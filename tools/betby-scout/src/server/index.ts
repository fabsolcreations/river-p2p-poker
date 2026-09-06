/**
 * Scout server bootstrap.
 *
 * Fastify on loopback, SQLite underneath, WebSocket fan-out on top, and the
 * built dashboard served as static files so `npm run build && npm start` gives
 * a working UI with no dev server involved.
 *
 * ---------------------------------------------------------------------------
 * THE CORS ASYMMETRY - the most important thing in this file
 * ---------------------------------------------------------------------------
 *
 * The two halves of this server have opposite trust requirements:
 *
 *   WRITE (POST /api/ingest, POST /api/frames, WS /ws/collector)
 *     The collector runs *inside the sportsbook page*, so it posts from
 *     https://duel.com (or whatever origin the BETBY widget's frame has - a
 *     value we deliberately do not know in advance, per CONTRACT.md rule 1).
 *     These routes therefore accept a cross-origin request from any https
 *     origin. That is safe because they only *accept* data; nothing is returned
 *     that the caller did not already have.
 *
 *   READ (everything else: /api/captures, /api/stats, /api/export/*, WS /ws)
 *     These serve the capture database - the traffic of a browser that is
 *     signed in to a sportsbook. If they answered cross-origin requests, then
 *     *any* page the user happens to visit could fetch
 *     http://127.0.0.1:8787/api/export/captures.json and read the lot. So they
 *     are restricted to loopback dashboard origins, and enforced twice: CORS
 *     headers so a browser refuses to hand the response to the page, and an
 *     explicit 403 so a mislabelled request never reaches a handler at all.
 *
 * The Host check on read routes closes DNS rebinding, where a hostile page
 * resolves its own domain to 127.0.0.1 so the browser treats us as same-origin.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors, { type FastifyCorsOptions } from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';

import { loadConfig, packageVersion, type ScoutServerConfig } from './config.ts';
import { openDb, toIngestResult, type ScoutDb } from './db/db.ts';
import { Hub, parseCollectorMessage, parseIdentity, type HubSocket } from './hub.ts';
import { ReferenceStore } from './refs.ts';
import { registerHealthRoutes } from './routes/health.ts';
import {
  normalizeAccepted,
  registerIngestRoutes,
  reclassify,
  validateIngestBatch,
  validateFrameReport,
} from './routes/ingest.ts';
import { registerCaptureRoutes } from './routes/captures.ts';
import { registerStatsRoutes } from './routes/stats.ts';
import { registerConfigRoutes } from './routes/config.ts';
import { registerExportRoutes } from './routes/export.ts';
import { registerBetRoutes } from './routes/bets.ts';
import { registerAnalysisRoutes } from './routes/analysis.ts';
import { registerBettorRoutes } from './routes/bettors.ts';
import { registerEdgeRoutes } from './routes/edges.ts';

/** Everything a route module needs. Passed explicitly rather than via decorators. */
export interface ServerContext {
  db: ScoutDb;
  hub: Hub;
  /** Market/event dictionaries used to turn feed ids into names. */
  refs: ReferenceStore;
  config: ScoutServerConfig;
  /** Epoch ms the process started, for uptime reporting. */
  startedAt: number;
  version: string;
}

/**
 * The `ws` socket, typed structurally. `@types/ws` is not installed (nothing in
 * this project imports ws directly), so the plugin's own socket type erases to
 * `any`; declaring the shape we actually use keeps this file honest.
 */
interface RawWebSocket extends HubSocket {
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
}

/* ------------------------------------------------------------------ *
 * Origin policy
 * ------------------------------------------------------------------ */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/** True for `http://localhost:5273`, `http://127.0.0.1:8787`, and friends. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return false;
  const hostname = hostnameOf(origin);
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Origins the ingest routes accept. Any https origin qualifies because we do
 * not know - and must not assume - which host serves the BETBY widget. Plain
 * http is allowed only from loopback, which is how the collector is exercised
 * against a local test page.
 */
export function isCollectorOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true; // non-browser or opaque origin
  if (origin.startsWith('https://')) return true;
  return isLoopbackOrigin(origin);
}

