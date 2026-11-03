// WP-12 registry-store (DESIGN.md §3.8 state dir layout, D-38; P-LIFE-10, P-REV-34).
import { describe, expect, it } from 'vitest';
import type { SessionKey } from '../../../src/model/ids.js';
import type { WallMs } from '../../../src/model/time.js';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { FakeStateStore } from '../../../src/platform/runtime-dir/fake-state-store.js';
import { ARCHIVE_TTL_MS, isSessionRecord, lastDeath, parseExitLine, RegistryStore } from '../../../src/session/registry-store.js';
import { record } from './wp12-helpers.js';

const KEY = 's0000c0de' as SessionKey;

function setup(): { clock: FakeClock; state: FakeStateStore; store: RegistryStore } {
  const clock = new FakeClock();
  const state = new FakeStateStore({ clock, pid: 4242, isAlive: () => true });
  return { clock, state, store: new RegistryStore(state, () => clock.wallNow()) };
}

describe('sessions/ (P-LIFE-10)', () => {
  it('write, read, update, list and remove a record; updatedAt follows the clock', async () => {
    const { store, state, clock } = setup();
    await store.writeSession(record());
    expect(state.files.has(`sessions/${KEY}.json`)).toBe(true);
    expect((await store.readSession(KEY))?.state).toBe('ready');
    clock.jumpWall(5_000);
    const up = await store.updateSession(KEY, { state: 'closing', status: 'idle', usageLimit: { since: 7 as WallMs } });
    expect(up?.state).toBe('closing');
    expect(up?.updatedAt).toBe(clock.wallNow());
    expect(up?.createdAt).toBe(1);
    const cleared = await store.updateSession(KEY, {}, ['usageLimit']);
    expect(cleared?.usageLimit).toBeUndefined();
    expect((await store.listSessions()).map((r) => r.sessionKey)).toEqual([KEY]);
    await store.removeSession(KEY);
    expect(await store.readSession(KEY)).toBeUndefined();
    expect(await store.updateSession(KEY, { state: 'ready' })).toBeUndefined();
  });

  it('damaged or foreign files are ignored, never trusted', async () => {
    const { store, state } = setup();
    state.files.set('sessions/s00000001.json', '{not json');
    state.files.set('sessions/s00000002.json', JSON.stringify({ v: 1, sessionKey: 's00000002' }));
    state.files.set('sessions/README', 'x');
    await store.writeSession(record());
    expect((await store.listSessions()).map((r) => r.sessionKey)).toEqual([KEY]);
    expect(isSessionRecord({ ...record(), sessionKey: '../x' })).toBe(false);
  });

  it('keys are validated (no path traversal)', async () => {
    const { store } = setup();
    await expect(store.readSession('../../etc' as SessionKey)).rejects.toThrow(/invalid session key/);
  });
});

describe('updateSession vs archive (no resurrection)', () => {
  it('a persist whose read happened before archive never writes the archived record back', async () => {
    const { store, state } = setup();
    await store.writeSession(record());
    // hold the persist's write of sessions/<key>.json until archive has had every chance to run
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const orig = state.writeJsonAtomic.bind(state);
    let held = false;
    state.writeJsonAtomic = async (rel: string, v: unknown): Promise<void> => {
      if (!held && rel === `sessions/${KEY}.json`) {
        held = true;
        await gate;
      }
      return orig(rel, v);
    };
    const up = store.updateSession(KEY, { status: 'exited' });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const ar = store.archive(KEY, { reapedBy: 'close' });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    release();
    await Promise.all([up, ar]);
    expect(state.files.has(`sessions/${KEY}.json`)).toBe(false);
    expect((await store.readArchive(KEY))?.status).toBe('exited');
    // a later persist is a no-op
    expect(await store.updateSession(KEY, { status: 'idle' })).toBeUndefined();
    expect(state.files.has(`sessions/${KEY}.json`)).toBe(false);
  });
});

describe('archive/ (7 days, resume lookups)', () => {
  it('archive moves the record and keeps the exit info; it is idempotent', async () => {
    const { store, state } = setup();
    await store.writeSession(record());
    const a = await store.archive(KEY, { reapedBy: 'close', exit: { exitStatus: 0, signal: null, reason: 'closed' } });
    expect(a?.state).toBe('exited');
    expect(a?.exit?.reason).toBe('closed');
    expect(state.files.has(`sessions/${KEY}.json`)).toBe(false);
    expect(state.files.has(`archive/${KEY}.json`)).toBe(true);
    const again = await store.archive(KEY, { reapedBy: 'reaper' });
    expect(again?.reapedBy).toBe('close');
    expect((await store.findArchivedByClaudeSessionId('00000000-0000-4000-8000-000000000001'))?.sessionKey).toBe(KEY);
  });

  it('reaper archives get state reaped; pruneArchive drops entries older than 7 days', async () => {
    const { store, clock } = setup();
    await store.writeSession(record());
    expect((await store.archive(KEY, { reapedBy: 'reaper' }))?.state).toBe('reaped');
    const k2 = 's00000002' as SessionKey;
    clock.jumpWall(ARCHIVE_TTL_MS - 1000);
    await store.writeSession(record(k2));
    await store.archive(k2, { reapedBy: 'close' });
    clock.jumpWall(2000);
    expect(await store.pruneArchive()).toEqual([KEY]);
    expect((await store.listArchive()).map((r) => r.sessionKey)).toEqual([k2]);
  });
});

