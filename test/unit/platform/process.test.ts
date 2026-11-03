// WP-05 unit tests: process port (exec, timeouts, signals, identity, detached spawn) and `which` (P-TMUX-41, P-LIFE-38,
// P-LIFE-44, P-SEC-40).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { createRealClock } from '../../../src/platform/clock/real-clock.js';
import { ProcessSpawnError } from '../../../src/platform/process/errors.js';
import { FakeProcess, fakeStartTime } from '../../../src/platform/process/fake-process.js';
import { identityMatches, parsePsIdentity, parsePsLine, PS_ARGS, PS_ENV } from '../../../src/platform/process/identity.js';
import { createProcessPort, isPidAlive, isSignalablePid, KILL_GRACE_MS } from '../../../src/platform/process/process-port.js';
import { KNOWN_BIN_DIRS, searchDirs, which } from '../../../src/platform/process/which.js';

const NODE = process.execPath;
const ENV = { PATH: '/usr/bin:/bin' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccd-wp05-proc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const port = () => createProcessPort({ clock: createRealClock() });

describe('ProcessPort.exec', () => {
  it('returns stdout/stderr/code and never throws for a non-zero exit', async () => {
    const r = await port().exec(NODE, ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'], {
      env: ENV,
      timeoutMs: 5_000,
      killOnTimeout: true,
    });
    expect(r).toEqual({ code: 3, signal: null, stdout: 'out', stderr: 'err', timedOut: false });
  });

  it('passes exactly the given env (never merges process.env, D-25) and stdin', async () => {
    process.env['CCD_WP05_LEAK'] = 'leaked';
    try {
      const r = await port().exec(
        NODE,
        [
          '-e',
          'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({s,env:process.env.CCD_WP05_LEAK??null,mine:process.env.MINE})))',
        ],
        { env: { ...ENV, MINE: 'yes' }, timeoutMs: 5_000, killOnTimeout: true, stdin: 'hello' },
      );
      expect(JSON.parse(r.stdout)).toEqual({ s: 'hello', env: null, mine: 'yes' });
    } finally {
      delete process.env['CCD_WP05_LEAK'];
    }
  });

  it('killOnTimeout:true kills the child and reports timedOut', async () => {
    const r = await port().exec(NODE, ['-e', 'setTimeout(()=>{},10000)'], { env: ENV, timeoutMs: 150, killOnTimeout: true });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGTERM');
  });

  it('killOnTimeout:true escalates to SIGKILL when the child ignores SIGTERM (never hangs)', async () => {
    const t0 = Date.now();
    const r = await port().exec(NODE, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
      env: ENV,
      timeoutMs: 150,
      killOnTimeout: true,
    });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(150 + KILL_GRACE_MS - 50);
    expect(ms).toBeLessThan(150 + 2 * KILL_GRACE_MS + 1_000);
  });

  it('a child that exits before the deadline is not reported as timed out and its timer is cancelled', async () => {
    const clock = new FakeClock();
    const r = await createProcessPort({ clock }).exec(NODE, ['-e', 'process.exit(3)'], { env: ENV, timeoutMs: 5_000, killOnTimeout: true });
    expect(r).toMatchObject({ code: 3, timedOut: false });
    expect(clock.pending()).toBe(0);
  });

  it('killOnTimeout:false resolves timedOut but leaves the child running untouched (P-LIFE-38)', async () => {
    const marker = join(dir, 'finished');
    const t0 = Date.now();
    // the path goes in argv, never into the evaluated source
    const r = await port().exec(NODE, ['-e', 'setTimeout(()=>{require("fs").writeFileSync(process.argv[1],"done")},600)', marker], {
      env: ENV,
      timeoutMs: 100,
      killOnTimeout: false,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(Date.now() - t0).toBeLessThan(550);
    await new Promise((res) => setTimeout(res, 900));
    expect(readFileSync(marker, 'utf8')).toBe('done'); // it was not killed and could finish
  });

  it('a missing binary rejects with ProcessSpawnError carrying no argv (P-SEC-40)', async () => {
    const e = await port()
      .exec('/nonexistent/bin/x', ['--token', 'SECRET'], { env: ENV, timeoutMs: 1_000, killOnTimeout: true })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProcessSpawnError);
    expect((e as ProcessSpawnError).errno).toBe('ENOENT');
    expect((e as Error).message).not.toContain('SECRET');
  });
});

