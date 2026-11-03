import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { SessionRecord } from '../../../src/cli/host.js';
import { readSessionRecord } from '../../../src/cli/node-host.js';
import { assertSessionKey, runView, viewArgv, viewCommandLine, ViewError, type ViewHost } from '../../../src/cli/view.js';
import { rec } from './helpers.js';

function host(r: SessionRecord | 'missing' | { error: string }, env: Record<string, string> = {}): ViewHost & { execs: unknown[] } {
  const execs: unknown[] = [];
  return {
    execs,
    readSession: () => Promise.resolve(r),
    env: () => env,
    execInteractive: (file, args, e) => {
      execs.push({ file, args, env: e });
      return Promise.resolve(0);
    },
  };
}

describe('ccd view (read-only attach, P-TMUX-18)', () => {
  const r = rec('s0000abcd');
  it('builds `tmux -u -L <sock> attach-session -r -t =<session>:`', () => {
    expect(viewArgv(r)).toEqual({
      file: '/opt/homebrew/bin/tmux',
      args: ['-u', '-L', 'ccd-100-s0000abcd', 'attach-session', '-r', '-t', '=ccd-s0000abcd:'],
    });
    expect(viewCommandLine(r)).toBe('env -u TMUX /opt/homebrew/bin/tmux -u -L ccd-100-s0000abcd attach-session -r -t =ccd-s0000abcd:');
  });

  it('always read-only: -r is present in every built command', () => {
    expect(viewArgv(r).args).toContain('-r');
  });

  it.each([
    ['socket name with a space', { tmux: { ...r.tmux, socketName: 'a b' } }],
    ['session name with a colon', { tmux: { ...r.tmux, sessionName: 'x:y' } }],
    ['relative tmux bin', { tmux: { ...r.tmux, bin: 'tmux' } }],
    ['tmux bin with $', { tmux: { ...r.tmux, bin: '/bin/$x' } }],
  ])('refuses a registry record with %s', (_n, over) => {
    expect(() => viewArgv({ ...r, ...over })).toThrow(ViewError);
  });

  it('refuses session keys that could escape the registry dir', () => {
    expect(() => assertSessionKey('../x')).toThrow(ViewError);
    expect(() => assertSessionKey('')).toThrow(ViewError);
    expect(assertSessionKey('s0000abcd')).toBe('s0000abcd');
  });

  it('prints by default, execs with --exec without TMUX/TMUX_PANE', async () => {
    const h = host(r, { TMUX: '/tmp/x,1,0', TMUX_PANE: '%3', HOME: '/h' });
    const printed = await runView(h, 's0000abcd', { exec: false });
    expect(printed).toEqual({ exitCode: 0, stdout: `${viewCommandLine(r)}\n`, stderr: '' });
    expect(h.execs).toEqual([]);
    const ran = await runView(h, 's0000abcd', { exec: true });
    expect(ran.exitCode).toBe(0);
    expect(h.execs).toEqual([{ file: '/opt/homebrew/bin/tmux', args: viewArgv(r).args, env: { HOME: '/h' } }]);
  });

  it('missing and unreadable records exit 1', async () => {
    expect(await runView(host('missing'), 's1', { exec: false })).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('no live session s1') as unknown,
    });
    expect(await runView(host({ error: 'invalid JSON' }), 's1', { exec: false })).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('invalid JSON') as unknown,
    });
  });
});

describe('readSessionRecord (node host)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-view-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'sessions'), { recursive: true });
  const stored = {
    v: 2,
    sessionKey: 's0000abcd',
    owner: { pid: 10, startTime: 'x' },
    tmux: { bin: '/usr/bin/tmux', socketName: 'ccd-10-ab', socketPath: '/tmp/s', sessionName: 'ccd-s0000abcd' },
    claude: { pid: 11, startTime: 'y', exe: '/c/claude.exe', version: '2.1.316' },
    claudeSessionId: 'abc',
    initialSessionId: 'abc',
    state: 'ready',
  };
  writeFileSync(join(root, 'sessions', 's0000abcd.json'), JSON.stringify(stored));
  writeFileSync(join(root, 'sessions', 'sbroken.json'), '{');

  it('reads and parses a live record', async () => {
    const r = await readSessionRecord(root, 's0000abcd');
    expect(r).toMatchObject({ key: 's0000abcd', tmux: { socketName: 'ccd-10-ab' }, claude: { pid: 11 } });
  });
  it('missing / broken / invalid key', async () => {
    expect(await readSessionRecord(root, 'snope')).toBe('missing');
    expect(await readSessionRecord(root, 'sbroken')).toEqual({ error: 'invalid JSON' });
    expect(await readSessionRecord(root, '../etc')).toEqual({ error: 'invalid key' });
  });
});
