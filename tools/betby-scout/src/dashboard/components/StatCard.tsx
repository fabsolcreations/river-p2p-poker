import type { ReactNode } from 'react';

/**
 * One headline number.
 *
 * The `value` is always rendered mono + tabular so a row of cards lines up, and
 * `hint` is not decoration: every card in this app says where its number came
 * from ("server total", "rows in this view"), because the same label over two
 * different denominators is how a dashboard quietly lies.
 */
export function StatCard(props: {
  label: string;
  value: string;
  hint?: string;
  /** Secondary line under the value, e.g. a share with its sample size. */
  sub?: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}): ReactNode {
  const { label, value, hint, sub, tone = 'neutral' } = props;
  const valueClass =
    tone === 'good'
      ? 'text-green-500'
      : tone === 'warn'
        ? 'text-yellow-500'
        : tone === 'bad'
          ? 'text-red-500'
          : 'text-white';

  return (
    <div className="scout-card min-w-0 px-3 py-2.5" title={hint}>
      <div className="truncate text-[11px] uppercase tracking-wide text-dark-300">{label}</div>
      <div className={`mt-1 truncate font-mono text-lg tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-dark-200">{sub}</div>}
    </div>
  );
}

/** Grid wrapper so every page lays its cards out identically. */
export function StatRow({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">{children}</div>
  );
}
