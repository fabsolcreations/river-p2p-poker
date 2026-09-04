/**
 * Aggregate views used for discovery.
 *
 * `/api/hosts` and `/api/shapes` are the two screens that answer the Milestone 1
 * question - "which of this traffic is the bets feed" - without anyone having
 * guessed an endpoint name.
 */

import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../index.ts';

export function registerStatsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/stats', async (_request, reply) => {
    await reply.send(ctx.db.stats());
  });

  app.get('/api/hosts', async (_request, reply) => {
    await reply.send(ctx.db.hosts());
  });

  app.get('/api/shapes', async (request, reply) => {
    const raw = (request.query as Record<string, unknown> | undefined)?.['limit'];
    const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 500) : 100;
    await reply.send(ctx.db.shapes(limit));
  });
}
