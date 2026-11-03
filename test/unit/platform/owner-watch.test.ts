// WP-05 unit tests: owner-watch config/identity rules (D-28, §3.8, P-LIFE-44, P-LIFE-45), the spawner (P-SEC-18, P-SEC-38)
// and the FakeOwnerWatch used by K-22.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { createRealClock } from '../../../src/platform/clock/real-clock.js';
import { FakeOwnerWatchFactory } from '../../../src/platform/process/fake-owner-watch.js';
import { FakeProcess } from '../../../src/platform/process/fake-process.js';
import { parsePsIdentity as parseL0, parsePsLine as parseLineL0, PS_ARGS, PS_ENV } from '../../../src/platform/process/identity.js';
import { createOwnerWatchFactory } from '../../../src/platform/process/owner-watcher.js';
import { createProcessPort, isPidAlive } from '../../../src/platform/process/process-port.js';
import {
  isClaudeIdentity,
  parsePsIdentity as parseStandalone,
  parsePsLine as parseLineStandalone,
  parseWatchConfig,
  PS_ENV as PS_ENV_STANDALONE,
  readPrivateConfig,
  type WatchConfig,
} from '../../../src/platform/process/standalone/owner-watch.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-ow-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = (o: Partial<WatchConfig> = {}): WatchConfig => ({
  ownerPid: 100,
  ownerStart: 'Tue Nov  3 06:00:00 2026',
  claudePid: 200,
  claudeStart: 'Tue Nov  3 06:00:05 2026',
  claudeExeSubstr: 'claude.exe',
  sessionIdSubstr: '11111111-2222-4333-8444-555555555555',
  tmuxBin: '/opt/homebrew/bin/tmux',
  socketName: 'ccd-2s-abcdef12',
  pollMs: 1000,
  exitsLog: '/state/exits/s1.log',
  ...o,
});

describe('parseWatchConfig', () => {
  it('accepts the §2.7.1 shape (pollMs defaults to 1000) and the optional socketPath', () => {
    const { pollMs: _p, ...noPoll } = base();
    expect(parseWatchConfig(noPoll)).toEqual(base());
    expect(parseWatchConfig({ ...base(), socketPath: '/private/tmp/tmux-501/ccd-2s-abcdef12' })).toMatchObject({
      socketPath: '/private/tmp/tmux-501/ccd-2s-abcdef12',
    });
  });

  it.each([
    ['ownerPid', { ownerPid: 1 }],
    ['claudePid', { claudePid: 0 }],
    ['ownerPid equals claudePid', { claudePid: 100 }],
    ['claudeExeSubstr', { claudeExeSubstr: '' }],
    ['sessionIdSubstr', { sessionIdSubstr: 'a\nb' }],
    ['tmuxBin', { tmuxBin: 'tmux' }],
    ['tmuxBin', { tmuxBin: '/bin/tm ux' }],
    ['socketName', { socketName: 'default' }], // never another tmux server (P-LIFE-45)
    ['socketName', { socketName: 'ccd-x;rm' }],
    ['exitsLog', { exitsLog: "/x/'quote" }],
    ['pollMs', { pollMs: 5 }],
  ])('rejects bad %s', (msg, patch) => {
    expect(parseWatchConfig({ ...base(), ...patch })).toBe(msg);
  });

  it('rejects non-objects and bad socketPath', () => {
    expect(parseWatchConfig(null)).toBe('config is not an object');
    expect(parseWatchConfig({ ...base(), socketPath: 'rel' })).toBe('socketPath');
    // -S must point at OUR socket: a path to any other server (e.g. the user's default) is refused (P-LIFE-45).
    expect(parseWatchConfig({ ...base(), socketPath: '/private/tmp/tmux-501/default' })).toBe('socketPath');
  });
});

