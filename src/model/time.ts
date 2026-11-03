// model/time.ts — time brands and the Clock port shape (DESIGN.md §2.1, D-03).

import type { Brand } from './ids.js';

export type MonoMs = Brand<number, 'MonoMs'>; // performance.now() based; the ONLY time the core uses
export type WallMs = Brand<number, 'WallMs'>; // Date.now(); joins with transcript timestamps + display only
export type Cancel = () => void;
export interface Clock {
  now(): MonoMs;
  wallNow(): WallMs;
  setTimer(atMono: MonoMs, fn: () => void): Cancel; // absolute deadline (no drift accumulation)
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
