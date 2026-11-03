// WP-05 unit tests: ClaudeBinaryPort — resolve order and shim following (P-LIFE-47), version parsing, auth status with a
// 10 s never-killed timeout (P-LIFE-38).
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRealClock } from '../../../src/platform/clock/real-clock.js';
import {
  AUTH_STATUS_TIMEOUT_MS,
  CLAUDE_EXE_REL,
  createClaudeBinaryPort,
  followToBinary,
  parseAuthStatus,
  parseClaudeVersion,
  shimTarget,
} from '../../../src/platform/process/claude-binary.js';
import { ClaudeAuthStatusUnreadable, ClaudeVersionUnreadable } from '../../../src/platform/process/errors.js';
import { FakeClaudeBinary } from '../../../src/platform/process/fake-claude-binary.js';
import { FakeProcess } from '../../../src/platform/process/fake-process.js';
import { createProcessPort } from '../../../src/platform/process/process-port.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-bin-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function exe(p: string, body = '\0\0native'): string {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

describe('parsers', () => {
  it('parseClaudeVersion', () => {
    expect(parseClaudeVersion('2.1.316 (Claude Code)\n')).toBe('2.1.316');
    expect(parseClaudeVersion('warning\n2.1.317-beta.1 (Claude Code)')).toBe('2.1.317-beta.1');
    expect(parseClaudeVersion('2.1.316')).toBeUndefined();
  });

  it('parseAuthStatus keeps only the preflight fields (no email/org)', () => {
    const out = parseAuthStatus(
      '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","orgId":"x","subscriptionType":"max"}',
    );
    expect(out).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' });
    expect(parseAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false });
    expect(parseAuthStatus('nope')).toBeUndefined();
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toBeUndefined();
    expect(parseAuthStatus('[1]')).toBeUndefined();
  });

  it('shimTarget follows the pnpm/npm shim exec line or its cmd-shim-target comment', () => {
    const pnpm = '#!/bin/sh\nexec "$basedir/../@anthropic-ai/claude-code/bin/claude.exe"   "$@"\nexit $?\n';
    expect(shimTarget(pnpm, '/p/node_modules/.bin')).toBe('/p/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    expect(shimTarget('#!/bin/sh\n# cmd-shim-target=/abs/claude.exe\nexec "$basedir/x"\n', '/b')).toBe('/abs/claude.exe');
    expect(shimTarget('#!/bin/sh\necho hi\n', '/b')).toBeUndefined();
  });
});

describe('resolve order', () => {
  it('option (shim followed) → consumer → package → PATH', async () => {
    const consumer = join(root, 'consumer', 'app', 'sub');
    mkdirSync(consumer, { recursive: true });
    const pkg = join(root, 'pkg', 'dist', 'platform', 'process');
    mkdirSync(pkg, { recursive: true });
    const fp = new FakeProcess();
    const port = () => createClaudeBinaryPort({ process: fp, consumerDir: consumer, packageDir: pkg, extraDirs: [] });

    expect(await port().resolve()).toBeUndefined();

    const onPathReal = exe(join(root, 'cask', 'claude'));
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    symlinkSync(onPathReal, join(binDir, 'claude'));
    fp.binaries.set('claude', join(binDir, 'claude'));
    expect(await port().resolve()).toEqual({ exe: onPathReal, via: 'path' });

    const fromPkg = exe(join(root, 'pkg', CLAUDE_EXE_REL));
    expect(await port().resolve()).toEqual({ exe: fromPkg, via: 'package' });

    const fromConsumer = exe(join(root, 'consumer', CLAUDE_EXE_REL));
    expect(await port().resolve()).toEqual({ exe: fromConsumer, via: 'consumer' });

    // option pointing at a .bin shim → the claude.exe it execs, never the sh shim (P-LIFE-47)
    const shim = join(root, 'consumer', 'node_modules', '.bin', 'claude');
    exe(shim, '#!/bin/sh\nuname -a >/dev/null\nexec "$basedir/../@anthropic-ai/claude-code/bin/claude.exe"   "$@"\n');
    expect(await port().resolve(shim)).toEqual({ exe: fromConsumer, via: 'option' });
    expect(await port().resolve(join(root, 'missing'))).toBeUndefined();
  });

  it('followToBinary rejects non-executables and dangling shims', async () => {
    const f = join(root, 'plain');
    writeFileSync(f, 'x');
    expect(await followToBinary(f)).toBeUndefined();
    const s = exe(join(root, 'shim'), '#!/bin/sh\nexec "$basedir/nothing/claude.exe" "$@"\n');
    expect(await followToBinary(s)).toBeUndefined();
  });
});

