// Regression tests for the core review fixes recorded in docs/icr/0034-core-review-fixes-3.md. Each test failed before
// its fix.
import { describe, expect, it } from 'vitest';
import { sanitizeMessage, sanitizePrompt } from '../../../src/core/input-policy/sanitize.js';
import type { Harness } from './harness.js';
import { WALL0, busyFrame, composerFrame, frame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

const running = (h: Harness, text = 'work', id = 'p1'): Harness => {
  sendUntilEnter(h, text);
  ups(h, text, id);
  return h;
};
const apiRequest = (h: Harness, ref = 'txreq:r1', meta: { agentId?: string } = {}): Harness =>
  h.tx('model.requestStarted', { requestRef: ref, isRetry: false, requestDigest: ref, txWall: h.wall as never }, { uuid: ref, ...meta });
const call = (h: Harness, k: string) => h.d.calls[k as never];

describe('a stall/retry banner leaves no sticky call state (screen-stall-retry-sticky)', () => {
  const netOff = () => running(readyHarness(testConfig({ channels: { network: false } })));

  it('the stall banner ends (spinner back): c1 returns to waiting and status is no longer stalled', () => {
    const h = netOff();
    apiRequest(h);
    h.screen(busyFrame({ status: { kind: 'stalled' } }));
    h.run(300);
    expect(call(h, 'c1')?.state.value).toBe('stalled');
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'stalled', provenance: { confirmed: false } });
    h.screen(busyFrame());
    h.run(5000, 500);
    expect(call(h, 'c1')?.state.value).toBe('waiting');
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'waiting' });
  });

  it('the retry banner ends: c1 returns to waiting with no screen retry detail', () => {
    const h = netOff();
    apiRequest(h);
    h.screen(busyFrame({ status: { kind: 'retrying', attempt: 2, max: 10, retryInMs: 4000 } }));
    h.run(300);
    expect(call(h, 'c1')?.state.value).toBe('retrying');
    h.screen(busyFrame());
    h.run(1000);
    expect(call(h, 'c1')?.state.value).toBe('waiting');
    expect(call(h, 'c1')?.retry).toBeUndefined();
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'waiting' });
  });

  it('the screen channel goes down: the banner claim and its call state end together', () => {
    const h = netOff();
    apiRequest(h);
    h.screen(busyFrame({ status: { kind: 'stalled' } }));
    h.run(300);
    h.obs('channel.health', { channel: 'screen', health: 'down', reason: 'capture failed' }, 'channel');
    expect(call(h, 'c1')?.state.value).toBe('waiting');
  });
});

/** t1 spawns a background agent `bg` (a1) through tool u1. */
function backgroundAgent(): Harness {
  const h = running(readyHarness());
  h.hook(
    'tool.pre',
    { toolUseId: 'toolu_a', toolName: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'go', run_in_background: true } },
    'PreToolUse',
  );
  h.hook('agent.started', { agent: { agentId: 'bg', agentType: 'general-purpose' } }, 'SubagentStart');
  h.hook(
    'tool.post',
    { toolUseId: 'toolu_a', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg' },
    'PostToolUse',
  );
  expect(h.d.agents['a1' as never]).toMatchObject({ background: true, state: { value: 'running' } });
  return h;
}
const mainStop = (h: Harness): Harness => {
  h.hook('turn.stopped', { backgroundTasks: [{ id: 'bg', type: 'local_agent', status: 'running' }], stopHookActive: false }, 'Stop');
  h.tx('turn.durationRecorded', { durationMs: 1, pendingBackgroundAgentCount: 1 }, { uuid: 'd1' });
  return h.run(600);
};

describe("closing rule 1 leaves a background agent's calls open (bg-agent-calls-closed-by-turn)", () => {
  it('t1 completes while a1 is still requesting: c(a1) stays open and gets no modelCall.ended', () => {
    const h = backgroundAgent();
    apiRequest(h, 'txreq:bg', { agentId: 'bg' });
    const k = Object.values(h.d.calls).find((c) => c.agent === 'a1')?.key;
    expect(k).toBeDefined();
    expect(h.d.turns['t1' as never]?.calls).toContain(k);
    mainStop(h);
    expect(h.d.turns['t1' as never]?.state.value).toBe('completed');
    expect(h.d.agents['a1' as never]?.state.value).toBe('running');
    expect(call(h, k!)?.state.value).toBe('started');
    expect(h.ev('modelCall.ended').filter((e) => e.payload.callKey === k)).toEqual([]);
  });
});

