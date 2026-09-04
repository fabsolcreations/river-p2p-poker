/**
 * Decimal-odds math.
 *
 * All prices in this system are decimal. American/fractional are converted at
 * the edge and never stored. Every function here is pure and total: given
 * nonsense it returns null rather than a plausible-looking number, because a
 * silently wrong probability is the single most dangerous bug this project can
 * have.
 */

/** Prices outside this band are almost certainly a parse error, not a price. */
export const MIN_DECIMAL_ODDS = 1.0001;
export const MAX_DECIMAL_ODDS = 10_000;

export function isValidDecimalOdds(o: unknown): o is number {
  return typeof o === 'number' && Number.isFinite(o) && o >= MIN_DECIMAL_ODDS && o <= MAX_DECIMAL_ODDS;
}

/** Raw (vig-inclusive) implied probability of a decimal price. */
export function impliedProbability(decimalOdds: number): number | null {
  if (!isValidDecimalOdds(decimalOdds)) return null;
  return 1 / decimalOdds;
}

export function probabilityToDecimal(p: number): number | null {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return 1 / p;
}

export function americanToDecimal(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  const d = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return isValidDecimalOdds(d) ? d : null;
}

export function decimalToAmerican(decimalOdds: number): number | null {
  if (!isValidDecimalOdds(decimalOdds)) return null;
  return decimalOdds >= 2 ? Math.round((decimalOdds - 1) * 100) : Math.round(-100 / (decimalOdds - 1));
}

/**
 * Overround ("vig", "juice") of a complete market: the sum of raw implied
 * probabilities. 1.0 means a fair book; 1.06 means a 6% overround.
 *
 * Returns null unless every price in the market is valid - a partial market
 * has a meaningless overround, and pretending otherwise would poison every
 * fair-value estimate downstream.
 */
export function overround(decimalOdds: readonly number[]): number | null {
  if (decimalOdds.length < 2) return null;
  let sum = 0;
  for (const o of decimalOdds) {
    const p = impliedProbability(o);
    if (p === null) return null;
    sum += p;
  }
  return sum;
}

/**
 * Proportional (multiplicative) vig removal: divide each raw probability by the
 * overround. This is the standard baseline and what the project brief
 * specifies.
 *
 * Known limitation, stated rather than hidden: proportional removal assumes the
 * bookmaker applies margin evenly across outcomes. Real books load more margin
 * onto longshots (favourite-longshot bias), so on a 9x underdog this method
 * *overstates* the fair probability of the longshot - which is exactly the
 * direction that manufactures fake +EV. Treat proportional fair values on
 * high-priced selections as an upper bound, and prefer `fairProbabilitiesShin`
 * once we have enough closing prices to validate it.
 */
export function fairProbabilities(decimalOdds: readonly number[]): number[] | null {
  const ov = overround(decimalOdds);
  if (ov === null || ov <= 0) return null;
  const raw = decimalOdds.map((o) => 1 / o);
  return raw.map((p) => p / ov);
}

/** Convenience for the common two-way case. Returns [p1, p2]. */
export function fairTwoWay(odds1: number, odds2: number): [number, number] | null {
  const f = fairProbabilities([odds1, odds2]);
  return f && f.length === 2 && f[0] !== undefined && f[1] !== undefined ? [f[0], f[1]] : null;
}

/** Three-way (1X2). Returns [pHome, pDraw, pAway] in the order given. */
export function fairThreeWay(home: number, draw: number, away: number): [number, number, number] | null {
  const f = fairProbabilities([home, draw, away]);
  if (!f || f.length !== 3 || f[0] === undefined || f[1] === undefined || f[2] === undefined) return null;
  return [f[0], f[1], f[2]];
}

/**
 * Shin's method for vig removal. Solves for the insider-trading proportion z
 * such that the implied probabilities are consistent with informed money.
 * Unlike proportional removal it shifts margin toward longshots, which is the
 * empirically better fit for real books.
 *
 * Returns null if it does not converge - we would rather report "unknown" than
 * a number we cannot justify.
 */
export function fairProbabilitiesShin(decimalOdds: readonly number[], maxIter = 200, tol = 1e-12): number[] | null {
  const ov = overround(decimalOdds);
  if (ov === null || ov <= 0) return null;

  // NOTE: pi here is the RAW implied probability 1/o, deliberately NOT
  // normalised by the overround. Shin's expression divides pi^2 by the booksum
  // itself; feeding it pre-normalised probabilities makes sum(z=0) fall below 1
  // and the solve degenerates to z=0, which silently produces something close
  // to proportional de-vig while claiming to be Shin.
  const pi = decimalOdds.map((o) => 1 / o);

  const shinProb = (p: number, z: number): number => {
    const disc = z * z + 4 * (1 - z) * ((p * p) / ov);
    if (disc < 0) return NaN;
    return (Math.sqrt(disc) - z) / (2 * (1 - z));
  };

  // sum(z) is monotonically decreasing: at z=0 it equals sqrt(booksum) > 1 for
  // any real book, and it falls through 1 as the assumed insider fraction rises.
  const sumFor = (z: number): number => {
    let s = 0;
    for (const p of pi) {
      const v = shinProb(p, z);
      if (!Number.isFinite(v)) return NaN;
      s += v;
    }
    return s;
  };

  let lo = 0;
  let hi = 0.4999;
  const sLo = sumFor(lo);
  const sHi = sumFor(hi);
  if (!Number.isFinite(sLo) || !Number.isFinite(sHi)) return null;
  // No root in the bracket - refuse rather than return the endpoint dressed up
  // as a solution.
  if (sLo < 1 || sHi > 1) return null;

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const s = sumFor(mid);
    if (!Number.isFinite(s)) return null;
    if (Math.abs(s - 1) < tol) {
      lo = mid;
      hi = mid;
      break;
    }
    if (s > 1) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  const out = pi.map((p) => shinProb(p, z));
  const total = out.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  // Renormalise away the bisection residual.
  return out.map((p) => p / total);
}

