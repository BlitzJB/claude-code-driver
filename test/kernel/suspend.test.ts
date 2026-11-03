// Kernel scenarios: idle suspend and transparent resume (ICR 0041). The real L3 + L2 + L1 against FakeClaude on a FakeClock.
import { describe, expect } from 'vitest';
import type { PermissionDecision } from '../../src/model/commands.js';
import type { FakeTurn } from '../../src/testing/fake-claude.js';
import { boot, codeOf, detailsOf, ended, kscenario, mark, roundTrip, send, since } from './support.js';

const WPS = ['09', '11', '12', '13'] as const;
const AGENT_ID = 'a1b2c3d4e5f6a7b8c';

/** Seqs of every published event: strictly increasing, no duplicates, across any number of suspend/resume cycles. */
function expectSeqsIncreasing(seqs: number[]): void {
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? 0);
}

async function launchBackground(t: FakeTurn): Promise<string> {
  const s = t.session;
  const r = await t.tool({
    name: 'Agent',
    input: { description: 'research', prompt: 'look around', subagent_type: 'general-purpose', run_in_background: true },
    permission: 'none',
    response: { status: 'async_launched', agentId: AGENT_ID, description: 'research', outputFile: `/tmp/${AGENT_ID}.output` },
  });
  s.hook('SubagentStart', { agent_id: AGENT_ID, agent_type: 'general-purpose' });
  await t.say('Started a background agent.');
  await t.stop({ backgroundTasks: [{ id: AGENT_ID, type: 'local_agent', status: 'running', description: 'research' }] });
  return r.toolUseId;
}

