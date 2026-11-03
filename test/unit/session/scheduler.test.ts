// session/scheduler.ts — A-0 single decision timer (mono + wall re-checks), host-sleep detector, A-7 loop-lag monitor
// (DESIGN.md §3.9, §4.10, §4.12; D-03; P-API-21, P-NET-42, P-REV-25, P-LIFE-57).
import { describe, expect, it } from 'vitest';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { createScheduler, realLagMonitor } from '../../../src/session/scheduler.js';
import type { LagMonitorFactory } from '../../../src/session/scheduler.js';

function mk(o: { lag?: LagMonitorFactory | false } = {}) {
  const clock = new FakeClock({ mono: 1000, wall: 1_700_000_000_000 });
  const ticks: number[] = [];
  const resumes: { monoGapMs: number; wallGapMs: number }[] = [];
  const lags: unknown[] = [];
  const s = createScheduler({
    clock,
    usageWakeCheckMs: 30_000,
    onTick: () => ticks.push(clock.now()),
    onHostResumed: (p) => resumes.push(p),
    onLoopLag: (p) => lags.push(p),
    lagMonitor: o.lag ?? false,
  });
  return { clock, s, ticks, resumes, lags };
}

describe('A-0 decision timer', () => {
  it('arms exactly one timer at the mono deadline and fires clock.tick there', async () => {
    const { clock, s, ticks } = mk();
    s.rearm({ atMono: 1500 as MonoMs });
    s.rearm({ atMono: 1500 as MonoMs });
    expect(clock.pending()).toBe(1);
    expect(s.armedAt).toBe(1500);
    await clock.advanceAsync(499);
    expect(ticks).toEqual([]);
    await clock.advanceAsync(1);
    expect(ticks).toEqual([1500]);
    expect(s.stats.fired).toBe(1);
    expect(s.armedAt).toBeUndefined();
  });

  it('re-arming moves the single timer (no second timer)', async () => {
    const { clock, s, ticks } = mk();
    s.rearm({ atMono: 5000 as MonoMs });
    s.rearm({ atMono: 2000 as MonoMs });
    expect(clock.pending()).toBe(1);
    await clock.advanceAsync(5000);
    expect(ticks).toEqual([2000]);
  });

  it('no deadline → no timer', () => {
    const { clock, s } = mk();
    s.rearm({ atMono: 5000 as MonoMs });
    s.rearm({});
    expect(clock.pending()).toBe(0);
    expect(s.armedAt).toBeUndefined();
  });

  it('a past mono deadline fires at once (next timer turn)', async () => {
    const { clock, s, ticks } = mk();
    s.rearm({ atMono: 10 as MonoMs });
    expect(s.armedAt).toBe(1000);
    await clock.advanceAsync(0);
    expect(ticks).toEqual([1000]);
  });

  it('a wall deadline is re-checked at most every usageWakeCheckMs (no long setTimeout, LC §3.3)', async () => {
    const { clock, s, ticks } = mk();
    const wallDue = (clock.wallNow() + 2 * 60 * 60_000) as WallMs; // 2 h away
    s.rearm({ atWall: wallDue });
    expect(s.armedAt).toBe(31_000);
    await clock.advanceAsync(30_000);
    expect(ticks).toEqual([31_000]);
    s.rearm({ atWall: wallDue, atMono: 40_000 as MonoMs });
    expect(s.armedAt).toBe(40_000); // the earlier of the two
    s.rearm({ atWall: wallDue, atMono: 90_000 as MonoMs });
    expect(s.armedAt).toBe(61_000);
  });

  it('a wall deadline already due fires now', async () => {
    const { clock, s, ticks } = mk();
    s.rearm({ atWall: (clock.wallNow() - 1) as WallMs });
    expect(s.armedAt).toBe(1000);
    await clock.advanceAsync(0);
    expect(ticks).toHaveLength(1);
  });

  it('stop() cancels the timer and ignores later rearms', async () => {
    const { clock, s, ticks } = mk();
    s.rearm({ atMono: 1100 as MonoMs });
    s.stop();
    s.rearm({ atMono: 1200 as MonoMs });
    await clock.advanceAsync(1000);
    expect(ticks).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});

describe('host-sleep detector (L-4)', () => {
  it('Δwall − Δmono > 5 s → clock.hostResumed before the tick (K-21 shape: jumpWall, no mono advance)', async () => {
    const { clock, s, ticks, resumes } = mk();
    const order: string[] = [];
    s.rearm({ atWall: (clock.wallNow() + 3_600_000) as WallMs });
    clock.jumpWall(10 * 60_000);
    // the next re-arm (after any step) detects it at once
    s.rearm({ atWall: (clock.wallNow() + 3_600_000) as WallMs });
    expect(resumes).toEqual([{ monoGapMs: 0, wallGapMs: 600_000 }]);
    order.push('resumed');
    await clock.advanceAsync(30_000);
    expect(ticks).toHaveLength(1);
    expect(resumes).toHaveLength(1); // no second report for the same gap
  });

  it('detects the gap on the timer fire too, and reports it before onTick', async () => {
    const clock = new FakeClock({ mono: 0, wall: 1_000_000 });
    const order: string[] = [];
    const s = createScheduler({
      clock,
      usageWakeCheckMs: 30_000,
      onTick: () => order.push('tick'),
      onHostResumed: (p) => order.push(`resumed:${p.wallGapMs - p.monoGapMs}`),
      lagMonitor: false,
    });
    s.rearm({ atMono: 1000 as MonoMs });
    clock.jumpWall(20_000);
    await clock.advanceAsync(1000);
    expect(order).toEqual(['resumed:20000', 'tick']);
  });

  it('a small skew (≤ 5 s) is not a host resume; backwards wall is ignored', () => {
    const { clock, s, resumes } = mk();
    clock.jumpWall(4999);
    s.check();
    clock.setWall(clock.wallNow() - 60_000);
    s.check();
    expect(resumes).toEqual([]);
  });
});

describe('A-7 loop-lag monitor', () => {
  it('passes the window/threshold to the factory and forwards lag reports', () => {
    let captured: Parameters<LagMonitorFactory>[0] | undefined;
    let stopped = false;
    const { s, lags } = mk({
      lag: (o) => {
        captured = o;
        return {
          stop: () => {
            stopped = true;
          },
        };
      },
    });
    expect(captured).toMatchObject({ windowMs: 5000, thresholdMs: 500 });
    captured?.onLag({ p99Ms: 6000, maxMs: 6000, windowMs: 5000 });
    expect(lags).toEqual([{ p99Ms: 6000, maxMs: 6000, windowMs: 5000 }]);
    s.stop();
    expect(stopped).toBe(true);
  });

  it('the real monitor detects a blocked event loop (busy loop > threshold)', async () => {
    const reports: { p99Ms: number }[] = [];
    const m = realLagMonitor({ windowMs: 100, thresholdMs: 150, onLag: (p) => reports.push(p) });
    try {
      const until = Date.now() + 400;
      while (Date.now() < until) {
        // block the host loop
      }
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      m.stop();
    }
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]?.p99Ms).toBeGreaterThan(150);
  });

  it('the real monitor stays quiet on an idle loop', async () => {
    const reports: unknown[] = [];
    const m = realLagMonitor({ windowMs: 50, thresholdMs: 500, onLag: (p) => reports.push(p) });
    await new Promise((r) => setTimeout(r, 180));
    m.stop();
    expect(reports).toEqual([]);
  });
});
