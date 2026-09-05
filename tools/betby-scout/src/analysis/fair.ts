/**
 * Fair value from a single book's market.
 *
 * See the header of ./types.ts for why this can never, on its own, produce an
 * edge. Everything here is built so the arithmetic makes that obvious rather
 * than hiding it: `evAgainstSameBook` returns a NEGATIVE number - the book's
 * margin - and it exists precisely so a test can assert that and a caller
 * cannot pretend otherwise.
 *
 * What this module is genuinely for: measuring the book's margin, normalizing
 * prices into probabilities so different markets can be compared, and providing
 * the fair-probability input that closing-line value needs.
 */

import {
  expectedValue,
  fairProbabilities,
  fairProbabilitiesShin,
  impliedProbability,
  isValidDecimalOdds,
  overround,
  probabilityToDecimal,
} from '../shared/odds.ts';
import {
  isEdgeClaimable,
  type CompleteMarket,
  type DevigMethod,
  type FairPrice,
  type FairProbability,
  type FairSource,
  type MarketOutcome,
} from './types.ts';

/**
 * Markets with this many outcomes or more are not de-vigged.
 *
 * Proportional removal assumes margin is spread evenly, and that assumption
 * degrades badly as the field grows: on a 40-runner outright the longshots
 * carry most of the margin and the result is confidently wrong. Refusing is
 * better than returning a number nobody should use.
 */
export const MAX_DEVIG_OUTCOMES = 12;

/** Below this the "market" is one price, and a lone price has no overround. */
export const MIN_DEVIG_OUTCOMES = 2;

/**
 * An overround this far from 1 means we are not looking at a complete market -
 * usually a suspended outcome or a market we assembled wrongly. Rejecting is
 * the honest response; de-vigging it would silently redistribute a phantom
 * margin across the outcomes that remain.
 */
export const MAX_PLAUSIBLE_OVERROUND = 1.6;
export const MIN_PLAUSIBLE_OVERROUND = 0.85;

export interface DevigOptions {
  method?: DevigMethod;
  source?: FairSource;
}

export interface DevigFailure {
  ok: false;
  reason: string;
}

export type DevigOutcome = { ok: true; fair: FairPrice } | DevigFailure;

/**
 * Removes the book's margin from a complete market.
 *
 * Returns a failure with a stated reason rather than a partial result: a caller
 * that receives `{ok:false}` cannot accidentally treat it as a probability.
 */
export function devigMarket(market: CompleteMarket, opts: DevigOptions = {}): DevigOutcome {
  const method = opts.method ?? 'shin';
  const source = opts.source ?? 'single-book-devig';
  const outcomes = market.outcomes;

  if (outcomes.length < MIN_DEVIG_OUTCOMES) {
    return { ok: false, reason: `a market needs at least ${MIN_DEVIG_OUTCOMES} priced outcomes; this has ${outcomes.length}` };
  }
  if (outcomes.length > MAX_DEVIG_OUTCOMES) {
    return {
      ok: false,
      reason: `${outcomes.length} outcomes exceeds the ${MAX_DEVIG_OUTCOMES}-way de-vig limit - proportional and Shin both degrade on large fields, so no fair value is offered`,
    };
  }

  const prices = outcomes.map((o) => o.decimalOdds);
  for (const [i, price] of prices.entries()) {
    if (!isValidDecimalOdds(price)) {
      return { ok: false, reason: `outcome ${i} has price ${price}, which is not a valid decimal price` };
    }
  }

  const book = overround(prices);
  if (book === null) {
    return { ok: false, reason: 'overround could not be computed' };
  }
  if (book < MIN_PLAUSIBLE_OVERROUND || book > MAX_PLAUSIBLE_OVERROUND) {
    return {
      ok: false,
      reason:
        `overround of ${book.toFixed(3)} is outside the plausible ${MIN_PLAUSIBLE_OVERROUND}-${MAX_PLAUSIBLE_OVERROUND} band, ` +
        'which almost always means the market is incomplete or was assembled from mismatched outcomes',
    };
  }

  const fair = method === 'shin' ? fairProbabilitiesShin(prices) : fairProbabilities(prices);
  if (fair === null) {
    // Shin can legitimately fail to converge; say so instead of silently
    // falling back to a different method under the same label.
    return { ok: false, reason: `${method} de-vig did not converge on this market` };
  }

  const results: FairProbability[] = [];
  for (const [i, outcome] of outcomes.entries()) {
    const p = fair[i];
    const raw = impliedProbability(outcome.decimalOdds);
    if (p === undefined || raw === null) {
      return { ok: false, reason: `outcome ${i} produced no probability` };
    }
    const fairOdds = probabilityToDecimal(p);
    if (fairOdds === null) {
      return { ok: false, reason: `outcome ${i} produced a fair probability of ${p}, which has no price` };
    }
    results.push({
      selectionKey: outcome.selectionKey,
      rawProbability: raw,
      fairProbability: p,
      decimalOdds: outcome.decimalOdds,
      fairDecimalOdds: fairOdds,
    });
  }

  return {
    ok: true,
    fair: {
      marketKey: market.marketKey,
      eventKey: market.eventKey,
      method,
      source,
      overround: book,
      marginPct: book - 1,
      outcomes: results,
      ts: market.ts,
      warnings: devigWarnings(market, book, method, source),
    },
  };
}

