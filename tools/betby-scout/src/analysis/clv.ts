/**
 * Closing line value.
 *
 * CLV is the strongest evidence a single book can give us (see ./types.ts).
 * It compares a price we recorded against the same book's own price at kickoff,
 * so it needs no second source: the book is being measured against itself at
 * the moment it knows the most.
 *
 * What CLV is NOT: an edge, an EV, or a profit. `isEdgeClaimable('closing-line')`
 * is false and stays false. Beating the close is evidence that a selection
 * process contains information; it is not money, and a positive number here may
 * never be rendered as one.
 *
 * The one silent-corruption risk in the whole idea is using an in-play price as
 * the close. Post-kickoff prices move for reasons that have nothing to do with
 * pre-game information - a goal, a red card - so a single in-play price folded
 * into a CLV series does not add noise, it adds bias, and nothing downstream
 * would show a symptom. `findClosingLine` therefore refuses rather than
 * approximates.
 */

import { clvPercent, clvProbability, isValidDecimalOdds, roiStdError } from '../shared/odds.ts';
import type { ClosingLine, ClvResult, FairSource, PriceSeries } from './types.ts';

/**
 * The fair-value source a closing line represents. Named here so a caller
 * cannot wire CLV into an edge calculation without tripping isEdgeClaimable.
 */
export const CLV_FAIR_SOURCE: FairSource = 'closing-line';

/**
 * Below this many settled bets, a CLV mean is not tested against zero at all.
 *
 * A two-standard-error test assumes the standard error is itself known
 * reasonably well, and on a handful of bets it is not - CLV per bet is
 * heavy-tailed, so three longshots can set the mean and the estimated variance
 * simultaneously. The floor is deliberately blunt: a plus figure over eleven
 * bets is a plus figure over eleven bets, and the summary says exactly that
 * rather than dressing it up in a t-statistic.
 */
export const MIN_CLV_SAMPLES = 30;

/** |t| at or above this is what we are willing to call "distinguishable". */
export const CLV_T_THRESHOLD = 2;

export interface ClvSummary {
  n: number;
  /** Mean CLV in probability terms (fraction, e.g. 0.012 = 1.2 points). */
  meanProbability: number;
  /** Mean CLV as a return against the close (fraction, e.g. 0.02 = 2%). */
  meanPercent: number;
  /** Standard error of meanProbability. Null when n < 2. */
  stdErrorProbability: number | null;
  /** Standard error of meanPercent. Null when n < 2. */
  stdErrorPercent: number | null;
  /** meanProbability / stdErrorProbability. Null when there is no usable SE. */
  tStat: number | null;
  /** True only when n >= MIN_CLV_SAMPLES and |tStat| >= CLV_T_THRESHOLD. */
  distinguishableFromZero: boolean;
  /** Plain-language statement of what this sample does and does not support. */
  note: string;
}

/**
 * The last price recorded at or before kickoff.
 *
 * Returns null when `startTime` is unknown, because without it we cannot tell a
 * pre-game price from an in-play one, and null when no price precedes kickoff,
 * because there is then nothing to close on. Both are honest empty answers; a
 * fallback to "the nearest price" would be a fabricated close.
 */
export function findClosingLine(series: PriceSeries, startTime: number | null): ClosingLine | null {
  if (startTime === null || typeof startTime !== 'number' || !Number.isFinite(startTime)) return null;
  const points = series && Array.isArray(series.points) ? series.points : [];

  let closing: { ts: number; decimalOdds: number } | null = null;
  let samples = 0;

  for (const p of points) {
    if (!p || typeof p.ts !== 'number' || !Number.isFinite(p.ts)) continue;
    // A price recorded after kickoff is an in-play price, whatever else it
    // looks like. It is not a candidate and it is not counted.
    if (p.ts > startTime) continue;
    // A mis-parsed price is not a close either. isValidDecimalOdds is the same
    // gate the rest of the system uses, so a price accepted here is a price
    // clvProbability will accept below.
    if (!isValidDecimalOdds(p.decimalOdds)) continue;
    samples += 1;
    // ">=" rather than ">": the series is oldest-first by contract, so a later
    // entry at the same instant is the more recently recorded one.
    if (!closing || p.ts >= closing.ts) closing = { ts: p.ts, decimalOdds: p.decimalOdds };
  }

  if (!closing) return null;

  return {
    selectionKey: series.selectionKey,
    eventKey: series.eventKey,
    closingOdds: closing.decimalOdds,
    closingTs: closing.ts,
    startTime,
    samples,
  };
}

