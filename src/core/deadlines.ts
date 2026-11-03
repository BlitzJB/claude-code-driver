// core/deadlines.ts — the deadline table: arm/clear, nextDeadline(core), due list (DESIGN.md §4.10, D-03).
// Every decision timer lives here; L3 runs exactly one timer at nextDeadline(core) (mono, or wall via ≤ 30 s re-checks).

import type { MonoMs, WallMs } from '../model/time.js';
import type { Deadline, DeadlineKind } from './facts.js';
import type { CoreState, NextDeadline, ReconState } from './types.js';

function deadlineId(kind: DeadlineKind, ref: string): string {
  return `${kind}:${ref}`;
}

export function armDeadline(recon: ReconState, kind: DeadlineKind, ref: string, at: number, clock: 'mono' | 'wall' = 'mono'): ReconState {
  const id = deadlineId(kind, ref);
  const d: Deadline = { id, clock, at, kind, ref };
  return { ...recon, deadlines: { ...recon.deadlines, [id]: d } };
}

export function clearDeadline(recon: ReconState, kind: DeadlineKind, ref: string): ReconState {
  const id = deadlineId(kind, ref);
  if (!(id in recon.deadlines)) return recon;
  const { [id]: _gone, ...rest } = recon.deadlines;
  return { ...recon, deadlines: rest };
}

export function clearDeadlinesWhere(recon: ReconState, pred: (d: Deadline) => boolean): ReconState {
  const kept: Record<string, Deadline> = {};
  let changed = false;
  for (const [id, d] of Object.entries(recon.deadlines)) {
    if (pred(d)) changed = true;
    else kept[id] = d;
  }
  return changed ? { ...recon, deadlines: kept } : recon;
}

function byAtId(a: Deadline, b: Deadline): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Due deadlines in `(at, id)` order: mono ones with at ≤ now, then wall ones with at ≤ wallNow (§2.9 step order (2)). */
export function dueDeadlines(recon: ReconState, now: MonoMs, wallNow: WallMs): Deadline[] {
  const all = Object.values(recon.deadlines);
  const mono = all.filter((d) => d.clock === 'mono' && d.at <= now).sort(byAtId);
  const wall = all.filter((d) => d.clock === 'wall' && d.at <= wallNow).sort(byAtId);
  return [...mono, ...wall];
}

/** §2.9: the earliest mono deadline and, separately, the earliest wall deadline (usageWake). */
export function nextDeadline(core: CoreState): NextDeadline {
  let atMono: number | undefined;
  let atWall: number | undefined;
  for (const d of Object.values(core.recon.deadlines)) {
    if (d.clock === 'mono') atMono = atMono === undefined ? d.at : Math.min(atMono, d.at);
    else atWall = atWall === undefined ? d.at : Math.min(atWall, d.at);
  }
  const r: NextDeadline = {};
  if (atMono !== undefined) r.atMono = atMono as MonoMs;
  if (atWall !== undefined) r.atWall = atWall as WallMs;
  return r;
}
