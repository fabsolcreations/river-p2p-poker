/**
 * Movement and closing-line value.
 *
 * Every test here exists because there is a specific way to get the same number
 * wrong and never notice:
 *
 *   - ranking moves by odds ratio, which makes every longshot tick look like a
 *     favourite steaming;
 *   - dividing a price change by a stretch of time we were not watching, which
 *     turns two unrelated observations into a confident trend;
 *   - reporting the outward leg of an out-and-back as steam;
 *   - taking an in-play price as the close, which biases every CLV number
 *     downstream with no visible symptom;
 *   - reading a plus sign on eleven bets as a signal.
 *
 * The last test is the honesty argument itself: a market de-vigged from one
 * book, priced back into that same book, carries no information at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectMovements, summarizeSeries } from '../src/analysis/movement.ts';
import {
  clvSummary,
  closingLineAgeMs,
  computeClv,
  findClosingLine,
  CLV_FAIR_SOURCE,
  MIN_CLV_SAMPLES,
} from '../src/analysis/clv.ts';
import {
  assembleMarkets,
  devigMarket,
  evAgainstIndependent,
  evAgainstSameBook,
  type RawSelectionRow,
} from '../src/analysis/fair.ts';
import {
  isEdgeClaimable,
  DEFAULT_MOVEMENT_OPTIONS,
  type ClosingLine,
  type ClvResult,
  type PriceSeries,
} from '../src/analysis/types.ts';
import { parseCapture } from '../src/adapters/registry.ts';
import {
  emptyReference,
  mergeReference,
  parseEventTree,
  parseMarketDescriptions,
} from '../src/adapters/betby/dictionary.ts';
import type { RawCapture } from '../src/shared/types.ts';

const T0 = 1_788_600_000_000;
const MIN = 60_000;

/** Minutes-from-T0 plus a price, which is how every series below is written. */
type Tick = [minutes: number, decimalOdds: number];

function series(ticks: Tick[], keys = { selectionKey: 's_1', eventKey: 'e_1' }): PriceSeries {
  return {
    selectionKey: keys.selectionKey,
    eventKey: keys.eventKey,
    points: ticks.map(([m, decimalOdds]) => ({
      ts: T0 + m * MIN,
      decimalOdds,
      line: null,
      status: null,
    })),
  };
}

/* --- movement is measured in probability, never in an odds ratio --------- */

test('a short-price move outranks a longshot move of the identical odds ratio', () => {
  // 1.10 -> 1.05 and 11.0 -> 10.5 are the SAME 4.5% shortening in ratio terms.
  const favourite = summarizeSeries(series([[0, 1.1], [2, 1.05]]));
  const longshot = summarizeSeries(series([[0, 11.0], [2, 10.5]]));
  assert.ok(favourite && longshot);

  // The ratio cannot separate them at all - this is the metric we refused.
  assert.ok(Math.abs(1.05 / 1.1 - 10.5 / 11.0) < 1e-12, 'the two odds ratios are equal');

  // In probability the favourite move is ten times the size, which is the truth
  // about how much the market changed its mind.
  assert.ok(favourite.probDelta > 0, 'a shortening price raises implied probability');
  assert.ok(
    Math.abs(favourite.probDelta / longshot.probDelta - 10) < 1e-9,
    `expected a 10x ordering, got ${favourite.probDelta} vs ${longshot.probDelta}`,
  );

  // And the consequence: only one of them is worth reporting. The longshot tick
  // is 0.43 of a percentage point and never reaches the floor.
  assert.deepEqual(detectMovements(series([[0, 11.0], [2, 10.5]])), []);
  const moves = detectMovements(series([[0, 1.1], [2, 1.05]]));
  assert.equal(moves.length, 1);
  assert.equal(moves[0]?.kind, 'steam');
});

