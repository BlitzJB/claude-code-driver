// core/input-policy/sanitize.ts — D-16, §3.6 step 1, SEC §3.4 vectors, IN §4.6 invisibles, ICR 0001 items 1–2 (LP-45).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SanitizeOptions } from '../../../src/core/input-policy/sanitize.js';
import {
  chunkForPaste,
  sanitizeCommandArgs,
  sanitizeMessage,
  sanitizePrompt,
  stripStandaloneInvisibles,
  utf8Bytes,
} from '../../../src/core/input-policy/sanitize.js';

const opts: SanitizeOptions = { maxPromptBytes: 100_000, mentions: 'allow' };
const ok = (s: string): string => {
  const r = sanitizePrompt(s, opts);
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(s)}: ${r.reason}`);
  return r.text;
};
const rejected = (s: string, o = opts): string => {
  const r = sanitizePrompt(s, o);
  if (r.ok) throw new Error(`expected rejection for ${JSON.stringify(s)}`);
  return `${r.code}:${r.reason}`;
};

describe('sanitizePrompt — leading slash (P-INPUT-01, P-REV-01, K-48, LP-45)', () => {
  // LP-45 VERIFIED-LIVE: idle submit keeps the leading space and sends a prompt, but the busy/immediate path trims and
  // runs local/local-jsx immediate commands, so a leading space is not a safe escape: reject.
  it.each(['/permissions', ' /permissions', '/cost', ' /cost', '  /cost', '\t/cost', '\n/cost', ' /cost now', '/exit'])(
    'rejects %j as leadingSlash',
    (s) => {
      expect(rejected(s)).toBe('E_INPUT_REJECTED:leadingSlash');
    },
  );
  it('allows a slash later in the text', () => {
    expect(ok('use a/b path')).toBe('use a/b path');
  });
});

describe('sanitizePrompt — prefix escape only for ! (ICR 0001 item 2, P-INPUT-04, P-SEC-07)', () => {
  it('escapes a leading ! with one ASCII space (bracketed paste of !x enters shell mode)', () => {
    expect(ok('!rm -rf ~')).toBe(' !rm -rf ~');
    expect(ok('!x')).toBe(' !x');
  });
  it.each(['?x', '&x', '#x', '?', '#note', '&note'])('leaves %j unchanged (P-INPUT-05, P-INPUT-07)', (s) => {
    expect(ok(s)).toBe(s);
  });
  it('does not double-escape an already spaced !', () => {
    expect(ok(' !x')).toBe(' !x');
  });
});

describe('sanitizePrompt — control characters (P-INPUT-09, P-SEC-06)', () => {
  it.each<[string, string]>([
    ['\x1b[Z', '[Z'],
    ['a\x03b', 'ab'],
    ['x\x1b]52;c;aGVsbG8=\x07y', 'x]52;c;aGVsbG8=y'],
    ['a\u0000b', 'ab'],
    ['a\x7fb', 'ab'],
    ['a\u009bb', 'ab'],
    ['line1\r\nline2\rline3', 'line1\nline2\nline3'],
  ])('%j → %j', (input, want) => {
    expect(ok(input)).toBe(want);
  });
  it('rejects text that is empty after stripping (\\x1b\\x1b)', () => {
    expect(rejected('\x1b\x1b')).toBe('E_INPUT_INVALID:empty');
    expect(rejected('   \n ')).toBe('E_INPUT_INVALID:empty');
  });
  it('a 100 KB prompt with ESC[201~ at the end loses the ESC (bracketed-paste breakout)', () => {
    const t = ok(`${'a'.repeat(99_990)}\x1b[201~`);
    expect(t.includes('\x1b')).toBe(false);
    expect(t.endsWith('[201~')).toBe(true);
  });
  it('keeps \\n and \\t (P-INPUT-10: the editor path preserves tabs)', () => {
    expect(ok('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('sanitizePrompt — invisibles (P-INPUT-08, IN §4.6)', () => {
  it.each<[string, string]>([
    ['a​b', 'ab'],
    ['a⁠b﻿', 'ab'],
    ['a‮b', 'ab'],
    ['a⁦b⁩', 'ab'],
    ['a؜b‎‏', 'ab'],
    ['a️b', 'ab'],
    ['a\u{e0041}b', 'ab'],
    ['a᠎b', 'a᠎b'],
  ])('%j → %j', (input, want) => {
    expect(ok(input)).toBe(want);
  });
  it('rejects a lone RLO (empty after strip)', () => {
    expect(rejected('‮')).toBe('E_INPUT_INVALID:empty');
  });
  it.each(['👩‍💻', '❤️', '1️⃣', '👩🏽‍💻', '🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'])('keeps emoji sequence %j intact', (e) => {
    expect(ok(`x ${e} y`)).toBe(`x ${e} y`);
    expect(stripStandaloneInvisibles(e)).toBe(e);
  });
  it('drops a stray tag run that does not follow a black flag', () => {
    expect(stripStandaloneInvisibles('a\u{e0067}\u{e0062}\u{e007f}b')).toBe('ab');
  });
});

describe('sanitizePrompt — other rules', () => {
  it('appends one space after a trailing backslash on any line (P-TUI-06)', () => {
    expect(ok('a\\\nb\\')).toBe('a\\ \nb\\ ');
  });
  it('rejects lone surrogates (P-TMUX-52)', () => {
    expect(rejected('a\ud800b')).toBe('E_INPUT_INVALID:loneSurrogate');
    expect(rejected('\udc00')).toBe('E_INPUT_INVALID:loneSurrogate');
  });
  it('rejects prompts over maxPromptBytes (P-TMUX-51)', () => {
    expect(rejected('a'.repeat(100_001))).toBe('E_INPUT_INVALID:tooLarge');
    expect(rejected('é'.repeat(50_001))).toBe('E_INPUT_INVALID:tooLarge');
    expect(ok('a'.repeat(100_000)).length).toBe(100_000);
  });
  it("mentions:'reject' refuses @path (P-INPUT-06, P-SEC-37)", () => {
    const r: SanitizeOptions = { ...opts, mentions: 'reject' };
    expect(rejected('look at @src/x.ts', r)).toBe('E_INPUT_REJECTED:mention');
    expect(rejected('@README', r)).toBe('E_INPUT_REJECTED:mention');
    expect(sanitizePrompt('mail a@b.com', r).ok).toBe(true);
    expect(ok('look at @src/x.ts')).toBe('look at @src/x.ts');
  });
  it('normalizes to NFC', () => {
    expect(ok('é')).toBe('é');
  });
  it('is idempotent on its own output (property)', () => {
    expect(() => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (s) => {
          const r = sanitizePrompt(s, opts);
          if (!r.ok) return true;
          const again = sanitizePrompt(r.text, opts);
          return again.ok && again.text === r.text;
        }),
      );
    }).not.toThrow();
  });
  it('never lets C0 (except \\n \\t), DEL, C1 or a leading slash through (property)', () => {
    expect(() => {
      fc.assert(
        fc.property(fc.string({ maxLength: 120, unit: 'binary' }), (s) => {
          const r = sanitizePrompt(s, opts);
          if (!r.ok) return true;
          return !/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(r.text) && !r.text.trim().startsWith('/') && !r.text.startsWith('!');
        }),
      );
    }).not.toThrow();
  });
});

describe('sanitizeCommandArgs / sanitizeMessage', () => {
  it('args: single line, tabs → space, no prefix escape', () => {
    const r = sanitizeCommandArgs('opus\tnow');
    expect(r).toMatchObject({ ok: true, text: 'opus now' });
    expect(sanitizeCommandArgs('a\nb')).toMatchObject({ ok: false, reason: 'multiline' });
    expect(sanitizeCommandArgs('!x')).toMatchObject({ ok: true, text: '!x' });
    expect(sanitizeCommandArgs('x'.repeat(5000))).toMatchObject({ ok: false, reason: 'tooLarge' });
  });
  it('messages: control chars stripped, ≤ 2 KiB cut on a code point', () => {
    expect(sanitizeMessage('no\x1b[31m way')).toBe('no[31m way');
    const long = sanitizeMessage('é'.repeat(3000));
    expect(utf8Bytes(long)).toBeLessThanOrEqual(2048);
    expect(long.length).toBe(1024);
  });
});

describe('chunkForPaste (D-15 pasteChunks fallback)', () => {
  it('chunks are ≤ 400 bytes, ≤ 2 LF, rejoin exactly, never split a code point', () => {
    expect(() => {
      fc.assert(
        fc.property(fc.string({ maxLength: 3000, unit: 'grapheme' }), (s) => {
          const cs = chunkForPaste(s, 400);
          if (cs.join('') !== s) return false;
          return cs.every(
            (c) => utf8Bytes(c) <= 400 && (c.match(/\n/g)?.length ?? 0) <= 2 && !/^[\udc00-\udfff]/.test(c) && !/[\ud800-\udbff]$/.test(c),
          );
        }),
      );
    }).not.toThrow();
  });
  it('splits on the third newline', () => {
    expect(chunkForPaste('a\nb\nc\nd', 400)).toEqual(['a\nb\nc', '\nd']);
  });
});
