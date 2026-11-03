// platform/clock/fake-clock.ts — deterministic Clock for tests (DESIGN.md §6.3/§6.4: "FakeClock", mono + wall, jumpWall).
// Mono and wall advance together with `advance`; `jumpWall` moves only wall time (host sleep, K-21, P-NET-42, P-API-21).
// Timers fire in (deadline, registration) order and each sees `now()` equal to its own deadline.
import type { Cancel, Clock, MonoMs, WallMs } from '../../model/time.js';
import { abortReason } from './real-clock.js';

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

export interface FakeClockOptions {
  mono?: number;
  wall?: number;
}

export class FakeClock implements Clock {
  private mono: number;
  private wall: number;
  private seq = 0;
  private timers: FakeTimer[] = [];

  constructor(o: FakeClockOptions = {}) {
    this.mono = o.mono ?? 1_000;
    this.wall = o.wall ?? Date.UTC(2026, 10, 3, 12, 0, 0);
  }

  now(): MonoMs {
    return this.mono as MonoMs;
  }

  wallNow(): WallMs {
    return this.wall as WallMs;
  }

  setTimer(atMono: MonoMs, fn: () => void): Cancel {
    const t: FakeTimer = { id: ++this.seq, at: atMono, fn };
    this.timers.push(t);
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    return () => {
      this.timers = this.timers.filter((x) => x !== t);
    };
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        cancel();
        reject(abortReason(signal));
      };
      const cancel = this.setTimer((this.mono + Math.max(0, ms)) as MonoMs, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Number of armed timers. */
  pending(): number {
    return this.timers.length;
  }

  /** Mono deadline of the earliest armed timer. */
  nextAt(): MonoMs | undefined {
    const t = this.timers[0];
    return t === undefined ? undefined : (t.at as MonoMs);
  }

  /** Synchronously advance mono and wall by `ms`, firing every due timer in order. Returns how many fired. */
  advance(ms: number): number {
    const target = this.mono + Math.max(0, ms);
    let fired = 0;
    for (;;) {
      const t = this.timers[0];
      if (t === undefined || t.at > target) break;
      this.timers.shift();
      this.moveTo(Math.max(this.mono, t.at));
      fired++;
      t.fn();
    }
    this.moveTo(target);
    return fired;
  }

  /**
   * Like `advance`, but lets promise continuations run between timers (needed when code awaits `sleep` in a loop).
   * Resolves once mono reached `now + ms` and nothing else is due.
   */
  async advanceAsync(ms: number): Promise<number> {
    const target = this.mono + Math.max(0, ms);
    let fired = 0;
    await flushMicrotasks();
    for (;;) {
      const t = this.timers[0];
      if (t === undefined || t.at > target) break;
      this.timers.shift();
      this.moveTo(Math.max(this.mono, t.at));
      fired++;
      t.fn();
      await flushMicrotasks();
    }
    this.moveTo(target);
    await flushMicrotasks();
    return fired;
  }

  /** Fire timers until none is left (bounded to avoid runaway re-arming loops). */
  async runAll(maxTimers = 10_000): Promise<number> {
    let fired = 0;
    await flushMicrotasks();
    while (this.timers.length > 0 && fired < maxTimers) {
      const t = this.timers.shift();
      if (t === undefined) break;
      this.moveTo(Math.max(this.mono, t.at));
      fired++;
      t.fn();
      await flushMicrotasks();
    }
    return fired;
  }

  /** Host sleep: wall time jumps, mono does not (K-21). Wall-only consumers re-check on their next mono tick. */
  jumpWall(ms: number): void {
    this.wall += ms;
  }

  /** Set wall time explicitly (e.g. a transcript timestamp in a replay). */
  setWall(wall: number): void {
    this.wall = wall;
  }

  private moveTo(mono: number): void {
    const delta = mono - this.mono;
    if (delta <= 0) return;
    this.mono = mono;
    this.wall += delta;
  }
}

/** Let queued promise continuations (several hops deep) run. */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
