import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { ParsePreview, RawCapture } from '../../shared/types.ts';
import { MIN_CLASSIFY_CONFIDENCE } from '../../shared/types.ts';
import { flattenPaths } from '../../shared/shape.ts';
import { ApiError, decodeCaptureBody, getCapture, parseCapture } from '../lib/api.ts';
import {
  formatBytes,
  formatConfidence,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatOdds,
  humanizeKind,
  tryParseJson,
} from '../lib/format.ts';
import { JsonView, RawView } from './JsonView.tsx';
import { CaptureFlags, KindChip, transportLabel } from './KindChip.tsx';

/**
 * Detail pane for one capture, with the same tab set as the in-page debug panel
 * (CONTRACT.md, "Debug panel") plus Fields and Warnings.
 *
 * Two behaviours matter here:
 *
 * - The list route may return a trimmed body, so the pane re-fetches the single
 *   capture for the full one. If that fetch fails we keep showing the row we
 *   already have and say the body may be partial - degrading to the lesser data
 *   with a label beats an empty pane.
 * - The parsed tabs re-run the adapter server-side. **Empty is the expected
 *   Milestone 1 answer** and is presented as such, never as an error, because
 *   "no bets in this payload" is a fact about the payload.
 */

const TABS = [
  'Endpoint',
  'Payload',
  'Parsed event',
  'Parsed market',
  'Parsed bet',
  'Fields',
  'Warnings',
] as const;

type Tab = (typeof TABS)[number];

