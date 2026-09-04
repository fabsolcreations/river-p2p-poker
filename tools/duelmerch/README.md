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

## Garment mockups -- how they are lit

The SVGs are flat-lays, but they have to read as products, not technical drawings.
Four things do that work, in `garmentShading()` and each garment function:

1. **One shared light source.** The gradients use `gradientUnits="userSpaceOnUse"`
   spanning the whole 400x460 viewBox. This matters: with the default
   objectBoundingBox, every path gets its OWN gradient across its OWN bbox, so a
   narrow sleeve compresses the full light-to-dark ramp into its width and reads as
   a cutout pasted onto the torso. Every garment part must share one light.
2. **Fabric weave** -- a 3px `<pattern>` of fine diagonal lines at ~.03 opacity.
   Deliberately NOT `feTurbulence`: 15 of these render per page and turbulence is far
   too expensive on mobile. Keep the opacity low; at .055 it read as diagonal stripes,
   worst on navy.
3. **Topstitching** -- dashed strokes (`stroke-dasharray="3.5 3"`) at hems, cuffs,
   collar, pocket and hood edge. This is the single detail that most says "real
   garment" rather than "icon".
4. **Contact shadow** under the garment.

Verify changes by rasterising, never by eyeballing the code -- scratchpad
`render.mjs` brace-matches the garment functions out of index.html, renders them
with resvg and writes a side-by-side contact sheet. Gradients and patterns are
correct on product art; the no-gradient rule from the reskin applies to UI chrome only.

## Shareable product links

Every design has its own URL: `duelmerch.org/?p=<product-id>`. Opening a card
pushes that URL, closing clears it, and the back button closes the modal instead of
leaving the site. Landing on one opens straight into that product. There is a
"Copy link" button next to "Want this made".

This exists because the audience shares things by pasting a URL into Discord, and
until now there was no way to link a single design.

`functions/_middleware.js` rewrites `og:title`/`og:description`/`og:url` and
`<title>` per product so the paste unfurls with the design's real name. Names come
from `CATALOG` — one source of truth, never duplicate them in the middleware.

Two traps, both of which cost a deploy:

- **HTMLRewriter handler objects must not carry non-function fields named
  `element`, `text` or `comments`.** The first version stored the title on
  `this.text`; HTMLRewriter read that as a text-node callback, got a string, and
  threw `Incorrect type for the 'text' field` — a hard 500 on the whole page.
- **Do not pre-escape attribute values.** HTMLRewriter escapes what you pass to
  `setAttribute`; escaping first double-encodes it.

The rewrite is wrapped in try/catch and falls through to the unmodified page, with
the reason in an `x-og-rewrite` response header. Nicer social cards are never worth
taking the site down for. Check it with a cache-buster — Cloudflare caches these:

```bash
curl -s "https://duelmerch.org/?p=lousy-tee&cb=$RANDOM" | grep -o "<title>[^<]*</title>"
```

## The post-payment page

`functions/api/checkout.js` sends buyers to `${origin}/thanks?order=<id>` after payment.
That page did not exist until 2026-08-30 -- anyone who paid would have hit a 404 the
moment `SELLING` was flipped on. It exists now at `public/thanks.html` (Pages serves it
at `/thanks`). It renders the order reference from the query string, gated behind a
`^[A-Za-z0-9_-]{1,64}$` test so nothing can be injected through the URL.

It has to state the awkward parts, because they are true: crypto payments are final,
and since we deliberately store no buyer PII we genuinely cannot look an order up --
the reference is the only handle the buyer has. If you change the privacy model, change
this page too.

Check it after any change to the money path:

```bash
curl -o /dev/null -w "%{http_code}
" "https://duelmerch.org/thanks?order=TEST"
```

## Product depth: size charts and provenance

Each concept opens a real product page, not a thumbnail. Two things carry it:

**Size guide.** `SIZE_CHARTS` holds real garment measurements, pulled from
Printful's PUBLIC size endpoint -- no API key needed:

