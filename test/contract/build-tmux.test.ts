// test/contract/build-tmux.test.ts — scripts/ci/build-tmux.sh (WP-CI; DESIGN.md §7 "CI", P-TMUX-42).
// The script runs for real under bash: the `--check` version gate against fake and real tmux binaries, and the whole build
// pipeline (download → sha256 → extract → configure → make → install → `-V` check → private-server smoke test → GitHub
// outputs → cache reuse) against a fake source tarball served over file://, so no network and no compiler are needed.
// A real 3.2a build from github.com runs only with CCD_CI_BUILD_TMUX=1 (it downloads and compiles for minutes).
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findRealTmux } from './tmux.contract.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ci', 'build-tmux.sh');
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-ci-build-test-')));
let n = 0;
const fresh = (label: string): string => {
  const d = join(WORK, `${label}-${String(++n)}`);
  mkdirSync(d, { recursive: true });
  return d;
};

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? WORK,
      TMPDIR: WORK,
      CCD_TMUX_INSTALL_DEPS: '0',
      // The fake tarballs cannot match the pinned release digests; tests of the pins set this to '' explicitly.
      CCD_TMUX_SHA256: 'none',
      ...env,
    },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** A fake tmux that answers `-V` with `version`, logs every other argv to `log`, and prints `sessionName` for display. */
function fakeTmuxScript(version: string, opts: { sessionName?: string; failNew?: boolean } = {}): string {
  return [
    '#!/bin/sh',
    `if [ "$1" = "-V" ]; then echo "tmux ${version}"; exit 0; fi`,
    'if [ -n "$FAKE_TMUX_LOG" ]; then echo "$*" >>"$FAKE_TMUX_LOG"; fi',
    'for a in "$@"; do',
    `  case "$a" in new-session) ${opts.failNew === true ? 'exit 1' : 'exit 0'} ;; display-message) echo "${opts.sessionName ?? 'smoke'}"; exit 0 ;; kill-server) exit 0 ;; esac`,
    'done',
    'exit 0',
    '',
  ].join('\n');
}

function fakeBin(dir: string, version: string): string {
  const p = join(dir, `tmux-${version.replace(/[^\w.-]/g, '_')}`);
  writeFileSync(p, fakeTmuxScript(version));
  chmodSync(p, 0o755);
  return p;
}

/**
 * A release-shaped tarball `<base>/<version>/tmux-<version>.tar.gz` whose `configure` writes a Makefile that "builds" and
 * installs a fake tmux reporting `reports` (default: the version). `configure` appends a line to $FAKE_CONFIGURE_COUNT.
 */
function fakeRelease(
  version: string,
  opts: { reports?: string; sessionName?: string; failNew?: boolean } = {},
): { base: string; sha: string } {
  const base = fresh('release');
  const stage = fresh('stage');
  const src = join(stage, `tmux-${version}`);
  mkdirSync(src);
  writeFileSync(join(src, 'faketmux'), fakeTmuxScript(opts.reports ?? version, opts));
  writeFileSync(
    join(src, 'configure'),
    [
      '#!/bin/sh',
      'prefix=/usr/local',
      'for a in "$@"; do case "$a" in --prefix=*) prefix="${a#--prefix=}" ;; esac; done',
      'if [ -n "$FAKE_CONFIGURE_COUNT" ]; then echo configured >>"$FAKE_CONFIGURE_COUNT"; fi',
      'printf "PREFIX=%s\\n" "$prefix" >Makefile',
      'printf "all:\\n\\t@echo built\\n" >>Makefile',
      'printf "install:\\n\\tmkdir -p \\$(PREFIX)/bin\\n\\tcp faketmux \\$(PREFIX)/bin/tmux\\n\\tchmod 755 \\$(PREFIX)/bin/tmux\\n" >>Makefile',
      '',
    ].join('\n'),
  );
  chmodSync(join(src, 'configure'), 0o755);
  mkdirSync(join(base, version));
  const tarball = join(base, version, `tmux-${version}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', stage, `tmux-${version}`]);
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  return { base: `file://${base}`, sha };
}

describe('build-tmux.sh basics', () => {
  it('is valid bash and executable', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    expect(() => {
      execFileSync('test', ['-x', SCRIPT]);
    }).not.toThrow();
  });

  it('--help prints the usage header and exits 0', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('--check <tmux-bin> [min]');
    expect(r.stdout).not.toContain('set -euo pipefail');
  });

  it.each([
    [[], /missing <version>/],
    [['3.x'], /not a tmux release version/],
    [['3.2a', '3.4'], /unexpected argument/],
    [['--jobs', '0', '3.2a'], /positive integer/],
    [['--sha256', 'abc', '3.2a'], /64 hex/],
    [['--bogus', '3.2a'], /unknown option/],
    [['--prefix'], /needs a directory/],
    [['--prefix', '/', '3.2a'], /refusing to use \/ as the prefix/],
    [['--check'], /needs the path/],
    [['--check', '/bin/sh', 'x.y'], /invalid minimum/],
  ])('usage error %j → exit 2', (args, re) => {
    const r = run(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(re);
  });
});

