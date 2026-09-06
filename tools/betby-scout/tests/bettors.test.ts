/**
 * Bettor profiles and the sharpness score.
 *
 * The tests that matter here are the refusals. The brief's central instruction
 * is not to be fooled by someone who hit a few bets, and the only reliable
 * defence is declining to produce a number at all on a thin record - so most of
 * this file checks that the score stays null when it should, and that a real
 * signal is shrunk toward zero rather than taken at face value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProfile,
  computeClvForBettor,
  computeSharpness,
  isScored,
  winRateInterval,
  MIN_CLV_LEGS_FOR_SCORE,
  type BettorBetInput,
  type BettorInput,
} from '../src/analysis/bettors.ts';

const T0 = 1_788_600_000_000;

function bet(overrides: Partial<BettorBetInput> = {}): BettorBetInput {
  return {
    betKey: `b_${Math.round((overrides.ts ?? T0) % 100000)}_${overrides.legCount ?? 1}`,
    ts: T0,
    stake: 20,
    currency: 'USD',
    totalOdds: 2.0,
    type: 'single',
    legCount: 1,
    legs: [{ betKey: 'b', oddsAtBet: 2.0, closingOdds: 2.0, sport: 'Soccer', league: 'LaLiga' }],
    ...overrides,
  };
}

/**
 * A bettor whose legs all beat the close by a fixed amount.
 * `betOdds` above `closeOdds` means they took a better price than the market
 * settled on, which is positive CLV.
 */
function bettorWithClv(legs: number, betOdds: number, closeOdds: number, extra: Partial<BettorInput> = {}): BettorInput {
  return {
    bettorKey: 'b_test',
    label: '****tu',
    bets: Array.from({ length: legs }, (_, i) =>
      bet({
        betKey: `b_${i}`,
        ts: T0 + i * 60_000,
        totalOdds: betOdds,
        legs: [{ betKey: `b_${i}`, oddsAtBet: betOdds, closingOdds: closeOdds, sport: 'Soccer', league: 'LaLiga' }],
      }),
    ),
    ...extra,
  };
}

/* --- profile: facts only -------------------------------------------------- */

test('a profile reports activity without judging it', () => {
  const input: BettorInput = {
    bettorKey: 'b_1',
    label: '****aa',
    bets: [
      bet({ betKey: 'b1', stake: 10, totalOdds: 1.4 }),
      bet({ betKey: 'b2', stake: 30, totalOdds: 2.5 }),
      bet({
        betKey: 'b3',
        stake: 50,
        totalOdds: 12.0,
        type: 'combo',
        legCount: 2,
        legs: [
          { betKey: 'b3', oddsAtBet: 3.0, closingOdds: null, sport: 'Tennis', league: 'ATP' },
          { betKey: 'b3', oddsAtBet: 4.0, closingOdds: null, sport: 'Soccer', league: 'LaLiga' },
        ],
      }),
    ],
  };

  const p = buildProfile(input);
  assert.equal(p.bets, 3);
  assert.equal(p.singles, 2);
  assert.equal(p.combos, 1);
  assert.equal(p.oddsBands.short, 1, '1.40 is a short price');
  assert.equal(p.oddsBands.mid, 1, '2.50 is mid');
  assert.equal(p.oddsBands.extreme, 1, '12.00 is extreme');
  assert.equal(p.byCurrency[0]?.largestStake, 50);
  assert.equal(p.byCurrency[0]?.medianStake, 30);
  assert.deepEqual(
    p.sports.map((s) => s.sport).sort(),
    ['Soccer', 'Tennis'],
  );
});

test('stakes are never summed across currencies', () => {
  const p = buildProfile({
    bettorKey: 'b_2',
    label: null,
    bets: [bet({ betKey: 'a', stake: 100, currency: 'USD' }), bet({ betKey: 'b', stake: 5000, currency: 'INR' })],
  });

  assert.equal(p.byCurrency.length, 2);
  // Adding 5000 INR to 100 USD would produce 5100 of nothing.
  for (const c of p.byCurrency) assert.equal(c.bets, 1);
  assert.ok(p.byCurrency.every((c) => c.staked === 100 || c.staked === 5000));
});

