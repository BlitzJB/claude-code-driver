// core/input-policy/ack-match.ts — UserPromptSubmit ack matching and classification (DESIGN.md §3.6 step 5, IN §7.2;
// LP-54 VERIFIED: Claude trims only trailing whitespace at the end and keeps leading whitespace, CR, NFD and @mentions).

import type { PromptOrigin } from '../../model/observation.js';

const PASTED_OPEN_RE = /\n*<pasted_content id="[^"]+">\n/g;
const PASTED_CLOSE_RE = /\n<\/pasted_content id="[^"]+">\n*/g;

/** Remove the `<pasted_content id="…">` wrappers Claude adds around collapsed pastes (IN §3.2, P-INPUT-14). */
export function stripPastedContentWrappers(s: string): string {
  return s.replace(PASTED_OPEN_RE, '').replace(PASTED_CLOSE_RE, '');
}

/** NFC, CRLF → LF, wrapper strip, trailing whitespace trimmed per line and at the end; leading whitespace kept (P-INPUT-11). */
export function normalizeForAck(s: string): string {
  const t = stripPastedContentWrappers(s.normalize('NFC').replace(/\r\n?/g, '\n'));
  return t
    .split('\n')
    .map((l) => l.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/\s+$/u, '');
}

export function ackMatches(got: string, sent: string): boolean {
  return normalizeForAck(got) === normalizeForAck(sent);
}

export type ExternalOrigin = Extract<PromptOrigin, 'task_notification' | 'scheduled' | 'peer_message' | 'bash_mode'>;

/** §3.6 step 5.2: prompt shapes that are never ours (classified before any text comparison, rev 2 §10 A3). */
export function classifyExternalShape(text: string, hasTaskNotification = false): ExternalOrigin | undefined {
  const t = text.trimStart();
  if (hasTaskNotification || t.startsWith('<task-notification>')) return 'task_notification';
  if (t.startsWith('<scheduled') || t.slice(0, 512).includes('wakeupSource')) return 'scheduled';
  if (t.startsWith('<peer-message') || t.startsWith('<cross-session') || t.startsWith('<inbound-message')) return 'peer_message';
  if (t.startsWith('<bash-input>')) return 'bash_mode';
  return undefined;
}

export type AckVerdict =
  | { kind: 'selftest'; nonce: string }
  | { kind: 'external'; origin: ExternalOrigin }
  | { kind: 'match' }
  | { kind: 'mismatch'; detail: { sentSha256_16: string; gotSha256_16: string; editDistanceBucket: string } }
  | { kind: 'unsolicited' };

export interface AckContext {
  /** the armed nonce and recently used ones */
  nonces: readonly string[];
  /** our in-flight submit's sanitized text (one submit at a time, §3.6) */
  sent?: string | undefined;
  hasTaskNotification?: boolean;
}

/** §3.6 step 5, in order: (1) self-test nonce, (2) known external shape, (3) match, (4) mismatch. */
export function classifyAck(text: string, c: AckContext): AckVerdict {
  const n = normalizeForAck(text);
  for (const nonce of c.nonces) if (n === normalizeForAck(nonce)) return { kind: 'selftest', nonce };
  const ext = classifyExternalShape(text, c.hasTaskNotification === true);
  if (ext !== undefined) return { kind: 'external', origin: ext };
  if (c.sent === undefined) return { kind: 'unsolicited' };
  if (n === normalizeForAck(c.sent)) return { kind: 'match' };
  return {
    kind: 'mismatch',
    detail: {
      sentSha256_16: sha256Hex(c.sent).slice(0, 16),
      gotSha256_16: sha256Hex(text).slice(0, 16),
      editDistanceBucket: editDistanceBucket(c.sent, text),
    },
  };
}

/** Bounded Levenshtein distance bucket (texts above 2000 code points compare their first 2000). */
export function editDistanceBucket(a: string, b: string): string {
  const x = Array.from(normalizeForAck(a)).slice(0, 2000);
  const y = Array.from(normalizeForAck(b)).slice(0, 2000);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  const dist = prev[y.length] ?? 0;
  if (dist === 0) return '0';
  if (dist <= 2) return '1-2';
  if (dist <= 10) return '3-10';
  if (dist <= 100) return '11-100';
  return '>100';
}

// ---- pure SHA-256 (core may not use node:crypto, D-03); used only for digests in alerts ----
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

/** Read a typed-array slot that is in range by construction (index < length is guaranteed by the loops below). */
const at = (a: Uint32Array | Uint8Array, i: number): number => a[i] ?? 0;

export function sha256Hex(s: string): string {
  const raw = utf8(s);
  const bitLen = raw.length * 8;
  const total = Math.ceil((raw.length + 9) / 64) * 64;
  const bytes = new Uint8Array(total);
  bytes.set(raw);
  bytes[raw.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = at(w, i - 15);
      const w2 = at(w, i - 2);
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (at(w, i - 16) + s0 + at(w, i - 7) + s1) >>> 0;
    }
    const v = Array.from(h);
    for (let i = 0; i < 64; i++) {
      const [a, b, c, d, e, f, g, hh] = v as [number, number, number, number, number, number, number, number];
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + at(K, i) + at(w, i)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      v.splice(0, 8, (t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g);
    }
    for (let i = 0; i < 8; i++) h[i] = (at(h, i) + (v[i] ?? 0)) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/** FNV-1a 32-bit over the UTF-16 code units' UTF-8 bytes (deterministic usage-wake jitter, §3.9). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of utf8(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
