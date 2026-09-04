/**
 * Network instrumentation.
 *
 * This file runs inside a sportsbook the user is signed in to, in the MAIN
 * world, at document_start, ahead of the site's own bundle. If it misbehaves
 * the page breaks - so the governing rule everywhere below is:
 *
 *   **the page's behaviour is never altered.**
 *
 * Concretely that means: every wrapper calls through to the original with the
 * original arguments and `this`; every wrapper returns exactly what the
 * original returned (the same Promise object, the same Response object); no
 * event is swallowed, delayed or reordered; and every line of our own logic
 * sits inside a try/catch whose catch does nothing but record. A capture we
 * failed to read is recorded with `body: null` and an `error` string
 * (CONTRACT.md rule 4) - it is never thrown at the page and never guessed at.
 *
 * The second rule is that we only ever *observe*. Nothing here originates a
 * request, retries one, mutates a betslip, or touches the DOM.
 *
 * Classification is delegated to the adapter registry and is driven by payload
 * shape, never by a guessed endpoint name (CONTRACT.md rule 1). The single
 * URL-based decision in this file is the self-exclusion check that stops us
 * capturing our own uploads to the local server, which is our own host, not
 * the book's.
 */

import { classifyCapture } from '../../adapters/registry.ts';
import { captureId as makeCaptureId } from '../../shared/ids.ts';
import { redactBody, redactHeaders, redactUrl, skipUrl } from '../../shared/redact.ts';
import { shapeFingerprint } from '../../shared/shape.ts';
import type {
  BodyEncoding,
  CaptureClassification,
  CaptureDirection,
  CaptureTransport,
  ClassifyInput,
  CollectorConfig,
  RawCapture,
} from '../../shared/types.ts';

export interface HookDeps {
  config: () => CollectorConfig;
  emit: (c: RawCapture) => void;
  nextSeq: () => number;
  sessionId: string;
  now: () => number;
  pageOrigin: string;
}

/**
 * The registry is authored alongside this file, and its adapter-selection step
 * needs the page/frame origin that `SportsbookAdapter.matches` takes, which
 * `ClassifyInput` does not carry. We therefore call it through a tolerant local
 * signature: a one-parameter implementation ignores the extra argument, a
 * two-parameter one gets the context it needs. Either way the call is wrapped
 * in try/catch below and degrades to kind 'unknown' rather than throwing into
 * a page hook.
 */
type ClassifyFn = (input: ClassifyInput, ...rest: unknown[]) => CaptureClassification;
const classifyFn = classifyCapture as unknown as ClassifyFn;

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return String(e);
  } catch {
    return 'unknown error';
  }
}

/**
 * UTF-8 byte length without allocating an encoded copy. `RawCapture.bodyBytes`
 * is documented as bytes, and a JS string length is code units, so a payload
 * full of Cyrillic team names would under-report by half if we used `.length`.
 */
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3; // lone high surrogate encodes as U+FFFD
      }
    } else n += 3;
  }
  return n;
}

/**
 * Cuts a string to a UTF-8 byte budget and reports the TRUE pre-truncation
 * size. Never splits a surrogate pair - half an emoji in the middle of a JSON
 * string breaks the parse and makes a truncated capture look corrupt rather
 * than merely short.
 */
export function truncateUtf8(s: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  let total = 0;
  let cut = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let size: number;
    let step = 1;
    if (c < 0x80) size = 1;
    else if (c < 0x800) size = 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        size = 4;
        step = 2;
      } else size = 3;
    } else size = 3;

    if (cut === -1 && total + size > limit) cut = i;
    total += size;
    i += step - 1;
  }
  if (cut === -1) return { text: s, bytes: total, truncated: false };
  return { text: s.slice(0, cut), bytes: total, truncated: true };
}

/** Chunked base64 so a multi-megabyte frame cannot blow the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(slice) as unknown as number[]);
  }
  // btoa exists in every browser context this runs in; in a non-browser test
  // context we fall back to Buffer rather than throwing inside a hook.
  const b64 = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (typeof b64 === 'function') return b64(binary);
  return '';
}

function absoluteUrl(raw: string): string {
  try {
    return new URL(raw, typeof location === 'object' ? location.href : undefined).toString();
  } catch {
    return raw;
  }
}

function splitUrl(url: string): { host: string; path: string; query: string | undefined } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname, query: u.search ? u.search.slice(1) : undefined };
  } catch {
    // A URL we cannot parse still deserves to be recorded verbatim; we just
    // cannot split it. Reporting an empty host is honest, guessing one is not.
    return { host: '', path: url, query: undefined };
  }
}

/* ------------------------------------------------------------------ *
 * Asset filtering
 *
 * Note what is *not* here: any path or hostname pattern that tries to identify
 * "the API". Skipping is decided by content-type and by a file extension that
 * is unambiguously a static asset - both properties of the response itself.
 * ------------------------------------------------------------------ */

const ASSET_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|cur|woff2?|ttf|otf|eot|css|js|mjs|cjs|map|mp4|webm|ogg|mp3|wav|m4a|pdf|zip|gz)$/i;

const ASSET_CONTENT_TYPE =
  /^(?:image\/|font\/|video\/|audio\/|text\/css|application\/javascript|text\/javascript|application\/x-javascript|application\/font|application\/vnd\.ms-fontobject|application\/wasm)/i;

function isAssetLike(path: string, contentType: string | undefined): boolean {
  if (contentType && ASSET_CONTENT_TYPE.test(contentType.trim())) return true;
  return ASSET_EXTENSION.test(path);
}

/* ------------------------------------------------------------------ *
 * Header helpers
 * ------------------------------------------------------------------ */

