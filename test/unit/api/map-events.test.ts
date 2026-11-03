// DESIGN.md §2.12 mapping discipline (AL §6.4): every DomainEvent type is either mapped or deliberately dropped.
import { describe, expect, it } from 'vitest';
import { outcomeError, toPublicEvents, toTurnResult, type EventCtx } from '../../../src/api/map-events.js';
import { TimeBase } from '../../../src/api/map-state.js';
import type { SessionEvent } from '../../../src/api/public-types.js';
import type { DomainEvent } from '../../../src/model/events.js';
import type { AgentKey, ModelCallKey, MsgKey, PermissionKey, ToolKey, TurnKey } from '../../../src/model/ids.js';
import type { SessionState } from '../../../src/model/state.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import {
  agentRecord,
  fact,
  FakeKernel,
  type Payload,
  message,
  permissionRecord,
  readyState,
  toolRun,
  turnRecord,
  WALL_OFFSET,
} from './fake-kernel.js';

const k = new FakeKernel(readyState(), 0);
function ev<T extends DomainEvent['type']>(type: T, payload: Payload<T>, turnKey?: string): DomainEvent {
  return k.envelope(type, payload, turnKey === undefined ? {} : { turnKey: turnKey as TurnKey });
}
const M = (n: number) => n as MonoMs;
const ctx = (): EventCtx => {
  const time = new TimeBase();
  time.observe(0, WALL_OFFSET);
  return { cwd: '/w', time };
};

function state(): SessionState {
  return readyState({
    turns: {
      ['t1' as TurnKey]: turnRecord('t1', {
        state: fact('completed'),
        acceptedAt: M(100),
        endedAt: M(400),
        tools: ['u1' as ToolKey, 'u2' as ToolKey],
        messages: ['m1' as MsgKey],
      }),
    },
    tools: { ['u1' as ToolKey]: toolRun('u1', { turn: 't1' as TurnKey }), ['u2' as ToolKey]: toolRun('u2', { agent: 'a2' as AgentKey }) },
    agents: {
      ['a1' as AgentKey]: agentRecord('a1', { background: true }),
      ['a2' as AgentKey]: agentRecord('a2', { kind: 'internal' }),
    },
    messages: { ['m1' as MsgKey]: message('m1', 'hello'), ['m9' as MsgKey]: message('m9', 'sub', { agent: 'a1' as AgentKey }) },
    calls: {
      ['c2' as ModelCallKey]: {
        key: 'c2' as ModelCallKey,
        agent: 'a2' as AgentKey,
        requestRefs: [],
        attempts: 1,
        state: fact('streaming'),
        bytesDown: 0,
        startedAt: M(1),
      },
    },
    permissions: {
      ['p1' as PermissionKey]: permissionRecord('p1', { ourAnswer: { decision: 'allow', by: 'handler', via: 'hook', seq: 1 as never } }),
      ['p2' as PermissionKey]: permissionRecord('p2', { ourAnswer: { decision: 'deny', by: 'timeout', via: 'hook', seq: 1 as never } }),
    },
    usage: {
      tokensTotal: { inputTokens: 0, outputTokens: 0 },
      limit: {
        state: 'limited',
        source: 'screen',
        autoContinue: 'none',
        rearms: 0,
        resetsAtWall: 5 as WallMs,
        nextWakeAtWall: 6 as WallMs,
      },
    },
  });
}

