// WP-01 fake-tmux.ts fault injection (§6.4 tmux row): lost Enter, dead pane, vanish(), copy mode, torn frames, A→B→A frames,
// key mode, zero-invocation accounting (K-03). The shared behaviour is covered by test/contract/tmux.contract.test.ts.
import { describe, expect, it } from 'vitest';
import {
  TmuxCommandFailed,
  TmuxNotFound,
  TmuxPaneDead,
  TmuxUnsupported,
  TmuxVersionUnsupported,
} from '../../../src/platform/tmux/errors.js';
import { FakeTmux, KEY_BYTES } from '../../../src/platform/tmux/fake-tmux.js';
import { ManualClock } from './tmux-test-helpers.js';

async function setup(o: { version?: string } = {}) {
  const fake = new FakeTmux({ clock: new ManualClock(), ...(o.version !== undefined ? { version: o.version } : {}) });
  const server = await fake.create({
    tmuxPath: '/opt/homebrew/bin/tmux',
    socketName: 'ccd-f-1',
    clientEnv: {},
    historyLimit: 100,
    paneDiedLogPath: '/tmp/x.log',
  });
  const pane = await server.spawnPane({
    sessionName: 'ccd-s1',
    argv: ['/usr/bin/env', 'claude'],
    cwd: '/tmp',
    cols: 250,
    rows: 10,
    nonSecretEnv: {},
  });
  return { fake, server, pane, fp: fake.lastPane()!, fs: fake.lastServer()! };
}

