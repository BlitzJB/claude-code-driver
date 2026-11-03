// session/loop.ts — single serialized loop, no re-entrancy, isolated listeners, bounded fan-out with gap
// (AL §4.6 L-1/L-6; P-API-05, P-API-06, P-API-09). `step` is stubbed (§8 WP-11: "step stubbed in tests").
import { describe, expect, it } from 'vitest';
import { evolve } from '../../../src/core/evolve.js';
import { initialCore } from '../../../src/core/step.js';
import type { CoreInput, CoreState, StepResult } from '../../../src/core/step.js';
import type { DomainEvent } from '../../../src/model/events.js';
import type { EventSeq } from '../../../src/model/ids.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { testCoreInit } from '../../../src/testing/core-config.js';
import { createEventLog } from '../../../src/session/event-log.js';
import { createStepLoop } from '../../../src/session/loop.js';
import type { StepLoopOptions } from '../../../src/session/loop.js';
import { createInputQueue } from '../../../src/session/queue.js';

const flush = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A stub core step: one `warning` event per input, carrying the input kind; commands succeed with their type. */
function stubStep(log: string[] = []): (c: CoreState, i: CoreInput) => StepResult {
  return (c, i) => {
    const seq = (c.counters.event + 1) as EventSeq;
    const label = i.type === 'obs' ? i.obs.kind : i.cmd.type;
    log.push(label);
    const e = {
      v: 1,
      seq,
      type: 'warning',
      at: c.now,
      wallAt: c.wallNow,
      sessionKey: c.domain.sessionKey,
      provenance: { confirmed: true, sources: ['self'] },
      causedBy: i.type === 'obs' ? [i.obs.meta.seq] : [],
      payload: { code: 'E_INVARIANT', message: label },
    } as unknown as DomainEvent;
    const core = { ...c, counters: { ...c.counters, event: seq }, domain: evolve(c.domain, e) };
    const r: StepResult = { core, events: [e], intents: [], diagnostics: [] };
    if (i.type === 'cmd') {
      if (i.cmd.type === 'usage.wakeNow')
        r.commandResult = { cmdId: i.cmdId, ok: false, error: { code: 'E_BUSY', message: 'busy', details: { reason: 'x' } } };
      else r.commandResult = { cmdId: i.cmdId, ok: true, value: { echoed: i.cmd.type } };
    }
    return r;
  };
}

function mk(over: Partial<StepLoopOptions> = {}) {
  const log = createEventLog({ capacity: over.log?.capacity ?? 1000 });
  const queue = createInputQueue();
  const loop = createStepLoop({ core: initialCore(testCoreInit()), step: stubStep(), evolve, queue, log, ...over });
  return { loop, log, queue };
}
const tick = { kind: 'clock.tick', meta: { at: 1 as MonoMs, wallAt: 1 as WallMs, source: 'clock' }, p: {} } as const;

