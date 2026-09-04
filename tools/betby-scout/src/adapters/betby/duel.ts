/**
 * Duel adapter.
 *
 * PROVENANCE - everything in this file was OBSERVED, not guessed.
 *
 * Captured 2026-09-04 from https://duel.com/sports in a clean browser, logged
 * out, by wrapping window.fetch and window.WebSocket and reading what the page
 * itself requested. No authentication, no bypass, no endpoint invented. The
 * real responses are checked in at tests/fixtures/duel-*.json and the tests run
 * against them.
 *
 * WHAT THIS TOLD US, and why each part matters:
 *
 * 1. Duel proxies BETBY under its OWN domain: `sports-proxy.duel.com`. There is
 *    no cross-origin BETBY iframe on the page at all - the only iframes are
 *    Cookiebot's. That inverts the install advice we started with: a
 *    Tampermonkey userscript on duel.com is sufficient, because the sportsbook
 *    XHRs are issued by the duel.com page itself. The extension's
 *    grant-an-origin flow remains useful for other BETBY books, which do embed
 *    a third-party frame.
 *
 * 2. The bets feed is PUBLIC. `/api/v1/promo/bets_feed/brand/{brand}` answers
 *    200 with 50 rows to a plain curl - no cookie, no token, no account. We are
 *    reading a public endpoint the page already polls, which is the weakest
 *    possible claim on the sportsbook and exactly what the project set out to
 *    do.
 *
 * 3. Feed rows carry no timestamp. Ordering has to come from observation time.
 *
 * The brand id below is a public identifier that appears in the page's own URLs.
 * It is recorded so we can recognise Duel's traffic, never to authenticate as
 * anyone.
 */

import type { CaptureClassification, ClassifyInput, ParseInput, ParsePreview, SportsbookAdapter } from '../../shared/types.ts';
import { classifyGeneric, parseGeneric } from './generic-betby.ts';

export const DUEL_ID = 'betby.duel';
export const DUEL_SPORTSBOOK_ID = 'duel';

/** Public brand identifier, observed in duel.com's own request URLs. */
export const DUEL_BRAND_ID = '2482975601191952386';

/** The host Duel serves its BETBY API from. Discovered, not assumed. */
export const DUEL_SPORTS_HOST = 'sports-proxy.duel.com';

/**
 * Endpoints observed on 2026-09-04. This map is used ONLY to label and to raise
 * confidence in a verdict the shape analysis already reached - never to decide
 * what gets captured, and never as the sole basis for a classification. If Duel
 * moves an endpoint tomorrow, the shape rules still find it and this map simply
 * stops contributing.
 *
 * `{brand}` stands in for DUEL_BRAND_ID, `{lang}` for a language code, and
 * `{cursor}` for the incrementing long-poll cursor.
 */
export const DUEL_OBSERVED_ENDPOINTS: ReadonlyArray<{ pattern: RegExp; kind: string; note: string }> = [
  {
    pattern: /^\/api\/v1\/promo\/bets_feed\/brand\/\d+$/,
    kind: 'bets_feed',
    note: 'public bets feed, polled; 50 rows per response, no timestamps',
  },
  {
    pattern: /^\/api\/v4\/prematch\/brand\/\d+\/[a-z-]+\/\d+$/,
    kind: 'event_list',
    note: 'prematch tree, long-polled with an incrementing cursor',
  },
  {
    pattern: /^\/api\/v4\/live\/brand\/\d+\/[a-z-]+\/\d+$/,
    kind: 'event_list',
    note: 'live tree, long-polled with an incrementing cursor',
  },
  {
    pattern: /^\/api\/v3\/descriptions\/brand\/\d+\/markets\/[a-z-]+$/,
    kind: 'market_list',
    note: 'market id -> name and outcome templates; needed to name a feed leg',
  },
  {
    pattern: /^\/api\/v1\/descriptions\/statuses\/[a-z-]+$/,
    kind: 'translation',
    note: 'status code dictionary',
  },
  {
    pattern: /^\/api\/v1\/top\/events\/\d+\/country\/[A-Z]+\/currency\/[A-Z]+\/lang\/[a-z-]+$/,
    kind: 'event_list',
    note: 'featured events',
  },
  {
    pattern: /^\/api\/v1\/side\/brand\/\d+\/\d+$/,
    kind: 'sport_tree',
    note: 'sport/category sidebar tree',
  },
  {
    pattern: /^\/api\/v2\/auth\/brand\/\d+\/settings$/,
    kind: 'config',
    note: 'widget auth settings',
  },
  { pattern: /^\/locales\/[a-z-]+\.json$/, kind: 'translation', note: 'i18n strings' },
  { pattern: /^\/master\/[a-z0-9-]+\/theme\.json$/, kind: 'config', note: 'widget theme' },
];

