/**
 * Adapter tests.
 *
 * READ THIS BEFORE TRUSTING ANY FIXTURE HERE.
 *
 * Every payload in this file is INVENTED. None of it came from BETBY, from
 * duel.com, or from any real sportsbook. They exist to exercise the scoring
 * machinery - "does a many-handles array outscore a one-handle array", "does a
 * taxonomy tree avoid being called a bets feed" - and nothing more. A test
 * passing here means the classifier reasons correctly about structure; it does
 * NOT mean it will classify real BETBY traffic correctly.
 *
 * At Milestone 2, real captures from the browser replace these fixtures, and
 * the assertions become meaningful in a way they cannot be today.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCapture, makeClassifyInput, parseCapture, adapterFor, sportsbookIdFor } from '../src/adapters/registry.ts';
import { classifyGeneric } from '../src/adapters/betby/generic-betby.ts';
import type { CaptureKind, ClassifyInput, RawCapture } from '../src/shared/types.ts';
import { MIN_CLASSIFY_CONFIDENCE } from '../src/shared/types.ts';

const NOW = 1_800_000_000_000;

function input(json: unknown, overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    url: 'https://data.example.test/x',
    urlHost: 'data.example.test',
    urlPath: '/x',
    method: 'GET',
    contentType: 'application/json',
    transport: 'fetch',
    direction: 'inbound',
    json,
    text: JSON.stringify(json),
    ...overrides,
  };
}

function capture(json: unknown, overrides: Partial<RawCapture> = {}): RawCapture {
  const body = JSON.stringify(json);
  return {
    captureId: 'c_x',
    sessionId: 's_x',
    seq: 1,
    tsClient: NOW,
    transport: 'fetch',
    direction: 'inbound',
    frameUrl: 'https://duel.com/sports',
    frameOrigin: 'https://duel.com',
    isTopFrame: true,
    pageOrigin: 'https://duel.com',
    method: 'GET',
    url: 'https://data.example.test/x',
    urlHost: 'data.example.test',
    urlPath: '/x',
    status: 200,
    contentType: 'application/json',
    body,
    bodyEncoding: 'utf8',
    bodyBytes: body.length,
    truncated: false,
    redacted: false,
    classification: { kind: 'unknown', confidence: 0, adapterId: 'test', reasons: [], shapeFingerprint: '' },
    ...overrides,
  };
}

/* --- invented fixtures ------------------------------------------------- */

/** A feed-shaped array: many different masked handles, stakes, odds, legs. */
function feedLike(handleCount: number, rows = 24): unknown {
  const items = Array.from({ length: rows }, (_, i) => ({
    id: `b${i}`,
    createdAt: NOW - i * 1000,
    user: handleCount === 1 ? '****aa' : `****${String.fromCharCode(97 + (i % handleCount))}${i % 7}`,
    amount: 10 + (i % 9) * 25,
    currency: 'USD',
    totalOdds: 1.8 + (i % 11) * 0.35,
    possibleWin: 100 + i,
    status: 'open',
    selections: [
      { eventId: `e${i}`, sport: 'Soccer', league: 'La Liga', event: 'Real Madrid vs Sevilla', market: 'Moneyline', selection: 'Real Madrid', odds: 1.8 + (i % 5) * 0.2 },
    ],
  }));
  return { data: { items } };
}

/** An event-list shape: competitors, start times, nested markets. */
const eventListLike = {
  result: {
    events: Array.from({ length: 8 }, (_, i) => ({
      event_id: `ev${i}`,
      sport_name: 'Esports',
      tournament: 'LCK',
      home_team: `Team A${i}`,
      away_team: `Team B${i}`,
      start_time: Math.floor((NOW + i * 3_600_000) / 1000),
      markets: [
        {
          market_id: `m${i}`,
          market_name: 'Map Handicap',
          handicap: -2.5,
          outcomes: [
            { outcome_id: `o${i}a`, outcome_name: 'Team A', koef: 11.0 },
            { outcome_id: `o${i}b`, outcome_name: 'Team B', koef: 1.05 },
          ],
        },
      ],
    })),
  },
};

/** A taxonomy tree: deep, named, no odds, no timestamps. */
const sportTreeLike = {
  sports: [
    {
      id: 1,
      name: 'Soccer',
      children: [
        { id: 11, name: 'Europe', children: [{ id: 111, name: 'England', children: [{ id: 1111, name: 'Premier League', children: [] }] }] },
      ],
    },
  ],
};