describe('idle suspend and resume (ICR 0041)', () => {
  kscenario(
    'K-60',
    [...WPS],
    'manual suspend stops Claude and keeps the session; the next prompt resumes the same conversation',
    async () => {
      const tk = await boot();
      const first = await roundTrip(tk, 'hello');
      const sid = tk.claude().sessionId;
      const panes = tk.world.sessions.length;
      const m = mark(tk);

      await tk.pump(tk.kernel.suspend());
      expect(tk.state().lifecycle).toBe('suspended');
      expect(tk.state().status).toMatchObject({ kind: 'suspended', claudeSessionId: sid });
      expect(since(tk, m, 'session.suspended')[0]?.payload).toEqual({ claudeSessionId: sid, reason: 'manual', interrupted: false });
      expect(tk.kernel.diagnostics.viewCommand()).toBe('');
      expect(Object.values(tk.state().channels).every((c) => c.health === 'off')).toBe(true);

      const k2 = await send(tk, 'again');
      const e2 = await ended(tk, k2);
      expect(e2.payload).toMatchObject({ outcome: 'completed' });
      expect(tk.world.sessions.length).toBe(panes + 1);
      const resumed = tk.claude();
      expect(resumed.resumed).toBe(true);
      expect(resumed.sessionId).toBe(sid);
      expect(since(tk, m, 'session.resumed')).toHaveLength(1);
      expect(tk.eventsOf('session.exited')).toHaveLength(0);
      // keys continue: the new turn never reuses a key of the old process; history is kept, not replayed into duplicates
      expect(k2).not.toBe(first.turnKey);
      expect(Object.keys(tk.state().turns)).toHaveLength(2);
      expectSeqsIncreasing(tk.events.map((e) => e.seq));
    },
  );

  kscenario('K-61', [...WPS], 'idle.suspendAfterMs: the session suspends only after being continuously suspendable that long', async () => {
    const tk = await boot({ spec: { idle: { suspendAfterMs: 60_000 } } });
    await roundTrip(tk, 'hi');
    await tk.advance(55_000);
    expect(tk.state().lifecycle).toBe('ready');
    await tk.advance(10_000);
    expect(tk.state().lifecycle).toBe('suspended');
    expect(tk.eventsOf('session.suspended').at(-1)?.payload.reason).toBe('idle');
  });

  kscenario('K-62', [...WPS], 'activity restarts the idle clock', async () => {
    const tk = await boot({ spec: { idle: { suspendAfterMs: 20_000 } } });
    await roundTrip(tk, 'one');
    await tk.advance(15_000);
    await roundTrip(tk, 'two');
    await tk.advance(15_000);
    expect(tk.state().lifecycle).toBe('ready');
    await tk.advance(10_000);
    expect(tk.state().lifecycle).toBe('suspended');
  });

  kscenario('K-63', [...WPS], 'an open permission request blocks every suspend; it is never denied or dropped by one', async () => {
    let release: ((d: PermissionDecision) => void) | undefined;
    const tk = await boot({
      spec: { idle: { suspendAfterMs: 5_000 } },
      permissionHandler: () =>
        new Promise<PermissionDecision>((r) => {
          release = r;
        }),
      claude: {
        onPrompt: async (t) => {
          await t.tool({ name: 'Bash', input: { command: 'ls' }, permission: 'ask' });
          await t.say('Listed.');
          await t.stop();
        },
      },
    });
    const k = await send(tk, 'ls');
    await tk.waitForEvent('permission.requested');
    const err = await tk.pump(tk.kernel.suspend()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(codeOf(err)).toBe('E_BUSY');
    expect(detailsOf(err)['blockers']).toContain('permission');
    await tk.advance(20_000);
    expect(tk.state().lifecycle).toBe('ready');
    expect(tk.eventsOf('permission.answered')).toHaveLength(0);
    release?.({ behavior: 'allow' });
    expect((await ended(tk, k)).payload).toMatchObject({ outcome: 'completed' });
    expect(tk.eventsOf('permission.answered')[0]?.payload).toMatchObject({ decision: 'allow' });
    await tk.advance(6_000);
    expect(tk.state().lifecycle).toBe('suspended');
  });

  kscenario('K-64', [...WPS], 'a running background agent blocks the idle suspend until its notification turn is done', async () => {
    let toolUseId = '';
    const tk = await boot({
      spec: { idle: { suspendAfterMs: 5_000 } },
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
    await roundTrip(tk, 'research');
    await tk.advance(20_000);
    expect(tk.state().lifecycle).toBe('ready');
    const s = tk.claude();
    s.hook('SubagentStop', {
      agent_id: AGENT_ID,
      agent_type: 'general-purpose',
      stop_hook_active: false,
      last_assistant_message: 'found it',
      background_tasks: [],
    });
    s.submit(
      `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "research" completed</summary>\n</task-notification>`,
    );
    await tk.waitForEvent('turn.ended', { pred: (e) => e.payload.outcome === 'completed', from: tk.events.length });
    await tk.advance(8_000);
    expect(tk.state().lifecycle).toBe('suspended');
  });

  kscenario(
    'K-65',
    [...WPS],
    'in-session scheduled tasks (session_crons) block a suspend: they live inside the Claude process',
    async () => {
      const tk = await boot({
        spec: { idle: { suspendAfterMs: 5_000 } },
        claude: {
          onPrompt: async (t) => {
            await t.say('Scheduled.');
            await t.stop({ sessionCrons: [{ id: 'c1', cron: '*/5 * * * *' }] });
          },
        },
      });
      await roundTrip(tk, 'check the build every five minutes');
      expect(tk.state().scheduledTasks).toBe(1);
      await tk.advance(20_000);
      expect(tk.state().lifecycle).toBe('ready');
      const err = await tk.pump(tk.kernel.suspend()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(detailsOf(err)['blockers']).toContain('scheduledTasks');
    },
  );

  kscenario('K-66', [...WPS], 'close() while suspended ends the session without starting Claude', async () => {
    const tk = await boot();
    await roundTrip(tk, 'hi');
    await tk.pump(tk.kernel.suspend());
    const panes = tk.world.sessions.length;
    const info = await tk.close();
    expect(info.reason).toBe('closed');
    expect(tk.world.sessions.length).toBe(panes);
    expect(tk.eventsOf('session.exited').at(-1)?.payload.reason).toBe('closed');
  });

  kscenario('K-67', [...WPS], 'a failed resume rejects the call, stays suspended, and the next call tries again', async () => {
    const tk = await boot();
    await roundTrip(tk, 'hi');
    await tk.pump(tk.kernel.suspend());
    tk.world.options.startup = { kind: 'exit', status: 1, lines: ['Error: something broke'] };
    const err = await send(tk, 'again').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect(tk.state().lifecycle).toBe('suspended');
    expect(tk.state().status.kind).toBe('suspended');
    expect(tk.eventsOf('session.exited')).toHaveLength(0);
    expect(tk.eventsOf('warning').some((w) => (w.payload.detail as { reason?: string } | undefined)?.reason === 'resumeFailed')).toBe(true);
    delete tk.world.options.startup;
    const k = await send(tk, 'again');
    expect((await ended(tk, k)).payload).toMatchObject({ outcome: 'completed' });
    expect(tk.state().lifecycle).toBe('ready');
  });

  kscenario('K-68', [...WPS], 'the resume keeps the current permission mode and resumes the latest Claude session id', async () => {
    const tk = await boot();
    await roundTrip(tk, 'hi');
    await tk.dispatch({ type: 'mode.set', mode: 'acceptEdits' });
    expect(tk.state().claude.permissionMode?.value).toBe('acceptEdits');
    await tk.dispatch({ type: 'slash.run', name: '/clear' });
    await tk.advance(3_000);
    const latest = tk.state().claude.sessionId;
    await tk.pump(tk.kernel.suspend());
    expect(tk.state().status).toMatchObject({ kind: 'suspended', claudeSessionId: latest });
    await roundTrip(tk, 'next');
    const argv = tk.claude().argv;
    expect(argv[argv.indexOf('--resume') + 1]).toBe(latest);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  kscenario(
    'K-69',
    [...WPS],
    'while suspended: no-op commands never wake Claude; concurrent prompts share one resume, in order',
    async () => {
      const tk = await boot();
      const first = await roundTrip(tk, 'hi');
      await tk.pump(tk.kernel.suspend());
      const panes = tk.world.sessions.length;
      await expect(tk.dispatch({ type: 'interrupt' })).resolves.toEqual({});
      await expect(tk.dispatch({ type: 'usage.wakeNow' })).resolves.toEqual({ ok: true });
      await expect(tk.dispatch({ type: 'turn.stop', turnKey: first.turnKey! })).resolves.toMatchObject({ effect: 'none' });
      expect(tk.world.sessions.length).toBe(panes);

      const a = tk.kernel.dispatch({ type: 'prompt.send', text: 'first', whenBusy: 'wait' });
      const b = tk.kernel.dispatch({ type: 'prompt.send', text: 'second', whenBusy: 'wait' });
      const [ra, rb] = await tk.pump(Promise.all([a, b]), 30_000);
      const [ea, eb] = await Promise.all([ended(tk, ra.turnKey), ended(tk, rb.turnKey)]);
      expect(ea.payload.outcome).toBe('completed');
      expect(eb.payload.outcome).toBe('completed');
      expect(ea.seq).toBeLessThan(eb.seq);
      expect(tk.world.sessions.length).toBe(panes + 1);
      expect(tk.eventsOf('session.resumed')).toHaveLength(1);
    },
  );

  kscenario('K-70', [...WPS], 'a prompt sent before the suspend commits cancels it; the turn runs normally', async () => {
    const tk = await boot();
    await roundTrip(tk, 'hi');
    const sus = tk.kernel.suspend().then(
      () => undefined,
      (e: unknown) => e,
    );
    const k = await send(tk, 'right now');
    const err = await tk.pump(sus);
    expect(codeOf(err)).toBe('E_BUSY');
    expect((await ended(tk, k)).payload).toMatchObject({ outcome: 'completed' });
    expect(tk.eventsOf('session.suspended')).toHaveLength(0);
    expect(tk.state().lifecycle).toBe('ready');
  });

  kscenario('K-72', [...WPS], 'the idle clock starts when the last command settles, even with no later step', async () => {
    const tk = await boot({ spec: { idle: { suspendAfterMs: 10_000 } } });
    await roundTrip(tk, 'hi');
    await tk.dispatch({ type: 'mode.set', mode: 'acceptEdits' });
    await tk.advance(12_000);
    expect(tk.state().lifecycle).toBe('suspended');
  });

  kscenario('K-71', [...WPS], 'repeated suspend/resume cycles keep keys unique and event seqs strictly increasing', async () => {
    const tk = await boot({ spec: { idle: { suspendAfterMs: 3_000 } } });
    const keys = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const e = await roundTrip(tk, `round ${String(i)}`);
      keys.add(String(e.turnKey));
      await tk.advance(4_000);
      expect(tk.state().lifecycle).toBe('suspended');
    }
    expect(keys.size).toBe(3);
    expect(tk.eventsOf('session.suspended')).toHaveLength(3);
    expect(tk.eventsOf('session.resumed')).toHaveLength(2);
    expectSeqsIncreasing(tk.events.map((e) => e.seq));
  });
});
