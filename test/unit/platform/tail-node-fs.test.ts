// node-fs.ts: the real TailFs adapter and the error helpers (DESIGN.md §1.2 fs-tail/node-fs.ts; P-TAIL-05 no shell-outs,
// P-TAIL-23 a held fd keeps reading across a same-device rename).
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeError, errnoOf, nodeTailFs } from '../../../src/platform/fs-tail/node-fs.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-tailfs-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('nodeTailFs', () => {
  it('open / fstat / pread / close', async () => {
    const p = join(root, '-slug-starting-with-dash', 'f.jsonl');
    mkdirSync(join(root, '-slug-starting-with-dash'));
    writeFileSync(p, 'hello\nworld\n');
    const fh = await nodeTailFs.open(p);
    const st = await fh.stat();
    expect(st).toMatchObject({ size: 12, isFile: true, isDirectory: false });
    expect(st.ino).toBeGreaterThan(0);
    const buf = Buffer.alloc(5);
    expect(await fh.read(buf, 0, 5, 6)).toBe(5);
    expect(buf.toString()).toBe('world');
    expect(await fh.read(buf, 0, 5, 12)).toBe(0);
    await fh.close();
  });

  it('a held fd keeps reading the inode after a same-device rename', async () => {
    const a = join(root, 'a.jsonl');
    const b = join(root, 'moved', 'b.jsonl');
    writeFileSync(a, 'a\n');
    const fh = await nodeTailFs.open(a);
    mkdirSync(join(root, 'moved'));
    renameSync(a, b);
    appendFileSync(b, 'b\n');
    const buf = Buffer.alloc(4);
    expect(await fh.read(buf, 0, 4, 0)).toBe(4);
    expect(buf.toString()).toBe('a\nb\n');
    expect((await fh.stat()).ino).toBe((await nodeTailFs.stat(b)).ino);
    await fh.close();
  });

  it('stat / readdir kinds / realpath; errors carry errno codes', async () => {
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'f'), 'x');
    symlinkSync(join(root, 'f'), join(root, 'l'));
    const ents = (await nodeTailFs.readdir(root)).sort((x, y) => x.name.localeCompare(y.name));
    expect(ents).toEqual([
      { name: 'd', kind: 'dir' },
      { name: 'f', kind: 'file' },
      { name: 'l', kind: 'symlink' },
    ]);
    expect(await nodeTailFs.realpath(join(root, 'l'))).toBe(join(root, 'f'));
    expect((await nodeTailFs.stat(join(root, 'l'))).isFile).toBe(true);
    expect((await nodeTailFs.stat(join(root, 'd'))).isDirectory).toBe(true);
    await expect(nodeTailFs.open(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(nodeTailFs.stat(join(root, 'f', 'below-a-file'))).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(nodeTailFs.readdir(join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('error helpers', () => {
  it('errnoOf / describeError', () => {
    const e = Object.assign(new Error('boom'), { code: 'EIO' });
    expect(errnoOf(e)).toBe('EIO');
    expect(errnoOf(new Error('x'))).toBeUndefined();
    expect(errnoOf({ code: 5 })).toBeUndefined();
    expect(errnoOf(null)).toBeUndefined();
    expect(describeError(e)).toBe('EIO: boom');
    expect(describeError(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))).toBe('ENOENT: no such file');
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ code: 'EACCES' })).toBe('EACCES');
  });
});
