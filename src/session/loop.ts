// session/loop.ts — the single serialized step loop and the subscriber fan-out (DESIGN.md §1.2, §2.9, §2.10; AL §4.6
// L-1/L-6; P-API-05, P-API-06, P-API-09).
//
// L-1 One loop, no re-entrancy: `step` runs synchronously for one queued input at a time. Everything that wants to change
//     the core (observations, commands, `dispatch()` called from inside a listener) only ENQUEUES; draining is scheduled on a
//     microtask and never runs inline. A long backlog yields to the host event loop every `stepsPerSlice` steps
//     (setImmediate), so a 100 MB transcript catch-up does not starve timers and I/O (P-TAIL-15).
// L-6 Fan-out: after each step its events are appended to the event log (ring) and to every subscriber's pending buffer;
//     listeners are called on a microtask, each in its own try/catch. A buffer above `maxPendingEvents` drops its oldest
//     events and the next batch carries `gap{from,to}` — never a silent loss (P-API-09). A throwing listener is isolated,
//     logged and reported ONCE per listener as `warning E_LISTENER_THREW` (P-API-06, K-23).
// L3-originated warnings (`publishLocal`) are real DomainEvents: their seq is the core's next event seq and `evolve` folds
//     them into the domain, so invariant I1 (fold(evolve, events) = domain) still holds.

import type { Command } from '../model/commands.js';
import { CcdError } from '../model/errors.js';
import type { CcdErrorCode } from '../model/errors.js';
import type { CoreEvent, DomainEvent } from '../model/events.js';
import type { EventSeq } from '../model/ids.js';
import type { JsonValue } from '../model/json.js';
import type { KernelListener, Unsubscribe } from '../model/kernel.js';
import type { Logger } from '../model/logger.js';
import type { Observation, ObservationInput } from '../model/observation.js';
import type { SessionState } from '../model/state.js';
import type { MonoMs, WallMs } from '../model/time.js';
import type { CoreInput, CoreState, StepResult } from '../core/types.js';
import type { EventLog } from './event-log.js';
import { fromErrorData } from './errors-map.js';
import type { InputQueue, QueueItem } from './queue.js';

export type SecurityAlertPayload = Extract<DomainEvent, { type: 'security.alert' }>['payload'];

export const DEFAULT_MAX_PENDING_EVENTS = 10_000;
export const DEFAULT_STEPS_PER_SLICE = 512;

export interface StepLoopHooks {
  /** Before an input is stepped (trace `obs`/`cmd` records). */
  beforeStep?(item: QueueItem): void;
  /** After a step was committed: intents → executor, trace `step`/`diag`/`event` records, limit recorder. */
  afterStep?(r: StepResult, item: QueueItem, durUs: number): void;
  /** After an L3 event was published (`publishLocal`). */
  afterLocal?(e: DomainEvent): void;
}

export interface StepLoopOptions {
  core: CoreState;
  step: (core: CoreState, input: CoreInput) => StepResult;
  evolve: (domain: SessionState, e: CoreEvent) => SessionState;
  queue: InputQueue;
  log: EventLog;
  hooks?: StepLoopHooks;
  logger?: Logger;
  maxPendingEvents?: number;
  stepsPerSlice?: number;
  /** High-resolution time for `durUs` (default performance.now). */
  hrNow?: () => number;
  /** Microtask scheduler (default queueMicrotask). */
  microtask?: (fn: () => void) => void;
  /** Macrotask yield for long backlogs (default setImmediate). */
  yieldTask?: (fn: () => void) => void;
}

interface Subscriber {
  listener: KernelListener;
  pending: DomainEvent[];
  gap?: { from: EventSeq; to: EventSeq };
  threw: boolean;
  active: boolean;
}