/* --- CLV ------------------------------------------------------------------ */

test('CLV is positive when the bettor beat the close', () => {
  // Took 2.20, market closed 2.00 - a better price than the close.
  const clv = computeClvForBettor(bettorWithClv(40, 2.2, 2.0));
  assert.equal(clv.measured, 40);
  assert.ok((clv.meanClvProbability ?? 0) > 0, 'beating the close is positive CLV');
  assert.ok((clv.meanClvPercent ?? 0) > 0);
});

test('CLV is negative when the bettor took the worse side', () => {
  const clv = computeClvForBettor(bettorWithClv(40, 2.0, 2.2));
  assert.ok((clv.meanClvProbability ?? 0) < 0);
});

test('legs with no closing price are counted, not quietly dropped', () => {
  const input: BettorInput = {
    bettorKey: 'b_3',
    label: null,
    bets: [
      bet({ betKey: 'a', legs: [{ betKey: 'a', oddsAtBet: 2.0, closingOdds: 1.9, sport: null, league: null }] }),
      bet({ betKey: 'b', legs: [{ betKey: 'b', oddsAtBet: 2.0, closingOdds: null, sport: null, league: null }] }),
      bet({ betKey: 'c', legs: [{ betKey: 'c', oddsAtBet: null, closingOdds: 1.9, sport: null, league: null }] }),
    ],
  };
  const clv = computeClvForBettor(input);
  assert.equal(clv.measured, 1);
  assert.equal(clv.unmeasured.noClosingPrice, 1);
  assert.equal(clv.unmeasured.noBetPrice, 1);
});

/* --- the refusals: the point of this file --------------------------------- */

test('no score is emitted on a thin record, and the blockers say why', () => {
  const input = bettorWithClv(3, 3.0, 2.0); // three legs, spectacular CLV
  const profile = buildProfile(input);
  const clv = computeClvForBettor(input);
  const result = computeSharpness(profile, clv);

  assert.equal(result.score, null, 'three lucky legs must not produce a score');
  assert.equal(isScored(result), false);
  if (!isScored(result)) {
    assert.ok(result.blockers.some((b) => new RegExp(String(MIN_CLV_LEGS_FOR_SCORE)).test(b)));
    // And the reason ROI is absent must be stated as permanent, not pending.
    assert.ok(
      result.blockers.some((b) => /no settlement field/.test(b)),
      `the blockers must explain that ROI is unobtainable, got: ${result.blockers.join(' | ')}`,
    );
  }
});

test('a score appears exactly at the sample threshold, not before', () => {
  const under = bettorWithClv(MIN_CLV_LEGS_FOR_SCORE - 1, 2.2, 2.0);
  assert.equal(computeSharpness(buildProfile(under), computeClvForBettor(under)).score, null);

  const at = bettorWithClv(MIN_CLV_LEGS_FOR_SCORE, 2.2, 2.0);
  const result = computeSharpness(buildProfile(at), computeClvForBettor(at));
  assert.notEqual(result.score, null, 'at the threshold a score is produced');
});

test('a large sample scores higher than a small one on identical CLV', () => {
  // Same per-leg edge, different evidence. Shrinkage must reward the evidence.
  const small = bettorWithClv(MIN_CLV_LEGS_FOR_SCORE, 2.2, 2.0);
  const large = bettorWithClv(400, 2.2, 2.0);

  const a = computeSharpness(buildProfile(small), computeClvForBettor(small));
  const b = computeSharpness(buildProfile(large), computeClvForBettor(large));
  assert.ok(isScored(a) && isScored(b));
  if (!isScored(a) || !isScored(b)) return;

  assert.ok(b.score > a.score, `400 legs (${b.score}) should outscore 30 (${a.score}) on the same edge`);
  assert.ok(b.confidence > a.confidence);
});

