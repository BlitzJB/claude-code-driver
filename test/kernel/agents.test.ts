// Kernel scenarios: generations, subagents, background tasks (DESIGN.md §6.3 K-17, K-18, K-42, K-42b; §4.3, §4.5.3, §4.8).
import { describe, expect } from 'vitest';
import type { FakeClaudeSession, FakeTurn } from '../../src/testing/fake-claude.js';
import { replayRaw, readTrace } from '../../src/testing/replay.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { boot, ended, kscenario, mark, send, since } from './support.js';

const AGENT_ID = 'a1b2c3d4e5f6a7b8c';

/** Launch one background agent from the current turn (Agent tool, async_launched), then Stop with it pending. */
async function launchBackground(t: FakeTurn, agentId = AGENT_ID): Promise<string> {
  const s = t.session;
  const r = await t.tool({
    name: 'Agent',
    input: { description: 'research', prompt: 'look around', subagent_type: 'general-purpose', run_in_background: true },
    permission: 'none',
    response: { status: 'async_launched', agentId, description: 'research', outputFile: `/tmp/${agentId}.output` },
  });
  s.hook('SubagentStart', { agent_id: agentId, agent_type: 'general-purpose' });
  await t.say('Started a background agent.');
  await t.stop({ backgroundTasks: [{ id: agentId, type: 'local_agent', status: 'running', description: 'research' }] });
  return r.toolUseId;
}

/** The background agent finishes: SubagentStop, then Claude itself submits the task-notification turn. */
function finishBackground(s: FakeClaudeSession, toolUseId: string, agentId = AGENT_ID): void {
  s.hook('SubagentStop', {
    agent_id: agentId,
    agent_type: 'general-purpose',
    stop_hook_active: false,
    last_assistant_message: 'found it',
    background_tasks: [],
  });
  s.submit(
    `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "research" completed</summary>\n</task-notification>`,
  );
}

