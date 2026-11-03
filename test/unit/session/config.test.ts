// session/config.ts — resolveConfig + DEFAULTS (DESIGN.md §2.11, §3.1 step 1, §3.3; P-API-19, P-TMUX-56, P-REV-03,
// P-REV-04, P-REV-42).
import { describe, expect, it } from 'vitest';
import { isCcdError } from '../../../src/model/errors.js';
import type { SessionSpec } from '../../../src/model/spec.js';
import { FakeEnv } from '../../../src/platform/env/fake-env.js';
import { DEFAULT_TEST_CORE_CONFIG } from '../../../src/testing/core-config.js';
import {
  COLS_MAX,
  COLS_MIN,
  DEFAULTS,
  FORBIDDEN_ENV_SET,
  resolveConfig,
  resolveConfigPure,
  validateExtraArgs,
} from '../../../src/session/config.js';
import type { ConfigFacts } from '../../../src/session/config.js';
import { ALLOWED_EXTRA_FLAGS, validateExtraArgs as argvBuilderValidate } from '../../../src/session/argv-builder.js';
import type { SessionKey } from '../../../src/model/ids.js';

const facts = (over: Partial<ConfigFacts> = {}): ConfigFacts => ({
  cwdRealpath: '/private/work/p',
  sessionKey: 's0000abcd' as SessionKey,
  freshSessionId: '11111111-2222-4333-8444-555555555555',
  env: {},
  homeDir: '/home/u',
  platform: 'darwin',
  tmpDir: '/var/folders/xx/T',
  uid: 501,
  ...over,
});
const base: SessionSpec = { cwd: '/work/p', permissions: { policy: 'handler' } };
const spec = (over: Record<string, unknown> = {}): SessionSpec => ({ ...base, ...over });

function errOf(f: () => unknown): { code: string; details: Record<string, unknown> } {
  try {
    f();
  } catch (e) {
    if (!isCcdError(e)) throw e;
    return { code: e.code, details: e.details ?? {} };
  }
  throw new Error('expected a CcdError');
}

