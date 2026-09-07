/**
 * The Odds API (the-odds-api.com) - the first independent price source.
 *
 * Chosen because its free tier needs no payment and returns decimal odds from
 * many books at once, which is exactly the shape a consensus needs. Endpoint
 * and response shape were read from the published v4 docs, not guessed.
 *
 * QUOTA IS THE BINDING CONSTRAINT. The free tier is 500 credits a month - about
 * 16 a day - and one /odds call costs (markets x regions) credits. That budget
 * shapes every decision here:
 *
 *   - Nothing polls. A fetch happens only when something asks for one.
 *   - Every response is cached, and a cached copy inside maxAgeMs is returned
 *     without spending anything.
 *   - The quota headers are read back and surfaced, so the dashboard can show
 *     what is left rather than discovering the limit by hitting it.
 *   - One region and one market by default. Asking for three regions triples
 *     the cost for prices that mostly agree.
 *
 * The API key is read from the environment and never written to disk by this
 * module. Scout does not store sportsbook credentials, and this is not an
 * exception - it is a read-only key for a public odds service, kept the same way.
 */

import { resolveSportKey } from './sport-keys.ts';
import type {
  Competition,
  ExternalBook,
  ExternalEvent,
  ExternalMarket,
  ExternalOddsSource,
  ExternalOutcome,
  FetchResult,
  QuotaStatus,
  SourceStatus,
} from './types.ts';

export const SOURCE_ID = 'the-odds-api';
const BASE = 'https://api.the-odds-api.com/v4';

/**
 * Default cache window. Prematch prices do not move fast enough to justify
 * spending a credit more often than this on a 16-a-day budget.
 */
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

export interface TheOddsApiOptions {
  apiKey?: string | null;
  /** Bookmaker regions. One by default - each extra region multiplies the cost. */
  regions?: string;
  /** Markets. One by default, for the same reason. */
  markets?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CacheEntry {
  fetchedAt: number;
  events: ExternalEvent[];
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isoToMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Maps one API event. Anything malformed is dropped rather than defaulted -
 * a price we cannot read must not become a price we invented.
 */
function toEvent(raw: unknown): ExternalEvent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id = typeof r['id'] === 'string' ? r['id'] : null;
  const home = typeof r['home_team'] === 'string' ? r['home_team'] : null;
  const away = typeof r['away_team'] === 'string' ? r['away_team'] : null;
  const commence = isoToMs(r['commence_time']) ?? num(r['commence_time']);
  if (id === null || home === null || away === null || commence === null) return null;

  const books: ExternalBook[] = [];
  const bookmakers = Array.isArray(r['bookmakers']) ? r['bookmakers'] : [];
  for (const b of bookmakers) {
    if (b === null || typeof b !== 'object') continue;
    const bk = b as Record<string, unknown>;
    const key = typeof bk['key'] === 'string' ? bk['key'] : null;
    if (key === null) continue;

    const markets: ExternalMarket[] = [];
    const rawMarkets = Array.isArray(bk['markets']) ? bk['markets'] : [];
    for (const m of rawMarkets) {
      if (m === null || typeof m !== 'object') continue;
      const mk = m as Record<string, unknown>;
      const mKey = typeof mk['key'] === 'string' ? mk['key'] : null;
      if (mKey === null) continue;

      const outcomes: ExternalOutcome[] = [];
      const rawOutcomes = Array.isArray(mk['outcomes']) ? mk['outcomes'] : [];
      for (const o of rawOutcomes) {
        if (o === null || typeof o !== 'object') continue;
        const ok = o as Record<string, unknown>;
        const name = typeof ok['name'] === 'string' ? ok['name'] : null;
        const price = num(ok['price']);
        // The request always asks for decimal, so a price at or below 1 is a
        // format mismatch rather than a real quote.
        if (name === null || price === null || price <= 1) continue;
        outcomes.push({ name, decimalOdds: price, point: num(ok['point']) });
      }
      if (outcomes.length > 0) markets.push({ key: mKey, outcomes });
    }

    if (markets.length > 0) {
      books.push({
        key,
        title: typeof bk['title'] === 'string' ? bk['title'] : key,
        lastUpdate: isoToMs(bk['last_update']),
        markets,
      });
    }
  }

  return {
    id,
    sourceId: SOURCE_ID,
    sportKey: typeof r['sport_key'] === 'string' ? r['sport_key'] : '',
    sportTitle: typeof r['sport_title'] === 'string' ? r['sport_title'] : '',
    commenceTime: commence,
    homeTeam: home,
    awayTeam: away,
    books,
  };
}

export class TheOddsApiSource implements ExternalOddsSource {
  readonly id = SOURCE_ID;
  readonly label = 'The Odds API';

