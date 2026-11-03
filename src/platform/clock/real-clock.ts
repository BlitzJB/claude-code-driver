// platform/clock/real-clock.ts — the real Clock port (DESIGN.md §2.1, D-03, §4.12).
// Mono time = performance.now(); wall time = Date.now(). `setTimer` takes an ABSOLUTE mono deadline, so re-arming never
// accumulates drift (P-TMUX-54). This is the only file outside the §4.12 list that may call setTimeout (arch test allowlist):
// every adapter that has to wait goes through this port so the fake clock can drive it in tests.
import { performance } from 'node:perf_hooks';
import type { Cancel, Clock, MonoMs, WallMs } from '../../model/time.js';

/** setTimeout clamps larger delays to 1 ms; long deadlines are re-armed in hops of this size. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface RealClockOptions {
  /** Do not keep the event loop alive for clock timers (default false). */
  unref?: boolean;
}

export function createRealClock(o: RealClockOptions = {}): Clock {
  const now = (): MonoMs => performance.now() as MonoMs;
  const wallNow = (): WallMs => Date.now() as WallMs;

  const setTimer = (atMono: MonoMs, fn: () => void): Cancel => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const arm = (): void => {
      if (cancelled) return;
      const delay = atMono - now();
      if (delay <= 0) {
        handle = undefined;
        fn();
        return;
      }
      // Timers may fire up to ~1 ms early; `arm` re-checks and re-arms until the deadline really passed.
      handle = setTimeout(arm, Math.min(Math.ceil(delay), MAX_TIMEOUT_MS));
      if (o.unref === true) handle.unref();
    };
    const delay = atMono - now();
    handle = setTimeout(arm, Math.max(0, Math.min(Math.ceil(delay), MAX_TIMEOUT_MS)));
    if (o.unref === true) handle.unref();
    return () => {
      cancelled = true;
      if (handle !== undefined) clearTimeout(handle);
      handle = undefined;
    };
  };

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        cancel();
        reject(abortReason(signal));
      };
      const cancel = setTimer((now() + Math.max(0, ms)) as MonoMs, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  return { now, wallNow, setTimer, sleep };
}

/** The rejection value of an aborted sleep: the signal's reason when it is an Error, else an AbortError carrying it. */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error('The operation was aborted', reason === undefined ? undefined : { cause: reason });
  e.name = 'AbortError';
  return e;
}
