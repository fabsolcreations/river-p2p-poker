/**
 * Pinnacle, scraped from the public endpoints its own website uses.
 *
 * No API key, no account, no browser impersonation - the requests below are the
 * ones pinnacle.com's front end makes, and they answer a plain HTTP client.
 *
 * WHY PINNACLE SPECIFICALLY. It is the reference book. Its margins are the
 * thinnest in the market and it famously does not limit winning accounts, so it
 * has no reason to shade a price away from its true opinion. De-vigging
 * Pinnacle and treating the result as fair value is the standard method in
 * betting analytics, which is why this source is allowed to stand alone as a
 * `sharp-reference` when a three-book consensus is not available.
 *
 * OBSERVED 2026-09-06, and checked into tests/fixtures/pinnacle-*.json:
 *
 *   GET /0.1/leagues/{leagueId}/matchups        events + participants + start
 *   GET /0.1/leagues/{leagueId}/markets/straight prices, keyed by matchup
 *
 * Two things the shape gets right that most books do not:
 *   - prices carry a `designation` (home/away/draw), so sides never have to be
 *     inferred from participant order
 *   - each market carries `limits`, which is a real liquidity signal: a market
 *     Pinnacle will take 500 on is one it is confident about
 *
 * Prices are AMERICAN. Reading them as decimal would turn +197 into a 197.0
 * shot and produce spectacular nonsense, so conversion happens on the way in.
 */

import { americanToDecimal } from '../../shared/odds.ts';
import { normalizeName } from '../../shared/ids.ts';
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

export const PINNACLE_SOURCE_ID = 'pinnacle';
const BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';

/** Full-game moneyline. `s` straight, `0` whole match, `m` moneyline. */
const FULL_GAME_MONEYLINE = 's;0;m';

/**
 * Duel league name (lowercased) -> Pinnacle league id, read from the live
 * league listing on 2026-09-06. Explicit rather than fuzzy for the reason given
 * in ../sport-keys.ts: confusing a first and second division manufactures an
 * edge out of nothing.
 */
export const PINNACLE_LEAGUES: ReadonlyMap<string, number> = new Map([
  ['soccer|england|premier league', 1980],
  ['soccer|england|championship', 1977],
  ['soccer|spain|laliga', 2196],
  ['soccer|spain|la liga', 2196],
  ['soccer|italy|serie a', 2436],
  ['soccer|germany|bundesliga', 1842],
  ['soccer|france|ligue 1', 2036],
  ['soccer|international|champions league', 2627],
  ['soccer|europe|champions league', 2627],
  ['soccer|usa|mls', 2663],
  ['soccer|usa|major league soccer', 2663],
  // Baseball. Pinnacle's MLB league id, read from its live listing on
  // 2026-09-07. NPB and KBO are deliberately absent until someone checks them:
  // "Baseball" alone must never resolve to MLB.
  ['baseball|usa|mlb', 246],
]);

/**
 * The key a competition maps under. Sport and country are part of it because
 * neither is optional for correctness - see the note on `Competition`.
 */
export function competitionKey(c: Competition): string {
  return `${normalizeName(c.sport)}|${normalizeName(c.country)}|${normalizeName(c.league)}`;
}

/**
 * Politeness floor. These are somebody's servers and nobody asked them; one
 * request per league per this window is plenty for prematch prices, and Kambi
 * has already returned a 429 during development for being asked twice quickly.
 */
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  events: ExternalEvent[];
}

interface PinnacleParticipant {
  name?: unknown;
  alignment?: unknown;
}

interface PinnacleMatchup {
  id?: unknown;
  type?: unknown;
  parentId?: unknown;
  startTime?: unknown;
  league?: { id?: unknown; name?: unknown } | null;
  participants?: unknown;
}

interface PinnaclePrice {
  designation?: unknown;
  price?: unknown;
}

