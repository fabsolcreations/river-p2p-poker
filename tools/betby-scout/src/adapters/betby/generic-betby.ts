/**
 * Generic BETBY adapter - the shape-driven classifier and parser.
 *
 * THE CONSTRAINT THAT DEFINES THIS FILE: we do not know BETBY's API. Not the
 * endpoint paths, not the hostnames, not the field names. Anything in here that
 * branched on a guessed URL would be a lie dressed as code, and worse, it would
 * quietly stop working on the next BETBY book we point this at.
 *
 * So classification is done purely on the STRUCTURE of a payload: how many
 * objects are in the biggest array, what fraction of them carry a number in the
 * decimal-odds band, whether there are many distinct masked handles or only
 * one, whether timestamps look like epochs. Field *reading* uses pick(), which
 * tries a long list of spellings case- and separator-insensitively, because
 * books built on the same platform still disagree about camelCase vs snake_case
 * and about "odds" vs "price" vs "coefficient".
 *
 * The output that matters most at Milestone 1 is not the verdict - it is the
 * `reasons` array. A human reads those in the debug panel and decides what an
 * unknown endpoint actually is. "unknown, here is exactly what I did and did
 * not find" is a successful result; a confident wrong label is not.
 */

import type {
  BetStatus,
  BetType,
  CaptureKind,
  CaptureClassification,
  ClassifyInput,
  NormalizedEvent,
  NormalizedFeedBet,
  NormalizedFeedBetLeg,
  NormalizedMarket,
  NormalizedSelection,
  OddsSnapshot,
  ParseInput,
  ParsePreview,
  SportsbookAdapter,
} from '../../shared/types.ts';
import {
  bettorKey as makeBettorKey,
  eventKey as makeEventKey,
  feedBetKey as makeFeedBetKey,
  legFingerprint,
  marketKey as makeMarketKey,
  selectionKey as makeSelectionKey,
} from '../../shared/ids.ts';
import { isValidDecimalOdds } from '../../shared/odds.ts';
import { resolveLeg, type BetbyReference } from './dictionary.ts';
import {
  findObjectArrays,
  flattenPaths,
  fractionOf,
  looksLikeCurrencyCode,
  looksLikeDecimalOdds,
  looksLikeEpoch,
  looksLikeIsoDate,
  looksLikeMaskedHandle,
  looksLikeStake,
  pick,
  shapeFingerprint,
} from '../../shared/shape.ts';

export const GENERIC_BETBY_ID = 'betby.generic';

/* ------------------------------------------------------------------ *
 * Field-name candidates
 *
 * Every list is deliberately long. We have observed NONE of these on a real
 * BETBY response - they are the union of spellings used across sportsbook APIs
 * generally, so that whichever one BETBY uses, pick() finds it. Reading a field
 * by many candidate names is discovery; branching on one is assumption.
 * ------------------------------------------------------------------ */

const K_ID = ['id', 'uid', 'uuid', 'key', '_id'];
const K_EVENT_ID = ['eventId', 'event_id', 'eid', 'matchId', 'match_id', 'fixtureId', 'fixture_id', 'gameId', 'game_id', 'sportEventId'];
const K_MARKET_ID = ['marketId', 'market_id', 'mid', 'betTypeId', 'bet_type_id', 'marketTypeId'];
const K_SELECTION_ID = ['selectionId', 'selection_id', 'outcomeId', 'outcome_id', 'sid', 'oid', 'oddId', 'odd_id'];
const K_BET_ID = ['betId', 'bet_id', 'ticketId', 'ticket_id', 'couponId', 'coupon_id', 'slipId', 'wagerId'];
const K_ODDS = ['odds', 'odd', 'price', 'coefficient', 'coef', 'koef', 'k', 'rate', 'value', 'factor', 'decimalOdds', 'decimal_odds', 'currentOdds', 'oddValue'];
const K_TOTAL_ODDS = ['totalOdds', 'total_odds', 'totalCoefficient', 'totalKoef', 'combinedOdds', 'oddsTotal', 'totalPrice', 'totalRate'];
const K_STAKE = ['stake', 'amount', 'sum', 'betAmount', 'bet_amount', 'wager', 'betSum', 'bet_sum', 'money', 'total'];
const K_PAYOUT = ['payout', 'pot_win', 'potWin', 'potentialWin', 'potential_win', 'possibleWin', 'possible_win', 'winAmount', 'win_amount', 'toReturn', 'maxWin', 'profit', 'possiblePayout'];
const K_TS = ['ts', 'time', 'timestamp', 'created', 'createdAt', 'created_at', 'date', 'dateTime', 'placedAt', 'placed_at', 'acceptedAt', 'time_placed'];
const K_START = ['startTime', 'start_time', 'startsAt', 'starts_at', 'scheduled', 'scheduledAt', 'kickoff', 'eventDate', 'event_date', 'begin', 'startDate'];
const K_USER = ['user', 'username', 'userName', 'user_name', 'player', 'playerName', 'nick', 'nickname', 'handle', 'login', 'displayName', 'maskedName', 'account'];
const K_CURRENCY = ['currency', 'currencyCode', 'currency_code', 'ccy', 'cur'];
const K_LEGS = ['legs', 'selections', 'outcomes', 'items', 'bets', 'parts', 'events', 'picks', 'lines', 'stakes'];
const K_SPORT = ['sport', 'sportName', 'sport_name', 'sportTitle', 'category'];
const K_LEAGUE = ['league', 'tournament', 'competition', 'leagueName', 'tournamentName', 'championship', 'group'];
const K_MARKET_NAME = ['market', 'marketName', 'market_name', 'betType', 'bet_type', 'marketTitle', 'type', 'title'];
const K_SELECTION_NAME = ['selection', 'selectionName', 'outcome', 'outcomeName', 'pick', 'choice', 'name', 'caption'];
const K_EVENT_NAME = ['event', 'eventName', 'event_name', 'match', 'matchName', 'fixture', 'game', 'name', 'title'];
const K_LINE = ['line', 'handicap', 'hcp', 'spread', 'total', 'points', 'param', 'specialValue', 'argument'];
// BETBY carries the line inside this string rather than a numeric field.
const K_SPECIFIERS = ['specifiers', 'specifier', 'params', 'sv', 'special'];
const K_STATUS = ['status', 'state', 'result', 'settlement', 'outcome_status', 'betStatus'];
const K_HOME = ['home', 'homeTeam', 'home_team', 'team1', 'competitor1', 'homeName'];
const K_AWAY = ['away', 'awayTeam', 'away_team', 'team2', 'competitor2', 'awayName'];
const K_COMPETITORS = ['competitors', 'teams', 'participants', 'opponents', 'players'];
const K_LIVE = ['live', 'isLive', 'is_live', 'inplay', 'inPlay', 'in_play'];
const K_MARKETS = ['markets', 'bets', 'odds', 'outcomes', 'betTypes'];
const K_CHILDREN = ['children', 'items', 'subcategories', 'categories', 'tournaments', 'nodes', 'sub'];