describe('every agent stop runs closing rule 2 (agent-stop-without-rule2)', () => {
  const bgTool = (h: Harness): Harness =>
    h.hook(
      'tool.pre',
      { toolUseId: 'toolu_b', toolName: 'Bash', input: { command: 'sleep 99' }, agent: { agentId: 'bg', agentType: 'general-purpose' } },
      'PreToolUse',
      { agentId: 'bg' },
    );
  const toolOfBg = (h: Harness) => Object.values(h.d.tools).find((t) => t.toolUseId === 'toolu_b');

  it('a killed task notification with no SubagentStop: the tool ends unknown(agent_stopped), subagent.stopped + tail intent', () => {
    const h = backgroundAgent();
    bgTool(h);
    apiRequest(h, 'txreq:bg', { agentId: 'bg' });
    mainStop(h);
    expect(toolOfBg(h)?.state.value).not.toBe('unknown');
    h.hook(
      'prompt.submitted',
      {
        promptId: 'pn',
        text: '<task-notification><task-id>bg</task-id><status>killed</status></task-notification>',
        taskNotification: { taskId: 'bg', toolUseId: 'toolu_a', status: 'killed' },
      },
      'UserPromptSubmit',
    );
    expect(h.d.agents['a1' as never]?.state.value).toBe('stopped');
    expect(toolOfBg(h)).toMatchObject({ state: { value: 'unknown' }, error: 'agent_stopped' });
    expect(h.ev('subagent.stopped').map((e) => e.payload.agentKey)).toEqual(['a1']);
    expect(h.intentsOf('tail.subagentStopped').map((i) => i.agentId)).toEqual(['bg']);
    expect(Object.values(h.d.calls).find((c) => c.agent === 'a1')?.state.value).toBe('unknown');
    // a late SubagentStop changes nothing and publishes no second stop
    h.hook('agent.stopped', { agent: { agentId: 'bg', agentType: 'general-purpose' }, backgroundTasks: [] }, 'SubagentStop');
    expect(h.ev('subagent.stopped')).toHaveLength(1);
  });

  it('meta.json finished: rule 2 runs', () => {
    const h = backgroundAgent();
    bgTool(h);
    h.tx('agent.meta', { agentId: 'bg', finished: true });
    expect(h.d.agents['a1' as never]?.state.value).toBe('stopped');
    expect(toolOfBg(h)?.state.value).toBe('unknown');
    expect(h.ev('subagent.stopped')).toHaveLength(1);
  });
});

describe('long texts sanitize without a stack overflow (sanitize-spread-rangeerror)', () => {
  it('a 200k prompt under the default limit is tooLarge, not a RangeError', () => {
    expect(sanitizePrompt('a'.repeat(200_000), { maxPromptBytes: 100_000, mentions: 'allow' })).toMatchObject({
      ok: false,
      code: 'E_INPUT_INVALID',
      reason: 'tooLarge',
    });
  });

  it('a 500k prompt under a 1 MB limit is accepted intact', () => {
    const r = sanitizePrompt(`x\u200b${'a'.repeat(500_000)}`, { maxPromptBytes: 1_000_000, mentions: 'allow' });
    expect(r).toMatchObject({ ok: true, removed: 1 });
    expect(r.ok && r.text.length).toBe(500_001);
  });

  it('prompt.send with a 130k prompt fails E_INPUT_INVALID{tooLarge}', () => {
    const h = readyHarness();
    const r = h.cmd({ type: 'prompt.send', text: 'b'.repeat(130_000), whenBusy: 'wait' });
    expect(r).toMatchObject({ ok: false, error: { code: 'E_INPUT_INVALID' } });
  });

  it('a 300k deny message is cut to 2 KiB; controls are stripped even next to a lone surrogate', () => {
    expect(sanitizeMessage('x'.repeat(300_000))).toBe('x'.repeat(2048));
    expect(sanitizeMessage('a\u0007b\uD800c')).toBe('abc');
  });
});