/**
 * Expected value per unit staked, as a fraction.
 *   EV = p * decimalOdds - 1
 * +0.248 means "if our probability estimate is right, this returns 24.8% per
 * unit staked on average". The conditional is the whole point - see
 * `evWarnings`.
 */
export function expectedValue(probability: number, decimalOdds: number): number | null {
  if (!isValidDecimalOdds(decimalOdds)) return null;
  if (!Number.isFinite(probability) || probability <= 0 || probability > 1) return null;
  return probability * decimalOdds - 1;
}

/** Break-even probability: the probability at which this price is exactly fair. */
export function breakEvenProbability(decimalOdds: number): number | null {
  return impliedProbability(decimalOdds);
}

/**
 * Closing line value, in probability terms.
 *
 * CLV = (fair probability at bet time implied by our price)
 *     - (fair probability at close)
 *
 * Positive means we got a better price than the closing market. Expressed as a
 * fraction of probability, not of odds: probability differences are additive
 * and comparable across price ranges, odds ratios are not.
 */
export function clvProbability(betDecimalOdds: number, closingDecimalOdds: number): number | null {
  const pBet = impliedProbability(betDecimalOdds);
  const pClose = impliedProbability(closingDecimalOdds);
  if (pBet === null || pClose === null) return null;
  return pClose - pBet;
}

/**
 * CLV as a percentage return against the close - the "beat the close by X%"
 * figure. (betOdds / closeOdds) - 1.
 */
export function clvPercent(betDecimalOdds: number, closingDecimalOdds: number): number | null {
  if (!isValidDecimalOdds(betDecimalOdds) || !isValidDecimalOdds(closingDecimalOdds)) return null;
  return betDecimalOdds / closingDecimalOdds - 1;
}

/**
 * Wilson score interval for a win rate. Used everywhere we show a rate on a
 * small sample, so the UI can render "3/3 (0%-71% at 95%)" rather than "100%".
 */
export function wilsonInterval(successes: number, trials: number, z = 1.96): { lo: number; hi: number } | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials <= 0 || successes < 0 || successes > trials) {
    return null;
  }
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return { lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom) };
}

/**
 * Standard error of ROI for a set of settled bets, used to say whether an
 * observed ROI is distinguishable from zero. `returns` is per-unit profit for
 * each bet (e.g. +9.6 for a won 10.6 price, -1 for a loss).
 */
export function roiStdError(returns: readonly number[]): number | null {
  const n = returns.length;
  if (n < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return Math.sqrt(variance / n);
}

/**
 * Roughly how many bets are needed before an edge of `edge` (per-unit ROI) is
 * two standard errors from zero, given a typical price. This is the number the
 * UI quotes when it warns about small samples; it is an order-of-magnitude
 * guide, not a guarantee.
 */
export function samplesForSignificance(edge: number, typicalDecimalOdds: number): number | null {
  if (!Number.isFinite(edge) || edge <= 0 || !isValidDecimalOdds(typicalDecimalOdds)) return null;
  const p = 1 / typicalDecimalOdds;
  // Variance of per-unit return for a single bet at this price.
  const variance = p * Math.pow(typicalDecimalOdds - 1, 2) + (1 - p) * 1 - Math.pow(p * (typicalDecimalOdds - 1) - (1 - p), 2);
  if (!Number.isFinite(variance) || variance <= 0) return null;
  return Math.ceil((4 * variance) / (edge * edge));
}

/**
 * Kelly fraction. Exposed for sizing guidance on the review screen only - this
 * project never places a bet. Full Kelly on an estimated edge is reckless, so
 * callers should pass a fractional multiplier.
 */
export function kellyFraction(probability: number, decimalOdds: number, fraction = 0.25): number | null {
  const ev = expectedValue(probability, decimalOdds);
  if (ev === null || ev <= 0) return 0;
  const b = decimalOdds - 1;
  const f = (probability * b - (1 - probability)) / b;
  if (!Number.isFinite(f) || f <= 0) return 0;
  return f * fraction;
}

/**
 * Structural caveats that must be shown next to any EV number. These are not
 * decoration: every one of them is a way the estimate is systematically wrong
 * rather than merely noisy.
 */
export function evWarnings(input: {
  decimalOdds: number;
  sampleSize?: number | null;
  fairSource: 'proportional-devig' | 'shin-devig' | 'consensus' | 'single-book' | 'unknown';
  legs?: number;
  live?: boolean;
}): string[] {
  const out: string[] = [];
  if (input.fairSource === 'single-book' || input.fairSource === 'unknown') {
    out.push('Fair value came from one book, so "edge" here mostly measures disagreement with that book, not the true price.');
  }
  if (input.fairSource === 'proportional-devig' && input.decimalOdds >= 5) {
    out.push('Proportional de-vig overstates longshot fair value; edge on this price is likely inflated.');
  }
  if ((input.legs ?? 1) > 1) {
    out.push('Multi-leg price assumes independent legs. Correlated legs make the combined probability wrong in an unknown direction.');
  }
  if (input.live) {
    out.push('Live market: the price moves faster than we sample, so the recorded price may never have been available.');
  }
  if (input.sampleSize !== null && input.sampleSize !== undefined && input.sampleSize < 100) {
    out.push(`Only ${input.sampleSize} historical samples support this estimate - not enough to distinguish edge from noise.`);
  }
  return out;
}
