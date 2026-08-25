# DUELMERCH — duelmerch.org

The Duel community merch store. Live at **https://duelmerch.pages.dev**
(Cloudflare Pages project `duelmerch`), custom domain **duelmerch.org**.

```
duelmerch/
├─ public/            ← the site (static, no build step)
│  ├─ index.html      ← everything: styles, cart, checkout, product art (inline SVG)
│  ├─ thanks.html     ← post-payment page
│  ├─ 404.html        ← "this page is coming 2029"
│  ├─ og.png          ← Discord/Twitter embed card (1200x630)
│  ├─ pfp/            ← receipt-wall avatars (144x144 webp)
│  └─ print/          ← print files Printful fetches by URL
├─ functions/api/
│  ├─ checkout.js     ← prices cart, creates Printful draft + crypto invoice
│  ├─ ipn.js          ← verifies payment callback, releases the print job
│  ├─ quote.js        ← live shipping cost for a cart + destination
│  ├─ notify.js       ← waitlist capture
│  └─ submit.js       ← Drop 002 concept submissions
├─ shared/catalog.mjs ← prices, sizes, Printful variants, print files (server truth)
├─ print-files/       ← Drop 001 source artwork (300 DPI + editable SVG)
├─ drop-002/          ← concepts, not yet on the site
└─ wrangler.toml      ← Pages config + KV bindings
```


## Deploy / redeploy

From this folder (wrangler is installed in the repo root, login already stored):

```bash
npx wrangler pages deploy
```

That's it — uploads `public/`, bundles `functions/`, applies `wrangler.toml`.

## Reading the waitlist and submissions

> **Always pass `--remote`.** Wrangler v4 KV commands read and write a *local*
> store by default, so without it `list` prints `[]` even when real signups
> exist, and `delete` silently does nothing to the live data. Empty output
> without `--remote` means nothing.

**Waitlist** — the "get pinged when checkout opens" form POSTs to `/api/notify`,
storing one entry per unique email/Discord handle. Duplicates ignored, honeypot
field filters bots. Values: `{contact, type, at, country}`.

```bash
npx wrangler kv key list --namespace-id 507d8c3f915841b5934e887593be736a --remote
```

**Drop 002 submissions** — the "send it in" form POSTs to `/api/submit`, one
entry per submission keyed by timestamp (nothing overwrites). 4–280 characters.
Values: `{idea, handle, at, country}`.

```bash
npx wrangler kv key list --namespace-id 2d2f580b406845499c15dc7781092bd7 --remote
```

Read one entry with `kv key get "<name>" --namespace-id <id> --remote`. Both are
also browsable in the dash under Storage & Databases → KV, which always shows
the real remote data.

## Receipt avatars

Real profile pictures live in `public/pfp/*.webp` (144x144, ~3KB each, cropped
centre). A receipt uses one via an `img:"file.webp"` field in the `RECEIPTS`
array; without it the renderer falls back to a hand-drawn SVG in `AVATARS`, and
failing that a coloured initial.

To add or replace one: drop the image in `public/pfp/`, resize it
(144x144 webp keeps the page light - the originals were 1.1MB total, the webps
are 44KB), and add the `img:` field for that person. Sean is the only one on the
wall still without a real pfp. `wisdomjester.webp` is in the folder but unused -
he has no quote on the wall yet.

## Privacy model — DO NOT BREAK THIS

Plank raised (2026-08-22) that a fan store accumulating players' home addresses
is a problem, and that it's fine "if you set it up in a way that you don't
control player info and it goes direct to the supplier". So:

**No buyer PII is ever written to our storage.** At checkout the name, email and
address are validated, passed straight to Printful to create a *draft* order,
and then dropped. The only thing saved in the ORDERS KV is a receipt with no
person attached: order id, Printful order id, line items, totals, status.

If you ever add name/email/address to the `record` object in
`functions/api/checkout.js`, you have broken the promise the site makes to
buyers in the FAQ and under the shipping form. Don't.

**Honest limit:** the address does exist in the Printful account, because
Printful has to post the parcel. Whoever owns that Printful login can see
orders. If the intent is that darci genuinely cannot see buyer addresses, the
Printful account needs to be held by someone else — the site cannot enforce
that on its own.

