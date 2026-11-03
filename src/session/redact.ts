// session/redact.ts — exact-token masking + pattern redactor (DESIGN.md §1.2; SEC §8.2–§8.4; P-SEC-22, P-SEC-41, P-API-20).
//
// Three layers, always in this order (SEC §8.2):
//   1. exact-match replacement of every secret the library knows (hook token, proxy/control tokens, captured proxy userinfo);
//      the only fully reliable layer, so it runs first and on every string;
//   2. the SEC §8.2 pattern list (API keys, GitHub/AWS/Slack tokens, private keys, JWTs, credential headers, bearer tokens,
//      URL userinfo, `*_TOKEN=…` assignments) and e-mail addresses (AL §8.2);
//   3. structural rules: env dumps mask values by variable name; trace `meta` mode replaces content-bearing fields by
//      `{len, sha256_8}`; `redactEvent` does the same for host logs (P-SEC-41).
// `scrubForFixture` reproduces the `scripts/fixtures-scrub.mjs` forms (ICR 0014 item 5) so a limit capture (§3.9) passes
// `pnpm fixtures:lint` without post-processing.

import { createHash } from 'node:crypto';
import type { DomainEvent } from '../model/events.js';
import type { JsonValue } from '../model/json.js';

export const REDACTED = '[REDACTED]';
export const EMAIL_FAKE = 'user@example.com';
const NONCE_FAKE = 'ccd-selftest-NONCE';

/** Shortest secret we mask by exact match (shorter strings would mask ordinary words). */
const MIN_SECRET_LEN = 8;