/** Requests that write data and may therefore come from the sportsbook page. */
export function isWriteRequest(method: string, path: string): boolean {
  if (path === '/ws/collector') return true;
  return method === 'POST' && (path === '/api/ingest' || path === '/api/frames');
}

function pathOf(request: FastifyRequest): string {
  const url = request.url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/* ------------------------------------------------------------------ *
 * Server construction
 * ------------------------------------------------------------------ */

export interface BuildOptions {
  config?: ScoutServerConfig;
  db?: ScoutDb;
  hub?: Hub;
  /** Overrides the log level; tests pass false to silence Fastify entirely. */
  logger?: boolean;
}

export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance & { scout: ServerContext }> {
  const config = options.config ?? loadConfig();
  const db = options.db ?? openDb(config.dbPath, { maxBodyBytes: config.maxBodyBytes });
  const hub = options.hub ?? new Hub({ stats: () => db.stats() });

  // Own what we create, and only that. A caller who injected its own db or hub
  // keeps responsibility for closing them; closing a borrowed handle underneath
  // an embedder would be a nasty surprise.
  const ownsDb = options.db === undefined;
  const ownsHub = options.hub === undefined;

  const app = Fastify({
    // The limit has to hold a whole flush batch. Fastify rejects anything
    // larger with a 413 before reading it into memory.
    bodyLimit: config.maxRequestBytes,
    logger:
      options.logger === false
        ? false
        : { level: config.logLevel, transport: undefined },
    // The collector posts from a page; a stray trailing slash should not 404.
    ignoreTrailingSlash: true,
  });

  const refs = new ReferenceStore(db);
  // Rebuild from what is already stored, so a restart does not briefly
  // un-name every leg until fresh dictionary payloads happen to arrive.
  refs.hydrate();

  const ctx: ServerContext = {
    db,
    hub,
    refs,
    config,
    startedAt: Date.now(),
    version: packageVersion(),
  };

  await app.register(cors, {
    // Per-request policy: see the asymmetry note at the top of this file.
    delegator: (request, callback) => {
      const write = isWriteRequest(
        request.method === 'OPTIONS'
          ? String(request.headers['access-control-request-method'] ?? 'POST').toUpperCase()
          : request.method,
        pathOf(request),
      );
      const corsOptions: FastifyCorsOptions = write
        ? {
            origin: (origin, cb) => cb(null, isCollectorOrigin(origin)),
            methods: ['POST', 'OPTIONS'],
            // No credentials: the collector must never send the sportsbook's
            // cookies to us, and we have no use for them.
            credentials: false,
            maxAge: 600,
          }
        : {
            origin: (origin, cb) => cb(null, origin === undefined || isLoopbackOrigin(origin)),
            methods: ['GET', 'POST', 'OPTIONS'],
            credentials: false,
            exposedHeaders: ['Content-Disposition', 'X-Scout-Filters', 'X-Scout-Rows'],
          };
      callback(null, corsOptions);
    },
  });

  /**
   * Hard gate in front of the read routes. CORS alone tells a *browser* not to
   * hand the body to the page; this makes sure the body is never produced.
   */
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Preflight carries no data and is answered by the CORS plugin; blocking it
    // here would break the collector's legitimate cross-origin POST.
    if (request.method === 'OPTIONS') return;
    const path = pathOf(request);
    if (isWriteRequest(request.method, path)) return;

    const origin = request.headers.origin;
    if (typeof origin === 'string' && !isLoopbackOrigin(origin)) {
      await reply.code(403).send({
        ok: false,
        error: `Origin ${origin} is not allowed to read Scout data. Read routes are limited to a dashboard on localhost.`,
      });
      return;
    }

    // DNS rebinding: a hostile page can point its own hostname at 127.0.0.1 so
    // that its fetches look same-origin. The Host header still carries that
    // hostname, and ours never will.
    const host = request.headers.host;
    if (typeof host === 'string' && host !== '') {
      const hostname = hostnameOf(`http://${host}`);
      if (hostname !== null && !LOOPBACK_HOSTNAMES.has(hostname)) {
        await reply.code(403).send({
          ok: false,
          error: `Host "${host}" is not a loopback address. Scout only answers requests addressed to localhost.`,
        });
      }
    }
  });

  await app.register(websocket, {
    options: {
      // One capture body is capped server-side; a frame larger than the request
      // limit is a protocol error, not something to buffer.
      maxPayload: config.maxRequestBytes,
    },
  });

  registerHealthRoutes(app, ctx);
  registerIngestRoutes(app, ctx);
  registerCaptureRoutes(app, ctx);
  registerStatsRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerExportRoutes(app, ctx);
  registerBetRoutes(app, ctx);
  registerAnalysisRoutes(app, ctx);
  registerBettorRoutes(app, ctx);
  registerEdgeRoutes(app, ctx);
  registerWebsockets(app, ctx);
  registerDashboard(app, ctx);

  // Releasing the SQLite handle belongs to the Fastify lifecycle, not only to
  // the signal handler in start(): anything that builds a server and closes it
  // - every test in this repo, for one - would otherwise leak the file handle,
  // which on Windows means the database cannot even be deleted afterwards.
  app.addHook('onClose', async () => {
    if (ownsHub) hub.stop();
    if (ownsDb) db.close();
  });

  app.setErrorHandler(async (error: unknown, request, reply) => {
    request.log.error({ err: error, url: request.url }, 'request failed');
    // Fastify types the handler's error loosely across versions, so narrow it
    // here rather than trusting a `.statusCode` that may not exist.
    const status =
      typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    const message = error instanceof Error ? error.message : 'internal error';
    await reply.code(status).send({ ok: false, error: message });
  });

  return Object.assign(app, { scout: ctx }) as FastifyInstance & { scout: ServerContext };
}

