// Kernel scenarios: channels, clock, lifecycle (DESIGN.md §6.3 K-20, K-21, K-22, K-23, K-24, K-27, K-29, K-30, K-40, K-52;
// §3.8, §4.6, §4.10, §4.12).
import { describe, expect } from 'vitest';
import type { EventSeq } from '../../src/model/ids.js';
import type { PermissionDecision } from '../../src/model/commands.js';
import { createFakePorts } from '../../src/testing/fake-ports.js';
import { FakeClaude, projectSlug } from '../../src/testing/fake-claude.js';
import { createTestKernel } from '../../src/testing/test-kernel.js';
import { modalFrame } from '../../src/testing/screens.js';
import { boot, ended, kscenario, mark, roundTrip, send, since } from './support.js';

describe('channels, clock and lifecycle', () => {
  kscenario('K-20', ['09'], 'hook ECONNREFUSED attachments → channel hooks degraded, transcript primary', async () => {
    const tk = await boot();
    tk.claude().httpHooksDown = true;
    const m = mark(tk);
    const e = await roundTrip(tk, 'Reply with OK');
    expect(e.payload.outcome).toBe('completed');
    const h = since(tk, m, 'channel.health').find((x) => x.payload.channel === 'hooks');
    expect(h?.payload.health).toBe('degraded');
    expect(e.provenance.sources).toContain('transcript');
    expect(e.provenance.sources).not.toContain('hook');
  });

  kscenario(
    'K-21',
    ['11'],
    'jumpWall(10 min) with no mono advance → hostResumed, no false stalled, wall deadline fires at once',
    async () => {
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            if (t.text === 'continue') {
              await t.stop();
              return;
            }
            const now = t.session.ports.clock.wallNow();
            await t.fail({
              error: 'rate_limit',
              message: "You've hit your 5-hour limit · resets 3pm",
              resetsAtEpochS: Math.ceil((now + 5 * 60_000) / 1000),
              rateLimitType: 'five_hour',
            });
          },
        },
      });
      await ended(tk, await send(tk, 'work'));
      await tk.waitForEvent('usage.wakeScheduled');
      const m = mark(tk);
      tk.fakes.clock.jumpWall(10 * 60_000);
      await tk.advance(31_000, 500);
      expect(since(tk, m, 'status.changed').some((s) => s.payload.to.kind === 'modelRequest' && s.payload.to.phase === 'stalled')).toBe(
        false,
      );
      expect(since(tk, m, 'turn.queued').some((q) => q.payload.origin === 'auto_continue')).toBe(true);
    },
  );

  kscenario(
    'K-22',
    ['05', '12'],
    'owner death → owner-watch kills Claude + server → registry archived; start({resume}) replays with replay:true',
    async () => {
      const fakes = createFakePorts();
      const world = new FakeClaude(fakes);
      const first = await createTestKernel({ fakes, world });
      const turn = await roundTrip(first, 'Reply with OK');
      expect(turn.payload.outcome).toBe('completed');
      const claudeSid = first.claude().sessionId;
      const claudePid = first.claude().pid;
      fakes.process.exit(fakes.ownerPid);
      await first.advance(3000);
      expect(fakes.ownerWatch.reports.at(-1)).toMatchObject({ kind: 'owner-gone', serverKilled: true });
      expect(fakes.process.isAlive(claudePid)).toBe(false);
      expect([...fakes.exitLogs.values()].flat().some((l) => l.startsWith('watch=owner-gone'))).toBe(true);
      // A new owner (the restarted host) resumes the same Claude session.
      fakes.process.addProcess({ pid: fakes.ownerPid, command: 'node /fake/host/app.js' });
      const second = await createTestKernel({ fakes, world, spec: { resume: claudeSid } });
      expect(second.eventsOf('session.ready')[0]?.payload.resumed).toBe(true);
      const replayed = second.events.filter((e) => e.type === 'turn.ended');
      expect(replayed.length).toBeGreaterThanOrEqual(1);
      expect(replayed.every((e) => e.replayed === true)).toBe(true);
      // A new live turn after the replay is not marked replayed and nothing old is duplicated live.
      const live = await roundTrip(second, 'again');
      expect(live.replayed).not.toBe(true);
      expect(second.events.filter((e) => e.type === 'turn.ended' && e.replayed !== true)).toHaveLength(1);
    },
  );

  kscenario('K-23', ['11'], 'a listener that throws → warning E_LISTENER_THREW, the loop continues', async () => {
    const tk = await boot();
    tk.kernel.subscribe(() => {
      throw new Error('listener bug');
    });
    const e = await roundTrip(tk, 'Reply with OK');
    expect(e.payload.outcome).toBe('completed');
    expect(tk.eventsOf('warning').some((w) => w.payload.code === 'E_LISTENER_THREW')).toBe(true);
  });

  kscenario('K-24', ['11'], 'a consumer that falls behind the retention ring → first batch carries gap, memory bounded', async () => {
    const tk = await boot({ spec: { debug: { retainEvents: 16 } } });
    for (let i = 0; i < 4; i++) await roundTrip(tk, `turn ${i}`);
    const batches: { gap?: { from: EventSeq; to: EventSeq }; n: number }[] = [];
    tk.kernel.subscribe(
      (b) => {
        batches.push(b.gap === undefined ? { n: b.events.length } : { gap: b.gap, n: b.events.length });
      },
      { fromSeq: 1 as EventSeq },
    );
    await tk.advance(100);
    expect(batches[0]?.gap?.from).toBe(1);
    expect(batches[0]?.n ?? 0).toBeLessThanOrEqual(16);
  });

  kscenario(
    'K-27',
    ['02', '09'],
    'tombstone rewrite (size shrink) → full rescan, uuid dedup, state consistent, no duplicate observations',
    async () => {
      const tk = await boot();
      const k = await send(tk, 'Reply with OK');
      await ended(tk, k);
      const before = tk.events.length;
      const c = tk.claude();
      const path = `${tk.fakes.home}/.claude/projects/${projectSlug(c.cwd)}/${c.sessionId}.jsonl`;
      // Claude's tombstone pass removes one entry (the stop_hook_summary) and rewrites the file shorter than our offset.
      tk.fakes.tailFs.removeLineContaining(path, '"stop_hook_summary"');
      await tk.advance(2000);
      const after = tk.events.slice(before);
      expect(after.filter((e) => e.type.startsWith('turn.'))).toEqual([]);
      expect(after.filter((e) => e.type === 'tool.started' || e.type === 'assistant.block')).toEqual([]);
      expect(tk.state().turns[k]?.state.value).toBe('completed');
      expect(Object.keys(tk.state().turns)).toHaveLength(1);
      // Still live after the rescan.
      expect((await roundTrip(tk, 'again')).payload.outcome).toBe('completed');
    },
  );

  kscenario('K-29', ['12'], 'graceful close order: /exit → pane dead → owner-watch stop → hooks stop → kill-server → cleanup', async () => {
    const tk = await boot();
    const m = mark(tk);
    // D-27 order across the components: owner-watch stop → hooks stop → kill-server → cleanup
    const order: string[] = [];
    const watch = tk.fakes.ownerWatch.started.at(-1);
    if (watch !== undefined) {
      let stopped = watch.stopped;
      Object.defineProperty(watch, 'stopped', {
        get: () => stopped,
        set: (v: boolean) => {
          if (v && !stopped) order.push(`ownerWatch.stop claudeAlive=${String(tk.fakes.process.isAlive(tk.claude().pid))}`);
          stopped = v;
        },
      });
    }
    const hooks = tk.fakes.hooks.instances.at(-1);
    if (hooks !== undefined) {
      const close = hooks.close.bind(hooks);
      hooks.close = (body) => {
        order.push('hooks.close');
        return close(body);
      };
    }
    const server = tk.fakes.tmux.lastServer();
    if (server !== undefined) {
      const kill = server.kill.bind(server);
      server.kill = () => {
        order.push('tmux.kill');
        return kill();
      };
    }
    const removeDir = tk.fakes.runtimeDir.removeSessionDir.bind(tk.fakes.runtimeDir);
    tk.fakes.runtimeDir.removeSessionDir = (d) => {
      order.push('removeSessionDir');
      return removeDir(d);
    };
    const info = await tk.close({ mode: 'graceful' });
    expect(info.reason).toBe('closed');
    expect(order).toEqual(['ownerWatch.stop claudeAlive=false', 'hooks.close', 'tmux.kill', 'removeSessionDir']);
    const c = tk.claude();
    expect(c.hookCalls.filter((h) => h.event === 'SessionEnd').at(-1)?.payload).toMatchObject({ reason: 'prompt_input_exit' });
    expect(c.exited).toBe(true);
    expect(tk.fakes.ownerWatch.started.at(-1)?.stopped).toBe(true);
    expect(tk.fakes.hooks.instances.at(-1)?.state).toBe('closed');
    const ops = tk.fakes.tmux.invocations.slice(m.inv).map((i) => i.op);
    expect(ops.indexOf('kill')).toBeGreaterThan(-1);
    expect(ops.lastIndexOf('sendKey')).toBeLessThan(ops.indexOf('kill'));
    expect(tk.fakes.runtimeDir.removed.length).toBeGreaterThanOrEqual(1);
    expect(tk.fakes.process.killCalls.filter((k) => k.pid === c.pid)).toEqual([]);
    expect(await tk.kernel.close()).toEqual(info);
  });

  kscenario('K-29', ['12'], 'a dialog after /exit → SIGTERM path (at once, not after the grace period)', async () => {
    const tk = await boot({ claude: { exitShowsDialog: true } });
    const c = tk.claude();
    const t0 = tk.fakes.clock.now();
    const sigAt: { sig: string; at: number }[] = [];
    const kill = tk.fakes.process.kill.bind(tk.fakes.process);
    tk.fakes.process.kill = (p, sig) => {
      if (p === c.pid) sigAt.push({ sig, at: tk.fakes.clock.now() - t0 });
      return kill(p, sig);
    };
    const info = await tk.close({ mode: 'graceful' }, 40_000);
    expect(sigAt[0]?.sig).toBe('SIGTERM');
    // P-LIFE-46: the fallback SIGTERM follows the dialog, long before the 12 000 ms grace would escalate
    expect(sigAt[0]?.at ?? Infinity).toBeLessThan(9_000);
    expect(sigAt.map((s) => s.sig)).not.toContain('SIGKILL');
    expect(c.exited).toBe(true);
    expect(info.reason).toBe('closed');
  });

  kscenario('K-29', ['09', '12'], 'close while a permission is held → deny on close, then exit', async () => {
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          await t.tool({ name: 'Bash', input: { command: 'touch x', description: 'x' } });
          await t.stop();
        },
      },
      permissionHandler: () => new Promise<PermissionDecision>(() => undefined),
    });
    await send(tk, 'touch x');
    await tk.waitForEvent('permission.requested');
    await tk.close({ mode: 'graceful' }, 40_000);
    const body = tk.fakes.hooks.instances.at(-1)?.responses.at(-1)?.body as
      { hookSpecificOutput?: { decision?: { behavior?: string } } } | undefined;
    expect(body?.hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(tk.eventsOf('permission.answered').at(-1)?.payload.by).toBe('close');
  });

  kscenario('K-30', ['11'], 'two kernels in one process, no cross-talk', async () => {
    const a = await boot({ ports: { idSeed: 'one' } });
    const b = await boot({ ports: { idSeed: 'two' } });
    expect(a.kernel.sessionKey).not.toBe(b.kernel.sessionKey);
    const [ea, eb] = await Promise.all([roundTrip(a, 'alpha'), roundTrip(b, 'beta')]);
    expect(ea.payload.outcome).toBe('completed');
    expect(eb.payload.outcome).toBe('completed');
    expect(a.events.every((e) => e.sessionKey === a.kernel.sessionKey)).toBe(true);
    expect(b.events.every((e) => e.sessionKey === b.kernel.sessionKey)).toBe(true);
    expect(
      a
        .claude()
        .prompts.filter((p) => !p.blocked)
        .map((p) => p.text),
    ).toEqual(['alpha']);
    expect(
      b
        .claude()
        .prompts.filter((p) => !p.blocked)
        .map((p) => p.text),
    ).toEqual(['beta']);
    await a.close();
    expect(b.state().lifecycle).toBe('ready');
  });

  kscenario(
    'K-40',
    ['09'],
    'Notification{elicitation_dialog} during a turn → awaitingInput, queue blocked; elicitation_complete → cleared',
    async () => {
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            if (t.text !== 'first') {
              await t.stop();
              return;
            }
            t.session.hook('Notification', { notification_type: 'elicitation_dialog', message: 'Server needs your API region' });
            if (!(await t.sleep(3000))) return;
            t.session.hook('Notification', { notification_type: 'elicitation_complete', message: 'done' });
            await t.say('ok');
            await t.stop();
          },
        },
      });
      const first = await send(tk, 'first');
      const req = await tk.waitForEvent('input.requested');
      expect(req.payload.kind).toBe('elicitation');
      expect(tk.state().status.kind).toBe('awaitingInput');
      const m = mark(tk);
      const second = await send(tk, 'second');
      await tk.advance(1000);
      expect(since(tk, m, 'turn.submitting')).toEqual([]);
      await tk.waitForEvent('input.cleared');
      await ended(tk, first);
      expect((await ended(tk, second)).payload.outcome).toBe('completed');
    },
  );

  kscenario('K-40', ['07', '09'], 'a screen-only unknown modal for > 2 s during a turn → awaitingInput{unknownModal}', async () => {
    // §4.6 PendingInput: the modal counts while a turn is active (a turn that opened it and waits on the human).
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          const s = t.session;
          s.dialog = {
            kind: 'modal',
            lines: () => modalFrame({ title: 'Something new', body: ['❯ Option A', '  Option B'] }),
            onKey: () => undefined,
          };
          s.render();
          if (!(await t.sleep(4000))) return;
          s.dialog = undefined;
          s.render();
          await t.say('ok');
          await t.stop();
        },
      },
    });
    const k = await send(tk, 'go');
    await tk.waitForEvent('turn.accepted', { pred: (a) => a.turnKey === k });
    await tk.advance(2500, 50);
    const st = tk.state().status;
    expect(st.kind).toBe('awaitingInput');
    expect(st.kind === 'awaitingInput' ? st.inputKind : undefined).toBe('unknownModal');
    expect((await ended(tk, k)).payload.outcome).toBe('completed');
    expect(tk.eventsOf('input.cleared').length).toBeGreaterThanOrEqual(1);
  });

  kscenario(
    'K-52',
    ['03', '11'],
    'host main thread blocked 6 s → host.loopLag warning; permission answers delayed but delivered',
    async () => {
      let answer: (d: PermissionDecision) => void = () => undefined;
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            await t.tool({ name: 'Bash', input: { command: 'touch x', description: 'x' } });
            await t.say('ok');
            await t.stop();
          },
        },
        permissionHandler: () =>
          new Promise<PermissionDecision>((r) => {
            answer = r;
          }),
      });
      const k = await send(tk, 'touch x');
      await tk.waitForEvent('permission.requested');
      const until = Date.now() + 6000;
      while (Date.now() < until) {
        // a real busy loop: the host's event loop is blocked (A-7 measures it with monitorEventLoopDelay)
      }
      answer({ behavior: 'allow' });
      await new Promise((r) => setTimeout(r, 5500));
      await tk.advance(1000);
      expect(tk.eventsOf('warning').some((w) => w.payload.code === 'E_HOST_LOOP_LAG')).toBe(true);
      expect((await ended(tk, k)).payload.outcome).toBe('completed');
    },
  );
});
