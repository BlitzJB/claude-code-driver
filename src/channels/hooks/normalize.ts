// channels/hooks/normalize.ts — RawHookEvent → ObservationInput[] (DESIGN.md §2.8, §2.4 normalizer mapping; RC §2.3).
// Pure and total: never throws, never does I/O or timers, never filters by `session_id` (rev 2 §10 A5: the token
// authenticated the request; the core alone judges generations). Hooks are never de-duplicated (D-42).
// Rejections (P-HOOK-44): `eventMismatch` when the payload's `hook_event_name` differs from the event the transport routed
// it to (URL path / forwarder argv) → no observation; `malformed` when the body is not a JSON object, was truncated, or lacks
// a field the event's observation needs → one `unknown` observation (so the hook still counts as channel liveness).
// The caller (L3) counts both; the transport has already answered 200, except for a held (`holdable`) PermissionRequest:
// one that yields no `permission.requested` (rejected for any reason, or an L1 failure) has no PermissionRecord, so nothing
// in the core would ever answer it — the caller releases it at once (`heldUnclaimed`, ICR 0026), and Claude falls back to its
// native dialog, which the screen adopts (§3.7 step 8; caveats/hooks-transport.md rule 4, fail open).

import type { ClaudeProfile } from '../profiles/index.js';
import { hookExtras as hookExtras2_1_316 } from '../profiles/claude-2.1.316/hooks.js';
import type { HookExtras } from '../profiles/claude-2.1.316/hooks.js';
import type { RawHookEvent } from '../../platform/ports.js';
import type { BgTaskInfo, ObsMeta, Observation, ObservationInput } from '../../model/observation.js';
import {
  agentRefOf,
  arr,
  backgroundTasksOf,
  bool,
  errorText,
  field,
  hookCommon,
  isRecord,
  missingString,
  nonEmpty,
  num,
  put,
  str,
} from './payload-guards.js';
import type { HookCommon, JsonRecord } from './payload-guards.js';
import { parseTaskNotification } from './task-notification.js';

export interface HookNormalizeCtx {
  profile: ClaudeProfile;
} // rev2: no expectedSessionIds (§10 A5)

export interface HookNormalizeResult {
  observations: ObservationInput[];
  rejected?: 'eventMismatch' | 'malformed';
}

/** Version → hook vocabulary not covered by the assembly type (profiles/claude-<v>/hooks.ts `hookExtras`). */
const HOOK_EXTRAS: Readonly<Record<ClaudeProfile['version'], HookExtras>> = Object.freeze({ '2.1.316': hookExtras2_1_316 });

export function hookExtrasFor(profile: ClaudeProfile): HookExtras {
  return HOOK_EXTRAS[profile.version];
}

type Kind = Observation['kind'];
type PayloadOf<K extends Kind> = Extract<Observation, { kind: K }>['p'];
type Meta = Omit<ObsMeta, 'seq'>;

function mk<K extends Kind>(kind: K, meta: Meta, p: PayloadOf<K>): ObservationInput {
  // The mapped ObservationInput union cannot correlate a generic K with its payload; the signature above enforces it.
  return { kind, meta, p } as unknown as ObservationInput;
}

function metaOf(raw: RawHookEvent, common: HookCommon | undefined): Meta {
  const m: Meta = {
    at: raw.at,
    wallAt: raw.wallAt,
    source: 'hook',
    origin: { kind: 'hook', transport: raw.transport, event: raw.event, hookSeq: raw.hookSeq },
  };
  if (common !== undefined) {
    put(m, 'claudeSessionId', common.sessionId);
    put(m, 'agentId', common.agent?.agentId);
  }
  return m;
}

function malformed(raw: RawHookEvent, meta: Meta, reason: string): HookNormalizeResult {
  return {
    observations: [
      mk('unknown', meta, {
        channel: 'hook',
        raw: { event: raw.event, reason, bytes: raw.bytes, truncated: raw.truncated, payload: raw.truncated ? null : raw.payload },
      }),
    ],
    rejected: 'malformed',
  };
}

