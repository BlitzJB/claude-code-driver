// core/decide/entities.ts — low-level entity reads/writes shared by decide/*, reconcile/* and closing.ts (WP-09 helper).
// Every write is an `x.patch` through ctx (evolve is the only writer, I1); every state change goes through the §4.2
// lattice and publishes its DomainEvent. Policy (what to do on which observation) lives in the decide modules.

import type { CcdErrorData } from '../../model/errors.js';
import type { TurnEndedBy, TurnOutcome, ResponseRef, ToolOutcomeFrom } from '../../model/events.js';
import type { AgentKey, GenKey, ModelCallKey, MsgKey, PermissionKey, ToolKey, TurnKey } from '../../model/ids.js';
import type { Source } from '../../model/observation.js';
import type {
  AgentRecord,
  AgentState,
  CallState,
  Generation,
  MessageRecord,
  ModelCall,
  PermissionRecord,
  PermState,
  ToolRun,
  ToolState,
  TurnRecord,
  TurnState,
} from '../../model/state.js';
import { claim as getClaim } from '../claims.js';
import { countConflict, disarm, dom, growProvenance, nowOf, patch, publish, recon, seqOf, srcOf, unset } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { applyStatus, isTurnTerminal } from '../lattice.js';
import type { ApplyVerdict } from '../lattice.js';

// ------------------------------------------------------------------ reads
export const turnRec = (ctx: Ctx, k: TurnKey | undefined): TurnRecord | undefined => (k === undefined ? undefined : dom(ctx).turns[k]);
export const toolRec = (ctx: Ctx, k: ToolKey | undefined): ToolRun | undefined => (k === undefined ? undefined : dom(ctx).tools[k]);
export const permRec = (ctx: Ctx, k: PermissionKey | undefined): PermissionRecord | undefined =>
  k === undefined ? undefined : dom(ctx).permissions[k];
export const agentRec = (ctx: Ctx, k: AgentKey | undefined): AgentRecord | undefined => (k === undefined ? undefined : dom(ctx).agents[k]);
export const callRec = (ctx: Ctx, k: ModelCallKey | undefined): ModelCall | undefined => (k === undefined ? undefined : dom(ctx).calls[k]);
export const msgRec = (ctx: Ctx, k: MsgKey | undefined): MessageRecord | undefined => (k === undefined ? undefined : dom(ctx).messages[k]);
export const genRec = (ctx: Ctx, k: GenKey | undefined): Generation | undefined => (k === undefined ? undefined : dom(ctx).generations[k]);

export function genOfSession(ctx: Ctx, sessionId: string | undefined): GenKey | undefined {
  return sessionId === undefined ? undefined : recon(ctx).aliases.sessionId[sessionId];
}
export function toolByUseId(ctx: Ctx, id: string | undefined): ToolRun | undefined {
  if (id === undefined || id === '') return undefined;
  return toolRec(ctx, recon(ctx).aliases.toolUseId[id]);
}
export function agentById(ctx: Ctx, id: string | undefined): AgentRecord | undefined {
  if (id === undefined || id === '') return undefined;
  return agentRec(ctx, recon(ctx).aliases.agentId[id]);
}
export function turnByPromptId(ctx: Ctx, id: string | undefined): TurnRecord | undefined {
  if (id === undefined || id === '') return undefined;
  return turnRec(ctx, recon(ctx).aliases.promptId[id]);
}

/** The turn an agent's work belongs to: its spawning tool's turn (spawn chain, RC §5.3.5), else none. */
export function turnOfAgent(ctx: Ctx, a: AgentRecord | undefined, depth = 0): TurnKey | undefined {
  if (a === undefined || depth > 16) return undefined;
  const spawn = toolRec(ctx, a.spawnTool);
  if (spawn?.turn !== undefined) return spawn.turn;
  if (spawn?.agent !== undefined) return turnOfAgent(ctx, agentRec(ctx, spawn.agent), depth + 1);
  return undefined;
}