describe('owners/, exits/, lock, lifecheck target', () => {
  it('owner record + heartbeat', async () => {
    const { store, clock } = setup();
    await store.writeOwner({
      pid: 4242,
      startTime: 'x',
      argv0: '/n',
      nodeVersion: '22',
      libVersion: '0.0.0',
      createdAt: 1 as WallMs,
      heartbeatAt: 1 as WallMs,
    });
    clock.jumpWall(10_000);
    await store.heartbeat(4242);
    expect((await store.readOwner(4242))?.heartbeatAt).toBe(clock.wallNow());
    await store.heartbeat(9999); // unknown owner: no-op
    expect(await store.readOwner(9999)).toBeUndefined();
    expect((await store.listOwners()).map((o) => o.pid)).toEqual([4242]);
    await store.removeOwner(4242);
    expect(await store.listOwners()).toEqual([]);
  });

  it('P-REV-34: every path is absolute and validated for the tmux run-shell line', () => {
    const { store, state } = setup();
    expect(store.exitsLogPath(KEY)).toBe(`${state.root}/exits/${KEY}.log`);
    expect(store.ownerWatchLogPath(KEY).startsWith('/')).toBe(true);
    const odd = new RegistryStore(new FakeStateStore({ clock: new FakeClock(), root: '/my state/x' }), () => 0 as WallMs);
    expect(() => odd.exitsLogPath(KEY)).toThrow(/run-shell/);
  });

  it('exits log lines: append (newlines flattened) and parse the last death', async () => {
    const { store, state } = setup();
    await store.appendExit(KEY, 'launched owner=4242\nwall=1');
    state.files.set(`exits/${KEY}.log`, `${state.files.get(`exits/${KEY}.log`) ?? ''}died pane=%0 pid=50000 status=143 signal=\n`);
    const text = state.files.get(`exits/${KEY}.log`) ?? '';
    expect(text.split('\n')[0]).toBe('launched owner=4242 wall=1');
    expect(lastDeath(text)).toEqual({ exitStatus: 143, signal: null });
    expect(lastDeath('died pane=%0 pid=1 status= signal=SIGHUP\n')).toEqual({ exitStatus: null, signal: 'SIGHUP' });
    expect(lastDeath('launched x=1')).toBeUndefined();
    // tmux 3.5 prints the name, 3.3/3.4 the number, 3.2a nothing (CI on Linux)
    expect(lastDeath('died pane=%0 pid=1 status= signal=term\n')).toEqual({ exitStatus: null, signal: 'SIGTERM' });
    expect(lastDeath('died pane=%0 pid=1 status= signal=15\n')).toEqual({ exitStatus: null, signal: 'SIGTERM' });
    expect(lastDeath('died pane=%0 pid=1 status= signal=\n')).toEqual({ exitStatus: null, signal: null });
    expect(parseExitLine('watch=owner-gone ownerPid=1 claude=terminated').kind).toBe('watch');
    expect(parseExitLine('watch=owner-gone ownerPid=1 claude=terminated').fields['claude']).toBe('terminated');
    await store.removeExits(KEY);
    expect(state.files.has(`exits/${KEY}.log`)).toBe(false);
  });

  it('withLock uses the shared `lock` file', async () => {
    const { store, state } = setup();
    let inside = false;
    await store.withLock(() => {
      inside = state.isLocked('lock');
      return Promise.resolve();
    });
    expect(inside).toBe(true);
    expect(state.isLocked('lock')).toBe(false);
  });

  it('lifecheck-target.json is rewritten with writtenAt', async () => {
    const { store, clock } = setup();
    await store.writeLifecheckTarget({ distPath: '/d/cli/main.js', nodePath: '/n', libVersion: '0.0.0' });
    expect(await store.readLifecheckTarget()).toEqual({
      distPath: '/d/cli/main.js',
      nodePath: '/n',
      libVersion: '0.0.0',
      writtenAt: clock.wallNow(),
    });
  });
});
