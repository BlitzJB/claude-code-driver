#!/usr/bin/env node
// scripts/fixtures-scrub.mjs — scrub a recorded trace (or any JSONL) before it is committed (DESIGN.md §6.6; SEC §8.4; P-SEC-23,
// P-REV-23). Usage:
//
//   pnpm fixtures:scrub <in.jsonl> <out.jsonl> [--user <name>]... [--token <secret>]...
//
// Rules, applied to every string of every record (keys included), consistently across one file:
//   - home dirs `/Users/<u>`, `/home/<u>` (and their project-slug forms `-Users-<u>-`) → `/HOME`; the user name → `user`;
//   - temp prefixes (`/private/var/folders/…/T/`, `/var/folders/…/T/`, `/private/tmp/`, `/tmp/`, slug forms) → `/TMP/`;
//   - e-mail addresses → `user@example.com`;
//   - organisation / account / user ids (by key name) → fixed fakes, the same original always maps to the same fake;
//   - library secrets → `TOKEN` (exact `--token` values, and the values of token-bearing keys; X-CCD-Token /
//     Proxy-Authorization keys are dropped entirely);
//   - self-test nonces `ccd-selftest-<32 hex>` → `ccd-selftest-NONCE`;
//   - `api-request-blob.message.content` and `api-request-shape.shape.system` are dropped;
//   - `tool_response` / `toolUseResult` larger than 8 KiB are truncated;
//   - the SEC §8.2 pattern redactor;
//   - any remaining run of ≥ 32 hex chars or ≥ 32 base64-like chars → a deterministic fake from the lint allowlist.
// The module also exports `createScrubber()` for scripts/fixtures-from-verify.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_RESPONSE_MAX_BYTES = 8 * 1024;
export const NONCE_FAKE = 'ccd-selftest-NONCE';
export const EMAIL_FAKE = 'user@example.com';

/** Fake forms the lint accepts (keep in sync with fixtures-lint.mjs ALLOW). */
export function fakeHex(n, len) {
  const body = n.toString(16);
  return `cafe${'0'.repeat(Math.max(1, len - 4 - body.length))}${body}`;
}
export function fakeB64(n, len) {
  const body = String(n).padStart(4, '0');
  return `FAKEb64${'x'.repeat(Math.max(1, len - 7 - body.length))}${body}`;
}
export const FAKE_HEX_RE = /^cafe0+[0-9a-f]{1,8}$/;
export const FAKE_B64_RE = /^FAKEb64x+[0-9]{4,}$/;

const SECRET_KEY_RE =
  /^(token|tokenA|controlToken|hookToken|authToken|accessToken|refreshToken|apiKey|api_key|x-api-key|authorization|cookie|password|secret)$/i;
const DROP_KEY_RE = /^(x-ccd-token|proxy-authorization)$/i;
const ID_KEY_RE =
  /^(organizationUuid|organization_uuid|orgUuid|org_uuid|orgId|org_id|organizationId|accountUuid|account_uuid|accountId|account_id|userID|userId|user_id|anonymousId|deviceId|device_id)$/;

/**
 * SEC §8.2 patterns. Fixture scrubbing is stricter than the runtime redactor: every replacement is chosen so that the result
 * never trips a fixtures-lint rule (no `sk-ant-`, `gh?_<alnum>`, `AKIA`, `BEGIN … PRIVATE KEY`, `Proxy-Authorization`,
 * `X-CCD-Token` survive), so `scrub → lint` is always clean for secrets.
 */
