/**
 * Consensus, edges and event matching.
 *
 * These cover the two ways this feature can produce a confident lie: a
 * consensus that is really one opinion counted twice, and a match to the wrong
 * fixture. Both produce a number that is arithmetically correct and completely
 * false, so most of what follows checks that the code refuses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConsensus,
  computeEdge,
  MIN_BOOKS_FOR_CONSENSUS,
  type BookMarket,
} from '../src/analysis/consensus.ts';
import { isEdgeClaimable } from '../src/analysis/types.ts';
import { evAgainstIndependent } from '../src/analysis/fair.ts';
import {
  isMatched,
  matchEvent,
  nameSimilarity,
  tokenize,
  type MatchCandidate,
} from '../src/odds-sources/matching.ts';
import { parseOddsApiEvent, TheOddsApiSource } from '../src/odds-sources/the-odds-api.ts';

const NOW = 1_788_600_000_000;

function book(key: string, home: number, away: number, lastUpdate = NOW): BookMarket {
  return {
    bookKey: key,
    bookTitle: key,
    lastUpdate,
    prices: new Map([
      ['Home', home],
      ['Away', away],
    ]),
  };
}

/* --- consensus ------------------------------------------------------------ */

test('a consensus needs at least three independent books', () => {
  const two = buildConsensus([book('a', 1.9, 1.9), book('b', 1.95, 1.87)], { now: NOW });
  assert.equal(two.ok, false);
  if (!two.ok) assert.match(two.reason, new RegExp(String(MIN_BOOKS_FOR_CONSENSUS)));

  const three = buildConsensus([book('a', 1.9, 1.9), book('b', 1.95, 1.87), book('c', 1.92, 1.89)], { now: NOW });
  assert.equal(three.ok, true);
});

test('the book being evaluated is excluded from its own consensus', () => {
  const markets = [book('duel', 1.5, 2.6), book('a', 1.9, 1.9), book('b', 1.95, 1.87), book('c', 1.92, 1.89)];

  const withDuel = buildConsensus(markets, { now: NOW });
  const withoutDuel = buildConsensus(markets, { now: NOW, exclude: new Set(['duel']) });
  assert.equal(withDuel.ok, true);
  assert.equal(withoutDuel.ok, true);
  if (!withDuel.ok || !withoutDuel.ok) return;

  // Duel's outlying price must not be able to drag the number it is judged by.
  const a = withDuel.consensus.outcomes.find((o) => o.name === 'Home')?.fairProbability ?? 0;
  const b = withoutDuel.consensus.outcomes.find((o) => o.name === 'Home')?.fairProbability ?? 0;
  assert.notEqual(a, b, 'excluding the evaluated book must change the consensus');
  assert.ok(withoutDuel.consensus.warnings.some((w) => /cannot help price itself/.test(w)));
  assert.ok(!withoutDuel.consensus.contributingBooks.includes('duel'));
});

