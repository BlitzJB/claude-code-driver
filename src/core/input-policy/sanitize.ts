// core/input-policy/sanitize.ts — the pure text sanitizer every input path goes through (DESIGN.md D-16, §3.6 step 1;
// SEC §3.4, IN §4; ICR 0001 items 1–2 from the Phase-0 probes LP-45).
//
// Order: lone surrogates → NFC → CRLF → C0/DEL/C1 strip (keeps \n \t) → standalone invisibles → trailing-backslash space →
// empty → leading slash → mentions → size → `!` prefix escape.

import type { CcdErrorCode } from '../../model/errors.js';

export type SanitizeResult =
  | { ok: true; text: string; changed: boolean; removed: number }
  | { ok: false; code: Extract<CcdErrorCode, 'E_INPUT_REJECTED' | 'E_INPUT_INVALID'>; reason: string };

export interface SanitizeOptions {
  maxPromptBytes: number;
  mentions: 'allow' | 'reject';
}

const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_G = new RegExp(LONE_SURROGATE_RE.source, 'g');
const PICTO_RE = /\p{Extended_Pictographic}/u;

const BIDI = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const BLACK_FLAG = 0x1f3f4;
const TAG_CANCEL = 0xe007f;

function isTag(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f;
}
function isSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0x180b && cp <= 0x180d) || cp === 0x180f;
}
function isEmojiModifier(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}
function isPicto(cp: number | undefined): boolean {
  return cp !== undefined && PICTO_RE.test(String.fromCodePoint(cp));
}
function isKeycapBase(cp: number | undefined): boolean {
  return cp !== undefined && ((cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a);
}

/**
 * Strip standalone invisibles (IN §4.6): tags, bidi controls, zero-width characters and variation selectors — keeping ZWJ
 * and VS15/VS16 inside emoji sequences (`👩‍💻`, `❤️`, keycaps `1️⃣`) and tag runs of subdivision flags (`🏴…`).
 */
export function stripStandaloneInvisibles(s: string): string {
  const cps = Array.from(s, (c) => c.codePointAt(0) ?? 0);
  const out: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i] ?? 0;
    const prev = out[out.length - 1];
    const next = cps[i + 1];
    if (BIDI.has(cp)) continue;
    if (ZERO_WIDTH.has(cp)) {
      if (cp === ZWJ && prev !== undefined && (isPicto(prev) || isEmojiModifier(prev) || prev === VS16) && isPicto(next)) out.push(cp);
      continue;
    }
    if (isSelector(cp)) {
      if ((cp === VS16 || cp === VS15) && prev !== undefined && (isPicto(prev) || (isKeycapBase(prev) && next === KEYCAP))) out.push(cp);
      continue;
    }
    if (isTag(cp)) {
      // keep a complete tag run (… U+E007F) that follows U+1F3F4 (subdivision flag sequence)
      let j = i;
      while (j < cps.length && isTag(cps[j] ?? 0) && cps[j] !== TAG_CANCEL) j++;
      const complete = j < cps.length && cps[j] === TAG_CANCEL && j > i;
      if (prev === BLACK_FLAG && complete) {
        for (let k = i; k <= j; k++) out.push(cps[k] ?? 0);
        i = j;
        continue;
      }
      // drop the run (and a stray cancel tag ending it)
      i = j < cps.length && cps[j] === TAG_CANCEL ? j : j - 1;
      continue;
    }
    out.push(cp);
  }
  return fromCodePoints(out);
}

/** `String.fromCodePoint` over an array of any length: spreading one argument per code point overflows the stack. */
function fromCodePoints(cps: readonly number[]): string {
  const CHUNK = 4096;
  const parts: string[] = [];
  for (let i = 0; i < cps.length; i += CHUNK) parts.push(String.fromCodePoint(...cps.slice(i, i + CHUNK)));
  return parts.join('');
}

export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Shared cleaning for every text path (prompt, command args, permission messages). */
function cleanText(input: string): { text: string; removed: number } | { error: 'loneSurrogate' } {
  if (LONE_SURROGATE_RE.test(input)) return { error: 'loneSurrogate' };
  let t = input.normalize('NFC').replace(/\r\n?/g, '\n');
  const before = t.length;
  t = t.replace(CONTROL_RE, '');
  t = stripStandaloneInvisibles(t);
  return { text: t, removed: before - t.length };
}

