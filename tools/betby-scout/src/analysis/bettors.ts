/**
 * Bettor profiles and the sharpness score.
 *
 * ---------------------------------------------------------------------------
 * THE FINDING THAT SHAPES THIS FILE
 * ---------------------------------------------------------------------------
 *
 * Duel's bets feed carries exactly these fields per row:
 *
 *     id, odds, stake, pot_win, player, type, selections
 *
 * There is no status. No settlement, no result, no won/lost. A bet appears in
 * the feed and, as far as the feed is concerned, never resolves.
 *
 * That is not a gap that more days of capture will close. It means the metrics
 * the brief asks for - wins, losses, ROI, profit, win rate - are NOT COMPUTABLE
 * from this source, and a sharpness score built on them would be built on
 * nothing. Anything here that reported an ROI would be inventing it.
 *
 * What survives, and it is the good half: CLOSING LINE VALUE needs no
 * settlement. We know the price each leg was taken at, and we record that
 * selection's price over time, so we can ask whether the bettor got a better
 * number than the market closed at. The brief itself calls CLV the strongest
 * indicator that a strategy contains information, and it is the one strong
 * signal this data source can actually support.
 *
 * So the score is built on CLV, modified by a few weak behavioural factors, and
 * it REFUSES TO EXIST below a minimum sample. `computeSharpness` returns null
 * plus the specific blockers rather than a small number dressed up as a score -
 * because a bettor with three lucky bets is the exact thing this project was
 * commissioned to not be fooled by.
 */

import { clvPercent, clvProbability, roiStdError, samplesForSignificance, wilsonInterval } from '../shared/odds.ts';

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface BettorLegInput {
  betKey: string;
  /** Price the leg was taken at. */
  oddsAtBet: number | null;
  /** Last price at or before kickoff, when we recorded one. */
  closingOdds: number | null;
  sport: string | null;
  league: string | null;
}

export interface BettorBetInput {
  betKey: string;
  ts: number;
  stake: number | null;
  currency: string | null;
  totalOdds: number | null;
  type: string;
  legCount: number;
  legs: BettorLegInput[];
}

export interface BettorInput {
  bettorKey: string;
  label: string | null;
  bets: BettorBetInput[];
}

/* ------------------------------------------------------------------ *
 * Profile - facts, no judgement
 * ------------------------------------------------------------------ */

export interface CurrencyTotal {
  currency: string;
  bets: number;
  staked: number;
  avgStake: number;
  medianStake: number;
  largestStake: number;
  /** Coefficient of variation. High means erratic sizing. */
  stakeCv: number | null;
}

