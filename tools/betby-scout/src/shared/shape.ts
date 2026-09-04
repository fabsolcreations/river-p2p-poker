/**
 * Payload shape analysis.
 *
 * This is how we reverse-engineer BETBY without guessing endpoint names. Two
 * responses from the same endpoint have the same *key shape* even though their
 * values differ completely, so hashing the shape clusters unknown traffic into
 * "kinds of message" that we can then inspect one representative at a time.
 *
 * It also gives the classifier something honest to work with: instead of
 * "this URL contains the word feed, so it is the bets feed", we can say "this
 * payload contains an array of objects that each have a stake-like number, an
 * odds-like number, a timestamp and a nested legs array".
 */

import { hash64 } from './ids.ts';

export type JsonType = 'null' | 'bool' | 'num' | 'str' | 'arr' | 'obj';

export function jsonType(v: unknown): JsonType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number' || typeof v === 'bigint') return 'num';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'arr';
  return 'obj';
}

/**
 * Canonical description of a value's structure with all values discarded.
 * Arrays are described by the *union* of their first N element shapes so a
 * heterogeneous array does not produce a different fingerprint each time its
 * first element changes.
 */
export function shapeOf(value: unknown, depth = 0, maxDepth = 8, maxKeys = 60, maxArraySample = 8): string {
  if (depth > maxDepth) return '…';
  const t = jsonType(value);
  if (t !== 'arr' && t !== 'obj') return t;

  if (Array.isArray(value)) {
    if (value.length === 0) return 'arr[]';
    const seen = new Set<string>();
    for (let i = 0; i < Math.min(value.length, maxArraySample); i++) {
      seen.add(shapeOf(value[i], depth + 1, maxDepth, maxKeys, maxArraySample));
    }
    return `arr[${[...seen].sort().join('|')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, maxKeys);
  const parts = entries
    .map(([k, v]) => `${k}:${shapeOf(v, depth + 1, maxDepth, maxKeys, maxArraySample)}`)
    .sort();
  return `{${parts.join(',')}}`;
}

/** 16-hex fingerprint of a payload's shape. Empty payloads hash consistently. */
export function shapeFingerprint(value: unknown): string {
  return hash64(shapeOf(value));
}

/** Top-level key names, for a human scanning a cluster list. */
export function topLevelKeys(value: unknown, limit = 24): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    const first = value[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return Object.keys(first).slice(0, limit).map((k) => `[].${k}`);
    }
    return ['[]'];
  }
  return Object.keys(value).slice(0, limit);
}

export interface FieldHit {
  /** Dotted path, with array indices collapsed to `[]`. */
  path: string;
  type: JsonType;
  /** One example value, truncated. Never used for logic, only for display. */
  sample: string;
}

/**
 * Flattens a payload into dotted paths, collapsing array indices so that
 * `bets[0].stake` and `bets[7].stake` both report as `bets[].stake`. This is
 * the list the debug panel shows as "fields seen", and the list adapters
 * subtract their consumed paths from to produce `unmappedFields`.
 */
export function flattenPaths(value: unknown, opts?: { maxPaths?: number; maxDepth?: number }): FieldHit[] {
  const maxPaths = opts?.maxPaths ?? 400;
  const maxDepth = opts?.maxDepth ?? 10;
  const out = new Map<string, FieldHit>();

  const walk = (v: unknown, path: string, depth: number): void => {
    if (out.size >= maxPaths || depth > maxDepth) return;
    const t = jsonType(v);
    if (t === 'arr') {
      const arr = v as unknown[];
      if (arr.length === 0) {
        if (path) out.set(path, { path, type: 'arr', sample: '[]' });
        return;
      }
      // Sample a few elements: enough to catch heterogeneous arrays, cheap.
      for (let i = 0; i < Math.min(arr.length, 5); i++) walk(arr[i], `${path}[]`, depth + 1);
      return;
    }
    if (t === 'obj') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        walk(child, path ? `${path}.${k}` : k, depth + 1);
      }
      return;
    }
    if (!path || out.has(path)) return;
    out.set(path, { path, type: t, sample: sampleOf(v) });
  };

  walk(value, '', 0);
  return [...out.values()];
}

function sampleOf(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/* ------------------------------------------------------------------ *
 * Value-level heuristics
 *
 * Each of these answers "could this number be an X?" - never "this IS an X".
 * They exist so the classifier can score a payload on evidence rather than on
 * a guessed endpoint name.
 * ------------------------------------------------------------------ */

/** Decimal odds live in a narrow band and are almost never whole numbers. */
export function looksLikeDecimalOdds(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 1.0 && v < 1000;
}

/** Epoch seconds or milliseconds within a plausible window (2015-2050). */
export function looksLikeEpoch(v: unknown): { is: boolean; unit: 'ms' | 's' | null } {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { is: false, unit: null };
  if (v > 1_400_000_000_000 && v < 2_500_000_000_000) return { is: true, unit: 'ms' };
  if (v > 1_400_000_000 && v < 2_500_000_000) return { is: true, unit: 's' };
  return { is: false, unit: null };
}

export function looksLikeIsoDate(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v);
}

/** A masked handle as feeds display them, e.g. four stars then two letters. */
export function looksLikeMaskedHandle(v: unknown): boolean {
  return typeof v === 'string' && /[*•]{2,}/.test(v) && v.length <= 40;
}

/** Money-ish: finite, non-negative, and not obviously an id. */
export function looksLikeStake(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100_000_000;
}

export function looksLikeCurrencyCode(v: unknown): boolean {
  return typeof v === 'string' && /^[A-Z]{3,5}$/.test(v);
}

/**
 * Counts how many objects in an array satisfy a predicate, as a fraction.
 * Classification rules are written against fractions so one odd row cannot
 * flip a verdict.
 */
export function fractionOf<T>(items: readonly T[], pred: (t: T) => boolean, sample = 40): number {
  if (items.length === 0) return 0;
  const n = Math.min(items.length, sample);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const item = items[i];
    if (item !== undefined && pred(item)) hits++;
  }
  return hits / n;
}

/**
 * Finds arrays of objects anywhere in a payload, biggest first. Feed and event
 * payloads are usually wrapped (`{data:{items:[...]}}`, `{result:{bets:[]}}`),
 * and we do not know the wrapper names, so we search structurally.
 */
export function findObjectArrays(
  value: unknown,
  opts?: { minLength?: number; maxDepth?: number; limit?: number },
): Array<{ path: string; items: Record<string, unknown>[] }> {
  const minLength = opts?.minLength ?? 1;
  const maxDepth = opts?.maxDepth ?? 8;
  const limit = opts?.limit ?? 20;
  const found: Array<{ path: string; items: Record<string, unknown>[] }> = [];

  const walk = (v: unknown, path: string, depth: number): void => {
    if (found.length >= limit || depth > maxDepth || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const objs = v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= minLength && objs.length === v.length) {
        found.push({ path: path || '$', items: objs });
      }
      for (let i = 0; i < Math.min(v.length, 5); i++) walk(v[i], `${path}[]`, depth + 1);
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      walk(child, path ? `${path}.${k}` : k, depth + 1);
    }
  };

  walk(value, '', 0);
  return found.sort((a, b) => b.items.length - a.items.length);
}

/**
 * Case- and separator-insensitive key lookup. BETBY payloads (and the many
 * books built on it) are inconsistent about camelCase vs snake_case, and we
 * must not hard-code either.
 */
export function pick(obj: Record<string, unknown>, ...candidates: string[]): unknown {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const index = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) index.set(norm(k), v);
  for (const c of candidates) {
    const hit = index.get(norm(c));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Finds the first key whose normalized name matches a pattern. */
export function pickByPattern(obj: Record<string, unknown>, pattern: RegExp): { key: string; value: unknown } | null {
  for (const [k, v] of Object.entries(obj)) {
    if (pattern.test(k)) return { key: k, value: v };
  }
  return null;
}