/** One sample per DomainEvent type → the public types it maps to. The Record type makes the table exhaustive. */
const SAMPLES: Record<DomainEvent['type'], [DomainEvent, SessionEvent['type'][]]> = {
  'session.launching': [ev('session.launching', { cwd: '/w', claudeVersion: '2.1.316', claudeSessionId: 'x', resume: false }), []],
  'session.gated': [ev('session.gated', { gate: 'trust', text: 'Trust?' }), []],
  'session.ready': [
    ev('session.ready', { permissionMode: 'default', selfTest: 'passed', resumed: false, hookTransport: 'http' }),
    ['ready'],
  ],
  'session.generationChanged': [
    ev('session.generationChanged', { to: 'b', gen: 'g2' as never, reason: 'clear', from: 'a' }),
    ['claudeSessionChanged'],
  ],
  'session.modeChanged': [ev('session.modeChanged', { mode: 'plan' }), []],
  'session.modelChanged': [ev('session.modelChanged', { model: 'opus' }), []],
  'session.authRequired': [ev('session.authRequired', { message: 'login' }), ['authRequired']],
  'session.authRestored': [ev('session.authRestored', {}), ['authRestored']],
  'session.closing': [ev('session.closing', { reason: 'host' }), []],
  'session.exited': [ev('session.exited', { exitStatus: 0, signal: null, reason: 'closed', finalScreen: 'secret screen' }), ['exited']],
  'session.suspended': [ev('session.suspended', { claudeSessionId: 'c1', reason: 'idle', interrupted: false }), ['suspended']],
  'session.resumed': [ev('session.resumed', { claudeSessionId: 'c1', durationMs: 1800 }), ['resumed']],
  'status.changed': [
    ev('status.changed', { from: { kind: 'compacting', since: M(1) }, to: { kind: 'compacting', since: M(2) } }),
    ['status'],
  ],
  'turn.queued': [ev('turn.queued', { prompt: 'p', origin: 'library', clientRef: 'pending:1' }, 't1'), ['turnQueued']],
  'turn.submitting': [ev('turn.submitting', { attempt: 1, method: 'editor' }, 't1'), []],
  'turn.accepted': [ev('turn.accepted', { promptId: 'pid' }, 't1'), ['turnStarted']],
  'turn.ended': [ev('turn.ended', { outcome: 'completed', endedBy: 'stop' }, 't1'), ['turnEnded']],
  'turn.resolvedLate': [ev('turn.resolvedLate', { from: 'unknown', to: 'completed' }, 't1'), []],
  'turn.textAppended': [ev('turn.textAppended', { msgKey: 'm1' as MsgKey }, 't1'), []],
  'assistant.textDelta': [ev('assistant.textDelta', { msgKey: 'm1' as MsgKey, index: 0, delta: 'he', final: false }, 't1'), ['text']],
  'assistant.block': [
    ev('assistant.block', { msgKey: 'm1' as MsgKey, apiMessageId: 'msg_1', blockIndex: 0, block: 'text', text: 'hello' }, 't1'),
    ['message'],
  ],
  'assistant.retracted': [ev('assistant.retracted', { msgKeys: ['m1' as MsgKey], reason: 'refused' }, 't1'), ['textRetracted']],
  'tool.started': [ev('tool.started', { toolKey: 'u1' as ToolKey, name: 'Bash', input: {} }, 't1'), ['toolStarted']],
  'tool.updated': [ev('tool.updated', { toolKey: 'u1' as ToolKey, state: 'running' }), []],
  'tool.ended': [ev('tool.ended', { toolKey: 'u1' as ToolKey, state: 'succeeded', outcomeFrom: 'post' }, 't1'), ['toolEnded']],
  'tool.resolvedLate': [ev('tool.resolvedLate', { toolKey: 'u1' as ToolKey, to: 'succeeded' }), []],
  'permission.requested': [
    ev(
      'permission.requested',
      {
        permissionKey: 'p1' as PermissionKey,
        toolName: 'Bash',
        input: { command: 'ls' },
        suggestions: [],
        binding: 'unique',
        autoAnswerAllowed: true,
        needs: 'decision',
        agentKey: 'a1' as AgentKey,
        toolKey: 'u1' as ToolKey,
        background: true,
        deadlineAt: M(1500 + 10_000),
      },
      't1',
    ),
    ['permissionRequested'],
  ],
  'permission.bound': [ev('permission.bound', { permissionKey: 'p1' as PermissionKey, toolKey: 'u1' as ToolKey, confirmed: true }), []],
  'permission.rebound': [ev('permission.rebound', { permissionKey: 'p1' as PermissionKey, toolKey: 'u1' as ToolKey, confirmed: true }), []],
  'permission.answered': [
    ev('permission.answered', { permissionKey: 'p1' as PermissionKey, decision: 'allow', by: 'handler', via: 'hook' }),
    [],
  ],
  'permission.resolved': [
    ev('permission.resolved', { permissionKey: 'p1' as PermissionKey, decision: 'allow', decider: 'hook', overridden: false }),
    ['permissionResolved'],
  ],
  'permission.needsKeys': [ev('permission.needsKeys', { permissionKey: 'p1' as PermissionKey }), []],
  'permission.abandoned': [ev('permission.abandoned', { permissionKey: 'p1' as PermissionKey, reason: 'x' }), []],
  'input.requested': [ev('input.requested', { requestKey: 'r', kind: 'elicitationUrl', message: 'Open' }), ['inputRequested']],
  'input.cleared': [ev('input.cleared', { requestKey: 'r', how: 'complete' }), []],
  'subagent.started': [
    ev('subagent.started', {
      agentKey: 'a1' as AgentKey,
      agentId: 'x',
      agentType: 'g',
      background: true,
      internal: false,
      teammate: false,
    }),
    ['subagentStarted'],
  ],
  'subagent.linked': [ev('subagent.linked', { agentKey: 'a1' as AgentKey, spawnToolKey: 'u1' as ToolKey, confirmed: true }), []],
  'subagent.stopped': [ev('subagent.stopped', { agentKey: 'a1' as AgentKey, fileMissing: false }), ['subagentEnded']],
  'bgtask.updated': [ev('bgtask.updated', { taskId: 'x', type: 'bash', status: 'running' }), []],
  'modelCall.started': [ev('modelCall.started', { callKey: 'c1' as ModelCallKey, attempt: 1 }), ['modelCall']],
  'modelCall.progress': [ev('modelCall.progress', { callKey: 'c1' as ModelCallKey, phase: 'streaming' }), ['modelCall']],
  'modelCall.retrying': [ev('modelCall.retrying', { callKey: 'c1' as ModelCallKey, attempt: 2, retryInMs: 1000 }), ['modelCall']],
  'modelCall.ended': [ev('modelCall.ended', { callKey: 'c1' as ModelCallKey, outcome: 'ok' }), ['modelCall']],
  'usage.limited': [ev('usage.limited', { resetsAtWall: 5 as WallMs, source: 'screen', autoContinue: 'none' }), ['usageLimited']],
  'usage.wakeScheduled': [ev('usage.wakeScheduled', { atWall: 7 as WallMs, attempt: 1, jitterMs: 3 }), ['usageLimited']],
  'usage.cleared': [ev('usage.cleared', { reason: 'turnStarted' }), []],
  'usage.info': [ev('usage.info', { contextUsedPct: 3 }), []],
  compaction: [ev('compaction', { phase: 'started' }), ['compaction']],
  'claim.asserted': [ev('claim.asserted', { claim: 'x', value: 1 }), []],
  'claim.confirmed': [ev('claim.confirmed', { claim: 'x', value: 1 }), []],
  'claim.retracted': [ev('claim.retracted', { claim: 'x', value: 1 }), []],
  'claim.expired': [ev('claim.expired', { claim: 'x', value: 1 }), []],
  'channel.health': [ev('channel.health', { channel: 'screen', health: 'degraded', reason: 'frozen' }), ['channel']],
  'interrupt.ignored': [ev('interrupt.ignored', { reason: 'notBusy' }), []],
  'input.rejected': [ev('input.rejected', { job: 'j1' as never, code: 'E_INPUT_INVALID', reason: 'too long' }), ['warning']],
  'config.changed': [ev('config.changed', { source: 'user' }), []],
  'security.alert': [ev('security.alert', { code: 'E_SECURITY_HOOK_FORGERY', detail: null }), ['security']],
  warning: [ev('warning', { code: 'E_HOST_LOOP_LAG', message: 'lag' }), ['warning']],
};

