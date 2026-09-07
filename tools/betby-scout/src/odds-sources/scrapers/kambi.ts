/**
 * Kambi, scraped from the public offering API its operators' sites use.
 *
 * No key and no account. Kambi is the platform behind Unibet, Betsson,
 * LeoVegas, 32Red and others, and its offering endpoint answers a plain HTTP
 * client:
 *
 *   GET https://eu-offering-api.kambicdn.com/offering/v2018/{brand}/listView/{path}.json
 *
 * OBSERVED 2026-09-06, recorded in tests/fixtures/kambi-listview.json.
 *
 * TWO THINGS THAT MATTER FOR CORRECTNESS
 *
 * 1. Odds are in MILLI-UNITS. 1680 means 1.68. Read as decimal it would be a
 *    1680-to-1 shot, and every market would look like a lottery.
 *
 * 2. Every Kambi brand is ONE opinion. Unibet and Betsson quote the same
 *    trading engine, so counting them as two books in a consensus would be
 *    double-counting dressed up as corroboration. Only one Kambi brand may ever
 *    contribute, which is why the book key is the platform and not the brand.
 *
 * Kambi returned a 429 during development when asked twice in quick succession,
 * so the interval floor here is not decorative.
 */

import { normalizeName } from '../../shared/ids.ts';
import { competitionKey } from './pinnacle.ts';
import type {
  Competition,
  ExternalBook,
  ExternalEvent,
  ExternalOddsSource,
  ExternalOutcome,
  FetchResult,
  QuotaStatus,
  SourceStatus,
} from '../types.ts';

export const KAMBI_SOURCE_ID = 'kambi';
const BASE = 'https://eu-offering-api.kambicdn.com/offering/v2018';

/** The brand whose offering is read. One only - see note 2 above. */
const DEFAULT_BRAND = 'ub';

/** Duel league name (lowercased) -> Kambi list path. */
export const KAMBI_PATHS: ReadonlyMap<string, string> = new Map([
  ['soccer|england|premier league', 'football/england/premier_league'],
  ['soccer|spain|laliga', 'football/spain/la_liga'],
  ['soccer|spain|la liga', 'football/spain/la_liga'],
  ['soccer|italy|serie a', 'football/italy/serie_a'],
  ['soccer|germany|bundesliga', 'football/germany/bundesliga'],
  ['soccer|france|ligue 1', 'football/france/ligue_1'],
  ['soccer|international|champions league', 'football/champions_league'],
  ['soccer|europe|champions league', 'football/champions_league'],
]);

/** Kambi rate-limits. This floor is why. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

/** The full-time 1X2 offer. Kambi labels its match market this way. */
const MATCH_BET_OFFER_TYPE = 2;

