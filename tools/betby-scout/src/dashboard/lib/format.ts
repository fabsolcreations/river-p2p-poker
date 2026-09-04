/**
 * Display formatting.
 *
 * One rule runs through every function here: an absent value renders as the
 * em-dash placeholder, never as 0, "n/a" or a plausible-looking default. A
 * dashboard that shows `0.00` for "we could not parse the price" is worse than
 * one that shows nothing, because the reader has no way to tell the difference.
 *
 * Callers pair the dash with a `title` explaining *why* it is missing wherever
 * the reason is known.
 */

/** The single placeholder for "no value". Used everywhere, so it is scannable. */
export const NO_VALUE = '—';

const clockFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Decimal odds, always to exactly 2 places (CONTRACT.md design tokens). */
export function formatOdds(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return NO_VALUE;
  return value.toFixed(2);
}

/**
 * Money with its currency label attached. The label is mandatory: this project
 * mixes fiat and crypto stakes, and a bare "250" is ambiguous enough to be
 * dangerous. When the payload did not carry a currency we say so rather than
 * assuming USD.
 */
export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (!isFiniteNumber(amount)) return NO_VALUE;
  const magnitude = Math.abs(amount);
  // Crypto stakes are routinely < 1 unit, so small values keep more precision.
  const digits = magnitude === 0 ? 2 : magnitude >= 1 ? 2 : 8;
  const num = amount.toLocaleString(undefined, {
    minimumFractionDigits: magnitude >= 1 || magnitude === 0 ? 2 : 2,
    maximumFractionDigits: digits,
  });
  const label = currency && currency.trim() ? currency.trim().toUpperCase() : null;
  return label ? `${num} ${label}` : `${num} (currency not in payload)`;
}

/** A plain percentage. Only for values that are not rates over a sample. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(value)) return NO_VALUE;
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * A share of a population, with the denominator always visible.
 *
 * CONTRACT-adjacent rule from the brief: never a bare percentage without its
 * sample size. "18.4% (221 of 1,204)" is honest; "18.4%" invites the reader to
 * treat 2-of-11 and 200-of-1100 as the same fact.
 */
export function formatShare(part: number | null | undefined, total: number | null | undefined): string {
  if (!isFiniteNumber(part) || !isFiniteNumber(total) || total <= 0) return NO_VALUE;
  return `${((part / total) * 100).toFixed(1)}% (${formatInt(part)} of ${formatInt(total)})`;
}

/**
 * Classification confidence. Rendered as a percentage plus the word "guess"
 * below the contract's threshold - the caller supplies the threshold so this
 * file does not need to import the domain constant.
 */
export function formatConfidence(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return NO_VALUE;
  return `${Math.round(value * 100)}%`;
}

export function formatInt(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return NO_VALUE;
  return Math.round(value).toLocaleString();
}

/** Binary sizes, because these are byte counts of buffers, not disk marketing. */
export function formatBytes(value: number | null | undefined): string {
  if (!isFiniteNumber(value) || value < 0) return NO_VALUE;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = value / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

/** Wall-clock time of day, seconds included - captures arrive seconds apart. */
export function formatClock(ts: number | null | undefined): string {
  if (!isFiniteNumber(ts) || ts <= 0) return NO_VALUE;
  return clockFormatter.format(new Date(ts));
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!isFiniteNumber(ts) || ts <= 0) return NO_VALUE;
  return dateTimeFormatter.format(new Date(ts));
}

/**
 * Relative time. `now` is passed in rather than read from the clock so the
 * whole table re-renders against one consistent instant and rows cannot
 * disagree about what "5s ago" means.
 */
export function formatRelative(ts: number | null | undefined, now: number): string {
  if (!isFiniteNumber(ts) || ts <= 0) return NO_VALUE;
  const delta = now - ts;
  const ahead = delta < 0;
  const abs = Math.abs(delta);

  if (abs < 1000) return 'just now';
  const seconds = Math.floor(abs / 1000);
  let body: string;
  if (seconds < 60) body = `${seconds}s`;
  else if (seconds < 3600) body = `${Math.floor(seconds / 60)}m`;
  else if (seconds < 86_400) body = `${Math.floor(seconds / 3600)}h`;
  else body = `${Math.floor(seconds / 86_400)}d`;
  return ahead ? `in ${body}` : `${body} ago`;
}

/** Compact duration for latency figures. */
export function formatDuration(ms: number | null | undefined): string {
  if (!isFiniteNumber(ms) || ms < 0) return NO_VALUE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Truncates in the middle. URL paths are long and their *ends* carry the
 * discriminating segment, so lopping off the tail loses the useful half.
 */
export function truncateMiddle(value: string, max = 64): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function truncateEnd(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Turns a kind id like `bets_feed` into `Bets feed` for headings and chips. */
export function humanizeKind(kind: string): string {
  const spaced = kind.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return 'unknown';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Pretty-prints JSON when the body parses, and returns the raw text when it
 * does not. Never throws - a body we cannot parse is still worth showing.
 */
export function tryPrettyJson(text: string | null): { text: string; isJson: boolean } {
  if (text === null) return { text: '', isJson: false };
  try {
    return { text: JSON.stringify(JSON.parse(text) as unknown, null, 2), isJson: true };
  } catch {
    return { text, isJson: false };
  }
}

/** Parses a body to a JSON value, or null when it is not JSON. */
export function tryParseJson(text: string | null | undefined): unknown {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
