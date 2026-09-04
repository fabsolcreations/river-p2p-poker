/**
 * Collector configuration.
 *
 * The config lives on the server rather than only in the page so that it
 * survives a page reload and so the dashboard can change it while the
 * sportsbook tab stays open. Writes are pushed straight to every connected
 * collector - there is no polling.
 *
 * Unknown keys are dropped rather than merged: this object is echoed back to
 * code running inside a third-party page, and it should never carry anything we
 * did not put there ourselves.
 */

import type { FastifyInstance } from 'fastify';
import { DEFAULT_COLLECTOR_CONFIG, type CollectorConfig } from '../../shared/types.ts';
import type { ServerContext } from '../index.ts';

const META_KEY = 'collector_config';

/** Numeric bounds. A page that asks for a 2 GB ring buffer is not honoured. */
const LIMITS = {
  maxBodyBytes: { min: 1_000, max: 8_000_000 },
  ringSize: { min: 50, max: 20_000 },
  flushIntervalMs: { min: 250, max: 60_000 },
} as const;

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(Math.max(Math.trunc(value), bounds.min), bounds.max);
}

/**
 * Builds a CollectorConfig from arbitrary input, keeping only known keys and
 * falling back to the default for anything missing or malformed.
 */
export function coerceConfig(input: unknown, base: CollectorConfig = DEFAULT_COLLECTOR_CONFIG): CollectorConfig {
  const src = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const boolOr = (key: keyof CollectorConfig, fallback: boolean): boolean =>
    typeof src[key] === 'boolean' ? (src[key] as boolean) : fallback;
  const intOr = (key: 'maxBodyBytes' | 'ringSize' | 'flushIntervalMs'): number => {
    const v = src[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? clamp(n, LIMITS[key]) : base[key];
  };

  let serverUrl = base.serverUrl;
  const rawUrl = src['serverUrl'];
  if (typeof rawUrl === 'string' && rawUrl.length <= 256) {
    try {
      const parsed = new URL(rawUrl);
      // The collector must only ever be told to talk to a local server. Letting
      // this point anywhere would turn the config endpoint into a way to
      // exfiltrate captured traffic to a third party.
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        serverUrl = parsed.origin;
      }
    } catch {
      // keep the existing value
    }
  }

  return {
    enabled: boolOr('enabled', base.enabled),
    upload: boolOr('upload', base.upload),
    serverUrl,
    hookFetch: boolOr('hookFetch', base.hookFetch),
    hookXhr: boolOr('hookXhr', base.hookXhr),
    hookWebSocket: boolOr('hookWebSocket', base.hookWebSocket),
    hookSse: boolOr('hookSse', base.hookSse),
    domFallback: boolOr('domFallback', base.domFallback),
    skipAssets: boolOr('skipAssets', base.skipAssets),
    maxBodyBytes: intOr('maxBodyBytes'),
    ringSize: intOr('ringSize'),
    flushIntervalMs: intOr('flushIntervalMs'),
    redact: boolOr('redact', base.redact),
    panel: boolOr('panel', base.panel),
  };
}

export function readStoredConfig(ctx: ServerContext): CollectorConfig {
  const raw = ctx.db.getMeta(META_KEY);
  if (!raw) return DEFAULT_COLLECTOR_CONFIG;
  try {
    return coerceConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_COLLECTOR_CONFIG;
  }
}

export function registerConfigRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/config', async (_request, reply) => {
    await reply.send(readStoredConfig(ctx));
  });

  app.post('/api/config', async (request, reply) => {
    // Patch semantics: merge over what is stored, so a caller can flip one
    // toggle without having to send the whole object back.
    const merged = coerceConfig(request.body, readStoredConfig(ctx));
    ctx.db.setMeta(META_KEY, JSON.stringify(merged));
    const pushed = ctx.hub.broadcastConfig(merged);
    await reply.send({ ok: true, config: merged, pushedTo: pushed });
  });
}
