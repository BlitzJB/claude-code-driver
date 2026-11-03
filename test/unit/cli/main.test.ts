import { describe, expect, it } from 'vitest';

import { EXIT_USAGE, main, USAGE, type CliDeps } from '../../../src/cli/main.js';
import { defaultStateDir } from '../../../src/cli/node-host.js';
import { emptyPass, memInstall, memLifecheck, NOW, rec } from './helpers.js';

function deps(over: Partial<CliDeps> = {}): CliDeps & { outs: string[]; errs: string[]; stateDirs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  const stateDirs: string[] = [];
  const lc = memLifecheck({ sessions: [rec('s1')], classes: new Map([['s1', { classification: 'orphan' }]]), pass: emptyPass() });
  return {
    outs,
    errs,
    stateDirs,
    out: (s) => outs.push(s),
    err: (s) => errs.push(s),
    env: { XDG_STATE_HOME: '/xdg' },
    homeDir: '/Users/u',
    lifecheckHost: (sd) => {
      stateDirs.push(sd);
      return Promise.resolve(lc.host);
    },
    installHost: (sd) => {
      stateDirs.push(sd);
      return memInstall({ stateDir: sd }, { runResult: () => ({ code: 113, stdout: '', stderr: '' }) }).host;
    },
    viewHost: () => ({
      readSession: () => Promise.resolve(rec('s1')),
      env: () => ({}),
      execInteractive: () => Promise.resolve(0),
    }),
    readFile: (p) =>
      p === 'golden'
        ? Promise.resolve('')
        : Promise.resolve(
            [
              JSON.stringify({ r: 'obs', seq: 1, obs: { kind: 'x', meta: { seq: 1, at: 1, wallAt: 1, source: 'hook' }, p: {} } }),
              JSON.stringify({
                r: 'event',
                e: {
                  v: 1,
                  seq: 5,
                  type: 'turn.completed',
                  at: 2,
                  wallAt: 2,
                  sessionKey: 's1',
                  provenance: { confirmed: true, sources: [] },
                  causedBy: [1],
                  payload: {},
                },
              }),
            ].join('\n'),
          ),
    ...over,
  };
}

