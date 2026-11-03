// WP-05 unit tests: ClaudeConfigPort global-config handling — single-key atomic merge from a fresh read, mode preserved, never
// drop keys (P-LIFE-27, P-LIVE-12), trust lookup cwd → git root (D-19), concurrent writer retry.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEnv } from '../../../src/platform/env/fake-env.js';
import { createClaudeConfigPort, detectIndent, trustLookup } from '../../../src/platform/settings/claude-config.js';
import { ClaudeConfigBusy, ClaudeConfigUnreadable } from '../../../src/platform/settings/errors.js';
import { FakeClaudeConfig } from '../../../src/platform/settings/fake-config.js';
import { claudePaths, findGitRoot } from '../../../src/platform/settings/paths.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-cfg-')));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const cfgPath = () => join(home, '.claude.json');
const port = (extra: Partial<Parameters<typeof createClaudeConfigPort>[0]> = {}) =>
  createClaudeConfigPort({ env: new FakeEnv({ home, vars: {} }), ...extra });

const ORIGINAL = {
  numStartups: 218,
  oauthAccount: { accountUuid: 'u', emailAddress: 'x@y.z' },
  hasCompletedOnboarding: true,
  projects: {
    '/other': { allowedTools: [], hasTrustDialogAccepted: false, lastSessionId: 'abc' },
  },
  zLastKey: [1, 2, 3],
};

function writeConfig(v: unknown, o: { indent?: number | string; trailingNewline?: boolean; mode?: number } = {}): void {
  writeFileSync(cfgPath(), `${JSON.stringify(v, null, o.indent ?? 2)}${o.trailingNewline === false ? '' : '\n'}`);
  chmodSync(cfgPath(), o.mode ?? 0o600);
}

describe('paths', () => {
  it('global config and config dir follow CLAUDE_CONFIG_DIR and the legacy .config.json', () => {
    expect(claudePaths({}, '/h')).toEqual({ configDir: '/h/.claude', globalConfig: '/h/.claude.json' });
    expect(claudePaths({ CLAUDE_CONFIG_DIR: '/c' }, '/h')).toEqual({ configDir: '/c', globalConfig: '/c/.claude.json' });
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.config.json'), '{}');
    expect(claudePaths({}, home).globalConfig).toBe(join(home, '.claude', '.config.json'));
  });
});

describe('readGlobal', () => {
  it('missing / invalid JSON / onboarding flag', async () => {
    expect(await port().readGlobal()).toEqual({ ok: false, reason: 'missing' });
    writeFileSync(cfgPath(), '{"broken":');
    expect(await port().readGlobal()).toEqual({ ok: false, reason: 'invalidJson' });
    writeFileSync(cfgPath(), '[]');
    expect(await port().readGlobal()).toEqual({ ok: false, reason: 'invalidJson' });
    writeConfig({ hasCompletedOnboarding: 'yes' });
    expect(await port().readGlobal()).toEqual({ ok: true, hasCompletedOnboarding: false });
    writeConfig(ORIGINAL);
    expect(await port().readGlobal()).toEqual({ ok: true, hasCompletedOnboarding: true });
  });
});

