// WP-12 preflight (DESIGN.md §3.1 steps 1–7 + the tmux probe; P-TMUX-41/50, P-INPUT-37, P-HOOK-04, P-LIFE-02/18/41,
// P-SEC-15/29, P-REV-04/12/37).
import { describe, expect, it } from 'vitest';
import { isCctError } from '../../../src/model/errors.js';
import { TmuxNotFound } from '../../../src/platform/tmux/errors.js';
import { RegistryStore } from '../../../src/session/registry-store.js';
import {
  checkAccount,
  checkClaudeBinary,
  checkCwd,
  checkExtraArgs,
  checkNode,
  checkResumeHolder,
  checkSettingsLayers,
  checkStateRoot,
  checkTerminfo,
  checkTrust,
  chooseHookTransport,
  keybindingConflicts,
  mapPortError,
  probeTmux,
  sandboxEnabledIn,
  staggerAuth,
  TMUX_SEARCH_DIRS,
} from '../../../src/session/preflight.js';
import { createFakePorts, type FakePortsOptions } from '../../../src/testing/fake-ports.js';
import { launchWorld, pump, record } from './wp12-helpers.js';

async function rejection(p: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> | undefined }> {
  try {
    await p;
  } catch (e) {
    if (isCctError(e)) return { code: e.code, details: e.details as Record<string, unknown> | undefined };
    throw e;
  }
  throw new Error('expected a rejection');
}

function ports(o: FakePortsOptions = {}): ReturnType<typeof createFakePorts> {
  return createFakePorts(o);
}

describe('steps 1–2: config parts, cwd, node', () => {
  it('extraArgs go through the allowlist (E_FORBIDDEN_ARG) and file checks', async () => {
    const f = ports();
    expect(await checkExtraArgs(['--name', 'x'], f.env)).toEqual(['--name', 'x']);
    expect((await rejection(checkExtraArgs(['--add-dir', '/'], f.env))).code).toBe('E_FORBIDDEN_ARG');
  });

  it('cwd must exist and be a directory; its realpath is returned (LV Q4)', async () => {
    const f = ports({
      cwd: '/var/w',
      realpaths: { '/var/w': '/private/var/w' },
      entries: {
        '/private/var/w': { isSymlink: false, isFile: false, isDir: true },
        '/file': { isSymlink: false, isFile: true, isDir: false },
      },
    });
    expect(await checkCwd(f.env, '/var/w')).toBe('/private/var/w');
    expect((await rejection(checkCwd(f.env, '/nope'))).details?.['reason']).toBe('cwdMissing');
    expect((await rejection(checkCwd(f.env, '/file'))).details?.['reason']).toBe('cwdNotDirectory');
    expect((await rejection(checkCwd(f.env, 'rel'))).details?.['reason']).toBe('cwdNotAbsolute');
  });

  it('node ≥ 20', () => {
    expect(() => {
      checkNode('20.19.0');
    }).not.toThrow();
    expect(() => {
      checkNode('v22.23.2');
    }).not.toThrow();
    expect(() => {
      checkNode('18.20.4');
    }).toThrow(/not supported/);
  });

  it('state root: symlink or non-dir → E_UNSAFE_RUNTIME_DIR; missing is fine', async () => {
    const f = ports({
      entries: { '/s/link': { isSymlink: true, isFile: false, isDir: false }, '/s/file': { isSymlink: false, isFile: true, isDir: false } },
    });
    expect((await rejection(checkStateRoot(f.env, '/s/link'))).details?.['reason']).toBe('symlink');
    expect((await rejection(checkStateRoot(f.env, '/s/file'))).details?.['reason']).toBe('notDirectory');
    await expect(checkStateRoot(f.env, '/s/missing')).resolves.toBeUndefined();
  });
});

describe('step 5: Claude binary and version (K-03)', () => {
  it('missing binary → E_CLAUDE_NOT_FOUND; wrong version → E_CLAUDE_VERSION_MISMATCH; any accepted', async () => {
    expect((await rejection(checkClaudeBinary(ports({ claude: { exe: undefined } }).claude, { expectVersion: '2.1.316' }, {}))).code).toBe(
      'E_CLAUDE_NOT_FOUND',
    );
    const f = ports({ claude: { version: '2.1.400' } });
    expect(await rejection(checkClaudeBinary(f.claude, { expectVersion: '2.1.316' }, {}))).toEqual({
      code: 'E_CLAUDE_VERSION_MISMATCH',
      details: { expected: '2.1.316', found: '2.1.400' },
    });
    expect((await checkClaudeBinary(f.claude, { expectVersion: 'any' }, {})).version).toBe('2.1.400');
  });

  it('the version check runs with env₁ and before any tmux call', async () => {
    const f = ports({ claude: { version: '9.9.9' } });
    const r = await launchWorld({ fakes: f }).catch((e: unknown) => e);
    expect(isCctError(r, 'E_CLAUDE_VERSION_MISMATCH')).toBe(true);
    expect(f.tmux.invocations).toEqual([]);
    const call = f.claude.calls.find((c) => c.op === 'version');
    expect(call?.env?.['DISABLE_AUTOUPDATER']).toBe('1');
    expect(call?.env?.['ANTHROPIC_API_KEY']).toBeUndefined();
  });
});

