/**
 * Tests for the isomorphic core: odds math, deterministic ids, redaction and
 * shape analysis.
 *
 * These are the parts where a silent error is most dangerous, because a wrong
 * probability does not look wrong - it looks like an edge. Every assertion here
 * is derived from the formula, not from whatever the code happened to print.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  americanToDecimal,
  breakEvenProbability,
  clvPercent,
  clvProbability,
  decimalToAmerican,
  evWarnings,
  expectedValue,
  fairProbabilities,
  fairProbabilitiesShin,
  fairThreeWay,
  fairTwoWay,
  impliedProbability,
  isValidDecimalOdds,
  kellyFraction,
  overround,
  roiStdError,
  samplesForSignificance,
  wilsonInterval,
} from '../src/shared/odds.ts';

import {
  bettorKey,
  eventKey,
  feedBetKey,
  hash64,
  legFingerprint,
  marketKey,
  normalizeLine,
  normalizeName,
  selectionKey,
  timeBucket,
} from '../src/shared/ids.ts';

import { redactBody, redactHeaders, redactJson, redactUrl, skipUrl } from '../src/shared/redact.ts';

import {
  findObjectArrays,
  flattenPaths,
  fractionOf,
  looksLikeDecimalOdds,
  looksLikeEpoch,
  looksLikeMaskedHandle,
  pick,
  shapeFingerprint,
  shapeOf,
  topLevelKeys,
} from '../src/shared/shape.ts';

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} within ${eps} of ${b}`);

/* ---------------------------------------------------------------- odds --- */

test('implied probability and its inverse round-trip', () => {
  close(impliedProbability(2)!, 0.5);
  close(impliedProbability(9.6)!, 1 / 9.6);
  assert.equal(impliedProbability(0.5), null, 'sub-1.0 odds are not a price');
  assert.equal(impliedProbability(Number.NaN), null);
  assert.equal(isValidDecimalOdds(1), false, '1.00 pays nothing and is not a valid price');
  assert.equal(isValidDecimalOdds(50_000), false);
});

test('american conversion matches the standard definition', () => {
  close(americanToDecimal(150)!, 2.5);
  close(americanToDecimal(-200)!, 1.5);
  assert.equal(decimalToAmerican(2.5), 150);
  assert.equal(decimalToAmerican(1.5), -200);
  assert.equal(americanToDecimal(0), null);
});

test('overround is null unless the whole market is present and valid', () => {
  close(overround([1.9, 1.9])!, 2 / 1.9);
  assert.equal(overround([1.9]), null, 'a one-sided market has no meaningful overround');
  assert.equal(overround([1.9, Number.NaN]), null);
  assert.equal(overround([1.9, 0]), null);
});

test('proportional de-vig normalises to 1 and is symmetric on a symmetric market', () => {
  const f = fairTwoWay(1.9, 1.9)!;
  close(f[0], 0.5);
  close(f[1], 0.5);

  const three = fairThreeWay(2.5, 3.4, 3.1)!;
  close(three[0] + three[1] + three[2], 1);
  assert.ok(three[0] > three[2], 'the shortest price must carry the highest fair probability');
});

test('Shin de-vig shifts margin onto the longshot, unlike proportional', () => {
  // 1.20 / 4.50 - a real favourite-longshot pair with ~5.6% overround.
  const proportional = fairProbabilities([1.2, 4.5])!;
  const shin = fairProbabilitiesShin([1.2, 4.5])!;

  close(shin[0]! + shin[1]!, 1);

  // The whole reason Shin exists: books load more margin onto longshots, so the
  // longshot's fair probability is LOWER than proportional de-vig claims. If
  // this assertion ever flips, every longshot "edge" the tool reports is
  // manufactured by the de-vig step itself.
  assert.ok(
    shin[1]! < proportional[1]!,
    `Shin longshot ${shin[1]} should be below proportional ${proportional[1]}`,
  );
  assert.ok(shin[0]! > proportional[0]!);

  // Symmetric market: both methods must agree exactly at 50/50.
  const symShin = fairProbabilitiesShin([1.9, 1.9])!;
  close(symShin[0]!, 0.5, 1e-6);
  close(symShin[1]!, 0.5, 1e-6);
});

test('Shin refuses rather than guessing when there is no root in the bracket', () => {
  assert.equal(fairProbabilitiesShin([1.9]), null);
  assert.equal(fairProbabilitiesShin([1.9, Number.NaN]), null);
});

