// Regression tests for the core review fixes recorded in docs/icr/0028-core-review-fixes-2.md. Each test failed before
// its fix.
import { describe, expect, it } from 'vitest';
import type { CoreConfig } from '../../../src/model/config.js';
import type { HookSeq, PermissionKey } from '../../../src/model/ids.js';
import type { ScreenFacts } from '../../../src/model/screen-facts.js';
import type { WallMs } from '../../../src/model/time.js';
import type { Harness } from './harness.js';
import { WALL0, busyFrame, composerFrame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

const turn = (h: Harness, k: string) => h.d.turns[k as never];
const perm = (h: Harness, k: string) => h.d.permissions[k as PermissionKey];
const endedFor = (h: Harness, k: string) => h.ev('turn.ended').filter((e) => e.turnKey === k);
const keyPresses = (h: Harness, key: string) => h.primitives().filter((p) => p.kind === 'key' && p.key === key);

function running(o: Partial<CoreConfig['permissions']> = {}): Harness {
  const h = readyHarness(testConfig({ permissions: o }));
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
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
const banner = (h: Harness): Harness => h.screen(busyFrame({ interruptedBanner: true }));
const dialog = (options: { n: number; label: string; selected: boolean }[] = [{ n: 1, label: 'Yes', selected: true }]): ScreenFacts =>
  busyFrame({ surface: 'permissionDialog', dialog: { kind: 'permission', title: 'Bash command', options }, composer: undefined });
const request = (h: Harness, seq: number, o: { agentId?: string } = {}): Harness =>
  h.hook(
    'permission.requested',
    {
      hookSeq: seq as HookSeq,
      toolName: 'Bash',
      input: { command: 'ls' },
      suggestions: [],
      ...(o.agentId !== undefined ? { agent: { agentId: o.agentId } } : {}),
    },
    'PermissionRequest',
    o.agentId !== undefined ? { agentId: o.agentId } : {},
  );

describe('a held provisional interrupt that loses the active slot ends (held-interrupt-superseded-never-ends)', () => {
  function heldThenNewPrompt(): Harness {
    const h = running();
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Bash', input: { command: 'sleep 9' } }, 'PreToolUse');
    banner(h);
    h.run(300);
    expect(turn(h, 't1')?.state).toMatchObject({ value: 'interrupted', provisional: true });
    expect(h.d.activeTurn).toBe('t1');
    taskNotification(h, 'p2'); // Claude submits a queued notification right after the Esc
    return h;
  }

  it('the new UPS releases t1: turn.ended{confirmed:false} and its closing rule runs', () => {
    const h = heldThenNewPrompt();
    expect(h.d.activeTurn).toBe('t2');
    expect(endedFor(h, 't1')).toHaveLength(1);
    expect(endedFor(h, 't1')[0]?.provenance.confirmed).toBe(false);
    expect(h.d.tools['u1' as never]?.state.value).toBe('unknown'); // closing rule 1
  });

  it('a later transcript marker for t1 publishes no second turn.ended; t2 is untouched', () => {
    const h = heldThenNewPrompt();
    h.tx('turn.interrupted', { marker: 'request', promptId: 'p1' }, { uuid: 'i1' });
    h.run(6000);
    expect(turn(h, 't1')?.state).toMatchObject({ value: 'interrupted', provisional: false });
    expect(endedFor(h, 't1')).toHaveLength(1);
    expect(turn(h, 't2')?.state.value).toBe('running');
    expect(h.d.activeTurn).toBe('t2');
  });

  it("a late PostToolUse of t1's tool never revives t1 while t2 is active", () => {
    const h = heldThenNewPrompt();
    h.hook('tool.post', { toolUseId: 'toolu_1', toolName: 'Bash', response: { stdout: '' } }, 'PostToolUse');
    expect(turn(h, 't1')?.state.value).toBe('interrupted');
    expect(h.d.activeTurn).toBe('t2');
  });
});

describe('releasing a held host turn ends the turns merged into it (release-held-skips-merged-turns)', () => {
  it('interruptConfirm expires on the host: the merged library turn ends interrupted{endedBy:merged}', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'mine');
    taskNotification(h, 'px');
    ups(h, 'mine', 'px');
    expect(turn(h, 't1')?.mergedInto).toBe('t2');
    banner(h);
    h.run(6000);
    expect(h.d.activeTurn).toBeUndefined();
    expect(turn(h, 't1')?.state.value).toBe('interrupted');
    expect(turn(h, 't1')?.endedBy).toBe('merged');
    expect(endedFor(h, 't1')).toHaveLength(1);
  });
});

