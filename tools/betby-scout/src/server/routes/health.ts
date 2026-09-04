/**
 * Liveness and self-description.
 *
 * Deliberately verbose: when nothing is arriving, this is the first thing the
 * user checks, and "is the server even holding the database I think it is"
 * needs a straight answer.
 */

import type { FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION } from '../../shared/types.ts';
import type { ServerContext } from '../index.ts';

export function registerHealthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/health', async (_request, reply) => {
    const stats = ctx.db.stats();
    await reply.send({
      ok: true,
      version: ctx.version,
      protocol: PROTOCOL_VERSION,
      schemaVersion: ctx.db.getMeta('schema_version'),
      startedAt: ctx.startedAt,
      uptimeMs: Date.now() - ctx.startedAt,
      dbPath: ctx.config.dbPath,
      retentionDays: ctx.config.retentionDays,
      maxBodyBytes: ctx.config.maxBodyBytes,
      captures: stats.total,
      lastCaptureTs: stats.lastCaptureTs,
      collectors: ctx.hub.counts(),
      warnings: ctx.config.warnings,
    });
  });
}