## Colourways

Every product except the Duel Cow (white only, dark artwork) comes in **Black
and Navy**. Variants are keyed product -> colour -> size in
`shared/catalog.mjs`; `variantFor(id, size, color)` resolves them and falls back
to the first colour if one isn't given. The cart line carries `color`, the
modal shows swatches, and the garment SVG re-renders in that colour.

Navy was added because Duel's own direction is navy rather than black. To add
another colour: find its Printful variant ids (their catalog API is public — no
key needed), add them under the product, and list the colour in `colors` in both
`shared/catalog.mjs` and `public/index.html`, plus a hex in `COLORWAYS`.

## The monogram — all-over print

A tonal DM monogram, tiled. Tonal dark-on-dark **cannot be done with normal DTG**
(dark ink on dark fabric barely shows), so these use Printful's all-over-print
garments: printed edge to edge on a white base, so the "colour" is the artwork.

- Blanks: All-Over Print Unisex Cotton Hoodie (1419) and Oversized Cotton Tee
  (1482). Same variant ids for both colourways — only the file changes.
- Template sizes, from Printful's printfiles endpoint (needs auth):
  hoodie **6000x6000 @150dpi** for every panel; tee **5250x6750** body and
  **5250x3000** sleeves.
- Placements are `*_dtfabric` (front, back, sleeve_left, sleeve_right, hood,
  pocket) — see `AOP` in `shared/catalog.mjs`.
- Files are generated by scratchpad `monogram.mjs` + `gen-aop.mjs`; the same
  tile drives the on-site mockup via an SVG `<pattern>` fill.

Verified: a Navy L hoodie order was accepted by Printful with all six panels
`status: ok`.

## Shipping and print files

Shipping is **quoted live from Printful** per destination — there is no flat
rate. `POST /api/quote` returns the real cost before payment, and checkout
recomputes it server-side so the invoice always matches. An early flat $8 would
have lost money: three items to Chile is ~$20.

Print files live in `public/print/*.png` and Printful fetches them by URL when
building the order. Embroidery items (cap, beanie) must also declare
`thread_colors` from Printful's fixed palette — see `EMBROIDERY_OPTIONS`.

**The Lousy T-Shirt has fixed amounts**, not free text: $69 / $420 / $1,000 /
$4,000 / $10,000 / $100,000. Each is a separate pre-rendered print file, because
Printful only accepts jpg/png/pdf and a Worker can't rasterise text on the free
plan. Restoring arbitrary numbers needs a renderer (Cloudflare Browser Rendering
is paid) — until then, adding an amount means adding a `lousy-<amount>.png` and
listing it in `custom.amounts` in both `shared/catalog.mjs` and the page.

US, Canada and Australia require a **state/province code** or Printful rejects
the order; the form enforces this.

## If a payment succeeds but nothing prints

Almost always a stale IPN secret: NOWPayments signs each callback, and
regenerating the secret there without updating `ipn` in Cloudflare makes every
callback fail verification. The buyer pays, we reject the notification, and no
print job is released — it looks fine from their side.

The handler leaves a breadcrumb for exactly this:

```bash
npx wrangler kv key get "_ipn_rejected" --namespace-id c55dd3df4a304a9da408659c354dfaf1 --remote
npx wrangler kv key get "_ipn_ok"       --namespace-id c55dd3df4a304a9da408659c354dfaf1 --remote
```

`_ipn_rejected` present and recent = the secrets don't match, fix that first.
`_ipn_ok` present = callbacks are verifying properly.

Note the checkout sets `ipn_callback_url` on every invoice, so the Webhook URL
field in the NOWPayments dashboard is only a fallback. Keep webhook format on
**Classic way** — the signature check assumes it.

## Swapping the supplier

Duel already has the designs (a PDF of the full range) and a supplier — the
storefront was the missing piece. So fulfilment is deliberately pluggable:

- `shared/providers/printful.mjs` is the only file that knows a supplier exists.
- `shared/fulfillment.mjs` picks which one is active (one line).
- Everything else — cart, checkout, payments, privacy model, print files — is
  supplier-agnostic and does not change.