test('expected value matches the brief worked example', () => {
  // Brief: fair probability 13%, price 9.60 -> +24.8%
  const ev = expectedValue(0.13, 9.6)!;
  close(ev, 0.248, 1e-12);
  assert.equal(expectedValue(0, 9.6), null);
  assert.equal(expectedValue(1.5, 9.6), null);
  close(breakEvenProbability(9.6)!, 1 / 9.6);
});

test('CLV is positive exactly when the bettor beat the close', () => {
  // Bet 11.00, closed 9.00 -> got a better price -> positive.
  assert.ok(clvProbability(11, 9)! > 0);
  assert.ok(clvPercent(11, 9)! > 0);
  close(clvPercent(11, 9)!, 11 / 9 - 1);

  // Bet 9.00, closed 11.00 -> worse than close -> negative.
  assert.ok(clvProbability(9, 11)! < 0);
  assert.ok(clvPercent(9, 11)! < 0);

  // No move -> exactly zero, not epsilon.
  close(clvProbability(3.5, 3.5)!, 0);
});

test('Wilson interval stops three lucky wins looking like a 100% bettor', () => {
  const w = wilsonInterval(3, 3)!;
  close(w.lo, 0.4385, 1e-3);
  close(w.hi, 1, 1e-9);
  assert.ok(w.lo < 0.5, 'a 3-for-3 record must not exclude a coin-flip bettor');

  const big = wilsonInterval(540, 1000)!;
  assert.ok(big.hi - big.lo < 0.07, 'a 1000-bet sample should be tight');
  assert.equal(wilsonInterval(4, 3), null);
  assert.equal(wilsonInterval(1, 0), null);
});

test('roi standard error and required sample size are sane', () => {
  assert.equal(roiStdError([1]), null);
  assert.ok(roiStdError([-1, -1, 8.6, -1, -1])! > 0);

  // A 5% edge at even money needs on the order of a thousand-plus bets.
  const n = samplesForSignificance(0.05, 2)!;
  assert.ok(n > 1000 && n < 3000, `unexpected sample requirement ${n}`);
  // Longshots are noisier, so they need more.
  assert.ok(samplesForSignificance(0.05, 11)! > n);
  assert.equal(samplesForSignificance(-0.05, 2), null);
});

test('kelly is zero on a non-positive edge and fractional otherwise', () => {
  assert.equal(kellyFraction(0.4, 2), 0);
  close(kellyFraction(0.6, 2, 1)!, 0.2);
  close(kellyFraction(0.6, 2, 0.25)!, 0.05);
});

test('EV warnings fire on the structurally-wrong cases, not just noisy ones', () => {
  const longshot = evWarnings({ decimalOdds: 11, fairSource: 'proportional-devig' });
  assert.ok(longshot.some((w) => w.includes('longshot')));

  const parlay = evWarnings({ decimalOdds: 6, fairSource: 'consensus', legs: 4 });
  assert.ok(parlay.some((w) => w.includes('Correlated')));

  const clean = evWarnings({ decimalOdds: 2, fairSource: 'consensus', legs: 1, sampleSize: 5000 });
  assert.deepEqual(clean, []);
});

/* ----------------------------------------------------------------- ids --- */

test('hash64 is deterministic, wide, and handles non-ASCII', () => {
  assert.equal(hash64('abc'), hash64('abc'));
  assert.notEqual(hash64('abc'), hash64('abd'));
  assert.match(hash64('abc'), /^[0-9a-f]{16}$/);
  // Multi-byte and emoji (surrogate pair) must not throw and must differ.
  assert.notEqual(hash64('Bayern München'), hash64('Bayern Munchen'));
  assert.match(hash64('🐋'), /^[0-9a-f]{16}$/);
});

test('name normalisation collapses the ways books write the same team', () => {
  assert.equal(normalizeName('Real Madrid C.F.'), 'real madrid c f');
  assert.equal(normalizeName('Bayern München'), 'bayern munchen');
  assert.equal(normalizeName(null), '');
});

test('line normalisation is stable across sign-of-zero and trailing zeros', () => {
  assert.equal(normalizeLine(0), normalizeLine(-0));
  assert.equal(normalizeLine(2.5), '2.5');
  assert.equal(normalizeLine(100), '100');
  assert.equal(normalizeLine(-2.5), '-2.5');
  assert.equal(normalizeLine(null), '');
});