/**
 * How long before kickoff our "closing" price was actually recorded.
 *
 * Worth showing next to any CLV figure: a close taken six hours out is not a
 * close in the sense the literature means, it is the last price we happened to
 * see, and CLV measured against it is much weaker evidence.
 */
export function closingLineAgeMs(closing: ClosingLine): number {
  return closing.startTime - closing.closingTs;
}

/**
 * CLV of one bet against a closing line.
 *
 * Sign convention, which is the thing most easily got backwards: POSITIVE means
 * the bettor got the better price. Betting 11.0 into a 9.0 close is positive -
 * the market ended up thinking the outcome more likely than the price paid for.
 * Both figures come from shared/odds.ts; nothing is re-derived here.
 */
export function computeClv(betOdds: number, closing: ClosingLine): ClvResult | null {
  if (!closing) return null;
  const probability = clvProbability(betOdds, closing.closingOdds);
  const percent = clvPercent(betOdds, closing.closingOdds);
  if (probability === null || percent === null) return null;
  return {
    selectionKey: closing.selectionKey,
    betOdds,
    closingOdds: closing.closingOdds,
    clvProbability: probability,
    clvPercent: percent,
  };
}

/**
 * Aggregates CLV across bets, and says whether the mean is distinguishable from
 * zero.
 *
 * The significance test is the point of the function. "+2% CLV" over eleven
 * bets is the single most common way a betting tool talks its user into
 * believing in a signal, and the number by itself cannot be argued with. Paired
 * with n and a standard error it can.
 */
export function clvSummary(results: readonly ClvResult[]): ClvSummary | null {
  const usable = (Array.isArray(results) ? results : []).filter(
    (r): r is ClvResult =>
      !!r && Number.isFinite(r.clvProbability) && Number.isFinite(r.clvPercent),
  );
  const n = usable.length;
  if (n === 0) return null;

  const probs = usable.map((r) => r.clvProbability);
  const percents = usable.map((r) => r.clvPercent);
  const meanProbability = probs.reduce((a, b) => a + b, 0) / n;
  const meanPercent = percents.reduce((a, b) => a + b, 0) / n;

  // roiStdError is the standard error of the mean of a set of per-bet numbers.
  // Its name comes from its first caller, not from its arithmetic, so it is the
  // right function here and re-deriving it would only risk disagreeing with it.
  const stdErrorProbability = roiStdError(probs);
  const stdErrorPercent = roiStdError(percents);

  const tStat =
    stdErrorProbability !== null && stdErrorProbability > 0
      ? meanProbability / stdErrorProbability
      : null;

  const distinguishableFromZero =
    n >= MIN_CLV_SAMPLES && tStat !== null && Math.abs(tStat) >= CLV_T_THRESHOLD;

  return {
    n,
    meanProbability,
    meanPercent,
    stdErrorProbability,
    stdErrorPercent,
    tStat,
    distinguishableFromZero,
    note: clvNote(n, meanPercent, tStat, distinguishableFromZero),
  };
}

function clvNote(
  n: number,
  meanPercent: number,
  tStat: number | null,
  distinguishable: boolean,
): string {
  const mean = `${(meanPercent * 100).toFixed(2)}% mean CLV`;

  if (n < MIN_CLV_SAMPLES) {
    return (
      `${mean} over ${n} bet${n === 1 ? '' : 's'}. That is below the ${MIN_CLV_SAMPLES}-bet floor for testing a ` +
      'CLV mean, so this figure is a description of what happened and not evidence of a signal, ' +
      'whichever way it points.'
    );
  }
  if (tStat === null) {
    return (
      `${mean} over ${n} bets, but the spread between bets could not be estimated, so the mean cannot ` +
      'be separated from chance.'
    );
  }
  if (!distinguishable) {
    return (
      `${mean} over ${n} bets, ${Math.abs(tStat).toFixed(2)} standard errors from zero. A result this size ` +
      'is what an ordinary run of luck looks like at this sample size.'
    );
  }
  return (
    `${mean} over ${n} bets, ${Math.abs(tStat).toFixed(2)} standard errors from zero. The mean is ` +
    'distinguishable from zero, which is evidence that the selections carried information about the ' +
    'closing price. It is not a profit figure and not an edge against this book.'
  );
}
