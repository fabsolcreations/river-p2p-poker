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
import { buildConsensus, buildSharpReference, computeEdge, type BookMarket } from '../../analysis/consensus.ts';
import { pricedSelections } from '../db/analysis-queries.ts';
import { isMatched, matchEvent, type MatchCandidate } from '../../odds-sources/matching.ts';
import { mappedLeagues } from '../../odds-sources/sport-keys.ts';
import { NON_INDEPENDENT_BOOK_KEYS, type ExternalEvent, type ExternalOddsSource } from '../../odds-sources/types.ts';
import { TheOddsApiSource } from '../../odds-sources/the-odds-api.ts';
import { PinnacleSource, PINNACLE_SOURCE_ID } from '../../odds-sources/scrapers/pinnacle.ts';
import { KambiSource } from '../../odds-sources/scrapers/kambi.ts';
import { edgeStrength } from '../../analysis/types.ts';
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
  country: string | null;
}

function loadEventSides(ctx: ServerContext, eventKeys: readonly string[]): Map<string, EventSides> {
  const out = new Map<string, EventSides>();
  if (eventKeys.length === 0) return out;
  const stmt = ctx.db.handle.prepare(
    'SELECT event_key, home, away, start_time, country FROM events WHERE event_key = ?',
  );
  for (const key of new Set(eventKeys)) {
    const row = stmt.get(key) as
      | { home: string | null; away: string | null; start_time: number | null; country: string | null }
      | undefined;
    if (row) out.set(key, { home: row.home, away: row.away, startTime: row.start_time, country: row.country });
  }
  return out;
}

/**
 * The active price sources.
 *
 * Two are scraped and need nothing configured - Pinnacle and Kambi, both read
 * from the public endpoints their own websites use. The Odds API is included
 * too and contributes only when a key happens to be set; it is no longer
 * required for the feature to work at all.
 *
 * Held in a mutable slot so the whole pipeline can be exercised end to end
 * against stubs. Without that seam the only way to test this route would be to
 * hit three live third-party services on every run, which is neither polite nor
 * repeatable.
 */
let sources: ExternalOddsSource[] = [new PinnacleSource(), new KambiSource(), new TheOddsApiSource()];

/** Test seam. Returns the previous list so a test can restore it. */
export function setOddsSources(next: ExternalOddsSource[]): ExternalOddsSource[] {
  const previous = sources;
  sources = next;
  return previous;
}

