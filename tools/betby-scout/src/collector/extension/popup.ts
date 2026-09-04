/**
 * Popup UI.
 *
 * The popup owns exactly one thing the service worker cannot: the user gesture.
 * `chrome.permissions.request` is only honoured while a gesture is live, and a
 * service worker never has one, so the "Allow" button here must call it as the
 * very first statement of its click handler - one `await` beforehand and Chrome
 * drops the gesture and the prompt silently never appears. Everything else is
 * delegated to the background worker, which is the only context that survives
 * this window closing.
 *
 * Display rule inherited from CONTRACT.md: nothing here is allowed to invent a
 * value. When no collector answers in the active tab the counters read
 * "unknown", not "0" - a zero would be a claim we cannot support.
 */

import type { CollectorConfig } from '../../shared/types.ts';
import type { DiscoveredFrame, PopupMessage, PopupReply, PopupState, TabCommand } from './messages.ts';

const DASHBOARD_URL = 'http://127.0.0.1:5273';
const POLL_MS = 2000;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  // A missing node means popup.html and popup.ts drifted apart; fail loudly at
  // load rather than half-rendering and looking like a data problem later.
  if (node === null) throw new Error(`popup.html is missing #${id}`);
  return node as T;
}

const ui = {
  version: el<HTMLSpanElement>('version'),
  toggleCollect: el<HTMLButtonElement>('toggle-collect'),
  statHook: el<HTMLDivElement>('stat-hook'),
  statCaptures: el<HTMLDivElement>('stat-captures'),
  statServer: el<HTMLDivElement>('stat-server'),
  statDropped: el<HTMLDivElement>('stat-dropped'),
  tabBadge: el<HTMLSpanElement>('tab-badge'),
  tabOrigin: el<HTMLSpanElement>('tab-origin'),
  serverUrl: el<HTMLInputElement>('server-url'),
  serverSave: el<HTMLButtonElement>('server-save'),
  btnDiscover: el<HTMLButtonElement>('btn-discover'),
  btnPanel: el<HTMLButtonElement>('btn-panel'),
  btnExport: el<HTMLButtonElement>('btn-export'),
  btnDashboard: el<HTMLButtonElement>('btn-dashboard'),
  granted: el<HTMLUListElement>('granted'),
  discovered: el<HTMLUListElement>('discovered'),
  discoveredEmpty: el<HTMLParagraphElement>('discovered-empty'),
  notice: el<HTMLParagraphElement>('notice'),
};

let activeTabId: number | null = null;
let state: PopupState | null = null;
let polling = false;
/** Set while the user is editing the server field, so a poll cannot clobber it. */
let serverFieldDirty = false;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function notice(text: string, tone: 'info' | 'ok' | 'err' = 'info'): void {
  ui.notice.textContent = text;
  ui.notice.className = tone === 'info' ? 'notice' : `notice ${tone}`;
  ui.notice.hidden = text.length === 0;
}

