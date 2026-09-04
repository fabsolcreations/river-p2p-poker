/**
 * Bounded in-page capture buffer.
 *
 * This is the only thing standing between "we recorded the traffic" and "the
 * tab used 4GB and the user closed it", so every rule here exists to bound
 * memory without ever losing a fact silently:
 *
 * - Overflow evicts the oldest entry and *counts* it. A drop that nobody knows
 *   about looks exactly like an endpoint that never fired, which is the single
 *   most misleading failure this tool can have (CONTRACT.md: "Drop counts are
 *   reported, never hidden").
 * - Upload is a state machine on the entry, not a queue of its own. Two flushes
 *   can overlap - a timer tick and a manual "flush now" - and a plain
 *   take-from-the-front queue would send the same captures twice.
 * - Entries stay in the buffer after a successful upload. The panel lists from
 *   here, the NDJSON export reads from here, and both must keep working with
 *   the server switched off.
 *
 * Insertion order is FIFO and is provided by Map iteration order, which is
 * specified as insertion order for string keys. Using a Map (rather than an
 * array plus an index) makes get(id), ack and nack O(1) without a second index
 * that could drift out of sync with the array.
 */

import type { RawCapture } from '../../shared/types.ts';

export interface RingStats {
  size: number;
  dropped: number;
  totalPushed: number;
  bytes: number;
}

/**
 * pending  - never handed to the uploader
 * inflight - handed out by takeForUpload, not yet acked or nacked
 * sent     - the server confirmed it; kept for display/export only
 */
type UploadState = 'pending' | 'inflight' | 'sent';

interface Entry {
  capture: RawCapture;
  state: UploadState;
  /**
   * Retained footprint of this entry, in UTF-16 code units of the strings we
   * actually hold. This is a memory proxy, deliberately not the wire size:
   * `RawCapture.bodyBytes` carries the true pre-truncation byte count, and
   * mixing the two would let a truncated 40MB response claim 40MB of buffer.
   */
  bytes: number;
}

function entryBytes(c: RawCapture): number {
  let n = c.url.length + c.captureId.length + c.sessionId.length;
  if (c.body !== null) n += c.body.length;
  if (typeof c.reqBody === 'string') n += c.reqBody.length;
  if (c.error) n += c.error.length;
  for (const headers of [c.reqHeaders, c.resHeaders]) {
    if (!headers) continue;
    for (const [k, v] of Object.entries(headers)) n += k.length + v.length;
  }
  for (const r of c.classification.reasons) n += r.length;
  return n;
}

export class CaptureRing {
  private entries = new Map<string, Entry>();
  private capacity: number;
  private droppedCount = 0;
  private pushedCount = 0;
  private byteTotal = 0;
  private subscribers = new Set<(c: RawCapture) => void>();

  constructor(capacity: number) {
    this.capacity = CaptureRing.sanitizeCapacity(capacity);
  }

  /**
   * A capacity of 0 (or a NaN from a hand-edited config) would evict every
   * capture the moment it arrived and report a drop for each - technically
   * honest, practically a broken collector. Clamp to at least one entry.
   */
  private static sanitizeCapacity(n: number): number {
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.floor(n));
  }

  setCapacity(n: number): void {
    this.capacity = CaptureRing.sanitizeCapacity(n);
    this.evictToCapacity();
  }

  push(c: RawCapture): void {
    // A duplicate captureId means the same (sessionId, seq) pair was emitted
    // twice, which would corrupt the seq-gap accounting the dashboard uses to
    // detect loss. Keep the first and count the second as a drop rather than
    // overwriting, so the anomaly is visible.
    if (this.entries.has(c.captureId)) {
      this.droppedCount++;
      return;
    }

    const bytes = entryBytes(c);
    this.entries.set(c.captureId, { capture: c, state: 'pending', bytes });
    this.byteTotal += bytes;
    this.pushedCount++;
    this.evictToCapacity();

    // Subscriber failures are the panel's problem, never the collector's: a
    // throwing renderer must not stop us recording the next capture.
    for (const fn of this.subscribers) {
      try {
        fn(c);
      } catch {
        /* ignore - a broken subscriber cannot be allowed to break capture */
      }
    }
  }

  private evictToCapacity(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      const key = oldest.value;
      const entry = this.entries.get(key);
      this.entries.delete(key);
      if (!entry) continue;
      this.byteTotal -= entry.bytes;
      // Only unacknowledged entries count as lost. Evicting something the
      // server already has loses nothing, and reporting it as dropped would
      // raise a false data-loss alarm on every long session.
      if (entry.state !== 'sent') this.droppedCount++;
    }
    if (this.byteTotal < 0) this.byteTotal = 0;
  }

  list(filter?: (c: RawCapture) => boolean): RawCapture[] {
    const out: RawCapture[] = [];
    for (const entry of this.entries.values()) {
      if (filter) {
        // A filter written by the panel runs over untrusted capture bodies; if
        // it throws we drop that row from the view rather than the whole list.
        let keep = false;
        try {
          keep = filter(entry.capture);
        } catch {
          keep = false;
        }
        if (!keep) continue;
      }
      out.push(entry.capture);
    }
    return out;
  }

  get(id: string): RawCapture | undefined {
    return this.entries.get(id)?.capture;
  }

  /**
   * Hands out up to `max` pending captures, oldest first, and marks them
   * in-flight so an overlapping flush cannot pick them up again. Every id
   * returned here must eventually reach ackUpload or nackUpload, or those
   * captures stay in-flight until they are evicted.
   */
  takeForUpload(max: number): RawCapture[] {
    if (!Number.isFinite(max) || max <= 0) return [];
    const out: RawCapture[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state !== 'pending') continue;
      entry.state = 'inflight';
      out.push(entry.capture);
      if (out.length >= max) break;
    }
    return out;
  }

  ackUpload(ids: string[]): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      // A missing id is normal: the entry can be evicted while its batch is in
      // flight. It was already counted as dropped at eviction time.
      if (entry) entry.state = 'sent';
    }
  }

  nackUpload(ids: string[]): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      // Only in-flight entries go back to pending. A 'sent' entry that a caller
      // nacks by mistake must not be resent.
      if (entry && entry.state === 'inflight') entry.state = 'pending';
    }
  }

  clear(): void {
    this.entries.clear();
    this.byteTotal = 0;
    // droppedCount and pushedCount survive a clear on purpose: they describe
    // the session, not the current contents, and resetting them would erase
    // evidence of loss.
  }

  stats(): RingStats {
    return {
      size: this.entries.size,
      dropped: this.droppedCount,
      totalPushed: this.pushedCount,
      bytes: this.byteTotal,
    };
  }

  subscribe(fn: (c: RawCapture) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}
