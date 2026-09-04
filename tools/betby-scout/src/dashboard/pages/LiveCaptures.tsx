import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type {
  CaptureKind,
  CaptureStats,
  CaptureTransport,
  RawCapture,
} from '../../shared/types.ts';
import { ApiError, coerceCapture, exportUrl, listCaptures } from '../lib/api.ts';
import type { CaptureFilters } from '../lib/api.ts';
import { useServerEvents } from '../lib/ws.ts';
import {
  formatBytes,
  formatClock,
  formatInt,
  formatRelative,
  humanizeKind,
} from '../lib/format.ts';
import { CaptureDetail } from '../components/CaptureDetail.tsx';
import { CaptureTable } from '../components/CaptureTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ALL_KINDS, ALL_TRANSPORTS, transportLabel } from '../components/KindChip.tsx';
import { StatCard, StatRow } from '../components/StatCard.tsx';

/**
 * The default view: watch real traffic arrive and work out which payload is the
 * bets feed.
 *
 * Memory is the constraint that shapes this file. A busy sportsbook page pushes
 * WebSocket frames continuously, and every row carries its body, so an unbounded
 * list would eat the tab within an hour. Three bounds, all of them visible to
 * the user rather than silent:
 *
 *   MAX_ROWS      how many captures this tab keeps at once (oldest dropped)
 *   RENDER_LIMIT  how many of those are put in the DOM
 *   INITIAL_LIMIT how many the first REST load asks for
 *
 * Pause freezes the *view*, not the stream: incoming captures keep arriving and
 * queue up in a ref, and the button says how many are waiting. Dropping the
 * subscription on pause would silently lose exactly the burst the user paused to
 * read.
 */

const MAX_ROWS = 3000;
const RENDER_LIMIT = 300;
const INITIAL_LIMIT = 500;

/** Sparkline geometry: 10-second buckets over the last five minutes. */
const BUCKET_MS = 10_000;
const BUCKET_COUNT = 30;

interface UiFilters {
  kind: CaptureKind | '';
  host: string;
  transport: CaptureTransport | '';
  session: string;
  q: string;
  /** Set only by a deep link from the Shapes page. */
  shape: string;
}

const EMPTY_FILTERS: UiFilters = { kind: '', host: '', transport: '', session: '', q: '', shape: '' };

function filtersFromParams(params: URLSearchParams): UiFilters {
  return {
    kind: (params.get('kind') ?? '') as CaptureKind | '',
    host: params.get('host') ?? '',
    transport: (params.get('transport') ?? '') as CaptureTransport | '',
    session: params.get('session') ?? '',
    q: params.get('q') ?? '',
    shape: params.get('shape') ?? '',
  };
}

function toApiFilters(f: UiFilters): CaptureFilters {
  return { kind: f.kind, host: f.host, transport: f.transport, session: f.session, q: f.q, shape: f.shape };
}

function hasAnyFilter(f: UiFilters): boolean {
  return Boolean(f.kind || f.host || f.transport || f.session || f.q || f.shape);
}

/**
 * Client-side twin of the server's filter, applied to live rows.
 *
 * The server owns the initial page; the socket does not filter, so the same
 * predicate has to run here or a filtered view would fill up with rows that do
 * not match it. `q` is matched against the fields a human would search - URL,
 * host, path, method, kind and the body text - because we cannot know how the
 * server interprets it and a narrower local rule would hide matching rows.
 */
