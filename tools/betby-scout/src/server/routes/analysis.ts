/**
 * Analysis endpoints.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ROUTES MAY AND MAY NOT SAY
 * ---------------------------------------------------------------------------
 *
 * Every price in this database comes from one sportsbook. De-vigging that book's
 * market and comparing the result back to the same market yields an edge of
 * MINUS the margin - see the header of ../../analysis/types.ts. So no route here
 * returns an EV, an edge, or a ranked "opportunity", and none ever will while
 * there is a single source of prices. `isEdgeClaimable` is the gate, it is
 * called rather than paraphrased, and today it returns false for every source we
 * can produce.
 *
 * What these routes do return is the set of things one book CAN honestly say:
 *
 *   /margins     how much the book charges, by sport and by market type
 *   /movements   a price against its own past
 *   /fair/:key   the de-vigged market, with the caveats that make it usable
 *   /clv         a bettor's price against the closing price
 *
 * Two rules run through all four:
 *
 *   1. A probability never travels without its `source` and its `warnings`.
 *      Both are top-level fields on every response that carries a fair value, so
 *      a client that reads only the top level still receives the caveat. Nesting
 *      the warning where a lazy renderer will not find it is the same as not
 *      having one.
 *
 *   2. An empty result always carries an explanation. "No market qualified" and
 *      "the query is broken" produce the same empty array, and only the
 *      `explanation` field tells them apart. Every list endpoint here computes
 *      one from the actual counts rather than emitting a generic sentence.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  assembleMarkets,
  devigMarket,
  summarizeMargins,
  type MarginSummary,
} from '../../analysis/fair.ts';
import { detectMovements, summarizeSeries, type SeriesSummary } from '../../analysis/movement.ts';
import {
  CLV_FAIR_SOURCE,
  closingLineAgeMs,
  clvSummary,
  computeClv,
  findClosingLine,
} from '../../analysis/clv.ts';
import {
  DEFAULT_MOVEMENT_OPTIONS,
  isEdgeClaimable,
  type ClvResult,
  type DevigMethod,
  type FairSource,
  type LineMovement,
} from '../../analysis/types.ts';
import {
  clvCandidateLegs,
  eventStartTimes,
  marketMargins,
  movingSelections,
  priceSeries,
  pricedSelections,
  selectionLabels,
  UNKNOWN_MARKET_TYPE,
  type MarketMarginRow,
  type SelectionLabel,
} from '../db/analysis-queries.ts';
import type { ServerContext } from '../index.ts';

/* ------------------------------------------------------------------ *
 * Caveats that travel with the numbers
 * ------------------------------------------------------------------ */

const SINGLE_BOOK_CAVEAT =
  'Every figure here is derived from one sportsbook\'s own prices. Removing that book\'s margin and comparing ' +
  'the result back to the same book returns MINUS the margin, never zero and never positive, so nothing on this ' +
  'endpoint is an edge, an opportunity, or a value bet. A second independent source of prices is required ' +
  'before an edge can be claimed at all.';

const SAMPLING_CAVEAT =
  'We hold only the prices the collector was running to see. A gap in a price series is our blind spot, not a ' +
  'quiet market, and every number computed over a series inherits that gap.';

const MARGIN_CAVEAT =
  'Overround is a fact about what the book charges, measured directly. It says where the book is tight and ' +
  'where it is not; it says nothing about whether any individual price is wrong.';

const MOVEMENT_CAVEAT =
  'A movement is this book\'s price measured against its own past. It is evidence that money or information ' +
  'arrived. It does not say the new price is wrong, and following it is not an edge.';

const MOVEMENT_THRESHOLD_CAVEAT =
  'The labels "steam" and "drift" mean only "faster than a threshold chosen by hand". Those thresholds have ' +
  'not been validated against settled outcomes yet, so they describe speed, not profitability.';

const CLV_CAVEAT =
  'Closing-line value is evidence that a selection process carried information about the closing price. It is ' +
  'not profit and not an edge against this book, and a positive figure must not be presented as money.';

const CLV_FEED_BIAS_CAVEAT =
  'These are the bets the book chose to publish in its public feed. That is not a random sample of the bets ' +
  'placed - it leans toward large stakes and long prices - so this measures the feed, not the bettors behind it.';

