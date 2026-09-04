/**
 * Capture read routes.
 *
 * `/api/captures/:id/parse` is the one that matters during reverse
 * engineering: it re-runs the current adapter over a stored payload, so an
 * adapter improvement can be tested against traffic captured hours ago without
 * going back to the sportsbook. Captures are the raw record; parsing is a view
 * over them, and the two must never be conflated.
 */

import type { FastifyInstance } from 'fastify';
import type { CaptureFilter } from '../db/db.ts';
import { parseCapture } from '../../adapters/registry.ts';
import type { ServerContext } from '../index.ts';

/** Sort keys the caller may choose. Anything else is ignored, never interpolated. */
const SORTS = new Set(['ts_server', 'ts_client', 'body_bytes', 'confidence', 'seq']);

function readFilter(query: Record<string, unknown>): CaptureFilter {
  const str = (k: string, max = 256): string | undefined => {
    const v = query[k];
    return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
  };
  const int = (k: string): number | undefined => {
    const v = query[k];
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  };

  const sort = str('sort');
  const dir = str('dir');

  return {
    limit: Math.min(Math.max(int('limit') ?? 100, 1), 1000),
    offset: Math.max(int('offset') ?? 0, 0),
    kind: str('kind'),
    host: str('host'),
    transport: str('transport'),
    direction: str('direction'),
    session: str('session'),
    shape: str('shape'),
    since: int('since'),
    until: int('until'),
    q: str('q', 512),
    sort: sort && SORTS.has(sort) ? sort : undefined,
    dir: dir === 'asc' || dir === 'desc' ? dir : undefined,
  };
}

export function registerCaptureRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db } = ctx;

  app.get('/api/captures', async (request, reply) => {
    const page = db.listCaptures(readFilter((request.query ?? {}) as Record<string, unknown>));
    await reply.send(page);
  });

  app.get<{ Params: { id: string } }>('/api/captures/:id', async (request, reply) => {
    const capture = db.getCapture(request.params.id);
    if (!capture) {
      await reply.code(404).send({ ok: false, error: `no capture ${request.params.id}` });
      return;
    }
    await reply.send(capture);
  });

  app.get<{ Params: { id: string } }>('/api/captures/:id/parse', async (request, reply) => {
    const capture = db.getCapture(request.params.id);
    if (!capture) {
      await reply.code(404).send({ ok: false, error: `no capture ${request.params.id}` });
      return;
    }
    // `now` is passed explicitly so a re-parse of an old capture produces odds
    // snapshots stamped at re-parse time, which is the truth: we are observing
    // the price now, from a record made then. `refs` carries the market/event
    // dictionaries, which is what turns a leg's ids into names.
    await reply.send(parseCapture(capture, Date.now(), ctx.refs.get()));
  });

  app.get('/api/refs', async (_request, reply) => {
    // What the name resolution currently knows. Empty counts here explain an
    // unnamed leg better than the leg itself can.
    await reply.send(ctx.refs.stats());
  });

  app.get('/api/sessions', async (_request, reply) => {
    await reply.send(db.sessions());
  });

  app.get('/api/frames', async (_request, reply) => {
    await reply.send({ origins: db.listFrameOrigins(), reports: db.listFrameReports(50) });
  });
}