/* --- classification ----------------------------------------------------- */

test('a many-handle wager array classifies as the public bets feed', () => {
  const c = classifyGeneric(input(feedLike(9)));
  assert.equal(c.kind, 'bets_feed');
  assert.ok(c.confidence >= MIN_CLASSIFY_CONFIDENCE, `confidence ${c.confidence} should clear the guess threshold`);
  assert.ok(
    c.reasons.some((r) => /distinct bettor identities/.test(r)),
    `the decisive reason must be stated; got: ${c.reasons.join(' | ')}`,
  );
});

test('the same array with one repeated handle is a personal history, not a feed', () => {
  const c = classifyGeneric(input(feedLike(1)));
  assert.equal(c.kind, 'user_bets', `expected user_bets, got ${c.kind}: ${c.reasons.join(' | ')}`);
  assert.ok(c.reasons.some((r) => /only 1 distinct bettor identity/.test(r)));
});

test('a taxonomy tree is never mistaken for a bets feed', () => {
  const c = classifyGeneric(input(sportTreeLike));
  assert.notEqual(c.kind, 'bets_feed');
  assert.equal(c.kind, 'sport_tree');
});

test('an event list is recognised by competitor names, not by its endpoint', () => {
  const c = classifyGeneric(input(eventListLike));
  assert.equal(c.kind, 'event_list');
  assert.ok(c.reasons.some((r) => /competitors/.test(r)));
});

test('the same payload classifies identically from a different URL', () => {
  // The point of shape-based classification: the endpoint name is irrelevant.
  const a = classifyGeneric(input(feedLike(9), { url: 'https://a.test/totally/unrelated', urlPath: '/totally/unrelated' }));
  const b = classifyGeneric(input(feedLike(9), { url: 'https://b.test/api/v3/bets/feed', urlPath: '/api/v3/bets/feed' }));
  assert.equal(a.kind, b.kind);
  assert.equal(a.shapeFingerprint, b.shapeFingerprint);
});

test('garbage is unknown with low confidence and a stated reason', () => {
  const c = classifyGeneric(input({ a: 1, b: 'x' }));
  assert.equal(c.kind, 'unknown');
  assert.ok(c.confidence < MIN_CLASSIFY_CONFIDENCE);
  assert.ok(c.reasons.length > 0, 'an unknown verdict must still explain what was looked for');
});

test('a non-JSON body says so rather than scoring nothing silently', () => {
  const c = classifyGeneric(input(null, { json: null, text: '<html></html>', contentType: 'text/html' }));
  assert.equal(c.kind, 'unknown');
  assert.ok(c.reasons.some((r) => /not JSON/.test(r)));
});

test('assets are decided from content-type alone', () => {
  const c = classifyGeneric(input(null, { contentType: 'image/png', text: null }));
  assert.equal(c.kind, 'asset');
});

test('a translation dictionary is not confused with data', () => {
  const dict: Record<string, string> = {};
  for (let i = 0; i < 40; i++) dict[`sportsbook.market.label_${i}`] = `Label ${i}`;
  const c = classifyGeneric(input(dict));
  assert.equal(c.kind, 'translation');
});

test('confidence drops when a runner-up scores nearly as well', () => {
  // Wager-shaped rows with no identity field at all: genuinely ambiguous
  // between a feed and a personal history, and the verdict must show it.
  const ambiguous = {
    items: Array.from({ length: 12 }, (_, i) => ({
      id: i,
      amount: 25,
      odds: 2.4,
      ts: NOW - i * 1000,
    })),
  };
  const c = classifyGeneric(input(ambiguous));
  assert.ok(c.confidence < MIN_CLASSIFY_CONFIDENCE, `ambiguous payload should not read as a fact (got ${c.confidence})`);
});

/* --- parsing ------------------------------------------------------------ */

