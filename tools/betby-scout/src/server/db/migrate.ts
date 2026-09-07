/**
 * Schema application.
 *
 * `schema.sql` is written to be idempotent (every statement is CREATE ... IF NOT
 * EXISTS), so "migrating" is just applying it again on every boot. That is the
 * whole strategy at Milestone 1: there is no user data worth a migration ladder
 * yet, and a ladder we never exercise is a ladder that is broken when we finally
 * need it.
 *
 * Two things here are less obvious than they look:
 *
 * 1. **The PRAGMAs are stripped out and applied separately.** `sqlite3_exec()`
 *    runs a whole script, and `PRAGMA journal_mode = WAL` is a statement that
 *    *returns a row*. Depending on the binding that is either fine or an error,
 *    and "sometimes fine" is not a property we want in the boot path. Applying
 *    them one at a time through `prepare().get()` also lets us read back what
 *    SQLite actually did - asking for WAL and getting `delete` (which happens on
 *    network filesystems) is worth knowing about rather than assuming.
 *
 * 2. **`schema.sql` is found by search, not by a fixed relative path.** tsc does
 *    not copy .sql files into `dist/`, so the built server has to reach back
 *    into `src/`. Rather than hard-coding one guess, we try the candidates in
 *    order and report every path we looked at if none of them exist.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { hash64 } from '../../shared/ids.ts';
import { PROTOCOL_VERSION } from '../../shared/types.ts';

/**
 * Bumped whenever schema.sql changes in a way that existing rows care about.
 * Recorded in `meta` so /api/health can report it and a future migration can
 * tell what it is looking at.
 */
export const SCHEMA_VERSION = 1;

export const META_SCHEMA_VERSION = 'schema_version';
export const META_SCHEMA_HASH = 'schema_sql_hash';
export const META_CREATED_AT = 'created_at';
export const META_PROTOCOL_VERSION = 'protocol_version';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every place schema.sql could legitimately be, in the order we try them. */
function schemaCandidates(): string[] {
  const candidates = [
    // Running from source (node --experimental-strip-types) or a build that
    // copied the asset next to the emitted JS.
    join(HERE, 'schema.sql'),
  ];
  // Built layout: dist/server/db/migrate.js -> walk up looking for the source
  // tree. Six levels is far more than the real depth; it costs one stat each.
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, 'src', 'server', 'db', 'schema.sql'));
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

export interface SchemaSource {
  path: string;
  sql: string;
}

export function readSchemaSql(): SchemaSource {
  const tried = schemaCandidates();
  for (const path of tried) {
    if (existsSync(path)) return { path, sql: readFileSync(path, 'utf8') };
  }
  throw new Error(
    `Could not find schema.sql. Looked in:\n  ${tried.join('\n  ')}\n` +
      'The server cannot create its database without it.',
  );
}

/**
 * Splits the PRAGMA statements out of a script. Returns the remaining SQL plus
 * the pragma bodies, so the caller can apply them through a prepared statement
 * where a returned row is expected rather than surprising.
 */
export function splitPragmas(sql: string): { pragmas: string[]; body: string } {
  const pragmas: string[] = [];
  const body = sql.replace(/^[ \t]*PRAGMA[^;]*;[ \t]*$/gim, (match) => {
    pragmas.push(match.trim().replace(/;$/, ''));
    return '';
  });
  return { pragmas, body };
}

export interface PragmaOutcome {
  pragma: string;
  /** What SQLite reported back, when the pragma returns a value. */
  result: string | null;
  /** Set when the pragma could not be applied. Never fatal on its own. */
  error: string | null;
}

/**
 * Applies one pragma and reads back whatever it returns.
 *
 * Pragmas are best-effort by design: WAL is impossible on some filesystems and
 * meaningless for an in-memory database, and neither case should stop a local
 * analytics tool from starting. The outcome is returned so the caller can log
 * the difference between "asked for WAL, got WAL" and "asked for WAL, got
 * delete".
 */
