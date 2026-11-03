// session/queue.ts + session/event-log.ts — seq stamping without de-duplication (D-42, P-REV-11); ring + gap (P-API-09).
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../../src/model/events.js';
import type { EventSeq } from '../../../src/model/ids.js';
import type { ObservationInput } from '../../../src/model/observation.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { createEventLog } from '../../../src/session/event-log.js';
import { createInputQueue } from '../../../src/session/queue.js';

const tick = (at = 0): ObservationInput => ({
  kind: 'clock.tick',
  meta: { at: at as MonoMs, wallAt: (1000 + at) as WallMs, source: 'clock' },
  p: {},
});

describe('input queue', () => {
  it('stamps strictly increasing, gap-free seqs in arrival order and never mutates the input', () => {
    const q = createInputQueue();
    const a = tick(1);
    const o1 = q.pushObservation(a);
    const o2 = q.pushObservation(tick(2));
    expect(o1.meta.seq).toBe(1);
    expect(o2.meta.seq).toBe(2);
    expect('seq' in a.meta).toBe(false);
    expect(q.nextSeq).toBe(3);
  });

  it('keeps identical observations (no de-dup window, D-42)', () => {
    const q = createInputQueue();
    const same = tick(5);
    for (let i = 0; i < 3; i++) q.pushObservation(same);
    expect(q.size).toBe(3);
    const seqs = [q.shift(), q.shift(), q.shift()].map((x) => (x?.type === 'obs' ? x.obs.meta.seq : -1));
    expect(seqs).toEqual([1, 2, 3]);
    expect(q.shift()).toBeUndefined();
  });

  it('commands share the FIFO with observations and get their own ids', () => {
    const q = createInputQueue({ firstCmdId: 10 });
    q.pushObservation(tick());
    const id = q.pushCommand({ type: 'interrupt' }, 1 as MonoMs, 2 as WallMs);
    q.pushObservation(tick());
    expect(id).toBe(10);
    expect(q.shift()?.type).toBe('obs');
    const c = q.shift();
    expect(c).toMatchObject({ type: 'cmd', cmdId: 10, at: 1, wallAt: 2 });
    expect(q.shift()?.type).toBe('obs');
    expect(q.stats).toMatchObject({ observations: 2, commands: 1 });
  });

  it('reports a backlog once per crossing of the high-water mark and compacts', () => {
    const hits: number[] = [];
    const q = createInputQueue({ highWater: 2000, onHighWater: (n) => hits.push(n) });
    for (let i = 0; i < 2500; i++) q.pushObservation(tick(i));
    expect(hits).toEqual([2000]);
    for (let i = 0; i < 2400; i++) q.shift();
    expect(q.size).toBe(100);
    for (let i = 0; i < 1950; i++) q.pushObservation(tick(i));
    expect(hits).toEqual([2000, 2000]);
    expect(q.stats.maxSize).toBe(2500);
    let n = 0;
    while (q.shift() !== undefined) n++;
    expect(n).toBe(2050);
  });

  it('clear() returns queued items, commands first', () => {
    const q = createInputQueue();
    q.pushObservation(tick());
    q.pushCommand({ type: 'usage.wakeNow' }, 0 as MonoMs, 0 as WallMs);
    const dropped = q.clear();
    expect(dropped.map((d) => d.type)).toEqual(['cmd', 'obs']);
    expect(q.size).toBe(0);
  });
});

const ev = (seq: number): DomainEvent =>
  ({
    v: 1,
    seq: seq as EventSeq,
    type: 'warning',
    at: 0 as MonoMs,
    wallAt: 0 as WallMs,
    sessionKey: 's1',
    provenance: { confirmed: true, sources: ['self'] },
    causedBy: [],
    payload: { code: 'E_INVARIANT', message: String(seq) },
  }) as unknown as DomainEvent;

describe('event log', () => {
  it('retains the last N events, replays from a seq and reports the lost range as gap', () => {
    const log = createEventLog({ capacity: 4 });
    log.append([1, 2, 3, 4, 5, 6].map(ev));
    expect(log.size).toBe(4);
    expect(log.evicted).toBe(2);
    expect(log.firstRetained).toBe(3);
    expect(log.lastSeq).toBe(6);
    const all = log.since(1 as EventSeq);
    expect(all.events.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(all.gap).toEqual({ from: 1, to: 2 });
    const tail = log.since(5 as EventSeq);
    expect(tail.events.map((e) => e.seq)).toEqual([5, 6]);
    expect(tail.gap).toBeUndefined();
    expect(log.since(7 as EventSeq).events).toEqual([]);
  });

  it('empty log: no gap for future seqs, a gap for seqs already published but not retained', () => {
    const log = createEventLog({ capacity: 1 });
    expect(log.since(1 as EventSeq)).toEqual({ events: [] });
    expect(log.firstRetained).toBeUndefined();
  });

  it('memory is bounded by the capacity regardless of volume', () => {
    const log = createEventLog({ capacity: 16 });
    for (let i = 1; i <= 10_000; i++) log.append([ev(i)]);
    expect(log.size).toBe(16);
    expect(log.since(0 as EventSeq).events).toHaveLength(16);
  });

  it('feeds the sink in order and swallows sink errors', () => {
    const seen: number[] = [];
    const log = createEventLog({
      capacity: 8,
      sink: (e) => {
        seen.push(e.seq);
        if (e.seq === 2) throw new Error('sink down');
      },
    });
    log.append([1, 2, 3].map(ev));
    expect(seen).toEqual([1, 2, 3]);
    expect(log.lastSeq).toBe(3);
  });
});