const CLV_CLOSE_CAVEAT =
  'The "close" here is the last price we recorded at or before kickoff, not the book\'s final price. When the ' +
  'collector was not running near kickoff we are comparing against an earlier price, and the error has no ' +
  'predictable direction. Each leg reports closingAgeMs, which is how long before kickoff our price was taken.';

/* ------------------------------------------------------------------ *
 * Windows and bounds
 * ------------------------------------------------------------------ */

const MARGIN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MOVEMENT_WINDOW_MS = 6 * 60 * 60 * 1000;
const CLV_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A "closing" price taken more than this long before kickoff is flagged. Half an
 * hour out, a market has usually not absorbed team news, and CLV against it is
 * much weaker evidence than the same number against a real close.
 */
const STALE_CLOSE_MS = 30 * 60 * 1000;

/** Cap on how many price series one movements request will walk. */
const MOVEMENT_SCAN_DEFAULT = 400;
const MOVEMENT_SCAN_MAX = 2000;

/* ------------------------------------------------------------------ *
 * Query parsing
 * ------------------------------------------------------------------ */

function queryOf(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

function readString(query: Record<string, unknown>, key: string, max = 200): string | undefined {
  const value = query[key];
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function readNumber(query: Record<string, unknown>, key: string): number | undefined {
  const value = query[key];
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function bounded(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readMethod(query: Record<string, unknown>): DevigMethod {
  return readString(query, 'method', 16) === 'proportional' ? 'proportional' : 'shin';
}

function isoOrNull(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Reason bucketing
 * ------------------------------------------------------------------ */

interface ReasonBucket {
  reason: string;
  count: number;
}

/**
 * Groups reason strings that differ only in their numbers.
 *
 * Rejection reasons embed per-market figures ("overround of 1.812 is outside
 * ..."), so counting the raw strings would give every rejection its own category
 * and the summary would stop summarizing. Bucketing on the sentence shape and
 * keeping one full example preserves both the count and the detail.
 */
function bucketReasons(entries: ReadonlyArray<string>, max = 12): ReasonBucket[] {
  const buckets = new Map<string, ReasonBucket>();
  for (const entry of entries) {
    const shape = entry.replace(/-?\d+(?:\.\d+)?/g, 'N');
    const hit = buckets.get(shape);
    if (hit) hit.count += 1;
    else buckets.set(shape, { reason: entry, count: 1 });
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, max);
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function registerAnalysisRoutes(app: FastifyInstance, ctx: ServerContext): void {
  registerMarginsRoute(app, ctx);
  registerMovementsRoute(app, ctx);
  registerFairRoute(app, ctx);
  registerClvRoute(app, ctx);
}

/* ---------------- margins ---------------- */

/**
 * Median overround by sport and by market type.
 *
 * This is the honest headline metric for a single book: it is measured, not
 * inferred, and it is comparable across sports without a second source. It runs
 * through `devigMarket` rather than summing implied probabilities here so that
 * the completeness and plausibility guards in fair.ts apply - an overround over
 * a partial market is not a margin, and refusing is the only correct response.
 */
function registerMarginsRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/analysis/margins', async (request, reply) => {
    const query = queryOf(request);
    const windowMs = bounded(readNumber(query, 'windowMs'), 60_000, MAX_WINDOW_MS, MARGIN_WINDOW_MS);
    const sinceMs = Date.now() - windowMs;
    const method = readMethod(query);
    const source: FairSource = 'single-book-devig';

    const result = marketMargins(ctx.db.handle, {
      sportsbookId: readString(query, 'sportsbook', 64),
      sport: readString(query, 'sport', 64),
      marketType: readString(query, 'marketType', 64),
      eventKey: readString(query, 'event'),
      sinceMs,
      maxMarkets: bounded(readNumber(query, 'maxMarkets'), 1, 2000, 500),
      method,
      groupBy: 'sport',
      order: readString(query, 'order', 16),
    });

    // `group` on each row is already the sport; the market-type view re-groups
    // the same measured markets rather than re-running the query, so both views
    // are guaranteed to describe exactly the same set.
    const bySport: MarginSummary[] = summarizeMargins(result.rows);
    const byMarketType: MarginSummary[] = summarizeMargins(
      result.rows.map((row) => ({ group: row.marketType ?? UNKNOWN_MARKET_TYPE, marginPct: row.marginPct })),
    );
    const overall: MarginSummary | null =
      summarizeMargins(result.rows.map((row) => ({ group: 'all measured markets', marginPct: row.marginPct })))[0] ??
      null;

    await reply.send({
      window: { windowMs, sinceMs, since: isoOrNull(sinceMs) },
      method,
      source,
      edgeClaimable: isEdgeClaimable(source),
      maxPriceSpreadMs: result.maxPriceSpreadMs,
      scanned: {
        selections: result.selectionsScanned,
        markets: result.marketsScanned,
        measured: result.rows.length,
        skipped: result.skipped.length,
      },
      overall,
      bySport,
      byMarketType,
      skipped: bucketReasons(result.skipped.map((s) => s.reason)),
      // The de-vig caveats attached to individual markets, rolled up. A market
      // whose margin is 18% is measured under a different assumption than one at
      // 4%, and that difference has to survive the aggregation.
      marketWarnings: bucketReasons(result.rows.flatMap((row) => row.warnings)),
      warnings: [SINGLE_BOOK_CAVEAT, MARGIN_CAVEAT, SAMPLING_CAVEAT],
      explanation: result.rows.length === 0 ? explainNoMargins(ctx, result, sinceMs, windowMs) : null,
    });
  });
}

function explainNoMargins(
  ctx: ServerContext,
  result: { rows: MarketMarginRow[]; skipped: Array<{ reason: string }>; marketsScanned: number; selectionsScanned: number },
  sinceMs: number,
  windowMs: number,
): string {
  const counts = ctx.db.normalizedCounts();
  const prices = counts['odds_snapshots'] ?? 0;
  const hours = Math.round(windowMs / 3_600_000);

  if (prices === 0) {
    return (
      'No prices are stored at all, so there is no market to measure. Either nothing has been captured yet, or ' +
      'captures exist but have not been normalized - POST /api/backfill re-runs the parser over stored ' +
      'captures, and /api/normalized reports the row counts.'
    );
  }
  if (result.marketsScanned === 0) {
    return (
      `${prices} prices are stored, but none of them was recorded in the last ${hours}h (since ` +
      `${isoOrNull(sinceMs) ?? 'the window start'}). Widen the window with ?windowMs= to reach older prices, or ` +
      'run the collector to record current ones.'
    );
  }

  const top = bucketReasons(result.skipped.map((s) => s.reason), 3)
    .map((b) => `${b.count} x "${b.reason}"`)
    .join('; ');
  return (
    `${result.marketsScanned} markets had a recent price and none could be measured, so no margin is reported ` +
    `rather than a margin computed over incomplete markets. Reasons: ${top || 'none recorded'}. A market is ` +
    'measured only when every outcome we have ever seen for it currently has a valid price, all recorded ' +
    'within the same short window.'
  );
}

/* ---------------- movements ---------------- */

interface MovementRow extends LineMovement {
  selection: SelectionLabel | null;
  /** Where the price sits within its own range over the window. */
  series: SeriesSummary | null;
}

function registerMovementsRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/analysis/movements', async (request, reply) => {
    const query = queryOf(request);
    const windowMs = bounded(readNumber(query, 'windowMs'), 60_000, MAX_WINDOW_MS, MOVEMENT_WINDOW_MS);
    const sinceMs = Date.now() - windowMs;
    const limit = bounded(readNumber(query, 'limit'), 1, 500, 50);
    const scan = bounded(readNumber(query, 'scan'), 1, MOVEMENT_SCAN_MAX, MOVEMENT_SCAN_DEFAULT);

    const options = {
      minProbDelta: bounded(readNumber(query, 'minProbDelta'), 0, 1, DEFAULT_MOVEMENT_OPTIONS.minProbDelta),
      steamProbPerMinute: bounded(
        readNumber(query, 'steamProbPerMinute'),
        0,
        1,
        DEFAULT_MOVEMENT_OPTIONS.steamProbPerMinute,
      ),
      maxGapMs: bounded(readNumber(query, 'maxGapMs'), 1000, MAX_WINDOW_MS, DEFAULT_MOVEMENT_OPTIONS.maxGapMs),
    };

    const db = ctx.db.handle;
    const candidates = movingSelections(db, sinceMs, scan);
    const found: LineMovement[] = [];
    const summaries = new Map<string, SeriesSummary>();
    let seriesWithMovement = 0;

    for (const selectionKey of candidates) {
      const series = priceSeries(db, selectionKey, { sinceMs, limit: 2000 });
      const movements = detectMovements(series, options);
      if (movements.length > 0) {
        seriesWithMovement += 1;
        const summary = summarizeSeries(series);
        if (summary) summaries.set(selectionKey, summary);
        found.push(...movements);
      }
    }

    // Most significant first means largest change in implied PROBABILITY, not
    // largest change in odds. A ratio would rank 11.0 -> 10.5 alongside
    // 1.10 -> 1.05, and those are not remotely the same event.
    found.sort((a, b) => Math.abs(b.probDelta) - Math.abs(a.probDelta) || b.tsTo - a.tsTo);
    const top = found.slice(0, limit);
    const labels = selectionLabels(db, top.map((m) => m.selectionKey));

    const movements: MovementRow[] = top.map((m) => ({
      ...m,
      selection: labels.get(m.selectionKey) ?? null,
      series: summaries.get(m.selectionKey) ?? null,
    }));

    await reply.send({
      window: { windowMs, sinceMs, since: isoOrNull(sinceMs) },
      options,
      scanned: {
        candidates: candidates.length,
        candidateLimit: scan,
        candidatesTruncated: candidates.length >= scan,
        seriesWithMovement,
        movementsFound: found.length,
        shown: movements.length,
      },
      movements,
      warnings: [MOVEMENT_CAVEAT, MOVEMENT_THRESHOLD_CAVEAT, SINGLE_BOOK_CAVEAT, SAMPLING_CAVEAT],
      explanation:
        movements.length === 0
          ? explainNoMovements(ctx, candidates.length, found.length, options.minProbDelta, windowMs)
          : null,
    });
  });
}