export function applyPragma(db: DatabaseSync, pragma: string): PragmaOutcome {
  try {
    const row = db.prepare(pragma).get();
    if (row === undefined) return { pragma, result: null, error: null };
    const first = Object.values(row)[0];
    return { pragma, result: first === undefined || first === null ? null : String(first), error: null };
  } catch (err) {
    // Some pragmas cannot be prepared as statements in every SQLite build; fall
    // back to exec() before giving up.
    try {
      db.exec(pragma);
      return { pragma, result: null, error: null };
    } catch {
      return { pragma, result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export interface MigrationReport {
  schemaVersion: number;
  schemaPath: string;
  /** True when this file had no tables before we ran. */
  freshDatabase: boolean;
  pragmas: PragmaOutcome[];
  /** Non-fatal notes, e.g. a pragma that did not take effect. */
  warnings: string[];
}

function getMetaValue(db: DatabaseSync, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    const value = row?.['value'];
    return typeof value === 'string' ? value : null;
  } catch {
    // `meta` does not exist yet on a fresh database.
    return null;
  }
}

function setMetaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/**
 * Applies pragmas and the schema, and records the schema version. Safe to call
 * on every boot.
 */
export function migrate(db: DatabaseSync, opts?: { busyTimeoutMs?: number }): MigrationReport {
  const warnings: string[] = [];
  const source = readSchemaSql();
  const { pragmas: schemaPragmas, body } = splitPragmas(source.sql);

  const freshDatabase =
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()?.['n'] === 0;

  // Order matters: journal_mode and foreign_keys must be set before any DDL
  // runs, and busy_timeout before anything that could contend.
  const wanted = [
    'PRAGMA journal_mode = WAL',
    'PRAGMA foreign_keys = ON',
    `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(opts?.busyTimeoutMs ?? 5000))}`,
    // Durable enough for an append-only local capture log, and materially
    // faster than FULL when a busy live feed is flushing every 1.5s.
    'PRAGMA synchronous = NORMAL',
    ...schemaPragmas.filter((p) => !/journal_mode|foreign_keys/i.test(p)),
  ];

  const outcomes = wanted.map((p) => applyPragma(db, p));
  for (const outcome of outcomes) {
    if (outcome.error) warnings.push(`${outcome.pragma} failed: ${outcome.error}`);
  }
  const journal = outcomes.find((o) => /journal_mode/i.test(o.pragma));
  if (journal && journal.result && journal.result.toLowerCase() !== 'wal') {
    warnings.push(
      `Asked for WAL journal mode, SQLite reports "${journal.result}". Concurrent readers may block writers.`,
    );
  }
  const fk = db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'];
  if (fk !== 1 && fk !== 1n) {
    warnings.push('foreign_keys is not enabled; referential integrity is not being enforced.');
  }

  db.exec(body);

  const now = Date.now();
  const sqlHash = hash64(source.sql);
  const previousHash = getMetaValue(db, META_SCHEMA_HASH);
  if (previousHash !== null && previousHash !== sqlHash) {
    // Not an error - schema.sql is all IF NOT EXISTS, so re-running it is safe -
    // but a changed schema against an existing file is worth saying out loud,
    // because CREATE TABLE IF NOT EXISTS will not alter a table that is already
    // there.
    warnings.push(
      'schema.sql has changed since this database was created. New tables and indexes were added; existing tables were left as they are.',
    );
  }

  setMetaValue(db, META_SCHEMA_VERSION, String(SCHEMA_VERSION));
  setMetaValue(db, META_SCHEMA_HASH, sqlHash);
  setMetaValue(db, META_PROTOCOL_VERSION, String(PROTOCOL_VERSION));
  if (getMetaValue(db, META_CREATED_AT) === null) setMetaValue(db, META_CREATED_AT, String(now));

  ensureAddedColumns(db);

  return {
    schemaVersion: SCHEMA_VERSION,
    schemaPath: source.path,
    freshDatabase,
    pragmas: outcomes,
    warnings,
  };
}


/**
 * Columns added after the first release.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, which does nothing to a table
 * that already exists - so a new column has to be ALTERed in for databases
 * created before it. Guarded by table_info so it is safe to run every boot.
 */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'events', column: 'country', ddl: 'ALTER TABLE events ADD COLUMN country TEXT' },
];

export function ensureAddedColumns(db: DatabaseSync): string[] {
  const applied: string[] = [];
  for (const entry of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${entry.table})`).all() as Array<{ name?: unknown }>;
    if (columns.length === 0) continue; // table not created yet; schema.sql owns it
    if (columns.some((c) => c.name === entry.column)) continue;
    db.exec(entry.ddl);
    applied.push(`${entry.table}.${entry.column}`);
  }
  return applied;
}
