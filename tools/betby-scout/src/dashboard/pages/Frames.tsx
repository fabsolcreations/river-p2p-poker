import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { FrameReport, RawCapture } from '../../shared/types.ts';
import { ApiError, getFrames, listCaptures } from '../lib/api.ts';
import { formatDateTime, formatInt, formatRelative, truncateMiddle } from '../lib/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { StatCard, StatRow } from '../components/StatCard.tsx';
import { hrefFor } from '../components/Nav.tsx';

/**
 * Discovered iframe origins.
 *
 * A BETBY widget normally lives in a cross-origin child frame, and a content
 * script cannot see inside one unless that origin has been granted. This page is
 * therefore the bridge between "we found a frame" and "grant it in the extension
 * popup so the collector can hook it".
 *
 * The server contract defines POST /api/frames for the collector but no GET, so
 * `getFrames()` tries the GET and reports whether it exists. When it does not,
 * we derive origins from the capture rows themselves — that is still real
 * observed data (every capture records the frame that saw it), and the page says
 * which of the two sources it used rather than presenting them as the same
 * thing.
 */

interface FrameRow {
  origin: string;
  /** Reports (or captures) that mentioned this origin. */
  observations: number;
  depth: number | null;
  sameOrigin: boolean | null;
  isTopFrame: boolean | null;
  firstSeen: number | null;
  lastSeen: number | null;
  sample: string | null;
  /** Top-level origins this frame was seen inside. */
  parents: string[];
}

type Source = 'reports' | 'captures';

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function rowsFromReports(reports: FrameReport[]): FrameRow[] {
  const byOrigin = new Map<string, FrameRow>();
  for (const report of reports) {
    for (const frame of report.frames) {
      const origin = frame.origin || '(opaque origin)';
      const existing = byOrigin.get(origin);
      if (existing) {
        existing.observations += 1;
        existing.depth = existing.depth === null ? frame.depth : Math.min(existing.depth, frame.depth);
        // A frame seen both same-origin and cross-origin is genuinely ambiguous;
        // null means "mixed", not "unknown default".
        if (existing.sameOrigin !== frame.sameOrigin) existing.sameOrigin = null;
        existing.firstSeen = Math.min(existing.firstSeen ?? report.ts, report.ts);
        existing.lastSeen = Math.max(existing.lastSeen ?? report.ts, report.ts);
        if (!existing.parents.includes(report.topOrigin)) existing.parents.push(report.topOrigin);
      } else {
        byOrigin.set(origin, {
          origin,
          observations: 1,
          depth: frame.depth,
          sameOrigin: frame.sameOrigin,
          isTopFrame: frame.depth === 0,
          firstSeen: report.ts,
          lastSeen: report.ts,
          sample: frame.src || null,
          parents: [report.topOrigin],
        });
      }
    }
  }
  return [...byOrigin.values()];
}

function rowsFromCaptures(captures: RawCapture[]): FrameRow[] {
  const byOrigin = new Map<string, FrameRow>();
  for (const c of captures) {
    const origin = c.frameOrigin || '(origin not recorded)';
    const existing = byOrigin.get(origin);
    if (existing) {
      existing.observations += 1;
      existing.firstSeen = Math.min(existing.firstSeen ?? c.tsClient, c.tsClient);
      existing.lastSeen = Math.max(existing.lastSeen ?? c.tsClient, c.tsClient);
      if (existing.isTopFrame !== c.isTopFrame) existing.isTopFrame = null;
      if (c.pageOrigin && !existing.parents.includes(c.pageOrigin)) existing.parents.push(c.pageOrigin);
    } else {
      byOrigin.set(origin, {
        origin,
        observations: 1,
        // Capture rows carry no nesting depth - only the report path has it.
        depth: null,
        sameOrigin: c.pageOrigin ? c.frameOrigin === c.pageOrigin : null,
        isTopFrame: c.isTopFrame,
        firstSeen: c.tsClient,
        lastSeen: c.tsClient,
        sample: c.frameUrl || null,
        parents: c.pageOrigin ? [c.pageOrigin] : [],
      });
    }
  }
  return [...byOrigin.values()];
}

