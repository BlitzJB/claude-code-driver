// api/options.ts — the public options and their mapping onto the internal SessionSpec (DESIGN.md §2.11, §2.12, D-39).
//
// Public option names live only in src/api/** (option-isolation arch test, §1.4 3e, P-REV-41): renaming or regrouping a public
// option touches this file only. `permissions` is required (P-REV-42). `unstable_advanced` is deep-merged over the mapped spec
// after its keys were checked against the SessionSpec groups; value validation is resolveConfig's job (session/config.ts).
//
// Declaration hygiene (§1.3): the public `.d.ts` graph reaches this file through ClaudeSessionOptions, so no exported signature
// here may name the internal spec type. `MappedOptions.spec` is therefore typed as a plain record; claude-session.ts is the one
// place that hands it to createKernel as the SessionSpec it was built as.

import type { SessionSpec } from '../model/spec.js';
import { publicError } from './map-errors.js';
import type { Logger, PermissionHandler, PermissionMode } from './public-types.js';

type NamedPolicy = 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll';

export interface ClaudeSessionOptions {
  cwd: string;
  /** REQUIRED (rev2 §10 E2): 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll' | handler function. */
  permissions:
    | NamedPolicy
    | PermissionHandler
    | { policy: NamedPolicy | PermissionHandler; timeoutMs?: number /* 120_000 */; onTimeout?: 'deny' | 'tui' };
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  sessionId?: string;
  resume?: string;
  /** Allowlisted CLI flags (§3.3). */
  extraArgs?: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- §2.12 verbatim: documents the 'any' value
  claude?: { bin?: string; expectVersion?: string | 'any' };
  env?: { inherit?: 'minimal' | 'all'; set?: Readonly<Record<string, string>> };
  trust?: 'require' | 'seed';
  /** Opt-in CONNECT channel (faults only via unstable_advanced). */
  network?: boolean;
  usageLimit?: { autoResume?: boolean /* true */; resumePrompt?: string /* 'continue' */ };
  /**
   * Stop Claude after the session has been idle (quiescent, no open prompt of any kind) for `suspendAfterMs` (≥ 1000).
   * The next `send`, `command`, `usage` or `setMode` resumes the same conversation first (ICR 0041).
   */
  idle?: { suspendAfterMs?: number };
  debug?: { trace?: string; raw?: 'none' | 'meta' | 'full' };
  /** Operator logger; structured metadata only, never prompt or tool content. */
  logger?: Logger;
  /** Aborting it = close({ mode: 'kill' }). */
  signal?: AbortSignal;
  /** Validated against the internal spec at runtime; unstable, may change in any minor. */
  unstable_advanced?: Readonly<Record<string, unknown>>;
}

/** The result of mapping: the spec (a SessionSpec, see the header) plus what travels beside it. */
export interface MappedOptions {
  readonly spec: Readonly<Record<string, unknown>>;
  readonly handler?: PermissionHandler;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly cwd: string;
  readonly whenBusy: 'wait' | 'reject';
}

const PUBLIC_KEYS: readonly (keyof ClaudeSessionOptions)[] = [
  'cwd',
  'permissions',
  'model',
  'effort',
  'permissionMode',
  'sessionId',
  'resume',
  'extraArgs',
  'claude',
  'env',
  'trust',
  'network',
  'usageLimit',
  'idle',
  'debug',
  'logger',
  'signal',
  'unstable_advanced',
];

/** SessionSpec groups and their keys (§2.11). `null` = a scalar or array field. Used to vet `unstable_advanced`. */
const SPEC_SHAPE: Readonly<Record<keyof SessionSpec, readonly string[] | null>> = {
  cwd: null,
  sessionId: null,
  resume: null,
  model: null,
  effort: null,
  permissionMode: null,
  extraArgs: null,
  selfTest: null,
  timeouts: null, // a Partial<CoreConfig['timeouts']>; its keys are resolveConfig's to check
  claude: ['bin', 'expectVersion'],
  env: ['inherit', 'set', 'scrubSubprocessEnv'],
  tmux: ['bin', 'cols', 'rows', 'historyLimit'],
  permissions: ['policy', 'timeoutMs', 'onTimeout', 'screenAllow', 'allowDangerousModes', 'allowAddDirectories'],
  trust: ['mode', 'acceptRisks'],
  input: ['method', 'mentions', 'maxPromptBytes', 'whenBusy'],
  hooks: ['transport', 'overrideDisableAllHooks', 'preToolUse', 'messageDisplay', 'postToolBatch'],
  network: ['faults', 'allowPrivate'],
  security: ['denyTmuxInBash', 'crossSessionInbound', 'mcp', 'onTamper'],
  usageLimit: ['autoResume', 'resumePrompt', 'jitterMinMs', 'jitterMaxMs', 'maxRearms', 'builtinAutoContinue'],
  lifecycle: ['closeGraceMs', 'killAfterMs', 'stateDir', 'runtimeRoot'],
  idle: ['suspendAfterMs'],
  debug: ['tracePath', 'raw', 'retainEvents', 'claudeDebugFile', 'keepClaudeDebugFile', 'dumpDir', 'captureLimitFixtures'],
};
/** Fields only the stable options may set (an advanced override would bypass their validation here). */
const ADVANCED_FORBIDDEN: ReadonlySet<string> = new Set(['cwd', 'permissions.policy']);