describe('build-tmux.sh --check (the CI version gate, P-TMUX-42)', () => {
  const bins = fresh('bins');

  it.each([
    ['3.2', '3.2', true],
    ['3.2a', '3.2', true],
    ['3.4', '3.2', true],
    ['3.1c', '3.2', false],
    ['2.9', '3.2', false],
    ['3.5', '3.5a', false],
    ['3.5a', '3.5a', true],
    ['3.6a', '3.5b', true],
    ['10.0', '3.2', true],
    ['next-3.6', '3.2', true],
    ['next-3.1', '3.2', false],
    ['master', '3.6a', true],
    ['openbsd-3.3', '3.2', true],
  ])('tmux %s vs minimum %s → ok=%s', (version, min, ok) => {
    const r = run(['--check', fakeBin(bins, version), min]);
    expect(r.code).toBe(ok ? 0 : 1);
    expect(r.stdout).toContain(`tmux ${version}`);
    if (!ok) expect(r.stderr).toMatch(/older than the supported minimum/);
  });

  it('defaults the minimum to 3.2', () => {
    expect(run(['--check', fakeBin(bins, '3.1')]).code).toBe(1);
    expect(run(['--check', fakeBin(bins, '3.2')]).code).toBe(0);
  });

  it('fails on an unparsable version, a binary that does not run, and a missing binary', () => {
    expect(run(['--check', fakeBin(bins, 'weird')]).stderr).toMatch(/cannot parse/);
    const broken = join(bins, 'broken');
    writeFileSync(broken, '#!/bin/sh\nexit 3\n');
    chmodSync(broken, 0o755);
    expect(run(['--check', broken]).stderr).toMatch(/-V' failed/);
    expect(run(['--check', join(bins, 'nope')]).code).toBe(1);
    expect(run(['--check', 'definitely-not-a-tmux-on-path']).stderr).toMatch(/not on PATH/);
  });

  const real = findRealTmux();
  it.runIf(real !== undefined)('accepts the real tmux of this machine (by path and by name on PATH)', () => {
    const path = real?.path ?? '';
    const byPath = run(['--check', path, '3.2']);
    expect(byPath.code).toBe(0);
    expect(byPath.stdout).toContain(`tmux ${real?.version ?? ''}`);
    const dir = path.slice(0, path.lastIndexOf('/'));
    expect(run(['--check', 'tmux'], { PATH: `${dir}:/usr/bin:/bin` }).code).toBe(0);
  });
});

describe('build-tmux.sh build pipeline (fake release over file://)', () => {
  it('builds, verifies, smoke-tests on a private server, publishes GitHub outputs, then reuses the cache', () => {
    const rel = fakeRelease('3.2a');
    const dir = fresh('build');
    const prefix = join(dir, 'prefix');
    const gh = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_ENV: join(dir, 'env'), GITHUB_PATH: join(dir, 'path') };
    const env = { CCD_TMUX_URL_BASE: rel.base, FAKE_TMUX_LOG: join(dir, 'tmux.log'), FAKE_CONFIGURE_COUNT: join(dir, 'count'), ...gh };

    const first = run(['--prefix', prefix, '--jobs', '2', '3.2a'], env);
    expect(first.stderr).toContain(`tarball sha256 ${rel.sha}`);
    expect(first.code).toBe(0);
    const bin = join(prefix, 'bin', 'tmux');
    expect(first.stdout.trimEnd().split('\n').at(-1)).toBe(bin);
    expect(execFileSync(bin, ['-V'], { encoding: 'utf8' })).toBe('tmux 3.2a\n');
    expect(existsSync(join(prefix, '.ccd-tmux-prefix'))).toBe(true);
    expect(readFileSync(gh.GITHUB_OUTPUT, 'utf8')).toBe(`tmux-bin=${bin}\ntmux-version=3.2a\n`);
    expect(readFileSync(gh.GITHUB_ENV, 'utf8')).toBe(`CCD_TMUX_BIN=${bin}\n`);
    expect(readFileSync(gh.GITHUB_PATH, 'utf8')).toBe(`${join(prefix, 'bin')}\n`);
    expect(readFileSync(env.FAKE_CONFIGURE_COUNT, 'utf8')).toBe('configured\n');

    // The smoke test only ever used a private server with no config, and killed it.
    const calls = readFileSync(env.FAKE_TMUX_LOG, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c).toMatch(/^-L ccd-ci-build-\d+ /);
    expect(calls[0]).toMatch(/-f \/dev\/null new-session -d /);
    expect(calls.at(-1)).toMatch(/kill-server$/);

    // No build directory is left behind in TMPDIR.
    const leftovers = execFileSync('find', [WORK, '-maxdepth', '1', '-name', 'ccd-tmux-build.*'], { encoding: 'utf8' });
    expect(leftovers).toBe('');

    // Second run: cache hit, configure not run again, outputs published again.
    const second = run(['--prefix', prefix, '3.2a'], env);
    expect(second.code).toBe(0);
    expect(second.stderr).toMatch(/cached: .* reports tmux 3\.2a/);
    expect(readFileSync(env.FAKE_CONFIGURE_COUNT, 'utf8')).toBe('configured\n');
    expect(second.stdout.trimEnd().split('\n').at(-1)).toBe(bin);
    expect(readFileSync(gh.GITHUB_ENV, 'utf8')).toBe(`CCD_TMUX_BIN=${bin}\nCCD_TMUX_BIN=${bin}\n`);

    // --force rebuilds even with a good cache.
    const forced = run(['--force', '--prefix', prefix, '3.2a'], env);
    expect(forced.code).toBe(0);
    expect(readFileSync(env.FAKE_CONFIGURE_COUNT, 'utf8')).toBe('configured\nconfigured\n');
  });

  it('rebuilds when the cached prefix holds a different version', () => {
    const dir = fresh('stale');
    const prefix = join(dir, 'prefix');
    const count = join(dir, 'count');
    const old = fakeRelease('3.5a');
    expect(run(['--prefix', prefix, '3.5a'], { CCD_TMUX_URL_BASE: old.base }).code).toBe(0);
    const rel = fakeRelease('3.6a');
    const r = run(['--prefix', prefix, '3.6a'], { CCD_TMUX_URL_BASE: rel.base, FAKE_CONFIGURE_COUNT: count });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/different tmux \(3\.5a\); rebuilding/);
    expect(readFileSync(count, 'utf8')).toBe('configured\n');
    expect(execFileSync(join(prefix, 'bin', 'tmux'), ['-V'], { encoding: 'utf8' })).toBe('tmux 3.6a\n');
  });

  it('uses CCD_TMUX_PREFIX when --prefix is not given', () => {
    const rel = fakeRelease('3.4');
    const prefix = join(fresh('envprefix'), 'p');
    const r = run(['3.4'], { CCD_TMUX_URL_BASE: rel.base, CCD_TMUX_PREFIX: prefix });
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(join(prefix, 'bin', 'tmux'));
  });

  it('accepts a matching --sha256 (any case) and fails on a mismatch before configuring', () => {
    const rel = fakeRelease('3.2a');
    const dir = fresh('sha');
    const count = join(dir, 'count');
    const env = { CCD_TMUX_URL_BASE: rel.base, FAKE_CONFIGURE_COUNT: count };
    expect(run(['--sha256', rel.sha.toUpperCase(), '--prefix', join(dir, 'ok'), '3.2a'], env).code).toBe(0);
    const bad = run(['--sha256', '0'.repeat(64), '--prefix', join(dir, 'bad'), '3.2a'], env);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/sha256 mismatch/);
    expect(readFileSync(count, 'utf8')).toBe('configured\n');
    // CCD_TMUX_SHA256 is the environment form of --sha256.
    const badEnv = run(['--prefix', join(dir, 'bad2'), '3.2a'], { ...env, CCD_TMUX_SHA256: 'f'.repeat(64) });
    expect(badEnv.code).toBe(1);
    expect(badEnv.stderr).toMatch(/sha256 mismatch/);
  });

  it('checks the pinned digest of a known release by default and fails on a mismatch before configuring', () => {
    const rel = fakeRelease('3.2a');
    const dir = fresh('pinned');
    const count = join(dir, 'count');
    const r = run(['--prefix', join(dir, 'p'), '3.2a'], { CCD_TMUX_URL_BASE: rel.base, CCD_TMUX_SHA256: '', FAKE_CONFIGURE_COUNT: count });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('sha256 mismatch');
    expect(r.stderr).toContain('expected 551553a4f82beaa8dadc9256800bcc284d7c000081e47aa6ecbb6ff36eacd05f');
    expect(existsSync(count)).toBe(false);
    expect(existsSync(join(dir, 'p'))).toBe(false);
  });

  it('only prints the digest for a release without a pin, and `--sha256 none` disables a pin', () => {
    const unpinned = fakeRelease('3.4');
    const a = run(['--prefix', join(fresh('unpinned'), 'p'), '3.4'], { CCD_TMUX_URL_BASE: unpinned.base, CCD_TMUX_SHA256: '' });
    expect(a.code).toBe(0);
    expect(a.stderr).toContain(`tarball sha256 ${unpinned.sha}`);
    expect(a.stderr).toMatch(/no pinned or given sha256 for tmux 3\.4/);
    const pinned = fakeRelease('3.6a');
    const b = run(['--sha256', 'none', '--prefix', join(fresh('nonepin'), 'p'), '3.6a'], {
      CCD_TMUX_URL_BASE: pinned.base,
      CCD_TMUX_SHA256: '',
    });
    expect(b.code).toBe(0);
    expect(b.stderr).toContain('sha256 check disabled');
  });

  it('never wipes a non-empty prefix it did not create', () => {
    const rel = fakeRelease('3.2a');
    const prefix = fresh('foreign');
    writeFileSync(join(prefix, 'precious.txt'), 'keep me');
    const r = run(['--prefix', prefix, '3.2a'], { CCD_TMUX_URL_BASE: rel.base });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/refusing to replace non-empty/);
    expect(readFileSync(join(prefix, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('fails when the built binary reports another version', () => {
    const rel = fakeRelease('3.2a', { reports: '3.1c' });
    const r = run(['--prefix', join(fresh('mismatch'), 'p'), '3.2a'], { CCD_TMUX_URL_BASE: rel.base });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/reports tmux 3\.1c, expected 3\.2a/);
  });

  it.each([
    ['the session cannot be created', { failNew: true }],
    ['the server answers with the wrong session', { sessionName: 'other' }],
  ])('fails the smoke test when %s', (_why, opts) => {
    const rel = fakeRelease('3.2a', opts);
    const r = run(['--prefix', join(fresh('smoke'), 'p'), '3.2a'], { CCD_TMUX_URL_BASE: rel.base });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/smoke test failed/);
  });

  it('fails when the download fails or the tarball has the wrong layout', () => {
    const missing = run(['--prefix', join(fresh('dl'), 'p'), '3.2a'], { CCD_TMUX_URL_BASE: `file://${fresh('empty')}` });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/download failed/);

    const base = fresh('layout');
    const stage = fresh('layout-stage');
    mkdirSync(join(stage, 'wrong-dir'));
    mkdirSync(join(base, '3.2a'));
    execFileSync('tar', ['-czf', join(base, '3.2a', 'tmux-3.2a.tar.gz'), '-C', stage, 'wrong-dir']);
    const wrong = run(['--prefix', join(fresh('dl2'), 'p'), '3.2a'], { CCD_TMUX_URL_BASE: `file://${base}` });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/did not contain tmux-3\.2a/);
  });
});

describe.runIf(process.env['CCD_CI_BUILD_TMUX'] === '1')('real build from github.com (CCD_CI_BUILD_TMUX=1)', () => {
  it('builds tmux 3.2a from the release tarball and runs a private server', { timeout: 900_000 }, () => {
    const prefix = join(fresh('real'), 'p');
    const r = spawnSync('bash', [SCRIPT, '--prefix', prefix, '3.2a'], { encoding: 'utf8', timeout: 900_000 });
    expect(r.status, r.stderr.slice(-4000)).toBe(0);
    const bin = join(prefix, 'bin', 'tmux');
    expect(execFileSync(bin, ['-V'], { encoding: 'utf8' })).toBe('tmux 3.2a\n');
    expect(run(['--check', bin, '3.2']).code).toBe(0);
  });
});
