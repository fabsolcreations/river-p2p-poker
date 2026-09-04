/**
 * MAIN-world entry point. This is the bundle that actually runs inside the
 * sportsbook page, loaded identically by the extension and by the userscript.
 *
 * It owns the wiring and nothing else: session, ring, hooks, uploader, panel,
 * and the small control surface the extension bridge talks to. All the logic
 * lives in ./core and ./panel.
 *
 * Two properties matter more than anything here:
 *   - It must be idempotent. The extension can inject into a frame that a
 *     userscript already covered, and double-hooking would double-count every
 *     capture and double-wrap fetch.
 *   - It must never throw at top level. An exception at document_start in the
 *     MAIN world surfaces as a broken page on a site the user has money on.
 */

import { DEFAULT_COLLECTOR_CONFIG, type CollectorCommand, type CollectorConfig, type RawCapture } from '../shared/types.ts';
import { parseCapture } from '../adapters/registry.ts';
import { CaptureRing } from './core/ring.ts';
import { installHooks } from './core/hook.ts';
import { createUploader, type UploaderStatus } from './core/uploader.ts';
import { buildFrameReport } from './core/frames.ts';
import { installDomFallback } from './core/dom-fallback.ts';
import { COLLECTOR_VERSION, CONFIG_STORAGE_KEY, createSession, resolvePageOrigin } from './core/session.ts';
import { mountPanel } from './panel/panel.ts';

/** Namespaced so the bridge's messages can never collide with the page's own. */
const BRIDGE = 'betby-scout/bridge';

export interface ScoutGlobal {
  version: string;
  ring: CaptureRing;
  getConfig(): CollectorConfig;
  setConfig(patch: Partial<CollectorConfig>): CollectorConfig;
  exportNdjson(): number;
  discoverFrames(): void;
  togglePanel(visible?: boolean): boolean;
  status(): {
    version: string;
    sessionId: string;
    captures: number;
    dropped: number;
    uploader: UploaderStatus;
    panelVisible: boolean;
  };
}

declare global {
  interface Window {
    __BETBY_SCOUT__?: ScoutGlobal;
  }
}

function loadConfig(): CollectorConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COLLECTOR_CONFIG };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_COLLECTOR_CONFIG };
    // Merged over the defaults so a config written by an older build, missing
    // keys added since, still produces a complete object.
    return { ...DEFAULT_COLLECTOR_CONFIG, ...(parsed as Partial<CollectorConfig>) };
  } catch {
    // Private mode, blocked storage, or a corrupt value. Defaults are correct.
    return { ...DEFAULT_COLLECTOR_CONFIG };
  }
}

function saveConfig(config: CollectorConfig): void {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Non-fatal: the config still applies for this page load.
  }
}

