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
import {
  emptyReference,
  mergeReference,
  ordinal,
  parseEventTree,
  parseMarketDescriptions,
  referenceSize,
  renderTemplate,
} from '../src/adapters/betby/dictionary.ts';
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

test('a known path serving a payload of a different shape keeps the SHAPE verdict', () => {
  // Guards the rule that observation never silently overrides positive
  // evidence. The market dictionary has a decisive shape of its own, so
  // serving it on the feed path must not make it a feed.
  const c = duelAdapter.classify(input(markets, FEED_PATH));
  assert.equal(c.kind, 'market_list', 'the payload is what it is, whatever the path says');
  assert.ok(c.reasons.some((r) => /may have changed/.test(r)));
  assert.ok(c.confidence <= 0.5, 'and the disagreement must cost confidence');
});

test('a known path with an inscrutable payload falls back to the observed kind', () => {
  // Different case: shape analysis found NOTHING, so there is no evidence to
  // override - only a gap the observed path can fill. The reason must say the
  // verdict rests on the path, not the payload.
  const c = duelAdapter.classify(input({ totally: 'different' }, FEED_PATH));
  assert.equal(c.kind, 'bets_feed');
  assert.ok(c.confidence < 0.9, 'a path-derived verdict must rank below a shape-derived one');
  assert.ok(c.reasons.some((r) => /rests on the observed path/.test(r)));
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

test('with no dictionary loaded, every leg is unnamed and the parser says so', () => {
  // `parsed` is deliberately built without refs. That is the cold-start state,
  // and it must be reported rather than looking like a feed of nameless events.
  assert.ok(parsed.bets.flatMap((b) => b.legs).every((l) => l.eventName === null));
  assert.ok(parsed.warnings.some((w) => /could not be named/.test(w)));
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

/* ------------------------------------------------------------------ *
 * Name resolution — the id -> name join, against real payloads
 * ------------------------------------------------------------------ */

const tree: unknown = JSON.parse(readFileSync(join(HERE, 'fixtures', 'duel-event-tree.json'), 'utf8'));

function buildRefs() {
  const ref = emptyReference();
  const md = parseMarketDescriptions(markets);
  if (md) mergeReference(ref, { markets: md });
  const t = parseEventTree(tree);
  if (t) mergeReference(ref, t);
  return ref;
}

const refs = buildRefs();
const named = duelAdapter.parse({
  ...input(feed, FEED_PATH),
  captureId: 'c_real',
  sportsbookId: 'duel',
  classification: duelAdapter.classify(input(feed, FEED_PATH)),
  ctx: { now: NOW, refs },
});

test('both reference payloads parse into dictionaries', () => {
  const size = referenceSize(refs);
  assert.ok(size.markets > 0, 'market descriptions loaded');
  assert.ok(size.events > 0, 'event tree loaded');
  assert.ok(size.sports > 0 && size.tournaments > 0);

  // Each parser must reject the other's payload - that is what lets the store
  // identify a payload by trying to parse it rather than trusting a label.
  assert.equal(parseEventTree(markets), null, 'market descriptions are not an event tree');
  assert.equal(parseMarketDescriptions(feed), null, 'a bets feed is not a market dictionary');
  assert.equal(parseEventTree({ version: 1, status: {} }), null, 'the cursor-0 handshake has no events');
});

test('feed legs resolve to real team, league and market names', () => {
  const legs = named.bets.flatMap((b) => b.legs);
  const withNames = legs.filter((l) => l.eventName !== null);
  assert.ok(withNames.length > 0, 'at least some legs resolve against this snapshot');

  for (const leg of withNames) {
    assert.ok((leg.eventName as string).length > 0);
    // A resolved name must never still contain an unrendered template token.
    assert.ok(!/\{[^}]*\}/.test(leg.eventName as string), `unrendered token in "${leg.eventName}"`);
    if (leg.selectionName) {
      assert.ok(!/\{\$competitor\d\}/.test(leg.selectionName), `competitor token left in "${leg.selectionName}"`);
    }
  }
});

test('naming adds information without changing identity', () => {
  // The join must not alter any key, or a named leg would stop matching the
  // same leg captured before the dictionary arrived.
  assert.deepEqual(
    parsed.bets.map((b) => b.key),
    named.bets.map((b) => b.key),
  );
  assert.deepEqual(
    parsed.bets.flatMap((b) => b.legs.map((l) => l.selectionKey)),
    named.bets.flatMap((b) => b.legs.map((l) => l.selectionKey)),
  );
  // ...and it strictly adds names.
  const before = parsed.bets.flatMap((b) => b.legs).filter((l) => l.eventName !== null).length;
  const after = named.bets.flatMap((b) => b.legs).filter((l) => l.eventName !== null).length;
  assert.ok(after > before, `expected more named legs with refs (${before} -> ${after})`);
});

test('current odds come from the event tree, not from the feed row', () => {
  const withCurrent = named.bets.flatMap((b) => b.legs).filter((l) => l.currentOdds !== null);
  assert.ok(withCurrent.length > 0, 'the tree carried live prices for some feed selections');
  // Without the dictionary there is no current price at all - the feed row
  // only ever carries the price at bet time.
  assert.ok(parsed.bets.flatMap((b) => b.legs).every((l) => l.currentOdds === null));
  for (const l of withCurrent) assert.ok((l.currentOdds as number) > 1);
});

test('an unnamed leg is reported with a reason, not silently blank', () => {
  const legs = named.bets.flatMap((b) => b.legs);
  if (legs.some((l) => l.eventName === null)) {
    assert.ok(named.warnings.some((w) => /could not be named/.test(w)));
    assert.ok(named.warnings.some((w) => /api\/refs/.test(w)), 'the warning should say where to look');
  }
});

/* --- template engine --------------------------------------------------- */

test('every template form the descriptions use renders correctly', () => {
  const ctx = {
    specifiers: { total: '2.5', hcp: '1.5', setnr: '2', gamenr: '3', from: '1', to: '5' },
    competitors: ['G2 Esports', 'LOUD'],
  };
  assert.equal(renderTemplate('over {total}', ctx), 'over 2.5');
  assert.equal(renderTemplate('{$competitor1}', ctx), 'G2 Esports');
  assert.equal(renderTemplate('{$competitor2}', ctx), 'LOUD');
  assert.equal(renderTemplate('{!setnr} set game {gamenr} - winner', ctx), '2nd set game 3 - winner');
  assert.equal(renderTemplate('{+hcp}', ctx), '+1.5');
  assert.equal(renderTemplate('{-hcp}', ctx), '-1.5');
  assert.equal(renderTemplate('{(to-from)}', ctx), '4');

  // Ordinals, including the 11/12/13 exception.
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
});

test('an unresolvable token is left visible rather than blanked', () => {
  const ctx = { specifiers: {}, competitors: [] };
  // A silently emptied label reads as a real name and cannot be diagnosed;
  // "{$competitor1}" on screen is obviously a gap.
  assert.equal(renderTemplate('{$competitor1}', ctx), '{$competitor1}');
  assert.equal(renderTemplate('over {total}', ctx), 'over {total}');
  assert.equal(renderTemplate('no tokens here', ctx), 'no tokens here');
});

test('a zero handicap renders unsigned', () => {
  const ctx = { specifiers: { hcp: '0' }, competitors: [] };
  assert.equal(renderTemplate('{+hcp}', ctx), '0');
});

test('event tree scheduled times are converted from seconds to ms', () => {
  const t = parseEventTree(tree);
  assert.ok(t);
  const dated = [...(t as { events: Map<string, { scheduled: number | null }> }).events.values()].filter(
    (e) => e.scheduled !== null,
  );
  assert.ok(dated.length > 0);
  for (const e of dated) {
    // Anything still in seconds would land in 1970 and break every kickoff
    // comparison downstream.
    assert.ok((e.scheduled as number) > 1_600_000_000_000, `scheduled ${e.scheduled} looks like seconds, not ms`);
  }
});
