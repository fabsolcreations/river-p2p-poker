import type { ReactNode } from 'react';

import type { CaptureKind, CaptureTransport } from '../../shared/types.ts';
import { MIN_CLASSIFY_CONFIDENCE } from '../../shared/types.ts';
import { formatConfidence, humanizeKind } from '../lib/format.ts';

/**
 * The classification badge.
 *
 * Two rules from CONTRACT.md are enforced here rather than left to call sites:
 *
 * 1. Below MIN_CLASSIFY_CONFIDENCE the verdict is rendered as a *guess* - the
 *    word "guess" appears in the chip, not just a paler colour. A reader
 *    skimming the table must not mistake a 0.2-confidence hunch for a fact.
 * 2. Colour never carries meaning on its own. The kind name is always spelled
 *    out, and the confidence number always sits next to it.
 */

/**
 * Declared as a total Record so adding a CaptureKind to the shared union fails
 * the build here instead of silently rendering the new kind as unstyled.
 */
const KIND_STYLE: Record<CaptureKind, string> = {
  // The prize. Green is reserved for the two kinds that carry other users' bets.
  bets_feed: 'border-green-600 bg-green-700/25 text-green-500',
  user_bets: 'border-green-700 bg-green-700/15 text-green-500',
  // Price and structure data - useful, but not the feed we are hunting.
  event_list: 'border-blue-600 bg-blue-700/20 text-blue-500',
  event_detail: 'border-blue-600 bg-blue-700/20 text-blue-500',
  market_list: 'border-blue-600 bg-blue-700/20 text-blue-500',
  odds_update: 'border-purple-600 bg-purple-600/20 text-purple-500',
  betslip: 'border-yellow-600 bg-yellow-600/15 text-yellow-500',
  // Scaffolding: worth capturing for label mapping, never the analytics target.
  sport_tree: 'border-dark-400 bg-dark-600 text-dark-100',
  translation: 'border-dark-400 bg-dark-600 text-dark-100',
  config: 'border-dark-400 bg-dark-600 text-dark-100',
  // Red is a warning, not a category: auth payloads must never be persisted raw.
  auth: 'border-red-600 bg-red-700/20 text-red-500',
  telemetry: 'border-dark-500 bg-dark-700 text-dark-200',
  asset: 'border-dark-500 bg-dark-700 text-dark-200',
  unknown: 'border-dark-500 bg-dark-700 text-dark-200',
};

/** Derived from the style map so the two can never drift apart. */
export const ALL_KINDS = Object.keys(KIND_STYLE) as CaptureKind[];

const TRANSPORT_LABEL: Record<CaptureTransport, string> = {
  fetch: 'fetch',
  xhr: 'xhr',
  websocket: 'ws',
  sse: 'sse',
  dom: 'dom',
  manual: 'manual',
};

export const ALL_TRANSPORTS = Object.keys(TRANSPORT_LABEL) as CaptureTransport[];

export function transportLabel(t: CaptureTransport): string {
  return TRANSPORT_LABEL[t] ?? t;
}

export function KindChip(props: {
  kind: CaptureKind;
  confidence: number;
  adapterId?: string;
  reasons?: string[];
  /** Hide the confidence number where the column already shows it. */
  showConfidence?: boolean;
}): ReactNode {
  const { kind, confidence, adapterId, reasons, showConfidence = true } = props;
  const isGuess = !Number.isFinite(confidence) || confidence < MIN_CLASSIFY_CONFIDENCE;
  const style = KIND_STYLE[kind] ?? KIND_STYLE.unknown;

  const title = [
    isGuess
      ? `Guess: confidence ${formatConfidence(confidence)} is below the ${Math.round(MIN_CLASSIFY_CONFIDENCE * 100)}% threshold, so treat this as a hypothesis.`
      : `Classified as ${humanizeKind(kind)} at ${formatConfidence(confidence)} confidence.`,
    adapterId ? `Adapter: ${adapterId}` : null,
    ...(reasons ?? []),
  ]
    .filter((s): s is string => Boolean(s))
    .join('\n');

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] leading-4 ${style} ${
        isGuess ? 'border-dashed' : ''
      }`}
      title={title}
    >
      {isGuess && <span className="font-semibold uppercase tracking-wide opacity-80">guess</span>}
      <span className="truncate">{humanizeKind(kind)}</span>
      {showConfidence && (
        <span className="font-mono tabular-nums opacity-80">{formatConfidence(confidence)}</span>
      )}
    </span>
  );
}

/**
 * The small square flags that follow a row: truncation, redaction and read
 * errors. Each is a word rather than an icon, because the whole point is that a
 * reader can tell at a glance whether the body they are about to analyse is the
 * whole body.
 */
export function CaptureFlags(props: {
  truncated: boolean;
  redacted: boolean;
  bodyBytes: number;
  error?: string | undefined;
}): ReactNode {
  const { truncated, redacted, bodyBytes, error } = props;
  if (!truncated && !redacted && !error) return <span className="text-dark-400">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {truncated && (
        <span
          className="rounded-sm border border-yellow-600 px-1 text-[10px] leading-4 text-yellow-500"
          title={`Body was cut at the collector's per-body cap. The full payload was ${bodyBytes} bytes, so anything parsed from it may be incomplete.`}
        >
          trunc
        </span>
      )}
      {redacted && (
        <span
          className="rounded-sm border border-dark-400 px-1 text-[10px] leading-4 text-dark-100"
          title="At least one value was masked in the page before upload. Structure, key order and value types were preserved."
        >
          redacted
        </span>
      )}
      {error && (
        <span
          className="rounded-sm border border-red-600 px-1 text-[10px] leading-4 text-red-500"
          title={error}
        >
          error
        </span>
      )}
    </span>
  );
}
