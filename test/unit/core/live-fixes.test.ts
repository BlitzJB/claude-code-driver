// Regression tests for library bugs found by the live runs against the real Claude Code 2.1.316
// (docs/research/live-results.md). Each test failed before its fix.
import { describe, expect, it } from 'vitest';
import type { CoreConfig } from '../../../src/model/config.js';
import type { Harness } from './harness.js';
import { SESSION_ID, busyFrame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

function session(policy: CoreConfig['permissions']['policy'] = 'handler'): Harness {
  const h = readyHarness(testConfig({ permissions: { policy } }));
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
const BASH = { command: 'for i in $(seq 1 30); do echo tick $i; sleep 1; done' };
const pre = (h: Harness): Harness =>
  h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Bash', input: BASH, promptId: 'p1' }, 'PreToolUse');
const request = (h: Harness): Harness =>
  h.hook(
    'permission.requested',
    { hookSeq: h.nextHookSeq(), toolName: 'Bash', input: BASH, suggestions: [], promptId: 'p1' },
    'PermissionRequest',
  );
const escapes = (h: Harness): number => h.primitives().filter((p) => p.kind === 'key' && p.key === 'Escape').length;

describe('F-1: interrupt asked between PreToolUse and PermissionRequest (live smoke, 2026-11-03)', () => {
  it('the request is answered deny{interrupt:true} through the hook; no Escape ever reaches the native dialog', () => {
    const h = session('handler');
    pre(h);
    // the pane briefly shows a new surface (live: `modal`), so the interrupt job waits for dialogSettleMs
    h.screen(busyFrame({ surface: 'modal', composer: undefined }));
    h.cmd({ type: 'interrupt' });
    expect(escapes(h)).toBe(0);
    h.advance(70); // live: the PermissionRequest arrived 74 ms after the interrupt
    request(h);
    // never given to the handler: it would allow, and the deferred Escape would then reject the tool at the dialog
    expect(h.intentsOf('host.askPermission')).toEqual([]);
    expect(h.intentsOf('hook.respond')[0]?.body?.hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'Interrupted by the host',
      interrupt: true,
    });
    expect(h.ev('permission.answered')[0]?.payload).toMatchObject({ decision: 'deny', by: 'host', via: 'hook' });
    h.screen(busyFrame());
    h.run(1000);
    expect(escapes(h)).toBe(0);
    expect(Object.values(h.core.input.jobs).map((j) => j.kind)).not.toContain('interrupt');
  });

  it('an Escape already sent stays in flight; the request is still denied with interrupt (no allow after an interrupt)', () => {
    const h = session('handler');
    pre(h);
    h.cmd({ type: 'interrupt' });
    expect(escapes(h)).toBe(1);
    request(h);
    expect(h.intentsOf('host.askPermission')).toEqual([]);
    expect(h.intentsOf('hook.respond')[0]?.body?.hookSpecificOutput.decision).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(escapes(h)).toBe(1);
  });

  it('without an interrupt the request goes to the handler as before', () => {
    const h = session('handler');
    pre(h);
    request(h);
    expect(h.intentsOf('host.askPermission')).toHaveLength(1);
    expect(h.intentsOf('hook.respond')).toEqual([]);
  });
});

/** The live L-06 sequence: an Agent call launched async (no run_in_background in the input), Stop with it running. */
function backgroundAgentStopped(): Harness {
  const h = session('handler');
  h.hook(
    'tool.pre',
    { toolUseId: 'toolu_a', toolName: 'Agent', input: { description: 'Reply with OK', prompt: 'Reply OK.' } },
    'PreToolUse',
  );
  h.hook('agent.started', { agent: { agentId: 'bg', agentType: 'general-purpose' } }, 'SubagentStart');
  h.hook(
    'tool.post',
    { toolUseId: 'toolu_a', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg' },
    'PostToolUse',
  );
  h.hook('turn.stopped', { backgroundTasks: [{ id: 'bg', type: 'subagent', status: 'running' }], stopHookActive: false }, 'Stop');
  h.tx('turn.durationRecorded', { durationMs: 1, pendingBackgroundAgentCount: 1 }, { uuid: 'd1' });
  h.run(600);
  expect(h.d.status).toMatchObject({ kind: 'idle', backgroundAgents: 1, quiescent: false });
  h.hook(
    'agent.stopped',
    { agent: { agentId: 'bg', agentType: 'general-purpose' }, backgroundTasks: [{ id: 'bg', type: 'subagent', status: 'running' }] },
    'SubagentStop',
    { claudeSessionId: SESSION_ID },
  );
  return h;
}

describe('F-2: quiescence between SubagentStop and the task-notification turn (live L-06, 2026-11-03)', () => {
  it('a stopped background agent whose notification has not arrived keeps the session non-quiescent', () => {
    const h = backgroundAgentStopped();
    expect(h.d.status).toMatchObject({ kind: 'idle', backgroundAgents: 0, quiescent: false });
    h.advance(38); // live: the notification UPS came 38 ms after SubagentStop
    expect(h.d.status).toMatchObject({ kind: 'idle', quiescent: false });
    h.hook(
      'prompt.submitted',
      {
        promptId: 'pn',
        text: '<task-notification><task-id>bg</task-id><status>completed</status></task-notification>',
        taskNotification: { taskId: 'bg', toolUseId: 'toolu_a', status: 'completed' },
      },
      'UserPromptSubmit',
    );
    expect(h.d.activeTurn).toBe('t2');
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false }, 'Stop');
    h.tx('turn.durationRecorded', { durationMs: 1, pendingBackgroundAgentCount: 0 }, { uuid: 'd2' });
    h.run(600);
    expect(h.d.status).toMatchObject({ kind: 'idle', backgroundAgents: 0, quiescent: true });
  });

  it('no notification within transcriptSettleMs → quiescent on its own (the grace deadline re-derives the status)', () => {
    const h = backgroundAgentStopped();
    h.advance(4900);
    expect(h.d.status).toMatchObject({ kind: 'idle', quiescent: false });
    h.advance(200);
    expect(h.d.status).toMatchObject({ kind: 'idle', quiescent: true });
  });
});

