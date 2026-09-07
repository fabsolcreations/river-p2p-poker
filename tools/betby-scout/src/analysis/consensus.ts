/**
 * Multi-book consensus - the only thing in Scout that can support an edge claim.
 *
 * The method, and why each step is there:
 *
 *   1. De-vig EACH book's market SEPARATELY. Averaging raw prices across books
 *      averages their margins in too, and the result is a "fair" number that
 *      still has 5% of vig baked into it. Every book gets its own margin
 *      removed before anything is combined.
 *
 *   2. Take the MEDIAN of the fair probabilities, not the mean. One book with a
 *      stale or mis-parsed price should move the consensus a little, not drag
 *      it. With two books the median is the mean, which is one reason three is
 *      the real minimum for a number worth acting on.
 *
 *   3. EXCLUDE the book being evaluated. Comparing Duel against a consensus
 *      that contains Duel is circular, and the circularity is invisible in the
 *      output - it just makes the edge look smaller and more credible.
 *
 *   4. Refuse on thin or stale input rather than returning a weaker number.
 *
 * Only after all four does `source` become 'multi-book-consensus', which is the
 * single value `isEdgeClaimable()` accepts.
 */

import { expectedValue, isValidDecimalOdds } from '../shared/odds.ts';
import { devigMarket, type DevigFailure } from './fair.ts';
import type { CompleteMarket, DevigMethod, FairSource } from './types.ts';

/** One book's complete market for a single outcome set. */
export interface BookMarket {
  bookKey: string;
  bookTitle: string;
  /** Epoch ms this book's prices were last updated. */
  lastUpdate: number | null;
  /** Outcome name -> decimal price. Names must already be aligned across books. */
  prices: Map<string, number>;
}

/**
 * Two books is arithmetic; three is a consensus. Below three the median has no
 * resistance to a single bad price, which is the entire reason for using one.
 */
export const MIN_BOOKS_FOR_CONSENSUS = 3;

/**
 * Prices older than this are dropped. A book that has not moved in six hours on
 * a market that is about to start is not quoting, it is stale, and treating a
 * stale price as a live opinion is how a phantom edge appears.
 */
export const MAX_PRICE_AGE_MS = 6 * 60 * 60 * 1000;

export interface ConsensusOutcome {
  name: string;
  /** Median fair probability across the contributing books. */
  fairProbability: number;
  /** What that probability is worth as a price. */
  fairDecimalOdds: number;
  /** Spread of book opinions - wide means they disagree. */
  minProbability: number;
  maxProbability: number;
  books: number;
}

export interface Consensus {
  source: FairSource;
  method: DevigMethod;
  outcomes: ConsensusOutcome[];
  /** Books that contributed after exclusions and staleness filtering. */
  contributingBooks: string[];
  /** Median overround of the contributing books - what the market charges. */
  medianOverround: number;
  warnings: string[];
}

export type ConsensusResult = { ok: true; consensus: Consensus } | DevigFailure;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

export interface ConsensusOptions {
  method?: DevigMethod;
  /** Book keys to leave out - always includes the book being evaluated. */
  exclude?: ReadonlySet<string>;
  now?: number;
  maxPriceAgeMs?: number;
}

/**
 * Builds a consensus fair price from several books' markets.
 *
 * `markets` must already agree on outcome names; aligning them is the caller's
 * job because only the caller knows how its source names things.
 */