test('event keys prefer the book id and are order-invariant on the fallback', () => {
  const a = eventKey({ sportsbookId: 'duel', sourceEventId: '99123' });
  const b = eventKey({ sportsbookId: 'duel', sourceEventId: '99123', sport: 'ignored' });
  assert.equal(a, b, 'a known source id must dominate every other field');

  // Fallback: the same fixture listed home-first or away-first is one event.
  const start = 1_800_000_000_000;
  const x = eventKey({ sportsbookId: 'duel', sport: 'esports', league: 'LCK', competitors: ['KT Rolster', 'Dplus KIA'], startTime: start });
  const y = eventKey({ sportsbookId: 'duel', sport: 'esports', league: 'LCK', competitors: ['Dplus KIA', 'KT Rolster'], startTime: start });
  assert.equal(x, y);

  // A start time drifting by a minute must not fragment the event.
  const z = eventKey({ sportsbookId: 'duel', sport: 'esports', league: 'LCK', competitors: ['KT Rolster', 'Dplus KIA'], startTime: start + 60_000 });
  assert.equal(x, z);

  // Different book, same event: different key. Keys are never shared across books.
  const other = eventKey({ sportsbookId: 'other', sourceEventId: '99123' });
  assert.notEqual(a, other);
});

test('market and selection keys are namespaced and line-sensitive', () => {
  const ev = eventKey({ sportsbookId: 'duel', sourceEventId: 'e1' });
  const m1 = marketKey({ sportsbookId: 'duel', eventKey: ev, type: 'handicap', line: -2.5 });
  const m2 = marketKey({ sportsbookId: 'duel', eventKey: ev, type: 'handicap', line: -1.5 });
  assert.notEqual(m1, m2, 'a different line is a different market');

  const s1 = selectionKey({ sportsbookId: 'duel', eventKey: ev, marketKey: m1, side: 'home', line: -2.5 });
  const s2 = selectionKey({ sportsbookId: 'duel', eventKey: ev, marketKey: m1, side: 'away', line: 2.5 });
  assert.notEqual(s1, s2);
  assert.equal(s1, selectionKey({ sportsbookId: 'duel', eventKey: ev, marketKey: m1, side: 'HOME', line: -2.5 }));
});

test('bettor keys are per-book and case-insensitive on the masked handle', () => {
  assert.equal(bettorKey('duel', '****tu'), bettorKey('duel', '****TU'));
  assert.notEqual(bettorKey('duel', '****tu'), bettorKey('other', '****tu'));
});

test('feed bet keys dedupe a replayed feed but keep two genuine identical bets apart', () => {
  const legs = [{ selectionKey: 'o_1' }, { selectionKey: 'o_2' }];
  const fp = legFingerprint(legs);
  assert.equal(fp, legFingerprint([...legs].reverse()), 'leg order must not change the fingerprint');

  const base = { sportsbookId: 'duel', bettorKey: 'b_1', ts: 1_800_000_000_000, stake: 20, totalOdds: 4.5, legFingerprint: fp };
  assert.equal(feedBetKey(base), feedBetKey(base), 'a replayed feed row must collapse');
  assert.notEqual(feedBetKey(base), feedBetKey({ ...base, ts: 1_800_000_002_000 }), 'two seconds apart is two bets');
  assert.equal(
    feedBetKey({ sportsbookId: 'duel', sourceBetId: 'B7' }),
    feedBetKey({ sportsbookId: 'duel', sourceBetId: 'B7', stake: 999 }),
    'a known bet id must dominate',
  );
});

test('time bucketing rounds to the configured window', () => {
  assert.equal(timeBucket(1_800_000_000_000, 15), timeBucket(1_800_000_060_000, 15));
  assert.equal(timeBucket(null), '');
});

/* ------------------------------------------------------------- redact --- */

test('redaction masks credentials but preserves the data we are here for', () => {
  const payload = {
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    user: { email: 'someone@example.com', maskedName: '****tu' },
    bets: [{ stake: 2000, odds: 11.0, ts: 1_800_000_000_000, legs: [{ line: -2.5, odds: 11 }] }],
  };
  const { value, redacted } = redactJson(payload) as { value: typeof payload; redacted: boolean };
  assert.equal(redacted, true);
  assert.equal(value.accessToken, '[redacted]');
  assert.equal(value.user.email, '[redacted]');

  // The reverse failure mode: over-redaction that destroys the dataset.
  assert.equal(value.bets[0]!.stake, 2000);
  assert.equal(value.bets[0]!.odds, 11.0);
  assert.equal(value.bets[0]!.ts, 1_800_000_000_000);
  assert.equal(value.bets[0]!.legs[0]!.line, -2.5);
  assert.equal(value.user.maskedName, '****tu', 'the masked handle is the identifier we track');
});

test('a bare JWT is masked even under an innocuous key', () => {
  const out = redactJson({ note: 'token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij' });
  assert.equal(out.redacted, true);
  assert.match(JSON.stringify(out.value), /redacted:jwt/);
});

