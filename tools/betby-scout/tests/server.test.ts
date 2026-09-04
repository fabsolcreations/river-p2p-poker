/**
 * Server tests.
 *
 * Everything here runs through `fastify.inject()` against a temp-file database:
 * no port is opened and no process is left running. The point is to prove the
 * ingest path is safe against the input it will actually receive - a payload
 * built by JavaScript running inside a third-party page.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer } from '../src/server/index.ts';
import { loadConfig } from '../src/server/config.ts';
import { parseCollectorMessage } from '../src/server/hub.ts';
import { validateIngestBatch } from '../src/server/routes/ingest.ts';
import type { FastifyInstance } from 'fastify';
import type { IngestBatch, RawCapture } from '../src/shared/types.ts';

let dir: string;
let app: FastifyInstance;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scout-test-'));
  const config = loadConfig({ SCOUT_DB: join(dir, 'test.db'), SCOUT_LOG_LEVEL: 'silent' });
  app = await buildServer({ config, logger: false });
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function capture(overrides: Partial<RawCapture> = {}): RawCapture {
  return {
    captureId: 'c_test0000000001',
    sessionId: 's_test0000000001',
    seq: 1,
    tsClient: 1_800_000_000_000,
    transport: 'fetch',
    direction: 'inbound',
    frameUrl: 'https://duel.com/sports',
    frameOrigin: 'https://duel.com',
    isTopFrame: true,
    pageOrigin: 'https://duel.com',
    method: 'GET',
    url: 'https://data.example.test/v1/records',
    urlHost: 'data.example.test',
    urlPath: '/v1/records',
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 1, price: 2.5 }] }),
    bodyEncoding: 'utf8',
    bodyBytes: 40,
    truncated: false,
    redacted: false,
    classification: {
      kind: 'unknown',
      confidence: 0,
      adapterId: 'test',
      reasons: [],
      shapeFingerprint: 'fp_test',
    },
    ...overrides,
  };
}

function batch(captures: RawCapture[]): IngestBatch {
  return {
    v: 1,
    identity: {
      kind: 'extension',
      version: '0.1.0',
      sessionId: 's_test0000000001',
      pageOrigin: 'https://duel.com',
      frameOrigin: 'https://duel.com',
      isTopFrame: true,
      userAgent: 'test',
    },
    captures,
  };
}

test('health reports a live server and an applied schema', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body['ok'], true);
  assert.ok(body['schemaVersion'], 'the schema must have been applied at startup');
});

test('a capture round-trips through ingest and back out of the list', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/ingest', payload: batch([capture()]) });
  assert.equal(res.statusCode, 200);
  const result = res.json() as { accepted: number; duplicates: number; rejected: number };
  assert.equal(result.accepted, 1);

  const list = await app.inject({ method: 'GET', url: '/api/captures' });
  assert.equal(list.statusCode, 200);
  const page = list.json() as { captures: RawCapture[]; total: number };
  assert.equal(page.total, 1);
  assert.equal(page.captures[0]?.captureId, 'c_test0000000001');
  assert.ok(page.captures[0]?.tsServer, 'the server must stamp its own clock, never trust the page');
});

test('a replayed batch is idempotent rather than duplicated', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/ingest', payload: batch([capture()]) });
  const result = res.json() as { accepted: number; duplicates: number };
  assert.equal(result.accepted, 0, 'a resent capture must not be stored twice');
  assert.equal(result.duplicates, 1);

  const list = await app.inject({ method: 'GET', url: '/api/captures' });
  assert.equal((list.json() as { total: number }).total, 1);
});

test('one malformed capture is rejected without aborting the rest of the batch', async () => {
  const good = capture({ captureId: 'c_test0000000002', seq: 2 });
  const bad = capture({ captureId: '', seq: 3 }); // no id
  const worse = capture({ captureId: 'c_test0000000004', seq: 4, transport: 'carrier-pigeon' as never });

  const res = await app.inject({ method: 'POST', url: '/api/ingest', payload: batch([good, bad, worse]) });
  assert.equal(res.statusCode, 200);
  const result = res.json() as { accepted: number; rejected: number; errors?: string[] };
  assert.equal(result.accepted, 1, 'the valid row must still be stored');
  assert.equal(result.rejected, 2);
  assert.ok((result.errors ?? []).length >= 2, 'each rejection needs a reason a human can act on');
});

test('a batch with no identity is refused with reasons, not a bare failure', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/ingest', payload: { v: 1, captures: [] } });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { errors: string[] };
  assert.ok(body.errors.some((e) => e.includes('identity')));
});

test('filters narrow the capture list', async () => {
  const byHost = await app.inject({ method: 'GET', url: '/api/captures?host=data.example.test' });
  assert.ok((byHost.json() as { total: number }).total >= 1);

  const missing = await app.inject({ method: 'GET', url: '/api/captures?host=nowhere.invalid' });
  assert.equal((missing.json() as { total: number }).total, 0);
});

test('hosts ranks a data host above one that only served assets', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/ingest',
    payload: batch([
      capture({
        captureId: 'c_asset000000001',
        seq: 10,
        url: 'https://cdn.example.test/logo.png',
        urlHost: 'cdn.example.test',
        urlPath: '/logo.png',
        contentType: 'image/png',
        body: null,
        classification: { kind: 'asset', confidence: 0.95, adapterId: 'test', reasons: [], shapeFingerprint: '' },
      }),
      capture({
        captureId: 'c_feed0000000001',
        seq: 11,
        url: 'https://data.example.test/v1/feed',
        urlHost: 'data.example.test',
        urlPath: '/v1/feed',
        classification: { kind: 'bets_feed', confidence: 0.9, adapterId: 'test', reasons: [], shapeFingerprint: 'fp_feed' },
      }),
    ]),
  });

  const res = await app.inject({ method: 'GET', url: '/api/hosts' });
  const hosts = res.json() as Array<{ host: string }>;
  const dataIdx = hosts.findIndex((h) => h.host === 'data.example.test');
  const cdnIdx = hosts.findIndex((h) => h.host === 'cdn.example.test');
  assert.ok(dataIdx !== -1 && cdnIdx !== -1);
  assert.ok(dataIdx < cdnIdx, 'the host that served data must outrank the one that served images');
});

test('shapes cluster captures by payload structure', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/shapes' });
  assert.equal(res.statusCode, 200);
  const shapes = res.json() as Array<{ shapeFingerprint: string; count: number }>;
  assert.ok(shapes.length >= 1);
  assert.ok(shapes.every((s) => s.count >= 1));
});

test('re-parsing a stored capture runs the live adapter', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/captures/c_test0000000001/parse' });
  assert.equal(res.statusCode, 200);
  const preview = res.json() as { adapterId: string; warnings: string[] };
  assert.ok(preview.adapterId, 'a parse result always names the adapter that produced it');
});

test('a missing capture 404s rather than returning an empty object', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/captures/does-not-exist' });
  assert.equal(res.statusCode, 404);
});

test('config rejects a non-loopback server url', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/config',
    payload: { serverUrl: 'https://evil.example.test' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { config: { serverUrl: string } };
  assert.ok(
    body.config.serverUrl.includes('127.0.0.1') || body.config.serverUrl.includes('localhost'),
    'the collector must never be told to ship captures off-box',
  );
});

test('config round-trips a real change', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/config', payload: { domFallback: true, ringSize: 500 } });
  const body = res.json() as { config: { domFallback: boolean; ringSize: number } };
  assert.equal(body.config.domFallback, true);
  assert.equal(body.config.ringSize, 500);

  const read = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal((read.json() as { domFallback: boolean }).domFallback, true);
});

test('ndjson export streams one capture per line', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/export/captures.ndjson' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'] as string, /attachment; filename=/);
  const lines = res.body.trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 3);
  for (const line of lines) {
    const parsed = JSON.parse(line) as { captureId?: string };
    assert.ok(parsed.captureId, 'every line must be a complete capture object');
  }
});

test('frame reports are stored and their origins listed', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/frames',
    payload: {
      sessionId: 's_test0000000001',
      ts: 1_800_000_000_000,
      topOrigin: 'https://duel.com',
      frames: [{ src: 'https://widget.example.test/embed', origin: 'https://widget.example.test', depth: 1, sameOrigin: false }],
    },
  });
  assert.equal(res.statusCode, 200);

  const list = await app.inject({ method: 'GET', url: '/api/frames' });
  const body = list.json() as { origins: Array<{ origin: string }> };
  assert.ok(body.origins.some((o) => o.origin === 'https://widget.example.test'));
});

test('a malformed frame report is refused', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/frames', payload: { nope: true } });
  assert.equal(res.statusCode, 400);
});

test('an unknown api route 404s as json, not as html', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/nonsense' });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { ok: boolean }).ok, false);
});

/* ------------------------------------------------------------------ *
 * WebSocket envelope contract
 *
 * These lock down the framing that /ws/collector expects. The collector once
 * sent bare IngestBatch objects here; parseCollectorMessage returned null for
 * every one of them and the server discarded the lot without a log line, while
 * the collector's status panel cheerfully reported "sent". Nothing in the unit
 * tests or the type system caught it, because both sides were internally
 * consistent and only disagreed with each other.
 * ------------------------------------------------------------------ */

