// POST /api/submit — Drop 002 concept submissions into KV (binding: SUBMISSIONS)
// Accepts { idea, handle, website: "" (honeypot) }

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

    const idea = typeof body.idea === "string" ? body.idea.trim() : "";
    const handle = typeof body.handle === "string" ? body.handle.trim().slice(0, 60) : "";

    if (idea.length < 4) {
      return json({ ok: false, error: "Give us more than that." }, 400);
    }
    if (idea.length > 280) {
      return json({ ok: false, error: "Keep it under 280 characters — it has to fit on a shirt." }, 400);
    }

    // one entry per submission, keyed by time + random so nothing overwrites
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await env.SUBMISSIONS.put(
      id,
      JSON.stringify({
        idea,
        handle,
        at: new Date().toISOString(),
        country: (request.cf && request.cf.country) || "",
      })
    );
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: "Something broke on our end. Fitting, honestly." }, 500);
  }
}