test('summarizeSeries reports the extremes and survives junk, unsorted input and a lone point', () => {
  const s = summarizeSeries(series([[4, 1.95], [0, 2.0], [2, 1.7]]));
  assert.ok(s);
  // Input arrived newest-first / out of order; the summary is still chronological.
  assert.equal(s.first.decimalOdds, 2.0);
  assert.equal(s.last.decimalOdds, 1.95);
  assert.equal(s.min.decimalOdds, 1.7, 'min is the shortest price seen');
  assert.equal(s.max.decimalOdds, 2.0, 'max is the longest price seen');
  assert.equal(s.samples, 3);

  const one = summarizeSeries(series([[0, 2.0]]));
  assert.equal(one?.samples, 1);
  assert.equal(one?.probDelta, 0, 'one price has not moved, and that is a real answer');

  assert.equal(summarizeSeries(series([])), null);
  // A price of 0 and a NaN timestamp are parse failures, not prices. Dropping
  // them must not throw and must not leave a summary implying we know something.
  assert.equal(summarizeSeries(series([[0, 0], [1, Number.NaN]])), null);
  assert.deepEqual(detectMovements(series([[0, 0], [1, Number.NaN]])), []);
});

/* --- irregular sampling: a gap is silence, not a slow move --------------- */

test('a gap longer than maxGapMs breaks the window instead of becoming a slow move', () => {
  // 2.00 -> 1.80 is 5.6 points of probability. Recorded 45 minutes apart, the
  // only honest reading is "we were not watching in between".
  assert.deepEqual(detectMovements(series([[0, 2.0], [45, 1.8]])), []);

  // The same change inside the gap allowance is reported, but its rate is
  // 0.22pp/min - below the steam threshold, so it is a plain move.
  const slow = detectMovements(series([[0, 2.0], [25, 1.8]]));
  assert.equal(slow.length, 1);
  assert.equal(slow[0]?.kind, 'move');
  assert.equal(slow[0]?.samples, 2, 'a two-point series is a valid window');
  assert.equal(slow[0]?.durationMs, 25 * MIN, 'the rate uses real elapsed time');

  // The identical change over two minutes is 2.8pp/min, and that is steam.
  const fast = detectMovements(series([[0, 2.0], [2, 1.8]]));
  assert.equal(fast[0]?.kind, 'steam');
});

test('a gap in the middle of a series splits it rather than spanning it', () => {
  const moves = detectMovements(series([[0, 2.0], [1, 1.9], [46, 1.85], [47, 1.75]]));
  assert.equal(moves.length, 2, 'one window each side of the silence');
  assert.equal(moves[0]?.tsTo, T0 + 1 * MIN);
  assert.equal(moves[1]?.tsFrom, T0 + 46 * MIN);
  for (const m of moves) {
    assert.ok(
      m.durationMs <= DEFAULT_MOVEMENT_OPTIONS.maxGapMs,
      'no window may cover a stretch we did not observe',
    );
  }
});

test('a drifting price is drift, and the direction is carried by the sign', () => {
  const moves = detectMovements(series([[0, 1.8], [1, 1.9], [2, 2.0]]));
  assert.equal(moves.length, 1);
  assert.equal(moves[0]?.kind, 'drift');
  assert.ok((moves[0]?.probDelta ?? 0) < 0, 'a lengthening price loses implied probability');
});

/* --- round trips ---------------------------------------------------------- */

test('an out-and-back is one round-trip, not a steam leg', () => {
  // Taken on its own, the outward leg is textbook steam - which is exactly the
  // trap: a detector that reported it would have the tool acting on noise.
  const outwardOnly = detectMovements(series([[0, 2.0], [2, 1.8]]));
  assert.equal(outwardOnly[0]?.kind, 'steam');

  const moves = detectMovements(series([[0, 2.0], [2, 1.8], [4, 2.0]]));
  assert.equal(moves.length, 1, 'the whole excursion is a single entry');
  assert.equal(moves[0]?.kind, 'round-trip');
  assert.equal(moves[0]?.samples, 3);
  assert.equal(moves[0]?.oddsFrom, 2.0);
  assert.equal(moves[0]?.oddsTo, 2.0);
  assert.ok(Math.abs(moves[0]?.probDelta ?? 1) < 1e-12, 'the reported delta is the net, which is nil');
});