/** SEC §8.2 item 2 (runtime thresholds; the fixture scrubber is stricter, see FIXTURE_PATTERNS). */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/github_pat_[A-Za-z0-9_]{50,}/g, REDACTED],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, REDACTED],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, REDACTED],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  [
    /(authorization|proxy-authorization|x-api-key|cookie|set-cookie|x-ccd-token)(\s*[:=]\s*)(?:(?:basic|bearer|digest|token)\s+)?\S+/gi,
    `$1$2${REDACTED}`,
  ],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${REDACTED}`],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*=\s*)\S+/gi, `$1$2${REDACTED}`],
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** SEC §8.2 item 3: env values masked by variable name. */
const SENSITIVE_ENV_NAME = /(TOKEN|SECRET|KEY|PASS|AUTH|COOKIE|CREDENTIAL|SESSION|PROXY)/i;

/**
 * Keys whose values are content (prompts, tool input/output, assistant text). AL §8.2 list plus the camelCase forms the
 * observation/event payloads use. In trace `meta` mode and in `redactEvent` they become `{len, sha256_8}`.
 */
export const CONTENT_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'tool_input',
  'tool_response',
  'toolUseResult',
  'content',
  'delta',
  'last_assistant_message',
  'lastAssistantMessage',
  'text',
  'input',
  'response',
  'finalText',
  'output',
  'preview',
  'contentPreview',
  'answers',
  'updatedInput',
  'lines',
  'stdout',
  'line',
]);

/** Keys whose values are secrets by name, wherever they appear (values replaced, keys kept). */
const SECRET_KEY_RE =
  /^(token|tokenA|controlToken|hookToken|authToken|accessToken|refreshToken|apiKey|api_key|x-api-key|authorization|proxy-authorization|x-ccd-token|cookie|password|secret)$/i;

export function sha256_8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/** `{len, sha256_8}` summary of a content value (strings by UTF-8 length; other values by their JSON text). */
export function summarize(v: unknown): { len: number; sha256_8: string } {
  const s = typeof v === 'string' ? v : safeJson(v);
  return { len: Buffer.byteLength(s), sha256_8: sha256_8(s) };
}

function safeJson(v: unknown): string {
  try {
    // JSON.stringify returns undefined for undefined / functions / symbols despite its declared type
    const out = JSON.stringify(v) as unknown;
    return typeof out === 'string' ? out : 'undefined';
  } catch {
    return '[unserializable]';
  }
}

export interface Redactor {
  /** Register a secret for exact-match masking (no-op for strings shorter than 8 characters). */
  addSecret(secret: string): void;
  /** The secrets currently masked (count only; never the values). */
  readonly secretCount: number;
  /** The exact secrets, for the in-process fixture scrubber only (never log or serialize this). */
  knownSecrets(): readonly string[];
  /** Exact secrets first, then the pattern list and e-mails. */
  string(s: string): string;
  /** Deep copy with every string redacted and secret-named keys masked. Total: cycles and exotic values are handled. */
  value(v: unknown): JsonValue;
  /** Deep copy for trace `meta` mode: content keys → `{len, sha256_8}`, every other string through `string()`. */
  meta(v: unknown): JsonValue;
  /** Env dump: values masked by name, URL userinfo always masked (SEC §8.2 item 3). Never call with process.env for logging. */
  env(env: Readonly<Record<string, string>>): Record<string, string>;
}

export function createRedactor(o: { secrets?: readonly string[] } = {}): Redactor {
  const secrets = new Set<string>();
  let ordered: string[] = [];
  const add = (s: string): void => {
    if (typeof s !== 'string' || s.length < MIN_SECRET_LEN || secrets.has(s)) return;
    secrets.add(s);
    // longest first, so a secret that contains another is masked whole
    ordered = [...secrets].sort((a, b) => b.length - a.length);
  };
  for (const s of o.secrets ?? []) add(s);

  const str = (s: string): string => {
    let out = s;
    for (const sec of ordered) if (out.includes(sec)) out = out.split(sec).join(REDACTED);
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    out = out.replace(EMAIL_RE, (m) => (/@example\.com$/i.test(m) ? m : EMAIL_FAKE));
    return out;
  };

  const walk = (v: unknown, metaMode: boolean, key: string | undefined, stack: Set<object>): JsonValue => {
    if (key !== undefined && SECRET_KEY_RE.test(key) && v !== undefined && v !== null && v !== '') return REDACTED;
    if (metaMode && key !== undefined && CONTENT_KEYS.has(key) && v !== undefined && v !== null) return summarize(v);
    switch (typeof v) {
      case 'string':
        return str(v);
      case 'number':
        return Number.isFinite(v) ? v : null;
      case 'boolean':
        return v;
      case 'bigint':
        return v.toString(10);
      case 'undefined':
      case 'function':
      case 'symbol':
        return null;
      case 'object':
        break;
    }
    if (v === null) return null;
    const obj = v;
    if (stack.has(obj)) return '[Circular]';
    stack.add(obj);
    try {
      if (Array.isArray(obj)) return (obj as unknown[]).map((x) => walk(x, metaMode, undefined, stack));
      if (obj instanceof Uint8Array)
        return metaMode ? summarize(Buffer.from(obj).toString('utf8')) : str(Buffer.from(obj).toString('utf8'));
      if (obj instanceof Error) return { name: obj.name, message: str(obj.message) };
      if (obj instanceof Map)
        return [...(obj as Map<unknown, unknown>)].map(([k, x]) => [
          walk(k, metaMode, undefined, stack),
          walk(x, metaMode, undefined, stack),
        ]);
      if (obj instanceof Set) return [...(obj as Set<unknown>)].map((x) => walk(x, metaMode, undefined, stack));
      const out: Record<string, JsonValue> = {};
      for (const k of Object.keys(obj)) {
        let x: unknown;
        try {
          x = (obj as Record<string, unknown>)[k];
        } catch {
          continue;
        }
        if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
        out[str(k)] = walk(x, metaMode, k, stack);
      }
      return out;
    } finally {
      stack.delete(obj);
    }
  };

  return {
    addSecret: add,
    get secretCount(): number {
      return secrets.size;
    },
    knownSecrets: () => ordered,
    string: str,
    value: (v) => walk(v, false, undefined, new Set()),
    meta: (v) => walk(v, true, undefined, new Set()),
    env(env) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(env)) {
        if (SENSITIVE_ENV_NAME.test(k)) out[k] = val === '' ? '' : REDACTED;
        else out[k] = str(val.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***:***@'));
      }
      return out;
    },
  };
}

/**
 * P-SEC-41: a host-log-safe copy of a DomainEvent. Content fields (prompt, tool input, assistant text, previews, …) become
 * `{len, sha256_8}`; every other string goes through the pattern redactor. The envelope (seq, type, keys, provenance) is kept.
 */
export function redactEvent(e: DomainEvent, redactor: Redactor = createRedactor()): JsonValue {
  const payload = redactor.meta(e.payload);
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined) continue;
    out[k] = k === 'payload' ? payload : redactor.value(v);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Fixture scrubbing (the `scripts/fixtures-scrub.mjs` forms; ICR 0014 item 5). Used by limit-recorder.ts (§3.9 (b)).

const FIXTURE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/sk-ant-[A-Za-z0-9_-]*/g, 'ANTHROPIC_KEY_REDACTED'],
  [/github_pat_[A-Za-z0-9_]+/g, 'GITHUB_PAT_REDACTED'],
  [/gh[pousr]_[A-Za-z0-9]+/g, 'GITHUB_TOKEN_REDACTED'],
  [/(?:AKIA|ASIA)[0-9A-Z]{4,}/g, 'AWS_KEY_REDACTED'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, 'SLACK_TOKEN_REDACTED'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[PRIVATE KEY REDACTED]'],
  [/BEGIN [A-Z ]*PRIVATE KEY/g, '[PRIVATE KEY REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT_REDACTED'],
  [
    /(authorization|proxy-authorization|x-api-key|cookie|set-cookie|x-ccd-token)(\\?["']?\s*[:=]\s*\\?["']?)(?:(?:basic|bearer|digest|negotiate|ntlm|token)\s+)?[^\s"'\\,;}]+/gi,
    '$1$2REDACTED',
  ],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1REDACTED'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*=\s*)\S+/gi, '$1$2REDACTED'],
  [/proxy-authorization/gi, 'Proxy-Auth-Header'],
  [/x-ccd-token/gi, 'X-Ccd-Header'],
];
const FIX_NONCE_RE = /ccd-selftest-[0-9a-f]{32}/g;
const FIX_HEX_RE = /(?<![0-9a-fA-F])[0-9a-f]{32,}(?![0-9a-fA-F])/g;
const FIX_B64_RE = /[A-Za-z0-9+/]{32,}={0,2}/g;
const FAKE_HEX_RE = /^cafe0+[0-9a-f]{1,8}$/;
const FAKE_B64_RE = /^FAKEb64x+[0-9]{4,}$/;
const FIX_DROP_KEY_RE = /^(x-ccd-token|proxy-authorization)$/i;
const FIX_SECRET_KEY_RE =
  /^(token|tokenA|controlToken|hookToken|authToken|accessToken|refreshToken|apiKey|api_key|x-api-key|authorization|cookie|password|secret)$/i;
const FIX_ID_KEY_RE =
  /^(organizationUuid|organization_uuid|orgUuid|org_uuid|orgId|org_id|organizationId|accountUuid|account_uuid|accountId|account_id|userID|userId|user_id|anonymousId|deviceId|device_id)$/;

function fakeHex(n: number, len: number): string {
  const body = n.toString(16);
  return `cafe${'0'.repeat(Math.max(1, len - 4 - body.length))}${body}`;
}
function fakeB64(n: number, len: number): string {
  const body = String(n).padStart(4, '0');
  return `FAKEb64${'x'.repeat(Math.max(1, len - 7 - body.length))}${body}`;
}

export interface FixtureScrubber {
  string(s: string): string;
  value(v: unknown): JsonValue;
}

/**
 * Per-dump consistent scrubber (same original → same fake). `home`/`user`/`tmp` come from the EnvPort; `tokens` are the
 * library's exact secrets. Mirrors `createScrubber()` of scripts/fixtures-scrub.mjs; the two are kept equal by
 * test/unit/session/limit-recorder.test.ts, which runs the output through the fixture lint rules.
 */
export function createFixtureScrubber(
  o: { home?: string | undefined; user?: string | undefined; tmpDir?: string | undefined; tokens?: readonly string[] } = {},
): FixtureScrubber {
  const tokens = [...new Set(o.tokens ?? [])].filter((t) => t.length >= MIN_SECRET_LEN).sort((a, b) => b.length - a.length);
  const users = new Set<string>();
  if (o.user !== undefined && o.user.length > 1) users.add(o.user);
  const hexMap = new Map<string, string>();
  const b64Map = new Map<string, string>();
  const idMap = new Map<string, string>();
  const tmpPrefixes = [o.tmpDir]
    .filter((t): t is string => t !== undefined && t.length > 1)
    .map((t) => (t.endsWith('/') ? t : `${t}/`))
    .sort((a, b) => b.length - a.length);

  const once = (s: string): string => {
    let out = s;
    for (const t of tokens) if (out.includes(t)) out = out.split(t).join('TOKEN');
    out = out.replace(FIX_NONCE_RE, NONCE_FAKE);
    for (const t of tmpPrefixes) if (out.includes(t)) out = out.split(t).join('/TMP/');
    out = out
      .replace(/\/private\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_+-]+\/[TC]\//g, '/TMP/')
      .replace(/\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_+-]+\/[TC]\//g, '/TMP/')
      .replace(/-private-var-folders-[A-Za-z0-9_]+-[A-Za-z0-9_+]+-[TC]-/g, '-TMP-')
      .replace(/\/private\/tmp\//g, '/TMP/')
      .replace(/(^|[^A-Za-z0-9_/.-])\/tmp\//g, '$1/TMP/')
      .replace(/-private-tmp-/g, '-TMP-');
    if (o.home !== undefined && o.home.length > 1 && out.includes(o.home)) out = out.split(o.home).join('/HOME');
    for (const m of out.matchAll(/\/(?:Users|home)\/([^/\s"'\\]+)/g)) {
      const u = m[1];
      if (u !== undefined && u.length > 1 && u !== 'HOME' && u !== 'user' && u !== 'Shared') users.add(u);
    }
    out = out.replace(/\/(?:Users|home)\/[^/\s"'\\]+/g, '/HOME').replace(/-(?:Users|home)-[A-Za-z0-9_]+-/g, '-HOME-');
    for (const u of users) {
      const esc = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pre = /^\w/.test(u) ? '\\b' : '';
      const post = /\w$/.test(u) ? '\\b' : '';
      out = out.replace(new RegExp(`${pre}${esc}${post}`, 'g'), 'user');
    }
    out = out.replace(EMAIL_RE, (m) => (/@example\.com$/i.test(m) ? m : EMAIL_FAKE));
    for (const [re, rep] of FIXTURE_PATTERNS) out = out.replace(re, rep);
    out = out.replace(FIX_HEX_RE, (m) => {
      if (FAKE_HEX_RE.test(m)) return m;
      let f = hexMap.get(m);
      if (f === undefined) {
        f = fakeHex(hexMap.size + 1, m.length);
        hexMap.set(m, f);
      }
      return f;
    });
    out = out.replace(FIX_B64_RE, (m) => {
      if (!(/[0-9]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m)) || FAKE_B64_RE.test(m)) return m;
      let f = b64Map.get(m);
      if (f === undefined) {
        f = fakeB64(b64Map.size + 1, m.length);
        b64Map.set(m, f);
      }
      return f;
    });
    return out;
  };
  const scrubString = (s: string): string => {
    let cur = s;
    for (let pass = 0; pass < 6; pass++) {
      const next = once(cur);
      if (next === cur) return next;
      cur = next;
    }
    return cur;
  };
  const fakeId = (v: string): string => {
    let f = idMap.get(v);
    if (f === undefined) {
      const n = idMap.size + 1;
      f = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` : `fake-id-${n}`;
      idMap.set(v, f);
    }
    return f;
  };
  const walk = (v: unknown, key: string | undefined, stack: Set<object>): JsonValue => {
    if (typeof v === 'string') {
      if (key !== undefined && FIX_SECRET_KEY_RE.test(key) && v !== '') return 'TOKEN';
      if (key !== undefined && FIX_ID_KEY_RE.test(key)) return fakeId(v);
      return scrubString(v);
    }
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean' || v === null) return v;
    if (typeof v !== 'object') return null;
    if (stack.has(v)) return '[Circular]';
    stack.add(v);
    try {
      if (Array.isArray(v)) return (v as unknown[]).map((x) => walk(x, undefined, stack));
      const out: Record<string, JsonValue> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (FIX_DROP_KEY_RE.test(k) || x === undefined || typeof x === 'function') continue;
        out[scrubString(k)] = walk(x, k, stack);
      }
      return out;
    } finally {
      stack.delete(v);
    }
  };
  return { string: scrubString, value: (v) => walk(v, undefined, new Set()) };
}
