/**
 * App shell and router.
 *
 * Hash routing, hand-rolled: there is no router dependency, and for five views
 * a listener on `hashchange` is less machinery than a library would be.
 *
 * The one piece of real logic here is the live-event fan-in. A single WebSocket
 * feeds every page, so it is subscribed once at the top and the pieces pages
 * care about are pushed down as props. Subscribing per page would open a socket
 * per navigation and lose the stats stream every time the user clicked away.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { CaptureStats, CollectorIdentity, ServerEvent } from '../shared/types.ts';
import { Shell } from './components/Shell.tsx';
import { DEFAULT_ROUTE, parseHash, type ParsedRoute } from './components/Nav.tsx';
import { useServerEvents } from './lib/ws.ts';
import { LiveCaptures } from './pages/LiveCaptures.tsx';
import { Bets } from './pages/Bets.tsx';
import { Bettors } from './pages/Bettors.tsx';
import { Margins } from './pages/Margins.tsx';
import { Movements } from './pages/Movements.tsx';
import { Hosts } from './pages/Hosts.tsx';
import { Shapes } from './pages/Shapes.tsx';
import { Frames } from './pages/Frames.tsx';
import { Settings } from './pages/Settings.tsx';

/**
 * Relative-time labels need a clock, but re-rendering every list on every tick
 * is wasteful. One second is a compromise: fast enough that "3s ago" is not a
 * lie, slow enough to be free.
 */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useRoute(): ParsedRoute {
  const [route, setRoute] = useState<ParsedRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    // A first visit has no hash at all; normalise it so links and the back
    // button behave the same from the start.
    if (!window.location.hash) window.location.hash = `#/${DEFAULT_ROUTE}`;
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function App(): ReactNode {
  const route = useRoute();
  const now = useNow();

  const [stats, setStats] = useState<CaptureStats | null>(null);
  const [collectors, setCollectors] = useState<{ connected: number; identities: CollectorIdentity[] }>({
    connected: 0,
    identities: [],
  });

  // Capture events are consumed by LiveCaptures through its own subscription;
  // here we only track the aggregate views so the header stays live on every
  // page. Held in a ref as well as state so the handler identity stays stable
  // and the socket is not resubscribed on every stats update.
  const statsRef = useRef<CaptureStats | null>(null);

  const onEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case 'stats':
        statsRef.current = event.stats;
        setStats(event.stats);
        break;
      case 'collector':
        setCollectors({ connected: event.connected, identities: event.identities });
        break;
      default:
        // 'capture' and 'frames' are handled by the pages that display them.
        break;
    }
  }, []);

  const status = useServerEvents(onEvent);

  let page: ReactNode;
  switch (route.id) {
    case 'bets':
      page = <Bets now={now} />;
      break;
    case 'bettors':
      page = <Bettors now={now} />;
      break;
    case 'margins':
      // No clock: a median margin has no "3s ago" to it.
      page = <Margins />;
      break;
    case 'movements':
      page = <Movements now={now} />;
      break;
    case 'hosts':
      page = <Hosts now={now} />;
      break;
    case 'shapes':
      page = <Shapes now={now} />;
      break;
    case 'frames':
      page = <Frames now={now} />;
      break;
    case 'settings':
      page = <Settings />;
      break;
    case 'captures':
    default:
      page = <LiveCaptures params={route.params} stats={stats} now={now} />;
      break;
  }

  return (
    <Shell route={route.id} status={status} now={now} collectors={collectors}>
      {!route.known && (
        <div className="mb-4 rounded-lg border border-yellow-600/40 bg-yellow-600/10 px-4 py-3 text-sm text-yellow-500">
          There is no view called <code className="font-mono">{route.raw}</code>. Showing live captures instead.
        </div>
      )}
      {page}
    </Shell>
  );
}
