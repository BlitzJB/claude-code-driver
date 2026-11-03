// core/deadlines.ts + every row of DESIGN.md §4.10 (all decision timers are core deadlines, D-03, P-TMUX-54).
import { describe, expect, it } from 'vitest';
import { nextDeadline } from '../../../src/core/deadlines.js';
import type { HookSeq } from '../../../src/model/ids.js';
import {
  Harness,
  SESSION_ID,
  WALL0,
  busyFrame,
  composerFrame,
  frame,
  idleFrame,
  readyHarness,
  sendUntilEnter,
  testConfig,
  ups,
} from './harness.js';

const launch = (h: Harness): Harness =>
  h.obs('process.launched', { pid: 1, paneId: '%1', claudeVersion: '2.1.316', startTime: 't' }, 'process');
const running = (h: Harness, text = 'work', id = 'p1'): void => {
  sendUntilEnter(h, text);
  ups(h, text, id);
};
const tunnel = (h: Harness, phase: 'sending' | 'awaiting' | 'receiving' | 'idle', bytesDown = 0, id = 7): Harness =>
  h.obs(
    'net.tunnel',
    { tunnelId: id, host: 'api.anthropic.com', token: 'A', phase, bytesUp: 100, bytesDown, lastDownAtMono: h.now as never },
    'network',
  );
const apiRequest = (h: Harness, ref = 'txreq:r1', retry = false): Harness =>
  h.tx('model.requestStarted', { requestRef: ref, isRetry: retry, requestDigest: 'dg', txWall: h.wall as never }, { uuid: ref });

describe('nextDeadline', () => {
  it('reports the earliest mono deadline and, separately, the earliest wall deadline', () => {
    const h = launch(new Harness());
    expect(nextDeadline(h.core)).toEqual({ atMono: 3000 });
    const r = readyHarness();
    r.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    // a hook-only limit waits transcriptSettle for the transcript's reset time, then arms the unknown-reset wall wake
    r.run(r.core.config.timeouts.transcriptSettleMs);
    expect(nextDeadline(r.core).atWall).toBeGreaterThan(WALL0);
  });
});