function boot(): void {
  // Idempotence guard - see the header.
  if (window.__BETBY_SCOUT__) return;

  const session = createSession();
  const pageOrigin = resolvePageOrigin();
  let config = loadConfig();
  const ring = new CaptureRing(config.ringSize);

  let uploaderStatus: UploaderStatus = {
    connected: false,
    transport: 'none',
    lastError: null,
    sent: 0,
    pending: 0,
    lastSentAt: null,
  };

  const now = (): number => Date.now();

  const uploader = createUploader({
    config: () => config,
    ring,
    identity: () => session.identity(detectKind()),
    onCommand: (cmd: CollectorCommand) => {
      // The server can push a config change while the sportsbook tab stays open.
      if (cmd.type === 'config') applyConfig(cmd.config, { persist: true, push: false });
    },
    onStatus: (s) => {
      uploaderStatus = s;
    },
  });

  const hookDeps = {
    config: () => config,
    emit: (c: RawCapture) => {
      ring.push(c);
    },
    nextSeq: session.nextSeq,
    sessionId: session.sessionId,
    now,
    pageOrigin,
  };

  const hooks = installHooks(hookDeps);
  let domFallback = config.domFallback ? installDomFallback(hookDeps) : null;

  /** Applies a config change everywhere it has an effect, in one place. */
  function applyConfig(next: Partial<CollectorConfig>, opts: { persist: boolean; push: boolean }): CollectorConfig {
    const previous = config;
    config = { ...config, ...next };
    if (opts.persist) saveConfig(config);

    if (config.ringSize !== previous.ringSize) ring.setCapacity(config.ringSize);

    if (config.domFallback && !domFallback) domFallback = installDomFallback(hookDeps);
    else if (!config.domFallback && domFallback) {
      domFallback.uninstall();
      domFallback = null;
    }

    if (config.panel !== previous.panel) panel?.toggle();

    if (opts.push) postToBridge({ type: 'config-changed', config });
    return config;
  }

  function exportNdjson(): number {
    const captures = ring.list();
    const text = captures.map((c) => JSON.stringify(c)).join('\n');
    try {
      const blob = new Blob([text], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `betby-scout-${session.sessionId}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.ndjson`;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick: revoking synchronously can cancel the download
      // in some builds.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      return 0;
    }
    return captures.length;
  }

  function discoverFrames(): void {
    try {
      const report = buildFrameReport(session.sessionId, pageOrigin, now());
      uploader.sendFrameReport(report);
      postToBridge({ type: 'frames', report });
    } catch {
      // A frame walk can throw on an exotic document; it is diagnostics only.
    }
  }

  const panel = mountPanel({
    ring,
    config: () => config,
    setConfig: (patch) => {
      applyConfig(patch, { persist: true, push: true });
    },
    uploaderStatus: () => uploaderStatus,
    parse: (c) => parseCapture(c, now()),
    discoverFrames,
    exportNdjson: () => {
      exportNdjson();
    },
    version: COLLECTOR_VERSION,
  });

  let panelVisible = config.panel;

  uploader.start();
  // Re-check our wrappers on a slow tick: single-page apps sometimes replace
  // window.fetch after we install, and a silently unhooked fetch is the worst
  // failure mode this tool has - it looks like the site simply has no traffic.
  const guard = setInterval(() => {
    try {
      hooks.ensureInstalled();
    } catch {
      /* keep the interval alive regardless */
    }
  }, 5_000);

  const api: ScoutGlobal = {
    version: COLLECTOR_VERSION,
    ring,
    getConfig: () => ({ ...config }),
    setConfig: (patch) => applyConfig(patch, { persist: true, push: true }),
    exportNdjson,
    discoverFrames,
    togglePanel(visible?: boolean) {
      panelVisible = visible === undefined ? !panelVisible : visible;
      panel.toggle();
      return panelVisible;
    },
    status: () => ({
      version: COLLECTOR_VERSION,
      sessionId: session.sessionId,
      captures: ring.stats().size,
      dropped: ring.stats().dropped,
      uploader: uploaderStatus,
      panelVisible,
    }),
  };

  window.__BETBY_SCOUT__ = api;

  // Tell the bridge we exist. It may have loaded first and be waiting.
  postToBridge({ type: 'hello', version: COLLECTOR_VERSION });

  window.addEventListener('message', (event: MessageEvent) => {
    // Same-window only: the bridge posts to this exact window. Anything from a
    // different source is the page talking to itself and none of our business.
    if (event.source !== window) return;
    const data = event.data as { channel?: unknown; type?: unknown } | null;
    if (!data || data.channel !== BRIDGE || typeof data.type !== 'string') return;
    handleBridgeCommand(data as BridgeCommand);
  });

  interface BridgeCommand {
    channel: string;
    type: string;
    config?: Partial<CollectorConfig>;
    visible?: boolean;
    nonce?: number;
  }

  function handleBridgeCommand(cmd: BridgeCommand): void {
    try {
      switch (cmd.type) {
        case 'ping':
          postToBridge({ type: 'status', status: api.status(), nonce: cmd.nonce });
          break;
        case 'set-config':
          if (cmd.config) applyConfig(cmd.config, { persist: true, push: false });
          postToBridge({ type: 'status', status: api.status(), nonce: cmd.nonce });
          break;
        case 'toggle-panel':
          api.togglePanel(cmd.visible);
          postToBridge({ type: 'status', status: api.status(), nonce: cmd.nonce });
          break;
        case 'discover-frames':
          discoverFrames();
          postToBridge({ type: 'status', status: api.status(), nonce: cmd.nonce });
          break;
        case 'export':
          postToBridge({ type: 'exported', count: exportNdjson(), nonce: cmd.nonce });
          break;
      }
    } catch {
      // A malformed command from the bridge must not take the collector down.
    }
  }

  function postToBridge(payload: Record<string, unknown>): void {
    try {
      window.postMessage({ channel: BRIDGE, ...payload }, window.location.origin);
    } catch {
      // No bridge listening (userscript mode) - entirely expected.
    }
  }

  window.addEventListener('pagehide', () => {
    clearInterval(guard);
    void uploader.flushNow();
  });
}

/**
 * The extension bridge sets a marker before the MAIN-world bundle runs. Without
 * it we are a userscript. This only affects how the session labels itself, so
 * getting it wrong is cosmetic rather than dangerous.
 */
function detectKind(): 'extension' | 'userscript' {
  return document.documentElement.hasAttribute('data-betby-scout-ext') ? 'extension' : 'userscript';
}

try {
  boot();
} catch (err) {
  // Last line of defence. A collector that fails to start is acceptable; a
  // sportsbook page that fails to load because of us is not.
  try {
    console.warn('[betby-scout] collector failed to start', err);
  } catch {
    /* nothing left to do */
  }
}
