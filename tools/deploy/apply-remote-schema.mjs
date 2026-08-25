#!/usr/bin/env node
// Applies the drizzle migrations in drizzle/ to a REAL (remote) D1 database,
// in journal order, tracking what's already been applied in a
// `_river_migrations` table so re-running is safe.
//
// Why not `wrangler d1 migrations apply`: this project generates its schema
// with drizzle-kit, whose journal (drizzle/meta/_journal.json) is its own
// format - wrangler keeps its own separate bookkeeping table and expects to
// own the directory. Running both against one database gives you two
// disagreeing records of what's applied. Reading drizzle's journal directly
// keeps a single source of truth, and matches how the local database is
// already brought up to date.
//
// Usage: node tools/deploy/apply-remote-schema.mjs [--local]

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// Invoke wrangler's JS entry with the current node binary. Going through npx
// means a .cmd shim on Windows, which execFileSync can only reach via a
// shell - and passing args through a shell is exactly what DEP0190 warns
// about. This avoids the shell entirely and works the same on every OS.
const WRANGLER_BIN = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// There's no wrangler config at the project root (the deployable one is
// generated into dist/server at build time), so wrangler can't resolve a
// binding name here - it needs the database's actual name.
if (existsSync(".env.deploy")) {
  for (const line of readFileSync(".env.deploy", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const BINDING = process.env.CF_D1_DATABASE_NAME;
if (!BINDING) {
  console.error("CF_D1_DATABASE_NAME is not set (see .env.deploy.example).");
  process.exit(1);
}
const remote = !process.argv.includes("--local");
const scope = remote ? "--remote" : "--local";

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function execSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "river-d1-"));
  const file = join(dir, "stmt.sql");
  writeFileSync(file, sql, "utf8");
  return wrangler(["d1", "execute", BINDING, scope, "--yes", "--file", file]);
}

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

execSql("CREATE TABLE IF NOT EXISTS _river_migrations (tag TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");

let applied = new Set();
try {
  const out = wrangler([
    "d1",
    "execute",
    BINDING,
    scope,
    "--yes",
    "--json",
    "--command",
    "SELECT tag FROM _river_migrations;",
  ]);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  for (const block of parsed) for (const row of block.results ?? []) applied.add(row.tag);
} catch {
  // First run against a fresh database - nothing applied yet.
}

let count = 0;
for (const entry of entries) {
  if (applied.has(entry.tag)) {
    console.log(`skip  ${entry.tag} (already applied)`);
    continue;
  }
  const sql = readFileSync(`drizzle/${entry.tag}.sql`, "utf8");
  // drizzle marks statement boundaries explicitly; D1 rejects a multi-statement
  // string on some paths, so split and send them one at a time.
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`apply ${entry.tag} (${statements.length} statement${statements.length === 1 ? "" : "s"})`);
  for (const statement of statements) execSql(statement);
  execSql(
    `INSERT INTO _river_migrations (tag, applied_at) VALUES ('${entry.tag}', datetime('now'));`,
  );
  count += 1;
}

console.log(count === 0 ? "Schema already up to date." : `Applied ${count} migration(s) to ${remote ? "remote" : "local"} D1.`);
