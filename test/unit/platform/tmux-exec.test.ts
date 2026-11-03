// WP-01 tmux/exec.ts: P-TMUX-01 (-L, no TMUX in the client env), P-TMUX-02 (-f /dev/null), P-TMUX-03 (execFile argv),
// P-TMUX-06 (argv ≤ 12 KiB), P-TMUX-38 (short socket names), P-TMUX-46 (mouse off: -f /dev/null + prelude), P-TMUX-49 (-u).
import { describe, expect, it } from 'vitest';
import { lit, SEP } from '../../../src/platform/tmux/args.js';
import { TmuxArgTooLong, TmuxCommandFailed, TmuxInvalidInput, TmuxNotFound, TmuxServerGone } from '../../../src/platform/tmux/errors.js';
import { baseArgs, nodeExecFile, sanitizeClientEnv, TmuxExec, type ExecFileFn } from '../../../src/platform/tmux/exec.js';
import { fail, ok, TmuxSim } from './tmux-test-helpers.js';

const mk = (execFile: ExecFileFn, env: Record<string, string> = {}) =>
  new TmuxExec({ tmuxPath: '/opt/homebrew/bin/tmux', socketName: 'ccd-1a-deadbeef', env, execFile });

describe('TmuxExec.run', () => {
  it('always prepends -u -L <sock> -f /dev/null and uses the absolute binary', async () => {
    const sim = new TmuxSim();
    sim.serverUp = true;
    await mk(sim.exec).run([lit('list-sessions')]);
    expect(sim.calls[0]!.file).toBe('/opt/homebrew/bin/tmux');
    expect(sim.calls[0]!.argv.slice(0, 5)).toEqual(['-u', '-L', 'ccd-1a-deadbeef', '-f', '/dev/null']);
    expect(baseArgs('ccd-x')).toEqual(['-u', '-L', 'ccd-x', '-f', '/dev/null']);
  });

  it('strips TMUX and TMUX_PANE from the client env and keeps everything else (incl. secrets for the server env)', async () => {
    const sim = new TmuxSim();
    sim.serverUp = true;
    await mk(sim.exec, {
      TMUX: '/tmp/tmux-501/default,1,0',
      TMUX_PANE: '%1',
      LC_ALL: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://u:tok@127.0.0.1:1',
    }).run([lit('list-sessions')]);
    expect(sim.calls[0]!.env).toEqual({ LC_ALL: 'en_US.UTF-8', HTTPS_PROXY: 'http://u:tok@127.0.0.1:1' });
    expect(sanitizeClientEnv({ TMUX: 'x', A: 'b' })).toEqual({ A: 'b' });
  });

  it('uses timeout 5 s and maxBuffer 16 MiB by default', async () => {
    const sim = new TmuxSim();
    sim.serverUp = true;
    await mk(sim.exec).run([lit('list-sessions')]);
    expect(sim.calls[0]!.timeoutMs).toBe(5000);
    expect(sim.calls[0]!.maxBuffer).toBe(16 * 1024 * 1024);
  });

  it('passes stdin only when given (load-buffer -)', async () => {
    const sim = new TmuxSim();
    sim.serverUp = true;
    const e = mk(sim.exec);
    await e.run([lit('load-buffer'), lit('-b'), lit('b'), lit('-')], { stdin: 'x;y' });
    await e.run([lit('list-sessions')]);
    expect(sim.calls[0]!.stdin).toBe('x;y');
    expect(sim.calls[1]!.stdin).toBeUndefined();
  });

  it('refuses argv above 12 KiB before spawning anything (P-TMUX-06)', async () => {
    const sim = new TmuxSim();
    await expect(mk(sim.exec).run([lit('send-keys'), lit('-l'), lit('--'), lit('x'.repeat(13_000))])).rejects.toBeInstanceOf(
      TmuxArgTooLong,
    );
    expect(sim.calls).toHaveLength(0);
  });

  it('maps ENOENT to TmuxNotFound and stderr to typed errors', async () => {
    const enoent: ExecFileFn = () =>
      Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, errorCode: 'ENOENT' });
    await expect(mk(enoent).run([lit('list-sessions')])).rejects.toBeInstanceOf(TmuxNotFound);
    const gone: ExecFileFn = () => Promise.resolve(fail('no server running on /tmp/tmux-501/ccd-x\n'));
    await expect(mk(gone).run([lit('list-sessions')])).rejects.toBeInstanceOf(TmuxServerGone);
    const big: ExecFileFn = () =>
      Promise.resolve({
        code: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        timedOut: false,
        errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
    await expect(mk(big).run([lit('capture-pane')])).rejects.toBeInstanceOf(TmuxCommandFailed);
    const slow: ExecFileFn = () => Promise.resolve({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true });
    const err = await mk(slow)
      .run([lit('capture-pane'), SEP, lit('display-message')])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmuxCommandFailed);
    expect((err as TmuxCommandFailed).timedOut).toBe(true);
    expect((err as TmuxCommandFailed).commands).toEqual(['capture-pane', 'display-message']);
  });

  it('rejects socket names that are paths or long (P-TMUX-38: -S is never used)', () => {
    expect(() => new TmuxExec({ tmuxPath: '/x/tmux', socketName: '/tmp/sock', env: {} })).toThrow(TmuxInvalidInput);
    expect(() => new TmuxExec({ tmuxPath: '/x/tmux', socketName: `ccd-${'a'.repeat(80)}`, env: {} })).toThrow(TmuxInvalidInput);
  });

  it('runSyncBestEffort never throws', () => {
    const e = new TmuxExec({
      tmuxPath: '/x/tmux',
      socketName: 'ccd-a',
      env: {},
      execFileSync: () => {
        throw new Error('boom');
      },
    });
    expect(() => {
      e.runSyncBestEffort([lit('kill-server')]);
    }).not.toThrow();
  });
});

describe('nodeExecFile (real child_process.execFile, no shell)', () => {
  it('runs a binary with argv verbatim and feeds stdin', async () => {
    const r = await nodeExecFile(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      env: {},
      timeoutMs: 5000,
      maxBuffer: 1 << 20,
      stdin: '$HOME;`x`',
    });
    expect(r).toMatchObject({ code: 0, stdout: '$HOME;`x`', timedOut: false });
  });

  it('reports exit codes, ENOENT and timeouts', async () => {
    expect((await nodeExecFile(process.execPath, ['-e', 'process.exit(3)'], { env: {}, timeoutMs: 5000, maxBuffer: 1 << 20 })).code).toBe(
      3,
    );
    expect((await nodeExecFile('/nonexistent/tmux', ['-V'], { env: {}, timeoutMs: 5000, maxBuffer: 1 << 20 })).errorCode).toBe('ENOENT');
    const t = await nodeExecFile(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, timeoutMs: 200, maxBuffer: 1 << 20 });
    expect(t.timedOut).toBe(true);
  });

  it('ok() helper sanity', () => {
    expect(ok('x').code).toBe(0);
  });
});
