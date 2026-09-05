/**
 * Margins — the honest headline number for a single book.
 *
 * This page exists because of what it deliberately does NOT show. Scout has
 * prices from one sportsbook. De-vig that book's market and you get a fair
 * probability derived from the book itself; compare it back against the book and
 * the difference is zero, always, by construction. A screen that printed that
 * subtraction as "+7.8% EV" would be manufacturing exactly the illusion this
 * project was built to avoid (see the header of src/analysis/types.ts).
 *
 * What survives that constraint is the overround: how much margin the book
 * charges, measured directly, comparable across sports and market types. That is
 * a real fact about a real book, and it is the whole of this page.
 *
 * The second rule the layout enforces is that no median appears without the
 * number of markets it was taken over. A median over three markets is a fact
 * about three markets, and the bar chart would otherwise draw it at the same
 * weight as a median over four hundred.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from 'recharts';

import { getMargins, type MarginRow, type MarginsResult } from '../lib/api.ts';
import { formatInt, formatPercent, truncateEnd } from '../lib/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';

/**
 * Below this many markets a group's median is reported but flagged.
 *
 * Ten is a judgement call and is labelled as one in the UI. The reasoning: with
 * a handful of markets the median is decided by which markets the collector
 * happened to see — a couple of niche props on a quiet night — rather than by
 * how the book prices that sport. There is no threshold at which the number
 * becomes true; there is a point below which it is mostly sampling.
 */
const THIN_SAMPLE_MARKETS = 10;

type Grouping = 'sport' | 'type';

interface ChartDatum {
  group: string;
  /** Median margin in percent, i.e. 4.5 for a 4.5% overround. */
  median: number;
  markets: number;
  /** Drawn beside the bar so the sample size is never a hover away. */
  label: string;
  thin: boolean;
}

/** Ascending: the tightest-priced group sits at the top, which is the read. */
function toChartData(rows: readonly MarginRow[]): ChartDatum[] {
  return rows
    .map((row) => ({
      group: row.group,
      median: row.medianMarginPct * 100,
      markets: row.markets,
      label: `${(row.medianMarginPct * 100).toFixed(1)}%  ·  ${formatInt(row.markets)} market${row.markets === 1 ? '' : 's'}`,
      thin: row.markets < THIN_SAMPLE_MARKETS,
    }))
    .sort((a, b) => a.median - b.median);
}

