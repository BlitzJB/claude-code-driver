// WP-01 tmux/server.ts: probe (P-TMUX-41/42), the one-invocation prelude + spawn (P-TMUX-17/18/19/20/22/23/25/47/48,
// D-07, D-09, P-REV-28, P-REV-44/LP-52), pane-died record (P-TMUX-37, P-LIFE-12), kill + socket cleanup (P-TMUX-39/60).
import { describe, expect, it } from 'vitest';
import { findGlobalWindowSize } from '../../../scripts/check-no-global-window-size.mjs';
import { toArgv, commandList } from '../../../src/platform/tmux/args.js';
import {
  TmuxDuplicate,
  TmuxInvalidInput,
  TmuxNotFound,
  TmuxServerGone,
  TmuxSocketPathTooLong,
  TmuxSpawnFailed,
  TmuxUnsupported,
  TmuxVersionUnsupported,
} from '../../../src/platform/tmux/errors.js';
import {
  createTmuxServerFactory,
  paneDiedHookCommand,
  parseSpawnOutput,
  preludeCommands,
  spawnCommands,
} from '../../../src/platform/tmux/server.js';
import { featuresOf, parseTmuxVersion } from '../../../src/platform/tmux/version.js';
import { fail, ManualClock, ok, splitCommands, TmuxSim } from './tmux-test-helpers.js';

const TMUX = '/opt/homebrew/bin/tmux';
const spawnOpts = {
  sessionName: 'ccd-s1',
  argv: ['/usr/bin/env', '-u', 'TMUX', '-u', 'TMUX_PANE', '/x/claude.exe', '--settings', '/x/s.json'] as [string, string, ...string[]],
  cwd: '/private/tmp/work dir;',
  cols: 250,
  rows: 80,
  nonSecretEnv: { CCD_X: 'a b;' },
};

function mk(sim = new TmuxSim(), env: Record<string, string> = { PATH: '/usr/bin:/bin' }) {
  const clock = new ManualClock();
  const factory = createTmuxServerFactory({ clock, env, execFile: sim.exec, fs: sim.fs, uid: 501 });
  return { sim, clock, factory };
}

const create = (f: ReturnType<typeof mk>['factory'], over: Partial<Parameters<ReturnType<typeof mk>['factory']['create']>[0]> = {}) =>
  f.create({
    tmuxPath: TMUX,
    socketName: 'ccd-t-1',
    clientEnv: { LC_ALL: 'en_US.UTF-8', TMUX: '/tmp/x,1,0' },
    historyLimit: 5000,
    paneDiedLogPath: '/tmp/exits/s1.log',
    ...over,
  });

describe('probe (TD rule 19, §3.1 step 12)', () => {
  it('searches $PATH, then /opt/homebrew/bin, /usr/local/bin, /usr/bin', async () => {
    const { factory, sim } = mk();
    expect(await factory.probe()).toEqual({ path: TMUX, version: '3.5a' });
    expect(sim.calls[0]).toMatchObject({ file: TMUX, argv: ['-V'] });
  });

  it('PATH wins over the known dirs', async () => {
    const sim = new TmuxSim();
    sim.fs.executables.add('/custom/bin/tmux');
    const { factory } = mk(sim, { PATH: '/custom/bin' });
    expect((await factory.probe()).path).toBe('/custom/bin/tmux');
  });

  it('absolute option is used as given', async () => {
    const sim = new TmuxSim();
    sim.fs.executables.add('/x/tmux');
    const { factory } = mk(sim);
    expect((await factory.probe('/x/tmux')).path).toBe('/x/tmux');
  });

  it('not found → TmuxNotFound listing the searched paths', async () => {
    const sim = new TmuxSim();
    sim.fs.executables.clear();
    const { factory } = mk(sim);
    const e = await factory.probe().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TmuxNotFound);
    expect((e as TmuxNotFound).searched).toEqual(['/usr/bin/tmux', '/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']);
    await expect(factory.probe('bin/tmux')).rejects.toBeInstanceOf(TmuxInvalidInput);
  });

  it('version < 3.2 or unparsable → TmuxVersionUnsupported', async () => {
    const sim = new TmuxSim();
    sim.version = 'tmux 3.1c';
    await expect(mk(sim).factory.probe()).rejects.toBeInstanceOf(TmuxVersionUnsupported);
    const sim2 = new TmuxSim();
    sim2.version = 'weird';
    await expect(mk(sim2).factory.probe()).rejects.toBeInstanceOf(TmuxVersionUnsupported);
  });
});