interface PinnacleMarket {
  key?: unknown;
  matchupId?: unknown;
  prices?: unknown;
  limits?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Builds events from the two endpoints. Exported so the mapping can be tested
 * against the recorded fixtures without any network access.
 */
export function buildPinnacleEvents(matchupsRaw: unknown, marketsRaw: unknown): ExternalEvent[] {
  const matchups = Array.isArray(matchupsRaw) ? (matchupsRaw as PinnacleMatchup[]) : [];
  const markets = Array.isArray(marketsRaw) ? (marketsRaw as PinnacleMarket[]) : [];

  // matchupId -> the full-game moneyline row.
  const moneylines = new Map<number, PinnacleMarket>();
  for (const m of markets) {
    if (str(m.key) !== FULL_GAME_MONEYLINE) continue;
    const id = int(m.matchupId);
    if (id !== null) moneylines.set(id, m);
  }

  const out: ExternalEvent[] = [];
  for (const matchup of matchups) {
    // `special` rows are prop questions ("Yes"/"No"), not fixtures.
    if (str(matchup.type) !== 'matchup') continue;
    // A child matchup is a period or alternate line on a parent fixture.
    if (matchup.parentId !== null && matchup.parentId !== undefined) continue;

    const id = int(matchup.id);
    const start = str(matchup.startTime);
    if (id === null || start === null) continue;
    const startMs = Date.parse(start);
    if (!Number.isFinite(startMs)) continue;

    const participants = Array.isArray(matchup.participants) ? (matchup.participants as PinnacleParticipant[]) : [];
    const home = participants.find((p) => str(p.alignment) === 'home');
    const away = participants.find((p) => str(p.alignment) === 'away');
    const homeName = str(home?.name);
    const awayName = str(away?.name);
    if (homeName === null || awayName === null) continue;

    const market = moneylines.get(id);
    if (!market) continue;

    const prices = Array.isArray(market.prices) ? (market.prices as PinnaclePrice[]) : [];
    const outcomes: ExternalOutcome[] = [];
    for (const p of prices) {
      const designation = str(p.designation);
      const american = int(p.price);
      if (designation === null || american === null) continue;
      const decimal = americanToDecimal(american);
      if (decimal === null) continue;
      // Named by side, then resolved to the team name so every source in a
      // consensus keys its outcomes the same way.
      const name = designation === 'home' ? homeName : designation === 'away' ? awayName : 'Draw';
      outcomes.push({ name, decimalOdds: decimal, point: null });
    }
    if (outcomes.length < 2) continue;

    const book: ExternalBook = {
      key: PINNACLE_SOURCE_ID,
      title: 'Pinnacle',
      // The endpoint carries no per-market timestamp, so freshness is the fetch
      // itself. Claiming an update time we were not given would be worse.
      lastUpdate: null,
      markets: [{ key: 'h2h', outcomes }],
    };

    out.push({
      id: String(id),
      sourceId: PINNACLE_SOURCE_ID,
      sportKey: String(int(matchup.league?.id) ?? ''),
      sportTitle: str(matchup.league?.name) ?? '',
      commenceTime: startMs,
      homeTeam: homeName,
      awayTeam: awayName,
      books: [book],
    });
  }

  return out;
}

export interface PinnacleOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class PinnacleSource implements ExternalOddsSource {
  readonly id = PINNACLE_SOURCE_ID;
  readonly label = 'Pinnacle (scraped)';

  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private lastRequestAt = 0;
  private lastFetchAt: number | null = null;
  private lastError: string | null = null;

  constructor(opts: PinnacleOptions = {}) {
    this.doFetch = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Always usable: there is nothing to configure. */
  isConfigured(): boolean {
    return true;
  }

  status(): SourceStatus {
    return {
      id: this.id,
      label: this.label,
      configured: true,
      setup: null,
      // Scraping has no quota to report; the constraint is politeness instead.
      quota: { remaining: null, used: null, lastCost: null } satisfies QuotaStatus,
      lastFetchAt: this.lastFetchAt,
      lastError: this.lastError,
    };
  }

  keyForLeague(competition: Competition): string | null {
    const id = PINNACLE_LEAGUES.get(competitionKey(competition));
    return id === undefined ? null : String(id);
  }

  async listSports(): Promise<Array<{ key: string; title: string; group: string; active: boolean }>> {
    return [...PINNACLE_LEAGUES.entries()].map(([league, id]) => ({
      key: String(id),
      title: league,
      group: 'Soccer',
      active: true,
    }));
  }

  /** `sportKey` is a Pinnacle league id. */
  async fetchOdds(sportKey: string, opts: { maxAgeMs?: number } = {}): Promise<FetchResult> {
    const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const now = this.now();
    const quota: QuotaStatus = { remaining: null, used: null, lastCost: null };

    const cached = this.cache.get(sportKey);
    if (cached && now - cached.fetchedAt <= maxAge) {
      return { events: cached.events, quota, fetchedAt: cached.fetchedAt, cached: true };
    }
    // Hard floor between requests regardless of what the caller asked for.
    if (now - this.lastRequestAt < MIN_INTERVAL_MS && cached) {
      return { events: cached.events, quota, fetchedAt: cached.fetchedAt, cached: true };
    }

    try {
      this.lastRequestAt = now;
      const [matchupsRes, marketsRes] = await Promise.all([
        this.doFetch(`${BASE}/leagues/${encodeURIComponent(sportKey)}/matchups`),
        this.doFetch(`${BASE}/leagues/${encodeURIComponent(sportKey)}/markets/straight`),
      ]);

      if (!matchupsRes.ok || !marketsRes.ok) {
        this.lastError = `pinnacle returned ${matchupsRes.status}/${marketsRes.status}`;
        if (cached) return { events: cached.events, quota, fetchedAt: cached.fetchedAt, cached: true };
        return { events: [], quota, fetchedAt: now, cached: false };
      }

      const events = buildPinnacleEvents(await matchupsRes.json(), await marketsRes.json());
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
