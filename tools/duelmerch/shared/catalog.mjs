// Server-side source of truth for what things cost.
// The browser sends ids/sizes/quantities only — never prices. Anything the
// client claims about money is ignored and recomputed here.
//
// PRIVACY RULE: nothing in this store persists a customer's name, email or
// address. Shipping details are passed straight through to the printer and
// are never written to our own storage. See functions/api/checkout.js.

// MASTER SWITCH. While false the store is a concept wall: checkout refuses to
// take money no matter what the client sends. Flip to true only when a supplier
// is confirmed and these can actually be produced and shipped.
export const SELLING = false;

export const APPAREL = ["S", "M", "L", "XL", "XXL"];
export const ONE_SIZE = ["ONE SIZE"];

export const CATALOG = {
  "gambling-easy-hoodie":   { name: "Gambling Is Easy Hoodie", price: 72, sizes: APPAREL, colors: ["Black","Navy"] },
  "duel-cow-tee":           { name: "Duel Cow Tee",            price: 34, sizes: APPAREL, colors: ["White"] },
  "coming-2029-tee":        { name: "Coming 2029 Tee",         price: 34, sizes: APPAREL, colors: ["Black","Navy"] },
  "ev-beanie":              { name: "+EV Beanie",              price: 28, sizes: ONE_SIZE, colors: ["Black","Navy"] },
  "lousy-tee":              { name: "Lousy T-Shirt",           price: 34, sizes: APPAREL, colors: ["Black","Navy"],
                              // fixed set: each one is a pre-made print file
                              custom: { amounts: [69, 420, 1000, 4000, 10000, 100000] } },
  // ---- Drop 002 ----
  "on-the-team-tee":        { name: "On The Team Tee",         price: 34, sizes: APPAREL, colors: ["Black","Navy"] },
  "rtp-hoodie":             { name: "100% RTP Hoodie",         price: 74, sizes: APPAREL, colors: ["Black","Navy"] },
  "trademarked-cap":        { name: "Trademarked? Cap",        price: 30, sizes: ONE_SIZE, colors: ["Black","Navy"] },

  // ---- Drop 003: all-over monogram. Colour comes from the PRINT, not the
  // blank — these garments are printed edge to edge on a white base.
  "monogram-hoodie":        { name: "Monogram Hoodie",         price: 128, sizes: APPAREL, colors: ["Black","Navy"] },
  "monogram-tee":           { name: "Monogram Tee",            price: 68,  sizes: APPAREL, colors: ["Black","Navy"] },

  // ---- Drop 004: placement variety (left chest, back, front) ----
  "chest-wordmark-tee":     { name: "Wordmark Tee",            price: 34, sizes: APPAREL, colors: ["Black","Navy"] },
  "dates-tee":              { name: "The Dates Tee",           price: 34, sizes: APPAREL, colors: ["Black","Navy"] },

  // Novelty concepts. No supplier mapping — Printful makes neither of these.
  "cow-body-pillow":        { name: "Duel Cow Body Pillow",   price: 88,    sizes: ONE_SIZE, colors: ["White"] },
  "duel-condoms":           { name: "Duel Dick Condoms",      price: 69.69, sizes: ONE_SIZE, colors: ["Navy"] },

  // Not actually for sale. It's a bit. Rejected at checkout on purpose.
  "the-entire-merch-store": { name: "The Entire Merch Store",  price: 1000000000, sizes: ONE_SIZE,
                              gag: "The Entire Merch Store isn't sold through checkout. DMs are open." },
};

