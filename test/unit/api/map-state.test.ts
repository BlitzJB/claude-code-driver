// DESIGN.md §2.12 mapping discipline: SessionState → SessionSnapshot / AgentStatus / TurnSnapshot / ToolRunSnapshot.
import { describe, expect, it } from 'vitest';
import {
  assertNever,
  opt,
  TimeBase,
  toMode,
  toProvenance,
  toSnapshot,
  toStatus,
  toTurnSnapshot,
  turnText,
} from '../../../src/api/map-state.js';
import type { AgentKey, EventSeq, GenKey, MsgKey, ToolKey, TurnKey } from '../../../src/model/ids.js';
import type { AgentStatus, SessionState } from '../../../src/model/state.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { agentRecord, fact, message, permissionRecord, readyState, toolRun, turnRecord } from './fake-kernel.js';
import { outcomeError } from '../../../src/api/outcome-error.js';

const OFF = 1_800_000_000_000;
function time(): TimeBase {
  const t = new TimeBase(
    () => OFF + 5000,
    () => 5000,
  );
  t.observe(0, OFF);
  return t;
}
const ctx = () => ({ cwd: '/w', time: time() });
const M = (n: number) => n as MonoMs;

describe('TimeBase', () => {
  it('translates mono to wall with the offset of the last observed event and ignores non-finite anchors', () => {
    const t = new TimeBase(
      () => 10_000,
      () => 100,
    );
    expect(t.toWall(100)).toBe(10_000);
    t.observe(50, 1050);
    expect(t.toWall(60)).toBe(1060);
    t.observe(Number.NaN, 1);
    expect(t.toWall(60)).toBe(1060);
    expect(t.nowMono()).toBe(9_000);
  });
});

describe('small helpers', () => {
  it('opt omits undefined; toMode collapses dangerous modes; toProvenance maps sources to channels', () => {
    expect(opt('a', undefined)).toEqual({});
    expect(opt('a', 0)).toEqual({ a: 0 });
    expect(toMode('plan')).toBe('plan');
    expect(toMode('bypassPermissions')).toBe('other');
    expect(toMode(undefined)).toBe('default');
    expect(toProvenance({ confirmed: true, sources: ['hook', 'screen', 'self', 'hook', 'transcript', 'network'] })).toEqual({
      confirmed: true,
      sources: ['hooks', 'screen', 'transcript', 'network'],
    });
    expect(toProvenance(undefined)).toEqual({ confirmed: false, sources: [] });
    expect(() => assertNever('x' as never)).toThrow(/unmapped/);
  });
});

describe('toStatus (every internal kind)', () => {
  const t = time();
  const p = { confirmed: true, sources: ['hook' as const] };
  const cases: [AgentStatus, unknown][] = [
    [
      { kind: 'starting', phase: 'gated', since: M(1) },
      { kind: 'starting', since: OFF + 1 },
    ],
    [
      {
        kind: 'idle',
        since: M(2),
        backgroundAgents: 1,
        queued: 2,
        quiescent: false,
        lastTurn: { outcome: 'failed', error: { code: 'E_TURN_API_ERROR', message: 'x' } },
      },
      {
        kind: 'idle',
        since: OFF + 2,
        backgroundAgents: 1,
        queued: 2,
        quiescent: false,
        lastError: { code: 'E_TURN_FAILED', message: 'x', details: { reason: 'E_TURN_API_ERROR' } },
      },
    ],
    [
      { kind: 'idle', since: M(2), backgroundAgents: 0, queued: 0, quiescent: true },
      { kind: 'idle', since: OFF + 2, backgroundAgents: 0, queued: 0, quiescent: true },
    ],
    [
      { kind: 'modelRequest', phase: 'retrying', since: M(3), attempt: 2, maxAttempts: 10, retryInMs: 500, provenance: p },
      {
        kind: 'modelRequest',
        phase: 'retrying',
        since: OFF + 3,
        attempt: 2,
        maxAttempts: 10,
        retryInMs: 500,
        provenance: { confirmed: true, sources: ['hooks'] },
      },
    ],
    [
      { kind: 'writing', since: M(4), provenance: p },
      { kind: 'writing', since: OFF + 4, provenance: { confirmed: true, sources: ['hooks'] } },
    ],
    [
      { kind: 'runningTools', tools: ['u1' as ToolKey], since: M(5), provenance: p },
      { kind: 'runningTools', tools: ['u1'], since: OFF + 5, provenance: { confirmed: true, sources: ['hooks'] } },
    ],
    [
      { kind: 'awaitingPermission', permission: 'p1' as never, since: M(6) },
      { kind: 'awaitingPermission', permission: 'p1', since: OFF + 6 },
    ],
    [
      { kind: 'awaitingInput', request: 'r1', inputKind: 'elicitation', message: 'Pick', since: M(7) },
      { kind: 'awaitingInput', inputKind: 'elicitation', message: 'Pick', since: OFF + 7 },
    ],
    [
      { kind: 'interrupted', since: M(8), provenance: p },
      { kind: 'interrupted', since: OFF + 8 },
    ],
    [
      { kind: 'compacting', since: M(9) },
      { kind: 'compacting', since: OFF + 9 },
    ],
    [
      { kind: 'usageLimited', since: M(10), resetsAtWall: 99 as WallMs, autoResume: true, nextWakeAtWall: 100 as WallMs },
      { kind: 'usageLimited', since: OFF + 10, resetsAt: 99, nextWakeAt: 100, autoResume: true },
    ],
    [
      { kind: 'authRequired', since: M(11), message: 'login' },
      { kind: 'authRequired', since: OFF + 11, message: 'login' },
    ],
    [
      { kind: 'exited', since: M(12), exitStatus: 1, signal: null },
      { kind: 'exited', since: OFF + 12, exitStatus: 1, signal: null },
    ],
  ];
  it.each(cases)('%j', (internal, pub) => {
    expect(toStatus(internal, t)).toEqual(pub);
  });
});