test('each book is de-vigged before combining, so the consensus carries no margin', () => {
  // Three books each with a ~5% margin. If prices were averaged first, the
  // consensus would still contain that margin and every edge would be understated.
  const result = buildConsensus([book('a', 1.9, 1.9), book('b', 1.9, 1.9), book('c', 1.9, 1.9)], { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const total = result.consensus.outcomes.reduce((a, o) => a + o.fairProbability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `a fair book sums to 1, got ${total}`);
  // A symmetric market must come out 50/50.
  for (const o of result.consensus.outcomes) assert.ok(Math.abs(o.fairProbability - 0.5) < 1e-6);
  // And the margin is reported rather than silently removed.
  assert.ok(result.consensus.medianOverround > 1.05);
});

test('a stale book is dropped and the drop is reported', () => {
  const fresh = [book('a', 1.9, 1.9), book('b', 1.95, 1.87), book('c', 1.92, 1.89)];
  const withStale = [...fresh, book('old', 5.0, 1.1, NOW - 12 * 60 * 60 * 1000)];

  const result = buildConsensus(withStale, { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(!result.consensus.contributingBooks.includes('old'));
  assert.ok(result.consensus.warnings.some((w) => /stale/.test(w)));
});

test('the median resists one bad price where a mean would not', () => {
  const sane = [book('a', 1.9, 1.9), book('b', 1.92, 1.88), book('c', 1.88, 1.92)];
  const withOutlier = [...sane, book('bad', 1.05, 15.0)];

  const clean = buildConsensus(sane, { now: NOW });
  const dirty = buildConsensus(withOutlier, { now: NOW });
  assert.equal(clean.ok, true);
  assert.equal(dirty.ok, true);
  if (!clean.ok || !dirty.ok) return;

  const a = clean.consensus.outcomes.find((o) => o.name === 'Home')?.fairProbability ?? 0;
  const b = dirty.consensus.outcomes.find((o) => o.name === 'Home')?.fairProbability ?? 0;
  assert.ok(Math.abs(a - b) < 0.12, `one wild book moved the median by ${Math.abs(a - b)}, which is too much`);
  assert.ok(dirty.consensus.warnings.some((w) => /disagree|differ by/.test(w)));
});

/* --- the edge: the first claimable one ------------------------------------ */

test('a consensus unlocks an edge claim that a single book never could', () => {
  const result = buildConsensus([book('a', 1.9, 1.9), book('b', 1.92, 1.88), book('c', 1.88, 1.92)], { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.consensus.source, 'multi-book-consensus');
  assert.equal(isEdgeClaimable(result.consensus.source), true, 'this is the whole point of the feature');

  // A single-book value still cannot.
  assert.equal(
    evAgainstIndependent({ fairProbability: 0.5, decimalOdds: 2.2, source: 'single-book-devig' }).ok,
    false,
  );
});

test('a better price than consensus is a positive edge, a worse one negative', () => {
  const result = buildConsensus([book('a', 1.9, 1.9), book('b', 1.92, 1.88), book('c', 1.88, 1.92)], { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Consensus is 50%, so fair odds are 2.00.
  const good = computeEdge({ outcomeName: 'Home', bookOdds: 2.2, consensus: result.consensus });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.ok(good.edge.ev > 0, 'taking 2.20 on a 50% shot is +EV');
    assert.ok(Math.abs(good.edge.ev - 0.1) < 0.02, `expected about +10%, got ${good.edge.ev}`);
    assert.ok(good.edge.probabilityGap > 0);
  }

  const bad = computeEdge({ outcomeName: 'Home', bookOdds: 1.8, consensus: result.consensus });
  assert.equal(bad.ok, true);
  if (bad.ok) assert.ok(bad.edge.ev < 0);
});

test('a suspiciously large edge is flagged as suspicious', () => {
  const result = buildConsensus([book('a', 1.9, 1.9), book('b', 1.92, 1.88), book('c', 1.88, 1.92)], { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const huge = computeEdge({ outcomeName: 'Home', bookOdds: 3.0, consensus: result.consensus });
  assert.equal(huge.ok, true);
  if (huge.ok) {
    assert.ok(huge.edge.ev > 0.15);
    assert.ok(
      huge.edge.warnings.some((w) => /suspicious/.test(w) && /matched the right fixture/.test(w)),
      'a big edge is more often a bad match than an opportunity, and must say so',
    );
  }
});

test('an unknown outcome is refused rather than defaulted', () => {
  const result = buildConsensus([book('a', 1.9, 1.9), book('b', 1.92, 1.88), book('c', 1.88, 1.92)], { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(computeEdge({ outcomeName: 'Draw', bookOdds: 3.5, consensus: result.consensus }).ok, false);
});

/* --- event matching: the dangerous part ----------------------------------- */

function candidate(id: string, home: string, away: string, at: number): MatchCandidate {
  return { externalId: id, homeTeam: home, awayTeam: away, commenceTime: at, sportKey: 'soccer_spain_la_liga' };
}

test('name similarity treats a longer name as the same club, not a different one', () => {
  // The relationship that actually holds between two books naming one club.
  assert.ok(nameSimilarity('Real Betis Seville', 'Real Betis') > 0.99);
  assert.ok(nameSimilarity('Liverpool FC', 'Liverpool') > 0.99);
  // And the pair that must NOT score highly despite sharing a token.
  assert.ok(nameSimilarity('Real Betis', 'Real Madrid') < 0.6, 'sharing "Real" is not sharing an identity');
  assert.equal(tokenize('Liverpool FC').join(' '), 'liverpool', 'noise words are stripped');
});

test('a correct fixture matches with its reasoning stated', () => {
  const m = matchEvent(
    { eventKey: 'e1', home: 'Real Betis Seville', away: 'Real Madrid', startTime: NOW, sport: 'Soccer' },
    [candidate('x1', 'Real Betis', 'Real Madrid', NOW + 60_000), candidate('x2', 'Barcelona', 'Sevilla', NOW)],
  );
  assert.ok(isMatched(m));
  if (!isMatched(m)) return;
  assert.equal(m.externalId, 'x1');
  assert.ok(m.confidence >= 0.7);
  assert.ok(m.reasons.some((r) => /Real Betis/.test(r)));
});

test('a swapped home/away listing is detected, not mismatched', () => {
  const m = matchEvent(
    { eventKey: 'e1', home: 'Real Madrid', away: 'Real Betis Seville', startTime: NOW, sport: 'Soccer' },
    [candidate('x1', 'Real Betis', 'Real Madrid', NOW)],
  );
  assert.ok(isMatched(m));
  // Getting this backwards would invert every handicap and every side.
  if (isMatched(m)) assert.equal(m.swapped, true);
});

test('the same fixture on a different date is refused', () => {
  // The reverse leg, months later. Same two clubs, different match.
  const m = matchEvent(
    { eventKey: 'e1', home: 'Real Betis Seville', away: 'Real Madrid', startTime: NOW, sport: 'Soccer' },
    [candidate('x1', 'Real Betis', 'Real Madrid', NOW + 90 * 24 * 60 * 60 * 1000)],
  );
  assert.equal(isMatched(m), false);
});

test('two equally plausible fixtures are refused rather than guessed between', () => {
  const m = matchEvent(
    { eventKey: 'e1', home: 'Manchester United', away: 'Arsenal', startTime: NOW, sport: 'Soccer' },
    [candidate('x1', 'Manchester United', 'Arsenal', NOW), candidate('x2', 'Manchester United', 'Arsenal', NOW + 1000)],
  );
  assert.equal(isMatched(m), false);
  assert.ok(m.reasons.some((r) => /score almost identically|Refusing rather than guessing/.test(r)));
});

test('a missing start time refuses, because the date is what separates fixtures', () => {
  const m = matchEvent(
    { eventKey: 'e1', home: 'Real Betis', away: 'Real Madrid', startTime: null, sport: 'Soccer' },
    [candidate('x1', 'Real Betis', 'Real Madrid', NOW)],
  );
  assert.equal(isMatched(m), false);
  assert.ok(m.reasons.some((r) => /no start time/.test(r)));
});

test('an unrelated fixture never matches', () => {
  const m = matchEvent(
    { eventKey: 'e1', home: 'Real Betis Seville', away: 'Real Madrid', startTime: NOW, sport: 'Soccer' },
    [candidate('x1', 'Bayern Munich', 'Borussia Dortmund', NOW)],
  );
  assert.equal(isMatched(m), false);
});

/* --- the API client -------------------------------------------------------- */

test('a documented API event maps cleanly, and a malformed one is dropped', () => {
  const raw = {
    id: 'abc',
    sport_key: 'soccer_epl',
    sport_title: 'EPL',
    commence_time: '2026-09-10T00:20:00Z',
    home_team: 'Liverpool',
    away_team: 'Arsenal',
    bookmakers: [
      {
        key: 'pinnacle',
        title: 'Pinnacle',
        last_update: '2026-09-09T23:00:00Z',
        markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: 1.9 }, { name: 'Arsenal', price: 2.0 }] }],
      },
    ],
  };
  const event = parseOddsApiEvent(raw);
  assert.ok(event);
  assert.equal(event.homeTeam, 'Liverpool');
  assert.equal(event.books[0]?.markets[0]?.outcomes[1]?.decimalOdds, 2.0);
  assert.ok((event.commenceTime ?? 0) > 1_700_000_000_000, 'ISO time is converted to epoch ms');

  assert.equal(parseOddsApiEvent({ id: 'x' }), null, 'an event with no teams is not an event');
  // American odds arriving where decimal was requested must not be read as prices.
  const american = parseOddsApiEvent({
    ...raw,
    bookmakers: [{ key: 'p', title: 'P', markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: -303 }] }] }],
  });
  assert.equal(american?.books.length, 0, 'a price at or below 1 is a format mismatch, not a quote');
});

test('an unconfigured source is inert and says how to configure it', async () => {
  const source = new TheOddsApiSource({ apiKey: null });
  assert.equal(source.isConfigured(), false);
  const status = source.status();
  assert.match(status.setup ?? '', /the-odds-api\.com/);
  assert.match(status.setup ?? '', /ODDS_API_KEY/);

  // It must not throw, and must not pretend to have data.
  const result = await source.fetchOdds('soccer_epl');
  assert.deepEqual(result.events, []);
  assert.deepEqual(await source.listSports(), []);
});

test('a cached response is served without spending quota', async () => {
  let calls = 0;
  const payload = JSON.stringify([
    {
      id: 'a',
      sport_key: 'soccer_epl',
      sport_title: 'EPL',
      commence_time: '2026-09-10T00:20:00Z',
      home_team: 'Liverpool',
      away_team: 'Arsenal',
      bookmakers: [
        { key: 'p', title: 'P', last_update: '2026-09-09T23:00:00Z', markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: 1.9 }] }] },
      ],
    },
  ]);

  const source = new TheOddsApiSource({
    apiKey: 'test-key',
    now: () => NOW,
    fetchImpl: (async () => {
      calls += 1;
      return new Response(payload, {
        status: 200,
        headers: { 'x-requests-remaining': '480', 'x-requests-used': '20', 'x-requests-last': '1' },
      });
    }) as unknown as typeof fetch,
  });

  const first = await source.fetchOdds('soccer_epl');
  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(first.quota.remaining, 480, 'quota headers are read back');

  const second = await source.fetchOdds('soccer_epl');
  // On a 500-a-month budget this is the difference between usable and exhausted.
  assert.equal(calls, 1, 'a second call inside the cache window must not spend a credit');
  assert.equal(second.cached, true);
});

test('an exhausted quota is reported plainly, not as an empty result', async () => {
  const source = new TheOddsApiSource({
    apiKey: 'test-key',
    now: () => NOW,
    fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
  });
  await source.fetchOdds('soccer_epl');
  assert.match(source.status().lastError ?? '', /quota exhausted/i);
});
