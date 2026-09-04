/**
 * Collector settings, plus server self-description.
 *
 * Writes go to the server, which pushes them to every connected collector over
 * the WebSocket - so a change here reaches the sportsbook tab without a reload.
 * If the collector is on the HTTP fallback it will not receive the push, and
 * the page says so rather than letting the user think a setting applied.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { CollectorConfig } from '../../shared/types.ts';
import { getConfig, getHealth, saveConfig, type HealthInfo } from '../lib/api.ts';
import { formatBytes, formatRelative } from '../lib/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';

interface ToggleSpec {
  key: keyof CollectorConfig;
  label: string;
  help: string;
  /** Rendered as a warning rather than help text. */
  danger?: string;
}

const TOGGLES: ToggleSpec[] = [
  { key: 'enabled', label: 'Collecting', help: 'Master switch. Off means the hooks stay installed but record nothing.' },
  { key: 'upload', label: 'Upload to server', help: 'Off keeps captures in the page ring buffer only - nothing reaches this database.' },
  { key: 'hookFetch', label: 'Hook fetch()', help: 'Most modern sportsbook traffic.' },
  { key: 'hookXhr', label: 'Hook XMLHttpRequest', help: 'Older widgets and analytics still use it.' },
  { key: 'hookWebSocket', label: 'Hook WebSocket', help: 'Live odds usually arrive here. Leave on.' },
  { key: 'hookSse', label: 'Hook EventSource', help: 'Server-sent events, occasionally used for live pushes.' },
  {
    key: 'domFallback',
    label: 'DOM fallback',
    help: 'MutationObserver capture of rendered markup. Only useful when nothing readable is on the wire - noisy and fragile otherwise.',
  },
  { key: 'skipAssets', label: 'Skip assets', help: 'Drop images, fonts, CSS and JS by content type. Keeps the volume sane.' },
  {
    key: 'redact',
    label: 'Redact credentials',
    help: 'Masks tokens, emails and wallet addresses in the page, before anything is stored or uploaded.',
    danger: 'Turning this off means an exported capture file can contain a live session token. Do not share an unredacted export.',
  },
  { key: 'panel', label: 'Show debug panel', help: 'The floating panel on the sportsbook page.' },
];

interface NumberSpec {
  key: 'maxBodyBytes' | 'ringSize' | 'flushIntervalMs';
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
}

const NUMBERS: NumberSpec[] = [
  {
    key: 'maxBodyBytes',
    label: 'Max body bytes',
    help: 'Bodies larger than this are truncated - and flagged as truncated, never silently.',
    min: 1_000,
    max: 8_000_000,
    step: 1000,
  },
  {
    key: 'ringSize',
    label: 'Ring buffer size',
    help: 'Captures held in the page. Overflow is counted and reported, not hidden.',
    min: 50,
    max: 20_000,
    step: 50,
  },
  {
    key: 'flushIntervalMs',
    label: 'Flush interval (ms)',
    help: 'How often the collector ships a batch to this server.',
    min: 250,
    max: 60_000,
    step: 250,
  },
];

