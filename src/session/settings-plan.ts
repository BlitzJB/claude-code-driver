// session/settings-plan.ts — the injected `--settings` file, exact shape (DESIGN.md §3.4, D-13, D-14, D-34, D-36).
//
// Pitfalls handled here (§5):
//   P-HOOK-03  regular file; serialized size asserted < 64 KiB (Claude's limit is 2 MiB)
//   P-HOOK-18  SessionStart (and PermissionRequest) always use the command forwarder; Setup never registered
//   P-HOOK-22, P-SEC-32  header token written literally, lowercase hex only, no `$` anywhere in the plan
//   P-HOOK-32  no `async` hooks
//   P-HOOK-33  observation hooks `timeout:5`, MessageDisplay `timeout:3`
//   P-HOOK-35  PreModelSwitch never registered
//   P-HOOK-36  WorktreeCreate / WorktreeRemove never registered
//   P-HOOK-37  no `onFailure`
//   P-HOOK-63, P-SEC-28  `allowedHttpHookUrls` only when a readable layer defines it, then the exact origin (D-13)
//   P-SEC-29   `disableAllHooks:false` only with `overrideDisableAllHooks` (D-14)
//   P-SEC-33   exec form (`command` + `args`), never a shell string; paths validated
//   P-SEC-39   `command` is the absolute `process.execPath`, never a PATH lookup of `node`
//   P-REC-17   one transport per event (an event is registered exactly once)
//   P-DOCS-02  matcher `*`, never an `if`

import type { HookEndpoint } from '../platform/ports.js';
import { CcdError } from '../model/errors.js';

/** Always delivered through the command forwarder (HTTP is unsupported for SessionStart; PermissionRequest is held over unix). */
export const COMMAND_EVENTS: readonly string[] = Object.freeze(['SessionStart', 'PermissionRequest']);

/** The observation events (D-34). `switch` names the CoreConfig/spec switch that may turn them off (starred in §3.4). */
export const OBSERVATION_EVENTS: readonly { event: string; switch?: 'preToolUse' | 'messageDisplay' | 'postToolBatch'; short?: boolean }[] =
  Object.freeze([
    { event: 'UserPromptSubmit' },
    { event: 'PreToolUse', switch: 'preToolUse' },
    { event: 'PostToolUse' },
    { event: 'PostToolUseFailure' },
    { event: 'Stop' },
    { event: 'StopFailure' },
    { event: 'SubagentStart' },
    { event: 'SubagentStop' },
    { event: 'Notification' },
    { event: 'PreCompact' },
    { event: 'PostCompact' },
    { event: 'SessionEnd' },
    { event: 'PermissionDenied' },
    { event: 'MessageDisplay', switch: 'messageDisplay', short: true },
    { event: 'PostModelSwitch' },
    { event: 'ConfigChange' },
    { event: 'CwdChanged' },
    { event: 'PostToolBatch', switch: 'postToolBatch' },
  ]);

/** Never registered (§3.4): blocking or behaviour-replacing hooks, agent teams, low-value events. */
export const NEVER_REGISTERED: readonly string[] = Object.freeze([
  'WorktreeCreate',
  'WorktreeRemove',
  'PreModelSwitch',
  'Setup',
  'FileChanged',
  'UserPromptExpansion',
  'Elicitation',
  'ElicitationResult',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'InstructionsLoaded',
  'DirectoryAdded',
]);

/** The only top-level keys the plan may write; each exists in the 2.1.316 binary (§3.4). Unknown keys would open a Settings Error. */
export const KNOWN_SETTINGS_KEYS: readonly string[] = Object.freeze([
  'hooks',
  'spinnerTipsEnabled',
  'spinnerVerbs',
  'showTurnDuration',
  'promptSuggestionEnabled',
  'feedbackSurveyRate',
  'emojiCompletionEnabled',
  'editorMode',
  'autoContinueAtUsageLimit',
  'skillOverrides',
  'crossSessionInbound',
  'permissions',
  'allowedHttpHookUrls',
  'disableAllHooks',
]);

const HOOK_ENTRY_KEYS: Readonly<Record<'command' | 'http', readonly string[]>> = Object.freeze({
  command: ['type', 'command', 'args', 'timeout'],
  http: ['type', 'url', 'headers', 'timeout'],
});