// Printful catalog variant ids, filled in once the products exist in Printful.
// Keyed by product id -> size. Null means "not connected yet" and checkout
// refuses the order rather than taking money it can't fulfil.
export const PRINTFUL_VARIANTS = {
  // product -> colour -> size. Black and Navy across the range; the Duel Cow
  // runs on White only because its artwork is dark.
  "gambling-easy-hoodie":   { Black:{S:5530,M:5531,L:5532,XL:5533,XXL:5534}, Navy:{S:5594,M:5595,L:5596,XL:5597,XXL:5598} },
  "duel-cow-tee":           { White:{S:4011,M:4012,L:4013,XL:4014,XXL:4015} },
  "coming-2029-tee":        { Black:{S:4016,M:4017,L:4018,XL:4019,XXL:4020}, Navy:{S:4111,M:4112,L:4113,XL:4114,XXL:4115} },
  "ev-beanie":              { Black:{"ONE SIZE":8936}, Navy:{"ONE SIZE":8940} },
  "lousy-tee":              { Black:{S:4016,M:4017,L:4018,XL:4019,XXL:4020}, Navy:{S:4111,M:4112,L:4113,XL:4114,XXL:4115} },
  "on-the-team-tee":        { Black:{S:4016,M:4017,L:4018,XL:4019,XXL:4020}, Navy:{S:4111,M:4112,L:4113,XL:4114,XXL:4115} },
  "rtp-hoodie":             { Black:{S:5530,M:5531,L:5532,XL:5533,XXL:5534}, Navy:{S:5594,M:5595,L:5596,XL:5597,XXL:5598} },
  "trademarked-cap":        { Black:{"ONE SIZE":7854}, Navy:{"ONE SIZE":7857} },
  "chest-wordmark-tee":     { Black:{S:4016,M:4017,L:4018,XL:4019,XXL:4020}, Navy:{S:4111,M:4112,L:4113,XL:4114,XXL:4115} },
  "dates-tee":              { Black:{S:4016,M:4017,L:4018,XL:4019,XXL:4020}, Navy:{S:4111,M:4112,L:4113,XL:4114,XXL:4115} },
  "monogram-hoodie":        { Black:{S:33976,M:33977,L:33978,XL:33979,XXL:33980},
                              Navy: {S:33976,M:33977,L:33978,XL:33979,XXL:33980} },
  "monogram-tee":           { Black:{S:46408,M:46409,L:46410,XL:46411,XXL:46412},
                              Navy: {S:46408,M:46409,L:46410,XL:46411,XXL:46412} },
};

export function colorsFor(id) {
  return Object.keys(PRINTFUL_VARIANTS[id] || {});
}

// Rough wholesale (size L / one size) at time of writing, for margin sanity:
// hoodie $19.50 -> $72 | tee $10.75 -> $34 | longsleeve $18.25 -> $46
// cap $15.25 -> $30 | beanie $12.50 -> $28. Embroidery and extra placements
// cost more than the base figure, so treat these as a floor, not the real cost.

// Print files Printful fetches when building an order. Placement names are
// Printful's: omit `type` for the default front placement.
export const PRINT_FILES = {
  "gambling-easy-hoodie":   [{ url: "/print/gambling-is-easy.png" }],
  "duel-cow-tee":           [{ url: "/print/duel-cow.png" }],
  "coming-2029-tee":        [{ url: "/print/coming-2029.png" }],
  // embroidery placements must declare thread colours from Printful's palette
  "ev-beanie":              [{ type: "embroidery_front", url: "/print/beanie-ev.png" }],
  // lousy-tee picks its file from the chosen amount — see filesFor()
  "on-the-team-tee":        [{ url: "/print/on-the-team.png" }],
  "rtp-hoodie":             [{ url: "/print/100-rtp.png" }],
  "trademarked-cap":        [{ type: "embroidery_front", url: "/print/cap-trademarked.png" }],
  "chest-wordmark-tee":     [{ type: "front_large", url: "/print/chest-duelmerch.png" }],
  "dates-tee":              [{ type: "front_large", url: "/print/chest-dates.png" }],
};

// Printful's allowed embroidery threads, per product.
export const EMBROIDERY_OPTIONS = {
  "lore-cap":  [{ id: "thread_colors", value: ["#FFCC00"] }],           // gold LORE
  "ev-beanie": [{ id: "thread_colors", value: ["#E25C27"] }],           // orange +EV (plusev)
  "trademarked-cap": [{ id: "thread_colors", value: ["#FFCC00"] }],     // gold TRADEMARKED?
};

