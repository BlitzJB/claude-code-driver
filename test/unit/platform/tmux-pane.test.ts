// WP-01 tmux/pane.ts input path: P-TMUX-07, P-TMUX-09, P-TMUX-14, P-TMUX-21 (status cache ≤ 100 ms, A-2), P-TMUX-44 (FIFO),
// P-TMUX-45 (copy mode), P-TMUX-52 (lone surrogates), P-TMUX-58 (unique buffers + delete on failure), P-TMUX-59 (stdin),
// P-REV-44 (key mode).
import { describe, expect, it } from 'vitest';
import type { TmuxPane } from '../../../src/platform/ports.js';
import {
  TmuxArgTooLong,
  TmuxCommandFailed,
  TmuxInvalidInput,
  TmuxPaneDead,
  TmuxPaneInMode,
  TmuxTargetMissing,
  TmuxUnsupported,
} from '../../../src/platform/tmux/errors.js';
import {
  isWellFormedString,
  normalizePasteText,
  normalizeSignal,
  parseStatusLine,
  STATUS_TTL_MS,
} from '../../../src/platform/tmux/pane.js';
import { createTmuxServerFactory } from '../../../src/platform/tmux/server.js';
import { fail, ManualClock, splitCommands, TmuxSim } from './tmux-test-helpers.js';

async function setup(version = 'tmux 3.5a') {
  const sim = new TmuxSim();
  sim.version = version;
  const clock = new ManualClock();
  const f = createTmuxServerFactory({ clock, execFile: sim.exec, fs: sim.fs, uid: 501 });
  const server = await f.create({
    tmuxPath: '/opt/homebrew/bin/tmux',
    socketName: 'ccd-t-1',
    clientEnv: {},
    historyLimit: 5000,
    paneDiedLogPath: '/tmp/exits.log',
  });
  const pane: TmuxPane = await server.spawnPane({
    sessionName: 'ccd-s1',
    argv: ['/usr/bin/env', 'true'],
    cwd: '/tmp',
    cols: 250,
    rows: 80,
    nonSecretEnv: {},
  });
  sim.calls = [];
  return { sim, clock, server, pane };
}

describe('paste (TD R9, D-15)', () => {
  it('load-buffer from stdin + paste-buffer -p -r -d in one invocation, never Enter', async () => {
    const { sim, pane } = await setup();
    await pane.paste('line1;\nline2');
    const pasteCall = sim.calls.find((c) => c.cmd[0] === 'load-buffer')!;
    expect(splitCommands(pasteCall.cmd)).toEqual([
      ['load-buffer', '-b', 'ccd-0-1', '-'],
      ['paste-buffer', '-t', '%0', '-b', 'ccd-0-1', '-d', '-p', '-r'],
    ]);
    expect(pasteCall.stdin).toBe('line1;\nline2');
    expect(sim.commands().some((c) => c[0] === 'send-keys')).toBe(false);
    expect(sim.buffers.size).toBe(0);
  });

  it('uses a fresh buffer name per paste', async () => {
    const { sim, pane } = await setup();
    await pane.paste('a');
    await pane.paste('b');
    const names = sim
      .commands()
      .filter((c) => c[0] === 'load-buffer')
      .map((c) => c[2]);
    expect(names).toEqual(['ccd-0-1', 'ccd-0-2']);
  });

  it('normalises CRLF and CR to LF', async () => {
    const { sim, pane } = await setup();
    await pane.paste('a\r\nb\rc');
    expect(sim.calls.find((c) => c.cmd[0] === 'load-buffer')!.stdin).toBe('a\nb\nc');
    expect(normalizePasteText('x\r\n\r\ny')).toBe('x\n\ny');
  });

  it('rejects lone surrogates and control characters other than LF/TAB (ESC could close the bracket)', async () => {
    const { sim, pane } = await setup();
    await expect(pane.paste('a\ud800b')).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(pane.paste('a\u001b[201~b')).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(pane.paste('a\u0003')).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(pane.paste('a\u0085')).rejects.toBeInstanceOf(TmuxInvalidInput);
    await pane.paste('tab\there\nok 日本 👍🏽');
    expect(sim.calls.filter((c) => c.cmd[0] === 'load-buffer')).toHaveLength(1);
    expect(isWellFormedString('👍')).toBe(true);
    expect(isWellFormedString('\udc00')).toBe(false);
    expect(isWellFormedString('\ud83d')).toBe(false);
  });

  it('empty text is a no-op (load-buffer of empty stdin creates no buffer)', async () => {
    const { sim, pane } = await setup();
    await pane.paste('');
    expect(sim.calls).toHaveLength(0);
  });

  it('deletes the buffer when the paste fails', async () => {
    const { sim, pane } = await setup();
    sim.intercept.push((c) => (c.cmd[0] === 'load-buffer' ? (sim.buffers.set('ccd-0-1', 'x'), fail("can't find pane: %0\n")) : undefined));
    await expect(pane.paste('x')).rejects.toBeInstanceOf(TmuxTargetMissing);
    expect(sim.commands().some((c) => c[0] === 'delete-buffer' && c[2] === 'ccd-0-1')).toBe(true);
    expect(sim.buffers.size).toBe(0);
  });

  it('a large paste goes entirely through stdin (no argv limit)', async () => {
    const { sim, pane } = await setup();
    const big = 'x'.repeat(200_000);
    await pane.paste(big);
    const c = sim.calls.find((x) => x.cmd[0] === 'load-buffer')!;
    expect(c.stdin).toHaveLength(200_000);
    expect(c.argv.join(' ').length).toBeLessThan(200);
  });
});

