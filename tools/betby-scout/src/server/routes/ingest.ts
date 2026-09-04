/**
 * Ingest routes - the only write surface, and the only one reachable from the
 * sportsbook page.
 *
 * Everything arriving here came from JavaScript running inside a third-party
 * page. It is untrusted input in the strongest sense: the collector we wrote is
 * the expected sender, but nothing proves the sender is our collector. So every
 * field is validated before it reaches SQLite, one bad row never aborts a batch,
 * and the server clock always overrides whatever timestamp the page claimed.
 */

import type { FastifyInstance } from 'fastify';
import type { FrameReport, IngestBatch, RawCapture } from '../../shared/types.ts';
import { PROTOCOL_VERSION } from '../../shared/types.ts';
import { toIngestResult } from '../db/db.ts';
import { classifyCapture } from '../../adapters/registry.ts';
import type { ScoutServerConfig } from '../config.ts';
import type { ServerContext } from '../index.ts';

export type BatchValidation =
  | { ok: true; batch: IngestBatch }
  | { ok: false; errors: string[] };

const TRANSPORTS = new Set(['fetch', 'xhr', 'websocket', 'sse', 'dom', 'manual']);
const DIRECTIONS = new Set(['inbound', 'outbound']);
const ENCODINGS = new Set(['utf8', 'base64']);

/** Anything longer is not a field we recognise; it is someone probing. */
const MAX_STRING = 4096;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function shortString(v: unknown, max = MAX_STRING): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

/**
 * Structural validation of a whole batch. Returns errors rather than throwing,
 * because the collector needs to be told what was wrong so it can stop resending
 * it - a silent 400 would have it retry the same bad batch forever.
 */
export function validateIngestBatch(input: unknown, config: ScoutServerConfig): BatchValidation {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['body must be a JSON object'] };

  const v = typeof input['v'] === 'number' ? input['v'] : null;
  if (v === null) errors.push('missing protocol version "v"');
  else if (v > PROTOCOL_VERSION) {
    errors.push(`collector speaks protocol v${v}, server understands v${PROTOCOL_VERSION} - upgrade the server`);
  }

  const identityRaw = input['identity'];
  if (!isObj(identityRaw)) {
    errors.push('missing "identity"');
    return { ok: false, errors };
  }

  const sessionId = shortString(identityRaw['sessionId'], 128);
  if (!sessionId) errors.push('identity.sessionId is missing or too long');

  const kind = identityRaw['kind'];
  if (kind !== 'extension' && kind !== 'userscript') {
    errors.push('identity.kind must be "extension" or "userscript"');
  }

  const capturesRaw = input['captures'];
  if (!Array.isArray(capturesRaw)) {
    errors.push('"captures" must be an array');
    return { ok: false, errors };
  }
  if (capturesRaw.length > 5000) {
    errors.push(`batch of ${capturesRaw.length} captures exceeds the 5000 per-batch limit`);
  }

  if (errors.length) return { ok: false, errors };

  const identity: IngestBatch['identity'] = {
    kind: kind as 'extension' | 'userscript',
    version: shortString(identityRaw['version'], 32) ?? '0',
    sessionId: sessionId as string,
    pageOrigin: shortString(identityRaw['pageOrigin'], 512) ?? '',
    frameOrigin: shortString(identityRaw['frameOrigin'], 512) ?? '',
    isTopFrame: identityRaw['isTopFrame'] === true,
    userAgent: shortString(identityRaw['userAgent'], 512) ?? '',
  };

  // Per-capture validation happens in db.insertCaptures, which reports each
  // rejection with its batch index. Here we only enforce that the elements are
  // objects at all, so the db layer never sees a primitive.
  const captures = capturesRaw.filter(isObj) as unknown as RawCapture[];

  return {
    ok: true,
    batch: {
      v: v ?? PROTOCOL_VERSION,
      identity,
      captures,
      dropped: typeof input['dropped'] === 'number' ? input['dropped'] : 0,
    },
  };
}

/**
 * Frame reports are how we discover which host actually serves the BETBY
 * widget. They are small and low-risk, but still capped: a page could otherwise
 * report ten thousand iframes.
 */
