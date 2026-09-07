/**
 * Mapping Duel's sport and league names to an external source's sport keys.
 *
 * Kept explicit rather than fuzzy. Matching "Soccer / LaLiga" to
 * `soccer_spain_la_liga` by string similarity would also cheerfully match it to
 * `soccer_spain_segunda_division`, and the price difference between a first and
 * second division fixture is exactly the kind of phantom edge this project must
 * not produce.
 *
 * So: a league we have not mapped returns null and the caller says "unmapped"
 * rather than guessing. The list grows by observation - run the collector, see
 * which leagues appear in `/api/analysis/margins`, and add the ones worth
 * comparing.
 *
 * Keys were taken from The Odds API's published /sports listing.
 */

import { normalizeName } from '../shared/ids.ts';
import { competitionKey } from './scrapers/pinnacle.ts';
import type { Competition } from './types.ts';

export interface SportMapping {
  /** External sport key. */
  key: string;
  /** Why this mapping is safe, for a human auditing it. */
  note: string;
}

/**
 * Duel league name (normalised) -> external sport key.
 *
 * Only competitions where the correspondence is unambiguous. Anything with a
 * reserve league, a youth division or a same-named cup is deliberately absent
 * until someone has checked it.
 */
const LEAGUE_MAP: ReadonlyMap<string, SportMapping> = new Map([
  ['soccer|england|premier league', { key: 'soccer_epl', note: 'England top flight' }],
  ['soccer|spain|laliga', { key: 'soccer_spain_la_liga', note: 'Spain top flight' }],
  ['soccer|spain|la liga', { key: 'soccer_spain_la_liga', note: 'Spain top flight' }],
  ['soccer|italy|serie a', { key: 'soccer_italy_serie_a', note: 'Italy top flight' }],
  ['soccer|germany|bundesliga', { key: 'soccer_germany_bundesliga', note: 'Germany top flight' }],
  ['soccer|france|ligue 1', { key: 'soccer_france_ligue_one', note: 'France top flight' }],
  ['soccer|international|champions league', { key: 'soccer_uefa_champs_league', note: 'UEFA Champions League' }],
  ['soccer|europe|champions league', { key: 'soccer_uefa_champs_league', note: 'UEFA Champions League' }],
  ['soccer|usa|mls', { key: 'soccer_usa_mls', note: 'Major League Soccer' }],
  ['american football|usa|nfl', { key: 'americanfootball_nfl', note: 'NFL' }],
  ['american football|usa|ncaa', { key: 'americanfootball_ncaaf', note: 'NCAA football' }],
  ['basketball|usa|nba', { key: 'basketball_nba', note: 'NBA' }],
  ['baseball|usa|mlb', { key: 'baseball_mlb', note: 'MLB' }],
  ['ice hockey|usa|nhl', { key: 'icehockey_nhl', note: 'NHL' }],
]);

/**
 * The sport-level fallback is GONE, deliberately.
 *
 * It used to map bare "Baseball" to MLB and "American Football" to the NFL.
 * That is the same class of error as mapping "Premier League" to England:
 * "Baseball / Japan / NPB" would have been compared against MLB prices. A
 * competition is identified by sport AND country AND league, or not at all.
 */

export interface SportKeyResult {
  key: string | null;
  note: string;
}

/**
 * Resolves a Duel sport/league pair to an external sport key.
 *
 * League first: it is the specific statement. The sport fallback is offered
 * only where one competition dominates the sport, and it says so in the note,
 * because "Baseball" meaning MLB is an assumption that fails on the day a
 * Japanese league fixture appears.
 */
export function resolveSportKey(competition: Competition): SportKeyResult {
  const hit = LEAGUE_MAP.get(competitionKey(competition));
  if (hit) return { key: hit.key, note: hit.note };

  return {
    key: null,
    note:
      `no external sport key is mapped for ${competition.sport ?? '?'} / ${competition.country ?? '?'} / ` +
      `${competition.league ?? '?'}. Unmapped is deliberate: Duel serves "Premier League" for England, Malta ` +
      'and Kenya, so a name-only match would compare Maltese football against the English top flight. Add it to ' +
      'LEAGUE_MAP once the correspondence has been checked.',
  };
}

/** Every league currently mapped, for display. */
export function mappedLeagues(): Array<{ league: string; key: string; note: string }> {
  return [...LEAGUE_MAP.entries()].map(([league, m]) => ({ league, key: m.key, note: m.note }));
}
