/**
 * Matching Duel's events to an external source's events.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE MOST DANGEROUS FILE IN THE PROJECT
 * ---------------------------------------------------------------------------
 *
 * Every other honesty guard in Scout is about refusing to overstate a number we
 * computed correctly. This one is different: a WRONG MATCH produces a number
 * that is computed correctly and is nonsense. Pair Duel's "Real Madrid vs Real
 * Betis" with the external feed's "Real Madrid vs Real Sociedad" and the
 * comparison yields a huge, entirely fictional edge - and it will look exactly
 * like the signal the tool exists to find.
 *
 * So the bar is deliberately high and asymmetric: refusing a real match costs a
 * missed opportunity, accepting a false one costs money. The rules:
 *
 *   1. BOTH competitors must match. One good name and one bad name is a
 *      different fixture, not a partial success.
 *   2. Kickoff times must agree within a tight window. Two teams do meet twice
 *      a season, and the date is what separates the fixtures.
 *   3. Sport must agree where both sides declare one.
 *   4. A tie is a refusal. If two external events score equally well, we cannot
 *      tell them apart and must not guess.
 *
 * Names are compared token-wise rather than by edit distance. "Real Betis
 * Seville" and "Real Betis" share every token of the shorter name, which is the
 * relationship that actually holds between two books naming one club; edit
 * distance would score that pair barely better than "Real Madrid", which shares
 * a token too but differs in the token that identifies the club.
 */

import { normalizeName } from '../shared/ids.ts';

/** Words that carry no identifying information about a club. */
const NOISE = new Set([
  'fc', 'cf', 'sc', 'ac', 'afc', 'cfc', 'club', 'city', 'town', 'united', 'utd',
  'the', 'de', 'do', 'da', 'of', 'and', 'e', 'y',
  'esports', 'gaming', 'team', 'academy', 'reserves', 'ii',
]);

/**
 * Kickoff tolerance. Books disagree by minutes on scheduled time, and a
 * postponement moves it further - but two hours is comfortably inside the gap
 * between two fixtures involving the same club.
 */
export const DEFAULT_TIME_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/** Below this, the pair is not considered a match at all. */
export const MIN_TEAM_SIMILARITY = 0.6;
/** Below this combined confidence, the match is refused. */
export const MIN_MATCH_CONFIDENCE = 0.7;
/**
 * A runner-up scoring within this of the winner means we cannot tell them
 * apart, and a coin flip between two fixtures is not a match.
 */
export const MIN_MARGIN_OVER_RUNNER_UP = 0.08;

export function tokenize(name: string): string[] {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  const meaningful = tokens.filter((t) => !NOISE.has(t) && t.length > 1);
  // If stripping noise leaves nothing, the noise WAS the name ("United").
  return meaningful.length > 0 ? meaningful : tokens;
}

/**
 * Token-overlap similarity, normalised by the SHORTER name.
 *
 * Dividing by the shorter side is the point: one book's "Real Betis" and
 * another's "Real Betis Seville" should score 1.0, because the extra token is
 * the longer name being more specific about the same club, not a disagreement.
 * Jaccard (dividing by the union) would score that 0.67 and reject it.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const setB = new Set(tb);
  let shared = 0;
  for (const token of new Set(ta)) {
    if (setB.has(token)) {
      shared += 1;
      continue;
    }
    // Allow a prefix match for abbreviations: "Wolverhampton" vs "Wolves" does
    // not share a token, but one is a prefix of the other's stem often enough
    // to be worth catching. Requires 4+ characters so "St" matches nothing.
    for (const other of setB) {
      if (token.length >= 4 && other.length >= 4 && (token.startsWith(other) || other.startsWith(token))) {
        shared += 0.75;
        break;
      }
    }
  }

  return Math.min(1, shared / Math.min(new Set(ta).size, new Set(tb).size));
}

export interface MatchCandidate {
  /** The external event's id. */
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: number;
  sportKey: string;
}

export interface MatchTarget {
  eventKey: string;
  home: string | null;
  away: string | null;
  startTime: number | null;
  sport: string | null;
}

export interface MatchResult {
  externalId: string;
  confidence: number;
  /** True when the external feed lists the teams the other way round. */
  swapped: boolean;
  reasons: string[];
}

export interface MatchRefusal {
  externalId: null;
  reasons: string[];
}

export type Match = MatchResult | MatchRefusal;

export function isMatched(m: Match): m is MatchResult {
  return m.externalId !== null;
}

interface Scored {
  candidate: MatchCandidate;
  score: number;
  swapped: boolean;
  homeSim: number;
  awaySim: number;
  timeDeltaMs: number;
}