function devigWarnings(market: CompleteMarket, book: number, method: DevigMethod, source: FairSource): string[] {
  const out: string[] = [];

  if (!isEdgeClaimable(source)) {
    out.push(
      `This fair value is derived from this book's own prices. Betting any outcome of it back into the same ` +
        `book returns about ${(100 * (1 / book - 1)).toFixed(2)}% per unit staked - the margin - and the de-vig ` +
        'cannot produce a positive number by construction. Usable for margin comparison and closing-line ' +
        'value, never as an edge.',
    );
  }

  if (method === 'proportional') {
    const longest = Math.max(...market.outcomes.map((o) => o.decimalOdds));
    if (longest >= 5) {
      out.push(
        `Proportional de-vig spreads margin evenly, but books load more of it onto longshots. The ${longest.toFixed(2)} ` +
          'outcome here is therefore assigned a higher fair probability than it deserves - the direction that ' +
          'manufactures false value. Shin is the better estimate.',
      );
    }
  }

  if (book > 1.15) {
    out.push(
      `Overround is ${((book - 1) * 100).toFixed(1)}%, which is high. Fair values from a wide market are sensitive ` +
        'to the de-vig method chosen, so treat the numbers as a range rather than a point.',
    );
  }

  if (market.outcomes.length >= 3) {
    out.push(
      `${market.outcomes.length}-way market: de-vig error grows with the number of outcomes, so these ` +
        'probabilities are less reliable than a two-way equivalent.',
    );
  }

  return out;
}

/**
 * Expected value of betting a selection back into the book its own fair value
 * came from.
 *
 * THIS IS ALWAYS NEGATIVE, and the arithmetic says why. Under proportional
 * de-vig the fair probability of outcome i is (1/d_i)/overround, so
 *
 *     EV_i = p_i * d_i - 1 = (1/d_i)/Φ * d_i - 1 = 1/Φ - 1
 *
 * which is the same number for every outcome in the market and is negative for
 * any Φ > 1. On a 1.90/1.90 market Φ = 1.0526 and every outcome returns -5%:
 * precisely the book's margin, which is the fee for playing.
 *
 * Shin redistributes margin unevenly, so its per-outcome EV varies a little,
 * but it is negative everywhere for the same reason.
 *
 * The function exists so this can be asserted in a test rather than merely
 * asserted in a comment. A caller wanting a real edge needs a fair value whose
 * source satisfies isEdgeClaimable - see ./types.ts.
 */
export function evAgainstSameBook(fair: FairPrice, selectionKey: string): number | null {
  const outcome = fair.outcomes.find((o) => o.selectionKey === selectionKey);
  if (!outcome) return null;
  return expectedValue(outcome.fairProbability, outcome.decimalOdds);
}

/**
 * Expected value against an INDEPENDENT fair probability - a consensus from
 * other books, or a closing line. Refuses when the estimate came from the same
 * book as the price.
 */