describe('resolveConfigPure: defaults (P-API-19: one table)', () => {
  it('applies every default from DEFAULTS', () => {
    const c = resolveConfigPure(base, facts());
    expect(c.sessionKey).toBe('s0000abcd');
    expect(c.cwd).toBe('/work/p');
    expect(c.cwdRealpath).toBe('/private/work/p');
    expect(c.claudeSessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(c.permissionMode).toBe('default');
    expect(c.tmux).toEqual({ cols: 250, rows: 80, historyLimit: 10_000 });
    expect(c.hooks.transport).toBe('auto');
    expect(c.hooks.permissionHookTimeoutS).toBe(Math.ceil(120_000 / 1000) + 30); // D-37
    expect(c.trust).toEqual({ mode: 'require', acceptRisks: false });
    expect(c.network).toBe(false);
    expect(c.security).toEqual({ denyTmuxInBash: false, crossSessionInbound: 'refuse', mcp: 'inherit', onTamper: 'alert' });
    expect(c.debug).toEqual({
      raw: 'meta',
      retainEvents: 10_000,
      claudeDebugFile: false,
      keepClaudeDebugFile: false,
      captureLimitFixtures: true,
    });
    expect(c.lifecycle.closeGraceMs).toBe(12_000);
    expect(c.lifecycle.killAfterMs).toBe(3000);
    expect(c.lifecycle.stateDir).toBe('/home/u/.local/state/claude-code-driver');
    expect(c.lifecycle.runtimeRoot).toBe('/var/folders/xx/T');
    expect(c.claude.configDir).toBe('/home/u/.claude');
    expect(c.claude.expectVersion).toBe('2.1.316');
    expect(c.core.selfTest).toBe('once');
    expect(c.resume).toBeUndefined();
  });

  it('CoreConfig derived from DEFAULTS equals the testing kit default (single source of truth)', () => {
    const c = resolveConfigPure(base, facts());
    expect(c.core).toEqual(DEFAULT_TEST_CORE_CONFIG);
  });

  it('DEFAULTS is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.timeouts)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.commands.allow)).toBe(true);
  });

  it('a resolved config is a fresh copy (mutating it never changes DEFAULTS)', () => {
    const c = resolveConfigPure(base, facts());
    c.core.timeouts.submitAckMs = 1;
    c.core.commands.allow.push('/x');
    expect(DEFAULTS.timeouts.submitAckMs).toBe(3000);
    expect(DEFAULTS.commands.allow).not.toContain('/x');
  });

  it('respects an inherited CLAUDE_CONFIG_DIR and XDG dirs, never introduces one', () => {
    const c = resolveConfigPure(
      base,
      facts({ env: { CLAUDE_CONFIG_DIR: '/cfg', XDG_STATE_HOME: '/xs', XDG_RUNTIME_DIR: '/run/user/1' }, platform: 'linux' }),
    );
    expect(c.claude.configDir).toBe('/cfg');
    expect(c.lifecycle.stateDir).toBe('/xs/claude-code-driver');
    expect(c.lifecycle.runtimeRoot).toBe('/run/user/1');
    const d = resolveConfigPure(base, facts({ platform: 'linux' }));
    expect(d.lifecycle.runtimeRoot).toBe('/tmp/ccd-501');
    const o = resolveConfigPure(base, facts({ platform: 'other', env: { XDG_RUNTIME_DIR: 'relative' } }));
    expect(o.lifecycle.runtimeRoot).toBe('/tmp/ccd-501');
  });

  it('maps the spec onto ResolvedConfig and CoreConfig', () => {
    const c = resolveConfigPure(
      spec({
        model: 'opus',
        effort: 'high',
        permissionMode: 'plan',
        permissions: { policy: 'allowRead', timeoutMs: 30_000, onTimeout: 'tui', screenAllow: true },
        input: { method: 'pasteChunks', whenBusy: 'reject', maxPromptBytes: 5000, mentions: 'reject' },
        hooks: { transport: 'unix', preToolUse: false, messageDisplay: false, postToolBatch: true },
        network: { allowPrivate: true },
        usageLimit: { autoResume: false, resumePrompt: 'go on', jitterMinMs: 0, jitterMaxMs: 10, maxRearms: 5 },
        selfTest: 'always',
        timeouts: { submitAckMs: 4000 },
        debug: { tracePath: '/t/x.ccd.jsonl', raw: 'full', retainEvents: 16, dumpDir: '/t/d' },
        tmux: { cols: 300, rows: 60, bin: '/opt/tmux' },
        claude: { bin: '/opt/claude.exe', expectVersion: 'any' },
        env: { inherit: ['FOO', 'LC_*'], set: { A: 'b' } },
        security: { onTamper: 'interrupt', mcp: 'strict' },
        lifecycle: { closeGraceMs: 5000, stateDir: '/s', runtimeRoot: '/r' },
      }),
      facts(),
    );
    expect(c.model).toBe('opus');
    expect(c.effort).toBe('high');
    expect(c.permissionMode).toBe('plan');
    expect(c.core.permissions).toMatchObject({ policy: 'allowRead', timeoutMs: 30_000, onTimeout: 'tui', screenAllow: true });
    expect(c.hooks.permissionHookTimeoutS).toBe(60);
    expect(c.core.input).toMatchObject({ method: 'pasteChunks', whenBusyDefault: 'reject', maxPromptBytes: 5000, mentions: 'reject' });
    expect(c.core.channels).toMatchObject({ network: true, preToolUse: false, messageDisplay: false });
    expect(c.hooks).toMatchObject({ transport: 'unix', postToolBatch: true });
    expect(c.network).toEqual({ faults: false, allowPrivate: true, allowPorts: [443] });
    expect(c.core.usage).toMatchObject({ autoResume: false, resumePrompt: 'go on', jitterMinMs: 0, jitterMaxMs: 10, maxRearms: 5 });
    expect(c.core.selfTest).toBe('always');
    expect(c.core.timeouts.submitAckMs).toBe(4000);
    expect(c.core.timeouts.settleMs).toBe(100);
    expect(c.debug).toMatchObject({ tracePath: '/t/x.ccd.jsonl', raw: 'full', retainEvents: 16, dumpDir: '/t/d' });
    expect(c.tmux).toEqual({ cols: 300, rows: 60, historyLimit: 10_000, bin: '/opt/tmux' });
    expect(c.claude).toMatchObject({ bin: '/opt/claude.exe', expectVersion: 'any' });
    expect(c.env).toEqual({ inherit: ['FOO', 'LC_*'], set: { A: 'b' }, scrubSubprocessEnv: false });
    expect(c.core.security.onTamper).toBe('interrupt');
    expect(c.security.mcp).toBe('strict');
    expect(c.lifecycle).toMatchObject({ closeGraceMs: 5000, stateDir: '/s', runtimeRoot: '/r' });
  });

  it('resume: the Claude session id is the resumed id', () => {
    const c = resolveConfigPure(spec({ resume: 'abcd-1234' }), facts());
    expect(c.resume).toBe('abcd-1234');
    expect(c.claudeSessionId).toBe('abcd-1234');
    const d = resolveConfigPure(spec({ sessionId: '99999999-2222-4333-8444-555555555555' }), facts());
    expect(d.claudeSessionId).toBe('99999999-2222-4333-8444-555555555555');
  });
});