/** `toolUseIds` of a PostToolBatch (`tool_calls[].tool_use_id`). */
function batchToolUseIds(p: JsonRecord, x: HookExtras): string[] {
  const calls = arr(p, x.fields.toolCalls) ?? [];
  const ids: string[] = [];
  for (const c of calls) {
    if (!isRecord(c)) continue;
    const id = nonEmpty(c, x.fields.toolUseId);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** `bgtask.status{taskType:'teammate'}` for every teammate entry of `background_tasks` (§2.4, D-24). */
function teammateTasks(tasks: readonly BgTaskInfo[], meta: Meta, x: HookExtras): ObservationInput[] {
  return tasks
    .filter((t) => t.type === x.teammateTaskType)
    .map((t) => mk('bgtask.status', meta, { taskId: t.id, taskType: x.teammateTaskType, status: t.status }));
}

/** Map one authenticated, well-formed payload. Returns `undefined` + the missing field name when a required field is absent. */
function mapEvent(
  event: string,
  p: JsonRecord,
  c: HookCommon,
  raw: RawHookEvent,
  meta: Meta,
  x: HookExtras,
): { obs: ObservationInput[] } | { missing: string } {
  const F = x.fields;
  switch (event) {
    case 'SessionStart': {
      // Command hook only (HTTP SessionStart is never sent, LV §Q1). `model` is absent on `source:"clear"`.
      if (c.sessionId === undefined) return { missing: F.sessionId };
      const pl: PayloadOf<'session.started'> = {
        sessionId: c.sessionId,
        transcriptPath: c.transcriptPath ?? '',
        source: nonEmpty(p, F.source) ?? 'unknown',
      };
      put(pl, 'model', nonEmpty(p, F.model));
      return { obs: [mk('session.started', meta, pl)] };
    }
    case 'SessionEnd': {
      // Carries a prompt_id even for /clear (no UPS): never a turn (RC §2.3). Reason `prompt_input_exit` after /exit (LP).
      if (c.sessionId === undefined) return { missing: F.sessionId };
      return { obs: [mk('session.ended', meta, { sessionId: c.sessionId, reason: nonEmpty(p, F.reason) ?? 'other' })] };
    }
    case 'UserPromptSubmit': {
      const text = str(p, F.prompt);
      if (text === undefined) return { missing: F.prompt };
      const pl: PayloadOf<'prompt.submitted'> = { promptId: c.promptId ?? '', text };
      const tn = parseTaskNotification(text, x);
      if (tn !== undefined) {
        const t: NonNullable<PayloadOf<'prompt.submitted'>['taskNotification']> = { taskId: tn.taskId, status: tn.status };
        put(t, 'toolUseId', tn.toolUseId);
        pl.taskNotification = t;
      }
      return { obs: [mk('prompt.submitted', meta, pl)] };
    }
    case 'PreToolUse': {
      const missing = missingString(p, [F.toolName, F.toolUseId]);
      if (missing !== undefined) return { missing };
      const pl: PayloadOf<'tool.pre'> = {
        toolUseId: nonEmpty(p, F.toolUseId) ?? '',
        toolName: nonEmpty(p, F.toolName) ?? '',
        input: field(p, F.toolInput) ?? null,
      };
      // A ghost (internal) agent's PreToolUse may carry the prompt_id of an already stopped turn (P-LIVE-10): passed as is,
      // the core never reopens a turn from it (P-REC-15).
      put(pl, 'promptId', c.promptId);
      put(pl, 'agent', c.agent);
      return { obs: [mk('tool.pre', meta, pl)] };
    }
    case 'PostToolUse': {
      const missing = missingString(p, [F.toolName, F.toolUseId]);
      if (missing !== undefined) return { missing };
      const response = field(p, F.toolResponse);
      const pl: PayloadOf<'tool.post'> = {
        toolUseId: nonEmpty(p, F.toolUseId) ?? '',
        toolName: nonEmpty(p, F.toolName) ?? '',
        response: response ?? null,
      };
      put(pl, 'input', field(p, F.toolInput));
      put(pl, 'durationMs', num(p, F.durationMs));
      put(pl, 'agent', c.agent);
      // Background Agent: `tool_response.status === 'async_launched'` → the tool ends, the agent does not (P-REC-06).
      if (isRecord(response) && str(response, x.agentResponse.status) === x.agentResponse.asyncLaunched) {
        put(pl, 'asyncAgentId', nonEmpty(response, x.agentResponse.agentId));
      }
      return { obs: [mk('tool.post', meta, pl)] };
    }
    case 'PostToolUseFailure': {
      const missing = missingString(p, [F.toolName, F.toolUseId]);
      if (missing !== undefined) return { missing };
      const pl: PayloadOf<'tool.failed'> = {
        toolUseId: nonEmpty(p, F.toolUseId) ?? '',
        toolName: nonEmpty(p, F.toolName) ?? '',
        error: str(p, F.error) ?? '',
      };
      put(pl, 'isInterrupt', bool(p, F.isInterrupt));
      put(pl, 'agent', c.agent);
      return { obs: [mk('tool.failed', meta, pl)] };
    }
    case 'PostToolBatch': {
      const pl: PayloadOf<'tool.batchDone'> = { toolUseIds: batchToolUseIds(p, x) };
      put(pl, 'agent', c.agent);
      return { obs: [mk('tool.batchDone', meta, pl)] };
    }
    case 'PermissionRequest': {
      // No tool_use_id (binding is the core's job, §4.5.1); agent_id only when present (P-REC-44, LP-22).
      const toolName = nonEmpty(p, F.toolName);
      if (toolName === undefined) return { missing: F.toolName };
      const pl: PayloadOf<'permission.requested'> = {
        hookSeq: raw.hookSeq,
        toolName,
        input: field(p, F.toolInput) ?? null,
        suggestions: [...(arr(p, F.permissionSuggestions) ?? [])],
      };
      put(pl, 'promptId', c.promptId);
      put(pl, 'agent', c.agent);
      put(pl, 'permissionMode', c.permissionMode);
      // Answered `{}` at once by the transport (over maxHeld, or not unix): not held, the native dialog follows (ICR 0018).
      if (!raw.holdable) pl.holdable = false;
      return { obs: [mk('permission.requested', meta, pl)] };
    }
    case 'PermissionDenied': {
      const missing = missingString(p, [F.toolName, F.toolUseId]);
      if (missing !== undefined) return { missing };
      return {
        obs: [
          mk('permission.autoDenied', meta, {
            toolUseId: nonEmpty(p, F.toolUseId) ?? '',
            toolName: nonEmpty(p, F.toolName) ?? '',
            reason: str(p, F.reason) ?? '',
          }),
        ],
      };
    }
    case 'Stop': {
      const tasks = backgroundTasksOf(p, x);
      const pl: PayloadOf<'turn.stopped'> = { backgroundTasks: tasks, stopHookActive: bool(p, F.stopHookActive) ?? false };
      put(pl, 'promptId', c.promptId);
      put(pl, 'lastAssistantMessage', str(p, F.lastAssistantMessage));
      // ICR 0041: in-session scheduled tasks (/loop, cron) live inside the Claude process; a suspend would cancel them
      const crons = arr(p, F.sessionCrons);
      if (crons !== undefined) pl.sessionCrons = crons.length;
      return { obs: [mk('turn.stopped', meta, pl), ...teammateTasks(tasks, meta, x)] };
    }
    case 'StopFailure': {
      const pl: PayloadOf<'turn.failed'> = { error: nonEmpty(p, F.error) ?? 'unknown' };
      put(pl, 'promptId', c.promptId);
      put(pl, 'errorDetails', str(p, F.errorDetails));
      put(pl, 'message', str(p, F.lastAssistantMessage));
      return { obs: [mk('turn.failed', meta, pl)] };
    }
    case 'SubagentStart': {
      const agent = agentRefOf(p, x);
      if (agent === undefined) return { missing: F.agentId };
      const pl: PayloadOf<'agent.started'> = { agent };
      put(pl, 'promptId', c.promptId); // the *current* main prompt, never the cause (P-REC-01/45)
      return { obs: [mk('agent.started', meta, pl)] };
    }
    case 'SubagentStop': {
      // agent_type '' for internal agents (the transcript file may never exist, P-TAIL-34); background_tasks may list the
      // stopping agent itself (the core ignores self entries, P-REC-08).
      const agent = agentRefOf(p, x);
      if (agent === undefined) return { missing: F.agentId };
      const tasks = backgroundTasksOf(p, x);
      const pl: PayloadOf<'agent.stopped'> = { agent, backgroundTasks: tasks };
      put(pl, 'transcriptPath', nonEmpty(p, F.agentTranscriptPath));
      put(pl, 'lastAssistantMessage', str(p, F.lastAssistantMessage));
      return { obs: [mk('agent.stopped', meta, pl), ...teammateTasks(tasks, meta, x)] };
    }
    case 'MessageDisplay': {
      // UI ids, not joinable to the transcript (P-REC-09). The final delta may be empty.
      const missing = missingString(p, [F.turnId, F.messageId]);
      if (missing !== undefined) return { missing };
      const pl: PayloadOf<'message.textDelta'> = {
        uiTurnId: nonEmpty(p, F.turnId) ?? '',
        uiMessageId: nonEmpty(p, F.messageId) ?? '',
        index: num(p, F.index) ?? 0,
        final: bool(p, F.final) ?? false,
        delta: str(p, F.delta) ?? '',
      };
      put(pl, 'promptId', c.promptId);
      return { obs: [mk('message.textDelta', meta, pl)] };
    }
    case 'Notification': {
      const type = nonEmpty(p, F.notificationType) ?? 'unknown';
      const message = str(p, F.message);
      const has = (t: Readonly<Record<string, unknown>>): boolean => Object.prototype.hasOwnProperty.call(t, type);
      if (has(x.inputCleared)) {
        const cl = x.inputCleared[type];
        if (cl !== undefined) return { obs: [mk('input.requestCleared', meta, { kind: cl.kind, how: cl.how })] };
      }
      const n: PayloadOf<'notification'> = { type };
      put(n, 'message', message);
      const out: ObservationInput[] = [];
      if (has(x.inputRequested)) {
        const kind = x.inputRequested[type];
        if (kind !== undefined) {
          const ir: PayloadOf<'input.requested'> = { kind };
          put(ir, 'message', message);
          put(ir, 'server', nonEmpty(p, F.serverName) ?? nonEmpty(p, F.mcpServerName));
          out.push(mk('input.requested', meta, ir));
        }
      }
      // `quota_auto_resume_*` stays a plain notification: the core interprets it (§3.9).
      out.push(mk('notification', meta, n));
      return { obs: out };
    }
    case 'PreCompact':
    case 'PostCompact': {
      const pl: PayloadOf<'compact.phase'> = { phase: event === 'PreCompact' ? x.compactPhases.PreCompact : x.compactPhases.PostCompact };
      put(pl, 'trigger', nonEmpty(p, F.trigger));
      return { obs: [mk('compact.phase', meta, pl)] };
    }
    case 'PostModelSwitch': {
      const toModel = nonEmpty(p, F.toModel);
      if (toModel === undefined) return { missing: F.toModel };
      const pl: PayloadOf<'model.switched'> = { toModel };
      put(pl, 'fromModel', nonEmpty(p, F.fromModel));
      put(pl, 'source', nonEmpty(p, F.source));
      return { obs: [mk('model.switched', meta, pl)] };
    }
    case 'ConfigChange': {
      // Hot reload of settings/skills mid-session → surfaced to the host (P-SEC-30).
      const pl: PayloadOf<'config.changed'> = { source: nonEmpty(p, F.source) ?? 'unknown' };
      put(pl, 'filePath', nonEmpty(p, F.filePath));
      return { obs: [mk('config.changed', meta, pl)] };
    }
    case 'CwdChanged': {
      const missing = missingString(p, [F.newCwd]);
      if (missing !== undefined) return { missing };
      return { obs: [mk('cwd.changed', meta, { oldCwd: str(p, F.oldCwd) ?? '', newCwd: nonEmpty(p, F.newCwd) ?? '' })] };
    }
    default:
      // Open world: an event this profile does not map (a never-registered event cannot reach us through our own
      // registration, so this is a version drift signal) → passthrough.
      return { obs: [mk('unknown', meta, { channel: 'hook', raw: { event, payload: p } })] };
  }
}

/**
 * True when `raw` is a held request (`holdable`) that `res` does not hand to the core as a `permission.requested`: no record
 * will ever carry its hookSeq, so the caller must release it (`HookTransport.respond(hookSeq, null)`) instead of leaving the
 * forwarder blocked (and a `maxHeld` slot used) until Claude's own hook timeout. `res` undefined = the normalizer failed.
 */
export function heldUnclaimed(raw: RawHookEvent, res: HookNormalizeResult | undefined): boolean {
  if (!raw.holdable) return false;
  return !(res?.observations.some((o) => o.kind === 'permission.requested') ?? false);
}

export function normalizeHook(raw: RawHookEvent, ctx: HookNormalizeCtx): HookNormalizeResult {
  try {
    return normalizeHookUnsafe(raw, ctx);
  } catch (err) {
    // L1 never throws (§2.8, P-REC-20): an internal failure on a hostile payload is reported like a malformed body, so the
    // hook still counts as channel liveness and the trace shows why. The payload is not echoed (it is what failed).
    const meta: Meta = {
      at: raw.at,
      wallAt: raw.wallAt,
      source: 'hook',
      origin: { kind: 'hook', transport: raw.transport, event: raw.event, hookSeq: raw.hookSeq },
    };
    return {
      observations: [
        mk('unknown', meta, {
          channel: 'hook',
          raw: {
            event: raw.event,
            reason: 'normalizerError',
            message: errorText(err),
            bytes: raw.bytes,
            truncated: raw.truncated,
            payload: null,
          },
        }),
      ],
      rejected: 'malformed',
    };
  }
}

function normalizeHookUnsafe(raw: RawHookEvent, ctx: HookNormalizeCtx): HookNormalizeResult {
  const x = hookExtrasFor(ctx.profile);
  if (raw.truncated) return malformed(raw, metaOf(raw, undefined), 'truncated');
  const payload: unknown = raw.payload;
  if (!isRecord(payload)) return malformed(raw, metaOf(raw, undefined), 'notObject');

  const common = hookCommon(payload, x);
  const meta = metaOf(raw, common);
  // P-HOOK-44: the payload's own event name must equal the routed event. Absent → lenient (the route is authenticated).
  if (common.eventName !== undefined && common.eventName !== raw.event) return { observations: [], rejected: 'eventMismatch' };

  const r = mapEvent(raw.event, payload, common, raw, meta, x);
  if ('missing' in r) return malformed(raw, meta, `missing:${r.missing}`);

  // Permission-mode fact only from events that carry it (P-DOCS-03); `manual` already mapped to `default`.
  const obs = r.obs;
  if (common.permissionMode !== undefined) obs.push(mk('mode.observed', meta, { permissionMode: common.permissionMode }));
  return { observations: obs };
}