test('a partial retrace is not a round trip', () => {
  // 2.00 -> 1.80 -> 1.95 gives back most of the move but not all of it: the net
  // is 1.3 points, still above the reporting floor, so the market did go
  // somewhere and both legs are reported.
  const moves = detectMovements(series([[0, 2.0], [2, 1.8], [4, 1.95]]));
  assert.deepEqual(moves.map((m) => m.kind), ['steam', 'drift']);
});

test('a counter-tick inside a trend does not fragment it', () => {
  // 1.90 -> 1.91 is a 0.27-point tick against a move of 5.6. Ending the window
  // there would split one steam into two halves, each too small to report, and
  // the move would vanish from the output without any sign that it had.
  const moves = detectMovements(series([[0, 2.0], [1, 1.9], [2, 1.91], [3, 1.8]]));
  assert.equal(moves.length, 1);
  assert.equal(moves[0]?.kind, 'steam');
  assert.equal(moves[0]?.samples, 4, 'the tick stays inside the window it belongs to');
  assert.ok(Math.abs((moves[0]?.probDelta ?? 0) - (1 / 1.8 - 1 / 2.0)) < 1e-12);
});

test('a series of fewer than two usable points yields nothing', () => {
  assert.deepEqual(detectMovements(series([[0, 2.0]])), []);
  assert.deepEqual(detectMovements(series([])), []);
  assert.equal(detectMovements(series([[0, 2.0], [1, 1.9]])).length, 1);
});

/* --- closing line --------------------------------------------------------- */

const KICKOFF = T0 + 60 * MIN;

test('the closing line is the last price BEFORE kickoff, and in-play prices are ignored', () => {
  const s = series([[0, 2.0], [30, 1.9], [59, 1.85], [61, 1.4], [90, 1.2]]);
  const closing = findClosingLine(s, KICKOFF);
  assert.ok(closing);

  // 1.40 and 1.20 are in-play prices. Folding either into CLV would bias every
  // number built on it, and nothing downstream would show a symptom.
  assert.equal(closing.closingOdds, 1.85);
  assert.equal(closing.closingTs, T0 + 59 * MIN);
  assert.ok(closing.closingTs <= closing.startTime);
  assert.equal(closing.samples, 3, 'only pre-kickoff prices are counted');
  assert.equal(closingLineAgeMs(closing), 1 * MIN, 'how stale the close is stays visible');
});

test('no kickoff and no pre-kickoff price both mean no closing line', () => {
  const s = series([[0, 2.0], [30, 1.9]]);
  assert.equal(findClosingLine(s, null), null, 'without kickoff we cannot tell pre-game from in-play');

  const inPlayOnly = series([[61, 1.4], [90, 1.2]]);
  assert.equal(findClosingLine(inPlayOnly, KICKOFF), null, 'an in-play price is never promoted to a close');

  assert.equal(findClosingLine(series([]), KICKOFF), null);
});

/* --- CLV ------------------------------------------------------------------ */

function closingAt(odds: number): ClosingLine {
  const closing = findClosingLine(series([[0, odds]]), T0 + 10 * MIN);
  assert.ok(closing, 'fixture closing line');
  return closing;
}

test('CLV is positive when the bettor beat the close', () => {
  // 11.0 taken, 9.0 at the close: the market ended up thinking the outcome more
  // likely than the price paid for it. That is positive CLV.
  const good = computeClv(11.0, closingAt(9.0));
  assert.ok(good);
  assert.ok(good.clvProbability > 0, `expected positive, got ${good.clvProbability}`);
  assert.ok(Math.abs(good.clvProbability - (1 / 9 - 1 / 11)) < 1e-12);
  assert.ok(Math.abs(good.clvPercent - (11 / 9 - 1)) < 1e-12);

  const bad = computeClv(9.0, closingAt(11.0));
  assert.ok(bad);
  assert.ok(bad.clvProbability < 0);
  assert.ok(bad.clvPercent < 0);

  // Symmetry in percent terms is not expected, but the signs must never agree.
  assert.notEqual(Math.sign(good.clvPercent), Math.sign(bad.clvPercent));

  assert.equal(computeClv(0.5, closingAt(2.0)), null, 'an impossible price yields no CLV');
  assert.equal(computeClv(Number.NaN, closingAt(2.0)), null);
});

