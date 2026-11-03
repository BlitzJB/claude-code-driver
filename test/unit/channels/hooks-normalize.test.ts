// channels/hooks/normalize.ts (WP-06; DESIGN.md §2.4, §2.8, §6.2): RawHookEvent → ObservationInput[] on the live 2.1.316
// fixtures plus targeted synthetic payloads. Pitfalls: P-HOOK-44, P-DOCS-03, P-DOCS-04, P-SEC-30, P-REC-01/06/08/09,
// P-LIVE-10, P-REV-14, rev 2 §10 A5 (session ids never filtered).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { heldUnclaimed, normalizeHook } from '../../../src/channels/hooks/normalize.js';
import { isTaskNotification, parseTaskNotification } from '../../../src/channels/hooks/task-notification.js';
import { hookExtras, hooksProfile } from '../../../src/channels/profiles/claude-2.1.316/hooks.js';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';
import type { HookSeq } from '../../../src/model/ids.js';
import type { Observation, ObservationInput } from '../../../src/model/observation.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import type { RawHookEvent } from '../../../src/platform/ports.js';

const ctx = { profile };
const fixture = (name: string): string => fileURLToPath(new URL(`../../../fixtures/verify/${name}`, import.meta.url));

let seq = 0;
/** A RawHookEvent whose `bytes` is given (no JSON.stringify of the payload: hostile payloads may throw on read). */
function rawBytes(event: string, payload: unknown, bytes: number, o: Partial<RawHookEvent> = {}): RawHookEvent {
  seq += 1;
  return {
    hookSeq: seq as HookSeq,
    at: (1000 + seq) as MonoMs,
    wallAt: (1_793_000_000_000 + seq) as WallMs,
    transport: 'http',
    event,
    bytes,
    truncated: false,
    payload,
    holdable: false,
    ...o,
  };
}
function raw(event: string, payload: unknown, o: Partial<RawHookEvent> = {}): RawHookEvent {
  seq += 1;
  return {
    hookSeq: seq as HookSeq,
    at: (1000 + seq) as MonoMs,
    wallAt: (1_793_000_000_000 + seq) as WallMs,
    transport: 'http',
    event,
    bytes: JSON.stringify(payload ?? null).length,
    truncated: false,
    payload,
    holdable: false,
    ...o,
  };
}

const common = {
  session_id: '59129e0d-0328-40d1-93bb-5312bc731f39',
  transcript_path: '/HOME/.claude/projects/-x/59129e0d-0328-40d1-93bb-5312bc731f39.jsonl',
  cwd: '/TMP/x',
  scratchpad_dir: '/TMP/x/scratchpad',
};
const ev = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...common, hook_event_name: name, ...extra });

type Payload<K extends Observation['kind']> = Extract<Observation, { kind: K }>['p'];
function only<K extends Observation['kind']>(obs: ObservationInput[], kind: K): Payload<K>[] {
  return obs.filter((o) => o.kind === kind).map((o) => o.p as Payload<K>);
}
function one<K extends Observation['kind']>(obs: ObservationInput[], kind: K): Payload<K> {
  const list = only(obs, kind);
  expect(list).toHaveLength(1);
  const [first] = list;
  if (first === undefined) throw new Error(`no ${kind} observation`);
  return first;
}

