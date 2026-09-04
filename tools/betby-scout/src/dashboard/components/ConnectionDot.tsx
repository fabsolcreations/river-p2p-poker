import type { ReactNode } from 'react';

import type { SocketStatus } from '../lib/ws.ts';
import { formatRelative } from '../lib/format.ts';

/**
 * Live-connection indicator.
 *
 * The dot is never the only signal - CONTRACT.md forbids encoding state in
 * colour alone, and the same reasoning applies here: the word "Live" or
 * "Offline" sits next to it, and the tooltip carries the detail.
 */
export function ConnectionDot({ status, now }: { status: SocketStatus; now: number }): ReactNode {
  const { state } = status;
  const label = state === 'open' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline';
  const dotClass =
    state === 'open'
      ? 'bg-green-600'
      : state === 'connecting'
        ? 'bg-yellow-500 animate-pulse'
        : 'bg-red-600';
  const textClass =
    state === 'open' ? 'text-green-500' : state === 'connecting' ? 'text-yellow-500' : 'text-red-500';

  const detail: string[] = [];
  if (state === 'open') {
    detail.push(
      status.lastEventTs === null
        ? 'Connected to /ws. No events received yet.'
        : `Last event ${formatRelative(status.lastEventTs, now)}.`,
    );
  } else {
    detail.push('Not connected to the Scout server on 127.0.0.1:8787.');
    if (status.attempts > 0) detail.push(`Reconnect attempts: ${status.attempts}.`);
  }
  if (status.lastError) detail.push(status.lastError);
  if (status.malformedFrames > 0) detail.push(`${status.malformedFrames} unreadable frame(s) discarded.`);

  return (
    <span className="inline-flex items-center gap-2" title={detail.join(' ')}>
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className={`text-xs font-medium ${textClass}`}>{label}</span>
      {state !== 'open' && status.attempts > 0 && (
        <span className="font-mono text-[11px] tabular-nums text-dark-300">retry #{status.attempts}</span>
      )}
    </span>
  );
}