/** Main-thread attribution: the active turn; the most recent stopping/terminal turn for late transcript lines. */
export function mainTurn(ctx: Ctx, allowRecent = false): TurnRecord | undefined {
  const d = dom(ctx);
  const a = turnRec(ctx, d.activeTurn);
  if (a !== undefined) return a;
  if (!allowRecent) return undefined;
  for (let i = d.turnOrder.length - 1; i >= 0; i--) {
    const k = d.turnOrder[i];
    const t = k === undefined ? undefined : d.turns[k];
    if (t !== undefined && t.state.value !== 'queued' && t.state.value !== 'submitting' && t.mergedInto === undefined) return t;
  }
  return undefined;
}

// ------------------------------------------------------------------ writes
export function putTurn(ctx: Ctx, t: TurnRecord, why: string): void {
  patch(ctx, ['turns', t.key], t, why);
}
export function putTool(ctx: Ctx, t: ToolRun, why: string): void {
  patch(ctx, ['tools', t.key], t, why);
}
export function putPerm(ctx: Ctx, p: PermissionRecord, why: string): void {
  patch(ctx, ['permissions', p.key], p, why);
}
export function putAgent(ctx: Ctx, a: AgentRecord, why: string): void {
  patch(ctx, ['agents', a.key], a, why);
}
export function putCall(ctx: Ctx, c: ModelCall, why: string): void {
  patch(ctx, ['calls', c.key], c, why);
}
export function putMsg(ctx: Ctx, m: MessageRecord, why: string): void {
  patch(ctx, ['messages', m.key], m, why);
}
export function putGen(ctx: Ctx, g: Generation, why: string): void {
  patch(ctx, ['generations', g.key], g, why);
}
export function setActiveTurn(ctx: Ctx, k: TurnKey | undefined, why: string): void {
  const cur = dom(ctx).activeTurn;
  if (cur === k) return;
  // a held provisional (screen) interrupt that loses the active slot to another turn is released first: it ends with
  // confirmed:false and its closing rule runs, never left without turn.ended (ICR 0028 item 1)
  if (cur !== undefined && isHeld(ctx, cur)) {
    releaseHeldTurn(ctx, cur);
    if (dom(ctx).activeTurn === k) return;
  }
  if (k === undefined) unset(ctx, ['activeTurn'], why);
  else patch(ctx, ['activeTurn'], k, why);
}

export function touchTurn(ctx: Ctx, k: TurnKey | undefined): void {
  const t = turnRec(ctx, k);
  if (t === undefined) return;
  const p = growProvenance(t.provenance, ctx);
  if (p !== t.provenance) putTurn(ctx, { ...t, provenance: p }, 'provenance');
}

// ------------------------------------------------------------------ turn state
function publishTurnEnded(ctx: Ctx, k: TurnKey, confirmed: boolean): void {
  const n = turnRec(ctx, k);
  if (n === undefined) return;
  const payload: {
    outcome: TurnOutcome;
    endedBy: TurnEndedBy;
    error?: CcdErrorData;
    durationMs?: number;
    finalText?: string;
    truncated?: boolean;
    refused?: boolean;
  } = { outcome: outcomeOf(n.state.value), endedBy: n.endedBy ?? 'stop' };
  if (n.error !== undefined) payload.error = n.error;
  if (n.durationMs !== undefined) payload.durationMs = n.durationMs;
  if (n.finalText !== undefined) payload.finalText = n.finalText.value;
  if (n.truncated !== undefined) payload.truncated = n.truncated;
  if (n.refused !== undefined) payload.refused = true;
  // provenance = the source of the evidence that ended the turn (the terminal state fact), not the observation that happened
  // to trigger it (a clock tick firing stopGrace after a transcript turn_duration, K-20). ICR 0016.
  const src = n.state.src;
  publish(ctx, 'turn.ended', payload, src === 'clock' ? { turnKey: k, confirmed } : { turnKey: k, confirmed, sources: [src] });
}

/** A provisional (screen) terminal turn still holding the active slot until confirmed or interruptConfirm (§4.4#15). */
function isHeld(ctx: Ctx, k: TurnKey): boolean {
  const t = turnRec(ctx, k);
  return t !== undefined && t.state.provisional && isTurnTerminal(t.state.value) && dom(ctx).activeTurn === k;
}

