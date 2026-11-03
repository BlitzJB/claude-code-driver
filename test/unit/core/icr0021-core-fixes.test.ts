// Regression tests for the core review fixes recorded in docs/icr/0021-core-review-fixes.md (§4.4, §4.5.1, §4.5.4,
// §4.6, §4.7, §4.8, §3.6, §3.9). Each test failed before its fix.
import { describe, expect, it } from 'vitest';
import { sanitizeCommandArgs } from '../../../src/core/input-policy/sanitize.js';
import type { CoreConfig } from '../../../src/model/config.js';
import type { PermissionKey } from '../../../src/model/ids.js';
import type { WallMs } from '../../../src/model/time.js';
import type { Harness } from './harness.js';
import { SESSION_ID, WALL0, idleFrame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

function running(policy: CoreConfig['permissions']['policy'] = 'ask'): Harness {
  const h = readyHarness(testConfig({ permissions: { policy } }));
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
const turn = (h: Harness, k: string) => h.d.turns[k as never];
const stop = (h: Harness, bg: string[] = []): Harness =>
  h.hook(
    'turn.stopped',
    { backgroundTasks: bg.map((id) => ({ id, type: 'local_agent', status: 'running' })), stopHookActive: false },
    'Stop',
  );
const taskNotification = (h: Harness, promptId: string): Harness =>
  h.hook(
    'prompt.submitted',
    {
      promptId,
      text: '<task-notification><task-id>x</task-id><status>completed</status></task-notification>',
      taskNotification: { taskId: 'x', status: 'completed' },
    },
    'UserPromptSubmit',
  );
/** A background Agent launched by the running turn: agent a1 (agentId 'bg'), spawn tool u1. */
function withBackgroundAgent(h: Harness): Harness {
  h.hook(
    'tool.pre',
    { toolUseId: 'toolu_a', toolName: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'go', run_in_background: true } },
    'PreToolUse',
  );
  h.hook(
    'tool.post',
    { toolUseId: 'toolu_a', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg' },
    'PostToolUse',
  );
  h.hook('agent.started', { agent: { agentId: 'bg', agentType: 'general-purpose' } }, 'SubagentStart');
  expect(h.d.agents['a1' as never]?.background).toBe(true);
  return h;
}
const bgBash = (h: Harness, id: string): Harness =>
  h.hook(
    'tool.pre',
    { toolUseId: id, toolName: 'Bash', input: { command: 'sleep 30' }, agent: { agentId: 'bg', agentType: 'general-purpose' } },
    'PreToolUse',
    { agentId: 'bg' },
  );
const bgRequest = (h: Harness): Harness =>
  h.hook(
    'permission.requested',
    { hookSeq: h.nextHookSeq(), toolName: 'Bash', input: { command: 'sleep 30' }, suggestions: [], agent: { agentId: 'bg' } },
    'PermissionRequest',
    { agentId: 'bg' },
  );

describe('turn-level transcript lines are bound to their own turn (turn-duration-misattributed)', () => {
  /** Turn A (t1) Stops; a task-notification UPS in the same ms supersedes it (K-25) and B (t2) starts a Bash. */
  function lateLine(): Harness {
    const h = running();
    stop(h);
    taskNotification(h, 'pb');
    expect(turn(h, 't1')?.state.value).toBe('completed');
    expect(h.d.activeTurn).toBe('t2');
    h.hook('tool.pre', { toolUseId: 'toolu_b', toolName: 'Bash', input: { command: 'sleep 30' } }, 'PreToolUse');
    return h;
  }

  it("A's late turn_duration (no promptId) goes to A, never ends B", () => {
    const h = lateLine();
    h.tx('turn.durationRecorded', { durationMs: 900, pendingBackgroundAgentCount: 0 }, { uuid: 'd1' });
    h.run(600);
    expect(turn(h, 't1')?.durationMs).toBe(900);
    expect(turn(h, 't2')?.state.value).toBe('running');
    expect(turn(h, 't2')?.durationMs).toBeUndefined();
    expect(h.d.activeTurn).toBe('t2');
    expect(h.d.status.kind).toBe('runningTools');
  });

  it('a turn_duration bound by promptId goes to that turn even after transcriptSettle', () => {
    const h = lateLine();
    h.run(6000);
    h.tx('turn.durationRecorded', { durationMs: 900, pendingBackgroundAgentCount: 0, promptId: 'p1' }, { uuid: 'd1' });
    h.run(600);
    expect(turn(h, 't1')?.durationMs).toBe(900);
    expect(turn(h, 't2')?.state.value).toBe('running');
  });

  it("a turn_duration naming another prompt never lands on B; B's own still ends it with no Stop (§4.4#16)", () => {
    const h = lateLine();
    h.run(6000);
    h.tx('turn.durationRecorded', { durationMs: 900, pendingBackgroundAgentCount: 0, promptId: 'p-unknown' }, { uuid: 'd1' });
    h.run(600);
    expect(turn(h, 't2')?.state.value).toBe('running');
    h.tx('turn.durationRecorded', { durationMs: 50, pendingBackgroundAgentCount: 0, promptId: 'pb' }, { uuid: 'd2' });
    h.run(600);
    expect(turn(h, 't2')).toMatchObject({ endedBy: 'turn_duration', durationMs: 50 });
  });

  it('main-thread work after an unbound turn_duration disarms its grace', () => {
    const h = lateLine();
    h.run(6000); // A is past transcriptSettle: the unbound line falls back to the active turn
    h.tx('turn.durationRecorded', { durationMs: 900, pendingBackgroundAgentCount: 0 }, { uuid: 'd1' });
    expect(h.core.recon.deadlines['stopGrace:dur:t2']).toBeDefined();
    h.hook('tool.pre', { toolUseId: 'toolu_c', toolName: 'Read', input: { file_path: '/x' } }, 'PreToolUse');
    h.run(600);
    expect(turn(h, 't2')?.state.value).toBe('running');
  });

  it("A's late API-error line (after its StopFailure) never fails B", () => {
    const h = running();
    h.hook('turn.failed', { error: 'server_error' }, 'StopFailure');
    expect(turn(h, 't1')?.state.value).toBe('failed');
    taskNotification(h, 'pb');
    h.tx('model.apiErrorRecorded', { error: 'server_error', text: 'API Error: 500' }, { uuid: 'ae' });
    h.run(600);
    expect(turn(h, 't2')?.state.value).toBe('running');
    expect(turn(h, 't2')?.error).toBeUndefined();
  });
});

describe('background agents are session-scoped (bg-agent-permission-abandoned-on-turn-end, status rule 9)', () => {
  it("the main turn's end does not abandon or release a background agent's held request (bound)", () => {
    const h = withBackgroundAgent(running());
    bgBash(h, 'toolu_bg');
    bgRequest(h);
    expect(h.d.permissions['p1' as PermissionKey]?.state.value).toBe('pending');
    stop(h, ['bg']);
    h.run(600);
    expect(turn(h, 't1')?.state.value).toBe('completed');
    expect(h.d.permissions['p1' as PermissionKey]?.state.value).toBe('pending');
    expect(h.intentsOf('hook.respond')).toEqual([]);
    expect(h.ev('permission.abandoned')).toEqual([]);
  });

  it("…nor an unbound one carrying the agent's id", () => {
    const h = withBackgroundAgent(running());
    bgRequest(h);
    stop(h, ['bg']);
    h.run(600);
    expect(h.d.permissions['p1' as PermissionKey]?.state.value).toBe('pending');
    expect(h.intentsOf('hook.respond')).toEqual([]);
  });

  it("a background agent's running tool is not a main-thread runningTools (§4.7 rule 9)", () => {
    const h = withBackgroundAgent(running());
    bgBash(h, 'toolu_bg');
    h.hook('message.textDelta', { uiTurnId: 'ut', uiMessageId: 'um', index: 0, final: false, delta: 'meanwhile' }, 'MessageDisplay');
    expect(h.d.status.kind).toBe('writing');
  });
});

describe('interrupt() targets the turn being interrupted (interrupt-denies-wrong-permission)', () => {
  it("a background agent's held request is left alone; the main turn gets the Escape", () => {
    const h = withBackgroundAgent(running());
    bgBash(h, 'toolu_bg');
    bgRequest(h);
    h.cmd({ type: 'interrupt' });
    h.run(100);
    expect(h.intentsOf('hook.respond')).toEqual([]);
    expect(h.d.permissions['p1' as PermissionKey]?.state.value).toBe('pending');
    expect(h.primitives().some((p) => p.kind === 'key' && p.key === 'Escape')).toBe(true);
  });
});

describe('pending inputs never stick (agent-needs-input-stuck, closeProcess)', () => {
  it('agent_needs_input while idle is not a pending input; canSubmit stays open', () => {
    const h = readyHarness();
    h.hook('input.requested', { kind: 'agentNeedsInput', message: 'bg needs your input' }, 'Notification');
    expect(h.d.pendingInputs).toEqual({});
    expect(h.d.status.kind).toBe('idle');
    expect(h.cmd({ type: 'prompt.send', text: 'next', whenBusy: 'reject' })?.ok).toBe(true);
  });

  it("a background agent's agent_needs_input during a turn does not block the main status", () => {
    const h = withBackgroundAgent(running());
    h.hook('input.requested', { kind: 'agentNeedsInput' }, 'Notification', { agentId: 'bg' });
    expect(h.d.pendingInputs).toEqual({});
    expect(h.d.status.kind).not.toBe('awaitingInput');
  });

  it('an idle elicitation with no clearing notification clears on an idle main frame with no modal', () => {
    const h = readyHarness();
    h.hook('input.requested', { kind: 'elicitation', message: 'Pick' }, 'Notification');
    expect(h.d.status.kind).toBe('awaitingInput');
    h.screen(idleFrame()); // too early: the modal may not have rendered yet
    expect(Object.keys(h.d.pendingInputs)).toEqual(['r1']);
    h.run(2100);
    h.screen(idleFrame({ frameHash: 'later' }));
    expect(h.d.pendingInputs).toEqual({});
    expect(h.ev('input.cleared')[0]?.payload).toEqual({ requestKey: 'r1', how: 'screenGone' });
    expect(h.d.inputBlocked.input).toBe(false);
  });

  it('§4.8 rule 4: process exit with a request open outside any turn clears it (interrupted)', () => {
    const h = readyHarness();
    h.hook('input.requested', { kind: 'elicitation', message: 'Pick' }, 'Notification');
    h.obs('process.exited', { exitStatus: 0, signal: null }, 'process');
    expect(h.d.pendingInputs).toEqual({});
    expect(h.ev('input.cleared').map((e) => e.payload)).toEqual([{ requestKey: 'r1', how: 'interrupted' }]);
  });
});

describe('usage wake (usage-waking-stuck-after-submit-fail)', () => {
  it('the resume submit failing while waking re-arms the wake instead of staying waking forever', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'work');
    ups(h, 'work', 'p1');
    h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    h.tx(
      'model.apiErrorRecorded',
      { error: 'rate_limit', apiError: 'usage_limit_reached', text: 'limit', resetsAtWall: (WALL0 + 3_600_000) as WallMs },
      { uuid: 'ae' },
    );
    const at = h.d.usage.limit?.nextWakeAtWall ?? 0;
    h.advance(100, at - h.wall + 1);
    expect(h.d.usage.limit?.state).toBe('waking');
    for (let i = 0; i < 1200 && turn(h, 't2')?.state.value !== 'notSubmitted'; i++) h.advance(50);
    expect(turn(h, 't2')?.state.value).toBe('notSubmitted');
    expect(h.d.usage.limit).toMatchObject({ state: 'limited', rearms: 1 });
    expect(h.core.recon.deadlines['usageWake:limit']).toBeDefined();
  });
});

