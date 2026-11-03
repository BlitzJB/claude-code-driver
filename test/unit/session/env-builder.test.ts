// WP-12 env-builder (DESIGN.md §3.2, D-22, D-25, §3.10 env).
import { describe, expect, it } from 'vitest';
import { isCctError } from '../../../src/model/errors.js';
import {
  argvLeaksEnvSecret,
  BASE_ALLOWLIST,
  buildChildEnv,
  checkCallerEnv,
  checkSettingsEnv,
  isStripped,
  libraryProxyUrl,
  LIBRARY_REQUIRED,
  networkEligibility,
  noProxyCovers,
  PRIVACY_PASSTHROUGH,
  PROVIDER_SWITCHES,
  readUserProxy,
  SEMANTICS_VARS,
  STRIP_ALWAYS,
  type ChildEnvInput,
} from '../../../src/session/env-builder.js';

const VISUAL = '/run/ccd-abc123/ccd-editor';

function input(host: Record<string, string>, over: Partial<ChildEnvInput> = {}): ChildEnvInput {
  return {
    host,
    homeDir: '/home/u',
    userName: 'u',
    platform: 'darwin',
    inherit: 'minimal',
    set: {},
    scrubSubprocessEnv: false,
    visualPath: VISUAL,
    ...over,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (!isCctError(e)) return 'non-ccd';
    const r = e.details?.['reason'];
    return `${e.code}:${typeof r === 'string' ? r : ''}`;
  }
  return undefined;
}