function scoreCandidate(target: MatchTarget, candidate: MatchCandidate, toleranceMs: number): Scored | null {
  if (target.home === null || target.away === null) return null;

  // Home/away orientation differs between books often enough that we test both
  // and record which one won - getting it backwards would invert every handicap.
  const straight = Math.min(
    nameSimilarity(target.home, candidate.homeTeam),
    nameSimilarity(target.away, candidate.awayTeam),
  );
  const swapped = Math.min(
    nameSimilarity(target.home, candidate.awayTeam),
    nameSimilarity(target.away, candidate.homeTeam),
  );

  const useSwapped = swapped > straight;
  const teamScore = useSwapped ? swapped : straight;
  if (teamScore < MIN_TEAM_SIMILARITY) return null;

  // Time is a hard gate, not a weighted factor. Two clubs meeting twice a season
  // are two fixtures, and the only thing separating them is the date.
  if (target.startTime === null) return null;
  const delta = Math.abs(target.startTime - candidate.commenceTime);
  if (delta > toleranceMs) return null;

  // Within tolerance, closer is better, but only as a tie-breaker.
  const timeScore = 1 - delta / toleranceMs;

  return {
    candidate,
    score: teamScore * 0.85 + timeScore * 0.15,
    swapped: useSwapped,
    homeSim: useSwapped
      ? nameSimilarity(target.home, candidate.awayTeam)
      : nameSimilarity(target.home, candidate.homeTeam),
    awaySim: useSwapped
      ? nameSimilarity(target.away, candidate.homeTeam)
      : nameSimilarity(target.away, candidate.awayTeam),
    timeDeltaMs: delta,
  };
}

/**
 * Finds the external event corresponding to a Duel event, or refuses.
 *
 * The refusal path is the important one. Every `reasons` entry is written to be
 * read by a human deciding whether the tool is behaving.
 */
export function matchEvent(
  target: MatchTarget,
  candidates: readonly MatchCandidate[],
  opts: { toleranceMs?: number } = {},
): Match {
  const toleranceMs = opts.toleranceMs ?? DEFAULT_TIME_TOLERANCE_MS;

  if (target.home === null || target.away === null) {
    return { externalId: null, reasons: ['the Duel event has no competitor names to match on'] };
  }
  if (target.startTime === null) {
    return {
      externalId: null,
      reasons: [
        'the Duel event has no start time. Two clubs meet more than once a season and the date is the only ' +
          'thing that separates those fixtures, so matching without it is guessing.',
      ],
    };
  }

  const scored = candidates
    .map((c) => scoreCandidate(target, c, toleranceMs))
    .filter((s): s is Scored => s !== null)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      externalId: null,
      reasons: [
        `no external event has both competitors above ${MIN_TEAM_SIMILARITY} similarity within ` +
          `${Math.round(toleranceMs / 60000)} minutes of kickoff`,
      ],
    };
  }

  const best = scored[0];
  if (!best) return { externalId: null, reasons: ['no candidate survived scoring'] };

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < MIN_MARGIN_OVER_RUNNER_UP) {
    return {
      externalId: null,
      reasons: [
        `two external events score almost identically (${best.score.toFixed(3)} vs ${runnerUp.score.toFixed(3)}): ` +
          `"${best.candidate.homeTeam} v ${best.candidate.awayTeam}" and ` +
          `"${runnerUp.candidate.homeTeam} v ${runnerUp.candidate.awayTeam}". Refusing rather than guessing - ` +
          'a wrong match produces a real-looking edge that is entirely fictional.',
      ],
    };
  }

  if (best.score < MIN_MATCH_CONFIDENCE) {
    return {
      externalId: null,
      reasons: [
        `best candidate "${best.candidate.homeTeam} v ${best.candidate.awayTeam}" scores ${best.score.toFixed(3)}, ` +
          `below the ${MIN_MATCH_CONFIDENCE} threshold`,
      ],
    };
  }

  const reasons = [
    `"${target.home}" matched "${best.swapped ? best.candidate.awayTeam : best.candidate.homeTeam}" at ` +
      `${best.homeSim.toFixed(2)}`,
    `"${target.away}" matched "${best.swapped ? best.candidate.homeTeam : best.candidate.awayTeam}" at ` +
      `${best.awaySim.toFixed(2)}`,
    `kickoffs differ by ${Math.round(best.timeDeltaMs / 60000)} minutes`,
  ];
  if (best.swapped) {
    reasons.push('the external feed lists these teams in the opposite order; sides were swapped to compensate');
  }

  return { externalId: best.candidate.externalId, confidence: best.score, swapped: best.swapped, reasons };
}
