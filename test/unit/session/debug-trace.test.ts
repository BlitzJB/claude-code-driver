// session/debug-trace.ts — redaction at write time, 0600 file, header first, 8 MiB lag cap with drop records, bounded
// screen ring written only to debug.dumpDir (P-API-20, P-SEC-22, P-SEC-42; AL §4.6 L-6, §8.2).
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DebugRecord } from '../../../src/model/debug.js';
import { createDebugTrace, createScreenRing, nodeTraceFs, redactRecord } from '../../../src/session/debug-trace.js';
import type { TraceFs } from '../../../src/session/debug-trace.js';
import { REDACTED, createRedactor } from '../../../src/session/redact.js';

const TOKEN = '0123456789abcdef'.repeat(4);
const header = {
  r: 'header',
  format: 'ccd-trace',
  v: 1,
  lib: '0',
  claude: '2.1.316',
  tmux: '3.5a',
  node: '22',
  platform: 'darwin',
  startedWall: 1,
  tz: 'UTC',
  coreInit: { cwdRealpath: '/w' },
  profile: '2.1.316',
  redaction: 'meta',
  hookTransport: 'http',
} as unknown as Extract<DebugRecord, { r: 'header' }>;
const hookRaw = (prompt: string): DebugRecord => ({
  r: 'raw',
  i: 0,
  ch: 'hook',
  at: 1,
  wallAt: 2,
  data: { event: 'UserPromptSubmit', hookSeq: 3, bytes: 9, payload: { prompt } },
});
const obs = (text: string): DebugRecord =>
  ({
    r: 'obs',
    seq: 1,
    obs: { kind: 'prompt.submitted', meta: { seq: 1, at: 1, wallAt: 2, source: 'hook' }, p: { promptId: 'p', text } },
  }) as unknown as DebugRecord;

