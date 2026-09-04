/**
 * MV3 service worker.
 *
 * Three jobs, in order of how much they matter:
 *
 * 1. Runtime host access. The manifest ships access to duel.com only. The
 *    BETBY widget almost certainly lives on a *different* origin inside an
 *    iframe, and we refuse to guess which one (CONTRACT.md rule 1). So the page
 *    reports the iframe origins it actually contains, the popup offers them,
 *    and the user grants one. Only then do we register content scripts for it.
 *
 * 2. Keeping those dynamic registrations alive. A service worker is evicted
 *    constantly and `persistAcrossSessions` has not proven reliable enough to
 *    lean on alone, so the granted list is the source of truth in
 *    chrome.storage.local and we re-derive registrations from it on every
 *    startup and install.
 *
 * 3. Being the popup's only view of the page. The popup cannot talk to a
 *    content script directly in a way that survives the popup closing, and it
 *    has no host permission for the local server, so everything it shows about
 *    a tab comes through here.
 *
 * The worker never touches the page's DOM, never issues a sportsbook request,
 * and has no code path that could submit anything.
 */

import { DEFAULT_COLLECTOR_CONFIG, type CollectorConfig, type FrameReport } from '../../shared/types.ts';
import {
  isMessage,
  type ContentMessage,
  type CollectorTabStatus,
  type DiscoveredFrame,
  type PopupMessage,
  type PopupReply,
  type PopupState,
  type TabCommand,
  type TabCommandReply,
} from './messages.ts';

const CONFIG_KEY = 'scout.config';
const ORIGINS_KEY = 'scout.grantedOrigins';
const TABS_KEY = 'scout.tabs';

/** Bundle filenames produced by scripts/build-collector.mjs. */
const HOOK_FILE = 'hook.js';
const BRIDGE_FILE = 'content.js';

/**
 * A content script that never answers still holds the sendMessage promise open
 * forever. Anything the popup waits on gets a deadline.
 */
const PROBE_TIMEOUT_MS = 1500;

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

async function readConfig(): Promise<CollectorConfig> {
  const got = await chrome.storage.local.get(CONFIG_KEY);
  const stored = got[CONFIG_KEY] as Partial<CollectorConfig> | undefined;
  // Merge over defaults rather than replacing: a config written by an older
  // build must not leave a newer field undefined in the page.
  return { ...DEFAULT_COLLECTOR_CONFIG, ...(stored ?? {}) };
}

async function writeConfig(config: CollectorConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}