describe('command args (command-args-trailing-backslash)', () => {
  it('a trailing backslash gets one space after trim(), so Enter still runs the command (P-TUI-06)', () => {
    expect(sanitizeCommandArgs('C:\\work\\')).toMatchObject({ ok: true, text: 'C:\\work\\ ', changed: true });
    expect(sanitizeCommandArgs('foo\\ ')).toMatchObject({ ok: true, text: 'foo\\ ' });
    expect(sanitizeCommandArgs(' opus ')).toMatchObject({ ok: true, text: 'opus' });
  });
});

describe('attachment binding (attachment-bind-ignores-input)', () => {
  it('the hookPermissionDecision attachment binds the request with the same input, never the first of that name', () => {
    const h = running('ask');
    const req = (cmd: string): Harness =>
      h.hook(
        'permission.requested',
        { hookSeq: h.nextHookSeq(), toolName: 'Bash', input: { command: cmd }, suggestions: [], promptId: 'p1' },
        'PermissionRequest',
      );
    req('rm -rf build');
    req('ls');
    h.cmd({ type: 'permission.answer', permissionKey: 'p2' as PermissionKey, decision: { behavior: 'allow' }, by: 'handler' });
    const before = h.intentsOf('hook.respond').length;
    h.run(2500);
    h.hook('tool.pre', { toolUseId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' }, promptId: 'p1' }, 'PreToolUse');
    h.tx('permission.decisionRecorded', { toolUseId: 'toolu_ls', decision: 'accept', decider: 'hook', via: 'attachment' }, { uuid: 'att' });
    expect(h.d.permissions['p1' as PermissionKey]?.state.value).toBe('pending');
    expect(h.d.permissions['p1' as PermissionKey]?.tool).toBeUndefined();
    expect(h.d.permissions['p2' as PermissionKey]).toMatchObject({ tool: 'u1', state: { value: 'resolved' } });
    expect(h.intentsOf('hook.respond').slice(before)).toEqual([]);
    expect(h.ev('permission.resolved').map((e) => e.payload.permissionKey)).toEqual(['p2']);
  });

  it('two candidates with equal input and no distinguishing answer → no bind (diag), nothing released', () => {
    const h = running('ask');
    for (let i = 0; i < 2; i++)
      h.hook(
        'permission.requested',
        { hookSeq: h.nextHookSeq(), toolName: 'Bash', input: { command: 'ls' }, suggestions: [], promptId: 'p1' },
        'PermissionRequest',
      );
    h.run(2500);
    h.hook('tool.pre', { toolUseId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' }, promptId: 'p1' }, 'PreToolUse');
    h.tx('permission.decisionRecorded', { toolUseId: 'toolu_ls', decision: 'accept', decider: 'hook', via: 'attachment' }, { uuid: 'att' });
    expect(h.diag('attachment_bind_ambiguous')).toHaveLength(1);
    expect(h.intentsOf('hook.respond')).toEqual([]);
  });
});

describe('§4.5.4 drain check by turn_duration count (mut-drain-pendingcount-untested, §4.10#22, K-42)', () => {
  /** A background agent of g1 survives /clear; the drain fires; g2 runs a turn. */
  function drained(): Harness {
    const h = withBackgroundAgent(running());
    stop(h, ['bg']);
    h.run(600);
    h.hook('session.ended', { sessionId: SESSION_ID, reason: 'clear' }, 'SessionEnd');
    h.hook('session.started', { sessionId: 'g2id', transcriptPath: '/n.jsonl', source: 'clear' }, 'SessionStart', {
      claudeSessionId: 'g2id',
    });
    h.run(5100);
    expect(h.core.recon.drained['g1']).toBe(true);
    ups(h, 'new gen prompt', 'pg2');
    return h;
  }

  it('the new generation’s turn_duration with a pending count > 0 (no ids) keeps the agent running', () => {
    const h = drained();
    h.tx(
      'turn.durationRecorded',
      { durationMs: 5, pendingBackgroundAgentCount: 1, promptId: 'pg2' },
      { uuid: 'dg2', claudeSessionId: 'g2id' },
    );
    expect(h.d.agents['a1' as never]?.state.value).toBe('running');
  });

  it('…and with a count of 0 the agent becomes unknown', () => {
    const h = drained();
    h.tx(
      'turn.durationRecorded',
      { durationMs: 5, pendingBackgroundAgentCount: 0, promptId: 'pg2' },
      { uuid: 'dg2', claudeSessionId: 'g2id' },
    );
    expect(h.d.agents['a1' as never]?.state.value).toBe('unknown');
  });
});
