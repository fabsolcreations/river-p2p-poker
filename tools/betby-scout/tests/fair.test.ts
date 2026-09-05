/**
 * Fair-value engine.
 *
 * The central test is that betting a de-vigged market back into the book it
 * came from has NEGATIVE expected value, equal to that book's margin. Under
 * proportional de-vig it collapses exactly:
 *
 *     EV_i = p_i * d_i - 1 = (1/d_i)/overround * d_i - 1 = 1/overround - 1
 *
 * the same number for every outcome. That arithmetic is what decides whether
 * this tool is honest: if a single-book de-vig ever yields a positive EV, either
 * the de-vig is broken or something is manufacturing an edge out of one book's
 * own prices, and both are fatal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleMarkets,
  devigMarket,
  evAgainstIndependent,
  evAgainstSameBook,
  summarizeMargins,
  MAX_DEVIG_OUTCOMES,
  type RawSelectionRow,
} from '../src/analysis/fair.ts';
import { isEdgeClaimable, type CompleteMarket } from '../src/analysis/types.ts';

const TS = 1_788_600_000_000;

function market(prices: number[], overrides: Partial<CompleteMarket> = {}): CompleteMarket {
  return {
    marketKey: 'm_test',
    eventKey: 'e_test',
    sportsbookId: 'duel',
    name: 'Test market',
    type: 'Result',
    line: null,
    ts: TS,
    outcomes: prices.map((p, i) => ({ selectionKey: `o_${i}`, name: `outcome ${i}`, decimalOdds: p, line: null })),
    ...overrides,
  };
}

/* --- the honesty property ----------------------------------------------- */

test('betting a de-vigged market back into the same book is always -EV', () => {
  for (const prices of [[1.9, 1.9], [2.5, 3.4, 3.1], [1.2, 4.5], [1.05, 11.0]]) {
    for (const method of ['proportional', 'shin'] as const) {
      const result = devigMarket(market(prices), { method });
      assert.equal(result.ok, true, `expected ${prices.join('/')} to de-vig`);
      if (!result.ok) continue;

      for (const outcome of result.fair.outcomes) {
        const ev = evAgainstSameBook(result.fair, outcome.selectionKey);
        assert.ok(ev !== null);
        // A tool reporting "+7.8% EV" from a single book's own prices is
        // reporting this number, wrongly. It is never positive.
        assert.ok(ev < 0, `${method} EV must be negative, got ${ev} for ${prices.join('/')}`);
      }
    }
  }
});

test('proportional de-vig gives every outcome the same EV: exactly minus the margin', () => {
  // EV_i = (1/d_i)/overround * d_i - 1 = 1/overround - 1, independent of i.
  // Any drift between outcomes means the de-vig is not doing what it claims.
  for (const prices of [[1.9, 1.9], [1.2, 4.5], [2.5, 3.4, 3.1]]) {
    const result = devigMarket(market(prices), { method: 'proportional' });
    assert.equal(result.ok, true);
    if (!result.ok) continue;

    const expected = 1 / result.fair.overround - 1;
    for (const outcome of result.fair.outcomes) {
      const ev = evAgainstSameBook(result.fair, outcome.selectionKey) ?? 0;
      assert.ok(Math.abs(ev - expected) < 1e-9, `EV ${ev} should equal 1/overround - 1 = ${expected}`);
    }
  }

  // The worked case: 1.90/1.90 is a 5.26% overround, so every outcome returns
  // -5% per unit staked.
  const even = devigMarket(market([1.9, 1.9]), { method: 'proportional' });
  assert.equal(even.ok, true);
  if (even.ok) {
    const ev = evAgainstSameBook(even.fair, 'o_0') ?? 0;
    assert.ok(Math.abs(ev - -0.05) < 1e-9, `expected -5%, got ${ev}`);
  }
});

test('fair probabilities sum to one and the margin is reported', () => {
  const result = devigMarket(market([1.9, 1.9]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const sum = result.fair.outcomes.reduce((a, o) => a + o.fairProbability, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `fair probabilities must sum to 1, got ${sum}`);

  // 2/1.9 = 1.0526 -> a 5.26% margin.
  assert.ok(Math.abs(result.fair.marginPct - 0.0526) < 0.001, `unexpected margin ${result.fair.marginPct}`);
  assert.ok(result.fair.overround > 1);
});

test('a single-book fair value always carries the caveat that it cannot show an edge', () => {
  const result = devigMarket(market([1.9, 1.9]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.fair.source, 'single-book-devig');
  assert.equal(isEdgeClaimable(result.fair.source), false);
  assert.ok(
    result.fair.warnings.some((w) => /cannot produce a positive number/.test(w)),
    `the caveat must travel with the number; got: ${result.fair.warnings.join(' | ')}`,
  );
});

test('an edge cannot be claimed against a same-book fair value', () => {
  const refused = evAgainstIndependent({ fairProbability: 0.13, decimalOdds: 9.6, source: 'single-book-devig' });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /same book/);

  const closing = evAgainstIndependent({ fairProbability: 0.13, decimalOdds: 9.6, source: 'closing-line' });
  assert.equal(closing.ok, false, 'a closing line supports CLV, not a live edge claim');

  // Only a genuine multi-book consensus unlocks it, and then the brief's own
  // worked example holds: 0.13 * 9.60 - 1 = +24.8%.
  const allowed = evAgainstIndependent({ fairProbability: 0.13, decimalOdds: 9.6, source: 'multi-book-consensus' });
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.ok(Math.abs(allowed.ev - 0.248) < 1e-9);
});

/* --- refusals ------------------------------------------------------------ */

test('an implausible overround is refused rather than de-vigged', () => {
  // Two outcomes at 1.2 imply 167% - not a market, a mis-assembly.
  const bad = devigMarket(market([1.2, 1.2]));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /overround/);

  // And a "market" that sums to well under 1 is equally broken.
  const under = devigMarket(market([5.0, 5.0]));
  assert.equal(under.ok, false);
});

test('a large field is refused because both de-vig methods degrade on it', () => {
  const wide = market(Array.from({ length: MAX_DEVIG_OUTCOMES + 1 }, () => 20));
  const result = devigMarket(wide);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /de-vig limit/);
});