describe('base allowlist and inheritance (D-25, P-SEC-19, P-LIFE-56)', () => {
  it('minimal keeps only the base list, LC_* and the privacy pass-through list', () => {
    const host = {
      PATH: '/usr/bin',
      HOME: '/h',
      USER: 'alice',
      LANG: 'en_US.UTF-8',
      LC_TIME: 'de_DE.UTF-8',
      SECRET_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'y',
      SSH_AUTH_SOCK: '/tmp/ssh',
      DISABLE_TELEMETRY: '1',
      DO_NOT_TRACK: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const { env } = buildChildEnv(input(host));
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['LC_TIME']).toBe('de_DE.UTF-8');
    expect(env['SECRET_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    // P-REV-06: privacy vars kept exactly as the user set them
    expect(env['DISABLE_TELEMETRY']).toBe('1');
    expect(env['DO_NOT_TRACK']).toBe('1');
    expect(env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
    expect(PRIVACY_PASSTHROUGH).toContain('DISABLE_GROWTHBOOK');
    expect(BASE_ALLOWLIST).toContain('TZ');
  });

  it('a listed inherit adds names (SSH_AUTH_SOCK only when listed)', () => {
    const { env } = buildChildEnv(input({ SSH_AUTH_SOCK: '/tmp/ssh', FOO: 'bar', HOME: '/h' }, { inherit: ['SSH_AUTH_SOCK', 'FOO'] }));
    expect(env['SSH_AUTH_SOCK']).toBe('/tmp/ssh');
    expect(env['FOO']).toBe('bar');
  });

  it("inherit:'all' still applies the strip list", () => {
    const host: Record<string, string> = { FOO: 'bar', HOME: '/h' };
    for (const n of STRIP_ALWAYS) host[n] = 'x';
    host['BUN_INSTALL'] = '/b';
    host['CLAUDE_CODE_RETRY_WATCHDOG_MS'] = '5';
    const { env, warnings } = buildChildEnv(input(host, { inherit: 'all' }));
    expect(env['FOO']).toBe('bar');
    for (const n of STRIP_ALWAYS) expect(env[n], n).toBeUndefined();
    expect(env['BUN_INSTALL']).toBeUndefined();
    expect(env['CLAUDE_CODE_RETRY_WATCHDOG_MS']).toBeUndefined();
    expect(warnings.find((w) => w.reason === 'providerSwitchStripped')?.names.sort()).toEqual([...PROVIDER_SWITCHES].sort());
  });

  it.each([
    ['P-TAIL-04', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY'],
    ['P-TAIL-29', 'CLAUDE_CODE_CHILD_SESSION'],
    ['P-HOOK-12', 'CLAUDE_CODE_SAFE_MODE'],
    ['P-HOOK-12', 'CLAUDE_CODE_SIMPLE'],
    ['P-NET-39', 'ANTHROPIC_UNIX_SOCKET'],
    ['P-LIFE-32', 'ANTHROPIC_API_KEY'],
    ['P-LIFE-42', 'CLAUDE_CODE_RETRY_WATCHDOG'],
    ['P-SEC-38', 'NODE_OPTIONS'],
    ['P-SEC-12', 'CLAUDE_CODE_SANDBOXED'],
    ['P-REV-18', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'],
    ['D-08', 'TMUX'],
    ['D-08', 'TMUX_PANE'],
  ])('%s: %s is stripped even when the caller sets it', (_id, name) => {
    const { env } = buildChildEnv(input({ HOME: '/h' }, { inherit: 'all', set: { [name]: '1' } }));
    expect(env[name]).toBeUndefined();
    expect(isStripped(name)).toBe(true);
  });

  it('P-REV-05: every model-call semantics var is stripped', () => {
    const host: Record<string, string> = { HOME: '/h' };
    for (const n of SEMANTICS_VARS) host[n] = '7';
    const { env } = buildChildEnv(input(host, { inherit: 'all' }));
    for (const n of SEMANTICS_VARS) expect(env[n]).toBeUndefined();
  });
});

describe('library-required and identity', () => {
  it('sets every library-required var (P-LIFE-24, P-TAIL-29) and the subprocess scrub only on request', () => {
    const a = buildChildEnv(input({ HOME: '/h' })).env;
    for (const [k, v] of Object.entries(LIBRARY_REQUIRED)) expect(a[k]).toBe(v);
    expect(a['DISABLE_UPDATES']).toBe('1');
    expect(a['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE']).toBe('1');
    expect(a['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBeUndefined();
    const b = buildChildEnv(input({ HOME: '/h' }, { scrubSubprocessEnv: true })).env;
    expect(b['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('1');
  });

  it('library-required beats the caller', () => {
    const { env } = buildChildEnv(input({ HOME: '/h' }, { set: { DISABLE_AUTOUPDATER: '0', VISUAL: 'vim' } }));
    expect(env['DISABLE_AUTOUPDATER']).toBe('1');
    expect(env['VISUAL']).toBe(VISUAL);
  });

  it('P-LIFE-25: USER and HOME are mandatory', () => {
    const { env } = buildChildEnv(input({ PATH: '/bin' }));
    expect(env['HOME']).toBe('/home/u');
    expect(env['USER']).toBe('u');
    expect(env['LOGNAME']).toBe('u');
  });

  it('P-LIFE-26: CLAUDE_CONFIG_DIR is kept only when the host has it, never introduced', () => {
    expect(buildChildEnv(input({ HOME: '/h' }, { set: { CLAUDE_CONFIG_DIR: '/x' } })).env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(buildChildEnv(input({ HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' })).env['CLAUDE_CONFIG_DIR']).toBe('/cfg');
  });

  it('P-TMUX-49: a UTF-8 locale is forced when none is set (darwin and linux values)', () => {
    expect(buildChildEnv(input({ HOME: '/h', LANG: 'C' })).env['LC_ALL']).toBe('en_US.UTF-8');
    expect(buildChildEnv(input({ HOME: '/h' }, { platform: 'linux' })).env['LC_ALL']).toBe('C.UTF-8');
    expect(buildChildEnv(input({ HOME: '/h', LANG: 'de_DE.utf8' })).env['LC_ALL']).toBeUndefined();
  });

  it('P-INPUT-16 / P-REV-31: VISUAL is ours, GIT_EDITOR keeps the user chain, fallback `true`', () => {
    expect(buildChildEnv(input({ HOME: '/h', GIT_EDITOR: 'nano', VISUAL: 'code -w' })).env['GIT_EDITOR']).toBe('nano');
    expect(buildChildEnv(input({ HOME: '/h', VISUAL: 'code -w', EDITOR: 'vi' })).env['GIT_EDITOR']).toBe('code -w');
    expect(buildChildEnv(input({ HOME: '/h', EDITOR: 'vi' })).env['GIT_EDITOR']).toBe('vi');
    const none = buildChildEnv(input({ HOME: '/h' })).env;
    expect(none['GIT_EDITOR']).toBe('true');
    expect(none['VISUAL']).toBe(VISUAL);
  });
});

describe('caller env validation (§3.1 step 1, P-REV-04)', () => {
  const forbiddenCases: [string, string][] = [
    ['ANTHROPIC_BASE_URL', 'baseUrl'],
    ...PROVIDER_SWITCHES.map((n): [string, string] => [n, 'providerSwitch']),
  ];
  it.each(forbiddenCases)('%s in env.set → E_FORBIDDEN_ENV', (name, reason) => {
    expect(
      code(() => {
        checkCallerEnv({ [name]: '1' });
      }),
    ).toBe(`E_FORBIDDEN_ENV:${reason}`);
    expect(code(() => buildChildEnv(input({}, { set: { [name]: '1' } })))).toBe(`E_FORBIDDEN_ENV:${reason}`);
  });
  it('malformed names / values → E_CONFIG_INVALID', () => {
    expect(
      code(() => {
        checkCallerEnv({ 'A-B': '1' });
      }),
    ).toBe('E_CONFIG_INVALID:envName');
    expect(
      code(() => {
        checkCallerEnv({ A: 'x\0y' });
      }),
    ).toBe('E_CONFIG_INVALID:envValue');
    expect(
      code(() => {
        checkCallerEnv({ OK_NAME: 'v' });
      }),
    ).toBeUndefined();
  });
});

describe('settings env blocks (P-REV-12)', () => {
  it('a provider switch in a settings env block fails; semantics vars warn', () => {
    expect(code(() => checkSettingsEnv([{ layer: 'user', value: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } }]))).toBe(
      'E_FORBIDDEN_ENV:settingsEnv',
    );
    const w = checkSettingsEnv([
      { layer: 'project', value: { env: { CLAUDE_CODE_MAX_RETRIES: '1', NODE_OPTIONS: '--x', FINE: '1' } } },
      { layer: 'local', value: 'garbage' },
    ]);
    expect(w).toEqual([
      { code: 'E_FORBIDDEN_ENV', reason: 'settingsEnvSemantics:project', names: ['CLAUDE_CODE_MAX_RETRIES'] },
      { code: 'E_FORBIDDEN_ENV', reason: 'settingsEnvStripped:project', names: ['NODE_OPTIONS'] },
    ]);
  });
});

describe('proxies (D-22, P-HOOK-19, P-NET-22/31/32/33/34/37)', () => {
  it('network off: the user proxy passes through in both casings (lowercase wins) and NO_PROXY gets loopback', () => {
    const host = {
      HOME: '/h',
      https_proxy: 'http://low:1',
      HTTPS_PROXY: 'http://up:2',
      NO_PROXY: 'corp.example',
      no_proxy: 'x.example,corp.example',
    };
    const { env } = buildChildEnv(input(host));
    expect(env['HTTPS_PROXY']).toBe('http://low:1');
    expect(env['https_proxy']).toBe('http://low:1');
    expect(env['NO_PROXY']).toBe('corp.example,x.example,127.0.0.1,localhost,::1');
    expect(env['no_proxy']).toBe(env['NO_PROXY']);
    expect(env['HTTP_PROXY']).toBeUndefined();
  });

  it('ALL_PROXY alone is passed through and still triggers the loopback NO_PROXY (P-NET-34, D-22)', () => {
    const { env } = buildChildEnv(input({ HOME: '/h', ALL_PROXY: 'socks5://p:1080' }));
    expect(env['ALL_PROXY']).toBe('socks5://p:1080');
    expect(env['NO_PROXY']).toBe('127.0.0.1,localhost,::1');
  });

  it('no proxy at all → no proxy vars; caller proxy vars are ignored', () => {
    const { env } = buildChildEnv(input({ HOME: '/h' }, { set: { HTTPS_PROXY: 'http://evil:1' } }));
    expect(env['HTTPS_PROXY']).toBeUndefined();
    expect(env['NO_PROXY']).toBeUndefined();
  });

  it('network on: our proxy URL, HTTP_PROXY unset, NO_PROXY exactly loopback; carriesSecret', () => {
    const token = 'ab'.repeat(32);
    const r = buildChildEnv(input({ HOME: '/h' }, { libraryProxy: { tokenA: token, port: 41234 } }));
    expect(r.env['HTTPS_PROXY']).toBe(`http://ccd:${token}@127.0.0.1:41234`);
    expect(r.env['https_proxy']).toBe(r.env['HTTPS_PROXY']);
    expect(r.env['HTTP_PROXY']).toBeUndefined();
    expect(r.env['http_proxy']).toBeUndefined();
    expect(r.env['NO_PROXY']).toBe('127.0.0.1,localhost,::1');
    expect(r.carriesSecret).toBe(true);
    // P-SEC-18 (argv scan): the token never appears in argv
    expect(argvLeaksEnvSecret(['/usr/bin/env', 'claude.exe', '--settings', '/x'], r.env)).toBe(false);
    expect(argvLeaksEnvSecret(['/usr/bin/env', `--x=${token}`], r.env)).toBe(true);
  });

  it('P-NET-37: the proxy URL is validated', () => {
    expect(code(() => libraryProxyUrl('NOT-HEX', 1))).toBe('E_INVARIANT:');
    expect(code(() => libraryProxyUrl('ab'.repeat(16), 0))).toBe('E_INVARIANT:');
    expect(new URL(libraryProxyUrl('ab'.repeat(16), 8080)).host).toBe('127.0.0.1:8080');
  });

  it('network eligibility: user proxy / NO_PROXY covering the API / proxy auth helper → off', () => {
    expect(networkEligibility({})).toEqual({ ok: true });
    expect(networkEligibility({ http_proxy: 'http://p:1' })).toEqual({ ok: false, reason: 'userProxy' });
    expect(networkEligibility({ ALL_PROXY: 'socks5://p' })).toEqual({ ok: false, reason: 'userProxy' });
    expect(networkEligibility({ NO_PROXY: '*' })).toEqual({ ok: false, reason: 'noProxyCovers' });
    expect(networkEligibility({ no_proxy: '.anthropic.com' })).toEqual({ ok: false, reason: 'noProxyCovers' });
    expect(networkEligibility({ CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER: '1' })).toEqual({ ok: false, reason: 'proxyAuthHelper' });
  });

  it('NO_PROXY matching semantics', () => {
    expect(noProxyCovers(['api.anthropic.com:443'], 'api.anthropic.com')).toBe(true);
    expect(noProxyCovers(['anthropic.com'], 'api.anthropic.com')).toBe(true);
    expect(noProxyCovers(['*.anthropic.com'], 'api.anthropic.com')).toBe(true);
    expect(noProxyCovers(['notanthropic.com', 'localhost'], 'api.anthropic.com')).toBe(false);
    expect(readUserProxy({ NO_PROXY: ' a, b c ' }).noProxy).toEqual(['a', 'b', 'c']);
  });
});

describe('logging hygiene', () => {
  it('names are sorted and never values', () => {
    const r = buildChildEnv(input({ HOME: '/h', PATH: '/bin' }));
    expect(r.names).toEqual([...r.names].sort());
    expect(r.names).toContain('PATH');
    expect(r.names.join(',')).not.toContain('/bin');
  });
});
