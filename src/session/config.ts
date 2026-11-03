// session/config.ts — resolveConfig(spec, env, defaults) and the single DEFAULTS table (DESIGN.md §2.6, §2.11, §3.1 step 1,
// §3.3, D-39; AL §12; P-API-19, P-TMUX-56, P-REV-03, P-REV-04, P-REV-27, P-REV-41, P-REV-42).
//
// - The ONLY input is the internal `SessionSpec` (model/spec.ts); nothing here knows the public option names (option-isolation
//   arch test, P-REV-41).
// - Validation is strict: an unknown key anywhere → E_CONFIG_INVALID{reason:'unknownKey', path}; a wrong type or range →
//   E_CONFIG_INVALID{reason, path}; `permissions` missing → E_CONFIG_INVALID{reason:'permissionsRequired'} (P-REV-42).
// - One defaults table (`DEFAULTS`); every default lives here and nowhere else (P-API-19). `CoreConfig` is derived from it.
// - The only I/O is `env.realpath(cwd)` (macOS /var → /private/var, LV Q4) and random ids for the session key / Claude session
//   id; `resolveConfigPure` is the pure core of it.
// - `extraArgs` is checked against the single §3.3 allowlist (argv-builder.ts, pure) so a config that resolves never fails
//   the same check later; the lstat checks of `*-file` values stay in preflight (they need I/O).
// - `debug.claudeDebugFile` stays an advanced opt-in (LP-50/P-REV-27): the file lives in the 0700 session dir and is deleted
//   at close unless `keepClaudeDebugFile` (lifecycle.ts); it holds prompts and Claude creates it 0644.

import { randomBytes, randomUUID } from 'node:crypto';
import { commandsExtras, commandsProfile } from '../channels/profiles/claude-2.1.316/commands.js';
import type { CoreConfig, ResolvedConfig } from '../model/config.js';
import { CcdError } from '../model/errors.js';
import type { CcdErrorCode } from '../model/errors.js';
import type { SessionKey } from '../model/ids.js';
import type { JsonValue } from '../model/json.js';
import type { SessionSpec } from '../model/spec.js';
import type { PermissionMode } from '../model/state.js';
import { SUPPORTED_CLAUDE_VERSION } from '../model/version.js';
import type { EnvPort } from '../platform/ports.js';
import { DANGEROUS_MODES, validateExtraArgs as validateExtraArgsAllowlist } from './argv-builder.js';

// ---------------------------------------------------------------------------------------------------------------- DEFAULTS