const REDACT = [
  [/sk-ant-[A-Za-z0-9_\-]*/g, 'ANTHROPIC_KEY_REDACTED'],
  [/github_pat_[A-Za-z0-9_]+/g, 'GITHUB_PAT_REDACTED'],
  [/gh[pousr]_[A-Za-z0-9]+/g, 'GITHUB_TOKEN_REDACTED'],
  [/(?:AKIA|ASIA)[0-9A-Z]{4,}/g, 'AWS_KEY_REDACTED'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, 'SLACK_TOKEN_REDACTED'],
  // a whole key block, or (truncated tool output, a bare marker) everything from BEGIN to the end of the string
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[PRIVATE KEY REDACTED]'],
  [/BEGIN [A-Z ]*PRIVATE KEY/g, '[PRIVATE KEY REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT_REDACTED'],
  // credential-bearing headers, also inside JSON-in-a-string (`"Proxy-Authorization":"Basic …"`): the auth scheme and the
  // credential both go, whatever the scheme (Basic, Bearer, Digest, …)
  [
    /(authorization|proxy-authorization|x-api-key|cookie|set-cookie|x-ccd-token)(\\?["']?\s*[:=]\s*\\?["']?)(?:(?:basic|bearer|digest|negotiate|ntlm|token)\s+)?[^\s"'\\,;}]+/gi,
    '$1$2REDACTED',
  ],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1REDACTED'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*=\s*)\S+/gi, '$1$2REDACTED'],
  // header names the lint forbids anywhere in a fixture (their values are already gone above)
  [/proxy-authorization/gi, 'Proxy-Auth-Header'],
  [/x-ccd-token/gi, 'X-Ccd-Header'],
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NONCE_RE = /ccd-selftest-[0-9a-f]{32}/g;
const HEX_RE = /(?<![0-9a-fA-F])[0-9a-f]{32,}(?![0-9a-fA-F])/g;
const B64_RE = /[A-Za-z0-9+/]{32,}={0,2}/g;

function isB64Candidate(s) {
  return /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

/**
 * A scrubber with per-file consistent fake maps.
 * @param {{ users?: string[]; tokens?: string[] }} [o]
 */
export function createScrubber(o = {}) {
  const users = new Set((o.users ?? []).filter((u) => u.length > 1));
  const tokens = (o.tokens ?? []).filter((t) => t.length >= 8);
  const hexMap = new Map();
  const b64Map = new Map();
  const idMap = new Map();

  // same character class as the fixtures-lint `home-path` rule, so nothing the lint would flag survives
  const homeRe = () => /\/(?:Users|home)\/([^/\s"'\\]+)/g;

  // A learned name is replaced as a word everywhere, so one-letter names (`/home/a`) are not learned (the path itself is still
  // rewritten to /HOME); the same length rule as `--user`.
  const NOT_USERS = new Set(['HOME', 'user', 'Shared']);
  function learnUsers(text) {
    for (const m of text.matchAll(homeRe())) if (m[1].length > 1 && !NOT_USERS.has(m[1])) users.add(m[1]);
    for (const m of text.matchAll(/-(?:Users|home)-([A-Za-z0-9_]+)-/g)) if (m[1].length > 1 && !NOT_USERS.has(m[1])) users.add(m[1]);
  }

  // One replacement can create a new match for an earlier rule (an e-mail glued to a base64 run becomes
  // `user@example.FAKEb64…`), so the rules run to a fixed point (bounded; in practice ≤ 3 passes).
  function scrubString(s) {
    let cur = s;
    for (let pass = 0; pass < 6; pass++) {
      const next = scrubOnce(cur);
      if (next === cur) return next;
      cur = next;
    }
    return cur;
  }

  function scrubOnce(s) {
    let out = s;
    for (const t of tokens) out = out.split(t).join('TOKEN');
    out = out.replace(NONCE_RE, NONCE_FAKE);
    // temp prefixes first (they can contain the user's home in slug form)
    out = out
      .replace(/\/private\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_+-]+\/[TC]\//g, '/TMP/')
      .replace(/\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_+-]+\/[TC]\//g, '/TMP/')
      .replace(/-private-var-folders-[A-Za-z0-9_]+-[A-Za-z0-9_+]+-[TC]-/g, '-TMP-')
      .replace(/\/private\/tmp\//g, '/TMP/')
      .replace(/(^|[^A-Za-z0-9_/.-])\/tmp\//g, '$1/TMP/')
      .replace(/-private-tmp-/g, '-TMP-');
    out = out.replace(homeRe(), '/HOME').replace(/-(?:Users|home)-[A-Za-z0-9_]+-/g, '-HOME-');
    for (const u of users) {
      const esc = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // word boundaries only where the name itself starts/ends with a word character (`\b` never matches around `+x`)
      const pre = /^\w/.test(u) ? '\\b' : '';
      const post = /\w$/.test(u) ? '\\b' : '';
      out = out.replace(new RegExp(`${pre}${esc}${post}`, 'g'), 'user');
    }
    out = out.replace(EMAIL_RE, (m) => (/@example\.com$/i.test(m) ? m : EMAIL_FAKE));
    for (const [re, rep] of REDACT) out = out.replace(re, rep);
    out = out.replace(HEX_RE, (m) => {
      if (FAKE_HEX_RE.test(m)) return m;
      if (!hexMap.has(m)) hexMap.set(m, fakeHex(hexMap.size + 1, m.length));
      return hexMap.get(m);
    });
    out = out.replace(B64_RE, (m) => {
      if (!isB64Candidate(m) || FAKE_B64_RE.test(m)) return m;
      if (!b64Map.has(m)) b64Map.set(m, fakeB64(b64Map.size + 1, m.length));
      return b64Map.get(m);
    });
    return out;
  }

  function fakeId(v) {
    if (!idMap.has(v)) {
      const n = idMap.size + 1;
      idMap.set(v, /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` : `fake-id-${n}`);
    }
    return idMap.get(v);
  }

  function truncateIfLarge(v) {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    if (text === undefined || Buffer.byteLength(text) <= TOOL_RESPONSE_MAX_BYTES) return v;
    return `${text.slice(0, TOOL_RESPONSE_MAX_BYTES)}…[truncated ${Buffer.byteLength(text) - TOOL_RESPONSE_MAX_BYTES} bytes]`;
  }

  function walk(v, key) {
    if (typeof v === 'string') {
      if (key !== undefined && SECRET_KEY_RE.test(key) && v !== '') return 'TOKEN';
      if (key !== undefined && ID_KEY_RE.test(key)) return fakeId(v);
      return scrubString(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, undefined));
    if (v === null || typeof v !== 'object') return v;
    // structural drops (§6.6)
    if (v.type === 'api-request-blob' && v.message !== null && typeof v.message === 'object')
      v = { ...v, message: { ...v.message, content: '[dropped]' } };
    if (v.type === 'api-request-shape' && v.shape !== null && typeof v.shape === 'object')
      v = { ...v, shape: { ...v.shape, system: '[dropped]' } };
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEY_RE.test(k)) continue;
      const value = k === 'tool_response' || k === 'toolUseResult' ? truncateIfLarge(x) : x;
      out[scrubString(k)] = walk(value, k);
    }
    return out;
  }

  return {
    users,
    /** Learn user names from raw text before scrubbing (home paths, project slugs). */
    learn(text) {
      learnUsers(text);
    },
    string: scrubString,
    value: (v) => walk(v, undefined),
    /** Scrub one JSONL line (non-JSON lines are scrubbed as text). */
    line(text) {
      if (text.trim() === '') return text;
      try {
        return JSON.stringify(walk(JSON.parse(text), undefined));
      } catch {
        return scrubString(text);
      }
    },
  };
}

/** Scrub a whole JSONL text. */
export function scrubText(text, o = {}) {
  const s = createScrubber(o);
  s.learn(text);
  return text
    .split('\n')
    .map((l) => s.line(l))
    .join('\n');
}

function parseArgs(argv) {
  const files = [];
  const users = [];
  const tokens = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') users.push(argv[++i] ?? '');
    else if (a === '--token') tokens.push(argv[++i] ?? '');
    else files.push(a);
  }
  return { files, users, tokens };
}

function main() {
  const { files, users, tokens } = parseArgs(process.argv.slice(2));
  if (files.length !== 2) {
    process.stderr.write('usage: fixtures-scrub <in.jsonl> <out.jsonl> [--user <name>]... [--token <secret>]...\n');
    process.exit(2);
  }
  const [input, output] = files;
  const envUser = process.env.USER;
  const text = readFileSync(input, 'utf8');
  const out = scrubText(text, { users: envUser === undefined ? users : [...users, envUser], tokens });
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, out);
  process.stdout.write(`scrubbed ${input} → ${output}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