const NAMED: ReadonlySet<string> = new Set<NamedPolicy>(['deny', 'ask', 'allowRead', 'dangerouslyAllowAll']);
const LOG_METHODS = ['debug', 'info', 'warn', 'error'] as const;
const MODES: ReadonlySet<string> = new Set<PermissionMode>(['default', 'acceptEdits', 'plan']);

function invalid(path: string, message: string, reason = 'invalidValue'): never {
  throw publicError('E_CONFIG_INVALID', `invalid option ${path}: ${message}`, { path, detail: reason });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Keys that would reach an object's prototype through a plain assignment (`out[k] = v` in merge). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function checkKeys(v: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(v)) invalid(path, 'must be a plain object');
  for (const k of Object.keys(v)) if (!allowed.includes(k)) invalid(`${path}.${k}`, 'unknown key', 'unknownKey');
  return v;
}

/** Rejects prototype-reaching keys anywhere in an advanced value (free-form groups such as `timeouts` included). */
function checkSafe(v: unknown, path: string): void {
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) checkSafe(x, `${path}.${i}`);
  } else if (typeof v === 'object' && v !== null)
    for (const [k, x] of Object.entries(v)) {
      if (UNSAFE_KEYS.has(k)) invalid(`${path}.${k}`, 'unknown key', 'unknownKey');
      checkSafe(x, `${path}.${k}`);
    }
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) invalid(path, `must be one of ${allowed.join(', ')}`);
  return v as T;
}

function str(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0) invalid(path, 'must be a non-empty string');
  return v;
}

function bool(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') invalid(path, 'must be a boolean');
  return v;
}

/** `T` with every `undefined`-able field made optional and `undefined`-free (exactOptionalPropertyTypes). */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
/** Copies only defined values: an optional field is absent, never `undefined`. */
function defined<T extends object>(o: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Defined<T>;
}

function mapPermissions(p: unknown, path = 'permissions'): { spec: SessionSpec['permissions']; handler?: PermissionHandler } {
  // P-REV-42 / §3.1: no default policy; the sub-reason matches session/config.ts ('permissionsRequired').
  if (p === undefined || p === null)
    invalid(path, 'is required (deny | ask | allowRead | dangerouslyAllowAll | handler)', 'permissionsRequired');
  if (typeof p === 'function') return { spec: { policy: 'handler' }, handler: p as PermissionHandler };
  if (typeof p === 'string') {
    if (!NAMED.has(p)) invalid(path, 'must be deny | ask | allowRead | dangerouslyAllowAll or a handler');
    return { spec: { policy: p as NamedPolicy } };
  }
  if (path !== 'permissions') invalid(path, 'must be deny | ask | allowRead | dangerouslyAllowAll or a handler');
  const o = checkKeys(p, 'permissions', ['policy', 'timeoutMs', 'onTimeout']);
  const inner = mapPermissions(o['policy'], 'permissions.policy');
  const timeoutMs = o['timeoutMs'];
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0))
    invalid('permissions.timeoutMs', 'must be a positive number');
  const spec = defined({ ...inner.spec, timeoutMs, onTimeout: oneOf(o['onTimeout'], 'permissions.onTimeout', ['deny', 'tui']) });
  return inner.handler === undefined ? { spec } : { spec, handler: inner.handler };
}

function mapEnv(v: unknown): SessionSpec['env'] | undefined {
  if (v === undefined) return undefined;
  const o = checkKeys(v, 'env', ['inherit', 'set']);
  const set = o['set'];
  if (set !== undefined) {
    if (!isRecord(set)) invalid('env.set', 'must be a plain object');
    for (const [k, val] of Object.entries(set)) if (typeof val !== 'string') invalid(`env.set.${k}`, 'must be a string');
  }
  return defined({
    inherit: oneOf(o['inherit'], 'env.inherit', ['minimal', 'all']),
    set: set as Readonly<Record<string, string>> | undefined,
  });
}

/** Deep merge of an advanced override into the mapped spec (objects merge, everything else replaces). */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isRecord(b) && isRecord(v) ? merge(b, v) : v;
  }
  return out;
}

function vetAdvanced(adv: unknown): Record<string, unknown> {
  const o = checkKeys(adv, 'unstable_advanced', Object.keys(SPEC_SHAPE));
  checkSafe(o, 'unstable_advanced');
  for (const [k, v] of Object.entries(o)) {
    if (ADVANCED_FORBIDDEN.has(k)) invalid(`unstable_advanced.${k}`, 'is a stable option; set it there', 'stableOnly');
    const group = SPEC_SHAPE[k as keyof SessionSpec];
    if (group === null || (k === 'network' && v === false)) continue;
    const g = checkKeys(v, `unstable_advanced.${k}`, group);
    for (const sub of Object.keys(g))
      if (ADVANCED_FORBIDDEN.has(`${k}.${sub}`)) invalid(`unstable_advanced.${k}.${sub}`, 'is a stable option; set it there', 'stableOnly');
  }
  return o;
}