To move to Duel's supplier, write `shared/providers/<name>.mjs` exporting the
same five functions (`quoteShipping`, `createDraft`, `confirm`, `cancel`,
`configured`), then repoint `fulfillment.mjs`. Order records store
`supplier` + `supplier_id` rather than anything vendor-specific.

## Why the mockups have lighting

A competing Duel merch site (built by Jacob, seen 2026-08-23) beat this one on
one thing above all: **it used lit product renders, this used flat vector.** Flat
shapes read as technical drawings, not objects someone would own.

`garmentShading()` in `public/index.html` adds a diagonal light gradient, a soft
highlight pool and blurred fold lines over each garment body. Keep the white
stop low (~.085) or black garments wash out to grey — the point is a sheen, not
a lift. This is the one place gradients are correct; the no-gradient rule is
about UI chrome, not product art.

His other winning move was **spec tables** — Material / Thickness / Width, values
right-aligned. Product `meta` entries are now `"Key — value"` pairs and render as
`.spec-row`s in the detail panel. Keep that format when adding products.

## The interest tally

Every concept shows how many people hit "want this made", and the leader gets a
MOST WANTED badge. Painted on load from `GET /api/want`; failures are swallowed
so the tally can never block the page.

```bash
curl https://duelmerch.org/api/want          # current standings
```

Use it to decide what gets produced first. One vote per browser (localStorage),
no personal data stored — just a per-product counter.

## UX rules learned the hard way

- **Designs come first.** The receipts wall used to sit between the hero and the
  concepts; twelve Discord screenshots before any product is bad UX. Concepts
  now render first, receipts collapse to 4 with a "show all" toggle.
- **The primary action lives on the card**, not behind a modal. "Want this made"
  votes straight from the grid; the modal is for detail only.
- Cards are a numbered catalogue (01, 02, …) with a spec row (colourways, size
  range) rather than a plain shop tile — reads as a lookbook, not a template.

**This has now broken the page twice.** Both times the same way: markup was
deleted, the JavaScript that referenced it was left behind, `getElementById`
returned null, the script threw on load, and every handler defined *after* the
throw silently stopped working. The page still looked fine — products just
never rendered. Guard element writes (`const el = document.getElementById(id);
if (el) ...`) and **open the console after any structural change**, because the
served HTML can be perfectly correct while the page is dead.

**If you remove a UI block, remove its JavaScript too.** Deleting the cart
markup while leaving `document.getElementById("cartOpen").addEventListener(...)`
threw on load and silently killed every handler defined after it — voting and
the modal both stopped working while the page still looked fine. Check the
console after any structural change.

## It's a concept wall, not a shop

`SELLING = false` in `shared/catalog.mjs` is the master switch. While it's false,
`/api/checkout` refuses every request with "nothing is for sale yet" **no matter
what the client sends** — the cart UI is gone, but the gate is server-side so
the site cannot contradict itself.

Why: there's no confirmed production partner, so taking money would mean
charging for goods nobody is set up to ship. Instead each piece has a
**"want this made"** button -> `POST /api/want` -> a per-product tally in the
INTEREST namespace (no PII, one vote per browser).

```bash
npx wrangler kv key list --namespace-id 4b8d433b77bf4cd1bfd36a4d3431bb04 --remote
curl https://duelmerch.org/api/want          # current tally as JSON
```

Flip `SELLING` to true when a supplier is confirmed; the whole checkout,
shipping-quote and payment path is intact underneath and tested.

## Order flow

1. `POST /api/checkout` — prices the cart server-side (never trusts client
   prices), creates an unconfirmed Printful draft order carrying the address,
   saves the PII-free receipt, opens a NOWPayments invoice, returns its URL.
2. Buyer pays in crypto on the NOWPayments page.
3. `POST /api/ipn` — verifies NOWPayments' HMAC-SHA512 signature, and only then
   confirms the Printful order so it actually prints. Failed/expired payments
   delete the draft so nothing unpaid sits at the printer.
4. Printful prints, ships, and emails tracking directly to the buyer.

