/**
 * Read-only queries that feed the analysis layer.
 *
 * These are plain functions over a `DatabaseSync` rather than methods on
 * `ScoutDb`, for two reasons. The first is size: `ScoutDb` is already the
 * biggest file in the server and the ingest path is the last place that should
 * grow an analytics dependency. The second is direction of dependency - the
 * analysis layer may read the database, but nothing here may ever write, and a
 * function that never receives the write API cannot accidentally use it.
 *
 * Three rules carried over from db.ts, because they matter more here not less:
 *
 *   1. Every value is a bound parameter. Sort keys are identifiers and cannot be
 *      bound, so they are looked up in an allowlist and the *stored constant*
 *      reaches the SQL string. `IN (...)` placeholders are generated from a
 *      count, never from caller-supplied text.
 *
 *   2. Markets are fetched whole. A market is selected first, then all of its
 *      priced selections are read. Applying a row limit to selections directly
 *      would slice a market in half, and half a market has a meaningless
 *      overround - see the header of ../../analysis/fair.ts.
 *
 *   3. Nothing here computes a probability by hand. The margin path routes
 *      through `assembleMarkets` and `devigMarket` so that the completeness and
 *      plausibility guards in fair.ts apply to every number that leaves this
 *      file.
 *
 * The coercion helpers at the bottom are deliberately a local copy of the ones
 * in db.ts rather than an import: keeping this module independent of that class
 * is the whole point, and four six-line functions are a cheaper price than the
 * coupling.
 */

import type { DatabaseSync } from 'node:sqlite';

import { assembleMarkets, devigMarket, type RawSelectionRow } from '../../analysis/fair.ts';
import type { DevigMethod, PriceSeries } from '../../analysis/types.ts';

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/**
 * SQLite's default host-parameter ceiling is 999. Staying well under it means a
 * long `IN (...)` list is chunked rather than failing at the driver.
 */
const MAX_BOUND_PARAMS = 400;

/** Hard ceilings so a caller can never ask the database for everything. */
const LIMITS = {
  markets: 2000,
  selections: 20_000,
  seriesPoints: 5000,
  movingSelections: 5000,
  clvLegs: 5000,
} as const;

/**
 * How far apart the newest prices in one market may be before we refuse to read
 * an overround from them.
 *
 * This is not fussiness. Overround is a statement about the book's margin *at an
 * instant*. Summing a price recorded now with one recorded two hours ago
 * measures neither moment, and the error has no fixed sign - it silently
 * inflates or deflates the margin depending on which way the market moved.
 */
export const DEFAULT_MAX_MARKET_PRICE_SPREAD_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

/**
 * A priced selection plus the event context needed to group margins.
 *
 * Extends `RawSelectionRow` rather than replacing it, so the result is passed
 * straight to `assembleMarkets` without a mapping step that could drop a field.
 */
export interface PricedSelection extends RawSelectionRow {
  sport: string | null;
  league: string | null;
  eventName: string | null;
  /** Kickoff, epoch ms, or null when the book never told us. */
  startTime: number | null;
}

export type MarketOrder = 'recent' | 'outcomes';

export interface PricedSelectionOptions {
  sportsbookId?: string;
  sport?: string;
  marketType?: string;
  eventKey?: string;
  marketKey?: string;
  /**
   * Ignore markets whose newest price is older than this epoch ms. Applied when
   * *choosing* markets, not when reading their selections: a market picked
   * because one leg is fresh is returned complete, so that a stale sibling shows
   * up as a wide price spread with a reason rather than as a missing outcome.
   */
  sinceMs?: number;
  /** Maximum markets to read. Selections are then read whole for each. */
  maxMarkets?: number;
  /** Fixed allowlist; anything else falls back to 'recent'. */
  order?: string;
}

export interface SelectionLabel {
  selectionKey: string;
  marketKey: string;
  eventKey: string;
  selectionName: string | null;
  marketName: string | null;
  marketType: string | null;
  eventName: string | null;
  sport: string | null;
  league: string | null;
  startTime: number | null;
}

export interface ClvCandidateLeg {
  betKey: string;
  idx: number;
  selectionKey: string;
  eventKey: string | null;
  oddsAtBet: number;
  betTs: number;
  bettorKey: string;
  betType: string;
  betStatus: string;
  legStatus: string;
  sport: string | null;
  eventName: string | null;
  marketName: string | null;
  selectionName: string | null;
}

