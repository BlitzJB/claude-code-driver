// WP-05 unit tests: real/fake clock (absolute deadlines, jumpWall: P-TMUX-54, P-NET-42, P-API-21), ids, env port.
import { describe, expect, it } from 'vitest';
import type { MonoMs } from '../../../src/model/time.js';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { abortReason, createRealClock } from '../../../src/platform/clock/real-clock.js';
import { createEnvPort } from '../../../src/platform/env/env-port.js';
import { FakeEnv } from '../../../src/platform/env/fake-env.js';
import { createCryptoIds } from '../../../src/platform/ids/crypto-ids.js';
import { FakeIds } from '../../../src/platform/ids/fake-ids.js';

describe('real clock', () => {
  it('setTimer fires at an absolute mono deadline and can be cancelled', async () => {
    const c = createRealClock();
    const t0 = c.now();
    const fired: number[] = [];
    c.setTimer((t0 + 30) as MonoMs, () => fired.push(c.now() - t0));
    const cancel = c.setTimer((t0 + 20) as MonoMs, () => fired.push(-1));
    cancel();
    await c.sleep(80);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeGreaterThanOrEqual(30);
    expect(Math.abs(c.wallNow() - Date.now())).toBeLessThan(50);
  });

  it('a past deadline fires asynchronously; sleep rejects on abort', async () => {
    const c = createRealClock({ unref: true });
    let fired = false;
    c.setTimer((c.now() - 10) as MonoMs, () => (fired = true));
    expect(fired).toBe(false);
    await c.sleep(5);
    expect(fired).toBe(true);
    const ac = new AbortController();
    const p = c.sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(c.sleep(1, AbortSignal.abort(new Error('why')))).rejects.toThrow('why');
    expect(abortReason(undefined).name).toBe('AbortError');
  });
});

describe('fake clock', () => {
  it('fires timers in deadline order with now() at each deadline; mono and wall advance together', () => {
    const c = new FakeClock({ mono: 0, wall: 1_000_000 });
    const seen: [string, number, number][] = [];
    c.setTimer(50 as MonoMs, () => seen.push(['b', c.now(), c.wallNow()]));
    c.setTimer(10 as MonoMs, () => seen.push(['a', c.now(), c.wallNow()]));
    c.setTimer(50 as MonoMs, () => seen.push(['c', c.now(), c.wallNow()]));
    expect(c.nextAt()).toBe(10);
    expect(c.advance(100)).toBe(3);
    expect(seen).toEqual([
      ['a', 10, 1_000_010],
      ['b', 50, 1_000_050],
      ['c', 50, 1_000_050],
    ]);
    expect(c.now()).toBe(100);
    expect(c.pending()).toBe(0);
  });

  it('jumpWall moves only wall time (host sleep, K-21)', () => {
    const c = new FakeClock({ mono: 5, wall: 0 });
    c.jumpWall(600_000);
    expect(c.now()).toBe(5);
    expect(c.wallNow()).toBe(600_000);
    c.setWall(42);
    expect(c.wallNow()).toBe(42);
  });

  it('advanceAsync drives code that awaits sleep in a loop; runAll drains', async () => {
    const c = new FakeClock({ mono: 0 });
    const ticks: number[] = [];
    const loop = (async () => {
      for (let i = 0; i < 3; i++) {
        await c.sleep(100);
        ticks.push(c.now());
      }
    })();
    await c.advanceAsync(250);
    expect(ticks).toEqual([100, 200]);
    await c.runAll();
    await loop;
    expect(ticks).toEqual([100, 200, 300]);
    const ac = new AbortController();
    const s = c.sleep(10, ac.signal);
    ac.abort();
    await expect(s).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.pending()).toBe(0);
  });
});

describe('ids', () => {
  it('crypto ids: uuid v4, lowercase hex tokens of the right length, never a $', () => {
    const ids = createCryptoIds();
    expect(ids.uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids.tokenHex(32)).toMatch(/^[0-9a-f]{64}$/);
    expect(ids.shortHex(7)).toMatch(/^[0-9a-f]{7}$/);
    expect(ids.tokenHex(16)).not.toBe(ids.tokenHex(16));
    expect(() => ids.tokenHex(0)).toThrow(RangeError);
    expect(() => ids.shortHex(1.5)).toThrow(RangeError);
  });

  it('fake ids are deterministic per seed and have the real shapes', () => {
    const a = new FakeIds('x');
    const b = new FakeIds('x');
    expect([a.uuidV4(), a.tokenHex(16), a.shortHex(8)]).toEqual([b.uuidV4(), b.tokenHex(16), b.shortHex(8)]);
    const c = new FakeIds();
    expect(c.uuidV4()).toMatch(/^[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}$/);
    expect(c.tokenHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(c.shortHex(5)).toMatch(/^[0-9a-f]{5}$/);
  });
});

describe('env port', () => {
  it('reports host facts and a string-only frozen snapshot', async () => {
    const env = createEnvPort();
    const snap = env.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.values(snap).every((v) => typeof v === 'string')).toBe(true);
    expect(env.homeDir()).toMatch(/^\//);
    expect(env.userName().length).toBeGreaterThan(0);
    expect(env.uid()).toBe(process.getuid?.() ?? -1);
    expect(['darwin', 'linux', 'other']).toContain(env.platform());
    expect(env.execPath()).toBe(process.execPath);
    expect(env.nodeVersion()).toBe(process.versions.node);
    expect(env.timeZone().length).toBeGreaterThan(0);
    expect(await env.lstat('/nonexistent/ccd')).toBeUndefined();
    expect((await env.lstat('/'))?.isDir).toBe(true);
    expect(await env.realpath('/')).toBe('/');
  });

  it('fake env is configurable', async () => {
    const env = new FakeEnv({
      vars: { X: '1' },
      realpaths: { '/var/x': '/private/var/x' },
      entries: { '/f': { isSymlink: true, isFile: false, isDir: false } },
    });
    expect(env.snapshot()['X']).toBe('1');
    expect(await env.realpath('/var/x')).toBe('/private/var/x');
    expect((await env.lstat('/f'))?.isSymlink).toBe(true);
    expect(await env.lstat('/none')).toBeUndefined();
  });
});
