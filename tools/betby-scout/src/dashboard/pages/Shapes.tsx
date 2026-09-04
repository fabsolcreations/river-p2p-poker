import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ShapeStat } from '../../shared/types.ts';
import { MIN_CLASSIFY_CONFIDENCE } from '../../shared/types.ts';
import { ApiError, getShapes } from '../lib/api.ts';
import { useServerEvents } from '../lib/ws.ts';
import { formatConfidence, formatDateTime, formatInt, formatRelative, truncateMiddle } from '../lib/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { KindChip } from '../components/KindChip.tsx';
import { StatCard, StatRow } from '../components/StatCard.tsx';
import { hrefFor } from '../components/Nav.tsx';

/**
 * Schema discovery.
 *
 * Two responses from the same endpoint share a key-shape even though their
 * values differ completely (src/shared/shape.ts), so each row here is one
 * *kind of message* the page exchanges. This is the view the whole Milestone 1
 * exists to feed: you scan the clusters, find the one whose top-level keys look
 * like a list of other people's bets, and open its example capture.
 *
 * Sorted by count by default because a feed pushes the same shape repeatedly,
 * so the interesting cluster is usually large and, crucially, still classified
 * `unknown` — a big unknown cluster is the strongest lead on this page.
 */

type SortKey = 'count' | 'unknownFirst' | 'confidence' | 'lastSeen';

