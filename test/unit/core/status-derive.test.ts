// core/status/derive.ts — §4.7 first match wins (P-REC-13, P-REC-42, P-REV-20).
import { describe, expect, it } from 'vitest';
import { deriveStatus } from '../../../src/core/status/derive.js';
import type { MonoMs } from '../../../src/model/time.js';
import type { Harness } from './harness.js';
import { busyFrame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

function running(): Harness {
  const h = readyHarness();
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}

describe('deriveStatus', () => {
  it('order: awaitingPermission beats awaitingInput beats runningTools beats writing beats modelRequest', () => {
    const h = running();
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'waiting' });
    h.hook('message.textDelta', { uiTurnId: 'u', uiMessageId: 'm', index: 0, final: false, delta: 'x' }, 'MessageDisplay');
    expect(h.d.status.kind).toBe('writing');
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Bash', input: {} }, 'PreToolUse');
    expect(h.d.status.kind).toBe('runningTools');
    h.hook('input.requested', { kind: 'elicitation', message: 'pick' }, 'Notification');
    expect(h.d.status).toMatchObject({ kind: 'awaitingInput', inputKind: 'elicitation', message: 'pick' });
    h.hook('permission.requested', { hookSeq: 1 as never, toolName: 'Bash', input: {}, suggestions: [] }, 'PermissionRequest');
    expect(h.d.status.kind).toBe('awaitingPermission');
  });

  it('a thinking label never yields stalled (P-REC-13); a stall claim does', () => {
    const h = running();
    h.screen(busyFrame({ status: { kind: 'spinner', thinkingLabel: 'thinking some more', elapsedMs: 40_000 } }));
    h.run(300);
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'waiting' });
    h.screen(busyFrame({ status: { kind: 'stalled' } }));
    h.run(300);
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'stalled' });
  });

  it('K-16 retry banner attempt 4/10 → modelRequest.retrying (provisional), stale done line ignored', () => {
    const h = running();
    h.tx('model.requestStarted', { requestRef: 'txreq:a', isRetry: false, requestDigest: 'd' }, { uuid: 'txreq:a' });
    h.screen(busyFrame({ status: { kind: 'retrying', attempt: 4, max: 10, retryInMs: 8000 } }));
    h.run(300);
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'retrying', attempt: 4, maxAttempts: 10, retryInMs: 8000 });
    expect(h.d.calls['c1' as never]?.state).toMatchObject({ value: 'retrying', provisional: true });
    h.screen(busyFrame({ status: { kind: 'done', doneDurationMs: 100 } }));
    h.run(300);
    expect(h.d.turns['t1' as never]?.state.value).toBe('running');
  });

  it('idle carries lastTurn error, queued count and quiescence (P-REV-20: API error is an attribute)', () => {
    const h = running();
    h.hook('turn.failed', { error: 'server_error' }, 'StopFailure');
    expect(h.d.status).toMatchObject({ kind: 'idle', queued: 0, backgroundAgents: 0, quiescent: true, lastTurn: { outcome: 'failed' } });
  });

  it('usageLimited and compacting', () => {
    const h = readyHarness(testConfig({ usage: { autoResume: false } }));
    h.hook('compact.phase', { phase: 'started', trigger: 'auto' }, 'PreCompact');
    expect(h.d.status.kind).toBe('compacting');
    h.hook('compact.phase', { phase: 'finished' }, 'PostCompact');
    expect(h.d.status.kind).toBe('idle');
    h.screen(
      busyFrame({
        usageLimit: {
          line: "You've hit your 5-hour limit · resets 3pm",
          limitName: '5-hour limit',
          resetsAtWall: 1_800_000_900_000 as never,
        },
      }),
    );
    h.run(300);
    expect(h.d.status).toMatchObject({ kind: 'usageLimited', autoResume: false, resetsAtWall: 1_800_000_900_000 });
  });

  it('since is stable while the kind is unchanged; status.changed only on deep inequality', () => {
    const h = running();
    const s1 = h.d.status;
    h.run(1000);
    expect(h.d.status).toEqual(s1);
    const d = deriveStatus(h.d, { now: (h.now + 50) as MonoMs, config: h.core.config, prev: s1 });
    expect(d.since).toBe(s1.since);
  });

  it('background agents never make the main status non-idle', () => {
    const h = readyHarness();
    h.hook('agent.started', { agent: { agentId: 'bg', agentType: 'general-purpose' } }, 'SubagentStart');
    h.hook('tool.post', { toolUseId: 'toolu_b', toolName: 'Agent', response: {}, asyncAgentId: 'bg' }, 'PostToolUse');
    h.hook('tool.pre', { toolUseId: 'toolu_c', toolName: 'Bash', input: {}, agent: { agentId: 'bg' } }, 'PreToolUse');
    expect(h.d.status).toMatchObject({ kind: 'idle', backgroundAgents: 1, quiescent: false });
  });
});