export interface ClvCandidateOptions {
  sportsbookId?: string;
  /** Only bets placed at or after this epoch ms. */
  sinceMs?: number;
  limit?: number;
}

/* ------------------------------------------------------------------ *
 * Latest price per selection
 * ------------------------------------------------------------------ */

/**
 * The newest `odds_snapshots` row for a selection.
 *
 * Ties on `ts` are broken by `id` because the unique index allows two rows with
 * the same timestamp and different prices; taking the higher rowid takes the one
 * written later, which is the one that superseded the other.
 *
 * INNER vs LEFT is the difference between a correct market and a plausible one.
 * Choosing which markets to look at needs a market to have a recent price, so
 * that pass joins INNER. Reading a chosen market's outcomes must be LEFT, so
 * that a selection we know about but have never had a price for arrives with a
 * null price and `assembleMarkets` rejects the market. Dropping it instead would
 * hand back a three-way market with two outcomes and no sign anything is
 * missing - the overround would look normal and every fair probability derived
 * from it would be wrong.
 */
function latestSnapshotJoin(kind: 'JOIN' | 'LEFT JOIN'): string {
  return `
  ${kind} odds_snapshots o ON o.id = (
    SELECT o2.id
      FROM odds_snapshots o2
     WHERE o2.selection_key = s.selection_key
     ORDER BY o2.ts DESC, o2.id DESC
     LIMIT 1
  )`;
}

const MARKET_ORDER_COLUMNS: Record<string, string> = {
  recent: 'last_ts',
  outcomes: 'priced_outcomes',
};

function marketOrderColumn(order: string | undefined): string {
  return MARKET_ORDER_COLUMNS[order ?? ''] ?? 'last_ts';
}

interface Filter {
  clause: string;
  params: Array<string | number>;
}

function buildFilter(opts: PricedSelectionOptions): Filter {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (opts.sportsbookId) {
    where.push('s.sportsbook_id = ?');
    params.push(opts.sportsbookId);
  }
  if (opts.sport) {
    where.push('e.sport = ?');
    params.push(opts.sport);
  }
  if (opts.marketType) {
    where.push('m.type = ?');
    params.push(opts.marketType);
  }
  if (opts.eventKey) {
    where.push('s.event_key = ?');
    params.push(opts.eventKey);
  }
  if (opts.marketKey) {
    where.push('s.market_key = ?');
    params.push(opts.marketKey);
  }
  if (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs)) {
    where.push('o.ts >= ?');
    params.push(Math.trunc(opts.sinceMs));
  }

  return { clause: where.length > 0 ? 'WHERE ' + where.join(' AND ') : '', params };
}

/** Market keys matching the filter, most recently priced first. */
function candidateMarketKeys(db: DatabaseSync, opts: PricedSelectionOptions): string[] {
  const filter = buildFilter(opts);
  const limit = clampInt(opts.maxMarkets ?? 500, 1, LIMITS.markets);
  const sql =
    `SELECT s.market_key AS market_key,
            MAX(o.ts)    AS last_ts,
            COUNT(*)     AS priced_outcomes
       FROM selections s
       JOIN markets m ON m.market_key = s.market_key
       JOIN events  e ON e.event_key  = s.event_key` +
    latestSnapshotJoin('JOIN') +
    ` ${filter.clause}
      GROUP BY s.market_key
      ORDER BY ${marketOrderColumn(opts.order)} DESC
      LIMIT ?`;

  return db
    .prepare(sql)
    .all(...filter.params, limit)
    .map((r) => asText(r['market_key']))
    .filter((k) => k.length > 0);
}