const REFETCH_COOLDOWN_MS = 5000;

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function Shapes({ now }: { now: number }): ReactNode {
  const [shapes, setShapes] = useState<ShapeStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('count');
  const [query, setQuery] = useState('');
  const lastFetchRef = useRef(0);

  const load = useCallback(() => {
    lastFetchRef.current = Date.now();
    getShapes()
      .then((rows) => {
        setShapes(rows);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useServerEvents((event) => {
    if (event.type !== 'stats' && event.type !== 'capture') return;
    if (Date.now() - lastFetchRef.current < REFETCH_COOLDOWN_MS) return;
    load();
  });

  const rows = useMemo(() => {
    let list = [...(shapes ?? [])];
    if (query.trim()) {
      const needle = query.trim().toLowerCase();
      list = list.filter((s) =>
        [s.host, s.path, s.kind, s.shapeFingerprint, ...(s.keys ?? [])]
          .join('\n')
          .toLowerCase()
          .includes(needle),
      );
    }
    list.sort((a, b) => {
      switch (sort) {
        case 'unknownFirst': {
          // Unknown clusters are the leads; inside them, biggest first.
          const au = a.kind === 'unknown' ? 0 : 1;
          const bu = b.kind === 'unknown' ? 0 : 1;
          if (au !== bu) return au - bu;
          return b.count - a.count;
        }
        case 'confidence':
          return b.confidence - a.confidence;
        case 'lastSeen':
          return b.lastSeen - a.lastSeen;
        case 'count':
        default:
          return b.count - a.count;
      }
    });
    return list;
  }, [shapes, sort, query]);

  const totals = useMemo(() => {
    const list = shapes ?? [];
    return {
      clusters: list.length,
      messages: list.reduce((n, s) => n + s.count, 0),
      unknown: list.filter((s) => s.kind === 'unknown').length,
      confident: list.filter((s) => s.confidence >= MIN_CLASSIFY_CONFIDENCE).length,
    };
  }, [shapes]);

  if (error) {
    return (
      <EmptyState
        tone="error"
        title="Could not load shapes"
        body={<p>{error}</p>}
        action={
          <button type="button" className="scout-button" onClick={load}>
            Try again
          </button>
        }
      />
    );
  }

  if (shapes !== null && shapes.length === 0) {
    return (
      <EmptyState
        title="No payload shapes yet"
        body={
          <p>
            A shape appears as soon as one capture with a readable body reaches the server. Until
            then there is nothing to cluster.
          </p>
        }
        steps={[
          <>Install the collector and open the sportsbook.</>,
          <>
            Confirm rows are arriving on{' '}
            <a className="text-blue-500 hover:underline" href={hrefFor('captures')}>
              Live captures
            </a>
            .
          </>,
          <>Come back here: every distinct message structure gets one row.</>,
        ]}
      />
    );
  }

  return (
    <div className="space-y-3">
      <StatRow>
        <StatCard label="Clusters" value={formatInt(totals.clusters)} hint="Distinct payload structures seen." />
        <StatCard label="Messages" value={formatInt(totals.messages)} hint="Captures across all clusters." />
        <StatCard
          label="Unclassified"
          value={`${formatInt(totals.unknown)} of ${formatInt(totals.clusters)}`}
          hint="Clusters the adapter could not name. A large unknown cluster is the strongest lead on this page."
          tone={totals.unknown > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Above threshold"
          value={`${formatInt(totals.confident)} of ${formatInt(totals.clusters)}`}
          hint={`Clusters classified at or above ${Math.round(MIN_CLASSIFY_CONFIDENCE * 100)}% confidence.`}
          tone={totals.confident > 0 ? 'good' : 'neutral'}
        />
      </StatRow>

      <div className="scout-card px-3 py-2.5">
        <p className="text-[12px] text-dark-200">
          One row per distinct payload structure: keys and value types, with values discarded. Look
          for a large cluster whose top-level keys read like a list of other people's bets — stake,
          odds, a timestamp, a nested legs array — then open its example capture to confirm. Nothing
          here is matched on an endpoint name.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-dark-300">Sort</span>
          {(
            [
              ['count', 'count'],
              ['unknownFirst', 'unclassified first'],
              ['confidence', 'confidence'],
              ['lastSeen', 'last seen'],
            ] as Array<[SortKey, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                sort === key ? 'bg-blue-600/25 text-white' : 'text-dark-200 hover:bg-dark-700'
              }`}
            >
              {label}
            </button>
          ))}
          <input
            type="search"
            className="scout-control ml-2 w-56 text-[12px]"
            placeholder="filter by host, path or key"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="flex-1" />
          <button type="button" className="scout-button text-[11px]" onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      <div className="scout-card overflow-x-auto">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead className="bg-dark-700 text-[11px] uppercase tracking-wide text-dark-200">
            <tr>
              <th className="w-20 px-2 py-1.5 text-right font-medium">Count</th>
              <th className="w-44 px-2 py-1.5 font-medium">Inferred kind</th>
              <th className="w-40 px-2 py-1.5 font-medium">Host</th>
              <th className="px-2 py-1.5 font-medium">Top-level keys</th>
              <th className="w-28 px-2 py-1.5 font-medium">Last seen</th>
              <th className="w-28 px-2 py-1.5 font-medium">Example</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.shapeFingerprint} className="border-t border-dark-700 align-top hover:bg-dark-700/60">
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-dark-100">
                  {formatInt(s.count)}
                </td>
                <td className="px-2 py-1.5">
                  <KindChip kind={s.kind} confidence={s.confidence} />
                  <div className="mt-0.5 font-mono text-[10px] text-dark-400" title="Shape fingerprint">
                    {s.shapeFingerprint}
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <a
                    className="block truncate font-mono text-dark-100 hover:text-blue-500 hover:underline"
                    href={hrefFor('captures', { host: s.host })}
                    title={`Open Live captures filtered to ${s.host}`}
                  >
                    {s.host || '—'}
                  </a>
                  <div className="truncate font-mono text-[10px] text-dark-300" title={s.path}>
                    {s.path ? truncateMiddle(s.path, 46) : '—'}
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {(s.keys ?? []).length === 0 ? (
                      <span className="text-dark-400" title="The payload had no object keys at the top level.">
                        —
                      </span>
                    ) : (
                      (s.keys ?? []).map((k) => (
                        <code
                          key={k}
                          className="rounded-sm border border-dark-500 bg-dark-700 px-1 text-[10px] text-dark-100"
                        >
                          {k}
                        </code>
                      ))
                    )}
                  </div>
                </td>
                <td
                  className="px-2 py-1.5 font-mono text-[11px] tabular-nums text-dark-200"
                  title={`First seen ${formatDateTime(s.firstSeen)}\nLast seen ${formatDateTime(s.lastSeen)}`}
                >
                  {formatRelative(s.lastSeen, now)}
                </td>
                <td className="px-2 py-1.5">
                  {s.exampleCaptureId ? (
                    <a
                      className="text-blue-500 hover:underline"
                      href={hrefFor('captures', { capture: s.exampleCaptureId, shape: s.shapeFingerprint })}
                      title="Open this cluster in Live captures with the example capture selected"
                    >
                      open capture
                    </a>
                  ) : (
                    <span className="text-dark-400" title="This cluster row carried no example capture id.">
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shapes === null && <p className="text-[12px] text-dark-300">Loading shapes…</p>}
      {shapes !== null && rows.length === 0 && (
        <p className="text-[12px] text-dark-300">
          No cluster matches “{query}”. {formatInt(totals.clusters)} cluster(s) exist in total.
        </p>
      )}
    </div>
  );
}
