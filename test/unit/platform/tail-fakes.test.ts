// fake-tail-fs.ts: FakeTailFs semantics the tail scenarios rely on, and the scripted FakeTranscriptTail(+Factory)
// (DESIGN.md §2.7 "Fakes", §6.4 tail row).
import { describe, expect, it } from 'vitest';
import { FakeTailFs, FakeTranscriptTail, FakeTranscriptTailFactory } from '../../../src/platform/fs-tail/fake-tail-fs.js';
import type { TailEvent } from '../../../src/platform/ports.js';
import { DEFAULT_TAIL_TUNING } from '../../../src/platform/fs-tail/tail.js';
import { ManualClock, SID1 } from '../../contract/tail.contract.js';

const readAll = async (fs: FakeTailFs, p: string): Promise<string> => {
  const fh = await fs.open(p);
  const st = await fh.stat();
  const b = Buffer.alloc(st.size);
  await fh.read(b, 0, st.size, 0);
  await fh.close();
  return b.toString();
};

describe('FakeTailFs', () => {
  it('open fds keep their inode across rename and unlink (POSIX)', async () => {
    const fs = new FakeTailFs();
    fs.writeFile('/a/f', 'one\n');
    const fh = await fs.open('/a/f');
    fs.rename('/a', '/b');
    fs.appendFile('/b/f', 'two\n');
    expect(fs.exists('/a/f')).toBe(false);
    const b = Buffer.alloc(8);
    expect(await fh.read(b, 0, 8, 0)).toBe(8);
    expect(b.toString()).toBe('one\ntwo\n');
    fs.unlink('/b/f');
    expect((await fh.stat()).size).toBe(8);
    await fh.close();
    expect(fs.counters.openFds).toBe(0);
  });

  it('rename keeps the inode; replaceFile and copyNewInode create new ones', async () => {
    const fs = new FakeTailFs();
    fs.writeFile('/p/x', 'abc');
    const i0 = (await fs.stat('/p/x')).ino;
    fs.rename('/p/x', '/p/y');
    expect((await fs.stat('/p/y')).ino).toBe(i0);
    fs.replaceFile('/p/y', 'new');
    const i1 = (await fs.stat('/p/y')).ino;
    expect(i1).not.toBe(i0);
    fs.copyNewInode('/p/y', '/q/z', { dev: 9 });
    const st = await fs.stat('/q/z');
    expect(st.ino).not.toBe(i1);
    expect(st.dev).toBe(9);
    expect(await readAll(fs, '/q/z')).toBe('new');
    expect(fs.exists('/p/y')).toBe(false);
  });

  it('truncate and removeLineContaining keep the inode (tombstone)', async () => {
    const fs = new FakeTailFs();
    fs.writeFile('/t', 'l1\n{"uuid":"u2"}\nl3\n');
    const ino = (await fs.stat('/t')).ino;
    fs.removeLineContaining('/t', '"uuid":"u2"');
    expect(fs.read('/t').toString()).toBe('l1\nl3\n');
    fs.truncate('/t', 2);
    expect(fs.read('/t').toString()).toBe('l1');
    fs.truncate('/t', 4);
    expect(fs.read('/t')).toEqual(Buffer.from('l1\0\0'));
    expect((await fs.stat('/t')).ino).toBe(ino);
    expect(() => {
      fs.removeLineContaining('/t', 'absent');
    }).toThrow();
  });

  it('symlinks (file and directory), ENOENT, ENOTDIR, EISDIR, ELOOP, EACCES, EMFILE', async () => {
    const fs = new FakeTailFs();
    fs.writeFile('/real/dir/f', 'x');
    fs.symlink('/real/dir', '/link');
    fs.symlink('/real/dir/f', '/tasks/a.output');
    expect(await fs.realpath('/link/f')).toBe('/real/dir/f');
    expect(await fs.realpath('/tasks/a.output')).toBe('/real/dir/f');
    expect(await readAll(fs, '/tasks/a.output')).toBe('x');
    expect((await fs.readdir('/tasks'))[0]).toEqual({ name: 'a.output', kind: 'symlink' });
    await expect(fs.open('/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat('/real/dir/f/x')).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(fs.open('/real/dir')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(fs.readdir('/real/dir/f')).rejects.toMatchObject({ code: 'ENOTDIR' });
    fs.symlink('/loop2', '/loop1');
    fs.symlink('/loop1', '/loop2');
    await expect(fs.stat('/loop1')).rejects.toMatchObject({ code: 'ELOOP' });
    fs.setDenied('/real/dir/f', true);
    await expect(fs.open('/real/dir/f')).rejects.toMatchObject({ code: 'EACCES' });
    fs.setDenied('/real/dir/f', false);
    fs.maxOpenFiles = 1;
    const h = await fs.open('/real/dir/f');
    await expect(fs.open('/real/dir/f')).rejects.toMatchObject({ code: 'EMFILE' });
    await h.close();
    await expect(h.read(Buffer.alloc(1), 0, 1, 0)).rejects.toMatchObject({ code: 'EBADF' });
    expect(fs.counters.maxOpenFds).toBe(1);
  });

  it('removeTree and readdir listing', async () => {
    const fs = new FakeTailFs();
    fs.writeFile('/r/a', '1');
    fs.writeFile('/r/s/b', '2');
    expect((await fs.readdir('/r')).map((e) => [e.name, e.kind])).toEqual([
      ['a', 'file'],
      ['s', 'dir'],
    ]);
    fs.removeTree('/r/s');
    expect((await fs.readdir('/r')).map((e) => e.name)).toEqual(['a']);
    expect(() => {
      fs.writeFile('/r/a/under-file', 'x');
    }).toThrow(/ENOTDIR/);
  });
});

describe('FakeTranscriptTail', () => {
  it('records calls, emits pushed events with per-file offsets, stops after close', async () => {
    const f = new FakeTranscriptTailFactory();
    const t = f.create({ ...DEFAULT_TAIL_TUNING, configDir: '/c', clock: new ManualClock() });
    expect(f.last).toBe(t);
    expect(t).toBeInstanceOf(FakeTranscriptTail);
    const got: TailEvent[] = [];
    const cancel = t.on((e) => got.push(e));
    t.followMain(SID1, '/p/x.jsonl');
    t.observePath(SID1, '/p/x.jsonl', 'SessionStart');
    t.expectSubagent(SID1, 'a');
    t.subagentStopped(SID1, 'a');
    t.poke('Stop');
    const key = { kind: 'main', sessionId: SID1 } as const;
    const l1 = t.emitLine(key, { type: 'user', n: 1 });
    const l2 = t.emitLine(key, { type: 'assistant' }, { replay: true });
    expect(l1).toMatchObject({ offset: 0, type: 'user', replay: false });
    expect(l2.offset).toBe(l1.bytes + 1);
    expect(l2.replay).toBe(true);
    t.emit({ kind: 'missing', file: { kind: 'subagent', sessionId: SID1, agentId: 'a' }, waitedMs: 10_000 });
    expect(got.map((e) => e.kind)).toEqual(['line', 'line', 'missing']);
    expect(t.calls.map((c) => c.m)).toEqual(['followMain', 'observePath', 'expectSubagent', 'subagentStopped', 'poke']);
    expect(t.checkpoint()).toEqual({ files: [] });
    cancel();
    expect(t.listenerCount).toBe(0);
    t.on((e) => got.push(e));
    await t.close();
    await t.close();
    t.emitLine(key, { type: 'user' });
    expect(got).toHaveLength(3);
    expect(t.calls.filter((c) => c.m === 'close')).toHaveLength(1);
    expect(t.closed).toBe(true);
  });
});
