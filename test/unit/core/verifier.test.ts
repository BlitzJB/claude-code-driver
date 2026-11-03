// WP-09 verifier regressions: behaviours DESIGN.md requires that the first implementation pass missed.
//   §2.9 I6 (only Escape while a request is held), §4.5.1 (agent equality for a carried agent_id; permission.rebound),
//   §3.7 step 4 (AskUserQuestion needs its answers), §4.8 rule 3 (foreground agent tools close with their generation),
//   §4.11 (immediate captures on PermissionRequest, tunnel error, byte stall).
import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '../../../src/model/ids.js';
import type { CoreConfig } from '../../../src/model/config.js';
import { emit, newCtx } from '../../../src/core/ctx.js';
import type { Harness } from './harness.js';
import { SESSION_ID, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

const P1 = 'p1' as PermissionKey;
function session(policy: CoreConfig['permissions']['policy'] = 'ask', over: Partial<CoreConfig> = {}): Harness {
  const h = readyHarness(testConfig({ ...over, permissions: { policy } }));
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
const pre = (h: Harness, id: string, tool: string, input: unknown, agentId?: string): Harness =>
  h.hook(
    'tool.pre',
    { toolUseId: id, toolName: tool, input, promptId: 'p1', ...(agentId !== undefined ? { agent: { agentId } } : {}) },
    'PreToolUse',
  );
const request = (h: Harness, tool: string, input: unknown, agentId?: string): Harness =>
  h.hook(
    'permission.requested',
    {
      hookSeq: h.nextHookSeq(),
      toolName: tool,
      input,
      suggestions: [],
      promptId: 'p1',
      ...(agentId !== undefined ? { agent: { agentId } } : {}),
    },
    'PermissionRequest',
  );

describe('§2.9 I6: while a request is held only Escape reaches the pane', () => {
  it('every key but Escape and every text primitive is withheld (I6_guard); Escape passes', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' });
    expect(h.d.inputBlocked.permission).toBe(true);
    const ctx = newCtx(h.core);
    for (const k of ['Enter', 'Up', 'Down', 'BTab', 'C-g', '1'] as const) {
      expect(emit<'input'>(ctx, { kind: 'input', job: 'j99' as never, step: 1, primitive: { kind: 'key', key: k, gapAfterMs: 0 } })).toBe(
        undefined,
      );
    }
    expect(emit<'input'>(ctx, { kind: 'input', job: 'j99' as never, step: 1, primitive: { kind: 'typeLiteral', text: 'x' } })).toBe(
      undefined,
    );
    expect(ctx.diagnostics.filter((d) => d.code === 'I6_guard')).toHaveLength(7);
    const esc = emit<'input'>(ctx, {
      kind: 'input',
      job: 'j99' as never,
      step: 1,
      primitive: { kind: 'key', key: 'Escape', gapAfterMs: 250 },
    });
    expect(esc).toBeDefined();
    expect(ctx.intents).toHaveLength(1);
  });
});

describe('§4.11 immediate captures', () => {
  it('a PermissionRequest asks for an immediate screen capture', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    const before = h.intentsOf('screen.captureNow').length;
    request(h, 'Bash', { command: 'ls' });
    expect(
      h
        .intentsOf('screen.captureNow')
        .slice(before)
        .map((i) => i.reason),
    ).toEqual(['permissionRequest']);
  });

  it('a model tunnel error and a byte stall > quietMs ask for an immediate capture', () => {
    const h = session('ask');
    h.obs('net.tunnel', { tunnelId: 1, host: 'api.anthropic.com', token: 'A', phase: 'sending', bytesUp: 10, bytesDown: 0 }, 'network');
    h.tx('model.requestStarted', { requestRef: 'txreq:a', isRetry: false, txWall: h.wall as never }, { uuid: 'txreq:a' });
    expect(h.d.calls['c1' as never]?.tunnelId).toBe(1);
    h.obs(
      'net.tunnel',
      {
        tunnelId: 1,
        host: 'api.anthropic.com',
        token: 'A',
        phase: 'receiving',
        bytesUp: 10,
        bytesDown: 50,
        lastDownAtMono: h.now as never,
      },
      'network',
    );
    const before = h.intentsOf('screen.captureNow').length;
    h.run(15_100, 500);
    expect(
      h
        .intentsOf('screen.captureNow')
        .slice(before)
        .map((i) => i.reason),
    ).toContain('net:byteStall');
    const mid = h.intentsOf('screen.captureNow').length;
    h.obs('net.tunnel', { tunnelId: 1, host: 'api.anthropic.com', token: 'A', phase: 'error', bytesUp: 10, bytesDown: 50 }, 'network');
    expect(
      h
        .intentsOf('screen.captureNow')
        .slice(mid)
        .map((i) => i.reason),
    ).toEqual(['net:error']);
  });
});