async function send(message: PopupMessage): Promise<PopupReply> {
  try {
    const reply: unknown = await chrome.runtime.sendMessage(message);
    if (reply && typeof reply === 'object') return reply as PopupReply;
    return { ok: false, error: 'The background worker answered with nothing.' };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function setStat(node: HTMLElement, text: string, tone: 'good' | 'bad' | 'warn' | 'idle'): void {
  node.textContent = text;
  const numeric = node.classList.contains('num');
  node.className = `v ${tone}${numeric ? ' num' : ''}`;
}

function render(next: PopupState): void {
  state = next;
  ui.version.textContent = next.version;

  const collecting = next.config.enabled;
  ui.toggleCollect.textContent = collecting ? 'Collecting' : 'Paused';
  ui.toggleCollect.className = collecting ? 'on' : 'off';

  // No collector answered. Say so, rather than showing zeros that would read as
  // "installed and quiet".
  if (next.status === null) {
    setStat(ui.statHook, 'unknown', 'idle');
    setStat(ui.statCaptures, '–', 'idle');
    setStat(ui.statServer, 'unknown', 'idle');
    setStat(ui.statDropped, '–', 'idle');
  } else {
    const s = next.status;
    setStat(ui.statHook, s.hookInstalled ? 'yes' : 'no', s.hookInstalled ? 'good' : 'bad');
    setStat(ui.statCaptures, String(s.captures), s.captures > 0 ? 'good' : 'idle');
    setStat(ui.statServer, s.serverConnected ? 'connected' : 'offline', s.serverConnected ? 'good' : 'warn');
    setStat(ui.statDropped, String(s.dropped), s.dropped > 0 ? 'warn' : 'idle');
    ui.btnPanel.textContent = s.panelVisible ? 'Hide panel' : 'Show panel';
  }

  ui.tabOrigin.textContent = next.tab.origin ?? 'no page in this tab';
  if (next.tab.origin === null) {
    ui.tabBadge.textContent = 'no site';
    ui.tabBadge.className = 'badge none';
  } else if (next.tab.registered) {
    ui.tabBadge.textContent = 'granted';
    ui.tabBadge.className = 'badge live';
  } else {
    ui.tabBadge.textContent = 'not granted';
    ui.tabBadge.className = 'badge none';
  }

  if (!serverFieldDirty) ui.serverUrl.value = next.config.serverUrl;

  const hasTab = next.tab.id !== null;
  ui.btnDiscover.disabled = !hasTab;
  ui.btnPanel.disabled = !hasTab;
  ui.btnExport.disabled = !hasTab;

  renderGranted(next);
  renderDiscovered(next.frames);

  // Only surface a probe failure once we know the tab should have a collector -
  // "no receiving end" on an unrelated tab is expected, not an error.
  if (next.statusError !== null && next.tab.registered) {
    notice(`No collector answered in this tab: ${next.statusError}. Reload the page if you just granted access.`, 'err');
  }
}

function renderGranted(next: PopupState): void {
  ui.granted.replaceChildren();

  for (const pattern of next.staticOrigins) {
    const li = document.createElement('li');
    li.className = 'static';
    const origin = document.createElement('span');
    origin.className = 'origin';
    origin.textContent = pattern;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = 'built in';
    li.append(origin, meta);
    ui.granted.append(li);
  }

  for (const origin of next.grantedOrigins) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'origin';
    label.textContent = origin;
    const remove = document.createElement('button');
    remove.className = 'tiny ghost';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      void withBusy(remove, async () => {
        const reply = await send({ type: 'scout/popup/remove-origin', origin });
        if (!reply.ok) {
          notice(reply.error, 'err');
          return;
        }
        notice(`Removed ${origin}. Open tabs keep the old scripts until they reload.`, 'ok');
        await refresh();
      });
    });
    li.append(label, remove);
    ui.granted.append(li);
  }
}

