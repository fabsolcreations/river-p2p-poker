import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { CaptureKind, HostStat } from '../../shared/types.ts';
import { MIN_CLASSIFY_CONFIDENCE } from '../../shared/types.ts';
import { ApiError, getHosts } from '../lib/api.ts';
import { useServerEvents } from '../lib/ws.ts';
import {
  formatBytes,
  formatConfidence,
  formatDateTime,
  formatInt,
  formatRelative,
} from '../lib/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { KindChip } from '../components/KindChip.tsx';
import { StatCard, StatRow } from '../components/StatCard.tsx';
import { hrefFor } from '../components/Nav.tsx';

/**
 * "Which host serves the BETBY data?"
 *
 * This page is the answer to CONTRACT.md rule 1: host names are an *output* of
 * discovery, never an input. Nothing in this tool branches on a hostname; we
 * rank what we observed and let the reader draw the conclusion.
 *
 * The ranking is computed here rather than taken from the server so that the
 * page can state the rule it used. Best classification confidence leads, volume
 * breaks ties: an asset CDN will out-shout a data host on request count, so
 * sorting by traffic alone buries the answer.
 */

type SortKey = 'rank' | 'captures' | 'bytes' | 'confidence' | 'lastSeen';

/** How often a burst of ws stats events may trigger a refetch. */
const REFETCH_COOLDOWN_MS = 5000;

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function kindEntries(kinds: HostStat['kinds']): Array<[CaptureKind, number]> {
  return Object.entries(kinds ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .map((entry): [CaptureKind, number] => [entry[0] as CaptureKind, entry[1]])
    .sort((a, b) => b[1] - a[1]);
}

export function Hosts({ now }: { now: number }): ReactNode {
  const [hosts, setHosts] = useState<HostStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('rank');
  const lastFetchRef = useRef(0);

  const load = useCallback(() => {
    lastFetchRef.current = Date.now();
    getHosts()
      .then((rows) => {
        setHosts(rows);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh when the server says its stats moved, throttled: a busy collector
  // pushes stats faster than a page can usefully redraw a table.
  useServerEvents((event) => {
    if (event.type !== 'stats' && event.type !== 'capture') return;
    if (Date.now() - lastFetchRef.current < REFETCH_COOLDOWN_MS) return;
    load();
  });

  const ranked = useMemo(() => {
    const rows = [...(hosts ?? [])];
    // Rank is the documented default; the other sorts are for inspection.
    rows.sort((a, b) => {
      if (b.bestConfidence !== a.bestConfidence) return b.bestConfidence - a.bestConfidence;
      return b.captures - a.captures;
    });
    const withRank = rows.map((h, i) => ({ host: h, rank: i + 1 }));
    if (sort === 'rank') return withRank;
    return [...withRank].sort((a, b) => {
      switch (sort) {
        case 'captures':
          return b.host.captures - a.host.captures;
        case 'bytes':
          return b.host.bytes - a.host.bytes;
        case 'confidence':
          return b.host.bestConfidence - a.host.bestConfidence;
        case 'lastSeen':
          return b.host.lastSeen - a.host.lastSeen;
        default:
          return 0;
      }
    });
  }, [hosts, sort]);

  const totals = useMemo(() => {
    const rows = hosts ?? [];
    return {
      hosts: rows.length,
      captures: rows.reduce((n, h) => n + h.captures, 0),
      bytes: rows.reduce((n, h) => n + h.bytes, 0),
      confident: rows.filter((h) => h.bestConfidence >= MIN_CLASSIFY_CONFIDENCE).length,
    };
  }, [hosts]);

  if (error) {
    return (
      <EmptyState
        tone="error"
        title="Could not load hosts"
        body={<p>{error}</p>}
        action={
          <button type="button" className="scout-button" onClick={load}>
            Try again
          </button>
        }
      />
    );
  }

  if (hosts !== null && hosts.length === 0) {
    return (
      <EmptyState
        title="No hosts yet"
        body={
          <p>
            Hosts appear here as soon as the collector uploads its first capture. This list is
            discovered from real traffic — Scout never assumes a hostname.
          </p>
        }
        steps={[
          <>Install the collector and open the sportsbook in the same browser.</>,
          <>
            Watch <a className="text-blue-500 hover:underline" href={hrefFor('captures')}>Live captures</a>{' '}
            fill up, then come back here.
          </>,
        ]}
      />
    );
  }

  return (
    <div className="space-y-3">
      <StatRow>
        <StatCard label="Hosts seen" value={formatInt(totals.hosts)} hint="Distinct URL hosts the server has stored." />
        <StatCard label="Captures" value={formatInt(totals.captures)} hint="Sum across all hosts." />
        <StatCard label="Bytes" value={formatBytes(totals.bytes)} hint="Pre-truncation body bytes across all hosts." />
        <StatCard
          label="Above threshold"
          value={`${formatInt(totals.confident)} of ${formatInt(totals.hosts)}`}
          hint={`Hosts with at least one capture classified at or above ${Math.round(MIN_CLASSIFY_CONFIDENCE * 100)}% confidence.`}
          tone={totals.confident > 0 ? 'good' : 'neutral'}
        />
      </StatRow>

      <div className="scout-card px-3 py-2.5">
        <p className="text-[12px] text-dark-200">
          Ranked by the strongest classification a host produced, with capture count breaking ties —
          not by traffic volume, because an asset CDN out-requests a data host by an order of
          magnitude. The host serving the bets feed should sit near the top with a{' '}
          <span className="text-green-500">Bets feed</span> kind above{' '}
          {Math.round(MIN_CLASSIFY_CONFIDENCE * 100)}% confidence.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-dark-300">Sort</span>
          {(
            [
              ['rank', 'rank (confidence, then volume)'],
              ['captures', 'captures'],
              ['bytes', 'bytes'],
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
              <th className="w-10 px-2 py-1.5 text-right font-medium">#</th>
              <th className="px-2 py-1.5 font-medium">Host</th>
              <th className="w-24 px-2 py-1.5 text-right font-medium">Captures</th>
              <th className="w-24 px-2 py-1.5 text-right font-medium">Bytes</th>
              <th className="w-28 px-2 py-1.5 text-right font-medium">Best confidence</th>
              <th className="px-2 py-1.5 font-medium">Kinds</th>
              <th className="w-32 px-2 py-1.5 font-medium">First seen</th>
              <th className="w-32 px-2 py-1.5 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(({ host, rank }) => {
              const kinds = kindEntries(host.kinds);
              const strong = host.bestConfidence >= MIN_CLASSIFY_CONFIDENCE;
              return (
                <tr key={host.host} className="border-t border-dark-700 hover:bg-dark-700/60">
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-dark-300">{rank}</td>
                  <td className="px-2 py-1.5">
                    <a
                      className="font-mono text-dark-100 hover:text-blue-500 hover:underline"
                      href={hrefFor('captures', { host: host.host })}
                      title="Open Live captures filtered to this host"
                    >
                      {host.host}
                    </a>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-dark-100">
                    {formatInt(host.captures)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-dark-100">
                    {formatBytes(host.bytes)}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right font-mono tabular-nums ${strong ? 'text-green-500' : 'text-dark-200'}`}
                    title={
                      strong
                        ? 'At or above the classification threshold: treat as a verdict.'
                        : `Below the ${Math.round(MIN_CLASSIFY_CONFIDENCE * 100)}% threshold: every kind from this host is still a guess.`
                    }
                  >
                    {formatConfidence(host.bestConfidence)}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {kinds.length === 0 ? (
                        <span className="text-dark-400">—</span>
                      ) : (
                        kinds.map(([kind, count]) => (
                          <span key={kind} className="inline-flex items-center gap-1">
                            <KindChip kind={kind} confidence={host.bestConfidence} showConfidence={false} />
                            <span className="font-mono text-[10px] tabular-nums text-dark-300">
                              {formatInt(count)}
                            </span>
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11px] tabular-nums text-dark-200" title={formatDateTime(host.firstSeen)}>
                    {formatRelative(host.firstSeen, now)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11px] tabular-nums text-dark-200" title={formatDateTime(host.lastSeen)}>
                    {formatRelative(host.lastSeen, now)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hosts === null && <p className="text-[12px] text-dark-300">Loading hosts…</p>}

      <p className="text-[11px] text-dark-400">
        A host's kind chips carry that host's best confidence, not a per-kind one — the /api/hosts
        row does not break confidence down by kind, and inventing one per chip would misrepresent it.
      </p>
    </div>
  );
}
