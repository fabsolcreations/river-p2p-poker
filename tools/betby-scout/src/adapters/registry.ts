/**
 * Adapter registry - the only door between the rest of the system and any
 * sportsbook-specific code.
 *
 * The server, the collector core and the dashboard all import from here and
 * never from `betby/duel.ts` directly. That is what keeps the analytics layer
 * free of Duel, so adding the next BETBY book is a new file plus one line in
 * ADAPTERS.
 *
 * Everything exported here is total: `classifyCapture` and `parseCapture` are
 * called from inside a page hook on a live sportsbook, so an exception thrown
 * out of a parser would break the user's session. They degrade instead, and
 * record why.
 */

import type {
  CaptureClassification,
  ClassifyInput,
  ParseInput,
  ParsePreview,
  RawCapture,
  SportsbookAdapter,
} from '../shared/types.ts';
import { shapeFingerprint } from '../shared/shape.ts';
import { duelAdapter, DUEL_SPORTSBOOK_ID } from './betby/duel.ts';
import { genericBetbyAdapter } from './betby/generic-betby.ts';

/**
 * Last-resort adapter. Exists so `adapterFor` can have a total signature - a
 * caller must never have to null-check the thing that tells it what a payload
 * is.
 */
const unknownAdapter: SportsbookAdapter = {
  id: 'unknown',
  label: 'Unrecognised site',
  platform: 'unknown',
  matches: () => true,
  classify: (input) => genericBetbyAdapter.classify(input),
  parse: (input) => genericBetbyAdapter.parse(input),
};

/**
 * Order matters: the first match wins, so host-specific adapters precede the
 * generic one, and the catch-all is last.
 */
export const ADAPTERS: SportsbookAdapter[] = [duelAdapter, genericBetbyAdapter, unknownAdapter];

export interface AdapterMatchContext {
  pageOrigin: string;
  frameOrigin: string;
  url: string;
}

export function adapterFor(ctx: AdapterMatchContext): SportsbookAdapter {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.matches(ctx)) return adapter;
    } catch {
      // A throwing matcher must not be able to hide every adapter behind it.
    }
  }
  return unknownAdapter;
}

/**
 * Maps a match context to the sportsbook id used in every database key. Kept
 * separate from `adapterFor` because several adapters can share one book, and
 * because ids must stay stable even if adapter internals are refactored.
 */
export function sportsbookIdFor(ctx: AdapterMatchContext): string {
  const adapter = adapterFor(ctx);
  if (adapter.id === duelAdapter.id) return DUEL_SPORTSBOOK_ID;
  if (adapter.id === unknownAdapter.id) {
    // Namespace by host so two unrecognised books never share keys.
    try {
      return `site:${new URL(ctx.pageOrigin || ctx.url).hostname}`;
    } catch {
      return 'site:unknown';
    }
  }
  return adapter.id;
}

/* ------------------------------------------------------------------ *
 * Capture -> adapter input
 * ------------------------------------------------------------------ */

function decodeBody(capture: RawCapture): string | null {
  if (capture.body === null) return null;
  if (capture.bodyEncoding !== 'base64') return capture.body;
  try {
    const bytes =
      typeof atob === 'function'
        ? Uint8Array.from(atob(capture.body), (c) => c.charCodeAt(0))
        : new Uint8Array(Buffer.from(capture.body, 'base64'));
    // A binary frame that is not valid UTF-8 must stay unreadable rather than
    // becoming a string of replacement characters that a parser might "match".
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text;
  } catch {
    return null;
  }
}

function parseJson(text: string | null, contentType: string | undefined): unknown {
  if (text === null) return null;
  const looksJson = (contentType ?? '').includes('json') || /^\s*[[{]/.test(text);
  if (!looksJson) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function makeClassifyInput(capture: RawCapture): ClassifyInput {
  const text = decodeBody(capture);
  return {
    url: capture.url,
    urlHost: capture.urlHost,
    urlPath: capture.urlPath,
    method: capture.method,
    contentType: capture.contentType,
    transport: capture.transport,
    direction: capture.direction,
    json: parseJson(text, capture.contentType),
    text,
  };
}

function matchContext(capture: RawCapture): AdapterMatchContext {
  return { pageOrigin: capture.pageOrigin, frameOrigin: capture.frameOrigin, url: capture.url };
}

function failedClassification(reason: string, json: unknown): CaptureClassification {
  return {
    kind: 'unknown',
    confidence: 0,
    adapterId: 'registry',
    reasons: [reason],
    shapeFingerprint: safeFingerprint(json),
  };
}

function safeFingerprint(json: unknown): string {
  try {
    return shapeFingerprint(json);
  } catch {
    return '';
  }
}

/**
 * Classifies a capture. Never throws: the collector calls this synchronously
 * inside a wrapped `fetch`, and a crash here would surface as a broken page.
 */
export function classifyCapture(capture: RawCapture): CaptureClassification {
  let input: ClassifyInput;
  try {
    input = makeClassifyInput(capture);
  } catch (err) {
    return failedClassification(`could not decode the captured body: ${errText(err)}`, null);
  }
  return classifyPayload(input, matchContext(capture));
}

export function classifyPayload(input: ClassifyInput, ctx: AdapterMatchContext): CaptureClassification {
  try {
    return adapterFor(ctx).classify(input);
  } catch (err) {
    return failedClassification(`adapter threw while classifying: ${errText(err)}`, input.json);
  }
}

/**
 * Parses a capture into normalized entities. Also never throws - a parse
 * failure returns an empty preview whose `warnings` say what went wrong, which
 * is exactly what the debug panel is there to display.
 */
export function parseCapture(capture: RawCapture, now: number, refs?: unknown): ParsePreview {
  let input: ClassifyInput;
  try {
    input = makeClassifyInput(capture);
  } catch (err) {
    return emptyFailure(`could not decode the captured body: ${errText(err)}`);
  }
  const ctx = matchContext(capture);
  // Deliberately re-classified rather than reusing capture.classification. The
  // stored verdict was produced by whatever adapter existed when the traffic was
  // recorded; re-running it here is the entire point of /api/captures/:id/parse,
  // which exists so an adapter improvement can be tested against traffic
  // captured hours earlier. Trusting the stored kind would pin every old capture
  // to the understanding we had at capture time.
  return parsePayload(
    {
      ...input,
      captureId: capture.captureId,
      sportsbookId: sportsbookIdFor(ctx),
      classification: classifyPayload(input, ctx),
      ctx: { now, refs },
    },
    ctx,
  );
}

/**
 * `ctx` decides which adapter parses. It is optional only so a caller holding a
 * bare payload can still parse it; when it is omitted we fall back to the URL
 * alone, which will usually select the generic adapter - correct, but weaker
 * than passing the real page and frame origins.
 */
export function parsePayload(input: ParseInput, ctx?: AdapterMatchContext): ParsePreview {
  try {
    return adapterFor(ctx ?? { pageOrigin: '', frameOrigin: '', url: input.url }).parse(input);
  } catch (err) {
    return emptyFailure(`adapter threw while parsing: ${errText(err)}`);
  }
}

function emptyFailure(reason: string): ParsePreview {
  return {
    adapterId: 'registry',
    kind: 'unknown',
    events: [],
    markets: [],
    selections: [],
    bets: [],
    oddsSnapshots: [],
    warnings: [reason],
    unmappedFields: [],
  };
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
