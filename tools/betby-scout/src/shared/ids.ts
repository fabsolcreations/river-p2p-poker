/**
 * Deterministic identifiers.
 *
 * Why not random ids: the same event, market and selection must resolve to the
 * same key across restarts, across collector sessions, and after the book
 * rotates its own internal ids (BETBY books do rotate market ids between
 * sessions). Every key here is a pure function of its inputs, so two machines
 * that saw the same payload agree without coordinating.
 *
 * Hash is FNV-1a 64-bit: no crypto import (must run identically in a page and
 * in Node), stable across engines because it is all BigInt, and short enough
 * to eyeball in a debug panel. It is not a security primitive and is not used
 * as one - every key is namespaced by sportsbook, so a cross-book collision is
 * impossible and a within-book collision at our volumes is negligible.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64 over the UTF-8 bytes of `s`, as 16 lowercase hex chars. */
export function hash64(s: string): string {
  let h = FNV_OFFSET;
  // Encode without TextEncoder so this works in any context.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      h = ((h ^ BigInt(c)) * FNV_PRIME) & MASK64;
    } else if (c < 0x800) {
      h = ((h ^ BigInt(0xc0 | (c >> 6))) * FNV_PRIME) & MASK64;
      h = ((h ^ BigInt(0x80 | (c & 0x3f))) * FNV_PRIME) & MASK64;
    } else {
      h = ((h ^ BigInt(0xe0 | (c >> 12))) * FNV_PRIME) & MASK64;
      h = ((h ^ BigInt(0x80 | ((c >> 6) & 0x3f))) * FNV_PRIME) & MASK64;
      h = ((h ^ BigInt(0x80 | (c & 0x3f))) * FNV_PRIME) & MASK64;
    }
  }
  return h.toString(16).padStart(16, '0');
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Numbers are part of keys; render them identically everywhere. */
export function normalizeLine(line: number | null | undefined): string {
  if (line === null || line === undefined || !Number.isFinite(line)) return '';
  // -0 and 0 must not produce different keys.
  const v = line === 0 ? 0 : line;
  return v.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * Kickoff times drift by seconds between payloads, so a fallback key that used
 * the raw timestamp would fragment. Bucket to 15 minutes.
 */
export function timeBucket(ts: number | null | undefined, minutes = 15): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '';
  const ms = minutes * 60_000;
  return String(Math.round(ts / ms) * ms);
}

function key(prefix: string, parts: Array<string | number | null | undefined>): string {
  return `${prefix}_${hash64(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join(''))}`;
}

export function captureId(sessionId: string, seq: number): string {
  return key('c', [sessionId, seq]);
}

export function sessionId(seedA: string, seedB: string): string {
  return key('s', [seedA, seedB]);
}

/**
 * Event key. Prefers the book's own id (stable and unambiguous); falls back to
 * a content hash so that an event still gets a durable identity when the
 * payload does not expose one.
 */
export function eventKey(input: {
  sportsbookId: string;
  sourceEventId?: string | null;
  sport?: string | null;
  league?: string | null;
  competitors?: Array<string | null | undefined>;
  startTime?: number | null;
}): string {
  if (input.sourceEventId) {
    return key('e', [input.sportsbookId, 'id', input.sourceEventId]);
  }
  // Competitor order varies between payloads (home/away vs alphabetical), so
  // sort before hashing.
  const teams = (input.competitors ?? [])
    .map((c) => normalizeName(c))
    .filter(Boolean)
    .sort()
    .join('|');
  return key('e', [
    input.sportsbookId,
    'shape',
    normalizeName(input.sport),
    normalizeName(input.league),
    teams,
    timeBucket(input.startTime ?? null),
  ]);
}

export function marketKey(input: {
  sportsbookId: string;
  eventKey: string;
  sourceMarketId?: string | null;
  type?: string | null;
  name?: string | null;
  line?: number | null;
  period?: string | null;
}): string {
  if (input.sourceMarketId) {
    return key('m', [input.sportsbookId, input.eventKey, 'id', input.sourceMarketId]);
  }
  return key('m', [
    input.sportsbookId,
    input.eventKey,
    'shape',
    normalizeName(input.type ?? input.name),
    normalizeLine(input.line),
    normalizeName(input.period),
  ]);
}

export function selectionKey(input: {
  sportsbookId: string;
  eventKey: string;
  marketKey: string;
  sourceSelectionId?: string | null;
  name?: string | null;
  side?: string | null;
  line?: number | null;
}): string {
  if (input.sourceSelectionId) {
    return key('o', [input.sportsbookId, input.marketKey, 'id', input.sourceSelectionId]);
  }
  return key('o', [
    input.sportsbookId,
    input.marketKey,
    'shape',
    normalizeName(input.side ?? input.name),
    normalizeLine(input.line),
  ]);
}

/**
 * Bettor key. The feed shows a masked handle; we hash it with the sportsbook
 * id so a handle is only ever tracked within the book that displayed it. We
 * deliberately do not attempt to resolve a masked handle to a real account.
 */
export function bettorKey(sportsbookId: string, label: string | null | undefined): string {
  return key('b', [sportsbookId, (label ?? '').trim().toLowerCase()]);
}

/**
 * Feed bet key. Prefers the book's own bet id. The fallback deliberately
 * includes the leg fingerprint and the timestamp bucketed to the second: the
 * same bettor can place two identical bets, and we would rather record two
 * rows than silently collapse them, but a feed that re-sends the same bet on
 * reconnect must not double-count.
 */
export function feedBetKey(input: {
  sportsbookId: string;
  sourceBetId?: string | null;
  bettorKey?: string;
  ts?: number | null;
  stake?: number | null;
  totalOdds?: number | null;
  legFingerprint?: string;
}): string {
  if (input.sourceBetId) {
    return key('fb', [input.sportsbookId, 'id', input.sourceBetId]);
  }
  return key('fb', [
    input.sportsbookId,
    'shape',
    input.bettorKey ?? '',
    input.ts ? Math.round(input.ts / 1000) : '',
    input.stake ?? '',
    input.totalOdds ?? '',
    input.legFingerprint ?? '',
  ]);
}

/** Order-independent fingerprint of a combo's legs. */
export function legFingerprint(legs: Array<{ selectionKey?: string | null; selectionName?: string | null; line?: number | null }>): string {
  return legs
    .map((l) => l.selectionKey ?? `${normalizeName(l.selectionName)}@${normalizeLine(l.line)}`)
    .sort()
    .join(',');
}
