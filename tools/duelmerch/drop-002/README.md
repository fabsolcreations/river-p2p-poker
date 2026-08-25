# Drop 002 — concepts

Print-ready already: 3600x4800 (12x16in @300dpi), transparent, white/bright art
for **dark garments**. `.svg` twins are editable. Nothing here is on the site
yet — these are for picking, not shipping.

| File | The line | Who said it | Notes |
|---|---|---|---|
| `receipt-monarch.png` | "merch store coming 2029" | Monarch, 24/05/2026 | The receipts wall, worn. Full colour — the only non-plain-type piece |
| `on-the-team.png` | "bro thinks he's on the team" | Plank, about darci | Self-own. Reads better now that darci genuinely isn't on the team |
| `100-rtp.png` | "100% RTP" | the house line | The asterisk does the work: *not on my account |
| `no-one-receiving.png` | "no one is receiving their merch" | Rony | Printed on merch that arrived. That's the joke |
| `day-256.png` | 256 days of "any day now" | the counter | Dated edition — the number is fixed at print, like a newspaper |
| `cap-trademarked.png` | "TRADEMARKED?" | reggin asked | Embroidery, gold thread (#FFCC00), 5x2.5in |

## Read before printing the last one

`cap-trademarked` pokes directly at the thing Plank warned about — whether Duel
takes issue with the store. It's the funniest one here and the only one that
invites the question out loud. Your call, not mine; everything else is safe
self-deprecation aimed at the community, not the company.

`day-256` goes stale the day after it prints. That's intentional (it's a dated
edition) but it means re-rendering per drop — the number comes from `DAY_ZERO`
in the site, 2025-12-09.

## Adding one to the store

1. Copy the `.png` into `public/print/`.
2. Add the product to `PRODUCTS` in `public/index.html` (art, price, sizes, tile).
3. Add it to `CATALOG`, `PRINTFUL_VARIANTS` and `PRINT_FILES` in
   `shared/catalog.mjs` — unmapped products are refused at checkout.
