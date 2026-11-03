// core/decide/usage.ts — §3.9 usage limits, deterministic wake jitter, wake procedure (K-19, K-51, P-LIFE-15, P-REV-36).
import { describe, expect, it } from 'vitest';
import { wakeJitterMs } from '../../../src/core/decide/usage.js';
import { fnv1a32 } from '../../../src/core/input-policy/ack-match.js';
import type { SessionKey } from '../../../src/model/ids.js';
import type { WallMs } from '../../../src/model/time.js';
import type { Harness } from './harness.js';
import { WALL0, busyFrame, composerFrame, frame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

const RESET = WALL0 + 3_600_000;
function limited(key = 'sdeadbeef', o: { reset?: number | undefined } = { reset: RESET }): Harness {
  const h = readyHarness(testConfig(), { sessionKey: key as SessionKey });
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
  if (o.reset !== undefined)
    h.tx(
      'model.apiErrorRecorded',
      { error: 'rate_limit', apiError: 'usage_limit_reached', text: "You've hit your limit", resetsAtWall: o.reset as WallMs },
      { uuid: 'ae' },
    );
  return h;
}

describe('usage limits', () => {
  it('K-19 StopFailure rate_limit + transcript resetsAt → usageLimited; the interrupted turn fails E_USAGE_LIMIT', () => {
    const h = limited();
    expect(h.d.turns['t1' as never]?.error?.code).toBe('E_USAGE_LIMIT');
    expect(h.d.usage.limit).toMatchObject({ state: 'limited', source: 'hook', resetsAtWall: RESET, rearms: 0, autoContinue: 'none' });
    expect(h.d.status).toMatchObject({ kind: 'usageLimited', resetsAtWall: RESET, autoResume: true });
    expect(h.ev('usage.limited')[0]?.payload.source).toBe('hook');
  });

  it('K-19 jitterMs equals the documented fnv1a formula and lies in [30000, 90000]', () => {
    const h = limited();
    const want = 30000 + (fnv1a32(`sdeadbeef:${RESET}:0`) % 60001);
    const ev = h.ev('usage.wakeScheduled').at(-1)?.payload;
    expect(ev?.jitterMs).toBe(want);
    expect(ev?.atWall).toBe(RESET + want);
    expect(wakeJitterMs('sdeadbeef', RESET, 0, 30000, 90000)).toBe(want);
  });

  it('K-51 two sessions with the same resetsAt get different deterministic jitter', () => {
    const a = wakeJitterMs('s00000001', RESET, 0, 30000, 90000);
    const b = wakeJitterMs('s00000002', RESET, 0, 30000, 90000);
    expect(a).not.toBe(b);
    for (const j of [a, b]) {
      expect(j).toBeGreaterThanOrEqual(30000);
      expect(j).toBeLessThanOrEqual(90000);
    }
    expect(wakeJitterMs('s00000001', RESET, 0, 30000, 90000)).toBe(a);
  });

  it('K-19 wall time passing reset + jitter → `continue` submitted (origin auto_continue) → cleared{wokeByLibrary}', () => {
    const h = limited();
    const at = h.d.usage.limit?.nextWakeAtWall ?? 0;
    h.advance(100, at - h.wall + 1);
    expect(h.d.usage.limit?.state).toBe('waking');
    h.run(300);
    expect(
      h
        .primitives()
        .filter((p) => p.kind === 'editorStage')
        .at(-1),
    ).toEqual({ kind: 'editorStage', text: 'continue' });
    ups(h, 'continue', 'pc');
    expect(h.d.usage.limit?.state).toBe('cleared');
    expect(h.ev('usage.cleared')[0]?.payload.reason).toBe('wokeByLibrary');
    expect(h.d.turns['t2' as never]?.origin.value).toBe('auto_continue');
  });

  it('K-51 usage.wakeNow triggers the procedure immediately', () => {
    const h = limited();
    h.cmd({ type: 'usage.wakeNow' });
    expect(h.d.usage.limit?.state).toBe('waking');
    h.run(200);
    expect(h.primitives().some((p) => p.kind === 'editorStage' && p.text === 'continue')).toBe(true);
  });

  it('a new limit while waking re-arms (rearms++); after maxRearms (3) → warning, no more wakes', () => {
    const h = limited();
    for (let i = 1; i <= 4; i++) {
      h.cmd({ type: 'usage.wakeNow' });
      h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
      h.tx(
        'model.apiErrorRecorded',
        { error: 'rate_limit', text: 'limit', resetsAtWall: (RESET + i * 1000) as WallMs },
        { uuid: `ae${i}` },
      );
      h.run(100);
    }
    expect(h.d.usage.limit?.rearms).toBeGreaterThan(3);
    expect(h.ev('warning').some((w) => (w.payload.detail as { reason?: string } | null)?.reason === 'maxRearms')).toBe(true);
    expect(h.core.recon.deadlines['usageWake:limit']).toBeUndefined();
  });

  it('K-19 unknown reset → wall deadline at wallNow + 15 min', () => {
    const h = limited('sdeadbeef', { reset: undefined });
    // no reset with the StopFailure: usage.limited and the wake wait transcriptSettle for the transcript's reset (ICR 0016)
    expect(h.ev('usage.limited')).toEqual([]);
    expect(h.core.recon.deadlines['usageWake:limit']).toBeUndefined();
    h.run(h.core.config.timeouts.transcriptSettleMs);
    expect(h.ev('usage.limited')).toHaveLength(1);
    expect(h.core.recon.deadlines['usageWake:limit']).toMatchObject({ clock: 'wall', at: h.wall + 15 * 60 * 1000 });
    expect(h.ev('usage.wakeScheduled')[0]?.payload.jitterMs).toBe(0);
  });

  it('a stale "press Enter" auto-continue screen → wakeEnter job; verified by the next UPS', () => {
    const h = limited();
    h.screen(composerFrame('', { usageLimit: { line: 'limit', autoContinue: 'stalePressEnter' } }));
    h.run(300);
    h.cmd({ type: 'usage.wakeNow' });
    h.run(100);
    expect(h.primitives().at(-1)).toEqual({ kind: 'key', key: 'Enter', gapAfterMs: 15 });
    ups(h, 'continue', 'pw');
    expect(h.core.input.current).toBeUndefined();
    expect(h.d.usage.limit?.state).toBe('cleared');
  });

  it('the usage-limit options menu → one Escape (dismissMenu), then the resume prompt', () => {
    const h = limited();
    h.screen(frame({ surface: 'usageLimitMenu', composer: undefined }));
    h.run(300);
    h.onPrimitive = (p) => (p.kind === 'key' && p.key === 'Escape' ? { surface: 'main' } : undefined);
    h.cmd({ type: 'usage.wakeNow' });
    h.run(1500);
    const prims = h.primitives();
    expect(prims.findIndex((p) => p.kind === 'key' && p.key === 'Escape')).toBeLessThan(
      prims.findIndex((p) => p.kind === 'editorStage' && p.text === 'continue'),
    );
  });

  it('a screen banner with a later reset re-arms instead of submitting', () => {
    const h = limited();
    h.screen(busyFrame({ usageLimit: { line: 'limit', resetsAtWall: (h.wall + 7_200_000) as WallMs } }));
    h.run(300);
    h.cmd({ type: 'usage.wakeNow' });
    expect(h.primitives().some((p) => p.kind === 'editorStage' && p.text === 'continue')).toBe(false);
    expect(h.d.usage.limit).toMatchObject({ state: 'limited', rearms: 1 });
  });

  it("send() while limited: whenBusy:'reject' → E_USAGE_LIMIT; 'wait' queues until cleared", () => {
    const h = limited();
    expect(h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'reject' })).toMatchObject({ ok: false, error: { code: 'E_USAGE_LIMIT' } });
    h.cmd({ type: 'prompt.send', text: 'queued', whenBusy: 'wait' });
    h.run(500);
    expect(h.primitives().some((p) => p.kind === 'editorStage' && p.text === 'queued')).toBe(false);
  });

  it('Notification quota_auto_resume_fired clears the limit (autoResumeFired)', () => {
    const h = limited();
    h.hook('notification', { type: 'quota_auto_resume_fired' }, 'Notification');
    expect(h.ev('usage.cleared')[0]?.payload.reason).toBe('autoResumeFired');
  });

  it('autoResume:false → no wake deadline', () => {
    const h = readyHarness(testConfig({ usage: { autoResume: false } }));
    h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    expect(h.d.usage.limit?.state).toBe('limited');
    expect(h.core.recon.deadlines['usageWake:limit']).toBeUndefined();
  });
});