interface PendingCommand {
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

export interface StepLoop {
  readonly core: CoreState;
  readonly state: Readonly<SessionState>;
  /** Replace the core (a relaunch builds a fresh one). Only between steps. */
  setCore(c: CoreState): void;
  /** Stamp + enqueue an observation and schedule a drain. */
  observe(o: ObservationInput): Observation;
  /** Enqueue a command; resolves with the core's result value, rejects with a CcdError. */
  dispatch(cmd: Command, at: MonoMs, wallAt: WallMs): Promise<unknown>;
  subscribe(listener: KernelListener, fromSeq?: EventSeq): Unsubscribe;
  /** Synchronous per-step state watchers (waitFor, kernel bookkeeping). Called after every committed step. */
  watch(fn: (s: Readonly<SessionState>, events: readonly DomainEvent[]) => void): Unsubscribe;
  /** Publish an L3-originated event (a warning, or an L0 security alert) through the core's event seq. */
  publishLocal(type: 'warning', payload: { code: CcdErrorCode; message: string; detail?: JsonValue }): DomainEvent | undefined;
  publishLocal(type: 'security.alert', payload: SecurityAlertPayload): DomainEvent | undefined;
  /** Schedule a drain (normally automatic). */
  kick(): void;
  /** Resolves when the queue is empty and no drain is scheduled (tests, close). */
  idle(): Promise<void>;
  /** Stop: reject every pending and queued command with E_SESSION_CLOSED, refuse new ones; later observations are discarded. */
  close(reason: string): void;
  readonly closed: boolean;
  readonly stats: { steps: number; listenerErrors: number; droppedForSlowSubscribers: number; stepErrors: number };
}

export function createStepLoop(o: StepLoopOptions): StepLoop {
  let core = o.core;
  const maxPending = Math.max(1, o.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS);
  const slice = Math.max(1, o.stepsPerSlice ?? DEFAULT_STEPS_PER_SLICE);
  const hrNow = o.hrNow ?? ((): number => performance.now());
  const microtask =
    o.microtask ??
    ((fn: () => void): void => {
      queueMicrotask(fn);
    });
  const yieldTask = o.yieldTask ?? ((fn: () => void): void => void setImmediate(fn));
  const subs = new Set<Subscriber>();
  const watchers = new Set<(s: Readonly<SessionState>, events: readonly DomainEvent[]) => void>();
  const pendingCmds = new Map<number, PendingCommand>();
  const idleWaiters: (() => void)[] = [];
  let draining = false;
  let drainScheduled = false;
  let flushScheduled = false;
  let closed = false;
  const stats = { steps: 0, listenerErrors: 0, droppedForSlowSubscribers: 0, stepErrors: 0 };

  const isIdle = (): boolean => !draining && !drainScheduled && o.queue.size === 0;
  const notifyIdle = (): void => {
    if (!isIdle()) return;
    for (const w of idleWaiters.splice(0)) w();
  };

  const kick = (): void => {
    if (drainScheduled || draining) return;
    drainScheduled = true;
    microtask(drain);
  };

  const deliver = (sub: Subscriber, events: readonly DomainEvent[]): void => {
    if (!sub.active || events.length === 0) return;
    for (const e of events) sub.pending.push(e);
    trim(sub);
  };

  const trim = (sub: Subscriber): void => {
    const over = sub.pending.length - maxPending;
    if (over > 0) {
      const lost = sub.pending.splice(0, over);
      stats.droppedForSlowSubscribers += lost.length;
      const from = lost[0]?.seq;
      const to = lost[lost.length - 1]?.seq;
      if (from !== undefined && to !== undefined)
        sub.gap = sub.gap === undefined ? { from, to } : { from: sub.gap.from < from ? sub.gap.from : from, to };
    }
  };

  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    microtask(flush);
  };

  function flush(): void {
    flushScheduled = false;
    const state = core.domain;
    for (const sub of [...subs]) {
      if (!sub.active || (sub.pending.length === 0 && sub.gap === undefined)) continue;
      const events = sub.pending;
      sub.pending = [];
      const gap = sub.gap;
      delete sub.gap;
      try {
        sub.listener(gap === undefined ? { events, state } : { events, state, gap });
      } catch (e) {
        stats.listenerErrors++;
        const name = e instanceof Error ? e.name : typeof e;
        o.logger?.warn('kernel listener threw', { error: name });
        if (!sub.threw) {
          sub.threw = true;
          publishLocal('warning', {
            code: 'E_LISTENER_THREW',
            message: 'a session listener threw; it stays subscribed and the session continues',
            detail: { error: name },
          });
        }
      }
    }
  }

  const fanOut = (events: readonly DomainEvent[]): void => {
    if (events.length === 0) return;
    for (const sub of subs) deliver(sub, events);
    scheduleFlush();
  };

  const runWatchers = (events: readonly DomainEvent[]): void => {
    for (const w of [...watchers]) {
      try {
        w(core.domain, events);
      } catch (e) {
        o.logger?.warn('kernel watcher threw', { error: e instanceof Error ? e.name : typeof e });
      }
    }
  };

  const settle = (r: StepResult): void => {
    const cr = r.commandResult;
    if (cr === undefined) return;
    const p = pendingCmds.get(cr.cmdId);
    if (p === undefined) return;
    pendingCmds.delete(cr.cmdId);
    if (cr.ok) p.resolve(cr.value);
    else p.reject(fromErrorData(cr.error));
  };