describe('FakeTmux', () => {
  it('records zero invocations until something is called (K-03)', () => {
    const fake = new FakeTmux({ clock: new ManualClock() });
    expect(fake.invocationCount()).toBe(0);
  });

  it('probe: missing binary and old versions', async () => {
    await expect(new FakeTmux({ clock: new ManualClock(), missing: true }).probe()).rejects.toBeInstanceOf(TmuxNotFound);
    await expect(new FakeTmux({ clock: new ManualClock(), version: '3.1c' }).probe()).rejects.toBeInstanceOf(TmuxVersionUnsupported);
    expect(await new FakeTmux({ clock: new ManualClock() }).probe()).toEqual({ path: '/opt/homebrew/bin/tmux', version: '3.5a' });
  });

  it('dropNextKey: the next matching key resolves but is not delivered (lost Enter, K-06)', async () => {
    const { fake, pane, fp } = await setup();
    fake.dropNextKey('Enter');
    await pane.sendKey('Enter');
    await pane.sendKey('Enter');
    expect(fp.received).toEqual(['\r']);
    expect(fp.inputs.map((i) => i.dropped)).toEqual([true, false]);
    expect(fake.invocations.filter((i) => i.op === 'sendKey')).toEqual([
      { op: 'sendKey', paneId: '%0', key: 'Enter', dropped: true },
      { op: 'sendKey', paneId: '%0', key: 'Enter', dropped: false },
    ]);
  });

  it('records inputs with the bytes the app would receive', async () => {
    const { pane, fp } = await setup();
    await pane.paste('a\r\nb');
    await pane.typeLiteral('/clear');
    await pane.sendKey('BTab');
    expect(fp.received).toEqual(['a\nb', '/clear', KEY_BYTES.BTab]); // no bracketed paste enabled by the default program
    expect(fp.inputs.map((i) => i.kind)).toEqual(['paste', 'typeLiteral', 'key']);
  });

  it('queueFrames: A→B→A all reach capture in order, then the last frame stays (K-43)', async () => {
    const { pane, fp } = await setup();
    fp.queueFrames([['A'], ['B'], ['A']]);
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push((await pane.capture()).lines[0]);
    expect(seen).toEqual(['A', 'B', 'A', 'A']);
    const h1 = (await pane.capture()).hash;
    expect((await pane.capture()).hash).toBe(h1);
  });

  it('tearNextCapture: top half new, bottom half old', async () => {
    const { pane, fp } = await setup();
    fp.setScreen(Array.from({ length: 10 }, () => 'old'));
    fp.setScreen(Array.from({ length: 10 }, () => 'new'));
    fp.tearNextCapture();
    const torn = (await pane.capture()).lines;
    expect(torn.slice(0, 5)).toEqual(Array(5).fill('new'));
    expect(torn.slice(5)).toEqual(Array(5).fill('old'));
    expect((await pane.capture()).lines).toEqual(Array(10).fill('new'));
  });

  it('exitPane: dead pane, died once, input refused, exit record appended', async () => {
    const { fake, pane, fp } = await setup();
    let died = 0;
    pane.on('died', () => died++);
    fp.exitPane({ status: 3 });
    expect(await pane.status()).toMatchObject({ dead: true, exitStatus: 3 });
    await pane.capture();
    expect(died).toBe(1);
    await expect(pane.sendKey('Enter')).rejects.toBeInstanceOf(TmuxPaneDead);
    expect(fake.exitLogLines('/tmp/x.log')).toEqual(['died pane=%0 pid=50000 status=3 signal=']);
  });

  it('vanish(): crash noticed lazily by the next command, like the real driver', async () => {
    const { server, pane, fs } = await setup();
    let gone = 0;
    server.onGone(() => gone++);
    fs.vanish();
    expect(gone).toBe(0);
    expect((await pane.status()).exists).toBe(false);
    expect(gone).toBe(1);
    await expect(pane.capture()).rejects.toThrow(/unexpectedly/);
    expect(gone).toBe(1);
  });

  it('vanishPane(): a pane removed without a death', async () => {
    const { pane, fp } = await setup();
    let gone = 0;
    pane.on('gone', () => gone++);
    fp.vanishPane();
    expect((await pane.status()).exists).toBe(false);
    expect(gone).toBe(1);
  });

  it('setKeyMode: spawns and input fail with TmuxUnsupported{extendedKeys} (LP-52)', async () => {
    const { server, pane, fs } = await setup();
    fs.setKeyMode('Ext 2');
    await expect(pane.sendKey('Enter')).rejects.toBeInstanceOf(TmuxUnsupported);
    await expect(
      server.spawnPane({ sessionName: 'ccd-s2', argv: ['/bin/sh', 'x'], cwd: '/tmp', cols: 250, rows: 10, nonSecretEnv: {} }),
    ).rejects.toBeInstanceOf(TmuxUnsupported);
  });

  it('failNext injects one error for one op', async () => {
    const { fake, pane } = await setup();
    fake.failNext('paste', new TmuxCommandFailed(1, 'boom', ['load-buffer']));
    await expect(pane.paste('x')).rejects.toBeInstanceOf(TmuxCommandFailed);
    await pane.paste('x');
    fake.failNext('capture', new TmuxCommandFailed(1, 'boom', ['capture-pane']));
    await expect(pane.capture()).rejects.toBeInstanceOf(TmuxCommandFailed);
  });

  it('copy mode and alternate screen are reported', async () => {
    const { pane, fp } = await setup();
    fp.enterCopyMode();
    fp.setAlternate(true);
    fp.setCursor(3, 4);
    expect(await pane.status()).toMatchObject({ inMode: true, alternateOn: true, cursorX: 3, cursorY: 4 });
    await pane.exitCopyMode();
    expect((await pane.status()).inMode).toBe(false);
  });

  it('programs: start/input hooks drive the screen (env carries the client env and -e extras)', async () => {
    const fake = new FakeTmux({
      clock: new ManualClock(),
      program: () => ({
        start: (io) => {
          io.print(`hi ${io.env['A'] ?? ''} ${io.env['B'] ?? ''}`);
        },
        input: (b, io) => {
          if (b === '\r') io.exit(0);
        },
      }),
    });
    const s = await fake.create({
      tmuxPath: '/x/tmux',
      socketName: 'ccd-f-2',
      clientEnv: { A: '1', TMUX: 'no' },
      historyLimit: 1,
      paneDiedLogPath: '/tmp/y.log',
    });
    const p = await s.spawnPane({
      sessionName: 'ccd-s1',
      argv: ['/bin/a', 'b'],
      cwd: '/tmp',
      cols: 120,
      rows: 5,
      nonSecretEnv: { B: '2' },
    });
    expect((await p.capture()).lines[0]).toBe('hi 1 2');
    expect(fake.lastPane()!.env['TMUX']).not.toBe('no');
    await p.sendKey('Enter');
    expect((await p.status()).dead).toBe(true);
  });
});