export function optionsFor(id, amount) {
  const opts = [...(EMBROIDERY_OPTIONS[id] || [])];
  return opts;
}

// All-over garments need one file per panel, and the colourway IS the file.
const AOP = {
  "monogram-hoodie": c => [
    { type:"front_dtfabric",        url:`/print/monogram-${c}-6000.png` },
    { type:"back_dtfabric",         url:`/print/monogram-${c}-6000.png` },
    { type:"sleeve_left_dtfabric",  url:`/print/monogram-${c}-6000.png` },
    { type:"sleeve_right_dtfabric", url:`/print/monogram-${c}-6000.png` },
    { type:"hood_dtfabric",         url:`/print/monogram-${c}-6000.png` },
    { type:"pocket_dtfabric",       url:`/print/monogram-${c}-6000.png` },
  ],
  "monogram-tee": c => [
    { type:"front_dtfabric",        url:`/print/monogram-${c}-tee.png` },
    { type:"back_dtfabric",         url:`/print/monogram-${c}-tee.png` },
    { type:"sleeve_left_dtfabric",  url:`/print/monogram-${c}-sleeve.png` },
    { type:"sleeve_right_dtfabric", url:`/print/monogram-${c}-sleeve.png` },
  ],
};

export function filesFor(id, origin, amount, color) {
  const aop = AOP[id];
  if (aop) return aop(String(color || "black").toLowerCase()).map(f => ({ ...f, url: `${origin}${f.url}` }));
  if (id === "lousy-tee") {
    return [{ url: `${origin}/print/lousy-${amount ?? 4000}.png` }];
  }
  return (PRINT_FILES[id] || []).map(f => ({ ...f, url: `${origin}${f.url}` }));
}

export function variantFor(id, size, color) {
  const byColor = PRINTFUL_VARIANTS[id];
  if (!byColor) return null;
  const chosen = color && byColor[color] ? byColor[color] : byColor[Object.keys(byColor)[0]];
  return chosen ? (chosen[size] ?? null) : null;
}

export const SHIPPING_USD = 0; // superseded by live Printful rates (see quote.js)
export const MAX_QTY_PER_LINE = 10;
export const MAX_LINES = 20;

/**
 * Validate a client cart and price it server-side.
 * Returns { ok:true, lines, subtotal, shipping, total } or { ok:false, error }.
 */
export function priceCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: "Your cart is empty." };
  }
  if (rawItems.length > MAX_LINES) {
    return { ok: false, error: "Too many separate items in one order." };
  }

  const lines = [];
  let subtotal = 0;

  for (const raw of rawItems) {
    const p = CATALOG[raw && raw.id];
    if (!p) return { ok: false, error: "That item doesn't exist." };
    if (p.gag) return { ok: false, error: p.gag };

    const size = String(raw.size || "");
    if (!p.sizes.includes(size)) return { ok: false, error: `Pick a valid size for ${p.name}.` };

    const palette = p.colors || colorsFor(raw.id);
    const color = raw.color && palette.includes(raw.color) ? raw.color : palette[0];
    if (!color) return { ok: false, error: `${p.name} has no colour available.` };

    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      return { ok: false, error: `Quantity for ${p.name} must be 1–${MAX_QTY_PER_LINE}.` };
    }

    let amount = null;
    if (p.custom) {
      amount = Math.floor(Number(raw.amount));
      if (!p.custom.amounts.includes(amount)) {
        return { ok: false, error: `Pick one of the printed amounts for the ${p.name}.` };
      }
    }

    const lineTotal = p.price * qty;
    subtotal += lineTotal;
    lines.push({ id: raw.id, name: p.name, size, color, qty, amount, unit: p.price, lineTotal });
  }

  const shipping = SHIPPING_USD; // placeholder; real rate comes from Printful
  return { ok: true, lines, subtotal, shipping, total: subtotal + shipping };
}
