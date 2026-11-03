// Kernel scenarios: usage limits and auth (DESIGN.md §6.3 K-19, K-19b, K-28, K-51; §3.9).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FakeTurn } from '../../src/testing/fake-claude.js';
import { usageLimitLine } from '../../src/testing/screens.js';
import type { TestKernel } from '../../src/testing/test-kernel.js';
import { boot, ended, expectedJitter, kscenario, mark, send, since } from './support.js';

/** A turn that hits the 5-hour limit with a known reset `inMs` from now (StopFailure rate_limit + transcript resetsAt). */
function limitTurn(inMs: number | undefined) {
  return async (t: FakeTurn): Promise<void> => {
    if (t.text === 'continue') {
      await t.say('Resumed.');
      await t.stop();
      return;
    }
    const now = t.session.ports.clock.wallNow();
    const resetsAtEpochS = inMs === undefined ? undefined : Math.ceil((now + inMs) / 1000);
    // The banner carries a reset time of its own; with no reset anywhere (inMs undefined) the screen must not supply one.
    if (inMs !== undefined) t.session.history.push(usageLimitLine({ resetText: '3pm' }));
    await t.fail({
      error: 'rate_limit',
      message: inMs === undefined ? "You've hit your 5-hour limit" : "You've hit your 5-hour limit · resets 3pm",
      ...(resetsAtEpochS === undefined ? {} : { resetsAtEpochS, rateLimitType: 'five_hour' }),
    });
  };
}

async function limited(tk: TestKernel): Promise<{ resetsAtWall: number; jitterMs: number; atWall: number }> {
  const k = await send(tk, 'work');
  const e = await ended(tk, k);
  expect(e.payload.outcome).toBe('failed');
  expect(e.payload.error?.code).toBe('E_USAGE_LIMIT');
  const lim = await tk.waitForEvent('usage.limited');
  const wake = await tk.waitForEvent('usage.wakeScheduled');
  return { resetsAtWall: lim.payload.resetsAtWall ?? NaN, jitterMs: wake.payload.jitterMs, atWall: wake.payload.atWall };
}