function explainNoMovements(
  ctx: ServerContext,
  candidates: number,
  found: number,
  minProbDelta: number,
  windowMs: number,
): string {
  const hours = Math.round(windowMs / 3_600_000);
  if (candidates === 0) {
    const prices = ctx.db.normalizedCounts()['odds_snapshots'] ?? 0;
    if (prices === 0) {
      return (
        'No prices are stored, so no price can have moved. /api/normalized reports the row counts, and ' +
        'POST /api/backfill re-parses captures that were stored before the adapters could read them.'
      );
    }
    return (
      `${prices} prices are stored, but no selection recorded two different prices in the last ${hours}h. ` +
      'A selection observed repeatedly at the same price has several snapshots and no movement; widen ' +
      '?windowMs= to look further back.'
    );
  }
  if (found === 0) {
    return (
      `${candidates} selections changed price in the last ${hours}h, but no window in any of them reached the ` +
      `${(minProbDelta * 100).toFixed(2)} percentage-point minimum. Below that threshold we are mostly watching ` +
      'the book round its own prices, so nothing is reported rather than reporting noise. Lower it with ' +
      '?minProbDelta= if you want to see the small moves.'
    );
  }
  return `${found} movements were detected but none survived the requested limit.`;
}

/* ---------------- fair value for one market ---------------- */

function registerFairRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/analysis/fair/:marketKey', async (request, reply) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const marketKey = typeof params['marketKey'] === 'string' ? params['marketKey'] : '';
    if (marketKey.length === 0 || marketKey.length > 200) {
      await reply.code(400).send({ ok: false, error: 'A market key is required.' });
      return;
    }

    const method = readMethod(queryOf(request));
    const rows = pricedSelections(ctx.db.handle, { marketKey, maxMarkets: 1 });

    if (rows.length === 0) {
      await reply.code(404).send({
        ok: false,
        error:
          `No priced selection is stored for market "${marketKey}". Either the key is wrong, or the market is ` +
          'known but every outcome is still waiting for its first recorded price.',
      });
      return;
    }

    const first = rows[0];
    const market = {
      marketKey,
      eventKey: first?.eventKey ?? null,
      name: first?.marketName ?? null,
      type: first?.marketType ?? null,
      eventName: first?.eventName ?? null,
      sport: first?.sport ?? null,
      league: first?.league ?? null,
      startTime: first?.startTime ?? null,
      outcomesKnown: rows.length,
      newestPriceTs: rows.reduce((max, row) => (row.ts > max ? row.ts : max), 0),
    };

    const assembled = assembleMarkets(rows);
    const complete = assembled.markets.find((m) => m.marketKey === marketKey);
    if (!complete) {
      // No fair value, and the reason the market was rejected. Returning a
      // partial de-vig here would be the exact failure this endpoint exists to
      // avoid: a probability computed over outcomes that are missing.
      await reply.send({
        market,
        fair: null,
        method,
        reason:
          assembled.incomplete.find((i) => i.marketKey === marketKey)?.reason ??
          'the market could not be assembled from the stored selections',
        warnings: [SINGLE_BOOK_CAVEAT, SAMPLING_CAVEAT],
      });
      return;
    }

    const devigged = devigMarket(complete, { method });
    if (!devigged.ok) {
      await reply.send({
        market,
        fair: null,
        method,
        reason: devigged.reason,
        warnings: [SINGLE_BOOK_CAVEAT, SAMPLING_CAVEAT],
      });
      return;
    }

    const fair = devigged.fair;
    const names = new Map(rows.map((row) => [row.selectionKey, row]));

    await reply.send({
      market,
      method: fair.method,
      // Repeated at the top level on purpose: `source` is what decides whether
      // an edge may be claimed, and a client must not have to reach inside
      // `fair` to discover it.
      source: fair.source,
      edgeClaimable: isEdgeClaimable(fair.source),
      fair: {
        ...fair,
        outcomes: fair.outcomes.map((outcome) => {
          const row = names.get(outcome.selectionKey);
          return {
            ...outcome,
            name: row?.name ?? null,
            line: row?.line ?? null,
            status: row?.status ?? null,
          };
        }),
      },
      // Deliberately absent: any per-outcome expected value. Against this book's
      // own de-vigged probabilities it is zero for every outcome, and a field
      // holding zero is an invitation to render it as though it might not be.
      warnings: [SINGLE_BOOK_CAVEAT, ...fair.warnings, SAMPLING_CAVEAT],
    });
  });
}