  const processItem = (item: QueueItem): void => {
    const input: CoreInput =
      item.type === 'obs'
        ? { type: 'obs', obs: item.obs }
        : { type: 'cmd', cmdId: item.cmdId, cmd: item.cmd, at: item.at, wallAt: item.wallAt };
    try {
      o.hooks?.beforeStep?.(item);
    } catch (e) {
      o.logger?.warn('beforeStep hook threw', { error: e instanceof Error ? e.name : typeof e });
    }
    const t0 = hrNow();
    let r: StepResult;
    try {
      r = o.step(core, input);
    } catch (e) {
      // `step` is total (I2); a throw is a core bug. The input is dropped with a diagnostic, the loop goes on.
      stats.stepErrors++;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      r = { core, events: [], intents: [], diagnostics: [{ code: 'step_threw', at: core.now, detail: { message: msg.slice(0, 500) } }] };
      if (input.type === 'cmd')
        r.commandResult = { cmdId: input.cmdId, ok: false, error: { code: 'E_INVARIANT', message: 'core step failed' } };
    }
    const durUs = Math.max(0, Math.round((hrNow() - t0) * 1000));
    core = r.core;
    stats.steps++;
    o.log.append(r.events);
    fanOut(r.events);
    try {
      o.hooks?.afterStep?.(r, item, durUs);
    } catch (e) {
      o.logger?.warn('afterStep hook threw', { error: e instanceof Error ? e.name : typeof e });
    }
    settle(r);
    runWatchers(r.events);
  };

  function drain(): void {
    drainScheduled = false;
    if (draining) return;
    draining = true;
    let n = 0;
    try {
      for (;;) {
        if (closed) {
          o.queue.clear();
          break;
        }
        const item = o.queue.shift();
        if (item === undefined) break;
        processItem(item);
        if (++n >= slice && o.queue.size > 0) {
          drainScheduled = true;
          yieldTask(drain);
          break;
        }
      }
    } finally {
      draining = false;
    }
    notifyIdle();
  }

  function publishLocal(type: 'warning', payload: { code: CcdErrorCode; message: string; detail?: JsonValue }): DomainEvent | undefined;
  function publishLocal(type: 'security.alert', payload: SecurityAlertPayload): DomainEvent | undefined;
  function publishLocal(
    type: 'warning' | 'security.alert',
    payload: { code: CcdErrorCode; message: string; detail?: JsonValue } | SecurityAlertPayload,
  ): DomainEvent | undefined {
    if (closed) return undefined;
    const seq = (core.counters.event + 1) as EventSeq;
    const env: Record<string, unknown> = {
      v: 1,
      seq,
      type,
      at: core.now,
      wallAt: core.wallNow,
      sessionKey: core.domain.sessionKey,
      provenance: { confirmed: true, sources: ['self'] },
      causedBy: [],
      payload:
        type === 'warning' && 'message' in payload && payload.detail === undefined
          ? { code: payload.code, message: payload.message }
          : payload,
    };
    if (core.domain.claude.currentGen !== undefined) env['gen'] = core.domain.claude.currentGen;
    const e = env as unknown as DomainEvent;
    core = { ...core, counters: { ...core.counters, event: seq }, domain: o.evolve(core.domain, e) };
    o.log.append([e]);
    fanOut([e]);
    try {
      o.hooks?.afterLocal?.(e);
    } catch {
      // trace only
    }
    runWatchers([e]);
    return e;
  }

  return {
    get core(): CoreState {
      return core;
    },
    get state(): Readonly<SessionState> {
      return core.domain;
    },
    setCore(c: CoreState): void {
      core = c;
    },
    observe(input: ObservationInput): Observation {
      const obs = o.queue.pushObservation(input);
      // A closed loop never steps again: late producers (hook worker, pollers racing the teardown) must not grow the queue
      // without bound (P-API-09). The observation is still stamped so seqs stay gap-free for anyone tracing it.
      if (closed) o.queue.clear();
      else kick();
      return obs;
    },
    dispatch(cmd: Command, at: MonoMs, wallAt: WallMs): Promise<unknown> {
      if (closed) return Promise.reject(new CcdError('E_SESSION_CLOSED', 'the session is closed'));
      return new Promise<unknown>((resolve, reject) => {
        const id = o.queue.pushCommand(cmd, at, wallAt);
        pendingCmds.set(id, { resolve, reject });
        kick();
      });
    },
    subscribe(listener: KernelListener, fromSeq?: EventSeq): Unsubscribe {
      const sub: Subscriber = { listener, pending: [], threw: false, active: true };
      if (fromSeq !== undefined) {
        const r = o.log.since(fromSeq);
        sub.pending = r.events;
        if (r.gap !== undefined) sub.gap = r.gap;
        trim(sub);
      }
      subs.add(sub);
      if (sub.pending.length > 0 || sub.gap !== undefined) scheduleFlush();
      return () => {
        sub.active = false;
        sub.pending = [];
        subs.delete(sub);
      };
    },
    watch(fn) {
      watchers.add(fn);
      return () => {
        watchers.delete(fn);
      };
    },
    publishLocal,
    kick,
    idle(): Promise<void> {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((r) => idleWaiters.push(r));
    },
    close(reason: string): void {
      if (closed) return;
      closed = true;
      const err = new CcdError('E_SESSION_CLOSED', `the session is closed (${reason})`);
      for (const it of o.queue.clear()) if (it.type === 'cmd') pendingCmds.get(it.cmdId)?.reject(err);
      for (const p of pendingCmds.values()) p.reject(err);
      pendingCmds.clear();
      notifyIdle();
    },
    get closed(): boolean {
      return closed;
    },
    stats,
  };
}