describe('resolveConfigPure: strict validation', () => {
  it('unknown key anywhere → E_CONFIG_INVALID{reason:unknownKey, path}', () => {
    expect(errOf(() => resolveConfigPure(spec({ colour: 'x' }), facts()))).toEqual({
      code: 'E_CONFIG_INVALID',
      details: { reason: 'unknownKey', path: 'colour' },
    });
    expect(errOf(() => resolveConfigPure(spec({ tmux: { width: 1 } }), facts())).details).toEqual({
      reason: 'unknownKey',
      path: 'tmux.width',
    });
    expect(errOf(() => resolveConfigPure(spec({ timeouts: { nope: 1 } }), facts())).details).toEqual({
      reason: 'unknownKey',
      path: 'timeouts.nope',
    });
  });

  it('permissions missing → permissionsRequired (P-REV-42); policy missing → required', () => {
    expect(errOf(() => resolveConfigPure({ cwd: '/w' } as SessionSpec, facts())).details).toEqual({
      reason: 'permissionsRequired',
      path: 'permissions',
    });
    expect(errOf(() => resolveConfigPure(spec({ permissions: {} }), facts())).details).toEqual({
      reason: 'required',
      path: 'permissions.policy',
    });
    expect(errOf(() => resolveConfigPure(spec({ permissions: { policy: 'allowAll' } }), facts())).details).toMatchObject({
      reason: 'notAllowed',
      path: 'permissions.policy',
    });
  });

  it.each([
    [COLS_MIN - 1, 'outOfRange'],
    [COLS_MAX + 1, 'outOfRange'],
    [200.5, 'notInteger'],
    ['250', 'notInteger'],
  ])('tmux.cols %s → %s (P-TMUX-56: 120…1000)', (cols, reason) => {
    expect(errOf(() => resolveConfigPure(spec({ tmux: { cols } }), facts())).details).toMatchObject({ reason, path: 'tmux.cols' });
  });

  it('accepts the cols boundaries', () => {
    expect(resolveConfigPure(spec({ tmux: { cols: COLS_MIN } }), facts()).tmux.cols).toBe(COLS_MIN);
    expect(resolveConfigPure(spec({ tmux: { cols: COLS_MAX } }), facts()).tmux.cols).toBe(COLS_MAX);
  });

  it('type errors: strings, booleans, paths, enums, records', () => {
    expect(errOf(() => resolveConfigPure(spec({ cwd: 'rel/path' }), facts())).details).toEqual({ reason: 'notAbsolute', path: 'cwd' });
    expect(errOf(() => resolveConfigPure(spec({ trust: { acceptRisks: 'yes' } }), facts())).details).toEqual({
      reason: 'notBoolean',
      path: 'trust.acceptRisks',
    });
    expect(errOf(() => resolveConfigPure(spec({ model: 'has space' }), facts())).details).toEqual({ reason: 'badFormat', path: 'model' });
    expect(errOf(() => resolveConfigPure(spec({ env: { set: { 'BAD-NAME': 'x' } } }), facts())).details).toEqual({
      reason: 'badEnvName',
      path: 'env.set.BAD-NAME',
    });
    expect(errOf(() => resolveConfigPure(spec({ env: { set: { A: 'x\u0000y' } } }), facts())).details).toEqual({
      reason: 'controlChar',
      path: 'env.set.A',
    });
    expect(errOf(() => resolveConfigPure(spec({ env: { inherit: 'some' } }), facts())).details).toMatchObject({
      reason: 'notAllowed',
      path: 'env.inherit',
    });
    expect(errOf(() => resolveConfigPure(spec({ debug: { tracePath: 'x.jsonl' } }), facts())).details).toEqual({
      reason: 'notAbsolute',
      path: 'debug.tracePath',
    });
    expect(errOf(() => resolveConfigPure(spec({ network: true }), facts())).details).toEqual({ reason: 'notObject', path: 'network' });
    expect(errOf(() => resolveConfigPure(spec({ tmux: [] }), facts())).details).toEqual({ reason: 'notObject', path: 'tmux' });
    expect(errOf(() => resolveConfigPure(spec({ claude: { expectVersion: 'latest' } }), facts())).details).toEqual({
      reason: 'badFormat',
      path: 'claude.expectVersion',
    });
  });

  it('sessionId and resume together are refused (never both, LC §8.1)', () => {
    expect(
      errOf(() => resolveConfigPure(spec({ sessionId: '99999999-2222-4333-8444-555555555555', resume: 'x' }), facts())).details,
    ).toMatchObject({
      reason: 'sessionIdAndResume',
    });
  });

  it('jitterMax below jitterMin is refused', () => {
    expect(errOf(() => resolveConfigPure(spec({ usageLimit: { jitterMinMs: 10, jitterMaxMs: 5 } }), facts())).details).toMatchObject({
      reason: 'jitterMaxBelowMin',
    });
  });

  it('dangerous permission modes need allowDangerousModes (E_MODE_FORBIDDEN)', () => {
    for (const m of ['bypassPermissions', 'auto', 'dontAsk']) {
      expect(errOf(() => resolveConfigPure(spec({ permissionMode: m }), facts())).code).toBe('E_MODE_FORBIDDEN');
      const ok = resolveConfigPure(spec({ permissionMode: m, permissions: { policy: 'handler', allowDangerousModes: true } }), facts());
      expect(ok.permissionMode).toBe(m);
    }
  });

  it.each([...FORBIDDEN_ENV_SET])('env.set %s → E_FORBIDDEN_ENV (BRIEF, P-REV-04)', (name) => {
    expect(errOf(() => resolveConfigPure(spec({ env: { set: { [name]: 'x' } } }), facts()))).toEqual({
      code: 'E_FORBIDDEN_ENV',
      details: { reason: 'forbiddenName', name },
    });
  });

  it('undefined members are treated as absent', () => {
    const c = resolveConfigPure(spec({ model: undefined, tmux: { cols: undefined } }), facts());
    expect(c.model).toBeUndefined();
    expect(c.tmux.cols).toBe(250);
  });

  it('a non-plain object (class instance) is not an options object', () => {
    class X {
      policy = 'handler';
    }
    expect(errOf(() => resolveConfigPure(spec({ permissions: new X() }), facts())).details).toEqual({
      reason: 'notObject',
      path: 'permissions',
    });
  });
});

