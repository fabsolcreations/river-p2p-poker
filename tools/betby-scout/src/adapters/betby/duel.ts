/**
 * Duel adapter.
 *
 * Right now this is host matching and nothing else, and that is the honest
 * state of it. Every Duel-specific override below is empty because we have not
 * yet seen a single real BETBY payload from duel.com - the collector exists to
 * go and get them. Filling this file in before that happens would mean
 * inventing an API and then writing code that appears to work against our own
 * invention.
 *
 * What goes here at Milestone 2, once a capture export comes back:
 *   - overrides for field spellings that Duel uses and generic-betby misses
 *   - the currency Duel reports stakes in, so stakeUsd stops being null
 *   - any Duel-specific wrapper the payloads are nested inside
 *   - real fixtures in tests/adapters.test.ts, replacing the invented shapes
 *
 * Host matching is legitimate here in a way that endpoint guessing is not: we
 * know the user is on duel.com because they told us, and matching only picks
 * which parser to use. It never filters what gets captured.
 */

import type { CaptureClassification, ClassifyInput, ParseInput, ParsePreview, SportsbookAdapter } from '../../shared/types.ts';
import { classifyGeneric, parseGeneric } from './generic-betby.ts';

export const DUEL_ID = 'betby.duel';
export const DUEL_SPORTSBOOK_ID = 'duel';

/** Hosts that are unambiguously Duel's own. */
function isDuelHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'duel.com' || h.endsWith('.duel.com');
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

export const duelAdapter: SportsbookAdapter = {
  id: DUEL_ID,
  label: 'Duel',
  platform: 'betby',

  matches({ pageOrigin, frameOrigin, url }) {
    // The page origin is what decides the book. A BETBY widget iframe is served
    // from a different host, and we deliberately do NOT try to recognise that
    // host - it is discovered by the frame reporter and shown to the user, not
    // hardcoded here.
    return isDuelHost(hostOf(pageOrigin)) || isDuelHost(hostOf(frameOrigin)) || isDuelHost(hostOf(url));
  },

  classify(input: ClassifyInput): CaptureClassification {
    const base = classifyGeneric(input);
    // No Duel-specific classification rules yet - see the file header. Only the
    // adapter id changes, so the panel shows which adapter produced the verdict.
    return { ...base, adapterId: DUEL_ID };
  },

  parse(input: ParseInput): ParsePreview {
    const base = parseGeneric(input);
    return { ...base, adapterId: DUEL_ID };
  },
};
