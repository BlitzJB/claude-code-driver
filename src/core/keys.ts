// core/keys.ts — deterministic session-scoped counters → library keys (DESIGN.md D-05, §2.1).

import type { AgentKey, GenKey, InputJobKey, ModelCallKey, MsgKey, PermissionKey, ToolKey, TurnKey } from '../model/ids.js';
import type { Counters } from './types.js';

export type KeyKind = 'gen' | 'turn' | 'tool' | 'agent' | 'perm' | 'call' | 'msg' | 'job';

export interface KeyOf {
  gen: GenKey;
  turn: TurnKey;
  tool: ToolKey;
  agent: AgentKey;
  perm: PermissionKey;
  call: ModelCallKey;
  msg: MsgKey;
  job: InputJobKey;
}

const PREFIX: Readonly<Record<KeyKind, string>> = { gen: 'g', turn: 't', tool: 'u', agent: 'a', perm: 'p', call: 'c', msg: 'm', job: 'j' };

export function nextKey<K extends KeyKind>(counters: Counters, kind: K): [KeyOf[K], Counters] {
  const n = counters[kind] + 1;
  return [`${PREFIX[kind]}${n}` as KeyOf[K], { ...counters, [kind]: n }];
}

export function initialCounters(): Counters {
  return { gen: 0, turn: 0, tool: 0, agent: 0, perm: 0, call: 0, msg: 0, job: 0, intent: 0, event: 0, input: 0 };
}