Secrets needed (set them in the Cloudflare dashboard, never in the repo):
`NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, `PRINTFUL_API_KEY`.

Until all three exist, checkout returns a clean "not switched on yet" message
and takes no money. Printful variant ids also need filling into
`shared/catalog.mjs` — unmapped items are refused rather than sold.

## Visual direction — keep it flat

The first build got called "ai slop"; a second pass got called it again. The
tells were **soft radial-gradient glows, gradient buttons with coloured halo
shadows, rainbow per-product tiles, floaty hover lifts and big pill radii**.
All removed 2026-08-22: flat panels, solid fills, one shared tile colour
(`#1b2038`), 4px corners, accent rules instead of glows, tighter spacing.

There are now **zero** gradients in the stylesheet. If you add one back, that is
the thing people recognise. Dense and utilitarian reads as real; soft and glowy
reads as generated.

## Positioning (don't undo this)

Duelmerch is an **independent fan project**. darci is not part of Duel — the
site must not imply staff status, insider access, or official endorsement. The
FAQ, footer disclaimer and manifesto all say so explicitly. Checkout will take
**crypto only** — no cards. Card processing would require business registration
and KYC the user does not want to do, and the audience pays in crypto anyway.
Do not add a card rail without asking.

## Personalised products (the Lousy T-Shirt)

`lousy-tee` carries a `custom:{label, def, amounts, presets}` field. Any product
with `custom` shows amount buttons in its modal and re-renders `art(amount)` on
click. The chosen number rides on the cart line (`amount`), so two different
amounts are two separate line items — and it is validated server-side against
`custom.amounts`, because each one maps to a real print file.

**This matters at fulfillment time:** the chosen amount selects which
pre-rendered print file goes to Printful. See "Shipping and print files" for why
it's a fixed set rather than free text.

## The "days waited" counter

Hero, stat chip and FAQ all show a live day count computed from `DAY_ZERO` in
`public/index.html` — set to **2025-12-09**, the date of the oldest "merch store"
promise we have a screenshot of (Ventful and DuelPounder, both on the receipts
wall). It updates itself, so no copy goes stale.

Duel is **not** three years old — earlier drafts said "three years," which came
from a member's hyperbole in chat, not reality. Don't reintroduce a duration
claim that isn't anchored to a receipt on the wall.

## Garment mockups — prints must fit the shirt

The card mockups draw the print on top of an SVG garment. Type that is wider
than the garment body visibly runs onto the sleeves, and eyeballing it does not
work — five prints shipped overflowing before this was measured, two of them
since Drop 001.

`tools/measure-prints.mjs` reports every print's rendered width and x-range.
The safe window is **x 130–270** on tees/hoodies/longsleeves (the torso is
120–280), **108–262** on the cap crown, **132–268** on the beanie cuff.

`tools/fit-prints.mjs` fixes them automatically: it measures each print and
wraps any that overflow in a scale-to-fit transform, centred in the garment.
Run it after adding or editing any print, then re-render to check:

```bash
node tools/measure-prints.mjs     # report
node tools/fit-prints.mjs         # rewrite index.html with fitted transforms
```

Note this only affects the on-site mockups. The real print files in
`print-files/` and `drop-002/` are separate artwork sized to the 12x16in print
area, and are unaffected.

## Editing products / receipts

- Products: the `PRODUCTS` array in `public/index.html` — name, price, sizes,
  copy, and which SVG mockup fn draws it (`hoodieSVG`, `teeSVG`, `capSVG`…).
- Receipts wall: the `RECEIPTS` array — name, date, message, optional stamp
  (`"WRONG."` red / `"DONE."` volt).
- Real product photos later: replace a product's `art()` SVG with an `<img>`;
  the cards don't care what's inside `.card-art`.
- Embed card: regenerate `public/og.png` if the messaging changes (any
  1200x630 PNG works).

## Local preview

Static preview via the `duelmerch` entry in `.claude/launch.json` (plain
`python -m http.server` on 5603 serving `public/` — no file watchers). The
`/api/notify` endpoint only exists on the deployed site, so the form shows
its "couldn't reach the list" fallback locally. No dev server needed.
