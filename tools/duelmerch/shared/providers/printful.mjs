// Printful adapter. Everything Printful-specific lives here and nowhere else.
// To move to a different supplier, write a file with these four functions and
// point shared/fulfillment.mjs at it. Nothing in functions/api/ should ever
// mention a supplier by name.

import { variantFor, filesFor, optionsFor } from "../catalog.mjs";

const API = "https://api.printful.com";
const key = env => env.PRINTFUL_API_KEY || env.printful;

export const name = "printful";

/** Cheapest real shipping cost in USD for a destination, or null if unshippable. */
export async function quoteShipping(env, { lines, dest }) {
  const r = await fetch(`${API}/shipping/rates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key(env)}`, "content-type": "application/json" },
    body: JSON.stringify({
      recipient: {
        country_code: dest.country_code,
        state_code: dest.state || undefined,
        city: dest.city || undefined,
        zip: dest.zip || undefined,
      },
      items: lines.map(l => ({ variant_id: variantFor(l.id, l.size, l.color), quantity: l.qty })),
      currency: "USD",
      locale: "en_US",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j.result) || !j.result.length) {
    return { ok: false, error: (j && j.error && j.error.message) || "We can't work out shipping to there." };
  }
  const rates = j.result.map(x => ({ name: x.name, rate: Number(x.rate), days: x.minDeliveryDays ? `${x.minDeliveryDays}-${x.maxDeliveryDays} days` : null }))
                        .sort((a, b) => a.rate - b.rate);
  return { ok: true, shipping: Math.ceil(rates[0].rate * 100) / 100, service: rates[0].name, eta: rates[0].days };
}

/** Unconfirmed order holding the address. Returns the supplier's order id. */
export async function createDraft(env, { orderId, recipient, lines, origin }) {
  const r = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key(env)}`, "content-type": "application/json" },
    body: JSON.stringify({
      external_id: orderId,
      confirm: false,
      recipient: {
        name: recipient.name, email: recipient.email, address1: recipient.address,
        city: recipient.city, zip: recipient.zip, country_code: recipient.country_code,
        ...(recipient.state ? { state_code: recipient.state } : {}),
      },
      items: lines.map(l => {
        const opts = optionsFor(l.id, l.amount);
        return {
          variant_id: variantFor(l.id, l.size, l.color),
          quantity: l.qty,
          name: l.name,
          files: filesFor(l.id, origin, l.amount, l.color),
          ...(opts.length ? { options: opts } : {}),
        };
      }),
      packing_slip: { message: "Coming 2029. Shipped 2026. — duelmerch.org" },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.result || !j.result.id) return { ok: false, error: "Couldn't reach the printer. Nothing was charged." };
  return { ok: true, supplierId: j.result.id };
}

/** Release a paid order into production. */
export async function confirm(env, supplierId) {
  const r = await fetch(`${API}/orders/${supplierId}/confirm`, {
    method: "POST", headers: { Authorization: `Bearer ${key(env)}` },
  });
  return { ok: r.ok, status: r.status };
}

/** Bin an unpaid draft so nothing unpaid sits at the supplier. */
export async function cancel(env, supplierId) {
  const r = await fetch(`${API}/orders/${supplierId}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${key(env)}` },
  });
  return { ok: r.ok };
}

export function configured(env) { return Boolean(key(env)); }