/* ---------------- closing line value ---------------- */

interface ClvRow extends ClvResult {
  betKey: string;
  idx: number;
  betTs: number;
  bettorKey: string;
  betType: string;
  betStatus: string;
  legStatus: string;
  sport: string | null;
  eventName: string | null;
  marketName: string | null;
  selectionName: string | null;
  eventKey: string | null;
  startTime: number;
  closingTs: number;
  /** How long before kickoff our closing price was recorded. */
  closingAgeMs: number;
  /** Prices we held for this selection before kickoff. */
  closingSamples: number;
  staleClose: boolean;
}

function registerClvRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/analysis/clv', async (request, reply) => {
    const query = queryOf(request);
    const windowMs = bounded(readNumber(query, 'windowMs'), 60_000, MAX_WINDOW_MS, CLV_WINDOW_MS);
    const sinceMs = Date.now() - windowMs;
    const legLimit = bounded(readNumber(query, 'limit'), 1, 500, 100);
    const scan = bounded(readNumber(query, 'scan'), 1, 5000, 1000);
    const now = Date.now();

    const db = ctx.db.handle;
    const legs = clvCandidateLegs(db, {
      sportsbookId: readString(query, 'sportsbook', 64),
      sinceMs,
      limit: scan,
    });

    const starts = eventStartTimes(
      db,
      legs.map((leg) => leg.eventKey).filter((key): key is string => typeof key === 'string' && key.length > 0),
    );

    const skipped = {
      noEventKey: 0,
      noStartTime: 0,
      notStarted: 0,
      noPriceBeforeKickoff: 0,
      unusablePrice: 0,
    };

    const rows: ClvRow[] = [];
    for (const leg of legs) {
      if (leg.eventKey === null) {
        skipped.noEventKey += 1;
        continue;
      }
      const startTime = starts.get(leg.eventKey) ?? null;
      if (startTime === null) {
        // Without a kickoff time we cannot tell a pre-game price from an in-play
        // one, and an in-play price used as a close does not add noise, it adds
        // bias. Skipping is the only safe answer.
        skipped.noStartTime += 1;
        continue;
      }
      if (startTime > now) {
        skipped.notStarted += 1;
        continue;
      }

      const series = priceSeries(db, leg.selectionKey, { limit: 5000 });
      const closing = findClosingLine(series, startTime);
      if (closing === null) {
        skipped.noPriceBeforeKickoff += 1;
        continue;
      }
      const clv = computeClv(leg.oddsAtBet, closing);
      if (clv === null) {
        skipped.unusablePrice += 1;
        continue;
      }

      const closingAgeMs = closingLineAgeMs(closing);
      rows.push({
        ...clv,
        betKey: leg.betKey,
        idx: leg.idx,
        betTs: leg.betTs,
        bettorKey: leg.bettorKey,
        betType: leg.betType,
        betStatus: leg.betStatus,
        legStatus: leg.legStatus,
        sport: leg.sport,
        eventName: leg.eventName,
        marketName: leg.marketName,
        selectionName: leg.selectionName,
        eventKey: leg.eventKey,
        startTime: closing.startTime,
        closingTs: closing.closingTs,
        closingAgeMs,
        closingSamples: closing.samples,
        staleClose: closingAgeMs > STALE_CLOSE_MS,
      });
    }

    // The summary covers every measured leg; the `legs` array is a page of them.
    // Computing the mean over the page instead would silently make the headline
    // figure depend on the limit the caller happened to pass.
    const summary = clvSummary(rows);
    const staleCloses = rows.filter((row) => row.staleClose).length;
    const shown = [...rows].sort((a, b) => b.betTs - a.betTs).slice(0, legLimit);

    const warnings = [CLV_CAVEAT, CLV_FEED_BIAS_CAVEAT, CLV_CLOSE_CAVEAT, SAMPLING_CAVEAT];
    if (staleCloses > 0) {
      warnings.push(
        `${staleCloses} of ${rows.length} legs use a closing price recorded more than ` +
          `${Math.round(STALE_CLOSE_MS / 60000)} minutes before kickoff. Those comparisons are against the last ` +
          'price we saw, not against a real close, and they weaken the result by an unknown amount.',
      );
    }

    await reply.send({
      window: { windowMs, sinceMs, since: isoOrNull(sinceMs) },
      source: CLV_FAIR_SOURCE,
      edgeClaimable: isEdgeClaimable(CLV_FAIR_SOURCE),
      scanned: {
        legs: legs.length,
        legLimitReached: legs.length >= scan,
        measured: rows.length,
        skipped,
      },
      summary,
      staleCloses,
      legsShown: shown.length,
      legs: shown,
      warnings,
      explanation: rows.length === 0 ? explainNoClv(legs.length, skipped, windowMs) : null,
    });
  });
}

