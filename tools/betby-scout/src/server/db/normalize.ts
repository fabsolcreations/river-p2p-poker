/**
 * Persisting parsed captures into the normalized tables.
 *
 * This is where a `ParsePreview` - a read-only view over one payload - becomes
 * durable history. Three rules govern everything here, and all three exist
 * because the analytics built on top of these tables are worthless if the
 * history underneath them can quietly change:
 *
 * 1. IDEMPOTENT. The bets feed is polled every few seconds and returns the same
 *    50 rows. Writing a bet twice would double every stake in the whale
 *    detector and every sample count in a bettor's record. Every write is keyed
 *    on a deterministic id and uses INSERT OR IGNORE / a guarded UPDATE.
 *
 * 2. FIRST-SEEN WINS on time. BETBY's feed carries no timestamp, so a bet's
 *    `ts` is when WE first observed it and it never moves afterwards. Letting a
 *    re-poll refresh it would make every bet look like it was placed seconds
 *    ago, destroying any hope of ordering bets against line movement.
 *
 * 3. APPEND, NEVER REWRITE. Prices go to odds_snapshots as new rows. A
 *    settlement change appends to feed_bet_status_history as well as updating
 *    the current status, so "what did we believe, and when" survives. A
 *    resettlement that silently overwrote the old status would let a backtest
 *    grade a signal against a result we did not have at the time.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { NormalizedFeedBet, ParsePreview, RawCapture } from '../../shared/types.ts';

export interface NormalizeResult {
  events: number;
  markets: number;
  selections: number;
  oddsSnapshots: number;
  bettors: number;
  bets: number;
  legs: number;
  /** Bets whose settlement status changed since we last saw them. */
  statusChanges: number;
  /** Rows skipped because an identical one already existed. */
  duplicates: number;
}

export function emptyNormalizeResult(): NormalizeResult {
  return {
    events: 0,
    markets: 0,
    selections: 0,
    oddsSnapshots: 0,
    bettors: 0,
    bets: 0,
    legs: 0,
    statusChanges: 0,
    duplicates: 0,
  };
}

function add(into: NormalizeResult, from: NormalizeResult): void {
  into.events += from.events;
  into.markets += from.markets;
  into.selections += from.selections;
  into.oddsSnapshots += from.oddsSnapshots;
  into.bettors += from.bettors;
  into.bets += from.bets;
  into.legs += from.legs;
  into.statusChanges += from.statusChanges;
  into.duplicates += from.duplicates;
}

/** Prepared once per database; re-preparing per row dominates the write cost. */
interface Statements {
  sportsbook: StatementSync;
  event: StatementSync;
  eventTouch: StatementSync;
  market: StatementSync;
  selection: StatementSync;
  odds: StatementSync;
  bettor: StatementSync;
  bettorTouch: StatementSync;
  bet: StatementSync;
  betStatus: StatementSync;
  betCurrent: StatementSync;
  betTouch: StatementSync;
  history: StatementSync;
  leg: StatementSync;
  legUpdate: StatementSync;
}

const cache = new WeakMap<DatabaseSync, Statements>();