export function buildConsensus(markets: readonly BookMarket[], opts: ConsensusOptions = {}): ConsensusResult {
  const method = opts.method ?? 'shin';
  const exclude = opts.exclude ?? new Set<string>();
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxPriceAgeMs ?? MAX_PRICE_AGE_MS;
  const warnings: string[] = [];

  const excluded = markets.filter((m) => exclude.has(m.bookKey)).map((m) => m.bookKey);
  let usable = markets.filter((m) => !exclude.has(m.bookKey));

  const stale = usable.filter((m) => m.lastUpdate !== null && now - m.lastUpdate > maxAge);
  if (stale.length > 0) {
    usable = usable.filter((m) => m.lastUpdate === null || now - m.lastUpdate <= maxAge);
    warnings.push(
      `${stale.length} book(s) dropped for stale prices (older than ${Math.round(maxAge / 3_600_000)}h): ` +
        `${stale.map((m) => m.bookTitle).join(', ')}.`,
    );
  }

  if (usable.length < MIN_BOOKS_FOR_CONSENSUS) {
    return {
      ok: false,
      reason:
        `only ${usable.length} independent book(s) available; ${MIN_BOOKS_FOR_CONSENSUS} are required. ` +
        'Below three, the median has no resistance to one bad price, which is the whole reason for using it' +
        (excluded.length > 0 ? ` (excluded: ${excluded.join(', ')})` : ''),
    };
  }

  // Every book must quote the same outcome set, or we are averaging different
  // questions. Intersect rather than union.
  const names = [...(usable[0]?.prices.keys() ?? [])].filter((name) =>
    usable.every((m) => isValidDecimalOdds(m.prices.get(name))),
  );
  if (names.length < 2) {
    return { ok: false, reason: 'the books do not share at least two commonly-named outcomes' };
  }

  // Step 1: de-vig each book on its own.
  const perBook: Array<{ book: BookMarket; fair: Map<string, number>; overround: number }> = [];
  const devigFailures: string[] = [];

  for (const book of usable) {
    const market: CompleteMarket = {
      marketKey: `consensus:${book.bookKey}`,
      eventKey: 'consensus',
      sportsbookId: book.bookKey,
      name: null,
      type: null,
      line: null,
      ts: book.lastUpdate ?? now,
      outcomes: names.map((name) => ({
        selectionKey: name,
        name,
        decimalOdds: book.prices.get(name) as number,
        line: null,
      })),
    };
    const result = devigMarket(market, { method });
    if (!result.ok) {
      devigFailures.push(`${book.bookTitle}: ${result.reason}`);
      continue;
    }
    const fair = new Map<string, number>();
    for (const o of result.fair.outcomes) fair.set(o.selectionKey, o.fairProbability);
    perBook.push({ book, fair, overround: result.fair.overround });
  }

  if (devigFailures.length > 0) {
    warnings.push(`${devigFailures.length} book(s) could not be de-vigged and were dropped: ${devigFailures.join('; ')}`);
  }
  if (perBook.length < MIN_BOOKS_FOR_CONSENSUS) {
    return {
      ok: false,
      reason: `only ${perBook.length} book(s) survived de-vigging; ${MIN_BOOKS_FOR_CONSENSUS} are required`,
    };
  }

  // Step 2: median across books, per outcome.
  const outcomes: ConsensusOutcome[] = names.map((name) => {
    const probs = perBook.map((b) => b.fair.get(name) ?? 0).filter((p) => p > 0);
    const med = median(probs);
    return {
      name,
      fairProbability: med,
      fairDecimalOdds: med > 0 ? 1 / med : Number.POSITIVE_INFINITY,
      minProbability: Math.min(...probs),
      maxProbability: Math.max(...probs),
      books: probs.length,
    };
  });

  // The medians will not sum to exactly 1 - each is taken independently.
  // Renormalise, and say so if the drift was large, because a big drift means
  // the books genuinely disagree and the consensus is softer than it looks.
  const total = outcomes.reduce((a, o) => a + o.fairProbability, 0);
  if (total > 0) {
    for (const o of outcomes) {
      o.fairProbability = o.fairProbability / total;
      o.fairDecimalOdds = 1 / o.fairProbability;
    }
  }
  if (Math.abs(total - 1) > 0.02) {
    warnings.push(
      `Per-outcome medians summed to ${total.toFixed(3)} before renormalising, meaning the books disagree ` +
        'materially about this market. Treat the consensus as a range, not a point.',
    );
  }

  const disagreement = Math.max(...outcomes.map((o) => o.maxProbability - o.minProbability));
  if (disagreement > 0.05) {
    warnings.push(
      `Books differ by up to ${(disagreement * 100).toFixed(1)} probability points on a single outcome. ` +
        'A wide spread usually means one book has not caught up with news the others have.',
    );
  }
  if (perBook.length < 5) {
    warnings.push(`Consensus is built from ${perBook.length} books. More books make the median more resistant.`);
  }
  if (excluded.length > 0) {
    warnings.push(`Excluded from the consensus: ${excluded.join(', ')} - a book cannot help price itself.`);
  }

  return {
    ok: true,
    consensus: {
      source: 'multi-book-consensus',
      method,
      outcomes,
      contributingBooks: perBook.map((b) => b.book.bookTitle),
      medianOverround: median(perBook.map((b) => b.overround)),
      warnings,
    },
  };
}

/**
 * Fair value from ONE sharp book, when a three-book consensus is unavailable.
 *
 * The tier below a consensus, and it says so in every warning it returns. It is
 * admissible for the one reason that matters - the price did not come from the
 * book being judged - and because de-vigging Pinnacle is the standard method in
 * betting analytics rather than a shortcut invented here.
 *
 * What it cannot do is notice that the reference book is the one that is wrong.
 * A consensus has that redundancy; this does not.
 */
