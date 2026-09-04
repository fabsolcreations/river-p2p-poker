/**
 * Wire protocol between the extension's three contexts.
 *
 *   MAIN world  (hook.js)     -- window.postMessage -->  ISOLATED world
 *   ISOLATED    (content.js)  -- chrome.runtime     -->  background.js
 *   popup.js                  -- chrome.runtime     -->  background.js
 *   background.js             -- chrome.tabs        -->  content.js
 *
 * Only the last three hops are defined here; the MAIN<->ISOLATED hop belongs to
 * the collector core, which owns the page-side bridge.
 *
 * Every message carries a `scout/` prefix because content scripts share the
 * chrome.runtime channel with nothing else here, but the page's own postMessage
 * traffic is noisy and mislabelled messages are the classic source of a bridge
 * that "works on my machine". A prefix makes an unknown message obviously
 * unknown rather than accidentally matching.
 */

import type { CollectorConfig, FrameReport } from '../../shared/types.ts';

/**
 * What one collector instance (one frame) reports about itself. Every field is
 * observed, never assumed: if the bridge cannot determine a value it must send
 * the honest zero/false rather than a plausible number, because the popup
 * renders these as facts about the live page.
 */
export interface CollectorTabStatus {
  /** Version of the collector bundle actually running in the page. */
  version: string;
  /** True once the MAIN-world hook has answered the bridge's handshake. */
  hookInstalled: boolean;
  collecting: boolean;
  panelVisible: boolean;
  /** Captures currently held in the in-page ring buffer. */
  captures: number;
  /** Captures the ring dropped locally. Surfaced, never hidden. */
  dropped: number;
  /** Whether the collector's own uploader reached the local server. */
  serverConnected: boolean;
  frameOrigin: string;
  frameUrl: string;
  isTopFrame: boolean;
  sessionId: string;
  lastCaptureTs: number | null;
}

/** An iframe origin the page reported. Discovery output, never an input. */
export interface DiscoveredFrame {
  origin: string;
  src: string;
  depth: number;
  sameOrigin: boolean;
  firstSeen: number;
  lastSeen: number;
}

/* ------------------------------------------------------------------ *
 * content.js -> background.js
 * ------------------------------------------------------------------ */

export type ContentMessage =
  /** Heartbeat. Sent on load and whenever the counters move materially. */
  | { type: 'scout/status'; status: CollectorTabStatus }
  /** Result of a frame walk, whether the popup asked for it or not. */
  | { type: 'scout/frames'; report: FrameReport }
  /** Bridge asking for the current config at document_start. */
  | { type: 'scout/get-config' };

export interface ConfigReply {
  ok: true;
  config: CollectorConfig;
}

/* ------------------------------------------------------------------ *
 * background.js -> content.js  (relayed from the popup)
 * ------------------------------------------------------------------ */

export type TabCommand =
  /** Liveness probe. Reply with a CollectorTabStatus. */
  | { type: 'scout/ping' }
  /** Absolute config, not a patch. The bridge applies it verbatim. */
  | { type: 'scout/set-config'; config: CollectorConfig }
  /** `visible` is absolute, not a flip, so a duplicate delivery is harmless. */
  | { type: 'scout/toggle-panel'; visible: boolean }
  /** Walk the frame tree now and reply with what is there. */
  | { type: 'scout/discover-frames' }
  /** Dump the in-page ring buffer to an NDJSON download. */
  | { type: 'scout/export' };

export type TabCommandReply =
  | { ok: true; status: CollectorTabStatus }
  | { ok: true; report: FrameReport }
  | { ok: true; exported: number }
  | { ok: true; panelVisible: boolean }
  | { ok: true }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ *
 * popup.js -> background.js
 * ------------------------------------------------------------------ */

export type PopupMessage =
  | { type: 'scout/popup/state'; tabId: number | null }
  | { type: 'scout/popup/config'; patch: Partial<CollectorConfig> }
  /**
   * `alreadyGranted` is set when the popup already ran
   * chrome.permissions.request inside the click handler. A service worker has
   * no user gesture, so the background can only verify the grant, never obtain
   * one - see addOrigin() in background.ts.
   */
  | { type: 'scout/popup/add-origin'; origin: string; alreadyGranted?: boolean }
  | { type: 'scout/popup/remove-origin'; origin: string }
  | { type: 'scout/popup/command'; tabId: number; command: TabCommand };

/** Everything the popup needs for one render. One round trip, no partial UI. */
export interface PopupState {
  version: string;
  config: CollectorConfig;
  /** Origins granted at runtime; removable. */
  grantedOrigins: string[];
  /** Origins baked into the manifest; present for display, not removable. */
  staticOrigins: string[];
  tab: {
    id: number | null;
    url: string | null;
    origin: string | null;
    /** True when this origin is covered by a static or granted registration. */
    registered: boolean;
  };
  /** Null when nothing in the tab answered - shown as "unknown", not as "off". */
  status: CollectorTabStatus | null;
  /** Why status is null, verbatim from Chrome. */
  statusError: string | null;
  /** Iframe origins seen in this tab, minus the ones already granted. */
  frames: DiscoveredFrame[];
  framesUpdatedAt: number | null;
}

export type PopupReply =
  | { ok: true; state: PopupState }
  | { ok: true; config: CollectorConfig }
  | { ok: true; reply: TabCommandReply }
  | { ok: false; error: string };

/** Narrow an unknown runtime message without trusting its shape. */
export function isMessage<T extends { type: string }>(m: unknown, prefix: string): m is T {
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof (m as { type?: unknown }).type === 'string' &&
    (m as { type: string }).type.startsWith(prefix)
  );
}
