// WP-12 reaper (DESIGN.md §3.8, rev 2 §10 G21; P-TMUX-39, P-LIFE-11/44/45, P-REV-33/34/46).
import { describe, expect, it } from 'vitest';
import type { SessionKey } from '../../../src/model/ids.js';
import type { WallMs } from '../../../src/model/time.js';
import type { ExecResult } from '../../../src/platform/ports.js';
import type { ExecCall } from '../../../src/platform/process/fake-process.js';
import {
  classifySession,
  defaultSocketDir,
  isOwnerAlive,
  reap,
  releaseTrustLocked,
  terminateVerified,
  tmuxTarget,
  verifyClaudeIdentity,
  type ReaperDeps,
} from '../../../src/session/reaper.js';
import { RegistryStore, TRUST_SEEDS_FILE } from '../../../src/session/registry-store.js';
import { FAKE_GLOBAL_CONFIG_PATH } from '../../../src/platform/settings/fake-config.js';
import { createFakePorts, type FakePortSet } from '../../../src/testing/fake-ports.js';
import { pump, record } from './wp12-helpers.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false });
const fail = (stderr = 'no server running on /tmp/tmux-501/x'): ExecResult => ({
  code: 1,
  signal: null,
  stdout: '',
  stderr,
  timedOut: false,
});

interface World {
  fakes: FakePortSet;
  store: RegistryStore;
  deps: ReaperDeps;
  execs: ExecCall[];
}

function world(o: { socketEntries?: string[]; serverAnswers?: (call: ExecCall, n: number) => boolean; lsOut?: string } = {}): World {
  const entries: Record<string, { isSymlink: boolean; isFile: boolean; isDir: boolean }> = {
    '/tmp/tmux-501': { isSymlink: false, isFile: false, isDir: true },
  };
  for (const p of o.socketEntries ?? []) entries[p] = { isSymlink: false, isFile: true, isDir: false };
  const fakes = createFakePorts({ entries });
  const store = new RegistryStore(fakes.state, () => fakes.clock.wallNow());
  const execs: ExecCall[] = [];
  let probes = 0;
  fakes.process.onExec((c) => {
    execs.push(c);
    const sub = c.args.at(-1);
    if (c.file === '/bin/rm') return ok();
    if (c.file === '/bin/ls') return ok(o.lsOut ?? '');
    if (sub === 'kill-server') return ok();
    if (sub === 'list-sessions') return (o.serverAnswers?.(c, ++probes) ?? false) ? ok('ccd-x: 1 windows') : fail();
    return undefined;
  });
  const deps: ReaperDeps = {
    process: fakes.process,
    clock: fakes.clock,
    env: fakes.env,
    runtimeDir: fakes.runtimeDir,
    claudeConfig: fakes.claudeConfig,
    logger: fakes.logger,
    store,
  };
  return { fakes, store, deps, execs };
}

/** A dead owner (pid gone) with a live, identity-matching Claude. */
function orphan(
  w: World,
  key: SessionKey,
  o: { claudeIgnores?: string[]; trustAdded?: boolean; configPath?: string } = {},
): { claudePid: number } {
  const p = w.fakes.process;
  const owner = p.addProcess({ command: 'node /old/host.js' });
  const ownerStart = p.procs.get(owner)?.startTime ?? '';
  p.exit(owner);
  const sid = `00000000-0000-4000-8000-${key.slice(1).padStart(12, '0')}`;
  const claudePid = p.addProcess({ command: `/n/bin/claude.exe --session-id ${sid} --settings /x`, ignores: o.claudeIgnores ?? [] });
  const claudeStart = p.procs.get(claudePid)?.startTime ?? '';
  const dir = `${w.fakes.runtimeDir.root}/ccd-${key.slice(-6)}`;
  w.fakes.runtimeDir.plant(dir);
  const rec = record(key, {
    owner: { pid: owner, startTime: ownerStart },
    claude: { pid: claudePid, startTime: claudeStart, exe: '/n/bin/claude.exe', version: '2.1.316' },
    claudeSessionId: sid,
    initialSessionId: sid,
    sessionDir: dir,
    trustKeyAddedByLibrary: o.trustAdded ?? false,
    ...(o.configPath !== undefined ? { claudeConfigPath: o.configPath } : {}),
    tmux: {
      bin: '/opt/homebrew/bin/tmux',
      socketName: `ccd-1-${key.slice(-8)}`,
      socketPath: `/tmp/tmux-501/ccd-1-${key.slice(-8)}`,
      sessionName: `ccd-${key}`,
    },
  });
  void w.store.writeSession(rec);
  return { claudePid };
}