export function buildSharpReference(market: BookMarket, opts: ConsensusOptions = {}): ConsensusResult {
  const method = opts.method ?? 'shin';
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxPriceAgeMs ?? MAX_PRICE_AGE_MS;

  if (market.lastUpdate !== null && now - market.lastUpdate > maxAge) {
    return { ok: false, reason: `the reference book's prices are older than ${Math.round(maxAge / 3_600_000)}h` };
  }

  const names = [...market.prices.keys()].filter((n) => isValidDecimalOdds(market.prices.get(n)));
  if (names.length < 2) {
    return { ok: false, reason: 'the reference book does not price at least two outcomes' };
  }

  const devigged = devigMarket(
    {
      marketKey: `sharp:${market.bookKey}`,
      eventKey: 'sharp',
      sportsbookId: market.bookKey,
      name: null,
      type: null,
      line: null,
      ts: market.lastUpdate ?? now,
      outcomes: names.map((name) => ({
        selectionKey: name,
        name,
        decimalOdds: market.prices.get(name) as number,
        line: null,
      })),
    },
    { method, source: 'sharp-reference' },
  );
  if (!devigged.ok) return devigged;

  return {
    ok: true,
    consensus: {
      source: 'sharp-reference',
      method,
      outcomes: devigged.fair.outcomes.map((o) => ({
        name: o.selectionKey,
        fairProbability: o.fairProbability,
        fairDecimalOdds: o.fairDecimalOdds,
        // One book has no spread of opinion. Reporting the same number for both
        // bounds is honest; inventing a range would not be.
        minProbability: o.fairProbability,
        maxProbability: o.fairProbability,
        books: 1,
      })),
      contributingBooks: [market.bookTitle],
      medianOverround: devigged.fair.overround,
      warnings: [
        `Fair value comes from ${market.bookTitle} alone, not from a consensus. It is admissible because it is ` +
          'not the book being judged, and because de-vigging a sharp book is the standard method - but it has no ' +
          'redundancy. If this book is the one that is wrong, nothing here can tell.',
        ...devigged.fair.warnings.filter((w) => !/own prices/.test(w)),
      ],
    },
  };
}

/* ------------------------------------------------------------------ *
 * The edge
 * ------------------------------------------------------------------ */

export interface EdgeInput {
  /** Outcome name as it appears in the consensus. */
  outcomeName: string;
  /** The price the book under evaluation is offering. */
  bookOdds: number;
  consensus: Consensus;
}

export interface Edge {
  outcomeName: string;
  bookOdds: number;
  consensusFairOdds: number;
  consensusProbability: number;
  /** Expected value per unit staked. 0.078 is +7.8%. */
  ev: number;
  /** How far the book's price is from consensus, in probability points. */
  probabilityGap: number;
  books: number;
  warnings: string[];
}

/**
 * The first genuinely claimable edge in this codebase.
 *
 * Still returns its warnings, because a positive EV against a three-book
 * consensus is an estimate with a confidence interval, not a fact.
 */
export function computeEdge(input: EdgeInput): { ok: true; edge: Edge } | DevigFailure {
  const outcome = input.consensus.outcomes.find((o) => o.name === input.outcomeName);
  if (!outcome) {
    return { ok: false, reason: `"${input.outcomeName}" is not in the consensus market` };
  }
  if (!isValidDecimalOdds(input.bookOdds)) {
    return { ok: false, reason: `${input.bookOdds} is not a valid decimal price` };
  }

  const ev = expectedValue(outcome.fairProbability, input.bookOdds);
  if (ev === null) {
    return { ok: false, reason: 'expected value could not be computed' };
  }

  const warnings = [...input.consensus.warnings];
  if (input.bookOdds >= 5) {
    warnings.push(
      'Longshot price: de-vig error is largest here, and it biases in the direction that invents value. ' +
        'Treat this edge as the least reliable kind.',
    );
  }
  if (ev > 0.15) {
    // A big number is more often a mistake than an opportunity.
    warnings.push(
      `An edge of ${(ev * 100).toFixed(1)}% is large enough to be suspicious. Before believing it, check that ` +
        'the event matched the right fixture and that the outcome names line up between books.',
    );
  }

  return {
    ok: true,
    edge: {
      outcomeName: outcome.name,
      bookOdds: input.bookOdds,
      consensusFairOdds: outcome.fairDecimalOdds,
      consensusProbability: outcome.fairProbability,
      ev,
      probabilityGap: outcome.fairProbability - 1 / input.bookOdds,
      books: outcome.books,
      warnings,
    },
  };
}
