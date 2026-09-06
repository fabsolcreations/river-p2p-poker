/**
 * Edge routes - Duel's price against an independent consensus.
 *
 * This is the endpoint the whole project was pointed at, and the first one
 * allowed to use the word "edge". It only earns that because the fair value
 * comes from books that are not Duel; see src/analysis/types.ts.
 *
 * The pipeline, and the refusal at every stage:
 *
 *   Duel market  -> needs every outcome priced, or no comparison is possible
 *   sport key    -> unmapped league refuses rather than guessing a division
 *   event match  -> ambiguous or time-mismatched fixtures refuse
 *   consensus    -> under three independent books refuses
 *   edge         -> computed, and still shipped with its warnings
 *
 * A refusal at any stage is reported with its reason. The counts of what was
 * refused and why are as much the product as the edges themselves: "we compared
 * 4 of 300 markets" is the honest headline, and hiding it would make a thin
 * result look like a thorough one.
 */

import type { FastifyInstance } from 'fastify';

import { assembleMarkets } from '../../analysis/fair.ts';
import { buildConsensus, computeEdge, type BookMarket } from '../../analysis/consensus.ts';
import { pricedSelections } from '../db/analysis-queries.ts';
import { isMatched, matchEvent, type MatchCandidate } from '../../odds-sources/matching.ts';
import { mappedLeagues, resolveSportKey } from '../../odds-sources/sport-keys.ts';
import { NON_INDEPENDENT_BOOK_KEYS, type ExternalEvent, type ExternalOddsSource } from '../../odds-sources/types.ts';
import { TheOddsApiSource } from '../../odds-sources/the-odds-api.ts';
import type { ServerContext } from '../index.ts';

/**
 * Home and away as separate names, read from the events table.
 *
 * `PricedSelection` only carries a display string ("A vs B"), and splitting
 * that on " vs " would break on any club whose name contains it and would
 * silently swap sides on a differently-formatted row. Sides being swapped is
 * exactly the error that inverts a handicap, so the columns are read directly.
 */
interface EventSides {
  home: string | null;
  away: string | null;
  startTime: number | null;
}

function loadEventSides(ctx: ServerContext, eventKeys: readonly string[]): Map<string, EventSides> {
  const out = new Map<string, EventSides>();
  if (eventKeys.length === 0) return out;
  const stmt = ctx.db.handle.prepare('SELECT event_key, home, away, start_time FROM events WHERE event_key = ?');
  for (const key of new Set(eventKeys)) {
    const row = stmt.get(key) as { home: string | null; away: string | null; start_time: number | null } | undefined;
    if (row) out.set(key, { home: row.home, away: row.away, startTime: row.start_time });
  }
  return out;
}

/**
 * The active price source.
 *
 * Held in a module-level slot with a setter rather than constructed inline so
 * the whole pipeline - match, consensus, edge - can be exercised end to end
 * against a stubbed source. Without that seam the only way to test this route
 * would be to spend real quota against a live API, which on a 500-a-month free
 * tier is not a test anyone runs twice.
 */
let source: ExternalOddsSource = new TheOddsApiSource();

/** Test seam. Returns the previous source so a test can restore it. */
export function setOddsSource(next: ExternalOddsSource): ExternalOddsSource {
  const previous = source;
  source = next;
  return previous;
}

/**
 * Aligns an external h2h market to the two-or-three outcome names a consensus
 * needs. Names come from the source verbatim, so every book in one event
 * already agrees on them - it is only across EVENTS that they vary.
 */
function h2hMarkets(event: ExternalEvent): BookMarket[] {
  const out: BookMarket[] = [];
  for (const book of event.books) {
    if (NON_INDEPENDENT_BOOK_KEYS.has(book.key)) continue;
    const market = book.markets.find((m) => m.key === 'h2h');
    if (!market) continue;
    const prices = new Map<string, number>();
    for (const outcome of market.outcomes) prices.set(outcome.name, outcome.decimalOdds);
    if (prices.size >= 2) {
      out.push({ bookKey: book.key, bookTitle: book.title, lastUpdate: book.lastUpdate, prices });
    }
  }
  return out;
}

/** Maps a Duel selection name to the external outcome name for the same side. */
function alignOutcome(selectionName: string | null, home: string | null, away: string | null, event: ExternalEvent, swapped: boolean): string | null {
  if (selectionName === null) return null;
  const target = selectionName.toLowerCase().trim();
  const duelHome = (home ?? '').toLowerCase().trim();
  const duelAway = (away ?? '').toLowerCase().trim();

  // The external names are authoritative for the consensus keys, so map by
  // which SIDE the Duel selection refers to rather than by string similarity.
  if (target === duelHome) return swapped ? event.awayTeam : event.homeTeam;
  if (target === duelAway) return swapped ? event.homeTeam : event.awayTeam;
  return null;
}

