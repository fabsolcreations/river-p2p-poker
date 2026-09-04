import type { ReactNode } from 'react';

import type { CollectorIdentity } from '../../shared/types.ts';
import type { SocketStatus } from '../lib/ws.ts';
import { ConnectionDot } from './ConnectionDot.tsx';
import { Nav, PAGE_META, type RouteId } from './Nav.tsx';

/**
 * App chrome: a fixed sidebar of views and a header carrying the live-connection
 * state.
 *
 * The header shows collector count as well as socket state because those are two
 * different failures that look identical from the table: "the server is down"
 * and "the server is up but no page is running the collector". Distinguishing
 * them is most of the support burden of a tool like this.
 */
export function Shell(props: {
  route: RouteId;
  status: SocketStatus;
  now: number;
  collectors: { connected: number; identities: CollectorIdentity[] };
  children: ReactNode;
}): ReactNode {
  const { route, status, now, collectors, children } = props;
  const meta = PAGE_META[route];

  const collectorTitle =
    collectors.identities.length > 0
      ? collectors.identities
          .map(
            (id) =>
              `${id.kind} v${id.version} - ${id.frameOrigin || id.pageOrigin}${id.isTopFrame ? ' (top frame)' : ' (child frame)'}`,
          )
          .join('\n')
      : 'No collector is connected to the server right now. Install the extension or userscript and open the sportsbook.';

  return (
    <div className="flex min-h-screen bg-dark-900">
      <aside className="sticky top-0 hidden h-screen w-56 flex-none overflow-y-auto border-r border-dark-600 bg-dark-800/60 md:block">
        <a
          href="#/captures"
          className="flex items-baseline gap-2 border-b border-dark-600 px-4 py-3.5 hover:bg-dark-700/60"
        >
          <span className="text-sm font-semibold text-white">Betby Scout</span>
          <span className="text-[10px] uppercase tracking-widest text-dark-300">local</span>
        </a>
        <Nav current={route} />
        <p className="border-t border-dark-600 px-4 py-3 text-[11px] leading-4 text-dark-300">
          Read-only. Scout observes traffic the signed-in browser already
          receives. It never places a bet, touches a betslip, or logs in.
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-dark-600 bg-dark-900/95 px-4 py-3 backdrop-blur">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-white">{meta.title}</h1>
            <p className="truncate text-[11px] text-dark-300">{meta.subtitle}</p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="rounded border border-dark-500 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-dark-100"
              title={collectorTitle}
            >
              {collectors.connected} collector{collectors.connected === 1 ? '' : 's'}
            </span>
            <ConnectionDot status={status} now={now} />
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-4">{children}</main>
      </div>
    </div>
  );
}
