// channels/hooks/payload-guards.ts — lenient guards for untrusted hook payloads (DESIGN.md §1.2, §2.8; P-HOOK-44).
// Unknown fields are kept (the raw payload stays reachable through the trace); a guard only checks the fields an
// observation needs. Nothing here throws: every accessor returns `undefined` for a missing or mistyped value.
// The generic JSON accessors are shared with channels/transcript (same layer).

import type { HookExtras } from '../profiles/claude-2.1.316/hooks.js';
import type { AgentRef, BgTaskInfo } from '../../model/observation.js';

export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Own-property read (never walks the prototype chain: `__proto__`, `constructor` in a payload are just keys). */
export function field(o: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

export function str(o: JsonRecord, key: string): string | undefined {
  const v = field(o, key);
  return typeof v === 'string' ? v : undefined;
}

/** A string that is present and non-empty. */
export function nonEmpty(o: JsonRecord, key: string): string | undefined {
  const v = str(o, key);
  return v !== undefined && v.length > 0 ? v : undefined;
}

export function num(o: JsonRecord, key: string): number | undefined {
  const v = field(o, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function bool(o: JsonRecord, key: string): boolean | undefined {
  const v = field(o, key);
  return typeof v === 'boolean' ? v : undefined;
}

export function arr(o: JsonRecord, key: string): readonly unknown[] | undefined {
  const v = field(o, key);
  return Array.isArray(v) ? v : undefined;
}

export function rec(o: JsonRecord, key: string): JsonRecord | undefined {
  const v = field(o, key);
  return isRecord(v) ? v : undefined;
}

/** Text of a caught value; never throws itself (a hostile `toString` must not escape the guard). */
export function errorText(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'unprintable error';
  }
}

/** Copy `value` into `target[key]` only when defined (exactOptionalPropertyTypes: never write `undefined`). */
export function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hook-specific guards
// ---------------------------------------------------------------------------------------------------------------------

/** Fields every hook payload may carry (official-docs.md §1.6). All optional: absence is normal for several of them. */
export interface HookCommon {
  eventName?: string;
  sessionId?: string;
  transcriptPath?: string;
  promptId?: string;
  permissionMode?: string;
  agent?: AgentRef;
}

/** Map a hook `permission_mode` through the profile aliases (`manual` → `default`, P-DOCS-03). */
export function normalizePermissionMode(mode: string | undefined, x: HookExtras): string | undefined {
  if (mode === undefined || mode.length === 0) return undefined;
  const alias = Object.prototype.hasOwnProperty.call(x.permissionModeAliases, mode) ? x.permissionModeAliases[mode] : undefined;
  return alias ?? mode;
}

/**
 * Agent attribution: present when `agent_id` is a non-empty string (inside a subagent, an in-process teammate or
 * `--agent`), or when only `teammate_name` is present. `agent_type` is kept even when it is `''` (internal agents, RC §5.4);
 * `teammate_name` → `teammateName` (§2.4). A teammate without `agent_id` is keyed `teammate:<name>` (§4.5.9), so its
 * tools and messages never attach to the main thread.
 */
export function agentRefOf(p: JsonRecord, x: HookExtras): AgentRef | undefined {
  const F = x.fields;
  const teammateName = nonEmpty(p, F.teammateName);
  const agentId = nonEmpty(p, F.agentId) ?? (teammateName === undefined ? undefined : `${x.teammateKeyPrefix}${teammateName}`);
  if (agentId === undefined) return undefined;
  const ref: AgentRef = { agentId };
  put(ref, 'agentType', str(p, F.agentType));
  put(ref, 'teammateName', teammateName);
  return ref;
}

export function hookCommon(p: JsonRecord, x: HookExtras): HookCommon {
  const F = x.fields;
  const c: HookCommon = {};
  put(c, 'eventName', nonEmpty(p, F.hookEventName));
  put(c, 'sessionId', nonEmpty(p, F.sessionId));
  put(c, 'transcriptPath', nonEmpty(p, F.transcriptPath));
  put(c, 'promptId', nonEmpty(p, F.promptId)); // optional everywhere (P-DOCS-04)
  put(c, 'permissionMode', normalizePermissionMode(str(p, F.permissionMode), x));
  put(c, 'agent', agentRefOf(p, x));
  return c;
}

/**
 * `background_tasks[]` (Stop, SubagentStop). Entries without an `id` are dropped (they cannot be joined); `type`/`status`
 * default to `'unknown'` so a partial entry still counts as pending background work (RC §5.5).
 */
export function backgroundTasksOf(p: JsonRecord, x: HookExtras): BgTaskInfo[] {
  const list = arr(p, x.fields.backgroundTasks);
  if (list === undefined) return [];
  const B = x.bgTaskFields;
  const out: BgTaskInfo[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = nonEmpty(item, B.id);
    if (id === undefined) continue;
    const t: BgTaskInfo = { id, type: nonEmpty(item, B.type) ?? 'unknown', status: nonEmpty(item, B.status) ?? 'unknown' };
    put(t, 'description', str(item, B.description));
    put(t, 'agentType', str(item, B.agentType));
    out.push(t);
  }
  return out;
}

/** Required-field check result: the name of the first missing field, or `undefined` when all are present. */
export function missingString(p: JsonRecord, keys: readonly string[]): string | undefined {
  for (const k of keys) if (nonEmpty(p, k) === undefined) return k;
  return undefined;
}