export interface ConfigDefaults {
  permissionMode: PermissionMode;
  claude: { expectVersion: string };
  env: { inherit: 'minimal' | 'all'; scrubSubprocessEnv: boolean };
  tmux: { cols: number; rows: number; historyLimit: number };
  permissions: {
    timeoutMs: number;
    onTimeout: 'deny' | 'tui';
    screenAllow: boolean;
    allowDangerousModes: boolean;
    allowAddDirectories: boolean;
    backgroundTimeoutMs: number;
  };
  trust: { mode: 'require' | 'seed'; acceptRisks: boolean };
  input: {
    method: 'editor' | 'pasteChunks';
    mentions: 'allow' | 'reject';
    maxPromptBytes: number;
    whenBusy: 'wait' | 'reject';
    chunkBytes: number;
    chunkGapMs: number;
  };
  hooks: {
    transport: 'auto' | 'http' | 'unix';
    overrideDisableAllHooks: boolean;
    preToolUse: boolean;
    messageDisplay: boolean;
    postToolBatch: boolean;
    /** D-37: PermissionRequest hook timeout = ceil(permissions.timeoutMs / 1000) + this. */
    permissionHookExtraS: number;
    observationTimeoutS: number;
    messageDisplayTimeoutS: number;
  };
  network: { faults: boolean; allowPrivate: boolean; allowPorts: number[] };
  security: {
    denyTmuxInBash: boolean;
    crossSessionInbound: 'accept' | 'hold' | 'refuse';
    mcp: 'inherit' | 'strict';
    onTamper: 'alert' | 'interrupt';
  };
  usageLimit: {
    autoResume: boolean;
    resumePrompt: string;
    jitterMinMs: number;
    jitterMaxMs: number;
    maxRearms: number;
    builtinAutoContinue: boolean;
  };
  lifecycle: { closeGraceMs: number; killAfterMs: number; heartbeatMs: number; ownerWatchPollMs: number };
  selfTest: 'once' | 'always' | 'off';
  debug: {
    raw: 'none' | 'meta' | 'full';
    retainEvents: number;
    claudeDebugFile: boolean;
    keepClaudeDebugFile: boolean;
    captureLimitFixtures: boolean;
  };
  timeouts: CoreConfig['timeouts'];
  channels: CoreConfig['channels']['screen'];
  commands: CoreConfig['commands'];
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** The single defaults table (§2.6, §3.x, §4.10, AL §12). */
export const DEFAULTS: ConfigDefaults = deepFreeze({
  permissionMode: 'default',
  claude: { expectVersion: SUPPORTED_CLAUDE_VERSION },
  env: { inherit: 'minimal', scrubSubprocessEnv: false },
  tmux: { cols: 250, rows: 80, historyLimit: 10_000 },
  permissions: {
    timeoutMs: 120_000,
    onTimeout: 'deny',
    screenAllow: false,
    allowDangerousModes: false,
    allowAddDirectories: false,
    backgroundTimeoutMs: 10_000,
  },
  trust: { mode: 'require', acceptRisks: false },
  input: { method: 'editor', mentions: 'allow', maxPromptBytes: 100_000, whenBusy: 'wait', chunkBytes: 400, chunkGapMs: 30 },
  hooks: {
    transport: 'auto',
    overrideDisableAllHooks: false,
    preToolUse: true,
    messageDisplay: true,
    postToolBatch: false,
    permissionHookExtraS: 30,
    observationTimeoutS: 5,
    messageDisplayTimeoutS: 3,
  },
  network: { faults: false, allowPrivate: false, allowPorts: [443] },
  security: { denyTmuxInBash: false, crossSessionInbound: 'refuse', mcp: 'inherit', onTamper: 'alert' },
  usageLimit: {
    autoResume: true,
    resumePrompt: 'continue',
    jitterMinMs: 30_000,
    jitterMaxMs: 90_000,
    maxRearms: 3,
    builtinAutoContinue: false,
  },
  lifecycle: { closeGraceMs: 12_000, killAfterMs: 3000, heartbeatMs: 10_000, ownerWatchPollMs: 1000 },
  selfTest: 'once',
  debug: { raw: 'meta', retainEvents: 10_000, claudeDebugFile: false, keepClaudeDebugFile: false, captureLimitFixtures: true },
  timeouts: {
    submitAckMs: 3000,
    submitAckFirstExtraMs: 2000,
    submitRetries: 1,
    settleMs: 100,
    escGapMs: 250,
    keyGapMs: 15,
    dialogSettleMs: 150,
    interruptConfirmMs: 5000,
    stopGraceMs: 500,
    transcriptSettleMs: 5000,
    permBindLateMs: 2000,
    hookGapMs: 2000,
    stallMs: 25_000,
    quietMs: 15_000,
    genImplicitConfirmMs: 3000,
    interruptedHoldMs: 1500,
    drainMs: 5000,
    startupHookGraceMs: 3000,
    startupMs: 60_000,
    readyStableMs: 300,
    lateTextMs: 500,
    editorConsumeMs: 3000,
    claimTtlMs: 800,
    claimMinStableMs: 100,
    claimDialogStableMs: 250,
    hostResumeGraceMs: 30_000,
    adoptDialogMs: 500,
    usageWakeCheckMs: 30_000,
    authPollMs: 60_000,
  },
  channels: { busyPollMs: 250, idlePollMs: 2000, retryPollMs: 1000, startupPollMs: 150 },
  commands: {
    allow: [...commandsExtras.allowed],
    deny: [...commandsExtras.denied],
    refuseAlways: [...commandsExtras.refusedAlways],
    aliases: { ...commandsProfile.aliases },
  },
});

// ---------------------------------------------------------------------------------------------------------- constants

/** P-TMUX-56: tmux max width is 10000; we keep a sane window. cols < 120 breaks the classifier (§3.1 step 1). */
export const COLS_MIN = 120;
export const COLS_MAX = 1000;
const ROWS_MIN = 24;
const ROWS_MAX = 1000;

/** Caller `env.set` names that move billing or the model host (BRIEF; §3.2; P-REV-04). */
export const FORBIDDEN_ENV_SET: ReadonlySet<string> = new Set([
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
]);

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

// ------------------------------------------------------------------------------------------------------------- schema

type Schema =
  | { t: 'string'; min?: number; max?: number; abs?: boolean; noCtl?: boolean; re?: RegExp }
  | { t: 'bool' }
  | { t: 'int'; min: number; max: number }
  | { t: 'enum'; v: readonly string[] }
  | { t: 'obj'; k: Readonly<Record<string, Schema>>; required?: readonly string[] }
  | { t: 'strArr'; max?: number }
  | { t: 'strRecord' }
  | { t: 'inherit' }
  | { t: 'network' };

const MS = (max = 86_400_000): Schema => ({ t: 'int', min: 0, max });
const ABS: Schema = { t: 'string', min: 1, max: 1024, abs: true, noCtl: true };
const TOKEN: Schema = { t: 'string', min: 1, max: 256, noCtl: true, re: /^\S+$/ };
const TIMEOUT_KEYS = Object.keys(DEFAULTS.timeouts);

const SPEC_SCHEMA: Schema = {
  t: 'obj',
  required: ['cwd', 'permissions'],
  k: {
    cwd: ABS,
    sessionId: { t: 'string', re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
    resume: { t: 'string', min: 1, max: 128, re: /^[A-Za-z0-9-]+$/ },
    model: TOKEN,
    effort: TOKEN,
    permissionMode: { t: 'enum', v: PERMISSION_MODES },
    extraArgs: { t: 'strArr', max: 64 },
    claude: { t: 'obj', k: { bin: ABS, expectVersion: { t: 'string', min: 1, max: 64, re: /^(any|\d+\.\d+\.\d+)$/ } } },
    env: { t: 'obj', k: { inherit: { t: 'inherit' }, set: { t: 'strRecord' }, scrubSubprocessEnv: { t: 'bool' } } },
    tmux: {
      t: 'obj',
      k: {
        bin: ABS,
        cols: { t: 'int', min: COLS_MIN, max: COLS_MAX },
        rows: { t: 'int', min: ROWS_MIN, max: ROWS_MAX },
        historyLimit: { t: 'int', min: 0, max: 1_000_000 },
      },
    },
    permissions: {
      t: 'obj',
      required: ['policy'],
      k: {
        policy: { t: 'enum', v: ['deny', 'ask', 'allowRead', 'dangerouslyAllowAll', 'handler'] },
        timeoutMs: { t: 'int', min: 1000, max: 86_400_000 },
        onTimeout: { t: 'enum', v: ['deny', 'tui'] },
        screenAllow: { t: 'bool' },
        allowDangerousModes: { t: 'bool' },
        allowAddDirectories: { t: 'bool' },
      },
    },
    trust: { t: 'obj', k: { mode: { t: 'enum', v: ['require', 'seed'] }, acceptRisks: { t: 'bool' } } },
    input: {
      t: 'obj',
      k: {
        method: { t: 'enum', v: ['editor', 'pasteChunks'] },
        mentions: { t: 'enum', v: ['allow', 'reject'] },
        maxPromptBytes: { t: 'int', min: 1, max: 10_000_000 },
        whenBusy: { t: 'enum', v: ['wait', 'reject'] },
      },
    },
    hooks: {
      t: 'obj',
      k: {
        transport: { t: 'enum', v: ['auto', 'http', 'unix'] },
        overrideDisableAllHooks: { t: 'bool' },
        preToolUse: { t: 'bool' },
        messageDisplay: { t: 'bool' },
        postToolBatch: { t: 'bool' },
      },
    },
    network: { t: 'network' },
    security: {
      t: 'obj',
      k: {
        denyTmuxInBash: { t: 'bool' },
        crossSessionInbound: { t: 'enum', v: ['accept', 'hold', 'refuse'] },
        mcp: { t: 'enum', v: ['inherit', 'strict'] },
        onTamper: { t: 'enum', v: ['alert', 'interrupt'] },
      },
    },
    usageLimit: {
      t: 'obj',
      k: {
        autoResume: { t: 'bool' },
        resumePrompt: { t: 'string', min: 1, max: 2000 },
        jitterMinMs: MS(3_600_000),
        jitterMaxMs: MS(3_600_000),
        maxRearms: { t: 'int', min: 0, max: 100 },
        builtinAutoContinue: { t: 'bool' },
      },
    },
    lifecycle: {
      t: 'obj',
      k: { closeGraceMs: MS(600_000), killAfterMs: MS(600_000), stateDir: ABS, runtimeRoot: ABS },
    },
    selfTest: { t: 'enum', v: ['once', 'always', 'off'] },
    idle: { t: 'obj', k: { suspendAfterMs: { t: 'int', min: 1000, max: 7 * 86_400_000 } } },
    debug: {
      t: 'obj',
      k: {
        tracePath: ABS,
        raw: { t: 'enum', v: ['none', 'meta', 'full'] },
        retainEvents: { t: 'int', min: 1, max: 1_000_000 },
        claudeDebugFile: { t: 'bool' },
        keepClaudeDebugFile: { t: 'bool' },
        dumpDir: ABS,
        captureLimitFixtures: { t: 'bool' },
      },
    },
    timeouts: {
      t: 'obj',
      k: Object.fromEntries(TIMEOUT_KEYS.map((k) => [k, k === 'submitRetries' ? { t: 'int', min: 0, max: 10 } : MS()])),
    },
  },
};

const NETWORK_SCHEMA: Schema = { t: 'obj', k: { faults: { t: 'bool' }, allowPrivate: { t: 'bool' } } };

function invalid(reason: string, path: string, extra: Record<string, JsonValue> = {}, code: CcdErrorCode = 'E_CONFIG_INVALID'): CcdError {
  return new CcdError(code, `invalid session options at '${path}': ${reason}`, { details: { reason, path, ...extra } });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v) as unknown;
  return p === Object.prototype || p === null;
}

function check(v: unknown, s: Schema, path: string): void {
  switch (s.t) {
    case 'string': {
      if (typeof v !== 'string') throw invalid('notString', path);
      if (s.min !== undefined && v.length < s.min) throw invalid('tooShort', path);
      if (s.max !== undefined && v.length > s.max) throw invalid('tooLong', path);
      if (v.includes('\0')) throw invalid('controlChar', path);
      if (s.noCtl === true && CONTROL_RE.test(v)) throw invalid('controlChar', path);
      if (s.abs === true && !v.startsWith('/')) throw invalid('notAbsolute', path);
      if (s.re !== undefined && !s.re.test(v)) throw invalid('badFormat', path);
      return;
    }
    case 'bool':
      if (typeof v !== 'boolean') throw invalid('notBoolean', path);
      return;
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) throw invalid('notInteger', path);
      if (v < s.min || v > s.max) throw invalid('outOfRange', path, { min: s.min, max: s.max, value: v });
      return;
    case 'enum':
      if (typeof v !== 'string' || !s.v.includes(v)) throw invalid('notAllowed', path, { allowed: [...s.v] });
      return;
    case 'obj': {
      if (!isPlainObject(v)) throw invalid('notObject', path);
      for (const k of Object.keys(v)) {
        const sub = s.k[k];
        const p = path === '' ? k : `${path}.${k}`;
        if (sub === undefined) throw invalid('unknownKey', p);
        const x = v[k];
        if (x === undefined) continue;
        check(x, sub, p);
      }
      for (const r of s.required ?? []) {
        if (v[r] === undefined) {
          const p = path === '' ? r : `${path}.${r}`;
          if (r === 'permissions' && path === '') throw invalid('permissionsRequired', p);
          throw invalid('required', p);
        }
      }
      return;
    }
    case 'strArr':
      if (!Array.isArray(v)) throw invalid('notArray', path);
      if (s.max !== undefined && v.length > s.max) throw invalid('tooMany', path);
      v.forEach((x, i) => {
        if (typeof x !== 'string') throw invalid('notString', `${path}[${i}]`);
      });
      return;
    case 'strRecord': {
      if (!isPlainObject(v)) throw invalid('notObject', path);
      for (const [k, x] of Object.entries(v)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw invalid('badEnvName', `${path}.${k}`);
        if (typeof x !== 'string') throw invalid('notString', `${path}.${k}`);
        if (x.includes('\0')) throw invalid('controlChar', `${path}.${k}`);
      }
      return;
    }
    case 'inherit': {
      if (v === 'minimal' || v === 'all') return;
      if (!Array.isArray(v)) throw invalid('notAllowed', path, { allowed: ['minimal', 'all', 'string[]'] });
      v.forEach((x, i) => {
        if (typeof x !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(x)) throw invalid('badEnvName', `${path}[${i}]`);
      });
      return;
    }
    case 'network':
      if (v === false) return;
      check(v, NETWORK_SCHEMA, path);
      return;
  }
}