/* ------------------------------------------------------------------ *
 * WebSocket wiring
 * ------------------------------------------------------------------ */

function registerWebsockets(app: FastifyInstance, ctx: ServerContext): void {
  const { hub, db, config } = ctx;

  app.get('/ws', { websocket: true }, (socket: RawWebSocket) => {
    const client = hub.attachDashboard(socket);
    socket.on('close', () => hub.detachDashboard(client));
    socket.on('error', () => hub.detachDashboard(client));
    // The dashboard channel is push-only. Anything it sends is ignored rather
    // than parsed, so there is no command surface here to get wrong.
    socket.on('message', () => {});
  });

  app.get('/ws/collector', { websocket: true }, (socket: RawWebSocket) => {
    const client = hub.attachCollector(socket);

    socket.on('close', () => hub.detachCollector(client));
    socket.on('error', () => hub.detachCollector(client));

    socket.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : String(data);
      if (text.length > config.maxRequestBytes) {
        socket.close(1009, 'message too large');
        return;
      }
      const message = parseCollectorMessage(text);
      if (message === null) return;

      try {
        switch (message.type) {
          case 'hello': {
            const identity = parseIdentity(message.identity);
            if (identity) hub.identifyCollector(client, identity);
            break;
          }
          case 'ingest': {
            const validated = validateIngestBatch(message.batch, config);
            if (!validated.ok) {
              socket.send(JSON.stringify({ type: 'ingest-result', result: { ok: false, accepted: 0, duplicates: 0, rejected: 0, errors: validated.errors } }));
              return;
            }
            hub.identifyCollector(client, validated.batch.identity);
            // Same authority rule as the HTTP path: the server's adapters win.
            reclassify(validated.batch);
            const stored = db.insertCaptures(validated.batch, Date.now());
            for (const capture of stored.accepted) ctx.refs.observe(capture);
            normalizeAccepted(ctx, stored.accepted);
            hub.broadcastCaptures(stored.accepted);
            socket.send(JSON.stringify({ type: 'ingest-result', result: toIngestResult(stored) }));
            break;
          }
          case 'frames': {
            const report = validateFrameReport(message.report);
            if (report === null) return;
            db.insertFrames(report, Date.now());
            hub.broadcastFrames(report);
            break;
          }
          case 'pong':
            break;
        }
      } catch (err) {
        // A malformed message must never take the socket - or the server - down.
        app.log.error({ err }, 'collector websocket message failed');
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Static dashboard
 * ------------------------------------------------------------------ */

function registerDashboard(app: FastifyInstance, ctx: ServerContext): void {
  const dir = ctx.config.dashboardDir;
  const built = existsSync(resolve(dir, 'index.html'));

  if (built) {
    void app.register(fastifyStatic, { root: dir, index: ['index.html'], wildcard: false });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const path = pathOf(request);
    if (path.startsWith('/api/') || path.startsWith('/ws')) {
      await reply.code(404).send({ ok: false, error: `No route for ${request.method} ${path}` });
      return;
    }
    if (!built) {
      await reply.code(404).type('text/plain; charset=utf-8').send(
        `Betby Scout server is running, but the dashboard has not been built.\n\n` +
          `Run:  npm run build:dashboard\n` +
          `Expected files in: ${dir}\n\n` +
          `The API is available at /api/health.\n`,
      );
      return;
    }
    // A request for something that looks like a FILE must 404 as a file.
    //
    // Falling back to index.html for these is actively misleading: after a
    // rebuild the asset hashes change, and a browser holding the old page asks
    // for a bundle that no longer exists. Serving HTML in its place makes the
    // browser report "Expected a JavaScript module but got text/html", which
    // sends you looking for a syntax error that is not there. The real answer -
    // that file is gone, reload - is what a 404 says.
    if (/\.[a-z0-9]{2,8}$/i.test(path)) {
      await reply.code(404).type('text/plain; charset=utf-8').send(
        `${path} does not exist in this dashboard build.\n\n` +
          `If the page was open across a rebuild, its asset hashes changed - reload.\n`,
      );
      return;
    }

    // SPA fallback: client-side routes are not files on disk.
    await reply.sendFile('index.html');
  });
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function start(): Promise<FastifyInstance> {
  const config = loadConfig();
  const db = openDb(config.dbPath, { maxBodyBytes: config.maxBodyBytes });
  const app = await buildServer({ config, db });

  for (const warning of [...config.warnings, ...db.migration.warnings]) {
    app.log.warn(warning);
  }

  if (config.retentionDays > 0) {
    const pruned = db.pruneCaptures(config.retentionDays, Date.now());
    if (pruned.deleted > 0) {
      app.log.warn(
        `Retention: deleted ${pruned.deleted} captures older than ${config.retentionDays} days (before ${new Date(pruned.cutoff).toISOString()}).`,
      );
    }
  }

  await app.listen({ host: config.host, port: config.port });

  const base = `http://${config.host}:${config.port}`;
  const dashboardBuilt = existsSync(resolve(config.dashboardDir, 'index.html'));
  app.log.info(
    [
      '',
      '  Betby Scout server',
      `  dashboard   ${base}${dashboardBuilt ? '' : '   (not built yet - run: npm run build:dashboard)'}`,
      `  api         ${base}/api/health`,
      `  collector   ${base}/api/ingest   (accepts cross-origin POSTs from the page)`,
      `  database    ${db.path}`,
      `  schema      v${db.schemaVersion} from ${db.migration.schemaPath}`,
      `  retention   ${config.retentionDays === 0 ? 'keep forever' : `${config.retentionDays} days`}`,
      '',
      '  Read routes answer localhost origins only. This tool never places a bet.',
      '',
    ].join('\n'),
  );

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    // Order matters: stop accepting, then close sockets, then close the db so
    // no statement runs against a closed handle.
    void app
      .close()
      .catch((err: unknown) => app.log.error({ err }, 'error while closing the server'))
      .finally(() => {
        ctxSafeStop(app);
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return app;
}

function ctxSafeStop(app: FastifyInstance & { scout?: ServerContext }): void {
  try {
    app.scout?.hub.stop();
  } catch {
    /* nothing useful to do while exiting */
  }
  try {
    app.scout?.db.close();
  } catch {
    /* nothing useful to do while exiting */
  }
}

/**
 * Only start when executed directly. Importing this module (tests do) must not
 * open a port - see the environment rule about long-lived processes.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  start().catch((err: unknown) => {
    console.error('Betby Scout server failed to start:', err);
    process.exit(1);
  });
}
