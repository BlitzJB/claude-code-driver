// WP-05 unit tests: StateStorePort — atomic 0600 writes, 0700 dirs, path containment, lenient reads, O_EXCL lock with the
// stale rule (§3.8 `lock`: stale if the holder is dead or > staleMs), P-SEC-24 root check.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { createRealClock } from '../../../src/platform/clock/real-clock.js';
import { FakeEnv } from '../../../src/platform/env/fake-env.js';
import { FakeStateStore } from '../../../src/platform/runtime-dir/fake-state-store.js';
import { createStateStore, defaultStateRoot } from '../../../src/platform/runtime-dir/state-store.js';

let base: string;
const uid = process.getuid?.() ?? 501;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-st-')));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const store = (root = join(base, 'state'), isAlive?: (pid: number) => boolean) =>
  createStateStore({ env: new FakeEnv({ uid }), clock: createRealClock(), root, ...(isAlive ? { isAlive } : {}) });

describe('root', () => {
  it('defaults to ${XDG_STATE_HOME:-~/.local/state}/claude-code-driver', () => {
    expect(defaultStateRoot(new FakeEnv({ home: '/h' }))).toBe('/h/.local/state/claude-code-driver');
    expect(defaultStateRoot(new FakeEnv({ home: '/h', vars: { XDG_STATE_HOME: '/x/state' } }))).toBe('/x/state/claude-code-driver');
    expect(defaultStateRoot(new FakeEnv({ home: '/h', vars: { XDG_STATE_HOME: 'relative' } }))).toBe('/h/.local/state/claude-code-driver');
  });

  it('is created 0700; an existing loose root is refused (P-SEC-24)', async () => {
    const s = store();
    await s.writeJsonAtomic('a.json', { a: 1 });
    expect(statSync(s.root).mode & 0o777).toBe(0o700);
    const loose = join(base, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    await expect(store(loose).list('')).rejects.toMatchObject({ name: 'UnsafeRuntimeDir', reason: 'mode' });
  });
});

describe('files', () => {
  it('writeJsonAtomic: 0600 file, 0700 sub dirs, no tmp leftovers, readJson round-trip', async () => {
    const s = store();
    await s.writeJsonAtomic('sessions/s1.json', { v: 2, x: [1, 2] });
    await s.writeJsonAtomic('sessions/s1.json', { v: 2, x: [3] });
    expect(await s.readJson('sessions/s1.json')).toEqual({ v: 2, x: [3] });
    expect(statSync(join(s.root, 'sessions', 's1.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.root, 'sessions')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(s.root, 'sessions'))).toEqual(['s1.json']);
    expect(await s.list('sessions')).toEqual(['s1.json']);
    expect(await s.list('nope')).toEqual([]);
  });

  it('lenient reads: missing or corrupt → undefined; dot files hidden from list', async () => {
    const s = store();
    await s.writeJsonAtomic('x.json', 1);
    writeFileSync(join(s.root, 'bad.json'), '{oops');
    writeFileSync(join(s.root, '.hidden.tmp'), '');
    expect(await s.readJson('bad.json')).toBeUndefined();
    expect(await s.readJson('missing.json')).toBeUndefined();
    expect(await s.list('')).toEqual(['bad.json', 'x.json']);
  });

  it('paths may not escape the root', async () => {
    const s = store();
    await expect(s.writeJsonAtomic('../evil.json', 1)).rejects.toThrow(RangeError);
    await expect(s.readJson('/etc/passwd')).rejects.toThrow(RangeError);
    await expect(s.remove('')).rejects.toThrow(RangeError);
    expect(await s.readJson('a/../a.json')).toBeUndefined();
  });

  it('appendLine appends whole lines at 0600 and refuses embedded newlines', async () => {
    const s = store();
    await s.appendLine('exits/s1.log', 'died pane=%1 status=0');
    await s.appendLine('exits/s1.log', 'watch=owner-gone\n');
    expect(readFileSync(join(s.root, 'exits', 's1.log'), 'utf8')).toBe('died pane=%1 status=0\nwatch=owner-gone\n');
    expect(statSync(join(s.root, 'exits', 's1.log')).mode & 0o777).toBe(0o600);
    await expect(s.appendLine('exits/s1.log', 'a\nforged')).rejects.toThrow(RangeError);
  });

  it('remove deletes files and dirs, ignores missing', async () => {
    const s = store();
    await s.writeJsonAtomic('archive/a.json', 1);
    await s.remove('archive/a.json');
    await s.remove('archive/a.json');
    await s.writeJsonAtomic('limit-captures/x/y.json', 1);
    await s.remove('limit-captures');
    expect(await s.list('')).toEqual(['archive']);
  });
});

describe('withLock', () => {
  it('serializes holders and releases on throw', async () => {
    const s = store();
    const order: string[] = [];
    const a = s.withLock(
      'lock',
      async () => {
        order.push('a-in');
        await new Promise((r) => setTimeout(r, 80));
        order.push('a-out');
      },
      { staleMs: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 10));
    const b = s.withLock(
      'lock',
      () => {
        order.push('b');
        return Promise.resolve(7);
      },
      { staleMs: 60_000 },
    );
    await a;
    expect(await b).toBe(7);
    expect(order).toEqual(['a-in', 'a-out', 'b']);
    await expect(s.withLock('lock', () => Promise.reject(new Error('x')), { staleMs: 1000 })).rejects.toThrow('x');
    expect(readdirSync(s.root)).not.toContain('lock');
  });

  it('steals a lock whose holder pid is dead', async () => {
    const s = store(join(base, 'st2'), (pid) => pid !== 999_999);
    await s.list('');
    writeFileSync(join(s.root, 'lock'), JSON.stringify({ pid: 999_999, token: 'old', at: Date.now() }));
    expect(await s.withLock('lock', () => Promise.resolve('got'), { staleMs: 60_000 })).toBe('got');
  });

  it('never steals a fresh lock that replaced the stale one between the check and the rename', async () => {
    const DEAD = 999_999;
    const lockPath = () => join(base, 'st4', 'lock');
    let swapped = false;
    // While the stealer judges the dead holder, that holder "releases" and a live process takes a fresh lock.
    const s = store(join(base, 'st4'), (pid) => {
      if (pid === DEAD && !swapped) {
        swapped = true;
        writeFileSync(lockPath(), JSON.stringify({ pid: process.ppid, token: 'fresh', at: Date.now() }));
      }
      return pid !== DEAD;
    });
    await s.list('');
    writeFileSync(lockPath(), JSON.stringify({ pid: DEAD, token: 'old', at: Date.now() }));
    let ran = false;
    const p = s.withLock(
      'lock',
      () => {
        ran = true;
        return Promise.resolve('got');
      },
      { staleMs: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(swapped).toBe(true);
    expect(ran).toBe(false); // the fresh holder still owns the lock
    expect(JSON.parse(readFileSync(lockPath(), 'utf8'))).toMatchObject({ token: 'fresh' });
    rmSync(lockPath()); // the fresh holder releases
    expect(await p).toBe('got');
    expect(readdirSync(join(base, 'st4')).filter((n) => n.startsWith('lock'))).toEqual([]);
  });

  it('same when the first read saw a torn (half-written) stale lock: the fresh replacement is put back', async () => {
    const root = join(base, 'st5');
    const lockPath = join(root, 'lock');
    const real = createRealClock();
    let swapped = false;
    let arm = false;
    // The torn lock is judged by mtime via wallNow(); at that moment a live process replaces it with a fresh lock.
    const clock = {
      ...real,
      wallNow: () => {
        if (arm && !swapped) {
          swapped = true;
          writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, token: 'fresh', at: Date.now() }));
        }
        return real.wallNow();
      },
    };
    const s = createStateStore({ env: new FakeEnv({ uid }), clock, root, isAlive: () => true });
    await s.list('');
    writeFileSync(lockPath, '{"pid":');
    utimesSync(lockPath, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    arm = true;
    let ran = false;
    const p = s.withLock(
      'lock',
      () => {
        ran = true;
        return Promise.resolve('got');
      },
      { staleMs: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(swapped).toBe(true);
    expect(ran).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ token: 'fresh' });
    rmSync(lockPath);
    expect(await p).toBe('got');
  });

  it('steals a lock older than staleMs even if the holder looks alive; a torn lock file is judged by mtime', async () => {
    const s = store(join(base, 'st3'), () => true);
    await s.list('');
    writeFileSync(join(s.root, 'lock'), JSON.stringify({ pid: 4242, token: 'old', at: Date.now() - 120_000 }));
    expect(await s.withLock('lock', () => Promise.resolve(1), { staleMs: 60_000 })).toBe(1);
    writeFileSync(join(s.root, 'lock'), '{"pid":');
    const t0 = Date.now();
    expect(await s.withLock('lock', () => Promise.resolve(2), { staleMs: 100 })).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });
});

describe('FakeStateStore', () => {
  it('mirrors path rules and lock staleness on a fake clock', async () => {
    const clock = new FakeClock();
    const f = new FakeStateStore({ clock, isAlive: (p) => p !== 7 });
    await f.writeJsonAtomic('sessions/a.json', { a: 1 });
    expect(await f.list('sessions')).toEqual(['a.json']);
    expect(await f.list('')).toEqual(['sessions']);
    await expect(f.readJson('../x')).rejects.toThrow(RangeError);
    f.plantLock('lock', { pid: 7, at: clock.wallNow() });
    expect(await f.withLock('lock', () => Promise.resolve('ok'), { staleMs: 10_000 })).toBe('ok');
    f.plantLock('lock', { pid: 8, at: clock.wallNow() });
    const p = f.withLock('lock', () => Promise.resolve('late'), { staleMs: 1_000 });
    await clock.advanceAsync(1_100);
    expect(await p).toBe('late');
    expect(f.isLocked('lock')).toBe(false);
  });
});
