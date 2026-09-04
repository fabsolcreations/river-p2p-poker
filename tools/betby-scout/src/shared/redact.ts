/**
 * Redaction.
 *
 * The collector runs inside a page where the user is signed in. Everything it
 * sees - request headers, bootstrap configs, betslip calls - can contain
 * session tokens, and the whole point of the "Export raw capture" button is
 * that these payloads get sent somewhere else for analysis. So redaction runs
 * *before* a capture leaves the page, not before it is displayed.
 *
 * The constraint that shapes the design: we are reverse-engineering a schema,
 * so we must preserve structure exactly - every key, every array length, every
 * value *type*. Only leaf values that look like credentials or personal data
 * are replaced, and they are replaced with a marker of the same JSON type.
 *
 * This reduces exposure; it is not a guarantee. Anything genuinely sensitive
 * should not be captured at all - see `skipUrl`.
 */

export const REDACTED = '[redacted]';

/** Header names dropped outright. Never masked-and-kept: no schema value. */
const HEADER_DENY = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-api-key',
  'api-key',
  'x-signature',
]);

/** Keys whose values are masked wherever they appear, at any depth. */
const KEY_SENSITIVE =
  /(?:^|[._-])(?:pass(?:word|wd)?|secret|token|jwt|bearer|auth|authorization|session(?:id|_id|key)?|api[._-]?key|apikey|access[._-]?key|private[._-]?key|privkey|signature|sig|otp|pin|cvv|card(?:number|no)?|iban|ssn|tax[._-]?id|passport|licen[cs]e|dob|birth|email|e[._-]?mail|phone|mobile|msisdn|address|street|postcode|zip|city(?:_?name)?|first[._-]?name|last[._-]?name|full[._-]?name|real[._-]?name|ip(?:_?address)?|device[._-]?id|fingerprint|refresh)(?:$|[._-])/i;

/**
 * Key matching has to survive every casing convention at once, because a
 * payload will happily mix `access_token`, `accessToken` and `AccessToken` in
 * one response. Splitting camelCase into separators before testing means the
 * single pattern above covers all of them - without this, `accessToken` slips
 * past the key rule and is only caught if its value happens to look like a JWT.
 */
export function isSensitiveKey(key: string): boolean {
  if (!key) return false;
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  return KEY_SENSITIVE.test(snake) || KEY_SENSITIVE.test(`_${snake}_`);
}

/**
 * Numbers are only masked under an unambiguously sensitive key. Masking every
 * number under a broad rule would destroy odds, stakes and timestamps - the
 * entire dataset - so this list is deliberately much narrower than KEY_SENSITIVE.
 */
const KEY_SENSITIVE_NUMERIC =
  /(?:^|[._-])(?:pin|cvv|ssn|card(?:number|no)?|phone|mobile|msisdn|account(?:number|no)?)(?:$|[._-])/i;

export function isSensitiveNumericKey(key: string): boolean {
  if (!key) return false;
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  return KEY_SENSITIVE_NUMERIC.test(snake) || KEY_SENSITIVE_NUMERIC.test(`_${snake}_`);
}

/** Standalone values that are dangerous regardless of the key they sit under. */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted:jwt]'],
  // email
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted:email]'],
  // long opaque token: 32+ chars of base64url/hex with no spaces
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted:token]'],
  // crypto addresses (the user's own deposit addresses show up in wallet calls)
  [/\b0x[a-fA-F0-9]{40}\b/g, '[redacted:evm-address]'],
  [/\b(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}\b/g, '[redacted:btc-address]'],
];

export interface RedactionResult<T> {
  value: T;
  /** True if anything was changed. Surfaced in the debug panel. */
  redacted: boolean;
}

/** URLs we refuse to capture a body for at all. */
export function skipUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes('/oauth') ||
    u.includes('/login') ||
    u.includes('/signin') ||
    u.includes('/sign-in') ||
    u.includes('/register') ||
    u.includes('/password') ||
    u.includes('/2fa') ||
    u.includes('/kyc') ||
    u.includes('/verification/document')
  );
}

export function redactHeaders(headers: Record<string, string> | undefined): RedactionResult<Record<string, string> | undefined> {
  if (!headers) return { value: undefined, redacted: false };
  const out: Record<string, string> = {};
  let changed = false;
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HEADER_DENY.has(lk) || isSensitiveKey(lk)) {
      out[k] = REDACTED;
      changed = true;
      continue;
    }
    const masked = redactString(v);
    if (masked !== v) changed = true;
    out[k] = masked;
  }
  return { value: out, redacted: changed };
}

/** Mask query-string values, keeping parameter names so the shape survives. */
export function redactUrl(url: string): RedactionResult<string> {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return { value: url, redacted: false };
  const base = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1);
  let changed = false;
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    if (isSensitiveKey(decodeURIComponent(k))) {
      changed = true;
      return `${k}=${REDACTED}`;
    }
    const masked = redactString(decodeURIComponent(v));
    if (masked !== decodeURIComponent(v)) {
      changed = true;
      return `${k}=${encodeURIComponent(masked)}`;
    }
    return pair;
  });
  return { value: `${base}?${parts.join('&')}`, redacted: changed };
}

export function redactString(s: string): string {
  if (s.length < 8) return s;
  let out = s;
  for (const [re, replacement] of VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Walks a parsed JSON value and masks sensitive leaves. Structure, key order,
 * array lengths and value types are all preserved: a redacted string stays a
 * string, a redacted number becomes 0 (not a string), so shape fingerprinting
 * and schema discovery still work on redacted captures.
 */
export function redactJson(input: unknown, maxDepth = 24): RedactionResult<unknown> {
  let changed = false;

  const walk = (value: unknown, keyPath: string, depth: number): unknown => {
    if (depth > maxDepth) return value;
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      if (isSensitiveKey(keyPath)) {
        changed = true;
        return REDACTED;
      }
      const masked = redactString(value);
      if (masked !== value) changed = true;
      return masked;
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
      // Only mask numbers under an unambiguously sensitive key - masking every
      // number would destroy odds and stakes, which are the entire dataset.
      if (isSensitiveNumericKey(keyPath)) {
        changed = true;
        return 0;
      }
      return value;
    }

    if (typeof value === 'boolean') return value;

    if (Array.isArray(value)) {
      return value.map((v) => walk(v, keyPath, depth + 1));
    }

    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, k, depth + 1);
      }
      return out;
    }

    return value;
  };

  return { value: walk(input, '', 0), redacted: changed };
}

/**
 * Redacts a body without knowing whether it is JSON. JSON is redacted
 * structurally; anything else falls back to pattern masking on the raw text.
 */
export function redactBody(text: string | null, contentType?: string): RedactionResult<string | null> {
  if (text === null) return { value: null, redacted: false };
  const looksJson =
    (contentType ?? '').includes('json') || /^\s*[[{]/.test(text);
  if (looksJson) {
    try {
      const parsed: unknown = JSON.parse(text);
      const result = redactJson(parsed);
      return { value: JSON.stringify(result.value), redacted: result.redacted };
    } catch {
      // fall through to text masking
    }
  }
  const masked = redactString(text);
  return { value: masked, redacted: masked !== text };
}