describe('identity (P-LIFE-44)', () => {
  it('match / mismatch (pid reuse) / gone', async () => {
    const { fakes } = world();
    const pid = fakes.process.addProcess({ command: '/x/claude.exe --session-id abc' });
    const start = fakes.process.procs.get(pid)?.startTime ?? '';
    const id = { pid, startTime: start, exeSubstr: 'claude.exe', sessionId: 'abc' };
    expect(await verifyClaudeIdentity(fakes.process, id)).toBe('match');
    expect(await verifyClaudeIdentity(fakes.process, { ...id, sessionId: 'other' })).toBe('mismatch');
    fakes.process.reusePid(pid, '/x/claude.exe --session-id abc');
    expect(await verifyClaudeIdentity(fakes.process, id)).toBe('mismatch');
    fakes.process.exit(pid);
    expect(await verifyClaudeIdentity(fakes.process, id)).toBe('gone');
  });

  it('owner liveness compares the start time', async () => {
    const { fakes } = world();
    const pid = fakes.process.addProcess({ command: 'node a.js' });
    const startTime = fakes.process.procs.get(pid)?.startTime ?? '';
    expect(await isOwnerAlive(fakes.process, { pid, startTime })).toBe(true);
    fakes.process.reusePid(pid, 'node b.js');
    expect(await isOwnerAlive(fakes.process, { pid, startTime })).toBe(false);
  });

  it('terminateVerified: SIGTERM, SIGKILL escalation (P-LIFE-11), never signals a reused pid', async () => {
    const { fakes } = world();
    const p = fakes.process;
    const mk = (ignores: string[] = []): { pid: number; startTime: string; exeSubstr: string; sessionId: string } => {
      const pid = p.addProcess({ command: '/x/claude.exe --resume S', ignores });
      return { pid, startTime: p.procs.get(pid)?.startTime ?? '', exeSubstr: 'claude.exe', sessionId: 'S' };
    };
    expect(await pump(fakes, terminateVerified(p, fakes.clock, mk(), { graceMs: 1000 }))).toBe('terminated');
    const stubborn = mk(['SIGTERM']);
    const t0 = fakes.clock.now();
    expect(await pump(fakes, terminateVerified(p, fakes.clock, stubborn, { graceMs: 12_000 }))).toBe('killed');
    expect(fakes.clock.now() - t0).toBeGreaterThanOrEqual(12_000);
    const reused = mk();
    p.reusePid(reused.pid, 'vim');
    expect(await terminateVerified(p, fakes.clock, reused, { graceMs: 1000 })).toBe('identity-mismatch');
    expect(p.killCalls.filter((k) => k.pid === reused.pid)).toEqual([]);
    expect(await pump(fakes, terminateVerified(p, fakes.clock, mk(), { graceMs: 1000, startWith: 'SIGKILL' }))).toBe('killed');
  });

  it('terminateVerified: the pid is reused by a stranger during the SIGTERM grace → no SIGKILL (identity re-checked, P-LIFE-44)', async () => {
    const { fakes } = world();
    const p = fakes.process;
    const pid = p.addProcess({ command: '/x/claude.exe --resume S', ignores: ['SIGTERM'] });
    const id = { pid, startTime: p.procs.get(pid)?.startTime ?? '', exeSubstr: 'claude.exe', sessionId: 'S' };
    // Claude dies mid-grace and macOS hands its pid to an unrelated process that stays alive past the grace
    fakes.clock.setTimer((fakes.clock.now() + 5_000) as Parameters<typeof fakes.clock.setTimer>[0], () => {
      p.reusePid(pid, '/x/claude.exe --resume S');
    });
    expect(await pump(fakes, terminateVerified(p, fakes.clock, id, { graceMs: 12_000 }))).toBe('identity-mismatch');
    expect(p.killCalls.filter((k) => k.pid === pid).map((k) => k.sig)).toEqual(['SIGTERM']);
    expect(p.isAlive(pid)).toBe(true);
  });
});