export function registerEdgeRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/edges/status', async (_request, reply) => {
    await reply.send({
      sources: [source.status()],
      mappedLeagues: mappedLeagues(),
      // Stated up front, because without a key none of this can work at all.
      note: source.isConfigured()
        ? null
        : 'No independent price source is configured, so no edge can be computed. Scout can still measure ' +
          "Duel's own margins and line movement, but an edge needs a price from a book that is not Duel.",
    });
  });

  app.get('/api/edges/sports', async (_request, reply) => {
    await reply.send({ sports: await source.listSports(), configured: source.isConfigured() });
  });

  app.get('/api/edges', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const maxAgeMs = typeof query['maxAgeMs'] === 'string' ? Number(query['maxAgeMs']) : undefined;

    if (!source.isConfigured()) {
      await reply.send({
        edges: [],
        configured: false,
        explanation: source.status().setup,
        skipped: {},
      });
      return;
    }

    // Duel's current prices, grouped into complete markets.
    const rows = pricedSelections(ctx.db.handle, {});
    const { markets, incomplete } = assembleMarkets(rows);
    const sides = loadEventSides(ctx, markets.map((m) => m.eventKey));

    const skipped = {
      incompleteMarkets: incomplete.length,
      unmappedLeague: 0,
      noExternalEvent: 0,
      thinConsensus: 0,
      unalignedOutcome: 0,
    };
    const notes: string[] = [];
    const edges: unknown[] = [];

    // Group by sport key so each external sport is fetched at most once - the
    // free tier is 500 credits a month and a fetch per market would exhaust it
    // in a single request.
    const bySportKey = new Map<string, typeof markets>();
    for (const market of markets) {
      const context = rows.find((r) => r.marketKey === market.marketKey);
      const resolved = resolveSportKey(context?.sport ?? null, context?.league ?? null);
      if (resolved.key === null) {
        skipped.unmappedLeague += 1;
        continue;
      }
      const list = bySportKey.get(resolved.key);
      if (list) list.push(market);
      else bySportKey.set(resolved.key, [market]);
    }

    for (const [sportKey, group] of bySportKey) {
      const fetched = await source.fetchOdds(sportKey, maxAgeMs !== undefined && Number.isFinite(maxAgeMs) ? { maxAgeMs } : {});
      if (fetched.events.length === 0) {
        notes.push(`${sportKey}: the source returned no events${fetched.cached ? ' (from cache)' : ''}.`);
        continue;
      }

      const candidates: MatchCandidate[] = fetched.events.map((e) => ({
        externalId: e.id,
        homeTeam: e.homeTeam,
        awayTeam: e.awayTeam,
        commenceTime: e.commenceTime,
        sportKey: e.sportKey,
      }));

      for (const market of group) {
        const context = rows.find((r) => r.marketKey === market.marketKey);
        if (!context) continue;

        const side = sides.get(market.eventKey) ?? { home: null, away: null, startTime: null };
        const match = matchEvent(
          {
            eventKey: market.eventKey,
            home: side.home,
            away: side.away,
            startTime: side.startTime ?? context.startTime ?? null,
            sport: context.sport ?? null,
          },
          candidates,
        );
        if (!isMatched(match)) {
          skipped.noExternalEvent += 1;
          continue;
        }

        const external = fetched.events.find((e) => e.id === match.externalId);
        if (!external) continue;

        const consensus = buildConsensus(h2hMarkets(external), {
          // Duel can never be part of the consensus it is measured against.
          exclude: NON_INDEPENDENT_BOOK_KEYS,
        });
        if (!consensus.ok) {
          skipped.thinConsensus += 1;
          continue;
        }

        for (const outcome of market.outcomes) {
          const name = alignOutcome(outcome.name, side.home, side.away, external, match.swapped);
          if (name === null) {
            skipped.unalignedOutcome += 1;
            continue;
          }
          const edge = computeEdge({ outcomeName: name, bookOdds: outcome.decimalOdds, consensus: consensus.consensus });
          if (!edge.ok) continue;

          edges.push({
            eventKey: market.eventKey,
            event: context.eventName ?? `${side.home ?? '?'} v ${side.away ?? '?'}`,
            sport: context.sport,
            league: context.league,
            marketKey: market.marketKey,
            marketName: market.name,
            selection: outcome.name,
            duelOdds: outcome.decimalOdds,
            consensusFairOdds: edge.edge.consensusFairOdds,
            ev: edge.edge.ev,
            books: edge.edge.books,
            contributingBooks: consensus.consensus.contributingBooks,
            matchConfidence: match.confidence,
            matchReasons: match.reasons,
            warnings: edge.edge.warnings,
          });
        }
      }
    }

    edges.sort((a, b) => (b as { ev: number }).ev - (a as { ev: number }).ev);

    await reply.send({
      configured: true,
      quota: source.status().quota,
      scanned: { duelMarkets: markets.length, sportKeys: bySportKey.size },
      skipped,
      notes,
      edges,
      // The proportion is the honest headline. A handful of edges out of
      // hundreds of markets is a narrow comparison, not a thorough one.
      explanation:
        edges.length === 0
          ? 'No edges computed. That is the normal result: most Duel markets are in leagues with no mapped ' +
            'external equivalent, or their fixtures did not match confidently, or fewer than three independent ' +
            'books quoted them. The skipped counts say which.'
          : `Compared ${edges.length} selections out of ${markets.length} priced Duel markets. Every number here ` +
            'is an estimate against a small consensus, not a certainty.',
      caveats: [
        'An edge is measured against a median of other books after removing each one\'s margin. It is an ' +
          'estimate with a confidence interval, not a guaranteed return.',
        'A wrong fixture match produces a large and entirely fictional edge. Match confidence and the reasoning ' +
          'are attached to every row so it can be checked.',
        'Nothing here places a bet. Review each one yourself.',
      ],
    });
  });
}