/**
 * §3.3 allowlist (P-REV-03). The ONE allowlist lives in argv-builder.ts (`validateExtraArgs`, pure): flag names classified
 * against the recorded `claude --help` 2.1.316, `--flag value` / `--flag=value` / `-n` forms, no C0/C1 control characters
 * in any value, ≤ 8 KiB, no positional prompt, no lone surrogates, a reason for every refused flag in `details.reason`.
 * The `*-file` rules (absolute, lstat: regular file, no symlink) need I/O and run in preflight (`checkExtraArgFiles`).
 * The caller's elements are returned unchanged: preflight re-validates them, and the canonical form of `--name=--x`
 * (`--name --x`) would not re-validate.
 */
export function validateExtraArgs(args: readonly string[]): string[] {
  validateExtraArgsAllowlist(args);
  return [...args];
}

// -------------------------------------------------------------------------------------------------------------- resolve

export interface ConfigFacts {
  /** realpath(spec.cwd). */
  cwdRealpath: string;
  sessionKey: SessionKey;
  /** A fresh uuid v4, used when neither sessionId nor resume is given. */
  freshSessionId: string;
  env: Readonly<Record<string, string>>;
  homeDir: string;
  platform: 'darwin' | 'linux' | 'other';
  tmpDir: string;
  uid: number;
}

