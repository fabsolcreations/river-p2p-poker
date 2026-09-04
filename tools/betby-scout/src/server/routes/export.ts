/**
 * Export routes.
 *
 * NDJSON is streamed a page at a time rather than assembled in memory: a few
 * hours of a live bets feed is hundreds of megabytes, and buffering that to
 * build one JSON array would take the server down at exactly the moment the
 * user has finally captured something worth keeping.
 *
 * The JSON variant exists because it is easier to paste into a tool, and it is
 * therefore capped - if you want everything, take the NDJSON.
 */

import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { CaptureFilter } from '../db/db.ts';
import type { ServerContext } from '../index.ts';

const PAGE = 500;
/** Cap for the array-shaped export only. NDJSON is unbounded. */
const JSON_MAX = 5000;

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
  return {
    kind: str('kind'),
    host: str('host'),
    transport: str('transport'),
    direction: str('direction'),
    session: str('session'),
    shape: str('shape'),
    since: int('since'),
    until: int('until'),
    q: str('q', 512),
  };
}

function stamp(): string {
  // Filename only - a plain sortable stamp, no locale surprises.
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function registerExportRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db } = ctx;

  app.get('/api/export/captures.ndjson', async (request, reply) => {
    const filter = readFilter((request.query ?? {}) as Record<string, unknown>);

    // A generator keeps exactly one page resident at a time.
    async function* rows(): AsyncGenerator<string> {
      let offset = 0;
      for (;;) {
        const page = db.listCaptures({ ...filter, limit: PAGE, offset, sort: 'ts_server', dir: 'asc' });
        if (page.captures.length === 0) return;
        for (const capture of page.captures) yield `${JSON.stringify(capture)}\n`;
        offset += page.captures.length;
        if (offset >= page.total) return;
      }
    }

    await reply
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header('content-disposition', `attachment; filename="betby-scout-captures-${stamp()}.ndjson"`)
      .send(Readable.from(rows()));
  });

  app.get('/api/export/captures.json', async (request, reply) => {
    const filter = readFilter((request.query ?? {}) as Record<string, unknown>);
    const page = db.listCaptures({ ...filter, limit: JSON_MAX, offset: 0, sort: 'ts_server', dir: 'asc' });
    await reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="betby-scout-captures-${stamp()}.json"`)
      .send({
        exportedAt: Date.now(),
        // Stated explicitly so a truncated export is never mistaken for a
        // complete one.
        truncated: page.total > page.captures.length,
        returned: page.captures.length,
        total: page.total,
        captures: page.captures,
      });
  });

  app.get('/api/export/frames.json', async (_request, reply) => {
    await reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="betby-scout-frames-${stamp()}.json"`)
      .send({ exportedAt: Date.now(), origins: db.listFrameOrigins(), reports: db.listFrameReports(500) });
  });
}