export interface BettorProfile {
  bettorKey: string;
  label: string | null;
  bets: number;
  singles: number;
  combos: number;
  avgLegs: number;
  /**
   * Per currency, never summed across them: without an FX rate, adding a rupee
   * stake to a dollar stake produces a number that means nothing.
   */
  byCurrency: CurrencyTotal[];
  avgOdds: number | null;
  medianOdds: number | null;
  /** Share of bets in each price band. A longshot habit is a recreational tell. */
  oddsBands: { short: number; mid: number; long: number; extreme: number };
  firstSeen: number;
  lastSeen: number;
  sports: Array<{ sport: string; bets: number }>;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildProfile(input: BettorInput): BettorProfile {
  const bets = input.bets;
  const odds = bets.map((b) => b.totalOdds).filter((o): o is number => o !== null && o > 1);

  const byCurrency: CurrencyTotal[] = [];
  const currencies = new Set(bets.map((b) => b.currency).filter((c): c is string => c !== null));
  for (const currency of currencies) {
    const stakes = bets
      .filter((b) => b.currency === currency)
      .map((b) => b.stake)
      .filter((s): s is number => s !== null && s >= 0);
    if (stakes.length === 0) continue;
    const avg = mean(stakes) ?? 0;
    const sd =
      stakes.length > 1
        ? Math.sqrt(stakes.reduce((a, s) => a + (s - avg) * (s - avg), 0) / (stakes.length - 1))
        : null;
    byCurrency.push({
      currency,
      bets: stakes.length,
      staked: stakes.reduce((a, b) => a + b, 0),
      avgStake: avg,
      medianStake: median(stakes) ?? 0,
      largestStake: Math.max(...stakes),
      stakeCv: sd !== null && avg > 0 ? sd / avg : null,
    });
  }
  byCurrency.sort((a, b) => b.bets - a.bets);

  const bands = { short: 0, mid: 0, long: 0, extreme: 0 };
  for (const o of odds) {
    if (o < 1.5) bands.short += 1;
    else if (o < 3) bands.mid += 1;
    else if (o < 10) bands.long += 1;
    else bands.extreme += 1;
  }

  const sportCounts = new Map<string, number>();
  for (const bet of bets) {
    for (const sport of new Set(bet.legs.map((l) => l.sport).filter((s): s is string => s !== null))) {
      sportCounts.set(sport, (sportCounts.get(sport) ?? 0) + 1);
    }
  }

  const times = bets.map((b) => b.ts).filter((t) => t > 0);

  return {
    bettorKey: input.bettorKey,
    label: input.label,
    bets: bets.length,
    singles: bets.filter((b) => b.type === 'single').length,
    combos: bets.filter((b) => b.type === 'combo').length,
    avgLegs: mean(bets.map((b) => b.legCount)) ?? 0,
    byCurrency,
    avgOdds: mean(odds),
    medianOdds: median(odds),
    oddsBands: bands,
    firstSeen: times.length ? Math.min(...times) : 0,
    lastSeen: times.length ? Math.max(...times) : 0,
    sports: [...sportCounts.entries()]
      .map(([sport, n]) => ({ sport, bets: n }))
      .sort((a, b) => b.bets - a.bets),
  };
}

/* ------------------------------------------------------------------ *
 * Closing line value - the one strong signal available
 * ------------------------------------------------------------------ */

export interface BettorClv {
  /** Legs where we had both a bet price and a closing price. */
  measured: number;
  /** Legs we could not measure, and why. */
  unmeasured: { noBetPrice: number; noClosingPrice: number };
  meanClvProbability: number | null;
  meanClvPercent: number | null;
  /** Standard error of the mean CLV in probability terms. */
  stdError: number | null;
  /** True when the mean is more than two standard errors from zero. */
  distinguishableFromZero: boolean;
  /** Legs needed before a CLV of this size would be distinguishable. */
  samplesNeeded: number | null;
}

export function computeClvForBettor(input: BettorInput): BettorClv {
  const probs: number[] = [];
  const percents: number[] = [];
  let noBetPrice = 0;
  let noClosingPrice = 0;

  for (const bet of input.bets) {
    for (const leg of bet.legs) {
      if (leg.oddsAtBet === null) {
        noBetPrice += 1;
        continue;
      }
      if (leg.closingOdds === null) {
        noClosingPrice += 1;
        continue;
      }
      const p = clvProbability(leg.oddsAtBet, leg.closingOdds);
      const pct = clvPercent(leg.oddsAtBet, leg.closingOdds);
      if (p === null || pct === null) {
        noClosingPrice += 1;
        continue;
      }
      probs.push(p);
      percents.push(pct);
    }
  }

  const meanProb = mean(probs);
  const stdError = roiStdError(probs);
  const distinguishable =
    meanProb !== null && stdError !== null && stdError > 0 && Math.abs(meanProb) > 2 * stdError;

  return {
    measured: probs.length,
    unmeasured: { noBetPrice, noClosingPrice },
    meanClvProbability: meanProb,
    meanClvPercent: mean(percents),
    stdError,
    distinguishableFromZero: distinguishable,
    // How many legs an edge of this size would need. Usually a humbling number.
    samplesNeeded:
      meanProb !== null && meanProb > 0 ? samplesForSignificance(meanProb, 2.5) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Sharpness
 * ------------------------------------------------------------------ */

/**
 * Below this many CLV-measured legs, no score is emitted at all.
 *
 * Not a soft warning - a refusal. The brief's central instruction is to avoid
 * massively overrating someone who happened to hit a few bets, and the only
 * reliable way to do that is to decline to produce the number that would do the
 * overrating.
 */
export const MIN_CLV_LEGS_FOR_SCORE = 30;

/**
 * Shrinkage constant. An observed mean is pulled toward zero by n/(n+K), so a
 * bettor with 30 legs keeps half their measured signal and one with 5 keeps a
 * seventh of it. This is what stops a tiny sample producing a big score.
 */
const SHRINKAGE_K = 30;

export interface SharpnessComponent {
  name: string;
  /** 0..1, already normalised. */
  value: number;
  weight: number;
  /** What this component is actually measuring, in plain language. */
  explanation: string;
}

export interface Sharpness {
  score: number;
  /** 0..1. How much the sample supports the score at all. */
  confidence: number;
  components: SharpnessComponent[];
  warnings: string[];
}

export interface SharpnessRefusal {
  score: null;
  /** Precisely what is missing, and how much of it. */
  blockers: string[];
}

export type SharpnessResult = Sharpness | SharpnessRefusal;

export function isScored(result: SharpnessResult): result is Sharpness {
  return result.score !== null;
}

/**
 * Combines CLV with a few weak behavioural factors into 0-100.
 *
 * Deliberately NOT included: win rate, ROI and profit. Duel's feed has no
 * settlement field, so those are not unavailable-for-now, they are unavailable.
 * Weighting a zero into the average would silently drag every bettor toward the
 * middle and make the score look better-founded than it is.
 */
export function computeSharpness(profile: BettorProfile, clv: BettorClv): SharpnessResult {
  const blockers: string[] = [];

  if (clv.measured < MIN_CLV_LEGS_FOR_SCORE) {
    blockers.push(
      `Only ${clv.measured} of this bettor's legs have both a bet price and a closing price; ` +
        `${MIN_CLV_LEGS_FOR_SCORE} are needed before a score means anything.`,
    );
    if (clv.unmeasured.noClosingPrice > 0) {
      blockers.push(
        `${clv.unmeasured.noClosingPrice} legs have no closing price yet - their events have not started, ` +
          'or Scout was not running to record the price before kickoff.',
      );
    }
  }

  if (blockers.length > 0) {
    blockers.push(
      'Win rate, ROI and profit are not listed as blockers because they are not obtainable at all: ' +
        "Duel's bets feed carries no settlement field, so no bet in it ever resolves.",
    );
    return { score: null, blockers };
  }

  const warnings: string[] = [];
  const components: SharpnessComponent[] = [];

  // --- CLV, the only strong component -------------------------------------
  const rawClv = clv.meanClvProbability ?? 0;
  const shrunkClv = rawClv * (clv.measured / (clv.measured + SHRINKAGE_K));
  // +5 percentage points of CLV is exceptional; map that range onto 0..1.
  const clvValue = clamp01(0.5 + shrunkClv / 0.1);
  components.push({
    name: 'Closing line value',
    value: clvValue,
    weight: 0.7,
    explanation:
      `Mean CLV of ${(rawClv * 100).toFixed(2)} probability points over ${clv.measured} legs, shrunk toward zero ` +
      `to ${(shrunkClv * 100).toFixed(2)} because ${clv.measured} legs is ${clv.measured < 200 ? 'still a small' : 'a reasonable'} sample.`,
  });

  if (!clv.distinguishableFromZero) {
    warnings.push(
      'This bettor\'s CLV is not distinguishable from zero at two standard errors. The score below is built ' +
        'on a signal that may be noise.',
    );
  }

  // --- Singles share ------------------------------------------------------
  const singlesShare = profile.bets > 0 ? profile.singles / profile.bets : 0;
  components.push({
    name: 'Singles share',
    value: singlesShare,
    weight: 0.1,
    explanation:
      `${(singlesShare * 100).toFixed(0)}% of bets are singles. A single is cleaner evidence than a combo, ` +
      'whose price compounds several independent judgements and hides which one was right.',
  });

  // --- Stake discipline ---------------------------------------------------
  const primary = profile.byCurrency[0];
  const cv = primary?.stakeCv ?? null;
  // A CV near 0 means flat staking, which is what a disciplined bettor does.
  const stakeValue = cv === null ? 0.5 : clamp01(1 - cv / 3);
  components.push({
    name: 'Stake discipline',
    value: stakeValue,
    weight: 0.1,
    explanation:
      cv === null
        ? 'Not enough stakes in one currency to measure consistency; scored neutral.'
        : `Stake variation is ${cv.toFixed(2)}x the average. Flat staking is a professional habit; wildly ` +
          'varying stakes usually are not.',
  });

  // --- Odds discipline ----------------------------------------------------
  const scored = profile.oddsBands.short + profile.oddsBands.mid + profile.oddsBands.long + profile.oddsBands.extreme;
  const extremeShare = scored > 0 ? profile.oddsBands.extreme / scored : 0;
  components.push({
    name: 'Odds discipline',
    value: clamp01(1 - extremeShare * 2),
    weight: 0.1,
    explanation:
      `${(extremeShare * 100).toFixed(0)}% of bets are at 10.00 or longer. A heavy longshot habit is a ` +
      'recreational signature, and longshot prices are also where de-vig error is worst.',
  });

  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const weighted = components.reduce((a, c) => a + c.value * c.weight, 0) / totalWeight;

  // Confidence is about the SAMPLE, not the score. It is reported separately so
  // a high score on a thin record cannot masquerade as a strong one.
  const confidence = clamp01(clv.measured / 200);

  if (profile.bets < 50) {
    warnings.push(`Only ${profile.bets} bets tracked for this bettor. Treat every rate here as provisional.`);
  }
  if (clv.samplesNeeded !== null && clv.measured < clv.samplesNeeded) {
    warnings.push(
      `An edge the size of this bettor's CLV would need roughly ${clv.samplesNeeded.toLocaleString()} legs to be ` +
        `statistically distinguishable from luck. We have ${clv.measured}.`,
    );
  }
  warnings.push(
    'No win rate, ROI or profit is included: Duel\'s feed carries no settlement field, so this score measures ' +
      'price-taking, not results.',
  );

  return { score: Math.round(weighted * 100), confidence, components, warnings };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Win-rate interval helper, kept for the day a settlement source exists.
 * Returns null rather than a point estimate, because a bare "100%" from three
 * bets is precisely the display this project exists to prevent.
 */
export function winRateInterval(wins: number, settled: number): { rate: number; lo: number; hi: number } | null {
  const interval = wilsonInterval(wins, settled);
  if (interval === null) return null;
  return { rate: wins / settled, lo: interval.lo, hi: interval.hi };
}