function memFs(): TraceFs & { files: Map<string, string>; opens: number; failWrites?: boolean } {
  const files = new Map<string, string>();
  const fs = {
    files,
    opens: 0,
    failWrites: false,
    openAppend(path: string) {
      fs.opens++;
      return Promise.resolve({
        write: (d: string) => {
          if (fs.failWrites) return Promise.reject(new Error('EIO'));
          files.set(path, (files.get(path) ?? '') + d);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      });
    },
    writePrivate(dir: string, name: string, data: string) {
      files.set(`${dir}/${name}`, data);
      return Promise.resolve(`${dir}/${name}`);
    },
  };
  return fs;
}
const lines = (s: string | undefined): Record<string, unknown>[] =>
  (s ?? '')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('redactRecord (raw policy)', () => {
  const red = createRedactor({ secrets: [TOKEN] });
  it('meta: content keys hashed, raw records reduced to metadata', () => {
    const r = redactRecord(hookRaw(`deploy ${TOKEN}`), 'meta', red) as Extract<DebugRecord, { r: 'raw' }>;
    expect(r.data).toMatchObject({
      ch: 'hook',
      event: 'UserPromptSubmit',
      hookSeq: 3,
      bytes: 9,
      payload: { len: expect.any(Number) as unknown, sha256_8: expect.any(String) as unknown },
    });
    expect(JSON.stringify(r)).not.toContain('deploy');
    const o = redactRecord(obs('my secret prompt'), 'meta', red) as Extract<DebugRecord, { r: 'obs' }>;
    expect(JSON.stringify(o)).not.toContain('my secret prompt');
    expect((o.obs.p as Record<string, unknown>)['promptId']).toBe('p');
  });
  it('none: raw records are not written at all; full: content kept, secrets masked', () => {
    expect(redactRecord(hookRaw('x'), 'none', red)).toBeUndefined();
    const f = redactRecord(hookRaw(`deploy ${TOKEN}`), 'full', red) as Extract<DebugRecord, { r: 'raw' }>;
    expect(JSON.stringify(f)).toContain('deploy');
    expect(JSON.stringify(f)).toContain(REDACTED);
    expect(JSON.stringify(f)).not.toContain(TOKEN);
  });
  it('header records the effective redaction mode; effect errors and diagnostics are redacted', () => {
    expect((redactRecord(header, 'full', red) as { redaction: string }).redaction).toBe('full');
    expect(redactRecord({ r: 'effect', intentId: 1, at: 1, durMs: 1, ok: false, error: `x ${TOKEN}` }, 'meta', red)).toMatchObject({
      error: `x ${REDACTED}`,
    });
    expect(redactRecord({ r: 'diag', at: 1, code: 'c', detail: { t: TOKEN } }, 'meta', red)).toMatchObject({ detail: { t: REDACTED } });
    const d = { r: 'drop', count: 1, reason: 'backpressure' } as const;
    expect(redactRecord(d, 'meta', red)).toBe(d);
  });
});

describe('debug trace writer', () => {
  it('holds records until the header, writes header first, redacted (P-API-20)', async () => {
    const fs = memFs();
    const t = createDebugTrace({ path: '/t/a.ccd.jsonl', raw: 'meta', redactor: createRedactor({ secrets: [TOKEN] }), fs });
    t.record(obs(`hello ${TOKEN}`));
    t.start(header);
    t.record(hookRaw('prompt text'));
    await t.flush();
    const out = lines(fs.files.get('/t/a.ccd.jsonl'));
    expect(out.map((r) => r['r'])).toEqual(['header', 'obs', 'raw']);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain('prompt text');
    expect(t.stats.written).toBe(3);
    await t.close();
  });

  it('in-process listeners get the same redacted records; a throwing listener is counted', () => {
    const t = createDebugTrace({ raw: 'meta', redactor: createRedactor() });
    expect(t.active).toBe(false);
    const got: DebugRecord[] = [];
    const off = t.subscribe((r) => got.push(r));
    t.subscribe(() => {
      throw new Error('x');
    });
    expect(t.active).toBe(true);
    t.record(obs('secret'));
    expect(got).toHaveLength(1);
    expect(JSON.stringify(got[0])).not.toContain('secret');
    expect(t.stats.listenerErrors).toBe(1);
    off();
  });

  it('drops (and counts) records beyond the lag cap, then writes a drop record (L-6)', async () => {
    const fs = memFs();
    const t = createDebugTrace({ path: '/t/b', raw: 'full', redactor: createRedactor(), fs, maxLagBytes: 600 });
    t.start(header);
    for (let i = 0; i < 20; i++) t.record({ r: 'diag', at: i, code: 'c', detail: { i, pad: 'x'.repeat(40) } });
    expect(t.stats.dropped).toBeGreaterThan(0);
    await t.flush();
    t.record({ r: 'diag', at: 99, code: 'after', detail: null });
    await t.close();
    const out = lines(fs.files.get('/t/b'));
    const drop = out.find((r) => r['r'] === 'drop');
    expect(drop).toMatchObject({ reason: 'backpressure' });
    expect(drop?.['count']).toBe(t.stats.dropped);
    expect(out.at(-1)).toMatchObject({ r: 'diag', code: 'after' });
  });

  it('the lag cap also bounds records held before the header, in UTF-8 bytes (multi-byte content)', async () => {
    const fs = memFs();
    const t = createDebugTrace({ path: '/t/c', raw: 'full', redactor: createRedactor(), fs, maxLagBytes: 4000 });
    const rec = (i: number): DebugRecord => ({ r: 'diag', at: i, code: 'c', detail: { pad: '\u00e9\u4e2d'.repeat(75) } });
    const line = `${JSON.stringify(rec(1))}\n`;
    const kept = Math.floor(4000 / Buffer.byteLength(line));
    expect(Math.floor(4000 / line.length)).toBeGreaterThan(12); // counted in UTF-16 units, nothing would be dropped
    for (let i = 0; i < 12; i++) t.record(rec(i));
    expect(t.stats.dropped).toBe(12 - kept);
    t.start(header);
    await t.close();
    const out = lines(fs.files.get('/t/c'));
    expect(out[0]).toMatchObject({ r: 'header' });
    const kinds = out.map((r) => r['r']);
    // the drop marker follows the surviving records (they were recorded first)
    expect(kinds.indexOf('drop')).toBeGreaterThan(kinds.lastIndexOf('diag'));
    const dropCount = out.filter((r) => r['r'] === 'drop').reduce((n, r) => n + Number(r['count']), 0);
    expect(dropCount).toBe(t.stats.dropped);
    expect(kinds.filter((k) => k === 'diag').length + t.stats.dropped).toBe(12);
  });

  it('a failing sink disables the file and never throws into the loop', async () => {
    const fs = memFs();
    fs.failWrites = true;
    const errors: unknown[] = [];
    const t = createDebugTrace({ path: '/t/c', raw: 'meta', redactor: createRedactor(), fs, onError: (e) => errors.push(e) });
    t.start(header);
    t.record(obs('x'));
    await t.flush();
    expect(errors).toHaveLength(1);
    expect(t.active).toBe(false);
    t.record(obs('y'));
    await t.close();
  });

  it('never started → nothing is written (no headerless trace); records after close are ignored', async () => {
    const fs = memFs();
    const t = createDebugTrace({ path: '/t/d', raw: 'meta', redactor: createRedactor(), fs });
    t.record(obs('x'));
    await t.close();
    t.record(obs('y'));
    expect(fs.files.size).toBe(0);
    expect(fs.opens).toBe(0);
  });

  it('flushes on its own (A-9, 250 ms timer)', async () => {
    const fs = memFs();
    const t = createDebugTrace({ path: '/t/e', raw: 'meta', redactor: createRedactor(), fs, flushMs: 5 });
    t.start(header);
    await new Promise((r) => setTimeout(r, 40));
    expect(lines(fs.files.get('/t/e'))).toHaveLength(1);
    await t.close();
  });
});

describe('real files: modes', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('the trace file is 0600; the dump dir is 0700 and dumps are 0600 (P-SEC-42)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ccd-trace-'));
    const path = join(dir, 'x.ccd.jsonl');
    const t = createDebugTrace({ path, raw: 'meta', redactor: createRedactor(), fs: nodeTraceFs });
    t.start(header);
    await t.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lines(readFileSync(path, 'utf8'))[0]).toMatchObject({ r: 'header' });

    const dumpDir = join(dir, 'dumps');
    const ring = createScreenRing({ redactor: createRedactor({ secrets: [TOKEN] }), sessionKey: 's1', dumpDir });
    ring.push({ at: 1, wallAt: 2, hash: 'a', lines: [`token ${TOKEN}`] });
    const p = await ring.dump('stall', 123);
    expect(p).toBeDefined();
    expect(statSync(dumpDir).mode & 0o777).toBe(0o700);
    expect(statSync(p ?? '').mode & 0o777).toBe(0o600);
    expect(readFileSync(p ?? '', 'utf8')).not.toContain(TOKEN);
    expect(readdirSync(dumpDir)).toHaveLength(1);
  });
});

describe('screen ring', () => {
  it('is bounded, keeps one copy of an unchanged frame, and never touches disk without dumpDir', async () => {
    const fs = memFs();
    const ring = createScreenRing({ capacity: 3, redactor: createRedactor(), sessionKey: 's1', fs });
    for (let i = 0; i < 5; i++) ring.push({ at: i, wallAt: i, hash: `h${i}`, lines: [`l${i}`] });
    ring.push({ at: 9, wallAt: 9, hash: 'h4', lines: ['l4'] });
    expect(ring.size).toBe(3);
    expect(ring.entries().map((e) => e.hash)).toEqual(['h2', 'h3', 'h4']);
    expect(await ring.dump('x', 1)).toBeUndefined();
    expect(fs.files.size).toBe(0);
    const empty = createScreenRing({ redactor: createRedactor(), sessionKey: 's1', dumpDir: '/d', fs });
    expect(await empty.dump('x', 1)).toBeUndefined();
  });
});
