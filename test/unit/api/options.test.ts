// DESIGN.md §2.11/§2.12, D-39, P-REV-41, P-REV-42, P-API-19: public options → SessionSpec.
import { describe, expect, it } from 'vitest';
import { isClaudeSessionError } from '../../../src/api/map-errors.js';
import { consoleLogger, toSessionSpec, type ClaudeSessionOptions } from '../../../src/api/options.js';
import type { SessionSpec } from '../../../src/model/spec.js';

const spec = (o: ClaudeSessionOptions): SessionSpec => toSessionSpec(o).spec as unknown as SessionSpec;

function configError(fn: () => unknown): { path?: unknown; detail?: unknown; reason?: unknown } {
  try {
    fn();
  } catch (e) {
    expect(isClaudeSessionError(e, 'E_CONFIG')).toBe(true);
    return (e as { details: Record<string, unknown> }).details;
  }
  throw new Error('expected E_CONFIG');
}

describe('toSessionSpec', () => {
  it('P-REV-42: permissions is required (no silent deny default)', () => {
    const d = configError(() => toSessionSpec({ cwd: '/w' } as unknown as ClaudeSessionOptions));
    expect(d).toMatchObject({ path: 'permissions', detail: 'permissionsRequired', reason: 'E_CONFIG_INVALID' });
  });

  it('P-REV-42: the object form needs a policy too; a nested object is not a policy', () => {
    expect(configError(() => toSessionSpec({ cwd: '/w', permissions: { timeoutMs: 5 } } as unknown as ClaudeSessionOptions))).toMatchObject(
      {
        path: 'permissions.policy',
        detail: 'permissionsRequired',
      },
    );
    expect(
      configError(() => toSessionSpec({ cwd: '/w', permissions: { policy: { policy: 'deny' } } } as unknown as ClaudeSessionOptions)),
    ).toMatchObject({ path: 'permissions.policy', detail: 'invalidValue' });
  });

  it('ICR 0041: idle.suspendAfterMs maps to the spec and is validated', () => {
    expect(toSessionSpec({ cwd: '/w', permissions: 'deny', idle: { suspendAfterMs: 600_000 } }).spec).toMatchObject({
      idle: { suspendAfterMs: 600_000 },
    });
    expect(configError(() => toSessionSpec({ cwd: '/w', permissions: 'deny', idle: { suspendAfterMs: 999 } }))).toMatchObject({
      path: 'idle.suspendAfterMs',
    });
    expect(configError(() => toSessionSpec({ cwd: '/w', permissions: 'deny', idle: { suspendAfterMs: 1.5e3 + 0.5 } }))).toMatchObject({
      path: 'idle.suspendAfterMs',
    });
    expect(
      configError(() => toSessionSpec({ cwd: '/w', permissions: 'deny', idle: { after: 5 } } as unknown as ClaudeSessionOptions)),
    ).toMatchObject({ path: 'idle.after' });
  });

  it('maps the minimal options to the minimal spec', () => {
    const m = toSessionSpec({ cwd: '/w', permissions: 'deny' });
    expect(m.spec).toEqual({ cwd: '/w', permissions: { policy: 'deny' } });
    expect(m.whenBusy).toBe('wait');
    expect('permissionTimeoutMs' in m).toBe(false); // the deadline comes from the core (ICR 0023)
    expect(m.handler).toBeUndefined();
    expect(Object.isFrozen(m.spec)).toBe(true);
  });

  it.each(['deny', 'ask', 'allowRead', 'dangerouslyAllowAll'] as const)('named policy %s', (p) => {
    expect(spec({ cwd: '/w', permissions: p }).permissions).toEqual({ policy: p });
  });

  it('a handler function becomes policy handler and travels beside the spec', () => {
    const h = (): undefined => undefined;
    const m = toSessionSpec({ cwd: '/w', permissions: h });
    expect((m.spec as unknown as SessionSpec).permissions).toEqual({ policy: 'handler' });
    expect(m.handler).toBe(h);
  });

  it('object form with timeout, onTimeout and a handler policy', () => {
    const h = (): undefined => undefined;
    const m = toSessionSpec({ cwd: '/w', permissions: { policy: h, timeoutMs: 5000, onTimeout: 'tui' } });
    expect((m.spec as unknown as SessionSpec).permissions).toEqual({ policy: 'handler', timeoutMs: 5000, onTimeout: 'tui' });
    expect(m.handler).toBe(h);
  });

  it('maps every stable option onto its SessionSpec group (renames: trace → tracePath, trust → trust.mode, network → {})', () => {
    const s = spec({
      cwd: '/w',
      permissions: 'ask',
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
      sessionId: '00000000-0000-4000-8000-000000000009',
      resume: 'abc',
      extraArgs: ['--add-dir', '/x'],
      claude: { bin: '/bin/claude', expectVersion: 'any' },
      env: { inherit: 'all', set: { FOO: 'bar' } },
      trust: 'seed',
      network: true,
      usageLimit: { autoResume: false, resumePrompt: 'go on' },
      debug: { trace: '/tmp/t.ccd.jsonl', raw: 'full' },
    });
    expect(s).toEqual({
      cwd: '/w',
      permissions: { policy: 'ask' },
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
      sessionId: '00000000-0000-4000-8000-000000000009',
      resume: 'abc',
      extraArgs: ['--add-dir', '/x'],
      claude: { bin: '/bin/claude', expectVersion: 'any' },
      env: { inherit: 'all', set: { FOO: 'bar' } },
      trust: { mode: 'seed' },
      network: {},
      usageLimit: { autoResume: false, resumePrompt: 'go on' },
      debug: { tracePath: '/tmp/t.ccd.jsonl', raw: 'full' },
    });
    expect(spec({ cwd: '/w', permissions: 'deny', network: false }).network).toBe(false);
  });

  it('logger and signal travel beside the spec, never inside it', () => {
    const logger = consoleLogger('error');
    const ac = new AbortController();
    const m = toSessionSpec({ cwd: '/w', permissions: 'deny', logger, signal: ac.signal });
    expect(m.logger).toBe(logger);
    expect(m.signal).toBe(ac.signal);
    expect(Object.keys(m.spec)).toEqual(['cwd', 'permissions']);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['unknown top-level key', { cwd: '/w', permissions: 'deny', whenBusy: 'wait' }, 'options.whenBusy'],
    ['unknown nested key', { cwd: '/w', permissions: 'deny', debug: { trace: '/t', redact: true } }, 'debug.redact'],
    ['unknown permissions key', { cwd: '/w', permissions: { policy: 'deny', onRequest: 1 } }, 'permissions.onRequest'],
    ['env.inherit list (advanced only)', { cwd: '/w', permissions: 'deny', env: { inherit: ['PATH'] } }, 'env.inherit'],
  ])('P-API-19: rejects %s', (_n, o, path) => {
    expect(configError(() => toSessionSpec(o as unknown as ClaudeSessionOptions)).path).toBe(path);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['empty cwd', { cwd: '', permissions: 'deny' }, 'cwd'],
    ['missing cwd', { permissions: 'deny' }, 'cwd'],
    ['bad policy', { cwd: '/w', permissions: 'allowAll' }, 'permissions'],
    ['bad timeout', { cwd: '/w', permissions: { policy: 'deny', timeoutMs: 0 } }, 'permissions.timeoutMs'],
    ['bad onTimeout', { cwd: '/w', permissions: { policy: 'deny', onTimeout: 'allow' } }, 'permissions.onTimeout'],
    ['dangerous mode through the stable option', { cwd: '/w', permissions: 'deny', permissionMode: 'bypassPermissions' }, 'permissionMode'],
    ['extraArgs not strings', { cwd: '/w', permissions: 'deny', extraArgs: ['--x', 1] }, 'extraArgs'],
    ['env.set value not a string', { cwd: '/w', permissions: 'deny', env: { set: { A: 1 } } }, 'env.set.A'],
    ['network not a boolean', { cwd: '/w', permissions: 'deny', network: { faults: true } }, 'network'],
    ['trust value', { cwd: '/w', permissions: 'deny', trust: true }, 'trust'],
    ['debug.raw value', { cwd: '/w', permissions: 'deny', debug: { raw: 'some' } }, 'debug.raw'],
    ['logger shape', { cwd: '/w', permissions: 'deny', logger: { info: () => undefined } }, 'logger'],
    ['signal type', { cwd: '/w', permissions: 'deny', signal: {} }, 'signal'],
    ['options not an object', null as unknown as Record<string, unknown>, 'options'],
  ])('rejects %s', (_n, o, path) => {
    expect(configError(() => toSessionSpec(o as unknown as ClaudeSessionOptions)).path).toBe(path);
  });

  describe('unstable_advanced', () => {
    it('deep-merges SessionSpec groups over the mapped spec (stable fields keep their siblings)', () => {
      const m = toSessionSpec({
        cwd: '/w',
        permissions: { policy: 'deny', timeoutMs: 9000 },
        network: true,
        debug: { raw: 'meta' },
        unstable_advanced: {
          permissions: { allowDangerousModes: true },
          permissionMode: 'bypassPermissions',
          network: { faults: true },
          debug: { claudeDebugFile: true },
          tmux: { cols: 200 },
          input: { whenBusy: 'reject' },
          selfTest: 'off',
          timeouts: { startupMs: 1 },
        },
      });
      expect(m.spec).toEqual({
        cwd: '/w',
        permissions: { policy: 'deny', timeoutMs: 9000, allowDangerousModes: true },
        permissionMode: 'bypassPermissions',
        network: { faults: true },
        debug: { raw: 'meta', claudeDebugFile: true },
        tmux: { cols: 200 },
        input: { whenBusy: 'reject' },
        selfTest: 'off',
        timeouts: { startupMs: 1 },
      });
      expect(m.whenBusy).toBe('reject');
    });

    it('LP-50 / P-REV-27: claudeDebugFile is reachable only through unstable_advanced', () => {
      expect(
        configError(() =>
          toSessionSpec({ cwd: '/w', permissions: 'deny', debug: { claudeDebugFile: true } } as unknown as ClaudeSessionOptions),
        ).path,
      ).toBe('debug.claudeDebugFile');
    });

    it.each<[string, Record<string, unknown>, string, string]>([
      ['unknown group', { statusLine: true }, 'unstable_advanced.statusLine', 'unknownKey'],
      ['unknown key in a group', { tmux: { name: 'x' } }, 'unstable_advanced.tmux.name', 'unknownKey'],
      ['cwd override', { cwd: '/other' }, 'unstable_advanced.cwd', 'stableOnly'],
      ['policy override', { permissions: { policy: 'dangerouslyAllowAll' } }, 'unstable_advanced.permissions.policy', 'stableOnly'],
      ['a group that is not an object', { hooks: 'http' }, 'unstable_advanced.hooks', 'invalidValue'],
    ])('rejects %s', (_n, adv, path, detail) => {
      expect(configError(() => toSessionSpec({ cwd: '/w', permissions: 'deny', unstable_advanced: adv }))).toMatchObject({ path, detail });
    });

    it('rejects prototype-reaching keys anywhere, free-form groups included', () => {
      const adv = JSON.parse('{"timeouts":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
      expect(configError(() => toSessionSpec({ cwd: '/w', permissions: 'deny', unstable_advanced: adv }))).toMatchObject({
        path: 'unstable_advanced.timeouts.__proto__',
        detail: 'unknownKey',
      });
      const deep = JSON.parse('{"env":{"set":{"constructor":"x"}}}') as Record<string, unknown>;
      expect(configError(() => toSessionSpec({ cwd: '/w', permissions: 'deny', unstable_advanced: deep })).path).toBe(
        'unstable_advanced.env.set.constructor',
      );
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('network:false is a valid advanced value', () => {
      expect(spec({ cwd: '/w', permissions: 'deny', unstable_advanced: { network: false } }).network).toBe(false);
    });
  });
});

describe('consoleLogger', () => {
  it('filters below the level and prefixes lines', () => {
    const seen: string[] = [];
    const orig = { info: console.info, warn: console.warn, debug: console.debug };
    console.info = (l: string) => void seen.push(l);
    console.warn = (l: string, f?: unknown) => void seen.push(`${l} ${JSON.stringify(f)}`);
    console.debug = (l: string) => void seen.push(l);
    try {
      const log = consoleLogger('info');
      log.debug('hidden');
      log.info('shown');
      log.warn('w', { a: 1 });
    } finally {
      Object.assign(console, orig);
    }
    expect(seen).toEqual(['[claude-code-driver] info shown', '[claude-code-driver] warn w {"a":1}']);
  });
});
