import type { ReactNode } from 'react';

import type { RawCapture } from '../../shared/types.ts';
import { formatBytes, formatClock, truncateMiddle } from '../lib/format.ts';
import { CaptureFlags, KindChip, transportLabel } from './KindChip.tsx';

/**
 * The capture list.
 *
 * Deliberately not virtualised: instead of a scroll-window library the caller
 * passes an already-sliced page and we show, in the footer, exactly how many
 * rows are being withheld. A virtual list would hide the fact that the browser
 * is holding thousands of bodies in memory; a visible "showing 300 of 2,914"
 * makes the cap a fact the reader knows rather than a silent truncation.
 */
export function CaptureTable(props: {
  rows: RawCapture[];
  /** Total rows the caller holds, before the render cap. */
  totalHeld: number;
  selectedId: string | null;
  onSelect: (captureId: string) => void;
}): ReactNode {
  const { rows, totalHeld, selectedId, onSelect } = props;
  const hidden = Math.max(0, totalHeld - rows.length);

  return (
    <div className="scout-card overflow-hidden">
      <div className="max-h-[calc(100vh-19rem)] overflow-auto">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead className="sticky top-0 z-10 bg-dark-700 text-[11px] uppercase tracking-wide text-dark-200">
            <tr>
              <Th className="w-[74px]">Time</Th>
              <Th className="w-[60px]">Via</Th>
              <Th className="w-[56px]">Method</Th>
              <Th className="w-[52px] text-right">Status</Th>
              <Th className="w-[150px]">Host</Th>
              <Th>Path</Th>
              <Th className="w-[74px] text-right">Size</Th>
              <Th className="w-[170px]">Kind</Th>
              <Th className="w-[110px]">Flags</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const selected = c.captureId === selectedId;
              return (
                <tr
                  key={c.captureId}
                  tabIndex={0}
                  aria-selected={selected}
                  onClick={() => onSelect(c.captureId)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      onSelect(c.captureId);
                    }
                  }}
                  className={`cursor-pointer border-t border-dark-700 outline-none transition-colors ${
                    selected ? 'bg-blue-700/25' : 'hover:bg-dark-700/70 focus:bg-dark-700'
                  }`}
                >
                  <Td className="font-mono tabular-nums text-dark-200">
                    {formatClock(c.tsClient)}
                  </Td>
                  <Td>
                    <span className="text-dark-100">{transportLabel(c.transport)}</span>
                    {c.direction === 'outbound' && (
                      <span className="ml-1 text-[10px] text-dark-300" title="Outbound frame or request body">
                        ↑
                      </span>
                    )}
                  </Td>
                  <Td className="text-dark-200">{c.method ?? '—'}</Td>
                  <Td className={`text-right font-mono tabular-nums ${statusClass(c.status)}`}>
                    {c.status ?? '—'}
                  </Td>
                  <Td className="text-dark-100" title={c.urlHost}>
                    <span className="block truncate">{c.urlHost || '—'}</span>
                  </Td>
                  <Td className="text-dark-200" title={c.url}>
                    <span className="block truncate font-mono">
                      {truncateMiddle(c.urlPath || c.url, 90)}
                      {c.urlQuery ? <span className="text-dark-400">?{truncateMiddle(c.urlQuery, 40)}</span> : null}
                    </span>
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-dark-100">
                    {formatBytes(c.bodyBytes)}
                  </Td>
                  <Td>
                    <KindChip
                      kind={c.classification.kind}
                      confidence={c.classification.confidence}
                      adapterId={c.classification.adapterId}
                      reasons={c.classification.reasons}
                    />
                  </Td>
                  <Td>
                    <CaptureFlags
                      truncated={c.truncated}
                      redacted={c.redacted}
                      bodyBytes={c.bodyBytes}
                      error={c.error}
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <div className="border-t border-dark-600 bg-dark-800 px-3 py-1.5 text-[11px] text-dark-300">
          Showing the newest {rows.length.toLocaleString()} of {totalHeld.toLocaleString()} rows held
          in this tab. Narrow the filters, or use Export to take the whole set to disk.
        </div>
      )}
    </div>
  );
}

function statusClass(status: number | undefined): string {
  if (status === undefined) return 'text-dark-400';
  if (status >= 500) return 'text-red-500';
  if (status >= 400) return 'text-red-500';
  if (status >= 300) return 'text-yellow-500';
  if (status >= 200) return 'text-dark-100';
  return 'text-dark-200';
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <th className={`px-2 py-1.5 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }): ReactNode {
  return (
    <td className={`max-w-0 px-2 py-1 align-middle ${className}`} title={title}>
      {children}
    </td>
  );
}