/**
 * Release a held provisional (screen) interrupt — interruptConfirm expired, or another turn takes the active slot: it
 * stays interrupted with confirmed:false (RC §8 rule 5), its closing rule runs and its merged turns end with it (§4.4#8).
 */
export function releaseHeldTurn(ctx: Ctx, k: TurnKey): void {
  if (!isHeld(ctx, k)) return;
  unset(ctx, ['activeTurn'], 'provisional interrupt released');
  disarm(ctx, 'interruptConfirm', `turn:${k}`);
  ctx.closedTurns.push(k);
  publishTurnEnded(ctx, k, false);
  const t = turnRec(ctx, k);
  if (t !== undefined) endMergedTurns(ctx, t, t.state.src);
}

/** Turns merged into `host` (IN §7.3) end with the host's outcome, error and final text, endedBy 'merged' (§4.4#8). */
function endMergedTurns(ctx: Ctx, host: TurnRecord, src: Source): void {
  for (const other of Object.values(dom(ctx).turns)) {
    if (other.mergedInto !== host.key || isTurnTerminal(other.state.value)) continue;
    const mo: TurnStateOpts = { endedBy: 'merged', src };
    if (host.error !== undefined) mo.error = host.error;
    if (host.finalText !== undefined) putTurn(ctx, { ...other, finalText: host.finalText }, 'merged final text');
    setTurnState(ctx, other.key, host.state.value, mo);
  }
}

function outcomeOf(s: TurnState): TurnOutcome {
  switch (s) {
    case 'completed':
    case 'failed':
    case 'interrupted':
    case 'withdrawn':
    case 'notSubmitted':
    case 'aborted':
    case 'unknown':
      return s;
    case 'queued':
    case 'submitting':
    case 'running':
    case 'stopping':
      return 'unknown';
  }
}

export interface TurnStateOpts {
  endedBy?: TurnEndedBy;
  error?: CcdErrorData;
  provisional?: boolean;
  src?: Source;
  /** keep the turn active while provisional (screen interrupt banner until confirmed) */
  keepActive?: boolean;
}

/** §4.4 transitions through the lattice; terminal → publishes turn.ended (or resolvedLate / claim.retracted). */
export function setTurnState(ctx: Ctx, k: TurnKey, next: TurnState, o: TurnStateOpts = {}): ApplyVerdict {
  const t = turnRec(ctx, k);
  if (t === undefined) return 'ignore';
  const src = o.src ?? srcOf(ctx);
  const r = applyStatus('turn', t.state, next, src, seqOf(ctx), nowOf(ctx), o.provisional === true);
  if (r.verdict === 'ignore') {
    if (t.state.value !== next) countConflict(ctx, `turn:${t.state.value}->${next}`);
    return 'ignore';
  }
  const n: TurnRecord = { ...t, state: r.fact, provenance: growProvenance(t.provenance, ctx, src) };
  const terminal = isTurnTerminal(next);
  if (terminal) {
    if (o.endedBy !== undefined) n.endedBy = o.endedBy;
    if (o.error !== undefined) n.error = o.error;
    if (r.verdict !== 'resolvedLate' || n.endedAt === undefined) n.endedAt = nowOf(ctx);
  }
  putTurn(ctx, n, `turn:${next}`);
  if (r.verdict === 'resolvedLate') {
    publish(ctx, 'turn.resolvedLate', { from: 'unknown', to: outcomeOf(next) }, { turnKey: k });
    return r.verdict;
  }
  if (r.verdict === 'retract') {
    publish(ctx, 'claim.retracted', { claim: `turn:${k}:${t.state.value}`, value: t.state.value }, { turnKey: k });
  }
  if (terminal) {
    const held = o.keepActive === true && o.provisional === true;
    if (held) return r.verdict; // provisional (screen) end: the turn stays active until confirmed or interruptConfirm
    const sameValueUpgrade = t.state.value === next;
    const wasHeld = t.state.provisional && dom(ctx).activeTurn === k;
    if (dom(ctx).activeTurn === k) unset(ctx, ['activeTurn'], `turn ${next}`);
    ctx.closedTurns.push(k);
    // a same-value upgrade of a released hold: its turn.ended{confirmed:false} was already published
    if (!sameValueUpgrade || wasHeld) publishTurnEnded(ctx, k, true);
    endMergedTurns(ctx, turnRec(ctx, k) ?? n, src); // merged turns end with the host's outcome (§4.4#8)
  }
  return r.verdict;
}