test('redaction preserves JSON structure so shape analysis still works', () => {
  const before = { a: { b: [{ token: 'x'.repeat(50), odds: 2.5 }, { token: 'y'.repeat(50), odds: 3.5 }] } };
  const after = redactJson(before).value;
  assert.equal(shapeOf(before), shapeOf(after), 'a redacted capture must fingerprint identically');
});

test('headers and query strings are redacted by name', () => {
  const h = redactHeaders({ authorization: 'Bearer abc', 'content-type': 'application/json' });
  assert.equal(h.value!['authorization'], '[redacted]');
  assert.equal(h.value!['content-type'], 'application/json');

  const u = redactUrl('https://example.com/x?eventId=123&access_token=secretvalue123');
  assert.match(u.value, /eventId=123/, 'a non-sensitive parameter must survive');
  assert.match(u.value, /access_token=\[redacted\]/);
  assert.equal(redactUrl('https://example.com/x').redacted, false);
});

test('credential endpoints are skipped outright', () => {
  assert.equal(skipUrl('https://example.com/api/login'), true);
  assert.equal(skipUrl('https://example.com/api/kyc/status'), true);
  assert.equal(skipUrl('https://example.com/api/sports/events'), false);
});

test('non-JSON bodies still get pattern masking', () => {
  const out = redactBody('contact me at someone@example.com', 'text/plain');
  assert.equal(out.redacted, true);
  assert.match(out.value!, /redacted:email/);
  assert.equal(redactBody(null).value, null);
});

/* -------------------------------------------------------------- shape --- */

test('shape fingerprints cluster payloads from the same endpoint', () => {
  const a = { data: { items: [{ id: 1, odds: 2.5, user: 'a' }] } };
  const b = { data: { items: [{ id: 999, odds: 11.0, user: 'zzz' }, { id: 2, odds: 1.5, user: 'q' }] } };
  assert.equal(shapeFingerprint(a), shapeFingerprint(b), 'same shape, different values');

  const c = { data: { items: [{ id: 1, odds: 2.5, user: 'a', extra: true }] } };
  assert.notEqual(shapeFingerprint(a), shapeFingerprint(c), 'an added field is schema drift');

  // Key order must not matter.
  assert.equal(shapeOf({ x: 1, y: 'a' }), shapeOf({ y: 'b', x: 2 }));
});

test('flattenPaths collapses array indices so a feed reports one path per field', () => {
  const paths = flattenPaths({ bets: [{ stake: 1 }, { stake: 2 }, { stake: 3 }] }).map((p) => p.path);
  assert.deepEqual(paths, ['bets[].stake']);
});

test('findObjectArrays locates the payload array without knowing the wrapper name', () => {
  const found = findObjectArrays({ result: { payload: { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }, meta: { t: 1 } } });
  assert.equal(found[0]!.path, 'result.payload.rows');
  assert.equal(found[0]!.items.length, 3);
});

test('value heuristics answer could-this-be, not is-this', () => {
  assert.equal(looksLikeDecimalOdds(2.75), true);
  assert.equal(looksLikeDecimalOdds(1), false);
  assert.equal(looksLikeDecimalOdds(5000), false);
  assert.equal(looksLikeEpoch(1_800_000_000_000).unit, 'ms');
  assert.equal(looksLikeEpoch(1_800_000_000).unit, 's');
  assert.equal(looksLikeEpoch(42).is, false);
  assert.equal(looksLikeMaskedHandle('****tu'), true);
  assert.equal(looksLikeMaskedHandle('plainname'), false);
});

test('pick is insensitive to the casing and separators books disagree about', () => {
  assert.equal(pick({ event_id: 7 }, 'eventId'), 7);
  assert.equal(pick({ EventID: 7 }, 'event_id'), 7);
  assert.equal(pick({ koef: 2.5 }, 'odds', 'price', 'koef'), 2.5);
  assert.equal(pick({ a: 1 }, 'missing'), undefined);
});

test('fractionOf resists a single odd row flipping a verdict', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ odds: i === 0 ? null : 2.5 }));
  const f = fractionOf(rows, (r) => looksLikeDecimalOdds(r.odds));
  assert.ok(f > 0.9 && f < 1);
  assert.equal(fractionOf([], () => true), 0);
});

test('topLevelKeys describes an array payload by its element keys', () => {
  assert.deepEqual(topLevelKeys([{ a: 1, b: 2 }]), ['[].a', '[].b']);
  assert.deepEqual(topLevelKeys({ a: 1 }), ['a']);
});