export function Frames({ now }: { now: number }): ReactNode {
  const [rows, setRows] = useState<FrameRow[] | null>(null);
  const [source, setSource] = useState<Source>('reports');
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(0);

  const load = useCallback(() => {
    let cancelled = false;
    getFrames()
      .then(async (result) => {
        if (cancelled) return;
        if (result.supported && result.reports.length > 0) {
          setSource('reports');
          setRows(rowsFromReports(result.reports).sort(byObservations));
          setScanned(result.reports.length);
          setError(null);
          return;
        }
        // Either the route does not exist or no report has been filed yet;
        // either way the capture rows still know which frame saw what.
        const captures = await listCaptures({ limit: 1000 });
        if (cancelled) return;
        setSource('captures');
        setRows(rowsFromCaptures(captures.captures).sort(byObservations));
        setScanned(captures.captures.length);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancel = load();
    return cancel;
  }, [load]);

  if (error) {
    return (
      <EmptyState
        tone="error"
        title="Could not load frames"
        body={<p>{error}</p>}
        action={
          <button type="button" className="scout-button" onClick={() => load()}>
            Try again
          </button>
        }
      />
    );
  }

  const list = rows ?? [];
  const crossOrigin = list.filter((r) => r.sameOrigin === false).length;

  return (
    <div className="space-y-3">
      <StatRow>
        <StatCard label="Origins seen" value={formatInt(list.length)} hint="Distinct frame origins observed on the page." />
        <StatCard
          label="Cross-origin"
          value={formatInt(crossOrigin)}
          hint="Origins that differ from the page's own. These are the ones that need a grant before the collector can hook them."
          tone={crossOrigin > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Source"
          value={source === 'reports' ? 'frame reports' : 'capture rows'}
          hint={
            source === 'reports'
              ? 'GET /api/frames answered, so these are the collector’s own frame reports.'
              : 'This server build has no GET /api/frames (or no report has been filed), so origins were derived from the frame each capture recorded.'
          }
        />
        <StatCard
          label="Records scanned"
          value={formatInt(scanned)}
          hint={source === 'reports' ? 'Frame reports read.' : 'Capture rows read (most recent 1,000).'}
        />
      </StatRow>

      <div className="scout-card px-3 py-2.5 text-[12px] text-dark-200">
        <p>
          BETBY widgets normally render inside a cross-origin iframe, and a content script cannot see
          into one until that origin is granted. Granting an origin in the{' '}
          <strong className="text-dark-100">extension popup</strong> is what lets the collector hook{' '}
          <code>fetch</code>, XHR and WebSocket <em>inside</em> the widget frame — until then you only
          see the parent page's own traffic. The MV3 extension requests host access at runtime
          (nothing is baked into the manifest), and the userscript cannot reach a cross-origin frame
          at all.
        </p>
        {source === 'captures' && (
          <p className="mt-2 text-dark-300">
            Derived from capture rows because this server did not answer a GET on /api/frames. Depth
            and the frame tree are unavailable that way; only the origins the collector actually
            captured from appear, so a frame that has produced no traffic yet is missing here.
          </p>
        )}
      </div>

      {rows === null ? (
        <p className="text-[12px] text-dark-300">Loading frames…</p>
      ) : list.length === 0 ? (
        <EmptyState
          title="No frames discovered yet"
          body={
            <p>
              Nothing has reported an iframe. The collector enumerates frames when it starts and when
              you press “Discover frames” in the in-page panel.
            </p>
          }
          steps={[
            <>Open the sportsbook with the collector installed.</>,
            <>Press “Discover frames” in the floating panel on that page.</>,
            <>
              Return here, or check{' '}
              <a className="text-blue-500 hover:underline" href={hrefFor('captures')}>
                Live captures
              </a>{' '}
              to confirm the collector is uploading at all.
            </>,
          ]}
        />
      ) : (
        <div className="scout-card overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead className="bg-dark-700 text-[11px] uppercase tracking-wide text-dark-200">
              <tr>
                <th className="px-2 py-1.5 font-medium">Frame origin</th>
                <th className="w-16 px-2 py-1.5 text-right font-medium">Depth</th>
                <th className="w-28 px-2 py-1.5 font-medium">Relationship</th>
                <th className="w-24 px-2 py-1.5 text-right font-medium">
                  {source === 'reports' ? 'Reports' : 'Captures'}
                </th>
                <th className="px-2 py-1.5 font-medium">Seen inside</th>
                <th className="w-28 px-2 py-1.5 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.origin} className="border-t border-dark-700 align-top hover:bg-dark-700/60">
                  <td className="px-2 py-1.5">
                    <span className="font-mono text-dark-100">{row.origin}</span>
                    {row.sample && (
                      <div className="truncate font-mono text-[10px] text-dark-300" title={row.sample}>
                        {truncateMiddle(row.sample, 60)}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-dark-100">
                    {row.depth === null ? (
                      <span className="text-dark-400" title="Nesting depth is only reported by the collector's frame scan.">
                        —
                      </span>
                    ) : (
                      row.depth
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {row.sameOrigin === null ? (
                      <span className="text-dark-300" title="Seen both same-origin and cross-origin.">
                        mixed
                      </span>
                    ) : row.sameOrigin ? (
                      <span className="text-dark-100">same-origin</span>
                    ) : (
                      <span className="text-yellow-500" title="Needs a host grant before the collector can hook inside it.">
                        cross-origin
                      </span>
                    )}
                    {row.isTopFrame === true && (
                      <div className="text-[10px] text-dark-300">top frame</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-dark-100">
                    {formatInt(row.observations)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11px] text-dark-200">
                    {row.parents.length === 0 ? '—' : row.parents.join(', ')}
                  </td>
                  <td
                    className="px-2 py-1.5 font-mono text-[11px] tabular-nums text-dark-200"
                    title={`First seen ${formatDateTime(row.firstSeen)}\nLast seen ${formatDateTime(row.lastSeen)}`}
                  >
                    {formatRelative(row.lastSeen, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function byObservations(a: FrameRow, b: FrameRow): number {
  return b.observations - a.observations;
}
