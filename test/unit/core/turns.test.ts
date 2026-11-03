// core/decide/turns.ts — every row of DESIGN.md §4.4 plus the turn-related kernel scenarios that are pure-core (K-06,
// K-08, K-13, K-25, K-26, K-31, K-32, K-46, K-48).
import { describe, expect, it } from 'vitest';
import type { TurnKey } from '../../../src/model/ids.js';
import type { Harness } from './harness.js';
import { SESSION_ID, busyFrame, composerFrame, idleFrame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

const turn = (h: Harness, k = 't1') => h.d.turns[k as TurnKey];
const stop = (h: Harness, o: { last?: string; active?: boolean; bg?: { id: string; type: string; status: string }[] } = {}): Harness =>
  h.hook(
    'turn.stopped',
    { backgroundTasks: o.bg ?? [], stopHookActive: o.active ?? false, ...(o.last !== undefined ? { lastAssistantMessage: o.last } : {}) },
    'Stop',
  );

describe('§4.4 turn creation', () => {
  it('§4.4#1 prompt.send → queued library turn, turn.queued; whenBusy:reject while busy → E_BUSY', () => {
    const h = readyHarness(testConfig(), {}, { auto: false });
    const r = h.cmd({ type: 'prompt.send', text: 'hello', whenBusy: 'wait', clientRef: 'c1' });
    expect(r).toMatchObject({ ok: true, value: { turnKey: 't1' } });
    expect(h.ev('turn.queued')[0]?.payload).toEqual({ prompt: 'hello', origin: 'library', clientRef: 'c1' });
    expect(turn(h)?.origin.value).toBe('library');
    const busy = h.cmd({ type: 'prompt.send', text: 'again', whenBusy: 'reject' });
    expect(busy).toMatchObject({ ok: false, error: { code: 'E_BUSY' } });
  });

  it('§4.4#1 the sanitizer runs at send time (K-48: /cost and " /cost" rejected, zero keys)', () => {
    const h = readyHarness();
    for (const text of ['/cost', ' /cost']) {
      expect(h.cmd({ type: 'prompt.send', text, whenBusy: 'wait' })).toMatchObject({
        ok: false,
        error: { code: 'E_INPUT_REJECTED', details: { reason: 'leadingSlash' } },
      });
    }
    h.run(500);
    expect(h.intentsOf('input')).toEqual([]);
    expect(Object.keys(h.d.turns)).toEqual([]);
  });

  it('§4.4#2 head of the library queue with the gate open → submitting + submit job (turn.submitting)', () => {
    const h = readyHarness();
    h.cmd({ type: 'prompt.send', text: 'hello', whenBusy: 'wait' });
    expect(turn(h)?.state.value).toBe('submitting');
    expect(h.ev('turn.submitting')[0]?.payload).toEqual({ attempt: 1, method: 'editor' });
    expect(h.primitives()[0]).toEqual({ kind: 'editorStage', text: 'hello' });
  });

  it('§4.4#3 UPS with no in-flight submit → external running turn (turn.queued + turn.accepted), security alert for unknown origin (K-32)', () => {
    const h = readyHarness();
    ups(h, 'typed by a human', 'ph');
    expect(turn(h)).toMatchObject({ prompt: 'typed by a human', promptId: 'ph', gen: 'g1' });
    expect(turn(h)?.state.value).toBe('running');
    expect(turn(h)?.origin.value).toBe('unknown');
    expect(h.ev('turn.accepted')[0]?.payload.promptId).toBe('ph');
    expect(h.ev('security.alert')[0]?.payload.code).toBe('E_SECURITY_UNEXPECTED_INPUT');
    expect(h.d.activeTurn).toBe('t1');
  });

  it('§4.4#3 a task-notification UPS is an external turn with causedBy (RC §5.5)', () => {
    const h = readyHarness();
    h.hook('agent.started', { agent: { agentId: 'ag1', agentType: 'general-purpose' } }, 'SubagentStart');
    h.hook(
      'prompt.submitted',
      {
        promptId: 'pn',
        text: '<task-notification><task-id>ag1</task-id></task-notification>',
        taskNotification: { taskId: 'ag1', status: 'completed' },
      },
      'UserPromptSubmit',
    );
    expect(turn(h)?.origin.value).toBe('task_notification');
    expect(turn(h)?.causedBy).toMatchObject({ taskId: 'ag1', agent: 'a1' });
    expect(h.d.agents['a1' as never]?.notifications).toEqual(['t1']);
    expect(h.ev('security.alert')).toEqual([]);
  });

  it('§4.4#4 a UPS / prompt.recorded carrying the self-test nonce is never a Turn', () => {
    const h = readyHarness();
    const nonce = 'ccd-selftest-0123456789abcdef0123456789abcdef';
    ups(h, nonce, 'pz');
    h.tx('prompt.recorded', { uuid: 'u1', parentUuid: null, text: nonce, isMeta: false }, { uuid: 'u1' });
    h.run(3000);
    expect(Object.keys(h.d.turns)).toEqual([]);
  });

  it('§4.4#5 prompt.recorded{bashInput} → running turn with origin bash_mode (no UPS)', () => {
    const h = readyHarness();
    h.tx(
      'prompt.recorded',
      { uuid: 'u2', parentUuid: null, text: '<bash-input>ls</bash-input>', isMeta: false, bashInput: true, promptId: 'pb' },
      { uuid: 'u2' },
    );
    expect(turn(h)?.origin.value).toBe('bash_mode');
    expect(turn(h)?.state.value).toBe('running');
  });

  it('§4.4#6 transcript-first prompt with no UPS within hookGap → provisional running + hooks degraded{UserPromptSubmit}', () => {
    const h = readyHarness();
    h.tx('prompt.recorded', { uuid: 'u3', parentUuid: null, text: 'from somewhere', isMeta: false, promptId: 'pr' }, { uuid: 'u3' });
    expect(Object.keys(h.d.turns)).toEqual([]);
    h.run(2100);
    expect(turn(h)?.state).toMatchObject({ value: 'running', provisional: true });
    expect(h.d.channels.hooks.reasons).toContain('hookGap:UserPromptSubmit');
    // the hook of that event type restores the channel
    ups(h, 'next', 'pn2');
    expect(h.d.channels.hooks.reasons).not.toContain('hookGap:UserPromptSubmit');
  });

  it('§4.4#6 a UPS within hookGap cancels the transcript placeholder', () => {
    const h = readyHarness();
    h.tx('prompt.recorded', { uuid: 'u4', parentUuid: null, text: 'hi', isMeta: false, promptId: 'pq' }, { uuid: 'u4' });
    h.advance(100);
    ups(h, 'hi', 'pq');
    h.run(2500);
    expect(Object.keys(h.d.turns)).toEqual(['t1']);
    expect(h.d.channels.hooks.health).toBe('up');
  });
});

describe('§4.4 submission', () => {
  it('§4.4#7 matching ack → running, promptId aliased, turn.accepted, job done', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'fix the bug');
    ups(h, 'fix the bug  ', 'p1');
    expect(turn(h)?.state.value).toBe('running');
    expect(turn(h)?.promptId).toBe('p1');
    expect(h.d.activeTurn).toBe('t1');
    expect(h.d.libraryQueue).toEqual([]);
    expect(h.ev('turn.accepted')[0]?.provenance.confirmed).toBe(true);
    expect(h.core.input.current).toBeUndefined();
  });

  it('§4.4#8 ack whose prompt_id is an external running turn → mergedInto; ours ends with the host outcome (K-25)', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'mine');
    // an external turn races our Enter
    h.hook(
      'prompt.submitted',
      {
        promptId: 'px',
        text: '<task-notification><task-id>zz</task-id></task-notification>',
        taskNotification: { taskId: 'zz', status: 'completed' },
      },
      'UserPromptSubmit',
    );
    expect(turn(h, 't2')?.origin.value).toBe('task_notification');
    expect(turn(h)?.state.value).toBe('submitting');
    // Claude queued ours into the running turn: UPS of our text with the external prompt_id
    ups(h, 'mine', 'px');
    expect(turn(h)?.mergedInto).toBe('t2');
    expect(h.ev('turn.accepted').at(-1)?.payload).toMatchObject({ mergedInto: 't2' });
    stop(h, { last: 'both answered' });
    h.run(600);
    expect(turn(h)?.state.value).toBe('completed');
    expect(turn(h)?.endedBy).toBe('merged');
    expect(turn(h)?.finalText?.value).toBe('both answered');
  });

  it('§4.4#8 prompt.absorbed with our text also merges', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'mine');
    h.hook(
      'prompt.submitted',
      { promptId: 'px', text: '<task-notification>x</task-notification>', taskNotification: { taskId: 'zz', status: 'completed' } },
      'UserPromptSubmit',
    );
    h.tx('prompt.absorbed', { text: 'mine' });
    expect(turn(h)?.mergedInto).toBe('t2');
  });

  it('§4.4#9 a failed submit job → notSubmitted with the error (K-06 second loss → E_SUBMIT_UNCONFIRMED)', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'lost');
    h.composer = 'lost';
    h.run(5200 + 700); // first ack window (+2000 first prompt) → retry Enter
    expect(h.primitives().filter((p) => p.kind === 'key' && p.key === 'Enter')).toHaveLength(2);
    h.run(3800);
    expect(turn(h)?.state.value).toBe('notSubmitted');
    expect(turn(h)?.error?.code).toBe('E_SUBMIT_UNCONFIRMED');
    expect(h.ev('turn.ended').at(-1)?.payload).toMatchObject({ outcome: 'notSubmitted', endedBy: 'submit_failed' });
    expect(h.ev('input.rejected')[0]?.payload.code).toBe('E_SUBMIT_UNCONFIRMED');
  });

  it('K-06 lost Enter: no UPS in time, composer still holds the text → one Enter retry → accepted', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'retry me');
    h.composer = 'retry me';
    h.run(5800);
    expect(h.primitives().filter((p) => p.kind === 'key' && p.key === 'Enter')).toHaveLength(2);
    ups(h, 'retry me', 'p1');
    expect(turn(h)?.state.value).toBe('running');
  });

  it('K-08 ack text differs (not an external shape) → accepted confirmed:false + security.alert E_INPUT_TAMPERED, no interrupt', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'original');
    ups(h, 'tampered text', 'p1');
    expect(turn(h)?.state).toMatchObject({ value: 'running', provisional: true });
    expect(h.ev('turn.accepted')[0]?.provenance.confirmed).toBe(false);
    expect(h.ev('security.alert')[0]?.payload.code).toBe('E_INPUT_TAMPERED');
    h.run(300);
    expect(h.primitives().some((p) => p.kind === 'key' && p.key === 'Escape')).toBe(false);
  });

  it("K-08 with security.onTamper:'interrupt' a mismatch starts an interrupt job", () => {
    const h = readyHarness(testConfig({ security: { onTamper: 'interrupt' } }));
    sendUntilEnter(h, 'original');
    ups(h, 'tampered', 'p1');
    h.run(100);
    expect(h.primitives().at(-1)).toEqual({ kind: 'key', key: 'Escape', gapAfterMs: 250 });
  });
});