describe('toPublicEvents', () => {
  it.each(Object.entries(SAMPLES))('%s', (_t, [e, expected]) => {
    const out = toPublicEvents(e, state(), ctx());
    expect(out.map((x) => x.type)).toEqual(expected);
    for (const x of out) {
      expect(x.seq).toBe(e.seq);
      expect(x.at).toBe(e.wallAt);
      expect(x.provenance).toEqual({ confirmed: true, sources: ['hooks'] });
    }
  });

  const one = (t: DomainEvent['type']): SessionEvent => {
    const out = toPublicEvents(SAMPLES[t][0], state(), ctx());
    expect(out).toHaveLength(1);
    return out[0]!;
  };

  it('payload shapes of the mapped events', () => {
    expect(one('session.exited').data).toEqual({ exitStatus: 0, signal: null, reason: 'closed' }); // finalScreen is not public
    expect(one('turn.queued')).toMatchObject({ turnKey: 't1', data: { prompt: 'p', origin: 'library' } });
    expect(one('assistant.textDelta').data).toEqual({ delta: 'he', messageId: 'm1', final: false });
    expect(one('permission.requested').data).toEqual({
      key: 'p1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      suggestions: [],
      needs: 'decision',
      background: true,
      requestedAt: WALL_OFFSET + 1500,
      deadlineAt: WALL_OFFSET + 1500 + 10_000,
      turnKey: 't1',
      toolKey: 'u1',
      subagentKey: 'a1',
    });
    expect(one('permission.resolved').data).toEqual({ key: 'p1', decision: 'allow', by: 'library' });
    expect(one('usage.limited').data).toEqual({ resetsAt: 5, nextWakeAt: 6 });
    expect(one('usage.wakeScheduled').data).toEqual({ resetsAt: 5, nextWakeAt: 7 });
    expect(one('input.rejected').data).toEqual({ code: 'E_INPUT_REJECTED', reason: 'E_INPUT_INVALID', message: 'too long' });
    expect(one('warning').data).toEqual({ code: 'E_ENVIRONMENT', reason: 'E_HOST_LOOP_LAG', message: 'lag' });
    expect(one('security.alert').data).toEqual({ code: 'E_SECURITY', reason: 'E_SECURITY_HOOK_FORGERY' });
    expect(one('session.ready').data).toEqual({ mode: 'default' });
    expect(one('modelCall.retrying').data).toEqual({ phase: 'retrying', attempt: 2, retryInMs: 1000 });
  });

  it('permissionRequested takes background and deadlineAt from the core payload (a foreground subagent: 10 s, background)', () => {
    // a1 is not a background agent in this state: the facade must not recompute background from the agent record, and the
    // deadline is the core's armed permissionPolicy deadline, not requestedAt + permissions.timeoutMs (ICR 0023)
    const st = readyState({ agents: { ['a1' as AgentKey]: agentRecord('a1', { background: false }) } });
    const payload: Payload<'permission.requested'> = {
      permissionKey: 'p1' as PermissionKey,
      toolName: 'Bash',
      input: {},
      suggestions: [],
      binding: 'unique',
      autoAnswerAllowed: true,
      needs: 'decision',
      agentKey: 'a1' as AgentKey,
      background: true,
      deadlineAt: M(7777),
    };
    const out = toPublicEvents(ev('permission.requested', payload), st, ctx());
    expect(out[0]?.data).toMatchObject({ background: true, deadlineAt: WALL_OFFSET + 7777 });
    const fg = toPublicEvents(ev('permission.requested', { ...payload, background: false, deadlineAt: M(9) }), st, ctx());
    expect(fg[0]?.data).toMatchObject({ background: false, deadlineAt: WALL_OFFSET + 9 });
  });

  it('permissionResolved.by follows the decider and our recorded answer', () => {
    const by = (permissionKey: string, decider: 'hook' | 'user_keys' | 'config' | 'classifier' | 'unknown'): unknown =>
      toPublicEvents(
        ev('permission.resolved', { permissionKey: permissionKey as PermissionKey, decision: 'deny', decider, overridden: false }),
        state(),
        ctx(),
      )[0]?.data;
    expect(by('p2', 'hook')).toMatchObject({ by: 'policy' });
    expect(by('p9', 'hook')).toMatchObject({ by: 'library' });
    expect(by('p1', 'user_keys')).toMatchObject({ by: 'tui' });
    expect(by('p1', 'config')).toMatchObject({ by: 'policy' });
    expect(by('p1', 'classifier')).toMatchObject({ by: 'policy' });
    expect(by('p1', 'unknown')).toMatchObject({ by: 'unknown' });
  });

  it('external turns map to externalTurn; self-test turns are never published', () => {
    const map = (origin: 'human' | 'task_notification' | 'scheduled' | 'auto_continue' | 'bash_mode' | 'peer_message' | 'selftest') =>
      toPublicEvents(ev('turn.queued', { prompt: 'x', origin }, 't5'), state(), ctx());
    expect(map('human')[0]).toMatchObject({ type: 'externalTurn', data: { kind: 'human' } });
    expect(map('bash_mode')[0]).toMatchObject({ data: { kind: 'human' } });
    expect(map('task_notification')[0]).toMatchObject({ data: { kind: 'taskNotification' } });
    expect(map('scheduled')[0]).toMatchObject({ data: { kind: 'scheduled' } });
    expect(map('auto_continue')[0]).toMatchObject({ data: { kind: 'autoContinue' } });
    expect(map('peer_message')[0]).toMatchObject({ data: { kind: 'unknown' } });
    expect(map('selftest')).toEqual([]);
  });

  it('hides internal agents, teammates, their tools, model calls and sub-agent text', () => {
    const d = state();
    const c = ctx();
    expect(toPublicEvents(ev('tool.started', { toolKey: 'u2' as ToolKey, name: 'Read', input: {} }), d, c)).toEqual([]);
    expect(toPublicEvents(ev('tool.ended', { toolKey: 'u404' as ToolKey, state: 'succeeded', outcomeFrom: 'post' }), d, c)).toEqual([]);
    expect(
      toPublicEvents(
        ev('subagent.started', {
          agentKey: 'a2' as AgentKey,
          agentId: 'x',
          agentType: '',
          background: false,
          internal: true,
          teammate: false,
        }),
        d,
        c,
      ),
    ).toEqual([]);
    expect(
      toPublicEvents(
        ev('subagent.started', {
          agentKey: 'a1' as AgentKey,
          agentId: 'x',
          agentType: 'g',
          background: false,
          internal: false,
          teammate: true,
        }),
        d,
        c,
      ),
    ).toEqual([]);
    expect(toPublicEvents(ev('subagent.stopped', { agentKey: 'a2' as AgentKey, fileMissing: false }), d, c)).toEqual([]);
    expect(
      toPublicEvents(ev('modelCall.started', { callKey: 'c3' as ModelCallKey, attempt: 1, agentKey: 'a2' as AgentKey }), d, c),
    ).toEqual([]);
    expect(toPublicEvents(ev('modelCall.progress', { callKey: 'c2' as ModelCallKey, phase: 'streaming' }), d, c)).toEqual([]);
    expect(toPublicEvents(ev('modelCall.progress', { callKey: 'c1' as ModelCallKey, phase: 'quiet' }), d, c)).toEqual([]);
    expect(toPublicEvents(ev('modelCall.retrying', { callKey: 'c2' as ModelCallKey, attempt: 2 }), d, c)).toEqual([]);
    expect(toPublicEvents(ev('modelCall.ended', { callKey: 'c2' as ModelCallKey, outcome: 'ok' }), d, c)).toEqual([]);
    expect(toPublicEvents(ev('assistant.textDelta', { msgKey: 'm9' as MsgKey, index: 0, delta: 'x', final: true }), d, c)).toEqual([]);
    expect(
      toPublicEvents(
        ev('assistant.block', {
          msgKey: 'm9' as MsgKey,
          apiMessageId: 'a',
          blockIndex: 0,
          block: 'text',
          text: 'x',
          agentKey: 'a1' as AgentKey,
        }),
        d,
        c,
      ),
    ).toEqual([]);
    expect(
      toPublicEvents(
        ev('assistant.block', { msgKey: 'm1' as MsgKey, apiMessageId: 'a', blockIndex: 0, block: 'thinking', text: 'x' }),
        d,
        c,
      ),
    ).toEqual([]);
    expect(toPublicEvents(ev('turn.ended', { outcome: 'completed', endedBy: 'stop' }), d, c)).toEqual([]);
  });

  it('a warning with a code this build does not know is E_INTERNAL', () => {
    const e = ev('warning', { code: 'E_FROM_THE_FUTURE' as never, message: 'm' });
    expect(toPublicEvents(e, state(), ctx())[0]?.data).toEqual({ code: 'E_INTERNAL', reason: 'E_FROM_THE_FUTURE', message: 'm' });
  });
});

