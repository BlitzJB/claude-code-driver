// WP-12 settings-plan (DESIGN.md §3.4, D-13, D-14, D-34, D-36).
import { describe, expect, it } from 'vitest';
import { isCcdError } from '../../../src/model/errors.js';
import type { HookEndpoint } from '../../../src/platform/ports.js';
import {
  buildSettingsPlan,
  COMMAND_EVENTS,
  KNOWN_SETTINGS_KEYS,
  MAX_SETTINGS_BYTES,
  NEVER_REGISTERED,
  OBSERVATION_EVENTS,
  validateSettingsPlan,
  type CommandHook,
  type HttpHook,
  type SettingsPlanInput,
} from '../../../src/session/settings-plan.js';

const TOKEN = 'a1'.repeat(32);
const NODE = '/opt/homebrew/Cellar/node/22.23.2/bin/node';
const FWD = '/p/node_modules/claude-code-driver/dist/platform/hook-server/standalone/forward.js';

function endpoint(transport: 'http' | 'unix'): HookEndpoint {
  return {
    transport,
    ...(transport === 'http' ? { http: { port: 45678, urlBase: 'http://127.0.0.1:45678/h/s0000c0de/', token: TOKEN } } : {}),
    unix: { socketPath: '/run/ccd-abc/h.sock', forwarderConfigPath: '/run/ccd-abc/fwd.json' },
    forwarder: { nodePath: NODE, scriptPath: FWD },
  };
}

function input(over: Partial<SettingsPlanInput> = {}): SettingsPlanInput {
  return {
    endpoint: endpoint('http'),
    switches: { preToolUse: true, messageDisplay: true, postToolBatch: false },
    permissionTimeoutS: 330,
    observationTimeoutS: 5,
    messageDisplayTimeoutS: 3,
    crossSessionInbound: 'refuse',
    denyTmuxInBash: false,
    allowedHttpHookUrlsDefined: false,
    writeDisableAllHooksFalse: false,
    ...over,
  };
}

function hook(plan: ReturnType<typeof buildSettingsPlan>, ev: string): CommandHook | HttpHook {
  const h = plan.hooks[ev]?.[0].hooks[0];
  if (h === undefined) throw new Error(`no hook for ${ev}`);
  return h;
}

describe('exact shape (§3.4)', () => {
  it('the http plan matches the documented JSON', () => {
    const plan = buildSettingsPlan(input());
    expect(plan.hooks['SessionStart']).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: NODE, args: [FWD, '/run/ccd-abc/fwd.json', 'SessionStart'], timeout: 5 }] },
    ]);
    expect(plan.hooks['PermissionRequest']).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: NODE, args: [FWD, '/run/ccd-abc/fwd.json', 'PermissionRequest'], timeout: 330 }],
      },
    ]);
    expect(plan.hooks['UserPromptSubmit']).toEqual([
      {
        matcher: '*',
        hooks: [
          { type: 'http', url: 'http://127.0.0.1:45678/h/s0000c0de/UserPromptSubmit', headers: { 'X-CCD-Token': TOKEN }, timeout: 5 },
        ],
      },
    ]);
    const { hooks: _h, ...rest } = plan;
    expect(rest).toEqual({
      spinnerTipsEnabled: false,
      spinnerVerbs: { mode: 'replace', verbs: ['Working'] },
      showTurnDuration: true,
      promptSuggestionEnabled: false,
      feedbackSurveyRate: 0,
      emojiCompletionEnabled: false,
      editorMode: 'normal',
      autoContinueAtUsageLimit: false,
      skillOverrides: { 'auto-mode-setup': 'off' },
      crossSessionInbound: 'refuse',
    });
  });

  it('D-34 event set: defaults register PreToolUse and MessageDisplay, not PostToolBatch', () => {
    const plan = buildSettingsPlan(input());
    const expected = [...COMMAND_EVENTS, ...OBSERVATION_EVENTS.filter((o) => o.event !== 'PostToolBatch').map((o) => o.event)].sort();
    expect(Object.keys(plan.hooks).sort()).toEqual(expected);
  });

  it('starred switches turn PreToolUse / MessageDisplay off and PostToolBatch on', () => {
    const plan = buildSettingsPlan(input({ switches: { preToolUse: false, messageDisplay: false, postToolBatch: true } }));
    expect(plan.hooks['PreToolUse']).toBeUndefined();
    expect(plan.hooks['MessageDisplay']).toBeUndefined();
    expect(plan.hooks['PostToolBatch']).toBeDefined();
  });

  it('P-HOOK-33: observation timeout 5, MessageDisplay 3; PermissionRequest ceil(timeoutMs/1000)+30', () => {
    const plan = buildSettingsPlan(input());
    expect(hook(plan, 'Stop').timeout).toBe(5);
    expect(hook(plan, 'MessageDisplay').timeout).toBe(3);
    expect(hook(plan, 'PermissionRequest').timeout).toBe(330);
  });

  it('transport unix: every event uses the forwarder with the event as last arg (one transport per event, P-REC-17)', () => {
    const plan = buildSettingsPlan(input({ endpoint: endpoint('unix') }));
    for (const [ev, groups] of Object.entries(plan.hooks)) {
      expect(groups).toHaveLength(1);
      const h = groups[0].hooks[0];
      expect(h.type, ev).toBe('command');
      if (h.type === 'command') expect(h.args).toEqual([FWD, '/run/ccd-abc/fwd.json', ev]);
    }
    expect(plan.allowedHttpHookUrls).toBeUndefined();
  });
});