describe('create', () => {
  it('validates the socket name, log path and history limit; never reaches a live server', async () => {
    const { factory, sim } = mk();
    await expect(create(factory, { socketName: 'bad name' })).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(create(factory, { paneDiedLogPath: "/tmp/x'; touch /tmp/pwn" })).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(create(factory, { paneDiedLogPath: 'rel/x.log' })).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(create(factory, { historyLimit: -1 })).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(create(factory, { tmuxPath: 'tmux' })).rejects.toBeInstanceOf(TmuxInvalidInput);
    sim.serverUp = true;
    await expect(create(factory)).rejects.toBeInstanceOf(TmuxDuplicate);
  });

  it('socket path from TMUX_TMPDIR (or /tmp) + tmux-<uid>; too long → TmuxSocketPathTooLong', async () => {
    const { factory } = mk();
    expect((await create(factory)).socketPath).toBe('/tmp/tmux-501/ccd-t-1');
    await expect(create(factory, { clientEnv: { TMUX_TMPDIR: `/${'d'.repeat(100)}` } })).rejects.toBeInstanceOf(TmuxSocketPathTooLong);
  });

  it('measures the realpath of the base dir, as tmux does (macOS /tmp → /private/tmp, P-TMUX-38)', async () => {
    const sim = new TmuxSim();
    sim.fs.realpaths.set('/tmp', '/private/tmp');
    const { factory } = mk(sim);
    expect((await create(factory)).socketPath).toBe('/private/tmp/tmux-501/ccd-t-1');
    // 79 + '/tmux-501/' + 'ccd-t-1' = 96 bytes unresolved (passes), 104 resolved (must fail before tmux says ENAMETOOLONG)
    const short = `/${'d'.repeat(78)}`;
    sim.fs.realpaths.set(short, `/private${short}`);
    const e = await create(factory, { clientEnv: { TMUX_TMPDIR: short } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TmuxSocketPathTooLong);
    expect((e as TmuxSocketPathTooLong).bytes).toBe(104);
  });
});

describe('spawn invocation (D-07, D-09, TD R5/R6)', () => {
  it('is ONE invocation: prelude, new-session, per-window options and the pane-died hook', async () => {
    const { factory, sim } = mk();
    const server = await create(factory);
    sim.calls = [];
    const pane = await server.spawnPane(spawnOpts);
    const spawnCall = sim.calls.find((c) => c.cmd.includes('new-session'))!;
    const cmds = splitCommands(spawnCall.cmd);
    expect(cmds.map((c) => c[0])).toEqual([
      'start-server',
      'set-option',
      'set-option',
      'set-option',
      'set-option', // escape-time, focus-events, set-clipboard, extended-keys
      'set-option',
      'set-option',
      'set-option',
      'set-option',
      'set-option',
      'set-option', // history, remain, status, mouse, TERM, passthrough
      'new-session',
      'set-option',
      'set-option',
      'set-option',
      'set-hook',
    ]);
    const has = (c: string[]) => cmds.some((x) => JSON.stringify(x) === JSON.stringify(c));
    expect(has(['set-option', '-s', 'set-clipboard', 'off'])).toBe(true); // P-REV-28, P-TMUX-48
    expect(has(['set-option', '-s', 'extended-keys', 'off'])).toBe(true); // LP-52, P-REV-44
    expect(has(['set-option', '-s', 'focus-events', 'off'])).toBe(true); // P-TMUX-47
    expect(has(['set-option', '-g', 'allow-passthrough', 'off'])).toBe(true); // P-TMUX-48
    expect(has(['set-option', '-g', 'history-limit', '5000'])).toBe(true); // P-TMUX-22
    expect(has(['set-option', '-g', 'remain-on-exit', 'on'])).toBe(true); // P-TMUX-20
    expect(has(['set-option', '-g', 'status', 'off'])).toBe(true); // P-TMUX-19
    expect(has(['set-option', '-g', 'mouse', 'off'])).toBe(true); // P-TMUX-46
    expect(has(['set-option', '-w', '-t', '=ccd-s1:', 'window-size', 'manual'])).toBe(true); // P-TMUX-17/18
    expect(has(['set-option', '-w', '-t', '=ccd-s1:', 'remain-on-exit', 'on'])).toBe(true);
    expect(has(['set-option', '-t', '=ccd-s1:', 'status', 'off'])).toBe(true);
    const ns = cmds.find((c) => c[0] === 'new-session')!;
    expect(ns.slice(0, ns.indexOf('--'))).toEqual([
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{session_id} #{window_id} #{pane_id} #{pane_pid}',
      '-s',
      'ccd-s1',
      '-c',
      '/private/tmp/work dir\\;',
      '-x',
      '250',
      '-y',
      '80',
      '-e',
      'CCD_X=a b\\;',
    ]);
    expect(ns.slice(ns.indexOf('--') + 1)).toEqual(spawnOpts.argv); // multi-arg argv, exec'd directly (P-TMUX-24)
    expect(cmds.at(-1)).toEqual([
      'set-hook',
      '-t',
      '=ccd-s1:',
      'pane-died',
      "run-shell 'echo died pane=#{pane_id} pid=#{pane_pid} status=#{pane_dead_status} signal=#{pane_dead_signal} >> /tmp/exits/s1.log'",
    ]);
    // the client env of this invocation becomes the server's global env (P-TMUX-23), minus TMUX
    expect(spawnCall.env).toEqual({ LC_ALL: 'en_US.UTF-8' });
    expect(pane.info).toEqual({ paneId: '%0', sessionId: '$0', windowId: '@0', pid: 4000, cols: 250, rows: 80 });
    expect(server.socketPath).toBe('/private/tmp/tmux-501/sock'); // the real #{socket_path} replaces the computed one
  });

  it('never sets window-size globally (P-TMUX-17: SIGSEGV on 3.5a)', () => {
    const v = parseTmuxVersion('tmux 3.5a')!;
    const argv = toArgv(commandList(spawnCommands(spawnOpts, 5000, featuresOf(v), '/tmp/x.log')));
    for (let i = 0; i < argv.length - 1; i++) if (argv[i + 1] === 'window-size') expect(argv[i]).not.toMatch(/^-[a-z]*g/);
    expect(findGlobalWindowSize(argv.map((a) => `'${a}'`).join(', '))).toEqual([]);
  });

  it('tmux 3.2 has no allow-passthrough option, so it is not set', () => {
    const cmds = preludeCommands(100, featuresOf(parseTmuxVersion('tmux 3.2a')!));
    expect(cmds.some((c) => c.positional?.[0] === 'allow-passthrough')).toBe(false);
    expect(cmds.some((c) => c.positional?.[0] === 'extended-keys')).toBe(true);
  });

  it('validates spawn options before any tmux call', async () => {
    const { factory, sim } = mk();
    const server = await create(factory);
    sim.calls = [];
    const bad = [
      { ...spawnOpts, sessionName: 'ccd-a.b' },
      { ...spawnOpts, argv: ['/bin/sh'] as unknown as [string, string] },
      { ...spawnOpts, argv: ['sh', '-c'] as [string, string] },
      { ...spawnOpts, argv: ['/bin/sh', 'a\0b'] as [string, string] },
      { ...spawnOpts, cwd: 'relative' },
      { ...spawnOpts, cols: 10_001 },
      { ...spawnOpts, rows: 0 },
      { ...spawnOpts, nonSecretEnv: { 'A=B': 'x' } },
    ];
    for (const o of bad) await expect(server.spawnPane(o)).rejects.toBeInstanceOf(TmuxInvalidInput);
    expect(sim.calls).toHaveLength(0);
  });

  it('paneDiedHookCommand refuses unsafe paths', () => {
    expect(() => paneDiedHookCommand('/tmp/$(x)')).toThrow(TmuxInvalidInput);
  });

  it('parseSpawnOutput', () => {
    expect(parseSpawnOutput('$2 @2 %2 31894\n')).toEqual({ sessionId: '$2', windowId: '@2', paneId: '%2', pid: 31894 });
    expect(parseSpawnOutput('noise\n')).toBeUndefined();
  });
});

describe('post-spawn verification (R7, LP-52)', () => {
  it('re-pins a wrong size with resize-window', async () => {
    const { factory, sim } = mk();
    sim.spawnSize = { cols: 80, rows: 24 };
    const server = await create(factory);
    const pane = await server.spawnPane(spawnOpts);
    expect(sim.commands().some((c) => c[0] === 'resize-window' && c.join(' ') === 'resize-window -t %0 -x 250 -y 80')).toBe(true);
    expect(pane.info.cols).toBe(250);
  });

  it('a size that cannot be pinned → TmuxSpawnFailed and the session is removed', async () => {
    const { factory, sim } = mk();
    sim.spawnSize = { cols: 80, rows: 24 };
    sim.resizeResult = { cols: 80, rows: 24 };
    const server = await create(factory);
    await expect(server.spawnPane(spawnOpts)).rejects.toBeInstanceOf(TmuxSpawnFailed);
    expect(sim.commands().some((c) => c[0] === 'kill-session' && c[2] === '=ccd-s1')).toBe(true);
  });

  it('pane_key_mode other than VT10x → TmuxUnsupported{extendedKeys} and the session is removed', async () => {
    const { factory, sim } = mk();
    sim.keyModeOnSpawn = 'Ext 1';
    const server = await create(factory);
    const e = await server.spawnPane(spawnOpts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TmuxUnsupported);
    expect((e as TmuxUnsupported).reason).toBe('extendedKeys');
    expect(sim.commands().some((c) => c[0] === 'kill-session')).toBe(true);
  });

  it('an empty key mode is a failure where the format exists (≥ 3.5), accepted on 3.4', async () => {
    const a = mk();
    a.sim.keyModeOnSpawn = '';
    await expect((await create(a.factory)).spawnPane(spawnOpts)).rejects.toBeInstanceOf(TmuxUnsupported);
    const b = mk();
    b.sim.version = 'tmux 3.4';
    b.sim.keyModeOnSpawn = '';
    expect((await (await create(b.factory)).spawnPane(spawnOpts)).info.paneId).toBe('%0');
  });

  it('a duplicate session name never kills the existing session (it may be the last one: exit-empty kills the server)', async () => {
    const { factory, sim } = mk();
    const server = await create(factory);
    await server.spawnPane(spawnOpts);
    sim.calls = [];
    sim.intercept.push((c) => (c.cmd.includes('new-session') ? fail('duplicate session: ccd-s1\n') : undefined));
    await expect(server.spawnPane(spawnOpts)).rejects.toBeInstanceOf(TmuxDuplicate);
    expect(sim.commands().some((c) => c[0] === 'kill-session')).toBe(false);
  });

  it('a non-duplicate failure for a name a live pane of ours holds does not kill that session either', async () => {
    const { factory, sim } = mk();
    const server = await create(factory);
    await server.spawnPane(spawnOpts);
    sim.calls = [];
    sim.intercept.push((c) => (c.cmd.includes('new-session') ? fail('invalid option: whatever\n') : undefined));
    await expect(server.spawnPane(spawnOpts)).rejects.toThrow(/invalid option/);
    expect(sim.commands().some((c) => c[0] === 'kill-session')).toBe(false);
  });

  it('an error inside the spawn invocation removes the half-configured session', async () => {
    const { factory, sim } = mk();
    const server = await create(factory);
    sim.intercept.push((c) => (c.cmd.includes('new-session') ? fail('invalid option: whatever\n') : undefined));
    await expect(server.spawnPane(spawnOpts)).rejects.toThrow(/invalid option/);
    expect(sim.commands().some((c) => c[0] === 'kill-session' && c[2] === '=ccd-s1')).toBe(true);
  });
});

describe('kill / killSync / onGone (P-TMUX-39, P-TMUX-60, TD R18/R19)', () => {
  it('kill-server, waits until the server stops answering, unlinks both socket paths, panes gone, no onGone', async () => {
    const { factory, sim, clock } = mk();
    const server = await create(factory);
    const pane = await server.spawnPane(spawnOpts);
    let serverGone = 0;
    let paneGone = 0;
    server.onGone(() => serverGone++);
    pane.on('gone', () => paneGone++);
    let answers = 3;
    sim.intercept.push((c) => {
      if (c.cmd[0] === 'kill-server') return ok();
      if (c.cmd[0] === 'list-sessions') return answers-- > 0 ? ok('$0\n') : fail('no server running on x\n');
      return undefined;
    });
    await server.kill();
    expect(clock.sleeps).toEqual([50, 50, 50]);
    expect(sim.fs.removed).toEqual(['/private/tmp/tmux-501/sock', '/tmp/tmux-501/ccd-t-1']);
    expect(serverGone).toBe(0);
    expect(paneGone).toBe(1);
    expect((await pane.status()).exists).toBe(false);
  });

  it('gives up waiting after 1 s', async () => {
    const { factory, sim, clock } = mk();
    const server = await create(factory);
    sim.intercept.push((c) => (c.cmd[0] === 'list-sessions' || c.cmd[0] === 'kill-server' ? ok('$0\n') : undefined));
    await server.kill();
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
    expect(sim.fs.removed).toContain('/tmp/tmux-501/ccd-t-1');
  });

  it('killSync runs kill-server synchronously and removes the socket', async () => {
    const sim = new TmuxSim();
    const syncCalls: string[][] = [];
    const factory = createTmuxServerFactory({
      clock: new ManualClock(),
      execFile: sim.exec,
      execFileSync: (_f, args) => {
        syncCalls.push([...args]);
      },
      fs: sim.fs,
      uid: 501,
    });
    const server = await create(factory);
    server.killSync();
    expect(syncCalls).toEqual([['-u', '-L', 'ccd-t-1', '-f', '/dev/null', 'kill-server']]);
    expect(sim.fs.removed).toEqual(['/tmp/tmux-501/ccd-t-1']);
  });

  it('a crash noticed by any command fires onGone once and marks every pane gone', async () => {
    const { factory, sim, clock } = mk();
    const server = await create(factory);
    const pane = await server.spawnPane(spawnOpts);
    let n = 0;
    let pg = 0;
    server.onGone(() => n++);
    pane.on('gone', () => pg++);
    sim.intercept.push(() => fail('server exited unexpectedly\n'));
    clock.advance(200);
    await expect(pane.sendKey('Enter')).rejects.toThrow();
    await expect(pane.capture()).rejects.toThrow();
    expect((await pane.status()).exists).toBe(false);
    expect(n).toBe(1);
    expect(pg).toBe(1);
    await expect(server.spawnPane({ ...spawnOpts, sessionName: 'ccd-s2' })).rejects.toBeInstanceOf(TmuxSpawnFailed);
  });

  it('commands after kill() report the server gone without firing onGone', async () => {
    const { factory, clock } = mk();
    const server = await create(factory);
    const pane = await server.spawnPane(spawnOpts);
    let n = 0;
    server.onGone(() => n++);
    await server.kill();
    clock.advance(200);
    await expect(pane.capture()).rejects.toBeInstanceOf(TmuxServerGone);
    expect(n).toBe(0);
  });
});
