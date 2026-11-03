// core/lattice.ts — monotone status orders per entity and applyStatus() (DESIGN.md §4.2, RC §4.2).

import type { ObsSeq } from '../model/ids.js';
import type { Source } from '../model/observation.js';
import type { AgentState, CallState, Fact, PermState, ToolState, TurnState } from '../model/state.js';
import type { MonoMs } from '../model/time.js';
import { mkFact, rank } from './facts.js';

const TURN_ORDER: Readonly<Record<TurnState, number>> = {
  queued: 0,
  submitting: 1,
  running: 2,
  stopping: 3,
  completed: 4,
  failed: 4,
  interrupted: 4,
  withdrawn: 4,
  notSubmitted: 4,
  aborted: 4,
  unknown: 4,
};
const TOOL_ORDER: Readonly<Record<ToolState, number>> = {
  proposed: 0,
  pending: 1,
  awaitingPermission: 2,
  running: 3,
  launched: 4,
  succeeded: 5,
  failed: 5,
  denied: 5,
  interrupted: 5,
  unknown: 5,
};
const PERM_ORDER: Readonly<Record<PermState, number>> = { pending: 0, answered: 1, dialogOnly: 1, resolved: 2, abandoned: 2 };
const AGENT_ORDER: Readonly<Record<AgentState, number>> = { running: 0, stopped: 1, unknown: 1 };
const CALL_ORDER: Readonly<Record<CallState, number>> = {
  started: 0,
  waiting: 1,
  streaming: 1,
  retrying: 1,
  stalled: 1,
  ended: 2,
  aborted: 2,
  failed: 2,
  refused: 2,
  unknown: 2,
};

export type EntityKind = 'turn' | 'tool' | 'perm' | 'agent' | 'call';
interface StateOf {
  turn: TurnState;
  tool: ToolState;
  perm: PermState;
  agent: AgentState;
  call: CallState;
}
const ORDERS: { [K in EntityKind]: Readonly<Record<StateOf[K], number>> } = {
  turn: TURN_ORDER,
  tool: TOOL_ORDER,
  perm: PERM_ORDER,
  agent: AGENT_ORDER,
  call: CALL_ORDER,
};
const TERMINAL_LEVEL: Readonly<Record<EntityKind, number>> = { turn: 4, tool: 5, perm: 2, agent: 1, call: 2 };

export const isTurnTerminal = (s: TurnState): boolean => TURN_ORDER[s] >= 4;
export const isToolTerminal = (s: ToolState): boolean => TOOL_ORDER[s] >= 5;
export const isPermOpen = (s: PermState): boolean => s === 'pending' || s === 'answered' || s === 'dialogOnly';
export const isCallOpen = (s: CallState): boolean => CALL_ORDER[s] < 2;

export type ApplyVerdict = 'apply' | 'resolvedLate' | 'retract' | 'ignore';

export interface ApplyResult<S> {
  verdict: ApplyVerdict;
  fact: Fact<S>;
}

/**
 * §4.2: apply iff order(next) > order(cur), or cur==='unknown' and next is a concrete terminal (resolvedLate), or both
 * terminal and next comes from a strictly higher-ranked source than cur while cur was provisional (retract). Call states of
 * order 1 are mutually updatable. Everything else is ignored (the caller counts it).
 */
export function applyStatus<K extends EntityKind>(
  kind: K,
  cur: Fact<StateOf[K]>,
  next: StateOf[K],
  src: Source,
  seq: ObsSeq,
  at: MonoMs,
  provisional = false,
): ApplyResult<StateOf[K]> {
  const order = ORDERS[kind];
  const term = TERMINAL_LEVEL[kind];
  const oc = order[cur.value];
  const on = order[next];
  const nf = mkFact(next, src, seq, at, provisional);
  if (cur.value === next) {
    if (cur.provisional && !provisional)
      return { verdict: 'apply', fact: { ...cur, provisional: false, src, corroborated: [...cur.corroborated, cur.src] } };
    return { verdict: 'ignore', fact: cur };
  }
  if (on > oc) return { verdict: 'apply', fact: nf };
  if (kind === 'call' && oc === 1 && on === 1) return { verdict: 'apply', fact: nf };
  // A refusal retracts a call whose stream already ended normally (§4.5.10, K-41: "call refused"): `ended → refused` is the
  // one terminal-to-terminal call move. WP-INT fix (docs/icr/0016-wp-int.md).
  if (kind === 'call' && cur.value === 'ended' && next === 'refused') return { verdict: 'retract', fact: nf };
  if (oc >= term && on >= term) {
    if (cur.value === 'unknown' && next !== 'unknown') return { verdict: 'resolvedLate', fact: nf };
    if (cur.provisional && rank(src) > rank(cur.src)) return { verdict: 'retract', fact: nf };
  }
  return { verdict: 'ignore', fact: cur };
}