describe('reap (§3.8)', () => {
  it('reaps a session whose owner died: Claude, server, socket, trust, dir, archive', async () => {
    const key = 's000000a1' as SessionKey;
    const w = world({ socketEntries: [`/tmp/tmux-501/ccd-1-000000a1`] });
    const { claudePid } = orphan(w, key, { trustAdded: true });
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    expect(rep.reaped).toEqual([
      { sessionKey: key, claude: 'terminated', server: 'killed', socketUnlinked: true, sessionDirRemoved: true, trustUnseeded: true },
    ]);
    expect(w.fakes.process.isAlive(claudePid)).toBe(false);
    expect(w.execs.find((c) => c.args.at(-1) === 'kill-server')?.args).toEqual(['-S', '/tmp/tmux-501/ccd-1-000000a1', 'kill-server']);
    expect(w.execs.find((c) => c.file === '/bin/rm')?.args).toEqual(['-f', '--', '/tmp/tmux-501/ccd-1-000000a1']);
    expect(w.fakes.claudeConfig.writes).toEqual([{ op: 'unseed', cwd: '/work/project' }]);
    expect(await w.store.readSession(key)).toBeUndefined();
    expect((await w.store.readArchive(key))?.state).toBe('reaped');
    expect(w.fakes.state.files.get(`exits/${key}.log`)).toContain('reaped by=reaper claude=terminated server=killed');
    expect(w.fakes.state.isLocked('lock')).toBe(false);
  });

  it('ICR 0022: a reaped seeded key is kept while a live session uses the cwd; the last one out unseeds it', async () => {
    const w = world();
    orphan(w, 's000000a2' as SessionKey, { trustAdded: true });
    // two dead records in the cwd: the first leaves the key to the second, which is the last one
    orphan(w, 's000000a3' as SessionKey);
    const live = 's000000a4' as SessionKey;
    const me = { pid: w.fakes.ownerPid, startTime: w.fakes.process.procs.get(w.fakes.ownerPid)?.startTime ?? '' };
    await w.store.writeSession(record(live, { owner: me }));
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    expect(rep.reaped.map((r) => r.trustUnseeded)).toEqual([false, false]);
    expect(w.fakes.claudeConfig.writes).toEqual([]);
    expect((await w.store.readTrustSeeds()).map((x) => [x.cwd, x.configPath])).toEqual([['/work/project', FAKE_GLOBAL_CONFIG_PATH]]);
    await w.store.archive(live, { reapedBy: 'close' });
    const live2 = 's000000a5' as SessionKey;
    await w.store.writeSession(record(live2, { owner: me }));
    // the live session closes last: it never added the key, but the workspace is listed as library-seeded
    expect(
      await w.store.withLock(() => releaseTrustLocked(w.deps, { sessionKey: live2, cwdRealpath: '/work/project', ownedHint: false })),
    ).toBe('unseeded');
    expect(w.fakes.claudeConfig.writes).toEqual([{ op: 'unseed', cwd: '/work/project' }]);
    expect(await w.store.readTrustSeeds()).toEqual([]);
  });

  it('ICR 0033: a key seeded under another CLAUDE_CONFIG_DIR is unseeded in that file, never in the reaper’s own config', async () => {
    const w = world();
    const acct2 = '/work/acct2/.claude.json';
    // the user accepted trust for /work/project themselves in ~/.claude.json; the crashed owner ran with
    // CLAUDE_CONFIG_DIR=/work/acct2 and seeded its own .claude.json
    w.fakes.claudeConfig.others.set(acct2, { projects: { '/work/project': { hasTrustDialogAccepted: true, lastSessionId: 'x' } } });
    orphan(w, 's000000c1' as SessionKey, { trustAdded: true, configPath: acct2 });
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    expect(rep.reaped.map((r) => r.trustUnseeded)).toEqual([true]);
    expect(w.fakes.claudeConfig.writes).toEqual([{ op: 'unseed', cwd: '/work/project', path: acct2 }]);
    expect(w.fakes.claudeConfig.others.get(acct2)).toEqual({ projects: { '/work/project': { lastSessionId: 'x' } } });
    const own = w.fakes.claudeConfig.global as { projects: Record<string, Record<string, unknown>> };
    expect(own.projects['/work/project']?.['hasTrustDialogAccepted']).toBe(true);
  });

  it('ICR 0033: a live session of the same cwd under ANOTHER config dir does not keep the key (workspace = cwd + config)', async () => {
    const w = world();
    const acct2 = '/work/acct2/.claude.json';
    w.fakes.claudeConfig.others.set(acct2, { projects: { '/work/project': { hasTrustDialogAccepted: true } } });
    orphan(w, 's000000c2' as SessionKey, { trustAdded: true, configPath: acct2 });
    const me = { pid: w.fakes.ownerPid, startTime: w.fakes.process.procs.get(w.fakes.ownerPid)?.startTime ?? '' };
    await w.store.writeSession(record('s000000c3' as SessionKey, { owner: me, claudeConfigPath: FAKE_GLOBAL_CONFIG_PATH }));
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    expect(rep.reaped.map((r) => r.trustUnseeded)).toEqual([true]);
    expect(w.fakes.claudeConfig.writes).toEqual([{ op: 'unseed', cwd: '/work/project', path: acct2 }]);
    expect(w.fakes.state.files.has(TRUST_SEEDS_FILE)).toBe(false);
  });

  it('ICR 0033: a v:1 trust-seeds.json entry (no config path) still counts as the reader’s own config', async () => {
    const w = world();
    await w.fakes.state.writeJsonAtomic(TRUST_SEEDS_FILE, { v: 1, cwds: { '/work/project': { by: 's000000c4', at: 1 } } });
    const me = { pid: w.fakes.ownerPid, startTime: w.fakes.process.procs.get(w.fakes.ownerPid)?.startTime ?? '' };
    await w.store.writeSession(record('s000000c5' as SessionKey, { owner: me }));
    expect(
      await w.store.withLock(() =>
        releaseTrustLocked(w.deps, { sessionKey: 's000000c5' as SessionKey, cwdRealpath: '/work/project', ownedHint: false }),
      ),
    ).toBe('unseeded');
    expect(w.fakes.claudeConfig.writes).toEqual([{ op: 'unseed', cwd: '/work/project' }]);
    expect(await w.store.readTrustSeeds()).toEqual([]);
  });

  it('kill-server fails while the server still answers → socket, dir, trust and record kept; the next pass retries', async () => {
    const key = 's000000c6' as SessionKey;
    const sock = '/tmp/tmux-501/ccd-1-000000c6';
    const w = world({ socketEntries: [sock], serverAnswers: () => true });
    let killWorks = false;
    w.fakes.process.onExec((c) =>
      c.args.at(-1) === 'kill-server' && !killWorks ? fail('server exited unexpectedly: protocol version mismatch') : undefined,
    );
    orphan(w, key, { trustAdded: true });
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid, sweepSockets: false }));
    expect(rep.reaped).toEqual([
      {
        sessionKey: key,
        claude: 'terminated',
        server: 'failed',
        socketUnlinked: false,
        sessionDirRemoved: false,
        trustUnseeded: false,
        retained: true,
      },
    ]);
    expect(rep.errors).toEqual([`${key}: tmux server could not be killed; record kept for a retry`]);
    expect(w.execs.filter((c) => c.file === '/bin/rm')).toEqual([]);
    expect(w.fakes.claudeConfig.writes).toEqual([]);
    expect(await w.store.readSession(key)).toBeDefined();
    expect(await w.store.readArchive(key)).toBeUndefined();
    // the next pass (start() or lifecheck) retries and now succeeds
    killWorks = true;
    const again = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid, sweepSockets: false }));
    expect(again.reaped.map((r) => [r.server, r.socketUnlinked, r.trustUnseeded, r.retained])).toEqual([['killed', true, true, undefined]]);
    expect((await w.store.readArchive(key))?.state).toBe('reaped');
  });

  it('kill-server cannot run (tmux binary gone) → nothing is unlinked or archived', async () => {
    const key = 's000000c7' as SessionKey;
    const w = world({ socketEntries: ['/tmp/tmux-501/ccd-1-000000c7'] });
    w.fakes.process.onExec((c) => {
      if (c.file === '/opt/homebrew/bin/tmux') throw new Error('spawn /opt/homebrew/bin/tmux ENOENT');
      return undefined;
    });
    orphan(w, key);
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid, sweepSockets: false }));
    expect(rep.reaped.map((r) => [r.server, r.socketUnlinked, r.retained])).toEqual([['failed', false, true]]);
    expect(w.execs.filter((c) => c.file === '/bin/rm')).toEqual([]);
    expect(await w.store.readSession(key)).toBeDefined();
  });

  it('kill-server fails but two list-sessions probes 5 s apart get no answer (G21) → socket unlinked, record archived', async () => {
    const key = 's000000c8' as SessionKey;
    const w = world({ socketEntries: ['/tmp/tmux-501/ccd-1-000000c8'], serverAnswers: () => false });
    w.fakes.process.onExec((c) => (c.args.at(-1) === 'kill-server' ? { ...fail('lost server'), timedOut: true, code: null } : undefined));
    orphan(w, key);
    const t0 = w.fakes.clock.now();
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid, sweepSockets: false }));
    expect(rep.reaped.map((r) => [r.server, r.socketUnlinked, r.retained])).toEqual([['failed', true, undefined]]);
    expect(w.execs.filter((c) => c.args.at(-1) === 'list-sessions')).toHaveLength(2);
    expect(w.fakes.clock.now() - t0).toBeGreaterThanOrEqual(5_000);
    expect((await w.store.readArchive(key))?.state).toBe('reaped');
  });

  it('ICR 0022: two dead records of one cwd → the key is removed once, by the last of them', async () => {
    const w = world();
    orphan(w, 's000000a6' as SessionKey, { trustAdded: true });
    orphan(w, 's000000a7' as SessionKey);
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    expect(rep.reaped.map((r) => r.trustUnseeded)).toEqual([false, true]);
    expect(w.fakes.claudeConfig.writes).toEqual([{ op: 'unseed', cwd: '/work/project' }]);
  });

  it('never reaps a session whose owner is alive (or is the caller)', async () => {
    const w = world();
    const myStart = w.fakes.process.procs.get(w.fakes.ownerPid)?.startTime ?? '';
    await w.store.writeSession(record('s000000b1' as SessionKey, { owner: { pid: w.fakes.ownerPid, startTime: myStart } }));
    const live = w.fakes.process.addProcess({ command: 'node other-owner.js' });
    await w.store.writeSession(
      record('s000000b2' as SessionKey, { owner: { pid: live, startTime: w.fakes.process.procs.get(live)?.startTime ?? '' } }),
    );
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid, selfStartTime: myStart }));
    expect(rep.reaped).toEqual([]);
    expect(rep.skippedLive.sort()).toEqual(['s000000b1', 's000000b2']);
    expect(w.execs.filter((c) => c.args.at(-1) === 'kill-server')).toEqual([]);
  });

  it("P-LIFE-44: a record (and owners/ file) of an earlier process with the caller's pid but another start time is reaped", async () => {
    const w = world();
    const me = w.fakes.ownerPid;
    const myStart = w.fakes.process.procs.get(me)?.startTime ?? '';
    const key = 's000000b3' as SessionKey;
    // run 1 (same pid, e.g. node as pid 7 in a container) seeded trust and died without its exit handler
    await w.store.writeSession(record(key, { owner: { pid: me, startTime: 'earlier-run' }, trustKeyAddedByLibrary: true }));
    await w.store.writeOwner({
      pid: me,
      startTime: 'earlier-run',
      argv0: 'node',
      nodeVersion: '22',
      libVersion: '0',
      createdAt: 0 as WallMs,
      heartbeatAt: 0 as WallMs,
    });
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: me, selfStartTime: myStart }));
    expect(rep.skippedLive).toEqual([]);
    expect(rep.reaped.map((r) => [r.sessionKey, r.trustUnseeded])).toEqual([[key, true]]);
    expect(rep.ownersRemoved).toEqual([me]);
    expect(await w.store.readSession(key)).toBeUndefined();
    expect(w.fakes.claudeConfig.writes).toEqual([{ op: 'unseed', cwd: '/work/project' }]);
  });

  it('a stubborn Claude gets SIGKILL after 12 s; an identity mismatch is never signalled', async () => {
    const w = world();
    const { claudePid } = orphan(w, 's000000c1' as SessionKey, { claudeIgnores: ['SIGTERM'] });
    const { claudePid: reusedPid } = orphan(w, 's000000c2' as SessionKey);
    w.fakes.process.reusePid(reusedPid, 'vim notes.txt');
    const rep = await pump(w.fakes, reap(w.deps, {}));
    const by = Object.fromEntries(rep.reaped.map((r) => [r.sessionKey, r.claude]));
    expect(by).toEqual({ s000000c1: 'killed', s000000c2: 'identity-mismatch' });
    expect(w.fakes.process.isAlive(claudePid)).toBe(false);
    expect(w.fakes.process.isAlive(reusedPid)).toBe(true);
  });

  it("a 'launching' record without a Claude pid still gets its server killed and archived", async () => {
    const w = world();
    const dead = w.fakes.process.addProcess({ command: 'node gone.js' });
    const st = w.fakes.process.procs.get(dead)?.startTime ?? '';
    w.fakes.process.exit(dead);
    const key = 's000000d1' as SessionKey;
    await w.store.writeSession(
      record(key, { owner: { pid: dead, startTime: st }, claude: { exe: '/n/claude.exe', version: '2.1.316' }, state: 'launching' }),
    );
    const rep = await pump(w.fakes, reap(w.deps, {}));
    expect(rep.reaped[0]).toMatchObject({ sessionKey: key, claude: 'n/a', server: 'killed' });
  });

  it("P-TMUX-61: a 'launching' record's pane Claude (pid never stored) is found via list-panes and terminated before kill-server", async () => {
    const w = world();
    const dead = w.fakes.process.addProcess({ command: 'node gone.js' });
    const st = w.fakes.process.procs.get(dead)?.startTime ?? '';
    w.fakes.process.exit(dead);
    const key = 's000000d2' as SessionKey;
    const sid = '00000000-0000-4000-8000-0000000000d2';
    const claudePid = w.fakes.process.addProcess({ command: `/n/bin/claude.exe --session-id ${sid}`, ignores: ['SIGHUP'] });
    const other = w.fakes.process.addProcess({ command: '/bin/zsh -l' });
    const foreign = w.fakes.process.addProcess({ command: '/n/bin/claude.exe --session-id ffffffff-0000-4000-8000-000000000000' });
    w.fakes.process.onExec((c) => (c.args.includes('list-panes') ? ok(`${claudePid}\n${other}\n${foreign}\n1\nnot-a-pid\n`) : undefined));
    await w.store.writeSession(
      record(key, {
        owner: { pid: dead, startTime: st },
        claude: { exe: '/n/bin/claude.exe', version: '2.1.316' },
        claudeSessionId: sid,
        initialSessionId: sid,
        state: 'launching',
      }),
    );
    const rep = await pump(w.fakes, reap(w.deps, {}));
    expect(rep.reaped[0]).toMatchObject({ sessionKey: key, claude: 'terminated', server: 'killed' });
    expect(w.fakes.process.isAlive(claudePid)).toBe(false);
    expect(w.fakes.process.isAlive(other)).toBe(true);
    expect(w.fakes.process.isAlive(foreign)).toBe(true);
    const calls = w.fakes.process.execCalls;
    const listIdx = calls.findIndex((c) => c.args.includes('list-panes'));
    const killIdx = calls.findIndex((c) => c.args.at(-1) === 'kill-server');
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeLessThan(killIdx);
    expect(calls[listIdx]?.args).toEqual(['-S', '/tmp/tmux-501/ccd-39a-0011aabb', 'list-panes', '-a', '-F', '#{pane_pid}']);
  });

  it('removes dead owners heartbeat files, sweeps only registry-named dirs, prunes the archive', async () => {
    const w = world();
    const dead = w.fakes.process.addProcess({ command: 'node gone.js' });
    w.fakes.process.exit(dead);
    await w.store.writeOwner({
      pid: dead,
      startTime: 'x',
      argv0: '/n',
      nodeVersion: '22',
      libVersion: '0',
      createdAt: 0 as WallMs,
      heartbeatAt: 0 as WallMs,
    });
    w.fakes.runtimeDir.plant('/fake/run/ccd-zzzzzz'); // unknown dir: never removed
    const key = 's000000e1' as SessionKey;
    w.fakes.runtimeDir.plant('/fake/run/ccd-e1e1e1');
    await w.store.writeSession(record(key, { sessionDir: '/fake/run/ccd-e1e1e1' }));
    await w.store.archive(key, { reapedBy: 'close' }); // archived, dir still there (crash between steps)
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    expect(rep.ownersRemoved).toEqual([dead]);
    expect(rep.sweptDirs).toEqual(['/fake/run/ccd-e1e1e1']);
    expect(w.fakes.runtimeDir.dirs.has('/fake/run/ccd-zzzzzz')).toBe(true);
  });
});