describe('version and authStatus', () => {
  it('runs --version (killable) and auth status with 10 s and killOnTimeout:false', async () => {
    const fp = new FakeProcess();
    fp.onExec((c) =>
      c.args[0] === '--version'
        ? { code: 0, signal: null, stdout: '2.1.316 (Claude Code)\n', stderr: '', timedOut: false }
        : {
            code: 0,
            signal: null,
            stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}',
            stderr: '',
            timedOut: false,
          },
    );
    const port = createClaudeBinaryPort({ process: fp });
    expect(await port.version('/c/claude.exe', { HOME: '/h' })).toBe('2.1.316');
    expect(await port.authStatus('/c/claude.exe', { HOME: '/h' })).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
    });
    const [v, a] = fp.execCalls;
    expect(v?.killOnTimeout).toBe(true);
    expect(a?.args).toEqual(['auth', 'status', '--json']);
    expect(a?.timeoutMs).toBe(AUTH_STATUS_TIMEOUT_MS);
    expect(a?.killOnTimeout).toBe(false);
    expect(a?.env).toEqual({ HOME: '/h' });
  });

  it('timeouts and garbage become typed errors', async () => {
    const fp = new FakeProcess();
    fp.onExec(() => ({ code: null, signal: null, stdout: '', stderr: '', timedOut: true }));
    const port = createClaudeBinaryPort({ process: fp });
    await expect(port.authStatus('/c', {})).rejects.toMatchObject({ name: 'ClaudeAuthStatusUnreadable', reason: 'timeout' });
    await expect(port.version('/c', {})).rejects.toBeInstanceOf(ClaudeVersionUnreadable);
    fp.onExec(() => ({ code: 1, signal: null, stdout: 'oops', stderr: '', timedOut: false }));
    await expect(port.authStatus('/c', {})).rejects.toBeInstanceOf(ClaudeAuthStatusUnreadable);
  });

  it('real exec: a fake claude.exe script answers --version', async () => {
    const script = exe(
      join(root, 'claude.exe'),
      `#!${process.execPath}\nconsole.log(process.argv[2]==='--version' ? '2.1.316 (Claude Code)' : '{"loggedIn":false}')\n`,
    );
    const port = createClaudeBinaryPort({ process: createProcessPort({ clock: createRealClock() }) });
    expect(await port.version(script, { PATH: '/usr/bin:/bin' })).toBe('2.1.316');
    expect(await port.authStatus(script, { PATH: '/usr/bin:/bin' })).toEqual({ loggedIn: false });
  });

  it('FakeClaudeBinary scripts mismatch / logged-out / provider cases', async () => {
    const f = new FakeClaudeBinary({ version: '2.1.317', auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' } });
    expect(await f.version('x', {})).toBe('2.1.317');
    expect((await f.authStatus('x', {})).apiProvider).toBe('bedrock');
    expect(await new FakeClaudeBinary({ exe: undefined }).resolve()).toBeUndefined();
    await expect(new FakeClaudeBinary({ auth: 'timeout' }).authStatus('x', {})).rejects.toMatchObject({ reason: 'timeout' });
  });
});
