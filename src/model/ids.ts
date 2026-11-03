// model/ids.ts — branded keys (DESIGN.md §2.1, D-05). Imports nothing.

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type SessionKey = Brand<string, 'SessionKey'>; // 's' + 8 hex, minted by L3 (random OK outside core)
export type GenKey = Brand<string, 'GenKey'>; // 'g1', 'g2' … one per Claude session_id seen in this pane
export type TurnKey = Brand<string, 'TurnKey'>; // 't1' …
export type ToolKey = Brand<string, 'ToolKey'>; // 'u1' …
export type AgentKey = Brand<string, 'AgentKey'>; // 'a1' …   (public alias SubagentKey)
export type PermissionKey = Brand<string, 'PermissionKey'>; // 'p1' …
export type ModelCallKey = Brand<string, 'ModelCallKey'>; // 'c1' …
export type MsgKey = Brand<string, 'MsgKey'>; // 'm1' …
export type InputJobKey = Brand<string, 'InputJobKey'>; // 'j1' …
export type ObsSeq = Brand<number, 'ObsSeq'>; // L3 queue, strictly increasing, gap-free per session
export type EventSeq = Brand<number, 'EventSeq'>; // core, gap-free per session
export type IntentId = Brand<number, 'IntentId'>; // core counter
export type HookSeq = Brand<number, 'HookSeq'>; // L0 hook transport counter
export const KEY_RE = {
  turn: /^t\d+$/,
  tool: /^u\d+$/,
  agent: /^a\d+$/,
  perm: /^p\d+$/,
  call: /^c\d+$/,
  msg: /^m\d+$/,
  job: /^j\d+$/,
  gen: /^g\d+$/,
} as const;