describe('per-event snapshots (the batch state is the flush-time or current state, ICR 0029 #1)', () => {
  // the state the kernel hands over is later than the event: the tool already succeeded, the agent already stopped
  const later = (): SessionState =>
    readyState({
      tools: { ['u1' as ToolKey]: toolRun('u1', { turn: 't1' as TurnKey, state: fact('succeeded'), endedAt: M(1900) }) },
      agents: { ['a1' as AgentKey]: agentRecord('a1', { state: fact('stopped'), endedAt: M(2500), agentType: 'later-type' }) },
    });

  it('toolStarted is the tool as it started: pending, the event payload, no endedAt', () => {
    const e = ev('tool.started', { toolKey: 'u1' as ToolKey, toolUseId: 'tu1', name: 'Bash', input: { command: 'pwd' } }, 't1');
    const [pe] = toPublicEvents(e, later(), ctx());
    expect(pe).toMatchObject({ type: 'toolStarted', data: { key: 'u1', name: 'Bash', input: { command: 'pwd' }, state: 'pending' } });
    expect(pe?.type === 'toolStarted' ? pe.data : undefined).toMatchObject({
      toolUseId: 'tu1',
      turnKey: 't1',
      startedAt: WALL_OFFSET + 1200,
    });
    expect(pe?.type === 'toolStarted' ? pe.data.endedAt : 'missing').toBeUndefined();
  });

  it('toolEnded carries the state and end time of its own event, not a later resolution', () => {
    const e = ev('tool.ended', { toolKey: 'u1' as ToolKey, state: 'failed', outcomeFrom: 'post_failure' }, 't1');
    const [pe] = toPublicEvents(e, later(), ctx());
    expect(pe?.type).toBe('toolEnded');
    expect(pe?.type === 'toolEnded' ? pe.data : undefined).toMatchObject({ state: 'failed', endedAt: WALL_OFFSET + e.at });
  });

  it('subagentStarted is running with the payload type and no endedAt; subagentEnded is stopped at its event', () => {
    const st = ev('subagent.started', {
      agentKey: 'a1' as AgentKey,
      agentId: 'agent-a1',
      agentType: 'general-purpose',
      background: true,
      internal: false,
      teammate: false,
    });
    const [s1] = toPublicEvents(st, later(), ctx());
    expect(s1).toMatchObject({
      type: 'subagentStarted',
      data: { key: 'a1', state: 'running', agentType: 'general-purpose', background: true },
    });
    expect(s1?.type === 'subagentStarted' ? s1.data.endedAt : 'missing').toBeUndefined();
    const sp = ev('subagent.stopped', { agentKey: 'a1' as AgentKey, fileMissing: false });
    const [s2] = toPublicEvents(sp, later(), ctx());
    expect(s2).toMatchObject({ type: 'subagentEnded', data: { state: 'stopped', endedAt: WALL_OFFSET + sp.at } });
  });
});