describe('socket sweep (P-TMUX-39, P-REV-33, P-LIFE-45)', () => {
  it('unlinks a registry-named socket only after two failed probes 5 s apart', async () => {
    const sock = '/tmp/tmux-501/ccd-1-0000f001';
    const w = world({ socketEntries: [sock] });
    const key = 's0000f001' as SessionKey;
    await w.store.writeSession(
      record(key, { tmux: { bin: '/opt/homebrew/bin/tmux', socketName: 'ccd-1-0000f001', socketPath: sock, sessionName: 'ccd-x' } }),
    );
    await w.store.archive(key, { reapedBy: 'close' });
    const t0 = w.fakes.clock.now();
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    const probes = w.execs.filter((c) => c.args.at(-1) === 'list-sessions');
    expect(probes).toHaveLength(2);
    expect(probes[0]?.timeoutMs).toBe(2000);
    expect(w.fakes.clock.now() - t0).toBeGreaterThanOrEqual(5000);
    expect(rep.sockets.unlinked).toEqual([sock]);
  });

  it('a server that answers the second probe is kept', async () => {
    const sock = '/tmp/tmux-501/ccd-1-0000f002';
    const w = world({ socketEntries: [sock], serverAnswers: (_c, n) => n === 2 });
    const key = 's0000f002' as SessionKey;
    await w.store.writeSession(
      record(key, { tmux: { bin: '/opt/homebrew/bin/tmux', socketName: 'ccd-1-0000f002', socketPath: sock, sessionName: 'ccd-x' } }),
    );
    await w.store.archive(key, { reapedBy: 'close' });
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    expect(rep.sockets.alive).toEqual([sock]);
    expect(rep.sockets.unlinked).toEqual([]);
    expect(w.execs.filter((c) => c.file === '/bin/rm')).toEqual([]);
  });

  it('unknown ccd-* sockets (other agents/tests) are only counted, never probed or removed', async () => {
    const w = world({ lsOut: 'ccd-input\nccd-verify-1\ndefault\nccd-1-0000f003\n', socketEntries: ['/tmp/tmux-501/ccd-1-0000f003'] });
    const key = 's0000f003' as SessionKey;
    await w.store.writeSession(
      record(key, {
        tmux: {
          bin: '/opt/homebrew/bin/tmux',
          socketName: 'ccd-1-0000f003',
          socketPath: '/tmp/tmux-501/ccd-1-0000f003',
          sessionName: 'ccd-x',
        },
      }),
    );
    await w.store.archive(key, { reapedBy: 'close' });
    const rep = await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid, socketProbeGapMs: 10 }));
    expect(rep.sockets.unknownCcdSockets).toBe(2);
    const touched = w.execs.flatMap((c) => c.args).filter((a) => a.includes('ccd-input') || a.includes('ccd-verify'));
    expect(touched).toEqual([]);
  });

  it('a live owner socket is never probed for removal', async () => {
    const sock = '/tmp/tmux-501/ccd-1-0000f004';
    const w = world({ socketEntries: [sock] });
    await w.store.writeSession(
      record('s0000f004' as SessionKey, {
        owner: { pid: w.fakes.ownerPid, startTime: w.fakes.process.procs.get(w.fakes.ownerPid)?.startTime ?? '' },
        tmux: { bin: '/opt/homebrew/bin/tmux', socketName: 'ccd-1-0000f004', socketPath: sock, sessionName: 'ccd-x' },
      }),
    );
    await pump(w.fakes, reap(w.deps, { selfPid: w.fakes.ownerPid }));
    expect(w.execs.filter((c) => c.args.at(-1) === 'list-sessions')).toEqual([]);
  });

  it('tmuxTarget refuses non-ccd names; the default socket dir honours TMUX_TMPDIR', () => {
    expect(tmuxTarget({ socketName: 'default' })).toBeUndefined();
    expect(tmuxTarget({ socketName: 'ccd-a', socketPath: '/tmp/tmux-501/other' })).toEqual(['-L', 'ccd-a']);
    expect(tmuxTarget({ socketName: 'ccd-a', socketPath: '/tmp/tmux-501/ccd-a' })).toEqual(['-S', '/tmp/tmux-501/ccd-a']);
    const f = createFakePorts({ envVars: { TMUX_TMPDIR: '/var/tt' } });
    expect(defaultSocketDir(f.env)).toBe('/var/tt/tmux-501');
  });
});

describe('classifySession (lifecheck support, P-LIFE-58)', () => {
  it('owned-alive / owned-hung / orphan / dead', async () => {
    const w = world();
    const now = w.fakes.clock.wallNow();
    const me = { pid: w.fakes.ownerPid, startTime: w.fakes.process.procs.get(w.fakes.ownerPid)?.startTime ?? '' };
    await w.store.writeOwner({
      pid: me.pid,
      startTime: me.startTime,
      argv0: '/n',
      nodeVersion: '22',
      libVersion: '0',
      createdAt: now,
      heartbeatAt: now,
    });
    const r = record('s0000a001' as SessionKey, { owner: me });
    expect(await classifySession(w.deps, r, now)).toBe('owned-alive');
    expect(await classifySession(w.deps, r, (now + 61_000) as WallMs)).toBe('owned-hung');
    const key = 's0000a002' as SessionKey;
    const { claudePid } = orphan(w, key);
    const rec = await w.store.readSession(key);
    if (rec === undefined) throw new Error('no record');
    expect(await classifySession(w.deps, rec, now)).toBe('orphan');
    w.fakes.process.exit(claudePid);
    expect(await classifySession(w.deps, rec, now)).toBe('dead');
  });
});
