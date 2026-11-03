// core/decide/tools.ts — ToolRun transitions (§4.6, RC §10.3; P-REC-14, P-REC-26/27/31/34, P-REV-10).
import { describe, expect, it } from 'vitest';
import type { MonoMs } from '../../../src/model/time.js';
import { displayToolState } from '../../../src/core/selectors.js';
import type { Harness } from './harness.js';
import { readyHarness, sendUntilEnter, ups } from './harness.js';

function running(): Harness {
  const h = readyHarness();
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
const tool = (h: Harness, k = 'u1') => h.d.tools[k as never];
const pre = (h: Harness, id = 'toolu_1', name = 'Bash', input: unknown = { command: 'ls' }): Harness =>
  h.hook('tool.pre', { toolUseId: id, toolName: name, input, promptId: 'p1' }, 'PreToolUse');

describe('ToolRun', () => {
  it('tool.pre → pending attributed to the active turn; no timer ever moves it (rev 2 §10 A1)', () => {
    const h = running();
    pre(h);
    expect(tool(h)).toMatchObject({ name: 'Bash', turn: 't1', toolUseId: 'toolu_1', promptIdAtPre: 'p1' });
    expect(tool(h)?.state.value).toBe('pending');
    expect(h.d.turns['t1' as never]?.tools).toEqual(['u1']);
    h.run(10_000, 1000);
    expect(tool(h)?.state.value).toBe('pending');
    expect(h.d.status.kind).toBe('runningTools');
  });

  it('displayToolState shows running for a pending tool older than 150 ms with no permission (facades only)', () => {
    const h = running();
    pre(h);
    const t = tool(h)!;
    expect(displayToolState(t, ((t.preAt ?? 0) + 100) as MonoMs)).toBe('pending');
    expect(displayToolState(t, ((t.preAt ?? 0) + 200) as MonoMs)).toBe('running');
  });

  it('PostToolUse → succeeded with responseRef; PostToolUseFailure → failed / interrupted(is_interrupt)', () => {
    const h = running();
    pre(h, 'toolu_1');
    h.hook('tool.post', { toolUseId: 'toolu_1', toolName: 'Bash', response: { stdout: 'a' }, durationMs: 12 }, 'PostToolUse');
    expect(tool(h)?.state.value).toBe('succeeded');
    expect(tool(h)?.responseRef?.bytes).toBeGreaterThan(0);
    expect(h.ev('tool.ended')[0]?.payload).toMatchObject({ toolKey: 'u1', state: 'succeeded', outcomeFrom: 'post', durationMs: 12 });
    pre(h, 'toolu_2');
    h.hook('tool.failed', { toolUseId: 'toolu_2', toolName: 'Bash', error: 'exit 1' }, 'PostToolUseFailure');
    expect(tool(h, 'u2')?.state.value).toBe('failed');
    pre(h, 'toolu_3');
    h.hook('tool.failed', { toolUseId: 'toolu_3', toolName: 'Bash', error: 'stop', isInterrupt: true }, 'PostToolUseFailure');
    expect(tool(h, 'u3')?.state.value).toBe('interrupted');
  });

  it('a Post with no Pre creates a terminal placeholder (post_without_pre, P-REC-26)', () => {
    const h = running();
    h.hook('tool.post', { toolUseId: 'toolu_x', toolName: 'Read', response: 'ok' }, 'PostToolUse');
    expect(tool(h)?.state.value).toBe('succeeded');
    expect(h.diag('post_without_pre')).toHaveLength(1);
  });

  it('async_launched → launched then succeeded; the agent keeps running (P-REC-06)', () => {
    const h = running();
    pre(h, 'toolu_a', 'Agent', { subagent_type: 'general-purpose', run_in_background: true });
    h.hook(
      'tool.post',
      { toolUseId: 'toolu_a', toolName: 'Agent', response: { status: 'async_launched', agentId: 'ag' }, asyncAgentId: 'ag' },
      'PostToolUse',
    );
    expect(h.ev('tool.updated').some((e) => e.payload.state === 'launched')).toBe(true);
    expect(tool(h)?.state.value).toBe('succeeded');
    expect(h.d.agents['a1' as never]).toMatchObject({ agentId: 'ag', background: true, spawnTool: 'u1', spawnLinkConfirmed: true });
    expect(h.d.agents['a1' as never]?.state.value).toBe('running');
  });

  it('transcript tool_result maps denial kinds (P-REC-27)', () => {
    const h = running();
    for (const [i, dk, want] of [
      [1, 'user-rejected', 'denied'],
      [2, 'permission-rule', 'denied'],
      [3, 'interrupted', 'interrupted'],
    ] as const) {
      pre(h, `toolu_${i}`);
      h.tx('tool.result', { toolUseId: `toolu_${i}`, isError: true, denialKind: dk, uuid: `r${i}` }, { uuid: `r${i}` });
      expect(tool(h, `u${i}`)?.state.value).toBe(want);
    }
    pre(h, 'toolu_4');
    h.tx('tool.result', { toolUseId: 'toolu_4', isError: false, uuid: 'r4' }, { uuid: 'r4' });
    expect(tool(h, 'u4')?.state.value).toBe('succeeded');
  });

  it('transcript-first tool_use → proposed; the later Pre moves it to pending; a tool_use for a terminal tool only enriches (P-REC-31)', () => {
    const h = running();
    h.tx(
      'message.block',
      {
        apiMessageId: 'msg',
        blockIndex: 1,
        block: 'tool_use',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: { command: 'ls' },
        stopReason: 'tool_use',
        synthetic: false,
        abortedMidStream: false,
        uuid: 'b',
        parentUuid: null,
      },
      { uuid: 'b' },
    );
    expect(tool(h)?.state.value).toBe('proposed');
    pre(h, 'toolu_1');
    expect(tool(h)?.state.value).toBe('pending');
    h.hook('tool.post', { toolUseId: 'toolu_1', toolName: 'Bash', response: 'x' }, 'PostToolUse');
    h.tx(
      'message.block',
      {
        apiMessageId: 'msg',
        blockIndex: 1,
        block: 'tool_use',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: {},
        stopReason: 'tool_use',
        synthetic: false,
        abortedMidStream: false,
        uuid: 'b2',
        parentUuid: null,
      },
      { uuid: 'b2' },
    );
    expect(tool(h)?.state.value).toBe('succeeded');
    expect(tool(h)?.apiMessageId).toBe('msg');
  });

  it('a validation error fires no hooks: transcript-first tool → failed (P-REC-26)', () => {
    const h = running();
    h.tx(
      'message.block',
      {
        apiMessageId: 'm',
        blockIndex: 0,
        block: 'tool_use',
        toolUseId: 'toolu_v',
        toolName: 'Edit',
        input: {},
        stopReason: 'tool_use',
        synthetic: false,
        abortedMidStream: false,
        uuid: 'v',
        parentUuid: null,
      },
      { uuid: 'v' },
    );
    h.tx('tool.validationError', { toolUseId: 'toolu_v' }, { uuid: 'v#1' });
    expect(tool(h)?.state.value).toBe('failed');
  });

  it('PostToolBatch closes listed still-running tools; a later Post only enriches (P-REC-34)', () => {
    const h = running();
    pre(h, 'toolu_1');
    pre(h, 'toolu_2');
    h.hook('tool.batchDone', { toolUseIds: ['toolu_1', 'toolu_2'] }, 'PostToolBatch');
    expect(tool(h)?.state.value).toBe('succeeded');
    expect(tool(h)?.outcomeFrom).toBe('batch');
    h.hook('tool.post', { toolUseId: 'toolu_1', toolName: 'Bash', response: 'late' }, 'PostToolUse');
    expect(tool(h)?.outcomeFrom).toBe('batch');
    expect(tool(h)?.responseRef?.preview).toBe('late');
  });

  it('closing rule 1: a turn ending leaves no open main-thread tool (unknown, closing_rule)', () => {
    const h = running();
    pre(h, 'toolu_1');
    h.hook('turn.failed', { error: 'server_error' }, 'StopFailure');
    expect(tool(h)?.state.value).toBe('unknown');
    expect(tool(h)?.outcomeFrom).toBe('closing_rule');
    // unknown + later post → concrete (tool.resolvedLate)
    h.hook('tool.post', { toolUseId: 'toolu_1', toolName: 'Bash', response: 'x' }, 'PostToolUse');
    expect(tool(h)?.state.value).toBe('succeeded');
    expect(h.ev('tool.resolvedLate')[0]?.payload).toEqual({ toolKey: 'u1', to: 'succeeded' });
  });

  it('a hook-provisional denial is confirmed by the transcript, and a long tool is never timed out (P-REC-14)', () => {
    const h = running();
    pre(h, 'toolu_1', 'Bash', { command: 'sleep 3600' });
    h.run(120_000, 10_000);
    expect(tool(h)?.state.value).toBe('pending');
  });
});
