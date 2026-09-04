/**
 * DOM fallback.
 *
 * Only for the case where the network hooks come back empty: a widget that
 * renders server-side, or streams over a transport we cannot read, or has
 * already finished loading before our hook installed. Then the rendered DOM is
 * the only place the data exists.
 *
 * OFF by default, and deliberately so. It is strictly worse than reading the
 * wire: markup changes without warning, values are formatted for humans
 * (thousands separators, localised dates, truncated names), and a subtree can
 * re-render several times for one logical update. Turning it on trades
 * reliability for coverage.
 *
 * What this file does NOT do is parse bets out of the markup. We have never
 * seen the real markup, so any selector here would be invented - exactly what
 * the project forbids. It captures the changed subtree's HTML and stops. An
 * adapter can learn to read it at Milestone 2, from real captures.
 */

import type { RawCapture } from '../../shared/types.ts';
import { captureId as makeCaptureId } from '../../shared/ids.ts';
import { redactBody } from '../../shared/redact.ts';
import { classifyCapture } from '../../adapters/registry.ts';
import { frameOrigin, frameUrl, isTopFrame } from './session.ts';
import type { HookDeps } from './hook.ts';

/**
 * A subtree is only interesting if it reads like betting data. Both patterns
 * must hit: a number in the decimal-odds band AND a currency-ish amount. Odds
 * alone match every clock, score and countdown on the page.
 */
const ODDS_TEXT = /\b\d{1,3}\.\d{2}\b/;
const MONEY_TEXT = /(?:[$€£₮]\s?\d|(?:\d[\d,]*\.\d{2})\s?(?:USD|EUR|USDT|BTC|ETH|SOL))/i;

/** Ignore our own panel, and anything too small or too vast to be a feed row. */
const MIN_HTML = 80;
const MAX_HTML = 60_000;

/** Coalescing window. A React re-render can fire dozens of mutations per update. */
const SETTLE_MS = 250;

function isInteresting(text: string): boolean {
  return ODDS_TEXT.test(text) && MONEY_TEXT.test(text);
}

/**
 * Walks up to the nearest element that looks like a whole row rather than the
 * one text node that changed - a leaf mutation on its own carries no context.
 */
function containerFor(node: Node): Element | null {
  let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  let hops = 0;
  while (el && hops < 6) {
    const html = el.outerHTML;
    if (html.length >= MIN_HTML) return el;
    el = el.parentElement;
    hops += 1;
  }
  return el;
}

export function installDomFallback(deps: HookDeps): { uninstall(): void } {
  if (typeof MutationObserver !== 'function' || typeof document !== 'object') {
    return { uninstall: () => {} };
  }

  let pending: Set<Element> = new Set();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Identical markup re-emitted on every re-render would flood the ring; a
  // bounded set of recent hashes suppresses that without unbounded memory.
  const recent = new Map<string, number>();

  const emitSubtree = (el: Element): void => {
    let html: string;
    try {
      html = el.outerHTML;
    } catch {
      return;
    }
    if (html.length < MIN_HTML || html.length > MAX_HTML) return;

    const text = el.textContent ?? '';
    if (!isInteresting(text)) return;

    // Cheap content key: length plus a sample, enough to spot a repeat render.
    const key = `${html.length}:${html.slice(0, 120)}`;
    const now = deps.now();
    const seen = recent.get(key);
    if (seen !== undefined && now - seen < 5000) return;
    recent.set(key, now);
    if (recent.size > 200) {
      for (const [k, t] of recent) {
        if (now - t > 30_000) recent.delete(k);
      }
    }

    const config = deps.config();
    let body: string | null = html;
    let redacted = false;
    if (config.redact) {
      // Markup is not JSON, so this is pattern masking only - it will catch a
      // token or an email rendered into the page, not much else.
      const result = redactBody(html, 'text/html');
      body = result.value;
      redacted = result.redacted;
    }
    const bytes = body === null ? 0 : body.length;
    const truncated = bytes > config.maxBodyBytes;
    if (truncated && body !== null) body = body.slice(0, config.maxBodyBytes);

    const seq = deps.nextSeq();
    const base: RawCapture = {
      captureId: makeCaptureId(deps.sessionId, seq),
      sessionId: deps.sessionId,
      seq,
      tsClient: now,
      transport: 'dom',
      direction: 'inbound',
      frameUrl: frameUrl(),
      frameOrigin: frameOrigin(),
      isTopFrame: isTopFrame(),
      pageOrigin: deps.pageOrigin,
      url: frameUrl(),
      urlHost: (() => {
        try {
          return new URL(frameUrl()).hostname;
        } catch {
          return '';
        }
      })(),
      urlPath: 'dom-mutation',
      contentType: 'text/html',
      body,
      bodyEncoding: 'utf8',
      bodyBytes: bytes,
      truncated,
      redacted,
      classification: {
        kind: 'unknown',
        confidence: 0,
        adapterId: 'dom-fallback',
        reasons: [],
        shapeFingerprint: '',
      },
    };

    try {
      base.classification = classifyCapture(base);
    } catch {
      base.classification.reasons = ['classifier threw on a DOM capture'];
    }
    // Markup will not classify as anything today, and saying so is more useful
    // than a bare "unknown".
    if (base.classification.reasons.length === 0) {
      base.classification.reasons = [
        'captured from the DOM, not the network - no structural rule reads markup yet (Milestone 2)',
      ];
    }

    deps.emit(base);
  };

  const flush = (): void => {
    timer = null;
    const batch = pending;
    pending = new Set();
    for (const el of batch) {
      try {
        if (el.isConnected) emitSubtree(el);
      } catch {
        // One bad node must not stop the rest of the batch.
      }
    }
  };

  const observer = new MutationObserver((records) => {
    if (!deps.config().enabled || !deps.config().domFallback) return;
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        const el = containerFor(node);
        // Never capture our own panel.
        if (el && !el.closest('[data-betby-scout]')) pending.add(el);
      }
      if (record.type === 'characterData' && record.target.parentElement) {
        const el = containerFor(record.target);
        if (el && !el.closest('[data-betby-scout]')) pending.add(el);
      }
    }
    if (pending.size > 0 && timer === null) timer = setTimeout(flush, SETTLE_MS);
  });

  const start = (): void => {
    const root = document.body ?? document.documentElement;
    if (!root) return;
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  return {
    uninstall(): void {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
      recent.clear();
    },
  };
}