describe('ccd main dispatch', () => {
  it('lifecheck --json prints the report (shape) and exits 0', async () => {
    const d = deps();
    expect(await main(['lifecheck', '--json'], d)).toBe(0);
    const j = JSON.parse(d.outs.join('')) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual([
      'actions',
      'distPath',
      'durationMs',
      'errors',
      'lastRunOk',
      'libVersion',
      'ranAt',
      'sessions',
      'unknownCcdSockets',
    ]);
    expect(j['ranAt']).toBe(NOW);
    expect(j['sessions']).toEqual([expect.objectContaining({ key: 's1', classification: 'orphan', claudeSessionId: 'uuid-s1' })]);
    expect(d.stateDirs).toEqual(['/xdg/claude-code-driver']);
  });

  it('--state-dir must be absolute; trailing slash dropped', async () => {
    const d = deps();
    expect(await main(['lifecheck', '--state-dir', '/s/'], d)).toBe(0);
    expect(d.stateDirs).toEqual(['/s']);
    expect(await main(['lifecheck', '--state-dir=rel'], d)).toBe(EXIT_USAGE);
    expect(d.errs.join('')).toContain('--state-dir must be an absolute path');
  });

  it('a failed lifecheck run exits 1', async () => {
    const lc = memLifecheck({ reapError: new Error('boom') });
    const d = deps({ lifecheckHost: () => Promise.resolve(lc.host) });
    expect(await main(['lifecheck'], d)).toBe(1);
    expect(d.outs.join('')).toContain('lifecheck FAILED');
  });

  it('lifecheck status: not installed → 3, --json shape', async () => {
    const d = deps();
    expect(await main(['lifecheck', 'status', '--json'], d)).toBe(3);
    expect(JSON.parse(d.outs.join(''))).toMatchObject({ health: 'notInstalled', exitCode: 3, installed: false });
  });

  it('lifecheck install / uninstall', async () => {
    const d = deps({ installHost: (sd) => memInstall({ stateDir: sd }).host });
    expect(await main(['lifecheck', 'install', '--state-dir', '/s'], d)).toBe(0);
    expect(d.outs.join('')).toContain('loaded com.claude-code-driver.lifecheck in gui/501');
    expect(await main(['lifecheck', 'uninstall', '--state-dir', '/s'], d)).toBe(0);
  });

  it('view prints the read-only command', async () => {
    const d = deps();
    expect(await main(['view', 's1'], d)).toBe(0);
    expect(d.outs.join('')).toContain('attach-session -r -t =ccd-s1:');
  });

  it('trace replay / explain', async () => {
    const d = deps();
    expect(await main(['trace', 'replay', 'f.ccd.jsonl'], d)).toBe(0);
    expect(d.outs.join('')).toContain('event#5 turn.completed');
    const d2 = deps();
    expect(await main(['trace', 'explain', 'f.ccd.jsonl', '--event', '5'], d2)).toBe(0);
    expect(d2.outs.join('')).toContain('event #5 turn.completed');
    const d3 = deps();
    expect(await main(['trace', 'replay', 'f.ccd.jsonl', '--golden', 'golden'], d3)).toBe(1);
    const d4 = deps();
    expect(await main(['trace', 'explain', 'f.ccd.jsonl', '--event', '6'], d4)).toBe(1);
    expect(d4.errs.join('')).toContain('no event with seq 6');
    const d5 = deps();
    expect(await main(['trace', 'replay', 'f', '--json', '--kinds', 'event'], d5)).toBe(0);
    expect((JSON.parse(d5.outs.join('')) as { records: unknown[] }).records).toHaveLength(1);
  });

  it.each([
    [['nope']],
    [['lifecheck', 'frobnicate']],
    [['lifecheck', '--bogus']],
    [['lifecheck', 'install', '--json']],
    [['lifecheck', 'status', '--signal-hung']],
    [['view']],
    [['view', 'a', 'b']],
    [['trace', 'explain', 'f']],
    [['trace', 'explain', 'f', '--event', 'x']],
    [['trace', 'replay', 'f', '--event', '1']],
    [['trace', 'zap', 'f']],
    [['trace']],
    [['lifecheck', '--state-dir']],
  ])('usage error %j → 64', async (argv) => {
    const d = deps();
    expect(await main(argv, d)).toBe(EXIT_USAGE);
    expect(d.errs.join('')).toContain('usage:');
  });

  it('help, version, no args', async () => {
    const d = deps();
    expect(await main(['--help'], d)).toBe(0);
    expect(d.outs.join('')).toBe(USAGE);
    expect(await main([], d)).toBe(EXIT_USAGE);
    expect(await main(['--version'], d)).toBe(0);
    expect(d.outs.at(-1)).toMatch(/^claude-code-driver \d/);
  });

  it('a host that cannot be built is exit 1 and leaves lastRunOk:false in lifecheck.json (P-REV-32)', async () => {
    const inst = memInstall({ stateDir: '/s' });
    const d = deps({ lifecheckHost: () => Promise.reject(new Error('runtime/node.js could not be loaded')), installHost: () => inst.host });
    expect(await main(['lifecheck', '--state-dir', '/s'], d)).toBe(1);
    expect(d.errs.join('')).toContain('runtime/node.js could not be loaded');
    const f = inst.fs.files.get('/s/lifecheck.json');
    expect(f?.mode).toBe(0o600);
    expect(JSON.parse(f?.text ?? '{}')).toMatchObject({ ranAt: NOW, lastRunOk: false, error: 'host: runtime/node.js could not be loaded' });
  });

  it('defaultStateDir follows XDG_STATE_HOME (absolute only)', () => {
    expect(defaultStateDir({ XDG_STATE_HOME: '/x' }, '/h')).toBe('/x/claude-code-driver');
    expect(defaultStateDir({ XDG_STATE_HOME: 'rel' }, '/h')).toBe('/h/.local/state/claude-code-driver');
    expect(defaultStateDir({}, '/h')).toBe('/h/.local/state/claude-code-driver');
  });
});
