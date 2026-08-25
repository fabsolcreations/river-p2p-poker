#!/usr/bin/env node
// One process for the whole deploy, so the values in .env.deploy are in
// scope for the BUILD as well as the checks. Running preflight and build as
// separate npm scripts silently doesn't work: the build reads
// CF_D1_DATABASE_ID out of process.env when it generates
// dist/server/wrangler.json, and a sibling process's environment isn't
// inherited - you'd get a green preflight and a Worker bound to the
// placeholder database.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WRANGLER_BIN = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");

if (existsSync(".env.deploy")) {
  for (const line of readFileSync(".env.deploy", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

function run(file, args) {
  execFileSync(file, args, { stdio: "inherit", env: process.env });
}

console.log("→ preflight");
run(process.execPath, ["tools/deploy/preflight.mjs"]);

console.log("\n→ build");
// Plain path on purpose: vinext's package.json "exports" doesn't expose its
// CLI (or even its own package.json), so require.resolve can't reach it.
const vinextCli = join("node_modules", "vinext", "dist", "cli.js");
if (!existsSync(vinextCli)) {
  console.error(`Can't find vinext CLI at ${vinextCli} - run npm install.`);
  process.exit(1);
}
run(process.execPath, [vinextCli, "build"]);

// Guard against shipping a Worker pointed at a database that doesn't exist -
// cheap to check, and the failure mode otherwise only appears at runtime.
const generated = JSON.parse(readFileSync("dist/server/wrangler.json", "utf8"));
const bound = generated.d1_databases?.[0]?.database_id;
if (bound !== process.env.CF_D1_DATABASE_ID) {
  console.error(
    `\nBuilt Worker is bound to D1 id ${bound}, expected ${process.env.CF_D1_DATABASE_ID}.\nRefusing to deploy.`,
  );
  process.exit(1);
}

console.log("\n→ deploy");
run(process.execPath, [WRANGLER_BIN, "deploy", "-c", "dist/server/wrangler.json"]);
