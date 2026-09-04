/**
 * Normalized bet views.
 *
 * This is the first endpoint that serves the tool's actual subject - other
 * people's bets, named and typed - rather than the raw traffic they arrived in.
 *
 * `/api/bets/stakes` reports a stake distribution. It is deliberately a
 * distribution and not a "whale list": the percentile is a fact about the
 * stake, and any judgement about whether a big bet is a GOOD bet has to come
 * from evidence this endpoint does not have.
 */

import type { FastifyInstance } from 'fastify';
import type { FeedBetFilter } from '../db/db.ts';
import type { ServerContext } from '../index.ts';

function readFilter(query: Record<string, unknown>): FeedBetFilter {
  const str = (k: string, max = 128): string | undefined => {
    const v = query[k];
    return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
  };
  const numeric = (k: string): number | undefined => {
    const v = query[k];
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    sportsbookId: str('sportsbook'),
    bettorKey: str('bettor'),
    type: str('type', 16),
    status: str('status', 16),
    sport: str('sport', 64),
    minStake: numeric('minStake'),
    since: numeric('since'),
    q: str('q', 200),
    limit: numeric('limit'),
    offset: numeric('offset'),
    sort: str('sort', 16),
    dir: str('dir', 8),
  };
}

/** Default stake-distribution window. Long enough to be stable, short enough to reflect now. */
const STAKE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function registerBetRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/bets', async (request, reply) => {
    await reply.send(ctx.db.listFeedBets(readFilter((request.query ?? {}) as Record<string, unknown>)));
  });

  app.get('/api/bets/stakes', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const sportsbook = typeof query['sportsbook'] === 'string' ? query['sportsbook'] : 'duel';
    const windowMs = typeof query['windowMs'] === 'string' ? Number(query['windowMs']) : STAKE_WINDOW_MS;
    const since = Date.now() - (Number.isFinite(windowMs) ? windowMs : STAKE_WINDOW_MS);
    const distribution = ctx.db.stakeDistribution(sportsbook, since);
    await reply.send(
      distribution ?? {
        samples: 0,
        // An explicit note beats an empty object: the caller needs to know the
        // difference between "no big bets" and "no comparable data yet".
        note: 'No USD-denominated bets stored for this window yet, so no stake percentile can be computed.',
      },
    );
  });

  app.get('/api/normalized', async (_request, reply) => {
    await reply.send({ counts: ctx.db.normalizedCounts(), refs: ctx.refs.stats() });
  });

  /**
   * Re-parses stored captures the current parser has not seen. Bounded per call
   * so a backfill over a large database is a series of requests rather than one
   * that ties up the process.
   */
  app.post('/api/backfill', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const raw = typeof body['limit'] === 'number' ? body['limit'] : 500;
    const limit = Math.min(Math.max(Math.trunc(raw), 1), 5000);

    const pending = ctx.db.unparsedCaptures(limit);
    // Dictionaries first: a bet normalized before its market descriptions
    // arrive stores null names, and while the leg backfill does repair that,
    // absorbing first avoids the second write entirely.
    for (const capture of pending) ctx.refs.observe(capture);

    const { normalizeAccepted } = await import('./ingest.ts');
    normalizeAccepted(ctx, pending);

    await reply.send({
      ok: true,
      scanned: pending.length,
      remaining: ctx.db.unparsedCaptures(1).length > 0,
      counts: ctx.db.normalizedCounts(),
      refs: ctx.refs.stats(),
    });
  });
}