describe('dialogOnly key answers are idempotent and checked before the key (dialogonly-keys-answer-not-idempotent)', () => {
  function dialogOnly(): Harness {
    const h = running({ policy: 'handler', screenAllow: true });
    request(h, 6);
    h.obs('permission.hookClosed', { hookSeq: 6 as HookSeq, reason: 'timeout' }, 'self');
    expect(perm(h, 'p1')?.state.value).toBe('dialogOnly');
    h.screen(
      dialog([
        { n: 1, label: 'Yes', selected: true },
        { n: 3, label: 'No', selected: false },
      ]),
    );
    h.run(300);
    h.exec.auto = false; // input completes asynchronously, as in reality
    return h;
  }

  it('a second answer while the keys job is out is notPending; one key only; the handler ask is cancelled', () => {
    const h = dialogOnly();
    const a = h.cmd({ type: 'permission.answer', permissionKey: 'p1' as PermissionKey, decision: { behavior: 'allow' }, by: 'host' });
    expect(a?.ok).toBe(true);
    expect(h.intentsOf('host.cancelAsk').some((i) => i.permissionKey === 'p1')).toBe(true);
    const b = h.cmd({ type: 'permission.answer', permissionKey: 'p1' as PermissionKey, decision: { behavior: 'allow' }, by: 'handler' });
    expect(b).toMatchObject({ ok: false, error: { details: { reason: 'notPending' } } });
    const c = h.cmd({ type: 'permission.answer', permissionKey: 'p1' as PermissionKey, decision: { behavior: 'deny' }, by: 'host' });
    expect(c).toMatchObject({ ok: false, error: { details: { reason: 'notPending' } } });
    h.done(h.lastInput()!);
    h.screen(busyFrame());
    h.run(1000);
    expect(keyPresses(h, '1')).toHaveLength(1);
    expect(keyPresses(h, 'Escape')).toHaveLength(0);
  });

  it('the dialog is gone by the time the job starts: no digit is pressed', () => {
    const h = running({ policy: 'handler', screenAllow: true });
    request(h, 6);
    h.obs('permission.hookClosed', { hookSeq: 6 as HookSeq, reason: 'timeout' }, 'self');
    h.screen(dialog()); // the surface just appeared: the gate waits dialogSettle
    expect(
      h.cmd({ type: 'permission.answer', permissionKey: 'p1' as PermissionKey, decision: { behavior: 'allow' }, by: 'host' })?.ok,
    ).toBe(true);
    h.advance(10);
    h.screen(busyFrame()); // the dialog left before the job could start
    h.run(1500);
    expect(keyPresses(h, '1')).toHaveLength(0);
    expect(h.diag('permission_keys_skipped')[0]?.detail).toMatchObject({ reason: 'dialogNotShown' });
  });
});

