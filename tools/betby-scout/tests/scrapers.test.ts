/**
 * Scraped odds sources, against payloads recorded from the live endpoints on
 * 2026-09-06.
 *
 * Both sources encode their prices in a format that is catastrophic if read
 * naively - Pinnacle in American odds, Kambi in milli-units - so the conversion
 * tests here are not pedantry. Reading Kambi's 1680 as decimal would make every
 * market look like a 1680-to-1 lottery, and reading Pinnacle's +197 as decimal
 * would do the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildPinnacleEvents, PinnacleSource, PINNACLE_LEAGUES } from '../src/odds-sources/scrapers/pinnacle.ts';
import { buildKambiEvents, KambiSource, KAMBI_PATHS } from '../src/odds-sources/scrapers/kambi.ts';
import { TheOddsApiSource } from '../src/odds-sources/the-odds-api.ts';
import { buildConsensus, type BookMarket } from '../src/analysis/consensus.ts';
import { devigMarket } from '../src/analysis/fair.ts';
import { edgeStrength, isEdgeClaimable } from '../src/analysis/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string): unknown => JSON.parse(readFileSync(join(HERE, 'fixtures', f), 'utf8'));

const pinMatchups = read('pinnacle-matchups.json');
const pinMarkets = read('pinnacle-markets.json');
const kambiRaw = read('kambi-listview.json');

/* --- Pinnacle -------------------------------------------------------------- */

test('Pinnacle American prices are converted, never read as decimal', () => {
  const events = buildPinnacleEvents(pinMatchups, pinMarkets);
  assert.ok(events.length > 0, 'the recorded fixture yields events');

  for (const event of events) {
    const outcomes = event.books[0]?.markets[0]?.outcomes ?? [];
    assert.ok(outcomes.length >= 2);
    for (const o of outcomes) {
      // +197 read as decimal would be 197. A football moneyline never is.
      assert.ok(o.decimalOdds > 1 && o.decimalOdds < 100, `${o.name} priced ${o.decimalOdds} - conversion failed`);
    }
  }
});

test('Pinnacle sides come from the designation, not from participant order', () => {
  const events = buildPinnacleEvents(pinMatchups, pinMarkets);
  const event = events[0];
  assert.ok(event);
  const names = (event.books[0]?.markets[0]?.outcomes ?? []).map((o) => o.name);
  // Outcomes are keyed by team name (plus Draw), which is what lets several
  // sources be combined without aligning anything by position.
  assert.ok(names.includes(event.homeTeam), `home team ${event.homeTeam} missing from ${names.join('/')}`);
  assert.ok(names.includes(event.awayTeam));
});

test('Pinnacle prop and period rows are excluded', () => {
  const withNoise = [
    ...(pinMatchups as unknown[]),
    { id: 1, type: 'special', startTime: '2026-09-06T16:00:00Z', participants: [{ name: 'Yes' }, { name: 'No' }] },
    { id: 2, type: 'matchup', parentId: 99, startTime: '2026-09-06T16:00:00Z', participants: [] },
  ];
  const events = buildPinnacleEvents(withNoise, pinMarkets);
  // A "Yes"/"No" prop is not a fixture, and a child row is a period of one.
  assert.ok(!events.some((e) => e.homeTeam === 'Yes'));
  assert.ok(!events.some((e) => e.id === '2'));
});

test('a real Pinnacle market de-vigs to a plausible margin', () => {
  const events = buildPinnacleEvents(pinMatchups, pinMarkets);
  const event = events[0];
  assert.ok(event);
  const outcomes = event.books[0]?.markets[0]?.outcomes ?? [];

  const result = devigMarket({
    marketKey: 'm',
    eventKey: 'e',
    sportsbookId: 'pinnacle',
    name: '1x2',
    type: 'Result',
    line: null,
    ts: Date.now(),
    outcomes: outcomes.map((o) => ({ selectionKey: o.name, name: o.name, decimalOdds: o.decimalOdds, line: null })),
  });
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  if (!result.ok) return;

  // Pinnacle's whole reputation is thin margins. Anything above ~8% on a major
  // league moneyline would mean the conversion is wrong, not that Pinnacle got
  // greedy.
  assert.ok(result.fair.marginPct > 0, 'a real book always has some margin');
  assert.ok(result.fair.marginPct < 0.08, `margin ${result.fair.marginPct} is too high to be Pinnacle`);
});

