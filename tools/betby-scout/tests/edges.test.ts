/**
 * End-to-end edge pipeline, through the real route.
 *
 * Duel prices -> sport key -> fixture match -> consensus -> edge, with a
 * stubbed price source so the whole path runs without spending quota against a
 * live API. This is the only test that proves the pieces actually connect; the
 * unit tests each prove one piece in isolation, and this project has already
 * been bitten twice by two correct halves that disagreed with each other.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/server/index.ts';
import { loadConfig } from '../src/server/config.ts';
import { setOddsSource } from '../src/server/routes/edges.ts';
import type { ExternalOddsSource, FetchResult } from '../src/odds-sources/types.ts';

const NOW = Date.now();
const KICKOFF = NOW + 6 * 60 * 60 * 1000;

let dir: string;
let app: FastifyInstance;

/**
 * A source that quotes three independent books on one LaLiga fixture.
 * Books agree closely; Duel will be given a much better price on the home side,
 * which must surface as a positive edge.
 */
const stub: ExternalOddsSource = {
  id: 'stub',
  label: 'Stub source',
  isConfigured: () => true,
  status: () => ({
    id: 'stub',
    label: 'Stub source',
    configured: true,
    setup: null,
    quota: { remaining: 400, used: 100, lastCost: 1 },
    lastFetchAt: NOW,
    lastError: null,
  }),
  listSports: async () => [{ key: 'soccer_spain_la_liga', title: 'La Liga', group: 'Soccer', active: true }],
  fetchOdds: async (): Promise<FetchResult> => ({
    fetchedAt: NOW,
    cached: false,
    quota: { remaining: 400, used: 100, lastCost: 1 },
    events: [
      {
        id: 'ext-1',
        sourceId: 'stub',
        sportKey: 'soccer_spain_la_liga',
        sportTitle: 'La Liga',
        commenceTime: KICKOFF,
        homeTeam: 'Real Betis',
        awayTeam: 'Real Madrid',
        books: ['pinnacle', 'betfair', 'williamhill'].map((key, i) => ({
          key,
          title: key,
          lastUpdate: NOW - i * 60_000,
          markets: [
            {
              key: 'h2h',
              // Fair probabilities land near 0.30 / 0.70 after de-vig.
              outcomes: [
                { name: 'Real Betis', decimalOdds: 3.2 + i * 0.05, point: null },
                { name: 'Real Madrid', decimalOdds: 1.42 - i * 0.01, point: null },
              ],
            },
          ],
        })),
      },
    ],
  }),
};

/** Inserts one complete Duel market on the same fixture, priced generously. */
function seedDuelMarket(app: FastifyInstance): void {
  const db = (app as unknown as { scout: { db: { handle: import('node:sqlite').DatabaseSync } } }).scout.db.handle;
  const t = NOW;
  db.exec(`
    INSERT OR REPLACE INTO sportsbooks (sportsbook_id, label, platform, adapter_id, origins, first_seen, last_seen)
      VALUES ('duel','duel','betby','betby.duel','[]',${t},${t});
    INSERT OR REPLACE INTO events (event_key, sportsbook_id, source_event_id, sport, league, home, away,
                                   competitors, name, start_time, live, status, first_seen, last_seen)
      VALUES ('e_edge','duel','1','Soccer','LaLiga','Real Betis Seville','Real Madrid',
              '["Real Betis Seville","Real Madrid"]','Real Betis Seville vs Real Madrid',${KICKOFF},0,NULL,${t},${t});
    INSERT OR REPLACE INTO markets (market_key, event_key, sportsbook_id, source_market_id, type, name, line,
                                    period, status, first_seen, last_seen)
      VALUES ('m_edge','e_edge','duel','1','Result','1x2',NULL,NULL,NULL,${t},${t});
    INSERT OR REPLACE INTO selections (selection_key, market_key, event_key, sportsbook_id, source_selection_id,
                                       name, side, line, status, first_seen, last_seen)
      VALUES ('s_home','m_edge','e_edge','duel','1','Real Betis Seville',NULL,NULL,NULL,${t},${t}),
             ('s_away','m_edge','e_edge','duel','3','Real Madrid',NULL,NULL,NULL,${t},${t});
    INSERT INTO odds_snapshots (sportsbook_id, event_key, market_key, selection_key, ts, decimal_odds, line, status, capture_id)
      VALUES ('duel','e_edge','m_edge','s_home',${t},4.20,NULL,NULL,NULL),
             ('duel','e_edge','m_edge','s_away',${t},1.38,NULL,NULL,NULL);
  `);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scout-edges-'));
  app = await buildServer({
    config: loadConfig({ SCOUT_DB: join(dir, 'edges.db'), SCOUT_LOG_LEVEL: 'silent' }),
    logger: false,
  });
  setOddsSource(stub);
  seedDuelMarket(app);
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a genuinely better price than the market surfaces as a positive edge', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/edges' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    configured: boolean;
    edges: Array<{
      selection: string;
      duelOdds: number;
      consensusFairOdds: number;
      ev: number;
      books: number;
      matchConfidence: number;
      matchReasons: string[];
      warnings: string[];
      event: string;
    }>;
    caveats: string[];
    skipped: Record<string, number>;
  };

  assert.equal(body.configured, true);
  assert.ok(body.edges.length > 0, `expected at least one edge, skipped: ${JSON.stringify(body.skipped)}`);

  const home = body.edges.find((e) => e.selection === 'Real Betis Seville');
  assert.ok(home, 'the home selection should have been compared');

  // Duel offers 4.20 where three books imply roughly 3.3 fair. That is a real,
  // claimable edge - the first this codebase can produce.
  assert.ok(home.ev > 0, `expected positive EV, got ${home.ev}`);
  assert.ok(home.duelOdds > home.consensusFairOdds, 'a positive edge means beating the fair price');
  assert.equal(home.books, 3, 'all three independent books contributed');
  assert.ok(home.matchConfidence >= 0.7);
  assert.ok(home.matchReasons.some((r) => /Real Betis/.test(r)), 'the match reasoning must be auditable');

  // The away side is priced short by Duel, so it must be negative.
  const away = body.edges.find((e) => e.selection === 'Real Madrid');
  assert.ok(away && away.ev < 0, 'the other side of a +EV market is -EV');

  // Every edge ships with its caveats.
  assert.ok(body.caveats.some((c) => /estimate with a confidence interval/.test(c)));
  assert.ok(body.caveats.some((c) => /Nothing here places a bet/.test(c)));
});

