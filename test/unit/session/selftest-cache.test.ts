// session/selftest-cache.ts — once per (process, version, trust, transport), 24 h TTL, HTTP failure honoured by every process
// (D-35, §3.1 steps 7 and 15; P-REV-23, P-HOOK-06).
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { FakeStateStore } from '../../../src/platform/runtime-dir/fake-state-store.js';
import {
  SELFTEST_CACHE_FILE,
  SELFTEST_TTL_MS,
  createSelfTestCache,
  httpSelfTestFailedRecently,
} from '../../../src/session/selftest-cache.js';
import type { SelfTestKey } from '../../../src/session/selftest-cache.js';

const key: SelfTestKey = { claudeVersion: '2.1.316', cwdRealpath: '/w', trusted: true, transport: 'http' };
const T0 = 1_800_000_000_000;

describe('self-test cache', () => {
  it('a pass is cached for the same process and exact key only', async () => {
    const state = new FakeStateStore({ clock: new FakeClock() });
    const c = createSelfTestCache({ state, pid: 100 });
    expect(await c.cachedPass(key, T0)).toBe(false);
    await c.record(key, 'pass', T0);
    expect(await c.cachedPass(key, T0 + 1000)).toBe(true);
    expect(await c.cachedPass({ ...key, transport: 'unix' }, T0)).toBe(false);
    expect(await c.cachedPass({ ...key, trusted: false }, T0)).toBe(false);
    expect(await c.cachedPass({ ...key, claudeVersion: '2.1.317' }, T0)).toBe(false);
    expect(await c.cachedPass({ ...key, cwdRealpath: '/other' }, T0)).toBe(false);
  });

  it('expires after 24 h', async () => {
    const c = createSelfTestCache({ state: new FakeStateStore({ clock: new FakeClock() }), pid: 100 });
    await c.record(key, 'pass', T0);
    expect(await c.cachedPass(key, T0 + SELFTEST_TTL_MS - 1)).toBe(true);
    expect(await c.cachedPass(key, T0 + SELFTEST_TTL_MS)).toBe(false);
  });

  it('another process does not reuse a pass (once per library process) but sees it on disk; a second package copy of the same process does', async () => {
    const state = new FakeStateStore({ clock: new FakeClock() });
    await createSelfTestCache({ state, pid: 100 }).record(key, 'pass', T0);
    expect(await createSelfTestCache({ state, pid: 200 }).cachedPass(key, T0)).toBe(false);
    const sameProcessOtherCopy = createSelfTestCache({ state, pid: 100 });
    sameProcessOtherCopy.forgetProcess();
    expect(await sameProcessOtherCopy.cachedPass(key, T0)).toBe(true); // via disk, pid matches
  });

  it('independent state stores never share memory entries', async () => {
    await createSelfTestCache({ state: new FakeStateStore({ clock: new FakeClock() }), pid: 100 }).record(key, 'pass', T0);
    expect(await createSelfTestCache({ state: new FakeStateStore({ clock: new FakeClock() }), pid: 100 }).cachedPass(key, T0)).toBe(false);
  });

  it('an HTTP failure is visible to every process for 24 h (transport auto → unix, §3.1 step 7)', async () => {
    const state = new FakeStateStore({ clock: new FakeClock() });
    await createSelfTestCache({ state, pid: 100 }).record(key, 'fail', T0, 'ack');
    expect(await httpSelfTestFailedRecently(state, '2.1.316', '/w', T0 + 60_000, 999)).toBe(true);
    expect(await httpSelfTestFailedRecently(state, '2.1.316', '/other', T0, 999)).toBe(false);
    expect(await httpSelfTestFailedRecently(state, '2.1.316', '/w', T0 + SELFTEST_TTL_MS + 1, 999)).toBe(false);
    const c = createSelfTestCache({ state, pid: 100 });
    expect(await c.httpFailedRecently('2.1.316', '/w', T0)).toBe(true); // from memory
    const unixFail = new FakeStateStore({ clock: new FakeClock() });
    await createSelfTestCache({ state: unixFail, pid: 1 }).record({ ...key, transport: 'unix' }, 'fail', T0);
    expect(await httpSelfTestFailedRecently(unixFail, '2.1.316', '/w', T0, 2)).toBe(false);
  });

  it('writes a v1 file through the state store, replaces the entry for the same key, drops expired ones', async () => {
    const state = new FakeStateStore({ clock: new FakeClock() });
    const c = createSelfTestCache({ state, pid: 7 });
    await c.record(key, 'fail', T0, 'ack');
    await c.record({ ...key, transport: 'unix' }, 'pass', T0 + SELFTEST_TTL_MS + 5);
    await c.record({ ...key, transport: 'unix' }, 'pass', T0 + SELFTEST_TTL_MS + 6);
    const file = JSON.parse(state.files.get(SELFTEST_CACHE_FILE) ?? '{}') as {
      v: number;
      entries: { transport: string; atWall: number }[];
    };
    expect(file.v).toBe(1);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({ transport: 'unix', result: 'pass', pid: 7, atWall: T0 + SELFTEST_TTL_MS + 6 });
  });

  it('a corrupt or foreign file costs one self-test, never an error', async () => {
    const state = new FakeStateStore({ clock: new FakeClock() });
    state.files.set(SELFTEST_CACHE_FILE, '{not json');
    const c = createSelfTestCache({ state, pid: 1 });
    expect(await c.cachedPass(key, T0)).toBe(false);
    state.files.set(SELFTEST_CACHE_FILE, JSON.stringify({ v: 1, entries: [{ junk: true }, null] }));
    expect(await c.httpFailedRecently('2.1.316', '/w', T0)).toBe(false);
    await c.record(key, 'pass', T0);
    expect(await c.cachedPass(key, T0)).toBe(true);
  });
});