interface CacheEntry {
  fetchedAt: number;
  events: ExternalEvent[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Maps a Kambi listView payload. Exported so the milli-unit conversion and the
 * 1X2 mapping can be tested against the recorded fixture with no network.
 */
export function buildKambiEvents(raw: unknown): ExternalEvent[] {
  if (raw === null || typeof raw !== 'object') return [];
  const events = (raw as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  const out: ExternalEvent[] = [];
  for (const entry of events) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { event?: unknown; betOffers?: unknown };
    if (e.event === null || typeof e.event !== 'object') continue;

    const ev = e.event as Record<string, unknown>;
    const id = int(ev['id']);
    const home = str(ev['homeName']);
    const away = str(ev['awayName']);
    const start = str(ev['start']);
    if (id === null || home === null || away === null || start === null) continue;
    const startMs = Date.parse(start);
    if (!Number.isFinite(startMs)) continue;

    const offers = Array.isArray(e.betOffers) ? e.betOffers : [];
    const match = offers.find((o) => {
      if (o === null || typeof o !== 'object') return false;
      const type = (o as { betOfferType?: { id?: unknown } }).betOfferType;
      return int(type?.id) === MATCH_BET_OFFER_TYPE;
    }) as { outcomes?: unknown } | undefined;
    if (!match) continue;

    const rawOutcomes = Array.isArray(match.outcomes) ? match.outcomes : [];
    const outcomes: ExternalOutcome[] = [];
    for (const o of rawOutcomes) {
      if (o === null || typeof o !== 'object') continue;
      const outcome = o as Record<string, unknown>;
      const milli = int(outcome['odds']);
      if (milli === null || milli <= 1000) continue; // 1000 = 1.00, which pays nothing

      // Name by side so every source in a consensus keys outcomes identically.
      // `participant` is present for 1 and 2 but not for the draw.
      const type = str(outcome['type']);
      const name =
        type === 'OT_ONE' ? home : type === 'OT_TWO' ? away : type === 'OT_CROSS' ? 'Draw' : str(outcome['participant']);
      if (name === null) continue;

      outcomes.push({ name, decimalOdds: milli / 1000, point: null });
    }
    if (outcomes.length < 2) continue;

    const book: ExternalBook = {
      // The PLATFORM, not the brand: two Kambi brands are one opinion.
      key: KAMBI_SOURCE_ID,
      title: 'Kambi',
      lastUpdate: null,
      markets: [{ key: 'h2h', outcomes }],
    };

    out.push({
      id: String(id),
      sourceId: KAMBI_SOURCE_ID,
      sportKey: str(ev['group']) ?? '',
      sportTitle: str(ev['group']) ?? '',
      commenceTime: startMs,
      homeTeam: home,
      awayTeam: away,
      books: [book],
    });
  }

  return out;
}

export interface KambiOptions {
  brand?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class KambiSource implements ExternalOddsSource {
  readonly id = KAMBI_SOURCE_ID;
  readonly label = 'Kambi (scraped)';

  private readonly brand: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private lastRequestAt = 0;
  private lastFetchAt: number | null = null;
  private lastError: string | null = null;

  constructor(opts: KambiOptions = {}) {
    this.brand = opts.brand ?? DEFAULT_BRAND;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return true;
  }

  status(): SourceStatus {
    return {
      id: this.id,
      label: this.label,
      configured: true,
      setup: null,
      quota: { remaining: null, used: null, lastCost: null } satisfies QuotaStatus,
      lastFetchAt: this.lastFetchAt,
      lastError: this.lastError,
    };
  }

  keyForLeague(competition: Competition): string | null {
    return KAMBI_PATHS.get(competitionKey(competition)) ?? null;
  }

  async listSports(): Promise<Array<{ key: string; title: string; group: string; active: boolean }>> {
    return [...KAMBI_PATHS.entries()].map(([league, path]) => ({
      key: path,
      title: league,
      group: 'Football',
      active: true,
    }));
  }

  /** `sportKey` is a Kambi list path, e.g. `football/england/premier_league`. */
  async fetchOdds(sportKey: string, opts: { maxAgeMs?: number } = {}): Promise<FetchResult> {
    const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const now = this.now();
    const quota: QuotaStatus = { remaining: null, used: null, lastCost: null };

    const cached = this.cache.get(sportKey);
    if (cached && now - cached.fetchedAt <= maxAge) {
      return { events: cached.events, quota, fetchedAt: cached.fetchedAt, cached: true };
    }
    if (now - this.lastRequestAt < MIN_INTERVAL_MS && cached) {
      return { events: cached.events, quota, fetchedAt: cached.fetchedAt, cached: true };
    }

    const url = `${BASE}/${encodeURIComponent(this.brand)}/listView/${sportKey}.json?lang=en_GB&market=GB`;
    try {
      this.lastRequestAt = now;
      const res = await this.doFetch(url);
      if (!res.ok) {
        this.lastError =
          res.status === 429
            ? 'Kambi rate-limited the request (429). Back off and reuse the cache.'
            : `kambi returned ${res.status}`;
        if (cached) return { events: cached.events, quota, fetchedAt: cached.fetchedAt, cached: true };
        return { events: [], quota, fetchedAt: now, cached: false };
      }

      const events = buildKambiEvents(await res.json());
      this.cache.set(sportKey, { fetchedAt: now, events });
      this.lastFetchAt = now;
      this.lastError = null;
      return { events, quota, fetchedAt: now, cached: false };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (cached) return { events: cached.events, quota, fetchedAt: cached.fetchedAt, cached: true };
      return { events: [], quota, fetchedAt: now, cached: false };
    }
  }
}