/* ------------------------------------------------------------------ *
 * Small structural helpers
 * ------------------------------------------------------------------ */

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Books frequently send prices as strings. Accepting them is reading, not
  // guessing - but only when the whole string is numeric.
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Currency symbols BETBY renders into money strings, mapped to ISO codes.
 *
 * `$` is genuinely ambiguous (USD/CAD/AUD/...). We resolve it to USD because
 * that is what the books we have observed mean by it, and an adapter can
 * override `resolveCurrencySymbol` when that is wrong for its book. The
 * assumption is recorded here rather than buried at the call site, because
 * getting it wrong silently mis-scales every stake in the whale detector.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  '¥': 'JPY',
  '₺': 'TRY',
  '₽': 'RUB',
  '₩': 'KRW',
  '₴': 'UAH',
  '₦': 'NGN',
  R$: 'BRL',
  'C$': 'CAD',
  A$: 'AUD',
};

export interface Money {
  amount: number;
  /** ISO code when we could resolve one, else the raw symbol, else null. */
  currency: string | null;
}

/**
 * Reads the money strings BETBY feeds actually contain - "50.01 $",
 * "253124.90 €", "1,234.50 ₹" - as well as plain numbers and "USD 5.00".
 *
 * This exists because the generic numeric reader deliberately refuses anything
 * that is not purely numeric, and a stake is the single most important field in
 * the feed: it drives whale detection and every stake percentile. Silently
 * returning null for "5.00 $" made every real row look stakeless.
 */
export function parseMoney(v: unknown): Money | null {
  if (typeof v === 'number' && Number.isFinite(v)) return { amount: v, currency: null };
  if (typeof v !== 'string') return null;

  const raw = v.trim();
  if (!raw) return null;

  // Grab the number first: optional sign, digits with , or space grouping,
  // optional decimal part. Reject anything with no digits at all.
  const numMatch = raw.match(/-?\d[\d\s,]*(?:\.\d+)?/);
  if (!numMatch) return null;
  const amount = Number(numMatch[0].replace(/[\s,]/g, ''));
  if (!Number.isFinite(amount)) return null;

  // Whatever is left, minus the number, is the currency marker.
  const marker = raw.replace(numMatch[0], '').trim();
  if (!marker) return { amount, currency: null };

  const iso = marker.match(/\b[A-Z]{3,5}\b/);
  if (iso) return { amount, currency: iso[0] };

  const symbol = CURRENCY_SYMBOLS[marker] ?? CURRENCY_SYMBOLS[marker.replace(/\s+/g, '')];
  // An unrecognised marker is kept verbatim rather than dropped: "we saw this
  // and could not map it" is useful, "no currency" is misleading.
  return { amount, currency: symbol ?? marker };
}

/**
 * BETBY encodes a market's line inside a `specifiers` string rather than a
 * numeric field: "total=2.5", "hcp=-1.5", "setnr=2|gamenr=3". Without reading
 * it, every handicap and total in the feed has a null line, which makes two
 * different lines on the same market collapse to one selection key.
 */
export function parseSpecifiers(v: unknown): { line: number | null; period: string | null; all: Record<string, string> } {
  const out: Record<string, string> = {};
  if (typeof v !== 'string' || !v.trim()) return { line: null, period: null, all: out };
  for (const part of v.split('|')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim();
    if (k) out[k] = val;
  }
  // Line-bearing keys, in the order we prefer them.
  let line: number | null = null;
  for (const k of ['total', 'hcp', 'handicap', 'spread', 'goals', 'score']) {
    const hit = out[k];
    if (hit === undefined) continue;
    const n = Number(hit);
    if (Number.isFinite(n)) {
      line = n;
      break;
    }
  }
  // Period-ish keys describe which part of the match the market covers.
  const periodParts: string[] = [];
  for (const k of ['setnr', 'gamenr', 'periodnr', 'inningnr', 'quarternr', 'mapnr', 'framenr']) {
    const hit = out[k];
    if (hit !== undefined) periodParts.push(`${k}=${hit}`);
  }
  return { line, period: periodParts.length ? periodParts.join('|') : null, all: out };
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return null;
}