function explainNoClv(
  legs: number,
  skipped: { noEventKey: number; noStartTime: number; notStarted: number; noPriceBeforeKickoff: number; unusablePrice: number },
  windowMs: number,
): string {
  const days = Math.max(1, Math.round(windowMs / 86_400_000));
  if (legs === 0) {
    return (
      `No stored bet in the last ${days} days has both a selection key and the price the bettor took, so there ` +
      'is nothing to compare against a close. Bets arrive from the public feed; if /api/bets is also empty, the ' +
      'feed has not been captured yet.'
    );
  }
  const parts: string[] = [];
  if (skipped.notStarted > 0) parts.push(`${skipped.notStarted} are on events that have not started`);
  if (skipped.noStartTime > 0) parts.push(`${skipped.noStartTime} are on events with no stored kickoff time`);
  if (skipped.noPriceBeforeKickoff > 0) {
    parts.push(`${skipped.noPriceBeforeKickoff} have no price recorded at or before kickoff`);
  }
  if (skipped.noEventKey > 0) parts.push(`${skipped.noEventKey} name no event`);
  if (skipped.unusablePrice > 0) parts.push(`${skipped.unusablePrice} carry a price outside the valid range`);

  return (
    `${legs} bet legs were examined and none could be measured: ${parts.join(', ')}. CLV needs a kickoff time ` +
    'and at least one price recorded before it; a price recorded after kickoff is an in-play price and is never ' +
    'used as a close.'
  );
}