describe('§4.5.1 binding needs agent equality when agent_id is carried (P-REC-44)', () => {
  it('a request from an unknown agent never binds an identical main-thread tool and is never auto-answered', () => {
    const h = session('dangerouslyAllowAll');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' }, 'ghost-agent');
    const rec = h.d.permissions[P1];
    expect(rec?.binding.kind).toBe('unbound');
    expect(rec?.tool).toBeUndefined();
    expect(rec?.autoAnswerAllowed).toBe(false);
    expect(h.intentsOf('hook.respond')).toHaveLength(0);
    expect(h.intentsOf('host.askPermission')).toHaveLength(1);
    expect(h.d.tools['u1' as never]?.permission).toBeUndefined();
  });

  it('the late PreToolUse of that agent binds it (by raw agent_id); the main-thread twin stays free', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' }, 'ghost-agent');
    pre(h, 'toolu_2', 'Bash', { command: 'ls' }, 'ghost-agent');
    const rec = h.d.permissions[P1];
    expect(rec?.tool).toBe('u2');
    expect(h.d.tools['u2' as never]?.permission).toBe('p1');
    expect(h.d.tools['u1' as never]?.permission).toBeUndefined();
    expect(h.ev('permission.bound').map((e) => e.payload)).toEqual([{ permissionKey: 'p1', toolKey: 'u2', confirmed: false }]);
  });
});

describe('§4.5.1 evidence of a wrong guess → permission.rebound', () => {
  it('an attachment naming the other of two equivalent tools moves the record there and resolves it', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    pre(h, 'toolu_2', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' });
    expect(h.d.permissions[P1]).toMatchObject({ tool: 'u1', binding: { kind: 'ambiguous-equivalent', confirmed: false } });
    h.tx('permission.decisionRecorded', { toolUseId: 'toolu_2', decision: 'accept', decider: 'user_keys', via: 'attachment' });
    expect(h.ev('permission.rebound').map((e) => e.payload)).toEqual([{ permissionKey: 'p1', toolKey: 'u2', confirmed: true }]);
    expect(h.d.permissions[P1]).toMatchObject({ tool: 'u2', binding: { kind: 'ambiguous-equivalent', confirmed: true } });
    expect(h.d.permissions[P1]?.state.value).toBe('resolved');
    expect(h.d.tools['u2' as never]?.permission).toBe('p1');
    expect(h.d.tools['u2' as never]?.state.value).toBe('running');
    expect(h.d.tools['u1' as never]?.permission).toBeUndefined();
  });

  it('a confirmed binding is never moved', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    pre(h, 'toolu_2', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' });
    h.tx('permission.decisionRecorded', { toolUseId: 'toolu_1', decision: 'accept', decider: 'user_keys', via: 'attachment' });
    h.tx('permission.decisionRecorded', { toolUseId: 'toolu_2', decision: 'accept', decider: 'user_keys', via: 'attachment' });
    expect(h.ev('permission.rebound')).toHaveLength(0);
    expect(h.d.permissions[P1]?.tool).toBe('u1');
    expect(h.diag('decision_without_permission')).toHaveLength(1);
  });
});

describe('§3.7 step 4: AskUserQuestion is answered only with its answers', () => {
  it('a raw allow whose updatedInput has no answers → E_PERMISSION_INVALID{structuredAnswerRequired}, still pending', () => {
    const h = session('ask');
    const input = { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] };
    pre(h, 'toolu_q', 'AskUserQuestion', input);
    request(h, 'AskUserQuestion', input);
    const r = h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'allow', updatedInput: input }, by: 'host' });
    expect(r).toMatchObject({ ok: false, error: { code: 'E_PERMISSION_INVALID', details: { reason: 'structuredAnswerRequired' } } });
    expect(h.d.permissions[P1]?.state.value).toBe('pending');
    expect(h.intentsOf('hook.respond')).toHaveLength(0);
    const ok = h.cmd({ type: 'permission.answerQuestion', permissionKey: P1, answers: { 'Which?': 'A' } });
    expect(ok?.ok).toBe(true);
    expect(h.intentsOf('hook.respond')[0]?.body?.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which?': 'A' } },
    });
  });
});

describe('§4.8 rule 3: a generation end closes foreground subagents with their tools and permissions', () => {
  it('/clear: the sync subagent → unknown, its running tool → unknown(agent_stopped), its held request abandoned + released', () => {
    const h = session('ask');
    h.hook('tool.pre', { toolUseId: 'toolu_a', toolName: 'Agent', input: { subagent_type: 'Explore', prompt: 'go' } }, 'PreToolUse');
    h.hook('agent.started', { agent: { agentId: 'ag1', agentType: 'Explore' } }, 'SubagentStart');
    pre(h, 'toolu_s', 'Bash', { command: 'ls' }, 'ag1');
    request(h, 'Bash', { command: 'ls' }, 'ag1');
    expect(h.d.permissions[P1]?.tool).toBe('u2');
    h.hook('session.ended', { sessionId: SESSION_ID, reason: 'clear' }, 'SessionEnd');
    expect(h.d.agents['a1' as never]?.state.value).toBe('unknown');
    expect(h.d.tools['u2' as never]?.state).toMatchObject({ value: 'unknown' });
    expect(h.d.tools['u2' as never]?.error).toBe('agent_stopped');
    expect(h.d.permissions[P1]?.state.value).toBe('abandoned');
    expect(h.intentsOf('hook.respond').map((i) => i.body)).toEqual([null]);
  });
});