function richState(): SessionState {
  const base = readyState();
  return {
    ...base,
    claude: { ...base.claude, permissionMode: fact('acceptEdits'), model: fact('opus'), currentGen: 'g1' as GenKey },
    activeTurn: 't1' as TurnKey,
    turnOrder: ['t0' as TurnKey, 't1' as TurnKey, 't2' as TurnKey],
    libraryQueue: ['t2' as TurnKey],
    turns: {
      ['t0' as TurnKey]: turnRecord('t0', {
        state: fact('completed'),
        finalText: fact('done before'),
        acceptedAt: M(100),
        endedAt: M(200),
      }),
      ['t1' as TurnKey]: turnRecord('t1', {
        promptId: 'pid-1',
        acceptedAt: M(1150),
        state: fact('stopping'),
        tools: ['u1' as ToolKey, 'u2' as ToolKey, 'u3' as ToolKey],
        messages: ['m1' as MsgKey, 'm2' as MsgKey, 'm3' as MsgKey, 'm4' as MsgKey],
      }),
      ['t2' as TurnKey]: turnRecord('t2', { state: fact('queued'), origin: fact('task_notification') }),
    },
    tools: {
      ['u1' as ToolKey]: toolRun('u1', { turn: 't1' as TurnKey, toolUseId: 'toolu_1', spawned: 'a1' as AgentKey }),
      ['u2' as ToolKey]: toolRun('u2', { turn: 't1' as TurnKey, agent: 'a2' as AgentKey }), // internal agent's tool: hidden
      ['u3' as ToolKey]: toolRun('u3', { turn: 't1' as TurnKey, state: fact('succeeded'), endedAt: M(1250) }),
      ['u4' as ToolKey]: toolRun('u4', { state: fact('proposed'), agent: 'a1' as AgentKey }),
    },
    agents: {
      ['a1' as AgentKey]: agentRecord('a1', { spawnTool: 'u1' as ToolKey }),
      ['a2' as AgentKey]: agentRecord('a2', { kind: 'internal' }),
      ['a3' as AgentKey]: agentRecord('a3', { kind: 'teammate' }),
      ['a4' as AgentKey]: agentRecord('a4', { kind: 'unknown', state: fact('stopped'), endedAt: M(1400), background: true }),
    },
    messages: {
      ['m1' as MsgKey]: message('m1', 'first'),
      ['m2' as MsgKey]: message('m2', 'gone', { retracted: true }),
      ['m3' as MsgKey]: message('m3', 'sub', { agent: 'a1' as AgentKey }),
      ['m4' as MsgKey]: message('m4', 'second'),
    },
    permissions: {
      ['p2' as never]: permissionRecord('p2', { requestedAt: M(1600) }),
      ['p1' as never]: permissionRecord('p1'),
      ['p3' as never]: permissionRecord('p3', { state: fact('resolved') }),
    },
    usage: {
      tokensTotal: { inputTokens: 0, outputTokens: 0 },
      contextUsedPct: 42,
      limit: { state: 'limited', source: 'screen', autoContinue: 'none', rearms: 0, resetsAtWall: 777 as WallMs },
    },
    channels: { ...base.channels, network: { health: 'off', reasons: [] }, screen: { health: 'degraded', reasons: ['x'] } },
    lastEventSeq: 17 as EventSeq,
  };
}