describe('identity rule', () => {
  it('both ps parsers agree (the standalone keeps its own copy)', () => {
    for (const line of [
      'S    Tue Nov  3 06:34:46 2026     node /x/claude.exe --session-id s',
      'Ss+ Mon Jan 12 00:00:00 2026 a',
      'ZN   Tue Nov  3 07:10:59 2026     <defunct>',
      'Tue Nov  3 06:34:46 2026 no-stat-column',
      '',
      'junk',
    ]) {
      expect(parseStandalone(line)).toEqual(parseL0(line));
      expect(parseLineStandalone(line)).toEqual(parseLineL0(line));
    }
    expect(parseStandalone('ZN   Tue Nov  3 07:10:59 2026     <defunct>')).toBeUndefined(); // a zombie owner is gone
  });

  it('both ps envs pin TZ=UTC0 so lstart never follows a host time-zone change (ICR 0031)', () => {
    expect(PS_ENV_STANDALONE).toEqual(PS_ENV);
    expect(PS_ENV['TZ']).toBe('UTC0');
  });

  it('requires start time, claude.exe and the session id (P-LIFE-44)', () => {
    const cfg = base();
    const good = { startTime: 'Tue Nov 3 06:00:05 2026', command: `/x/claude.exe --session-id ${cfg.sessionIdSubstr}` };
    expect(isClaudeIdentity(good, cfg)).toBe(true);
    expect(isClaudeIdentity({ ...good, startTime: 'Tue Nov 3 06:00:06 2026' }, cfg)).toBe(false);
    expect(isClaudeIdentity({ ...good, command: '/usr/bin/vim' }, cfg)).toBe(false);
    expect(isClaudeIdentity({ ...good, command: '/x/claude.exe --session-id other' }, cfg)).toBe(false);
    expect(isClaudeIdentity(undefined, cfg)).toBe(false);
  });
});

describe('createOwnerWatchFactory (spawner)', () => {
  function writeCfg(cfg: unknown, mode = 0o600): string {
    const p = join(dir, 'watch.json');
    writeFileSync(p, JSON.stringify(cfg));
    chmodSync(p, mode);
    return p;
  }

  it('spawns `node <script> <watch.json>` detached with a minimal env (no NODE_OPTIONS, no secrets in argv)', async () => {
    const fp = new FakeProcess();
    const f = createOwnerWatchFactory({
      process: fp,
      clock: new FakeClock(),
      nodePath: '/usr/local/bin/node',
      scriptPath: '/pkg/dist/platform/process/standalone/owner-watch.js',
      hostEnv: { TMUX_TMPDIR: '/t', NODE_OPTIONS: '--require evil', ANTHROPIC_API_KEY: 'k', HOME: '/h' },
    });
    const configPath = writeCfg(base());
    const h = await f.start({ configPath, logPath: join(dir, 'watch.log') });
    const call = fp.spawnCalls[0];
    expect(call?.file).toBe('/usr/local/bin/node');
    expect(call?.args).toEqual(['/pkg/dist/platform/process/standalone/owner-watch.js', configPath]);
    expect(call?.env).toEqual({ PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TMUX_TMPDIR: '/t', HOME: '/h' });
    expect(h.pid).toBe(call?.pid);
    await h.stop();
    expect(fp.isAlive(h.pid)).toBe(false);
    expect(fp.killCalls.at(-1)).toMatchObject({ pid: h.pid, sig: 'SIGTERM' });
  });

  it('refuses a world-readable, invalid or relative config before spawning anything', async () => {
    const fp = new FakeProcess();
    const f = createOwnerWatchFactory({ process: fp, clock: new FakeClock(), scriptPath: '/s.js' });
    await expect(f.start({ configPath: writeCfg(base(), 0o644), logPath: '/l' })).rejects.toMatchObject({ name: 'OwnerWatchStartFailed' });
    await expect(f.start({ configPath: writeCfg({ ...base(), socketName: 'x' }), logPath: '/l' })).rejects.toThrow('socketName');
    await expect(f.start({ configPath: 'watch.json', logPath: '/l' })).rejects.toThrow('absolute');
    expect(fp.spawnCalls).toEqual([]);
  });

  it('stop() never signals a recycled watcher pid', async () => {
    const fp = new FakeProcess();
    const f = createOwnerWatchFactory({ process: fp, clock: new FakeClock(), scriptPath: '/s.js' });
    const h = await f.start({ configPath: writeCfg(base()), logPath: join(dir, 'l') });
    fp.reusePid(h.pid, '/usr/bin/some-other-process');
    await h.stop();
    expect(fp.isAlive(h.pid)).toBe(true);
    expect(fp.killCalls).toEqual([]);
  });
});