describe('typeLiteral', () => {
  it('send-keys -l -- with the trailing-; escape', async () => {
    const { sim, pane } = await setup();
    await pane.typeLiteral('/model x;');
    expect(sim.calls[sim.calls.length - 1]!.cmd).toEqual(['send-keys', '-t', '%0', '-l', '--', '/model x\\;']);
    await pane.typeLiteral('-x');
    expect(sim.calls[sim.calls.length - 1]!.cmd.slice(-2)).toEqual(['--', '-x']);
  });

  it('refuses > 8 KiB, control characters and lone surrogates', async () => {
    const { pane } = await setup();
    await expect(pane.typeLiteral('é'.repeat(4097))).rejects.toBeInstanceOf(TmuxArgTooLong);
    await expect(pane.typeLiteral('a\nb')).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(pane.typeLiteral('a\rb')).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(pane.typeLiteral('\ud800')).rejects.toBeInstanceOf(TmuxInvalidInput);
  });
});

describe('input preconditions (P-TMUX-21, P-TMUX-45, P-REV-44)', () => {
  it('refuses input on a dead pane (send-keys to a dead pane would exit 0 and be lost)', async () => {
    const { sim, clock, pane } = await setup();
    const died: unknown[] = [];
    pane.on('died', (s) => died.push(s));
    Object.assign(sim.pane(), { dead: true, status: '42' });
    clock.advance(STATUS_TTL_MS + 1);
    const err = await pane.sendKey('Enter').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmuxPaneDead);
    expect((err as TmuxPaneDead).exitStatus).toBe(42);
    expect(died).toEqual([{ exitStatus: 42, exitSignal: null }]);
    expect(sim.commands().some((c) => c[0] === 'send-keys')).toBe(false);
  });

  it('the status cache lives ≤ 100 ms (a timestamp check, adapter timer A-2)', async () => {
    const { sim, clock, pane } = await setup();
    await pane.sendKey('1');
    await pane.sendKey('2');
    expect(sim.commands().filter((c) => c[0] === 'list-panes')).toHaveLength(1);
    clock.advance(STATUS_TTL_MS + 1);
    await pane.sendKey('3');
    expect(sim.commands().filter((c) => c[0] === 'list-panes')).toHaveLength(2);
  });

  it('refuses input in copy mode; exitCopyMode sends -X cancel only when in mode', async () => {
    const { sim, clock, pane } = await setup();
    await pane.exitCopyMode();
    expect(sim.commands().some((c) => c.includes('-X'))).toBe(false);
    sim.pane().inMode = true;
    clock.advance(STATUS_TTL_MS + 1);
    await expect(pane.paste('x')).rejects.toBeInstanceOf(TmuxPaneInMode);
    await pane.exitCopyMode();
    expect(sim.commands().find((c) => c.includes('-X'))).toEqual(['send-keys', '-t', '%0', '-X', 'cancel']);
    await pane.paste('x');
    expect(sim.commands().some((c) => c[0] === 'load-buffer')).toBe(true);
  });

  it('refuses input unless the key mode is VT10x (LP-52)', async () => {
    const { sim, clock, pane } = await setup();
    sim.pane().keyMode = 'Ext 2';
    clock.advance(STATUS_TTL_MS + 1);
    const err = await pane.sendKey('Enter').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmuxUnsupported);
    expect((err as TmuxUnsupported).reason).toBe('extendedKeys');
  });

  it('on tmux < 3.5 an empty key mode (format missing) is accepted', async () => {
    const { sim, clock, pane } = await setup('tmux 3.4');
    sim.pane().keyMode = '';
    clock.advance(STATUS_TTL_MS + 1);
    await pane.sendKey('Enter');
    expect(sim.commands().filter((c) => c[0] === 'send-keys')).toHaveLength(1);
  });

  it('a vanished pane: input → TmuxTargetMissing, status exists:false, gone fired once', async () => {
    const { sim, clock, pane } = await setup();
    let gone = 0;
    pane.on('gone', () => gone++);
    sim.panes.clear();
    clock.advance(STATUS_TTL_MS + 1);
    await expect(pane.sendKey('Enter')).rejects.toBeInstanceOf(TmuxTargetMissing);
    expect((await pane.status()).exists).toBe(false);
    clock.advance(STATUS_TTL_MS + 1);
    expect((await pane.status()).exists).toBe(false);
    expect(gone).toBe(1);
  });
});