test('CLV is never labelled an edge', () => {
  // A closing line is this book's own price. It supports CLV and nothing else.
  assert.equal(isEdgeClaimable(CLV_FAIR_SOURCE), false);
  const refused = evAgainstIndependent({ fairProbability: 0.5, decimalOdds: 2.2, source: CLV_FAIR_SOURCE });
  assert.equal(refused.ok, false);
});

/** n bets alternating between two prices, so the sample has real dispersion. */
function clvRun(n: number, betOdds: [number, number], closeOdds: number): ClvResult[] {
  const closing = closingAt(closeOdds);
  const out: ClvResult[] = [];
  for (let i = 0; i < n; i++) {
    const odds = i % 2 === 0 ? betOdds[0] : betOdds[1];
    const r = computeClv(odds, closing);
    assert.ok(r);
    out.push(r);
  }
  return out;
}

test('a small sample is reported, never called a signal', () => {
  // +2% CLV over 11 bets. This is the number that talks people into believing
  // in a system, and on its own it cannot be argued with.
  const summary = clvSummary(clvRun(11, [2.03, 2.05], 2.0));
  assert.ok(summary);
  assert.equal(summary.n, 11);
  assert.ok(summary.meanPercent > 0.019 && summary.meanPercent < 0.021, `${summary.meanPercent}`);
  assert.ok(summary.meanProbability > 0);

  // The t-statistic here is enormous, because the sample was constructed with
  // almost no spread. It still does not pass, and that is deliberate: below the
  // floor the standard error is itself too poorly estimated to test against.
  assert.ok((summary.tStat ?? 0) > 5, 'the naive test would have passed easily');
  assert.equal(summary.distinguishableFromZero, false);
  assert.match(summary.note, new RegExp(`${MIN_CLV_SAMPLES}-bet floor`));
});

test('a large sample can be distinguished from zero, or fail to be', () => {
  const real = clvSummary(clvRun(40, [2.03, 2.05], 2.0));
  assert.ok(real);
  assert.equal(real.n, 40);
  assert.equal(real.distinguishableFromZero, true);
  assert.ok((real.stdErrorProbability ?? 0) > 0);

  // Same size, but the bets scatter either side of the close. The mean is
  // nearly nil and the spread swamps it.
  const noise = clvSummary(clvRun(40, [2.1, 1.9], 2.0));
  assert.ok(noise);
  assert.equal(noise.distinguishableFromZero, false);
  assert.ok(Math.abs(noise.tStat ?? 99) < 2);

  assert.equal(clvSummary([]), null, 'no bets is not a zero result');

  for (const note of [real.note, noise.note]) {
    assert.doesNotMatch(note, /lock|guaranteed|free money/i);
  }
});