/* --- Kambi ----------------------------------------------------------------- */

test('Kambi milli-unit odds are divided by 1000', () => {
  const events = buildKambiEvents(kambiRaw);
  assert.ok(events.length > 0);

  for (const event of events) {
    for (const o of event.books[0]?.markets[0]?.outcomes ?? []) {
      // 1680 must become 1.68, not stay 1680.
      assert.ok(o.decimalOdds > 1 && o.decimalOdds < 200, `${o.name} priced ${o.decimalOdds} - milli conversion failed`);
    }
  }
});

test('Kambi 1X2 outcomes are named by side, including the draw', () => {
  const events = buildKambiEvents(kambiRaw);
  const withDraw = events.find((e) => (e.books[0]?.markets[0]?.outcomes ?? []).length === 3);
  assert.ok(withDraw, 'a football fixture has three outcomes');
  const names = (withDraw.books[0]?.markets[0]?.outcomes ?? []).map((o) => o.name);
  assert.ok(names.includes(withDraw.homeTeam));
  assert.ok(names.includes(withDraw.awayTeam));
  // The draw carries no `participant`, so it has to come from the outcome type.
  assert.ok(names.includes('Draw'), `draw missing from ${names.join('/')}`);
});

test('every Kambi brand reports as one book, because they share a trading engine', () => {
  const events = buildKambiEvents(kambiRaw);
  for (const event of events) {
    // Counting Unibet and Betsson as two books would be double-counting one
    // opinion and dressing it up as corroboration.
    assert.equal(event.books[0]?.key, 'kambi');
  }
});

/* --- the two together ------------------------------------------------------ */

test('Pinnacle alone is a claimable edge source, and a weaker tier than consensus', () => {
  assert.equal(isEdgeClaimable('sharp-reference'), true);
  assert.equal(edgeStrength('sharp-reference'), 'moderate');
  assert.equal(edgeStrength('multi-book-consensus'), 'strong');
  // The property that matters is preserved either way.
  assert.equal(isEdgeClaimable('single-book-devig'), false);
  assert.equal(edgeStrength('single-book-devig'), 'none');
});

test('two independent engines still refuse to form a consensus', () => {
  // Pinnacle and Kambi are genuinely independent, but two is not three: the
  // median of two is their mean and has no resistance to one bad price.
  const books: BookMarket[] = [
    { bookKey: 'pinnacle', bookTitle: 'Pinnacle', lastUpdate: null, prices: new Map([['Home', 2.0], ['Away', 2.0]]) },
    { bookKey: 'kambi', bookTitle: 'Kambi', lastUpdate: null, prices: new Map([['Home', 2.05], ['Away', 1.95]]) },
  ];
  const result = buildConsensus(books, { exclude: new Set(['duel']) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /3 are required|only 2/);
});

/* --- politeness and failure ------------------------------------------------ */

test('a scraped source caches so it does not hammer somebody else\'s servers', async () => {
  let calls = 0;
  const source = new KambiSource({
    now: () => 1_788_600_000_000,
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify(kambiRaw), { status: 200 });
    }) as unknown as typeof fetch,
  });

  const first = await source.fetchOdds('football/england/premier_league');
  assert.ok(first.events.length > 0);
  assert.equal(first.cached, false);

  const second = await source.fetchOdds('football/england/premier_league');
  assert.equal(calls, 1, 'a second call inside the cache window must not hit the network');
  assert.equal(second.cached, true);
});

