/**
 * Bets — the first view of the tool's actual subject.
 *
 * Everything here is a fact read back out of the database: who (as a masked
 * handle), how much, at what price, on what. The one derived number is the
 * stake percentile, and it is labelled as what it is — a statement about SIZE.
 * The brief is explicit that a large bet must not imply a good bet, and this
 * page is where that temptation is strongest, so the percentile is presented
 * beside its sample count and never as a recommendation.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getStakeDistribution, listBets, type BetFilters, type StakeDistribution, type StoredBet } from '../lib/api.ts';
import { formatRelative } from '../lib/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';

function money(value: number | null, currency: string | null): string {
  if (value === null) return '—';
  const n = value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toFixed(2);
  return currency ? `${n} ${currency}` : n;
}

function odds(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

/** Where a stake sits in the recent distribution. Size only — never merit. */
function stakeBand(stake: number | null, currency: string | null, dist: StakeDistribution | null): string | null {
  if (stake === null || dist === null || !dist.samples || currency !== dist.currency) return null;
  if (dist.p99 !== undefined && stake >= dist.p99) return 'top 1% by size';
  if (dist.p90 !== undefined && stake >= dist.p90) return 'top 10% by size';
  return null;
}

export function Bets({ now }: { now: number }): ReactNode {
  const [page, setPage] = useState<{ bets: StoredBet[]; total: number } | null>(null);
  const [dist, setDist] = useState<StakeDistribution | null>(null);
  const [filters, setFilters] = useState<BetFilters>({ sort: 'ts', limit: 100 });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: BetFilters) => {
    try {
      const [p, d] = await Promise.all([listBets(f), getStakeDistribution()]);
      setPage({ bets: p.bets, total: p.total });
      setDist(d.samples > 0 ? d : null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  const patch = (next: Partial<BetFilters>): void => setFilters((f) => ({ ...f, ...next }));

  // Currencies present in the current result set. Sorting by stake across more
  // than one of them compares raw numbers, which is meaningless without a rate.
  const mixedCurrencies = [...new Set((page?.bets ?? []).map((b) => b.currency).filter((c): c is string => c !== null))];

  if (error) {
    return <EmptyState title="Cannot reach the Scout server" body={`Loading bets failed: ${error}`} />;
  }

  if (!page) {
    return <EmptyState title="Loading bets" body="Reading the normalized feed from the server." />;
  }

  if (page.total === 0) {
    return (
      <EmptyState
        title="No bets stored yet"
        body="Bets appear once the collector captures a bets feed. Open the sportsbook's Bets Feed tab and let it poll for a few seconds, then come back. If captures are arriving but no bets are, check the capture's Warnings tab — it says exactly which rule did not match."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-dark-600 bg-dark-800/60 p-4">
        <label className="block">
          <span className="block text-xs font-medium text-dark-100">Type</span>
          <select
            value={filters.type ?? ''}
            onChange={(e) => patch({ type: e.target.value || undefined })}
            className="mt-1 rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 text-sm text-dark-100"
          >
            <option value="">all</option>
            <option value="single">single</option>
            <option value="combo">combo</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-dark-100">Min stake</span>
          <input
            type="number"
            min={0}
            value={filters.minStake ?? ''}
            onChange={(e) => patch({ minStake: e.target.value ? Number(e.target.value) : undefined })}
            className="mt-1 w-28 rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 font-mono text-sm tabular-nums text-dark-100"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-dark-100">Sort</span>
          <select
            value={filters.sort ?? 'ts'}
            onChange={(e) => patch({ sort: e.target.value })}
            className="mt-1 rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 text-sm text-dark-100"
          >
            <option value="ts">newest</option>
            <option value="stake">stake</option>
            <option value="odds">odds</option>
          </select>
        </label>
        <label className="block flex-1 min-w-40">
          <span className="block text-xs font-medium text-dark-100">Search</span>
          <input
            type="text"
            placeholder="team, league or selection"
            value={filters.q ?? ''}
            onChange={(e) => patch({ q: e.target.value || undefined })}
            className="mt-1 w-full rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 text-sm text-dark-100"
          />
        </label>
        <span className="ml-auto font-mono text-xs tabular-nums text-dark-200">
          {page.bets.length} of {page.total}
        </span>
      </div>

      {mixedCurrencies.length > 1 && filters.sort === 'stake' && (
        <p className="rounded-lg border border-yellow-600/40 bg-yellow-600/10 px-4 py-2 text-xs leading-relaxed text-yellow-500">
          These results mix {mixedCurrencies.join(', ')}, and sorting is on the raw number with no exchange rate
          applied — so a 250,000 {mixedCurrencies.find((c) => c !== 'USD') ?? 'EUR'} stake and a 250,000 USD stake rank
          together. Until an FX source exists, compare sizes within one currency.
        </p>
      )}

      {dist && (
        <p className="rounded-lg border border-dark-600 bg-dark-800/40 px-4 py-2 text-xs leading-relaxed text-dark-200">
          Stake distribution over the last 24h, {dist.currency} only, {dist.samples.toLocaleString()} bets: median{' '}
          <span className="font-mono text-dark-100">{money(dist.p50 ?? null, dist.currency ?? null)}</span>, 90th{' '}
          <span className="font-mono text-dark-100">{money(dist.p90 ?? null, dist.currency ?? null)}</span>, 99th{' '}
          <span className="font-mono text-dark-100">{money(dist.p99 ?? null, dist.currency ?? null)}</span>. A large
          stake is a fact about size — it says nothing on its own about whether the bet is any good.
        </p>
      )}

      <div className="space-y-2">
        {page.bets.map((bet) => {
          const band = stakeBand(bet.stake, bet.currency, dist);
          return (
            <article key={bet.betKey} className="rounded-xl border border-dark-600 bg-dark-800/60 p-4">
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-sm text-dark-100">{bet.bettorLabel ?? 'unknown'}</span>
                <span className="rounded bg-dark-600 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-dark-100">
                  {bet.type}
                  {bet.legCount > 1 ? ` ×${bet.legCount}` : ''}
                </span>
                <span className="font-mono text-sm tabular-nums text-dark-100">{money(bet.stake, bet.currency)}</span>
                <span className="text-dark-200">@</span>
                <span className="font-mono text-sm tabular-nums text-dark-100">{odds(bet.totalOdds)}</span>
                <span className="text-xs text-dark-200">
                  to return {money(bet.potentialWin, bet.currency)}
                </span>
                {band && (
                  <span className="rounded border border-yellow-600/50 px-1.5 py-0.5 text-[11px] text-yellow-500">
                    {band}
                  </span>
                )}
                <span className="ml-auto font-mono text-xs text-dark-200" title={new Date(bet.ts).toISOString()}>
                  first seen {formatRelative(bet.ts, now)}
                </span>
              </header>

              <table className="mt-3 w-full text-xs">
                <thead className="text-dark-200">
                  <tr className="text-left">
                    <th className="py-1 font-medium">Event</th>
                    <th className="py-1 font-medium">Market</th>
                    <th className="py-1 font-medium">Selection</th>
                    <th className="py-1 text-right font-medium">At bet</th>
                    <th className="py-1 text-right font-medium">Now</th>
                  </tr>
                </thead>
                <tbody>
                  {bet.legs.map((leg) => {
                    // Movement is only meaningful when we have both prices.
                    const moved =
                      leg.oddsAtBet !== null && leg.currentOdds !== null && leg.currentOdds !== leg.oddsAtBet;
                    const shortened = moved && (leg.currentOdds as number) < (leg.oddsAtBet as number);
                    return (
                      <tr key={leg.idx} className="border-t border-dark-700 align-top">
                        <td className="py-1 pr-3 text-dark-100">
                          {leg.eventName ?? <span className="text-dark-300">unnamed event</span>}
                          {leg.league && <span className="block text-dark-200">{leg.sport} · {leg.league}</span>}
                        </td>
                        <td className="py-1 pr-3 text-dark-200">{leg.marketName ?? '—'}</td>
                        <td className="py-1 pr-3 text-dark-100">{leg.selectionName ?? '—'}</td>
                        <td className="py-1 text-right font-mono tabular-nums text-dark-100">{odds(leg.oddsAtBet)}</td>
                        <td
                          className={`py-1 text-right font-mono tabular-nums ${
                            moved ? (shortened ? 'text-green-600' : 'text-red-500') : 'text-dark-200'
                          }`}
                          title={
                            moved
                              ? shortened
                                ? 'Price shortened after the bet — the market moved toward this selection'
                                : 'Price drifted after the bet — the market moved away from it'
                              : undefined
                          }
                        >
                          {odds(leg.currentOdds)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </article>
          );
        })}
      </div>
    </div>
  );
}