interface FixtureHook {
  event: string;
  transport: 'http' | 'unix';
  payload: Record<string, unknown>;
  t: number;
}
function loadFixtures(): FixtureHook[] {
  const out: FixtureHook[] = [];
  for (const line of readFileSync(fixture('http-hooks.jsonl'), 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const j = JSON.parse(line) as { kind: string; url?: string; body?: Record<string, unknown>; t: number };
    if (j.kind !== 'req' || j.url === undefined || j.body === undefined) continue;
    out.push({ event: j.url.replace(/^\//, ''), transport: 'http', payload: j.body, t: j.t });
  }
  for (const line of readFileSync(fixture('cmd-hooks.jsonl'), 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const j = JSON.parse(line) as { ev: string; p: Record<string, unknown>; t: number };
    out.push({ event: j.ev, transport: 'unix', payload: j.p, t: j.t });
  }
  return out;
}
const FIXTURES = loadFixtures();

const EXPECTED_KIND: Readonly<Record<string, Observation['kind']>> = {
  SessionStart: 'session.started',
  SessionEnd: 'session.ended',
  UserPromptSubmit: 'prompt.submitted',
  PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post',
  PermissionRequest: 'permission.requested',
  MessageDisplay: 'message.textDelta',
  Stop: 'turn.stopped',
  SubagentStop: 'agent.stopped',
  Notification: 'notification',
};

describe('live 2.1.316 fixtures (fixtures/verify/{http,cmd}-hooks.jsonl)', () => {
  it('loads both logs', () => {
    expect(FIXTURES.filter((f) => f.transport === 'http')).toHaveLength(45);
    expect(FIXTURES.filter((f) => f.transport === 'unix').length).toBeGreaterThan(10);
  });

  it('normalizes every line without a rejection or an unknown observation', () => {
    for (const f of FIXTURES) {
      const r = normalizeHook(raw(f.event, f.payload, { transport: f.transport, wallAt: f.t as WallMs }), ctx);
      expect(r.rejected, `${f.event} @${f.t}`).toBeUndefined();
      expect(r.observations.some((o) => o.kind === 'unknown')).toBe(false);
      const expected = EXPECTED_KIND[f.event];
      expect(expected, f.event).toBeDefined();
      expect(r.observations[0]?.kind).toBe(expected);
      for (const o of r.observations) {
        expect(o.meta.source).toBe('hook');
        expect(o.meta.claudeSessionId).toBe(f.payload['session_id']);
        expect(o.meta.origin).toMatchObject({ kind: 'hook', transport: f.transport, event: f.event });
      }
    }
  });

  it('ghost agent PreToolUse keeps its agent and the stale prompt_id (P-LIVE-10, P-REC-15)', () => {
    const ghost = FIXTURES.find((f) => f.event === 'PreToolUse' && typeof f.payload['agent_id'] === 'string');
    expect(ghost).toBeDefined();
    const r = normalizeHook(raw('PreToolUse', ghost?.payload), ctx);
    const pre = one(r.observations, 'tool.pre');
    expect(pre.agent).toEqual({ agentId: 'aae080349052f9ad8' });
    expect(pre.promptId).toBe('da6f47f1-d48c-44a9-bbf0-6f9d1bab94a8');
    expect(r.observations[0]?.meta.agentId).toBe('aae080349052f9ad8');
  });

  it("SubagentStop with agent_type '' keeps the empty type (internal agent, RC §5.4)", () => {
    const stops = FIXTURES.filter((f) => f.event === 'SubagentStop');
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) {
      const a = one(normalizeHook(raw('SubagentStop', s.payload), ctx).observations, 'agent.stopped');
      expect(a.agent.agentType).toBe('');
      expect(a.transcriptPath).toMatch(/subagents\/agent-a[0-9a-f]+\.jsonl$/);
      expect(Array.isArray(a.backgroundTasks)).toBe(true);
    }
  });

  it('SessionEnd with a prompt_id (after /clear) yields only session.ended (P-REC-01)', () => {
    const clear = FIXTURES.find((f) => f.event === 'SessionEnd' && f.payload['reason'] === 'clear');
    const r = normalizeHook(raw('SessionEnd', clear?.payload), ctx);
    expect(r.observations.map((o) => o.kind)).toEqual(['session.ended']);
    expect(one(r.observations, 'session.ended').reason).toBe('clear');
  });

  it('MessageDisplay: the 3-chunk message keeps index/final/delta per chunk (P-REC-09)', () => {
    const chunks = FIXTURES.filter(
      (f) => f.event === 'MessageDisplay' && f.payload['message_id'] === '3297f42a-203c-42ab-91be-2133a86d66dc',
    );
    expect(chunks).toHaveLength(3);
    const deltas = chunks.map((c) => one(normalizeHook(raw('MessageDisplay', c.payload), ctx).observations, 'message.textDelta'));
    expect(deltas.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(deltas.map((d) => d.final)).toEqual([false, false, true]);
    expect(new Set(deltas.map((d) => d.uiMessageId))).toEqual(new Set(['3297f42a-203c-42ab-91be-2133a86d66dc']));
    expect(deltas.every((d) => typeof d.delta === 'string')).toBe(true);
  });

  it('PermissionRequest carries hookSeq, input, suggestions and the mode', () => {
    const pr = FIXTURES.find((f) => f.event === 'PermissionRequest');
    const r = raw('PermissionRequest', pr?.payload, { transport: 'unix', holdable: true });
    const p = one(normalizeHook(r, ctx).observations, 'permission.requested');
    expect(p.hookSeq).toBe(r.hookSeq);
    expect(p.toolName).toBe(pr?.payload['tool_name']);
    expect(p.input).toEqual(pr?.payload['tool_input']);
    expect(Array.isArray(p.suggestions)).toBe(true);
    expect(p.permissionMode).toBe('default');
    expect(p.holdable).toBeUndefined();
  });

  it('a PermissionRequest the transport did not hold (over maxHeld) carries holdable:false (ICR 0018)', () => {
    const pr = FIXTURES.find((f) => f.event === 'PermissionRequest');
    const r = raw('PermissionRequest', pr?.payload, { transport: 'unix', holdable: false });
    expect(one(normalizeHook(r, ctx).observations, 'permission.requested').holdable).toBe(false);
  });
});

describe('rev 2 §10 A5: session ids are never filtered', () => {
  it('passes an unexpected session_id through to meta', () => {
    const r = normalizeHook(raw('Stop', ev('Stop', { session_id: 'ffffffff-0000-4000-8000-000000000000', stop_hook_active: false })), ctx);
    expect(r.rejected).toBeUndefined();
    expect(r.observations[0]?.meta.claudeSessionId).toBe('ffffffff-0000-4000-8000-000000000000');
  });

  it('accepts a payload without session_id (no claudeSessionId in meta)', () => {
    const p = ev('Stop');
    delete p['session_id'];
    const r = normalizeHook(raw('Stop', p), ctx);
    expect(r.rejected).toBeUndefined();
    expect('claudeSessionId' in (r.observations[0]?.meta ?? {})).toBe(false);
  });
});

describe('ICR 0041: session_crons', () => {
  it('Stop carries the number of in-session scheduled tasks; absent stays absent', () => {
    const withCrons = normalizeHook(raw('Stop', ev('Stop', { stop_hook_active: false, session_crons: [{ id: 'a' }, { id: 'b' }] })), ctx);
    expect(one(withCrons.observations, 'turn.stopped').sessionCrons).toBe(2);
    const without = normalizeHook(raw('Stop', ev('Stop', { stop_hook_active: false })), ctx);
    expect('sessionCrons' in one(without.observations, 'turn.stopped')).toBe(false);
  });
});

describe('P-HOOK-44: untrusted payloads', () => {
  it('rejects a hook_event_name that differs from the routed event, with no observation', () => {
    const r = normalizeHook(raw('Stop', ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1' })), ctx);
    expect(r).toEqual({ observations: [], rejected: 'eventMismatch' });
  });

  it('accepts a payload with no hook_event_name (route is authenticated)', () => {
    const p = ev('Stop', { stop_hook_active: false });
    delete p['hook_event_name'];
    expect(normalizeHook(raw('Stop', p), ctx).observations[0]?.kind).toBe('turn.stopped');
  });

  it.each([null, 42, 'text', [1, 2], undefined])('non-object payload %j → malformed + unknown', (payload) => {
    const r = normalizeHook(raw('Stop', payload), ctx);
    expect(r.rejected).toBe('malformed');
    expect(r.observations.map((o) => o.kind)).toEqual(['unknown']);
    expect(one(r.observations, 'unknown').channel).toBe('hook');
  });

  it('truncated body → malformed, payload not echoed', () => {
    const r = normalizeHook(raw('PostToolUse', undefined, { truncated: true, bytes: 40 * 1024 * 1024 }), ctx);
    expect(r.rejected).toBe('malformed');
    expect(one(r.observations, 'unknown').raw).toMatchObject({ event: 'PostToolUse', reason: 'truncated', truncated: true, payload: null });
  });

  it.each([
    ['PreToolUse', { tool_name: 'Bash' }, 'tool_use_id'],
    ['PostToolUse', { tool_use_id: 'toolu_1' }, 'tool_name'],
    ['PostToolUseFailure', { tool_name: 'Bash' }, 'tool_use_id'],
    ['PermissionRequest', {}, 'tool_name'],
    ['PermissionDenied', { tool_name: 'Bash' }, 'tool_use_id'],
    ['SubagentStart', {}, 'agent_id'],
    ['SubagentStop', { agent_id: '' }, 'agent_id'],
    ['MessageDisplay', { turn_id: 't' }, 'message_id'],
    ['UserPromptSubmit', {}, 'prompt'],
    ['PostModelSwitch', {}, 'to_model'],
    ['CwdChanged', { old_cwd: '/a' }, 'new_cwd'],
  ] as const)('%s without a required field → malformed (%s)', (event, extra, missing) => {
    const r = normalizeHook(raw(event, ev(event, extra)), ctx);
    expect(r.rejected).toBe('malformed');
    expect(one(r.observations, 'unknown').raw).toMatchObject({ reason: `missing:${missing}` });
  });

  it('SessionStart without session_id → malformed', () => {
    const p = ev('SessionStart', { source: 'startup' });
    delete p['session_id'];
    expect(normalizeHook(raw('SessionStart', p), ctx).rejected).toBe('malformed');
  });

  it('never throws on arbitrary JSON payloads (P-REC-20)', () => {
    const events = [...hooksProfile.observationEvents, ...hooksProfile.commandEvents, 'PostToolBatch', 'Bogus'];
    fc.assert(
      fc.property(fc.constantFrom(...events), fc.jsonValue(), fc.boolean(), (event, payload, named) => {
        const p =
          named && typeof payload === 'object' && payload !== null && !Array.isArray(payload)
            ? { ...payload, hook_event_name: event }
            : payload;
        const r = normalizeHook(raw(event, p), ctx);
        expect(Array.isArray(r.observations)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('a payload whose field read throws → malformed + unknown{normalizerError}, never a throw (P-REC-20)', () => {
    const hostile: Record<string, unknown> = { hook_event_name: 'Stop' };
    Object.defineProperty(hostile, 'stop_hook_active', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    let r: ReturnType<typeof normalizeHook> | undefined;
    expect(() => {
      r = normalizeHook(rawBytes('Stop', hostile, 64, { hookSeq: 4242 as HookSeq }), ctx);
    }).not.toThrow();
    expect(r?.rejected).toBe('malformed');
    expect(r?.observations).toHaveLength(1);
    const o = r?.observations[0];
    expect(o?.kind).toBe('unknown');
    expect(o?.meta).toMatchObject({ source: 'hook', origin: { kind: 'hook', event: 'Stop', hookSeq: 4242 } });
    expect(o?.p).toMatchObject({ channel: 'hook', raw: { event: 'Stop', reason: 'normalizerError', message: 'boom', payload: null } });
  });

  it('a thrown value with a hostile toString is still reported', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'hook_event_name', {
      enumerable: true,
      get(): never {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw {
          toString(): string {
            throw new Error('nested');
          },
        };
      },
    });
    const r = normalizeHook(rawBytes('Stop', hostile, 64), ctx);
    expect(r.rejected).toBe('malformed');
    expect(one(r.observations, 'unknown').raw).toMatchObject({ reason: 'normalizerError', message: 'unprintable error' });
  });

  it('own-property reads only: __proto__ / constructor keys are plain data', () => {
    const p = JSON.parse(
      '{"hook_event_name":"Notification","__proto__":{"notification_type":"elicitation_dialog"},"message":"m"}',
    ) as unknown;
    const r = normalizeHook(raw('Notification', p), ctx);
    expect(one(r.observations, 'notification').type).toBe('unknown');
    expect(only(r.observations, 'input.requested')).toHaveLength(0);
  });
});

describe('P-DOCS-03 / P-DOCS-04: optional common fields', () => {
  it('permission_mode → mode.observed; manual → default', () => {
    const r = normalizeHook(
      raw('PreToolUse', ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {}, permission_mode: 'manual' })),
      ctx,
    );
    expect(one(r.observations, 'mode.observed').permissionMode).toBe('default');
  });

  it('acceptEdits passes unchanged, also onto permission.requested', () => {
    const r = normalizeHook(
      raw('PermissionRequest', ev('PermissionRequest', { tool_name: 'Edit', tool_input: {}, permission_mode: 'acceptEdits' })),
      ctx,
    );
    expect(one(r.observations, 'permission.requested').permissionMode).toBe('acceptEdits');
    expect(one(r.observations, 'mode.observed').permissionMode).toBe('acceptEdits');
  });

  it('no permission_mode → no mode fact', () => {
    const r = normalizeHook(raw('SessionStart', ev('SessionStart', { source: 'startup' })), ctx);
    expect(only(r.observations, 'mode.observed')).toHaveLength(0);
  });

  it('prompt_id absent → no promptId key (before the first input)', () => {
    const r = normalizeHook(raw('Notification', ev('Notification', { notification_type: 'idle_prompt', message: 'waiting' })), ctx);
    expect('promptId' in one(r.observations, 'notification')).toBe(false);
    const ups = one(normalizeHook(raw('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'hi' })), ctx).observations, 'prompt.submitted');
    expect(ups).toEqual({ promptId: '', text: 'hi' });
  });

  it('SessionStart: source + model; model absent on clear', () => {
    const a = one(
      normalizeHook(raw('SessionStart', ev('SessionStart', { source: 'startup', model: 'claude-opus-5-5' }), { transport: 'unix' }), ctx)
        .observations,
      'session.started',
    );
    expect(a).toEqual({
      sessionId: common.session_id,
      transcriptPath: common.transcript_path,
      source: 'startup',
      model: 'claude-opus-5-5',
    });
    const b = one(normalizeHook(raw('SessionStart', ev('SessionStart', { source: 'clear' })), ctx).observations, 'session.started');
    expect('model' in b).toBe(false);
  });
});

describe('per-event mapping (§2.4 additions, RC §2.3)', () => {
  it('UserPromptSubmit <task-notification> → taskNotification', () => {
    const prompt =
      '<task-notification>\n<task-id>a573b9447668a3ed7</task-id>\n<tool-use-id>toolu_01EosBNtb385zzTVg8iuUZ9R</tool-use-id>\n<output-file>/TMP/tasks/a573b9447668a3ed7.output</output-file>\n<status>completed</status>\n<summary>Agent "Read package.json name" finished</summary>\n</task-notification>';
    const p = one(
      normalizeHook(raw('UserPromptSubmit', ev('UserPromptSubmit', { prompt, prompt_id: 'ab6278e5' })), ctx).observations,
      'prompt.submitted',
    );
    expect(p.taskNotification).toEqual({ taskId: 'a573b9447668a3ed7', toolUseId: 'toolu_01EosBNtb385zzTVg8iuUZ9R', status: 'completed' });
    expect(p.promptId).toBe('ab6278e5');
    expect(p.text).toBe(prompt);
  });

  it('a prompt that merely mentions <task-notification> is not one', () => {
    const p = one(
      normalizeHook(raw('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'explain <task-notification><task-id>x</task-id>' })), ctx)
        .observations,
      'prompt.submitted',
    );
    expect('taskNotification' in p).toBe(false);
  });

  it('PostToolUse async_launched → asyncAgentId (P-REC-06); foreground Agent has none', () => {
    const asyncP = one(
      normalizeHook(
        raw(
          'PostToolUse',
          ev('PostToolUse', {
            tool_name: 'Agent',
            tool_use_id: 'toolu_A',
            tool_input: { prompt: 'x' },
            tool_response: { status: 'async_launched', agentId: 'a1028a887bdb3ce93' },
            duration_ms: 12,
          }),
        ),
        ctx,
      ).observations,
      'tool.post',
    );
    expect(asyncP).toMatchObject({
      toolUseId: 'toolu_A',
      toolName: 'Agent',
      asyncAgentId: 'a1028a887bdb3ce93',
      durationMs: 12,
      input: { prompt: 'x' },
    });
    const fg = one(
      normalizeHook(
        raw(
          'PostToolUse',
          ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_B', tool_response: { status: 'completed', agentId: 'a2' } }),
        ),
        ctx,
      ).observations,
      'tool.post',
    );
    expect('asyncAgentId' in fg).toBe(false);
  });

  it('PostToolUseFailure → tool.failed with is_interrupt', () => {
    const p = one(
      normalizeHook(
        raw(
          'PostToolUseFailure',
          ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'toolu_F', error: 'Exit code 1', is_interrupt: true }),
        ),
        ctx,
      ).observations,
      'tool.failed',
    );
    expect(p).toEqual({ toolUseId: 'toolu_F', toolName: 'Bash', error: 'Exit code 1', isInterrupt: true });
  });

  it('PostToolBatch → tool.batchDone with every tool_use_id and the agent', () => {
    const p = one(
      normalizeHook(
        raw(
          'PostToolBatch',
          ev('PostToolBatch', {
            agent_id: 'a1',
            agent_type: 'general-purpose',
            tool_calls: [{ tool_use_id: 'toolu_1' }, { tool_use_id: 'toolu_2' }, { nope: 1 }, 'x'],
          }),
        ),
        ctx,
      ).observations,
      'tool.batchDone',
    );
    expect(p).toEqual({ toolUseIds: ['toolu_1', 'toolu_2'], agent: { agentId: 'a1', agentType: 'general-purpose' } });
  });

  it('PermissionDenied → permission.autoDenied', () => {
    const p = one(
      normalizeHook(
        raw('PermissionDenied', ev('PermissionDenied', { tool_name: 'Bash', tool_use_id: 'toolu_D', reason: 'Classifier unavailable' })),
        ctx,
      ).observations,
      'permission.autoDenied',
    );
    expect(p).toEqual({ toolUseId: 'toolu_D', toolName: 'Bash', reason: 'Classifier unavailable' });
  });

  it('Stop: background_tasks kept; stop_hook_active; teammate task → bgtask.status (§2.4, D-24)', () => {
    const r = normalizeHook(
      raw(
        'Stop',
        ev('Stop', {
          prompt_id: 'p1',
          stop_hook_active: true,
          last_assistant_message: 'done',
          background_tasks: [
            { id: 'a1028a887bdb3ce93', type: 'subagent', status: 'running', description: 'Run sleep', agent_type: 'general-purpose' },
            { id: 'tm1', type: 'teammate', status: 'idle' },
            { type: 'shell' },
            'junk',
          ],
        }),
      ),
      ctx,
    );
    const s = one(r.observations, 'turn.stopped');
    expect(s.stopHookActive).toBe(true);
    expect(s.lastAssistantMessage).toBe('done');
    expect(s.backgroundTasks).toEqual([
      { id: 'a1028a887bdb3ce93', type: 'subagent', status: 'running', description: 'Run sleep', agentType: 'general-purpose' },
      { id: 'tm1', type: 'teammate', status: 'idle' },
    ]);
    expect(one(r.observations, 'bgtask.status')).toEqual({ taskId: 'tm1', taskType: 'teammate', status: 'idle' });
  });

  it('StopFailure → turn.failed', () => {
    const p = one(
      normalizeHook(
        raw(
          'StopFailure',
          ev('StopFailure', {
            prompt_id: 'p',
            error: 'rate_limit',
            error_details: '429 Too Many Requests',
            last_assistant_message: 'API Error: Rate limit reached',
          }),
        ),
        ctx,
      ).observations,
      'turn.failed',
    );
    expect(p).toEqual({
      promptId: 'p',
      error: 'rate_limit',
      errorDetails: '429 Too Many Requests',
      message: 'API Error: Rate limit reached',
    });
  });

  it('SubagentStart → agent.started; teammate_name → AgentRef.teammateName', () => {
    const p = one(
      normalizeHook(
        raw(
          'SubagentStart',
          ev('SubagentStart', { agent_id: 'a9', agent_type: 'general-purpose', teammate_name: 'reviewer', prompt_id: 'p2' }),
        ),
        ctx,
      ).observations,
      'agent.started',
    );
    expect(p).toEqual({ agent: { agentId: 'a9', agentType: 'general-purpose', teammateName: 'reviewer' }, promptId: 'p2' });
    const pre = one(
      normalizeHook(
        raw(
          'PreToolUse',
          ev('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_t', tool_input: {}, agent_id: 'a9', teammate_name: 'reviewer' }),
        ),
        ctx,
      ).observations,
      'tool.pre',
    );
    expect(pre.agent?.teammateName).toBe('reviewer');
  });

  it('teammate_name without agent_id → AgentRef keyed teammate:<name> (§4.5.9), also on meta.agentId', () => {
    const r = normalizeHook(raw('SubagentStart', ev('SubagentStart', { teammate_name: 'reviewer', agent_type: 'teammate' })), ctx);
    expect(r.rejected).toBeUndefined();
    expect(one(r.observations, 'agent.started').agent).toEqual({
      agentId: 'teammate:reviewer',
      agentType: 'teammate',
      teammateName: 'reviewer',
    });
    const pre = normalizeHook(
      raw('PreToolUse', ev('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_tm', tool_input: {}, teammate_name: 'reviewer' })),
      ctx,
    ).observations;
    expect(one(pre, 'tool.pre').agent).toEqual({ agentId: 'teammate:reviewer', teammateName: 'reviewer' });
    expect(pre[0]?.meta.agentId).toBe('teammate:reviewer');
    // An empty teammate_name is not an attribution.
    const main = normalizeHook(
      raw('PreToolUse', ev('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_m', tool_input: {}, teammate_name: '' })),
      ctx,
    ).observations;
    expect(one(main, 'tool.pre').agent).toBeUndefined();
    expect(main[0]?.meta.agentId).toBeUndefined();
  });

  it.each([
    ['elicitation_dialog', 'elicitation'],
    ['elicitation_url_dialog', 'elicitationUrl'],
    ['agent_needs_input', 'agentNeedsInput'],
  ] as const)('Notification %s → input.requested + notification (P-REV-14)', (type, kind) => {
    const r = normalizeHook(
      raw('Notification', ev('Notification', { notification_type: type, message: 'MCP server wants input', server_name: 'figma' })),
      ctx,
    );
    expect(r.observations.map((o) => o.kind)).toEqual(['input.requested', 'notification']);
    expect(one(r.observations, 'input.requested')).toEqual({ kind, message: 'MCP server wants input', server: 'figma' });
    expect(one(r.observations, 'notification')).toEqual({ type, message: 'MCP server wants input' });
  });

  it.each([
    ['elicitation_complete', 'complete'],
    ['elicitation_response', 'response'],
  ] as const)('Notification %s → input.requestCleared only', (type, how) => {
    const r = normalizeHook(raw('Notification', ev('Notification', { notification_type: type })), ctx);
    expect(r.observations.map((o) => o.kind)).toEqual(['input.requestCleared']);
    expect(one(r.observations, 'input.requestCleared')).toEqual({ kind: 'elicitation', how });
  });

  it('quota_auto_resume_* stays a plain notification (core interprets, §3.9)', () => {
    const r = normalizeHook(
      raw('Notification', ev('Notification', { notification_type: 'quota_auto_resume_fired', message: 'Resuming' })),
      ctx,
    );
    expect(r.observations.map((o) => o.kind)).toEqual(['notification']);
  });

  it('PreCompact / PostCompact → compact.phase', () => {
    expect(one(normalizeHook(raw('PreCompact', ev('PreCompact', { trigger: 'manual' })), ctx).observations, 'compact.phase')).toEqual({
      phase: 'started',
      trigger: 'manual',
    });
    expect(
      one(
        normalizeHook(raw('PostCompact', ev('PostCompact', { trigger: 'auto', compact_summary: 's' })), ctx).observations,
        'compact.phase',
      ),
    ).toEqual({ phase: 'finished', trigger: 'auto' });
  });

  it('PostModelSwitch → model.switched', () => {
    const p = one(
      normalizeHook(raw('PostModelSwitch', ev('PostModelSwitch', { from_model: 'a', to_model: 'b', source: 'auto' })), ctx).observations,
      'model.switched',
    );
    expect(p).toEqual({ fromModel: 'a', toModel: 'b', source: 'auto' });
  });

  it('ConfigChange → config.changed (P-SEC-30)', () => {
    const p = one(
      normalizeHook(raw('ConfigChange', ev('ConfigChange', { source: 'project_settings', file_path: '/repo/.claude/settings.json' })), ctx)
        .observations,
      'config.changed',
    );
    expect(p).toEqual({ source: 'project_settings', filePath: '/repo/.claude/settings.json' });
  });

  it('CwdChanged → cwd.changed', () => {
    const p = one(normalizeHook(raw('CwdChanged', ev('CwdChanged', { old_cwd: '/a', new_cwd: '/b' })), ctx).observations, 'cwd.changed');
    expect(p).toEqual({ oldCwd: '/a', newCwd: '/b' });
  });

  it('an event this profile does not map → unknown passthrough (not rejected)', () => {
    const r = normalizeHook(raw('TeammateIdle', ev('TeammateIdle', { teammate_name: 'x' })), ctx);
    expect(r.rejected).toBeUndefined();
    expect(one(r.observations, 'unknown')).toMatchObject({ channel: 'hook', raw: { event: 'TeammateIdle' } });
  });

  it('hooks are never de-duplicated: two identical Stop{stop_hook_active:true} both map', () => {
    const p = ev('Stop', { stop_hook_active: true, prompt_id: 'p' });
    const a = normalizeHook(raw('Stop', p), ctx).observations;
    const b = normalizeHook(raw('Stop', p), ctx).observations;
    expect(a[0]?.p).toEqual(b[0]?.p);
    expect(a[0]?.meta.origin).not.toEqual(b[0]?.meta.origin);
  });
});

describe('task-notification parser', () => {
  it('parses the subagent-file form with the system banner', () => {
    const text =
      '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated event.\n<task-notification>\n<task-id>a1</task-id>\n<status>failed</status>\n</task-notification>';
    expect(isTaskNotification(text, hookExtras)).toBe(true);
    expect(parseTaskNotification(text, hookExtras)).toEqual({ taskId: 'a1', status: 'failed' });
  });

  it('keeps output-file and summary; tolerates a missing close tag; unknown status default', () => {
    expect(
      parseTaskNotification('  <task-notification><task-id>b2</task-id><output-file>/o</output-file><summary>S</summary>', hookExtras),
    ).toEqual({
      taskId: 'b2',
      status: 'unknown',
      outputFile: '/o',
      summary: 'S',
    });
  });

  it('no task-id → undefined; banner without notification → undefined', () => {
    expect(parseTaskNotification('<task-notification><status>completed</status></task-notification>', hookExtras)).toBeUndefined();
    expect(parseTaskNotification('[SYSTEM NOTIFICATION - NOT USER INPUT] hello', hookExtras)).toBeUndefined();
    expect(isTaskNotification('hello', hookExtras)).toBe(false);
  });
});

describe('hooks profile registration table (§3.4)', () => {
  it('observation, command and never-registered sets are disjoint', () => {
    const obs = new Set(hooksProfile.observationEvents);
    for (const e of hooksProfile.commandEvents) expect(obs.has(e)).toBe(false);
    for (const e of hooksProfile.neverRegister) {
      expect(obs.has(e)).toBe(false);
      expect((hooksProfile.commandEvents as readonly string[]).includes(e)).toBe(false);
    }
    for (const e of hookExtras.optInEvents) expect(obs.has(e)).toBe(false);
  });

  it('PostToolBatch is opt-in, PreToolUse/MessageDisplay are switchable, PreModelSwitch is never registered', () => {
    expect(hookExtras.optInEvents).toEqual(['PostToolBatch']);
    expect(hookExtras.switchableEvents).toEqual(['PreToolUse', 'MessageDisplay']);
    expect(hooksProfile.neverRegister).toContain('PreModelSwitch');
    expect(hooksProfile.neverRegister).toContain('WorktreeCreate');
    expect(hookExtras.timeoutsSec).toEqual({ default: 5, MessageDisplay: 3 });
  });

  it('every registrable event has a mapping (none falls through to unknown)', () => {
    const minimal: Readonly<Record<string, Record<string, unknown>>> = {
      UserPromptSubmit: { prompt: 'x' },
      PreToolUse: { tool_name: 'Bash', tool_use_id: 'toolu_1' },
      PostToolUse: { tool_name: 'Bash', tool_use_id: 'toolu_1' },
      PostToolUseFailure: { tool_name: 'Bash', tool_use_id: 'toolu_1' },
      PermissionDenied: { tool_name: 'Bash', tool_use_id: 'toolu_1' },
      SubagentStart: { agent_id: 'a1' },
      SubagentStop: { agent_id: 'a1' },
      MessageDisplay: { turn_id: 't', message_id: 'm' },
      PostModelSwitch: { to_model: 'm' },
      CwdChanged: { new_cwd: '/b' },
      PermissionRequest: { tool_name: 'Bash' },
    };
    for (const e of [...hooksProfile.observationEvents, ...hooksProfile.commandEvents, ...hookExtras.optInEvents]) {
      const r = normalizeHook(raw(e, ev(e, minimal[e] ?? {})), ctx);
      expect(r.rejected, e).toBeUndefined();
      expect(
        r.observations.some((o) => o.kind === 'unknown'),
        e,
      ).toBe(false);
    }
  });
});

describe('heldUnclaimed (ICR 0026: a held PermissionRequest L1 rejects must be released)', () => {
  const held = (payload: unknown, o: Partial<RawHookEvent> = {}): RawHookEvent =>
    raw('PermissionRequest', payload, { transport: 'unix', holdable: true, ...o });
  const check = (r: RawHookEvent): boolean => heldUnclaimed(r, normalizeHook(r, ctx));

  it('a valid held request is claimed (the core answers it)', () => {
    expect(check(held(ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })))).toBe(false);
  });
  it('eventMismatch, missing/empty tool_name, non-object and truncated held requests are unclaimed', () => {
    expect(check(held(ev('Stop', { tool_name: 'Bash', tool_input: {} })))).toBe(true);
    expect(check(held(ev('PermissionRequest', { tool_input: {} })))).toBe(true);
    expect(check(held(ev('PermissionRequest', { tool_name: '', tool_input: {} })))).toBe(true);
    expect(check(held([1, 2]))).toBe(true);
    expect(check(held(null, { truncated: true }))).toBe(true);
  });
  it('a normalizer failure (no result) on a held request is unclaimed; non-holdable events never are', () => {
    expect(heldUnclaimed(held({}), undefined)).toBe(true);
    const notHeld = raw('PermissionRequest', ev('PermissionRequest', { tool_input: {} }), { transport: 'unix', holdable: false });
    expect(check(notHeld)).toBe(false);
    expect(heldUnclaimed(notHeld, undefined)).toBe(false);
  });
});
