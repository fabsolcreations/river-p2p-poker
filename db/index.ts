import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

// Same pattern as examples/d1/app/api/notes/route.ts - the most common
// early failure is querying before migrations have been applied locally.
export function friendlyDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;
  if (combined.includes("no such table")) {
    return "The database schema isn't set up yet. Run `npm run db:generate`, then apply the generated SQL to the local D1 database.";
  }
  return message;
}