const keyNames = (h: Harness): string[] => h.primitives().map((p) => (p.kind === 'key' ? p.key : p.kind));

describe("a command never takes another actor's dialog as its modal (command-modal-grabs-foreign-dialogs)", () => {
  const foreign: [string, Parameters<typeof frame>[0]][] = [
    ['usage-limit menu', { surface: 'usageLimitMenu', dialog: { kind: 'usageLimitMenu', options: [] }, composer: undefined }],
    ['AskUserQuestion', { surface: 'modal', dialog: { kind: 'question', options: [] }, composer: undefined }],
    ['plan approval', { surface: 'modal', dialog: { kind: 'planApproval', options: [] }, composer: undefined }],
    ['elicitation', { surface: 'modal', dialog: { kind: 'elicitation', options: [] }, composer: undefined }],
  ];
  for (const [name, over] of foreign) {
    it(`/compact awaiting its effect while a ${name} appears: no captureText, no Escape, not resolved`, () => {
      const h = readyHarness();
      h.cmd({ type: 'slash.run', name: '/compact' });
      const id = h.lastCmdId();
      h.run(300);
      expect(keyNames(h)).toContain('Enter');
      h.run(10_000, 500);
      h.screen(frame(over));
      h.run(1000);
      expect(keyNames(h)).not.toContain('captureText');
      expect(keyNames(h)).not.toContain('Escape');
      expect(h.resultFor(id)).toBeUndefined();
    });
  }

  it("a command's own generic modal is still captured and dismissed", () => {
    const h = readyHarness();
    h.cmd({ type: 'slash.run', name: '/status' });
    const id = h.lastCmdId();
    h.run(300);
    h.screen(frame({ surface: 'modal', dialog: { kind: 'other', options: [] }, composer: undefined }));
    h.run(500);
    expect(keyNames(h).slice(-2)).toEqual(['captureText', 'Escape']);
    expect(h.resultFor(id)).toMatchObject({ ok: true, value: { effect: 'modal' } });
  });
});

const permDialog = (o: Parameters<typeof frame>[0] = {}) =>
  frame({
    surface: 'permissionDialog',
    dialog: { kind: 'permission', title: 'Bash command', options: [{ n: 1, label: 'Yes', selected: true }] },
    composer: undefined,
    ...o,
  });
const bgRequest = (h: Harness, seq: number): Harness =>
  h.hook(
    'permission.requested',
    { hookSeq: seq as never, toolName: 'Bash', input: { command: 'ls' }, suggestions: [], agent: { agentId: 'bgx' } },
    'PermissionRequest',
    { agentId: 'bgx' },
  );

describe("setMode presses no Escape on another actor's dialog (setmode-escape-on-permission-dialog)", () => {
  it("a background agent's held request appears between presses: fail E_MODE_FORBIDDEN, no Escape", () => {
    const h = readyHarness(testConfig({ permissions: { policy: 'handler' } }));
    let raised = false;
    h.onPrimitive = (p, hh) => {
      if (p.kind !== 'key' || p.key !== 'BTab' || raised) return undefined;
      raised = true;
      bgRequest(hh, 1);
      return {
        surface: 'permissionDialog',
        dialog: { kind: 'permission', options: [{ n: 1, label: 'Yes', selected: true }] },
        composer: undefined,
      };
    };
    h.cmd({ type: 'mode.set', mode: 'acceptEdits' });
    const id = h.lastCmdId();
    h.run(1500);
    expect(h.resultFor(id)).toMatchObject({ ok: false, error: { code: 'E_MODE_FORBIDDEN', details: { reason: 'dialog' } } });
    expect(keyNames(h)).not.toContain('Escape');
    expect(h.d.permissions['p1' as never]?.state.value).toBe('pending');
  });

  it('an AskUserQuestion appears after a press: no Escape', () => {
    const h = readyHarness();
    h.onPrimitive = (p) =>
      p.kind === 'key' && p.key === 'BTab'
        ? { surface: 'modal', dialog: { kind: 'question', options: [] }, composer: undefined }
        : undefined;
    h.cmd({ type: 'mode.set', mode: 'acceptEdits' });
    const id = h.lastCmdId();
    h.run(1500);
    expect(h.resultFor(id)).toMatchObject({ ok: false, error: { code: 'E_MODE_FORBIDDEN' } });
    expect(keyNames(h)).not.toContain('Escape');
  });

  it('the mode-entry warning a BTab opened is still dismissed with Escape', () => {
    const h = readyHarness();
    h.onPrimitive = (p) =>
      p.kind === 'key' && p.key === 'BTab' ? { surface: 'modal', dialog: { kind: 'other', options: [] }, composer: undefined } : undefined;
    h.cmd({ type: 'mode.set', mode: 'acceptEdits' });
    h.run(1500);
    expect(keyNames(h)).toContain('Escape');
  });
});

