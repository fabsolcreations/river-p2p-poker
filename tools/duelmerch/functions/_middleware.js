import { CATALOG } from "../shared/catalog.mjs";

// A link to a single design has to unfurl as that design. This audience shares
// things by pasting a URL into Discord, and a generic card for every product is
// the difference between "look at this one" landing and not.
//
// Product names come from CATALOG so there is one source of truth — never
// duplicate the names here.
//
// Handler objects must NOT carry fields named `element`, `text` or `comments`
// unless they are functions: HTMLRewriter reads those as node callbacks. Storing
// a string on `this.text` is what broke the first version of this file.

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  // only the document, only when a product is named
  const id = url.searchParams.get("p");
  if (!id || (url.pathname !== "/" && url.pathname !== "/index.html")) return next();

  const product = Object.prototype.hasOwnProperty.call(CATALOG, id) ? CATALOG[id] : null;
  if (!product) return next();

  const res = await next();
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;

  // Nicer social cards are never worth taking the site down for. If anything in
  // here throws, serve the page exactly as it would have been.
  try {
    const name = product.name;
    const desc = "A design for the Duel merch store that doesn't exist yet. Say whether this one should get made.";
    // HTMLRewriter escapes attribute values itself — do not pre-escape here.
    const meta = {
      "og:title": name,
      "og:description": desc,
      "og:url": `https://duelmerch.org/?p=${encodeURIComponent(id)}`,
      "twitter:title": name,
      "twitter:description": desc,
      "description": desc,
    };

    return new HTMLRewriter()
      .on("meta", {
        element(el) {
          const key = el.getAttribute("property") || el.getAttribute("name");
          if (key && Object.prototype.hasOwnProperty.call(meta, key)) {
            el.setAttribute("content", meta[key]);
          }
        },
      })
      .on("title", {
        element(el) { el.setInnerContent(`${name} — Duelmerch`); },
      })
      .transform(res);
  } catch (err) {
    const out = new Response(res.body, res);
    out.headers.set("x-og-rewrite", "failed: " + String(err && err.message).slice(0, 120));
    return out;
  }
}
