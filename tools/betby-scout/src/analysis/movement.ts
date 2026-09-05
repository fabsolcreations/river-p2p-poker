/**
 * Line movement: a price measured against its own past.
 *
 * This is one of the few things a single book can honestly tell us (see the
 * header of ./types.ts). A movement is NOT an edge and must never be presented
 * as one: it says money arrived on a side, not that the money was right. The
 * only claim made here is descriptive - "this price moved this far, this fast,
 * over this many observations".
 *
 * Two decisions drive the whole file, and both exist to stop a specific
 * statistical error:
 *
 *   1. Everything is measured in IMPLIED PROBABILITY, never in an odds ratio.
 *      1.10 -> 1.05 moves the market by 4.3 percentage points; 11.0 -> 10.5
 *      moves it by 0.43. A ratio calls both "4.5% shorter" and would therefore
 *      rank every longshot tick alongside a genuine favourite move, filling the
 *      tool with noise that looks like steam.
 *
 *   2. Time is real elapsed time, and a gap breaks the window. Snapshots are
 *      written only when a price CHANGES (see the normalizer), so the series is
 *      irregular by construction: two adjacent points can be an hour apart, and
 *      that hour usually means "we were not watching", not "the price crept".
 *      Averaging a move across a gap manufactures a slow, confident-looking
 *      trend out of two unrelated observations.
 */

import { impliedProbability } from '../shared/odds.ts';
import {
  DEFAULT_MOVEMENT_OPTIONS,
  type LineMovement,
  type MovementKind,
  type MovementOptions,
  type PriceSeries,
} from './types.ts';

const MS_PER_MINUTE = 60_000;

/**
 * How many consecutive legs may be folded into one round-trip. Two (out and
 * back) is the case worth naming; beyond four the market is simply oscillating
 * and calling that a single "round trip" stops describing anything.
 */
export const MAX_ROUND_TRIP_RUNS = 4;

/** A usable observation: a valid price, its timestamp, and its probability. */
export interface SeriesPoint {
  ts: number;
  decimalOdds: number;
  /** Raw implied probability, vig included. Comparable across price ranges. */
  probability: number;
}

export interface SeriesSummary {
  first: SeriesPoint;
  last: SeriesPoint;
  /** Shortest price seen (lowest decimal odds = highest implied probability). */
  min: SeriesPoint;
  /** Longest price seen. */
  max: SeriesPoint;
  /**
   * probability(last) - probability(first). Positive means the price shortened
   * over the series; negative means it drifted out.
   */
  probDelta: number;
  samples: number;
}

/**
 * Drops what we cannot measure, sorts oldest-first, and collapses same-instant
 * duplicates.
 *
 * Deliberately does NOT filter on `status`. The status vocabulary is whatever
 * the book puts on the wire - free text, frequently null (see the adapters) -
 * so a hard-coded list of "suspended"-looking strings would silently discard
 * real prices from any book that words it differently. A price we cannot parse
 * is dropped; a price we can parse is kept, and the caller can see the status.
 */
function usablePoints(series: PriceSeries): SeriesPoint[] {
  const raw = series && Array.isArray(series.points) ? series.points : [];
  const out: SeriesPoint[] = [];
  for (const p of raw) {
    if (!p || typeof p.ts !== 'number' || !Number.isFinite(p.ts)) continue;
    // impliedProbability is the single validity gate: it returns null for
    // anything outside the plausible decimal-odds band, so a mis-parsed 0 or a
    // 40,000 never reaches the arithmetic.
    const probability = impliedProbability(p.decimalOdds);
    if (probability === null) continue;
    out.push({ ts: p.ts, decimalOdds: p.decimalOdds, probability });
  }
  out.sort((a, b) => a.ts - b.ts);

  // Same-instant duplicates: keep the later-recorded one. Two different prices
  // stamped identically cannot both have been available, and an interval of
  // zero elapsed time would otherwise imply an infinite rate.
  const deduped: SeriesPoint[] = [];
  for (const p of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.ts === p.ts) deduped[deduped.length - 1] = p;
    else deduped.push(p);
  }
  return deduped;
}

