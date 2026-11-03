import { describe, expect, it } from 'vitest';

import { parseOwnerRecord, parseSessionRecord } from '../../../src/cli/host.js';
import {
  classifyStatus,
  formatLifecheckReport,
  formatStatus,
  isPastUsageReset,
  RESET_GRACE_MS,
  runLifecheck,
  STATUS_STALE_MS,
  type StatusProbe,
} from '../../../src/cli/lifecheck.js';
import { emptyPass, memLifecheck, NOW, rec, reapedLine } from './helpers.js';

describe('isPastUsageReset', () => {
  it('needs a usageLimit entry whose reset is older than the grace', () => {
    expect(isPastUsageReset(rec('s1', { state: 'ready', usageLimit: { resetsAtWall: NOW - RESET_GRACE_MS - 1 } }), NOW)).toBe(true);
    expect(isPastUsageReset(rec('s1', { state: 'ready', usageLimit: { resetsAtWall: NOW - 1000 } }), NOW)).toBe(false);
    expect(isPastUsageReset(rec('s1', { state: 'ready' }), NOW)).toBe(false);
    expect(isPastUsageReset(rec('s1', { state: 'ready', usageLimit: {} }), NOW)).toBe(false);
  });
});

describe('runLifecheck (§3.12)', () => {
  it('owned-alive: no action; classify before the reap pass; lifecheck.json has the §3.12 shape', async () => {
    const { host, s } = memLifecheck({
      sessions: [rec('s1')],
      classes: new Map([['s1', { classification: 'owned-alive', heartbeatAt: NOW - 1000 }]]),
      pass: emptyPass({ skippedLive: ['s1'], unknownCcdSockets: 2 }),
    });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.lastRunOk).toBe(true);
    expect(r.actions).toEqual([]);
    expect(r.sessions).toEqual([
      {
        key: 's1',
        classification: 'owned-alive',
        claudeSessionId: 'uuid-s1',
        ownerPid: 100,
        claudePid: 200,
        state: 'idle',
        heartbeatAgeMs: 1000,
      },
    ]);
    expect(s.calls).toEqual(['classify:s1', 'reapPass']);
    expect(s.written).toHaveLength(1);
    const w = s.written[0] as Record<string, unknown>;
    expect(Object.keys(w).sort()).toEqual(
      ['actions', 'distPath', 'durationMs', 'errors', 'lastRunOk', 'libVersion', 'ranAt', 'sessions', 'unknownCcdSockets'].sort(),
    );
    expect(w).toMatchObject({ ranAt: NOW, lastRunOk: true, libVersion: '9.9.9', distPath: '/pkg/dist/cli/main.js', unknownCcdSockets: 2 });
  });

  it('owned-hung: logged and reported, never killed; SIGUSR2 only with --signal-hung (P-LIFE-58)', async () => {
    const base = {
      sessions: [rec('s1')],
      classes: new Map([['s1', { classification: 'owned-hung' as const, heartbeatAt: NOW - 120_000 }]]),
      pass: emptyPass({ skippedLive: ['s1'] }),
    };
    const a = memLifecheck(base);
    const r1 = await runLifecheck(a.host, { signalHung: false });
    expect(r1.actions).toEqual([{ kind: 'hung', sessionKey: 's1', claudeSessionId: 'uuid-s1', detail: 'owner 100: heartbeat 120 s old' }]);
    expect(r1.lastRunOk).toBe(true);
    expect(a.s.calls.some((c) => c.startsWith('sigusr2'))).toBe(false);
    expect(a.s.logs[0]).toMatch(/looks hung.*not killed/);

    const b = memLifecheck(base);
    const r2 = await runLifecheck(b.host, { signalHung: true });
    expect(r2.actions.map((x) => x.kind)).toEqual(['hung', 'diagnosticsRequested']);
    expect(r2.actions[1]?.detail).toBe('SIGUSR2 sent');
    expect(b.s.calls).toContain('sigusr2:100');

    const c = memLifecheck({ ...base, signalOk: false });
    expect((await runLifecheck(c.host, { signalHung: true })).actions[1]?.detail).toBe('SIGUSR2 failed');
  });

  it('hungWhileLimited: a usage-limited session past its reset with a hung owner is reported, not woken', async () => {
    const { host, s } = memLifecheck({
      sessions: [rec('s1', { state: 'ready', usageLimit: { resetsAtWall: NOW - 10 * 60_000 } })],
      classes: new Map([['s1', { classification: 'owned-hung' }]]),
    });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.actions).toEqual([
      { kind: 'hungWhileLimited', sessionKey: 's1', claudeSessionId: 'uuid-s1', detail: 'owner 100: no heartbeat record' },
    ]);
    expect(r.sessions[0]?.heartbeatAgeMs).toBeUndefined();
    expect(s.calls).toEqual(['classify:s1', 'reapPass']); // no input, no wake, nothing else
  });

  it('orphan: reaped by the reaper pass; the resume id is reported (§3.8 recovery)', async () => {
    const { host } = memLifecheck({
      sessions: [rec('s1')],
      classes: new Map([['s1', { classification: 'orphan' }]]),
      pass: emptyPass({ reaped: [reapedLine('s1', { trustUnseeded: true })] }),
    });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.actions).toEqual([
      {
        kind: 'reaped',
        sessionKey: 's1',
        claudeSessionId: 'uuid-s1',
        detail: 'claude=terminated server=killed socket unlinked session dir removed trust unseeded',
      },
    ]);
    expect(r.lastRunOk).toBe(true);
    expect(formatLifecheckReport(r)).toContain('(resume: uuid-s1)');
  });

  it('a Claude that survived SIGKILL → reapFailed, lastRunOk:false', async () => {
    const { host } = memLifecheck({
      sessions: [rec('s1')],
      classes: new Map([['s1', { classification: 'orphan' }]]),
      pass: emptyPass({ reaped: [reapedLine('s1', { claude: 'survived', server: 'failed', socketUnlinked: false })] }),
    });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.actions[0]).toMatchObject({ kind: 'reapFailed', detail: 'claude=survived server=failed session dir removed' });
    expect(r.lastRunOk).toBe(false);
  });

  it.each(['gone', 'identity-mismatch', 'killed', 'n/a'])('claude outcome %s counts as down', async (claude) => {
    const { host } = memLifecheck({
      sessions: [rec('s1')],
      classes: new Map([['s1', { classification: 'orphan' }]]),
      pass: emptyPass({ reaped: [reapedLine('s1', { claude })] }),
    });
    expect((await runLifecheck(host, { signalHung: false })).actions[0]?.kind).toBe('reaped');
  });

  it("dead: finalized; the last exits/ line (not the reaper's own) is in the detail", async () => {
    const { host } = memLifecheck({
      sessions: [rec('s1')],
      classes: new Map([['s1', { classification: 'dead' }]]),
      exits: new Map([
        ['s1', ['died pane=%0 pid=200 status=0 signal=', 'watch=owner-gone', 'reaped by=lifecheck claude=gone server=gone']],
      ]),
      pass: emptyPass({ reaped: [reapedLine('s1', { claude: 'gone', server: 'gone', socketUnlinked: false })] }),
    });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.actions).toEqual([
      {
        kind: 'finalized',
        sessionKey: 's1',
        claudeSessionId: 'uuid-s1',
        detail: 'exit: watch=owner-gone; claude=gone server=gone session dir removed',
      },
    ]);
  });

  it('dead without an exit record', async () => {
    const { host } = memLifecheck({
      sessions: [rec('s1')],
      classes: new Map([['s1', { classification: 'dead' }]]),
      pass: emptyPass({ reaped: [reapedLine('s1', { claude: 'n/a' })] }),
    });
    expect((await runLifecheck(host, { signalHung: false })).actions[0]?.detail).toMatch(/^no exit record; /);
  });

  it('a session the pass reaped but we never listed (raced in) is still reported', async () => {
    const { host } = memLifecheck({ pass: emptyPass({ reaped: [reapedLine('s9')] }) });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.actions).toEqual([{ kind: 'reaped', sessionKey: 's9', detail: expect.stringContaining('claude=terminated') as unknown }]);
  });

  it('per-session errors do not stop the run; reaper errors and swept sockets are reported', async () => {
    const { host, s } = memLifecheck({
      sessions: [rec('s1'), rec('s2')],
      throwFor: 's1',
      classes: new Map([['s2', { classification: 'orphan' }]]),
      pass: emptyPass({ reaped: [reapedLine('s2')], socketsUnlinked: ['/tmp/tmux-501/ccd-100-old'], errors: ['s3: EACCES'] }),
    });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.actions.map((a) => a.kind)).toEqual(['error', 'reaped', 'socketSwept']);
    expect(r.errors).toEqual(['session s1: ps failed', 'reap: s3: EACCES']);
    expect(r.lastRunOk).toBe(false);
    expect(s.calls).toEqual(['classify:s1', 'classify:s2', 'reapPass']);
  });

  it('a failing reap pass (lock busy) still writes lifecheck.json with lastRunOk:false', async () => {
    const { host, s } = memLifecheck({ reapError: new Error('lock held by 4242') });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.lastRunOk).toBe(false);
    expect(r.errors).toEqual(['reap: lock held by 4242']);
    expect(s.written).toHaveLength(1);
  });

  it('listSessions failure is an error but the reap pass still runs', async () => {
    const { host, s } = memLifecheck({ listError: new Error('EACCES'), pass: emptyPass({ unknownCcdSockets: 1 }) });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.errors).toEqual(['listSessions: EACCES']);
    expect(r.unknownCcdSockets).toBe(1);
    expect(s.calls).toEqual(['reapPass']);
  });

  it('a lifecheck.json write failure is reported in the returned report', async () => {
    const { host } = memLifecheck();
    host.writeLifecheckJson = () => Promise.reject(new Error('ENOSPC'));
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.lastRunOk).toBe(false);
    expect(r.errors).toEqual(['writeLifecheckJson: ENOSPC']);
  });

  it('formats a readable report', () => {
    const t = formatLifecheckReport({
      ranAt: NOW,
      lastRunOk: false,
      libVersion: '1',
      distPath: '/d',
      actions: [{ kind: 'socketSwept', detail: '/tmp/x' }],
      unknownCcdSockets: 3,
      sessions: [{ key: 's1', classification: 'dead', claudeSessionId: 'u', ownerPid: 1 }],
      durationMs: 5,
      errors: ['x: y'],
    });
    expect(t).toContain('lifecheck FAILED at 2026-11-03T12:00:00.000Z (5 ms)');
    expect(t).toContain('s1 dead owner=1 claude=- session=u');
    expect(t).toContain('3 ccd-* socket(s) not named by the registry (left alone)');
    expect(t).toContain('error x: y');
    expect(
      formatLifecheckReport({
        ranAt: NOW,
        lastRunOk: true,
        libVersion: '1',
        distPath: '/d',
        actions: [],
        unknownCcdSockets: 0,
        sessions: [],
        durationMs: 0,
        errors: [],
      }),
    ).toContain('no registered sessions');
  });
});