test('a rate limit is reported plainly and the cache is reused', async () => {
  let calls = 0;
  let clock = 1_788_600_000_000;
  const source = new KambiSource({
    now: () => clock,
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify(kambiRaw), { status: 200 })
        : new Response('No access', { status: 429 });
    }) as unknown as typeof fetch,
  });

  await source.fetchOdds('football/england/premier_league');
  // Far enough ahead to clear both the cache window and the interval floor.
  clock += 60 * 60 * 1000;
  const result = await source.fetchOdds('football/england/premier_league');

  assert.match(source.status().lastError ?? '', /rate-limited/i);
  // Stale data that is labelled stale beats no data at all.
  assert.ok(result.events.length > 0);
  assert.equal(result.cached, true);
});

test('both scraped sources need no configuration', () => {
  assert.equal(new PinnacleSource().isConfigured(), true);
  assert.equal(new KambiSource().isConfigured(), true);
  assert.equal(new PinnacleSource().status().setup, null, 'nothing to set up means no setup message');
  assert.ok(PINNACLE_LEAGUES.size > 0 && KAMBI_PATHS.size > 0);
});

test('malformed payloads yield nothing rather than throwing', () => {
  assert.deepEqual(buildKambiEvents(null), []);
  assert.deepEqual(buildKambiEvents({ events: 'nope' }), []);
  assert.deepEqual(buildPinnacleEvents(null, null), []);
  assert.deepEqual(buildPinnacleEvents([{ id: 1 }], []), []);
});

/* ------------------------------------------------------------------ *
 * Competition identity - the bug that would have cost real money
 * ------------------------------------------------------------------ */

test('a league name alone never maps: Malta is not England', () => {
  const pinnacle = new PinnacleSource();
  const kambi = new KambiSource();

  // These are REAL competitions Duel was serving on 2026-09-06, verbatim.
  const maltaFootball = { sport: 'Soccer', country: 'Malta', league: 'Premier League' };
  const kenyaBasketball = { sport: 'Basketball', country: 'Kenya', league: 'Premier League' };
  const germanHandball = { sport: 'Handball', country: 'Germany', league: 'Bundesliga' };
  const esoccerBundesliga = { sport: 'eSoccer', country: 'Germany', league: 'Bundesliga (2x6 min)' };

  for (const competition of [maltaFootball, kenyaBasketball, germanHandball, esoccerBundesliga]) {
    // Mapping any of these onto England's or Germany's football top flight
    // would compare unrelated fixtures and report an enormous fictional edge.
    assert.equal(
      pinnacle.keyForLeague(competition),
      null,
      `${competition.sport}/${competition.country}/${competition.league} must not map`,
    );
    assert.equal(kambi.keyForLeague(competition), null);
  }

  // The genuine article still maps.
  const englandFootball = { sport: 'Soccer', country: 'England', league: 'Premier League' };
  assert.equal(pinnacle.keyForLeague(englandFootball), '1980');
  assert.equal(kambi.keyForLeague(englandFootball), 'football/england/premier_league');
});

test('a competition missing its country does not map', () => {
  const pinnacle = new PinnacleSource();
  // Without the country there is no way to tell which Premier League this is,
  // and guessing is exactly the failure being guarded against.
  assert.equal(pinnacle.keyForLeague({ sport: 'Soccer', country: null, league: 'Premier League' }), null);
  assert.equal(pinnacle.keyForLeague({ sport: null, country: 'England', league: 'Premier League' }), null);
});

test('the sport-level fallback is gone, so Japanese baseball is not MLB', () => {
  const api = new TheOddsApiSource({ apiKey: 'x' });
  assert.equal(api.keyForLeague({ sport: 'Baseball', country: 'USA', league: 'MLB' }), 'baseball_mlb');
  // The old fallback mapped bare "Baseball" to MLB, which would have priced an
  // NPB fixture against American baseball.
  assert.equal(api.keyForLeague({ sport: 'Baseball', country: 'Japan', league: 'NPB' }), null);
});
