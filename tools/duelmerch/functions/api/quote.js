// POST /api/quote — real shipping cost for a cart + destination.
// Creates nothing, stores nothing. The address is used for the rate lookup and
// dropped. Supplier-agnostic: see shared/fulfillment.mjs.
import { priceCart } from "../../shared/catalog.mjs";
import { provider } from "../../shared/fulfillment.mjs";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

export async function onRequestPost({ request, env }) {
  try {
    if (!provider.configured(env)) return json({ ok: false, error: "Checkout isn't switched on yet." }, 503);

    const body = await request.json().catch(() => null);
    if (!body) return json({ ok: false, error: "Bad request." }, 400);

    const priced = priceCart(body.items);
    if (!priced.ok) return json({ ok: false, error: priced.error }, 400);

    const c = body.customer || {};
    const country = String(c.country_code || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return json({ ok: false, error: "Pick your country." }, 400);

    const rate = await provider.quoteShipping(env, {
      lines: priced.lines,
      dest: { country_code: country, state: String(c.state || "").trim(), city: String(c.city || "").trim(), zip: String(c.zip || "").trim() },
    });
    if (!rate.ok) return json({ ok: false, error: rate.error }, 400);

    return json({
      ok: true,
      subtotal: priced.subtotal,
      shipping: rate.shipping,
      total: Math.round((priced.subtotal + rate.shipping) * 100) / 100,
      service: rate.service,
      eta: rate.eta,
    });
  } catch (e) {
    return json({ ok: false, error: "Couldn't price shipping." }, 500);
  }
}
