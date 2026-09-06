/**
 * Bettor routes.
 *
 * The endpoint the whole brief is pointing at - "are these people any good?" -
 * and the one where the answer is most often "we cannot tell yet, here is
 * exactly what is missing".
 *
 * Duel's feed has no settlement field, so wins, ROI and profit are not
 * computable from it at all. Closing line value is, because it needs only a
 * price at bet time and a price at kickoff, and both are recorded. So a bettor
 * is scored on the price they took, never on results they were never given.
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

import {
  buildProfile,
  computeClvForBettor,
  computeSharpness,
  isScored,
  MIN_CLV_LEGS_FOR_SCORE,
  type BettorBetInput,
  type BettorInput,
} from '../../analysis/bettors.ts';
import type { ServerContext } from '../index.ts';

/** Bettors scanned per request. Bounded so one call cannot walk the whole table. */
const MAX_BETTORS = 200;
/** Bets pulled per bettor. */
const MAX_BETS_PER_BETTOR = 500;

interface LegRow {
  bet_key: string;
  odds_at_bet: number | null;
  closing_odds: number | null;
  sport: string | null;
  league: string | null;
  event_key: string | null;
  start_time: number | null;
}

/**
 * Loads bettors with their bets and legs, resolving each leg's closing price.
 *
 * The closing price is the last snapshot at or before kickoff. It is computed
 * here rather than read from feed_bet_legs.closing_odds because that column is
 * only filled once an event has closed AND a job has run; deriving it from the
 * snapshots we already hold means CLV appears as soon as the data supports it.
 */
function loadBettors(db: DatabaseSync, limit: number, minBets: number): BettorInput[] {
  const bettorRows = db
    .prepare(
      `SELECT b.bettor_key, t.label, COUNT(*) AS n
         FROM feed_bets b
         LEFT JOIN bettors t ON t.bettor_key = b.bettor_key
        GROUP BY b.bettor_key
       HAVING n >= ?
        ORDER BY n DESC
        LIMIT ?`,
    )
    .all(minBets, limit) as Array<{ bettor_key: string; label: string | null; n: number }>;

  const betStmt = db.prepare(
    `SELECT bet_key, ts, stake, currency, total_odds, type, leg_count
       FROM feed_bets WHERE bettor_key = ? ORDER BY ts DESC LIMIT ?`,
  );

  // The closing price per leg: the newest snapshot at or before the event's
  // start. A snapshot after kickoff is an in-play price and must never be
  // mistaken for a close.
  const legStmt = db.prepare(
    `SELECT l.bet_key, l.odds_at_bet, l.sport, l.league, l.event_key,
            e.start_time,
            (SELECT o.decimal_odds
               FROM odds_snapshots o
              WHERE o.selection_key = l.selection_key
                AND e.start_time IS NOT NULL
                AND o.ts <= e.start_time
              ORDER BY o.ts DESC
              LIMIT 1) AS closing_odds
       FROM feed_bet_legs l
       LEFT JOIN events e ON e.event_key = l.event_key
      WHERE l.bet_key = ?
      ORDER BY l.idx ASC`,
  );

  const out: BettorInput[] = [];
  for (const row of bettorRows) {
    const bets = betStmt.all(row.bettor_key, MAX_BETS_PER_BETTOR) as Array<{
      bet_key: string;
      ts: number;
      stake: number | null;
      currency: string | null;
      total_odds: number | null;
      type: string;
      leg_count: number;
    }>;

    const modelled: BettorBetInput[] = bets.map((b) => {
      const legs = legStmt.all(b.bet_key) as unknown as LegRow[];
      return {
        betKey: b.bet_key,
        ts: b.ts,
        stake: b.stake,
        currency: b.currency,
        totalOdds: b.total_odds,
        type: b.type,
        legCount: b.leg_count,
        legs: legs.map((l) => ({
          betKey: l.bet_key,
          oddsAtBet: l.odds_at_bet,
          closingOdds: l.closing_odds,
          sport: l.sport,
          league: l.league,
        })),
      };
    });

    out.push({ bettorKey: row.bettor_key, label: row.label, bets: modelled });
  }
  return out;
}

export function registerBettorRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/bettors', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const asInt = (key: string, fallback: number, min: number, max: number): number => {
      const raw = query[key];
      const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
    };

    const limit = asInt('limit', 100, 1, MAX_BETTORS);
    const minBets = asInt('minBets', 1, 1, 10_000);

    const inputs = loadBettors(ctx.db.handle, limit, minBets);

    const rows = inputs.map((input) => {
      const profile = buildProfile(input);
      const clv = computeClvForBettor(input);
      const sharpness = computeSharpness(profile, clv);
      return {
        profile,
        clv,
        sharpness: isScored(sharpness)
          ? { score: sharpness.score, confidence: sharpness.confidence, components: sharpness.components, warnings: sharpness.warnings }
          : { score: null, blockers: sharpness.blockers },
      };
    });

    // Scored bettors first, then by how much of a record we have. An unscored
    // bettor is not "worse" - it is unmeasured, and the ordering should not
    // imply otherwise.
    rows.sort((a, b) => {
      const as = a.sharpness.score;
      const bs = b.sharpness.score;
      if (as !== null && bs !== null) return bs - as;
      if (as !== null) return -1;
      if (bs !== null) return 1;
      return b.profile.bets - a.profile.bets;
    });

    const scored = rows.filter((r) => r.sharpness.score !== null).length;

    await reply.send({
      bettors: rows,
      scored,
      unscored: rows.length - scored,
      thresholds: { minClvLegsForScore: MIN_CLV_LEGS_FOR_SCORE },
      // The standing caveat. It belongs in the payload, not only in the UI, so
      // any client of this endpoint receives it.
      limits: [
        "Duel's bets feed carries no settlement field, so wins, losses, ROI and profit are not computable " +
          'from it. Nothing here is a results record.',
        'Scores are built on closing line value: the price a bettor took against the price the market closed ' +
          'at. That measures price-taking, which is evidence about information, not proof of profit.',
        `A bettor with fewer than ${MIN_CLV_LEGS_FOR_SCORE} measurable legs gets no score at all, rather than a ` +
          'small one derived from a thin record.',
      ],
      explanation:
        rows.length === 0
          ? 'No bettors stored yet. Capture a bets feed and they appear here; scores follow once their events ' +
            'have kicked off and Scout has recorded prices up to the close.'
          : scored === 0
            ? `${rows.length} bettors tracked, none scored yet. A score needs ${MIN_CLV_LEGS_FOR_SCORE} legs with ` +
              'both a bet price and a closing price, and a closing price only exists once an event has started ' +
              'while Scout was running.'
            : null,
    });
  });
}