/** Backwards-compatible single-source setter used by the existing test. */
export function setOddsSource(next: ExternalOddsSource): ExternalOddsSource {
  const previous = sources[0] as ExternalOddsSource;
  sources = [next];
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
    const statuses = sources.map((src) => src.status());
    const ready = statuses.filter((st) => st.configured);
    await reply.send({
      sources: statuses,
      mappedLeagues: mappedLeagues(),
      note:
        ready.length === 0
          ? 'No price source is available, so no edge can be computed.'
          : `${ready.length} independent source(s) available. Three books are needed for a consensus; with fewer, ` +
            'Pinnacle alone is used as a sharp reference, which is weaker and is labelled as such.',
    });
  });

  app.get('/api/edges/sports', async (_request, reply) => {
    const out: Record<string, unknown> = {};
    for (const src of sources) {
      if (!src.isConfigured()) continue;
      out[src.id] = await src.listSports();
    }
    await reply.send({ sports: out });
  });

  app.get('/api/edges', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const rawAge = typeof query['maxAgeMs'] === 'string' ? Number(query['maxAgeMs']) : NaN;
    const fetchOpts = Number.isFinite(rawAge) ? { maxAgeMs: rawAge } : {};

    const active = sources.filter((src) => src.isConfigured());
    if (active.length === 0) {
      await reply.send({ edges: [], sources: [], explanation: 'No price source is available.', skipped: {} });
      return;
    }

    const rows = pricedSelections(ctx.db.handle, {});
    const { markets, incomplete } = assembleMarkets(rows);
    const sides = loadEventSides(ctx, markets.map((m) => m.eventKey));

    const skipped = {
      incompleteMarkets: incomplete.length,
      unmappedLeague: 0,
      noExternalEvent: 0,
      noFairValue: 0,
      unalignedOutcome: 0,
    };
    const notes: string[] = [];
    const edges: unknown[] = [];

    // Fetch each (source, competition) pair at most once per request. Both
    // scraped sources are somebody else's servers and Kambi has already
    // rate-limited us once, so this is politeness, not just efficiency.
    const fetchCache = new Map<string, ExternalEvent[]>();
    const loadEvents = async (sourceId: string, key: string): Promise<ExternalEvent[]> => {
      const cacheKey = `${sourceId}::${key}`;
      const hit = fetchCache.get(cacheKey);
      if (hit) return hit;
      const src = active.find((x) => x.id === sourceId);
      if (!src) return [];
      const result = await src.fetchOdds(key, fetchOpts);
      fetchCache.set(cacheKey, result.events);
      return result.events;
    };

    for (const market of markets) {
      const context = rows.find((r) => r.marketKey === market.marketKey);
      if (!context) continue;

      // Each source answers for itself, so a source added tomorrow is asked
      // without touching this file.
      const side = sides.get(market.eventKey) ?? { home: null, away: null, startTime: null, country: null };
      const competition = {
        sport: context.sport ?? null,
        country: side.country,
        league: context.league ?? null,
      };
      const resolved = new Map<string, string>();
      for (const src of active) {
        const key = src.keyForLeague(competition);
        if (key !== null) resolved.set(src.id, key);
      }
      if (resolved.size === 0) {
        skipped.unmappedLeague += 1;
        continue;
      }

      const books: BookMarket[] = [];
      const matchNotes: string[] = [];
      let matchConfidence = 0;
      // Kept so outcome names can be aligned to whichever source matched.
      let reference: { event: ExternalEvent; swapped: boolean } | null = null;

      for (const [sourceId, key] of resolved) {
        const events = await loadEvents(sourceId, key);
        if (events.length === 0) continue;

        const match = matchEvent(
          {
            eventKey: market.eventKey,
            home: side.home,
            away: side.away,
            startTime: side.startTime ?? context.startTime ?? null,
            sport: context.sport ?? null,
          },
          events.map((e) => ({
            externalId: e.id,
            homeTeam: e.homeTeam,
            awayTeam: e.awayTeam,
            commenceTime: e.commenceTime,
            sportKey: e.sportKey,
          })),
        );
        if (!isMatched(match)) continue;

        const external = events.find((e) => e.id === match.externalId);
        if (!external) continue;

        // Each source names its outcomes after ITS OWN team strings, so they
        // are re-keyed to one source's names before being combined. Without
        // this, "Man Utd" and "Manchester United" would look like different
        // outcomes and the consensus would find nothing in common.
        if (reference === null) reference = { event: external, swapped: match.swapped };
        for (const book of h2hMarkets(external)) {
          const aligned = new Map<string, number>();
          for (const [name, price] of book.prices) {
            const canonical =
              name === external.homeTeam
                ? reference.event.homeTeam
                : name === external.awayTeam
                  ? reference.event.awayTeam
                  : name;
            aligned.set(canonical, price);
          }
          books.push({ ...book, prices: aligned });
        }
        matchConfidence = Math.max(matchConfidence, match.confidence);
        matchNotes.push(`${sourceId}: ${match.reasons[0] ?? 'matched'}`);
      }

      if (books.length === 0 || reference === null) {
        skipped.noExternalEvent += 1;
        continue;
      }

      // Three independent books make a consensus. Failing that, Pinnacle alone
      // stands as a sharp reference - weaker, and the response says so.
      let fair = buildConsensus(books, { exclude: NON_INDEPENDENT_BOOK_KEYS });
      if (!fair.ok) {
        const pinnacle = books.find((b) => b.bookKey === PINNACLE_SOURCE_ID);
        if (pinnacle) fair = buildSharpReference(pinnacle);
      }
      if (!fair.ok) {
        skipped.noFairValue += 1;
        continue;
      }

      for (const outcome of market.outcomes) {
        const name = alignOutcome(outcome.name, side.home, side.away, reference.event, reference.swapped);
        if (name === null) {
          skipped.unalignedOutcome += 1;
          continue;
        }
        const edge = computeEdge({ outcomeName: name, bookOdds: outcome.decimalOdds, consensus: fair.consensus });
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
          fairOdds: edge.edge.consensusFairOdds,
          ev: edge.edge.ev,
          // The tier matters as much as the number: 'strong' is a consensus of
          // independent books, 'moderate' is one sharp book's opinion.
          fairSource: fair.consensus.source,
          strength: edgeStrength(fair.consensus.source),
          books: edge.edge.books,
          contributingBooks: fair.consensus.contributingBooks,
          matchConfidence,
          matchReasons: matchNotes,
          warnings: edge.edge.warnings,
        });
      }
    }

    edges.sort((a, b) => (b as { ev: number }).ev - (a as { ev: number }).ev);

    await reply.send({
      sources: active.map((src) => ({ id: src.id, label: src.label })),
      scanned: { duelMarkets: markets.length },
      skipped,
      notes,
      edges,
      explanation:
        edges.length === 0
          ? 'No edges computed. Most Duel markets are in competitions with no mapped equivalent at any source, ' +
            'or their fixtures did not match confidently. The skipped counts say which.'
          : `Compared ${edges.length} selections out of ${markets.length} priced Duel markets.`,
      caveats: [
        'An edge is an estimate against other books after removing each one\'s margin, not a guaranteed return.',
        'A "moderate" edge rests on Pinnacle alone. It is admissible because Pinnacle is not the book being ' +
          'judged, but it has no redundancy - if Pinnacle is the one that is wrong, nothing here can tell.',
        'A wrong fixture match produces a large and entirely fictional edge. Match confidence and the reasoning ' +
          'are attached to every row so it can be checked.',
        'Nothing here places a bet. Review each one yourself.',
      ],
    });
  });
}
