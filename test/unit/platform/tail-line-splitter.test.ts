// LineSplitter + classifyLine (DESIGN.md §5.3: P-TAIL-08…13, P-TAIL-14, P-TAIL-40, P-TAIL-42).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyLine, LineSplitter, type LineSink } from '../../../src/platform/fs-tail/line-splitter.js';

interface Got {
  lines: { text: string; offset: number; bytes: number }[];
  big: { offset: number; bytes: number }[]; // recorded oversize() calls
}
function sink(): Got & LineSink {
  const lines: Got['lines'] = [];
  const big: Got['big'] = [];
  return {
    lines,
    big,
    line(buf, st, e, offset) {
      lines.push({ text: buf.toString('utf8', st, e), offset, bytes: e - st });
    },
    oversize(offset, bytes) {
      big.push({ offset, bytes });
    },
  };
}
const push = (sp: LineSplitter, sk: LineSink, s: string | Buffer): void => {
  const b = typeof s === 'string' ? Buffer.from(s) : s;
  sp.push(b, 0, b.length, sk);
};

describe('LineSplitter', () => {
  it('splits on 0x0A with absolute offsets and keeps the remainder (P-TAIL-06)', () => {
    const sp = new LineSplitter(1024);
    const sk = sink();
    push(sp, sk, 'ab\ncd\nef');
    expect(sk.lines).toEqual([
      { text: 'ab', offset: 0, bytes: 2 },
      { text: 'cd', offset: 3, bytes: 2 },
    ]);
    expect(sp.consumed).toBe(6);
    expect(sp.position).toBe(8);
    expect(sp.remainder()).toEqual({ offset: 6, bytes: 2 });
    push(sp, sk, 'g\n');
    expect(sk.lines[2]).toEqual({ text: 'efg', offset: 6, bytes: 3 });
    expect(sp.remainder()).toBeUndefined();
  });

  it('a line torn across many chunks (Node 512 KiB appendFile) is one line (P-TAIL-08)', () => {
    const sp = new LineSplitter(1 << 30);
    const sk = sink();
    const line = Buffer.from('{"type":"user","pad":"' + 'q'.repeat(3 * 524288) + '"}\n');
    for (let i = 0; i < line.length; i += 524288) sp.push(line, i, Math.min(line.length, i + 524288), sk);
    expect(sk.lines).toHaveLength(1);
    expect(sk.lines[0]!.bytes).toBe(line.length - 1);
  });

  it('copies pending bytes: overwriting the reused read buffer does not corrupt a pending line (P-TAIL-40)', () => {
    const sp = new LineSplitter(1024);
    const sk = sink();
    const reused = Buffer.alloc(8);
    reused.write('hello');
    sp.push(reused, 0, 5, sk);
    reused.fill(0x5a); // the next read overwrites the buffer
    reused.write(' wor');
    reused[4] = 0x0a;
    sp.push(reused, 0, 5, sk);
    expect(sk.lines[0]?.text).toBe('hello wor');
  });

  it('decodes per complete line, so a code point split across reads survives (P-TAIL-13)', () => {
    const sp = new LineSplitter(1024);
    const sk = sink();
    const b = Buffer.from('€uro\n'); // € is e2 82 ac
    sp.push(b, 0, 1, sk);
    sp.push(b, 1, 3, sk);
    sp.push(b, 3, b.length, sk);
    expect(sk.lines[0]?.text).toBe('€uro');
    expect(sk.lines[0]?.text.includes('�')).toBe(false);
  });

  it('switches to discard mode above maxLineBytes and reports `oversize`, then resumes (P-TAIL-12)', () => {
    const sp = new LineSplitter(10);
    const sk = sink();
    push(sp, sk, 'ok\n0123456');
    push(sp, sk, '789abcdef');
    push(sp, sk, 'XYZ\nnext\n');
    expect(sk.big).toEqual([{ offset: 3, bytes: 19 }]);
    expect(sk.lines.map((l) => l.text)).toEqual(['ok', 'next']);
    expect(sk.lines[1]?.offset).toBe(23);
    // a single chunk with an over-long line is also discarded
    push(sp, sk, 'x'.repeat(11) + '\n');
    expect(sk.big[1]).toEqual({ offset: 28, bytes: 11 });
  });

  it('never hands out a prefix: "123" stays pending until its newline (P-TAIL-10)', () => {
    const sp = new LineSplitter(1024);
    const sk = sink();
    push(sp, sk, '123');
    expect(sk.lines).toEqual([]);
    push(sp, sk, '4\n');
    expect(sk.lines[0]?.text).toBe('1234');
  });

  it('is linear: a 24 MiB line fed in 4 KiB chunks is fast (P-TAIL-09)', () => {
    const sp = new LineSplitter(64 * 1024 * 1024);
    const sk = sink();
    const chunk = Buffer.alloc(4096, 0x61);
    const t0 = performance.now();
    for (let i = 0; i < 6144; i++) sp.push(chunk, 0, chunk.length, sk);
    push(sp, sk, '\n');
    const ms = performance.now() - t0;
    expect(sk.lines[0]?.bytes).toBe(24 * 1024 * 1024);
    expect(ms).toBeLessThan(2000);
  });

  it('reset(skipPartial) drops bytes up to the first newline silently', () => {
    const sp = new LineSplitter(1024);
    const sk = sink();
    sp.reset(100, { skipPartial: true });
    push(sp, sk, 'tail-of-line');
    expect(sp.remainder()).toBeUndefined();
    push(sp, sk, '\nnext\n');
    expect(sk.lines).toEqual([{ text: 'next', offset: 113, bytes: 4 }]);
    expect(sk.big).toEqual([]);
  });

  it('rejects a non-positive maxLineBytes', () => {
    expect(() => new LineSplitter(0)).toThrow(RangeError);
  });
});