describe('toTurnResult', () => {
  it('completed: text from the turn messages, public tools only, duration from accepted → ended', () => {
    const r = toTurnResult(
      ev('turn.ended', { outcome: 'completed', endedBy: 'stop' }, 't1') as Extract<DomainEvent, { type: 'turn.ended' }>,
      state(),
      ctx(),
    );
    expect(r).toMatchObject({ turnKey: 't1', outcome: 'completed', text: 'hello', refused: false, durationMs: 300 });
    expect(r.tools.map((t) => t.key)).toEqual(['u1']);
    expect(r.error).toBeUndefined();
  });

  it('failed with an error, payload text and duration win; refusal flag is kept', () => {
    const e = ev(
      'turn.ended',
      {
        outcome: 'failed',
        endedBy: 'stop_failure',
        error: { code: 'E_TURN_REFUSED', message: 'refused' },
        finalText: 'f',
        durationMs: 9,
        refused: true,
      },
      't1',
    );
    const r = toTurnResult(e as Extract<DomainEvent, { type: 'turn.ended' }>, state(), ctx());
    expect(r).toMatchObject({ outcome: 'failed', text: 'f', durationMs: 9, refused: true });
    expect(r.error?.code).toBe('E_TURN_FAILED');
    expect(r.error?.details.reason).toBe('E_TURN_REFUSED');
  });

  it.each([
    ['interrupted', 'E_TURN_FAILED', 'E_TURN_INTERRUPTED'],
    ['aborted', 'E_TURN_FAILED', 'E_TURN_ABORTED'],
    ['withdrawn', 'E_TURN_FAILED', 'E_TURN_ABORTED'],
    ['notSubmitted', 'E_SUBMIT_UNCONFIRMED', 'E_SUBMIT_UNCONFIRMED'],
    ['failed', 'E_TURN_FAILED', 'E_TURN_API_ERROR'],
    ['unknown', 'E_TURN_FAILED', 'E_TURN_STALLED'],
  ] as const)('an %s turn without an error gets %s{%s}', (outcome, code, reason) => {
    const r = toTurnResult(
      ev('turn.ended', { outcome, endedBy: 'interrupt' }, 'tZ') as Extract<DomainEvent, { type: 'turn.ended' }>,
      state(),
      ctx(),
    );
    expect(r.error?.code).toBe(code);
    expect(r.error?.details.reason).toBe(reason);
    expect(r).toMatchObject({ text: '', durationMs: 0, tools: [] });
    expect(outcomeError(outcome).code).toBe(code);
  });

  it.each(['notSubmitted', 'unknown', 'interrupted', 'aborted'] as const)(
    'a %s turn ended by process_exit gets E_SESSION_EXITED, never the retryable E_SUBMIT_UNCONFIRMED',
    (outcome) => {
      const r = toTurnResult(
        ev('turn.ended', { outcome, endedBy: 'process_exit' }, 'tZ') as Extract<DomainEvent, { type: 'turn.ended' }>,
        state(),
        ctx(),
      );
      expect(r.error?.code).toBe('E_SESSION_EXITED');
      expect(r.error?.details.reason).toBe('E_SESSION_EXITED');
      expect(r.error?.details['outcome']).toBe(outcome);
      expect(r.error?.details['endedBy']).toBe('process_exit');
      expect(r.error?.retryable).toBe(false);
    },
  );

  it.each([
    ['stop', 'E_TURN_FAILED', 'E_TURN_STALLED'], // superseded after a hook gap
    ['merged', 'E_TURN_FAILED', 'E_TURN_STALLED'], // placeholder merge
    ['session_end', 'E_TURN_FAILED', 'E_TURN_STALLED'], // generation switch (/clear, resume): the process is alive
    ['process_exit', 'E_SESSION_EXITED', 'E_SESSION_EXITED'], // the process-exit closing rule
  ] as const)("an 'unknown' turn ended by %s gets %s{%s}", (endedBy, code, reason) => {
    const r = toTurnResult(
      ev('turn.ended', { outcome: 'unknown', endedBy }, 'tZ') as Extract<DomainEvent, { type: 'turn.ended' }>,
      state(),
      ctx(),
    );
    expect(r.error?.code).toBe(code);
    expect(r.error?.details.reason).toBe(reason);
    expect(r.error?.details['endedBy']).toBe(endedBy);
  });
});
