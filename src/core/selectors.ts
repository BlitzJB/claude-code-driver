// core/selectors.ts — read-only views over core/domain state (DESIGN.md §1.2, §4.13). `api/**` may import this file only.

import type { AgentKey } from '../model/ids.js';
import type { PermissionRecord, SessionState, ToolRun, ToolState, TurnRecord } from '../model/state.js';
import type { MonoMs } from '../model/time.js';
import { isCallOpen, isToolTerminal } from './lattice.js';
import type { CoreState } from './types.js';

export interface CanSubmitOpts {
  forWake?: boolean;
  forSelfTest?: boolean;
}

/** Ordered clauses of canSubmit (§4.13); `whyNotSubmit` names the first false one (`E_BUSY{reason}`). */
const CLAUSES: readonly [string, (c: CoreState, o: CanSubmitOpts) => boolean][] = [
  ['notReady', (c, o) => (o.forSelfTest === true ? c.domain.lifecycle === 'selfTest' : c.domain.lifecycle === 'ready')],
  ['turnActive', (c) => c.domain.activeTurn === undefined],
  ['jobRunning', (c) => c.input.current === undefined],
  ['permission', (c) => !c.domain.inputBlocked.permission],
  ['dialog', (c) => !c.domain.inputBlocked.dialog],
  ['startup', (c) => !c.domain.inputBlocked.startup],
  ['copyMode', (c) => !c.domain.inputBlocked.copyMode],
  ['awaitingInput', (c) => !c.domain.inputBlocked.input],
  ['editorOpen', (c) => c.domain.inputBlocked.editor !== true],
  ['compacting', (c) => c.domain.compacting === undefined],
  ['authRequired', (c) => c.domain.auth.state === 'ok'],
  ['usageLimited', (c, o) => o.forWake === true || c.domain.usage.limit === undefined || c.domain.usage.limit.state === 'cleared'],
  ['exited', (c) => c.domain.exit === undefined],
];

/** The only predicate that lets the input-policy machine start a submit or command job (D-17, §4.13). */
export function canSubmit(c: CoreState, o: CanSubmitOpts = {}): boolean {
  return whyNotSubmit(c, o) === undefined;
}

export function whyNotSubmit(c: CoreState, o: CanSubmitOpts = {}): string | undefined {
  for (const [name, ok] of CLAUSES) if (!ok(c, o)) return name;
  return undefined;
}

export function currentTurn(d: SessionState): TurnRecord | undefined {
  return d.activeTurn === undefined ? undefined : d.turns[d.activeTurn];
}

export function lastTurn(d: SessionState): TurnRecord | undefined {
  for (let i = d.turnOrder.length - 1; i >= 0; i--) {
    const k = d.turnOrder[i];
    const t = k === undefined ? undefined : d.turns[k];
    if (t !== undefined && t.state.value !== 'queued' && t.state.value !== 'submitting' && t.mergedInto === undefined) return t;
  }
  return undefined;
}

/** Open permission records (pending | answered | dialogOnly), oldest first. */
export function pendingPermissions(d: SessionState): PermissionRecord[] {
  return Object.values(d.permissions)
    .filter((p) => p.state.value === 'pending' || p.state.value === 'answered' || p.state.value === 'dialogOnly')
    .sort((a, b) => a.requestedAt - b.requestedAt || (a.key < b.key ? -1 : 1));
}

/** §4.6 ToolRun: a `pending` tool older than 150 ms with no permission shows `running` (facades only; never a transition). */
export function displayToolState(tool: ToolRun, now: MonoMs): ToolState {
  if (tool.state.value === 'pending' && tool.permission === undefined && now - (tool.preAt ?? tool.startedAt) > 150) return 'running';
  return tool.state.value;
}

const BG_DONE = new Set(['completed', 'complete', 'done', 'failed', 'error', 'killed', 'stopped', 'cancelled', 'canceled', 'finished']);
export function isBgTaskOpen(status: string): boolean {
  return !BG_DONE.has(status.toLowerCase());
}

