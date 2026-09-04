/**
 * Reference-data store.
 *
 * A bets-feed row names nothing - it is ids and a specifier string. The names
 * live in two other payloads the sportsbook page also fetches: the market
 * descriptions and the prematch/live event tree. This store watches everything
 * that arrives, keeps the dictionary payloads, and hands the merged result to
 * the parser so a leg comes out as "Real Madrid, 1x2, LaLiga" rather than
 * "market 1, outcome 3, event 2705810434275024913".
 *
 * How a payload is recognised: by trying to parse it. `parseMarketDescriptions`
 * and `parseEventTree` return null for anything that is not their shape, so
 * they are their own discriminator. That is deliberate - it means the store
 * does not depend on the classifier having labelled the capture correctly, and
 * it keeps the whole system shape-first.
 *
 * The store is a cache, not a source of truth. Everything in it is rebuilt from
 * `raw_captures`, which is append-only and kept forever, so losing it costs a
 * rebuild and nothing else.
 */

import {
  emptyReference,
  mergeReference,
  parseEventTree,
  parseMarketDescriptions,
  referenceSize,
  type BetbyReference,
} from '../adapters/betby/dictionary.ts';
import type { RawCapture } from '../shared/types.ts';
import type { ScoutDb } from './db/db.ts';

/**
 * How many stored captures to scan on boot. Dictionary payloads are large and
 * infrequent, so the recent window is where they are; scanning the whole table
 * would read hundreds of megabytes to find a handful of rows.
 */
const HYDRATE_LIMIT = 400;

/** Bodies larger than this are skipped during hydration to bound boot time. */
const MAX_HYDRATE_BODY = 8_000_000;

export interface ReferenceStats {
  markets: number;
  events: number;
  sports: number;
  tournaments: number;
  /** Captures that contributed, by payload kind. */
  absorbed: { marketDescriptions: number; eventTrees: number };
  lastUpdated: number | null;
}

export class ReferenceStore {
  private ref: BetbyReference = emptyReference();
  private absorbed = { marketDescriptions: 0, eventTrees: 0 };
  private lastUpdated: number | null = null;
  /** Shape fingerprints already folded in, so a re-poll is not re-parsed. */
  private readonly seen = new Set<string>();

  private readonly db: ScoutDb;

  // Written out rather than declared as a constructor parameter property:
  // `node --experimental-strip-types` removes types without transforming, and a
  // parameter property is syntax it cannot strip. The whole test suite runs
  // under that flag.
  constructor(db: ScoutDb) {
    this.db = db;
  }

  get(): BetbyReference {
    return this.ref;
  }

  stats(): ReferenceStats {
    return { ...referenceSize(this.ref), absorbed: { ...this.absorbed }, lastUpdated: this.lastUpdated };
  }

  /**
   * Folds one capture in if it is a dictionary payload. Returns true when it
   * contributed. Safe to call on every capture - the parsers reject anything
   * that is not their shape.
   */
  observe(capture: RawCapture): boolean {
    if (capture.body === null || capture.bodyEncoding !== 'utf8') return false;
    // A truncated dictionary is worse than none: it would half-populate the
    // lookup and produce names for some legs and not others, with no way to
    // tell which. Refuse it.
    if (capture.truncated) return false;
    if (capture.bodyBytes > MAX_HYDRATE_BODY) return false;

    // Both dictionaries are JSON objects, so anything else is out immediately.
    // Note what this does NOT do: scan the head of the string for a marker key.
    // That was the first attempt and it silently failed on real data - a market
    // description leads with a several-KB `order` block, so "variants" sits far
    // beyond any sane window, and the event tree's "events" key comes after all
    // 60 sports, 141 categories and 214 tournaments. Both dictionaries went
    // unrecognised and every leg stayed unnamed for no visible reason.
    if (capture.body.charCodeAt(0) !== 0x7b /* { */) return false;

    let json: unknown;
    try {
      json = JSON.parse(capture.body) as unknown;
    } catch {
      return false;
    }

    // The parsers are their own discriminator: each returns null for anything
    // that is not its shape, so trying both is the check.
    let contributed = false;

    const tree = parseEventTree(json);
    if (tree) {
      mergeReference(this.ref, tree);
      this.absorbed.eventTrees += 1;
      contributed = true;
    } else {
      const markets = parseMarketDescriptions(json);
      if (markets) {
        mergeReference(this.ref, { markets });
        this.absorbed.marketDescriptions += 1;
        contributed = true;
      }
    }

    if (contributed) {
      this.lastUpdated = Date.now();
      if (capture.classification.shapeFingerprint) this.seen.add(capture.classification.shapeFingerprint);
    }
    return contributed;
  }

  /**
   * Rebuilds from stored captures. Called at boot; the dictionaries are
   * otherwise only as good as what has arrived since the process started, which
   * would mean every restart briefly un-names every leg.
   */
  hydrate(): ReferenceStats {
    // Newest first: a later poll of the same endpoint supersedes an earlier one,
    // and merge is last-write-wins, so we walk oldest-to-newest after slicing.
    const page = this.db.listCaptures({ limit: HYDRATE_LIMIT, offset: 0, sort: 'ts_server', dir: 'desc' });
    const ordered = [...page.captures].reverse();
    for (const summary of ordered) {
      // listCaptures may elide large bodies; fetch the full row before parsing.
      const full = summary.body === null ? this.db.getCapture(summary.captureId) : summary;
      if (full) this.observe(full);
    }
    return this.stats();
  }
}