describe('validateExtraArgs (§3.3 allowlist, P-REV-03)', () => {
  it('accepts every allowlisted form and returns the caller elements unchanged', () => {
    const args = ['--append-system-prompt', 'be brief', '--name=x', '-n', 'y', '-nz', '--exclude-dynamic-system-prompt-sections'];
    expect(validateExtraArgs(args)).toEqual(args);
    // the canonical form of `--name=--odd` would be `--name --odd`, which does not re-validate: config keeps the original
    expect(validateExtraArgs(['--name=--odd'])).toEqual(['--name=--odd']);
    expect(() => argvBuilderValidate(validateExtraArgs(['--name=--odd']))).not.toThrow();
  });

  it('uses the single allowlist of argv-builder (every flag it allows, nothing else)', () => {
    expect(Object.keys(ALLOWED_EXTRA_FLAGS).sort()).toEqual(
      [
        '--append-system-prompt',
        '--append-system-prompt-file',
        '--exclude-dynamic-system-prompt-sections',
        '--name',
        '--system-prompt',
        '--system-prompt-file',
      ].sort(),
    );
  });

  it.each([
    ['--allowedTools', 'addsPermissionRules'],
    ['--add-dir', 'bypassesAllowAddDirectories'],
    ['--tools', 'changesToolSet'],
    ['--mcp-config', 'loadsHooksOrServers'],
    ['--plugin-dir', 'loadsHooksOrServers'],
    ['--agents', 'loadsHooksOrServers'],
    ['--verbose', 'changesScreen'],
    ['--dangerously-skip-permissions', 'skipsPermissions'],
    ['--resume', 'useResumeOption'],
    ['--model', 'firstClassOption'],
    ['--strict-mcp-config', 'useSecurityMcpStrict'],
    ['--remote-control-x', 'remoteControl'],
    ['--brand-new-flag', 'notAllowlisted'],
  ])('%s → E_FORBIDDEN_ARG with a recorded reason', (flag, reason) => {
    expect(errOf(() => validateExtraArgs([flag, 'v']))).toMatchObject({ code: 'E_FORBIDDEN_ARG', details: { reason, arg: flag } });
  });

  it('library-owned and debug flags are refused in every form', () => {
    for (const a of [['--debug'], ['--debug=api'], ['-d'], ['-dapi'], ['--debug-file', '/x'], ['--settings', '/x']]) {
      expect(errOf(() => validateExtraArgs(a)).code).toBe('E_FORBIDDEN_ARG');
    }
  });

  it('--flag=value is matched on the flag name', () => {
    expect(errOf(() => validateExtraArgs(['--model=opus'])).details).toMatchObject({ reason: 'firstClassOption' });
  });

  it('a positional argument (initial prompt) and a bare "--" are forbidden', () => {
    expect(errOf(() => validateExtraArgs(['fix the bug'])).details).toMatchObject({ reason: 'positional' });
    expect(errOf(() => validateExtraArgs(['--'])).details).toMatchObject({ reason: 'endOfOptions' });
  });

  it('value shape: missing, empty, on a switch, flag-like, oversize', () => {
    expect(errOf(() => validateExtraArgs(['--name'])).details).toMatchObject({ reason: 'missingValue' });
    expect(errOf(() => validateExtraArgs(['--name='])).details).toMatchObject({ reason: 'emptyValue' });
    expect(errOf(() => validateExtraArgs(['--exclude-dynamic-system-prompt-sections=1'])).details).toMatchObject({
      reason: 'unexpectedValue',
    });
    expect(errOf(() => validateExtraArgs(['--name', '--verbose'])).details).toMatchObject({ reason: 'valueLooksLikeFlag' });
    expect(errOf(() => validateExtraArgs(['--append-system-prompt', 'x'.repeat(8 * 1024 + 1)])).details).toMatchObject({
      reason: 'valueTooLong',
    });
  });

  it('no C0/C1 control character in ANY value (§3.3), in both the separate and the inline form', () => {
    for (const v of ['a\u0000b', 'line1\nline2', 'tab\there', 'c1\u009b[2J', 'del\u007f']) {
      expect(errOf(() => validateExtraArgs(['--append-system-prompt', v])).details).toMatchObject({ reason: 'controlCharacter' });
      expect(errOf(() => validateExtraArgs([`--append-system-prompt=${v}`])).details).toMatchObject({ reason: 'controlCharacter' });
    }
    expect(errOf(() => validateExtraArgs(['--name\u0007'])).code).toBe('E_FORBIDDEN_ARG');
  });

  it('*-file flags stay refused while the recorded 2.1.316 --help does not list them (§3.3 UNVERIFIED rule)', () => {
    for (const f of ['--system-prompt-file', '--append-system-prompt-file']) {
      expect(errOf(() => validateExtraArgs([f, '/abs/p.md'])).details).toMatchObject({ reason: 'notInHelp', arg: f });
    }
  });

  it('whatever config accepts, the argv builder accepts (one rule, no late failure)', () => {
    const samples: string[][] = [
      ['--append-system-prompt', 'be brief'],
      ['-n', 'x'],
      ['-nx'],
      ['--name=--odd'],
      ['--exclude-dynamic-system-prompt-sections'],
      ['--system-prompt', 'You are terse.'],
    ];
    for (const a of samples) expect(() => argvBuilderValidate(validateExtraArgs(a))).not.toThrow();
  });

  it('resolveConfigPure runs the extraArgs check', () => {
    expect(errOf(() => resolveConfigPure(spec({ extraArgs: ['--verbose'] }), facts())).code).toBe('E_FORBIDDEN_ARG');
    expect(errOf(() => resolveConfigPure(spec({ extraArgs: ['--append-system-prompt', 'a\nb'] }), facts())).code).toBe('E_FORBIDDEN_ARG');
    expect(resolveConfigPure(spec({ extraArgs: ['-n', 'x'] }), facts()).extraArgs).toEqual(['-n', 'x']);
  });
});