function matchesFilters(c: RawCapture, f: UiFilters): boolean {
  if (f.kind && c.classification.kind !== f.kind) return false;
  if (f.host && c.urlHost !== f.host) return false;
  if (f.transport && c.transport !== f.transport) return false;
  if (f.session && c.sessionId !== f.session) return false;
  if (f.shape && c.classification.shapeFingerprint !== f.shape) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    const haystack = [c.url, c.urlHost, c.urlPath, c.method ?? '', c.classification.kind, c.body ?? '']
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Newest first, with `seq` breaking ties inside a millisecond. */
function byNewest(a: RawCapture, b: RawCapture): number {
  if (b.tsClient !== a.tsClient) return b.tsClient - a.tsClient;
  return b.seq - a.seq;
}

interface Bucket {
  t: number;
  label: string;
  count: number;
}

function buildBuckets(rows: RawCapture[], now: number, sizeMs: number, count: number): Bucket[] {
  const end = Math.floor(now / sizeMs) * sizeMs;
  const start = end - (count - 1) * sizeMs;
  const buckets: Bucket[] = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * sizeMs;
    buckets.push({ t, label: formatClock(t), count: 0 });
  }
  for (const row of rows) {
    if (row.tsClient < start || row.tsClient > end + sizeMs) continue;
    const idx = Math.floor((row.tsClient - start) / sizeMs);
    const bucket = buckets[idx];
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function LiveCaptures(props: {
  params: URLSearchParams;
  stats: CaptureStats | null;
  now: number;
}): ReactNode {
  const { params, stats, now } = props;
  const paramKey = params.toString();

  const [filters, setFilters] = useState<UiFilters>(() => filtersFromParams(params));
  const [rows, setRows] = useState<RawCapture[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get('capture'));
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [malformed, setMalformed] = useState(0);
  const [droppedByCap, setDroppedByCap] = useState(0);

  // Ids we already hold, so a replayed capture (reconnect, or a REST page that
  // overlaps the live stream) is not listed twice.
  const idsRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<RawCapture[]>([]);
  /**
   * The row list is kept in a ref as well as in state, and every write goes
   * through `commit`. Trimming needs to know the current list *and* report how
   * many rows it dropped; doing that inside a `setRows(prev => …)` updater would
   * mean calling another setter from an updater, which StrictMode invokes twice
   * and would double the reported drop count.
   */
  const rowsRef = useRef<RawCapture[]>([]);

  const commit = useCallback((next: RawCapture[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  /* -------------------- deep links from other pages -------------------- */

  useEffect(() => {
    const next = filtersFromParams(params);
    // Only adopt params that are actually present: navigating to `#/captures`
    // with no query must not wipe filters the user set by hand.
    setFilters((prev) => ({
      kind: params.has('kind') ? next.kind : prev.kind,
      host: params.has('host') ? next.host : prev.host,
      transport: params.has('transport') ? next.transport : prev.transport,
      session: params.has('session') ? next.session : prev.session,
      q: params.has('q') ? next.q : prev.q,
      shape: params.has('shape') ? next.shape : prev.shape,
    }));
    const capture = params.get('capture');
    if (capture) setSelectedId(capture);
    // Keyed on the serialised params: the URLSearchParams object identity changes every render.
  }, [paramKey]);

  /* -------------------- initial + filtered load -------------------- */

  const replaceRows = useCallback(
    (next: RawCapture[]) => {
      const sorted = [...next].sort(byNewest).slice(0, MAX_ROWS);
      idsRef.current = new Set(sorted.map((c) => c.captureId));
      pendingRef.current = [];
      setPendingCount(0);
      commit(sorted);
    },
    [commit],
  );

  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listCaptures({ ...toApiFilters(filters), limit: INITIAL_LIMIT })
      .then((res) => {
        if (cancelled) return;
        replaceRows(res.captures);
        setServerTotal(res.total);
        setMalformed(res.malformed);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the serialised filters so an unchanged filter object does not refetch.
  }, [filterKey, replaceRows]);

  /* -------------------- live stream -------------------- */

  const insertRows = useCallback(
    (incoming: RawCapture[]) => {
      const fresh = incoming.filter((c) => !idsRef.current.has(c.captureId));
      if (fresh.length === 0) return;
      for (const c of fresh) idsRef.current.add(c.captureId);
      const next = [...fresh, ...rowsRef.current].sort(byNewest);
      if (next.length > MAX_ROWS) {
        const dropped = next.splice(MAX_ROWS);
        for (const c of dropped) idsRef.current.delete(c.captureId);
        setDroppedByCap((n) => n + dropped.length);
      }
      commit(next);
    },
    [commit],
  );

  const socketStatus = useServerEvents((event) => {
    if (event.type !== 'capture') return;
    // Coerced through the same validator as the REST path: a row the server
    // pushes is not more trustworthy than one it serves, and a malformed row
    // must be counted rather than rendered with invented fields.
    const capture = coerceCapture(event.capture);
    if (!capture) {
      setMalformed((n) => n + 1);
      return;
    }
    if (!matchesFilters(capture, filters)) return;
    if (paused) {
      pendingRef.current = [capture, ...pendingRef.current].slice(0, MAX_ROWS);
      setPendingCount(pendingRef.current.length);
      return;
    }
    insertRows([capture]);
  });

  const resume = useCallback(() => {
    const queued = pendingRef.current;
    pendingRef.current = [];
    setPendingCount(0);
    setPaused(false);
    if (queued.length > 0) insertRows(queued);
  }, [insertRows]);

  /* -------------------- derived -------------------- */

  const bucketNow = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const spark = useMemo(() => buildBuckets(rows, bucketNow, BUCKET_MS, BUCKET_COUNT), [rows, bucketNow]);
  const inWindow = spark.reduce((sum, b) => sum + b.count, 0);

  const bytesInView = useMemo(() => rows.reduce((sum, r) => sum + (r.bodyBytes || 0), 0), [rows]);
  const hostsInView = useMemo(() => new Set(rows.map((r) => r.urlHost).filter(Boolean)).size, [rows]);
  const sessionsInView = useMemo(
    () => [...new Set(rows.map((r) => r.sessionId).filter(Boolean))].sort(),
    [rows],
  );
  const hostOptions = useMemo(() => {
    const fromStats = (stats?.hosts ?? []).map((h) => h.host);
    const fromRows = rows.map((r) => r.urlHost);
    return [...new Set([...fromStats, ...fromRows, filters.host].filter(Boolean))].sort();
  }, [stats, rows, filters.host]);

  const visible = rows.slice(0, RENDER_LIMIT);
  const selected = selectedId ? rows.find((r) => r.captureId === selectedId) ?? null : null;
  const lastTs = rows[0]?.tsClient ?? stats?.lastCaptureTs ?? null;

  const setFilter = <K extends keyof UiFilters>(key: K, value: UiFilters[K]): void => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-3">
      <StatRow>
        <StatCard
          label="Captures on server"
          value={stats ? formatInt(stats.total) : '—'}
          hint="Total rows the local server has stored across every session. Comes from /api/stats."
          sub={stats ? `${formatInt(stats.sessions)} session(s), ${formatBytes(stats.bytes)}` : 'waiting for /api/stats'}
        />
        <StatCard
          label="Rows in this view"
          value={formatInt(rows.length)}
          hint={`This tab holds at most ${MAX_ROWS.toLocaleString()} rows and renders the newest ${RENDER_LIMIT}. Filters apply before both limits.`}
          sub={
            droppedByCap > 0
              ? `${formatInt(droppedByCap)} older row(s) dropped by the memory cap`
              : hasAnyFilter(filters)
                ? 'filtered'
                : 'unfiltered'
          }
        />
        <StatCard
          label="Bytes in this view"
          value={formatBytes(bytesInView)}
          hint="Sum of the pre-truncation body sizes of the rows currently held in this tab."
        />
        <StatCard
          label="Hosts in this view"
          value={formatInt(hostsInView)}
          hint="Distinct URL hosts among the rows held here. The Hosts page ranks every host the server knows."
        />
        <StatCard
          label="Last capture"
          value={lastTs === null ? '—' : formatRelative(lastTs, now)}
          hint="Time since the newest capture in this view."
          tone={lastTs !== null && now - lastTs > 60_000 ? 'warn' : 'neutral'}
          sub={lastTs === null ? 'nothing captured yet' : formatClock(lastTs)}
        />
      </StatRow>

      <div className="scout-card px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[11px] uppercase tracking-wide text-dark-300">
            Capture rate, {BUCKET_MS / 1000}s buckets
          </h3>
          <span className="font-mono text-[11px] tabular-nums text-dark-200">
            {formatInt(inWindow)} in the last {(BUCKET_MS * BUCKET_COUNT) / 60_000} min
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-dark-400">
          Counted from the rows this tab is holding, after filters — not from the server total.
        </p>
        <div className="mt-1.5 h-16">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
              <defs>
                {/* Palette literals are the CONTRACT.md design tokens; Recharts
                    writes SVG paint attributes, so a CSS variable here would be
                    resolved per-element rather than from the theme layer. */}
                <linearGradient id="scout-spark" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5e6eff" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="#5e6eff" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" hide />
              <YAxis hide allowDecimals={false} />
              <Tooltip
                cursor={{ stroke: '#343c64' }}
                contentStyle={{
                  background: '#0c102b',
                  border: '1px solid #343c64',
                  borderRadius: 8,
                  fontSize: 11,
                }}
                labelStyle={{ color: '#767faa' }}
                itemStyle={{ color: '#a4aac6' }}
                formatter={(value) => [String(value ?? 0), 'captures']}
              />
              <Area
                type="monotone"
                dataKey="count"
                stroke="#5e6eff"
                strokeWidth={1.5}
                fill="url(#scout-spark)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="scout-card flex flex-wrap items-end gap-2 px-3 py-2.5">
        <Field label="Kind">
          <select
            className="scout-control w-40 text-[12px]"
            value={filters.kind}
            onChange={(e) => setFilter('kind', e.target.value as CaptureKind | '')}
          >
            <option value="">all kinds</option>
            {ALL_KINDS.map((k) => (
              <option key={k} value={k}>
                {humanizeKind(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Host">
          <select
            className="scout-control w-52 text-[12px]"
            value={filters.host}
            onChange={(e) => setFilter('host', e.target.value)}
          >
            <option value="">all hosts</option>
            {hostOptions.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Transport">
          <select
            className="scout-control w-32 text-[12px]"
            value={filters.transport}
            onChange={(e) => setFilter('transport', e.target.value as CaptureTransport | '')}
          >
            <option value="">all</option>
            {ALL_TRANSPORTS.map((t) => (
              <option key={t} value={t}>
                {transportLabel(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Session">
          <select
            className="scout-control w-44 text-[12px]"
            value={filters.session}
            onChange={(e) => setFilter('session', e.target.value)}
          >
            <option value="">all sessions</option>
            {[...new Set([...sessionsInView, filters.session].filter(Boolean))].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search">
          <input
            type="search"
            className="scout-control w-56 text-[12px]"
            placeholder="url, path or body text"
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value)}
          />
        </Field>

        {filters.shape && (
          <button
            type="button"
            className="scout-button text-[11px]"
            onClick={() => setFilter('shape', '')}
            title="Filtering to one payload shape, from a link on the Shapes page. Click to clear."
          >
            shape {filters.shape.slice(0, 10)} ×
          </button>
        )}

        <span className="flex-1" />

        <button
          type="button"
          className={paused ? 'scout-button-primary text-[12px]' : 'scout-button text-[12px]'}
          onClick={() => (paused ? resume() : setPaused(true))}
          title={
            paused
              ? 'Resume: merge the queued captures into the table. The stream never stopped.'
              : 'Freeze the table. Captures keep arriving and queue up while paused.'
          }
        >
          {paused ? `Resume${pendingCount > 0 ? ` (${pendingCount} queued)` : ''}` : 'Pause'}
        </button>
        <button
          type="button"
          className="scout-button text-[12px]"
          onClick={() => setFilters(EMPTY_FILTERS)}
          disabled={!hasAnyFilter(filters)}
        >
          Clear filters
        </button>
        <a
          className="scout-button text-[12px]"
          href={exportUrl('ndjson', toApiFilters(filters))}
          download
          title="Downloads every capture matching these filters as NDJSON, straight from the server. Values were redacted in the page before upload."
        >
          Export NDJSON
        </a>
      </div>

      {paused && (
        <p className="rounded-lg border border-blue-600/50 bg-blue-700/15 px-3 py-1.5 text-[12px] text-blue-500">
          View is frozen. {pendingCount === 0 ? 'Nothing has arrived yet.' : `${formatInt(pendingCount)} capture(s) queued.`}{' '}
          The collector and the socket are untouched.
        </p>
      )}

      {malformed > 0 && (
        <p className="rounded-lg border border-yellow-600/50 bg-yellow-600/10 px-3 py-1.5 text-[12px] text-yellow-500">
          {formatInt(malformed)} row(s) the server sent could not be read as captures and were
          discarded rather than shown with filled-in fields.
        </p>
      )}

      {loadError ? (
        <EmptyState
          tone="error"
          title="Could not load captures"
          body={<p>{loadError}</p>}
          steps={[
            <>
              Start the Scout server: <code className="text-dark-100">npm run start</code> (it binds
              127.0.0.1:8787).
            </>,
            <>Reload this page once the server answers /api/health.</>,
          ]}
        />
      ) : rows.length === 0 && !loading ? (
        hasAnyFilter(filters) ? (
          <EmptyState
            title="No captures match these filters"
            body={
              <p>
                {serverTotal === null
                  ? 'The server has captures, but none of them match.'
                  : `The server matched ${formatInt(serverTotal)} row(s) for this query.`}{' '}
                Live captures are filtered with the same rules, so a matching one will appear here as
                soon as it arrives.
              </p>
            }
            action={
              <button type="button" className="scout-button" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            title="No captures yet"
            body={
              <p>
                Nothing has reached the server. The collector runs inside your own signed-in browser
                and only reports traffic the page already made.
              </p>
            }
            steps={[
              <>Load the MV3 extension unpacked (or install the userscript in Tampermonkey).</>,
              <>
                Grant the site in the extension popup — that is what lets the collector see inside a
                cross-origin BETBY iframe.
              </>,
              <>Open the sportsbook and browse to a page with live odds. Rows appear within seconds.</>,
              <>
                Still nothing?{' '}
                {socketStatus.state === 'open'
                  ? 'The socket is connected, so the collector is not uploading — check Settings for the upload switch and server URL.'
                  : 'This dashboard is not connected to the server, so start it first.'}
              </>,
            ]}
          />
        )
      ) : (
        <div className="flex min-w-0 flex-col gap-3 xl:flex-row">
          <div className="min-w-0 flex-1">
            <CaptureTable
              rows={visible}
              totalHeld={rows.length}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            />
          </div>
          {selected && (
            <div className="min-w-0 xl:w-[620px] xl:flex-none">
              <div className="xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)]">
                <CaptureDetail row={selected} onClose={() => setSelectedId(null)} />
              </div>
            </div>
          )}
        </div>
      )}

      {loading && rows.length === 0 && !loadError && (
        <p className="text-[12px] text-dark-300">Loading captures…</p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-dark-300">{label}</span>
      {children}
    </label>
  );
}