export function evAgainstIndependent(input: {
  fairProbability: number;
  decimalOdds: number;
  source: FairSource;
}): { ok: true; ev: number } | DevigFailure {
  if (!isEdgeClaimable(input.source)) {
    return {
      ok: false,
      reason:
        `cannot claim an edge against a "${input.source}" fair value - it is derived from the same book as the ` +
        'price being evaluated, so any apparent edge is arithmetic noise',
    };
  }
  const ev = expectedValue(input.fairProbability, input.decimalOdds);
  if (ev === null) return { ok: false, reason: 'invalid probability or price' };
  return { ok: true, ev };
}

/* ------------------------------------------------------------------ *
 * Assembling markets from stored rows
 * ------------------------------------------------------------------ */

export interface RawSelectionRow {
  selectionKey: string;
  marketKey: string;
  eventKey: string;
  sportsbookId: string;
  name: string | null;
  marketName: string | null;
  marketType: string | null;
  line: number | null;
  decimalOdds: number | null;
  status: string | null;
  ts: number;
}

/**
 * Groups priced selections into markets.
 *
 * "Complete" here means every selection we have ever seen for the market
 * currently has a price. We cannot prove a market has no further outcomes -
 * only that none of the ones we know about are missing - so `devigMarket`'s
 * overround sanity band is the real backstop, and this is a first filter.
 */
export function assembleMarkets(rows: readonly RawSelectionRow[]): {
  markets: CompleteMarket[];
  incomplete: Array<{ marketKey: string; reason: string }>;
} {
  const grouped = new Map<string, RawSelectionRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.marketKey);
    if (list) list.push(row);
    else grouped.set(row.marketKey, [row]);
  }

  const markets: CompleteMarket[] = [];
  const incomplete: Array<{ marketKey: string; reason: string }> = [];

  for (const [marketKey, group] of grouped) {
    const unpriced = group.filter((r) => r.decimalOdds === null || !isValidDecimalOdds(r.decimalOdds));
    if (unpriced.length > 0) {
      incomplete.push({
        marketKey,
        reason: `${unpriced.length} of ${group.length} outcomes have no usable price`,
      });
      continue;
    }
    if (group.length < MIN_DEVIG_OUTCOMES) {
      incomplete.push({ marketKey, reason: `only ${group.length} outcome known` });
      continue;
    }

    const first = group[0];
    if (!first) continue;

    markets.push({
      marketKey,
      eventKey: first.eventKey,
      sportsbookId: first.sportsbookId,
      name: first.marketName,
      type: first.marketType,
      line: first.line,
      ts: Math.max(...group.map((r) => r.ts)),
      outcomes: group.map(
        (r): MarketOutcome => ({
          selectionKey: r.selectionKey,
          name: r.name,
          decimalOdds: r.decimalOdds as number,
          line: r.line,
        }),
      ),
    });
  }

  return { markets, incomplete };
}

/* ------------------------------------------------------------------ *
 * Margin comparison - the honest headline metric for a single book
 * ------------------------------------------------------------------ */

export interface MarginSummary {
  /** What the grouping is over, e.g. a sport name or a market type. */
  group: string;
  markets: number;
  medianMarginPct: number;
  minMarginPct: number;
  maxMarginPct: number;
}

/**
 * Median margin per group. Median rather than mean because a single mis-parsed
 * market with a 40% overround would drag an average badly, and the point of
 * this number is to be comparable.
 */
export function summarizeMargins(entries: ReadonlyArray<{ group: string; marginPct: number }>): MarginSummary[] {
  const grouped = new Map<string, number[]>();
  for (const e of entries) {
    const list = grouped.get(e.group);
    if (list) list.push(e.marginPct);
    else grouped.set(e.group, [e.marginPct]);
  }

  const out: MarginSummary[] = [];
  for (const [group, values] of grouped) {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median =
      values.length % 2 === 0 ? ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2 : (values[mid] ?? 0);
    out.push({
      group,
      markets: values.length,
      medianMarginPct: median,
      minMarginPct: values[0] ?? 0,
      maxMarginPct: values[values.length - 1] ?? 0,
    });
  }
  return out.sort((a, b) => b.markets - a.markets);
}