function pricedSelectionsSql(count: number): string {
  return (
    `SELECT s.selection_key AS selection_key,
            s.market_key    AS market_key,
            s.event_key     AS event_key,
            s.sportsbook_id AS sportsbook_id,
            s.name          AS selection_name,
            m.name          AS market_name,
            m.type          AS market_type,
            e.sport         AS sport,
            e.league        AS league,
            e.name          AS event_name,
            e.start_time    AS start_time,
            o.decimal_odds  AS decimal_odds,
            o.status        AS status,
            o.ts            AS ts,
            -- The snapshot's line is the handicap the price was actually offered
            -- at. selections.line and markets.line are last-write-wins summaries
            -- and can already describe a different line than this price did.
            COALESCE(o.line, s.line, m.line) AS line
       FROM selections s
       JOIN markets m ON m.market_key = s.market_key
       JOIN events  e ON e.event_key  = s.event_key` +
    latestSnapshotJoin('JOIN') +
    ` WHERE s.market_key IN (${placeholders(count)})
      ORDER BY s.market_key ASC, s.selection_key ASC
      LIMIT ?`
  );
}

/**
 * Latest price per selection, joined to selection, market and event names.
 *
 * Whole markets only: the row cap is a backstop against a pathological database,
 * not a paging mechanism. Page by narrowing `maxMarkets`, never by slicing rows.
 */
export function pricedSelections(db: DatabaseSync, opts: PricedSelectionOptions = {}): PricedSelection[] {
  const marketKeys = candidateMarketKeys(db, opts);
  if (marketKeys.length === 0) return [];

  const out: PricedSelection[] = [];
  for (const group of chunk(marketKeys, MAX_BOUND_PARAMS)) {
    const rows = db.prepare(pricedSelectionsSql(group.length)).all(...group, LIMITS.selections);
    for (const row of rows) out.push(toPricedSelection(row));
  }
  return out;
}

function toPricedSelection(row: Record<string, unknown>): PricedSelection {
  return {
    selectionKey: asText(row['selection_key']),
    marketKey: asText(row['market_key']),
    eventKey: asText(row['event_key']),
    sportsbookId: asText(row['sportsbook_id']),
    name: asTextOrNull(row['selection_name']),
    marketName: asTextOrNull(row['market_name']),
    marketType: asTextOrNull(row['market_type']),
    line: asNumberOrNull(row['line']),
    decimalOdds: asNumberOrNull(row['decimal_odds']),
    status: asTextOrNull(row['status']),
    ts: asInt(row['ts']),
    sport: asTextOrNull(row['sport']),
    league: asTextOrNull(row['league']),
    eventName: asTextOrNull(row['event_name']),
    startTime: asNumberOrNull(row['start_time']),
  };
}

/* ------------------------------------------------------------------ *
 * Price history for one selection
 * ------------------------------------------------------------------ */

export interface PriceSeriesOptions {
  /** Only points at or after this epoch ms. */
  sinceMs?: number;
  /** Cap on points. The NEWEST points are kept - see below. */
  limit?: number;
}

/**
 * One selection's recorded prices, oldest first.
 *
 * The inner query orders newest-first and the outer one flips it back. That
 * looks redundant and is not: a `LIMIT` over an ascending order would discard
 * the newest points, which is precisely where a move being looked for lives. A
 * truncated series must lose its oldest end, never its most recent.
 */
export function priceSeries(db: DatabaseSync, selectionKey: string, opts: PriceSeriesOptions = {}): PriceSeries {
  const limit = clampInt(opts.limit ?? 1000, 2, LIMITS.seriesPoints);
  const since = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) ? Math.trunc(opts.sinceMs) : 0;

  const rows = db
    .prepare(
      `SELECT ts, decimal_odds, line, status, event_key
         FROM (
           SELECT ts, decimal_odds, line, status, event_key, id
             FROM odds_snapshots
            WHERE selection_key = ? AND ts >= ?
            ORDER BY ts DESC, id DESC
            LIMIT ?
         )
        ORDER BY ts ASC, id ASC`,
    )
    .all(selectionKey, since, limit);

  const points = rows.map((r) => ({
    ts: asInt(r['ts']),
    decimalOdds: asNumber(r['decimal_odds']),
    line: asNumberOrNull(r['line']),
    status: asTextOrNull(r['status']),
  }));

  // The event key travels on every snapshot, but a selection with no stored
  // price still has one in the reference tables. Falling back keeps the series
  // identifiable instead of returning an empty string that means nothing.
  const first = rows[0];
  const eventKey = first ? asText(first['event_key']) : eventKeyForSelection(db, selectionKey);

  return { selectionKey, eventKey, points };
}

