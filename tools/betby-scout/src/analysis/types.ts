/**
 * Analysis contract.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE ADDING ANYTHING THAT CALLS ITSELF AN EDGE
 * ---------------------------------------------------------------------------
 *
 * We have prices from exactly one book. De-vigging Duel's market gives a fair
 * probability derived FROM Duel, and betting that back into Duel returns
 *
 *     EV = p * d - 1 = (1/d)/overround * d - 1 = 1/overround - 1
 *
 * which is NEGATIVE for any overround above 1, identical for every outcome, and
 * exactly the book's margin. On a 1.90/1.90 market it is -5%. A single-book
 * de-vig cannot yield a positive number; anything that appears to is measuring
 * an incomplete market or a bug.
 *
 * That is not a limitation to be worked around. It is the arithmetic. A tool
 * that displayed "+7.8% EV" from a single book's own prices would be
 * manufacturing the exact illusion this project exists to avoid.
 *
 * So what IS computable from one book, honestly:
 *
 *   OVERROUND        How much margin the book charges on a market. Real,
 *                    directly measured, and comparable across sports and market
 *                    types. Tells you where the book is tight and where it is
 *                    not.
 *
 *   CLOSING LINE     A price now versus the same price at kickoff. Needs only
 *   VALUE            our own history, and is the strongest evidence available
 *                    that a bettor or a signal contains information.
 *
 *   LINE MOVEMENT    A price against its own past. Real, and the input to steam
 *                    and drift detection.
 *
 *   CROSS-MARKET     Two markets on one event implying different probabilities
 *   INCONSISTENCY    for the same outcome. Needs no second book, because the
 *                    contradiction is internal.
 *
 * A genuine price edge needs a SECOND source, and there is none yet. The
 * `FairPrice.source` field records where a fair estimate came from precisely so
 * that a single-book estimate can never be silently presented as an edge; see
 * `isEdgeClaimable`.
 */

import type { OddsSnapshot } from '../shared/types.ts';

/* ------------------------------------------------------------------ *
 * Fair value
 * ------------------------------------------------------------------ */

export type DevigMethod = 'proportional' | 'shin';

/**
 * Where a fair-probability estimate came from. This is the field that decides
 * whether an "edge" may be shown at all.
 */
export type FairSource =
  /** De-vigged from this book's own market. Cannot support an edge claim. */
  | 'single-book-devig'
  /** Median across three or more independent books. The strongest tier. */
  | 'multi-book-consensus'
  /**
   * De-vigged from ONE book chosen because it is sharp - in practice Pinnacle,
   * whose margins are thinnest and which does not limit winners, so it has no
   * reason to shade a price away from its true opinion.
   *
   * Weaker than a consensus and it must say so, but it is the standard method
   * in betting analytics and refusing it would throw away the best reference
   * available. The critical property is preserved: it is not the book being
   * evaluated, so the comparison does not collapse to minus the margin.
   */
  | 'sharp-reference'
  /** The closing price of this book's own market. Supports CLV, not live edge. */
  | 'closing-line';

export interface MarketOutcome {
  selectionKey: string;
  name: string | null;
  decimalOdds: number;
  line: number | null;
}

/**
 * A market we believe is COMPLETE - every outcome priced, nothing suspended.
 * Completeness is not cosmetic: an overround computed over a partial market is
 * meaningless, and every fair probability derived from it is wrong in a
 * direction nobody can predict.
 */
export interface CompleteMarket {
  marketKey: string;
  eventKey: string;
  sportsbookId: string;
  name: string | null;
  type: string | null;
  line: number | null;
  outcomes: MarketOutcome[];
  /** Epoch ms of the newest price in this market. */
  ts: number;
}

export interface FairProbability {
  selectionKey: string;
  /** Raw implied probability, vig included. */
  rawProbability: number;
  /** After vig removal. */
  fairProbability: number;
  /** The price this book is offering. */
  decimalOdds: number;
  /** What a fair price would be, given fairProbability. */
  fairDecimalOdds: number;
}

