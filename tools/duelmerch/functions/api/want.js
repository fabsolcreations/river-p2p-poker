// POST /api/want — someone wants a concept made. Counts interest, stores no PII.
import { CATALOG } from "../../shared/catalog.mjs";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || body.website) return json({ ok: true });           // honeypot
    const id = String(body.id || "");
    if (!CATALOG[id]) return json({ ok: false, error: "Unknown item." }, 400);

    const key = `want:${id}`;
    const current = Number((await env.INTEREST.get(key)) || 0);
    await env.INTEREST.put(key, String(current + 1));
    return json({ ok: true, count: current + 1 });
  } catch (e) {
    return json({ ok: false, error: "Couldn't record that." }, 500);
  }
}

export async function onRequestGet({ env }) {
  const list = await env.INTEREST.list({ prefix: "want:" });
  const out = {};
  for (const k of list.keys) out[k.name.slice(5)] = Number((await env.INTEREST.get(k.name)) || 0);
  return json({ ok: true, counts: out });
}