/**
 * Summary of a whole series. Returns null only when nothing in it was usable -
 * a single point is a legitimate answer (probDelta 0, samples 1), because "we
 * have one price and it has not moved" is true and worth showing.
 */
export function summarizeSeries(series: PriceSeries): SeriesSummary | null {
  const pts = usablePoints(series);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return null;

  let min = first;
  let max = first;
  for (const p of pts) {
    if (p.decimalOdds < min.decimalOdds) min = p;
    if (p.decimalOdds > max.decimalOdds) max = p;
  }

  return {
    first,
    last,
    min,
    max,
    probDelta: last.probability - first.probability,
    samples: pts.length,
  };
}

function resolveOptions(opts?: MovementOptions): Required<MovementOptions> {
  const d = DEFAULT_MOVEMENT_OPTIONS;
  // A non-positive or non-finite threshold is treated as absent rather than
  // honoured. minProbDelta of 0 in particular would make every rounding tick a
  // "movement" and would make the round-trip rule below unsatisfiable.
  const positive = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    minProbDelta: positive(opts?.minProbDelta, d.minProbDelta),
    steamProbPerMinute: positive(opts?.steamProbPerMinute, d.steamProbPerMinute),
    maxGapMs: positive(opts?.maxGapMs, d.maxGapMs),
  };
}

/** A maximal stretch of points moving in one direction. Indices into `pts`. */
interface Run {
  from: number;
  to: number;
  /** probability(to) - probability(from). Sign carries the direction. */
  delta: number;
}

/**
 * Splits [start, end] into runs of one direction.
 *
 * A run ends at its extreme, and only a reversal of at least `noise` ends it.
 * That tolerance is not decoration: prices tick against the trend constantly,
 * and a splitter that ends a run on any counter-tick chops one sustained move
 * into fragments, each of which is then too small to clear minProbDelta. Real
 * steam would disappear from the output entirely, which is the worst kind of
 * failure - a quiet one. A reversal too small to be reported as a movement is
 * too small to end one, so `noise` is minProbDelta and needs no extra knob.
 *
 * A trailing wiggle below the tolerance is left out of the window: the move
 * ended where the price turned, not where we stopped looking.
 */
function runsIn(pts: readonly SeriesPoint[], start: number, end: number, noise: number): Run[] {
  const runs: Run[] = [];
  let from = start;
  let extreme = start;
  let direction = 0;

  const close = (to: number): void => {
    const head = pts[from];
    const tail = pts[to];
    if (head && tail && to > from) runs.push({ from, to, delta: tail.probability - head.probability });
  };

  for (let i = start + 1; i <= end; i++) {
    const cur = pts[i];
    const ext = pts[extreme];
    if (!cur || !ext) continue;
    const move = cur.probability - ext.probability;

    if (direction === 0) {
      if (move === 0) continue;
      direction = move > 0 ? 1 : -1;
      extreme = i;
      continue;
    }

    // Still going our way: this is the new extreme.
    if (move * direction > 0) {
      extreme = i;
      continue;
    }
    // Against us, but under the tolerance: a tick, not a turn.
    if (Math.abs(move) < noise) continue;

    close(extreme);
    from = extreme;
    direction = -direction;
    extreme = i;
  }

  close(extreme);
  return runs;
}

function classifyRun(
  delta: number,
  durationMs: number,
  opts: Required<MovementOptions>,
): MovementKind {
  // Zero elapsed time cannot support a rate. An "infinite" rate is a clock
  // artifact, not steam, so such a window is reported as a plain move.
  if (durationMs <= 0) return 'move';
  const ratePerMinute = Math.abs(delta) / (durationMs / MS_PER_MINUTE);
  if (ratePerMinute < opts.steamProbPerMinute) return 'move';
  return delta > 0 ? 'steam' : 'drift';
}