/** Validate + apply DEFAULTS. Pure: every fact it needs is passed in. */
export function resolveConfigPure(spec: SessionSpec, facts: ConfigFacts, defaults: ConfigDefaults = DEFAULTS): ResolvedConfig {
  check(spec, SPEC_SCHEMA, '');
  const D = defaults;
  if (spec.sessionId !== undefined && spec.resume !== undefined) throw invalid('sessionIdAndResume', 'sessionId');
  for (const name of Object.keys(spec.env?.set ?? {})) {
    if (FORBIDDEN_ENV_SET.has(name))
      throw new CcdError('E_FORBIDDEN_ENV', `env.set may not contain ${name}`, { details: { reason: 'forbiddenName', name } });
  }
  const permissions = {
    policy: spec.permissions.policy,
    timeoutMs: spec.permissions.timeoutMs ?? D.permissions.timeoutMs,
    onTimeout: spec.permissions.onTimeout ?? D.permissions.onTimeout,
    screenAllow: spec.permissions.screenAllow ?? D.permissions.screenAllow,
    allowDangerousModes: spec.permissions.allowDangerousModes ?? D.permissions.allowDangerousModes,
    allowAddDirectories: spec.permissions.allowAddDirectories ?? D.permissions.allowAddDirectories,
    backgroundTimeoutMs: D.permissions.backgroundTimeoutMs,
  };
  const permissionMode = spec.permissionMode ?? D.permissionMode;
  if (DANGEROUS_MODES.includes(permissionMode) && !permissions.allowDangerousModes) {
    throw new CcdError('E_MODE_FORBIDDEN', `permissionMode '${permissionMode}' needs permissions.allowDangerousModes`, {
      details: { reason: 'dangerousMode', path: 'permissionMode', mode: permissionMode },
    });
  }
  const usage = {
    autoResume: spec.usageLimit?.autoResume ?? D.usageLimit.autoResume,
    resumePrompt: spec.usageLimit?.resumePrompt ?? D.usageLimit.resumePrompt,
    jitterMinMs: spec.usageLimit?.jitterMinMs ?? D.usageLimit.jitterMinMs,
    jitterMaxMs: spec.usageLimit?.jitterMaxMs ?? D.usageLimit.jitterMaxMs,
    maxRearms: spec.usageLimit?.maxRearms ?? D.usageLimit.maxRearms,
    builtinAutoContinue: spec.usageLimit?.builtinAutoContinue ?? D.usageLimit.builtinAutoContinue,
  };
  if (usage.jitterMaxMs < usage.jitterMinMs) throw invalid('jitterMaxBelowMin', 'usageLimit.jitterMaxMs');
  const extraArgs = validateExtraArgs(spec.extraArgs ?? []);
  const timeouts: CoreConfig['timeouts'] = { ...D.timeouts, ...(spec.timeouts ?? {}) };

  const env = facts.env;
  const configDir =
    env['CLAUDE_CONFIG_DIR'] !== undefined && env['CLAUDE_CONFIG_DIR'] !== '' ? env['CLAUDE_CONFIG_DIR'] : `${facts.homeDir}/.claude`;
  const xdgState = env['XDG_STATE_HOME'];
  const stateDir =
    spec.lifecycle?.stateDir ?? `${xdgState?.startsWith('/') === true ? xdgState : `${facts.homeDir}/.local/state`}/claude-code-driver`;
  const xdgRuntime = env['XDG_RUNTIME_DIR'];
  const runtimeRoot =
    spec.lifecycle?.runtimeRoot ??
    (facts.platform === 'darwin'
      ? facts.tmpDir
      : facts.platform === 'linux' && xdgRuntime?.startsWith('/') === true
        ? xdgRuntime
        : `/tmp/ccd-${facts.uid}`);

  const net = spec.network;
  const network: ResolvedConfig['network'] =
    net === undefined || net === false
      ? false
      : {
          faults: net.faults ?? D.network.faults,
          allowPrivate: net.allowPrivate ?? D.network.allowPrivate,
          allowPorts: [...D.network.allowPorts],
        };

  const inherit = spec.env?.inherit;
  const hooks = {
    transport: spec.hooks?.transport ?? D.hooks.transport,
    overrideDisableAllHooks: spec.hooks?.overrideDisableAllHooks ?? D.hooks.overrideDisableAllHooks,
    postToolBatch: spec.hooks?.postToolBatch ?? D.hooks.postToolBatch,
    permissionHookTimeoutS: Math.ceil(permissions.timeoutMs / 1000) + D.hooks.permissionHookExtraS,
    observationTimeoutS: D.hooks.observationTimeoutS,
    messageDisplayTimeoutS: D.hooks.messageDisplayTimeoutS,
  };
  const security = {
    denyTmuxInBash: spec.security?.denyTmuxInBash ?? D.security.denyTmuxInBash,
    crossSessionInbound: spec.security?.crossSessionInbound ?? D.security.crossSessionInbound,
    mcp: spec.security?.mcp ?? D.security.mcp,
    onTamper: spec.security?.onTamper ?? D.security.onTamper,
  };
  const selfTest = spec.selfTest ?? D.selfTest;
  const input = {
    method: spec.input?.method ?? D.input.method,
    chunkBytes: D.input.chunkBytes,
    chunkGapMs: D.input.chunkGapMs,
    maxPromptBytes: spec.input?.maxPromptBytes ?? D.input.maxPromptBytes,
    mentions: spec.input?.mentions ?? D.input.mentions,
    whenBusyDefault: spec.input?.whenBusy ?? D.input.whenBusy,
  };

  const core: CoreConfig = {
    timeouts,
    permissions,
    input,
    security: { onTamper: security.onTamper },
    usage,
    commands: {
      allow: [...D.commands.allow],
      deny: [...D.commands.deny],
      refuseAlways: [...D.commands.refuseAlways],
      aliases: { ...D.commands.aliases },
    },
    channels: {
      screen: { ...D.channels },
      network: network !== false,
      messageDisplay: spec.hooks?.messageDisplay ?? D.hooks.messageDisplay,
      preToolUse: spec.hooks?.preToolUse ?? D.hooks.preToolUse,
    },
    selfTest,
  };

  const out: ResolvedConfig = {
    sessionKey: facts.sessionKey,
    cwd: spec.cwd,
    cwdRealpath: facts.cwdRealpath,
    claudeSessionId: spec.resume ?? spec.sessionId ?? facts.freshSessionId,
    permissionMode,
    extraArgs,
    claude: { expectVersion: spec.claude?.expectVersion ?? D.claude.expectVersion, configDir },
    env: {
      inherit: inherit === undefined ? D.env.inherit : typeof inherit === 'string' ? inherit : [...inherit],
      set: { ...(spec.env?.set ?? {}) },
      scrubSubprocessEnv: spec.env?.scrubSubprocessEnv ?? D.env.scrubSubprocessEnv,
    },
    tmux: {
      cols: spec.tmux?.cols ?? D.tmux.cols,
      rows: spec.tmux?.rows ?? D.tmux.rows,
      historyLimit: spec.tmux?.historyLimit ?? D.tmux.historyLimit,
    },
    hooks,
    trust: { mode: spec.trust?.mode ?? D.trust.mode, acceptRisks: spec.trust?.acceptRisks ?? D.trust.acceptRisks },
    network,
    security,
    lifecycle: {
      closeGraceMs: spec.lifecycle?.closeGraceMs ?? D.lifecycle.closeGraceMs,
      killAfterMs: spec.lifecycle?.killAfterMs ?? D.lifecycle.killAfterMs,
      heartbeatMs: D.lifecycle.heartbeatMs,
      stateDir,
      runtimeRoot,
      ownerWatchPollMs: D.lifecycle.ownerWatchPollMs,
    },
    debug: {
      raw: spec.debug?.raw ?? D.debug.raw,
      retainEvents: spec.debug?.retainEvents ?? D.debug.retainEvents,
      claudeDebugFile: spec.debug?.claudeDebugFile ?? D.debug.claudeDebugFile,
      keepClaudeDebugFile: spec.debug?.keepClaudeDebugFile ?? D.debug.keepClaudeDebugFile,
      captureLimitFixtures: spec.debug?.captureLimitFixtures ?? D.debug.captureLimitFixtures,
    },
    core,
  };
  if (spec.resume !== undefined) out.resume = spec.resume;
  if (spec.idle?.suspendAfterMs !== undefined) out.idle = { suspendAfterMs: spec.idle.suspendAfterMs };
  if (spec.model !== undefined) out.model = spec.model;
  if (spec.effort !== undefined) out.effort = spec.effort;
  if (spec.claude?.bin !== undefined) out.claude.bin = spec.claude.bin;
  if (spec.tmux?.bin !== undefined) out.tmux.bin = spec.tmux.bin;
  if (spec.debug?.tracePath !== undefined) out.debug.tracePath = spec.debug.tracePath;
  if (spec.debug?.dumpDir !== undefined) out.debug.dumpDir = spec.debug.dumpDir;
  return out;
}