export function validateFrameReport(input: unknown): FrameReport | null {
  if (!isObj(input)) return null;
  const sessionId = shortString(input['sessionId'], 128);
  const topOrigin = shortString(input['topOrigin'], 512);
  if (!sessionId || topOrigin === null) return null;

  const framesRaw = Array.isArray(input['frames']) ? input['frames'] : [];
  const frames: FrameReport['frames'] = [];
  for (const f of framesRaw.slice(0, 200)) {
    if (!isObj(f)) continue;
    const src = shortString(f['src'], 2048);
    const origin = shortString(f['origin'], 512);
    if (src === null || origin === null) continue;
    frames.push({
      src,
      origin,
      depth: typeof f['depth'] === 'number' && Number.isFinite(f['depth']) ? Math.trunc(f['depth']) : 0,
      sameOrigin: f['sameOrigin'] === true,
    });
  }

  const ts = typeof input['ts'] === 'number' && Number.isFinite(input['ts']) ? input['ts'] : Date.now();
  return { sessionId, ts, topOrigin, frames };
}

/**
 * Bodies above this are left with the collector's verdict. Re-classifying a
 * multi-megabyte payload on the ingest path would stall the request for every
 * other capture in the batch, and the panel's in-page verdict is no worse.
 */
const MAX_RECLASSIFY_BYTES = 4_000_000;

/**
 * Replaces each capture's classification with the server's own, in place.
 * Never throws: classifyCapture is already total, but a malformed row that
 * slipped past validation must not take down an entire batch of good ones.
 */
export function reclassify(batch: IngestBatch): number {
  let changed = 0;
  for (const capture of batch.captures) {
    if (typeof capture?.captureId !== 'string') continue;
    if (typeof capture.bodyBytes === 'number' && capture.bodyBytes > MAX_RECLASSIFY_BYTES) continue;
    try {
      const verdict = classifyCapture(capture);
      // Keep the collector's verdict if ours is strictly less informative -
      // the page saw the live response, we only see what survived the wire.
      const incoming = capture.classification;
      if (verdict.kind === 'unknown' && incoming && incoming.kind !== 'unknown') continue;
      capture.classification = verdict;
      changed += 1;
    } catch {
      // Leave the incoming verdict in place.
    }
  }
  return changed;
}

export function registerIngestRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, hub, config, refs } = ctx;

  app.post('/api/ingest', async (request, reply) => {
    const validated = validateIngestBatch(request.body, config);
    if (!validated.ok) {
      // 400 with reasons, not a bare failure: the collector logs these into its
      // own status panel so the user can see why nothing is arriving.
      await reply.code(400).send({ ok: false, accepted: 0, duplicates: 0, rejected: 0, errors: validated.errors });
      return;
    }

    // Re-classify with the server's own adapters before storing.
    //
    // The incoming verdict was produced in the page by whatever collector build
    // is installed there, which drifts behind the server as adapters improve.
    // Left alone it produces a genuinely confusing UI: the capture table shows
    // the stored kind while the detail pane re-parses and shows a different one,
    // so the same row reads "Unknown" in the list and "Bets feed" when opened.
    // The server has the newer adapters, so it is the authority.
    reclassify(validated.batch);

    const stored = db.insertCaptures(validated.batch, Date.now());
    // Absorb any dictionary payloads before broadcasting, so a dashboard that
    // re-parses on the back of this event already sees the new names.
    for (const capture of stored.accepted) refs.observe(capture);
    hub.broadcastCaptures(stored.accepted);

    await reply.send(toIngestResult(stored));
  });

  app.post('/api/frames', async (request, reply) => {
    const report = validateFrameReport(request.body);
    if (report === null) {
      await reply.code(400).send({ ok: false, error: 'malformed frame report' });
      return;
    }
    const result = db.insertFrames(report, Date.now());
    hub.broadcastFrames(report);
    await reply.send({ ok: true, ...result });
  });
}

/** Also exported so `validateIngestBatch`'s shape can be asserted in tests. */
export { ENCODINGS as INGEST_BODY_ENCODINGS, TRANSPORTS as INGEST_TRANSPORTS, DIRECTIONS as INGEST_DIRECTIONS };