/**
 * D-16 / §3.6 step 1 (ICR 0001): strip C0 except `\n\t`, DEL, C1 and standalone invisibles; reject lone surrogates;
 * trailing `\` on a line gets one space (TUI §2); reject a prompt whose `trim()` starts with `/` (LP-45 VERIFIED-LIVE:
 * idle submit keeps the leading space and sends a prompt, but the busy/immediate path trims and runs `local`/`local-jsx`
 * immediate commands, so a leading space is not a safe escape); prefix-escape only a leading `!` with one ASCII space
 * (bracketed paste of `!x` enters shell mode, LP-45; `? & #` are left alone); reject empty and oversize prompts.
 */
export function sanitizePrompt(text: string, o: SanitizeOptions): SanitizeResult {
  if (typeof text !== 'string') return { ok: false, code: 'E_INPUT_INVALID', reason: 'notString' };
  const c = cleanText(text);
  if ('error' in c) return { ok: false, code: 'E_INPUT_INVALID', reason: c.error };
  let t = c.text;
  t = t
    .split('\n')
    .map((line) => (line.endsWith('\\') ? `${line} ` : line))
    .join('\n');
  if (t.trim() === '') return { ok: false, code: 'E_INPUT_INVALID', reason: 'empty' };
  if (t.trim().startsWith('/')) return { ok: false, code: 'E_INPUT_REJECTED', reason: 'leadingSlash' };
  if (o.mentions === 'reject' && /(^|\s)@\S/.test(t)) return { ok: false, code: 'E_INPUT_REJECTED', reason: 'mention' };
  if (t.startsWith('!')) t = ` ${t}`;
  if (utf8Bytes(t) > o.maxPromptBytes) return { ok: false, code: 'E_INPUT_INVALID', reason: 'tooLarge' };
  return { ok: true, text: t, changed: t !== text, removed: c.removed };
}

/** Command arguments: single line, tabs → space, no prefix escape (§3.6 Commands), ≤ 4 KiB. */
export function sanitizeCommandArgs(args: string): SanitizeResult {
  if (typeof args !== 'string') return { ok: false, code: 'E_INPUT_INVALID', reason: 'notString' };
  const c = cleanText(args);
  if ('error' in c) return { ok: false, code: 'E_INPUT_INVALID', reason: c.error };
  const t = c.text.replace(/\t/g, ' ');
  if (t.includes('\n')) return { ok: false, code: 'E_INPUT_INVALID', reason: 'multiline' };
  if (utf8Bytes(t) > 4096) return { ok: false, code: 'E_INPUT_INVALID', reason: 'tooLarge' };
  // a trailing `\` would turn the Enter that runs the staged command into a newline (TUI §2, P-TUI-06): one space, as for
  // prompts; applied after trim() so the space that protected it is not lost (ICR 0021 item 7)
  let out = t.trim();
  if (out.endsWith('\\')) out = `${out} `;
  return { ok: true, text: out, changed: t !== args || out !== t.trim(), removed: c.removed };
}

/** Permission deny/feedback messages (§3.7 step 4): control chars stripped, ≤ 2 KiB (cut on a code point). */
export function sanitizeMessage(msg: string, maxBytes = 2048): string {
  // bound the work before cleaning: a deny message can be a whole log, and only the first maxBytes survive anyway (the
  // margin leaves room for removed controls/invisibles; a pair cut at the end becomes a lone surrogate, removed below)
  const bounded = msg.length > maxBytes * 4 ? msg.slice(0, maxBytes * 4) : msg;
  const c = cleanText(bounded.replace(LONE_SURROGATE_G, ''));
  const t = 'error' in c ? '' : c.text;
  let out = '';
  let n = 0;
  for (const ch of t) {
    const b = utf8Bytes(ch);
    if (n + b > maxBytes) break;
    out += ch;
    n += b;
  }
  return out;
}

/**
 * Bracketed-paste chunks for the pasteChunks fallback (D-15, §3.6): ≤ `maxBytes` bytes and ≤ `maxLf` LF each, split on
 * code-point boundaries (never inside a surrogate pair).
 */
export function chunkForPaste(text: string, maxBytes: number, maxLf = 2): string[] {
  const chunks: string[] = [];
  let cur = '';
  let bytes = 0;
  let lfs = 0;
  for (const ch of text) {
    const b = utf8Bytes(ch);
    const lf = ch === '\n' ? 1 : 0;
    if (cur !== '' && (bytes + b > maxBytes || lfs + lf > maxLf)) {
      chunks.push(cur);
      cur = '';
      bytes = 0;
      lfs = 0;
    }
    cur += ch;
    bytes += b;
    lfs += lf;
  }
  if (cur !== '') chunks.push(cur);
  return chunks;
}