describe('an Enter withheld by I6 arms no ack / effect deadline (i6-deferred-enter-arms-ack-deadline)', () => {
  function heldMidStaging(cmd: 'prompt' | 'slash'): Harness {
    const h = readyHarness(testConfig(), {}, { auto: false });
    if (cmd === 'prompt') h.cmd({ type: 'prompt.send', text: 'q', whenBusy: 'wait' });
    else h.cmd({ type: 'slash.run', name: '/usage' });
    h.done(h.lastInput()!); // editorStage
    h.done(h.lastInput()!); // C-g
    request(h, 1); // a request (e.g. a leftover background agent's) is held mid-flight
    h.done(h.lastInput()!); // awaitEditorConsumed
    h.screen(composerFrame(cmd === 'prompt' ? 'q' : '/usage'));
    return h;
  }

  it('a submit waits out a long hold: no E_SUBMIT_UNCONFIRMED, no clearComposer Escape, Enter after the hold', () => {
    const h = heldMidStaging('prompt');
    h.run(30_000, 500);
    expect(h.ev('input.rejected')).toEqual([]);
    expect(turn(h, 't1')?.state.value).toBe('submitting');
    expect(keyPresses(h, 'Escape')).toHaveLength(0);
    h.cmd({ type: 'permission.answer', permissionKey: 'p1' as PermissionKey, decision: { behavior: 'deny' }, by: 'host' });
    h.run(200);
    expect(h.primitives().at(-1)).toEqual({ kind: 'key', key: 'Enter', gapAfterMs: 15 });
    expect(h.core.recon.deadlines['submitAck:j1' as never]).toBeDefined();
  });

  it('a command is not reported effect:none while its Enter is withheld', () => {
    const h = heldMidStaging('slash');
    h.run(10_000, 500);
    expect(h.results.filter((r) => r.ok && (r.value as { effect?: string } | undefined)?.effect === 'none')).toEqual([]);
  });

  it('a composer clear never starts while a request is held (its Escape would deny the dialog)', () => {
    const h = heldMidStaging('prompt');
    h.tx('prompt.blocked', { reason: 'blocked_by_hook', text: 'q' }, { uuid: 'b1' }); // submit fails → clearComposer queued
    expect(turn(h, 't1')?.state.value).toBe('notSubmitted');
    h.run(1000);
    expect(keyPresses(h, 'Escape')).toHaveLength(0);
    h.cmd({ type: 'permission.answer', permissionKey: 'p1' as PermissionKey, decision: { behavior: 'deny' }, by: 'host' });
    h.run(100);
    expect(keyPresses(h, 'Escape')).toHaveLength(1); // the clear runs once the hold ended
  });
});

describe('a second interrupt during a held provisional interrupt presses nothing (second-interrupt-double-esc-rewind)', () => {
  it('session.interrupt after the banner → interrupt.ignored{notBusy}, one Escape only', () => {
    const h = running();
    h.cmd({ type: 'interrupt' });
    h.run(300);
    banner(h);
    h.run(100);
    expect(turn(h, 't1')?.state).toMatchObject({ value: 'interrupted', provisional: true });
    h.cmd({ type: 'interrupt' });
    h.run(500);
    expect(keyPresses(h, 'Escape')).toHaveLength(1);
    expect(h.ev('interrupt.ignored').at(-1)?.payload).toMatchObject({ reason: 'notBusy' });
  });
});

describe('the resume prompt goes through the sanitizer (resume-prompt-unsanitized)', () => {
  function wake(resumePrompt: string): Harness {
    const h = readyHarness(testConfig({ usage: { resumePrompt } }));
    sendUntilEnter(h, 'work');
    ups(h, 'work', 'p1');
    h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    h.tx(
      'model.apiErrorRecorded',
      { error: 'rate_limit', apiError: 'usage_limit_reached', text: 'limit', resetsAtWall: (WALL0 + 3_600_000) as WallMs },
      { uuid: 'ae' },
    );
    h.cmd({ type: 'usage.wakeNow' });
    h.run(300);
    return h;
  }
  const staged = (h: Harness) =>
    h
      .primitives()
      .filter((p) => p.kind === 'editorStage')
      .at(-1);

  it("a leading '!' is escaped and a trailing '\\' gets its space", () => {
    expect(staged(wake('!make deploy'))).toEqual({ kind: 'editorStage', text: ' !make deploy' });
    expect(staged(wake('go on\\'))).toEqual({ kind: 'editorStage', text: 'go on\\ ' });
  });

  it("a leading '/' is never typed: warning E_CONFIG_INVALID and the default prompt", () => {
    const h = wake('/clear');
    expect(staged(h)).toEqual({ kind: 'editorStage', text: 'continue' });
    expect(h.ev('warning').some((e) => e.payload.code === 'E_CONFIG_INVALID')).toBe(true);
  });
});