describe('FakeOwnerWatchFactory (K-22)', () => {
  function setup(o: { claudeCmd?: string } = {}) {
    const fp = new FakeProcess();
    const ownerPid = fp.addProcess({ command: 'node host.js' });
    const sid = '11111111-2222-4333-8444-555555555555';
    const claudePid = fp.addProcess({ command: o.claudeCmd ?? `/x/claude.exe --session-id ${sid}` });
    const cfg = base({
      ownerPid,
      claudePid,
      ownerStart: fp.procs.get(ownerPid)?.startTime ?? '',
      claudeStart: fp.procs.get(claudePid)?.startTime ?? '',
      sessionIdSubstr: sid,
    });
    const killed: string[] = [];
    const exits: string[] = [];
    const f = new FakeOwnerWatchFactory({
      process: fp,
      readConfig: () => JSON.stringify(cfg),
      onKillServer: (c) => killed.push(c.socketName),
      appendExit: (_p, l) => exits.push(l),
    });
    return { fp, f, cfg, ownerPid, claudePid, killed, exits };
  }

  it('owner death → verified Claude killed + tmux server killed + exits line', async () => {
    const s = setup();
    await s.f.start({ configPath: '/w.json', logPath: '/l' });
    s.fp.exit(s.ownerPid, 'SIGKILL');
    expect(s.fp.isAlive(s.claudePid)).toBe(false);
    expect(s.killed).toEqual([s.cfg.socketName]);
    expect(s.f.reports).toHaveLength(1);
    expect(s.f.reports[0]).toMatchObject({ kind: 'owner-gone', claude: 'terminated', serverKilled: true });
    expect(s.exits[0]).toMatch(/^watch=owner-gone /);
  });

  it('a Claude pid reused by another process is never killed (server still is)', async () => {
    const s = setup();
    await s.f.start({ configPath: '/w.json', logPath: '/l' });
    s.fp.reusePid(s.claudePid, '/usr/bin/vim notes.txt');
    // pid reuse looks like claude-gone first in the real watcher too: Claude's original process exited.
    expect(s.f.reports[0]?.kind).toBe('claude-gone');
    const t = setup({ claudeCmd: '/usr/bin/vim notes.txt' });
    await t.f.start({ configPath: '/w.json', logPath: '/l' });
    t.fp.exit(t.ownerPid);
    expect(t.fp.isAlive(t.claudePid)).toBe(true);
    expect(t.f.reports[0]).toMatchObject({ kind: 'owner-gone', claude: 'identity-mismatch', serverKilled: true });
  });

  it('stop() first → no action on a later owner death; a stubborn Claude gets SIGKILL', async () => {
    const s = setup();
    const h = await s.f.start({ configPath: '/w.json', logPath: '/l' });
    await h.stop();
    s.fp.exit(s.ownerPid);
    expect(s.fp.isAlive(s.claudePid)).toBe(true);
    expect(s.f.reports).toEqual([]);

    const fp = new FakeProcess();
    const ownerPid = fp.addProcess({ command: 'node host.js' });
    const claudePid = fp.addProcess({ command: '/x/claude.exe --session-id S', ignores: ['SIGTERM'] });
    const cfg = base({
      ownerPid,
      claudePid,
      ownerStart: fp.procs.get(ownerPid)?.startTime ?? '',
      claudeStart: fp.procs.get(claudePid)?.startTime ?? '',
      sessionIdSubstr: 'S',
    });
    const f = new FakeOwnerWatchFactory({ process: fp, readConfig: () => cfg });
    await f.start({ configPath: '/w', logPath: '/l' });
    fp.exit(ownerPid);
    expect(fp.isAlive(claudePid)).toBe(false);
    expect(f.reports[0]?.claude).toBe('killed');
  });

  it('owner already gone at start → acts at once (like the first poll); bad config rejects', async () => {
    const s = setup();
    s.fp.exit(s.ownerPid);
    await s.f.start({ configPath: '/w.json', logPath: '/l' });
    expect(s.f.reports[0]?.kind).toBe('owner-gone');
    const bad = new FakeOwnerWatchFactory({ process: new FakeProcess(), readConfig: () => 'not json' });
    await expect(bad.start({ configPath: '/w', logPath: '/l' })).rejects.toMatchObject({ name: 'OwnerWatchStartFailed' });
  });
});

