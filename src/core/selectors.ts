// core/selectors.ts — read-only views over core/domain state (DESIGN.md §1.2, §4.13). `api/**` may import this file only.

import type { AgentKey } from '../model/ids.js';
import type { PermissionRecord, SessionState, ToolRun, ToolState, TurnRecord } from '../model/state.js';
import type { MonoMs } from '../model/time.js';
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