describe('never registered, never set (P-HOOK-18/32/35/36/37, P-DOCS-02)', () => {
  it('blocking / behaviour-replacing events are absent; no async, onFailure, statusMessage, if; matcher *', () => {
    for (const t of ['http', 'unix'] as const) {
      const plan = buildSettingsPlan(
        input({ endpoint: endpoint(t), switches: { preToolUse: true, messageDisplay: true, postToolBatch: true } }),
      );
      for (const ev of NEVER_REGISTERED) expect(plan.hooks[ev], ev).toBeUndefined();
      const text = JSON.stringify(plan);
      for (const k of ['"async"', '"onFailure"', '"statusMessage"', '"if"', '"env"', '"statusLine"']) expect(text).not.toContain(k);
      for (const groups of Object.values(plan.hooks)) expect(groups[0].matcher).toBe('*');
    }
  });

  it('P-HOOK-18: SessionStart is a command hook even with transport http', () => {
    expect(hook(buildSettingsPlan(input()), 'SessionStart').type).toBe('command');
  });
});

describe('conditional keys (D-13, D-14, D-36)', () => {
  it('D-13 / P-HOOK-63 / P-SEC-28: allowedHttpHookUrls only when a layer defines it, exact origin', () => {
    expect(buildSettingsPlan(input()).allowedHttpHookUrls).toBeUndefined();
    expect(buildSettingsPlan(input({ allowedHttpHookUrlsDefined: true })).allowedHttpHookUrls).toEqual(['http://127.0.0.1:45678']);
  });
  it('D-14 / P-SEC-29: disableAllHooks:false only on request', () => {
    expect(buildSettingsPlan(input()).disableAllHooks).toBeUndefined();
    expect(buildSettingsPlan(input({ writeDisableAllHooksFalse: true })).disableAllHooks).toBe(false);
  });
  it('D-36: tmux deny rules only with denyTmuxInBash; crossSessionInbound from config', () => {
    expect(buildSettingsPlan(input()).permissions).toBeUndefined();
    const p = buildSettingsPlan(input({ denyTmuxInBash: true, crossSessionInbound: 'hold' }));
    expect(p.permissions).toEqual({ deny: ['Bash(tmux:*)', 'Bash(*tmux *)'] });
    expect(p.crossSessionInbound).toBe('hold');
  });
  it('only known keys are ever written', () => {
    const p = buildSettingsPlan(input({ denyTmuxInBash: true, allowedHttpHookUrlsDefined: true, writeDisableAllHooksFalse: true }));
    for (const k of Object.keys(p)) expect(KNOWN_SETTINGS_KEYS).toContain(k);
  });
});

describe('validation (P-HOOK-03/22, P-SEC-32/33/39)', () => {
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return isCcdError(e) ? e.code : 'other';
    }
    return undefined;
  };

  it('P-HOOK-22 / P-SEC-32: a $ anywhere or a non-hex token is refused', () => {
    const bad = endpoint('http');
    if (bad.http !== undefined) bad.http.token = '$HOME'.padEnd(64, '0');
    expect(code(() => buildSettingsPlan(input({ endpoint: bad })))).toBe('E_INVARIANT');
    const upper = endpoint('http');
    if (upper.http !== undefined) upper.http.token = 'A1'.repeat(32);
    expect(code(() => buildSettingsPlan(input({ endpoint: upper })))).toBe('E_INVARIANT');
  });

  it('P-SEC-39 / P-SEC-33: the node path must be absolute (no PATH lookup) and paths plain', () => {
    const rel = endpoint('http');
    rel.forwarder.nodePath = 'node';
    expect(code(() => buildSettingsPlan(input({ endpoint: rel })))).toBe('E_INVARIANT');
    const quote = endpoint('unix');
    quote.forwarder.scriptPath = "/x/'; rm -rf ~ '.js";
    expect(code(() => buildSettingsPlan(input({ endpoint: quote })))).toBe('E_INVARIANT');
  });

  it('P-HOOK-03: the serialized file stays below 64 KiB', () => {
    const plan = buildSettingsPlan(input({ switches: { preToolUse: true, messageDisplay: true, postToolBatch: true } }));
    expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThan(MAX_SETTINGS_BYTES);
  });

  it('a tampered plan fails validation (unknown key, wrong url, extra hook key, missing command event)', () => {
    const ep = endpoint('http');
    const mk = (): ReturnType<typeof buildSettingsPlan> => buildSettingsPlan(input({ endpoint: ep }));
    const a = mk() as unknown as Record<string, unknown>;
    a['statusLine'] = {};
    expect(
      code(() => {
        validateSettingsPlan(a as never, ep);
      }),
    ).toBe('E_INVARIANT');
    const b = mk();
    (hook(b, 'Stop') as HttpHook).url = 'http://127.0.0.2:45678/h/s0000c0de/Stop';
    expect(
      code(() => {
        validateSettingsPlan(b, ep);
      }),
    ).toBe('E_INVARIANT');
    const c = mk();
    (hook(c, 'Stop') as unknown as Record<string, unknown>)['async'] = true;
    expect(
      code(() => {
        validateSettingsPlan(c, ep);
      }),
    ).toBe('E_INVARIANT');
    const d = mk();
    Reflect.deleteProperty(d.hooks, 'PermissionRequest');
    expect(
      code(() => {
        validateSettingsPlan(d, ep);
      }),
    ).toBe('E_INVARIANT');
    const e = mk();
    e.hooks['WorktreeCreate'] = e.hooks['Stop'] as never;
    expect(
      code(() => {
        validateSettingsPlan(e, ep);
      }),
    ).toBe('E_INVARIANT');
  });
});