describe('classifyLine', () => {
  const none = new Set<string>();
  const skip = new Set(['api-request-blob', 'file-history-snapshot']);
  const c = (s: string, set: ReadonlySet<string> = none) => {
    const b = Buffer.from(s);
    return classifyLine(b, 0, b.length, set);
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses objects; type is a string or undefined; unknown types pass through (P-TAIL-42)', () => {
    expect(c('{"type":"user","n":1}')).toEqual({ kind: 'parsed', type: 'user', json: { type: 'user', n: 1 } });
    expect(c('{"n":1}')).toEqual({ kind: 'parsed', type: undefined, json: { n: 1 } });
    expect(c('{"type":7}')).toMatchObject({ kind: 'parsed', type: undefined });
    expect(c('{"type":"brand-new-type-2.1.999"}')).toMatchObject({ kind: 'parsed', type: 'brand-new-type-2.1.999' });
  });

  it('non-object JSON is malformed{not-object} (P-TAIL-42)', () => {
    for (const s of ['123', 'null', '[1,2]', '"str"', 'true']) expect(c(s)).toMatchObject({ kind: 'malformed', reason: 'not-object' });
  });

  it('invalid JSON is malformed{json} with a ≤200-byte preview (P-TAIL-07)', () => {
    const r = c('{"type":"assistant","message":' + 'x'.repeat(500));
    expect(r.kind).toBe('malformed');
    if (r.kind === 'malformed') {
      expect(r.reason).toBe('json');
      expect(Buffer.byteLength(r.preview)).toBeLessThanOrEqual(200);
    }
  });

  it('strips a trailing CR and leading NULs (P-TAIL-11); blank lines are empty', () => {
    expect(c('{"type":"user"}\r')).toMatchObject({ kind: 'parsed', type: 'user' });
    expect(c('\0\0\0{"type":"user"}')).toMatchObject({ kind: 'parsed', type: 'user' });
    expect(c('')).toEqual({ kind: 'empty' });
    expect(c('\0\r')).toEqual({ kind: 'empty' });
  });

  it('skips JSON.parse for skipParseTypes by prefix (P-TAIL-14), falls back to a full parse otherwise', () => {
    const spy = vi.spyOn(JSON, 'parse');
    expect(c('{"type":"api-request-blob","blob":"' + 'z'.repeat(10_000) + '"}', skip)).toEqual({
      kind: 'skipped',
      type: 'api-request-blob',
    });
    expect(c('{"type":"file-history-snapshot","x":1}', skip)).toEqual({ kind: 'skipped', type: 'file-history-snapshot' });
    expect(spy).not.toHaveBeenCalled();
    // key order differs → full parse (correctness never depends on key order)
    expect(c('{"x":1,"type":"api-request-blob"}', skip)).toMatchObject({ kind: 'parsed', type: 'api-request-blob' });
    // escape in the type → full parse
    expect(c('{"type":"api\\u002drequest-blob"}', skip)).toMatchObject({ kind: 'parsed', type: 'api-request-blob' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