export interface FairPrice {
  marketKey: string;
  eventKey: string;
  method: DevigMethod;
  source: FairSource;
  /** Sum of raw implied probabilities. 1.06 means a 6% margin. */
  overround: number;
  /** Margin as a percentage of the fair book, i.e. overround - 1. */
  marginPct: number;
  outcomes: FairProbability[];
  ts: number;
  /** Structural caveats that must travel with any number derived from this. */
  warnings: string[];
}

/**
 * The gate. An edge may only be claimed against a fair value that did not come
 * from the same book being compared against.
 *
 * Kept as a function rather than a comment because a comment cannot fail a test.
 */
export function isEdgeClaimable(source: FairSource): boolean {
  // Both admissible sources share the one property that matters: the fair value
  // came from somewhere other than the book whose price is being judged.
  return source === 'multi-book-consensus' || source === 'sharp-reference';
}

/**
 * How much weight an edge from this source deserves. A consensus of independent
 * books beats one book's opinion, however sharp, and the UI should not present
 * them as equals.
 */
export function edgeStrength(source: FairSource): 'strong' | 'moderate' | 'none' {
  if (source === 'multi-book-consensus') return 'strong';
  if (source === 'sharp-reference') return 'moderate';
  return 'none';
}

/* ------------------------------------------------------------------ *
 * Line movement
 * ------------------------------------------------------------------ */

export type MovementKind =
  /** Rapid shortening - money arriving on this side. */
  | 'steam'
  /** Rapid lengthening. */
  | 'drift'
  /** Moved and came back. */
  | 'round-trip'
  /** Changed, but not fast or far enough to call. */
  | 'move';

export interface LineMovement {
  selectionKey: string;
  eventKey: string;
  kind: MovementKind;
  tsFrom: number;
  tsTo: number;
  oddsFrom: number;
  oddsTo: number;
  /**
   * Change in implied probability. Probability is additive and comparable
   * across price ranges; an odds RATIO is not. 1.10 -> 1.05 is a far larger
   * move than 11.0 -> 10.5, and a ratio would rank them the same.
   */
  probDelta: number;
  durationMs: number;
  /** How many recorded prices the window covers. */
  samples: number;
}

export interface MovementOptions {
  /** Minimum probability change to report at all. */
  minProbDelta?: number;
  /** Probability change per minute above which a move counts as steam. */
  steamProbPerMinute?: number;
  /** Ignore gaps longer than this - a stale series is not a fast move. */
  maxGapMs?: number;
}

export const DEFAULT_MOVEMENT_OPTIONS: Required<MovementOptions> = {
  // 1 percentage point of implied probability. Below this we are mostly
  // watching the book round its own prices.
  minProbDelta: 0.01,
  // 0.5pp per minute sustained. Chosen as a starting point, not a calibrated
  // constant - it MUST be validated against settled outcomes at Milestone 9
  // before anything acts on it.
  steamProbPerMinute: 0.005,
  maxGapMs: 30 * 60 * 1000,
};

/* ------------------------------------------------------------------ *
 * Closing line value
 * ------------------------------------------------------------------ */

export interface ClosingLine {
  selectionKey: string;
  eventKey: string;
  /** Last price recorded at or before kickoff. */
  closingOdds: number;
  closingTs: number;
  /** Kickoff, epoch ms. */
  startTime: number;
  /** Prices we had for this selection before close. */
  samples: number;
}

export interface ClvResult {
  selectionKey: string;
  betOdds: number;
  closingOdds: number;
  /** Positive means the bettor got a better price than the close. */
  clvProbability: number;
  clvPercent: number;
}

/* ------------------------------------------------------------------ *
 * Series input
 * ------------------------------------------------------------------ */

/** One selection's recorded prices, oldest first. */
export interface PriceSeries {
  selectionKey: string;
  eventKey: string;
  points: Array<Pick<OddsSnapshot, 'ts' | 'decimalOdds' | 'line' | 'status'>>;
}