/** Undo a provisional (screen) interrupt: the turn continues (claim.retracted, §4.4#14). */
export function continueTurn(ctx: Ctx, k: TurnKey | undefined): void {
  const t = turnRec(ctx, k);
  if (t === undefined || k === undefined) return;
  if (t.state.value !== 'interrupted' || !t.state.provisional) return;
  // never revive a turn while another one holds the active slot: it could never end again (ICR 0028 item 1)
  const active = dom(ctx).activeTurn;
  if (active !== undefined && active !== k) return;
  const n: TurnRecord = {
    ...t,
    state: { value: 'running', src: srcOf(ctx), seq: seqOf(ctx), at: nowOf(ctx), corroborated: [], provisional: false },
  };
  delete n.endedAt;
  delete n.endedBy;
  putTurn(ctx, n, 'retract provisional interrupt');
  if (dom(ctx).activeTurn === undefined) setActiveTurn(ctx, k, 'retract provisional interrupt');
  const c = getClaim(ctx, 'interruptedBanner');
  publish(ctx, 'claim.retracted', { claim: 'interruptedBanner', value: c?.value ?? true }, { turnKey: k });
}

// ------------------------------------------------------------------ tool state
export interface ToolStateOpts {
  outcomeFrom?: ToolOutcomeFrom;
  error?: string;
  provisional?: boolean;
  src?: Source;
  responseRef?: ResponseRef;
  durationMs?: number;
}

export function setToolState(ctx: Ctx, k: ToolKey, next: ToolState, o: ToolStateOpts = {}): ApplyVerdict {
  const t = toolRec(ctx, k);
  if (t === undefined) return 'ignore';
  const src = o.src ?? srcOf(ctx);
  const r = applyStatus('tool', t.state, next, src, seqOf(ctx), nowOf(ctx), o.provisional === true);
  if (r.verdict === 'ignore') {
    if (t.state.value !== next) countConflict(ctx, `tool:${t.state.value}->${next}`);
    // enrichment of a terminal tool (late response/duration)
    if (o.responseRef !== undefined && t.responseRef === undefined) putTool(ctx, { ...t, responseRef: o.responseRef }, 'enrich');
    return 'ignore';
  }
  const n: ToolRun = { ...t, state: r.fact, provenance: growProvenance(t.provenance, ctx, src) };
  if (o.outcomeFrom !== undefined) n.outcomeFrom = o.outcomeFrom;
  if (o.error !== undefined) n.error = o.error;
  if (o.responseRef !== undefined) n.responseRef = o.responseRef;
  if (o.durationMs !== undefined) n.durationMs = o.durationMs;
  const terminal = next === 'succeeded' || next === 'failed' || next === 'denied' || next === 'interrupted' || next === 'unknown';
  if (terminal) n.endedAt = nowOf(ctx);
  putTool(ctx, n, `tool:${next}`);
  if (r.verdict === 'resolvedLate') {
    publish(ctx, 'tool.resolvedLate', { toolKey: k, to: next }, { turnKey: n.turn });
  } else if (terminal) {
    if (r.verdict === 'retract')
      publish(ctx, 'claim.retracted', { claim: `tool:${k}:${t.state.value}`, value: t.state.value }, { turnKey: n.turn });
    const pl: { toolKey: ToolKey; state: ToolState; outcomeFrom: ToolOutcomeFrom; durationMs?: number; responseRef?: ResponseRef } = {
      toolKey: k,
      state: next,
      outcomeFrom: n.outcomeFrom ?? 'closing_rule',
    };
    if (n.durationMs !== undefined) pl.durationMs = n.durationMs;
    if (n.responseRef !== undefined) pl.responseRef = n.responseRef;
    publish(ctx, 'tool.ended', pl, { turnKey: n.turn, confirmed: o.provisional !== true });
  } else {
    publish(ctx, 'tool.updated', { toolKey: k, state: next }, { turnKey: n.turn });
  }
  return r.verdict;
}

