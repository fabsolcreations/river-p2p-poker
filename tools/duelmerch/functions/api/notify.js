// POST /api/notify — waitlist capture into KV (binding: WAITLIST)
// Accepts { contact: "email or discord handle", website: "" (honeypot) }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HANDLE_RE = /^@?[a-z0-9._]{2,32}$/i;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) return json({ ok: false, error: "Bad request." }, 400);

    // honeypot: bots fill hidden fields; accept silently and store nothing
    if (body.website) return json({ ok: true });

    const contact = typeof body.contact === "string" ? body.contact.trim() : "";
    if (contact.length < 3 || contact.length > 200) {
      return json({ ok: false, error: "Enter an email or Discord handle." }, 400);
    }

    const isEmail = EMAIL_RE.test(contact);
    const isHandle = !isEmail && HANDLE_RE.test(contact);
    if (!isEmail && !isHandle) {
      return json({ ok: false, error: "That doesn't look like an email or a Discord handle." }, 400);
    }

    const key = contact.toLowerCase();
    const existing = await env.WAITLIST.get(key);
    if (existing === null) {
      await env.WAITLIST.put(
        key,
        JSON.stringify({
          contact,
          type: isEmail ? "email" : "discord",
          at: new Date().toISOString(),
          country: (request.cf && request.cf.country) || "",
        })
      );
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: "Something broke on our end. Fitting, honestly." }, 500);
  }
}
