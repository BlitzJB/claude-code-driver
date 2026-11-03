// core/closing.ts — closing rules, applied in order (DESIGN.md §4.8, RC §6). Nothing open ever outlives its container
// without a reason; timeouts never invent concrete outcomes (D-06): closed-by-rule entities become `unknown`.

import type { GenKey, TurnKey } from '../model/ids.js';
import { clearAllInputs } from './decide/inputs-requested.js';
import { arm, cfg, disarmWhere, dom, emit, patch, publish, recon, updRecon } from './ctx.js';
import type { Ctx } from './ctx.js';
import { stopAgent } from './decide/agents.js';
import { agentRec, setAgentState, setToolState, setTurnState, turnRec } from './decide/entities.js';
import { implicitFinalForTurn } from './decide/messages.js';
import { closeAllCalls, closeTurnCalls } from './decide/model-calls.js';
import { abandonPermission, isMainScoped, permissionsOfTurn } from './decide/permissions.js';
import { abortAllJobs } from './input-policy/machine.js';
import { isPermOpen, isToolTerminal, isTurnTerminal } from './lattice.js';

/** Rule 1: turn terminal → its main-thread tools → unknown, pending permissions → abandoned, open calls → aborted/ended. */
function closeTurn(ctx: Ctx, k: TurnKey): void {
  const t = turnRec(ctx, k);
  if (t === undefined || !isTurnTerminal(t.state.value)) return;
  for (const tool of Object.values(dom(ctx).tools)) {
    if (tool.turn === k && tool.agent === undefined && !isToolTerminal(tool.state.value)) {
      setToolState(ctx, tool.key, 'unknown', { outcomeFrom: 'closing_rule', error: 'turn_closed' });
    }
  }
  for (const p of permissionsOfTurn(ctx, k)) {
    const rec = dom(ctx).permissions[p];
    // background / teammate / internal agents launched by the turn are not closed with it (§4.8 rule 1, ICR 0021)
    if (rec !== undefined && isPermOpen(rec.state.value) && isMainScoped(ctx, rec)) abandonPermission(ctx, p, 'turnClosed');
  }
  const s = t.state.value;
  closeTurnCalls(
    ctx,
    k,
    s === 'interrupted' || s === 'withdrawn' || s === 'aborted'
      ? 'aborted'
      : s === 'failed'
        ? 'failed'
        : s === 'completed'
          ? 'ended'
          : 'unknown',
  );
  implicitFinalForTurn(ctx, k);
  if (dom(ctx).activeTurn === undefined && Object.keys(dom(ctx).pendingInputs).length > 0)
    clearAllInputs(ctx, s === 'interrupted' ? 'interrupted' : 'complete');
  // a successful turn restores auth (§4.3#18)
  if (s === 'completed' && dom(ctx).auth.state === 'required') {
    patch(ctx, ['auth'], { state: 'ok', polling: false }, 'auth restored by a turn');
    publish(ctx, 'session.authRestored', {});
  }
}

/** Step (4): rule 1 for every turn that became terminal during this step (repeated until no new closures). */
export function runClosing(ctx: Ctx): void {
  const done = new Set<string>();
  for (let guard = 0; guard < 64 && ctx.closedTurns.length > 0; guard++) {
    const k = ctx.closedTurns.shift();
    if (k === undefined || done.has(k)) continue;
    done.add(k);
    closeTurn(ctx, k);
  }
}

/**
 * Rule 3: generation ended → everything open in it → unknown/abandoned, EXCEPT background agents and background tasks
 * (session-scoped, §4.5.4, P-REV-17); its follower keeps draining for drainMs.
 */
export function endGenerationEntities(ctx: Ctx, gen: GenKey, reason: 'session_end' | 'process_exit'): void {
  for (const t of Object.values(dom(ctx).turns)) {
    if (t.gen !== gen || isTurnTerminal(t.state.value)) continue;
    if (t.state.value === 'queued' || t.state.value === 'submitting') continue; // library turns wait for the next generation
    setTurnState(ctx, t.key, 'unknown', { endedBy: reason });
  }
  const bg: string[] = [];
  for (const a of Object.values(dom(ctx).agents)) {
    if (a.gen !== gen || a.state.value !== 'running') continue;
    if (a.background || a.kind === 'teammate') {
      bg.push(a.key);
      continue;
    }
    stopAgent(ctx, a.key, 'unknown', { abandonReason: 'generationEnded' }); // rule 2 applied by rule 3
  }
  if (bg.length > 0) updRecon(ctx, (r) => ({ ...r, drainPending: [...r.drainPending, ...(bg as typeof r.drainPending)] }));
  arm(ctx, 'drain', gen, ctx.core.now + cfg(ctx).timeouts.drainMs);
}

/** drain fired for an ended generation: late upgrades stop; background agents are checked at the new gen's first Stop. */
export function onDrainDeadline(ctx: Ctx, ref: string): void {
  if (!ref.startsWith('g')) return;
  updRecon(ctx, (r) => ({ ...r, drained: { ...r.drained, [ref]: true } }));
}

/**
 * The new generation's first Stop / turn_duration: background agents of an ended generation with no evidence that are
 * not listed become unknown (not stopped) and leave the background count (§4.5.4).
 */
export function checkDrainPending(ctx: Ctx, listedIds: readonly string[], pendingCount: number): void {
  const pend = recon(ctx).drainPending;
  if (pend.length === 0) return;
  const keep: typeof pend = [];
  for (const k of pend) {
    const a = agentRec(ctx, k);
    if (a?.state.value !== 'running') continue;
    const genDrained = a.gen === undefined || recon(ctx).drained[a.gen] === true;
    if (!genDrained) {
      keep.push(k);
      continue;
    }
    if (listedIds.includes(a.agentId) || pendingCount > 0) continue; // still alive per the new generation
    stopAgent(ctx, k, 'unknown', { abandonReason: 'generationEnded' }); // rule 2 for the agent that never stopped
  }
  updRecon(ctx, (r) => ({ ...r, drainPending: keep }));
}

/** Rule 4: process exited → as rule 3 for all generations; everything open ends; deadlines cleared; finalize. */
export function closeProcess(ctx: Ctx, reason: string): void {
  abortAllJobs(ctx, 'exit');
  for (const t of Object.values(dom(ctx).turns)) {
    if (isTurnTerminal(t.state.value)) continue;
    if (t.state.value === 'queued' || t.state.value === 'submitting') {
      setTurnState(ctx, t.key, 'notSubmitted', { endedBy: 'process_exit', src: 'process' });
      continue;
    }
    setTurnState(ctx, t.key, 'unknown', { endedBy: 'process_exit', src: 'process' });
  }
  if (dom(ctx).libraryQueue.length > 0) patch(ctx, ['libraryQueue'], [], 'process exit');
  runClosing(ctx);
  for (const tool of Object.values(dom(ctx).tools)) {
    if (!isToolTerminal(tool.state.value))
      setToolState(ctx, tool.key, 'unknown', { outcomeFrom: 'closing_rule', error: 'process_exit', src: 'process' });
  }
  for (const p of Object.values(dom(ctx).permissions)) if (isPermOpen(p.state.value)) abandonPermission(ctx, p.key, 'processExit');
  for (const a of Object.values(dom(ctx).agents)) if (a.state.value === 'running') setAgentState(ctx, a.key, 'unknown');
  closeAllCalls(ctx);
  clearAllInputs(ctx, 'interrupted');
  disarmWhere(ctx, () => true);
  emit<'lifecycle.finalize'>(ctx, { kind: 'lifecycle.finalize', reason });
}