describe('§4.4 endings', () => {
  function running(): Harness {
    const h = readyHarness();
    sendUntilEnter(h, 'work');
    ups(h, 'work', 'p1');
    return h;
  }

  it('§4.4#10 Stop{stopHookActive:false} → stopping with finalText and backgroundPending; stopGrace armed', () => {
    const h = running();
    stop(h, { last: 'answer', bg: [{ id: 'b1', type: 'local_agent', status: 'running' }] });
    expect(turn(h)?.state.value).toBe('stopping');
    expect(turn(h)?.finalText?.value).toBe('answer');
    expect(turn(h)?.backgroundPending).toEqual(['b1']);
    expect(h.core.recon.deadlines['stopGrace:t1']).toBeDefined();
  });

  it('§4.4#11 Stop{stopHookActive:true} keeps the turn running; both identical Stops are processed (K-31)', () => {
    const h = running();
    stop(h, { active: true });
    stop(h, { active: true });
    expect(turn(h)?.state.value).toBe('running');
    expect(h.diag('stop_hook_active')).toHaveLength(2);
    stop(h, { last: 'final' });
    h.run(600);
    expect(turn(h)?.state.value).toBe('completed');
  });

  it('§4.4#12 stopping + stopGrace → completed{endedBy:stop}; a final MessageDisplay completes it at once', () => {
    const h = running();
    stop(h, { last: 'a' });
    h.run(600);
    expect(turn(h)?.state.value).toBe('completed');
    expect(h.ev('turn.ended').at(-1)?.payload).toMatchObject({ outcome: 'completed', endedBy: 'stop', finalText: 'a' });
    const g = running();
    g.hook('message.textDelta', { uiTurnId: 'ut', uiMessageId: 'um', index: 0, final: false, delta: 'hel' }, 'MessageDisplay');
    stop(g, { last: 'hello' });
    g.hook('message.textDelta', { uiTurnId: 'ut', uiMessageId: 'um', index: 1, final: true, delta: 'lo' }, 'MessageDisplay');
    expect(turn(g)?.state.value).toBe('completed');
  });

  it.each([
    ['rate_limit', 'E_USAGE_LIMIT'],
    ['authentication_failed', 'E_AUTH_REQUIRED'],
    ['oauth_org_not_allowed', 'E_AUTH_REQUIRED'],
    ['server_error', 'E_TURN_API_ERROR'],
  ] as [string, string][])('§4.4#13 StopFailure{%s} → failed with %s', (error, code) => {
    const h = running();
    h.hook('turn.failed', { error }, 'StopFailure');
    expect(turn(h)?.state.value).toBe('failed');
    expect(turn(h)?.error?.code).toBe(code);
    expect(turn(h)?.endedBy).toBe('stop_failure');
  });

  it('§4.4#14 transcript interrupt marker → interrupted (confirmed); tool_use marker → endedBy tool_use_interrupt', () => {
    const h = running();
    h.tx('turn.interrupted', { marker: 'request' }, { uuid: 'i1' });
    expect(turn(h)?.state).toMatchObject({ value: 'interrupted', provisional: false });
    expect(turn(h)?.endedBy).toBe('interrupt');
    expect(h.d.status.kind).toBe('interrupted');
    const g = running();
    g.tx('turn.interrupted', { marker: 'tool_use' }, { uuid: 'i2' });
    expect(turn(g)?.endedBy).toBe('tool_use_interrupt');
  });

  it('§4.4#15 screen interruptedBanner → provisional interrupted (turn stays active), confirmed by the transcript (K-13)', () => {
    const h = running();
    h.screen(busyFrame({ interruptedBanner: true, status: { kind: 'interrupted' } }));
    h.run(300);
    expect(turn(h)?.state).toMatchObject({ value: 'interrupted', provisional: true });
    expect(h.d.activeTurn).toBe('t1');
    expect(h.d.status.kind).toBe('interrupted');
    expect(h.ev('turn.ended')).toEqual([]);
    h.tx('turn.interrupted', { marker: 'request' }, { uuid: 'i3' });
    expect(turn(h)?.state.provisional).toBe(false);
    expect(h.d.activeTurn).toBeUndefined();
    expect(h.ev('turn.ended')).toHaveLength(1);
    expect(h.ev('claim.confirmed').some((e) => e.payload.claim === 'interruptedBanner')).toBe(true);
  });

  it('§4.4#15 a provisional interrupt with no confirmation is released after interruptConfirm with confirmed:false', () => {
    const h = running();
    h.screen(busyFrame({ interruptedBanner: true }));
    h.run(5600);
    expect(h.d.activeTurn).toBeUndefined();
    expect(h.ev('turn.ended')[0]?.provenance.confirmed).toBe(false);
  });

  it('§4.4#15 a later PostToolUse / MessageDisplay retracts the provisional interrupt', () => {
    const h = running();
    h.screen(busyFrame({ interruptedBanner: true }));
    h.run(300);
    h.hook('message.textDelta', { uiTurnId: 'ut', uiMessageId: 'um', index: 0, final: false, delta: 'still here' }, 'MessageDisplay');
    expect(turn(h)?.state.value).toBe('running');
    expect(h.ev('claim.retracted').length).toBeGreaterThan(0);
  });

  it('§4.4#16 turn_duration with no Stop within stopGrace → completed{endedBy:turn_duration}', () => {
    const h = running();
    h.tx('turn.durationRecorded', { durationMs: 900, pendingBackgroundAgentCount: 0 }, { uuid: 'd1' });
    h.run(600);
    expect(turn(h)?.state.value).toBe('completed');
    expect(turn(h)?.endedBy).toBe('turn_duration');
    expect(turn(h)?.durationMs).toBe(900);
  });

  it('§4.4#17 interrupt sent + no output + prompt.withdrawn → withdrawn', () => {
    const h = running();
    h.cmd({ type: 'interrupt' });
    h.run(300);
    h.tx('prompt.withdrawn', {});
    expect(turn(h)?.state.value).toBe('withdrawn');
    expect(h.ev('turn.ended').at(-1)?.payload).toMatchObject({ outcome: 'withdrawn', endedBy: 'withdrawn' });
  });

  it('§4.4#18 model.refused for a message of the turn → turn.refused set, the turn ends normally with refused:true', () => {
    const h = running();
    h.tx(
      'message.block',
      {
        apiMessageId: 'msg_1',
        blockIndex: 0,
        block: 'text',
        text: 'partial',
        stopReason: 'end_turn',
        synthetic: false,
        abortedMidStream: false,
        uuid: 'b1',
        parentUuid: null,
      },
      { uuid: 'b1' },
    );
    h.tx('model.refused', { refusedMessageId: 'msg_1', text: 'refused', uuid: 'r1' }, { uuid: 'r1' });
    expect(turn(h)?.refused).toEqual({ refusedMessageId: 'msg_1' });
    expect(turn(h)?.state.value).toBe('running');
    stop(h, { last: 'sorry' });
    h.run(600);
    expect(h.ev('turn.ended').at(-1)?.payload.refused).toBe(true);
  });

  it('§4.4#19 transcript synthetic API error with no StopFailure within stopGrace → failed', () => {
    const h = running();
    h.tx('model.apiErrorRecorded', { error: 'server_error', text: 'API Error: 500' }, { uuid: 'e1' });
    h.run(600);
    expect(turn(h)?.state.value).toBe('failed');
    expect(turn(h)?.error?.code).toBe('E_TURN_API_ERROR');
  });

  it('§4.4#20 generation ended → open turns unknown{session_end}; a late transcript line upgrades it (resolvedLate)', () => {
    const h = running();
    h.hook('session.ended', { sessionId: SESSION_ID, reason: 'clear' }, 'SessionEnd');
    expect(turn(h)?.state.value).toBe('unknown');
    expect(turn(h)?.endedBy).toBe('session_end');
    h.tx('turn.interrupted', { marker: 'request', promptId: 'p1' }, { uuid: 'late1' });
    expect(turn(h)?.state.value).toBe('interrupted');
    expect(h.ev('turn.resolvedLate')[0]?.payload).toEqual({ from: 'unknown', to: 'interrupted' });
  });

  it('§4.4#21 a terminal turn never reopens on a later observation carrying its promptId (P-REC-15)', () => {
    const h = running();
    stop(h, { last: 'x' });
    h.run(600);
    ups(h, 'work', 'p1');
    h.hook(
      'message.textDelta',
      { promptId: 'p1', uiTurnId: 'u', uiMessageId: 'late', index: 0, final: true, delta: 'late' },
      'MessageDisplay',
    );
    h.run(2000);
    expect(turn(h)?.state.value).toBe('completed');
    expect(h.d.activeTurn).toBeUndefined();
    expect(Object.keys(h.d.turns)).toEqual(['t1']);
  });

  it('§4.4#22 a provisional interrupt contradicted by Stop → completed + claim.retracted', () => {
    const h = running();
    h.screen(busyFrame({ interruptedBanner: true }));
    h.run(300);
    stop(h, { last: 'done anyway' });
    expect(turn(h)?.state).toMatchObject({ value: 'completed', provisional: false });
    expect(h.ev('claim.retracted').length).toBeGreaterThan(0);
  });
});

