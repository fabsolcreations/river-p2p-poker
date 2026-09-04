/**
 * Duel adapter tests, run against REAL captured BETBY payloads.
 *
 * Unlike tests/adapters.test.ts - whose fixtures are invented shapes that
 * exercise the scoring machinery - everything asserted here comes from
 * tests/fixtures/duel-bets-feed.json and duel-markets-subset.json, captured
 * from https://duel.com/sports on 2026-09-04 while logged out, by observing
 * what the page itself requested.
 *
 * These are the first assertions in the project that say anything true about
 * BETBY rather than about our own test data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { duelAdapter, DUEL_BRAND_ID, DUEL_SPORTS_HOST } from '../src/adapters/betby/duel.ts';
import { parseMoney, parseSpecifiers } from '../src/adapters/betby/generic-betby.ts';
import { adapterFor, sportsbookIdFor } from '../src/adapters/registry.ts';
import type { ClassifyInput } from '../src/shared/types.ts';
import { MIN_CLASSIFY_CONFIDENCE } from '../src/shared/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const feed: unknown = JSON.parse(readFileSync(join(HERE, 'fixtures', 'duel-bets-feed.json'), 'utf8'));
const markets: Record<string, { name?: string }> = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'duel-markets-subset.json'), 'utf8'),
);

const NOW = 1_788_547_000_000;

function input(json: unknown, path: string): ClassifyInput {
  return {
    url: `https://${DUEL_SPORTS_HOST}${path}`,
    urlHost: DUEL_SPORTS_HOST,
    urlPath: path,
    method: 'GET',
    contentType: 'application/json',
    transport: 'fetch',
    direction: 'inbound',
    json,
    text: JSON.stringify(json),
  };
}

const FEED_PATH = `/api/v1/promo/bets_feed/brand/${DUEL_BRAND_ID}`;

/* --- the fixture itself ------------------------------------------------- */

test('the captured feed has the shape we documented', () => {
  assert.ok(Array.isArray(feed), 'the bets feed is a bare array, not a wrapped object');
  const rows = feed as Array<Record<string, unknown>>;
  assert.equal(rows.length, 50, 'Duel returns 50 rows per poll');
  for (const row of rows) {
    for (const key of ['id', 'odds', 'stake', 'pot_win', 'player', 'type', 'selections']) {
      assert.ok(key in row, `every row carries ${key}`);
    }
    assert.ok(['single', 'combo'].includes(row['type'] as string), 'type is single or combo');
    // The finding that shapes the whole ingest design: no timestamp anywhere.
    assert.ok(!('ts' in row) && !('time' in row) && !('created_at' in row), 'feed rows carry no timestamp');
  }
});

/* --- classification ----------------------------------------------------- */

test('the real Duel feed classifies as bets_feed with high confidence', () => {
  const c = duelAdapter.classify(input(feed, FEED_PATH));
  assert.equal(c.kind, 'bets_feed');
  assert.ok(c.confidence >= 0.9, `expected high confidence, got ${c.confidence}`);
  assert.equal(c.adapterId, 'betby.duel');
  assert.ok(
    c.reasons.some((r) => /distinct bettor identities/.test(r)),
    'the many-distinct-handles signal must be what carries the verdict',
  );
  assert.ok(c.reasons.some((r) => /observed on 2026-09-04/.test(r)), 'the observed-endpoint note should appear');
});

test('shape alone is enough - the same payload on an unknown path still classifies', () => {
  // The endpoint map is a confidence booster, never the basis. If Duel moves
  // this endpoint the tool must still find the feed.
  const c = duelAdapter.classify(input(feed, '/some/path/we/have/never/seen'));
  assert.equal(c.kind, 'bets_feed');
  assert.ok(c.confidence >= MIN_CLASSIFY_CONFIDENCE);
});