describe('seedTrust / unseedTrust (single key, P-LIFE-27, P-LIVE-12)', () => {
  it('refuses a non-absolute key, so a prototype key can never be written (CodeQL js/prototype-polluting-assignment)', async () => {
    await expect(port().seedTrust('__proto__')).rejects.toMatchObject({ name: 'ClaudeConfigUnreadable', reason: 'cwdNotAbsolute' });
    await expect(port().unseedTrust('constructor')).resolves.toBeUndefined();
    expect(({} as Record<string, unknown>)['hasTrustDialogAccepted']).toBeUndefined();
  });

  it('adds only projects[cwd].hasTrustDialogAccepted, keeps every other byte-level property', async () => {
    writeConfig(ORIGINAL, { indent: 4, trailingNewline: false, mode: 0o640 });
    expect(await port().seedTrust('/work/repo')).toEqual({ added: true });
    const text = readFileSync(cfgPath(), 'utf8');
    const after = JSON.parse(text) as typeof ORIGINAL & { projects: Record<string, unknown> };
    expect(after).toEqual({ ...ORIGINAL, projects: { ...ORIGINAL.projects, '/work/repo': { hasTrustDialogAccepted: true } } });
    expect(Object.keys(after)).toEqual(Object.keys(ORIGINAL)); // key order kept
    expect(text.endsWith('\n')).toBe(false);
    expect(text.split('\n')[1]).toMatch(/^ {4}"numStartups"/); // indentation kept
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o640); // mode preserved, not widened
    expect(readdirSync(home).filter((n) => n.includes('.tmp'))).toEqual([]);

    expect(await port().seedTrust('/work/repo')).toEqual({ added: false }); // idempotent
    await port().unseedTrust('/work/repo');
    expect(JSON.parse(readFileSync(cfgPath(), 'utf8'))).toEqual({ ...ORIGINAL, projects: { ...ORIGINAL.projects, '/work/repo': {} } });
  });

  it('flips an existing false entry and unseed removes only that key, never the project entry', async () => {
    writeConfig(ORIGINAL);
    expect(await port().seedTrust('/other')).toEqual({ added: true });
    await port().unseedTrust('/other');
    const p = (JSON.parse(readFileSync(cfgPath(), 'utf8')) as typeof ORIGINAL).projects['/other'];
    expect(p).toEqual({ allowedTools: [], lastSessionId: 'abc' });
    await port().unseedTrust('/never-seeded'); // no-op, no throw
  });

  it('writes through a symlinked ~/.claude.json to its target (the link stays a link)', async () => {
    const realDir = join(home, 'dotfiles');
    mkdirSync(realDir);
    const real = join(realDir, 'claude.json');
    writeFileSync(real, JSON.stringify(ORIGINAL));
    chmodSync(real, 0o600);
    symlinkSync(real, cfgPath());
    await port().seedTrust('/w');
    expect(statSync(cfgPath()).isFile()).toBe(true);
    const { lstatSync } = await import('node:fs');
    expect(lstatSync(cfgPath()).isSymbolicLink()).toBe(true);
    expect((JSON.parse(readFileSync(real, 'utf8')) as { projects: Record<string, unknown> }).projects['/w']).toEqual({
      hasTrustDialogAccepted: true,
    });
  });

  it('missing or corrupt config is never "repaired" (E_CONFIG_CORRUPT path)', async () => {
    await expect(port().seedTrust('/w')).rejects.toBeInstanceOf(ClaudeConfigUnreadable);
    writeFileSync(cfgPath(), '{"a":');
    await expect(port().seedTrust('/w')).rejects.toMatchObject({ reason: 'invalidJson' });
    expect(readFileSync(cfgPath(), 'utf8')).toBe('{"a":');
    writeConfig({ projects: [] });
    await expect(port().seedTrust('/w')).rejects.toMatchObject({ reason: 'projectsNotObject' });
  });

  it('a concurrent writer between our read and rename forces a fresh merge on its version', async () => {
    writeConfig(ORIGINAL);
    let calls = 0;
    const p = port({
      beforeCommit: (attempt) => {
        calls++;
        if (attempt === 1) writeConfig({ ...ORIGINAL, numStartups: 219, newKeyFromClaude: true });
        return Promise.resolve();
      },
    });
    expect(await p.seedTrust('/race')).toEqual({ added: true });
    expect(calls).toBe(2);
    const after = JSON.parse(readFileSync(cfgPath(), 'utf8')) as Record<string, unknown>;
    expect(after['numStartups']).toBe(219);
    expect(after['newKeyFromClaude']).toBe(true);
    expect((after['projects'] as Record<string, unknown>)['/race']).toEqual({ hasTrustDialogAccepted: true });
  });

  it('gives up with ClaudeConfigBusy when the file changes on every attempt', async () => {
    writeConfig(ORIGINAL);
    let n = 0;
    const p = port({
      beforeCommit: () => {
        writeConfig({ ...ORIGINAL, numStartups: 300 + ++n });
        return Promise.resolve();
      },
    });
    await expect(p.seedTrust('/busy')).rejects.toBeInstanceOf(ClaudeConfigBusy);
    expect((JSON.parse(readFileSync(cfgPath(), 'utf8')) as { projects: Record<string, unknown> }).projects['/busy']).toBeUndefined();
  });

  it('detectIndent', () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe('    ');
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
    expect(detectIndent('{"a":1}')).toBe(2);
  });
});

describe('trustOf (D-19; cwd → git root, realpath keys)', () => {
  it('finds a trusted ancestor outside git all the way up', async () => {
    writeConfig({ ...ORIGINAL, projects: { [home]: { hasTrustDialogAccepted: true } } });
    const cwd = join(home, 'a', 'b');
    mkdirSync(cwd, { recursive: true });
    expect(await port().trustOf(cwd)).toEqual({ trusted: true, viaPath: home });
  });

  it('inside a git repo the walk stops at the git root; a false child entry does not override', async () => {
    const repo = join(home, 'repo');
    const cwd = join(repo, 'pkg', 'sub');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(repo, '.git'));
    expect(findGitRoot(cwd)).toBe(repo);
    writeConfig({ projects: { [home]: { hasTrustDialogAccepted: true } } });
    expect(await port().trustOf(cwd)).toEqual({ trusted: false });
    writeConfig({ projects: { [repo]: { hasTrustDialogAccepted: true }, [cwd]: { hasTrustDialogAccepted: false } } });
    expect(await port().trustOf(cwd)).toEqual({ trusted: true, viaPath: repo });
    expect(trustLookup({ projects: { '/x': { hasTrustDialogAccepted: 'true' } } }, '/x', undefined)).toEqual({ trusted: false });
    expect(trustLookup('nope', '/x', undefined)).toEqual({ trusted: false });
  });

  it('missing or broken config → not trusted', async () => {
    expect(await port().trustOf(home)).toEqual({ trusted: false });
    writeFileSync(cfgPath(), '{');
    expect(await port().trustOf(home)).toEqual({ trusted: false });
  });
});

describe('FakeClaudeConfig', () => {
  it('has the same single-key and walk semantics', async () => {
    const f = new FakeClaudeConfig({ global: structuredClone(ORIGINAL), gitRoots: ['/r'] });
    expect(await f.trustOf('/r/x')).toEqual({ trusted: false });
    expect(await f.seedTrust('/r')).toEqual({ added: true });
    expect(await f.trustOf('/r/x')).toEqual({ trusted: true, viaPath: '/r' });
    expect(await f.seedTrust('/r')).toEqual({ added: false });
    await f.unseedTrust('/r');
    expect((f.global as typeof ORIGINAL).projects).toEqual({ ...ORIGINAL.projects, '/r': {} });
    expect(f.writes).toEqual([
      { op: 'seed', cwd: '/r' },
      { op: 'unseed', cwd: '/r' },
    ]);
    expect(await new FakeClaudeConfig({ global: 'invalidJson' }).readGlobal()).toEqual({ ok: false, reason: 'invalidJson' });
    await expect(new FakeClaudeConfig({ global: 'missing' }).seedTrust('/x')).rejects.toBeInstanceOf(ClaudeConfigUnreadable);
  });
});