/** Epoch ms from a number (s or ms) or an ISO string. Null when unreadable. */
function toEpochMs(v: unknown): number | null {
  const n = num(v);
  if (n !== null) {
    const e = looksLikeEpoch(n);
    if (e.is) return e.unit === 's' ? Math.round(n * 1000) : Math.round(n);
    return null;
  }
  if (typeof v === 'string' && looksLikeIsoDate(v)) {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Bet/leg settlement status, normalized. Anything we do not recognise stays
 * 'unknown' rather than being forced into won/lost - a mislabelled settlement
 * would corrupt every ROI number computed later.
 */
function toBetStatus(v: unknown): BetStatus {
  const s = str(v)?.toLowerCase();
  if (!s) return 'unknown';
  if (/^(open|pending|active|placed|accepted|unsettled|running|new)$/.test(s)) return 'open';
  if (/^(won|win|winner|success)$/.test(s)) return 'won';
  if (/^(lost|lose|loss|lose[dr]?|failed)$/.test(s)) return 'lost';
  if (/^(push|refund|returned|tie|draw_no_bet)$/.test(s)) return 'push';
  if (/^(void|voided|cancel(l?ed)?|annul(l?ed)?|rejected)$/.test(s)) return 'void';
  if (/cashout|cashed/.test(s)) return 'cashout';
  if (/partial/.test(s)) return 'partial';
  return 'unknown';
}

/** Strings that plausibly name a team or player rather than a status or id. */
function looksLikeCompetitorName(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 2 || s.length > 60) return false;
  if (/^\d+$/.test(s)) return false;
  // Must contain a letter, and not be an obvious enum/slug.
  return /\p{L}/u.test(s) && !/^[a-z_]+$/.test(s);
}

/** Collects every string value at any depth, up to a cap. */
function collectStrings(v: unknown, out: string[], depth = 0, cap = 200): void {
  if (out.length >= cap || depth > 6) return;
  if (typeof v === 'string') {
    out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, depth + 1, cap);
    return;
  }
  if (isObj(v)) {
    for (const x of Object.values(v)) collectStrings(x, out, depth + 1, cap);
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ODDS_KEYS = new Set(K_ODDS.concat(K_TOTAL_ODDS).map(norm));

function isOddsKey(key: string): boolean {
  return ODDS_KEYS.has(norm(key));
}

/**
 * Is this value plausibly a price?
 *
 * The band alone is not enough, and getting this wrong is expensive: a taxonomy
 * tree full of integer ids like 11, 111 and 250 sits squarely inside the
 * decimal-odds range, so a naive band check makes every category list look like
 * it contains odds. Real prices are overwhelmingly non-integer, so an integer
 * only counts when it also sits under a price-ish key - which is how a genuine
 * `"odds": 11` still registers.
 */
function isOddsValue(v: unknown, key: string): boolean {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? num(v) : null;
  if (n === null || !looksLikeDecimalOdds(n)) return false;
  return !Number.isInteger(n) || isOddsKey(key);
}

/** Any value at any depth that reads as a price. */
function hasOddsLikeNumber(v: unknown, depth = 0, key = ''): boolean {
  if (depth > 5) return false;
  if (typeof v === 'number' || typeof v === 'string') return isOddsValue(v, key);
  if (Array.isArray(v)) return v.some((x) => hasOddsLikeNumber(x, depth + 1, key));
  if (isObj(v)) return Object.entries(v).some(([k, x]) => hasOddsLikeNumber(x, depth + 1, k));
  return false;
}

/** True when any object at any depth nests a child-array container. */
function hasChildArray(v: unknown, depth = 0): boolean {
  if (depth > 8 || !isObj(v)) {
    return Array.isArray(v) ? v.slice(0, 5).some((x) => hasChildArray(x, depth + 1)) : false;
  }
  for (const [k, child] of Object.entries(v)) {
    if (Array.isArray(child) && K_CHILDREN.some((c) => norm(c) === norm(k)) && child.length > 0) return true;
    if (hasChildArray(child, depth + 1)) return true;
  }
  return false;
}

function hasTimestampLike(o: Record<string, unknown>): boolean {
  return toEpochMs(pick(o, ...K_TS)) !== null || toEpochMs(pick(o, ...K_START)) !== null;
}

/** The masked handle a feed shows, if this object carries one. */
function handleOf(o: Record<string, unknown>): string | null {
  const direct = pick(o, ...K_USER);
  const s = str(direct);
  if (s) return s;
  // The handle is sometimes nested one level, e.g. { user: { name: "***tu" } }.
  if (isObj(direct)) {
    const nested = str(pick(direct, 'name', 'nick', 'login', 'username', 'displayName'));
    if (nested) return nested;
  }
  return null;
}

/** The nested array of legs, if this object carries one. */
function legsOf(o: Record<string, unknown>): { path: string; items: Record<string, unknown>[] } | null {
  for (const k of K_LEGS) {
    for (const [key, v] of Object.entries(o)) {
      if (key.toLowerCase().replace(/[^a-z]/g, '') !== k.toLowerCase().replace(/[^a-z]/g, '')) continue;
      if (Array.isArray(v)) {
        const objs = v.filter(isObj);
        if (objs.length > 0 && objs.length === v.length) return { path: key, items: objs };
      }
    }
  }
  return null;
}

/** Maximum nesting depth, used to recognise taxonomy trees. */
function maxDepth(v: unknown, depth = 0): number {
  if (depth > 12) return depth;
  if (Array.isArray(v)) return v.length ? Math.max(...v.slice(0, 5).map((x) => maxDepth(x, depth + 1))) : depth;
  if (isObj(v)) {
    const vals = Object.values(v).slice(0, 20);
    return vals.length ? Math.max(...vals.map((x) => maxDepth(x, depth + 1))) : depth;
  }
  return depth;
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

interface Score {
  kind: CaptureKind;
  points: number;
  reasons: string[];
}

/** Weight of the single strongest piece of evidence any rule can contribute. */
const DECISIVE = 3;

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}

function classifyByContentType(input: ClassifyInput): CaptureClassification | null {
  const ct = (input.contentType ?? '').toLowerCase();
  if (!ct) return null;
  if (/^(image|font|video|audio)\//.test(ct) || /text\/css|javascript|font-woff|octet-stream/.test(ct)) {
    return {
      kind: 'asset',
      confidence: 0.95,
      adapterId: GENERIC_BETBY_ID,
      reasons: [`content-type "${ct}" is a static asset, not data`],
      shapeFingerprint: shapeFingerprint(null),
    };
  }
  return null;
}

/**
 * Scores every candidate kind, then converts the winner's margin into a
 * calibrated confidence. Confidence is NOT the raw score: a payload can match
 * one rule strongly and still be ambiguous, and the panel must show that.
 */
export function classifyGeneric(input: ClassifyInput): CaptureClassification {
  const assetVerdict = classifyByContentType(input);
  if (assetVerdict) return assetVerdict;

  const fp = shapeFingerprint(input.json);
  const reasons: string[] = [];

  if (input.json === null || input.json === undefined) {
    return {
      kind: 'unknown',
      confidence: 0,
      adapterId: GENERIC_BETBY_ID,
      reasons: [
        input.text === null
          ? 'no readable body was captured (binary, empty, or the stream was already consumed)'
          : 'body is not JSON, so no structural rule could run',
      ],
      shapeFingerprint: fp,
    };
  }

  const scores: Score[] = [];
  const add = (kind: CaptureKind, points: number, reason: string) => {
    const existing = scores.find((s) => s.kind === kind);
    if (existing) {
      existing.points += points;
      existing.reasons.push(reason);
    } else {
      scores.push({ kind, points, reasons: [reason] });
    }
  };

  const arrays = findObjectArrays(input.json, { minLength: 1, limit: 12 });
  const biggest = arrays[0];
  const depth = maxDepth(input.json);

  /* --- Array-of-records rules: feeds, event lists, bet histories --------- */

  if (biggest && biggest.items.length >= 2) {
    const items = biggest.items;
    const n = items.length;
    reasons.push(`largest object array: ${n} items at "${biggest.path}"`);

    const fOdds = fractionOf(items, (o) => hasOddsLikeNumber(o));
    const fStake = fractionOf(items, (o) => looksLikeStake(num(pick(o, ...K_STAKE))));
    const fTs = fractionOf(items, (o) => hasTimestampLike(o));
    const fLegs = fractionOf(items, (o) => legsOf(o) !== null);
    const fHandle = fractionOf(items, (o) => looksLikeMaskedHandle(handleOf(o)));
    const fAnyUser = fractionOf(items, (o) => handleOf(o) !== null);

    const handles = new Set<string>();
    for (const o of items.slice(0, 60)) {
      const h = handleOf(o);
      if (h) handles.add(h.toLowerCase());
    }

    // Wager-shape evidence says "these rows are bets". It says NOTHING about
    // whose bets they are, so it is credited to both candidates equally. Only
    // the identity signal below can separate a public feed from one account's
    // own history - and when that signal is absent the two stay tied, which is
    // what drags the confidence below the threshold instead of letting a
    // coin-flip render as a fact.
    const wager: Array<[number, string]> = [];
    if (fOdds >= 0.6) wager.push([1, `${pct(fOdds)} of items contain a number in the decimal-odds band`]);
    if (fStake >= 0.5) wager.push([1, `${pct(fStake)} of items have a money-like value under a stake-ish key`]);
    if (fTs >= 0.5) wager.push([1, `${pct(fTs)} of items carry a parseable timestamp`]);
    if (fLegs >= 0.3) wager.push([1, `${pct(fLegs)} of items nest an array of leg-like objects`]);
    for (const [points, reason] of wager) {
      add('bets_feed', points, reason);
      add('user_bets', points, reason);
    }

    // The decisive discriminator.
    if (handles.size >= 3 && fAnyUser >= 0.5) {
      add('bets_feed', DECISIVE, `${handles.size} distinct bettor identities across ${n} items - a public feed, not one user's history`);
      if (fHandle >= 0.5) add('bets_feed', 1, `${pct(fHandle)} of identities are masked handles, as a public feed displays them`);
    } else if (fAnyUser >= 0.5 && handles.size <= 1) {
      add('user_bets', DECISIVE, `only ${handles.size} distinct bettor identity across ${n} items - reads as one account's own history`);
    } else if (wager.length >= 3) {
      // Wager-shaped but anonymous. Both remain tied; say so out loud.
      add('bets_feed', 0, 'no identity field found - a feed and a personal history are indistinguishable here');
      add('user_bets', 0, 'no identity field found - a personal history and a feed are indistinguishable here');
    }

    // Event list: competitor names + a start time + a market container.
    const fCompetitors = fractionOf(items, (o) => {
      const explicit = looksLikeCompetitorName(pick(o, ...K_HOME)) && looksLikeCompetitorName(pick(o, ...K_AWAY));
      if (explicit) return true;
      const list = pick(o, ...K_COMPETITORS);
      if (Array.isArray(list) && list.length >= 2) {
        const names: string[] = [];
        collectStrings(list, names, 0, 12);
        return names.filter(looksLikeCompetitorName).length >= 2;
      }
      return false;
    });
    const fStart = fractionOf(items, (o) => toEpochMs(pick(o, ...K_START)) !== null);
    const fMarkets = fractionOf(items, (o) => {
      const m = pick(o, ...K_MARKETS);
      return Array.isArray(m) ? m.length > 0 : isObj(m);
    });

    if (fCompetitors >= 0.5) {
      add('event_list', DECISIVE, `${pct(fCompetitors)} of items name two or more competitors`);
      if (fStart >= 0.5) add('event_list', 1, `${pct(fStart)} of items carry a start time`);
      if (fMarkets >= 0.3) add('event_list', 1, `${pct(fMarkets)} of items nest a markets/outcomes container`);
      if (fStake >= 0.5) add('event_list', -1, 'stake-like values present, which an event list would not normally carry');
    }
  } else if (arrays.length === 0) {
    reasons.push('no array of objects found at any depth');
  }

  /* --- Whole-payload rules ---------------------------------------------- */

  if (isObj(input.json)) {
    const o = input.json;
    const keys = Object.keys(o);

    // Single event with a market tree.
    const homeName = looksLikeCompetitorName(pick(o, ...K_HOME));
    const awayName = looksLikeCompetitorName(pick(o, ...K_AWAY));
    const marketsHere = pick(o, ...K_MARKETS);
    const marketCount = Array.isArray(marketsHere) ? marketsHere.length : 0;
    if (homeName && awayName && marketCount >= 2) {
      add('event_detail', DECISIVE, `single object naming two competitors with ${marketCount} nested markets`);
    }

    // Translation dictionary: mostly short strings, dotted keys.
    const values = Object.values(o);
    if (values.length >= 12) {
      const shortStrings = values.filter((v) => typeof v === 'string' && v.length < 120).length / values.length;
      const dotted = keys.filter((k) => k.includes('.') || k.includes('_')).length / keys.length;
      if (shortStrings >= 0.85 && dotted >= 0.5 && !hasOddsLikeNumber(o)) {
        add('translation', DECISIVE, `${keys.length} keys, ${pct(shortStrings)} short-string values, ${pct(dotted)} dotted/underscored keys, no odds anywhere`);
      }
    }

    // Bootstrap config: booleans and urls, no odds, no records.
    const bools = values.filter((v) => typeof v === 'boolean').length;
    const urls = values.filter((v) => typeof v === 'string' && /^https?:\/\//.test(v)).length;
    if ((bools >= 3 || urls >= 2) && !hasOddsLikeNumber(o) && (!biggest || biggest.items.length < 3)) {
      add('config', 2, `bootstrap-shaped: ${bools} boolean and ${urls} url values, no odds-like numbers`);
    }

    // Token-dominated payload.
    const tokenKeys = keys.filter((k) => /token|jwt|auth|secret|credential|refresh/i.test(k)).length;
    const redactedValues = values.filter((v) => typeof v === 'string' && v.startsWith('[redacted')).length;
    if (tokenKeys >= 1 && keys.length <= 12) {
      add('auth', 2, `${tokenKeys} of ${keys.length} top-level keys are credential-shaped`);
    }
    if (redactedValues >= 2) {
      add('auth', 1, `${redactedValues} values were masked by the redactor, which credential payloads trigger`);
    }

    // Odds update: small, id-heavy, carries prices, names nobody.
    const names: string[] = [];
    collectStrings(o, names, 0, 40);
    const competitorish = names.filter(looksLikeCompetitorName).length;
    const textLen = (input.text ?? '').length;
    if (hasOddsLikeNumber(o) && competitorish === 0 && textLen > 0 && textLen < 4000) {
      const weight = input.transport === 'websocket' ? DECISIVE : 1;
      add(
        'odds_update',
        weight,
        `${textLen}-byte payload with odds-like numbers and no competitor names${input.transport === 'websocket' ? ', pushed over a websocket' : ''}`,
      );
    }

    // Market-description dictionary: an object keyed by market id whose values
    // each carry a name and a variants/outcomes structure. Structural, so it
    // recognises the same dictionary on any BETBY book.
    const entries = Object.entries(o);
    if (entries.length >= 5) {
      const objectValues = entries.filter(([, v]) => isObj(v));
      const described = objectValues.filter(([, v]) => {
        const rec = v as Record<string, unknown>;
        return typeof rec['name'] === 'string' && (isObj(rec['variants']) || Array.isArray(rec['outcomes']));
      });
      const frac = objectValues.length > 0 ? described.length / objectValues.length : 0;
      if (described.length >= 5 && frac >= 0.8) {
        add(
          'market_list',
          DECISIVE,
          `${described.length} of ${objectValues.length} entries are named descriptors with an outcome/variant block - a market dictionary keyed by id`,
        );
      }
    }

    // Event tree: an `events` map whose values carry a descriptor with
    // competitors. This is the payload that names everything else.
    const eventsBlock = pick(o, 'events');
    if (isObj(eventsBlock)) {
      const eventValues = Object.values(eventsBlock).filter(isObj);
      const withDesc = eventValues.filter((e) => {
        const desc = (e as Record<string, unknown>)['desc'];
        return isObj(desc) && Array.isArray((desc as Record<string, unknown>)['competitors']);
      });
      if (withDesc.length >= 2) {
        add(
          'event_list',
          DECISIVE,
          `an "events" map of ${eventValues.length} entries, ${withDesc.length} carrying a descriptor with competitors - an event tree keyed by id`,
        );
        if (isObj(pick(o, 'sports')) || isObj(pick(o, 'tournaments'))) {
          add('event_list', 1, 'accompanied by sports/tournaments name maps');
        }
      }
    }

    // Taxonomy tree: deep nesting of named nodes, no odds, no times.
    if (depth >= 4 && hasChildArray(o) && !hasOddsLikeNumber(o)) {
      add('sport_tree', DECISIVE, `nested to depth ${depth} with child-array containers, no odds and no timestamps`);
    }
  }

  // Beacon-sized payloads on a non-JSON content type.
  const bodyLen = (input.text ?? '').length;
  if (bodyLen > 0 && bodyLen < 512 && input.direction === 'outbound' && !hasOddsLikeNumber(input.json)) {
    add('telemetry', 1, `${bodyLen}-byte outbound payload with no odds - beacon-shaped`);
  }

  /* --- Verdict ----------------------------------------------------------- */

  scores.sort((a, b) => b.points - a.points);
  const top = scores[0];
  const runnerUp = scores[1];

  if (!top || top.points < 2) {
    return {
      kind: 'unknown',
      confidence: top ? Math.min(0.4, top.points * 0.15) : 0,
      adapterId: GENERIC_BETBY_ID,
      reasons: [
        ...reasons,
        ...(top ? top.reasons : []),
        'no structural rule cleared the evidence floor - this payload is unclassified, not empty',
      ],
      shapeFingerprint: fp,
    };
  }

  // Confidence blends absolute evidence with the margin over the runner-up.
  // A payload that scores 5 but has a rival at 4 is genuinely ambiguous and
  // must not render as a fact.
  const absolute = Math.min(1, top.points / 6);
  const margin = runnerUp ? Math.min(1, (top.points - runnerUp.points) / 3) : 1;
  const confidence = Math.max(0, Math.min(0.97, 0.35 * absolute + 0.65 * (absolute * margin)));

  const verdictReasons = [...reasons, ...top.reasons];
  if (runnerUp && runnerUp.points >= top.points - 1) {
    verdictReasons.push(`ambiguous: "${runnerUp.kind}" scored ${runnerUp.points} against ${top.points} - ${runnerUp.reasons[0] ?? 'competing evidence'}`);
  }

  return {
    kind: top.kind,
    confidence,
    adapterId: GENERIC_BETBY_ID,
    reasons: verdictReasons,
    shapeFingerprint: fp,
  };
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** Tracks which dotted paths a rule consumed, so the rest can be reported. */
class Consumed {
  private readonly set = new Set<string>();
  mark(...paths: Array<string | null | undefined>): void {
    for (const p of paths) if (p) this.set.add(p);
  }
  /** Marks `prefix.key` for every key we read out of an object. */
  markKeys(prefix: string, obj: Record<string, unknown>, candidates: string[]): string | null {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = new Set(candidates.map(norm));
    for (const k of Object.keys(obj)) {
      if (wanted.has(norm(k))) {
        this.set.add(prefix ? `${prefix}.${k}` : k);
        return k;
      }
    }
    return null;
  }
  has(path: string): boolean {
    return this.set.has(path);
  }
  get size(): number {
    return this.set.size;
  }
}

function emptyPreview(kind: CaptureKind, adapterId: string, warnings: string[] = []): ParsePreview {
  return {
    adapterId,
    kind,
    events: [],
    markets: [],
    selections: [],
    bets: [],
    oddsSnapshots: [],
    warnings,
    unmappedFields: [],
  };
}

/**
 * Reads one leg out of a combo. Every field is optional; anything missing stays
 * null and the caller records why.
 */
function parseLeg(
  raw: Record<string, unknown>,
  idx: number,
  betKey: string,
  sportsbookId: string,
  consumed: Consumed,
  prefix: string,
  warnings: string[],
  refs: BetbyReference | null,
): NormalizedFeedBetLeg {
  consumed.markKeys(prefix, raw, K_EVENT_ID);
  consumed.markKeys(prefix, raw, K_SPORT);
  consumed.markKeys(prefix, raw, K_LEAGUE);
  consumed.markKeys(prefix, raw, K_EVENT_NAME);
  consumed.markKeys(prefix, raw, K_MARKET_NAME);
  consumed.markKeys(prefix, raw, K_SELECTION_NAME);
  consumed.markKeys(prefix, raw, K_LINE);
  consumed.markKeys(prefix, raw, K_SPECIFIERS);
  consumed.markKeys(prefix, raw, K_ODDS);
  consumed.markKeys(prefix, raw, K_STATUS);
  consumed.markKeys(prefix, raw, K_LIVE);

  const sourceEventId = str(pick(raw, ...K_EVENT_ID));
  const sport = str(pick(raw, ...K_SPORT));
  const league = str(pick(raw, ...K_LEAGUE));
  const eventName = str(pick(raw, ...K_EVENT_NAME));
  const marketName = str(pick(raw, ...K_MARKET_NAME));
  const selectionName = str(pick(raw, ...K_SELECTION_NAME));
  // A numeric line field wins when present; otherwise fall back to the BETBY
  // specifier string, which is where every real handicap and total lives.
  const specifierRaw = str(pick(raw, ...K_SPECIFIERS)) ?? '';
  const spec = parseSpecifiers(specifierRaw);
  const line = num(pick(raw, ...K_LINE)) ?? spec.line;

  const rawOdds = num(pick(raw, ...K_ODDS));
  let oddsAtBet: number | null = null;
  if (rawOdds !== null) {
    if (isValidDecimalOdds(rawOdds)) oddsAtBet = rawOdds;
    else warnings.push(`leg ${idx}: value ${rawOdds} under an odds-like key is outside the valid decimal-odds range, dropped`);
  }

  const evKey = sourceEventId || eventName
    ? makeEventKey({
        sportsbookId,
        sourceEventId,
        sport,
        league,
        competitors: eventName ? eventName.split(/\s+(?:vs?\.?|-|@)\s+/i) : [],
      })
    : null;

  const mkKey = evKey
    ? makeMarketKey({
        sportsbookId,
        eventKey: evKey,
        sourceMarketId: str(pick(raw, ...K_MARKET_ID)),
        name: marketName,
        line,
        period: spec.period,
      })
    : null;

  const selKey =
    evKey && mkKey
      ? makeSelectionKey({
          sportsbookId,
          eventKey: evKey,
          marketKey: mkKey,
          sourceSelectionId: str(pick(raw, ...K_SELECTION_ID)),
          name: selectionName,
          line,
        })
      : null;

  // A feed leg names nothing - it is ids and a specifier string. When the
  // reference dictionaries have been captured, join against them to recover the
  // teams, the market and the outcome. Anything still unknown stays null.
  let resolvedEventName = eventName;
  let resolvedSport = sport;
  let resolvedLeague = league;
  let resolvedMarketName = marketName;
  let resolvedSelectionName = selectionName;
  let currentOdds: number | null = null;

  if (refs) {
    const hit = resolveLeg(refs, {
      eventId: sourceEventId,
      marketId: str(pick(raw, ...K_MARKET_ID)),
      outcomeId: str(pick(raw, ...K_SELECTION_ID)),
      specifiers: spec.all,
      specifierKey: specifierRaw,
    });
    resolvedEventName = eventName ?? hit.eventName;
    resolvedSport = sport ?? hit.sport;
    resolvedLeague = league ?? hit.league;
    resolvedMarketName = marketName ?? hit.marketName;
    resolvedSelectionName = selectionName ?? hit.selectionName;
    currentOdds = hit.currentOdds;
  }

  return {
    betKey,
    idx,
    eventKey: evKey,
    sourceEventId,
    sport: resolvedSport,
    league: resolvedLeague,
    eventName: resolvedEventName,
    marketKey: mkKey,
    marketName: resolvedMarketName,
    selectionKey: selKey,
    selectionName: resolvedSelectionName,
    line,
    oddsAtBet,
    // Present only when the event tree carried a live price for this exact
    // selection; the feed row itself never has one.
    currentOdds,
    live: bool(pick(raw, ...K_LIVE)),
    status: toBetStatus(pick(raw, ...K_STATUS)),
  };
}

function parseFeedBets(
  items: Record<string, unknown>[],
  arrayPath: string,
  sportsbookId: string,
  consumed: Consumed,
  warnings: string[],
  refs: BetbyReference | null,
): NormalizedFeedBet[] {
  const out: NormalizedFeedBet[] = [];
  // Counted and reported once. Some feeds - BETBY's among them - carry no
  // timestamp at all, and one warning per row would bury every other warning.
  let missingTs = 0;

  for (const raw of items) {
    const prefix = `${arrayPath}[]`;
    consumed.markKeys(prefix, raw, K_BET_ID);
    consumed.markKeys(prefix, raw, K_ID);
    consumed.markKeys(prefix, raw, K_TS);
    consumed.markKeys(prefix, raw, K_USER);
    consumed.markKeys(prefix, raw, K_STAKE);
    consumed.markKeys(prefix, raw, K_CURRENCY);
    consumed.markKeys(prefix, raw, K_TOTAL_ODDS);
    consumed.markKeys(prefix, raw, K_PAYOUT);
    consumed.markKeys(prefix, raw, K_STATUS);
    consumed.markKeys(prefix, raw, K_LIVE);

    const label = handleOf(raw);
    const bKey = makeBettorKey(sportsbookId, label);
    const ts = toEpochMs(pick(raw, ...K_TS));
    if (ts === null) missingTs++;

    // Stake arrives as "50.01 $" on every BETBY book we have observed, so it
    // goes through the money reader rather than the strict numeric one.
    const stakeMoney = parseMoney(pick(raw, ...K_STAKE));
    const payoutMoney = parseMoney(pick(raw, ...K_PAYOUT));
    const stake = stakeMoney ? stakeMoney.amount : null;
    const explicitCurrency = looksLikeCurrencyCode(pick(raw, ...K_CURRENCY)) ? str(pick(raw, ...K_CURRENCY)) : null;
    const currency = explicitCurrency ?? stakeMoney?.currency ?? payoutMoney?.currency ?? null;

    const rawTotal = num(pick(raw, ...K_TOTAL_ODDS)) ?? num(pick(raw, ...K_ODDS));
    let totalOdds: number | null = null;
    if (rawTotal !== null) {
      if (isValidDecimalOdds(rawTotal)) totalOdds = rawTotal;
      else warnings.push(`total odds ${rawTotal} is outside the valid decimal range, dropped`);
    }

    const legContainer = legsOf(raw);
    const legsRaw = legContainer?.items ?? [];
    if (legContainer) consumed.mark(`${prefix}.${legContainer.path}`);

    // Placeholder key so legs can reference their parent; recomputed below once
    // the fingerprint is known.
    const legs = legsRaw.map((l, i) =>
      parseLeg(l, i, '', sportsbookId, consumed, `${prefix}.${legContainer?.path ?? 'legs'}[]`, warnings, refs),
    );

    const key = makeFeedBetKey({
      sportsbookId,
      sourceBetId: str(pick(raw, ...K_BET_ID)) ?? str(pick(raw, ...K_ID)),
      bettorKey: bKey,
      ts,
      stake,
      totalOdds,
      legFingerprint: legFingerprint(legs),
    });
    for (const l of legs) l.betKey = key;

    // Type is only asserted when legs were actually found. A single-leg-looking
    // row with no legs array might be a combo we failed to read.
    let type: BetType = 'unknown';
    if (legs.length === 1) type = 'single';
    else if (legs.length > 1) type = 'combo';

    out.push({
      key,
      sportsbookId,
      sourceBetId: str(pick(raw, ...K_BET_ID)) ?? str(pick(raw, ...K_ID)),
      ts: ts ?? 0,
      bettorKey: bKey,
      bettorLabel: label,
      stake,
      currency,
      stakeUsd: null, // no FX rate source yet; never invent one
      totalOdds,
      potentialWin: payoutMoney ? payoutMoney.amount : null,
      type,
      legCount: legs.length,
      live: bool(pick(raw, ...K_LIVE)),
      status: toBetStatus(pick(raw, ...K_STATUS)),
      legs,
    });
  }

  if (missingTs > 0) {
    warnings.push(
      `${missingTs} of ${items.length} feed rows carry no timestamp field. Their ts is 0, so ordering must come from ` +
        'observation time (when we captured the row), not from the payload. This is normal for BETBY feeds.',
    );
  }

  return out;
}

function parseEventList(
  items: Record<string, unknown>[],
  arrayPath: string,
  sportsbookId: string,
  captureId: string | null,
  now: number,
  consumed: Consumed,
  warnings: string[],
): { events: NormalizedEvent[]; markets: NormalizedMarket[]; selections: NormalizedSelection[]; snapshots: OddsSnapshot[] } {
  const events: NormalizedEvent[] = [];
  const markets: NormalizedMarket[] = [];
  const selections: NormalizedSelection[] = [];
  const snapshots: OddsSnapshot[] = [];
  const prefix = `${arrayPath}[]`;

  for (const raw of items) {
    consumed.markKeys(prefix, raw, K_EVENT_ID);
    consumed.markKeys(prefix, raw, K_SPORT);
    consumed.markKeys(prefix, raw, K_LEAGUE);
    consumed.markKeys(prefix, raw, K_HOME);
    consumed.markKeys(prefix, raw, K_AWAY);
    consumed.markKeys(prefix, raw, K_COMPETITORS);
    consumed.markKeys(prefix, raw, K_START);
    consumed.markKeys(prefix, raw, K_LIVE);
    consumed.markKeys(prefix, raw, K_STATUS);

    const home = str(pick(raw, ...K_HOME));
    const away = str(pick(raw, ...K_AWAY));
    let competitors = [home, away].filter((x): x is string => Boolean(x));
    if (competitors.length < 2) {
      const list = pick(raw, ...K_COMPETITORS);
      if (Array.isArray(list)) {
        const names: string[] = [];
        collectStrings(list, names, 0, 12);
        competitors = names.filter(looksLikeCompetitorName).slice(0, 8);
      }
    }
    if (competitors.length === 0) continue;

    const sourceEventId = str(pick(raw, ...K_EVENT_ID));
    const sport = str(pick(raw, ...K_SPORT));
    const league = str(pick(raw, ...K_LEAGUE));
    const startTime = toEpochMs(pick(raw, ...K_START));

    const evKey = makeEventKey({ sportsbookId, sourceEventId, sport, league, competitors, startTime });
    events.push({
      key: evKey,
      sportsbookId,
      sourceEventId,
      sport,
      league,
      competitors,
      home,
      away,
      name: str(pick(raw, ...K_EVENT_NAME)) ?? (competitors.length >= 2 ? `${competitors[0]} vs ${competitors[1]}` : null),
      startTime,
      live: bool(pick(raw, ...K_LIVE)),
      status: str(pick(raw, ...K_STATUS)),
    });

    const marketContainer = pick(raw, ...K_MARKETS);
    if (!Array.isArray(marketContainer)) continue;
    consumed.markKeys(prefix, raw, K_MARKETS);

    for (const m of marketContainer.filter(isObj)) {
      const mLine = num(pick(m, ...K_LINE));
      const mName = str(pick(m, ...K_MARKET_NAME));
      const mkKey = makeMarketKey({
        sportsbookId,
        eventKey: evKey,
        sourceMarketId: str(pick(m, ...K_MARKET_ID)),
        name: mName,
        line: mLine,
      });
      markets.push({
        key: mkKey,
        eventKey: evKey,
        sportsbookId,
        sourceMarketId: str(pick(m, ...K_MARKET_ID)),
        type: null, // market-family mapping needs real labels; guessing would be worse than null
        name: mName,
        line: mLine,
        period: null,
        status: str(pick(m, ...K_STATUS)),
      });

      const outcomeContainer = pick(m, 'outcomes', 'selections', 'odds', 'items', 'results');
      if (!Array.isArray(outcomeContainer)) continue;

      for (const s of outcomeContainer.filter(isObj)) {
        const sLine = num(pick(s, ...K_LINE)) ?? mLine;
        const sName = str(pick(s, ...K_SELECTION_NAME));
        const rawOdds = num(pick(s, ...K_ODDS));
        let odds: number | null = null;
        if (rawOdds !== null) {
          if (isValidDecimalOdds(rawOdds)) odds = rawOdds;
          else warnings.push(`selection "${sName ?? 'unnamed'}": odds ${rawOdds} outside the valid decimal range, dropped`);
        }

        const selKey = makeSelectionKey({
          sportsbookId,
          eventKey: evKey,
          marketKey: mkKey,
          sourceSelectionId: str(pick(s, ...K_SELECTION_ID)),
          name: sName,
          line: sLine,
        });
        selections.push({
          key: selKey,
          marketKey: mkKey,
          eventKey: evKey,
          sportsbookId,
          sourceSelectionId: str(pick(s, ...K_SELECTION_ID)),
          name: sName,
          side: null,
          line: sLine,
          decimalOdds: odds,
          status: str(pick(s, ...K_STATUS)),
        });

        if (odds !== null) {
          snapshots.push({
            sportsbookId,
            eventKey: evKey,
            marketKey: mkKey,
            selectionKey: selKey,
            ts: now,
            decimalOdds: odds,
            line: sLine,
            status: str(pick(s, ...K_STATUS)),
            captureId,
          });
        }
      }
    }
  }

  return { events, markets, selections, snapshots };
}

export function parseGeneric(input: ParseInput): ParsePreview {
  const { classification, sportsbookId, ctx, captureId } = input;
  const kind = classification.kind;
  const warnings: string[] = [];
  const consumed = new Consumed();

  if (input.json === null || input.json === undefined) {
    return emptyPreview(kind, GENERIC_BETBY_ID, [
      'No JSON body to parse. Nothing was extracted - this is a capture we can store but not yet read.',
    ]);
  }

  // ctx.refs is typed `unknown` in the shared contract so that file stays
  // platform-neutral; only this adapter knows the dictionary's shape.
  const refs = (ctx.refs ?? null) as BetbyReference | null;

  const preview = emptyPreview(kind, GENERIC_BETBY_ID, warnings);
  const arrays = findObjectArrays(input.json, { minLength: 1, limit: 12 });
  const biggest = arrays[0];

  if ((kind === 'bets_feed' || kind === 'user_bets') && biggest) {
    preview.bets = parseFeedBets(biggest.items, biggest.path, sportsbookId, consumed, warnings, refs);
    if (preview.bets.length === 0) {
      warnings.push('classified as a bets feed but no row yielded a readable bet - the field names differ from every spelling we try');
    }
  } else if ((kind === 'event_list' || kind === 'event_detail') && (biggest || isObj(input.json))) {
    const items = biggest ? biggest.items : [input.json as Record<string, unknown>];
    const path = biggest ? biggest.path : '$';
    const r = parseEventList(items, path, sportsbookId, captureId, ctx.now, consumed, warnings);
    preview.events = r.events;
    preview.markets = r.markets;
    preview.selections = r.selections;
    preview.oddsSnapshots = r.snapshots;
    if (preview.events.length === 0) {
      warnings.push('classified as an event list but no row yielded competitor names we could read');
    }
  } else if (kind === 'odds_update') {
    warnings.push(
      'Odds updates reference ids assigned by an earlier payload. Correlating them needs the event/market payload captured first, which is Milestone 5 - nothing is extracted here yet.',
    );
  } else {
    warnings.push(`No parser is wired for kind "${kind}". The raw capture is stored intact and can be re-parsed once a rule exists.`);
  }

  // Everything the rules did not touch. This is the schema-discovery output.
  const allPaths = flattenPaths(input.json, { maxPaths: 500 });
  // A path counts as consumed if it, or any of its ancestors, was read by a
  // rule - so a fully-parsed legs array does not report each of its leaves.
  preview.unmappedFields = allPaths.map((p) => p.path).filter((p) => !consumedPrefix(consumed, p));

  return preview;
}

function consumedPrefix(consumed: Consumed, path: string): boolean {
  const parts = path.split('.');
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join('.');
    if (consumed.has(candidate)) return true;
    if (consumed.has(candidate.replace(/\[\]$/, ''))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Adapter object
 * ------------------------------------------------------------------ */

export const genericBetbyAdapter: SportsbookAdapter = {
  id: GENERIC_BETBY_ID,
  label: 'BETBY (generic)',
  platform: 'betby',
  // Never claims a host. It is the fallback parser for any BETBY-shaped
  // traffic; host-specific adapters match first.
  matches: () => false,
  classify: classifyGeneric,
  parse: parseGeneric,
};