  private readonly apiKey: string | null;
  private readonly regions: string;
  private readonly markets: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  private quota: QuotaStatus = { remaining: null, used: null, lastCost: null };
  private lastFetchAt: number | null = null;
  private lastError: string | null = null;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: TheOddsApiOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env['ODDS_API_KEY'] ?? null;
    this.regions = opts.regions ?? process.env['ODDS_API_REGIONS'] ?? 'eu';
    this.markets = opts.markets ?? process.env['ODDS_API_MARKETS'] ?? 'h2h';
    this.doFetch = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  status(): SourceStatus {
    return {
      id: this.id,
      label: this.label,
      configured: this.isConfigured(),
      setup: this.isConfigured()
        ? null
        : 'No API key. Get a free one at https://the-odds-api.com (500 credits a month, no card), then set ' +
          'ODDS_API_KEY in the environment before starting the server. Until then Scout has one book\'s prices ' +
          'and cannot compute an edge against anything.',
      quota: { ...this.quota },
      lastFetchAt: this.lastFetchAt,
      lastError: this.lastError,
    };
  }

  private readQuota(headers: Headers): void {
    const read = (name: string): number | null => num(headers.get(name));
    const remaining = read('x-requests-remaining');
    const used = read('x-requests-used');
    const last = read('x-requests-last');
    if (remaining !== null) this.quota.remaining = remaining;
    if (used !== null) this.quota.used = used;
    if (last !== null) this.quota.lastCost = last;
  }

  keyForLeague(competition: Competition): string | null {
    return resolveSportKey(competition).key;
  }

  async listSports(): Promise<Array<{ key: string; title: string; group: string; active: boolean }>> {
    if (!this.isConfigured()) return [];
    // Documented as free - it does not consume quota.
    const url = `${BASE}/sports/?apiKey=${encodeURIComponent(this.apiKey as string)}`;
    const res = await this.doFetch(url);
    if (!res.ok) {
      this.lastError = `sports list failed: ${res.status}`;
      return [];
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    return body
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
      .map((s) => ({
        key: typeof s['key'] === 'string' ? s['key'] : '',
        title: typeof s['title'] === 'string' ? s['title'] : '',
        group: typeof s['group'] === 'string' ? s['group'] : '',
        active: s['active'] === true,
      }))
      .filter((s) => s.key !== '');
  }

  async fetchOdds(sportKey: string, opts: { maxAgeMs?: number } = {}): Promise<FetchResult> {
    const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const now = this.now();

    const cached = this.cache.get(sportKey);
    if (cached && now - cached.fetchedAt <= maxAge) {
      // Free. On a 16-a-day budget this branch is the difference between the
      // source being usable and being exhausted by lunchtime.
      return { events: cached.events, quota: { ...this.quota }, fetchedAt: cached.fetchedAt, cached: true };
    }

    if (!this.isConfigured()) {
      this.lastError = 'no API key configured';
      return { events: [], quota: { ...this.quota }, fetchedAt: now, cached: false };
    }

    const params = new URLSearchParams({
      apiKey: this.apiKey as string,
      regions: this.regions,
      markets: this.markets,
      oddsFormat: 'decimal',
      dateFormat: 'iso',
    });

    let res: Response;
    try {
      res = await this.doFetch(`${BASE}/sports/${encodeURIComponent(sportKey)}/odds/?${params.toString()}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // Serve stale rather than nothing: an old consensus that is labelled old
      // is more useful than no consensus, and the age is reported.
      if (cached) return { events: cached.events, quota: { ...this.quota }, fetchedAt: cached.fetchedAt, cached: true };
      return { events: [], quota: { ...this.quota }, fetchedAt: now, cached: false };
    }

    this.readQuota(res.headers);

    if (!res.ok) {
      this.lastError =
        res.status === 401
          ? 'API key rejected (401). Check ODDS_API_KEY.'
          : res.status === 429
            ? 'Monthly quota exhausted (429). It resets at the start of the next billing period.'
            : `odds request failed: ${res.status}`;
      if (cached) return { events: cached.events, quota: { ...this.quota }, fetchedAt: cached.fetchedAt, cached: true };
      return { events: [], quota: { ...this.quota }, fetchedAt: now, cached: false };
    }

    const body: unknown = await res.json();
    const events = (Array.isArray(body) ? body : [])
      .map(toEvent)
      .filter((e): e is ExternalEvent => e !== null);

    this.cache.set(sportKey, { fetchedAt: now, events });
    this.lastFetchAt = now;
    this.lastError = null;
    return { events, quota: { ...this.quota }, fetchedAt: now, cached: false };
  }
}

/** Exported for tests: mapping one raw event is where a schema change bites. */
export { toEvent as parseOddsApiEvent };