test('a known path with an unexpected payload keeps the shape verdict and says so', () => {
  // Guards the rule that observation never silently overrides evidence.
  const c = duelAdapter.classify(input({ totally: 'different' }, FEED_PATH));
  assert.notEqual(c.kind, 'bets_feed', 'the path must not force a verdict the payload does not support');
  assert.ok(c.reasons.some((r) => /may have changed/.test(r)));
  assert.ok(c.confidence <= 0.5);
});

/* --- parsing ------------------------------------------------------------ */

const parsed = duelAdapter.parse({
  ...input(feed, FEED_PATH),
  captureId: 'c_real',
  sportsbookId: 'duel',
  classification: duelAdapter.classify(input(feed, FEED_PATH)),
  ctx: { now: NOW },
});

test('every real feed row parses into a bet', () => {
  assert.equal(parsed.bets.length, 50, 'no row may be silently dropped');
});

test('stakes written as "50.01 $" are read as numbers with a currency', () => {
  // This is the field whale detection depends on; before the money reader every
  // real row came back stakeless.
  const withStake = parsed.bets.filter((b) => b.stake !== null);
  assert.equal(withStake.length, 50, 'every row has a readable stake');
  assert.ok(parsed.bets.every((b) => b.currency !== null), 'every row has a currency');

  const currencies = new Set(parsed.bets.map((b) => b.currency));
  assert.ok(currencies.has('USD'), 'the $ symbol resolves to USD');
  // The captured poll contained euro and rupee stakes too.
  assert.ok(currencies.size >= 2, `expected several currencies, saw ${[...currencies].join(',')}`);
});

test('potential win is read too', () => {
  assert.ok(parsed.bets.every((b) => b.potentialWin !== null));
  // Sanity: payout should exceed stake on a winning-priced bet.
  for (const b of parsed.bets) {
    if (b.stake !== null && b.potentialWin !== null && b.totalOdds !== null && b.totalOdds > 1) {
      assert.ok(b.potentialWin >= b.stake, `payout ${b.potentialWin} should be at least the stake ${b.stake}`);
    }
  }
});

test('singles and combos are distinguished and legs expanded', () => {
  const singles = parsed.bets.filter((b) => b.type === 'single');
  const combos = parsed.bets.filter((b) => b.type === 'combo');
  assert.ok(singles.length > 0 && combos.length > 0, 'the capture contains both');
  assert.ok(singles.every((b) => b.legCount === 1));
  assert.ok(combos.every((b) => b.legCount >= 2));
  assert.ok(parsed.bets.every((b) => b.legs.every((l) => l.betKey === b.key)));
});

test('leg odds come from the k field and are valid decimal prices', () => {
  const legs = parsed.bets.flatMap((b) => b.legs);
  const priced = legs.filter((l) => l.oddsAtBet !== null);
  assert.ok(priced.length > legs.length * 0.9, 'nearly every leg should have a price');
  assert.ok(priced.every((l) => (l.oddsAtBet as number) > 1), 'a decimal price is always above 1');
});

test('lines are recovered from the specifiers string', () => {
  const withLine = parsed.bets.flatMap((b) => b.legs).filter((l) => l.line !== null);
  assert.ok(withLine.length > 0, 'the capture contains total/handicap markets');
});

test('masked handles are preserved and keys are per-bettor', () => {
  assert.ok(parsed.bets.every((b) => b.bettorLabel !== null));
  const labels = new Set(parsed.bets.map((b) => b.bettorLabel));
  const keys = new Set(parsed.bets.map((b) => b.bettorKey));
  assert.equal(labels.size, keys.size, 'one key per distinct handle, no collisions');
  assert.ok(labels.size >= 20, `expected many distinct bettors, saw ${labels.size}`);
});

