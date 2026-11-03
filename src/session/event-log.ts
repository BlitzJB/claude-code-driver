// session/event-log.ts — ring buffer of published DomainEvents + optional JSONL sink + replay from a seq
// (DESIGN.md §1.2, §2.10 `subscribe(…, {fromSeq})`; AL §4.6 L-6; P-API-09).
//
// The ring keeps the last `retainEvents` events (ResolvedConfig.debug.retainEvents, default 10 000). `since(fromSeq)` returns
// every retained event with seq ≥ fromSeq and, when some of the requested range has already fallen out of the ring, the
// lost range as `gap` — losing data silently is never allowed (L-6). Memory is bounded by the ring capacity.

import type { DomainEvent } from '../model/events.js';
import type { EventSeq } from '../model/ids.js';

export interface EventLogOptions {
  capacity: number;
  /** Called for every appended event, in order (e.g. the debug trace's `event` records). Must not throw; errors are swallowed. */
  sink?: (e: DomainEvent) => void;
}

export interface EventLog {
  append(events: readonly DomainEvent[]): void;
  /** Events with seq ≥ fromSeq still retained, plus the lost range if part of it was evicted. */
  since(fromSeq: EventSeq): { events: DomainEvent[]; gap?: { from: EventSeq; to: EventSeq } };
  /** Highest seq appended (0 before any). */
  readonly lastSeq: EventSeq;
  /** Lowest retained seq (undefined when empty). */
  readonly firstRetained: EventSeq | undefined;
  readonly size: number;
  readonly capacity: number;
  /** Events evicted from the ring so far. */
  readonly evicted: number;
}

export function createEventLog(o: EventLogOptions): EventLog {
  const capacity = Math.max(1, Math.floor(o.capacity));
  const ring: (DomainEvent | undefined)[] = new Array<DomainEvent | undefined>(capacity);
  let start = 0; // index of the oldest retained event
  let count = 0;
  let lastSeq = 0;
  let evicted = 0;

  const at = (i: number): DomainEvent => {
    const e = ring[(start + i) % capacity];
    if (e === undefined) throw new RangeError('event-log: index outside the retained range');
    return e;
  };

  return {
    append(events: readonly DomainEvent[]): void {
      for (const e of events) {
        if (count < capacity) {
          ring[(start + count) % capacity] = e;
          count++;
        } else {
          ring[start] = e;
          start = (start + 1) % capacity;
          evicted++;
        }
        if (e.seq > lastSeq) lastSeq = e.seq;
        if (o.sink !== undefined) {
          try {
            o.sink(e);
          } catch {
            // the sink is best effort (debug trace); it never breaks the loop
          }
        }
      }
    },
    since(fromSeq: EventSeq): { events: DomainEvent[]; gap?: { from: EventSeq; to: EventSeq } } {
      const from = Math.max(1, Math.floor(fromSeq));
      const out: DomainEvent[] = [];
      if (count === 0) {
        if (from <= lastSeq) return { events: out, gap: { from: from as EventSeq, to: lastSeq as EventSeq } };
        return { events: out };
      }
      const first = at(0).seq;
      // binary search for the first retained index with seq ≥ from (seqs are increasing)
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (at(mid).seq < from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < count; i++) out.push(at(i));
      if (from < first) return { events: out, gap: { from: from as EventSeq, to: (first - 1) as EventSeq } };
      return { events: out };
    },
    get lastSeq(): EventSeq {
      return lastSeq as EventSeq;
    },
    get firstRetained(): EventSeq | undefined {
      return count === 0 ? undefined : at(0).seq;
    },
    get size(): number {
      return count;
    },
    capacity,
    get evicted(): number {
      return evicted;
    },
  };
}
