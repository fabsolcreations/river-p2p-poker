/**
 * BETBY reference data: the dictionaries that turn ids into names.
 *
 * A feed row names nothing. It says market 68, outcome 12, specifiers
 * "total=0.5" on event 2704263723815669762, and that is all. Everything a human
 * needs - "Over 0.5 goals, 1st half, Drogheda United vs Galway United" - lives
 * in two other payloads the page also fetches:
 *
 *   market descriptions  market id -> name + outcome name TEMPLATES
 *   event tree           event id  -> competitors, sport, tournament, kickoff
 *
 * So naming a leg is a join across three captures. This file owns the join.
 *
 * The templates are a small language, and these are all seven forms that occur
 * across the 2111 markets and 5352 outcomes Duel serves (counted, not guessed):
 *
 *   {total}          plain specifier value            -> "over 0.5"
 *   {$competitor1}   entity from the event            -> "G2 Esports"
 *   {!setnr}         ordinal of a specifier           -> "2nd set"
 *   {+hcp}           specifier, always signed         -> "+1.5"
 *   {-hcp}           specifier, sign flipped          -> "-1.5"
 *   {%player}        player entity                    -> a player name
 *   {(from-to)}      arithmetic over two specifiers   -> "1-5"
 *
 * A token we cannot resolve is left in place rather than blanked, so an
 * unrendered "{$competitor1}" in the UI is a visible, diagnosable gap instead of
 * a silently truncated label.
 */

import type { NormalizedEvent } from '../../shared/types.ts';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface OutcomeTemplate {
  id: string;
  /** Raw template, e.g. "over {total}" or "{$competitor1}". */
  name: string;
}

export interface MarketDescription {
  id: string;
  /** Raw template, e.g. "{!setnr} set game {gamenr} - winner". */
  name: string;
  marketType: string | null;
  /**
   * variant key -> outcome id -> template. Most markets have a single ""
   * variant; some key their outcomes by a `variant=...` specifier.
   */
  variants: Map<string, Map<string, string>>;
}

export interface EventCompetitor {
  id: string;
  name: string;
}

export interface EventDescription {
  id: string;
  competitors: EventCompetitor[];
  sportId: string | null;
  /** Country/region id. Resolved via the tree's `categories` map. */
  categoryId: string | null;
  tournamentId: string | null;
  /** Epoch ms. BETBY sends seconds; converted on the way in. */
  scheduled: number | null;
  /** status/match_status from the event's `state` block, when present. */
  status: number | null;
  /** market id -> specifier key -> outcome id -> decimal odds as written. */
  markets: Map<string, Map<string, Map<string, string>>>;
}

/** Everything the join needs, assembled from whatever has been captured. */
export interface BetbyReference {
  markets: Map<string, MarketDescription>;
  events: Map<string, EventDescription>;
  sports: Map<string, string>;
  categories: Map<string, string>;
  tournaments: Map<string, string>;
}

export function emptyReference(): BetbyReference {
  return { markets: new Map(), events: new Map(), sports: new Map(), categories: new Map(), tournaments: new Map() };
}