// ------------------------------------------------------------------ permission state
export function setPermState(ctx: Ctx, k: PermissionKey, next: PermState, patchRec: Partial<PermissionRecord> = {}): ApplyVerdict {
  const p = permRec(ctx, k);
  if (p === undefined) return 'ignore';
  const r = applyStatus('perm', p.state, next, srcOf(ctx), seqOf(ctx), nowOf(ctx));
  // answered ↔ dialogOnly share level 1: allow the explicit change
  const lateral = (p.state.value === 'answered' && next === 'dialogOnly') || (p.state.value === 'pending' && next === 'dialogOnly');
  if (r.verdict === 'ignore' && !lateral) {
    if (Object.keys(patchRec).length > 0) putPerm(ctx, { ...p, ...patchRec }, 'perm enrich');
    return 'ignore';
  }
  const fact = r.verdict === 'ignore' ? { ...p.state, value: next, seq: seqOf(ctx), at: nowOf(ctx), src: srcOf(ctx) } : r.fact;
  putPerm(ctx, { ...p, ...patchRec, state: fact, provenance: growProvenance(p.provenance, ctx) }, `perm:${next}`);
  return r.verdict === 'ignore' ? 'apply' : r.verdict;
}

// ------------------------------------------------------------------ agent / call state
export function setAgentState(ctx: Ctx, k: AgentKey, next: AgentState, patchRec: Partial<AgentRecord> = {}): ApplyVerdict {
  const a = agentRec(ctx, k);
  if (a === undefined) return 'ignore';
  const r = applyStatus('agent', a.state, next, srcOf(ctx), seqOf(ctx), nowOf(ctx));
  if (r.verdict === 'ignore') {
    if (Object.keys(patchRec).length > 0) putAgent(ctx, { ...a, ...patchRec }, 'agent enrich');
    return 'ignore';
  }
  const n: AgentRecord = { ...a, ...patchRec, state: r.fact, provenance: growProvenance(a.provenance, ctx) };
  if (next !== 'running') n.endedAt = nowOf(ctx);
  putAgent(ctx, n, `agent:${next}`);
  return r.verdict;
}

/** Resume a stopped agent on SubagentStart for the same agent_id (runs++, §4.2). */
export function resumeAgent(ctx: Ctx, k: AgentKey): void {
  const a = agentRec(ctx, k);
  if (a === undefined) return;
  const n: AgentRecord = {
    ...a,
    state: { value: 'running', src: srcOf(ctx), seq: seqOf(ctx), at: nowOf(ctx), corroborated: [], provisional: false },
    runs: a.runs + 1,
    provenance: growProvenance(a.provenance, ctx),
  };
  delete n.endedAt;
  putAgent(ctx, n, 'agent resume');
}

export function setCallState(
  ctx: Ctx,
  k: ModelCallKey,
  next: CallState,
  o: { provisional?: boolean; patch?: Partial<ModelCall> } = {},
): ApplyVerdict {
  const c = callRec(ctx, k);
  if (c === undefined) return 'ignore';
  const r = applyStatus('call', c.state, next, srcOf(ctx), seqOf(ctx), nowOf(ctx), o.provisional === true);
  if (r.verdict === 'ignore') {
    if (o.patch !== undefined) putCall(ctx, { ...c, ...o.patch }, 'call enrich');
    return 'ignore';
  }
  const n: ModelCall = { ...c, ...(o.patch ?? {}), state: r.fact };
  const terminal = next === 'ended' || next === 'aborted' || next === 'failed' || next === 'refused' || next === 'unknown';
  if (terminal) n.endedAt = nowOf(ctx);
  putCall(ctx, n, `call:${next}`);
  if (terminal) {
    const outcome =
      next === 'ended' ? 'ok' : next === 'failed' ? 'error' : next === 'aborted' ? 'aborted' : next === 'refused' ? 'refused' : 'unknown';
    const pl: { callKey: ModelCallKey; outcome: 'ok' | 'error' | 'aborted' | 'refused' | 'unknown'; usage?: ModelCall['usage'] & object } =
      { callKey: k, outcome };
    if (n.usage !== undefined) pl.usage = n.usage;
    publish(ctx, 'modelCall.ended', pl, { turnKey: n.turn });
  }
  return r.verdict;
}