describe('§3.6 Commands: /model "saved as your default" (LC §10.3)', () => {
  it('the result line → session.modelChanged{savedAsDefault:true} + warning; "for this session only" is silent', () => {
    const h = readyHarness();
    h.cmd({ type: 'slash.run', name: '/model', args: 'opus' });
    const id = h.lastCmdId();
    h.run(300);
    h.tx(
      'prompt.recorded',
      {
        uuid: 'lc1',
        parentUuid: null,
        isMeta: false,
        localCommand: { name: '/model', args: 'opus', stdout: 'Set model to opus and saved as your default for new sessions' },
      },
      { uuid: 'lc1' },
    );
    expect(h.ev('session.modelChanged').map((e) => e.payload)).toEqual([{ model: 'opus', source: 'command', savedAsDefault: true }]);
    expect(h.ev('warning').map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ detail: { reason: 'modelSavedAsDefault', model: 'opus' } }),
    );
    expect(h.resultFor(id)).toMatchObject({ ok: true, value: { effect: 'evidence' } });
    h.tx(
      'prompt.recorded',
      {
        uuid: 'lc2',
        parentUuid: null,
        isMeta: false,
        localCommand: { name: '/model', stdout: 'Set model to sonnet for this session only' },
      },
      { uuid: 'lc2' },
    );
    expect(h.ev('session.modelChanged')).toHaveLength(1);
  });
});

const escapes = (h: Harness): number => h.primitives().filter((p) => p.kind === 'key' && p.key === 'Escape').length;

describe('§3.6 Interrupt timing (P-INPUT-23, P-LIFE-05)', () => {
  it('an interrupt while our submit awaits its UPS ack sends no Escape until the ack (Esc during UPS hooks cancels the prompt)', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'long task');
    expect(h.core.input.current).toBeDefined(); // the submit job is still waiting for its ack
    h.cmd({ type: 'interrupt' });
    h.run(500);
    expect(escapes(h)).toBe(0);
    ups(h, 'long task', 'p1');
    expect(escapes(h)).toBe(1);
  });

  it('an interrupt queued behind a submit that then fails is dropped as notBusy (no stray Escape on an idle box)', () => {
    const run = (withInterrupt: boolean): Harness => {
      const h = readyHarness();
      const turn = sendUntilEnter(h, 'lost prompt');
      if (withInterrupt) h.cmd({ type: 'interrupt' });
      h.run(12_000, 100); // no UPS, no transcript: the submit fails (E_SUBMIT_UNCONFIRMED)
      expect(h.d.turns[turn as never]?.state.value).toBe('notSubmitted');
      return h;
    };
    const base = run(false);
    const h = run(true);
    expect(escapes(h)).toBe(escapes(base)); // only the composer clear's own keys, none from the interrupt
    expect(h.ev('interrupt.ignored').map((e) => e.payload)).toContainEqual({ reason: 'notBusy' });
    expect(h.core.input.current).toBeUndefined();
    expect(Object.values(h.core.input.jobs).some((j) => j.kind === 'interrupt')).toBe(false);
  });

  it('an interrupt is one Escape and nothing else: never C-c, never SIGINT, no signal at all', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'long task');
    ups(h, 'long task', 'p1');
    const before = h.primitives().length;
    h.cmd({ type: 'interrupt' });
    h.run(6000);
    const after = h.primitives().slice(before);
    expect(after).toEqual([{ kind: 'key', key: 'Escape', gapAfterMs: 250 }]);
    expect(h.intentsOf('process.signal')).toEqual([]);
    expect(h.ev('interrupt.ignored').map((e) => e.payload)).toEqual([{ reason: 'noEvidence' }]);
  });
});

describe('§4.5.4 quiescence counts pending task notifications (queue.op enqueue without dequeue)', () => {
  it('an enqueued <task-notification> keeps idle non-quiescent until it is dequeued', () => {
    const h = readyHarness();
    expect(h.d.status).toMatchObject({ kind: 'idle', quiescent: true });
    h.tx('queue.op', { op: 'enqueue', content: '<task-notification><task-id>bg</task-id></task-notification>' }, { uuid: 'q1' });
    expect(h.d.status).toMatchObject({ kind: 'idle', quiescent: false });
    h.tx('queue.op', { op: 'enqueue', content: 'a plain queued prompt' }, { uuid: 'q2' });
    h.tx('queue.op', { op: 'dequeue', content: '<task-notification><task-id>bg</task-id></task-notification>' }, { uuid: 'q3' });
    expect(h.d.status).toMatchObject({ kind: 'idle', quiescent: true });
  });
});