/**
 * The live push channel, observed as:
 *   wss://sports-proxy.duel.com/api/v1/ws_new?brand_id={brand}&lang=en
 * Recorded for documentation; the WebSocket hook captures it on shape alone.
 */
export const DUEL_WS_PATH = '/api/v1/ws_new';

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** duel.com and any subdomain of it, which includes sports-proxy.duel.com. */
function isDuelHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'duel.com' || h.endsWith('.duel.com');
}

/** Matches an observed endpoint, ignoring the query string. */
function observedEndpoint(urlPath: string): { kind: string; note: string } | null {
  const path = urlPath.split('?')[0] ?? urlPath;
  for (const entry of DUEL_OBSERVED_ENDPOINTS) {
    if (entry.pattern.test(path)) return { kind: entry.kind, note: entry.note };
  }
  return null;
}

export const duelAdapter: SportsbookAdapter = {
  id: DUEL_ID,
  label: 'Duel',
  platform: 'betby',

  matches({ pageOrigin, frameOrigin, url }) {
    return isDuelHost(hostOf(pageOrigin)) || isDuelHost(hostOf(frameOrigin)) || isDuelHost(hostOf(url));
  },

  classify(input: ClassifyInput): CaptureClassification {
    const base = classifyGeneric(input);
    const verdict: CaptureClassification = { ...base, adapterId: DUEL_ID };

    // Only consult the observed map for traffic from the host we observed it
    // on. A payload from anywhere else is judged on its shape alone.
    if (!isDuelHost(input.urlHost.toLowerCase())) return verdict;

    const known = observedEndpoint(input.urlPath);
    if (!known) return verdict;

    verdict.reasons = [
      ...verdict.reasons,
      `path matches a Duel endpoint observed on 2026-09-04: ${known.note}`,
    ];

    if (known.kind === base.kind) {
      // Shape and observation agree. Raise confidence, but never to certainty -
      // an endpoint can change what it returns without changing its path.
      verdict.confidence = Math.min(0.99, Math.max(base.confidence, 0.9));
      return verdict;
    }

    if (base.kind === 'unknown') {
      // No contradiction - the shape rules simply found nothing to go on. An
      // observed path is real evidence, so use it, but at a confidence that
      // makes clear it rests on the path rather than the payload.
      verdict.kind = known.kind as CaptureClassification['kind'];
      verdict.confidence = 0.75;
      verdict.reasons = [
        ...verdict.reasons,
        'shape analysis found nothing decisive, so this verdict rests on the observed path rather than the payload',
      ];
      return verdict;
    }

    // They disagree. Say so loudly and keep the SHAPE verdict, because the
    // payload in front of us is evidence and the map is a memory of one
    // afternoon. A silent override here is exactly how this tool would start
    // lying about what it is looking at.
    verdict.reasons = [
      ...verdict.reasons,
      `NOTE: this path was "${known.kind}" when observed, but the payload's shape reads as "${base.kind}". ` +
        'Keeping the shape verdict - the endpoint may have changed. Worth a look.',
    ];
    verdict.confidence = Math.min(base.confidence, 0.5);
    return verdict;
  },

  parse(input: ParseInput): ParsePreview {
    const base = parseGeneric(input);
    const warnings = [...base.warnings];

    // Duel's feed gives ids for events, markets and outcomes but no names -
    // those come from the market descriptions and the prematch/live trees, and
    // are joined in when those payloads have been captured. A leg we could not
    // name is reported rather than left as a blank cell, with the reason: an
    // empty dictionary and a genuinely unknown event look identical otherwise.
    if (base.kind === 'bets_feed' && base.bets.length > 0) {
      const legs = base.bets.flatMap((b) => b.legs);
      const unnamed = legs.filter((l) => l.eventName === null).length;
      if (unnamed > 0) {
        warnings.push(
          `${unnamed} of ${legs.length} legs could not be named. Their events were not in the market descriptions or ` +
            'the prematch/live trees captured so far - browse those sections of the sportsbook, or check /api/refs to ' +
            'see what the dictionaries currently hold.',
        );
      }
    }

    return { ...base, adapterId: DUEL_ID, warnings };
  },
};