describe('owner-watch standalone (real processes)', () => {
  const clock = createRealClock();
  const port = createProcessPort({ clock });
  const script = fileURLToPath(new URL('../../../src/platform/process/standalone/owner-watch.ts', import.meta.url));
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  });

  function writeCfg(cfg: unknown, mode = 0o600): string {
    const p = join(dir, `watch-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(cfg));
    chmodSync(p, mode);
    return p;
  }

  async function spawnFakeClaude(sid: string): Promise<{ pid: number; start: string }> {
    const exe = join(dir, 'claude.exe');
    writeFileSync(exe, 'setInterval(()=>{},1e6);\n');
    const c = spawn(process.execPath, [exe, '--session-id', sid], { stdio: 'ignore' });
    children.push(c);
    await new Promise((r) => c.once('spawn', r));
    const pid = c.pid ?? 0;
    let id = await port.identity(pid);
    for (let i = 0; i < 20 && id === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
      id = await port.identity(pid);
    }
    return { pid, start: id?.startTime ?? '' };
  }

  it('readPrivateConfig accepts only a 0600 regular file we own (never a symlink)', () => {
    const good = writeCfg(base());
    expect(readPrivateConfig(good)).toEqual({ value: { ...base() } });
    expect(readPrivateConfig(writeCfg(base(), 0o644))).toBe('mode must be 0600');
    const link = join(dir, 'link.json');
    symlinkSync(good, link);
    expect(readPrivateConfig(link)).toBe('ELOOP');
    expect(readPrivateConfig(join(dir, 'missing.json'))).toBe('ENOENT');
    const torn = writeCfg('x');
    writeFileSync(torn, '{"ownerPid":');
    expect(readPrivateConfig(torn)).toBe('invalid JSON');
  });

  it.skipIf(!existsSync('/usr/bin/true'))(
    'an owner whose recorded start time is its UTC lstart is not treated as gone (lstart-timezone-identity, ICR 0031)',
    async () => {
      const sid = '11111111-2222-4333-8444-555555555555';
      const claude = await spawnFakeClaude(sid);
      const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
      children.push(owner);
      await new Promise((r) => owner.once('spawn', r));
      const ownerPid = owner.pid ?? 0;
      // Record both start times in UTC, computed independently of PS_ENV; with a host-zone ps the watcher would see a
      // different string on its first poll (on any host not set to UTC) and kill Claude.
      const utc = async (pid: number): Promise<string> =>
        parseLineL0(
          (
            await port.exec('/bin/ps', PS_ARGS(pid), {
              env: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' },
              timeoutMs: 5_000,
              killOnTimeout: true,
            })
          ).stdout,
        )?.startTime ?? '';
      const exitsLog = join(dir, 'exits-tz.log');
      const cfg = base({
        ownerPid,
        ownerStart: await utc(ownerPid),
        claudePid: claude.pid,
        claudeStart: await utc(claude.pid),
        sessionIdSubstr: sid,
        tmuxBin: '/usr/bin/true',
        pollMs: 50,
        exitsLog,
      });
      const w = spawn(process.execPath, [script, writeCfg(cfg)], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', TZ: 'Asia/Tokyo' } });
      children.push(w);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(w.exitCode).toBeNull();
      expect(isPidAlive(claude.pid)).toBe(true);
      expect(existsSync(exitsLog)).toBe(false);
      // Sanity: the same watcher still acts on a real owner death.
      owner.kill('SIGKILL');
      for (let i = 0; i < 100 && isPidAlive(claude.pid); i++) await new Promise((r) => setTimeout(r, 50));
      expect(isPidAlive(claude.pid)).toBe(false);
    },
    15_000,
  );

  it('the standalone itself refuses a group/world-accessible watch.json (exit 2, nothing signalled)', async () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const claude = await spawnFakeClaude(sid);
    // Owner = a pid that is surely dead, so a watcher that accepted the config would act at once.
    const cfg = base({
      ownerPid: 999_999,
      claudePid: claude.pid,
      claudeStart: claude.start,
      sessionIdSubstr: sid,
      tmuxBin: '/usr/bin/true',
      exitsLog: join(dir, 'exits.log'),
    });
    const r = await port.exec(process.execPath, [script, writeCfg(cfg, 0o644)], {
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10_000,
      killOnTimeout: true,
    });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('mode must be 0600');
    expect(isPidAlive(claude.pid)).toBe(true);
    expect(existsSync(join(dir, 'exits.log'))).toBe(false);
  });

  it.skipIf(!existsSync('/usr/bin/perl') || !existsSync('/usr/bin/true'))(
    'a zombie owner (SIGKILLed, never reaped by its parent) counts as gone: Claude is killed within the window',
    async () => {
      // perl forks the "owner", which exits at once and is never reaped: kill(pid, 0) succeeds and lstart is unchanged.
      const parent = spawn('/usr/bin/perl', ['-e', '$|=1; my $c=fork(); if($c==0){exit 0} print "$c\\n"; sleep 30'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      children.push(parent);
      const ownerPid = await new Promise<number>((res) => {
        parent.stdout.once('data', (b: Buffer) => {
          res(Number(String(b).trim()));
        });
      });
      let line = parseLineL0(
        (await port.exec('/bin/ps', PS_ARGS(ownerPid), { env: PS_ENV, timeoutMs: 5_000, killOnTimeout: true })).stdout,
      );
      for (let i = 0; i < 20 && line?.zombie !== true; i++) {
        await new Promise((r) => setTimeout(r, 25));
        line = parseLineL0((await port.exec('/bin/ps', PS_ARGS(ownerPid), { env: PS_ENV, timeoutMs: 5_000, killOnTimeout: true })).stdout);
      }
      expect(line?.zombie).toBe(true);
      expect(isPidAlive(ownerPid)).toBe(true);

      const sid = '11111111-2222-4333-8444-555555555555';
      const claude = await spawnFakeClaude(sid);
      const exitsLog = join(dir, 'exits.log');
      chmodSync(dir, 0o700);
      const configPath = writeCfg(
        base({
          ownerPid,
          ownerStart: line?.startTime ?? '',
          claudePid: claude.pid,
          claudeStart: claude.start,
          sessionIdSubstr: sid,
          tmuxBin: '/usr/bin/true',
          pollMs: 200,
          exitsLog,
        }),
      );
      const f = createOwnerWatchFactory({ process: port, clock, scriptPath: script });
      const w = await f.start({ configPath, logPath: join(dir, 'watch.log') });
      try {
        const child = children.find((c) => c.pid === claude.pid);
        const t0 = Date.now();
        while (child?.exitCode === null && child.signalCode === null && Date.now() - t0 < 3_000)
          await new Promise((r) => setTimeout(r, 20));
        expect(child?.signalCode).toBe('SIGTERM');
        expect(Date.now() - t0).toBeLessThanOrEqual(2_000);
        let exits = '';
        for (let i = 0; i < 50 && !exits.includes('watch=owner-gone'); i++) {
          await new Promise((r) => setTimeout(r, 20));
          exits = existsSync(exitsLog) ? readFileSync(exitsLog, 'utf8') : '';
        }
        expect(exits).toMatch(/^watch=owner-gone .*claude=terminated server=killed/m);
        expect(statSync(exitsLog).mode & 0o777).toBe(0o600);
      } finally {
        port.kill(w.pid, 'SIGKILL');
      }
    },
  );
});