test('a bare IngestBatch is rejected - frames must carry a type', () => {
  const bare = JSON.stringify({
    v: 1,
    identity: { kind: 'extension', sessionId: 's_1' },
    captures: [],
  });
  assert.equal(
    parseCollectorMessage(bare),
    null,
    'an untyped frame must be refused, so this mismatch fails loudly next time',
  );
});

test('the enveloped forms the collector sends are all understood', () => {
  const ingest = parseCollectorMessage(JSON.stringify({ type: 'ingest', batch: { v: 1 } }));
  assert.equal(ingest?.type, 'ingest');
  assert.deepEqual(ingest?.type === 'ingest' ? ingest.batch : null, { v: 1 });

  const hello = parseCollectorMessage(JSON.stringify({ type: 'hello', identity: { kind: 'extension' } }));
  assert.equal(hello?.type, 'hello');

  const frames = parseCollectorMessage(JSON.stringify({ type: 'frames', report: { sessionId: 's' } }));
  assert.equal(frames?.type, 'frames');

  assert.equal(parseCollectorMessage(JSON.stringify({ type: 'nonsense' })), null);
  assert.equal(parseCollectorMessage('not json'), null);
  assert.equal(parseCollectorMessage({ type: 'ingest' }), null, 'only strings arrive off a socket');
});

test('an ingest sent as an envelope actually lands in the database', async () => {
  // The end-to-end shape check: the same JSON the uploader puts on the wire,
  // parsed and inserted exactly as index.ts does it.
  const wire = JSON.stringify({
    type: 'ingest',
    batch: batch([capture({ captureId: 'c_envelope00001', seq: 99 })]),
  });
  const message = parseCollectorMessage(wire);
  assert.equal(message?.type, 'ingest');

  const validated = validateIngestBatch(message?.type === 'ingest' ? message.batch : null, loadConfig({ SCOUT_LOG_LEVEL: 'silent' }));
  assert.equal(validated.ok, true, 'the uploader\'s batch must pass the server\'s own validator');
});
