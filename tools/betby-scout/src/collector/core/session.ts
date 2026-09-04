/**
 * Collector session identity.
 *
 * One session = one page load of one frame. That granularity matters because
 * the BETBY widget usually lives in a child frame with its own script context:
 * the top frame and the widget frame each run their own collector, each with
 * its own sequence counter, and the server has to be able to tell their streams
 * apart while still knowing they belong to the same page.
 *
 * `seq` is monotonic within a session and is stamped at the moment a payload is
 * observed, so a gap in the sequence is real evidence that something was
 * dropped rather than an artefact of async body reads finishing out of order.
 */

import { sessionId as makeSessionId } from '../../shared/ids.ts';
import type { CollectorIdentity, CollectorKind } from '../../shared/types.ts';

/**
 * Version of the in-page bundle. Kept in step with the extension manifest and
 * package.json by hand - the page bundle cannot read either at runtime.
 */
export const COLLECTOR_VERSION = '0.1.0';

/** Namespaced so a page's own localStorage keys cannot collide with ours. */
export const CONFIG_STORAGE_KEY = 'betby-scout:config';

function randomSeed(): string {
  // crypto.getRandomValues is present in every browser we target, but a hostile
  // page can delete it and a non-browser context (a test) may not have it.
  // Math.random is a fine fallback here: this seed only has to make two page
  // loads distinguishable, it is not a security value.
  try {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      const buf = new Uint32Array(2);
      c.getRandomValues(buf);
      return `${(buf[0] ?? 0).toString(36)}${(buf[1] ?? 0).toString(36)}`;
    }
  } catch {
    /* fall through */
  }
  return Math.random().toString(36).slice(2);
}

/** Frame URL, guarded: a sandboxed frame can throw on location access. */
export function frameUrl(): string {
  try {
    return location.href;
  } catch {
    return '';
  }
}

export function frameOrigin(): string {
  try {
    return location.origin;
  } catch {
    return '';
  }
}

export function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    // Cross-origin parents make window.top comparison throw in some engines.
    // If we cannot tell, we are certainly not the frame that owns the page.
    return false;
  }
}

/**
 * Best-effort top-level page origin.
 *
 * Order matters and each step is a fallback for a specific failure:
 *   1. window.top.location.origin - correct, but throws for a cross-origin top.
 *   2. document.referrer's origin - what a cross-origin child frame is actually
 *      told about its embedder, and the only signal available in that case.
 *   3. our own origin - true for the top frame, and an honest "we could not
 *      determine the embedder" for anything else.
 */
export function resolvePageOrigin(): string {
  try {
    const top = window.top;
    if (top && top.location && typeof top.location.origin === 'string') return top.location.origin;
  } catch {
    /* cross-origin top - expected, not an error */
  }
  try {
    if (document.referrer) return new URL(document.referrer).origin;
  } catch {
    /* referrer can be empty or malformed */
  }
  return frameOrigin();
}

export function userAgent(): string {
  try {
    return navigator.userAgent;
  } catch {
    return '';
  }
}

export interface Session {
  sessionId: string;
  nextSeq: () => number;
  identity: (kind: CollectorKind) => CollectorIdentity;
}

export function createSession(): Session {
  // Two independent seeds: one that varies per page load (time + randomness)
  // and one that varies per frame (its URL and UA). Together they make a
  // collision between two frames of the same page, or two loads of the same
  // frame, vanishingly unlikely without needing a real UUID source.
  const id = makeSessionId(
    `${Date.now()}|${randomSeed()}`,
    `${frameUrl()}|${userAgent()}|${typeof performance === 'object' ? performance.timeOrigin : 0}`,
  );

  let seq = 0;
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  const identity = (kind: CollectorKind): CollectorIdentity => ({
    kind,
    version: COLLECTOR_VERSION,
    sessionId: id,
    pageOrigin: resolvePageOrigin(),
    frameOrigin: frameOrigin(),
    isTopFrame: isTopFrame(),
    userAgent: userAgent(),
  });

  return { sessionId: id, nextSeq, identity };
}
