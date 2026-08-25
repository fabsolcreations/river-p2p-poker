// POST /api/checkout
//
// PRIVACY MODEL — read before changing anything here.
// The buyer's name, email and address are NEVER written to our storage. They
// are passed straight to the printer (Printful) to create a draft order, and
// then dropped. What we keep is a receipt with no person attached to it:
// order id, printer's order id, what was ordered, and what it cost.
// If you add PII to the `record` object below, you have broken the promise
// the site makes to buyers. Don't.

import { priceCart, variantFor, SELLING } from "../../shared/catalog.mjs";
import { provider } from "../../shared/fulfillment.mjs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function cleanCustomer(c) {
  if (!c || typeof c !== "object") return { error: "Shipping details are missing." };
  const s = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
  const out = {
    email:   s(c.email, 200),
    name:    s(c.name, 120),
    address: s(c.address, 200),
    city:    s(c.city, 100),
    zip:     s(c.zip, 40),
    country_code: s(c.country_code, 2).toUpperCase(),
    state: s(c.state, 6).toUpperCase(),
    note:    s(c.note, 300),
  };
  if (!EMAIL_RE.test(out.email)) return { error: "We need a valid email to send tracking to." };
  for (const [k, label] of [["name","your name"],["address","a street address"],["city","a city"]]) {
    if (out[k].length < 2) return { error: `Add ${label}.` };
  }
  if (!/^[A-Z]{2}$/.test(out.country_code)) return { error: "Pick your country." };
  if (["US","CA","AU"].includes(out.country_code) && !/^[A-Z]{2,3}$/.test(out.state)) {
    return { error: "That country needs a state/province code, like TX or ON." };
  }
  return { value: out };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!SELLING) {
      return json({ ok: false, error: "These are concepts — nothing is for sale yet. Nothing was charged." }, 503);
    }
    const body = await request.json().catch(() => null);
    if (!body) return json({ ok: false, error: "Bad request." }, 400);
    if (body.website) return json({ ok: true, skipped: true }); // honeypot

    const priced = priceCart(body.items);
    if (!priced.ok) return json({ ok: false, error: priced.error }, 400);

    const customer = cleanCustomer(body.customer);
    if (customer.error) return json({ ok: false, error: customer.error }, 400);
    const c0 = customer.value;

    const NP_KEY = env.NOWPAYMENTS_API_KEY || env.nowpayments;
    if (!provider.configured(env) || !NP_KEY) {
      return json({ ok: false, error: "Checkout isn't switched on yet. Hold tight." }, 503);
    }

    // every line must map to a real printable variant, or we don't take money
    for (const l of priced.lines) {
      if (!variantFor(l.id, l.size, l.color)) {
        return json({ ok: false, error: `${l.name} (${l.color} / ${l.size}) isn't ready to print yet.` }, 409);
      }
    }

    // real shipping for this destination — a flat guess loses money
    const rate = await provider.quoteShipping(env, {
      lines: priced.lines,
      dest: { country_code: c0.country_code, state: c0.state, city: c0.city, zip: c0.zip },
    });
    if (!rate.ok) return json({ ok: false, error: "We can't ship to that address. Nothing was charged." }, 400);
    const shipping = rate.shipping;
    const grandTotal = Math.round((priced.subtotal + shipping) * 100) / 100;

    const orderId = `DM-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const origin = new URL(request.url).origin;
    const c = c0;

    // --- hand the address to the supplier; we keep no copy ---
    const draft = await provider.createDraft(env, {
      orderId, origin, lines: priced.lines,
      recipient: c,
    });
    if (!draft.ok) return json({ ok: false, error: draft.error }, 502);

    // --- the only thing we persist: no name, no email, no address ---
    const record = {
      order_id: orderId,
      supplier: provider.name,
      supplier_id: draft.supplierId,
      status: "awaiting_payment",
      created: new Date().toISOString(),
      lines: priced.lines.map(l => ({ id: l.id, size: l.size, color: l.color, qty: l.qty, amount: l.amount, unit: l.unit })),
      subtotal: priced.subtotal,
      shipping,
      total: grandTotal,
    };
    await env.ORDERS.put(orderId, JSON.stringify(record));

    const desc = priced.lines.map(l => `${l.qty}x ${l.name} [${l.color} ${l.size}]`).join(", ");
    const npRes = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: { "x-api-key": NP_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        price_amount: grandTotal,
        price_currency: "usd",
        order_id: orderId,
        order_description: `Duelmerch Drop 001 — ${desc}`.slice(0, 500),
        ipn_callback_url: `${origin}/api/ipn`,
        success_url: `${origin}/thanks?order=${orderId}`,
        cancel_url: `${origin}/#drop`,
      }),
    });
    const np = await npRes.json().catch(() => ({}));
    if (!npRes.ok || !np.invoice_url) {
      record.status = "invoice_failed";
      await env.ORDERS.put(orderId, JSON.stringify(record));
      return json({ ok: false, error: "Couldn't open the payment page. Try again in a minute." }, 502);
    }

    record.invoice_id = np.id;
    await env.ORDERS.put(orderId, JSON.stringify(record));
    return json({ ok: true, invoice_url: np.invoice_url, order_id: orderId, total: grandTotal });
  } catch (e) {
    return json({ ok: false, error: "Something broke on our end. Fitting, honestly." }, 500);
  }
}
