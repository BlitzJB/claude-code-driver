import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  assertSafePath,
  BOOTSTRAP_ATTEMPTS,
  BOOTSTRAP_RETRY_MS,
  cronLine,
  installLifecheck,
  InstallError,
  JOB_PATH,
  LAUNCHD_LABEL,
  lifecheckPaths,
  lifecheckStatus,
  lifecheckTargetText,
  parseLaunchctlPrint,
  parseLifecheckJson,
  parseLifecheckTarget,
  plistText,
  shimText,
  systemdUnits,
  uninstallLifecheck,
} from '../../../src/cli/launchd.js';
import { memInstall, NOW } from './helpers.js';

const SD = '/Users/u/.local/state/claude-code-driver';
const HOME = '/Users/u';
const TOKENISH = /[0-9a-f]{32,}|X-CCD-Token|Authorization|sk-ant-/i;

describe('plist text (P-SEC-25, P-REV-32)', () => {
  const text = plistText({ stateDir: SD, homeDir: HOME });
  it('has the §3.12 keys', () => {
    expect(text).toContain(`<key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>`);
    expect(text).toContain(`<array>\n    <string>/bin/sh</string>\n    <string>${SD}/bin/ccd-lifecheck</string>\n  </array>`);
    expect(text).toContain('<key>StartInterval</key>\n  <integer>300</integer>');
    expect(text).toContain(`<key>PATH</key>\n    <string>${JOB_PATH}</string>`);
    expect(text).toContain('<key>LC_ALL</key>\n    <string>en_US.UTF-8</string>');
    expect(text).toContain(`<key>StandardOutPath</key>\n  <string>${SD}/lifecheck.out.log</string>`);
    expect(text).toContain(`<key>StandardErrorPath</key>\n  <string>${SD}/lifecheck.err.log</string>`);
  });
  it('names no node, no dist path and no token', () => {
    expect(text).not.toMatch(/node_modules|dist\/cli|main\.js|\.nvm|\/node\b/);
    expect(text).not.toMatch(TOKENISH);
    const strings = [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(strings.filter((s) => s?.startsWith('/'))).toEqual([
      '/bin/sh',
      `${SD}/bin/ccd-lifecheck`,
      JOB_PATH,
      `${SD}/lifecheck.out.log`,
      `${SD}/lifecheck.err.log`,
    ]);
  });
  it('is well-formed XML per plutil when available', () => {
    if (!existsSync('/usr/bin/plutil')) {
      expect(text.startsWith('<?xml')).toBe(true);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'ccd-plist-'));
    try {
      const p = join(dir, 'x.plist');
      writeFileSync(p, plistText({ stateDir: '/Users/u/Library/Application Support/ccd', homeDir: HOME }));
      const r = spawnSync('/usr/bin/plutil', ['-lint', p], { encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const j = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p], { encoding: 'utf8' })) as Record<
        string,
        unknown
      >;
      expect(j['ProgramArguments']).toEqual(['/bin/sh', '/Users/u/Library/Application Support/ccd/bin/ccd-lifecheck']);
      expect(j['StartInterval']).toBe(300);
      expect(j['RunAtLoad']).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('linux text', () => {
  it('systemd units and cron line hold only paths', () => {
    const u = systemdUnits({ stateDir: SD, homeDir: HOME });
    expect(u.service).toContain(`ExecStart=/bin/sh "${SD}/bin/ccd-lifecheck"`);
    expect(u.service).toContain('Environment="LC_ALL=en_US.UTF-8"');
    expect(u.service).toContain('Type=oneshot');
    expect(u.timer).toContain('OnUnitActiveSec=5min');
    expect(u.timer).toContain('WantedBy=timers.target');
    expect(cronLine({ stateDir: SD, homeDir: HOME })).toBe(`*/5 * * * * /bin/sh '${SD}/bin/ccd-lifecheck'`);
    expect(u.service + u.timer).not.toMatch(TOKENISH);
  });
});

describe('assertSafePath', () => {
  it.each(['relative/x', '/a/"b', "/a/'b", '/a/$HOME', '/a/`x`', '/a/%h', '/a\\b', '/a/\nb', '/a/../b', '/a/..', '/a/<b>', '/a&b'])(
    'rejects %j',
    (p) => {
      expect(() => assertSafePath(p, 'x')).toThrow(InstallError);
    },
  );
  it('accepts plain paths with spaces', () => {
    expect(assertSafePath('/Users/u/Library/Application Support/c-t_m@1+2,3', 'x')).toBe(
      '/Users/u/Library/Application Support/c-t_m@1+2,3',
    );
  });
  it('lifecheckPaths strips trailing slashes', () => {
    expect(lifecheckPaths(`${SD}/`, `${HOME}/`)).toMatchObject({
      shim: `${SD}/bin/ccd-lifecheck`,
      plist: `${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    });
  });
});

describe('lifecheck-target.json', () => {
  it('round-trips and accepts the CCD_NODE / nodePath spellings', () => {
    const t = lifecheckTargetText({ distPath: '/d/main.js', nodePath: '/n/node', libVersion: '1', writtenAt: NOW });
    expect(parseLifecheckTarget(t)).toEqual({ distPath: '/d/main.js', node: '/n/node' });
    expect(parseLifecheckTarget('{"distPath":"/d","CCD_NODE":"/x"}')).toEqual({ distPath: '/d', node: '/x' });
    expect(parseLifecheckTarget('{"nodePath":"/y"}')).toEqual({ node: '/y' });
    expect(parseLifecheckTarget('{"node":"/z"}')).toEqual({ node: '/z' });
    expect(parseLifecheckTarget('nope')).toBeUndefined();
    expect(parseLifecheckTarget(undefined)).toBeUndefined();
    expect(() => lifecheckTargetText({ distPath: '/d/"x', nodePath: '/n', libVersion: '1', writtenAt: 0 })).toThrow(InstallError);
  });
});

// ------------------------------------------------------------------------------------------------- the shim, run by /bin/sh

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fakeNode(path: string, major: number, exec = true): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${major}; exit 0; fi\nprintf '%s\\n' "$0" "$@" > "$CCD_TEST_OUT"\n`);
  chmodSync(path, exec ? 0o755 : 0o644);
}

interface ShimEnv {
  root: string;
  stateDir: string;
  home: string;
  shim: string;
  out: string;
  dist: string;
}

function setup(
  o: { target?: Record<string, string>; spaceInStateDir?: boolean; isolatePath?: boolean; distExists?: boolean } = {},
): ShimEnv {
  const root = mkdtempSync(join(tmpdir(), 'ccd-shim-'));
  roots.push(root);
  const stateDir = join(root, o.spaceInStateDir ? 'state dir' : 'state');
  const home = join(root, 'home');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const dist = join(root, 'pkg', 'dist', 'cli', 'main.js');
  if (o.distExists !== false) {
    mkdirSync(join(dist, '..'), { recursive: true });
    writeFileSync(dist, '');
  }
  let text = shimText({ stateDir, homeDir: home, libVersion: 't' });
  // Hermetic: the job PATH would find a real node in /opt/homebrew/bin; tests of the later tiers replace it.
  if (o.isolatePath) text = text.replace(`PATH=${JOB_PATH}`, `PATH=${join(root, 'nobin')}:/usr/bin:/bin`);
  const shim = join(stateDir, 'bin', 'ccd-lifecheck');
  mkdirSync(join(shim, '..'), { recursive: true });
  writeFileSync(shim, text, { mode: 0o700 });
  if (o.target) writeFileSync(join(stateDir, 'lifecheck-target.json'), JSON.stringify({ distPath: dist, ...o.target }, null, 2));
  return { root, stateDir, home, shim, out: join(root, 'out.txt'), dist };
}

function runShim(
  e: ShimEnv,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
): { status: number | null; stderr: string; ran?: string[] } {
  const env: Record<string, string> = { HOME: e.home, CCD_TEST_OUT: e.out, PATH: '/usr/bin:/bin', ...extraEnv };
  const r = spawnSync('/bin/sh', [e.shim, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  const res: { status: number | null; stderr: string; ran?: string[] } = { status: r.status, stderr: r.stderr };
  if (existsSync(e.out)) res.ran = readFileSync(e.out, 'utf8').trimEnd().split('\n');
  return res;
}

const usrBinHasNode = existsSync('/usr/bin/node') || existsSync('/bin/node');

describe('shim (§3.12 resolution order, P-REV-32)', () => {
  it('is valid sh', () => {
    const e = setup();
    expect(spawnSync('/bin/sh', ['-n', e.shim]).status).toBe(0);
    expect(shimText({ stateDir: SD, homeDir: HOME, libVersion: '1' })).not.toMatch(TOKENISH);
  });

  it('tier 1: the node recorded in lifecheck-target.json; execs dist main.js lifecheck --state-dir', () => {
    const e = setup({ spaceInStateDir: true });
    const node = join(e.root, 'n1', 'node');
    fakeNode(node, 22);
    writeFileSync(
      join(e.stateDir, 'lifecheck-target.json'),
      lifecheckTargetText({ distPath: e.dist, nodePath: node, libVersion: '1', writtenAt: 0 }),
    );
    const r = runShim(e, {}, ['--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.ran).toEqual([node, e.dist, 'lifecheck', '--state-dir', e.stateDir, '--json']);
  });

  it('tier 1 accepts the CCD_NODE key; a too-old recorded node is skipped', () => {
    const e = setup({ isolatePath: true });
    const old = join(e.root, 'old', 'node');
    fakeNode(old, 18);
    const good = join(e.root, 'good', 'node');
    fakeNode(good, 20);
    // compact one-line JSON, as session/registry-store.ts writes it
    writeFileSync(
      join(e.stateDir, 'lifecheck-target.json'),
      JSON.stringify({ distPath: e.dist, nodePath: old, CCD_NODE: good, libVersion: '1', writtenAt: 1 }),
    );
    expect(runShim(e).ran?.[0]).toBe(good);
  });

  it.skipIf(usrBinHasNode)('tier 3: newest ~/.nvm node >= 20 (skips v18 and non-executable ones)', () => {
    const e = setup({ isolatePath: true, target: {} });
    const nv = join(e.home, '.nvm', 'versions', 'node');
    fakeNode(join(nv, 'v18.20.5', 'bin', 'node'), 18);
    fakeNode(join(nv, 'v20.5.0', 'bin', 'node'), 20);
    fakeNode(join(nv, 'v20.10.1', 'bin', 'node'), 20);
    fakeNode(join(nv, 'v22.23.2', 'bin', 'node'), 22, false);
    fakeNode(join(nv, 'v9.0.0', 'bin', 'node'), 9);
    mkdirSync(join(nv, 'not-a-version'), { recursive: true });
    const r = runShim(e);
    expect(r.status, r.stderr).toBe(0);
    expect(r.ran?.[0]).toBe(join(nv, 'v20.10.1', 'bin', 'node'));
  });

  it.skipIf(usrBinHasNode)('tier 2: `command -v node` on the fixed PATH beats nvm', () => {
    const e = setup({ target: {} });
    // replace the fixed PATH with one whose first dir holds a fake node
    const bin = join(e.root, 'pathbin');
    fakeNode(join(bin, 'node'), 21);
    writeFileSync(e.shim, readFileSync(e.shim, 'utf8').replace(`PATH=${JOB_PATH}`, `PATH=${bin}:/usr/bin:/bin`));
    fakeNode(join(e.home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'node'), 22);
    expect(runShim(e).ran?.[0]).toBe(join(bin, 'node'));
  });

  it.skipIf(usrBinHasNode)('no node anywhere → lastRunOk:false in lifecheck.json (0600), exit 1', () => {
    const e = setup({ isolatePath: true, target: {} });
    const r = runShim(e);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('node-not-found');
    const p = join(e.stateDir, 'lifecheck.json');
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    expect(j).toMatchObject({ lastRunOk: false, error: 'node-not-found', via: 'shim' });
    expect(typeof j['ranAt']).toBe('number');
    expect(Math.abs((j['ranAt'] as number) - Date.now())).toBeLessThan(120_000);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(parseLifecheckJson(readFileSync(p, 'utf8'))).toMatchObject({ lastRunOk: false, error: 'node-not-found' });
  });

  it.skipIf(usrBinHasNode)('HOME unset (cron/launchd edge): the baked home dir is used for the nvm tier, spaces included', () => {
    const e = setup({ isolatePath: true, target: {} });
    // a home dir with a space, baked into the shim as the ${HOME:-...} fallback
    const home = join(e.root, 'my home');
    const text = shimText({ stateDir: e.stateDir, homeDir: home, libVersion: 't' }).replace(
      `PATH=${JOB_PATH}`,
      `PATH=${join(e.root, 'nobin')}:/usr/bin:/bin`,
    );
    expect(text).not.toMatch(/\$\{HOME:-'/); // no literal quotes inside the expansion (sh keeps them verbatim)
    writeFileSync(e.shim, text, { mode: 0o700 });
    const node = join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'node');
    fakeNode(node, 22);
    const r = spawnSync('/usr/bin/env', ['-i', `CCD_TEST_OUT=${e.out}`, 'PATH=/usr/bin:/bin', '/bin/sh', e.shim], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(e.out, 'utf8').trimEnd().split('\n')[0]).toBe(node);
  });

  it('dist path missing → distPath-missing; no target → no-distPath', () => {
    const e = setup({ distExists: false });
    const node = join(e.root, 'n', 'node');
    fakeNode(node, 22);
    writeFileSync(join(e.stateDir, 'lifecheck-target.json'), JSON.stringify({ distPath: e.dist, node }));
    const r = runShim(e);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('distPath-missing');
    expect(r.ran).toBeUndefined();

    const e2 = setup();
    rmSync(join(e2.stateDir, 'lifecheck-target.json'), { force: true });
    const r2 = runShim(e2, { CCD_NODE: node });
    expect(r2.stderr).toContain('no-distPath');
  });
});

// ------------------------------------------------------------------------------------------------- install / status

describe('installLifecheck', () => {
  it('darwin: writes target 0600, shim 0700, logs 0600, plist 0644; bootout then bootstrap gui/$UID', async () => {
    const { host, fs } = memInstall();
    const r = await installLifecheck(host, '1.2.3');
    expect(r.exitCode).toBe(0);
    const p = lifecheckPaths(host.stateDir, host.homeDir);
    expect(fs.files.get(p.target)?.mode).toBe(0o600);
    expect(parseLifecheckTarget(fs.files.get(p.target)?.text)).toEqual({ distPath: host.distPath, node: host.nodePath });
    expect(fs.files.get(p.shim)?.mode).toBe(0o700);
    expect(fs.files.get(p.shim)?.text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(fs.files.get(p.outLog)?.mode).toBe(0o600);
    expect(fs.files.get(p.errLog)?.mode).toBe(0o600);
    expect(fs.files.get(p.plist)?.mode).toBe(0o644);
    expect(fs.files.get(p.plist)?.text).not.toContain(host.distPath);
    expect(fs.runs).toEqual([
      { file: 'launchctl', args: ['bootout', `gui/501/${LAUNCHD_LABEL}`] },
      { file: 'launchctl', args: ['bootstrap', 'gui/501', p.plist] },
    ]);
  });

  it('darwin: a failed bootstrap is exit 1 with launchctl stderr', async () => {
    const { host } = memInstall(
      {},
      {
        runResult: (_f, a) =>
          a[0] === 'bootstrap'
            ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' }
            : { code: 0, stdout: '', stderr: '' },
      },
    );
    const r = await installLifecheck(host, '1');
    expect(r.exitCode).toBe(1);
    expect(r.lines.at(-1)).toContain('Input/output error');
  });

  it('darwin re-install: bootstrap right after a successful bootout is retried (launchctl EIO race)', async () => {
    let bootstraps = 0;
    const { host, fs } = memInstall(
      {},
      {
        runResult: (_f, a) => {
          if (a[0] !== 'bootstrap') return { code: 0, stdout: '', stderr: '' };
          bootstraps++;
          return bootstraps < 3
            ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' }
            : { code: 0, stdout: '', stderr: '' };
        },
      },
    );
    const r = await installLifecheck(host, '1');
    expect(r.exitCode).toBe(0);
    expect(bootstraps).toBe(3);
    expect(fs.sleeps).toEqual([BOOTSTRAP_RETRY_MS, BOOTSTRAP_RETRY_MS]);
  });

  it('darwin: retries are bounded; a first install (nothing to boot out) does not retry', async () => {
    const fail5 = { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' };
    const a = memInstall({}, { runResult: (_f, x) => (x[0] === 'bootstrap' ? fail5 : { code: 0, stdout: '', stderr: '' }) });
    expect((await installLifecheck(a.host, '1')).exitCode).toBe(1);
    expect(a.fs.runs.filter((x) => x.args[0] === 'bootstrap')).toHaveLength(BOOTSTRAP_ATTEMPTS);
    const b = memInstall({}, { runResult: (_f, x) => (x[0] === 'bootstrap' ? fail5 : { code: 3, stdout: '', stderr: 'No such process' }) });
    expect((await installLifecheck(b.host, '1')).exitCode).toBe(1);
    expect(b.fs.runs.filter((x) => x.args[0] === 'bootstrap')).toHaveLength(1);
    expect(b.fs.sleeps).toEqual([]);
  });

  it('linux: writes the shim and prints systemd + cron text, runs nothing', async () => {
    const { host, fs } = memInstall({ platform: 'linux', homeDir: '/home/u', stateDir: '/home/u/.local/state/claude-code-driver' });
    const r = await installLifecheck(host, '1');
    expect(r.exitCode).toBe(0);
    expect(fs.runs).toEqual([]);
    const text = r.lines.join('\n');
    expect(text).toContain('ExecStart=/bin/sh "/home/u/.local/state/claude-code-driver/bin/ccd-lifecheck"');
    expect(text).toContain("*/5 * * * * /bin/sh '/home/u/.local/state/claude-code-driver/bin/ccd-lifecheck'");
    expect([...fs.files.keys()].some((k) => k.endsWith('.plist'))).toBe(false);
  });

  it('other platforms are refused; unsafe state dirs throw InstallError', async () => {
    expect((await installLifecheck(memInstall({ platform: 'other' }).host, '1')).exitCode).toBe(1);
    await expect(installLifecheck(memInstall({ stateDir: '/x/$(rm -rf)' }).host, '1')).rejects.toThrow(InstallError);
  });
});

describe('uninstallLifecheck', () => {
  it('darwin: bootout + remove plist and shim', async () => {
    const { host, fs } = memInstall();
    await installLifecheck(host, '1');
    fs.runs.length = 0;
    const r = await uninstallLifecheck(host);
    const p = lifecheckPaths(host.stateDir, host.homeDir);
    expect(r.exitCode).toBe(0);
    expect(fs.runs).toEqual([{ file: 'launchctl', args: ['bootout', `gui/501/${LAUNCHD_LABEL}`] }]);
    expect(fs.files.has(p.plist)).toBe(false);
    expect(fs.files.has(p.shim)).toBe(false);
  });
  it('linux: removes the shim and prints how to disable the timer', async () => {
    const { host, fs } = memInstall({ platform: 'linux' });
    await installLifecheck(host, '1');
    const r = await uninstallLifecheck(host);
    expect(r.lines.join('\n')).toContain('systemctl --user disable --now ccd-lifecheck.timer');
    expect(fs.files.has(lifecheckPaths(host.stateDir, host.homeDir).shim)).toBe(false);
  });
});

describe('lifecheckStatus probe', () => {
  const PRINT = `gui/501/com.claude-code-driver.lifecheck = {\n\tactive count = 0\n\tstate = not running\n\tlast exit code = 0\n}\n`;
  it('parses launchctl print', () => {
    expect(parseLaunchctlPrint(PRINT)).toEqual({ state: 'not running', lastExitCode: '0' });
    expect(parseLaunchctlPrint('garbage')).toEqual({});
  });
  it('healthy after install and a recent run', async () => {
    const { host, fs } = memInstall(
      {},
      { runResult: (_f, a) => (a[0] === 'print' ? { code: 0, stdout: PRINT, stderr: '' } : { code: 0, stdout: '', stderr: '' }) },
    );
    await installLifecheck(host, '1');
    fs.files.set(host.distPath, { text: '', mode: 0o644 });
    fs.files.set(lifecheckPaths(host.stateDir, host.homeDir).report, {
      text: JSON.stringify({ ranAt: NOW - 30_000, lastRunOk: true }),
      mode: 0o600,
    });
    const s = await lifecheckStatus(host);
    expect(s).toMatchObject({
      health: 'ok',
      exitCode: 0,
      installed: true,
      launchd: { loaded: true, state: 'not running', lastExitCode: '0' },
      distPathExists: true,
    });
  });
  it('not loaded and stale', async () => {
    const { host, fs } = memInstall({}, { runResult: () => ({ code: 113, stdout: '', stderr: 'Could not find service' }) });
    await installLifecheck(host, '1');
    fs.files.set(lifecheckPaths(host.stateDir, host.homeDir).report, {
      text: JSON.stringify({ ranAt: NOW - 3_600_000, lastRunOk: true }),
      mode: 0o600,
    });
    const s = await lifecheckStatus(host);
    expect(s.health).toBe('stale');
    expect(s.exitCode).toBe(2);
    expect(s.launchd).toEqual({ loaded: false });
  });
  it('nothing installed', async () => {
    const s = await lifecheckStatus(memInstall({}, { runResult: () => ({ code: 113, stdout: '', stderr: '' }) }).host);
    expect(s).toMatchObject({ health: 'notInstalled', exitCode: 3, installed: false });
  });
  it('a corrupt lifecheck.json counts as a failed run', () => {
    expect(parseLifecheckJson('{')).toEqual({ lastRunOk: false, error: 'lifecheck.json is not valid JSON' });
    expect(parseLifecheckJson('{"ranAt":1,"lastRunOk":true,"errors":["x"]}')).toEqual({ ranAt: 1, lastRunOk: true, error: 'x' });
  });
});
