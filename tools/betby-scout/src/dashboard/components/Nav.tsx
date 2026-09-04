import type { ReactNode } from 'react';

/**
 * Hash routing + the navigation table.
 *
 * Hand-rolled because there is no router dependency installed and this app has
 * five real views. The hash is the whole route state, so every link is a plain
 * `<a href="#/...">` - back/forward, middle-click and copy-link all work without
 * a single event handler.
 *
 * This module also owns the *honest* half of the nav: the eight analysis views
 * from the brief that do not exist yet are listed as disabled items carrying the
 * milestone that delivers them and the thing that is missing. Shipping them as
 * mock screens with sample data would be the single most misleading thing this
 * dashboard could do - a reader cannot tell a fake +EV table from a real one.
 */

export type RouteId = 'captures' | 'bets' | 'hosts' | 'shapes' | 'frames' | 'settings';

export const DEFAULT_ROUTE: RouteId = 'captures';

const ROUTE_IDS: readonly RouteId[] = ['captures', 'bets', 'hosts', 'shapes', 'frames', 'settings'];

export interface ParsedRoute {
  id: RouteId;
  params: URLSearchParams;
  /** False when the hash named a view that does not exist. */
  known: boolean;
  /** The hash exactly as it arrived, for the "no such view" message. */
  raw: string;
}

export function parseHash(hash: string): ParsedRoute {
  const raw = hash.replace(/^#/, '');
  const trimmed = raw.replace(/^\/+/, '');
  const qIndex = trimmed.indexOf('?');
  const path = (qIndex === -1 ? trimmed : trimmed.slice(0, qIndex)).replace(/\/+$/, '');
  const params = new URLSearchParams(qIndex === -1 ? '' : trimmed.slice(qIndex + 1));
  if (path === '') return { id: DEFAULT_ROUTE, params, known: true, raw };
  const match = ROUTE_IDS.find((id) => id === path);
  return { id: match ?? DEFAULT_ROUTE, params, known: match !== undefined, raw };
}

/** Builds a hash href. Empty/absent params are dropped so links stay readable. */
export function hrefFor(
  id: RouteId,
  params?: Record<string, string | number | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `#/${id}${query ? `?${query}` : ''}`;
}

export interface PageMeta {
  title: string;
  subtitle: string;
}

export const PAGE_META: Record<RouteId, PageMeta> = {
  captures: {
    title: 'Live captures',
    subtitle: 'Everything the collector saw, newest first. This is where you find the bets feed.',
  },
  bets: {
    title: 'Bets',
    subtitle: "Other people's bets, parsed and named. Stake percentiles are facts about size, not verdicts about value.",
  },
  hosts: {
    title: 'Hosts',
    subtitle: 'Which origins served data rather than assets. Host names are discovered, never assumed.',
  },
  shapes: {
    title: 'Shapes',
    subtitle: 'Distinct payload structures, clustered. Scan these to spot the feed schema.',
  },
  frames: {
    title: 'Frames',
    subtitle: 'iframe origins seen on the page. A BETBY widget usually lives in one of these.',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Collector configuration and local server info.',
  },
};

interface FutureItem {
  label: string;
  milestone: string;
  /** What is actually missing. Never "coming soon". */
  blocker: string;
}

/**
 * The brief's analysis sections. Each one names the input it does not have yet,
 * because "not built" and "cannot be built from what we have captured" are
 * different statements and the second is the true one here.
 */
const FUTURE_ITEMS: FutureItem[] = [
  {
    label: 'Opportunities',
    milestone: 'Milestone 4',
    blocker: 'Needs de-vigged fair prices, which need a fully parsed market with every selection priced.',
  },
  {
    label: 'Whale Bets',
    milestone: 'Milestone 5',
    blocker:
      'Bets and stakes are parsed and stored - see Bets. A whale view additionally needs a stake distribution with enough history to make a percentile mean something.',
  },
  {
    label: 'Sharp Bettors',
    milestone: 'Milestone 6',
    blocker: 'Needs settled outcomes per pseudonymous bettor, which means days of feed history.',
  },
  {
    label: 'Steam Moves',
    milestone: 'Milestone 5',
    blocker:
      'Odds snapshots are now recorded whenever a price moves. This needs that history to span enough time to tell a move from noise.',
  },
  {
    label: 'Price Edges',
    milestone: 'Milestone 4',
    blocker: 'Needs a complete market so the overround can be removed. A partial market has no usable fair value.',
  },
  {
    label: 'Popular Legs',
    milestone: 'Milestone 5',
    blocker: 'Legs are extracted and stored. This needs enough distinct feed polls for a repeat to mean something.',
  },
  {
    label: 'Backtesting',
    milestone: 'Milestone 8',
    blocker: 'Needs real settled bets first. Backtesting invented results would only measure the invention.',
  },
  {
    label: 'Paper Trading',
    milestone: 'Milestone 9',
    blocker: 'Needs a live opportunity stream to log paper stakes against.',
  },
];

const DISCOVERY: RouteId[] = ['captures', 'bets', 'hosts', 'shapes', 'frames'];

export function Nav({ current }: { current: RouteId }): ReactNode {
  return (
    <nav className="flex flex-col gap-6 p-3" aria-label="Views">
      <div>
        <NavHeading>Discovery</NavHeading>
        <ul className="mt-1.5 space-y-0.5">
          {DISCOVERY.map((id) => (
            <li key={id}>
              <NavLink id={id} current={current} />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <NavHeading>Analysis</NavHeading>
        <p className="mt-1 px-2 text-[11px] leading-4 text-dark-300">
          Not built. Each needs data we have not captured and parsed yet.
        </p>
        <ul className="mt-1.5 space-y-0.5">
          {FUTURE_ITEMS.map((item) => (
            <li key={item.label}>
              <span
                className="flex cursor-not-allowed flex-col gap-0.5 rounded-lg px-2 py-1.5 text-dark-300 opacity-70"
                title={item.blocker}
                aria-disabled="true"
              >
                <span className="text-[13px] leading-4">{item.label}</span>
                <span className="text-[10px] uppercase leading-3 tracking-wide text-dark-400">
                  {item.milestone}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <NavHeading>Tool</NavHeading>
        <ul className="mt-1.5 space-y-0.5">
          <li>
            <NavLink id="settings" current={current} />
          </li>
        </ul>
      </div>
    </nav>
  );
}

function NavHeading({ children }: { children: ReactNode }): ReactNode {
  return (
    <h2 className="px-2 text-[10px] font-semibold uppercase tracking-widest text-dark-300">
      {children}
    </h2>
  );
}

function NavLink({ id, current }: { id: RouteId; current: RouteId }): ReactNode {
  const meta = PAGE_META[id];
  const active = id === current;
  return (
    <a
      href={hrefFor(id)}
      aria-current={active ? 'page' : undefined}
      title={meta.subtitle}
      className={`block rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
        active
          ? 'bg-blue-600/20 font-medium text-white shadow-[inset_2px_0_0_0_var(--color-blue-500)]'
          : 'text-dark-100 hover:bg-dark-600'
      }`}
    >
      {meta.title}
    </a>
  );
}
