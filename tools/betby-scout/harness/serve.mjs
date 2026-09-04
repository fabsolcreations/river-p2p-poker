#!/usr/bin/env node
/**
 * Collector harness server.
 *
 * Serves a local page that loads the real built collector and fires traffic at
 * it, so the whole capture path - hook, ring, classifier, redactor, uploader,
 * server, dashboard - can be exercised without opening a sportsbook.
 *
 * This is a development tool, not part of the product. It earned its place by
 * catching four integration bugs that every unit test passed straight through:
 * a websocket envelope mismatch that silently dropped every upload, an
 * unconfirmed-ack loop, and the hook calling the wrong classifier entry point
 * so that live traffic came back "not JSON" while the stored body was fine.
 *
 *   node harness/serve.mjs      then open http://127.0.0.1:8790
 *
 * Run `npm run build:collector` first - the page loads dist/collector/hook.js.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = import.meta.dirname;
const HOOK = resolve(ROOT, '..', 'dist', 'collector', 'hook.js');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

if (!existsSync(HOOK)) {
  console.error(`Missing ${HOOK}\nRun: npm run build:collector`);
  process.exit(1);
}

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // Served straight from dist so the harness always exercises the current
  // build - a stale copy here would test code that no longer exists.
  if (path === '/hook.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(HOOK));
    return;
  }

  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(8790, '127.0.0.1', () => console.log('harness   http://127.0.0.1:8790'));

// Something for the WebSocket hook to observe. Replies with a text frame and a
// binary one, because the binary path is the easiest to get wrong.
const wss = new WebSocketServer({ port: 8791, host: '127.0.0.1' });
wss.on('connection', (socket) => {
  socket.on('message', () => {
    socket.send(JSON.stringify({ type: 'odds', id: 'sel-1', price: 9.6, ts: Date.now() }));
    socket.send(Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]));
  });
});
console.log('ws echo   ws://127.0.0.1:8791');
