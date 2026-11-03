import { existsSync } from 'node:fs';
// Contract of the real lifecheck host: runLifecheck over session/reaper.ts + session/registry-store.ts with the WP fakes
// (createFakePorts). No real process, tmux server or file is touched.
import { describe, expect, it } from 'vitest';

import { assertLifecheckPorts, createLifecheckHost, createLifecheckHostFromPorts } from '../../../src/cli/lifecheck-host.js';
import { runLifecheck } from '../../../src/cli/lifecheck.js';
import type { SessionKey } from '../../../src/model/ids.js';
import type { WallMs } from '../../../src/model/time.js';
import { RegistryStore, type SessionRecord as StoredRecord } from '../../../src/session/registry-store.js';
import { createFakePorts, type FakePortSet } from '../../../src/testing/fake-ports.js';

function stored(
  key: string,
  ownerPid: number,
  ownerStart: string,
  claudePid: number | undefined,
  claudeStart: string | undefined,
  over: Partial<StoredRecord> = {},
): StoredRecord {
  const now = 1_000 as WallMs;
  return {
    v: 2,
    sessionKey: key as SessionKey,
    owner: { pid: ownerPid, startTime: ownerStart },
    tmux: {
      bin: '/usr/bin/tmux',
      socketName: `ccd-${ownerPid}-${key}`,
      socketPath: `/tmp/tmux-501/ccd-${ownerPid}-${key}`,
      sessionName: `ccd-${key}`,
    },
    claude: {
      ...(claudePid === undefined ? {} : { pid: claudePid }),
      ...(claudeStart === undefined ? {} : { startTime: claudeStart }),
      exe: '/x/bin/claude.exe',
      version: '2.1.316',
    },
    claudeSessionId: `uuid-${key}`,
    initialSessionId: `uuid-${key}`,
    cwdRealpath: '/work/project',
    sessionDir: `/fake/run/ccd-${key}`,
    settingsFile: `/fake/run/ccd-${key}/settings.json`,
    settingsSha256: 'x',
    hook: { transport: 'http', port: 1234, socketPath: `/fake/run/ccd-${key}/hook.sock` },
    trustKeyAddedByLibrary: false,
    permissionMode: 'default',
    state: 'ready',
    lastEventSeq: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function setup(): { fp: FakePortSet; store: RegistryStore; logs: string[] } {
  const fp = createFakePorts({ ownerPid: 50, entries: { '/tmp/tmux-501': { isSymlink: false, isFile: false, isDir: true } } });
  const store = new RegistryStore(fp.state, () => fp.clock.wallNow());
  // tmux: kill-server succeeds, list-sessions says "no server"; everything else unknown
  fp.process.onExec((c) => {
    if (c.file === '/usr/bin/tmux' && c.args.includes('kill-server'))
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false };
    if (c.file === '/usr/bin/tmux') return { code: 1, signal: null, stdout: '', stderr: 'no server running', timedOut: false };
    if (c.file === '/bin/ls') return { code: 0, signal: null, stdout: 'ccd-input\nccd-verify-1\n', stderr: '', timedOut: false };
    return undefined;
  });
  return { fp, store, logs: [] };
}

describe('lifecheck host over the reaper (fakes)', () => {
  it('orphan is reaped and archived; dead is finalized; a hung owner is only reported; lifecheck.json is written', async () => {
    const { fp, store, logs } = setup();
    const p = fp.process;
    // s00000001: owner dead, Claude alive → orphan
    const deadOwner = p.addProcess({ command: 'node /app/a.js' });
    const deadOwnerStart = (await p.identity(deadOwner))?.startTime ?? '';
    p.exit(deadOwner);
    const claude1 = p.addProcess({ command: '/x/bin/claude.exe --session-id uuid-s00000001' });
    const c1Start = (await p.identity(claude1))?.startTime ?? '';
    await store.writeSession(stored('s00000001', deadOwner, deadOwnerStart, claude1, c1Start));
    // s00000002: owner dead, Claude gone, exits/ has the pane-died line → dead
    await store.writeSession(stored('s00000002', deadOwner, deadOwnerStart, 99_999, 'never'));
    await store.appendExit('s00000002' as SessionKey, 'died pane=%0 pid=99999 status=0 signal=');
    // s00000003: owner alive (ignores SIGUSR2) with a 5-min-old heartbeat → owned-hung
    const hungOwner = p.addProcess({ command: 'node /app/b.js', ignores: ['SIGUSR2'] });
    const hungStart = (await p.identity(hungOwner))?.startTime ?? '';
    const claude3 = p.addProcess({ command: '/x/bin/claude.exe --session-id uuid-s00000003' });
    await store.writeSession(
      stored('s00000003', hungOwner, hungStart, claude3, (await p.identity(claude3))?.startTime ?? '', {
        usageLimit: { resetsAtWall: (fp.clock.wallNow() - 600_000) as WallMs, since: 0 as WallMs },
      }),
    );
    await store.writeOwner({
      pid: hungOwner,
      startTime: hungStart,
      argv0: 'node',
      nodeVersion: '22',
      libVersion: '0',
      createdAt: 0 as WallMs,
      heartbeatAt: (fp.clock.wallNow() - 300_000) as WallMs,
    });

    const host = createLifecheckHostFromPorts(fp.ports, {
      libVersion: '0.0.0',
      distPath: '/pkg/dist/cli/main.js',
      selfPid: fp.ownerPid,
      socketProbeGapMs: 0,
      log: (l) => logs.push(l),
      readStateText: (rel) => Promise.resolve(fp.state.files.get(rel)),
    });
    const r = await runLifecheck(host, { signalHung: true });

    expect(r.sessions.map((s) => [s.key, s.classification])).toEqual([
      ['s00000001', 'orphan'],
      ['s00000002', 'dead'],
      ['s00000003', 'owned-hung'],
    ]);
    expect(r.sessions[2]?.heartbeatAgeMs).toBe(300_000);
    const kinds = r.actions.map((a) => [a.kind, a.sessionKey]);
    expect(kinds).toEqual([
      ['hungWhileLimited', 's00000003'],
      ['diagnosticsRequested', 's00000003'],
      ['reaped', 's00000001'],
      ['finalized', 's00000002'],
    ]);
    expect(r.actions.find((a) => a.kind === 'finalized')?.detail).toContain('exit: died pane=%0 pid=99999 status=0 signal=');
    expect(r.actions.find((a) => a.kind === 'reaped')).toMatchObject({ claudeSessionId: 'uuid-s00000001' });
    expect(r.lastRunOk, r.errors.join('; ')).toBe(true);

    // Claude of the orphan got SIGTERM; the hung owner got SIGUSR2 only and is still alive with its Claude
    expect(p.killCalls.filter((k) => k.pid === claude1).map((k) => k.sig)).toEqual(['SIGTERM']);
    expect(p.killCalls.filter((k) => k.pid === hungOwner).map((k) => k.sig)).toEqual(['SIGUSR2']);
    expect(p.isAlive(hungOwner)).toBe(true);
    expect(p.isAlive(claude3)).toBe(true);
    expect(p.killCalls.some((k) => k.pid === claude3)).toBe(false);

    // registry: orphan + dead archived, hung still live
    expect((await store.listSessions()).map((s) => s.sessionKey)).toEqual(['s00000003']);
    expect((await store.listArchive()).map((s) => s.sessionKey).sort()).toEqual(['s00000001', 's00000002']);
    // unknown ccd-* sockets are counted, never touched (P-REV-33)
    expect(r.unknownCctSockets).toBe(2);
    expect(p.execCalls.some((c) => c.file === '/bin/rm')).toBe(false);
    // lifecheck.json in the state dir
    const w = JSON.parse(fp.state.files.get('lifecheck.json') ?? '{}') as Record<string, unknown>;
    expect(w).toMatchObject({ lastRunOk: true, libVersion: '0.0.0', distPath: '/pkg/dist/cli/main.js', unknownCctSockets: 2 });
    expect(logs.some((l) => l.includes('looks hung'))).toBe(true);
  });

  it('an owner whose pid was reused is dead; SIGUSR2 is never sent to a reused pid', async () => {
    const { fp, store } = setup();
    const p = fp.process;
    const owner = p.addProcess({ command: 'node /app/a.js' });
    const start = (await p.identity(owner))?.startTime ?? '';
    p.reusePid(owner, '/usr/bin/some-daemon');
    await store.writeSession(stored('s0000000a', owner, start, undefined, undefined, { state: 'launching' }));
    const host = createLifecheckHostFromPorts(fp.ports, {
      selfPid: fp.ownerPid,
      socketProbeGapMs: 0,
      log: () => undefined,
      readStateText: () => Promise.resolve(undefined),
    });
    expect(await host.signalOwnerDiagnostics({ pid: owner, startTime: start })).toBe(false);
    const r = await runLifecheck(host, { signalHung: true });
    expect(r.sessions[0]?.classification).not.toMatch(/^owned/);
    expect(p.killCalls.filter((k) => k.pid === owner)).toEqual([]);
  });

  it('the caller itself is never reaped (selfPid)', async () => {
    const { fp, store } = setup();
    const me = fp.ownerPid;
    const myStart = (await fp.process.identity(me))?.startTime ?? '';
    const c = fp.process.addProcess({ command: '/x/bin/claude.exe --session-id uuid-s0000000b' });
    await store.writeSession(stored('s0000000b', me, myStart, c, (await fp.process.identity(c))?.startTime ?? ''));
    await store.writeOwner({
      pid: me,
      startTime: myStart,
      argv0: 'node',
      nodeVersion: '22',
      libVersion: '0',
      createdAt: 0 as WallMs,
      heartbeatAt: fp.clock.wallNow(),
    });
    const host = createLifecheckHostFromPorts(fp.ports, {
      selfPid: me,
      socketProbeGapMs: 0,
      log: () => undefined,
      readStateText: () => Promise.resolve(undefined),
    });
    const r = await runLifecheck(host, { signalHung: false });
    expect(r.sessions[0]?.classification).toBe('owned-alive');
    expect(r.actions).toEqual([]);
    expect(fp.process.isAlive(c)).toBe(true);
  });

  it('readExits refuses odd keys', async () => {
    const { fp } = setup();
    const host = createLifecheckHostFromPorts(fp.ports, { readStateText: () => Promise.resolve('x\n') });
    expect(await host.readExits('../../etc/passwd')).toEqual([]);
    expect(await host.readExits('s1')).toEqual(['x']);
  });
});

describe('node composition root loading', () => {
  it('shape-checks the ports and insists on the requested state dir', () => {
    const fp = createFakePorts();
    expect(() => {
      assertLifecheckPorts(fp.ports, fp.state.root);
    }).not.toThrow();
    expect(() => {
      assertLifecheckPorts(fp.ports, '/somewhere/else');
    }).toThrow(/state root/);
    expect(() => {
      assertLifecheckPorts({ ...fp.ports, process: {} }, fp.state.root);
    }).toThrow(/process\.isAlive/);
    expect(() => {
      assertLifecheckPorts(null, '/x');
    }).toThrow(/no object/);
  });

  it('builds the host from runtime/node.ts createNodePorts rooted at --state-dir, without touching the disk', async () => {
    // WP-INT landed runtime/node.ts: createNodePorts must root the state store at --state-dir (assertLifecheckPorts checks it)
    // and building the host must not create the directory (only a lifecheck run writes there).
    const dir = '/nonexistent/ccd-state-for-test';
    const host = await createLifecheckHost(dir);
    expect(typeof host.reapPass).toBe('function');
    expect(existsSync(dir)).toBe(false);
  });
});