function statements(db: DatabaseSync): Statements {
  const existing = cache.get(db);
  if (existing) return existing;

  const s: Statements = {
    sportsbook: db.prepare(
      `INSERT INTO sportsbooks (sportsbook_id, label, platform, adapter_id, origins, first_seen, last_seen)
       VALUES (?, ?, ?, ?, '[]', ?, ?)
       ON CONFLICT(sportsbook_id) DO UPDATE SET last_seen = excluded.last_seen`,
    ),

    // first_seen is preserved by the upsert; only last_seen and fields that can
    // legitimately improve (a name we did not have) are refreshed.
    event: db.prepare(
      `INSERT INTO events (event_key, sportsbook_id, source_event_id, sport, league, home, away, competitors,
                           name, start_time, live, status, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO UPDATE SET
         last_seen   = excluded.last_seen,
         sport       = COALESCE(excluded.sport, events.sport),
         league      = COALESCE(excluded.league, events.league),
         home        = COALESCE(excluded.home, events.home),
         away        = COALESCE(excluded.away, events.away),
         name        = COALESCE(excluded.name, events.name),
         start_time  = COALESCE(excluded.start_time, events.start_time),
         live        = COALESCE(excluded.live, events.live),
         status      = COALESCE(excluded.status, events.status),
         competitors = CASE WHEN excluded.competitors = '[]' THEN events.competitors ELSE excluded.competitors END`,
    ),
    eventTouch: db.prepare('UPDATE events SET last_seen = ? WHERE event_key = ? AND last_seen < ?'),

    market: db.prepare(
      `INSERT INTO markets (market_key, event_key, sportsbook_id, source_market_id, type, name, line, period, status,
                            first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(market_key) DO UPDATE SET
         last_seen = excluded.last_seen,
         type      = COALESCE(excluded.type, markets.type),
         name      = COALESCE(excluded.name, markets.name),
         line      = COALESCE(excluded.line, markets.line),
         period    = COALESCE(excluded.period, markets.period),
         status    = COALESCE(excluded.status, markets.status)`,
    ),

    selection: db.prepare(
      `INSERT INTO selections (selection_key, market_key, event_key, sportsbook_id, source_selection_id, name, side,
                               line, status, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(selection_key) DO UPDATE SET
         last_seen = excluded.last_seen,
         name      = COALESCE(excluded.name, selections.name),
         side      = COALESCE(excluded.side, selections.side),
         line      = COALESCE(excluded.line, selections.line),
         status    = COALESCE(excluded.status, selections.status)`,
    ),

    // Writes a snapshot only when the price CHANGED.
    //
    // "Never discard historical odds" means keeping every change, not every
    // observation. The trees are polled every few seconds; storing a row per
    // poll per selection would add millions of identical rows a day and bury
    // the handful that represent actual movement. The guard compares against
    // the most recent snapshot for this selection, so a price that moves and
    // moves back is still recorded twice, as it should be.
    odds: db.prepare(
      `INSERT INTO odds_snapshots (sportsbook_id, event_key, market_key, selection_key, ts, decimal_odds,
                                   line, status, capture_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM odds_snapshots o
         WHERE o.selection_key = ?
           AND o.decimal_odds = ?
           AND o.ts = (SELECT MAX(ts) FROM odds_snapshots WHERE selection_key = ?)
       )`,
    ),

    bettor: db.prepare(
      `INSERT OR IGNORE INTO bettors (bettor_key, sportsbook_id, label, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    bettorTouch: db.prepare('UPDATE bettors SET last_seen = ? WHERE bettor_key = ? AND last_seen < ?'),

    bet: db.prepare(
      `INSERT OR IGNORE INTO feed_bets (bet_key, sportsbook_id, source_bet_id, ts, bettor_key, stake, currency,
                                        stake_usd, total_odds, potential_win, type, leg_count, live, status,
                                        settled_at, capture_id, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    betCurrent: db.prepare('SELECT status FROM feed_bets WHERE bet_key = ?'),
    betStatus: db.prepare('UPDATE feed_bets SET status = ?, settled_at = ?, last_seen = ? WHERE bet_key = ?'),
    betTouch: db.prepare('UPDATE feed_bets SET last_seen = ? WHERE bet_key = ? AND last_seen < ?'),

    history: db.prepare(
      'INSERT INTO feed_bet_status_history (bet_key, ts, status, capture_id) VALUES (?, ?, ?, ?)',
    ),

    leg: db.prepare(
      `INSERT OR IGNORE INTO feed_bet_legs (bet_key, idx, event_key, source_event_id, sport, league, event_name,
                                            market_key, market_name, selection_key, selection_name, line,
                                            odds_at_bet, current_odds, live, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // A leg captured before the dictionaries arrived has null names. When they
    // land, fill them in - but never overwrite a name with a null.
    legUpdate: db.prepare(
      `UPDATE feed_bet_legs SET
         sport          = COALESCE(?, sport),
         league         = COALESCE(?, league),
         event_name     = COALESCE(?, event_name),
         market_name    = COALESCE(?, market_name),
         selection_name = COALESCE(?, selection_name),
         current_odds   = COALESCE(?, current_odds)
       WHERE bet_key = ? AND idx = ?`,
    ),
  };

  cache.set(db, s);
  return s;
}

function bool(v: boolean | null): number | null {
  return v === null ? null : v ? 1 : 0;
}

/** Settlement states we treat as final for `settled_at`. */
const SETTLED = new Set(['won', 'lost', 'push', 'void', 'cashout']);

/**
 * Writes one parsed capture's entities. Caller supplies the transaction; this
 * function performs no BEGIN/COMMIT of its own so a whole batch can be atomic.
 *
 * `observedAt` is the capture's server timestamp, and it is what a feed bet's
 * `ts` becomes. See rule 2 in the file header - this is the only honest reading
 * when the payload carries no time of its own.
 */
export function writeNormalized(
  db: DatabaseSync,
  preview: ParsePreview,
  capture: RawCapture,
  observedAt: number,
): NormalizeResult {
  const out = emptyNormalizeResult();
  const s = statements(db);

  const sportsbookId =
    preview.bets[0]?.sportsbookId ??
    preview.events[0]?.sportsbookId ??
    preview.oddsSnapshots[0]?.sportsbookId ??
    null;

  if (sportsbookId !== null) {
    s.sportsbook.run(sportsbookId, sportsbookId, 'betby', preview.adapterId, observedAt, observedAt);
  }

  for (const e of preview.events) {
    const res = s.event.run(
      e.key, e.sportsbookId, e.sourceEventId, e.sport, e.league, e.home, e.away,
      JSON.stringify(e.competitors), e.name, e.startTime, bool(e.live), e.status, observedAt, observedAt,
    );
    if (res.changes > 0) out.events += 1;
  }

  for (const m of preview.markets) {
    const res = s.market.run(
      m.key, m.eventKey, m.sportsbookId, m.sourceMarketId, m.type, m.name, m.line, m.period, m.status,
      observedAt, observedAt,
    );
    if (res.changes > 0) out.markets += 1;
  }

  for (const sel of preview.selections) {
    const res = s.selection.run(
      sel.key, sel.marketKey, sel.eventKey, sel.sportsbookId, sel.sourceSelectionId, sel.name, sel.side,
      sel.line, sel.status, observedAt, observedAt,
    );
    if (res.changes > 0) out.selections += 1;
  }

  for (const o of preview.oddsSnapshots) {
    const res = s.odds.run(
      o.sportsbookId, o.eventKey, o.marketKey, o.selectionKey, o.ts, o.decimalOdds, o.line, o.status, o.captureId,
      o.selectionKey, o.decimalOdds, o.selectionKey,
    );
    if (res.changes > 0) out.oddsSnapshots += 1;
    else out.duplicates += 1;
  }

  for (const bet of preview.bets) {
    writeBet(s, bet, capture, observedAt, out);
  }

  return out;
}

function writeBet(
  s: Statements,
  bet: NormalizedFeedBet,
  capture: RawCapture,
  observedAt: number,
  out: NormalizeResult,
): void {
  const bettorRes = s.bettor.run(bet.bettorKey, bet.sportsbookId, bet.bettorLabel, observedAt, observedAt);
  if (bettorRes.changes > 0) out.bettors += 1;
  else s.bettorTouch.run(observedAt, bet.bettorKey, observedAt);

  // A feed with no timestamp of its own is dated by observation. A feed that
  // does carry one keeps it, because it is better evidence than our clock.
  const ts = bet.ts > 0 ? bet.ts : observedAt;
  const settledAt = SETTLED.has(bet.status) ? observedAt : null;

  const inserted = s.bet.run(
    bet.key, bet.sportsbookId, bet.sourceBetId, ts, bet.bettorKey, bet.stake, bet.currency, bet.stakeUsd,
    bet.totalOdds, bet.potentialWin, bet.type, bet.legCount, bool(bet.live), bet.status, settledAt,
    capture.captureId, observedAt, observedAt,
  );

  if (inserted.changes > 0) {
    out.bets += 1;
    // Opening state belongs in the history too, so the record starts at the
    // first thing we believed rather than at the first change.
    s.history.run(bet.key, observedAt, bet.status, capture.captureId);
  } else {
    out.duplicates += 1;
    const row = s.betCurrent.get(bet.key);
    const previous = row ? String(row['status'] ?? 'unknown') : 'unknown';
    // 'unknown' is the absence of information, not a state to transition to.
    if (bet.status !== 'unknown' && bet.status !== previous) {
      s.betStatus.run(bet.status, settledAt, observedAt, bet.key);
      s.history.run(bet.key, observedAt, bet.status, capture.captureId);
      out.statusChanges += 1;
    } else {
      s.betTouch.run(observedAt, bet.key, observedAt);
    }
  }

  for (const leg of bet.legs) {
    const legRes = s.leg.run(
      leg.betKey, leg.idx, leg.eventKey, leg.sourceEventId, leg.sport, leg.league, leg.eventName,
      leg.marketKey, leg.marketName, leg.selectionKey, leg.selectionName, leg.line, leg.oddsAtBet,
      leg.currentOdds, bool(leg.live), leg.status,
    );
    if (legRes.changes > 0) out.legs += 1;
    else {
      // Already stored. Backfill anything we know now and did not know then -
      // typically the names, once the dictionaries have been captured.
      s.legUpdate.run(
        leg.sport, leg.league, leg.eventName, leg.marketName, leg.selectionName, leg.currentOdds,
        leg.betKey, leg.idx,
      );
    }
  }
}

export { add as addNormalizeResults };
