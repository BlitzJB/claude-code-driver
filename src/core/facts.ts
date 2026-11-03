// core/facts.ts — authority ranks, Fact<T> helpers, mergeFact, Claim and Deadline shapes (DESIGN.md §4.1, RC §4.1).

import { stableStringify } from '../model/json.js';
import type { JsonValue } from '../model/json.js';
import type { ObsSeq } from '../model/ids.js';
import type { Source } from '../model/observation.js';
import type { Fact } from '../model/state.js';
import type { MonoMs } from '../model/time.js';

/** Authority rank per source (higher wins). §4.1 */
export const RANK: Readonly<Record<Source, number>> = Object.freeze({
  self: 0,
  clock: 0,
  channel: 0,
  screen: 1,
  registry: 2,
  network: 3,
  transcript: 4,
  hook: 5,
  process: 6,
});

export function rank(s: Source): number {
  return RANK[s];
}

export interface Claim {
  key: string;
  value: JsonValue;
  firstSeenSeq: ObsSeq;
  stableSince: MonoMs;
  frames: number;
  expiresAt: MonoMs;
  status: 'candidate' | 'asserted' | 'confirmed' | 'retracted' | 'expired';
  /** `at` of the last frame that still showed this claim (WP-09 bookkeeping). */
  lastSeenAt: MonoMs;
}

export type DeadlineKind =
  | 'startupHookGrace'
  | 'startup'
  | 'readyStable'
  | 'settle'
  | 'submitAck'
  | 'editorConsume'
  | 'escGap'
  | 'keyGap'
  | 'dialogSettle'
  | 'interruptConfirm'
  | 'stopGrace'
  | 'lateText'
  | 'transcriptSettle'
  | 'permBindLate'
  | 'hookGap'
  | 'stall'
  | 'quiet'
  | 'claimTtl'
  | 'genImplicitConfirm'
  | 'interruptedHold'
  | 'drain'
  | 'hostResumeGrace'
  | 'permissionPolicy'
  | 'adoptDialog'
  | 'modalEffect'
  | 'usageWake'; /* the only wall-clock kind */

export interface Deadline {
  id: string;
  clock: 'mono' | 'wall';
  at: number /* MonoMs or WallMs per clock */;
  kind: DeadlineKind;
  ref: string;
}

export function mkFact<T>(value: T, src: Source, seq: ObsSeq, at: MonoMs, provisional = false): Fact<T> {
  return { value, src, seq, at, corroborated: [], provisional };
}

export function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

export interface MergeResult<T> {
  fact: Fact<T>;
  /** the stored value changed */
  changed: boolean;
  /** corroboration or provisional → confirmed upgrade (no value change) */
  corroborated: boolean;
  /** a confirmed value was replaced, or a lower rank disagreed (counted in recon.conflicts) */
  conflict?: string;
}

/**
 * RC §4.1: same value → corroborate (and upgrade provisional → confirmed when a higher source agrees); different value →
 * replace only if rank(next) > rank(cur.src) or same rank and newer seq; a confirmed value replaced is a conflict; a lower
 * rank disagreeing keeps the old value and is counted. `authorityFloor`: sources ranked below it make provisional facts.
 */
export function mergeFact<T>(
  cur: Fact<T> | undefined,
  value: T,
  src: Source,
  seq: ObsSeq,
  at: MonoMs,
  authorityFloor: number,
  eq: (a: T, b: T) => boolean = jsonEq,
): MergeResult<T> {
  const provisional = rank(src) < authorityFloor;
  if (cur === undefined) return { fact: mkFact(value, src, seq, at, provisional), changed: true, corroborated: false };
  if (eq(cur.value, value)) {
    if (cur.src === src && !(cur.provisional && !provisional)) return { fact: cur, changed: false, corroborated: false };
    const corroborated = cur.corroborated.includes(src) || cur.src === src ? cur.corroborated : [...cur.corroborated, src];
    const upgrade = cur.provisional && !provisional;
    const fact: Fact<T> = upgrade
      ? { ...cur, src: rank(src) > rank(cur.src) ? src : cur.src, corroborated, provisional: false }
      : { ...cur, corroborated };
    return { fact, changed: false, corroborated: true };
  }
  const higher = rank(src) > rank(cur.src);
  const sameNewer = rank(src) === rank(cur.src) && seq >= cur.seq;
  if (higher || sameNewer) {
    const conflict = cur.provisional ? undefined : `${cur.src}->${src}`;
    const fact = mkFact(value, src, seq, at, provisional);
    return conflict === undefined ? { fact, changed: true, corroborated: false } : { fact, changed: true, corroborated: false, conflict };
  }
  return { fact: cur, changed: false, corroborated: false, conflict: `${src}<${cur.src}` };
}