/**
 * Detects movements in one selection's price history.
 *
 * Returns an empty array - never throws - for a series with fewer than two
 * usable points, and for one whose every window falls under the thresholds.
 * Empty is the honest answer for a price that has not done anything.
 *
 * NOTE ON THRESHOLDS: DEFAULT_MOVEMENT_OPTIONS are UNCALIBRATED starting
 * points, chosen for plausibility rather than measured against anything. Until
 * they have been validated against settled outcomes (Milestone 9), the labels
 * "steam" and "drift" mean only "faster than the number we guessed", and
 * nothing may act on them.
 */
export function detectMovements(series: PriceSeries, opts?: MovementOptions): LineMovement[] {
  const o = resolveOptions(opts);
  const pts = usablePoints(series);
  if (pts.length < 2) return [];

  const selectionKey = series?.selectionKey ?? '';
  const eventKey = series?.eventKey ?? '';
  const movements: LineMovement[] = [];

  const emit = (from: number, to: number, kind: MovementKind, delta: number): void => {
    const a = pts[from];
    const b = pts[to];
    if (!a || !b) return;
    movements.push({
      selectionKey,
      eventKey,
      kind,
      tsFrom: a.ts,
      tsTo: b.ts,
      oddsFrom: a.decimalOdds,
      oddsTo: b.decimalOdds,
      probDelta: delta,
      durationMs: b.ts - a.ts,
      samples: to - from + 1,
    });
  };

  // Segment on gaps first. A window may never span a gap longer than maxGapMs:
  // across a silence we do not know whether the price crept or jumped, and
  // dividing the change by the silence invents a rate.
  let segStart = 0;
  for (let i = 1; i <= pts.length; i++) {
    const cur = pts[i];
    const prev = pts[i - 1];
    const broken = i === pts.length || !cur || !prev || cur.ts - prev.ts > o.maxGapMs;
    if (!broken) continue;

    const segEnd = i - 1;
    if (segEnd > segStart) {
      const runs = runsIn(pts, segStart, segEnd, o.minProbDelta);

      let r = 0;
      while (r < runs.length) {
        const run = runs[r];
        if (!run) break;

        if (Math.abs(run.delta) < o.minProbDelta) {
          r += 1;
          continue;
        }

        // Round-trip: the price moved out and came back. We look ahead a few
        // legs and fold the whole excursion into one entry, because reporting
        // the outward leg on its own is exactly how a detector ends up calling
        // noise "steam" and a tool ends up acting on it. The return threshold
        // needs no new knob: coming back to within minProbDelta of the start
        // means the NET change is below the level at which we would report a
        // move at all, which is the definition of having gone nowhere.
        let net = run.delta;
        let roundTripEnd = -1;
        for (let j = r + 1; j < runs.length && j - r < MAX_ROUND_TRIP_RUNS; j++) {
          const leg = runs[j];
          if (!leg) break;
          net += leg.delta;
          const opposite = Math.sign(leg.delta) === -Math.sign(run.delta);
          if (opposite && Math.abs(leg.delta) >= o.minProbDelta && Math.abs(net) < o.minProbDelta) {
            roundTripEnd = j;
            break;
          }
        }

        if (roundTripEnd >= 0) {
          const last = runs[roundTripEnd];
          if (last) {
            const a = pts[run.from];
            const b = pts[last.to];
            // The reported delta is the NET change, which is near zero. That is
            // the honest headline: the price ended where it started.
            if (a && b) emit(run.from, last.to, 'round-trip', b.probability - a.probability);
            r = roundTripEnd + 1;
            continue;
          }
        }

        const a = pts[run.from];
        const b = pts[run.to];
        if (a && b) emit(run.from, run.to, classifyRun(run.delta, b.ts - a.ts, o), run.delta);
        r += 1;
      }
    }

    segStart = i;
  }

  return movements;
}