```bash
curl "https://api.printful.com/products/71/sizes?unit=inches"
```

71 = Bella + Canvas 3001, 146 = Gildan 18500, 1419 / 1482 = the all-over-print
blanks. Regenerate with scratchpad `sizes.mjs`. **Never hand-type these** -- the
only reason a size chart is worth having is that it is accurate.

Two traps: the AOP tables label columns `A`/`B`/`C` (= width / length / sleeve),
and the site sizes apparel `S-XXL` while Printful keys the same row `2XL`. Without
the alias in `renderSizeChart`, the largest size silently disappears from every
chart. The chart is looked up from the `Blank -- ...` line in a product's `meta`,
so it follows the garment automatically if a blank changes.

**Provenance.** A product may carry `from:{name,date}` pointing at a row in
`RECEIPTS`; the modal then shows the actual message that spawned the design. This
is the one thing a competitor structurally cannot copy -- it needs the community
history. **Only link a receipt whose message genuinely matches the design.** The
On The Team Tee was nearly linked to Plank's receipt, but his only quote on the
wall is about the store not shipping, not the line printed on that tee -- so it
has no link. Misattributing a real person's words would undermine the entire
premise of the receipts wall.

## Watch out: the modal controls are delegated

Size buttons, colour swatches and the Lousy Tee's amount presets have no inline
handlers -- one delegated listener on `#modal` drives all three, plus
`[data-close-modal]`. All three were found completely dead in 2026-08-30 (clicking
a size did nothing; the Lousy Tee could not change its number, which is that
product's whole gimmick). If you restructure the modal, click every control
afterwards -- a missing handler here is invisible in the markup and throws no error.

## Writing rules -- read before touching any copy

The site was called "AI generated" three times. The third time it was the prose, not
the design. Rules that came out of fixing it:

- **No tricolons.** If you write "no X, no Y, no Z", cut it to two. There were four
  of these on the page at once and it was the loudest tell on the site.
- **Not every sentence gets to land.** Product blurbs must contain at least one
  sentence that is only information -- a blank, a weight, a print size. Fact, fact,
  joke is fine. Joke, joke, joke is what a generator writes.
- **Never reuse a frame across products.** Four blurbs opened "The only piece here
  that..." and three closed on "Wear the <noun>." Humans repeat themselves messily;
  models repeat structure.
- **No winks.** "because of course it is", "Different management.", "let natural
  selection do its thing" -- all cut.
- **No antithesis taglines.** "gamble responsibly, dress irresponsibly" became "18+."
- **Audience vocabulary only.** "immortalised" and "the philosophy, immortalized on
  heavyweight fleece" are not words anyone in that Discord types.
- **Cutting beats rewriting.** The fix removed 218 words and added almost none.

The same applies to CSS: no numbered section eyebrows with tracked-out uppercase and a
trailing hairline, no `letter-spacing` under 1.5px, no half-pixel font sizes.

## The wall is a ranking

Concepts are ordered by votes, highest first, with the authored order in `PRODUCTS`
breaking ties. That means a wall with no votes looks exactly as written, and popular
designs rise on their own. `sortWall(counts)` does it; the tally request is started
BEFORE the grid renders so the reorder lands while the wall is still below the hero.

Three things to keep true if you touch this:

- **`card-no` is a position, not an identity.** Cards show 01-15; after any sort
  `renumberWall()` must run or the numbers read 05, 12, 01. Never derive it from
  the product index.
- **Voting must not re-sort.** `bumpCount()` updates the number in place and
  deliberately leaves the order alone -- re-sorting on click yanks the wall out from
  under the person who just clicked. The order settles on the next load.
- **The wall must render without the tally.** The grid is written synchronously and
  sorted later; if `/api/want` fails, `wantCounts` resolves null and the wall simply
  stays in authored order. `sortWall(null)` is a no-op by design. Never make the
  first paint depend on the tally.

One request serves both the sort and the counts -- don't add a second `fetch`.

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