describe('step loop', () => {
  it('steps inputs one at a time in FIFO order, on a microtask (never inline)', async () => {
    const order: string[] = [];
    const { loop } = mk({ step: stubStep(order) });
    loop.observe(tick);
    loop.observe({ ...tick, kind: 'clock.hostResumed', p: { monoGapMs: 0, wallGapMs: 9000 } });
    expect(order).toEqual([]); // nothing ran inline
    await loop.idle();
    expect(order).toEqual(['clock.tick', 'clock.hostResumed']);
    expect(loop.state.lastEventSeq).toBe(2);
    expect(loop.stats.steps).toBe(2);
  });

  it('dispatch resolves with the command result value and rejects with a CcdError', async () => {
    const { loop } = mk();
    await expect(loop.dispatch({ type: 'interrupt' }, 0 as MonoMs, 0 as WallMs)).resolves.toEqual({ echoed: 'interrupt' });
    await expect(loop.dispatch({ type: 'usage.wakeNow' }, 0 as MonoMs, 0 as WallMs)).rejects.toMatchObject({
      name: 'CcdError',
      code: 'E_BUSY',
      details: { reason: 'x' },
    });
  });

  it('a dispatch from inside a listener is enqueued, not run re-entrantly (P-API-05)', async () => {
    const order: string[] = [];
    const { loop } = mk({ step: stubStep(order) });
    let inListener = false;
    let dispatched: Promise<unknown> | undefined;
    loop.subscribe(() => {
      if (dispatched !== undefined) return;
      inListener = true;
      dispatched = loop.dispatch({ type: 'interrupt' }, 0 as MonoMs, 0 as WallMs);
      expect(order).toEqual(['clock.tick']); // not yet stepped
      inListener = false;
    });
    loop.observe(tick);
    await flush();
    expect(inListener).toBe(false);
    await dispatched;
    expect(order).toEqual(['clock.tick', 'interrupt']);
  });

  it('a throwing listener is isolated, others still run, one E_LISTENER_THREW warning (P-API-06)', async () => {
    const { loop } = mk();
    const good: number[] = [];
    loop.subscribe(() => {
      throw new TypeError('bug');
    });
    loop.subscribe((b) => good.push(...b.events.map((e) => e.seq)));
    loop.observe(tick);
    await flush();
    loop.observe(tick);
    await flush();
    const warnings: DomainEvent[] = [];
    loop.subscribe((b) => warnings.push(...b.events), 0 as EventSeq);
    await flush();
    const threw = warnings.filter((e) => e.type === 'warning' && e.payload.code === 'E_LISTENER_THREW');
    expect(threw).toHaveLength(1);
    expect(threw[0]?.payload).toMatchObject({ detail: { error: 'TypeError' } });
    expect(good).toContain(1);
    expect(good).toContain(3);
    expect(loop.stats.listenerErrors).toBe(3); // tick 1, the warning batch itself, tick 2: counted, reported once
  });

  it('publishLocal uses the core event seq and evolve (I1 holds)', async () => {
    const { loop, log } = mk();
    loop.observe(tick);
    await loop.idle();
    const e = loop.publishLocal('warning', { code: 'E_HOST_LOOP_LAG', message: 'x', detail: { a: 1 } });
    expect(e?.seq).toBe(2);
    expect(loop.core.counters.event).toBe(2);
    expect(loop.state.lastEventSeq).toBe(2);
    expect(log.lastSeq).toBe(2);
    loop.observe(tick);
    await loop.idle();
    expect(log.lastSeq).toBe(3);
  });

  it('subscribe fromSeq replays the ring; lost history is reported as gap (K-24 shape)', async () => {
    const { loop } = mk({ log: createEventLog({ capacity: 3 }) });
    for (let i = 0; i < 6; i++) loop.observe(tick);
    await loop.idle();
    const batches: { seqs: number[]; gap?: { from: number; to: number } }[] = [];
    loop.subscribe(
      (b) => batches.push(b.gap === undefined ? { seqs: b.events.map((e) => e.seq) } : { seqs: b.events.map((e) => e.seq), gap: b.gap }),
      1 as EventSeq,
    );
    await flush();
    expect(batches[0]).toEqual({ seqs: [4, 5, 6], gap: { from: 1, to: 3 } });
  });

  it('a subscriber buffer above maxPendingEvents drops the oldest and carries the gap (memory bounded, P-API-09)', async () => {
    const batches: { n: number; gap?: { from: number; to: number } }[] = [];
    const { loop } = mk({ maxPendingEvents: 4 });
    loop.subscribe((b) => batches.push(b.gap === undefined ? { n: b.events.length } : { n: b.events.length, gap: b.gap }));
    for (let i = 0; i < 10; i++) loop.observe(tick);
    await flush();
    expect(batches[0]).toEqual({ n: 4, gap: { from: 1, to: 6 } });
    expect(loop.stats.droppedForSlowSubscribers).toBe(6);
  });

  it('a long backlog yields to the event loop between slices', async () => {
    const yields: number[] = [];
    let pendingYield: (() => void) | undefined;
    const { loop } = mk({
      stepsPerSlice: 3,
      yieldTask: (fn) => {
        yields.push(1);
        pendingYield = fn;
      },
    });
    for (let i = 0; i < 7; i++) loop.observe(tick);
    await flush();
    expect(loop.stats.steps).toBe(3);
    pendingYield?.();
    expect(loop.stats.steps).toBe(6);
    pendingYield?.();
    expect(loop.stats.steps).toBe(7);
    expect(yields).toHaveLength(2);
  });

  it('a throwing step drops that input with a diagnostic and fails its command (the loop survives)', async () => {
    const diags: string[] = [];
    let n = 0;
    const { loop } = mk({
      step: (c, i) => {
        n++;
        if (n === 1) throw new Error('core bug');
        return stubStep()(c, i);
      },
      hooks: { afterStep: (r) => diags.push(...r.diagnostics.map((d) => d.code)) },
    });
    await expect(loop.dispatch({ type: 'interrupt' }, 0 as MonoMs, 0 as WallMs)).rejects.toMatchObject({ code: 'E_INVARIANT' });
    await expect(loop.dispatch({ type: 'interrupt' }, 0 as MonoMs, 0 as WallMs)).resolves.toEqual({ echoed: 'interrupt' });
    expect(diags).toEqual(['step_threw']);
    expect(loop.stats.stepErrors).toBe(1);
  });

  it('watchers see every committed step synchronously; hooks see items and results', async () => {
    const seen: number[] = [];
    const before: string[] = [];
    const { loop } = mk({ hooks: { beforeStep: (it) => before.push(it.type) } });
    loop.watch((s) => seen.push(s.lastEventSeq));
    loop.observe(tick);
    void loop.dispatch({ type: 'interrupt' }, 0 as MonoMs, 0 as WallMs);
    await loop.idle();
    expect(seen).toEqual([1, 2]);
    expect(before).toEqual(['obs', 'cmd']);
  });

  it('close() rejects pending and future commands with E_SESSION_CLOSED and stops stepping', async () => {
    const order: string[] = [];
    const { loop } = mk({ step: stubStep(order) });
    const p = loop.dispatch({ type: 'interrupt' }, 0 as MonoMs, 0 as WallMs);
    loop.close('test');
    await expect(p).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    await expect(loop.dispatch({ type: 'interrupt' }, 0 as MonoMs, 0 as WallMs)).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    loop.observe(tick);
    await flush();
    expect(order).toEqual([]);
    expect(loop.closed).toBe(true);
    expect(loop.publishLocal('warning', { code: 'E_INVARIANT', message: 'x' })).toBeUndefined();
  });

  it('observations after close() are discarded, never queued (memory stays bounded, P-API-09)', async () => {
    const { loop, queue } = mk();
    loop.close('test');
    for (let i = 0; i < 1000; i++) loop.observe(tick);
    expect(queue.size).toBe(0);
    // still stamped gap-free (a late producer's trace stays consistent)
    expect(loop.observe(tick).meta.seq).toBe(1001);
    await expect(loop.idle()).resolves.toBeUndefined();
  });

  it('unsubscribe stops delivery; setCore swaps the core between steps', async () => {
    const { loop } = mk();
    const got: number[] = [];
    const off = loop.subscribe((b) => got.push(b.events.length));
    off();
    loop.observe(tick);
    await flush();
    expect(got).toEqual([]);
    const fresh = initialCore(testCoreInit());
    loop.setCore({ ...fresh, counters: { ...fresh.counters, event: 100 } });
    loop.observe(tick);
    await loop.idle();
    expect(loop.state.lastEventSeq).toBe(101);
  });
});