function eventKeyForSelection(db: DatabaseSync, selectionKey: string): string {
  const row = db.prepare('SELECT event_key FROM selections WHERE selection_key = ?').get(selectionKey);
  return row ? asText(row['event_key']) : '';
}

/* ------------------------------------------------------------------ *
 * Selections worth looking at for movement
 * ------------------------------------------------------------------ */

/**
 * Selections with more than one recorded price in the window.
 *
 * `COUNT(DISTINCT decimal_odds) > 1` is the load-bearing half of the HAVING
 * clause. The unique index is on (selection_key, ts, decimal_odds), so a
 * selection re-observed at the same price at a new timestamp stores a new row -
 * it has several snapshots and no movement at all. Filtering on snapshot count
 * alone would hand the detector a stream of flat series to reject one by one.
 *
 * Ordered by recency rather than by how much a price moved: ranking by
 * significance is the detector's job, and doing it in SQL would need the
 * probability arithmetic that lives in shared/odds.ts.
 */
export function movingSelections(db: DatabaseSync, sinceMs: number, limit: number): string[] {
  const since = Number.isFinite(sinceMs) ? Math.trunc(sinceMs) : 0;
  return db
    .prepare(
      `SELECT selection_key
         FROM odds_snapshots
        WHERE ts >= ?
        GROUP BY selection_key
       HAVING COUNT(*) > 1 AND COUNT(DISTINCT decimal_odds) > 1
        ORDER BY MAX(ts) DESC
        LIMIT ?`,
    )
    .all(since, clampInt(limit, 1, LIMITS.movingSelections))
    .map((r) => asText(r['selection_key']))
    .filter((k) => k.length > 0);
}

/* ------------------------------------------------------------------ *
 * Margins
 * ------------------------------------------------------------------ */

export type MarginGrouping = 'sport' | 'marketType';

export interface MarketMarginOptions extends PricedSelectionOptions {
  /** Which axis `group` carries. Both are also returned per row. */
  groupBy?: MarginGrouping;
  method?: DevigMethod;
  /** Overrides {@link DEFAULT_MAX_MARKET_PRICE_SPREAD_MS}. */
  maxPriceSpreadMs?: number;
}

/** Shaped for `summarizeMargins`, with the context a report needs alongside. */
export interface MarketMarginRow {
  group: string;
  marginPct: number;
  marketKey: string;
  eventKey: string;
  sport: string | null;
  marketType: string | null;
  marketName: string | null;
  eventName: string | null;
  overround: number;
  outcomes: number;
  ts: number;
  warnings: string[];
}

export interface MarketMarginResult {
  rows: MarketMarginRow[];
  /** Every market we looked at and could not measure, with the reason. */
  skipped: Array<{ marketKey: string; reason: string }>;
  selectionsScanned: number;
  marketsScanned: number;
  method: DevigMethod;
  maxPriceSpreadMs: number;
}

export const UNKNOWN_SPORT = '(sport not recorded)';
export const UNKNOWN_MARKET_TYPE = '(market type not recorded)';

/**
 * Median-ready margin rows.
 *
 * Returns a result object rather than a bare array because the caller needs the
 * rejections as much as the measurements. "No market qualified" is a useful
 * answer only when it comes with the count and the reason; an empty array on its
 * own is indistinguishable from a bug.
 */