describe('agents and generations', () => {
  kscenario(
    'K-17',
    ['09'],
    '/clear: the HTTP UPS of g2 before the command-hook SessionStart → implicit gen confirmed; generationChanged',
    async () => {
      const tk = await boot({ claude: { clearSessionStartDelayMs: 2000 } });
      const g1 = tk.state().claude.currentGen;
      const oldSid = tk.claude().sessionId;
      const m = mark(tk);
      // A human types /clear and then a prompt; the UPS of the new session arrives 2 s before its SessionStart.
      const c = tk.claude();
      c.input('/clear');
      c.input('\r');
      await tk.advance(100);
      c.input('hello');
      c.input('\r');
      await tk.advance(3000);
      const changes = since(tk, m, 'session.generationChanged');
      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(changes.at(-1)?.payload).toMatchObject({ from: oldSid, to: c.sessionId });
      expect(changes.at(-1)?.payload.gen).not.toBe(g1);
      const gens = Object.values(tk.state().generations);
      expect(gens.find((g) => g.sessionId === c.sessionId)?.status).toBe('active');
      expect(gens.find((g) => g.sessionId === oldSid)?.status).toBe('ended');
      // The external turn belongs to the new generation.
      const ext = since(tk, m, 'turn.queued').at(-1);
      expect(ext?.gen).toBe(tk.state().claude.currentGen);
    },
  );

  kscenario(
    'K-18',
    ['09'],
    'background agent: task-notification turn with foreign prompt_id SubagentStop; quiescence only at the end',
    async () => {
      let toolUseId = '';
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            if (t.text.startsWith('<task-notification>')) {
              await t.say('The agent found it.');
              await t.stop();
              return;
            }
            toolUseId = await launchBackground(t);
          },
        },
      });
      const k = await send(tk, 'research in background');
      expect((await ended(tk, k)).payload.outcome).toBe('completed');
      await tk.advance(500);
      const st = tk.state().status;
      expect(st.kind).toBe('idle');
      expect(st.kind === 'idle' ? [st.quiescent, st.backgroundAgents] : []).toEqual([false, 1]);
      const m = mark(tk);
      finishBackground(tk.claude(), toolUseId);
      const ext = await tk.waitForEvent('turn.queued', { pred: (q) => q.payload.origin === 'task_notification', from: m.ev });
      expect((await ended(tk, ext.turnKey!)).payload.outcome).toBe('completed');
      await tk.advance(6000);
      const end = tk.state().status;
      expect(end.kind === 'idle' ? [end.quiescent, end.backgroundAgents] : end.kind).toEqual([true, 0]);
    },
  );

  kscenario('K-18', ['11', '12'], 'close({waitForBackgroundMs}) waits for the background agent', async () => {
    let toolUseId = '';
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          if (t.text.startsWith('<task-notification>')) {
            await t.stop();
            return;
          }
          toolUseId = await launchBackground(t);
        },
      },
    });
    await ended(tk, await send(tk, 'bg'));
    const closing = tk.kernel.close({ mode: 'graceful', waitForBackgroundMs: 30_000 });
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await tk.advance(5000);
    expect(closed).toBe(false);
    expect(tk.claude().exited).toBe(false);
    finishBackground(tk.claude(), toolUseId);
    const info = await tk.pump(closing, 40_000);
    expect(info.reason).toBe('closed');
    expect(tk.claude().hookCalls.map((h) => h.event)).toContain('SubagentStop');
  });

  kscenario('K-18', ['09', '14'], 'hookprobe replay: async agents, task-notification turns, internal agent after Stop hidden', async () => {
    const path = join(import.meta.dirname, '..', '..', 'fixtures', 'traces', 'bg-agents-task-notification.ccd.jsonl');
    expect(existsSync(path)).toBe(true);
    const r = await replayRaw(readTrace(path));
    const notif = r.events.filter((e) => e.type === 'turn.queued' && e.payload.origin === 'task_notification');
    expect(notif.length).toBeGreaterThanOrEqual(1);
    // Internal agents (agent_type '') are published flagged `internal:true` (§2.5; the facade hides them, map-events.ts),
    // never as background agents and never linked to a spawn tool, so they never count toward quiescence.
    const internal = r.events.flatMap((e) => (e.type === 'subagent.started' && e.payload.internal ? [e.payload] : []));
    expect(internal.length).toBeGreaterThanOrEqual(1);
    expect(internal.every((p) => !p.background && p.spawnToolKey === undefined)).toBe(true);
    const st = r.state.status;
    expect(st.kind === 'idle' ? st.quiescent : false).toBe(true);
  });

  kscenario(
    'K-42',
    ['09'],
    'agent launched in g1, /clear, its task-notification UPS in g2 → running until then, external turn causedBy the g1 agent',
    async () => {
      let toolUseId = '';
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            if (t.text.startsWith('<task-notification>')) {
              await t.stop();
              return;
            }
            toolUseId = await launchBackground(t);
          },
        },
      });
      await ended(tk, await send(tk, 'bg'));
      const g1 = tk.state().claude.currentGen;
      await tk.dispatch({ type: 'slash.run', name: '/clear' });
      expect(tk.state().claude.currentGen).not.toBe(g1);
      const agent = Object.values(tk.state().agents).find((a) => a.agentId === AGENT_ID);
      expect(agent?.state.value).toBe('running');
      expect(agent?.gen).toBe(g1);
      const m = mark(tk);
      finishBackground(tk.claude(), toolUseId);
      const ext = await tk.waitForEvent('turn.queued', { pred: (q) => q.payload.origin === 'task_notification', from: m.ev });
      expect(ext.gen).toBe(tk.state().claude.currentGen);
      const rec = tk.state().turns[ext.turnKey!];
      expect(rec?.causedBy?.agent).toBe(agent?.key);
      await ended(tk, ext.turnKey!);
      const st = tk.state().status;
      expect(st.kind === 'idle' ? st.backgroundAgents : -1).toBe(0);
    },
  );

  kscenario('K-42b', ['09'], "teammate payload → kind 'teammate', warning once, nothing on the main thread", async () => {
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          for (let i = 0; i < 2; i++)
            t.session.hook('SubagentStart', { agent_id: `tm${i}aaaaaaaaaaaaaa`, agent_type: 'helper', teammate_name: `mate-${i}` });
          await t.say('ok');
          await t.stop({ backgroundTasks: [{ id: 'tm0aaaaaaaaaaaaaa', type: 'teammate', status: 'running' }] });
        },
      },
    });
    const k = await send(tk, 'team');
    await ended(tk, k);
    const mates = Object.values(tk.state().agents).filter((a) => a.kind === 'teammate');
    expect(mates).toHaveLength(2);
    expect(tk.eventsOf('warning').filter((w) => JSON.stringify(w.payload).toLowerCase().includes('teammate'))).toHaveLength(1);
    expect(tk.eventsOf('subagent.started').filter((s) => s.payload.teammate)).toEqual(
      tk.eventsOf('subagent.started').filter((s) => s.payload.teammate && s.turnKey === undefined),
    );
    expect(tk.state().turns[k]?.tools).toEqual([]);
  });
});
