/**
 * Bettors — who is in the feed, and can we say anything about them.
 *
 * The page the brief is really asking for, and the one most able to mislead. So
 * the design rule here is that an UNSCORED bettor is displayed as prominently
 * and as neutrally as a scored one: unscored means unmeasured, not bad, and a
 * layout that buried them would imply a ranking the data does not support.
 *
 * The score itself measures price-taking (closing line value), never results.
 * Duel's feed carries no settlement field, so a results record cannot be built
 * from it at all — and the page says so rather than leaving a suspicious gap.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { EmptyState } from '../components/EmptyState.tsx';
import { formatRelative } from '../lib/format.ts';

interface Component {
  name: string;
  value: number;
  weight: number;
  explanation: string;
}

interface BettorRow {
  profile: {
    bettorKey: string;
    label: string | null;
    bets: number;
    singles: number;
    combos: number;
    avgLegs: number;
    byCurrency: Array<{ currency: string; bets: number; staked: number; avgStake: number; largestStake: number; stakeCv: number | null }>;
    avgOdds: number | null;
    medianOdds: number | null;
    oddsBands: { short: number; mid: number; long: number; extreme: number };
    firstSeen: number;
    lastSeen: number;
    sports: Array<{ sport: string; bets: number }>;
  };
  clv: {
    measured: number;
    unmeasured: { noBetPrice: number; noClosingPrice: number };
    meanClvPercent: number | null;
    distinguishableFromZero: boolean;
  };
  sharpness:
    | { score: number; confidence: number; components: Component[]; warnings: string[] }
    | { score: null; blockers: string[] };
}

interface Payload {
  bettors: BettorRow[];
  scored: number;
  unscored: number;
  limits: string[];
  explanation: string | null;
}

function num(v: number | null, digits = 2): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

export function Bettors({ now }: { now: number }): ReactNode {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/bettors?limit=100');
        if (!res.ok) throw new Error(`server returned ${res.status}`);
        const json = (await res.json()) as Payload;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <EmptyState title="Cannot load bettors" body={error} />;
  if (!data) return <EmptyState title="Loading bettors" body="Reading tracked bettors from the server." />;
  if (data.bettors.length === 0) {
    return (
      <EmptyState
        title="No bettors tracked yet"
        body={data.explanation ?? 'Capture a bets feed and the people in it appear here.'}
      />
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-yellow-600/40 bg-yellow-600/10 p-4">
        <h2 className="text-sm font-semibold text-yellow-500">What this score is, and is not</h2>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-yellow-500/90">
          {data.limits.map((l) => (
            <li key={l}>— {l}</li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-dark-200">
        <span className="font-mono text-dark-100">{data.scored}</span> scored ·{' '}
        <span className="font-mono text-dark-100">{data.unscored}</span> tracked but not scored. Unscored means
        unmeasured, not poor — a bettor without enough closing prices simply has no evidence either way.
      </p>

      {data.explanation && (
        <p className="rounded-lg border border-dark-600 bg-dark-800/40 px-4 py-2 text-xs leading-relaxed text-dark-200">
          {data.explanation}
        </p>
      )}

      <div className="space-y-2">
        {data.bettors.map((row) => {
          const p = row.profile;
          const scored = row.sharpness.score !== null;
          return (
            <article key={p.bettorKey} className="rounded-xl border border-dark-600 bg-dark-800/60 p-4">
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-sm text-dark-100">{p.label ?? 'unknown'}</span>

                {scored ? (
                  <>
                    <span className="rounded bg-blue-600/20 px-2 py-0.5 font-mono text-sm text-blue-500">
                      {row.sharpness.score}/100
                    </span>
                    <span className="text-xs text-dark-200">
                      confidence {(('confidence' in row.sharpness ? row.sharpness.confidence : 0) * 100).toFixed(0)}%
                    </span>
                  </>
                ) : (
                  <span className="rounded border border-dark-400 px-2 py-0.5 text-[11px] uppercase tracking-wide text-dark-200">
                    not scored
                  </span>
                )}

                <span className="text-xs text-dark-200">
                  {p.bets} bets · {p.singles} single / {p.combos} combo · avg {num(p.avgLegs, 1)} legs
                </span>
                <span className="ml-auto font-mono text-xs text-dark-200">
                  last seen {formatRelative(p.lastSeen, now)}
                </span>
              </header>

              <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
                <div>
                  <div className="text-dark-200">Closing line value</div>
                  <div className="mt-0.5 font-mono tabular-nums text-dark-100">
                    {row.clv.measured === 0 ? '—' : `${num(row.clv.meanClvPercent === null ? null : row.clv.meanClvPercent * 100, 2)}%`}
                    <span className="ml-2 text-dark-200">over {row.clv.measured} legs</span>
                  </div>
                  {row.clv.measured > 0 && !row.clv.distinguishableFromZero && (
                    <div className="mt-0.5 text-yellow-500">not distinguishable from zero</div>
                  )}
                  {row.clv.unmeasured.noClosingPrice > 0 && (
                    <div className="mt-0.5 text-dark-200">
                      {row.clv.unmeasured.noClosingPrice} legs have no closing price yet
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-dark-200">Prices taken</div>
                  <div className="mt-0.5 font-mono tabular-nums text-dark-100">
                    median {num(p.medianOdds)} · avg {num(p.avgOdds)}
                  </div>
                  <div className="mt-0.5 text-dark-200">
                    {p.oddsBands.short}/{p.oddsBands.mid}/{p.oddsBands.long}/{p.oddsBands.extreme} short/mid/long/10+
                  </div>
                </div>

                <div>
                  <div className="text-dark-200">Staking</div>
                  {p.byCurrency.slice(0, 2).map((c) => (
                    <div key={c.currency} className="mt-0.5 font-mono tabular-nums text-dark-100">
                      {c.currency}: avg {c.avgStake.toFixed(2)} · max {c.largestStake.toFixed(2)}
                      {c.stakeCv !== null && <span className="ml-2 text-dark-200">cv {c.stakeCv.toFixed(2)}</span>}
                    </div>
                  ))}
                  {p.sports.length > 0 && (
                    <div className="mt-0.5 text-dark-200">
                      {p.sports.slice(0, 3).map((s) => `${s.sport} ${s.bets}`).join(' · ')}
                    </div>
                  )}
                </div>
              </div>

              {scored && 'components' in row.sharpness ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-dark-200 hover:text-dark-100">
                    How this score was built
                  </summary>
                  <div className="mt-2 space-y-1.5">
                    {row.sharpness.components.map((c) => (
                      <div key={c.name} className="text-xs">
                        <span className="font-mono text-dark-100">
                          {c.name} {(c.value * 100).toFixed(0)}
                        </span>
                        <span className="ml-2 text-dark-200">weight {(c.weight * 100).toFixed(0)}%</span>
                        <div className="text-dark-200">{c.explanation}</div>
                      </div>
                    ))}
                    {row.sharpness.warnings.map((w) => (
                      <div key={w} className="text-xs text-yellow-500">
                        {w}
                      </div>
                    ))}
                  </div>
                </details>
              ) : (
                'blockers' in row.sharpness && (
                  <ul className="mt-3 space-y-1 text-xs text-dark-200">
                    {row.sharpness.blockers.map((b) => (
                      <li key={b}>— {b}</li>
                    ))}
                  </ul>
                )
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
