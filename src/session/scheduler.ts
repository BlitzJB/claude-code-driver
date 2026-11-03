// session/scheduler.ts — the single DECISION timer (A-0), host-sleep detector and event-loop-lag monitor (A-7)
// (DESIGN.md §1.2, §3.9, §4.10, §4.12; D-03; AL §4.6 L-3/L-4; rev 2 §10 G4; P-API-21, P-NET-42, P-REV-25, P-LIFE-57).
//
// A-0: one timer, armed after every step at `nextDeadline(core)`:
//   - a mono deadline → the timer fires at exactly `atMono` (absolute, Clock.setTimer: no drift);
//   - a wall deadline (usageWake) → the timer fires at `min(atMono, now + usageWakeCheckMs)` so the wall condition is
//     re-checked at least every 30 s and never relies on one long setTimeout (LC §3.3); a wall deadline already due fires now.
//   Firing enqueues `clock.tick` (the core fires every due deadline in its step (2)).
// Host sleep (L-4): on every re-arm and every fire, Δwall − Δmono > 5 s since the last check enqueues `clock.hostResumed`
//   BEFORE the tick, so the core suppresses stall verdicts for hostResumeGraceMs and re-checks wall deadlines at once.
//   Both outcomes of LP-27 (whether the mono clock pauses during macOS sleep) are handled because the wake is a wall deadline.
// A-7: `perf_hooks.monitorEventLoopDelay` (resolution 20 ms) read every 5 s; p99 > 500 ms (or the read itself delayed by
//   more than that: a single long block leaves too few samples for a percentile) enqueues `host.loopLag`, which the core turns
//   into `warning E_HOST_LOOP_LAG` (permission answers may be late; the hook servers live in a worker, P-REV-25).
// Nothing here decides anything; it only produces observations (§4.12).

import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Cancel, Clock, MonoMs, WallMs } from '../model/time.js';

const HOST_RESUME_THRESHOLD_MS = 5000;
const LOOP_LAG_WINDOW_MS = 5000;
const LOOP_LAG_THRESHOLD_MS = 500;
const LOOP_LAG_RESOLUTION_MS = 20;

interface NextDeadlineLike {
  atMono?: MonoMs;
  atWall?: WallMs;
}

/** A started loop-lag monitor (A-7). */
interface LagMonitor {
  stop(): void;
}
export type LagMonitorFactory = (o: {
  windowMs: number;
  thresholdMs: number;
  onLag: (p: { p99Ms: number; maxMs: number; windowMs: number }) => void;
}) => LagMonitor;

/** The real A-7 monitor: monitorEventLoopDelay + one unref'd interval (real time on purpose: it measures the host loop). */
export const realLagMonitor: LagMonitorFactory = (o) => {
  const h = monitorEventLoopDelay({ resolution: LOOP_LAG_RESOLUTION_MS });
  h.enable();
  let expected = performance.now() + o.windowMs;
  const iv = setInterval(() => {
    const now = performance.now();
    const drift = Math.max(0, now - expected);
    expected = now + o.windowMs;
    const p99 = h.percentile(99) / 1e6;
    const max = h.max / 1e6;
    h.reset();
    const p99Ms = Math.round(Math.max(Number.isFinite(p99) ? p99 : 0, drift));
    const maxMs = Math.round(Math.max(Number.isFinite(max) ? max : 0, drift));
    if (p99Ms > o.thresholdMs) o.onLag({ p99Ms, maxMs, windowMs: o.windowMs });
  }, o.windowMs);
  iv.unref();
  return {
    stop(): void {
      clearInterval(iv);
      h.disable();
    },
  };
};

export interface SchedulerOptions {
  clock: Clock;
  usageWakeCheckMs: number;
  /** Enqueue a `clock.tick` observation. */
  onTick: () => void;
  /** Enqueue a `clock.hostResumed` observation. */
  onHostResumed: (p: { monoGapMs: number; wallGapMs: number }) => void;
  /** Enqueue a `host.loopLag` observation. */
  onLoopLag?: (p: { p99Ms: number; maxMs: number; windowMs: number }) => void;
  /** A-7 factory; `false` disables the monitor (unit tests with a FakeClock). Default: the real monitor. */
  lagMonitor?: LagMonitorFactory | false;
  hostResumeThresholdMs?: number;
  lagWindowMs?: number;
  lagThresholdMs?: number;
}

export interface Scheduler {
  /** Re-arm A-0 for the core's next deadline (call after every step). Also runs the host-sleep check. */
  rearm(next: NextDeadlineLike): void;
  /** Host-sleep check only. */
  check(): void;
  /** When the timer is armed (mono), for tests and diagnostics. */
  readonly armedAt: MonoMs | undefined;
  readonly stats: { fired: number; hostResumes: number; rearms: number };
  stop(): void;
}

export function createScheduler(o: SchedulerOptions): Scheduler {
  const threshold = o.hostResumeThresholdMs ?? HOST_RESUME_THRESHOLD_MS;
  let lastMono = o.clock.now() as number;
  let lastWall = o.clock.wallNow() as number;
  let cancel: Cancel | undefined;
  let armedAt: MonoMs | undefined;
  let stopped = false;
  const stats = { fired: 0, hostResumes: 0, rearms: 0 };
  let lag: LagMonitor | undefined;
  if (o.lagMonitor !== false && o.onLoopLag !== undefined) {
    const factory = o.lagMonitor ?? realLagMonitor;
    const onLag = o.onLoopLag;
    lag = factory({ windowMs: o.lagWindowMs ?? LOOP_LAG_WINDOW_MS, thresholdMs: o.lagThresholdMs ?? LOOP_LAG_THRESHOLD_MS, onLag });
  }

  const check = (): boolean => {
    const mono = o.clock.now() as number;
    const wall = o.clock.wallNow() as number;
    const dMono = mono - lastMono;
    const dWall = wall - lastWall;
    lastMono = mono;
    lastWall = wall;
    if (dWall - dMono > threshold) {
      stats.hostResumes++;
      o.onHostResumed({ monoGapMs: Math.max(0, Math.round(dMono)), wallGapMs: Math.round(dWall) });
      return true;
    }
    return false;
  };

  const disarm = (): void => {
    if (cancel !== undefined) cancel();
    cancel = undefined;
    armedAt = undefined;
  };

  const arm = (at: MonoMs): void => {
    if (armedAt === at && cancel !== undefined) return;
    disarm();
    armedAt = at;
    cancel = o.clock.setTimer(at, () => {
      cancel = undefined;
      armedAt = undefined;
      if (stopped) return;
      stats.fired++;
      check();
      o.onTick();
    });
  };

  return {
    rearm(next: NextDeadlineLike): void {
      if (stopped) return;
      stats.rearms++;
      check();
      const now = o.clock.now();
      let target: number | undefined = next.atMono;
      if (next.atWall !== undefined) {
        const wallDue = (next.atWall as number) <= (o.clock.wallNow() as number);
        const recheck = wallDue ? (now as number) : (now as number) + Math.max(1, o.usageWakeCheckMs);
        target = target === undefined ? recheck : Math.min(target, recheck);
      }
      if (target === undefined) {
        disarm();
        return;
      }
      arm(Math.max(target, now) as MonoMs);
    },
    check(): void {
      if (!stopped) check();
    },
    get armedAt(): MonoMs | undefined {
      return armedAt;
    },
    stats,
    stop(): void {
      stopped = true;
      disarm();
      lag?.stop();
      lag = undefined;
    },
  };
}
