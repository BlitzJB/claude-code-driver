// WP-01 capture: P-TMUX-27 (-p -N, never -J/-a), P-TMUX-30 (never -S -), P-TMUX-15 (display-message exits 0 on a miss),
// status from the same batch, hash for the L1 consecutive-identical drop (D-41/D-42).
import { describe, expect, it } from 'vitest';
import { TmuxInvalidInput, TmuxTargetMissing } from '../../../src/platform/tmux/errors.js';
import { captureHash } from '../../../src/platform/tmux/pane.js';
import { createTmuxServerFactory } from '../../../src/platform/tmux/server.js';
import { ManualClock, ok, splitCommands, TmuxSim } from './tmux-test-helpers.js';

async function setup() {
  const sim = new TmuxSim();
  const clock = new ManualClock();
  const f = createTmuxServerFactory({ clock, execFile: sim.exec, fs: sim.fs, uid: 501 });
  const server = await f.create({
    tmuxPath: '/opt/homebrew/bin/tmux',
    socketName: 'ccd-t-1',
    clientEnv: {},
    historyLimit: 5000,
    paneDiedLogPath: '/tmp/exits.log',
  });
  const pane = await server.spawnPane({
    sessionName: 'ccd-s1',
    argv: ['/usr/bin/env', 'true'],
    cwd: '/tmp',
    cols: 250,
    rows: 80,
    nonSecretEnv: {},
  });
  sim.calls = [];
  return { sim, clock, pane };
}

describe('capture', () => {
  it('one batch: display-message status ; capture-pane -p -N -t %N', async () => {
    const { sim, pane } = await setup();
    sim.pane().lines[0] = '╭ hello   ';
    const c = await pane.capture();
    expect(sim.calls).toHaveLength(1);
    const cmds = splitCommands(sim.calls[0]!.cmd);
    expect(cmds[0]!.slice(0, 4)).toEqual(['display-message', '-p', '-t', '%0']);
    expect(cmds[1]).toEqual(['capture-pane', '-p', '-N', '-t', '%0']);
    expect(c.lines).toHaveLength(80);
    expect(c.lines[0]).toBe('╭ hello   ');
    expect(c.status).toMatchObject({ exists: true, dead: false, cols: 250, rows: 80, cursorY: 5 });
    expect(c.at).toBe(1000);
  });

  it('never uses -J, -a or -S - ; row windows become -S/-E integers', async () => {
    const { sim, pane } = await setup();
    await pane.capture({ startRow: 70, endRow: 79, styles: true });
    await pane.capture({ startRow: -12 });
    const caps = sim.commands().filter((c) => c[0] === 'capture-pane');
    expect(caps[0]).toEqual(['capture-pane', '-p', '-N', '-t', '%0', '-e', '-S', '70', '-E', '79']);
    expect(caps[1]).toEqual(['capture-pane', '-p', '-N', '-t', '%0', '-S', '-12']);
    for (const c of caps) {
      expect(c).not.toContain('-J');
      expect(c).not.toContain('-a');
      expect(c.join(' ')).not.toMatch(/-S -( |$)/);
    }
  });

  it('validates the row window', async () => {
    const { pane } = await setup();
    await expect(pane.capture({ startRow: 1.5 })).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(pane.capture({ endRow: Number.NaN })).rejects.toBeInstanceOf(TmuxInvalidInput);
    await expect(pane.capture({ startRow: 5, endRow: 4 })).rejects.toBeInstanceOf(TmuxInvalidInput);
  });

  it('returns exactly the requested rows', async () => {
    const { pane } = await setup();
    expect((await pane.capture({ startRow: 70, endRow: 79 })).lines).toHaveLength(10);
  });

  it('a missing pane (display-message exits 0 with empty fields) → TmuxTargetMissing + gone', async () => {
    const { sim, pane } = await setup();
    let gone = 0;
    pane.on('gone', () => gone++);
    sim.intercept.push((c) => (c.cmd[0] === 'display-message' ? ok('|||||||||||\n\n') : undefined));
    await expect(pane.capture()).rejects.toBeInstanceOf(TmuxTargetMissing);
    expect(gone).toBe(1);
  });

  it('capture refreshes the status cache and reports death', async () => {
    const { sim, pane } = await setup();
    const died: unknown[] = [];
    pane.on('died', (s) => died.push(s));
    Object.assign(sim.pane(), { dead: true, status: '', signal: 'term' });
    const c = await pane.capture();
    expect(c.status).toMatchObject({ dead: true, exitStatus: null, exitSignal: 'SIGTERM' });
    expect(died).toHaveLength(1);
    const before = sim.calls.length;
    expect((await pane.status()).dead).toBe(true);
    expect(sim.calls.length).toBe(before); // served from the cache
  });

  it('hash changes with content and with mode bits, not otherwise', () => {
    const st = { dead: false, inMode: false, alternateOn: false, cursorX: 0, cursorY: 0 };
    const a = captureHash(['a', 'b'], st);
    expect(captureHash(['a', 'b'], st)).toBe(a);
    expect(captureHash(['a', 'c'], st)).not.toBe(a);
    expect(captureHash(['a', 'b'], { ...st, alternateOn: true })).not.toBe(a);
    expect(captureHash(['a', 'b'], { ...st, inMode: true })).not.toBe(a);
    expect(captureHash(['a\nb'], st)).toBe(a); // the hash is over the joined text; rows are fixed by the pane height
  });
});