test('an unmapped league is skipped rather than guessed at', async () => {
  const db = (app as unknown as { scout: { db: { handle: import('node:sqlite').DatabaseSync } } }).scout.db.handle;
  const t = NOW;
  // A Valorant fixture. There is no mapped external key, and guessing one would
  // compare it against an unrelated sport.
  db.exec(`
    INSERT OR REPLACE INTO events (event_key, sportsbook_id, source_event_id, sport, league, home, away,
                                   competitors, name, start_time, live, status, first_seen, last_seen)
      VALUES ('e_val','duel','2','Valorant','VCT Americas','G2 Esports','LOUD',
              '["G2 Esports","LOUD"]','G2 Esports vs LOUD',${KICKOFF},0,NULL,${t},${t});
    INSERT OR REPLACE INTO markets (market_key, event_key, sportsbook_id, source_market_id, type, name, line,
                                    period, status, first_seen, last_seen)
      VALUES ('m_val','e_val','duel','186','Result','Winner',NULL,NULL,NULL,${t},${t});
    INSERT OR REPLACE INTO selections (selection_key, market_key, event_key, sportsbook_id, source_selection_id,
                                       name, side, line, status, first_seen, last_seen)
      VALUES ('s_g2','m_val','e_val','duel','4','G2 Esports',NULL,NULL,NULL,${t},${t}),
             ('s_loud','m_val','e_val','duel','5','LOUD',NULL,NULL,NULL,${t},${t});
    INSERT INTO odds_snapshots (sportsbook_id, event_key, market_key, selection_key, ts, decimal_odds, line, status, capture_id)
      VALUES ('duel','e_val','m_val','s_g2',${t},2.10,NULL,NULL,NULL),
             ('duel','e_val','m_val','s_loud',${t},1.75,NULL,NULL,NULL);
  `);

  const res = await app.inject({ method: 'GET', url: '/api/edges' });
  const body = res.json() as { skipped: { unmappedLeague: number }; edges: Array<{ event: string }> };
  assert.ok(body.skipped.unmappedLeague >= 1, 'the Valorant market must be counted as unmapped');
  assert.ok(!body.edges.some((e) => /G2/.test(e.event)), 'and must never appear as an edge');
});

test('the status endpoint reports quota so the free tier can be managed', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/edges/status' });
  const body = res.json() as { sources: Array<{ configured: boolean; quota: { remaining: number | null } }> };
  assert.equal(body.sources[0]?.configured, true);
  assert.equal(body.sources[0]?.quota.remaining, 400);
});
