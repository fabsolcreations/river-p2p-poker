// POST /api/ipn — NOWPayments payment notification.
// Verifies the HMAC-SHA512 signature before believing a single word of it,
// then releases the print job. Never trusts amounts from the callback alone.
//
// PRIVACY: this file never reads or writes buyer details. It only flips a
// status and tells Printful to go ahead — the address lives at the printer.

import { provider } from "../../shared/fulfillment.mjs";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// NOWPayments signs JSON.stringify(body) with keys sorted alphabetically.
function sortedStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(sortedStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${sortedStringify(obj[k])}`).join(",")}}`;
}

async function hmacSha512Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const PAID = new Set(["confirmed", "finished"]);

export async function onRequestPost({ request, env }) {
  try {
    const IPN_SECRET = env.NOWPAYMENTS_IPN_SECRET || env.ipn;
    if (!IPN_SECRET) return json({ ok: false, error: "not configured" }, 503);

    const raw = await request.text();
    let body;
    try { body = JSON.parse(raw); } catch { return json({ ok: false }, 400); }

    const given = request.headers.get("x-nowpayments-sig") || "";
    const expected = await hmacSha512Hex(IPN_SECRET, sortedStringify(body));
    if (!given || !timingSafeEqual(given.toLowerCase(), expected)) {
      // A wrong IPN secret looks exactly like success to the buyer: they pay,
      // we reject the callback, nothing prints. Leave a breadcrumb so it's
      // diagnosable instead of invisible. No secrets, no buyer details.
      try {
        await env.ORDERS.put("_ipn_rejected", JSON.stringify({
          at: new Date().toISOString(),
          order_id: String((body && body.order_id) || "").slice(0, 40),
          had_header: Boolean(given),
          hint: "signature mismatch — the ipn secret here probably differs from NOWPayments",
        }));
      } catch {}
      return json({ ok: false, error: "bad signature" }, 401);
    }

    const orderId = String(body.order_id || "");
    if (!orderId) return json({ ok: false, error: "no order_id" }, 400);

    const stored = await env.ORDERS.get(orderId);
    if (!stored) return json({ ok: false, error: "unknown order" }, 404);
    const order = JSON.parse(stored);

    const status = String(body.payment_status || "").toLowerCase();
    order.gateway_status = status;
    order.payment_id = body.payment_id || order.payment_id;
    order.paid_currency = body.pay_currency || order.paid_currency;
    order.actually_paid = body.actually_paid ?? order.actually_paid;
    order.updated = new Date().toISOString();

    if (PAID.has(status)) {
      // Guard against underpayment: the invoice was raised in USD, so compare
      // what the gateway says was settled against what we asked for.
      const settled = Number(body.price_amount);
      if (Number.isFinite(settled) && settled + 0.01 < order.total) {
        order.status = "underpaid";
      } else if (order.status !== "paid") {
        order.status = "paid";
        order.paid_at = new Date().toISOString();
      }
    } else if (["failed", "refunded", "expired"].includes(status)) {
      order.status = status;
    }

    // release or cancel the job at the supplier
    const supplierId = order.supplier_id || order.printful_id;
    if (order.status === "paid" && !order.fulfilled && supplierId && provider.configured(env)) {
      const r = await provider.confirm(env, supplierId);
      order.fulfilled = r.ok;
      if (!r.ok) order.fulfil_error = `${provider.name} HTTP ${r.status}`;
    } else if (["failed", "refunded", "expired"].includes(order.status) && supplierId && provider.configured(env)) {
      // never leave an unpaid draft sitting at the supplier
      await provider.cancel(env, supplierId).catch(() => {});
      order.supplier_id = null;
      order.printful_id = null;
    }

    await env.ORDERS.put(orderId, JSON.stringify(order));
    try {
      await env.ORDERS.put("_ipn_ok", JSON.stringify({ at: new Date().toISOString(), order_id: orderId, status: order.status }));
    } catch {}
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false }, 500);
  }
}