describe('a keys-mode composer clear presses Escape only on a visible idle composer (clear-escape-without-visible-composer)', () => {
  function failedSubmitDuringHold(): Harness {
    const h = readyHarness(testConfig(), {}, { auto: false });
    h.cmd({ type: 'prompt.send', text: 'q', whenBusy: 'wait' });
    h.done(h.lastInput()!); // editorStage
    h.done(h.lastInput()!); // C-g
    bgRequest(h, 1); // a background agent's request is held mid-flight
    h.done(h.lastInput()!); // awaitEditorConsumed
    h.screen(composerFrame('q'));
    h.tx('prompt.blocked', { reason: 'blocked_by_hook', text: 'q' }, { uuid: 'b1' }); // submit fails → clearComposer queued
    h.run(1000);
    expect(keyNames(h)).not.toContain('Escape');
    return h;
  }

  it('the hold ends without our answer and Claude shows its own dialog (dialogOnly): no Escape on it', () => {
    const h = failedSubmitDuringHold();
    h.obs('permission.hookClosed', { hookSeq: 1 as never, reason: 'timeout' }, 'self');
    h.screen(permDialog());
    h.run(3000);
    expect(h.d.permissions['p1' as never]?.state.value).toBe('dialogOnly');
    expect(keyNames(h)).not.toContain('Escape');
  });

  it('a turn is running when the clear could start: it waits, then clears the idle composer', () => {
    const h = failedSubmitDuringHold();
    h.hook(
      'prompt.submitted',
      {
        promptId: 'pn',
        text: '<task-notification><task-id>x</task-id><status>completed</status></task-notification>',
        taskNotification: { taskId: 'x', status: 'completed' },
      },
      'UserPromptSubmit',
    );
    h.cmd({ type: 'permission.answer', permissionKey: 'p1' as never, decision: { behavior: 'deny' }, by: 'host' });
    h.screen(busyFrame({ composer: { text: 'q', empty: false, placeholderLikely: false, pastedPlaceholder: false, notices: [] } }));
    h.run(1000);
    expect(keyNames(h)).not.toContain('Escape');
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false }, 'Stop');
    h.screen(composerFrame('q'));
    h.run(1000);
    expect(keyNames(h).filter((k) => k === 'Escape')).toHaveLength(1);
  });
});

describe("a host answer on the hook path aborts the handler's ask (host-answer-no-cancelask)", () => {
  it('policy handler, host answers first: host.cancelAsk{answered}; a handler answer emits none', () => {
    const h = running(readyHarness(testConfig({ permissions: { policy: 'handler' } })));
    bgRequest(h, 1);
    expect(h.intentsOf('host.askPermission').map((i) => i.permissionKey)).toEqual(['p1']);
    expect(h.cmd({ type: 'permission.answer', permissionKey: 'p1' as never, decision: { behavior: 'allow' }, by: 'host' })?.ok).toBe(true);
    expect(h.intentsOf('host.cancelAsk')).toMatchObject([{ permissionKey: 'p1', reason: 'answered' }]);

    const g = running(readyHarness(testConfig({ permissions: { policy: 'handler' } })));
    bgRequest(g, 1);
    g.cmd({ type: 'permission.answer', permissionKey: 'p1' as never, decision: { behavior: 'allow' }, by: 'handler' });
    expect(g.intentsOf('host.cancelAsk')).toEqual([]);
  });
});

