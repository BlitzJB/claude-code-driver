// core/evolve.ts — evolve(domain, coreEvent) → domain: the ONLY writer of `domain` (DESIGN.md §2.9 I1, rev 2 §10 B2).
// decide/* and closing.ts describe every change as a CoreEvent; `step` folds them here. Copy-on-write along the path, so
// earlier snapshots handed to listeners never change (structural sharing).

import type { CoreEvent } from '../model/events.js';
import type { JsonValue } from '../model/json.js';
import type { SessionState } from '../model/state.js';

/** `x.patch.patch` shape used by this core: set a value at the entity path, or remove the key. */
export type PatchOp = { op: 'set'; value: JsonValue; why?: string } | { op: 'unset'; why?: string };

/** Path segments are joined with '/', escaped JSON-pointer style ('~' → '~0', '/' → '~1'). */
export function encodePath(segs: readonly string[]): string {
  return segs.map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}
export function decodePath(path: string): string[] {
  if (path === '') return [];
  return path.split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function setIn(base: unknown, segs: readonly string[], i: number, value: unknown, unset: boolean): unknown {
  if (i === segs.length) return value;
  const k = segs[i] ?? '';
  const src: Obj = isObj(base) ? base : {};
  const copy: Obj = { ...src };
  if (unset && i === segs.length - 1) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- unset at a computed path is the point of this helper
    delete copy[k];
    return copy;
  }
  copy[k] = setIn(src[k], segs, i + 1, value, unset);
  return copy;
}

function isPatchOp(v: JsonValue): v is PatchOp {
  return isObj(v) && (v['op'] === 'set' || v['op'] === 'unset');
}

export function evolve(domain: SessionState, e: CoreEvent): SessionState {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- all other DomainEvents only advance lastEventSeq
  switch (e.type) {
    case 'x.patch': {
      const segs = decodePath(e.entity);
      if (segs.length === 0 || !isPatchOp(e.patch)) return domain;
      const p = e.patch;
      return setIn(domain, segs, 0, p.op === 'set' ? p.value : undefined, p.op === 'unset') as SessionState;
    }
    case 'x.fact': {
      const segs = decodePath(e.path);
      if (segs.length === 0) return domain;
      return setIn(domain, segs, 0, e.fact, false) as SessionState;
    }
    case 'x.provenance': {
      const segs = decodePath(e.entity);
      if (segs.length === 0) return domain;
      return setIn(domain, [...segs, 'provenance'], 0, e.provenance, false) as SessionState;
    }
    case 'x.inputBlocked':
      return { ...domain, inputBlocked: e.value };
    case 'x.lifecycle':
      return { ...domain, lifecycle: e.phase };
    case 'status.changed':
      return { ...domain, status: e.payload.to, lastEventSeq: e.seq };
    default:
      // Every published DomainEvent advances lastEventSeq; their state effects travel as x.* events next to them.
      return { ...domain, lastEventSeq: e.seq };
  }
}

/** I1 helper: fold a stream of core events over a domain. */
export function foldEvents(domain: SessionState, events: readonly CoreEvent[]): SessionState {
  let d = domain;
  for (const e of events) d = evolve(d, e);
  return d;
}