describe('F-4: Escape during a running, hook-allowed Bash is written as "user-rejected" by 2.1.316 (live L-04)', () => {
  const rejected = (h: Harness): Harness =>
    h.tx('tool.result', { toolUseId: 'toolu_1', isError: true, uuid: 'r1', denialKind: 'user-rejected' }, { uuid: 'r1' });

  it('the tool ends interrupted (not denied) and the permission resolves allow by the hook', () => {
    const h = session('handler');
    pre(h);
    const seq = h.hookSeq + 1;
    request(h);
    h.cmd({ type: 'permission.answer', permissionKey: 'p1' as never, decision: { behavior: 'allow' }, by: 'handler' });
    h.obs('hook.responded', { hookSeq: seq as never, ok: true, clientGone: false }, 'self');
    expect(h.d.tools['u1' as never]?.state.value).toBe('running');
    h.run(3000);
    h.cmd({ type: 'interrupt' });
    rejected(h);
    h.tx('turn.interrupted', { marker: 'tool_use' }, { uuid: 'x1' });
    expect(h.ev('tool.ended').at(-1)?.payload).toMatchObject({ toolKey: 'u1', state: 'interrupted' });
    expect(h.ev('permission.resolved').at(-1)?.payload).toMatchObject({ decision: 'allow', decider: 'hook', overridden: false });
    expect(h.d.turns['t1' as never]?.state.value).toBe('interrupted');
  });

  it('a rejection at a dialog we never answered (handler still deciding) stays denied by the user', () => {
    const h = session('handler');
    pre(h);
    request(h);
    rejected(h);
    expect(h.ev('tool.ended').at(-1)?.payload).toMatchObject({ toolKey: 'u1', state: 'denied' });
    expect(h.ev('permission.resolved').at(-1)?.payload).toMatchObject({ decision: 'deny', decider: 'user_keys' });
  });
});