test('both snake_case and camelCase spellings parse to the same shape', () => {
  // Three rows, because one row is not a feed and the classifier is right to
  // refuse to call it one. The subject of this test is field spelling, not
  // sample size.
  const camel = {
    items: [0, 1, 2].map((i) => ({
      betId: `b${i}`,
      createdAt: NOW - i * 1000,
      user: `****t${i}`,
      amount: 200,
      totalOdds: 3.5,
      selections: [{ eventId: 'e1', odds: 3.5, selection: 'KT Rolster' }],
    })),
  };
  const snake = {
    items: [0, 1, 2].map((i) => ({
      bet_id: `b${i}`,
      created_at: NOW - i * 1000,
      user_name: `****t${i}`,
      bet_amount: 200,
      total_odds: 3.5,
      selections: [{ event_id: 'e1', odds: 3.5, selection_name: 'KT Rolster' }],
    })),
  };

  const a = parseCapture(capture(camel), NOW);
  const b = parseCapture(capture(snake), NOW);

  assert.equal(a.bets.length, 3);
  assert.equal(b.bets.length, 3);
  assert.equal(a.bets[0]?.stake, 200);
  assert.equal(b.bets[0]?.stake, 200);
  assert.equal(a.bets[0]?.totalOdds, 3.5);
  assert.equal(b.bets[0]?.totalOdds, 3.5);
  assert.equal(a.bets[0]?.key, b.bets[0]?.key, 'the same bet written two ways must produce one key');
});

test('an out-of-range odds value is dropped with a warning, never coerced', () => {
  const payload = {
    items: [0, 1, 2].map((i) => ({
      betId: `b${i}`,
      createdAt: NOW - i * 1000,
      user: `****t${i}`,
      amount: 10,
      totalOdds: 0.5,
      selections: [{ eventId: 'e1', odds: 99999, selection: 'X' }],
    })),
  };
  const p = parseCapture(capture(payload), NOW);
  assert.equal(p.bets[0]?.totalOdds, null, 'an impossible price must be null, not a plausible-looking number');
  assert.equal(p.bets[0]?.legs[0]?.oddsAtBet, null);
  assert.ok(p.warnings.some((w) => /outside the valid decimal/.test(w)));
});

test('parsing is deterministic across calls', () => {
  const c = capture(feedLike(9));
  const a = parseCapture(c, NOW);
  const b = parseCapture(c, NOW);
  assert.deepEqual(
    a.bets.map((x) => x.key),
    b.bets.map((x) => x.key),
  );
});

test('event lists yield events, markets, selections and odds snapshots together', () => {
  const p = parseCapture(capture(eventListLike), NOW);
  assert.equal(p.events.length, 8);
  assert.ok(p.markets.length >= 8);
  assert.ok(p.selections.length >= 16);
  assert.ok(p.oddsSnapshots.length >= 16);
  // Every snapshot must be traceable back to the capture it came from.
  assert.ok(p.oddsSnapshots.every((s) => s.captureId === 'c_x'));
  assert.ok(p.oddsSnapshots.every((s) => s.decimalOdds > 1));
});

test('unmapped fields are reported so we can see what we are still ignoring', () => {
  const payload = {
    items: [0, 1, 2].map((i) => ({
      betId: `b${i}`,
      createdAt: NOW - i * 1000,
      user: `****t${i}`,
      amount: 10,
      totalOdds: 2.5,
      someFieldWeDoNotUnderstand: 'xyz',
      selections: [{ eventId: 'e1', odds: 2.5 }],
    })),
  };
  const p = parseCapture(capture(payload), NOW);
  assert.ok(
    p.unmappedFields.some((f) => f.includes('someFieldWeDoNotUnderstand')),
    `expected the unknown field to be reported; got ${p.unmappedFields.join(', ')}`,
  );
});

test('a bet with no legs array does not claim to be a single', () => {
  const payload = {
    items: [0, 1, 2].map((i) => ({ betId: `b${i}`, createdAt: NOW - i * 1000, user: `****t${i}`, amount: 10, totalOdds: 2.5 })),
  };
  const p = parseCapture(capture(payload), NOW);
  assert.equal(p.bets[0]?.type, 'unknown', 'we cannot know it is a single if we never found its legs');
  assert.equal(p.bets[0]?.legCount, 0);
});

test('multi-leg bets are combos and their legs are expanded', () => {
  const payload = {
    items: [0, 1, 2].map((i) => ({
      betId: `b${i}`,
      createdAt: NOW - i * 1000,
      user: `****t${i}`,
      amount: 10,
      totalOdds: 6.5,
      selections: [
        { eventId: 'e1', odds: 2.5, selection: 'A' },
        { eventId: 'e2', odds: 3.5, selection: 'B' },
      ],
    })),
  };
  const p = parseCapture(capture(payload), NOW);
  assert.equal(p.bets[0]?.type, 'combo');
  assert.equal(p.bets[0]?.legCount, 2);
  assert.equal(p.bets[0]?.legs[1]?.idx, 1);
  assert.ok(p.bets[0]?.legs.every((l) => l.betKey === p.bets[0]?.key));
});

