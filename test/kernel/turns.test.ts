// Kernel scenarios: turns, model calls, messages, modes (DESIGN.md §6.3 K-13, K-16, K-26, K-31, K-33, K-41, K-45, K-46;
// §4.4, §4.5.7, §4.5.10, §4.7).
import { describe, expect } from 'vitest';
import { doneLine, INTERRUPTED_BANNER, retryLine, stalledLine } from '../../src/testing/screens.js';
import { boot, codeOf, ended, keys, kscenario, mark, send, since } from './support.js';

describe('turns', () => {
  kscenario(
    'K-13',
    ['09'],
    'Esc during a model call → [Request interrupted by user], no Stop, no turn_duration → interrupted',
    async () => {
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            if (!(await t.sleep(20_000))) return;
            await t.stop();
          },
        },
      });
      const k = await send(tk, 'think hard');
      await tk.waitForEvent('turn.accepted', { pred: (a) => a.turnKey === k });
      await tk.advance(1000);
      const m = mark(tk);
      const r = await tk.dispatch({ type: 'interrupt' });
      expect(r).toMatchObject({ turnKey: k });
      const e = await ended(tk, k);
      expect(e.payload.outcome).toBe('interrupted');
      expect(keys(tk, m.inv)).toEqual(['Escape']);
      expect(tk.claude().hookCalls.map((h) => h.event)).not.toContain('Stop');
      expect(e.provenance.sources).toContain('transcript');
    },
  );

  kscenario('K-13', ['07', '09'], 'a screen interrupt banner alone is provisional and is retracted by a later Stop', async () => {
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          if (!(await t.sleep(1000))) return;
          // A real banner frame: the spinner and the busy footer are gone (a banner under a spinner is tool output, ICR 0030).
          t.session.history.push(INTERRUPTED_BANNER);
          t.session.busy = false;
          t.session.render();
          if (!(await t.sleep(1500))) return;
          t.session.busy = true;
          await t.say('still here');
          await t.stop();
        },
      },
    });
    const k = await send(tk, 'go');
    const e = await ended(tk, k);
    expect(e.payload.outcome).toBe('completed');
    expect(tk.eventsOf('turn.ended').filter((x) => x.turnKey === k)).toHaveLength(1);
    // Every screen claim asserted for the banner was retracted or expired; none was confirmed into an interrupt.
    const claims = tk.events.flatMap((ev) =>
      ev.type === 'claim.asserted' || ev.type === 'claim.retracted' || ev.type === 'claim.expired' || ev.type === 'claim.confirmed'
        ? [{ type: ev.type, claim: ev.payload.claim }]
        : [],
    );
    // Only the banner's claims: idle/done claims asserted after the Stop are still live (the screen still shows them).
    const asserted = claims.filter((c) => c.type === 'claim.asserted' && /interrupt/i.test(c.claim));
    expect(asserted.length).toBeGreaterThan(0);
    expect(
      asserted.every((a) => claims.some((c) => (c.type === 'claim.retracted' || c.type === 'claim.expired') && c.claim === a.claim)),
    ).toBe(true);
    expect(claims.filter((c) => c.type === 'claim.confirmed' && /interrupt/i.test(c.claim))).toEqual([]);
  });

  kscenario(
    'K-16',
    ['07', '09'],
    'retry banner attempt 4/10 → modelRequest.retrying; stall banner → stalled; network off → provisional only',
    async () => {
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            if (!(await t.sleep(500))) return;
            t.status(retryLine({ attempt: 4, max: 10, inS: 5 }));
            if (!(await t.sleep(3000))) return;
            t.status(stalledLine({ inS: 5 }));
            if (!(await t.sleep(3000))) return;
            t.status(undefined);
            await t.say('ok');
            await t.stop();
          },
        },
      });
      const k = await send(tk, 'go');
      const retry = await tk.waitForEvent('status.changed', {
        pred: (s) => s.payload.to.kind === 'modelRequest' && s.payload.to.phase === 'retrying',
      });
      const to = retry.payload.to;
      expect(to.kind === 'modelRequest' ? [to.attempt, to.maxAttempts] : []).toEqual([4, 10]);
      expect(to.kind === 'modelRequest' ? to.provenance.confirmed : true).toBe(false);
      await tk.waitForEvent('status.changed', { pred: (s) => s.payload.to.kind === 'modelRequest' && s.payload.to.phase === 'stalled' });
      expect((await ended(tk, k)).payload.outcome).toBe('completed');
      expect(tk.eventsOf('modelCall.retrying').every((r) => !r.provenance.confirmed)).toBe(true);
    },
  );

  kscenario('K-16', ['07', '09'], 'a stale done line from the previous turn does not end the next one', async () => {
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          if (t.text === 'second') {
            t.status(doneLine({ seconds: 3 }));
            if (!(await t.sleep(4000))) return;
          }
          await t.say('ok');
          await t.stop();
        },
      },
    });
    expect((await ended(tk, await send(tk, 'first'))).payload.outcome).toBe('completed');
    const k = await send(tk, 'second');
    await tk.waitForEvent('turn.accepted', { pred: (a) => a.turnKey === k });
    await tk.advance(3000);
    expect(tk.eventsOf('turn.ended').some((e) => e.turnKey === k)).toBe(false);
    expect((await ended(tk, k)).payload.endedBy).toBe('stop');
  });

  kscenario(
    'K-26',
    ['09'],
    'final MessageDisplay after Stop within 500 ms → textAppended; finalText from last_assistant_message',
    async () => {
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            await t.say('The answer is 42.', { display: false });
            const promptId = t.promptId;
            await t.stop({ lastMessage: 'The answer is 42.' });
            await t.session.ports.clock.sleep(200);
            t.session.hook('MessageDisplay', {
              prompt_id: promptId,
              turn_id: t.session.newId(),
              message_id: t.session.newId(),
              index: 0,
              final: true,
              delta: 'The answer is 42.',
            });
          },
        },
      });
      const k = await send(tk, 'answer?');
      const e = await ended(tk, k);
      expect(e.payload.finalText).toBe('The answer is 42.');
      const appended = await tk.waitForEvent('turn.textAppended', { pred: (x) => x.turnKey === k, maxMs: 1000 });
      expect(appended).toBeDefined();
    },
  );

  kscenario('K-31', ['09'], 'user Stop hook blocks twice → the turn ends only on stop_hook_active:false (no dedup)', async () => {
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          await t.say('first try');
          await t.stop({ stopHookActive: true });
          if (!(await t.sleep(500))) return;
          await t.say('second try');
          await t.stop({ stopHookActive: true });
          if (!(await t.sleep(500))) return;
          await t.say('final');
          await t.stop({ stopHookActive: false });
        },
      },
    });
    const k = await send(tk, 'go');
    await tk.until(() => tk.claude().hookCalls.filter((h) => h.event === 'Stop').length === 2, 5000, 'two blocked Stops');
    await tk.advance(200);
    expect(tk.eventsOf('turn.ended').some((e) => e.turnKey === k)).toBe(false);
    const e = await ended(tk, k);
    expect(e.payload.outcome).toBe('completed');
    expect(e.payload.finalText).toBe('final');
  });

  kscenario('K-33', ['09', '13'], "setMode('plan') with footer verification; bypassPermissions refused", async () => {
    const tk = await boot();
    const m = mark(tk);
    await tk.dispatch({ type: 'mode.set', mode: 'plan' });
    expect(keys(tk, m.inv).every((k) => k === 'BTab')).toBe(true);
    expect(keys(tk, m.inv).length).toBeGreaterThanOrEqual(1);
    expect(tk.claude().mode).toBe('plan');
    expect(since(tk, m, 'session.modeChanged').at(-1)?.payload.mode).toBe('plan');
    let err: unknown;
    try {
      await tk.dispatch({ type: 'mode.set', mode: 'bypassPermissions' });
    } catch (e) {
      err = e;
    }
    expect(codeOf(err)).toBe('E_MODE_FORBIDDEN');
    expect(tk.claude().mode).toBe('plan');
  });

  kscenario(
    'K-41',
    ['06', '09'],
    'refusal: deltas, then model.refused + model_refusal_fallback → assistant.retracted; finalText without the retracted text',
    async () => {
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            const s = t.session;
            await t.say('Sure, here is how to', { finalFlag: false });
            const retracted = s.entries.at(-1)?.json['uuid'] as string;
            s.entry({
              type: 'user',
              isMeta: true,
              refusedMessageId: 'msg_refused_1',
              message: { role: 'user', content: 'Your response above was stopped by a safety classifier' },
              turnCompanion: true,
            });
            s.entry({
              type: 'system',
              subtype: 'model_refusal_fallback',
              retractedMessageUuids: [retracted],
              originalModel: s.model,
              fallbackModel: 'claude-sonnet-5-5',
              trigger: 'refusal',
            });
            s.model = 'claude-sonnet-5-5';
            await t.say('I can help with a safer version.');
            await t.stop({ lastMessage: 'I can help with a safer version.' });
          },
        },
      });
      const k = await send(tk, 'risky');
      const e = await ended(tk, k);
      expect(tk.eventsOf('assistant.retracted')[0]?.payload.reason).toBe('refusalFallback');
      expect(e.payload.finalText).toBe('I can help with a safer version.');
      expect(e.payload.finalText).not.toContain('Sure, here is how to');
      expect(tk.eventsOf('session.modelChanged').at(-1)?.payload).toMatchObject({ model: 'claude-sonnet-5-5', source: 'refusalFallback' });
      expect(tk.eventsOf('modelCall.ended').some((c) => c.payload.outcome === 'refused')).toBe(true);
    },
  );

  kscenario(
    'K-45',
    ['09'],
    'final MessageDisplay lost, then tool.pre → message implicit final, status runningTools (not writing)',
    async () => {
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            await t.say('Let me check.', { finalFlag: false });
            await t.tool({ name: 'Bash', input: { command: 'sleep 3', description: 'Wait' }, permission: 'none', runMs: 3000 });
            await t.say('done');
            await t.stop();
          },
        },
      });
      const k = await send(tk, 'check');
      await tk.waitForEvent('tool.started');
      await tk.advance(500);
      expect(tk.state().status.kind).toBe('runningTools');
      const msgs = Object.values(tk.state().messages).filter((mm) => mm.turn === k);
      expect(msgs[0]?.final).toBe(true);
      expect(msgs[0]?.finalBy).toBe('implicit');
      expect((await ended(tk, k)).payload.outcome).toBe('completed');
    },
  );

  kscenario('K-46', ['09'], 'turn fails E_TURN_API_ERROR → status idle{lastTurn.error}', async () => {
    const tk = await boot({
      claude: {
        onPrompt: (t) => t.fail({ error: 'server_error', message: 'API Error: 500 {"type":"error","error":{"type":"api_error"}}' }),
      },
    });
    const k = await send(tk, 'go');
    const e = await ended(tk, k);
    expect(e.payload.outcome).toBe('failed');
    expect(e.payload.error?.code).toBe('E_TURN_API_ERROR');
    await tk.advance(500);
    const st = tk.state().status;
    expect(st.kind).toBe('idle');
    expect(st.kind === 'idle' ? st.lastTurn?.error?.code : undefined).toBe('E_TURN_API_ERROR');
  });

  kscenario('K-46', ['09'], 'a queued send() drains immediately after the failed turn', async () => {
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          if (t.text === 'first') {
            if (!(await t.sleep(1000))) return;
            await t.fail({ error: 'server_error', message: 'API Error: 500' });
            return;
          }
          await t.say('ok');
          await t.stop();
        },
      },
    });
    const first = await send(tk, 'first');
    const second = await send(tk, 'second');
    const f = await ended(tk, first);
    const failedAt = tk.fakes.clock.now();
    await tk.waitForEvent('turn.accepted', { pred: (a) => a.turnKey === second });
    expect(tk.fakes.clock.now() - failedAt).toBeLessThan(1500);
    expect(f.payload.error?.code).toBe('E_TURN_API_ERROR');
    expect((await ended(tk, second)).payload.outcome).toBe('completed');
  });
});
