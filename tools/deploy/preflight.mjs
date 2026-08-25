#!/usr/bin/env node
// Fails the deploy early on the mistakes that are expensive to discover in
// production. Runs before `wrangler deploy`.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// Invoke wrangler's JS entry with the current node binary. Going through npx
// means a .cmd shim on Windows, which execFileSync can only reach via a
// shell - and passing args through a shell is exactly what DEP0190 warns
// about. This avoids the shell entirely and works the same on every OS.
const WRANGLER_BIN = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env.deploy")) {
  for (const line of readFileSync(".env.deploy", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const PLACEHOLDER_D1 = "00000000-0000-4000-8000-000000000000";
const errors = [];
const warnings = [];

// 1. A real D1 database. The scaffold's placeholder id works locally
// (Miniflare ignores it) and binds to nothing in production, which shows up
// as every account/lobby/hand query failing at runtime rather than at deploy.
const d1Id = process.env.CF_D1_DATABASE_ID;
if (!d1Id || d1Id === PLACEHOLDER_D1) {
  errors.push(
    "CF_D1_DATABASE_ID is unset or still the placeholder.\n" +
      "    Create the database once with:  npm run cf:d1:create\n" +
      "    then put the printed database_id in .env.deploy (see .env.deploy.example).",
  );
}

// 2. Authenticated wrangler. Without this the deploy fails halfway, after
// the build, with a less obvious message.
try {
  execFileSync(process.execPath, [WRANGLER_BIN, "whoami"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch {
  errors.push("wrangler isn't logged in to a Cloudflare account.\n    Run:  npx wrangler login");
}

// 3. Money safety. This deploy target is a public site; shipping it wired to
// a live-value network is a different thing entirely from shipping test
// chips, and it should never happen as a side effect of a config default.
try {
  const chainConfig = readFileSync("worker/chain-config.ts", "utf8");
  const active = /export const ACTIVE_NETWORK: ChainKey = "([^"]+)"/.exec(chainConfig)?.[1];
  if (active && active !== "local") {
    warnings.push(
      `worker/chain-config.ts has ACTIVE_NETWORK="${active}" — this build can move real value.\n` +
        "    Confirm that's intended, and that the licensing question is actually settled, before deploying.",
    );
  }
} catch {
  // Config not readable - not worth failing the deploy over.
}

// 4. The well-known Hardhat test key must never become a production secret.
// It's public; anyone can sign with it.
const operatorKey = process.env.OPERATOR_PRIVATE_KEY ?? "";
if (operatorKey.toLowerCase().startsWith("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")) {
  errors.push(
    "OPERATOR_PRIVATE_KEY is Hardhat's well-known public test key.\n" +
      "    Never set this as a production secret - it is published in every Hardhat install.",
  );
}

for (const warning of warnings) console.warn(`WARNING: ${warning}\n`);
if (errors.length > 0) {
  console.error("Deploy preflight failed:\n");
  for (const error of errors) console.error(`  - ${error}\n`);
  process.exit(1);
}
console.log("Preflight OK.");