test('stakeUsd stays null because no FX source exists yet', () => {
  const p = parseCapture(capture(feedLike(9)), NOW);
  assert.ok(p.bets.length > 0);
  assert.ok(p.bets.every((b) => b.stakeUsd === null), 'an unconverted stake must not be silently treated as USD');
});

/* --- registry robustness ------------------------------------------------ */

test('classifying a malformed capture degrades instead of throwing', () => {
  const broken = capture({}, { body: '{not json', bodyEncoding: 'utf8' });
  const c = classifyCapture(broken);
  assert.equal(c.kind, 'unknown');
  assert.ok(c.confidence < MIN_CLASSIFY_CONFIDENCE);
});

test('a binary body that is not UTF-8 stays unreadable rather than becoming mojibake', () => {
  const bin = capture({}, { body: Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString('base64'), bodyEncoding: 'base64' });
  const parsed = makeClassifyInput(bin);
  assert.equal(parsed.text, null);
  assert.equal(parsed.json, null);
});

test('a base64 body that IS valid UTF-8 json decodes and classifies', () => {
  const json = feedLike(9);
  const b64 = capture({}, { body: Buffer.from(JSON.stringify(json), 'utf8').toString('base64'), bodyEncoding: 'base64' });
  const c = classifyCapture(b64);
  assert.equal(c.kind, 'bets_feed');
});

test('the duel adapter claims duel.com and the generic one claims nothing', () => {
  const onDuel = adapterFor({ pageOrigin: 'https://duel.com', frameOrigin: 'https://duel.com', url: 'https://x.test/y' });
  assert.equal(onDuel.id, 'betby.duel');
  assert.equal(sportsbookIdFor({ pageOrigin: 'https://duel.com', frameOrigin: 'https://duel.com', url: '' }), 'duel');

  const elsewhere = adapterFor({ pageOrigin: 'https://other.test', frameOrigin: 'https://other.test', url: 'https://other.test' });
  assert.equal(elsewhere.id, 'unknown', 'an unrecognised site must not be silently treated as Duel');
  assert.equal(
    sportsbookIdFor({ pageOrigin: 'https://other.test', frameOrigin: 'https://other.test', url: '' }),
    'site:other.test',
    'unrecognised books get their own key namespace so data never mixes',
  );
});

test('a subdomain of duel.com matches, a lookalike domain does not', () => {
  assert.equal(adapterFor({ pageOrigin: 'https://sports.duel.com', frameOrigin: '', url: '' }).id, 'betby.duel');
  assert.equal(adapterFor({ pageOrigin: 'https://duel.com.evil.test', frameOrigin: '', url: '' }).id, 'unknown');
  assert.equal(adapterFor({ pageOrigin: 'https://notduel.com', frameOrigin: '', url: '' }).id, 'unknown');
});

test('every classification carries the adapter that produced it', () => {
  const c = classifyCapture(capture(feedLike(9)));
  assert.equal(c.adapterId, 'betby.duel', 'the capture came from duel.com, so the Duel adapter must own the verdict');
});

test('no user-facing string promises a certainty', () => {
  const p = parseCapture(capture(feedLike(9)), NOW);
  const c = classifyCapture(capture(feedLike(9)));
  const text = [...p.warnings, ...c.reasons].join(' ').toLowerCase();
  for (const banned of ['lock', 'guaranteed', 'free money', 'sure thing']) {
    assert.ok(!text.includes(banned), `found forbidden certainty language: ${banned}`);
  }
});

/* --- kinds coverage ----------------------------------------------------- */

test('every kind the classifier can return is a declared CaptureKind', () => {
  const declared: CaptureKind[] = [
    'unknown', 'bets_feed', 'user_bets', 'event_list', 'event_detail', 'market_list',
    'odds_update', 'betslip', 'sport_tree', 'translation', 'config', 'auth', 'telemetry', 'asset',
  ];
  const samples: unknown[] = [feedLike(9), feedLike(1), eventListLike, sportTreeLike, { a: 1 }, {}];
  for (const s of samples) {
    const c = classifyGeneric(input(s));
    assert.ok(declared.includes(c.kind), `classifier returned an undeclared kind: ${c.kind}`);
  }
});