describe("a subagent file's API error never fails the main turn (subagent-api-error-fails-main-turn)", () => {
  function fgAgent(): Harness {
    const h = running(readyHarness());
    h.hook('tool.pre', { toolUseId: 'toolu_a', toolName: 'Agent', input: { subagent_type: 'Explore', prompt: 'go' } }, 'PreToolUse');
    h.hook('agent.started', { agent: { agentId: 'ag1', agentType: 'Explore' } }, 'SubagentStart');
    return h;
  }
  const sidechain = { agentId: 'ag1', origin: { kind: 'transcript', fileKey: 'f2', generation: 1, offset: 0, sidechain: true } } as const;

  it('apiErrorRecorded with the main promptId from agent ag1: t1 keeps running', () => {
    const h = fgAgent();
    h.tx('model.apiErrorRecorded', { promptId: 'p1', text: 'API Error: 400', error: 'invalid_request' }, sidechain);
    h.run(600);
    expect(h.d.turns['t1' as never]?.state.value).toBe('running');
    expect(h.d.turns['t1' as never]?.error).toBeUndefined();
  });

  it('an interrupt marker / turn_duration from the agent file leaves t1 running', () => {
    const h = fgAgent();
    h.tx('turn.interrupted', { marker: 'request', promptId: 'p1' }, sidechain);
    h.tx('turn.durationRecorded', { durationMs: 5, pendingBackgroundAgentCount: 0, promptId: 'p1' }, sidechain);
    h.run(600);
    expect(h.d.turns['t1' as never]?.state.value).toBe('running');
  });

  it('the same API error on the main thread still fails t1', () => {
    const h = fgAgent();
    h.tx('model.apiErrorRecorded', { promptId: 'p1', text: 'API Error: 400', error: 'invalid_request' }, { uuid: 'e1' });
    h.run(600);
    expect(h.d.turns['t1' as never]?.state.value).toBe('failed');
  });
});

describe('claim TTL while the screen channel is degraded (claims-ttl-degraded-untested)', () => {
  const stalledClaim = (h: Harness): Harness => {
    h.screen(busyFrame({ status: { kind: 'stalled' } }));
    h.run(300);
    expect(h.ev('claim.asserted').some((e) => e.payload.claim === 'status:stalled')).toBe(true);
    return h;
  };
  const expired = (h: Harness) => h.ev('claim.expired').filter((e) => e.payload.claim === 'status:stalled');

  it('degraded (captures failing): no new frame → the asserted claim expires at its TTL', () => {
    const h = stalledClaim(running(readyHarness()));
    h.obs('channel.health', { channel: 'screen', health: 'degraded', reason: 'captureFailed' }, 'channel');
    expect(expired(h)).toEqual([]); // degraded does not expire everything at once (only down/off do)
    h.run(10_000, 500);
    expect(expired(h)).toHaveLength(1);
    expect(h.core.recon.claims['status:stalled']).toBeUndefined();
  });

  it('up: the unchanged screen keeps extending the claim past its TTL', () => {
    const h = stalledClaim(running(readyHarness()));
    h.run(10_000, 500);
    expect(expired(h)).toEqual([]);
    expect(h.core.recon.claims['status:stalled']?.status).toBe('asserted');
  });
});

describe('usageLimit.autoResume:false never wakes Claude (autoresume-false-untested)', () => {
  it('a limit with a known reset time: no wake scheduled, no usageWake deadline, nothing submitted past reset + jitter', () => {
    const h = running(readyHarness(testConfig({ usage: { autoResume: false } })));
    const reset = WALL0 + 3_600_000;
    h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    h.tx(
      'model.apiErrorRecorded',
      { error: 'rate_limit', apiError: 'usage_limit_reached', text: "You've hit your limit", resetsAtWall: reset as never },
      { uuid: 'ae' },
    );
    expect(h.d.usage.limit).toMatchObject({ state: 'limited', resetsAtWall: reset });
    expect(h.ev('usage.wakeScheduled')).toEqual([]);
    expect(h.core.recon.deadlines['usageWake:limit' as never]).toBeUndefined();
    const before = h.primitives().length;
    h.advance(100, reset + 120_000 - h.wall);
    h.run(6000, 500);
    expect(h.ev('usage.wakeScheduled')).toEqual([]);
    expect(h.d.usage.limit?.state).toBe('limited');
    expect(h.primitives().slice(before)).toEqual([]);
    expect(Object.keys(h.d.turns)).toEqual(['t1']);
  });
});