describe('record parsing', () => {
  const good = {
    v: 2,
    owner: { pid: 10, startTime: 'x' },
    tmux: { bin: '/t', socketName: 'ccd-1', socketPath: '/tmp/s', sessionName: 'ccd-s1', paneId: '%0' },
    claude: { pid: 11, startTime: 'y', exe: '/c/claude.exe', version: '2.1.316' },
    claudeSessionId: 'abc',
    state: 'usageLimited',
    usageLimit: { resetsAtWall: 5 },
    ownerWatch: { pid: 12 },
    trustKeyAddedByLibrary: true,
    extra: 'ignored',
  };
  it('parses the §3.8 record leniently', () => {
    const r = parseSessionRecord('s1', good);
    expect(r).toEqual({
      record: {
        key: 's1',
        v: 2,
        owner: { pid: 10, startTime: 'x' },
        tmux: { bin: '/t', socketName: 'ccd-1', socketPath: '/tmp/s', sessionName: 'ccd-s1', paneId: '%0' },
        claude: { pid: 11, startTime: 'y', exe: '/c/claude.exe', version: '2.1.316' },
        claudeSessionId: 'abc',
        state: 'usageLimited',
        usageLimit: { resetsAtWall: 5 },
        ownerWatch: { pid: 12 },
        trustKeyAddedByLibrary: true,
      },
    });
    expect(parseSessionRecord('s1', { ...good, usageLimit: { resetsAt: 7 } })).toMatchObject({
      record: { usageLimit: { resetsAtWall: 7 } },
    });
    // a `launching` record has no claude pid yet (§3.1 step 11)
    const launching = parseSessionRecord('s1', {
      ...good,
      claude: { exe: '/c/claude.exe', version: '2.1.316' },
      claudeSessionId: undefined,
      initialSessionId: 'i1',
    });
    expect(launching).toMatchObject({ record: { claude: { exe: '/c/claude.exe' }, claudeSessionId: 'i1' } });
    expect('record' in launching && launching.record.claude.pid).toBe(undefined);
  });
  it.each([
    ['null', null],
    ['no owner', { ...good, owner: undefined }],
    ['pid 1', { ...good, claude: { ...good.claude, pid: 1 } }],
    ['no claude exe', { ...good, claude: { pid: 11 } }],
    ['pid string', { ...good, owner: { pid: '10', startTime: 'x' } }],
    ['no tmux bin', { ...good, tmux: { ...good.tmux, bin: undefined } }],
    ['no session id', { ...good, claudeSessionId: 3, initialSessionId: undefined }],
  ])('rejects %s', (_n, v) => {
    expect(parseSessionRecord('s1', v)).toHaveProperty('error');
  });
  it('parses owner records', () => {
    expect(parseOwnerRecord({ pid: 10, startTime: 'x', heartbeatAt: 5, libVersion: '1' })).toEqual({
      pid: 10,
      startTime: 'x',
      heartbeatAt: 5,
      libVersion: '1',
    });
    expect(parseOwnerRecord({ pid: 10, startTime: 'x' })).toBeUndefined();
    expect(parseOwnerRecord([])).toBeUndefined();
  });
});