export function CaptureDetail(props: {
  /** The row from the table. Used until (and if) the full capture arrives. */
  row: RawCapture;
  onClose: () => void;
}): ReactNode {
  const { row, onClose } = props;
  const captureId = row.captureId;

  // Tab choice deliberately survives a selection change: stepping through rows
  // while staying on "Payload" is the core discovery loop.
  const [tab, setTab] = useState<Tab>('Payload');
  const [full, setFull] = useState<RawCapture | null>(null);
  const [fullError, setFullError] = useState<string | null>(null);
  const [parse, setParse] = useState<ParsePreview | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFull(null);
    setFullError(null);
    setParse(null);
    setParseError(null);

    getCapture(captureId)
      .then((c) => {
        if (!cancelled) setFull(c);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFullError(describeError(err));
      });

    parseCapture(captureId)
      .then((p) => {
        if (!cancelled) setParse(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setParseError(describeError(err));
      });

    return () => {
      cancelled = true;
    };
  }, [captureId]);

  const capture = full ?? row;

  return (
    <section className="scout-card flex min-h-0 flex-col" aria-label="Capture detail">
      <header className="flex items-start gap-2 border-b border-dark-600 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <KindChip
              kind={capture.classification.kind}
              confidence={capture.classification.confidence}
              adapterId={capture.classification.adapterId}
              reasons={capture.classification.reasons}
            />
            <CaptureFlags
              truncated={capture.truncated}
              redacted={capture.redacted}
              bodyBytes={capture.bodyBytes}
              error={capture.error}
            />
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-dark-200" title={capture.url}>
            {capture.method ? `${capture.method} ` : ''}
            {capture.url}
          </div>
        </div>
        <button type="button" className="scout-button text-[11px]" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-dark-600 px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-2 py-1 text-[11px] transition-colors ${
              tab === t ? 'bg-blue-600/25 text-white' : 'text-dark-200 hover:bg-dark-700'
            }`}
          >
            {t}
            {t === 'Warnings' && warningCount(capture, parse, parseError) > 0 && (
              <span className="ml-1 font-mono tabular-nums text-yellow-500">
                {warningCount(capture, parse, parseError)}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {fullError && (
          <p className="mb-3 rounded-lg border border-yellow-600/60 bg-yellow-600/10 px-2.5 py-1.5 text-[11px] text-yellow-500">
            Could not load the full capture ({fullError}). Showing the row from the list, whose body
            may have been trimmed by the list route.
          </p>
        )}
        {tab === 'Endpoint' && <EndpointTab capture={capture} />}
        {tab === 'Payload' && <PayloadTab capture={capture} />}
        {tab === 'Parsed event' && (
          <ParsedEventTab parse={parse} error={parseError} />
        )}
        {tab === 'Parsed market' && <ParsedMarketTab parse={parse} error={parseError} />}
        {tab === 'Parsed bet' && <ParsedBetTab parse={parse} error={parseError} />}
        {tab === 'Fields' && <FieldsTab capture={capture} parse={parse} />}
        {tab === 'Warnings' && <WarningsTab capture={capture} parse={parse} error={parseError} />}
      </div>
    </section>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ *
 * Endpoint
 * ------------------------------------------------------------------ */

function EndpointTab({ capture }: { capture: RawCapture }): ReactNode {
  return (
    <div className="space-y-4">
      <Facts
        rows={[
          ['Method', capture.method ?? '—'],
          ['URL', capture.url],
          ['Host', capture.urlHost || '—'],
          ['Path', capture.urlPath || '—'],
          ['Query', capture.urlQuery ?? '— (no query string)'],
          ['Status', capture.status === undefined ? '— (no HTTP status for this transport)' : String(capture.status)],
          ['Transport', `${transportLabel(capture.transport)} (${capture.direction})`],
          ['Duration', formatDuration(capture.durationMs)],
          ['Content type', capture.contentType ?? '—'],
        ]}
      />
      <Facts
        title="Frame"
        rows={[
          ['Frame origin', capture.frameOrigin || '—'],
          ['Frame URL', capture.frameUrl || '—'],
          ['Top frame', capture.isTopFrame ? 'yes' : 'no - this came from a child iframe'],
          ['Page origin', capture.pageOrigin || '—'],
        ]}
      />
      <Facts
        title="Provenance"
        rows={[
          ['Capture id', capture.captureId],
          ['Session', capture.sessionId || '—'],
          ['Sequence', String(capture.seq)],
          ['Client time', formatDateTime(capture.tsClient)],
          ['Server time', capture.tsServer === undefined ? '— (not stamped)' : formatDateTime(capture.tsServer)],
          ['Shape fingerprint', capture.classification.shapeFingerprint || '—'],
          ['Adapter', capture.classification.adapterId],
        ]}
      />
      {capture.classification.reasons.length > 0 && (
        <div>
          <h4 className="text-[11px] uppercase tracking-wide text-dark-300">Classification evidence</h4>
          <ul className="mt-1 space-y-1 text-[12px] text-dark-100">
            {capture.classification.reasons.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-dark-400">·</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(capture.reqHeaders || capture.resHeaders) && (
        <div className="space-y-2">
          {capture.reqHeaders && <HeaderTable title="Request headers" headers={capture.reqHeaders} />}
          {capture.resHeaders && <HeaderTable title="Response headers" headers={capture.resHeaders} />}
        </div>
      )}
    </div>
  );
}

function HeaderTable({ title, headers }: { title: string; headers: Record<string, string> }): ReactNode {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  return (
    <div>
      <h4 className="text-[11px] uppercase tracking-wide text-dark-300">{title}</h4>
      <table className="mt-1 w-full border-collapse font-mono text-[11px]">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="border-t border-dark-700">
              <td className="w-52 py-0.5 pr-3 align-top text-dark-300">{k}</td>
              <td className="break-all py-0.5 text-dark-100">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Payload
 * ------------------------------------------------------------------ */

function PayloadTab({ capture }: { capture: RawCapture }): ReactNode {
  const decoded = useMemo(() => decodeCaptureBody(capture), [capture]);
  const json = useMemo(() => tryParseJson(decoded.text), [decoded.text]);
  const reqJson = useMemo(() => tryParseJson(capture.reqBody ?? null), [capture.reqBody]);
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    if (decoded.text === null) return;
    void navigator.clipboard
      .writeText(decoded.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopied(false));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-dark-200">
        <span className="font-mono tabular-nums">{formatBytes(capture.bodyBytes)}</span>
        <span className="text-dark-400">·</span>
        <span>{capture.bodyEncoding === 'base64' ? 'base64 on the wire' : 'utf8'}</span>
        {capture.truncated && (
          <span className="rounded-sm border border-yellow-600 px-1 text-yellow-500">
            truncated at the collector cap
          </span>
        )}
        <span className="flex-1" />
        {json !== null && (
          <div className="inline-flex overflow-hidden rounded border border-dark-500">
            {(['tree', 'raw'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-2 py-0.5 ${mode === m ? 'bg-dark-500 text-white' : 'text-dark-200 hover:bg-dark-600'}`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="scout-button text-[11px]" onClick={copy} disabled={decoded.text === null}>
          {copied ? 'Copied' : 'Copy body'}
        </button>
      </div>

      {decoded.note && <p className="text-[11px] text-dark-300">{decoded.note}</p>}

      {decoded.text === null ? (
        <p className="rounded-lg border border-dark-600 bg-dark-900/70 px-3 py-4 text-[12px] text-dark-200">
          No body was recorded for this capture. That is a fact about what the collector could read,
          not a placeholder - see the Warnings tab for the reason.
        </p>
      ) : json === null || mode === 'raw' ? (
        <RawView
          text={decoded.text}
          note={json === null ? 'Body is not JSON, so it is shown verbatim.' : null}
        />
      ) : (
        <JsonView value={json} rootLabel="body" defaultDepth={2} />
      )}

      {capture.reqBody && (
        <div>
          <h4 className="mb-1 text-[11px] uppercase tracking-wide text-dark-300">Request body</h4>
          {reqJson === null ? (
            <RawView text={capture.reqBody} />
          ) : (
            <JsonView value={reqJson} rootLabel="request" defaultDepth={2} />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Parsed tabs
 * ------------------------------------------------------------------ */

function ParseGate(props: {
  parse: ParsePreview | null;
  error: string | null;
  /** What this tab would show, described for the empty case. */
  noun: string;
  children: (parse: ParsePreview) => ReactNode;
}): ReactNode {
  const { parse, error, noun, children } = props;
  if (error) {
    return (
      <p className="rounded-lg border border-red-600/60 bg-red-700/10 px-3 py-2 text-[12px] text-red-500">
        The parse route failed: {error}
      </p>
    );
  }
  if (!parse) {
    return <p className="text-[12px] text-dark-300">Running the adapter…</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-dark-300">
        Adapter <span className="font-mono text-dark-100">{parse.adapterId}</span> read this as{' '}
        <span className="text-dark-100">{humanizeKind(parse.kind)}</span>.
      </p>
      {children(parse)}
      {parse.warnings.length > 0 && <WarningList items={parse.warnings} />}
      <p className="text-[11px] text-dark-400">
        No {noun} here is a normal answer at Milestone 1 - the adapter returns nothing rather than
        guessing at a schema we have not confirmed.
      </p>
    </div>
  );
}

function ParsedEventTab({ parse, error }: { parse: ParsePreview | null; error: string | null }): ReactNode {
  return (
    <ParseGate parse={parse} error={error} noun="events">
      {(p) =>
        p.events.length === 0 ? (
          <EmptyParse label="No events were extracted from this payload." />
        ) : (
          <MiniTable
            head={['Key', 'Sport', 'League', 'Competitors', 'Start', 'Live', 'Status']}
            rows={p.events.map((e) => [
              <Mono key="k">{e.key}</Mono>,
              e.sport ?? '—',
              e.league ?? '—',
              e.competitors.length > 0 ? e.competitors.join(' v ') : (e.name ?? '—'),
              e.startTime === null ? '—' : formatDateTime(e.startTime),
              e.live === null ? '—' : e.live ? 'live' : 'pre',
              e.status ?? '—',
            ])}
          />
        )
      }
    </ParseGate>
  );
}

function ParsedMarketTab({ parse, error }: { parse: ParsePreview | null; error: string | null }): ReactNode {
  return (
    <ParseGate parse={parse} error={error} noun="markets">
      {(p) => (
        <div className="space-y-4">
          {p.markets.length === 0 ? (
            <EmptyParse label="No markets were extracted from this payload." />
          ) : (
            <MiniTable
              head={['Key', 'Type', 'Name', 'Line', 'Period', 'Status']}
              rows={p.markets.map((m) => [
                <Mono key="k">{m.key}</Mono>,
                m.type ?? '—',
                m.name ?? '—',
                m.line === null ? '—' : m.line.toFixed(2),
                m.period ?? '—',
                m.status ?? '—',
              ])}
            />
          )}
          {p.selections.length > 0 && (
            <div>
              <h4 className="mb-1 text-[11px] uppercase tracking-wide text-dark-300">
                Selections ({p.selections.length})
              </h4>
              <MiniTable
                head={['Key', 'Name', 'Side', 'Line', 'Decimal odds', 'Status']}
                rows={p.selections.map((s) => [
                  <Mono key="k">{s.key}</Mono>,
                  s.name ?? '—',
                  s.side ?? '—',
                  s.line === null ? '—' : s.line.toFixed(2),
                  <Num key="o">{formatOdds(s.decimalOdds)}</Num>,
                  s.status ?? '—',
                ])}
              />
            </div>
          )}
          {p.oddsSnapshots.length > 0 && (
            <p className="text-[11px] text-dark-300">
              {p.oddsSnapshots.length} price snapshot(s) would be appended to the immutable odds
              history from this capture.
            </p>
          )}
        </div>
      )}
    </ParseGate>
  );
}

function ParsedBetTab({ parse, error }: { parse: ParsePreview | null; error: string | null }): ReactNode {
  return (
    <ParseGate parse={parse} error={error} noun="bets">
      {(p) =>
        p.bets.length === 0 ? (
          <EmptyParse label="No feed bets were extracted from this payload." />
        ) : (
          <div className="space-y-3">
            {p.bets.map((b) => (
              <div key={b.key} className="rounded-lg border border-dark-600 bg-dark-900/50 p-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
                  <span className="text-dark-100">{b.bettorLabel ?? 'bettor not labelled in payload'}</span>
                  <span className="text-dark-400">·</span>
                  <span className="text-dark-200">{b.type}</span>
                  <span className="text-dark-400">·</span>
                  <span className="font-mono tabular-nums text-white">
                    {formatMoney(b.stake, b.currency)}
                  </span>
                  <span className="text-dark-400">@</span>
                  <span className="font-mono tabular-nums text-white">{formatOdds(b.totalOdds)}</span>
                  <span className="text-dark-400">·</span>
                  <span className="text-dark-200">{b.status}</span>
                  {b.live === true && <span className="text-yellow-500">live</span>}
                  <span className="flex-1" />
                  <span className="font-mono text-[10px] text-dark-400">{b.key}</span>
                </div>
                {b.stakeUsd === null && b.stake !== null && (
                  <p className="mt-1 text-[11px] text-dark-300">
                    No USD conversion: no rate is known for {b.currency ?? 'this currency'}, so the
                    USD column stays empty rather than guessing one.
                  </p>
                )}
                {b.legs.length > 0 && (
                  <div className="mt-2">
                    <MiniTable
                      head={['#', 'Event', 'Market', 'Selection', 'Line', 'Odds at bet', 'Current', 'Status']}
                      rows={b.legs.map((leg) => [
                        String(leg.idx + 1),
                        leg.eventName ?? '—',
                        leg.marketName ?? '—',
                        leg.selectionName ?? '—',
                        leg.line === null ? '—' : leg.line.toFixed(2),
                        <Num key="a">{formatOdds(leg.oddsAtBet)}</Num>,
                        <Num key="c">{formatOdds(leg.currentOdds)}</Num>,
                        leg.status,
                      ])}
                    />
                  </div>
                )}
                {b.legCount !== b.legs.length && (
                  <p className="mt-1 text-[11px] text-yellow-500">
                    The payload said {b.legCount} legs but {b.legs.length} could be read.
                  </p>
                )}
              </div>
            ))}
          </div>
        )
      }
    </ParseGate>
  );
}

function EmptyParse({ label }: { label: string }): ReactNode {
  return (
    <p className="rounded-lg border border-dashed border-dark-600 px-3 py-3 text-[12px] text-dark-200">
      {label}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * Fields
 * ------------------------------------------------------------------ */

function FieldsTab({ capture, parse }: { capture: RawCapture; parse: ParsePreview | null }): ReactNode {
  const fields = useMemo(() => {
    const decoded = decodeCaptureBody(capture);
    const json = tryParseJson(decoded.text);
    return json === null ? [] : flattenPaths(json);
  }, [capture]);

  const unmapped = useMemo(() => new Set(parse?.unmappedFields ?? []), [parse]);

  if (fields.length === 0) {
    return (
      <p className="text-[12px] text-dark-200">
        No JSON fields to list - the body is absent or is not JSON. The Payload tab shows what was
        recorded.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-dark-300">
        {fields.length} distinct path(s), array indices collapsed to <code>[]</code>. Paths flagged{' '}
        <span className="text-yellow-500">unmapped</span> are ones the adapter did not consume - that
        list is the schema-discovery signal, so it is never suppressed.
      </p>
      <MiniTable
        head={['Path', 'Type', 'Example value', '']}
        rows={fields.map((f) => [
          <Mono key="p">{f.path}</Mono>,
          f.type,
          <span key="s" className="break-all text-dark-200">
            {f.sample}
          </span>,
          unmapped.has(f.path) ? (
            <span key="u" className="text-yellow-500">
              unmapped
            </span>
          ) : (
            ''
          ),
        ])}
      />
      {parse && parse.unmappedFields.length > 0 && unmapped.size > 0 && (
        <p className="text-[11px] text-dark-300">
          Adapter reported {parse.unmappedFields.length} unmapped path(s).
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Warnings
 * ------------------------------------------------------------------ */

function collectWarnings(
  capture: RawCapture,
  parse: ParsePreview | null,
  error: string | null,
): string[] {
  const out: string[] = [];
  if (capture.error) out.push(`Collector error: ${capture.error}`);
  if (capture.truncated) {
    out.push(
      `Body was truncated at the collector's per-body cap. The full payload was ${formatBytes(capture.bodyBytes)}, so anything parsed from it may be incomplete.`,
    );
  }
  if (capture.body === null) out.push('No body was recorded, so nothing can be parsed from this capture.');
  if (capture.classification.confidence < MIN_CLASSIFY_CONFIDENCE) {
    out.push(
      `Classification confidence is ${formatConfidence(capture.classification.confidence)}, below the ${Math.round(MIN_CLASSIFY_CONFIDENCE * 100)}% threshold. Treat the kind as a hypothesis.`,
    );
  }
  if (error) out.push(`Parse route failed: ${error}`);
  for (const w of parse?.warnings ?? []) out.push(w);
  return out;
}

function warningCount(capture: RawCapture, parse: ParsePreview | null, error: string | null): number {
  return collectWarnings(capture, parse, error).length;
}

function WarningsTab(props: {
  capture: RawCapture;
  parse: ParsePreview | null;
  error: string | null;
}): ReactNode {
  const { capture, parse, error } = props;
  const items = collectWarnings(capture, parse, error);
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-[12px] text-dark-200">
          Nothing to flag: the body arrived whole, nothing was masked in a way that would affect
          parsing, and the adapter raised no warnings.
        </p>
      ) : (
        <WarningList items={items} />
      )}
      {capture.redacted && (
        <p className="text-[11px] text-dark-300">
          At least one value in this capture was masked in the page before upload. Key names, array
          lengths and value types were preserved, so shape analysis is unaffected.
        </p>
      )}
    </div>
  );
}

function WarningList({ items }: { items: string[] }): ReactNode {
  return (
    <ul className="space-y-1.5">
      {items.map((w, i) => (
        <li
          key={i}
          className="rounded-lg border border-yellow-600/50 bg-yellow-600/10 px-2.5 py-1.5 text-[12px] text-yellow-500"
        >
          {w}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * Small shared bits
 * ------------------------------------------------------------------ */

function Facts({ title, rows }: { title?: string; rows: Array<[string, string]> }): ReactNode {
  return (
    <div>
      {title && <h4 className="mb-1 text-[11px] uppercase tracking-wide text-dark-300">{title}</h4>}
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-dark-700 first:border-t-0">
              <td className="w-36 py-1 pr-3 align-top text-dark-300">{k}</td>
              <td className="break-all py-1 font-mono text-dark-100">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MiniTable({ head, rows }: { head: string[]; rows: ReactNode[][] }): ReactNode {
  return (
    <div className="overflow-x-auto rounded-lg border border-dark-600">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="bg-dark-700 uppercase tracking-wide text-dark-200">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-2 py-1 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-t border-dark-700">
              {cells.map((c, j) => (
                <td key={j} className="px-2 py-1 align-top text-dark-100">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }): ReactNode {
  return <span className="font-mono text-[10px] text-dark-300">{children}</span>;
}

function Num({ children }: { children: ReactNode }): ReactNode {
  return <span className="font-mono tabular-nums text-dark-100">{children}</span>;
}