export function marketMargins(db: DatabaseSync, opts: MarketMarginOptions = {}): MarketMarginResult {
  const method: DevigMethod = opts.method === 'proportional' ? 'proportional' : 'shin';
  const maxSpread =
    typeof opts.maxPriceSpreadMs === 'number' && Number.isFinite(opts.maxPriceSpreadMs) && opts.maxPriceSpreadMs >= 0
      ? Math.trunc(opts.maxPriceSpreadMs)
      : DEFAULT_MAX_MARKET_PRICE_SPREAD_MS;
  const groupBy: MarginGrouping = opts.groupBy === 'marketType' ? 'marketType' : 'sport';

  const rows = pricedSelections(db, opts);
  const skipped: Array<{ marketKey: string; reason: string }> = [];

  // One representative row per market carries the sport and the names. Every
  // row in a market group shares them, so the first is as good as any.
  const meta = new Map<string, PricedSelection>();
  const span = new Map<string, { min: number; max: number }>();
  for (const row of rows) {
    if (!meta.has(row.marketKey)) meta.set(row.marketKey, row);
    const seen = span.get(row.marketKey);
    if (seen) {
      if (row.ts < seen.min) seen.min = row.ts;
      if (row.ts > seen.max) seen.max = row.ts;
    } else {
      span.set(row.marketKey, { min: row.ts, max: row.ts });
    }
  }

  const stale = new Set<string>();
  for (const [marketKey, seen] of span) {
    const width = seen.max - seen.min;
    if (width > maxSpread) {
      stale.add(marketKey);
      skipped.push({
        marketKey,
        reason:
          `prices in this market were recorded ${Math.round(width / 1000)}s apart, beyond the ` +
          `${Math.round(maxSpread / 1000)}s window - an overround summed across different moments is not the ` +
          'margin at either of them',
      });
    }
  }

  const fresh = stale.size === 0 ? rows : rows.filter((r) => !stale.has(r.marketKey));
  const assembled = assembleMarkets(fresh);
  skipped.push(...assembled.incomplete);

  const out: MarketMarginRow[] = [];
  for (const market of assembled.markets) {
    const devigged = devigMarket(market, { method });
    if (!devigged.ok) {
      skipped.push({ marketKey: market.marketKey, reason: devigged.reason });
      continue;
    }
    const context = meta.get(market.marketKey);
    const sport = context?.sport ?? null;
    const marketType = market.type ?? context?.marketType ?? null;
    out.push({
      group: groupBy === 'sport' ? (sport ?? UNKNOWN_SPORT) : (marketType ?? UNKNOWN_MARKET_TYPE),
      marginPct: devigged.fair.marginPct,
      marketKey: market.marketKey,
      eventKey: market.eventKey,
      sport,
      marketType,
      marketName: market.name,
      eventName: context?.eventName ?? null,
      overround: devigged.fair.overround,
      outcomes: market.outcomes.length,
      ts: devigged.fair.ts,
      warnings: devigged.fair.warnings,
    });
  }

  return {
    rows: out,
    skipped,
    selectionsScanned: rows.length,
    marketsScanned: span.size,
    method,
    maxPriceSpreadMs: maxSpread,
  };
}

/* ------------------------------------------------------------------ *
 * Event timing
 * ------------------------------------------------------------------ */

/**
 * Kickoff time per event.
 *
 * A key maps to null both when the event is unknown to us and when it is known
 * without a start time. The distinction does not matter to any caller here:
 * either way we cannot say when the market closed, and a CLV number without a
 * close is not a CLV number.
 */