export interface ConfigIds {
  uuidV4(): string;
  shortHex(n: number): string;
}

const nodeIds: ConfigIds = {
  uuidV4: () => randomUUID(),
  shortHex: (n: number) =>
    randomBytes(Math.ceil(n / 2))
      .toString('hex')
      .slice(0, n),
};

/**
 * §2.11 / §3.1 step 1: validate the spec and apply DEFAULTS. Async only for `realpath(cwd)` (the cwd must exist).
 * `ids` mints the session key ('s' + 8 hex) and a fresh Claude session id (default node:crypto).
 */
export async function resolveConfig(
  spec: SessionSpec,
  env: EnvPort,
  defaults: ConfigDefaults = DEFAULTS,
  ids: ConfigIds = nodeIds,
): Promise<ResolvedConfig> {
  if (!isPlainObject(spec)) throw invalid('notObject', '');
  if (typeof spec.cwd !== 'string' || !spec.cwd.startsWith('/')) {
    // validate the rest first so the most specific error wins, then report the cwd
    check(spec, SPEC_SCHEMA, '');
  }
  let cwdRealpath: string;
  try {
    cwdRealpath = await env.realpath(spec.cwd);
  } catch {
    check(spec, SPEC_SCHEMA, '');
    throw invalid('cwdMissing', 'cwd');
  }
  const hex = ids.shortHex(8).toLowerCase();
  const sessionKey = `s${/^[0-9a-f]{8}$/.test(hex) ? hex : nodeIds.shortHex(8)}` as SessionKey;
  return resolveConfigPure(
    spec,
    {
      cwdRealpath,
      sessionKey,
      freshSessionId: ids.uuidV4(),
      env: env.snapshot(),
      homeDir: env.homeDir(),
      platform: env.platform(),
      tmpDir: env.tmpDir(),
      uid: env.uid(),
    },
    defaults,
  );
}