async function readGrantedOrigins(): Promise<string[]> {
  const got = await chrome.storage.local.get(ORIGINS_KEY);
  const value = got[ORIGINS_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((o): o is string => typeof o === 'string');
}

async function writeGrantedOrigins(origins: string[]): Promise<void> {
  await chrome.storage.local.set({ [ORIGINS_KEY]: [...new Set(origins)].sort() });
}

/* ------------------------------------------------------------------ *
 * Per-tab discovery state
 *
 * chrome.storage.session and not a module-level Map: the worker is evicted
 * between the user clicking "Discover frames" and the popup reopening, and a
 * Map would silently come back empty. Session storage is cleared on browser
 * restart, which is exactly the lifetime a discovered iframe list deserves.
 * ------------------------------------------------------------------ */

interface TabRecord {
  /** Keyed by frameId so a page with several collector frames aggregates. */
  statuses: Record<string, { status: CollectorTabStatus; ts: number }>;
  frames: DiscoveredFrame[];
  framesUpdatedAt: number | null;
}

const emptyTabRecord = (): TabRecord => ({ statuses: {}, frames: [], framesUpdatedAt: null });

async function readTabs(): Promise<Record<string, TabRecord>> {
  const got = await chrome.storage.session.get(TABS_KEY);
  const value = got[TABS_KEY];
  return value && typeof value === 'object' ? (value as Record<string, TabRecord>) : {};
}

async function updateTab(tabId: number, mutate: (rec: TabRecord) => void): Promise<void> {
  const tabs = await readTabs();
  const rec = tabs[String(tabId)] ?? emptyTabRecord();
  mutate(rec);
  tabs[String(tabId)] = rec;
  await chrome.storage.session.set({ [TABS_KEY]: tabs });
}

async function forgetTab(tabId: number): Promise<void> {
  const tabs = await readTabs();
  if (!(String(tabId) in tabs)) return;
  delete tabs[String(tabId)];
  await chrome.storage.session.set({ [TABS_KEY]: tabs });
}

/**
 * Collapses every frame's status into one line for the popup. Counters sum;
 * booleans are true if any frame says true, because "the hook is installed
 * somewhere in this tab" is the question the popup is actually asking.
 */
function mergeStatuses(rec: TabRecord | undefined): CollectorTabStatus | null {
  const entries = Object.values(rec?.statuses ?? {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.ts - a.ts);
  const newest = entries[0];
  if (!newest) return null;
  const merged: CollectorTabStatus = { ...newest.status };
  merged.captures = 0;
  merged.dropped = 0;
  merged.hookInstalled = false;
  merged.collecting = false;
  merged.panelVisible = false;
  merged.serverConnected = false;
  merged.lastCaptureTs = null;
  for (const { status } of entries) {
    merged.captures += status.captures;
    merged.dropped += status.dropped;
    merged.hookInstalled ||= status.hookInstalled;
    merged.collecting ||= status.collecting;
    merged.panelVisible ||= status.panelVisible;
    merged.serverConnected ||= status.serverConnected;
    if (status.lastCaptureTs !== null) {
      merged.lastCaptureTs = Math.max(merged.lastCaptureTs ?? 0, status.lastCaptureTs);
    }
  }
  // Prefer the top frame's identity for the "which frame am I looking at" line.
  const top = entries.find((e) => e.status.isTopFrame);
  if (top) {
    merged.frameOrigin = top.status.frameOrigin;
    merged.frameUrl = top.status.frameUrl;
    merged.isTopFrame = true;
    merged.sessionId = top.status.sessionId;
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * Origins and match patterns
 * ------------------------------------------------------------------ */

/**
 * `https://host[:port]` and nothing else. Rejecting anything with a path or a
 * wildcard is deliberate: this value comes from a discovered iframe `src`, and
 * a permission pattern assembled from untrusted text is how an extension ends
 * up asking for more than the user thinks they are granting.
 *
 * http:// is rejected too, because `optional_host_permissions` is
 * `https://*` - an http origin would produce a request Chrome silently denies,
 * which looks like a bug rather than a refusal.
 */
export function normalizeOrigin(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw === 'null') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname.length === 0 || url.hostname.includes('*')) return null;
  return url.origin;
}

export function originPattern(origin: string): string | null {
  const normal = normalizeOrigin(origin);
  return normal === null ? null : `${normal}/*`;
}

/** Content-script ids must be stable and collision-free per origin. */
function scriptIds(origin: string): { hook: string; bridge: string } {
  const slug = origin.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return { hook: `scout-hook-${slug}`, bridge: `scout-bridge-${slug}` };
}

/**
 * Match-pattern test limited to the two forms this extension ever uses:
 * `scheme://host/*` and `scheme://*.host/*`. Enough to answer "is this origin
 * already covered by the manifest?", which is what stops us registering a
 * second copy of the hook over duel.com and double-counting every capture.
 */
export function patternCoversOrigin(pattern: string, origin: string): boolean {
  const m = /^(https?|\*):\/\/([^/]+)\/\*$/.exec(pattern);
  if (!m) return false;
  const [, scheme, hostPart] = m;
  if (!scheme || !hostPart) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (scheme !== '*' && `${scheme}:` !== url.protocol) return false;
  if (hostPart === '*') return true;
  if (hostPart.startsWith('*.')) {
    const base = hostPart.slice(2);
    return url.hostname === base || url.hostname.endsWith(`.${base}`);
  }
  return url.hostname === hostPart;
}

/** Origins the manifest already covers. Displayed, but not removable. */
function staticPatterns(): string[] {
  const manifest = chrome.runtime.getManifest();
  return manifest.host_permissions ?? [];
}

function coveredByManifest(origin: string): boolean {
  return staticPatterns().some((p) => patternCoversOrigin(p, origin));
}

/* ------------------------------------------------------------------ *
 * Dynamic content-script registration
 * ------------------------------------------------------------------ */

function scriptsFor(origin: string): chrome.scripting.RegisteredContentScript[] {
  const pattern = originPattern(origin);
  if (pattern === null) return [];
  const ids = scriptIds(origin);
  return [
    {
      // MAIN world, document_start: the hook must replace window.fetch before
      // the widget's own bundle captures a reference to the original. Register
      // it first so it lands ahead of the bridge.
      id: ids.hook,
      matches: [pattern],
      js: [HOOK_FILE],
      world: 'MAIN',
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
    {
      id: ids.bridge,
      matches: [pattern],
      js: [BRIDGE_FILE],
      world: 'ISOLATED',
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
  ];
}

/**
 * registerContentScripts rejects the entire batch if any id is already
 * registered, and the ids here are deterministic, so a re-register after a
 * worker restart would fail wholesale. Split by what already exists.
 */
async function registerForOrigin(origin: string): Promise<void> {
  const wanted = scriptsFor(origin);
  if (wanted.length === 0) throw new Error(`Not a usable https origin: ${origin}`);

  const existing = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  const toRegister = wanted.filter((s) => !existing.has(s.id));
  const toUpdate = wanted.filter((s) => existing.has(s.id));

  if (toRegister.length > 0) await chrome.scripting.registerContentScripts(toRegister);
  if (toUpdate.length > 0) await chrome.scripting.updateContentScripts(toUpdate);
}

async function unregisterForOrigin(origin: string): Promise<void> {
  const ids = scriptIds(origin);
  const existing = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  const present = [ids.hook, ids.bridge].filter((id) => existing.has(id));
  if (present.length > 0) await chrome.scripting.unregisterContentScripts({ ids: present });
}

/**
 * Rebuilds every dynamic registration from the stored grant list, and drops any
 * origin whose permission the user revoked from chrome://extensions behind our
 * back (registering for an origin we no longer hold throws).
 */
async function resyncRegistrations(): Promise<{ origins: string[]; warnings: string[] }> {
  const stored = await readGrantedOrigins();
  const kept: string[] = [];
  const warnings: string[] = [];

  for (const origin of stored) {
    const pattern = originPattern(origin);
    if (pattern === null) {
      warnings.push(`Dropped stored origin that is no longer a valid https origin: ${origin}`);
      continue;
    }
    const held = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
    if (!held) {
      warnings.push(`Host access for ${origin} is no longer granted; removing it.`);
      await unregisterForOrigin(origin).catch(() => undefined);
      continue;
    }
    try {
      await registerForOrigin(origin);
      kept.push(origin);
    } catch (e) {
      warnings.push(`Could not register collector for ${origin}: ${errText(e)}`);
    }
  }

  if (kept.length !== stored.length) await writeGrantedOrigins(kept);
  return { origins: kept, warnings };
}

export interface AddOriginResult {
  ok: boolean;
  origin: string | null;
  error?: string;
  /** True when the manifest already covers it and nothing needed doing. */
  alreadyCovered?: boolean;
}

/**
 * Grant + register one origin.
 *
 * The permission prompt is the awkward part. `chrome.permissions.request` only
 * works inside a user gesture, and a service worker has none, so in practice
 * the popup calls request() itself in the click handler and then calls us with
 * `alreadyGranted`. We still verify with contains() rather than believing the
 * caller, and we still attempt request() when we were called without a prior
 * grant - it will fail in a worker, and the error we surface then tells the
 * user exactly what to do instead of failing silently.
 */
export async function addOrigin(origin: string, alreadyGranted = false): Promise<AddOriginResult> {
  const normal = normalizeOrigin(origin);
  if (normal === null) {
    return { ok: false, origin: null, error: 'Only concrete https origins can be granted.' };
  }
  if (coveredByManifest(normal)) {
    // Registering a second hook over a static match would install it twice in
    // the same frame and double every capture.
    return { ok: true, origin: normal, alreadyCovered: true };
  }
  const pattern = `${normal}/*`;

  let held = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (!held && !alreadyGranted) {
    try {
      held = await chrome.permissions.request({ origins: [pattern] });
    } catch (e) {
      return {
        ok: false,
        origin: normal,
        error: `Chrome would not show the permission prompt from the background worker (${errText(e)}). Click Allow in the popup instead.`,
      };
    }
  }
  if (!held) {
    return { ok: false, origin: normal, error: `Host access for ${normal} was not granted.` };
  }

  try {
    await registerForOrigin(normal);
  } catch (e) {
    return { ok: false, origin: normal, error: `Registration failed: ${errText(e)}` };
  }

  const origins = await readGrantedOrigins();
  if (!origins.includes(normal)) await writeGrantedOrigins([...origins, normal]);
  return { ok: true, origin: normal };
}

export async function removeOrigin(origin: string): Promise<{ ok: boolean; error?: string }> {
  const normal = normalizeOrigin(origin);
  if (normal === null) return { ok: false, error: 'Not a valid origin.' };
  if (coveredByManifest(normal)) {
    return { ok: false, error: 'That origin comes from the manifest and cannot be removed here.' };
  }

  try {
    await unregisterForOrigin(normal);
  } catch (e) {
    return { ok: false, error: `Could not unregister the collector: ${errText(e)}` };
  }

  const pattern = `${normal}/*`;
  // A failed remove is worth reporting but not worth keeping the origin in our
  // list for: the scripts are already gone either way.
  const removed = await chrome.permissions.remove({ origins: [pattern] }).catch(() => false);
  const origins = (await readGrantedOrigins()).filter((o) => o !== normal);
  await writeGrantedOrigins(origins);

  return removed ? { ok: true } : { ok: true, error: 'Scripts unregistered, but Chrome kept the host permission.' };
}

/* ------------------------------------------------------------------ *
 * Talking to the page
 * ------------------------------------------------------------------ */

async function sendToTab(tabId: number, command: TabCommand): Promise<TabCommandReply> {
  const deadline = new Promise<TabCommandReply>((resolve) =>
    setTimeout(() => resolve({ ok: false, error: 'No answer from the page within 1.5s.' }), PROBE_TIMEOUT_MS),
  );
  const call = chrome.tabs
    .sendMessage(tabId, command)
    .then((reply: unknown): TabCommandReply => {
      if (reply && typeof reply === 'object') return reply as TabCommandReply;
      return { ok: false, error: 'The page answered with nothing usable.' };
    })
    .catch((e: unknown): TabCommandReply => ({ ok: false, error: errText(e) }));
  return Promise.race([call, deadline]);
}

/** Pushes config to every tab we have ever heard from. Failures are expected. */
async function broadcastConfig(config: CollectorConfig): Promise<void> {
  const tabs = await readTabs();
  await Promise.all(
    Object.keys(tabs).map((id) => sendToTab(Number(id), { type: 'scout/set-config', config }).catch(() => undefined)),
  );
}

function mergeFrames(existing: DiscoveredFrame[], report: FrameReport): DiscoveredFrame[] {
  const byOrigin = new Map(existing.map((f) => [f.origin, f]));
  for (const frame of report.frames) {
    const origin = typeof frame.origin === 'string' ? frame.origin : '';
    if (origin.length === 0) continue;
    const prior = byOrigin.get(origin);
    if (prior) {
      prior.lastSeen = report.ts;
      prior.depth = Math.min(prior.depth, frame.depth);
      if (frame.src) prior.src = frame.src;
    } else {
      byOrigin.set(origin, {
        origin,
        src: frame.src ?? '',
        depth: frame.depth,
        sameOrigin: frame.sameOrigin,
        firstSeen: report.ts,
        lastSeen: report.ts,
      });
    }
  }
  return [...byOrigin.values()].sort((a, b) => a.depth - b.depth || a.origin.localeCompare(b.origin));
}

/* ------------------------------------------------------------------ *
 * Popup state
 * ------------------------------------------------------------------ */

async function buildPopupState(tabId: number | null): Promise<PopupState> {
  const [config, granted, tabs] = await Promise.all([readConfig(), readGrantedOrigins(), readTabs()]);

  let url: string | null = null;
  let origin: string | null = null;
  if (tabId !== null) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    url = tab?.url ?? null;
    if (url) {
      try {
        origin = new URL(url).origin;
      } catch {
        origin = null;
      }
    }
  }

  const rec = tabId === null ? undefined : tabs[String(tabId)];

  // Probe live rather than trusting the last heartbeat: a stale record from a
  // previous page load in the same tab would otherwise read as "installed".
  let status: CollectorTabStatus | null = null;
  let statusError: string | null = null;
  if (tabId !== null) {
    const reply = await sendToTab(tabId, { type: 'scout/ping' });
    if ('status' in reply && reply.ok) {
      status = reply.status;
      const merged = mergeStatuses(rec);
      // The probe reaches one frame; the heartbeats cover all of them. Take the
      // larger counters so a busy iframe is not hidden by a quiet top frame.
      if (merged && merged.captures >= status.captures) status = merged;
    } else if (!reply.ok) {
      statusError = reply.error;
      status = mergeStatuses(rec);
      if (status) statusError = null;
    }
  }

  const grantedSet = new Set(granted);
  const frames = (rec?.frames ?? []).filter(
    (f) => normalizeOrigin(f.origin) !== null && !grantedSet.has(f.origin) && !coveredByManifest(f.origin),
  );

  const registered =
    origin !== null && (coveredByManifest(origin) || grantedSet.has(origin));

  return {
    version: chrome.runtime.getManifest().version,
    config,
    grantedOrigins: granted,
    staticOrigins: staticPatterns(),
    tab: { id: tabId, url, origin, registered },
    status,
    statusError,
    frames,
    framesUpdatedAt: rec?.framesUpdatedAt ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

async function handlePopup(message: PopupMessage): Promise<PopupReply> {
  switch (message.type) {
    case 'scout/popup/state':
      return { ok: true, state: await buildPopupState(message.tabId) };

    case 'scout/popup/config': {
      const config: CollectorConfig = { ...(await readConfig()), ...message.patch };
      await writeConfig(config);
      await broadcastConfig(config);
      return { ok: true, config };
    }

    case 'scout/popup/add-origin': {
      const result = await addOrigin(message.origin, message.alreadyGranted === true);
      if (!result.ok) return { ok: false, error: result.error ?? 'Could not add that origin.' };
      return { ok: true, state: await buildPopupState(null) };
    }

    case 'scout/popup/remove-origin': {
      const result = await removeOrigin(message.origin);
      if (!result.ok) return { ok: false, error: result.error ?? 'Could not remove that origin.' };
      return { ok: true, state: await buildPopupState(null) };
    }

    case 'scout/popup/command': {
      const reply = await sendToTab(message.tabId, message.command);
      // A frame walk triggered from the popup is still discovery output: fold
      // it into the tab record so the Sites list updates without a second trip.
      if (reply.ok && 'report' in reply) {
        const report = reply.report;
        await updateTab(message.tabId, (rec) => {
          rec.frames = mergeFrames(rec.frames, report);
          rec.framesUpdatedAt = report.ts;
        });
      }
      return { ok: true, reply };
    }

    default:
      return { ok: false, error: 'Unknown popup message.' };
  }
}

async function handleContent(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'scout/get-config':
      return { ok: true, config: await readConfig() };

    case 'scout/status': {
      if (tabId === undefined) return { ok: true };
      const frameId = String(sender.frameId ?? 0);
      await updateTab(tabId, (rec) => {
        rec.statuses[frameId] = { status: message.status, ts: Date.now() };
      });
      return { ok: true };
    }

    case 'scout/frames': {
      if (tabId === undefined) return { ok: true };
      const report = message.report;
      await updateTab(tabId, (rec) => {
        rec.frames = mergeFrames(rec.frames, report);
        rec.framesUpdatedAt = report.ts;
      });
      return { ok: true };
    }

    default:
      return { ok: false, error: 'Unknown content message.' };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const respond = (value: unknown): void => {
    try {
      sendResponse(value);
    } catch {
      // The caller (usually a closed popup) went away. Nothing to do.
    }
  };

  if (isMessage<PopupMessage>(message, 'scout/popup/')) {
    handlePopup(message).then(respond, (e: unknown) => respond({ ok: false, error: errText(e) }));
    return true;
  }
  if (isMessage<ContentMessage>(message, 'scout/')) {
    handleContent(message, sender).then(respond, (e: unknown) => respond({ ok: false, error: errText(e) }));
    return true;
  }
  return false;
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    // Write defaults only where nothing exists, so an upgrade never resets the
    // user's serverUrl or their ring size.
    const existing = await chrome.storage.local.get(CONFIG_KEY);
    if (existing[CONFIG_KEY] === undefined) await writeConfig(DEFAULT_COLLECTOR_CONFIG);
    else await writeConfig(await readConfig());
    const { warnings } = await resyncRegistrations();
    for (const w of warnings) console.warn('[betby-scout]', w);
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const { warnings } = await resyncRegistrations();
    for (const w of warnings) console.warn('[betby-scout]', w);
  })();
});

// Revoking access from chrome://extensions does not tell our storage, so listen.
chrome.permissions.onRemoved.addListener((permissions) => {
  void (async () => {
    const lost = (permissions.origins ?? [])
      .map((p) => normalizeOrigin(p.replace(/\/\*$/, '')))
      .filter((o): o is string => o !== null);
    if (lost.length === 0) return;
    for (const origin of lost) await unregisterForOrigin(origin).catch(() => undefined);
    const remaining = (await readGrantedOrigins()).filter((o) => !lost.includes(o));
    await writeGrantedOrigins(remaining);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTab(tabId);
});

// A navigation invalidates the old page's collector session, so the frame list
// and per-frame counters must not carry over into the next page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url !== undefined) void forgetTab(tabId);
});
