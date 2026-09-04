/**
 * Normalized persistence, against the real captured payloads.
 *
 * The properties tested here are the ones that make the analytics on top of
 * these tables trustworthy: a re-poll must not double anything, a price is
 * recorded only when it moves, history is appended rather than rewritten, and
 * two different lines on the same market must never share a key.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, type ScoutDb } from '../src/server/db/db.ts';
import { parseCapture } from '../src/adapters/registry.ts';
import {
  emptyReference,
  mergeReference,
  parseEventTree,
  parseMarketDescriptions,
} from '../src/adapters/betby/dictionary.ts';
import { betbyMarketSourceId } from '../src/adapters/betby/generic-betby.ts';
import type { RawCapture } from '../src/shared/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(HERE, 'fixtures', name), 'utf8');
const FEED = read('duel-bets-feed.json');
const TREE = read('duel-event-tree.json');
const MARKETS = read('duel-markets-subset.json');

const T0 = 1_788_600_000_000;

let dir: string;
let db: ScoutDb;

const refs = (() => {
  const r = emptyReference();
  const m = parseMarketDescriptions(JSON.parse(MARKETS));
  if (m) mergeReference(r, { markets: m });
  const t = parseEventTree(JSON.parse(TREE));
  if (t) mergeReference(r, t);
  return r;
})();

function capture(id: string, seq: number, path: string, body: string, tsServer: number): RawCapture {
  return {
    captureId: id,
    sessionId: 's_norm',
    seq,
    tsClient: tsServer,
    tsServer,
    transport: 'fetch',
    direction: 'inbound',
    frameUrl: 'https://duel.com/sports',
    frameOrigin: 'https://duel.com',
    isTopFrame: true,
    pageOrigin: 'https://duel.com',
    method: 'GET',
    url: `https://sports-proxy.duel.com${path}`,
    urlHost: 'sports-proxy.duel.com',
    urlPath: path,
    status: 200,
    contentType: 'application/json',
    body,
    bodyEncoding: 'utf8',
    bodyBytes: body.length,
    truncated: false,
    redacted: false,
    classification: { kind: 'unknown', confidence: 0, adapterId: 't', reasons: [], shapeFingerprint: '' },
  };
}

function ingest(id: string, seq: number, path: string, body: string, at: number) {
  const cap = capture(id, seq, path, body, at);
  const preview = parseCapture(cap, at, refs);
  return db.writeNormalized([{ preview, capture: cap, observedAt: at }]);
}

const FEED_PATH = '/api/v1/promo/bets_feed/brand/2482975601191952386';
const TREE_PATH = '/api/v4/prematch/brand/2482975601191952386/en/1';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-norm-'));
  db = openDb(join(dir, 'norm.db'));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a first poll stores bets, bettors, legs and prices', () => {
  const tree = ingest('c_tree_1', 1, TREE_PATH, TREE, T0);
  assert.ok(tree.events > 0, 'the event tree yields events');
  assert.ok(tree.oddsSnapshots > 0, 'and a price for every outcome');

  const feed = ingest('c_feed_1', 2, FEED_PATH, FEED, T0);
  assert.equal(feed.bets, 50);
  assert.equal(feed.bettors, 35, 'one row per distinct masked handle');
  assert.ok(feed.legs > 50, 'combos contribute more legs than bets');

  const counts = db.normalizedCounts();
  assert.equal(counts['feed_bets'], 50);
  assert.equal(
    counts['selections'],
    counts['odds_snapshots'],
    'exactly one price per selection after a single poll',
  );
});

test('re-polling identical data writes nothing at all', () => {
  const before = db.normalizedCounts();
  ingest('c_tree_2', 3, TREE_PATH, TREE, T0 + 30_000);
  ingest('c_feed_2', 4, FEED_PATH, FEED, T0 + 30_000);
  const after = db.normalizedCounts();

  // This is the property everything else depends on. The feed is polled every
  // few seconds and returns the same rows; without it, every stake and every
  // sample count inflates without bound.
  assert.deepEqual(after, before);
});

test('a bet keeps the timestamp of when we FIRST saw it', () => {
  const page = db.listFeedBets({ limit: 500 });
  assert.equal(page.total, 50);
  for (const bet of page.bets) {
    assert.equal(bet.ts, T0, 'a re-poll must not make an old bet look new');
    assert.ok(bet.lastSeen >= bet.firstSeen);
  }
});

test('a price is recorded only when it moves', () => {
  const before = db.normalizedCounts()['odds_snapshots'] ?? 0;

  // Same tree, one price nudged.
  const tree = JSON.parse(TREE) as { events: Record<string, { markets?: Record<string, Record<string, Record<string, { k: string }>>> }> };
  let touched = false;
  for (const event of Object.values(tree.events)) {
    for (const bySpec of Object.values(event.markets ?? {})) {
      for (const byOutcome of Object.values(bySpec)) {
        for (const outcome of Object.values(byOutcome)) {
          if (!touched && typeof outcome.k === 'string') {
            outcome.k = String(Number(outcome.k) + 0.5);
            touched = true;
          }
        }
      }
    }
  }
  assert.ok(touched, 'the fixture must contain at least one price to move');

  ingest('c_tree_3', 5, TREE_PATH, JSON.stringify(tree), T0 + 60_000);
  const after = db.normalizedCounts()['odds_snapshots'] ?? 0;
  assert.equal(after, before + 1, 'exactly one new snapshot: the one that changed');
});

test('a settlement change appends to history instead of overwriting it', () => {
  const feed = JSON.parse(FEED) as Array<Record<string, unknown>>;
  const target = feed[0] as Record<string, unknown>;
  target['status'] = 'won';

  const result = ingest('c_feed_3', 6, FEED_PATH, JSON.stringify(feed), T0 + 90_000);
  assert.equal(result.statusChanges, 1, 'one bet changed state');

  const betKey = db.listFeedBets({ limit: 500 }).bets.find((b) => b.sourceBetId === String(target['id']))?.betKey;
  assert.ok(betKey, 'the settled bet is findable by its source id');

  const history = db.handle
    .prepare('SELECT status, ts FROM feed_bet_status_history WHERE bet_key = ? ORDER BY ts ASC')
    .all(betKey) as Array<{ status: string; ts: number }>;

  // The point: what we believed first is still on the record.
  assert.ok(history.length >= 2, `expected an opening state and a change, got ${history.length}`);
  assert.equal(history[history.length - 1]?.status, 'won');
  assert.ok(history.some((h) => h.status !== 'won'), 'the earlier belief survives the change');
});

test('two lines on the same market never share a key', () => {
  // The bug this guards: makeMarketKey trusts a source id over the line, so
  // without a composite id "Total 2.5" and "Total 3.5" collapse into one market
  // and one selection ends up holding several contradictory prices at once.
  assert.equal(betbyMarketSourceId('18', 'total=2.5'), '18|total=2.5');
  assert.equal(betbyMarketSourceId('18', 'total=3.5'), '18|total=3.5');
  assert.notEqual(betbyMarketSourceId('18', 'total=2.5'), betbyMarketSourceId('18', 'total=3.5'));
  assert.equal(betbyMarketSourceId('186', ''), '186', 'a lineless market keeps its plain id');
  assert.equal(betbyMarketSourceId(null, 'total=1'), null);

  const dupes = db.handle
    .prepare(
      `SELECT selection_key, COUNT(DISTINCT decimal_odds) AS prices
       FROM odds_snapshots GROUP BY selection_key HAVING prices > 1 AND COUNT(DISTINCT ts) = 1`,
    )
    .all();
  assert.equal(dupes.length, 0, 'no selection may hold two different prices at the same instant');
});

test('legs are backfilled with names once the dictionaries arrive', () => {
  // A separate database that sees the feed BEFORE any dictionary - the ordering
  // a real session hits when the feed loads first.
  const coldDir = mkdtempSync(join(tmpdir(), 'scout-cold-'));
  const cold = openDb(join(coldDir, 'cold.db'));
  try {
    const bare = emptyReference();
    const cap1 = capture('c_cold_1', 1, FEED_PATH, FEED, T0);
    cold.writeNormalized([{ preview: parseCapture(cap1, T0, bare), capture: cap1, observedAt: T0 }]);

    const unnamedBefore = cold.handle
      .prepare('SELECT COUNT(*) AS n FROM feed_bet_legs WHERE event_name IS NULL')
      .get() as { n: number };
    assert.ok(unnamedBefore.n > 0, 'with no dictionary the legs start unnamed');

    // Dictionaries arrive; the same feed is re-polled.
    const cap2 = capture('c_cold_2', 2, FEED_PATH, FEED, T0 + 30_000);
    cold.writeNormalized([{ preview: parseCapture(cap2, T0 + 30_000, refs), capture: cap2, observedAt: T0 + 30_000 }]);

    const unnamedAfter = cold.handle
      .prepare('SELECT COUNT(*) AS n FROM feed_bet_legs WHERE event_name IS NULL')
      .get() as { n: number };
    assert.ok(unnamedAfter.n < unnamedBefore.n, `names should be filled in (${unnamedBefore.n} -> ${unnamedAfter.n})`);

    // ...and no bet was duplicated in the process.
    assert.equal(cold.normalizedCounts()['feed_bets'], 50);
  } finally {
    cold.close();
    rmSync(coldDir, { recursive: true, force: true });
  }
});

test('filters and stake distribution read back what was stored', () => {
  const combos = db.listFeedBets({ type: 'combo', limit: 500 });
  assert.ok(combos.total > 0);
  assert.ok(combos.bets.every((b) => b.type === 'combo'));

  const rich = db.listFeedBets({ minStake: 100, limit: 500 });
  assert.ok(rich.bets.every((b) => (b.stake ?? 0) >= 100));

  const byText = db.listFeedBets({ q: 'Real Madrid', limit: 500 });
  assert.ok(
    byText.bets.every((b) => b.legs.some((l) => `${l.eventName} ${l.selectionName} ${l.league}`.includes('Real Madrid'))),
    'a text filter must only return bets that actually mention it',
  );

  const dist = db.stakeDistribution('duel', 0);
  assert.ok(dist, 'the capture contains USD stakes');
  assert.ok(dist.samples > 0);
  assert.ok(dist.p50 <= dist.p90 && dist.p90 <= dist.p99 && dist.p99 <= dist.max, 'percentiles must be ordered');
  assert.equal(dist.currency, 'USD', 'mixing currencies without an FX rate would be meaningless');
});

test('captures are marked parsed so the backfill does not redo them', () => {
  assert.equal(db.unparsedCaptures(10).length, 0, 'everything written has been marked');
});