export function eventStartTimes(db: DatabaseSync, eventKeys: readonly string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const wanted = [...new Set(eventKeys.filter((k) => typeof k === 'string' && k.length > 0))];
  for (const key of wanted) out.set(key, null);
  if (wanted.length === 0) return out;

  for (const group of chunk(wanted, MAX_BOUND_PARAMS)) {
    const rows = db
      .prepare(`SELECT event_key, start_time FROM events WHERE event_key IN (${placeholders(group.length)})`)
      .all(...group);
    for (const row of rows) {
      const key = asText(row['event_key']);
      const start = asNumberOrNull(row['start_time']);
      // Zero is not a kickoff time, it is an unparsed field that reached the
      // column as a number. Treat it as absent rather than as 1970.
      out.set(key, start !== null && start > 0 ? start : null);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

/**
 * Names for a set of selections. A movement list rendered as opaque keys is not
 * a report anyone can act on, and the join is far cheaper once than per row.
 */
export function selectionLabels(db: DatabaseSync, selectionKeys: readonly string[]): Map<string, SelectionLabel> {
  const out = new Map<string, SelectionLabel>();
  const wanted = [...new Set(selectionKeys.filter((k) => typeof k === 'string' && k.length > 0))];
  if (wanted.length === 0) return out;

  for (const group of chunk(wanted, MAX_BOUND_PARAMS)) {
    const rows = db
      .prepare(
        `SELECT s.selection_key AS selection_key,
                s.market_key    AS market_key,
                s.event_key     AS event_key,
                s.name          AS selection_name,
                m.name          AS market_name,
                m.type          AS market_type,
                e.name          AS event_name,
                e.sport         AS sport,
                e.league        AS league,
                e.start_time    AS start_time
           FROM selections s
           JOIN markets m ON m.market_key = s.market_key
           JOIN events  e ON e.event_key  = s.event_key
          WHERE s.selection_key IN (${placeholders(group.length)})`,
      )
      .all(...group);

    for (const row of rows) {
      const key = asText(row['selection_key']);
      out.set(key, {
        selectionKey: key,
        marketKey: asText(row['market_key']),
        eventKey: asText(row['event_key']),
        selectionName: asTextOrNull(row['selection_name']),
        marketName: asTextOrNull(row['market_name']),
        marketType: asTextOrNull(row['market_type']),
        eventName: asTextOrNull(row['event_name']),
        sport: asTextOrNull(row['sport']),
        league: asTextOrNull(row['league']),
        startTime: asNumberOrNull(row['start_time']),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * CLV candidates
 * ------------------------------------------------------------------ */

/**
 * Legs of stored feed bets that could carry a closing-line comparison.
 *
 * Filtered to legs that name a selection and record the price the bettor got.
 * Whether the event has actually closed is decided by the caller against
 * `eventStartTimes`, because "closed" is a fact about the clock and this query
 * would have to embed one to answer it.
 */
export function clvCandidateLegs(db: DatabaseSync, opts: ClvCandidateOptions = {}): ClvCandidateLeg[] {
  const where: string[] = ['l.selection_key IS NOT NULL', 'l.odds_at_bet IS NOT NULL'];
  const params: Array<string | number> = [];

  if (opts.sportsbookId) {
    where.push('b.sportsbook_id = ?');
    params.push(opts.sportsbookId);
  }
  if (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs)) {
    where.push('b.ts >= ?');
    params.push(Math.trunc(opts.sinceMs));
  }

  const rows = db
    .prepare(
      `SELECT l.bet_key        AS bet_key,
              l.idx            AS idx,
              l.selection_key  AS selection_key,
              l.event_key      AS event_key,
              l.odds_at_bet    AS odds_at_bet,
              l.status         AS leg_status,
              l.sport          AS sport,
              l.event_name     AS event_name,
              l.market_name    AS market_name,
              l.selection_name AS selection_name,
              b.ts             AS bet_ts,
              b.bettor_key     AS bettor_key,
              b.type           AS bet_type,
              b.status         AS bet_status
         FROM feed_bet_legs l
         JOIN feed_bets b ON b.bet_key = l.bet_key
        WHERE ${where.join(' AND ')}
        ORDER BY b.ts DESC
        LIMIT ?`,
    )
    .all(...params, clampInt(opts.limit ?? 1000, 1, LIMITS.clvLegs));

  const out: ClvCandidateLeg[] = [];
  for (const row of rows) {
    const selectionKey = asTextOrNull(row['selection_key']);
    const oddsAtBet = asNumberOrNull(row['odds_at_bet']);
    // The WHERE clause already excluded nulls; this narrows the types without
    // asserting, so a schema change cannot turn into a runtime NaN.
    if (selectionKey === null || oddsAtBet === null) continue;
    out.push({
      betKey: asText(row['bet_key']),
      idx: asInt(row['idx']),
      selectionKey,
      eventKey: asTextOrNull(row['event_key']),
      oddsAtBet,
      betTs: asInt(row['bet_ts']),
      bettorKey: asText(row['bettor_key']),
      betType: asText(row['bet_type'] ?? 'unknown'),
      betStatus: asText(row['bet_status'] ?? 'unknown'),
      legStatus: asText(row['leg_status'] ?? 'unknown'),
      sport: asTextOrNull(row['sport']),
      eventName: asTextOrNull(row['event_name']),
      marketName: asTextOrNull(row['market_name']),
      selectionName: asTextOrNull(row['selection_name']),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/** `?,?,?` for a bound `IN` list. Generated from a count, never from input. */
function placeholders(count: number): string {
  return new Array(Math.max(0, Math.trunc(count))).fill('?').join(',');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return String(v);
}

function asTextOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return null;
  return String(v);
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return fallback;
}

function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

function asInt(v: unknown): number {
  return Math.trunc(asNumber(v, 0));
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}