describe('§4.10 deadlines', () => {
  it('§4.10#1 startupHookGrace (3000) armed by process.launched classifies the screen', () => {
    const h = launch(new Harness());
    expect(h.core.recon.deadlines['startupHookGrace:startup']?.at).toBe(3000);
    h.advance(10).screen(idleFrame());
    h.run(3000);
    expect(h.d.channels.hooks.reasons).toEqual(['noSessionStart']);
  });

  it('§4.10#2 startup (60000) → E_STARTUP_TIMEOUT', () => {
    const h = launch(new Harness());
    expect(h.core.recon.deadlines['startup:startup']?.at).toBe(60000);
    h.advance(59_999);
    expect(h.d.lifecycle).toBe('launching');
    h.advance(1);
    expect(h.d.lifecycle).toBe('exited');
  });

  it('§4.10#3 readyStable (300) from a stable empty composer', () => {
    const h = launch(new Harness());
    h.hook('session.started', { sessionId: SESSION_ID, transcriptPath: '/t.jsonl', source: 'startup' }, 'SessionStart');
    h.screen(idleFrame());
    expect(h.core.recon.deadlines['readyStable:ready']?.at).toBe(h.now + 300);
    h.advance(100).screen(composerFrame('typing'));
    expect(h.core.recon.deadlines['readyStable:ready']).toBeUndefined();
  });

  it('§4.10#4 settle (100) between the verified stage and Enter', () => {
    const h = readyHarness();
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    expect(h.primitives().some((p) => p.kind === 'key' && p.key === 'Enter')).toBe(false);
    expect(Object.keys(h.core.recon.deadlines).some((k) => k.startsWith('settle:'))).toBe(true);
    h.run(100);
    expect(h.primitives().at(-1)).toEqual({ kind: 'key', key: 'Enter', gapAfterMs: 15 });
  });

  it('§4.10#5 submitAck is 3000 ms, +2000 on the first prompt of a generation', () => {
    const h = readyHarness();
    h.cmd({ type: 'prompt.send', text: 'first', whenBusy: 'wait' });
    h.run(100);
    const first = Object.values(h.core.recon.deadlines).find((d) => d.kind === 'submitAck');
    expect(first !== undefined ? first.at - h.now : 0).toBeGreaterThan(4900);
    ups(h, 'first', 'p1');
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false }, 'Stop');
    h.tx('turn.durationRecorded', { durationMs: 1, pendingBackgroundAgentCount: 0 }, { uuid: 'd' });
    h.run(600);
    h.cmd({ type: 'prompt.send', text: 'second', whenBusy: 'wait' });
    h.run(100);
    const second = Object.values(h.core.recon.deadlines).find((d) => d.kind === 'submitAck');
    expect(second !== undefined ? second.at - h.now : 0).toBeLessThanOrEqual(3000);
  });

  it('§4.10#6 editorConsume: an editor that never reports consumption → fallback to pasteChunks (K-07)', () => {
    const h = readyHarness(testConfig(), {}, { auto: false });
    h.cmd({ type: 'prompt.send', text: 'paste me', whenBusy: 'wait' });
    h.done(h.lastInput()!); // editorStage
    h.done(h.lastInput()!); // C-g
    expect(h.lastInput()?.primitive.kind).toBe('awaitEditorConsumed');
    h.run(4100); // executor silent: the core backstop fires
    h.run(700); // beforePaste frame wait
    expect(h.primitives().some((p) => p.kind === 'pasteChunk')).toBe(true);
    expect(h.diag('editor_fallback')).toHaveLength(1);
  });

  it('§4.10#7 dialogSettle (150) since the first frame of a new surface gates job start; escGap after Escape', () => {
    const h = readyHarness();
    h.screen(frame({ surface: 'main' }));
    h.advance(1).screen(frame({ surface: 'modal', composer: undefined }));
    h.advance(1).screen(idleFrame());
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    expect(h.intentsOf('input')).toEqual([]);
    h.run(160);
    expect(h.primitives()[0]).toEqual({ kind: 'editorStage', text: 'x' });
  });

  it('§4.10#8 interruptConfirm (5000) with no evidence → interrupt.ignored{noEvidence}', () => {
    const h = readyHarness();
    running(h);
    h.cmd({ type: 'interrupt' });
    expect(h.primitives().at(-1)).toEqual({ kind: 'key', key: 'Escape', gapAfterMs: 250 });
    h.run(5100);
    expect(h.ev('interrupt.ignored')[0]?.payload.reason).toBe('noEvidence');
  });

  it('§4.10#9 stopGrace (500) → completed', () => {
    const h = readyHarness();
    running(h);
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false }, 'Stop');
    h.advance(499);
    expect(h.d.turns['t1' as never]?.state.value).toBe('stopping');
    h.advance(1);
    expect(h.d.turns['t1' as never]?.state.value).toBe('completed');
  });

  it('§4.10#10 lateText (500): MessageDisplay within → turn.textAppended, after → dropped', () => {
    const h = readyHarness();
    running(h);
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false, lastAssistantMessage: 'x' }, 'Stop');
    h.run(500);
    h.advance(200);
    h.hook(
      'message.textDelta',
      { promptId: 'p1', uiTurnId: 'u', uiMessageId: 'm1', index: 0, final: true, delta: 'late' },
      'MessageDisplay',
    );
    expect(h.ev('turn.textAppended')).toHaveLength(1);
    h.advance(400);
    h.hook(
      'message.textDelta',
      { promptId: 'p1', uiTurnId: 'u', uiMessageId: 'm2', index: 0, final: true, delta: 'later' },
      'MessageDisplay',
    );
    expect(h.ev('turn.textAppended')).toHaveLength(1);
    expect(h.diag('late_text_dropped')).toHaveLength(1);
  });

  it('§4.10#11 transcriptSettle (5000) stops waiting for turn_duration, never an error', () => {
    const h = readyHarness();
    running(h);
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false }, 'Stop');
    h.run(500);
    expect(h.core.recon.stopUncorroborated).toBe('t1');
    h.run(5000);
    expect(h.core.recon.stopUncorroborated).toBeUndefined();
    expect(h.ev('warning')).toEqual([]);
  });

  it('§4.10#12 permBindLate (2000): an unbound request stays unbound with auto-answer off', () => {
    const h = readyHarness(testConfig({ permissions: { policy: 'dangerouslyAllowAll' } }));
    running(h);
    h.hook(
      'permission.requested',
      { hookSeq: 1 as HookSeq, toolName: 'Bash', input: { command: 'ls' }, suggestions: [] },
      'PermissionRequest',
    );
    const p = h.d.permissions['p1' as never];
    expect(p?.binding.kind).toBe('unbound');
    expect(p?.autoAnswerAllowed).toBe(false);
    expect(h.intentsOf('host.askPermission')).toHaveLength(1);
    h.run(2100);
    expect(h.diag('permission_unbound')).toHaveLength(1);
  });

  it('§4.10#13 permissionPolicy: timeoutMs for foreground, backgroundTimeoutMs (10000) for background agents', () => {
    const h = readyHarness();
    running(h);
    h.hook('permission.requested', { hookSeq: 1 as HookSeq, toolName: 'Bash', input: {}, suggestions: [] }, 'PermissionRequest');
    expect(h.core.recon.deadlines['permissionPolicy:p1']?.at).toBe(h.now + 120000);
    h.hook('agent.started', { agent: { agentId: 'bg', agentType: 'general-purpose' } }, 'SubagentStart');
    h.hook(
      'permission.requested',
      { hookSeq: 2 as HookSeq, toolName: 'Read', input: {}, suggestions: [], agent: { agentId: 'bg' } },
      'PermissionRequest',
    );
    expect(h.core.recon.deadlines['permissionPolicy:p2']?.at).toBe(h.now + 10000);
    h.run(10_100, 500);
    expect(h.d.permissions['p2' as never]?.ourAnswer).toMatchObject({ decision: 'deny', by: 'timeout' });
    expect(h.intentsOf('host.cancelAsk').some((i) => i.permissionKey === 'p2')).toBe(true);
  });

  it('§4.10#14 adoptDialog (500): a stable permission dialog with no record is adopted', () => {
    const h = readyHarness();
    running(h);
    h.screen(
      busyFrame({
        surface: 'permissionDialog',
        dialog: {
          kind: 'permission',
          title: 'Bash command',
          options: [
            { n: 1, label: 'Yes', selected: true },
            { n: 2, label: 'No', selected: false },
          ],
        },
        composer: undefined,
      }),
    );
    h.run(300);
    expect(Object.keys(h.d.permissions)).toEqual([]);
    h.run(500);
    expect(h.d.permissions['p1' as never]).toMatchObject({ adopted: true, binding: { kind: 'screen-only' }, autoAnswerAllowed: false });
    expect(h.ev('permission.needsKeys')).toHaveLength(1);
  });

  it('§4.10#15 modalEffect (5000): a command with no evidence resolves {effect:"none"}', () => {
    const h = readyHarness();
    h.cmd({ type: 'slash.run', name: '/status' });
    const id = h.lastCmdId();
    h.run(5500);
    expect(h.resultFor(id)).toMatchObject({ ok: true, value: { ok: true, effect: 'none' } });
  });

  it('§4.10#16 hookGap (2000): a transcript-first tool with no PreToolUse degrades the hooks channel', () => {
    const h = readyHarness();
    running(h);
    h.tx(
      'message.block',
      {
        apiMessageId: 'm1',
        blockIndex: 0,
        block: 'tool_use',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: {},
        stopReason: 'tool_use',
        synthetic: false,
        abortedMidStream: false,
        uuid: 'b1',
        parentUuid: null,
      },
      { uuid: 'b1' },
    );
    expect(h.d.tools['u1' as never]?.state.value).toBe('proposed');
    h.run(2100);
    expect(h.d.channels.hooks.reasons).toContain('hookGap:PreToolUse');
  });

  it('§4.10#17 stall (25000) without down bytes while receiving → stalled', () => {
    const h = readyHarness();
    running(h);
    tunnel(h, 'sending');
    apiRequest(h);
    tunnel(h, 'receiving', 500);
    expect(h.d.calls['c1' as never]?.state.value).toBe('streaming');
    h.run(25_100, 1000);
    expect(h.d.calls['c1' as never]?.state.value).toBe('stalled');
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'stalled' });
  });

  it('§4.10#18 quiet (15000) → modelCall.progress{quiet}', () => {
    const h = readyHarness();
    running(h);
    tunnel(h, 'sending');
    apiRequest(h);
    tunnel(h, 'receiving', 500);
    h.run(15_100, 1000);
    expect(h.ev('modelCall.progress').some((e) => e.payload.phase === 'quiet')).toBe(true);
  });

  it('§4.10#19 claimTtl: with the screen channel down asserted claims expire', () => {
    const h = readyHarness();
    running(h);
    h.screen(busyFrame({ status: { kind: 'retrying', attempt: 2, max: 10 } }));
    h.run(300);
    expect(h.ev('claim.asserted').some((e) => e.payload.claim === 'status:retrying')).toBe(true);
    h.obs('channel.health', { channel: 'screen', health: 'down', reason: 'capture failed' }, 'channel');
    expect(h.ev('claim.expired').some((e) => e.payload.claim === 'status:retrying')).toBe(true);
    // with a healthy channel an unchanged screen keeps its claims past the TTL
    const g = readyHarness();
    g.screen(busyFrame({ status: { kind: 'stalled' } }));
    g.run(10_000, 500);
    expect(g.ev('claim.expired').filter((e) => e.payload.claim === 'status:stalled')).toEqual([]);
  });

  it('§4.10#20 genImplicitConfirm (3000): an implicit generation with no SessionStart → no_session_start + hooks degraded', () => {
    const h = readyHarness();
    h.hook('notification', { type: 'idle_prompt' }, 'Notification', { claudeSessionId: 'mystery' });
    h.run(3100);
    expect(h.diag('no_session_start')).toHaveLength(1);
    expect(h.d.channels.hooks.health).toBe('degraded');
  });

  it('§4.10#21 interruptedHold (1500): status leaves interrupted', () => {
    const h = readyHarness();
    running(h);
    h.tx('turn.interrupted', { marker: 'request' }, { uuid: 'i' });
    expect(h.d.status.kind).toBe('interrupted');
    h.run(1600);
    expect(h.d.status.kind).toBe('idle');
  });

  it('§4.10#22 drain (5000) after a generation end; background agents are checked at the new generation’s first Stop (K-42)', () => {
    const h = readyHarness();
    h.hook('agent.started', { agent: { agentId: 'bg1', agentType: 'general-purpose' } }, 'SubagentStart');
    h.hook(
      'tool.post',
      { toolUseId: 'toolu_a', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg1' },
      'PostToolUse',
    );
    h.hook('agent.started', { agent: { agentId: 'bg2', agentType: 'general-purpose' } }, 'SubagentStart');
    h.hook(
      'tool.post',
      { toolUseId: 'toolu_b', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg2' },
      'PostToolUse',
    );
    h.hook('session.ended', { sessionId: SESSION_ID, reason: 'clear' }, 'SessionEnd');
    h.hook('session.started', { sessionId: 'g2id', transcriptPath: '/n.jsonl', source: 'clear' }, 'SessionStart', {
      claudeSessionId: 'g2id',
    });
    expect(h.d.agents['a1' as never]?.state.value).toBe('running');
    h.run(5100);
    expect(h.core.recon.drained['g1']).toBe(true);
    ups(h, 'new gen prompt', 'pg2');
    h.hook('turn.stopped', { backgroundTasks: [{ id: 'bg1', type: 'local_agent', status: 'running' }], stopHookActive: false }, 'Stop', {
      claudeSessionId: 'g2id',
    });
    expect(h.d.agents['a1' as never]?.state.value).toBe('running');
    expect(h.d.agents['a2' as never]?.state.value).toBe('unknown');
  });

  it('§4.10#23 hostResumeGrace (30000) suppresses stall verdicts after clock.hostResumed (K-21 core part)', () => {
    const h = readyHarness();
    running(h);
    tunnel(h, 'sending');
    apiRequest(h);
    tunnel(h, 'receiving', 10);
    h.obs('clock.hostResumed', { monoGapMs: 0, wallGapMs: 600_000 }, 'clock');
    h.run(26_000, 1000);
    expect(h.d.calls['c1' as never]?.state.value).toBe('streaming');
    h.run(5000, 1000);
    expect(h.d.calls['c1' as never]?.state.value).toBe('stalled');
  });

  it('§4.10#24 usageWake is a wall deadline: wall time passing (no mono advance) fires it', () => {
    const h = readyHarness();
    running(h);
    h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    h.tx(
      'model.apiErrorRecorded',
      { error: 'rate_limit', apiError: 'usage_limit_reached', text: 'limit', resetsAtWall: (WALL0 + 3_600_000) as never },
      { uuid: 'ae' },
    );
    const d = h.core.recon.deadlines['usageWake:limit'];
    expect(d?.clock).toBe('wall');
    const lim = h.d.usage.limit;
    expect(lim?.nextWakeAtWall).toBe(WALL0 + 3_600_000 + (lim?.jitterMs ?? 0));
    h.advance(0, 3_600_000 + 91_000);
    expect(h.d.libraryQueue.length + Object.values(h.d.turns).filter((t) => t.origin.value === 'auto_continue').length).toBeGreaterThan(0);
  });

  it('§4.10#25 none: a running tool and a background agent never time out; a held permission only via permissionPolicy', () => {
    const h = readyHarness(testConfig({ permissions: { timeoutMs: 600_000 } }));
    running(h);
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Bash', input: { command: 'sleep 9999' } }, 'PreToolUse');
    h.hook('agent.started', { agent: { agentId: 'bg', agentType: 'general-purpose' } }, 'SubagentStart');
    h.run(300_000, 10_000);
    expect(h.d.tools['u1' as never]?.state.value).toBe('pending');
    expect(h.d.agents['a1' as never]?.state.value).toBe('running');
    expect(h.d.status.kind).toBe('runningTools');
  });
});
