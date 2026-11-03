// channels/screen/normalize-text.ts — capture text normalization (DESIGN.md §1.2, §2.8; screen-parse.md §8).
// Pure. Strips OSC (before CSI, so an OSC body with `[` is not misparsed, P-SCREEN-17), CSI, other ESC sequences and C0/C1
// controls; maps U+00A0, U+202F, U+2007 to a space (P-SCREEN-11); right-trims. No NFC/NFKC (`…` must stay `…`, `é` stays
// precomposed, SP §8.2). For `-e` captures a stateful SGR tracker carries the dim attribute across lines, because tmux does not
// re-emit attributes on soft-wrapped continuations (P-SCREEN-16), so ghost/placeholder text (dim) can be told from typed text.

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;

const STRING_SEQ = /\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)/gu; // DCS / APC / PM / SOS

const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/gu;

const OTHER_ESC = /\x1b[ -/]*[0-~]?/gu; // 2-char and nF escapes; a lone trailing ESC too

const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/gu;
const SPACES = /[   ]/gu;
const TRAILING_WS = /\s+$/u;

/** One captured line → plain text (no escapes, no controls, NBSP family → space, right-trimmed). Never throws. */
export function normalizeLine(raw: string): string {
  return raw
    .replace(OSC, '')
    .replace(STRING_SEQ, '')
    .replace(CSI, '')
    .replace(OTHER_ESC, '')
    .replace(CONTROLS, '')
    .replace(SPACES, ' ')
    .replace(TRAILING_WS, '');
}

/** True when any line carries an ESC (a `capture-pane -e` capture). */
export function hasEscapes(lines: readonly string[]): boolean {
  return lines.some((l) => l.includes('\x1b'));
}

export interface StyledLine {
  /** Same as `normalizeLine(raw)`. */
  text: string;
  /** The text with every SGR-dim (or SGR-hidden) run removed, then normalized the same way. */
  undimmed: string;
  /** True when at least one visible non-space character of the line is dim. */
  hasDim: boolean;
}

const TOKEN = /\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]?/gu;

function applySgr(params: string, state: { dim: boolean; hidden: boolean }): void {
  const parts = params === '' ? ['0'] : params.split(/[;:]/u);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i] === '' ? '0' : parts[i]);
    if (n === 0) {
      state.dim = false;
      state.hidden = false;
    } else if (n === 2) state.dim = true;
    else if (n === 22) state.dim = false;
    else if (n === 8) state.hidden = true;
    else if (n === 28) state.hidden = false;
    else if (n === 38 || n === 48 || n === 58) {
      // extended colour: skip its arguments (5;n or 2;r;g;b) so a `2` inside an RGB triple is not read as dim
      const mode = Number(parts[i + 1]);
      i += mode === 5 ? 2 : mode === 2 ? 4 : 1;
    }
  }
}

/**
 * `-e` capture → per-line text plus the non-dim text, with SGR state carried across lines (P-SCREEN-16). For a capture without
 * escapes `undimmed === text` and `hasDim === false`.
 */
export function normalizeStyledLines(raw: readonly string[]): StyledLine[] {
  const state = { dim: false, hidden: false };
  const out: StyledLine[] = [];
  for (const line of raw) {
    let plain = '';
    let visible = '';
    let hasDim = false;
    let last = 0;
    TOKEN.lastIndex = 0;
    const take = (chunk: string): void => {
      plain += chunk;
      if (state.dim || state.hidden) {
        if (/\S/u.test(chunk.replace(SPACES, ' '))) hasDim = true;
      } else visible += chunk;
    };
    for (let m = TOKEN.exec(line); m !== null; m = TOKEN.exec(line)) {
      take(line.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[3] === 'm' && m[2] === '') applySgr(m[1] ?? '', state);
      if (m[0].length === 0) TOKEN.lastIndex++; // defensive: never loop on an empty match
    }
    take(line.slice(last));
    out.push({ text: normalizeLine(plain), undimmed: normalizeLine(visible), hasDim });
  }
  return out;
}

/**
 * Deterministic 53-bit string hash (cyrb53), hex-encoded. Used for `frameHash`; collisions only cost one dropped frame.
 * Pure: no `node:crypto` (L1 stays I/O- and platform-free).
 */
export function hashText(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}