/** P-HOOK-03: our file stays far below Claude's 2 MiB cap. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

export interface CommandHook {
  type: 'command';
  command: string;
  args: string[];
  timeout: number;
}
export interface HttpHook {
  type: 'http';
  url: string;
  headers: { 'X-CCD-Token': string };
  timeout: number;
}
export type HookEntry = CommandHook | HttpHook;
export interface HookGroup {
  matcher: '*';
  hooks: [HookEntry];
}

export interface SettingsPlan {
  hooks: Record<string, [HookGroup]>;
  spinnerTipsEnabled: false;
  spinnerVerbs: { mode: 'replace'; verbs: ['Working'] };
  showTurnDuration: true;
  promptSuggestionEnabled: false;
  feedbackSurveyRate: 0;
  emojiCompletionEnabled: false;
  editorMode: 'normal';
  autoContinueAtUsageLimit: false;
  skillOverrides: { 'auto-mode-setup': 'off' };
  crossSessionInbound: 'accept' | 'hold' | 'refuse';
  permissions?: { deny: string[] };
  allowedHttpHookUrls?: [string];
  disableAllHooks?: false;
}

export interface SettingsPlanInput {
  endpoint: HookEndpoint;
  switches: { preToolUse: boolean; messageDisplay: boolean; postToolBatch: boolean };
  /** `ceil(permissions.timeoutMs/1000) + 30` (ResolvedConfig.hooks.permissionHookTimeoutS). */
  permissionTimeoutS: number;
  observationTimeoutS: number;
  messageDisplayTimeoutS: number;
  crossSessionInbound: 'accept' | 'hold' | 'refuse';
  denyTmuxInBash: boolean;
  /** D-13: true only when a readable user/project/local layer defines `allowedHttpHookUrls` (and the transport is http). */
  allowedHttpHookUrlsDefined: boolean;
  /** D-14: true only with `hooks.overrideDisableAllHooks` and some layer setting `disableAllHooks:true`. */
  writeDisableAllHooksFalse: boolean;
}

const SAFE_ABS_PATH = /^\/[A-Za-z0-9/._@+ -]+$/;
const EVENT_RE = /^[A-Z][A-Za-z]+$/;

function commandHook(endpoint: HookEndpoint, event: string, timeout: number): CommandHook {
  return {
    type: 'command',
    command: endpoint.forwarder.nodePath,
    args: [endpoint.forwarder.scriptPath, endpoint.unix.forwarderConfigPath, event],
    timeout,
  };
}

function httpHook(endpoint: HookEndpoint, event: string, timeout: number): HttpHook {
  const http = endpoint.http;
  if (http === undefined) throw new CcdError('E_INVARIANT', 'http transport without an http endpoint');
  return { type: 'http', url: `${http.urlBase}${event}`, headers: { 'X-CCD-Token': http.token }, timeout };
}

/** Build the plan (pure). `validateSettingsPlan` runs on the result before it is returned. */
export function buildSettingsPlan(i: SettingsPlanInput): SettingsPlan {
  const ep = i.endpoint;
  const hooks: Record<string, [HookGroup]> = {};
  const group = (h: HookEntry): [HookGroup] => [{ matcher: '*', hooks: [h] }];
  hooks['SessionStart'] = group(commandHook(ep, 'SessionStart', i.observationTimeoutS));
  hooks['PermissionRequest'] = group(commandHook(ep, 'PermissionRequest', i.permissionTimeoutS));
  for (const o of OBSERVATION_EVENTS) {
    if (o.switch !== undefined && !i.switches[o.switch]) continue;
    const timeout = o.short === true ? i.messageDisplayTimeoutS : i.observationTimeoutS;
    hooks[o.event] = group(ep.transport === 'http' ? httpHook(ep, o.event, timeout) : commandHook(ep, o.event, timeout));
  }
  const plan: SettingsPlan = {
    hooks,
    spinnerTipsEnabled: false,
    spinnerVerbs: { mode: 'replace', verbs: ['Working'] },
    showTurnDuration: true,
    promptSuggestionEnabled: false,
    feedbackSurveyRate: 0,
    emojiCompletionEnabled: false,
    editorMode: 'normal',
    autoContinueAtUsageLimit: false,
    skillOverrides: { 'auto-mode-setup': 'off' },
    crossSessionInbound: i.crossSessionInbound,
  };
  if (i.denyTmuxInBash) plan.permissions = { deny: ['Bash(tmux:*)', 'Bash(*tmux *)'] };
  if (i.allowedHttpHookUrlsDefined && ep.transport === 'http' && ep.http !== undefined)
    plan.allowedHttpHookUrls = [`http://127.0.0.1:${ep.http.port}`];
  if (i.writeDisableAllHooksFalse) plan.disableAllHooks = false;
  validateSettingsPlan(plan, ep);
  return plan;
}

