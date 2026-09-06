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
  ['premier league', { key: 'soccer_epl', note: 'England top flight' }],
  ['laliga', { key: 'soccer_spain_la_liga', note: 'Spain top flight' }],
  ['la liga', { key: 'soccer_spain_la_liga', note: 'Spain top flight' }],
  ['serie a', { key: 'soccer_italy_serie_a', note: 'Italy top flight' }],
  ['bundesliga', { key: 'soccer_germany_bundesliga', note: 'Germany top flight' }],
  ['ligue 1', { key: 'soccer_france_ligue_one', note: 'France top flight' }],
  ['uefa champions league', { key: 'soccer_uefa_champs_league', note: 'UEFA Champions League' }],
  ['champions league', { key: 'soccer_uefa_champs_league', note: 'UEFA Champions League' }],
  ['mls', { key: 'soccer_usa_mls', note: 'Major League Soccer' }],
  ['nfl', { key: 'americanfootball_nfl', note: 'NFL' }],
  ['ncaa', { key: 'americanfootball_ncaaf', note: 'NCAA football' }],
  ['nba', { key: 'basketball_nba', note: 'NBA' }],
  ['mlb', { key: 'baseball_mlb', note: 'MLB' }],
  ['nhl', { key: 'icehockey_nhl', note: 'NHL' }],
  ['atp', { key: 'tennis_atp_aus_open_singles', note: 'ATP - tournament-specific upstream, verify before use' }],
]);

/** Sport-level fallback, used only when the league itself is unmapped. */
const SPORT_MAP: ReadonlyMap<string, SportMapping> = new Map([
  ['american football', { key: 'americanfootball_nfl', note: 'defaults to NFL; college fixtures will not match' }],
  ['baseball', { key: 'baseball_mlb', note: 'defaults to MLB' }],
  ['ice hockey', { key: 'icehockey_nhl', note: 'defaults to NHL' }],
]);

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
export function resolveSportKey(sport: string | null, league: string | null): SportKeyResult {
  const leagueKey = league === null ? '' : normalizeName(league);
  if (leagueKey) {
    const hit = LEAGUE_MAP.get(leagueKey);
    if (hit) return { key: hit.key, note: hit.note };
  }

  const sportKey = sport === null ? '' : normalizeName(sport);
  if (sportKey) {
    const hit = SPORT_MAP.get(sportKey);
    if (hit) return { key: hit.key, note: `${hit.note} (matched on sport, not league)` };
  }

  return {
    key: null,
    note:
      `no external sport key is mapped for ${sport ?? 'unknown sport'} / ${league ?? 'unknown league'}. ` +
      'Unmapped is deliberate: guessing between a first and second division would produce a large, entirely ' +
      'fictional edge. Add it to LEAGUE_MAP once the correspondence has been checked.',
  };
}

/** Every league currently mapped, for display. */
export function mappedLeagues(): Array<{ league: string; key: string; note: string }> {
  return [...LEAGUE_MAP.entries()].map(([league, m]) => ({ league, key: m.key, note: m.note }));
}