describe('PermissionRequests after close() began are denied (permission-requests-during-closing-use-normal-policy)', () => {
  it("'dangerouslyAllowAll' while closing → deny by:'close', no ask", () => {
    const h = running({ policy: 'dangerouslyAllowAll' });
    h.cmd({ type: 'session.close', mode: 'graceful', graceMs: 12000, reason: 'bye' });
    expect(h.d.lifecycle).toBe('closing');
    h.hook('tool.pre', { toolUseId: 'toolu_9', toolName: 'Bash', input: { command: 'ls' } }, 'PreToolUse');
    request(h, 9);
    const r = h.intentsOf('hook.respond').at(-1);
    expect(r?.body?.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Denied: session closing' });
    expect(h.ev('permission.answered').at(-1)?.payload).toMatchObject({ decision: 'deny', by: 'close' });
    expect(h.intentsOf('host.askPermission')).toEqual([]);
  });

  it("'handler' while closing → deny, the handler is never asked", () => {
    const h = running({ policy: 'handler' });
    h.cmd({ type: 'session.close', mode: 'graceful', graceMs: 12000, reason: 'bye' });
    request(h, 9);
    expect(h.intentsOf('host.askPermission')).toEqual([]);
    expect(perm(h, 'p1')?.ourAnswer).toMatchObject({ decision: 'deny', by: 'close' });
  });
});

describe('dialog adoption is scoped to the active turn and retried (adoption-blocked-by-any-open-record)', () => {
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
    return h;
  }

  it("a background agent's pending request does not block adopting a main-thread dialog", () => {
    const h = withBackgroundAgent(running());
    request(h, 1, { agentId: 'bg' });
    expect(perm(h, 'p1')?.state.value).toBe('pending');
    h.hook('tool.pre', { toolUseId: 'toolu_m', toolName: 'Bash', input: { command: 'rm x' } }, 'PreToolUse');
    h.screen(dialog());
    h.run(800);
    expect(perm(h, 'p2')).toMatchObject({ adopted: true, state: { value: 'dialogOnly' } });
    expect(h.ev('permission.needsKeys').some((e) => e.payload.permissionKey === 'p2')).toBe(true);
  });

  it('adoption is retried when the blocking record of the active turn closes while the dialog stays', () => {
    const h = running();
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Bash', input: { command: 'ls' } }, 'PreToolUse');
    request(h, 1);
    expect(perm(h, 'p1')?.state.value).toBe('pending');
    h.hook('tool.pre', { toolUseId: 'toolu_2', toolName: 'Bash', input: { command: 'rm x' } }, 'PreToolUse');
    h.screen(dialog());
    h.run(800);
    expect(perm(h, 'p2')).toBeUndefined(); // p1 (pending, this turn) stands in the way
    h.hook('tool.post', { toolUseId: 'toolu_1', toolName: 'Bash', response: { stdout: '' } }, 'PostToolUse');
    expect(perm(h, 'p1')?.state.value).toBe('resolved');
    h.run(800);
    expect(perm(h, 'p2')).toBeUndefined(); // the frame may still be p1's own dialog: wait a full idle poll
    h.run(2000);
    expect(perm(h, 'p2')).toMatchObject({ adopted: true, state: { value: 'dialogOnly' } });
  });

  it("the closed record's own dialog leaving within the retry window is not adopted", () => {
    const h = running();
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Bash', input: { command: 'ls' } }, 'PreToolUse');
    request(h, 1);
    h.screen(dialog());
    h.run(300);
    h.hook('tool.post', { toolUseId: 'toolu_1', toolName: 'Bash', response: { stdout: '' } }, 'PostToolUse');
    h.run(900);
    h.screen(busyFrame()); // the next poll: the dialog was p1's and is gone
    h.run(3000);
    expect(Object.keys(h.d.permissions)).toEqual(['p1']);
  });
});
