// session/queue.ts — the single input queue of the step loop: observation seq stamping + commands (DESIGN.md §1.2, §2.4,
// AL §4.6; rev 2 D-42: NO de-duplication window here).
//
// Every observation gets `meta.seq` = the next ObsSeq (strictly increasing, gap-free per session) at the moment it is
// enqueued, so the seq order is the arrival order and `causedBy[]` chains are exact. Nothing is ever dropped or merged:
// the only de-duplication key in the system is the transcript entry uuid, applied by the core per generation (D-42,
// P-REV-11). Commands share the FIFO so a command is applied after every observation that arrived before it.
// The queue is unbounded (dropping an observation would corrupt state); a high-water callback reports a backlog.

import type { Command } from '../model/commands.js';
import type { ObsSeq } from '../model/ids.js';
import type { Observation, ObservationInput } from '../model/observation.js';
import type { MonoMs, WallMs } from '../model/time.js';

export type QueueItem = { type: 'obs'; obs: Observation } | { type: 'cmd'; cmdId: number; cmd: Command; at: MonoMs; wallAt: WallMs };

export interface InputQueueOptions {
  /** First ObsSeq handed out (default 1). */
  firstSeq?: number;
  /** First command id handed out (default 1). */
  firstCmdId?: number;
  /** Backlog size that triggers `onHighWater` (once per crossing; default 50 000). */
  highWater?: number;
  onHighWater?: (size: number) => void;
}

export interface InputQueue {
  /** Stamp `meta.seq` and enqueue. Returns the stamped observation. */
  pushObservation(o: ObservationInput): Observation;
  /** Enqueue a command; returns its cmdId. */
  pushCommand(cmd: Command, at: MonoMs, wallAt: WallMs): number;
  /** Dequeue the oldest item (FIFO). */
  shift(): QueueItem | undefined;
  readonly size: number;
  /** The seq the next observation will get. */
  readonly nextSeq: number;
  readonly stats: { observations: number; commands: number; maxSize: number };
  /** Drop every queued item (session closed); returns what was dropped, commands first, so callers can reject them. */
  clear(): QueueItem[];
}

export function createInputQueue(o: InputQueueOptions = {}): InputQueue {
  let items: (QueueItem | undefined)[] = [];
  let head = 0;
  let seq = o.firstSeq ?? 1;
  let cmdId = o.firstCmdId ?? 1;
  const highWater = o.highWater ?? 50_000;
  let above = false;
  const stats = { observations: 0, commands: 0, maxSize: 0 };

  const size = (): number => items.length - head;
  const pushItem = (it: QueueItem): void => {
    items.push(it);
    const n = size();
    if (n > stats.maxSize) stats.maxSize = n;
    if (!above && n >= highWater) {
      above = true;
      o.onHighWater?.(n);
    }
  };

  return {
    pushObservation(input: ObservationInput): Observation {
      const s = seq as ObsSeq;
      seq += 1;
      // A fresh meta object: the producer's object is never mutated (it may be retained by a normalizer or the trace).
      const obs = { kind: input.kind, meta: { ...input.meta, seq: s }, p: input.p } as unknown as Observation;
      stats.observations++;
      pushItem({ type: 'obs', obs });
      return obs;
    },
    pushCommand(cmd: Command, at: MonoMs, wallAt: WallMs): number {
      const id = cmdId;
      cmdId += 1;
      stats.commands++;
      pushItem({ type: 'cmd', cmdId: id, cmd, at, wallAt });
      return id;
    },
    shift(): QueueItem | undefined {
      if (head >= items.length) return undefined;
      const it = items[head];
      items[head] = undefined;
      head++;
      // compact occasionally so the array does not grow without bound
      if (head >= 1024 && head * 2 >= items.length) {
        items = items.slice(head);
        head = 0;
      }
      if (above && size() < highWater / 2) above = false;
      return it;
    },
    get size(): number {
      return size();
    },
    get nextSeq(): number {
      return seq;
    },
    stats,
    clear(): QueueItem[] {
      const rest = items.slice(head).filter((x): x is QueueItem => x !== undefined);
      items = [];
      head = 0;
      above = false;
      return [...rest.filter((x) => x.type === 'cmd'), ...rest.filter((x) => x.type === 'obs')];
    },
  };
}