export function Margins(): ReactNode {
  const [result, setResult] = useState<MarginsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<Grouping>('sport');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await getMargins();
        if (!cancelled) {
          setResult(r);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <EmptyState
        tone="error"
        title="Cannot reach the Scout server"
        body={`Loading margins failed: ${error}`}
        steps={[
          'Check that the Scout server is running on 127.0.0.1:8787.',
          'Reload this page once it is up — margins are computed on request, so there is nothing cached to lose.',
        ]}
      />
    );
  }

  if (!result) {
    return <EmptyState title="Computing margins" body="Reading complete markets back out of the database and removing the overround." />;
  }

  if (!result.supported) {
    return (
      <EmptyState
        tone="warning"
        title="This server build has no margins route"
        body={
          <>
            The dashboard asked for <code className="font-mono text-dark-100">/api/analysis/margins</code> and the
            server answered 404. The page itself is fine; the analysis route is not present in the server you are
            running.
          </>
        }
        steps={['Rebuild the server (npm run build:server) and restart it.', 'Reload this page.']}
      />
    );
  }

  const rows = grouping === 'sport' ? result.bySport : result.byType;
  const other = grouping === 'sport' ? result.byType : result.bySport;

  return (
    <div className="space-y-4">
      <Preamble />

      {result.note && (
        <p className="rounded-lg border border-dark-600 bg-dark-800/40 px-4 py-2 text-xs leading-relaxed text-dark-200">
          {result.note}
        </p>
      )}

      {result.malformed > 0 && (
        <p className="rounded-lg border border-yellow-600/40 bg-yellow-600/10 px-4 py-2 text-xs leading-relaxed text-yellow-500">
          {formatInt(result.malformed)} row{result.malformed === 1 ? '' : 's'} from the server had no group name, no
          market count or no median, so {result.malformed === 1 ? 'it was' : 'they were'} dropped rather than shown
          with a filled-in blank. The medians below are computed from the rows that did arrive intact.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <GroupToggle
          grouping={grouping}
          onChange={setGrouping}
          sportCount={result.bySport.length}
          typeCount={result.byType.length}
        />
        <span className="ml-auto font-mono text-xs tabular-nums text-dark-200">
          {formatInt(rows.reduce((sum, r) => sum + r.markets, 0))} markets across {formatInt(rows.length)} group
          {rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {rows.some((r) => r.medianMarginPct < 0) && (
        <p className="rounded-lg border border-yellow-600/40 bg-yellow-600/10 px-4 py-2 text-xs leading-relaxed text-yellow-500">
          At least one group has a median margin below zero. That does not mean the book is paying out more than it
          takes in — it means those markets were almost certainly assembled from outcomes that do not belong to the
          same market, or from a market with an outcome we never saw priced. Treat a negative row as a parsing bug to
          chase, not as a finding.
        </p>
      )}

      {rows.length === 0 ? (
        <NoGroups grouping={grouping} otherCount={other.length} onSwitch={() => setGrouping(grouping === 'sport' ? 'type' : 'sport')} />
      ) : (
        <>
          <MarginChart rows={rows} grouping={grouping} />
          <MarginTable rows={rows} grouping={grouping} />
        </>
      )}
    </div>
  );
}

function Preamble(): ReactNode {
  return (
    <section className="rounded-xl border border-dark-600 bg-dark-800/60 p-4 text-sm leading-relaxed text-dark-100">
      <p>
        This is the book&apos;s <strong className="font-semibold text-white">margin</strong>, not an edge for you. Add
        up the implied probability of every outcome in a complete market and the total comes to more than 100%; the
        excess is what the book keeps. A lower median means that sport or that market type is priced more tightly —
        it costs less to bet into. It does not mean the market is beatable.
      </p>
      <p className="mt-2 text-dark-200">
        Scout has prices from one book. Removing that book's margin gives a fair price derived from its own
        numbers, and betting that back into the same book returns{' '}
        <span className="font-mono text-dark-100">minus the margin</span> — never zero, never positive. That is the
        arithmetic, not a limitation waiting to be engineered around. So no figure on this page is an opportunity,
        and none is presented as one. Showing a genuine price edge would need a second, independent source of
        prices, and there is not one yet.
      </p>
    </section>
  );
}

function GroupToggle(props: {
  grouping: Grouping;
  onChange: (g: Grouping) => void;
  sportCount: number;
  typeCount: number;
}): ReactNode {
  const { grouping, onChange, sportCount, typeCount } = props;
  const button = (id: Grouping, label: string, count: number): ReactNode => (
    <button
      type="button"
      onClick={() => onChange(id)}
      aria-pressed={grouping === id}
      className={`rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
        grouping === id ? 'bg-blue-600/25 font-medium text-white' : 'text-dark-100 hover:bg-dark-600'
      }`}
    >
      {label}{' '}
      <span className="font-mono text-[11px] tabular-nums text-dark-200">{formatInt(count)}</span>
    </button>
  );
  return (
    <div className="inline-flex gap-1 rounded-lg border border-dark-600 bg-dark-800/60 p-1">
      {button('sport', 'By sport', sportCount)}
      {button('type', 'By market type', typeCount)}
    </div>
  );
}

function MarginChart({ rows, grouping }: { rows: readonly MarginRow[]; grouping: Grouping }): ReactNode {
  const data = toChartData(rows);
  // One row per bar plus the axis. A fixed height would squash twenty sports
  // into an unreadable band and leave three floating in whitespace.
  const height = Math.max(140, data.length * 28 + 48);

  return (
    <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-dark-300">
        Median margin by {grouping === 'sport' ? 'sport' : 'market type'}, tightest first
      </h3>
      {/*
        The table below carries the same numbers in a form a screen reader can
        read in order, so the chart is marked decorative rather than given an
        aria-label that would only restate it badly.
      */}
      <div style={{ height }} className="mt-3 w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 156, bottom: 20, left: 4 }}>
            {/* Palette literals are the CONTRACT.md design tokens; Recharts
                writes SVG paint attributes, so a CSS variable here would resolve
                per-element rather than from the theme layer. */}
            <XAxis
              type="number"
              // The floor follows the data below zero rather than being pinned
              // at 0. A negative median margin is possible (de-vig accepts an
              // overround down to 0.85) and it is a signal worth seeing, not
              // one to clip off the edge of the axis.
              domain={[(dataMin: number) => Math.min(0, dataMin), 'dataMax']}
              tickFormatter={(v: number) => `${v.toFixed(1)}%`}
              tick={{ fill: '#767faa', fontSize: 11 }}
              stroke="#343c64"
            />
            <YAxis
              type="category"
              dataKey="group"
              width={148}
              tickFormatter={(v: string) => truncateEnd(v, 22)}
              tick={{ fill: '#a4aac6', fontSize: 11 }}
              stroke="#343c64"
            />
            <Bar dataKey="median" isAnimationActive={false} radius={[0, 4, 4, 0]} barSize={16}>
              {data.map((d) => (
                // Thin samples are drawn muted AND labelled with their count -
                // colour alone never carries the caveat.
                <Cell key={d.group} fill={d.thin ? '#343c64' : '#5e6eff'} />
              ))}
              <LabelList dataKey="label" position="right" fill="#a4aac6" fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-dark-300">
        Bars drawn in grey are medians over fewer than {THIN_SAMPLE_MARKETS} markets. They are shown because hiding
        them would misrepresent what has been captured, but they describe those few markets rather than the group.
      </p>
    </div>
  );
}

function MarginTable({ rows, grouping }: { rows: readonly MarginRow[]; grouping: Grouping }): ReactNode {
  const sorted = [...rows].sort((a, b) => a.medianMarginPct - b.medianMarginPct);

  return (
    <div className="overflow-x-auto rounded-xl border border-dark-600 bg-dark-800/60">
      <table className="w-full text-xs">
        <caption className="px-4 pt-3 text-left text-[11px] text-dark-300">
          Every median with the number of markets it was taken over. Min and max are the tightest and widest single
          market in the group, so a wide range means the group is not priced uniformly.
        </caption>
        <thead className="text-dark-200">
          <tr className="text-left">
            <th className="px-4 py-2 font-medium">{grouping === 'sport' ? 'Sport' : 'Market type'}</th>
            <th className="px-4 py-2 text-right font-medium">Markets</th>
            <th className="px-4 py-2 text-right font-medium">Median margin</th>
            <th className="px-4 py-2 text-right font-medium">Tightest</th>
            <th className="px-4 py-2 text-right font-medium">Widest</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const thin = row.markets < THIN_SAMPLE_MARKETS;
            return (
              <tr key={row.group} className="border-t border-dark-700">
                <td className="px-4 py-2 text-dark-100">
                  <span className="align-middle">{row.group}</span>
                  {thin && (
                    <span
                      className="ml-2 rounded-sm border border-dark-400 px-1 align-middle text-[10px] leading-4 text-dark-200"
                      title={`Median over ${row.markets} market${row.markets === 1 ? '' : 's'}. Below ${THIN_SAMPLE_MARKETS} the figure describes the markets we happened to capture rather than how the book prices this group.`}
                    >
                      thin sample
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-dark-100">{formatInt(row.markets)}</td>
                <td
                  className={`px-4 py-2 text-right font-mono tabular-nums ${thin ? 'text-dark-200' : 'text-white'}`}
                >
                  {formatPercent(row.medianMarginPct, 1)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-dark-200">
                  {formatPercent(row.minMarginPct, 1)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-dark-200">
                  {formatPercent(row.maxMarginPct, 1)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The empty state distinguishes "nothing captured" from "captured, but nothing
 * de-viggable", because the fix is different: the first needs the collector
 * running, the second needs markets whose every outcome is priced.
 */
function NoGroups(props: { grouping: Grouping; otherCount: number; onSwitch: () => void }): ReactNode {
  const { grouping, otherCount, onSwitch } = props;
  const label = grouping === 'sport' ? 'sport' : 'market type';

  if (otherCount > 0) {
    return (
      <EmptyState
        title={`No market carries a ${label}`}
        body={`The server computed margins for ${formatInt(otherCount)} ${grouping === 'sport' ? 'market type' : 'sport'} group${otherCount === 1 ? '' : 's'}, but none of the markets it used had a ${label} attached. That is a gap in what the adapter mapped out of the feed, not a gap in the odds.`}
        steps={[
          <>Switch to the other grouping — the same markets are there.{' '}
            <button type="button" onClick={onSwitch} className="scout-button px-2 py-0.5 text-[11px]">
              Show by {grouping === 'sport' ? 'market type' : 'sport'}
            </button>
          </>,
          <>
            Open a capture on <a className="text-blue-500 hover:underline" href="#/captures">Live captures</a> and check
            its Unmapped fields list — if the feed carries the {label} under a name the adapter does not read yet, it
            will be sitting in there.
          </>,
        ]}
      />
    );
  }

  return (
    <EmptyState
      title="No complete market has been de-vigged yet"
      body="A margin needs a market where every outcome is priced at once. A market missing one outcome has no meaningful overround, so Scout refuses it rather than spreading a phantom margin across the outcomes that remain."
      steps={[
        'Open the sportsbook with the collector installed and leave an event page open long enough for its odds to arrive.',
        <>
          Check <a className="text-blue-500 hover:underline" href="#/captures?kind=odds_update">Live captures</a> for
          odds traffic. No odds captured means nothing to de-vig.
        </>,
        'Markets with more than 12 outcomes are skipped on purpose — de-vig error grows with the field size, so an outright with 40 runners produces a confidently wrong number rather than a useful one.',
      ]}
    />
  );
}