describe('step 6: account (P-LIFE-02, P-REV-04)', () => {
  const run = (o: FakePortsOptions): Promise<unknown> => {
    const f = ports(o);
    return checkAccount({ claudeConfig: f.claudeConfig, claude: f.claude, clock: f.clock }, '/x/claude.exe', {});
  };
  it.each([
    [{ globalConfig: 'invalidJson' as const }, 'E_CONFIG_CORRUPT'],
    [{ globalConfig: 'missing' as const }, 'E_NOT_ONBOARDED'],
    [{ globalConfig: { hasCompletedOnboarding: false } }, 'E_NOT_ONBOARDED'],
    [{ claude: { auth: { loggedIn: false } } }, 'E_LOGIN_REQUIRED'],
    [{ claude: { auth: { loggedIn: true, authMethod: 'api_key' } } }, 'E_AUTH_METHOD_UNSUPPORTED'],
    [{ claude: { auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' } } }, 'E_API_PROVIDER_UNSUPPORTED'],
    [{ claude: { auth: 'timeout' as const } }, 'E_STARTUP_TIMEOUT'], // errors-map: auth status still running (never killed early)
  ])('%j → %s', async (o, code) => {
    expect((await rejection(run(o))).code).toBe(code);
  });
  it('a firstParty claude.ai login passes', async () => {
    await expect(run({})).resolves.toEqual({ authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' });
  });

  it('P-LIFE-41: concurrent auth checks in one process are ≥ 1.5 s apart', async () => {
    const f = ports();
    const at: number[] = [];
    const call = (): Promise<void> =>
      staggerAuth(f.clock, () => {
        at.push(f.clock.now());
        return Promise.resolve();
      });
    await pump(f, Promise.all([call(), call(), call()]));
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1500);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(1500);
  });
});

describe('step 7: layers, keybindings, transport, trust, resume holder', () => {
  it('P-HOOK-04 / P-SEC-29 (D-14): disableAllHooks without override fails; with override writes false', async () => {
    const f = ports({ layers: { disableAllHooksTrueIn: ['user'] } });
    expect((await rejection(checkSettingsLayers(f.claudeConfig, '/w', { overrideDisableAllHooks: false }))).code).toBe(
      'E_HOOKS_DISABLED_BY_USER',
    );
    const v = await checkSettingsLayers(f.claudeConfig, '/w', { overrideDisableAllHooks: true });
    expect(v.writeDisableAllHooksFalse).toBe(true);
  });

  it('P-INPUT-37: rebinding a guarded key → E_KEYBINDING_CONFLICT (lenient parse)', async () => {
    const kb = { bindings: [{ context: 'Chat', bindings: { 'ctrl+g': 'chat:undo', 'ctrl+e': 'chat:externalEditor' } }] };
    const f = ports({ layers: { keybindings: kb } });
    expect(await rejection(checkSettingsLayers(f.claudeConfig, '/w', { overrideDisableAllHooks: false }))).toEqual({
      code: 'E_KEYBINDING_CONFLICT',
      details: { keys: ['ctrl+g'] },
    });
    expect(keybindingConflicts({ Enter: null, 'shift+tab': 'x', 'C-c': 'y', 'escape escape': 'z', other: { key: 'ctrl+j' } })).toEqual([
      'ctrl+c',
      'ctrl+j',
      'enter',
      'escape',
      'shift+tab',
    ]);
    expect(
      keybindingConflicts({ bindings: [{ bindings: { 'ctrl+e': 'chat:externalEditor', 'ctrl+x enter': 'chat:queueSubmit' } }] }),
    ).toEqual([]);
    expect(keybindingConflicts('garbage')).toEqual([]);
  });

  it('editorMode vim → warning (forced normal); P-REV-12 settings env provider switch → E_FORBIDDEN_ENV', async () => {
    const f = ports({ layers: { editorMode: 'vim', project: { env: { CLAUDE_CODE_MAX_RETRIES: '2' } } } });
    const v = await checkSettingsLayers(f.claudeConfig, '/w', { overrideDisableAllHooks: false });
    expect(v.warnings.map((w) => w.reason)).toEqual(['editorModeForcedNormal']);
    expect(v.envWarnings.map((w) => w.reason)).toEqual(['settingsEnvSemantics:project']);
    const g = ports({ layers: { user: { env: { CLAUDE_CODE_USE_VERTEX: '1' } } } });
    expect((await rejection(checkSettingsLayers(g.claudeConfig, '/w', { overrideDisableAllHooks: false }))).details?.['reason']).toBe(
      'settingsEnv',
    );
  });

  it('hook transport auto rules (rev 2 §10 G9)', () => {
    const layers = { disableAllHooksTrueIn: [], allowedHttpHookUrlsDefinedIn: [], statusLineDefined: false, parseErrors: [] };
    expect(chooseHookTransport('auto', { allowedHttpHookUrlsDefined: false, layers }, false)).toEqual({
      transport: 'http',
      reason: 'default',
    });
    expect(chooseHookTransport('auto', { allowedHttpHookUrlsDefined: true, layers }, false).transport).toBe('unix');
    expect(
      chooseHookTransport(
        'auto',
        { allowedHttpHookUrlsDefined: false, layers: { ...layers, local: { sandbox: { enabled: true } } } },
        false,
      ),
    ).toEqual({
      transport: 'unix',
      reason: 'sandbox',
    });
    expect(chooseHookTransport('auto', { allowedHttpHookUrlsDefined: false, layers }, true).reason).toBe('selfTestCache');
    expect(chooseHookTransport('http', { allowedHttpHookUrlsDefined: true, layers }, true)).toEqual({
      transport: 'http',
      reason: 'explicit',
    });
    expect(sandboxEnabledIn({ ...layers, user: { sandbox: { enabled: false } } })).toEqual([]);
  });

  it('P-SEC-15 (D-19): require → E_TRUST_REQUIRED; seed inspects first, risk → E_WORKSPACE_RISK, else seeds one key', async () => {
    const untrusted = ports({ trusted: false });
    expect((await rejection(checkTrust(untrusted.claudeConfig, untrusted.cwd, { mode: 'require', acceptRisks: false }))).code).toBe(
      'E_TRUST_REQUIRED',
    );
    const risky = ports({ trusted: false, risk: { empty: false, items: [{ file: '.claude/settings.json', kind: 'hooks', detail: 'x' }] } });
    expect(await rejection(checkTrust(risky.claudeConfig, risky.cwd, { mode: 'seed', acceptRisks: false }))).toEqual({
      code: 'E_WORKSPACE_RISK',
      details: { items: ['.claude/settings.json:hooks'] },
    });
    expect(risky.claudeConfig.writes).toEqual([]);
    expect(await checkTrust(risky.claudeConfig, risky.cwd, { mode: 'seed', acceptRisks: true })).toEqual({
      trusted: true,
      trustKeyAddedByLibrary: true,
    });
    const trusted = ports();
    expect((await checkTrust(trusted.claudeConfig, trusted.cwd, { mode: 'require', acceptRisks: false })).trustKeyAddedByLibrary).toBe(
      false,
    );
  });

  it('P-LIFE-18 / P-REV-37: a live holder of the resume id → E_SESSION_ID_IN_USE{pid, ours}', async () => {
    const f = ports();
    const store = new RegistryStore(f.state, () => f.clock.wallNow());
    await expect(checkResumeHolder(f.registry, store, 'abc')).resolves.toBeUndefined();
    const pid = f.process.addProcess({ command: 'claude' });
    f.registry.put({ pid, sessionId: 'abc' });
    expect(await rejection(checkResumeHolder(f.registry, store, 'abc'))).toEqual({
      code: 'E_SESSION_ID_IN_USE',
      details: { pid, ours: false },
    });
    await store.writeSession(record(undefined, { claude: { pid, startTime: 'x', exe: '/c/claude.exe', version: '2.1.316' } }));
    expect((await rejection(checkResumeHolder(f.registry, store, 'abc'))).details?.['ours']).toBe(true);
  });
});

describe('tmux probe and terminfo (P-TMUX-41, P-TMUX-50)', () => {
  it('missing tmux → E_TMUX_NOT_FOUND with the searched dirs; too old → E_TMUX_UNSUPPORTED', async () => {
    const f = ports({ tmuxMissing: true });
    expect(await rejection(probeTmux(f.tmux, f.process, undefined))).toEqual({
      code: 'E_TMUX_NOT_FOUND',
      details: { searched: [...TMUX_SEARCH_DIRS] },
    });
    const old = ports({ tmuxVersion: '3.1c' });
    expect((await rejection(probeTmux(old.tmux, old.process, undefined))).code).toBe('E_TMUX_UNSUPPORTED');
    const g = ports();
    g.process.binaries.set('tmux', '/usr/local/bin/tmux');
    expect((await probeTmux(g.tmux, g.process, undefined)).path).toBe('/usr/local/bin/tmux');
  });

  it('terminfo is checked on linux only', async () => {
    const f = ports();
    expect(await checkTerminfo(f.process, { platform: () => 'darwin' }, {})).toBeUndefined();
    expect((await checkTerminfo(f.process, { platform: () => 'linux' }, {}))?.reason).toBe('terminfoMissing');
    f.process.onExec((c) => (c.file === 'infocmp' ? { code: 0, signal: null, stdout: '', stderr: '', timedOut: false } : undefined));
    expect(await checkTerminfo(f.process, { platform: () => 'linux' }, {})).toBeUndefined();
  });

  it('L0 errors map by name through errors-map; unknown errors take the fallback code', () => {
    expect(mapPortError(new TmuxNotFound(['/x']), 'E_INVARIANT', 'probe').code).toBe('E_TMUX_NOT_FOUND');
    expect(mapPortError(new Error('weird'), 'E_HOOKS_UNAVAILABLE', 'hooks').code).toBe('E_HOOKS_UNAVAILABLE');
  });
});
