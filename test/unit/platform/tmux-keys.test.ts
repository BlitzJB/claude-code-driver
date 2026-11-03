// WP-01 key list: P-TMUX-11 (BTab only), P-TMUX-12 (no S-Enter/C-Enter), P-TMUX-13 (closed enum; text never without -l --),
// P-TMUX-53 (no Tab/Right), P-INPUT-28 (Up only as a key, gating is core's), P-SEC-05, P-PRIOR-06 (no Left).
import { describe, expect, it } from 'vitest';
import type { TmuxKeyName } from '../../../src/model/intents.js';
import { TmuxInvalidInput } from '../../../src/platform/tmux/errors.js';
import { isTmuxKeyName, TMUX_KEYS } from '../../../src/platform/tmux/pane.js';
import { createTmuxServerFactory } from '../../../src/platform/tmux/server.js';
import { ManualClock, splitCommands, TmuxSim } from './tmux-test-helpers.js';

const FORBIDDEN = [
  'Tab',
  'S-Tab',
  'Right',
  'Left',
  'C-c',
  'C-u',
  'C-s',
  'C-y',
  'C-l',
  'C-d',
  'C-z',
  'C-b',
  'S-Enter',
  'C-Enter',
  'M-Enter',
  'PageUp',
  'PageDown',
  'enter',
  'ENTER',
  'Space',
  'BSpace',
  '0',
  '',
  'Enter Enter',
  'hello',
];

async function spawnSim() {
  const sim = new TmuxSim();
  const f = createTmuxServerFactory({ clock: new ManualClock(), execFile: sim.exec, fs: sim.fs, uid: 501 });
  const s = await f.create({
    tmuxPath: '/opt/homebrew/bin/tmux',
    socketName: 'ccd-t-1',
    clientEnv: {},
    historyLimit: 5000,
    paneDiedLogPath: '/tmp/exits.log',
  });
  const p = await s.spawnPane({
    sessionName: 'ccd-s1',
    argv: ['/usr/bin/env', 'true'],
    cwd: '/tmp',
    cols: 250,
    rows: 80,
    nonSecretEnv: {},
  });
  return { sim, p };
}

describe('closed key list', () => {
  it('matches the TmuxKeyName union exactly', () => {
    const expected: TmuxKeyName[] = ['Enter', 'Escape', 'BTab', 'Up', 'Down', 'C-g', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    expect([...TMUX_KEYS]).toEqual(expected);
  });

  it.each(FORBIDDEN)('rejects %j', (k) => {
    expect(isTmuxKeyName(k)).toBe(false);
  });

  it('sendKey refuses anything outside the list before any tmux call', async () => {
    const { sim, p } = await spawnSim();
    const before = sim.calls.length;
    for (const k of FORBIDDEN) await expect(p.sendKey(k as TmuxKeyName)).rejects.toBeInstanceOf(TmuxInvalidInput);
    expect(sim.calls.length).toBe(before);
  });

  it('sends exactly one key per invocation, without -l (a key name, not text)', async () => {
    const { sim, p } = await spawnSim();
    for (const k of TMUX_KEYS) await p.sendKey(k);
    const sends = sim.calls.map((c) => splitCommands(c.cmd)).filter((cs) => cs.some((c) => c[0] === 'send-keys'));
    expect(sends).toHaveLength(TMUX_KEYS.length);
    for (const [i, cs] of sends.entries()) {
      expect(cs).toHaveLength(1);
      expect(cs[0]).toEqual(['send-keys', '-t', '%0', TMUX_KEYS[i]]);
    }
  });

  it('typeLiteral always uses -l -- (text never becomes key names, P-SEC-05)', async () => {
    const { sim, p } = await spawnSim();
    await p.typeLiteral('enter');
    expect(sim.calls.at(-1)!.cmd).toEqual(['send-keys', '-t', '%0', '-l', '--', 'enter']);
  });
});