/* --- the honesty argument, on the real capture ---------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string): string => readFileSync(join(HERE, 'fixtures', name), 'utf8');
const TREE_PATH = '/api/v4/prematch/brand/2482975601191952386/en/1';

function realMarketRows(): RawSelectionRow[] {
  const tree = readFixture('duel-event-tree.json');
  const refs = emptyReference();
  const descriptions = parseMarketDescriptions(JSON.parse(readFixture('duel-markets-subset.json')));
  if (descriptions) mergeReference(refs, { markets: descriptions });
  const parsedTree = parseEventTree(JSON.parse(tree));
  if (parsedTree) mergeReference(refs, parsedTree);

  const capture: RawCapture = {
    captureId: 'c_analysis_tree',
    sessionId: 's_analysis',
    seq: 1,
    tsClient: T0,
    tsServer: T0,
    transport: 'fetch',
    direction: 'inbound',
    frameUrl: 'https://duel.com/sports',
    frameOrigin: 'https://duel.com',
    isTopFrame: true,
    pageOrigin: 'https://duel.com',
    method: 'GET',
    url: `https://sports-proxy.duel.com${TREE_PATH}`,
    urlHost: 'sports-proxy.duel.com',
    urlPath: TREE_PATH,
    status: 200,
    contentType: 'application/json',
    body: tree,
    bodyEncoding: 'utf8',
    bodyBytes: tree.length,
    truncated: false,
    redacted: false,
    classification: { kind: 'unknown', confidence: 0, adapterId: 't', reasons: [], shapeFingerprint: '' },
  };

  const preview = parseCapture(capture, T0, refs);
  const marketsByKey = new Map(preview.markets.map((m) => [m.key, m]));
  return preview.selections.map((s) => ({
    selectionKey: s.key,
    marketKey: s.marketKey,
    eventKey: s.eventKey,
    sportsbookId: s.sportsbookId,
    name: s.name,
    marketName: marketsByKey.get(s.marketKey)?.name ?? null,
    marketType: marketsByKey.get(s.marketKey)?.type ?? null,
    line: s.line,
    decimalOdds: s.decimalOdds,
    status: s.status,
    ts: T0,
  }));
}

test('a real market de-vigged from Duel carries no edge against Duel', () => {
  const { markets } = assembleMarkets(realMarketRows());
  assert.ok(markets.length > 100, `expected the real tree to yield markets, got ${markets.length}`);

  let checked = 0;
  for (const market of markets) {
    const proportional = devigMarket(market, { method: 'proportional' });
    if (!proportional.ok) continue; // a refusal is the honest path, not a failure
    checked += 1;

    // A single-book fair value can never support an edge claim, whatever the
    // arithmetic below says.
    assert.equal(isEdgeClaimable(proportional.fair.source), false);

    // THE PROPERTY. Proportional de-vig gives every outcome of a market the
    // identical expected value, 1/overround - 1. It does not vary by outcome,
    // so ranking a single book's outcomes by "edge" ranks nothing at all: the
    // number is the book's margin, appearing once per selection.
    const expected = 1 / proportional.fair.overround - 1;
    for (const outcome of proportional.fair.outcomes) {
      const ev = evAgainstSameBook(proportional.fair, outcome.selectionKey);
      assert.ok(ev !== null);
      assert.ok(
        Math.abs(ev - expected) < 1e-12,
        `${market.marketKey}: EV ${ev} should be the constant ${expected}`,
      );
      // And it is never positive. A tool showing "+7.8% EV" from one book's own
      // prices is showing this number, wrongly.
      assert.ok(ev <= 0, `${market.marketKey}: single-book EV must never be positive, got ${ev}`);
    }
  }
  assert.ok(checked > 100, `expected most real markets to de-vig, got ${checked}`);
});

test('the zero itself: a market with no margin prices back at exactly zero EV', () => {
  // The residual above is the book's vig, not information. Take the vig away -
  // a hypothetical 2.00/2.00 book - and the edge is exactly, bit-for-bit zero.
  // That zero is the whole argument: de-vigging a book and betting into that
  // same book recovers the price you started from and nothing else.
  const fair = devigMarket({
    marketKey: 'm_zero',
    eventKey: 'e_zero',
    sportsbookId: 'duel',
    name: 'No-margin market',
    type: 'Result',
    line: null,
    ts: T0,
    outcomes: [
      { selectionKey: 'o_0', name: 'A', decimalOdds: 2.0, line: null },
      { selectionKey: 'o_1', name: 'B', decimalOdds: 2.0, line: null },
    ],
  }, { method: 'proportional' });

  assert.equal(fair.ok, true);
  if (!fair.ok) return;
  assert.equal(fair.fair.overround, 1);
  assert.equal(evAgainstSameBook(fair.fair, 'o_0'), 0);
  assert.equal(evAgainstSameBook(fair.fair, 'o_1'), 0);
});