test('bet keys are stable and unique across a re-parse', () => {
  const again = duelAdapter.parse({
    ...input(feed, FEED_PATH),
    captureId: 'c_real',
    sportsbookId: 'duel',
    classification: duelAdapter.classify(input(feed, FEED_PATH)),
    ctx: { now: NOW + 60_000 },
  });
  assert.deepEqual(
    parsed.bets.map((b) => b.key),
    again.bets.map((b) => b.key),
    'the same feed row must key identically however long after capture it is re-parsed',
  );
  assert.equal(new Set(parsed.bets.map((b) => b.key)).size, 50, 'no two rows collide');
});

test('the missing-timestamp reality is reported once, not fifty times', () => {
  const tsWarnings = parsed.warnings.filter((w) => /timestamp/.test(w));
  assert.equal(tsWarnings.length, 1);
  assert.match(tsWarnings[0] as string, /50 of 50/);
  assert.ok(parsed.bets.every((b) => b.ts === 0), 'and the ts is honestly zero rather than invented');
});

test('unnamed legs are flagged rather than left as blank cells', () => {
  assert.ok(parsed.warnings.some((w) => /names come from the prematch\/live trees/.test(w)));
});

test('stakeUsd stays null - no FX rate source exists yet', () => {
  assert.ok(parsed.bets.every((b) => b.stakeUsd === null), 'a euro stake must not be silently treated as dollars');
});

/* --- helpers ------------------------------------------------------------ */

test('the money reader handles the formats the feed actually contains', () => {
  assert.deepEqual(parseMoney('50.01 $'), { amount: 50.01, currency: 'USD' });
  assert.deepEqual(parseMoney('253124.90 €'), { amount: 253124.9, currency: 'EUR' });
  assert.deepEqual(parseMoney('1,234.50 ₹'), { amount: 1234.5, currency: 'INR' });
  assert.deepEqual(parseMoney('5.00 USD'), { amount: 5, currency: 'USD' });
  assert.deepEqual(parseMoney(42), { amount: 42, currency: null });
  // An unmapped symbol is kept verbatim rather than dropped.
  assert.deepEqual(parseMoney('10.00 ¤'), { amount: 10, currency: '¤' });
  assert.equal(parseMoney('no digits here'), null);
  assert.equal(parseMoney(null), null);
});

test('the specifier reader recovers lines and periods', () => {
  assert.equal(parseSpecifiers('total=2.5').line, 2.5);
  assert.equal(parseSpecifiers('hcp=-1.5').line, -1.5);
  assert.equal(parseSpecifiers('setnr=2|gamenr=3').period, 'setnr=2|gamenr=3');
  assert.equal(parseSpecifiers('setnr=2|gamenr=3').line, null, 'a period is not a line');
  assert.equal(parseSpecifiers('').line, null);
  assert.equal(parseSpecifiers(null).line, null);
});

/* --- registry ----------------------------------------------------------- */

test('the sports proxy host routes to the Duel adapter', () => {
  const ctx = { pageOrigin: 'https://duel.com', frameOrigin: '', url: `https://${DUEL_SPORTS_HOST}${FEED_PATH}` };
  assert.equal(adapterFor(ctx).id, 'betby.duel');
  assert.equal(sportsbookIdFor(ctx), 'duel');
  // A lookalike must not be mistaken for Duel.
  assert.equal(adapterFor({ pageOrigin: 'https://duel.com.evil.test', frameOrigin: '', url: '' }).id, 'unknown');
});

test('the market description fixture can name the markets the feed references', () => {
  const rows = feed as Array<{ selections?: Array<{ market_id?: string }> }>;
  const ids = new Set(rows.flatMap((r) => (r.selections ?? []).map((s) => String(s.market_id))));
  const named = [...ids].filter((id) => typeof markets[id]?.name === 'string');
  // Documents that the join needed for Milestone 3 is possible with what we
  // capture today - the data is there, it is simply not wired up yet.
  assert.ok(named.length > 0, 'market ids in the feed resolve against the descriptions endpoint');
  assert.equal(named.length, ids.size, 'every referenced market has a description');
});