export function Settings(): ReactNode {
  const [config, setConfig] = useState<CollectorConfig | null>(null);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [c, h] = await Promise.all([getConfig(), getHealth()]);
        if (cancelled) return;
        setConfig(c.config);
        setUnreadable(c.unreadable);
        setHealth(h);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback(
    (next: Partial<CollectorConfig>) => {
      setConfig((current) => {
        if (!current) return current;
        const merged = { ...current, ...next };
        setSaving(true);
        void saveConfig(merged)
          .then((result) => {
            setConfig(result.config);
            setUnreadable(result.unreadable);
            setSavedAt(Date.now());
            setError(null);
          })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setSaving(false));
        return merged;
      });
    },
    [],
  );

  if (error && !config) {
    return (
      <EmptyState
        title="Cannot reach the Scout server"
        body={`The dashboard could not load the collector config: ${error}. Is the server running on port 8787?`}
      />
    );
  }

  if (!config) {
    return <EmptyState title="Loading settings" body="Reading the collector config from the server." />;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-600/40 bg-red-600/10 px-4 py-3 text-sm text-red-500">
          Last save failed: {error}
        </div>
      )}
      {unreadable.length > 0 && (
        <div className="rounded-lg border border-yellow-600/40 bg-yellow-600/10 px-4 py-3 text-sm text-yellow-500">
          The server returned {unreadable.length} field(s) this build does not understand ({unreadable.join(', ')}). They
          were left untouched rather than overwritten.
        </div>
      )}

      <section className="rounded-xl border border-dark-600 bg-dark-800/60 p-5">
        <header className="mb-4 flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold text-dark-100">Collector</h2>
            <p className="mt-1 text-xs text-dark-200">
              Saved on the server and pushed to every connected collector. A collector on the HTTP fallback will not
              receive the push until it reconnects.
            </p>
          </div>
          <span className="font-mono text-xs text-dark-200">
            {saving ? 'saving…' : savedAt ? `saved ${formatRelative(savedAt, Date.now())}` : ''}
          </span>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          {TOGGLES.map((spec) => {
            const value = config[spec.key];
            const checked = typeof value === 'boolean' ? value : false;
            return (
              <label
                key={spec.key}
                className="flex cursor-pointer gap-3 rounded-lg border border-dark-600 bg-dark-900/40 p-3 hover:border-dark-400"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 flex-none accent-blue-600"
                  checked={checked}
                  onChange={(e) => patch({ [spec.key]: e.target.checked } as Partial<CollectorConfig>)}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-dark-100">{spec.label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-dark-200">{spec.help}</span>
                  {spec.danger && !checked && (
                    <span className="mt-1 block text-xs leading-snug text-red-500">{spec.danger}</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {NUMBERS.map((spec) => (
            <label key={spec.key} className="block">
              <span className="block text-xs font-medium text-dark-100">{spec.label}</span>
              <input
                type="number"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={config[spec.key]}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) patch({ [spec.key]: n } as Partial<CollectorConfig>);
                }}
                className="mt-1 w-full rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 font-mono text-sm tabular-nums text-dark-100 focus:border-blue-600 focus:outline-none"
              />
              <span className="mt-1 block text-xs leading-snug text-dark-200">{spec.help}</span>
            </label>
          ))}
        </div>

        <label className="mt-4 block">
          <span className="block text-xs font-medium text-dark-100">Server URL</span>
          <input
            type="text"
            value={config.serverUrl}
            onChange={(e) => patch({ serverUrl: e.target.value })}
            className="mt-1 w-full rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 font-mono text-sm text-dark-100 focus:border-blue-600 focus:outline-none"
          />
          <span className="mt-1 block text-xs leading-snug text-dark-200">
            Where the collector ships captures. Only loopback addresses are accepted - the server rejects anything else,
            so this cannot be pointed at a third party.
          </span>
        </label>
      </section>

      {health && (
        <section className="rounded-xl border border-dark-600 bg-dark-800/60 p-5">
          <h2 className="mb-3 text-sm font-semibold text-dark-100">Server</h2>
          <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            <Row label="Version" value={health.version ?? 'unknown'} />
            <Row label="Protocol" value={health.protocolVersion === null ? 'unknown' : String(health.protocolVersion)} />
            <Row label="Schema" value={health.schemaVersion === null ? 'unknown' : String(health.schemaVersion)} />
            <Row label="Database" value={health.dbPath ?? 'unknown'} mono />
            <Row label="Captures stored" value={rawNumber(health.raw, 'captures')} />
            <Row label="Retention" value={retentionLabel(health.raw)} />
            <Row label="Max body" value={formatBytes(rawNum(health.raw, 'maxBodyBytes'))} />
            <Row
              label="Last capture"
              value={
                rawNum(health.raw, 'lastCaptureTs') === null
                  ? 'never'
                  : formatRelative(rawNum(health.raw, 'lastCaptureTs'), Date.now())
              }
            />
          </dl>
          {warningsOf(health.raw).length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-yellow-500">
              {warningsOf(health.raw).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * `/api/health` carries more than HealthInfo models, and the client keeps the
 * whole response in `raw` rather than dropping the rest. These read from it
 * defensively: an older server that omits a field renders "unknown" instead of
 * NaN.
 */
function rawNum(raw: Record<string, unknown>, key: string): number | null {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rawNumber(raw: Record<string, unknown>, key: string): string {
  const v = rawNum(raw, key);
  return v === null ? 'unknown' : v.toLocaleString();
}

function retentionLabel(raw: Record<string, unknown>): string {
  const days = rawNum(raw, 'retentionDays');
  if (days === null) return 'unknown';
  return days === 0 ? 'kept forever' : `${days} days`;
}

function warningsOf(raw: Record<string, unknown>): string[] {
  const v = raw['warnings'];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="flex justify-between gap-4 border-b border-dark-700 pb-1">
      <dt className="text-dark-200">{label}</dt>
      <dd className={`truncate text-dark-100 ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
