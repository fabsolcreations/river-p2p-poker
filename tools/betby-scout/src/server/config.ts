/**
 * Server configuration.
 *
 * Everything is env-driven with defaults that make `node dist/server/index.js`
 * work with no setup at all. Two of the defaults are load-bearing rather than
 * arbitrary:
 *
 *   - `retentionDays` defaults to 0, meaning *keep forever*. CONTRACT.md rule 6
 *     says history is append-only; a tool that quietly deletes old odds makes
 *     closing-line value uncomputable after the fact, and the deletion is
 *     irreversible. Pruning therefore has to be asked for explicitly.
 *   - the bind host is pinned to loopback. CONTRACT.md says "Bind to 127.0.0.1
 *     only", and the read routes serve a database full of a signed-in user's
 *     traffic, so an env var must not be able to expose it on a LAN.
 *
 * Bad values never fall through silently: they are replaced by the default and
 * the reason is pushed onto `warnings`, which index.ts prints at boot.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Package root, derived from this module's own location so it is correct both
 * when run from source (`src/server/config.ts`) and from the build
 * (`dist/server/config.js`) - both are two levels below the package root.
 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Hostnames we are willing to bind to. Anything else is refused, not honoured. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface ScoutServerConfig {
  /** Always a loopback address. See the note above. */
  host: string;
  port: number;
  /** Absolute path to the SQLite file. */
  dbPath: string;
  /**
   * Hard per-capture body cap. A capture whose body exceeds this is rejected
   * with a reason rather than truncated, because a silently truncated body
   * would look like a complete payload to every parser downstream.
   */
  maxBodyBytes: number;
  /** Fastify `bodyLimit` for the whole request - one flush carries many captures. */
  maxRequestBytes: number;
  /** 0 means keep everything forever, and that is the default. */
  retentionDays: number;
  /** Built dashboard directory. Served as static files when it exists. */
  dashboardDir: string;
  logLevel: string;
  /** Non-fatal problems with the environment. Printed at boot, never swallowed. */
  warnings: string[];
}

function readInt(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  fallback: number,
  bounds: { min: number; max: number },
  warnings: string[],
): number {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      warnings.push(`${name}="${raw}" is not an integer; using ${fallback}.`);
      return fallback;
    }
    if (parsed < bounds.min || parsed > bounds.max) {
      warnings.push(
        `${name}=${parsed} is outside ${bounds.min}..${bounds.max}; using ${fallback}.`,
      );
      return fallback;
    }
    return parsed;
  }
  return fallback;
}

export const DEFAULTS = {
  port: 8787,
  /** 2 MB: twice the collector's own per-body cap, leaving room for base64. */
  maxBodyBytes: 2_000_000,
  maxRequestBytes: 32_000_000,
  retentionDays: 0,
  dbRelativePath: 'data/scout.db',
  dashboardRelativePath: 'dist/dashboard',
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ScoutServerConfig {
  const warnings: string[] = [];

  const requestedHost = env['SCOUT_HOST'] ?? env['HOST'];
  let host = '127.0.0.1';
  if (requestedHost && !LOOPBACK_HOSTS.has(requestedHost)) {
    // Refusing rather than honouring: the read routes expose captured traffic
    // from an authenticated browser session.
    warnings.push(
      `Refusing to bind to "${requestedHost}" - Scout serves captured session data and binds to loopback only. Using 127.0.0.1.`,
    );
  } else if (requestedHost) {
    host = requestedHost;
  }

  const port = readInt(env, ['PORT', 'SCOUT_PORT'], DEFAULTS.port, { min: 1, max: 65_535 }, warnings);

  const rawDb = env['SCOUT_DB'] ?? env['SCOUT_DB_PATH'] ?? DEFAULTS.dbRelativePath;
  // ':memory:' is passed through untouched - resolving it would turn it into a
  // filename and silently create a database file nobody asked for.
  const dbPath = rawDb === ':memory:' || isAbsolute(rawDb) ? rawDb : resolve(PACKAGE_ROOT, rawDb);

  const maxBodyBytes = readInt(
    env,
    ['MAX_BODY_BYTES', 'SCOUT_MAX_BODY_BYTES'],
    DEFAULTS.maxBodyBytes,
    { min: 1024, max: 64_000_000 },
    warnings,
  );

  // The request limit has to hold a whole flush batch, so it is at least eight
  // bodies wide; a batch bigger than this is refused by Fastify with a 413
  // rather than being read into memory.
  const maxRequestBytes = readInt(
    env,
    ['MAX_REQUEST_BYTES', 'SCOUT_MAX_REQUEST_BYTES'],
    Math.max(DEFAULTS.maxRequestBytes, maxBodyBytes * 8),
    { min: 64_000, max: 512_000_000 },
    warnings,
  );

  const retentionDays = readInt(
    env,
    ['RETENTION_DAYS', 'SCOUT_RETENTION_DAYS'],
    DEFAULTS.retentionDays,
    { min: 0, max: 36_500 },
    warnings,
  );
  if (retentionDays > 0) {
    warnings.push(
      `RETENTION_DAYS=${retentionDays}: captures older than ${retentionDays} days will be deleted at startup. History deletion is irreversible.`,
    );
  }

  const rawDashboard = env['SCOUT_DASHBOARD_DIR'] ?? DEFAULTS.dashboardRelativePath;
  const dashboardDir = isAbsolute(rawDashboard) ? rawDashboard : resolve(PACKAGE_ROOT, rawDashboard);

  const logLevel = env['SCOUT_LOG_LEVEL'] ?? env['LOG_LEVEL'] ?? 'info';

  return {
    host,
    port,
    dbPath,
    maxBodyBytes,
    maxRequestBytes,
    retentionDays,
    dashboardDir,
    logLevel,
    warnings,
  };
}

/**
 * Version reported by `/api/health` and sent to collectors, read from
 * package.json at startup. Read lazily and cached, so a missing or malformed
 * package.json degrades to "0.0.0" instead of preventing the server booting -
 * the version is diagnostic, never load-bearing.
 */
let cachedVersion: string | null = null;

export function packageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version =
      parsed !== null && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string'
        ? (parsed as { version: string }).version
        : '0.0.0';
    cachedVersion = version;
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