describe('usage limits and auth', () => {
  kscenario(
    'K-19',
    ['09', '11'],
    'StopFailure rate_limit + transcript resetsAt → usageLimited; jitter = fnv1a formula; wall passes reset+jitter → continue → cleared',
    async () => {
      const tk = await boot({ claude: { onPrompt: limitTurn(10 * 60_000) } });
      const w = await limited(tk);
      expect(tk.state().status.kind).toBe('usageLimited');
      expect(w.jitterMs).toBe(expectedJitter(tk.kernel.sessionKey, w.resetsAtWall, 0));
      expect(w.atWall).toBe(w.resetsAtWall + w.jitterMs);
      const m = mark(tk);
      await tk.advance(w.atWall - tk.fakes.clock.wallNow() + 31_000, 1000);
      const cont = since(tk, m, 'turn.queued').find((q) => q.payload.origin === 'auto_continue');
      expect(cont?.payload.prompt).toBe('continue');
      await tk.waitForEvent('usage.cleared', { from: m.ev });
      expect(
        tk
          .claude()
          .prompts.filter((p) => !p.blocked)
          .map((p) => p.text),
      ).toEqual(['work', 'continue']);
    },
  );

  kscenario('K-19', ['09', '11'], 'still limited after the wake → re-arm, cap 3 → warning E_USAGE_LIMIT', async () => {
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          const now = t.session.ports.clock.wallNow();
          await t.fail({
            error: 'rate_limit',
            message: "You've hit your 5-hour limit · resets 3pm",
            resetsAtEpochS: Math.ceil((now + 60_000) / 1000),
            rateLimitType: 'five_hour',
          });
        },
      },
    });
    await limited(tk);
    await tk.advance(4 * (60_000 + 90_000 + 31_000), 1000);
    const scheduled = tk.eventsOf('usage.wakeScheduled');
    // attempt is 1-based: the first wake is attempt 1, each re-arm adds one (rearms + 1, cap maxRearms 3 → at most 4)
    expect(scheduled.map((s) => s.payload.attempt)).toEqual([1, 2, 3, 4].slice(0, scheduled.length));
    expect(scheduled.length).toBeLessThanOrEqual(4);
    expect(tk.eventsOf('warning').some((x) => x.payload.code === 'E_USAGE_LIMIT')).toBe(true);
  });

  kscenario('K-19', ['09'], 'unknown reset → 15 min re-arm', async () => {
    const tk = await boot({ claude: { onPrompt: limitTurn(undefined) } });
    const k = await send(tk, 'work');
    await ended(tk, k);
    const wake = await tk.waitForEvent('usage.wakeScheduled');
    expect(wake.payload.atWall - tk.fakes.clock.wallNow()).toBeGreaterThan(14 * 60_000);
    expect(wake.payload.atWall - tk.fakes.clock.wallNow()).toBeLessThanOrEqual(15 * 60_000);
  });

  // K-19b [14]: replay of the first REAL captured limit fixture (limit-recorder, §3.9 (b)). None exists yet: no session in
  // this build has hit a real usage limit. When `fixtures/traces/usage-limit-*.ccd.jsonl` appears, this becomes a replay test.
  const limitFixtures = existsSync(join(import.meta.dirname, '..', '..', 'fixtures', 'traces'))
    ? readdirSync(join(import.meta.dirname, '..', '..', 'fixtures', 'traces')).filter((f) => /^usage-limit-.*\.ccd\.jsonl$/.test(f))
    : [];
  if (limitFixtures.length === 0)
    it.skip('K-19b [14] replay of the first real captured limit fixture (no real capture exists yet)', () => undefined);
  else
    kscenario('K-19b', ['14'], `replay of the captured limit fixture ${limitFixtures[0] ?? ''}`, async () => {
      const { replayRaw, readTrace } = await import('../../src/testing/replay.js');
      const r = await replayRaw(readTrace(join(import.meta.dirname, '..', '..', 'fixtures', 'traces', limitFixtures[0] ?? '')));
      expect(r.events.some((e) => e.type === 'usage.limited')).toBe(true);
    });

  kscenario(
    'K-28',
    ['09', '13'],
    '`Login expired` → authRequired, sends queued, auth.poll, auth.status{loggedIn:true} → restored',
    async () => {
      const tk = await boot({
        claude: {
          onPrompt: async (t) => {
            if (t.text === 'first') {
              t.session.history.push('  ⎿  Login expired · Please run /login');
              await t.fail({ error: 'authentication_failed', message: 'Login expired · Please run /login' });
              return;
            }
            await t.say('ok');
            await t.stop();
          },
        },
      });
      tk.fakes.claude.auth = { loggedIn: false };
      const first = await send(tk, 'first');
      await ended(tk, first);
      await tk.waitForEvent('session.authRequired');
      expect(tk.state().status.kind).toBe('authRequired');
      const m = mark(tk);
      const second = await send(tk, 'second');
      await tk.advance(61_000, 1000);
      expect(tk.fakes.claude.calls.filter((c) => c.op === 'authStatus').length).toBeGreaterThanOrEqual(2);
      expect(since(tk, m, 'turn.accepted')).toEqual([]);
      tk.fakes.claude.auth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };
      await tk.waitForEvent('session.authRestored', { maxMs: 70_000 });
      expect((await ended(tk, second)).payload.outcome).toBe('completed');
      const calls = tk.fakes.claude.calls.filter((c) => c.op === 'authStatus').length;
      await tk.advance(130_000, 1000);
      expect(tk.fakes.claude.calls.filter((c) => c.op === 'authStatus').length).toBe(calls);
    },
  );

  kscenario(
    'K-51',
    ['09', '11'],
    'two sessions limited with the same resetsAt → different deterministic jitter in [30 000, 90 000]; wakeNow() at once',
    async () => {
      const resetWall = Date.UTC(2026, 10, 3, 15, 0, 0);
      const turn = async (t: FakeTurn): Promise<void> => {
        if (t.text === 'continue') {
          await t.stop();
          return;
        }
        await t.fail({
          error: 'rate_limit',
          message: "You've hit your 5-hour limit · resets 3pm",
          resetsAtEpochS: resetWall / 1000,
          rateLimitType: 'five_hour',
        });
      };
      const a = await boot({ claude: { onPrompt: turn }, ports: { idSeed: 'a' } });
      const b = await boot({ claude: { onPrompt: turn }, ports: { idSeed: 'b' } });
      const ja = await limited(a);
      const jb = await limited(b);
      expect(a.kernel.sessionKey).not.toBe(b.kernel.sessionKey);
      for (const [tk, j] of [
        [a, ja],
        [b, jb],
      ] as const) {
        expect(j.resetsAtWall).toBe(resetWall);
        expect(j.jitterMs).toBe(expectedJitter(tk.kernel.sessionKey, resetWall, 0));
        expect(j.jitterMs).toBeGreaterThanOrEqual(30_000);
        expect(j.jitterMs).toBeLessThanOrEqual(90_000);
      }
      expect(ja.jitterMs).not.toBe(jb.jitterMs);
      const m = mark(a);
      await a.dispatch({ type: 'usage.wakeNow' });
      await a.advance(2000);
      // The wake procedure ran at once: the reset is still ahead, so it re-armed (attempt 1) instead of submitting.
      const reArmed = since(a, m, 'usage.wakeScheduled');
      const continued = since(a, m, 'turn.queued').filter((q) => q.payload.origin === 'auto_continue');
      expect(reArmed.length + continued.length).toBeGreaterThan(0);
      expect(reArmed.every((r) => r.payload.attempt >= 1)).toBe(true);
    },
  );
});