describe('toSnapshot', () => {
  it('maps the whole session and hides internal agents, teammates and their tools', () => {
    const s = toSnapshot(richState(), ctx());
    expect(s).toMatchObject({
      key: 's0000c0de',
      claudeSessionId: 'claude-session-1',
      cwd: '/w',
      claudeVersion: '2.1.316',
      mode: 'acceptEdits',
      model: 'opus',
      queuedTurns: ['t2'],
      pendingPermissions: ['p1', 'p2'],
      usage: { contextUsedPct: 42, limitedUntil: 777 },
      channels: { hooks: 'up', transcript: 'up', network: 'off', screen: 'degraded' },
      lastEventSeq: 17,
    });
    expect(s.activeTools.map((t) => t.key)).toEqual(['u1', 'u4']);
    expect(s.activeTools[1]).toMatchObject({ state: 'pending', subagentKey: 'a1' });
    expect(s.activeTools[0]).toEqual({
      key: 'u1',
      toolUseId: 'toolu_1',
      name: 'Bash',
      input: { command: 'ls' },
      state: 'running',
      turnKey: 't1',
      startedAt: OFF + 1200,
      provenance: { confirmed: true, sources: ['hooks'] },
    });
    expect(s.subagents.map((a) => a.key)).toEqual(['a1', 'a4']);
    expect(s.subagents[1]).toEqual({
      key: 'a4',
      agentId: 'agent-a4',
      agentType: 'general-purpose',
      background: true,
      state: 'stopped',
      startedAt: OFF + 1300,
      endedAt: OFF + 1400,
    });
    expect(s.currentTurn).toEqual({
      key: 't1',
      prompt: 'prompt t1',
      promptId: 'pid-1',
      origin: 'library',
      state: 'running',
      tools: ['u1', 'u3'],
      subagents: ['a1'],
      text: 'first\n\nsecond',
      startedAt: OFF + 1150,
    });
  });

  it('defaults: no session id yet, no limit, cleared limit hides limitedUntil', () => {
    const d = readyState({ claude: { version: '2.1.316' } });
    const s = toSnapshot(
      {
        ...d,
        usage: { ...d.usage, limit: { state: 'cleared', source: 'screen', autoContinue: 'none', rearms: 0, resetsAtWall: 1 as WallMs } },
      },
      ctx(),
    );
    expect(s.claudeSessionId).toBe('');
    expect(s.usage).toEqual({});
    expect(s.currentTurn).toBeUndefined();
    expect(s.mode).toBe('default');
  });

  it('turn snapshots: external origin, final text wins, error mapped', () => {
    const d = richState();
    const t2 = toTurnSnapshot(d, d.turns['t2' as TurnKey]!, ctx());
    expect(t2).toMatchObject({ origin: 'external', state: 'queued', text: '' });
    const failed = turnRecord('t9', {
      state: fact('failed'),
      error: { code: 'E_TURN_API_ERROR', message: 'boom' },
      endedAt: M(10),
      finalText: fact('partial'),
    });
    expect(toTurnSnapshot(d, failed, ctx())).toMatchObject({
      state: 'failed',
      text: 'partial',
      endedAt: OFF + 10,
      error: { code: 'E_TURN_FAILED', details: { reason: 'E_TURN_API_ERROR' } },
    });
    expect(turnText(d, turnRecord('tx', { messages: ['missing' as MsgKey] }))).toBe('');
  });

  it('turn snapshots: a turn ended without a recorded error reports the error its TurnResult carries', () => {
    const d = richState();
    // closeProcess ends a still-queued library turn as notSubmitted{endedBy process_exit} with no error attached.
    const queuedAtExit = turnRecord('t8', { state: fact('notSubmitted'), endedBy: 'process_exit', endedAt: M(10) });
    const snap = toTurnSnapshot(d, queuedAtExit, ctx());
    expect(snap.error).toMatchObject({ code: 'E_SESSION_EXITED', details: { reason: 'E_SESSION_EXITED', outcome: 'notSubmitted' } });
    expect(snap.error).toEqual(outcomeError('notSubmitted', 'process_exit').toJSON());
    const interrupted = turnRecord('t7', { state: fact('interrupted'), endedBy: 'interrupt', endedAt: M(10) });
    expect(toTurnSnapshot(d, interrupted, ctx()).error).toMatchObject({ code: 'E_TURN_FAILED', details: { reason: 'E_TURN_INTERRUPTED' } });
    expect(toTurnSnapshot(d, turnRecord('t6', { state: fact('completed') }), ctx()).error).toBeUndefined();
    expect(toTurnSnapshot(d, turnRecord('t5', { state: fact('running') }), ctx()).error).toBeUndefined();
  });

  it('display rule: a pending tool older than 150 ms without a permission shows running', () => {
    const d = readyState({ tools: { ['u1' as ToolKey]: toolRun('u1', { state: fact('pending'), preAt: M(100) }) } });
    const late = toSnapshot(d, {
      cwd: '/w',
      time: new TimeBase(
        () => OFF + 1000,
        () => 1000,
      ),
    });
    expect(late.activeTools[0]?.state).toBe('running');
    const early = new TimeBase(
      () => OFF + 150,
      () => 150,
    );
    expect(toSnapshot(d, { cwd: '/w', time: early }).activeTools[0]?.state).toBe('pending');
  });
});