test('a one-sided or unpriced market is refused with a reason', () => {
  const single = devigMarket(market([1.9]));
  assert.equal(single.ok, false);

  const invalid = devigMarket(market([1.9, 0.5]));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.reason, /not a valid decimal price/);
});

/* --- method differences --------------------------------------------------- */

test('Shin assigns the longshot less fair probability than proportional', () => {
  const shin = devigMarket(market([1.2, 4.5]), { method: 'shin' });
  const prop = devigMarket(market([1.2, 4.5]), { method: 'proportional' });
  assert.equal(shin.ok, true);
  assert.equal(prop.ok, true);
  if (!shin.ok || !prop.ok) return;

  const shinLongshot = shin.fair.outcomes[1]?.fairProbability ?? 0;
  const propLongshot = prop.fair.outcomes[1]?.fairProbability ?? 0;
  // Books load margin onto longshots. Proportional ignores that and inflates
  // the longshot's fair value - the direction that invents edges.
  assert.ok(shinLongshot < propLongshot, `Shin ${shinLongshot} should be below proportional ${propLongshot}`);
});

test('proportional de-vig on a longshot market warns about its own bias', () => {
  const result = devigMarket(market([1.05, 11.0]), { method: 'proportional' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.fair.warnings.some((w) => /longshot/.test(w)));
});

test('a wide market warns that its fair values are method-sensitive', () => {
  const result = devigMarket(market([1.5, 3.0, 5.0]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.fair.warnings.some((w) => /3-way|de-vig error/.test(w)));
});

/* --- assembling markets from stored rows ---------------------------------- */

function row(overrides: Partial<RawSelectionRow>): RawSelectionRow {
  return {
    selectionKey: 'o_1',
    marketKey: 'm_1',
    eventKey: 'e_1',
    sportsbookId: 'duel',
    name: 'Home',
    marketName: '1x2',
    marketType: 'Result',
    line: null,
    decimalOdds: 2.0,
    status: null,
    ts: TS,
    ...overrides,
  };
}

test('only fully priced markets are assembled, and the rest say why', () => {
  const { markets, incomplete } = assembleMarkets([
    row({ selectionKey: 'a', marketKey: 'm_ok' }),
    row({ selectionKey: 'b', marketKey: 'm_ok', decimalOdds: 2.1 }),
    row({ selectionKey: 'c', marketKey: 'm_partial' }),
    row({ selectionKey: 'd', marketKey: 'm_partial', decimalOdds: null }),
    row({ selectionKey: 'e', marketKey: 'm_lonely' }),
  ]);

  assert.equal(markets.length, 1);
  assert.equal(markets[0]?.marketKey, 'm_ok');
  assert.equal(markets[0]?.outcomes.length, 2);

  // A partial market must never be de-vigged: its overround is meaningless and
  // every probability derived from it is wrong in an unpredictable direction.
  const reasons = new Map(incomplete.map((i) => [i.marketKey, i.reason]));
  assert.match(reasons.get('m_partial') ?? '', /no usable price/);
  assert.match(reasons.get('m_lonely') ?? '', /only 1 outcome/);
});

test('a market takes the timestamp of its newest price', () => {
  const { markets } = assembleMarkets([
    row({ selectionKey: 'a', ts: TS }),
    row({ selectionKey: 'b', decimalOdds: 2.1, ts: TS + 5000 }),
  ]);
  assert.equal(markets[0]?.ts, TS + 5000);
});

/* --- margin summary ------------------------------------------------------- */

test('margins are summarised by median, with the sample count kept', () => {
  const summary = summarizeMargins([
    { group: 'Soccer', marginPct: 0.04 },
    { group: 'Soccer', marginPct: 0.06 },
    { group: 'Soccer', marginPct: 0.05 },
    // One mis-parsed market with an absurd margin. A mean would be dragged to
    // 0.14; a median must not be.
    { group: 'Soccer', marginPct: 0.5 },
    { group: 'Tennis', marginPct: 0.08 },
  ]);

  const soccer = summary.find((s) => s.group === 'Soccer');
  assert.ok(soccer);
  assert.equal(soccer.markets, 4);
  assert.ok(soccer.medianMarginPct < 0.07, `median ${soccer.medianMarginPct} should resist the outlier`);
  assert.equal(soccer.maxMarginPct, 0.5, 'but the outlier is still visible in the range');

  // Ordered by sample count, so the least trustworthy row is not first.
  assert.equal(summary[0]?.group, 'Soccer');
  assert.equal(summary.find((s) => s.group === 'Tennis')?.markets, 1);
});

test('no user-facing string in this module promises a certainty', () => {
  const result = devigMarket(market([1.05, 11.0]), { method: 'proportional' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = result.fair.warnings.join(' ').toLowerCase();
  for (const banned of ['lock', 'guaranteed', 'free money', 'sure thing']) {
    assert.ok(!text.includes(banned), `found forbidden certainty language: ${banned}`);
  }
});
