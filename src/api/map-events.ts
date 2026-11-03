// api/map-events.ts — DomainEvent → public SessionEvent (DESIGN.md §2.12 mapping discipline, AL §6.4).
// Exhaustive switch ending in assertNever: a new DomainEvent is a compile error until it is mapped or deliberately dropped.
// Not exposed (§2.12): claim.*, internal agents, teammates and their tools/calls, self-test turns, bookkeeping events.

import { CCD_ERROR_CODES, PUBLIC_CODE_OF } from '../model/errors.js';
import type { DomainEvent } from '../model/events.js';
import type { AgentKey } from '../model/ids.js';
import type { PromptOrigin } from '../model/observation.js';
import type { SessionState, ToolRun } from '../model/state.js';
import { fromErrorData } from './map-errors.js';
import { outcomeError } from './outcome-error.js';

export { outcomeError } from './outcome-error.js';
import {
  assertNever,
  isPublicAgent,
  isPublicTool,
  opt,
  toMode,
  toProvenance,
  toStatus,
  toSubagentSnapshot,
  toToolSnapshot,
  turnText,
  type MapCtx,
} from './map-state.js';
import type { PermissionRequest, SessionEvent, SessionEventOf, SessionEventType, SubagentKey, TurnResult } from './public-types.js';

export type EventCtx = MapCtx;

type Data<T extends SessionEventType> = SessionEventOf<T>['data'];

const EXTERNAL_KIND: Readonly<Record<PromptOrigin, Data<'externalTurn'>['kind'] | undefined>> = {
  human: 'human',
  bash_mode: 'human',
  task_notification: 'taskNotification',
  scheduled: 'scheduled',
  auto_continue: 'autoContinue',
  peer_message: 'unknown',
  unknown: 'unknown',
  library: undefined,
  selftest: undefined,
};

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(CCD_ERROR_CODES);

/**
 * The public TurnResult of a `turn.ended` event. Outcome, error, text and duration come from the event; the turn's tool list is
 * read against `d`, the state the kernel hands over with the batch (the state at flush time, or the current state for a ring
 * replay), so a tool resolved after the turn ended may already show its later state.
 */
export function toTurnResult(e: Extract<DomainEvent, { type: 'turn.ended' }>, d: SessionState, ctx: MapCtx): TurnResult {
  const key = e.turnKey ?? ('' as NonNullable<typeof e.turnKey>);
  const t = d.turns[key];
  const p = e.payload;
  const error = p.error !== undefined ? fromErrorData(p.error) : p.outcome === 'completed' ? undefined : outcomeError(p.outcome, p.endedBy);
  const started = t?.acceptedAt ?? t?.queuedAt;
  const tools = (t?.tools ?? []).map((k) => d.tools[k]).filter((r): r is ToolRun => r !== undefined && isPublicTool(d, r));
  return {
    turnKey: key,
    outcome: p.outcome,
    text: p.finalText ?? (t === undefined ? '' : turnText(d, t)),
    refused: p.refused ?? false,
    tools: tools.map((r) => toToolSnapshot(d, r, ctx)),
    durationMs: p.durationMs ?? (t?.endedAt !== undefined && started !== undefined ? Math.max(0, t.endedAt - started) : 0),
    ...opt('error', error),
  };
}

function agentHidden(d: SessionState, a: AgentKey | undefined): boolean {
  return a !== undefined && !isPublicAgent(d.agents[a]);
}