/** Running background agents (incl. teammates) and open background tasks not already counted through an agent. */
function runningBackground(d: SessionState): { agents: AgentKey[]; tasks: string[] } {
  const agents: AgentKey[] = [];
  const agentIds = new Set<string>();
  for (const a of Object.values(d.agents)) {
    if (a.background && a.state.value === 'running' && a.kind !== 'internal') {
      agents.push(a.key);
      agentIds.add(a.agentId);
    }
  }
  const tasks: string[] = [];
  for (const t of Object.values(d.bgTasks)) {
    if (isBgTaskOpen(t.status) && !agentIds.has(t.id) && (t.agent === undefined || !agents.includes(t.agent))) tasks.push(t.id);
  }
  return { agents, tasks };
}

/** §4.5.4: background count = max(last Stop background_tasks, turn_duration pending count, launched-not-stopped agents). */
export function backgroundCount(d: SessionState): number {
  const rb = runningBackground(d);
  const live = rb.agents.length + rb.tasks.length;
  const lt = lastTurn(d);
  let reported = 0;
  if (lt !== undefined) {
    const stillOpen = lt.backgroundPending.filter((id) => {
      const t = d.bgTasks[id];
      return t === undefined || isBgTaskOpen(t.status);
    });
    reported = stillOpen.length;
  }
  return Math.max(live, reported);
}

/**
 * Background subagents that stopped (SubagentStop) less than `graceMs` ago and whose `<task-notification>` turn has not been
 * seen yet. Claude delivers that notification right after the stop (live L-06: 38 ms later, docs/research/live-results.md
 * F-2), and its queue-operation enqueue reaches us through the transcript tail only after the hook, so without this the
 * session reads quiescent in between and a host that closes on quiescence cuts the notification turn off.
 */
export function awaitedNotifications(d: SessionState, now: number, graceMs: number): number {
  let n = 0;
  for (const a of Object.values(d.agents)) {
    if (!a.background || a.kind !== 'subagent' || a.state.value !== 'stopped' || a.notifications.length > 0) continue;
    if (a.endedAt !== undefined && now - a.endedAt < graceMs) n += 1;
  }
  return n;
}

/** quiescent = no active turn ∧ libraryQueue empty ∧ no running background agents/tasks ∧ no pending task notifications. */
export function isQuiescent(d: SessionState, pendingNotifications = 0): boolean {
  return d.activeTurn === undefined && d.libraryQueue.length === 0 && backgroundCount(d) === 0 && pendingNotifications <= 0;
}

/**
 * ICR 0041: why the session may not be suspended right now (empty = suspendable). A suspend must never cut off work or
 * leave a prompt unanswered, so every open record counts, background agents' permissions and questions included (the
 * derived status skips those). Order is stable; `E_BUSY{reason}` names the first entry.
 */
export function suspendBlockers(c: CoreState): string[] {
  const d = c.domain;
  const out: string[] = [];
  if (d.lifecycle !== 'ready') out.push('notReady');
  if (d.exit !== undefined) out.push('exited');
  if (d.status.kind !== 'idle') out.push(d.status.kind);
  else if (!d.status.quiescent) out.push('notQuiescent');
  if (d.activeTurn !== undefined || d.libraryQueue.length > 0) out.push('turn');
  if (pendingPermissions(d).length > 0) out.push('permission');
  if (Object.keys(d.pendingInputs).length > 0) out.push('awaitingInput');
  if (c.input.current !== undefined || c.input.order.length > 0) out.push('inputJob');
  const b = d.inputBlocked;
  if (b.permission || b.dialog || b.startup || b.copyMode || b.input || b.editor === true) out.push('composerBlocked');
  if (Object.values(d.calls).some((x) => isCallOpen(x.state.value))) out.push('modelCall');
  if (Object.values(d.tools).some((x) => !isToolTerminal(x.state.value))) out.push('tool');
  if (backgroundCount(d) > 0) out.push('background');
  if ((d.scheduledTasks ?? 0) > 0) out.push('scheduledTasks');
  if (d.usage.limit !== undefined && d.usage.limit.state !== 'cleared') out.push('usageLimited');
  if (d.auth.state !== 'ok') out.push('authRequired');
  if (d.compacting !== undefined) out.push('compacting');
  return [...new Set(out)];
}