describe('FIFO input queue (P-TMUX-44, P-TMUX-14)', () => {
  it('concurrent calls run strictly in call order, one invocation each', async () => {
    const { sim, pane } = await setup();
    const order: string[] = [];
    sim.intercept.push((c) => {
      if (c.cmd[0] === 'send-keys') order.push(c.cmd.at(-1)!);
      if (c.cmd[0] === 'load-buffer') order.push(`paste:${c.stdin ?? ''}`);
      return undefined;
    });
    await Promise.all([pane.paste('a'), pane.sendKey('Enter'), pane.typeLiteral('b'), pane.sendKey('Escape'), pane.sendKey('1')]);
    expect(order).toEqual(['paste:a', 'Enter', 'b', 'Escape', '1']);
  });

  it('a failure does not stall the queue', async () => {
    const { sim, pane } = await setup();
    let first = true;
    sim.intercept.push((c) => {
      if (c.cmd[0] === 'send-keys' && first) {
        first = false;
        return fail('something odd\n');
      }
      return undefined;
    });
    const r = await Promise.allSettled([pane.sendKey('1'), pane.sendKey('2')]);
    expect(r[0].status).toBe('rejected');
    expect((r[0] as PromiseRejectedResult).reason).toBeInstanceOf(TmuxCommandFailed);
    expect(r[1].status).toBe('fulfilled');
  });

  it('a listener that throws does not break the pane', async () => {
    const { sim, clock, pane } = await setup();
    pane.on('died', () => {
      throw new Error('listener');
    });
    sim.pane().dead = true;
    clock.advance(STATUS_TTL_MS + 1);
    expect((await pane.status()).dead).toBe(true);
  });

  it('cancel removes a listener', async () => {
    const { sim, clock, pane } = await setup();
    let n = 0;
    const cancel = pane.on('died', () => n++);
    cancel();
    sim.pane().dead = true;
    clock.advance(STATUS_TTL_MS + 1);
    await pane.status();
    expect(n).toBe(0);
  });
});

describe('status parsing', () => {
  it('parses the status line and normalises signals', () => {
    const s = parseStatusLine('%3|1||term|0|1|4|5|250|80|12|VT10x', '%3');
    expect(s).toEqual({
      exists: true,
      dead: true,
      exitStatus: null,
      exitSignal: 'SIGTERM',
      inMode: false,
      alternateOn: true,
      cursorX: 4,
      cursorY: 5,
      cols: 250,
      rows: 80,
      historySize: 12,
      keyMode: 'VT10x',
    });
    expect(parseStatusLine('%3|1|42||0|0|0|0|250|80|0|', '%3')?.exitStatus).toBe(42);
    expect(parseStatusLine('%4|0||||||||||', '%3')).toBeUndefined();
    expect(parseStatusLine('garbage', '%3')).toBeUndefined();
    expect(normalizeSignal('15')).toBe('SIGTERM');
    expect(normalizeSignal('kill')).toBe('SIGKILL');
    expect(normalizeSignal('SIGHUP')).toBe('SIGHUP');
    expect(normalizeSignal('')).toBeNull();
  });

  it('killPane ignores a missing pane', async () => {
    const { sim, pane } = await setup();
    await pane.killPane();
    await pane.killPane();
    expect(sim.commands().filter((c) => c[0] === 'kill-pane')).toHaveLength(2);
  });

  it('viewCommand is a read-only attach with an exact, quoted target', async () => {
    const { pane } = await setup();
    expect(pane.viewCommand()).toBe("/opt/homebrew/bin/tmux -L ccd-t-1 attach -r -t '=ccd-s1:'");
  });
});