describe('queue and corroboration', () => {
  it('K-46 a failed turn does not block the queue: idle{lastTurn.error}, the queued send drains', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'one');
    ups(h, 'one', 'p1');
    h.cmd({ type: 'prompt.send', text: 'two', whenBusy: 'wait' });
    h.hook('turn.failed', { error: 'server_error' }, 'StopFailure');
    h.run(400);
    expect(
      h
        .primitives()
        .filter((p) => p.kind === 'editorStage')
        .map((p) => (p as { text: string }).text),
    ).toEqual(['one', 'two']);
    ups(h, 'two', 'p2');
    h.hook('turn.failed', { error: 'server_error' }, 'StopFailure');
    h.run(100);
    expect(h.d.status).toMatchObject({ kind: 'idle', lastTurn: { outcome: 'failed', error: { code: 'E_TURN_API_ERROR' } } });
  });

  it('K-32 a Stop-completed turn needs corroboration (turn_duration / idle screen) before the queue drains', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'one');
    ups(h, 'one', 'p1');
    h.cmd({ type: 'prompt.send', text: 'two', whenBusy: 'wait' });
    stop(h, { last: 'x' });
    h.run(700);
    expect(h.primitives().filter((p) => p.kind === 'editorStage')).toHaveLength(1);
    h.tx('turn.durationRecorded', { durationMs: 10, pendingBackgroundAgentCount: 0 }, { uuid: 'dd' });
    h.run(300);
    expect(h.primitives().filter((p) => p.kind === 'editorStage')).toHaveLength(2);
  });

  it('K-32 an idle screen frame also corroborates; without any evidence the guard lifts after transcriptSettle', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'one');
    ups(h, 'one', 'p1');
    h.cmd({ type: 'prompt.send', text: 'two', whenBusy: 'wait' });
    stop(h, { last: 'x' });
    h.run(700);
    h.screen(idleFrame());
    h.run(300);
    expect(h.primitives().filter((p) => p.kind === 'editorStage')).toHaveLength(2);
    const g = readyHarness();
    sendUntilEnter(g, 'one');
    ups(g, 'one', 'p1');
    g.cmd({ type: 'prompt.send', text: 'two', whenBusy: 'wait' });
    stop(g, { last: 'x' });
    g.run(5700);
    expect(g.diag('stop_uncorroborated')).toHaveLength(1);
    expect(g.primitives().filter((p) => p.kind === 'editorStage')).toHaveLength(2);
  });

  it('prompt.cancel only while queued', () => {
    const h = readyHarness(testConfig(), {}, { auto: false });
    h.cmd({ type: 'prompt.send', text: 'one', whenBusy: 'wait' });
    h.cmd({ type: 'prompt.send', text: 'two', whenBusy: 'wait' });
    expect(h.cmd({ type: 'prompt.cancel', turnKey: 't2' as TurnKey })).toMatchObject({ ok: true });
    expect(turn(h, 't2')?.state.value).toBe('aborted');
    expect(h.cmd({ type: 'prompt.cancel', turnKey: 't1' as TurnKey })).toMatchObject({
      ok: false,
      error: { details: { reason: 'notQueued' } },
    });
    expect(h.core.input.order).toEqual([]);
  });

  it('turn.stop (ICR 0023): queued → cancelled; ended → none; unknown → unknownTurn', () => {
    const h = readyHarness(testConfig(), {}, { auto: false });
    h.cmd({ type: 'prompt.send', text: 'one', whenBusy: 'wait' });
    h.cmd({ type: 'prompt.send', text: 'two', whenBusy: 'wait' });
    expect(h.cmd({ type: 'turn.stop', turnKey: 't2' as TurnKey })).toMatchObject({ ok: true, value: { effect: 'cancelled' } });
    expect(turn(h, 't2')?.state.value).toBe('aborted');
    expect(h.cmd({ type: 'turn.stop', turnKey: 't2' as TurnKey })).toMatchObject({ ok: true, value: { effect: 'none' } });
    expect(h.cmd({ type: 'turn.stop', turnKey: 't9' as TurnKey })).toMatchObject({
      ok: false,
      error: { details: { reason: 'unknownTurn' } },
    });
  });

  it('turn.stop: a queued turn whose submit job is already current (copy-mode exit pending) is cancelled; prompt.cancel is not', () => {
    const mk = (): Harness => {
      const h = readyHarness(testConfig(), {}, { auto: false });
      h.screen(idleFrame({ inCopyMode: true }));
      h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
      expect(h.primitives().map((p) => p.kind)).toEqual(['exitCopyMode']);
      expect(turn(h)?.state.value).toBe('queued'); // still queued while its job is current
      return h;
    };
    const old = mk();
    expect(old.cmd({ type: 'prompt.cancel', turnKey: 't1' as TurnKey })).toMatchObject({
      ok: false,
      error: { details: { reason: 'notQueued' } },
    });
    const h = mk();
    expect(h.cmd({ type: 'turn.stop', turnKey: 't1' as TurnKey })).toMatchObject({ ok: true, value: { effect: 'cancelled' } });
    expect(turn(h)?.state.value).toBe('aborted');
    expect(h.core.input.current).toBeUndefined();
    h.exec.auto = true;
    const exit = h.lastInput();
    if (exit !== undefined) h.done(exit);
    h.screen(idleFrame());
    h.run(1000);
    expect(h.primitives().some((p) => p.kind === 'editorStage' || p.kind === 'pasteChunk')).toBe(false);
  });

  it('turn.stop: a submit in progress → an interrupt queued behind it; the Escape lands once the prompt is accepted', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'work');
    expect(turn(h)?.state.value).toBe('submitting');
    expect(h.cmd({ type: 'turn.stop', turnKey: 't1' as TurnKey })).toMatchObject({ ok: true, value: { effect: 'interrupted' } });
    const escapes = () => h.primitives().filter((p) => p.kind === 'key' && p.key === 'Escape').length;
    expect(escapes()).toBe(0); // never an Escape into a half-submitted prompt
    ups(h, 'work', 'p1');
    expect(turn(h)?.state.value).toBe('running');
    h.run(100);
    expect(escapes()).toBe(1);
  });

  it('turn.stop: the running main turn → the session interrupt', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'work');
    ups(h, 'work', 'p1');
    expect(h.cmd({ type: 'turn.stop', turnKey: 't1' as TurnKey })).toMatchObject({ ok: true, value: { effect: 'interrupted' } });
    h.run(100);
    expect(h.primitives().filter((p) => p.kind === 'key' && p.key === 'Escape')).toHaveLength(1);
  });

  it('a library prompt waits for the gate while a turn runs (whenBusy:wait, D-17)', () => {
    const h = readyHarness();
    ups(h, 'human turn', 'ph');
    h.cmd({ type: 'prompt.send', text: 'queued', whenBusy: 'wait' });
    h.run(500);
    expect(h.intentsOf('input')).toEqual([]);
    expect(turn(h, 't2')?.state.value).toBe('queued');
    expect(h.d.status).toMatchObject({ kind: 'modelRequest' });
    stop(h, { last: 'ok' });
    h.run(600);
    h.screen(composerFrame(''));
    h.run(300);
    expect(h.primitives()[0]).toEqual({ kind: 'editorStage', text: 'queued' });
  });
});