test('a bettor with no edge lands near the middle, not at zero', () => {
  const flat = bettorWithClv(200, 2.0, 2.0);
  const result = computeSharpness(buildProfile(flat), computeClvForBettor(flat));
  assert.ok(isScored(result));
  if (!isScored(result)) return;
  // Zero CLV is the neutral case, not a failing grade.
  assert.ok(result.score > 35 && result.score < 75, `expected a middling score, got ${result.score}`);
});

test('a negative-CLV bettor scores below a positive-CLV one', () => {
  const good = bettorWithClv(200, 2.2, 2.0);
  const bad = bettorWithClv(200, 2.0, 2.2);
  const a = computeSharpness(buildProfile(good), computeClvForBettor(good));
  const b = computeSharpness(buildProfile(bad), computeClvForBettor(bad));
  assert.ok(isScored(a) && isScored(b));
  if (isScored(a) && isScored(b)) assert.ok(a.score > b.score);
});

/* --- the warnings that must always travel --------------------------------- */

test('every score states that it measures price-taking, not results', () => {
  const input = bettorWithClv(200, 2.2, 2.0);
  const result = computeSharpness(buildProfile(input), computeClvForBettor(input));
  assert.ok(isScored(result));
  if (!isScored(result)) return;

  assert.ok(
    result.warnings.some((w) => /no settlement field/.test(w) && /price-taking, not results/.test(w)),
    `got: ${result.warnings.join(' | ')}`,
  );
  // Components must explain themselves, not just carry a number.
  assert.ok(result.components.every((c) => c.explanation.length > 20));
  assert.ok(result.components.some((c) => c.name === 'Closing line value' && c.weight >= 0.5), 'CLV must dominate');
});

test('an indistinguishable CLV is flagged even when a score is produced', () => {
  // Alternating legs: real spread, mean near zero, so noise swamps signal.
  const input: BettorInput = {
    bettorKey: 'b_noise',
    label: null,
    bets: Array.from({ length: 120 }, (_, i) =>
      bet({
        betKey: `n${i}`,
        ts: T0 + i * 1000,
        legs: [
          {
            betKey: `n${i}`,
            oddsAtBet: i % 2 === 0 ? 2.4 : 1.7,
            closingOdds: 2.0,
            sport: 'Soccer',
            league: 'LaLiga',
          },
        ],
      }),
    ),
  };
  const result = computeSharpness(buildProfile(input), computeClvForBettor(input));
  assert.ok(isScored(result));
  if (!isScored(result)) return;
  assert.ok(result.warnings.some((w) => /not distinguishable from zero/.test(w)));
});

test('confidence is reported separately from the score', () => {
  const thin = bettorWithClv(MIN_CLV_LEGS_FOR_SCORE, 3.0, 2.0); // huge edge, thin record
  const result = computeSharpness(buildProfile(thin), computeClvForBettor(thin));
  assert.ok(isScored(result));
  if (!isScored(result)) return;
  // A high score on a thin sample must not also claim high confidence.
  assert.ok(result.confidence < 0.25, `confidence ${result.confidence} should be low at 30 legs`);
});

/* --- win rate, kept honest for the day settlement exists ------------------ */

test('a 3-for-3 record never renders as a 100% bettor', () => {
  const w = winRateInterval(3, 3);
  assert.ok(w);
  assert.equal(w.rate, 1);
  assert.ok(w.lo < 0.5, `the interval must not exclude a coin flip, got lo=${w.lo}`);
  assert.equal(winRateInterval(0, 0), null);
});

test('no user-facing string promises a certainty', () => {
  const input = bettorWithClv(200, 2.2, 2.0);
  const result = computeSharpness(buildProfile(input), computeClvForBettor(input));
  const text = isScored(result)
    ? [...result.warnings, ...result.components.map((c) => c.explanation)].join(' ').toLowerCase()
    : result.blockers.join(' ').toLowerCase();
  for (const banned of ['lock', 'guaranteed', 'free money', 'sure thing']) {
    assert.ok(!text.includes(banned), `found forbidden certainty language: ${banned}`);
  }
});