function invariant(msg: string): never {
  throw new CcdError('E_INVARIANT', `settings plan: ${msg}`);
}

function containsDollar(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('$');
  if (Array.isArray(v)) return v.some(containsDollar);
  if (typeof v === 'object' && v !== null) return Object.entries(v).some(([k, x]) => k.includes('$') || containsDollar(x));
  return false;
}

/** Structural checks of §3.4 (a bug here would open Claude's Settings Error dialog and block startup, LC §1.1). */
export function validateSettingsPlan(plan: SettingsPlan, ep: HookEndpoint): void {
  for (const k of Object.keys(plan)) if (!KNOWN_SETTINGS_KEYS.includes(k)) invariant(`unknown key ${k}`);
  if (containsDollar(plan)) invariant('`$` in a value (header interpolation would blank it, P-SEC-32)');
  if (!SAFE_ABS_PATH.test(ep.forwarder.nodePath)) invariant('forwarder node path must be absolute and plain (P-SEC-39)');
  if (!SAFE_ABS_PATH.test(ep.forwarder.scriptPath)) invariant('forwarder script path must be absolute and plain');
  if (!SAFE_ABS_PATH.test(ep.unix.forwarderConfigPath)) invariant('fwd.json path must be absolute and plain');
  const events = Object.keys(plan.hooks);
  for (const ev of events) {
    if (!EVENT_RE.test(ev)) invariant(`bad event name ${ev}`);
    if (NEVER_REGISTERED.includes(ev)) invariant(`${ev} must never be registered`);
    const groups = plan.hooks[ev];
    if (groups?.length !== 1) invariant(`${ev}: exactly one group (one transport per event, P-REC-17)`);
    // Runtime check of what the types promise: the plan may have been tampered with after build (defence in depth).
    const g = groups[0] as { matcher: string; hooks: HookEntry[] };
    if (g.matcher !== '*' || Object.keys(g).some((k) => k !== 'matcher' && k !== 'hooks'))
      invariant(`${ev}: matcher must be '*' and no 'if'`);
    const h = g.hooks[0];
    if (h === undefined || g.hooks.length !== 1) invariant(`${ev}: exactly one hook`);
    const allowedKeys = HOOK_ENTRY_KEYS[h.type];
    for (const k of Object.keys(h))
      if (!allowedKeys.includes(k)) invariant(`${ev}: hook key ${k} not allowed (no async/onFailure/statusMessage)`);
    if (!Number.isInteger(h.timeout) || h.timeout < 1 || h.timeout > 86_400) invariant(`${ev}: timeout must be a positive integer`);
    if (h.type === 'command') {
      if (h.command !== ep.forwarder.nodePath) invariant(`${ev}: command must be the absolute node path`);
      if (h.args.length !== 3 || h.args[2] !== ev) invariant(`${ev}: forwarder args`);
    } else {
      if (ep.transport !== 'http' || ep.http === undefined) invariant(`${ev}: http hook with a unix transport`);
      if (COMMAND_EVENTS.includes(ev)) invariant(`${ev} must use the command forwarder`);
      if (!/^[0-9a-f]{64}$/.test(h.headers['X-CCD-Token'])) invariant('token must be 64 lowercase hex chars');
      const url = new URL(h.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(ep.http.port))
        invariant(`${ev}: url must be 127.0.0.1:<port>`);
      if (h.url !== `${ep.http.urlBase}${ev}`) invariant(`${ev}: url path`);
    }
  }
  for (const ev of COMMAND_EVENTS) if (!events.includes(ev)) invariant(`${ev} missing`);
  const bytes = Buffer.byteLength(JSON.stringify(plan));
  if (bytes >= MAX_SETTINGS_BYTES) invariant(`serialized size ${bytes} ≥ ${MAX_SETTINGS_BYTES} bytes (P-HOOK-03)`);
}