/** Validates the public options and maps them onto the internal SessionSpec (D-39). Throws ClaudeSessionError E_CONFIG. */
export function toSessionSpec(opts: ClaudeSessionOptions): MappedOptions {
  const o = checkKeys(opts, 'options', PUBLIC_KEYS);
  const cwd = str(o['cwd'], 'cwd') ?? invalid('cwd', 'is required', 'missing');
  const perms = mapPermissions(o['permissions']);
  const extraArgs = o['extraArgs'];
  if (extraArgs !== undefined && (!Array.isArray(extraArgs) || extraArgs.some((a) => typeof a !== 'string')))
    invalid('extraArgs', 'must be an array of strings');
  const claude = o['claude'] === undefined ? undefined : checkKeys(o['claude'], 'claude', ['bin', 'expectVersion']);
  const usage = o['usageLimit'] === undefined ? undefined : checkKeys(o['usageLimit'], 'usageLimit', ['autoResume', 'resumePrompt']);
  const debug = o['debug'] === undefined ? undefined : checkKeys(o['debug'], 'debug', ['trace', 'raw']);
  const idle = o['idle'] === undefined ? undefined : checkKeys(o['idle'], 'idle', ['suspendAfterMs']);
  const suspendAfterMs = idle?.['suspendAfterMs'];
  if (suspendAfterMs !== undefined && (typeof suspendAfterMs !== 'number' || !Number.isInteger(suspendAfterMs) || suspendAfterMs < 1000))
    invalid('idle.suspendAfterMs', 'must be an integer of at least 1000 (ms)');
  const network = bool(o['network'], 'network');
  const trust = oneOf(o['trust'], 'trust', ['require', 'seed']);
  const logger = o['logger'];
  if (
    logger !== undefined &&
    (typeof logger !== 'object' || logger === null || LOG_METHODS.some((m) => typeof (logger as Record<string, unknown>)[m] !== 'function'))
  )
    invalid('logger', 'must have debug, info, warn and error methods');
  const signal = o['signal'];
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal', 'must be an AbortSignal');
  const mode = o['permissionMode'];
  if (mode !== undefined && (typeof mode !== 'string' || !MODES.has(mode)))
    invalid('permissionMode', 'must be default | acceptEdits | plan (dangerous modes only via unstable_advanced)');

  let spec: Record<string, unknown> = defined({
    cwd,
    permissions: perms.spec,
    model: str(o['model'], 'model'),
    effort: str(o['effort'], 'effort'),
    permissionMode: mode,
    sessionId: str(o['sessionId'], 'sessionId'),
    resume: str(o['resume'], 'resume'),
    extraArgs: extraArgs === undefined ? undefined : [...(extraArgs as string[])],
    claude:
      claude === undefined
        ? undefined
        : defined({ bin: str(claude['bin'], 'claude.bin'), expectVersion: str(claude['expectVersion'], 'claude.expectVersion') }),
    env: mapEnv(o['env']),
    trust: trust === undefined ? undefined : { mode: trust },
    network: network === undefined ? undefined : network ? {} : false,
    usageLimit:
      usage === undefined
        ? undefined
        : defined({
            autoResume: bool(usage['autoResume'], 'usageLimit.autoResume'),
            resumePrompt: str(usage['resumePrompt'], 'usageLimit.resumePrompt'),
          }),
    debug:
      debug === undefined
        ? undefined
        : defined({ tracePath: str(debug['trace'], 'debug.trace'), raw: oneOf(debug['raw'], 'debug.raw', ['none', 'meta', 'full']) }),
    idle: suspendAfterMs === undefined ? undefined : { suspendAfterMs },
  });
  if (o['unstable_advanced'] !== undefined) spec = merge(spec, vetAdvanced(o['unstable_advanced']));

  const built = spec as unknown as SessionSpec;
  const whenBusy = built.input?.whenBusy ?? 'wait';
  return defined({
    spec: Object.freeze(spec),
    handler: perms.handler,
    logger: logger as Logger | undefined,
    signal: signal,
    cwd,
    whenBusy,
  });
}

/** A console-backed operator logger (opt-in; the library has no default sink, SEC §8.2). */
export function consoleLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'info'): Logger {
  const order = ['debug', 'info', 'warn', 'error'] as const;
  const min = order.indexOf(level);
  const at =
    (l: (typeof order)[number]) =>
    (m: string, f?: Record<string, unknown>): void => {
      if (order.indexOf(l) < min) return;
      const line = `[claude-code-driver] ${l} ${m}`;
      if (f === undefined) console[l](line);
      else console[l](line, f);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