/** Maps one domain event; returns [] for events that are deliberately internal. `e.replayed` filtering is the caller's job. */
export function toPublicEvents(e: DomainEvent, d: SessionState, ctx: EventCtx): SessionEvent[] {
  const head = { seq: e.seq, at: e.wallAt, provenance: toProvenance(e.provenance), ...opt('turnKey', e.turnKey) };
  const one = <T extends SessionEventType>(type: T, data: Data<T>): SessionEvent[] => [{ ...head, type, data } as SessionEvent];
  const t = ctx.time;
  switch (e.type) {
    case 'session.ready':
      return one('ready', { mode: toMode(e.payload.permissionMode), ...opt('model', e.payload.model) });
    case 'session.generationChanged':
      return one('claudeSessionChanged', { to: e.payload.to, reason: e.payload.reason, ...opt('from', e.payload.from) });
    case 'session.authRequired':
      return one('authRequired', { message: e.payload.message });
    case 'session.authRestored':
      return one('authRestored', {});
    case 'session.exited':
      return one('exited', { exitStatus: e.payload.exitStatus, signal: e.payload.signal, reason: e.payload.reason });
    case 'session.suspended':
      return one('suspended', { claudeSessionId: e.payload.claudeSessionId, reason: e.payload.reason, interrupted: e.payload.interrupted });
    case 'session.resumed':
      return one('resumed', { claudeSessionId: e.payload.claudeSessionId, durationMs: e.payload.durationMs });
    case 'status.changed':
      return one('status', { from: toStatus(e.payload.from, t), to: toStatus(e.payload.to, t) });
    case 'turn.queued': {
      const origin = e.payload.origin;
      if (origin === 'library') return one('turnQueued', { prompt: e.payload.prompt, origin: 'library' });
      const kind = EXTERNAL_KIND[origin];
      return kind === undefined ? [] : one('externalTurn', { prompt: e.payload.prompt, kind });
    }
    case 'turn.accepted':
      return one('turnStarted', { promptId: e.payload.promptId });
    case 'turn.ended':
      return e.turnKey === undefined ? [] : one('turnEnded', toTurnResult(e, d, ctx));
    case 'assistant.textDelta':
      return d.messages[e.payload.msgKey]?.agent !== undefined
        ? []
        : one('text', { delta: e.payload.delta, messageId: e.payload.msgKey, final: e.payload.final });
    case 'assistant.block':
      return e.payload.block !== 'text' || e.payload.text === undefined || e.payload.agentKey !== undefined
        ? []
        : one('message', { messageId: e.payload.msgKey, text: e.payload.text });
    case 'assistant.retracted':
      return one('textRetracted', { messageIds: [...e.payload.msgKeys] });
    case 'tool.started':
    case 'tool.ended': {
      // `d` is the state at flush time (or now, for a ring replay), never the state this event produced: the run record only
      // supplies what does not change after creation (visibility, turn, agent, startedAt); the state and end time are the
      // event's own, so a replayed or batched toolStarted never says the tool already finished.
      const run = d.tools[e.payload.toolKey];
      if (run === undefined || !isPublicTool(d, run)) return [];
      const base = toToolSnapshot(d, run, ctx);
      if (e.type === 'tool.ended') {
        const { endedAt: _later, ...rest } = base;
        return one('toolEnded', {
          ...rest,
          state: e.payload.state === 'proposed' ? 'pending' : e.payload.state,
          endedAt: t.toWall(e.at),
          provenance: toProvenance(e.provenance),
        });
      }
      const p = e.payload;
      const { endedAt: _later, toolUseId: _id, ...rest } = base;
      // a new tool is always created 'pending' (or 'proposed', shown as 'pending'): §10.3 ToolRun table
      return one('toolStarted', {
        ...rest,
        name: p.name,
        input: p.input,
        state: 'pending',
        provenance: toProvenance(e.provenance),
        ...opt('toolUseId', p.toolUseId),
      });
    }
    case 'permission.requested': {
      const p = e.payload;
      const rec = d.permissions[p.permissionKey];
      // background and the deadline come from the core (the rule and the armed permissionPolicy deadline the handler path
      // also sees), never recomputed here (ICR 0023)
      const data: Omit<PermissionRequest, 'signal'> = {
        key: p.permissionKey,
        toolName: p.toolName,
        toolInput: p.input,
        suggestions: [...p.suggestions],
        needs: p.needs,
        background: p.background,
        requestedAt: t.toWall(rec?.requestedAt ?? e.at),
        deadlineAt: t.toWall(p.deadlineAt),
        ...opt('turnKey', e.turnKey),
        ...opt('toolKey', p.toolKey),
        ...opt('subagentKey', p.agentKey as string | undefined as SubagentKey | undefined),
      };
      return one('permissionRequested', data);
    }
    case 'permission.resolved': {
      const p = e.payload;
      const ours = d.permissions[p.permissionKey]?.ourAnswer;
      let by: Data<'permissionResolved'>['by'] = 'unknown';
      if (p.decider === 'user_keys') by = 'tui';
      else if (p.decider === 'config' || p.decider === 'classifier') by = 'policy';
      else if (p.decider === 'hook' && ours !== undefined) by = ours.by === 'policy' || ours.by === 'timeout' ? 'policy' : 'library';
      else if (p.decider === 'hook') by = 'library';
      return one('permissionResolved', { key: p.permissionKey, decision: p.decision, by });
    }
    case 'input.requested':
      return one('inputRequested', { inputKind: e.payload.kind, ...opt('message', e.payload.message) });
    case 'subagent.started': {
      // as for tools: the record at flush time may already be stopped; the event's own payload says what started
      const p = e.payload;
      const a = d.agents[p.agentKey];
      if (p.internal || p.teammate || a === undefined || !isPublicAgent(a)) return [];
      const { endedAt: _later, ...rest } = toSubagentSnapshot(a, ctx);
      return one('subagentStarted', { ...rest, agentId: p.agentId, agentType: p.agentType, background: p.background, state: 'running' });
    }
    case 'subagent.stopped': {
      const a = d.agents[e.payload.agentKey];
      if (a === undefined || !isPublicAgent(a)) return [];
      return one('subagentEnded', { ...toSubagentSnapshot(a, ctx), state: 'stopped', endedAt: t.toWall(e.at) });
    }
    case 'modelCall.started':
      return agentHidden(d, e.payload.agentKey) ? [] : one('modelCall', { phase: 'started', attempt: e.payload.attempt });
    case 'modelCall.progress': {
      const call = d.calls[e.payload.callKey];
      const phase = e.payload.phase;
      return phase === 'quiet' || agentHidden(d, call?.agent) ? [] : one('modelCall', { phase });
    }
    case 'modelCall.retrying': {
      const call = d.calls[e.payload.callKey];
      return agentHidden(d, call?.agent)
        ? []
        : one('modelCall', { phase: 'retrying', attempt: e.payload.attempt, ...opt('retryInMs', e.payload.retryInMs) });
    }
    case 'modelCall.ended': {
      const call = d.calls[e.payload.callKey];
      return agentHidden(d, call?.agent) ? [] : one('modelCall', { phase: 'ended' });
    }
    case 'usage.limited':
      return one('usageLimited', { ...opt('resetsAt', e.payload.resetsAtWall), ...opt('nextWakeAt', d.usage.limit?.nextWakeAtWall) });
    case 'usage.wakeScheduled':
      return one('usageLimited', { ...opt('resetsAt', d.usage.limit?.resetsAtWall), nextWakeAt: e.payload.atWall });
    case 'compaction':
      return one('compaction', { phase: e.payload.phase });
    case 'channel.health':
      return one('channel', { channel: e.payload.channel, health: e.payload.health, ...opt('reason', e.payload.reason) });
    case 'security.alert':
      return one('security', { code: 'E_SECURITY', reason: e.payload.code });
    case 'warning':
    case 'input.rejected': {
      const code = e.payload.code;
      const message = e.type === 'warning' ? e.payload.message : e.payload.reason;
      return one('warning', { code: KNOWN_CODES.has(code) ? PUBLIC_CODE_OF[code] : 'E_INTERNAL', reason: code, message });
    }
    // Deliberately internal: bookkeeping, correlation, claims, late resolution and per-call details.
    case 'session.launching':
    case 'session.gated':
    case 'session.modeChanged':
    case 'session.modelChanged':
    case 'session.closing':
    case 'turn.submitting':
    case 'turn.resolvedLate':
    case 'turn.textAppended':
    case 'tool.updated':
    case 'tool.resolvedLate':
    case 'permission.bound':
    case 'permission.rebound':
    case 'permission.answered':
    case 'permission.needsKeys':
    case 'permission.abandoned':
    case 'input.cleared':
    case 'subagent.linked':
    case 'bgtask.updated':
    case 'usage.cleared':
    case 'usage.info':
    case 'claim.asserted':
    case 'claim.confirmed':
    case 'claim.retracted':
    case 'claim.expired':
    case 'interrupt.ignored':
    case 'config.changed':
      return [];
    default:
      return assertNever(e);
  }
}
