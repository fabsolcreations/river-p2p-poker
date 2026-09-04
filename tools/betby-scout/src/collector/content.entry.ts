/**
 * ISOLATED-world bridge. Extension only.
 *
 * Chrome gives content scripts two worlds. The MAIN world can see the page's
 * `window.fetch` (which is the whole point of the hook) but cannot call
 * `chrome.runtime`. The ISOLATED world is the reverse. This file is the wire
 * between them, and it is deliberately nothing else: it holds no state that
 * matters, makes no decisions, and never touches captured data.
 *
 * It talks to the page over `window.postMessage` on a namespaced channel, and
 * to the extension over `chrome.runtime`. Both sides are treated as untrusted:
 * the page could post a forged message on our channel, so nothing here does
 * anything a hostile page could not already do to itself.
 */

import {
  isMessage,
  type CollectorTabStatus,
  type ConfigReply,
  type TabCommand,
  type TabCommandReply,
} from './extension/messages.ts';
import type { FrameReport } from '../shared/types.ts';

const BRIDGE = 'betby-scout/bridge';

/** Round-trip correlation. A command waits for the reply carrying its nonce. */
let nextNonce = 1;
const pending = new Map<number, (payload: Record<string, unknown>) => void>();

/** Last status the page reported, so a ping can answer instantly if needed. */
let lastStatus: CollectorTabStatus | null = null;

/**
 * Marks the document so the MAIN-world bundle can tell it was injected by the
 * extension rather than by Tampermonkey. Set here, in the ISOLATED world,
 * because this script and the hook both run at document_start and the attribute
 * is visible to both.
 */
try {
  document.documentElement.setAttribute('data-betby-scout-ext', '1');
} catch {
  // A document without an element yet - the hook falls back to 'userscript'.
}

function post(payload: Record<string, unknown>): void {
  try {
    window.postMessage({ channel: BRIDGE, ...payload }, window.location.origin);
  } catch {
    // Nothing listening yet; the hook re-announces itself with 'hello'.
  }
}

/** Sends a command into the page and resolves with its reply, or times out. */
function ask(type: string, extra: Record<string, unknown> = {}, timeoutMs = 2000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const nonce = nextNonce++;
    const timer = setTimeout(() => {
      pending.delete(nonce);
      // Null, not a fabricated status: the popup renders "unknown" rather than
      // claiming the hook is off when we simply did not hear back.
      resolve(null);
    }, timeoutMs);
    pending.set(nonce, (payload) => {
      clearTimeout(timer);
      pending.delete(nonce);
      resolve(payload);
    });
    post({ type, nonce, ...extra });
  });
}

function toTabStatus(raw: unknown): CollectorTabStatus | null {
  if (raw === null || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const uploader = (s['uploader'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    version: typeof s['version'] === 'string' ? s['version'] : '0',
    hookInstalled: true, // it answered, so it is there
    collecting: true,
    panelVisible: s['panelVisible'] === true,
    captures: num(s['captures']),
    dropped: num(s['dropped']),
    serverConnected: uploader['connected'] === true,
    frameOrigin: window.location.origin,
    frameUrl: window.location.href,
    isTopFrame: window === window.top,
    sessionId: typeof s['sessionId'] === 'string' ? s['sessionId'] : '',
    lastCaptureTs: typeof uploader['lastSentAt'] === 'number' ? (uploader['lastSentAt'] as number) : null,
  };
}

/* ------------------------------------------------------------------ *
 * page -> extension
 * ------------------------------------------------------------------ */

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { channel?: unknown; type?: unknown; nonce?: unknown } | null;
  if (!data || data.channel !== BRIDGE || typeof data.type !== 'string') return;

  // Resolve a waiting ask() first.
  if (typeof data.nonce === 'number') {
    const resolver = pending.get(data.nonce);
    if (resolver) {
      resolver(data as Record<string, unknown>);
      return;
    }
  }

  switch (data.type) {
    case 'hello':
      // The hook just booted. Fetch config for it and report our presence.
      void sendConfigToPage();
      void refreshStatus();
      break;
    case 'status': {
      const status = toTabStatus((data as { status?: unknown }).status);
      if (status) {
        lastStatus = status;
        void safeSend({ type: 'scout/status', status });
      }
      break;
    }
    case 'config-changed':
      void refreshStatus();
      break;
    case 'frames': {
      const report = (data as { report?: unknown }).report as FrameReport | undefined;
      if (report) void safeSend({ type: 'scout/frames', report });
      break;
    }
  }
});

async function refreshStatus(): Promise<CollectorTabStatus | null> {
  const reply = await ask('ping');
  const status = toTabStatus(reply?.['status']);
  if (status) lastStatus = status;
  return status;
}

async function sendConfigToPage(): Promise<void> {
  const reply = await safeSend<ConfigReply>({ type: 'scout/get-config' });
  if (reply && reply.ok && reply.config) post({ type: 'set-config', config: reply.config });
}

/** chrome.runtime.sendMessage that never rejects - the SW may be asleep. */
function safeSend<T>(message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply: T) => {
        // Reading lastError is what suppresses Chrome's console noise when
        // nothing is listening.
        void chrome.runtime.lastError;
        resolve(reply ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------ *
 * extension -> page
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (r: TabCommandReply) => void) => {
  if (!isMessage<TabCommand>(message, 'scout/')) return undefined;

  void (async () => {
    try {
      switch (message.type) {
        case 'scout/ping': {
          const status = (await refreshStatus()) ?? lastStatus;
          if (status) sendResponse({ ok: true, status });
          else sendResponse({ ok: false, error: 'the collector did not answer in this frame' });
          break;
        }
        case 'scout/set-config': {
          const reply = await ask('set-config', { config: message.config });
          const status = toTabStatus(reply?.['status']);
          if (status) sendResponse({ ok: true, status });
          else sendResponse({ ok: false, error: 'no reply from the collector' });
          break;
        }
        case 'scout/toggle-panel': {
          const reply = await ask('toggle-panel', { visible: message.visible });
          const status = toTabStatus(reply?.['status']);
          sendResponse(status ? { ok: true, panelVisible: status.panelVisible } : { ok: false, error: 'no reply from the collector' });
          break;
        }
        case 'scout/discover-frames': {
          const reply = await ask('discover-frames', {}, 4000);
          const status = toTabStatus(reply?.['status']);
          // The frame report itself arrives separately as 'scout/frames'; this
          // reply only confirms the walk ran.
          sendResponse(status ? { ok: true, status } : { ok: false, error: 'no reply from the collector' });
          break;
        }
        case 'scout/export': {
          const reply = await ask('export', {}, 5000);
          const count = typeof reply?.['count'] === 'number' ? (reply['count'] as number) : 0;
          sendResponse({ ok: true, exported: count });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unrecognised command' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();

  // Keeps the message channel open for the async reply above.
  return true;
});

// Announce on load: the hook may already be running and waiting for config.
void sendConfigToPage();