describe('ProcessPort signals and identity', () => {
  it('isAlive/kill refuse pid 0, negative pids and 1 (process groups / init)', () => {
    const p = port();
    for (const pid of [0, -1, 1, 1.5, Number.NaN]) {
      expect(isSignalablePid(pid)).toBe(false);
      expect(p.isAlive(pid)).toBe(false);
      expect(p.kill(pid, 'SIGTERM')).toBe(false);
    }
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('identity(pid) returns ps lstart + full command; dead pid → undefined', async () => {
    const child = spawn(NODE, ['-e', 'setInterval(()=>{},1000)', 'claude.exe', '--session-id', 'abc-123'], { stdio: 'ignore' });
    try {
      await new Promise((r) => child.once('spawn', r));
      const pid = child.pid ?? 0;
      const id = await port().identity(pid);
      expect(id?.command).toContain('claude.exe --session-id abc-123');
      expect(id?.startTime).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
      expect(identityMatches(id, { startTime: id?.startTime ?? '', mustContain: ['claude.exe', 'abc-123'] })).toBe(true);
      expect(identityMatches(id, { startTime: 'Mon Jan  1 00:00:00 2001', mustContain: ['claude.exe'] })).toBe(false);
      expect(port().kill(pid, 'SIGTERM')).toBe(true);
      await new Promise((r) => child.once('exit', r));
      expect(await port().identity(pid)).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('identity start time is rendered in UTC, never the host zone (lstart-timezone-identity, ICR 0031)', async () => {
    expect(PS_ENV['TZ']).toBe('UTC0');
    const before = Math.floor(Date.now() / 1000) * 1000;
    const child = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => child.once('spawn', r));
      const after = Date.now();
      const id = await port().identity(child.pid ?? 0);
      // lstart in C locale: `Tue Nov  3 07:10:59 2026`; Date.parse with an explicit `UTC` suffix reads it as UTC.
      const startMs = Date.parse(`${id?.startTime ?? ''} UTC`);
      expect(Number.isNaN(startMs)).toBe(false);
      // A host-zone rendering would be off by the zone offset (hours); a UTC rendering is within the spawn window.
      expect(startMs).toBeGreaterThanOrEqual(before - 1_000);
      expect(startMs).toBeLessThanOrEqual(after + 1_000);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('parsePsIdentity handles padded days, treats zombies as gone and rejects garbage', () => {
    expect(PS_ARGS(42)).toEqual(['-ww', '-o', 'stat=,lstart=,command=', '-p', '42']);
    expect(parsePsIdentity('Ss   Tue Nov  3 06:34:46 2026     /bin/zsh -c x\n')).toEqual({
      startTime: 'Tue Nov 3 06:34:46 2026',
      command: '/bin/zsh -c x',
    });
    // VERIFIED macOS output for an exited-but-unreaped process: kill(pid, 0) still succeeds and lstart is unchanged.
    expect(parsePsLine('ZN   Tue Nov  3 07:10:59 2026     <defunct>')).toMatchObject({ state: 'ZN', zombie: true });
    expect(parsePsIdentity('ZN   Tue Nov  3 07:10:59 2026     <defunct>')).toBeUndefined();
    expect(parsePsIdentity('Z+ Tue Nov  3 07:10:59 2026 (node)')).toBeUndefined();
    expect(parsePsIdentity('Tue Nov  3 06:34:46 2026 /bin/zsh')).toBeUndefined(); // stat column missing
    expect(parsePsIdentity('')).toBeUndefined();
    expect(parsePsIdentity('not a ps line')).toBeUndefined();
    expect(identityMatches(undefined, { startTime: 'x', mustContain: [] })).toBe(false);
    expect(identityMatches({ startTime: 'a', command: 'b' }, { startTime: 'a', mustContain: [''] })).toBe(false);
  });

  it.skipIf(!existsSync('/usr/bin/perl'))(
    'identity(pid) of a real zombie (unreaped child) is undefined although kill(pid, 0) succeeds',
    async () => {
      // perl forks a child that exits at once and never reaps it, then prints the child pid and sleeps.
      const parent = spawn('/usr/bin/perl', ['-e', '$|=1; my $c=fork(); if($c==0){exit 0} print "$c\\n"; sleep 5'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      try {
        const zpid = await new Promise<number>((res) => {
          parent.stdout.once('data', (b: Buffer) => {
            res(Number(String(b).trim()));
          });
        });
        let id = await port().identity(zpid);
        for (let i = 0; i < 20 && id !== undefined; i++) {
          await new Promise((r) => setTimeout(r, 25));
          id = await port().identity(zpid);
        }
        expect(isPidAlive(zpid)).toBe(true);
        expect(id).toBeUndefined();
      } finally {
        parent.kill('SIGKILL');
      }
    },
  );

  it('spawnDetached appends output to a 0600 log and returns the pid', async () => {
    const log = join(dir, 'w.log');
    const { pid } = await port().spawnDetached(NODE, ['-e', 'console.log("hello-detached")'], { env: ENV, logPath: log });
    expect(pid).toBeGreaterThan(1);
    for (let i = 0; i < 100 && !readFileSync(log, 'utf8').includes('hello-detached'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(log, 'utf8')).toContain('hello-detached');
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it('execSyncBestEffort never throws', () => {
    expect(() => {
      port().execSyncBestEffort('/nonexistent/x', [], ENV);
    }).not.toThrow();
  });
});

describe('which (P-TMUX-41)', () => {
  it('searches PATH then the known dirs, ignores relative entries and non-executables', async () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, 'tool'), 'not executable');
    writeFileSync(join(b, 'tool'), '#!/bin/sh\n');
    chmodSync(join(b, 'tool'), 0o755);
    expect(await which('tool', { pathEnv: `relative:${a}`, extraDirs: [b] })).toBe(join(b, 'tool'));
    expect(await which('tool', { pathEnv: a, extraDirs: [] })).toBeUndefined();
    expect(await which(join(b, 'tool'), { pathEnv: '', extraDirs: [] })).toBe(join(b, 'tool'));
    expect(searchDirs(`/x:/x:rel:/y`, ['/y', '/z'])).toEqual(['/x', '/y', '/z']);
    expect(KNOWN_BIN_DIRS).toContain('/opt/homebrew/bin');
  });

  it('ProcessPort.which finds a real binary through the extra dirs when PATH lacks it', async () => {
    const p = createProcessPort({ clock: createRealClock(), pathEnv: '' });
    expect(await p.which('sh', KNOWN_BIN_DIRS)).toMatch(/\/sh$/);
  });
});

describe('FakeProcess', () => {
  it('models pid reuse, SIGHUP survivors and exec handlers', async () => {
    const fp = new FakeProcess();
    const pid = fp.addProcess({ command: 'claude.exe --session-id s1', ignores: ['SIGHUP'] });
    const before = await fp.identity(pid);
    expect(fp.kill(pid, 'SIGHUP')).toBe(true);
    expect(fp.isAlive(pid)).toBe(true); // SIGHUP survivor
    fp.reusePid(pid, '/usr/bin/vim');
    const after = await fp.identity(pid);
    expect(after?.command).toBe('/usr/bin/vim');
    expect(after?.startTime).not.toBe(before?.startTime);
    fp.onExec((c) =>
      c.args[0] === '--version' ? { code: 0, signal: null, stdout: '2.1.317 (Claude Code)', stderr: '', timedOut: false } : undefined,
    );
    expect((await fp.exec('/c', ['--version'], { env: {}, timeoutMs: 1, killOnTimeout: true })).stdout).toContain('2.1.317');
    await expect(fp.exec('/c', ['other'], { env: {}, timeoutMs: 1, killOnTimeout: true })).rejects.toBeInstanceOf(ProcessSpawnError);
    expect(fakeStartTime(1)).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/);
  });
});