describe('resolveConfig (async: realpath + ids)', () => {
  const ids = { uuidV4: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', shortHex: (n: number) => 'c0ffee12'.slice(0, n) };

  it('realpaths the cwd and mints the session key + fresh session id', async () => {
    const env = new FakeEnv({ realpaths: { '/var/w': '/private/var/w' } });
    const c = await resolveConfig({ cwd: '/var/w', permissions: { policy: 'deny' } }, env, DEFAULTS, ids);
    expect(c.cwdRealpath).toBe('/private/var/w');
    expect(c.sessionKey).toBe('sc0ffee12');
    expect(c.claudeSessionId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(c.claude.configDir).toBe('/home/tester/.claude');
  });

  it('default ids: s + 8 hex, uuid v4', async () => {
    const c = await resolveConfig({ cwd: '/w', permissions: { policy: 'deny' } }, new FakeEnv());
    expect(c.sessionKey).toMatch(/^s[0-9a-f]{8}$/);
    expect(c.claudeSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('a missing cwd → E_CONFIG_INVALID{cwdMissing}', async () => {
    const env = new FakeEnv();
    env.realpath = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(resolveConfig({ cwd: '/nope', permissions: { policy: 'deny' } }, env)).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
      details: { reason: 'cwdMissing', path: 'cwd' },
    });
  });

  it('validation errors win over cwd problems, and non-objects are refused', async () => {
    const env = new FakeEnv();
    await expect(resolveConfig({ cwd: 'rel', permissions: { policy: 'deny' } }, env)).rejects.toMatchObject({
      details: { reason: 'notAbsolute', path: 'cwd' },
    });
    await expect(resolveConfig(null as unknown as SessionSpec, env)).rejects.toMatchObject({ details: { reason: 'notObject' } });
    await expect(resolveConfig({ cwd: '/w' } as SessionSpec, env)).rejects.toMatchObject({ details: { reason: 'permissionsRequired' } });
  });

  it('a non-hex shortHex falls back to crypto', async () => {
    const c = await resolveConfig({ cwd: '/w', permissions: { policy: 'deny' } }, new FakeEnv(), DEFAULTS, {
      ...ids,
      shortHex: () => 'XYZ',
    });
    expect(c.sessionKey).toMatch(/^s[0-9a-f]{8}$/);
  });
});
