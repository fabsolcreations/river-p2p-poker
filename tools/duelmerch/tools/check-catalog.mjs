/**
 * Every product on the wall must exist in the server catalog.
 *
 * The page's PRODUCTS array drives what renders; shared/catalog.mjs is what
 * the server will actually accept. When an id is in the first and not the
 * second, the card looks completely normal and its primary button - "Want
 * this made" - fails with "Unknown item." Nothing about the page hints at
 * it, so this check exists to catch the mismatch instead of a customer.
 */
import { readFileSync } from "node:fs";
import { CATALOG } from "../shared/catalog.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = html.slice(html.indexOf("const PRODUCTS = ["));
const onWall = [...block.matchAll(/^\s{4}id:\s*"([^"]+)"/gm)].map((m) => m[1]);

if (onWall.length === 0) {
  console.error("FAIL  found no product ids - the PRODUCTS shape must have changed.");
  process.exit(1);
}

const missing = onWall.filter((id) => !CATALOG[id]);
const orphaned = Object.keys(CATALOG).filter((id) => !onWall.includes(id));

for (const id of missing) console.error(`FAIL  ${id} is on the wall but not in CATALOG - "Want this made" returns Unknown item.`);
for (const id of orphaned) console.warn(`warn  ${id} is in CATALOG but not on the wall`);

console.log(`${onWall.length} products on the wall, ${Object.keys(CATALOG).length} in the catalog, ${missing.length} broken.`);
process.exit(missing.length ? 1 : 0);
