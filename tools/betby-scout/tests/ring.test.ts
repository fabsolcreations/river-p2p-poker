/**
 * Ring buffer tests.
 *
 * The ring is the only thing standing between a busy live feed and the tab's
 * memory, and it is also the hand-off point to the uploader. Two properties
 * matter: it is genuinely bounded, and a capture is never sent twice or lost
 * when a flush fails. Both are easy to get subtly wrong and impossible to
 * notice in normal use.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CaptureRing } from '../src/collector/core/ring.ts';
import type { RawCapture } from '../src/shared/types.ts';

/**
 * Ids and urls are zero-padded to a fixed width so that two captures built with
 * the same bodyLen really are the same size. Without that, `c_9` and `c_10`
 * differ by a byte and the byte-accounting assertion below measures the fixture
 * rather than the ring.
 */
const pad = (n: number): string => String(n).padStart(4, '0');

function cap(n: number, bodyLen = 10): RawCapture {
  return {
    captureId: `c_${pad(n)}`,
    sessionId: 's_1',
    seq: n,
    tsClient: 1_800_000_000_000 + n,
    transport: 'fetch',
    direction: 'inbound',
    frameUrl: 'https://duel.com/',
    frameOrigin: 'https://duel.com',
    isTopFrame: true,
    pageOrigin: 'https://duel.com',
    url: `https://x.test/${pad(n)}`,
    urlHost: 'x.test',
    urlPath: `/${pad(n)}`,
    body: 'x'.repeat(bodyLen),
    bodyEncoding: 'utf8',
    bodyBytes: bodyLen,
    truncated: false,
    redacted: false,
    classification: { kind: 'unknown', confidence: 0, adapterId: 't', reasons: [], shapeFingerprint: '' },
  };
}

test('overflow evicts the oldest and counts the loss instead of hiding it', () => {
  const ring = new CaptureRing(3);
  for (let i = 1; i <= 5; i++) ring.push(cap(i));

  const stats = ring.stats();
  assert.equal(stats.size, 3);
  assert.equal(stats.dropped, 2, 'dropped captures must be counted, never silently forgotten');
  assert.equal(stats.totalPushed, 5);

  const ids = ring.list().map((c) => c.captureId);
  assert.deepEqual(ids, ['c_0003', 'c_0004', 'c_0005'], 'FIFO: the oldest goes first');
  assert.equal(ring.get('c_0001'), undefined);
});

test('byte accounting follows eviction rather than growing forever', () => {
  // The ring measures its real footprint (url + ids + body + headers), not just
  // body length, so the assertion is on the invariant rather than a literal:
  // a full ring holding N same-sized captures must not grow as more arrive.
  const ring = new CaptureRing(2);
  ring.push(cap(1, 100));
  ring.push(cap(2, 100));
  const full = ring.stats().bytes;
  assert.ok(full >= 200, 'body bytes must at least be counted');

  for (let i = 3; i <= 20; i++) ring.push(cap(i, 100));
  assert.equal(ring.stats().size, 2);
  assert.equal(ring.stats().bytes, full, 'eviction must subtract exactly what insertion added');

  // And a bigger body really does register as bigger.
  const wide = new CaptureRing(2);
  wide.push(cap(1, 1000));
  wide.push(cap(2, 1000));
  assert.ok(wide.stats().bytes > full);
});

test('shrinking the capacity evicts down to the new bound immediately', () => {
  const ring = new CaptureRing(10);
  for (let i = 1; i <= 10; i++) ring.push(cap(i));
  ring.setCapacity(4);
  assert.equal(ring.stats().size, 4);
  assert.deepEqual(ring.list().map((c) => c.captureId), ['c_0007', 'c_0008', 'c_0009', 'c_0010']);
});

test('a failed upload returns the same captures rather than losing them', () => {
  const ring = new CaptureRing(10);
  for (let i = 1; i <= 5; i++) ring.push(cap(i));

  const first = ring.takeForUpload(3);
  assert.equal(first.length, 3);

  // While those are in flight, a second flush must not pick them up again.
  const second = ring.takeForUpload(10);
  assert.deepEqual(second.map((c) => c.captureId), ['c_0004', 'c_0005'], 'in-flight captures must not be sent twice');

  // The first batch failed: nack returns it to the pending pool.
  ring.nackUpload(first.map((c) => c.captureId));
  const retry = ring.takeForUpload(10);
  assert.deepEqual(retry.map((c) => c.captureId), ['c_0001', 'c_0002', 'c_0003'], 'a failed batch must come back intact');
});

test('an acknowledged upload is not offered again', () => {
  const ring = new CaptureRing(10);
  for (let i = 1; i <= 3; i++) ring.push(cap(i));

  const batch = ring.takeForUpload(10);
  ring.ackUpload(batch.map((c) => c.captureId));
  assert.deepEqual(ring.takeForUpload(10), []);

  // Acked captures stay readable in the panel - upload state is not retention.
  assert.equal(ring.list().length, 3);
});

test('subscribers see every push and stop after unsubscribing', () => {
  const ring = new CaptureRing(10);
  const seen: string[] = [];
  const off = ring.subscribe((c) => seen.push(c.captureId));

  ring.push(cap(1));
  ring.push(cap(2));
  off();
  ring.push(cap(3));

  assert.deepEqual(seen, ['c_0001', 'c_0002']);
});

test('a throwing subscriber cannot break the ring or the other subscribers', () => {
  const ring = new CaptureRing(10);
  const seen: string[] = [];
  ring.subscribe(() => {
    throw new Error('subscriber blew up');
  });
  ring.subscribe((c) => seen.push(c.captureId));

  // This runs inside a page hook: an exception escaping here would surface as a
  // broken sportsbook.
  ring.push(cap(1));
  assert.deepEqual(seen, ['c_0001']);
  assert.equal(ring.stats().size, 1);
});

test('clear resets contents but keeps the lifetime counters honest', () => {
  const ring = new CaptureRing(2);
  for (let i = 1; i <= 4; i++) ring.push(cap(i));
  const before = ring.stats();
  ring.clear();
  const after = ring.stats();

  assert.equal(after.size, 0);
  assert.equal(after.bytes, 0);
  assert.equal(after.totalPushed, before.totalPushed, 'clearing the view must not rewrite what happened');
});

test('filtering returns only matching captures', () => {
  const ring = new CaptureRing(10);
  ring.push(cap(1));
  ring.push(cap(2));
  assert.equal(ring.list((c) => c.captureId === 'c_0002').length, 1);
});
