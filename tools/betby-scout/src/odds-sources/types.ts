/**
 * External odds sources.
 *
 * This is the abstraction the brief asked for, and it is what finally makes a
 * real edge computable. Everything Scout could say until now was about Duel
 * measured against itself; a price from an INDEPENDENT book is the missing
 * ingredient, because only a fair value that did not come from Duel can be
 * compared to Duel's price without the comparison collapsing to minus the
 * margin. See src/analysis/types.ts.
 *
 * A source is anything that can hand back priced markets for real-world events.
 * The first implementation is The Odds API; the interface exists so a second
 * one is a new file rather than a rewrite.
 *
 * Two things every implementation must respect:
 *
 *   QUOTA. Free tiers are small - The Odds API's is 500 credits a month, about
 *   16 a day. A source must report what it spent so the caller can stop, and
 *   must never poll on a timer of its own.
 *
 *   PROVENANCE. Every price carries the book that quoted it and when. A
 *   consensus built from one book twice is not a consensus, and a price from
 *   yesterday is not a price.
 */

/** A single priced outcome from one bookmaker. */
export interface ExternalOutcome {
  /** Team/side name exactly as the source wrote it. */
  name: string;
  decimalOdds: number;
  /** Handicap or total line, when the market has one. */
  point: number | null;
}

export interface ExternalMarket {
  /** 'h2h' | 'spreads' | 'totals' - the source's own key, kept verbatim. */
  key: string;
  outcomes: ExternalOutcome[];
}

export interface ExternalBook {
  key: string;
  title: string;
  /** Epoch ms this book's prices were last updated at the source. */
  lastUpdate: number | null;
  markets: ExternalMarket[];
}

export interface ExternalEvent {
  /** The source's event id. */
  id: string;
  sourceId: string;
  sportKey: string;
  sportTitle: string;
  /** Epoch ms. */
  commenceTime: number;
  homeTeam: string;
  awayTeam: string;
  books: ExternalBook[];
}

export interface QuotaStatus {
  /** Credits left in the current period, when the source reports it. */
  remaining: number | null;
  used: number | null;
  /** Credits the last call cost. */
  lastCost: number | null;
}

export interface FetchResult {
  events: ExternalEvent[];
  quota: QuotaStatus;
  /** Epoch ms this data was retrieved. */
  fetchedAt: number;
  /** True when served from cache without spending quota. */
  cached: boolean;
}

export interface SourceStatus {
  id: string;
  label: string;
  /** False when no credential is configured - the normal state before setup. */
  configured: boolean;
  /** Plain-language instruction when it is not configured. */
  setup: string | null;
  quota: QuotaStatus;
  lastFetchAt: number | null;
  lastError: string | null;
}

export interface ExternalOddsSource {
  id: string;
  label: string;
  /** Whether a credential is present. Never throws when it is not. */
  isConfigured(): boolean;
  status(): SourceStatus;
  /** Sports this source can be asked for, cheapest call available. */
  listSports(): Promise<Array<{ key: string; title: string; group: string; active: boolean }>>;
  /**
   * Priced events for one sport. Implementations must serve from cache when the
   * cached copy is younger than `maxAgeMs`, because quota is the binding
   * constraint on a free tier.
   */
  fetchOdds(sportKey: string, opts?: { maxAgeMs?: number }): Promise<FetchResult>;
}

/**
 * Books that are themselves BETBY-powered, or that resell another book's prices.
 *
 * Excluded from any consensus that is compared against Duel: two books quoting
 * the same underlying feed are one opinion, and averaging them would look like
 * corroboration while adding no information. This list is conservative and
 * declared here so the reason is visible rather than buried in a filter.
 */
export const NON_INDEPENDENT_BOOK_KEYS: ReadonlySet<string> = new Set([
  // Duel itself, should a source ever carry it.
  'duel',
]);
