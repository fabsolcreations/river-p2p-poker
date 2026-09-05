/**
 * Movements — a price against its own past.
 *
 * This is one of the few things a single book genuinely supports. Comparing
 * Duel's price now with Duel's price twenty minutes ago needs no second source,
 * because the comparison is internal: the book itself moved.
 *
 * Two decisions drive the whole layout.
 *
 * Ranking is on the change in implied PROBABILITY, not on an odds ratio. 1.10 to
 * 1.05 is a far larger move than 11.00 to 10.50, and a ratio ranks them
 * identically. Probability is additive and comparable across price ranges, so
 * percentage points are the only unit in which these rows can be sorted against
 * each other at all.
 *
 * The steam and drift labels are UNCALIBRATED and the page says so in a place
 * the reader cannot miss. The thresholds are hand-chosen starting points that
 * have never been checked against a settled outcome. A label here describes what
 * a price did; it makes no claim about what will happen next.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { DEFAULT_MOVEMENT_OPTIONS, type MovementKind } from '../../analysis/types.ts';
import { getMovements, type MovementRow, type MovementsResult } from '../lib/api.ts';
import { formatDuration, formatInt, formatOdds, formatRelative, truncateEnd } from '../lib/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';

/**
 * Declared as a total Record so adding a kind to the union in analysis/types.ts
 * fails this build rather than rendering the new kind as an unstyled chip.
 *
 * Green and red are deliberately absent. Those colours read as good and bad in
 * every other view of this tool, and none of these four labels is a verdict.
 */
const KIND_STYLE: Record<MovementKind, string> = {
  steam: 'border-blue-600 bg-blue-700/20 text-blue-500',
  drift: 'border-yellow-600 bg-yellow-600/15 text-yellow-500',
  'round-trip': 'border-purple-600 bg-purple-600/20 text-purple-500',
  move: 'border-dark-500 bg-dark-700 text-dark-200',
};

const KIND_TITLE: Record<MovementKind, string> = {
  steam:
    'Rapid shortening: the price moved toward this selection faster than the steam threshold. The threshold is uncalibrated, so this names a fast move and nothing more.',
  drift: 'Rapid lengthening: the price moved away from this selection.',
  'round-trip':
    'The price moved and came back. The two endpoints therefore understate how far it actually travelled in between.',
  move: 'Changed, but not fast or far enough to be called anything else.',
};

const ALL_KINDS = Object.keys(KIND_STYLE) as MovementKind[];

/**
 * Probability change in percentage points, signed.
 *
 * Percentage points rather than a percentage: the value is a difference between
 * two probabilities, and calling a move from 40% to 44% "a 10% move" is the
 * classic way to turn four points into a number ten times its size.
 */
function formatPoints(probDelta: number): string {
  const points = Number((probDelta * 100).toFixed(1));
  const sign = points > 0 ? '+' : points < 0 ? '-' : '';
  return `${sign}${Math.abs(points).toFixed(1)} pp`;
}