export function referenceSize(ref: BetbyReference): { markets: number; events: number; sports: number; tournaments: number } {
  return {
    markets: ref.markets.size,
    events: ref.events.size,
    sports: ref.sports.size,
    tournaments: ref.tournaments.size,
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/* ------------------------------------------------------------------ *
 * Ingesting the two reference payloads
 * ------------------------------------------------------------------ */

/**
 * Reads a market-descriptions payload: an object keyed by market id. Returns
 * null when the payload is not that shape, so a caller can tell "not this kind
 * of payload" from "this kind, but empty".
 */
export function parseMarketDescriptions(json: unknown): Map<string, MarketDescription> | null {
  if (!isObj(json)) return null;
  const out = new Map<string, MarketDescription>();

  for (const [id, raw] of Object.entries(json)) {
    if (!isObj(raw)) continue;
    const name = asString(raw['name']);
    // A market description always has a name and an id; anything else keyed by
    // a numeric string is some other payload that happens to look similar.
    if (name === null) continue;

    const variants = new Map<string, Map<string, string>>();
    const variantBlock = raw['variants'];
    if (isObj(variantBlock)) {
      for (const [variantKey, entries] of Object.entries(variantBlock)) {
        const outcomes = new Map<string, string>();
        // Each variant is an array of { outcomes: [{id, name}] }.
        for (const entry of Array.isArray(entries) ? entries : [entries]) {
          if (!isObj(entry)) continue;
          const list = entry['outcomes'];
          if (!Array.isArray(list)) continue;
          for (const o of list) {
            if (!isObj(o)) continue;
            const oid = asString(o['id']);
            const oname = asString(o['name']);
            if (oid !== null && oname !== null) outcomes.set(oid, oname);
          }
        }
        variants.set(variantKey, outcomes);
      }
    }

    out.set(String(id), {
      id: String(id),
      name,
      marketType: asString(raw['market_type']),
      variants,
    });
  }

  return out.size > 0 ? out : null;
}

/**
 * Reads an event-tree payload (the prematch/live response). Returns null when
 * the payload has no `events` map, which is how the cursor-0 handshake response
 * is distinguished from a real snapshot.
 */
export function parseEventTree(json: unknown): Pick<BetbyReference, 'events' | 'sports' | 'categories' | 'tournaments'> | null {
  if (!isObj(json)) return null;
  const eventsRaw = json['events'];
  if (!isObj(eventsRaw)) return null;

  const names = (block: unknown): Map<string, string> => {
    const map = new Map<string, string>();
    if (!isObj(block)) return map;
    for (const [id, entry] of Object.entries(block)) {
      const n = isObj(entry) ? asString(entry['name']) : asString(entry);
      if (n !== null) map.set(String(id), n);
    }
    return map;
  };

  const events = new Map<string, EventDescription>();
  for (const [id, raw] of Object.entries(eventsRaw)) {
    if (!isObj(raw)) continue;
    const desc = isObj(raw['desc']) ? raw['desc'] : {};
    const state = isObj(raw['state']) ? raw['state'] : {};

    const competitors: EventCompetitor[] = [];
    const compRaw = desc['competitors'];
    if (Array.isArray(compRaw)) {
      for (const c of compRaw) {
        if (!isObj(c)) continue;
        const cid = asString(c['id']);
        const cname = asString(c['name']);
        if (cname !== null) competitors.push({ id: cid ?? '', name: cname });
      }
    }

    // BETBY sends `scheduled` in epoch SECONDS. Storing it as-is would date
    // every event to 1970 and silently break every kickoff comparison.
    const scheduledRaw = desc['scheduled'];
    const scheduled =
      typeof scheduledRaw === 'number' && Number.isFinite(scheduledRaw) ? Math.round(scheduledRaw * 1000) : null;

    const markets = new Map<string, Map<string, Map<string, string>>>();
    const marketsRaw = raw['markets'];
    if (isObj(marketsRaw)) {
      for (const [marketId, specBlock] of Object.entries(marketsRaw)) {
        if (!isObj(specBlock)) continue;
        const bySpec = new Map<string, Map<string, string>>();
        for (const [specKey, outcomeBlock] of Object.entries(specBlock)) {
          if (!isObj(outcomeBlock)) continue;
          const byOutcome = new Map<string, string>();
          for (const [outcomeId, priceBlock] of Object.entries(outcomeBlock)) {
            const k = isObj(priceBlock) ? asString(priceBlock['k']) : asString(priceBlock);
            if (k !== null) byOutcome.set(outcomeId, k);
          }
          if (byOutcome.size > 0) bySpec.set(specKey, byOutcome);
        }
        if (bySpec.size > 0) markets.set(String(marketId), bySpec);
      }
    }

    const statusRaw = state['status'];
    events.set(String(id), {
      id: String(id),
      competitors,
      sportId: asString(desc['sport']),
      categoryId: asString(desc['category']),
      tournamentId: asString(desc['tournament']),
      scheduled,
      status: typeof statusRaw === 'number' ? statusRaw : null,
      markets,
    });
  }

  return {
    events,
    sports: names(json['sports']),
    categories: names(json['categories']),
    tournaments: names(json['tournaments']),
  };
}

/** Folds a newly parsed payload into an existing reference set, in place. */
export function mergeReference(target: BetbyReference, source: Partial<BetbyReference>): BetbyReference {
  for (const key of ['markets', 'events', 'sports', 'categories', 'tournaments'] as const) {
    const incoming = source[key];
    if (!incoming) continue;
    for (const [k, v] of incoming as Map<string, never>) {
      // Last write wins: a later capture is a fresher view of the same id.
      (target[key] as Map<string, unknown>).set(k, v);
    }
  }
  return target;
}

/* ------------------------------------------------------------------ *
 * Template rendering
 * ------------------------------------------------------------------ */

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
export function ordinal(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(Math.trunc(n));
  const rem100 = abs % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (abs % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function signed(value: string, flip: boolean): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const v = flip ? -n : n;
  // A handicap of exactly 0 reads better unsigned.
  if (v === 0) return '0';
  return v > 0 ? `+${v}` : String(v);
}

export interface TemplateContext {
  /** Parsed specifier key/value pairs, e.g. { total: "0.5", setnr: "2" }. */
  specifiers: Record<string, string>;
  /** Competitor names in listed order; competitor1 is the first. */
  competitors: string[];
}

/**
 * Substitutes every template token it can resolve. Unresolvable tokens are left
 * exactly as they were - see the note at the top of this file.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  if (!template || template.indexOf('{') === -1) return template;

  return template.replace(/\{([^}]*)\}/g, (whole, body: string) => {
    if (!body) return whole;

    const prefix = body[0];
    const rest = body.slice(1);

    // {(from-to)} - arithmetic/range over two specifier keys.
    if (prefix === '(' && body.endsWith(')')) {
      const inner = body.slice(1, -1);
      const parts = inner.split(/([+\-])/);
      const first = ctx.specifiers[parts[0] ?? ''];
      if (parts.length === 3 && first !== undefined) {
        const op = parts[1];
        const second = ctx.specifiers[parts[2] ?? ''];
        if (second !== undefined) {
          const a = Number(first);
          const b = Number(second);
          if (Number.isFinite(a) && Number.isFinite(b)) return String(op === '-' ? a - b : a + b);
          return `${first}-${second}`;
        }
      }
      return whole;
    }

    // {$competitorN} and {%playerN} - entity references.
    if (prefix === '$' || prefix === '%') {
      const compMatch = rest.match(/^competitor(\d+)$/i);
      if (compMatch) {
        const idx = Number(compMatch[1]) - 1;
        const name = ctx.competitors[idx];
        return name ?? whole;
      }
      // A bare {%player} with two competitors is ambiguous; only a numbered
      // reference is safe to resolve.
      const playerMatch = rest.match(/^player(\d+)$/i);
      if (playerMatch) {
        const idx = Number(playerMatch[1]) - 1;
        const name = ctx.competitors[idx];
        return name ?? whole;
      }
      const direct = ctx.specifiers[rest];
      return direct ?? whole;
    }

    // {!key} - ordinal.
    if (prefix === '!') {
      const raw = ctx.specifiers[rest];
      if (raw === undefined) return whole;
      const n = Number(raw);
      return Number.isFinite(n) ? ordinal(n) : raw;
    }

    // {+key} / {-key} - signed handicap.
    if (prefix === '+' || prefix === '-') {
      const raw = ctx.specifiers[rest];
      if (raw === undefined) return whole;
      return signed(raw, prefix === '-');
    }

    // {key} - plain substitution.
    const raw = ctx.specifiers[body];
    return raw ?? whole;
  });
}

/* ------------------------------------------------------------------ *
 * The join
 * ------------------------------------------------------------------ */

export interface ResolvedLeg {
  eventName: string | null;
  competitors: string[];
  sport: string | null;
  league: string | null;
  startTime: number | null;
  marketName: string | null;
  marketType: string | null;
  selectionName: string | null;
  /** Current price for this exact selection, if the tree carried one. */
  currentOdds: number | null;
}

export interface ResolveLegInput {
  eventId: string | null;
  marketId: string | null;
  outcomeId: string | null;
  specifiers: Record<string, string>;
  /** The raw specifier string, used as the variant key lookup. */
  specifierKey?: string;
}

/**
 * Names one feed leg from whatever reference data has been captured so far.
 * Every field is independently optional: a leg whose event is known but whose
 * market is not still gets its team names.
 */
export function resolveLeg(ref: BetbyReference, input: ResolveLegInput): ResolvedLeg {
  const out: ResolvedLeg = {
    eventName: null,
    competitors: [],
    sport: null,
    league: null,
    startTime: null,
    marketName: null,
    marketType: null,
    selectionName: null,
    currentOdds: null,
  };

  const event = input.eventId !== null ? ref.events.get(input.eventId) : undefined;
  if (event) {
    out.competitors = event.competitors.map((c) => c.name);
    out.eventName = out.competitors.length >= 2 ? out.competitors.join(' vs ') : (out.competitors[0] ?? null);
    out.sport = event.sportId !== null ? (ref.sports.get(event.sportId) ?? null) : null;
    out.league = event.tournamentId !== null ? (ref.tournaments.get(event.tournamentId) ?? null) : null;
    out.startTime = event.scheduled;
  }

  const ctx: TemplateContext = { specifiers: input.specifiers, competitors: out.competitors };

  const market = input.marketId !== null ? ref.markets.get(input.marketId) : undefined;
  if (market) {
    out.marketName = renderTemplate(market.name, ctx);
    out.marketType = market.marketType;

    if (input.outcomeId !== null) {
      // Prefer the variant the specifier names; fall back to the unnamed
      // default variant, which is what nearly every market uses.
      const variantKey = input.specifierKey ?? '';
      const byVariant =
        market.variants.get(variantKey) ??
        market.variants.get('') ??
        // Some markets key outcomes under a "variant=..." specifier value.
        (input.specifiers['variant'] !== undefined
          ? market.variants.get(`variant=${input.specifiers['variant']}`)
          : undefined);
      const template = byVariant?.get(input.outcomeId);
      if (template !== undefined) out.selectionName = renderTemplate(template, ctx);
      else if (market.variants.size === 1) {
        // Single-variant market whose outcome id we do not recognise: say so
        // rather than inventing a label.
        out.selectionName = null;
      }
    }
  }

  // Current price, when the tree carried this market for this event.
  if (event && input.marketId !== null && input.outcomeId !== null) {
    const bySpec = event.markets.get(input.marketId);
    if (bySpec) {
      const key = input.specifierKey ?? '';
      const byOutcome = bySpec.get(key) ?? (bySpec.size === 1 ? [...bySpec.values()][0] : undefined);
      const raw = byOutcome?.get(input.outcomeId);
      if (raw !== undefined) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 1) out.currentOdds = n;
      }
    }
  }

  return out;
}

/**
 * Turns the reference set's events into NormalizedEvent rows. Used to persist
 * the event catalogue independently of any bet that references it.
 */
export function referenceEvents(ref: BetbyReference, sportsbookId: string, makeKey: (input: {
  sportsbookId: string;
  sourceEventId: string;
}) => string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const event of ref.events.values()) {
    const competitors = event.competitors.map((c) => c.name);
    out.push({
      key: makeKey({ sportsbookId, sourceEventId: event.id }),
      sportsbookId,
      sourceEventId: event.id,
      sport: event.sportId !== null ? (ref.sports.get(event.sportId) ?? null) : null,
      country: event.categoryId !== null ? (ref.categories.get(event.categoryId) ?? null) : null,
      league: event.tournamentId !== null ? (ref.tournaments.get(event.tournamentId) ?? null) : null,
      competitors,
      home: competitors[0] ?? null,
      away: competitors[1] ?? null,
      name: competitors.length >= 2 ? competitors.join(' vs ') : (competitors[0] ?? null),
      startTime: event.scheduled,
      live: null,
      status: event.status !== null ? String(event.status) : null,
    });
  }
  return out;
}
