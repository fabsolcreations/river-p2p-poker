import type { ReactNode } from 'react';

/**
 * Hash routing + the navigation table.
 *
 * Hand-rolled because there is no router dependency installed and this app has
 * a handful of real views. The hash is the whole route state, so every link is a
 * plain `<a href="#/...">` - back/forward, middle-click and copy-link all work
 * without a single event handler.
 *
 * This module also owns the *honest* half of the nav: the analysis views from
 * the brief that do not exist yet are listed as disabled items carrying what is
 * missing. Shipping them as mock screens with sample data would be the single
 * most misleading thing this dashboard could do - a reader cannot tell a fake
 * +EV table from a real one.
 *
 * Two of those items will never be unlisted by collecting harder, and the labels
 * say so: an edge needs a price from a book other than the one being bet into.
 * Margins and Movements are enabled precisely because they are the analyses a
 * single book can support without that second source.
 */

export type RouteId =
  | 'captures'
  | 'bets'
  | 'bettors'
  | 'margins'
  | 'movements'
  | 'hosts'
  | 'shapes'
  | 'frames'
  | 'settings';

export const DEFAULT_ROUTE: RouteId = 'captures';

const ROUTE_IDS: readonly RouteId[] = [
  'captures',
  'bets',
  'bettors',
  'margins',
  'movements',
  'hosts',
  'shapes',
  'frames',
  'settings',
];

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
  bettors: {
    title: 'Bettors',
    subtitle: 'Who is in the feed. Scored on the prices they took, never on results the feed does not report.',
  },
  margins: {
    title: 'Margins',
    subtitle: 'How much the book charges, by sport and market type. A margin is not an edge, and one book cannot show one.',
  },
  movements: {
    title: 'Movements',
    subtitle: 'Prices against their own past. Steam and drift labels describe a move; the thresholds are uncalibrated.',
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
 *
 * Two of these have a blocker that no amount of collecting will clear. An edge
 * needs a fair price that did not come from the book being bet into, and Scout
 * watches exactly one book — so Opportunities and Price Edges are waiting on a
 * second source of prices, not on more data from this one. Saying "Milestone 4"
 * without saying that would imply they are merely queued.
 */
const FUTURE_ITEMS: FutureItem[] = [
  {
    label: 'Opportunities',
    milestone: 'Needs a 2nd book',
    blocker:
      'Needs a fair price from a source other than the book being bet into. De-vigging Duel and betting back into Duel returns minus the margin - never a positive number - so a second independent book is the missing ingredient, not more captures. Margins shows what one book can honestly report.',
  },
  {
    label: 'Whale Bets',
    milestone: 'Milestone 5',
    blocker:
      'Bets and stakes are parsed and stored - see Bets. A whale view additionally needs a stake distribution with enough history to make a percentile mean something.',
  },
  {
    label: 'Steam Moves',
    milestone: 'Milestone 9',
    blocker:
      'Detection ships in Movements. What is missing is calibration: the steam and drift thresholds are hand-chosen and have never been checked against a settled outcome, so nothing may act on them yet.',
  },
  {
    label: 'Price Edges',
    milestone: 'Needs a 2nd book',
    blocker:
      'Same wall as Opportunities. The overround is removable and Margins reports it, but a fair value taken from the same book prices that book exactly - the only outcome is minus the margin.',
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

const DISCOVERY: RouteId[] = ['captures', 'bets', 'bettors', 'margins', 'movements', 'hosts', 'shapes', 'frames'];

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
          Not built. Each names what it is waiting for — for two of them, that is
          a second book, which no amount of collecting here will supply.
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