function headersFromHeadersLike(h: unknown): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  try {
    if (typeof Headers === 'function' && h instanceof Headers) {
      h.forEach((v, k) => {
        out[k] = v;
      });
      return out;
    }
    if (Array.isArray(h)) {
      for (const pair of h) {
        if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
      }
      return out;
    }
    if (typeof h === 'object') {
      for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k] = String(v);
      return out;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** `getAllResponseHeaders()` returns one CRLF-separated block. */
function parseRawHeaders(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The observation record
 * ------------------------------------------------------------------ */

interface Observation {
  transport: CaptureTransport;
  direction: CaptureDirection;
  /** Stamped by the caller at the moment of receipt, before any async read. */
  seq: number;
  tsClient: number;
  method?: string;
  url: string;
  status?: number;
  durationMs?: number;
  reqHeaders?: Record<string, string>;
  reqBody?: string | null;
  resHeaders?: Record<string, string>;
  contentType?: string;
  body: string | null;
  bodyEncoding: BodyEncoding;
  /**
   * True size in bytes when the caller already knows it and the body it passes
   * is a re-encoding (base64) or was cut before we saw it. Leave undefined for
   * a plain text body and the byte count is computed here.
   */
  rawBytes?: number;
  /** Set when the caller already truncated (binary paths cut before encoding). */
  truncated?: boolean;
  error?: string;
}

/**
 * Redaction ceiling. Above this we truncate before redacting rather than
 * parsing tens of megabytes of JSON on the page's main thread; below it we
 * redact the whole body first, because structural (key-aware) redaction only
 * works on JSON that still parses, and truncated JSON never does.
 */
const REDACT_PARSE_CEILING_BYTES = 8 * 1024 * 1024;

function unknownClassification(reason: string, json: unknown): CaptureClassification {
  let fingerprint = '';
  try {
    fingerprint = shapeFingerprint(json);
  } catch {
    fingerprint = '';
  }
  return { kind: 'unknown', confidence: 0, adapterId: 'none', reasons: [reason], shapeFingerprint: fingerprint };
}

/* ------------------------------------------------------------------ *
 * installHooks
 * ------------------------------------------------------------------ */

export function installHooks(deps: HookDeps): { uninstall(): void; ensureInstalled(): void } {
  /* -------------------------------------------------------------- *
   * Self-exclusion.
   *
   * Our own uploader posts to the local server through fetch and opens a
   * WebSocket to it. Without this, every flush would be captured, and each
   * capture would enlarge the next flush - an unbounded feedback loop. This is
   * a check against *our* configured host, not a guess about the book's.
   * -------------------------------------------------------------- */
  let selfOriginCache = { serverUrl: '', origin: '' };
  const isSelfTraffic = (url: string): boolean => {
    let serverUrl = '';
    try {
      serverUrl = deps.config().serverUrl;
    } catch {
      return false;
    }
    if (selfOriginCache.serverUrl !== serverUrl) {
      let origin = '';
      try {
        origin = new URL(serverUrl).origin;
      } catch {
        origin = '';
      }
      selfOriginCache = { serverUrl, origin };
    }
    if (!selfOriginCache.origin) return false;
    try {
      const u = new URL(url);
      if (u.origin === selfOriginCache.origin) return true;
      // The uploader's WebSocket is ws:// against an http:// serverUrl, so the
      // origins differ by scheme only. Compare hosts for the ws case.
      if ((u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === new URL(selfOriginCache.origin).host) return true;
      return false;
    } catch {
      return false;
    }
  };

  const config = (): CollectorConfig | null => {
    try {
      return deps.config();
    } catch {
      return null;
    }
  };

  const capturing = (): boolean => {
    const c = config();
    return c !== null && c.enabled;
  };

  /* -------------------------------------------------------------- *
   * Capture assembly
   * -------------------------------------------------------------- */

  const emit = (obs: Observation): void => {
    try {
      const cfg = config();
      if (cfg === null) return;

      const absolute = absoluteUrl(obs.url);
      if (isSelfTraffic(absolute)) return;

      // Redact the URL before anything else touches it, so no later string -
      // including an error message - can carry an unredacted query value.
      const urlResult = cfg.redact ? redactUrl(absolute) : { value: absolute, redacted: false };
      const safeUrl = urlResult.value;
      const parts = splitUrl(safeUrl);
      let redacted = urlResult.redacted;

      if (cfg.skipAssets && isAssetLike(parts.path, obs.contentType)) return;

      let body = obs.body;
      let bodyEncoding: BodyEncoding = obs.bodyEncoding;
      let truncated = obs.truncated === true;
      let bodyBytes = obs.rawBytes ?? 0;
      const notes: string[] = [];
      if (obs.error) notes.push(obs.error);

      /**
       * A credential-shaped URL is recorded as metadata only. We keep the fact
       * that the call happened - host, path, status - because that is real
       * schema-discovery signal, and we drop the body because it is the one
       * place a password or a one-time code would be.
       */
      if (skipUrl(absolute)) {
        if (body !== null) {
          bodyBytes = obs.rawBytes ?? (bodyEncoding === 'utf8' ? utf8Len(body) : body.length);
          body = null;
          truncated = false;
          // Deliberately no URL in this message: an error string is displayed
          // and exported verbatim, and the whole point is to not carry it.
          notes.push('Body withheld: this URL matched the credential-path skip list.');
        }
      } else if (body !== null) {
        if (bodyEncoding === 'utf8') {
          const rawBytes = obs.rawBytes ?? utf8Len(body);
          if (cfg.redact && rawBytes <= REDACT_PARSE_CEILING_BYTES) {
            const r = redactBody(body, obs.contentType);
            body = r.value;
            redacted = redacted || r.redacted;
          }
          const cut = truncateUtf8(body ?? '', cfg.maxBodyBytes);
          body = cut.text;
          truncated = truncated || cut.truncated;
          // Report the size of what arrived, not of what we kept, and not of
          // the redacted rewrite: the honest answer to "how big was it".
          bodyBytes = rawBytes;
          if (cfg.redact && rawBytes > REDACT_PARSE_CEILING_BYTES) {
            // Truncate first, then redact the retained slice with the
            // pattern-level pass; key-aware redaction needs parseable JSON.
            const r = redactBody(body, obs.contentType);
            body = r.value;
            redacted = redacted || r.redacted;
            notes.push('Body exceeded the redaction ceiling, so only value-pattern redaction was applied to the retained slice.');
          }
        } else {
          // base64: the caller cut and encoded already, and value redaction
          // cannot see inside binary. Say so rather than implying it was safe.
          bodyBytes = obs.rawBytes ?? body.length;
          if (cfg.redact) {
            notes.push('Binary frame stored as base64; text redaction cannot inspect binary payloads.');
          }
        }
      }

      let json: unknown = null;
      if (body !== null && bodyEncoding === 'utf8' && !truncated) {
        const looksJson = (obs.contentType ?? '').includes('json') || /^\s*[[{]/.test(body);
        if (looksJson) {
          try {
            json = JSON.parse(body) as unknown;
          } catch {
            json = null;
          }
        }
      }

      const classifyInput: ClassifyInput = {
        url: safeUrl,
        urlHost: parts.host,
        urlPath: parts.path,
        method: obs.method,
        contentType: obs.contentType,
        transport: obs.transport,
        direction: obs.direction,
        json,
        text: body,
      };

      let classification: CaptureClassification;
      try {
        classification = classifyFn(classifyInput, {
          pageOrigin: deps.pageOrigin,
          frameOrigin: frameOriginOf(),
        });
        // Trust but verify: a malformed verdict must not poison the panel.
        if (!classification || typeof classification.kind !== 'string') {
          classification = unknownClassification('Classifier returned nothing usable.', json);
        }
      } catch (e) {
        classification = unknownClassification(`Classifier threw: ${errText(e)}`, json);
      }

      const reqHeaderResult = cfg.redact ? redactHeaders(obs.reqHeaders) : { value: obs.reqHeaders, redacted: false };
      const resHeaderResult = cfg.redact ? redactHeaders(obs.resHeaders) : { value: obs.resHeaders, redacted: false };
      redacted = redacted || reqHeaderResult.redacted || resHeaderResult.redacted;

      let reqBody = obs.reqBody ?? null;
      if (reqBody !== null) {
        if (skipUrl(absolute)) {
          reqBody = null;
        } else {
          if (cfg.redact) {
            // Request bodies are at least as sensitive as responses - this is
            // where a login form or a betslip payload lives.
            const r = redactBody(reqBody, undefined);
            reqBody = r.value;
            redacted = redacted || r.redacted;
          }
          if (reqBody !== null) reqBody = truncateUtf8(reqBody, cfg.maxBodyBytes).text;
        }
      }

      const capture: RawCapture = {
        captureId: makeCaptureId(deps.sessionId, obs.seq),
        sessionId: deps.sessionId,
        seq: obs.seq,
        tsClient: obs.tsClient,
        transport: obs.transport,
        direction: obs.direction,
        frameUrl: frameUrlOf(),
        frameOrigin: frameOriginOf(),
        isTopFrame: isTopFrameNow(),
        pageOrigin: deps.pageOrigin,
        url: safeUrl,
        urlHost: parts.host,
        urlPath: parts.path,
        body,
        bodyEncoding,
        bodyBytes,
        truncated,
        redacted,
        classification,
      };
      if (parts.query !== undefined) capture.urlQuery = parts.query;
      if (obs.method !== undefined) capture.method = obs.method;
      if (obs.status !== undefined) capture.status = obs.status;
      if (obs.durationMs !== undefined) capture.durationMs = obs.durationMs;
      if (reqHeaderResult.value !== undefined) capture.reqHeaders = reqHeaderResult.value;
      if (reqBody !== null) capture.reqBody = reqBody;
      if (resHeaderResult.value !== undefined) capture.resHeaders = resHeaderResult.value;
      if (obs.contentType !== undefined) capture.contentType = obs.contentType;
      if (notes.length > 0) capture.error = notes.join(' | ');

      deps.emit(capture);
    } catch {
      // Emitting must never surface in the page. A capture we could not even
      // assemble is a capture we lose; the alternative is breaking the site.
    }
  };

  function frameUrlOf(): string {
    try {
      return location.href;
    } catch {
      return '';
    }
  }
  function frameOriginOf(): string {
    try {
      return location.origin;
    } catch {
      return '';
    }
  }
  function isTopFrameNow(): boolean {
    try {
      return window.top === window.self;
    } catch {
      return false;
    }
  }

  /* -------------------------------------------------------------- *
   * fetch
   * -------------------------------------------------------------- */

  /**
   * Above this we do not read the body at all. Reading a 200MB download into a
   * string to then keep 1MB of it would stall the page for seconds.
   */
  const READ_CEILING_BYTES = 32 * 1024 * 1024;
  /**
   * A cloned body that the page never finishes reading (a long-poll, a
   * streaming response) would leave our read pending forever and hold the
   * buffer with it. After this we cancel *our clone* - never the page's - and
   * record what we know.
   */
  const BODY_READ_TIMEOUT_MS = 15_000;

  let originalFetch: typeof fetch | null = null;
  let ourFetch: typeof fetch | null = null;

  interface FetchPlan {
    url: string;
    method: string;
    reqHeaders: Record<string, string> | undefined;
    reqBody: string | null;
    startedAt: number;
  }

  function planFetch(args: unknown[]): FetchPlan {
    const input = args[0];
    const init = args[1] as RequestInit | undefined;
    let url = '';
    let method = 'GET';
    let reqHeaders: Record<string, string> | undefined;
    let reqBody: string | null = null;

    if (typeof Request === 'function' && input instanceof Request) {
      url = input.url;
      method = input.method;
      reqHeaders = headersFromHeadersLike(input.headers);
    } else if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else if (input && typeof (input as { url?: unknown }).url === 'string') {
      url = (input as { url: string }).url;
    }

    if (init) {
      if (typeof init.method === 'string') method = init.method;
      const h = headersFromHeadersLike(init.headers);
      if (h) reqHeaders = { ...(reqHeaders ?? {}), ...h };
      // Only bodies that are already strings are read synchronously. A Blob,
      // FormData or ReadableStream body is left alone: reading it here would
      // mean consuming or copying the very object the page is about to send.
      const b = init.body;
      if (typeof b === 'string') reqBody = b;
      else if (typeof URLSearchParams === 'function' && b instanceof URLSearchParams) reqBody = b.toString();
      else if (b !== undefined && b !== null) reqBody = null;
    }

    return { url: absoluteUrl(url), method: method.toUpperCase(), reqHeaders, reqBody, startedAt: Date.now() };
  }

  /** Reads a Request's body from a clone. Cloning never disturbs the original. */
  function readRequestBody(args: unknown[], plan: FetchPlan): Promise<string | null> {
    const input = args[0];
    if (plan.reqBody !== null) return Promise.resolve(plan.reqBody);
    if (!(typeof Request === 'function' && input instanceof Request)) return Promise.resolve(null);
    try {
      if (input.bodyUsed || input.body === null) return Promise.resolve(null);
      return input
        .clone()
        .text()
        .then(
          (t) => t,
          () => null,
        );
    } catch {
      return Promise.resolve(null);
    }
  }

  function observeFetchResponse(plan: FetchPlan, res: Response, reqBodyPromise: Promise<string | null>): void {
    // Seq at receipt: the body read below is async and may finish out of
    // order, but the sequence must reflect when the payload actually arrived.
    const seq = deps.nextSeq();
    const tsClient = deps.now();
    const durationMs = tsClient - plan.startedAt;

    let resHeaders: Record<string, string> | undefined;
    let contentType: string | undefined;
    let contentLength = -1;
    try {
      resHeaders = headersFromHeadersLike(res.headers);
      contentType = res.headers.get('content-type') ?? undefined;
      const len = res.headers.get('content-length');
      if (len !== null) {
        const n = Number(len);
        if (Number.isFinite(n)) contentLength = n;
      }
    } catch {
      /* an opaque response exposes no headers - expected, not an error */
    }

    const cfg = config();
    const path = splitUrl(absoluteUrl(plan.url)).path;
    if (cfg?.skipAssets === true && isAssetLike(path, contentType)) return;

    const base: Omit<Observation, 'body' | 'bodyEncoding'> = {
      transport: 'fetch',
      direction: 'inbound',
      seq,
      tsClient,
      method: plan.method,
      url: plan.url,
      status: res.status,
      durationMs,
      reqHeaders: plan.reqHeaders,
      resHeaders,
      contentType,
    };

    const finish = (body: string | null, error?: string, rawBytes?: number): void => {
      reqBodyPromise.then(
        (reqBody) => {
          const obs: Observation = { ...base, body, bodyEncoding: 'utf8' };
          if (reqBody !== null) obs.reqBody = reqBody;
          if (error !== undefined) obs.error = error;
          if (rawBytes !== undefined) obs.rawBytes = rawBytes;
          emit(obs);
        },
        () => {
          const obs: Observation = { ...base, body, bodyEncoding: 'utf8' };
          if (error !== undefined) obs.error = error;
          if (rawBytes !== undefined) obs.rawBytes = rawBytes;
          emit(obs);
        },
      );
    };

    // An opaque (no-cors) response has no readable body by design. Recording
    // it as metadata is still useful for host discovery.
    if (res.type === 'opaque' || res.type === 'opaqueredirect') {
      finish(null, `Response type "${res.type}" exposes no body to script.`);
      return;
    }
    if (contentLength > READ_CEILING_BYTES) {
      finish(null, `Body not read: content-length ${contentLength} exceeds the ${READ_CEILING_BYTES}-byte read ceiling.`, contentLength);
      return;
    }

    let clone: Response;
    try {
      // clone() is the only safe way to read a body the page also reads: it
      // tees the stream instead of consuming it. If the page already read the
      // body before our .then ran, this throws and we record that honestly.
      clone = res.clone();
    } catch (e) {
      finish(null, `Could not clone the response: ${errText(e)}`);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        void clone.body?.cancel();
      } catch {
        /* cancelling our own clone is best-effort */
      }
      finish(null, `Body did not finish within ${BODY_READ_TIMEOUT_MS}ms; the read was abandoned.`);
    }, BODY_READ_TIMEOUT_MS);

    clone.text().then(
      (text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish(text);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish(null, `Could not read the response body: ${errText(e)}`);
      },
    );
  }

  function installFetch(): void {
    const current = window.fetch;
    if (typeof current !== 'function') return;
    if (current === ourFetch) return;

    // Wrap whatever is currently installed, which may be the page's own
    // wrapper if it got in after us. Chaining preserves their behaviour.
    const previous = current;
    originalFetch = originalFetch ?? previous;

    const wrapper = function (this: unknown, ...args: unknown[]): Promise<Response> {
      // Native fetch throws "Illegal invocation" without a window receiver.
      const receiver = this === undefined || this === null ? window : this;

      let plan: FetchPlan | null = null;
      try {
        if (capturing()) plan = planFetch(args);
      } catch {
        plan = null;
      }

      let result: Promise<Response>;
      try {
        result = (previous as (...a: unknown[]) => Promise<Response>).apply(receiver, args);
      } catch (e) {
        // A synchronous throw belongs to the page unchanged.
        throw e;
      }

      if (plan !== null) {
        try {
          const reqBodyPromise = readRequestBody(args, plan).catch(() => null);
          // Observation runs on a derived promise. The page keeps `result`
          // itself, so its resolution value, identity and rejection are
          // untouched by anything we do here.
          void result.then(
            (res) => {
              try {
                observeFetchResponse(plan as FetchPlan, res, reqBodyPromise);
              } catch {
                /* never let observation reach the page */
              }
            },
            (err) => {
              try {
                const p = plan as FetchPlan;
                emit({
                  transport: 'fetch',
                  direction: 'inbound',
                  seq: deps.nextSeq(),
                  tsClient: deps.now(),
                  method: p.method,
                  url: p.url,
                  durationMs: deps.now() - p.startedAt,
                  reqHeaders: p.reqHeaders,
                  reqBody: p.reqBody,
                  body: null,
                  bodyEncoding: 'utf8',
                  error: `Request failed: ${errText(err)}`,
                });
              } catch {
                /* ignore */
              }
            },
          ).catch(() => undefined);
        } catch {
          /* ignore */
        }
      }

      return result;
    } as unknown as typeof fetch;

    window.fetch = wrapper;
    ourFetch = wrapper;
  }

  function uninstallFetch(): void {
    if (ourFetch !== null && window.fetch === ourFetch && originalFetch !== null) {
      window.fetch = originalFetch;
    }
    ourFetch = null;
  }

  /* -------------------------------------------------------------- *
   * XMLHttpRequest
   *
   * The rules here: we never touch `onreadystatechange` (assigning it would
   * silently delete the page's own handler), we use addEventListener so the
   * page's listeners still fire in their original order, and we preserve `this`
   * on every call through.
   * -------------------------------------------------------------- */

  interface XhrState {
    method: string;
    url: string;
    startedAt: number;
    reqHeaders: Record<string, string>;
    reqBody: string | null;
    listening: boolean;
    done: boolean;
  }

  const xhrState = new WeakMap<XMLHttpRequest, XhrState>();
  let originalOpen: XMLHttpRequest['open'] | null = null;
  let originalSend: XMLHttpRequest['send'] | null = null;
  let originalSetHeader: XMLHttpRequest['setRequestHeader'] | null = null;
  let ourOpen: XMLHttpRequest['open'] | null = null;

  function readXhrBody(xhr: XMLHttpRequest): { body: string | null; encoding: BodyEncoding; rawBytes?: number; error?: string; pending?: Promise<{ body: string | null; encoding: BodyEncoding; rawBytes: number; truncated: boolean }> } {
    let type = '';
    try {
      type = xhr.responseType;
    } catch {
      type = '';
    }

    try {
      if (type === '' || type === 'text') {
        // responseText throws for any other responseType, which is why this is
        // gated rather than wrapped-and-hoped.
        return { body: xhr.responseText, encoding: 'utf8' };
      }
      if (type === 'json') {
        const value: unknown = xhr.response;
        if (value === null || value === undefined) return { body: null, encoding: 'utf8' };
        return { body: JSON.stringify(value), encoding: 'utf8' };
      }
      if (type === 'arraybuffer') {
        const buf: unknown = xhr.response;
        if (buf instanceof ArrayBuffer) {
          const cfg = config();
          const cap = cfg ? cfg.maxBodyBytes : 0;
          const all = new Uint8Array(buf);
          const kept = all.length > cap ? all.subarray(0, cap) : all;
          return { body: bytesToBase64(kept), encoding: 'base64', rawBytes: all.length, error: undefined };
        }
        return { body: null, encoding: 'utf8', error: 'arraybuffer response was not an ArrayBuffer.' };
      }
      if (type === 'blob') {
        const blob: unknown = xhr.response;
        if (blob instanceof Blob) {
          return {
            body: null,
            encoding: 'base64',
            pending: readBlobAsBase64(blob),
          };
        }
        return { body: null, encoding: 'utf8', error: 'blob response was not a Blob.' };
      }
      if (type === 'document') {
        // Serialising a live document costs more than it is worth here, and
        // the DOM fallback exists for markup. Record the fact, not a guess.
        return { body: null, encoding: 'utf8', error: 'responseType "document" is not captured; use the DOM fallback for markup.' };
      }
    } catch (e) {
      return { body: null, encoding: 'utf8', error: `Could not read the XHR response: ${errText(e)}` };
    }
    return { body: null, encoding: 'utf8', error: `Unhandled responseType "${type}".` };
  }

  function readBlobAsBase64(blob: Blob): Promise<{ body: string | null; encoding: BodyEncoding; rawBytes: number; truncated: boolean }> {
    const cfg = config();
    const cap = cfg ? cfg.maxBodyBytes : 0;
    return blob
      .arrayBuffer()
      .then((buf) => {
        const all = new Uint8Array(buf);
        const kept = all.length > cap ? all.subarray(0, cap) : all;
        return { body: bytesToBase64(kept), encoding: 'base64' as BodyEncoding, rawBytes: all.length, truncated: all.length > cap };
      })
      .catch(() => ({ body: null, encoding: 'base64' as BodyEncoding, rawBytes: 0, truncated: false }));
  }

  function finishXhr(xhr: XMLHttpRequest): void {
    const state = xhrState.get(xhr);
    if (!state || state.done) return;
    state.done = true;

    const seq = deps.nextSeq();
    const tsClient = deps.now();

    let status = 0;
    let resHeaders: Record<string, string> | undefined;
    let contentType: string | undefined;
    try {
      status = xhr.status;
      resHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
      contentType = xhr.getResponseHeader('content-type') ?? undefined;
    } catch {
      /* a failed request exposes nothing - status stays 0 */
    }

    const cfg = config();
    const path = splitUrl(absoluteUrl(state.url)).path;
    if (cfg?.skipAssets === true && isAssetLike(path, contentType)) return;

    const base: Omit<Observation, 'body' | 'bodyEncoding'> = {
      transport: 'xhr',
      direction: 'inbound',
      seq,
      tsClient,
      method: state.method,
      url: state.url,
      status,
      durationMs: tsClient - state.startedAt,
      reqHeaders: Object.keys(state.reqHeaders).length > 0 ? state.reqHeaders : undefined,
      reqBody: state.reqBody,
      resHeaders,
      contentType,
    };

    const notes: string[] = [];
    if (status === 0) notes.push('Request did not complete (network error, abort or timeout).');

    const read = readXhrBody(xhr);
    if (read.pending) {
      read.pending.then((r) => {
        const obs: Observation = { ...base, body: r.body, bodyEncoding: r.encoding, rawBytes: r.rawBytes, truncated: r.truncated };
        if (notes.length > 0) obs.error = notes.join(' | ');
        emit(obs);
      }, () => undefined);
      return;
    }

    if (read.error) notes.push(read.error);
    const obs: Observation = { ...base, body: read.body, bodyEncoding: read.encoding };
    if (read.rawBytes !== undefined) {
      obs.rawBytes = read.rawBytes;
      const cap = cfg ? cfg.maxBodyBytes : 0;
      obs.truncated = read.rawBytes > cap;
    }
    if (notes.length > 0) obs.error = notes.join(' | ');
    emit(obs);
  }

  function installXhr(): void {
    const XHR = window.XMLHttpRequest;
    if (typeof XHR !== 'function') return;
    if (ourOpen !== null && XHR.prototype.open === ourOpen) return;

    originalOpen = originalOpen ?? XHR.prototype.open;
    originalSend = originalSend ?? XHR.prototype.send;
    originalSetHeader = originalSetHeader ?? XHR.prototype.setRequestHeader;
    const baseOpen = XHR.prototype.open;
    const baseSend = XHR.prototype.send;
    const baseSetHeader = XHR.prototype.setRequestHeader;

    const openWrapper = function (this: XMLHttpRequest, ...args: unknown[]): void {
      try {
        // A reused XHR opens again; reset per-request state so the second
        // request cannot inherit the first one's body or timing.
        xhrState.set(this, {
          method: String(args[0] ?? 'GET').toUpperCase(),
          url: absoluteUrl(String(args[1] ?? '')),
          startedAt: Date.now(),
          reqHeaders: {},
          reqBody: null,
          listening: xhrState.get(this)?.listening === true,
          done: false,
        });
      } catch {
        /* ignore */
      }
      return (baseOpen as (...a: unknown[]) => void).apply(this, args);
    } as unknown as XMLHttpRequest['open'];

    const setHeaderWrapper = function (this: XMLHttpRequest, ...args: unknown[]): void {
      try {
        const state = xhrState.get(this);
        if (state) state.reqHeaders[String(args[0])] = String(args[1]);
      } catch {
        /* ignore */
      }
      return (baseSetHeader as (...a: unknown[]) => void).apply(this, args);
    } as unknown as XMLHttpRequest['setRequestHeader'];

    const sendWrapper = function (this: XMLHttpRequest, ...args: unknown[]): void {
      try {
        const state = xhrState.get(this);
        if (state) {
          state.startedAt = Date.now();
          state.done = false;
          const body = args[0];
          if (typeof body === 'string') state.reqBody = body;
          else if (typeof URLSearchParams === 'function' && body instanceof URLSearchParams) state.reqBody = body.toString();
          else state.reqBody = null;

          if (!state.listening) {
            state.listening = true;
            // addEventListener, never onreadystatechange: assigning that
            // property would delete the page's own handler.
            this.addEventListener('readystatechange', () => {
              try {
                if (this.readyState === 4 && capturing()) finishXhr(this);
              } catch {
                /* ignore */
              }
            });
            // loadend also covers abort/timeout/error paths in engines that
            // reach them without a final readystatechange. finishXhr is
            // idempotent per request, so whichever fires first wins.
            this.addEventListener('loadend', () => {
              try {
                if (capturing()) finishXhr(this);
              } catch {
                /* ignore */
              }
            });
          }
        }
      } catch {
        /* ignore */
      }
      return (baseSend as (...a: unknown[]) => void).apply(this, args);
    } as unknown as XMLHttpRequest['send'];

    XHR.prototype.open = openWrapper;
    XHR.prototype.setRequestHeader = setHeaderWrapper;
    XHR.prototype.send = sendWrapper;
    ourOpen = openWrapper;
  }

  function uninstallXhr(): void {
    const XHR = window.XMLHttpRequest;
    if (typeof XHR !== 'function') return;
    if (ourOpen !== null && XHR.prototype.open === ourOpen) {
      if (originalOpen) XHR.prototype.open = originalOpen;
      if (originalSend) XHR.prototype.send = originalSend;
      if (originalSetHeader) XHR.prototype.setRequestHeader = originalSetHeader;
    }
    ourOpen = null;
  }

  /* -------------------------------------------------------------- *
   * WebSocket
   * -------------------------------------------------------------- */

  let originalWebSocket: typeof WebSocket | null = null;
  let ourWebSocket: typeof WebSocket | null = null;

  function wsFrameObservation(url: string, direction: CaptureDirection, data: unknown): void {
    const seq = deps.nextSeq();
    const tsClient = deps.now();
    const cfg = config();
    const cap = cfg ? cfg.maxBodyBytes : 0;

    const send = (body: string | null, encoding: BodyEncoding, rawBytes: number, truncated: boolean, error?: string): void => {
      const obs: Observation = {
        transport: 'websocket',
        direction,
        seq,
        tsClient,
        method: direction === 'outbound' ? 'WS_SEND' : 'WS_MESSAGE',
        url,
        body,
        bodyEncoding: encoding,
        rawBytes,
        truncated,
      };
      if (error !== undefined) obs.error = error;
      emit(obs);
    };

    try {
      if (typeof data === 'string') {
        send(data, 'utf8', utf8Len(data), false);
        return;
      }
      if (data instanceof ArrayBuffer) {
        const all = new Uint8Array(data);
        const kept = all.length > cap ? all.subarray(0, cap) : all;
        send(bytesToBase64(kept), 'base64', all.length, all.length > cap);
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        const all = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const kept = all.length > cap ? all.subarray(0, cap) : all;
        send(bytesToBase64(kept), 'base64', all.length, all.length > cap);
        return;
      }
      if (typeof Blob === 'function' && data instanceof Blob) {
        // Blob reads are async. seq and ts were stamped above, at receipt, so
        // a slow read cannot reorder this frame behind a later one. The
        // rejection handler is mandatory: an unhandled rejection inside a page
        // hook shows up in the site's console as if the site caused it.
        data
          .arrayBuffer()
          .then((buf) => {
            const all = new Uint8Array(buf);
            const kept = all.length > cap ? all.subarray(0, cap) : all;
            send(bytesToBase64(kept), 'base64', all.length, all.length > cap);
          })
          .catch((e: unknown) => {
            send(null, 'base64', 0, false, `Could not read the binary frame: ${errText(e)}`);
          });
        return;
      }
      send(null, 'utf8', 0, false, `Unrecognised WebSocket frame type: ${Object.prototype.toString.call(data)}`);
    } catch (e) {
      send(null, 'utf8', 0, false, `Could not read the WebSocket frame: ${errText(e)}`);
    }
  }

  function instrumentSocket(ws: WebSocket, url: string): void {
    // Listener added at construction: it runs before the page's, but since we
    // neither stop propagation nor mutate the event, the page sees exactly the
    // event it would have seen.
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        if (capturing()) wsFrameObservation(url, 'inbound', ev.data);
      } catch {
        /* ignore */
      }
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      try {
        if (!capturing()) return;
        emit({
          transport: 'websocket',
          direction: 'inbound',
          seq: deps.nextSeq(),
          tsClient: deps.now(),
          method: 'WS_CLOSE',
          url,
          status: ev.code,
          body: null,
          bodyEncoding: 'utf8',
          error: ev.wasClean ? undefined : `Socket closed uncleanly (code ${ev.code}).`,
        });
      } catch {
        /* ignore */
      }
    });

    ws.addEventListener('error', () => {
      try {
        if (!capturing()) return;
        emit({
          transport: 'websocket',
          direction: 'inbound',
          seq: deps.nextSeq(),
          tsClient: deps.now(),
          method: 'WS_ERROR',
          url,
          body: null,
          bodyEncoding: 'utf8',
          // The error event carries no detail by design (it would leak
          // cross-origin information), so there is nothing more to report.
          error: 'WebSocket error event (no detail is exposed to script).',
        });
      } catch {
        /* ignore */
      }
    });

    // Outgoing frames: wrap send on the instance only. Patching
    // WebSocket.prototype.send would affect every socket in the page including
    // ones created before us, and would be far harder to undo.
    try {
      const nativeSend = ws.send;
      Object.defineProperty(ws, 'send', {
        configurable: true,
        writable: true,
        enumerable: false,
        value: function (this: WebSocket, data: unknown): void {
          try {
            if (capturing()) wsFrameObservation(url, 'outbound', data);
          } catch {
            /* ignore */
          }
          return (nativeSend as (...a: unknown[]) => void).apply(this, [data]);
        },
      });
    } catch {
      // A frozen socket object is unusual but not our business to force.
    }
  }

  function installWebSocket(): void {
    const current = window.WebSocket;
    if (typeof current !== 'function') return;
    if (current === ourWebSocket) return;
    originalWebSocket = originalWebSocket ?? current;
    const previous = current;

    const wrapper = function (this: unknown, ...args: unknown[]): WebSocket {
      // Reflect.construct with new.target keeps `class Mine extends WebSocket`
      // working: the instance still gets the subclass prototype.
      const target = (new.target ?? previous) as Function;
      const ws = Reflect.construct(previous, args, target) as WebSocket;
      try {
        if (capturing()) {
          const url = absoluteUrl(String(args[0] ?? ''));
          // The open itself is a capture: it is how we learn which hosts the
          // page talks to over sockets, which is host discovery, not a guess.
          emit({
            transport: 'websocket',
            direction: 'outbound',
            seq: deps.nextSeq(),
            tsClient: deps.now(),
            method: 'WS_OPEN',
            url,
            body: null,
            bodyEncoding: 'utf8',
          });
          instrumentSocket(ws, url);
        }
      } catch {
        /* the socket is already constructed and handed back regardless */
      }
      return ws;
    } as unknown as typeof WebSocket;

    // Statics and prototype must match the original or feature detection and
    // instanceof checks in the page start failing.
    try {
      wrapper.prototype = previous.prototype;
      Object.defineProperties(wrapper, {
        CONNECTING: { value: previous.CONNECTING, writable: false, enumerable: true },
        OPEN: { value: previous.OPEN, writable: false, enumerable: true },
        CLOSING: { value: previous.CLOSING, writable: false, enumerable: true },
        CLOSED: { value: previous.CLOSED, writable: false, enumerable: true },
      });
    } catch {
      /* ignore */
    }

    window.WebSocket = wrapper;
    ourWebSocket = wrapper;
  }

  function uninstallWebSocket(): void {
    if (ourWebSocket !== null && window.WebSocket === ourWebSocket && originalWebSocket !== null) {
      window.WebSocket = originalWebSocket;
    }
    ourWebSocket = null;
  }

  /* -------------------------------------------------------------- *
   * EventSource
   * -------------------------------------------------------------- */

  let originalEventSource: typeof EventSource | null = null;
  let ourEventSource: typeof EventSource | null = null;

  function instrumentEventSource(es: EventSource, url: string): void {
    const observed = new Set<string>();

    const listen = (type: string): void => {
      if (observed.has(type)) return;
      observed.add(type);
      try {
        es.addEventListener(type, (ev: Event) => {
          try {
            if (!capturing()) return;
            const data = (ev as MessageEvent).data;
            const text = typeof data === 'string' ? data : null;
            emit({
              transport: 'sse',
              direction: 'inbound',
              seq: deps.nextSeq(),
              tsClient: deps.now(),
              method: `SSE_${type.toUpperCase()}`,
              url,
              body: text,
              bodyEncoding: 'utf8',
              rawBytes: text === null ? 0 : utf8Len(text),
              error: text === null ? 'SSE event carried no string data.' : undefined,
            });
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
    };

    listen('message');

    // Named SSE events cannot be enumerated, so we learn them the only way
    // available: by noticing which ones the page subscribes to.
    try {
      const nativeAdd = es.addEventListener.bind(es);
      Object.defineProperty(es, 'addEventListener', {
        configurable: true,
        writable: true,
        enumerable: false,
        value: function (this: EventSource, type: string, ...rest: unknown[]): void {
          try {
            if (type !== 'open' && type !== 'error') listen(type);
          } catch {
            /* ignore */
          }
          return (nativeAdd as (...a: unknown[]) => void)(type, ...rest);
        },
      });
    } catch {
      /* ignore */
    }
  }

  function installEventSource(): void {
    const current = window.EventSource;
    if (typeof current !== 'function') return;
    if (current === ourEventSource) return;
    originalEventSource = originalEventSource ?? current;
    const previous = current;

    const wrapper = function (this: unknown, ...args: unknown[]): EventSource {
      const target = (new.target ?? previous) as Function;
      const es = Reflect.construct(previous, args, target) as EventSource;
      try {
        if (capturing()) {
          const url = absoluteUrl(String(args[0] ?? ''));
          instrumentEventSource(es, url);
        }
      } catch {
        /* ignore */
      }
      return es;
    } as unknown as typeof EventSource;

    try {
      wrapper.prototype = previous.prototype;
      Object.defineProperties(wrapper, {
        CONNECTING: { value: previous.CONNECTING, writable: false, enumerable: true },
        OPEN: { value: previous.OPEN, writable: false, enumerable: true },
        CLOSED: { value: previous.CLOSED, writable: false, enumerable: true },
      });
    } catch {
      /* ignore */
    }

    window.EventSource = wrapper;
    ourEventSource = wrapper;
  }

  function uninstallEventSource(): void {
    if (ourEventSource !== null && window.EventSource === ourEventSource && originalEventSource !== null) {
      window.EventSource = originalEventSource;
    }
    ourEventSource = null;
  }

  /* -------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------- */

  /**
   * Re-asserts every hook the config asks for.
   *
   * Two things make this necessary rather than paranoid. Single-page apps
   * routinely install their own fetch wrapper (tracing, retries) after ours,
   * and some bundles deliberately restore a pristine `window.fetch` from a
   * fresh iframe to defeat instrumentation. In both cases our wrapper is no
   * longer on the chain and we would silently record nothing - the worst
   * possible failure, because it looks like a quiet site.
   *
   * Called on every uploader flush tick.
   */
  const ensureInstalled = (): void => {
    const cfg = config();
    if (cfg === null) return;
    try {
      if (cfg.hookFetch) installFetch();
      else uninstallFetch();
    } catch {
      /* ignore */
    }
    try {
      if (cfg.hookXhr) installXhr();
      else uninstallXhr();
    } catch {
      /* ignore */
    }
    try {
      if (cfg.hookWebSocket) installWebSocket();
      else uninstallWebSocket();
    } catch {
      /* ignore */
    }
    try {
      if (cfg.hookSse) installEventSource();
      else uninstallEventSource();
    } catch {
      /* ignore */
    }
  };

  const uninstall = (): void => {
    uninstallFetch();
    uninstallXhr();
    uninstallWebSocket();
    uninstallEventSource();
    // Sockets that are already open keep their instance-level send wrapper and
    // their listeners; there is no safe way to remove a listener from a page
    // object we did not create without risking removing the page's own. They
    // stop emitting because `capturing()` gates every handler.
  };

  ensureInstalled();

  return { uninstall, ensureInstalled };
}
