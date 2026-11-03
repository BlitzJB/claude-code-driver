// channels/screen/normalize-text.ts (WP-07; DESIGN.md §2.8, screen-parse.md §8). Pitfalls: P-SCREEN-11 (NBSP family),
// P-SCREEN-16 (SGR state across soft-wrapped rows), P-SCREEN-17 (OSC 8 stripped before CSI), no NFKC (SP §8.2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hasEscapes, hashText, normalizeLine, normalizeStyledLines } from '../../../src/channels/screen/normalize-text.js';

describe('normalizeLine', () => {
  it('maps U+00A0, U+202F, U+2007 to a space and right-trims (P-SCREEN-11)', () => {
    expect(normalizeLine('  ⎿  Tip: x   ')).toBe('  ⎿  Tip: x');
    expect(normalizeLine('done 2:24 AM')).toBe('done 2:24 AM');
    expect(normalizeLine('a b')).toBe('a b');
    expect(normalizeLine('❯ ')).toBe('❯');
  });

  it('strips OSC (BEL or ST) before CSI so an OSC body with `[` is not misparsed (P-SCREEN-17)', () => {
    expect(normalizeLine('\x1b]8;;https://x.test/[a]\x1b\\link\x1b]8;;\x1b\\ end')).toBe('link end');
    expect(normalizeLine('\x1b]0;title [x]\x07text')).toBe('text');
    expect(normalizeLine('\x1b[38;2;215;119;87m✻\x1b[39m \x1b[1mWorking…\x1b[0m')).toBe('✻ Working…');
  });

  it('strips other escapes, DCS strings and C0/C1 controls but keeps tabs', () => {
    expect(normalizeLine('\x1b(Ba\x1b=b\x1bPq#0;1\x1b\\c\x07\x08\u0085d\te')).toBe('abcd\te');
    expect(normalizeLine('trailing lone escape \x1b')).toBe('trailing lone escape');
  });

  it('never NFKC-normalizes: … and precomposed é survive (SP §8.2)', () => {
    expect(normalizeLine('✻ Sautéed… Flambéing…')).toBe('✻ Sautéed… Flambéing…');
  });

  it('is total and idempotent on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const n = normalizeLine(s);
        expect(normalizeLine(n)).toBe(n);
        expect(n).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f   ]/u);
      }),
      { numRuns: 500 },
    );
  });
});

describe('normalizeStyledLines (-e captures)', () => {
  it('drops dim runs from `undimmed` and flags them', () => {
    const [l] = normalizeStyledLines(['\x1b[0m❯ \x1b[2msave it to a file\x1b[0m']);
    expect(l).toEqual({ text: '❯ save it to a file', undimmed: '❯', hasDim: true });
  });

  it('carries the dim attribute across soft-wrapped rows that tmux does not re-prefix (P-SCREEN-16)', () => {
    const rows = normalizeStyledLines(['\x1b[2mdim begins', 'still dim/10', '\x1b[22mbright', 'bright too']);
    expect(rows.map((r) => r.undimmed)).toEqual(['', '', 'bright', 'bright too']);
    expect(rows.map((r) => r.hasDim)).toEqual([true, true, false, false]);
  });

  it('reads RGB colour arguments without mistaking a `2` for dim; SGR 8 (hidden) counts as non-text', () => {
    const [a, b] = normalizeStyledLines(['\x1b[38;2;2;2;2mred-ish\x1b[0m', '\x1b[8msecret\x1b[28m shown']);
    expect(a?.undimmed).toBe('red-ish');
    expect(b?.undimmed).toBe(' shown');
    expect(b?.text).toBe('secret shown');
  });

  it('equals the plain normalization when there is no escape', () => {
    expect(hasEscapes(['a', 'b'])).toBe(false);
    expect(hasEscapes(['a', '\x1b[0m'])).toBe(true);
    expect(normalizeStyledLines(['x  '])).toEqual([{ text: 'x', undimmed: 'x', hasDim: false }]);
  });
});

describe('hashText', () => {
  it('is deterministic, hex, seed-sensitive and content-sensitive', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).toMatch(/^[0-9a-f]{14}$/u);
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('abc', 1)).not.toBe(hashText('abc'));
  });
});