function renderDiscovered(frames: DiscoveredFrame[]): void {
  ui.discovered.replaceChildren();
  ui.discoveredEmpty.hidden = frames.length > 0;

  for (const frame of frames) {
    const li = document.createElement('li');

    const origin = document.createElement('span');
    origin.className = 'origin';
    origin.textContent = frame.origin;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = frame.sameOrigin ? `depth ${frame.depth} · same origin` : `depth ${frame.depth} · cross origin`;

    const allow = document.createElement('button');
    allow.className = 'tiny primary';
    allow.type = 'button';
    allow.textContent = 'Allow';
    allow.addEventListener('click', () => {
      // FIRST statement of the handler: chrome.permissions.request only works
      // while the user gesture is still live. Any await before this line and
      // the prompt never opens.
      const pattern = `${frame.origin}/*`;
      chrome.permissions.request({ origins: [pattern] }).then(
        async (granted) => {
          if (!granted) {
            notice(`Chrome did not grant access to ${frame.origin}.`, 'err');
            return;
          }
          const reply = await send({ type: 'scout/popup/add-origin', origin: frame.origin, alreadyGranted: true });
          if (!reply.ok) {
            notice(reply.error, 'err');
            return;
          }
          notice(`Granted ${frame.origin}. Reload the page so the collector attaches to it.`, 'ok');
          await refresh();
        },
        (e: unknown) => notice(`Permission request failed: ${errText(e)}`, 'err'),
      );
    });

    li.append(origin, meta, allow);
    ui.discovered.append(li);
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function withBusy(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
  const wasDisabled = button.disabled;
  button.disabled = true;
  try {
    await work();
  } catch (e) {
    notice(errText(e), 'err');
  } finally {
    button.disabled = wasDisabled;
  }
}

async function patchConfig(patch: Partial<CollectorConfig>): Promise<CollectorConfig | null> {
  const reply = await send({ type: 'scout/popup/config', patch });
  if (!reply.ok) {
    notice(reply.error, 'err');
    return null;
  }
  return 'config' in reply ? reply.config : null;
}

async function runCommand(command: TabCommand): Promise<PopupReply> {
  if (activeTabId === null) {
    notice('No active tab to talk to.', 'err');
    return { ok: false, error: 'no tab' };
  }
  const reply = await send({ type: 'scout/popup/command', tabId: activeTabId, command });
  if (!reply.ok) notice(reply.error, 'err');
  return reply;
}

async function refresh(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const reply = await send({ type: 'scout/popup/state', tabId: activeTabId });
    if (reply.ok && 'state' in reply) render(reply.state);
    else if (!reply.ok) notice(reply.error, 'err');
  } finally {
    polling = false;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

ui.toggleCollect.addEventListener('click', () => {
  void withBusy(ui.toggleCollect, async () => {
    const current = state?.config.enabled ?? false;
    const config = await patchConfig({ enabled: !current });
    if (config) {
      notice(config.enabled ? 'Collecting.' : 'Paused — hooks stay installed but nothing is recorded.', 'ok');
      await refresh();
    }
  });
});

ui.serverUrl.addEventListener('input', () => {
  serverFieldDirty = true;
});

ui.serverSave.addEventListener('click', () => {
  void withBusy(ui.serverSave, async () => {
    const raw = ui.serverUrl.value.trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      notice('That is not a URL. Expected something like http://127.0.0.1:8787', 'err');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      notice('The server URL must be http or https.', 'err');
      return;
    }
    // Strip the trailing slash so the uploader can concatenate paths safely.
    const serverUrl = parsed.origin + parsed.pathname.replace(/\/$/, '');
    const config = await patchConfig({ serverUrl });
    if (config) {
      serverFieldDirty = false;
      notice(`Server set to ${config.serverUrl}.`, 'ok');
      await refresh();
    }
  });
});

ui.btnDiscover.addEventListener('click', () => {
  void withBusy(ui.btnDiscover, async () => {
    const reply = await runCommand({ type: 'scout/discover-frames' });
    if (reply.ok && 'reply' in reply) {
      const inner = reply.reply;
      if (inner.ok && 'report' in inner) {
        const count = inner.report.frames.length;
        notice(count === 0 ? 'No iframes on this page.' : `Reported ${count} frame${count === 1 ? '' : 's'}.`, 'ok');
      } else if (!inner.ok) {
        notice(inner.error, 'err');
      }
    }
    await refresh();
  });
});

ui.btnPanel.addEventListener('click', () => {
  void withBusy(ui.btnPanel, async () => {
    const visible = !(state?.status?.panelVisible ?? state?.config.panel ?? false);
    // Persist it, then push an absolute value to the tab. Absolute rather than a
    // flip so the config broadcast and this command cannot cancel each other.
    await patchConfig({ panel: visible });
    await runCommand({ type: 'scout/toggle-panel', visible });
    await refresh();
  });
});

ui.btnExport.addEventListener('click', () => {
  void withBusy(ui.btnExport, async () => {
    const reply = await runCommand({ type: 'scout/export' });
    if (reply.ok && 'reply' in reply) {
      const inner = reply.reply;
      if (inner.ok && 'exported' in inner) {
        notice(`Exported ${inner.exported} capture${inner.exported === 1 ? '' : 's'} as NDJSON.`, 'ok');
      } else if (inner.ok) {
        notice('Export requested — check your downloads.', 'ok');
      } else {
        notice(inner.error, 'err');
      }
    }
  });
});

ui.btnDashboard.addEventListener('click', () => {
  void chrome.tabs.create({ url: DASHBOARD_URL });
});

async function boot(): Promise<void> {
  ui.version.textContent = chrome.runtime.getManifest().version;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  await refresh();
  const timer = setInterval(() => void refresh(), POLL_MS);
  window.addEventListener('unload', () => clearInterval(timer));
}

void boot().catch((e: unknown) => notice(errText(e), 'err'));
