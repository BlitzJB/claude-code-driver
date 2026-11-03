// core/decide/agents.ts + reconcile/spawn-link.ts — §4.5.2–§4.5.4, §4.5.9 (P-REC-08, P-REC-33, P-REC-40, K-18, K-42, K-42b).
import { describe, expect, it } from 'vitest';
import type { Harness } from './harness.js';
import { SESSION_ID, readyHarness, sendUntilEnter, ups } from './harness.js';

function running(): Harness {
  const h = readyHarness();
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
const agent = (h: Harness, k = 'a1') => h.d.agents[k as never];
const spawnTool = (h: Harness, id: string, type = 'Explore', bg = false): Harness =>
  h.hook(
    'tool.pre',
    { toolUseId: id, toolName: 'Agent', input: { subagent_type: type, prompt: 'go', ...(bg ? { run_in_background: true } : {}) } },
    'PreToolUse',
  );

describe('agents', () => {
  it('SubagentStart links to the open Agent tool with the same subagent_type (provisional), meta.json confirms', () => {
    const h = running();
    spawnTool(h, 'toolu_a', 'Explore');
    h.hook('agent.started', { agent: { agentId: 'ag1', agentType: 'Explore' } }, 'SubagentStart');
    expect(agent(h)).toMatchObject({ kind: 'subagent', spawnTool: 'u1', spawnLinkConfirmed: false, agentType: 'Explore' });
    expect(h.d.tools['u1' as never]?.spawned).toBe('a1');
    expect(h.intentsOf('tail.expectSubagent')[0]).toMatchObject({ agentId: 'ag1', sessionId: SESSION_ID });
    h.tx('agent.meta', { agentId: 'ag1', toolUseId: 'toolu_a', spawnDepth: 1 });
    expect(agent(h)?.spawnLinkConfirmed).toBe(true);
  });

  it('agent_type "" with no candidate → internal agent; its tools never drive the main status (§4.5.3)', () => {
    const h = running();
    h.hook('tool.pre', { toolUseId: 'toolu_g', toolName: 'Bash', input: {}, agent: { agentId: 'ghost', agentType: '' } }, 'PreToolUse');
    expect(agent(h)?.kind).toBe('internal');
    expect(h.d.tools['u1' as never]?.agent).toBe('a1');
    expect(h.d.tools['u1' as never]?.turn).toBeUndefined();
    expect(h.d.status.kind).toBe('modelRequest');
  });

  it('SubagentStop: stopped, open tools → unknown, self entries in background_tasks ignored (P-REC-08)', () => {
    const h = running();
    spawnTool(h, 'toolu_a');
    h.hook('agent.started', { agent: { agentId: 'ag1', agentType: 'Explore' } }, 'SubagentStart');
    h.hook(
      'tool.pre',
      { toolUseId: 'toolu_s', toolName: 'Read', input: {}, agent: { agentId: 'ag1', agentType: 'Explore' } },
      'PreToolUse',
    );
    h.hook(
      'agent.stopped',
      {
        agent: { agentId: 'ag1', agentType: 'Explore' },
        backgroundTasks: [{ id: 'ag1', type: 'local_agent', status: 'running' }],
        lastAssistantMessage: 'found it',
      },
      'SubagentStop',
    );
    expect(agent(h)?.state.value).toBe('stopped');
    expect(agent(h)?.lastAssistantMessage).toBe('found it');
    expect(h.d.tools['u2' as never]?.state.value).toBe('unknown');
    expect(h.d.bgTasks['ag1']).toBeUndefined();
    expect(h.intentsOf('tail.subagentStopped')[0]?.agentId).toBe('ag1');
  });

  it('the same agent id starting again resumes (runs++, P-REC-40)', () => {
    const h = running();
    h.hook('agent.started', { agent: { agentId: 'ag1', agentType: 'Explore' } }, 'SubagentStart');
    h.hook('agent.stopped', { agent: { agentId: 'ag1', agentType: 'Explore' }, backgroundTasks: [] }, 'SubagentStop');
    h.hook('agent.started', { agent: { agentId: 'ag1', agentType: 'Explore' } }, 'SubagentStart');
    expect(agent(h)?.state.value).toBe('running');
    expect(agent(h)?.runs).toBe(2);
  });

  it('PostToolUse(async) before SubagentStart creates the agent; the later start does not duplicate it (P-REC-33)', () => {
    const h = running();
    spawnTool(h, 'toolu_a', 'general-purpose', true);
    h.hook(
      'tool.post',
      { toolUseId: 'toolu_a', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg' },
      'PostToolUse',
    );
    h.hook('agent.started', { agent: { agentId: 'bg', agentType: 'general-purpose' } }, 'SubagentStart');
    expect(Object.keys(h.d.agents)).toEqual(['a1']);
    expect(agent(h)?.background).toBe(true);
  });

  it('K-18 background agents: Stop with background_tasks → idle but not quiescent; task-notification turns; quiescent at the end', () => {
    const h = running();
    spawnTool(h, 'toolu_a', 'general-purpose', true);
    h.hook(
      'tool.post',
      { toolUseId: 'toolu_a', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg' },
      'PostToolUse',
    );
    h.hook('turn.stopped', { backgroundTasks: [{ id: 'bg', type: 'local_agent', status: 'running' }], stopHookActive: false }, 'Stop');
    h.tx('turn.durationRecorded', { durationMs: 1, pendingBackgroundAgentCount: 1 }, { uuid: 'd1' });
    h.run(600);
    expect(h.d.status).toMatchObject({ kind: 'idle', backgroundAgents: 1, quiescent: false });
    h.hook('agent.stopped', { agent: { agentId: 'bg', agentType: 'general-purpose' }, backgroundTasks: [] }, 'SubagentStop', {
      claudeSessionId: SESSION_ID,
    });
    h.hook(
      'prompt.submitted',
      {
        promptId: 'pn',
        text: '<task-notification><task-id>bg</task-id><status>completed</status></task-notification>',
        taskNotification: { taskId: 'bg', toolUseId: 'toolu_a', status: 'completed' },
      },
      'UserPromptSubmit',
    );
    expect(h.d.turns['t2' as never]?.causedBy).toMatchObject({ agent: 'a1', tool: 'u1', taskId: 'bg' });
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false }, 'Stop');
    h.tx('turn.durationRecorded', { durationMs: 1, pendingBackgroundAgentCount: 0 }, { uuid: 'd2' });
    h.run(600);
    expect(h.d.status).toMatchObject({ kind: 'idle', backgroundAgents: 0, quiescent: true });
  });

  it('K-42 a background agent survives /clear; its task-notification in g2 has causedBy pointing at the g1 agent', () => {
    const h = running();
    spawnTool(h, 'toolu_a', 'general-purpose', true);
    h.hook(
      'tool.post',
      { toolUseId: 'toolu_a', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg' },
      'PostToolUse',
    );
    h.hook('turn.stopped', { backgroundTasks: [{ id: 'bg', type: 'local_agent', status: 'running' }], stopHookActive: false }, 'Stop');
    h.run(600);
    h.hook('session.ended', { sessionId: SESSION_ID, reason: 'clear' }, 'SessionEnd');
    h.hook('session.started', { sessionId: 'g2', transcriptPath: '/g2.jsonl', source: 'clear' }, 'SessionStart', { claudeSessionId: 'g2' });
    expect(agent(h)?.state.value).toBe('running');
    expect(agent(h)?.gen).toBe('g1');
    h.hook(
      'prompt.submitted',
      {
        promptId: 'pz',
        text: '<task-notification><task-id>bg</task-id></task-notification>',
        taskNotification: { taskId: 'bg', status: 'completed' },
      },
      'UserPromptSubmit',
      { claudeSessionId: 'g2' },
    );
    const t2 = h.d.turns['t2' as never];
    expect(t2?.gen).toBe('g2');
    expect(t2?.causedBy?.agent).toBe('a1');
    expect(agent(h)?.state.value).toBe('stopped');
  });

  it('K-42b teammate payloads → kind teammate, warning once, nothing on the main thread', () => {
    const h = running();
    h.hook(
      'tool.pre',
      { toolUseId: 'toolu_t', toolName: 'Bash', input: {}, agent: { agentId: 'tm1', teammateName: 'alice' } },
      'PreToolUse',
    );
    h.hook(
      'tool.pre',
      { toolUseId: 'toolu_t2', toolName: 'Bash', input: {}, agent: { agentId: 'tm1', teammateName: 'alice' } },
      'PreToolUse',
    );
    h.hook('bgtask.status', { taskId: 'tm2', taskType: 'teammate', status: 'running' }, 'Stop');
    expect(agent(h)).toMatchObject({ kind: 'teammate', background: true });
    expect(agent(h, 'a2')?.kind).toBe('teammate');
    expect(h.ev('warning').filter((w) => w.payload.code === 'E_UNSUPPORTED_FEATURE')).toHaveLength(1);
    expect(h.d.tools['u1' as never]?.turn).toBeUndefined();
    expect(h.d.turns['t1' as never]?.tools).toEqual([]);
  });

  it('agent.fileMissing marks the record; expected for internal agents', () => {
    const h = running();
    h.hook('agent.started', { agent: { agentId: 'gh', agentType: '' } }, 'SubagentStart');
    h.tx('agent.fileMissing', { agentId: 'gh' });
    expect(agent(h)?.fileMissing).toBe(true);
    expect(h.diag('agent_file_missing')).toEqual([]);
  });
});