describe('classifyStatus (ccd lifecheck status, §3.12)', () => {
  const ok: StatusProbe = {
    platform: 'darwin',
    shimInstalled: true,
    plistInstalled: true,
    launchd: { loaded: true, state: 'not running', lastExitCode: '0' },
    target: { distPath: '/d/main.js', node: '/n' },
    distPathExists: true,
    last: { ranAt: NOW - 60_000, lastRunOk: true },
    now: NOW,
  };
  const cases: [string, Partial<StatusProbe>, string, number][] = [
    ['healthy', {}, 'ok', 0],
    ['no shim', { shimInstalled: false }, 'notInstalled', 3],
    ['no plist on darwin', { plistInstalled: false }, 'notInstalled', 3],
    ['linux without plist is fine', { platform: 'linux' }, 'ok', 0],
    ['never ran', { last: {} }, 'neverRan', 2],
    ['stale > 15 min', { last: { ranAt: NOW - STATUS_STALE_MS - 1, lastRunOk: true } }, 'stale', 2],
    ['exactly 15 min is not stale', { last: { ranAt: NOW - STATUS_STALE_MS, lastRunOk: true } }, 'ok', 0],
    ['last run failed', { last: { ranAt: NOW - 1000, lastRunOk: false, error: 'node-not-found' } }, 'failing', 1],
    ['dist path gone (P-REV-32)', { distPathExists: false }, 'failing', 1],
    ['no distPath in target', { target: {} }, 'failing', 1],
    ['not loaded in launchd', { launchd: { loaded: false } }, 'failing', 1],
    ['stale wins over failing', { distPathExists: false, last: { ranAt: NOW - 3_600_000, lastRunOk: false } }, 'stale', 2],
  ];
  it.each(cases)('%s', (_n, over, health, code) => {
    const probe: StatusProbe = { ...ok, ...over };
    if (over.platform === 'linux') {
      delete probe.plistInstalled;
      delete probe.launchd;
    }
    const s = classifyStatus(probe);
    expect(s.health).toBe(health);
    expect(s.exitCode).toBe(code);
    expect(formatStatus(s)).toContain(`lifecheck status: ${health}`);
  });
  it('reports problems in words', () => {
    const s = classifyStatus({ ...ok, distPathExists: false, last: { ranAt: NOW - 1000, lastRunOk: false, error: 'distPath-missing' } });
    expect(s.problems.join('\n')).toMatch(/does not exist[\s\S]*last run failed: distPath-missing/);
  });
});