export function Movements({ now }: { now: number }): ReactNode {
  const [result, setResult] = useState<MovementsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<MovementKind | ''>('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await getMovements();
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

  const all = result?.movements ?? [];

  const ranked = useMemo(() => {
    // Sorted on the ABSOLUTE change: a four-point drift is exactly as large an
    // event as a four-point shortening, and burying one under the other would
    // make the ranking a statement about direction rather than about size. The
    // direction is carried by the sign and by the kind chip.
    const rows = kind === '' ? [...all] : all.filter((m) => m.kind === kind);
    return rows.sort((a, b) => Math.abs(b.probDelta) - Math.abs(a.probDelta));
  }, [all, kind]);

  if (error) {
    return (
      <EmptyState
        tone="error"
        title="Cannot reach the Scout server"
        body={`Loading movements failed: ${error}`}
        steps={[
          'Check that the Scout server is running on 127.0.0.1:8787.',
          'Reload once it is up. Movement history lives in the database, so nothing is lost while the server is down.',
        ]}
      />
    );
  }

  if (!result) {
    return <EmptyState title="Reading price history" body="Walking each selection's recorded prices to find where they moved." />;
  }

  if (!result.supported) {
    return (
      <EmptyState
        tone="warning"
        title="This server build has no movements route"
        body={
          <>
            The dashboard asked for <code className="font-mono text-dark-100">/api/analysis/movements</code> and the
            server answered 404. The route is not present in the server you are running.
          </>
        }
        steps={['Rebuild the server (npm run build:server) and restart it.', 'Reload this page.']}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Preamble />
      <CalibrationCaption />

      {result.note && (
        <p className="rounded-lg border border-dark-600 bg-dark-800/40 px-4 py-2 text-xs leading-relaxed text-dark-200">
          {result.note}
        </p>
      )}

      {result.malformed > 0 && (
        <p className="rounded-lg border border-yellow-600/40 bg-yellow-600/10 px-4 py-2 text-xs leading-relaxed text-yellow-500">
          {formatInt(result.malformed)} row{result.malformed === 1 ? '' : 's'} from the server were missing a key, a
          usable price or the probability change, so {result.malformed === 1 ? 'it was' : 'they were'} dropped instead
          of being shown with a reconstructed value. Everything below arrived complete.
        </p>
      )}

      {all.length === 0 ? (
        <NoMovements />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dark-600 bg-dark-800/60 p-4">
            <label className="block">
              <span className="block text-xs font-medium text-dark-100">Kind</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as MovementKind | '')}
                className="mt-1 rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 text-sm text-dark-100"
              >
                <option value="">all</option>
                {ALL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <p className="max-w-md text-[11px] leading-4 text-dark-300">
              This filter runs on the rows already loaded — it does not ask the server for a different set, so the
              counts below always add up to what arrived.
            </p>
            <span className="ml-auto font-mono text-xs tabular-nums text-dark-200">
              {formatInt(ranked.length)} of {formatInt(all.length)}
            </span>
          </div>

          {ranked.length === 0 ? (
            <EmptyState
              title={`No ${kind} moves in this batch`}
              body={`The server returned ${formatInt(all.length)} movement${all.length === 1 ? '' : 's'}, none of them classified as ${kind}. Clear the filter to see the rest.`}
            />
          ) : (
            <MovementTable rows={ranked} now={now} />
          )}
        </>
      )}
    </div>
  );
}

function Preamble(): ReactNode {
  return (
    <section className="rounded-xl border border-dark-600 bg-dark-800/60 p-4 text-sm leading-relaxed text-dark-100">
      <p>
        Each row is one selection&apos;s price compared against its own recent past — this book against itself, which
        needs no second source to be meaningful.
      </p>
      <p className="mt-2 text-dark-200">
        Rows are ranked by how far the implied probability moved, in percentage points, because that is the only unit
        in which two moves at different price levels can be compared. 1.10 to 1.05 shifts the implied probability by
        4.3 points; 11.00 to 10.50 shifts it by 0.4. An odds ratio would call those the same move.
      </p>
    </section>
  );
}

/**
 * The caption the brief requires, and the most important text on the page.
 *
 * The default numbers are quoted from the analysis module rather than retyped,
 * so they cannot drift out of sync with the constants that actually govern the
 * classification — with the caveat that the server may have been run with other
 * options, which is stated rather than assumed away.
 */
function CalibrationCaption(): ReactNode {
  const minPoints = (DEFAULT_MOVEMENT_OPTIONS.minProbDelta * 100).toFixed(1);
  const steamPoints = (DEFAULT_MOVEMENT_OPTIONS.steamProbPerMinute * 100).toFixed(1);

  return (
    <section className="rounded-xl border border-yellow-600/50 bg-yellow-600/10 p-4 text-xs leading-relaxed text-yellow-500">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide">Thresholds are uncalibrated</h3>
      <p className="mt-1.5">
        Scout&apos;s defaults report a move of {minPoints} percentage points or more, and call a move{' '}
        <em className="not-italic font-semibold">steam</em> above {steamPoints} points per minute. Both numbers were
        chosen by hand as a starting point. Neither has been validated against a single settled outcome. If the server
        ran with different options it says so in its own note.
      </p>
      <p className="mt-1.5">
        A row labelled steam means a price moved quickly. It is not a prediction, it is not a signal, and it is not a
        recommendation to bet anything. Whether these labels carry information is an open question that can only be
        answered by checking them against results we do not have yet.
      </p>
    </section>
  );
}

function MovementTable({ rows, now }: { rows: readonly MovementRow[]; now: number }): ReactNode {
  return (
    <div className="overflow-x-auto rounded-xl border border-dark-600 bg-dark-800/60">
      <table className="w-full text-xs">
        <thead className="text-dark-200">
          <tr className="text-left">
            <th className="px-4 py-2 font-medium">Event</th>
            <th className="px-4 py-2 font-medium">Selection</th>
            <th className="px-4 py-2 text-right font-medium">From</th>
            <th className="px-4 py-2 text-right font-medium">To</th>
            <th className="px-4 py-2 text-right font-medium" title="Change in implied probability, in percentage points. This is the ranking key.">
              Prob change
            </th>
            <th className="px-4 py-2 text-right font-medium">Duration</th>
            <th
              className="px-4 py-2 text-right font-medium"
              title="How many recorded prices the window covers. Two prices are a before and an after, not a trend."
            >
              Prices
            </th>
            <th className="px-4 py-2 font-medium">Kind</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // Direction is read off the two prices, which is unambiguous,
            // rather than off the sign of probDelta - that sign convention
            // belongs to the analysis layer and is not this page's to assume.
            const shortened = row.oddsTo < row.oddsFrom;
            const unchanged = row.oddsTo === row.oddsFrom;
            const directionTitle = unchanged
              ? 'The endpoints are the same price. On a round trip the move happened in between.'
              : shortened
                ? 'Price shortened - the market moved toward this selection.'
                : 'Price drifted - the market moved away from this selection.';

            return (
              <tr key={`${row.selectionKey}-${row.tsFrom}-${row.tsTo}`} className="border-t border-dark-700 align-top">
                <td className="px-4 py-2 text-dark-100" title={row.eventKey}>
                  {row.eventName ? (
                    truncateEnd(row.eventName, 44)
                  ) : (
                    <span className="font-mono text-dark-300">{truncateEnd(row.eventKey, 28)}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-dark-100" title={row.selectionKey}>
                  {row.selectionName ? (
                    truncateEnd(row.selectionName, 32)
                  ) : (
                    <span className="font-mono text-dark-300">{truncateEnd(row.selectionKey, 24)}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-dark-200">{formatOdds(row.oddsFrom)}</td>
                <td
                  className={`px-4 py-2 text-right font-mono tabular-nums ${
                    unchanged ? 'text-dark-200' : shortened ? 'text-green-600' : 'text-red-500'
                  }`}
                  title={directionTitle}
                >
                  {formatOdds(row.oddsTo)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-white">{formatPoints(row.probDelta)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-dark-100">
                  {formatDuration(row.durationMs)}
                  <span className="block font-sans text-[11px] text-dark-300" title={new Date(row.tsTo).toISOString()}>
                    ended {formatRelative(row.tsTo, now)}
                  </span>
                </td>
                <td
                  className="px-4 py-2 text-right font-mono tabular-nums text-dark-200"
                  title={`${row.samples} recorded price${row.samples === 1 ? '' : 's'} in this window.`}
                >
                  {formatInt(row.samples)}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] leading-4 ${KIND_STYLE[row.kind]}`}
                    title={KIND_TITLE[row.kind]}
                  >
                    {row.kind}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NoMovements(): ReactNode {
  const minPoints = (DEFAULT_MOVEMENT_OPTIONS.minProbDelta * 100).toFixed(1);
  const maxGapMinutes = Math.round(DEFAULT_MOVEMENT_OPTIONS.maxGapMs / 60_000);

  return (
    <EmptyState
      title="No price has moved far enough to report"
      body={`A movement needs at least two recorded prices for the same selection, taken close enough together to be one continuous series, with a gap between them of at least ${minPoints} percentage points of implied probability. Anything smaller is mostly the book rounding its own prices.`}
      steps={[
        'Leave the sportsbook open with the collector running. One snapshot of a price is a price; two are a movement.',
        <>
          Check <a className="text-blue-500 hover:underline" href="#/captures?kind=odds_update">Live captures</a> for
          odds traffic. If none is arriving, the collector is not seeing the odds feed and there is no history to walk.
        </>,
        `Gaps longer than ${maxGapMinutes} minutes break a series on purpose: a price recorded before lunch and again after it did not "move fast", it was simply not watched in between.`,
      ]}
    />
  );
}
