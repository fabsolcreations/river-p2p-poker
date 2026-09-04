/**
 * Frame discovery.
 *
 * This is the only sanctioned way we learn where the BETBY widget actually
 * lives. CONTRACT.md rule 1 forbids guessing a widget hostname, so instead the
 * collector reports the iframe origins the page genuinely contains, the popup
 * lists them, and the user decides which one to grant access to.
 *
 * Everything here is best-effort by nature: a cross-origin child frame will not
 * let us read its document, so its depth stops at the boundary and its origin
 * comes from the `src` attribute we can see from the outside. Where we cannot
 * determine a value we report an empty string, never a plausible-looking guess.
 */

import type { FrameReport } from '../../shared/types.ts';

type Frame = FrameReport['frames'][number];

/** How deep we walk same-origin frames. Deep enough for any real page. */
const MAX_DEPTH = 6;
/** Hard cap so a page that generates iframes in a loop cannot lock the tab. */
const MAX_FRAMES = 200;

function originOf(src: string, base: string): string {
  if (!src) return '';
  try {
    return new URL(src, base).origin;
  } catch {
    return '';
  }
}

function selfOrigin(): string {
  try {
    return location.origin;
  } catch {
    return '';
  }
}

function selfHref(): string {
  try {
    return location.href;
  } catch {
    return '';
  }
}

/**
 * Walks the frame tree from this document down.
 *
 * We enumerate `<iframe>`/`<frame>` elements rather than `window.frames`
 * because an element gives us the `src` attribute even when the frame's
 * contentWindow is cross-origin and opaque - and `src` is exactly the value the
 * popup needs in order to offer the origin as a grant.
 */
export function discoverFrames(): Frame[] {
  const out: Frame[] = [];
  const seen = new Set<string>();
  const base = selfHref();
  const mine = selfOrigin();

  const walk = (doc: Document, depth: number, docBase: string): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FRAMES) return;
    let elements: Element[];
    try {
      elements = Array.from(doc.querySelectorAll('iframe, frame'));
    } catch {
      return;
    }

    for (const element of elements) {
      if (out.length >= MAX_FRAMES) return;

      let src = '';
      try {
        src = element.getAttribute('src') ?? '';
      } catch {
        src = '';
      }

      let childDoc: Document | null = null;
      let childHref = '';
      let sameOrigin = false;
      try {
        // Reading contentDocument across origins throws (or returns null).
        // That failure is the signal, not an error: it tells us the frame is
        // cross-origin, which is precisely what the extension is needed for.
        const win = (element as HTMLIFrameElement).contentWindow;
        const cd = (element as HTMLIFrameElement).contentDocument;
        if (win && cd) {
          childDoc = cd;
          childHref = cd.location.href;
          sameOrigin = true;
        }
      } catch {
        childDoc = null;
        sameOrigin = false;
      }

      const origin = sameOrigin && childHref ? originOf(childHref, docBase) : originOf(src, docBase);
      // A frame with no src and no readable document (sandboxed, srcdoc) has no
      // origin we can honestly report. Record it with an empty origin so the
      // count is right; consumers filter empties out.
      const key = `${depth}|${origin}|${src}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          src: src || childHref,
          origin,
          depth,
          // "Same origin as the frame doing the discovery", which is the
          // question that decides whether a userscript can reach it at all.
          sameOrigin: sameOrigin && (origin === '' || origin === mine),
        });
      }

      if (childDoc) walk(childDoc, depth + 1, childHref || docBase);
    }
  };

  try {
    walk(document, 1, base);
  } catch {
    /* a detached or restricted document yields whatever we already collected */
  }

  return out;
}

export function buildFrameReport(sessionId: string, topOrigin: string, now: number): FrameReport {
  return {
    sessionId,
    ts: now,
    topOrigin,
    frames: discoverFrames(),
  };
}
