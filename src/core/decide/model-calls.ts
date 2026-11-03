// core/decide/model-calls.ts — ModelCall transitions (DESIGN.md §4.6 ModelCall; hooks are silent for model calls, RC §4).
// Retry/stall banners are screen claims (sole source, advisory): they never terminate an entity (§4.1).

import type { AgentKey, ModelCallKey, TurnKey } from '../../model/ids.js';
import type { JsonValue } from '../../model/json.js';
import type { Observation } from '../../model/observation.js';
import type { ModelCall } from '../../model/state.js';
import { cfg, dom, mint, nowOf, publish, recon, seqOf, srcOf, updRecon } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { mkFact } from '../facts.js';
import { isCallOpen } from '../lattice.js';
import { correlateRequest } from '../reconcile/net-correlate.js';
import { agentById, callRec, continueTurn, mainTurn, putCall, putTurn, setCallState, turnOfAgent, turnRec } from './entities.js';
import { implicitFinalForTurn } from './messages.js';

function agentOf(ctx: Ctx, o: Extract<Observation, { kind: 'model.requestStarted' }>): AgentKey | undefined {
  const byMeta = agentById(ctx, o.meta.agentId);
  if (byMeta !== undefined) return byMeta.key;
  const qs = o.p.querySource;
  if (qs?.startsWith('agent:') === true) return agentById(ctx, qs.slice('agent:'.length))?.key;
  return undefined;
}

/** transcript api-request: new call (attempts 1), or a retry of the same requestDigest (attempts++, retrying). */
export function onRequestStarted(ctx: Ctx, o: Extract<Observation, { kind: 'model.requestStarted' }>): void {
  const p = o.p;
  if (recon(ctx).aliases.requestRef[p.requestRef] !== undefined) return;
  const agent = agentOf(ctx, o);
  const turn: TurnKey | undefined = agent !== undefined ? turnOfAgent(ctx, dom(ctx).agents[agent]) : mainTurn(ctx)?.key;
  if (p.isRetry) {
    const prev = Object.values(dom(ctx).calls)
      .filter((c) => isCallOpen(c.state.value) && (p.requestDigest === undefined || c.digest === p.requestDigest) && c.agent === agent)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (prev !== undefined) {
      const attempts = prev.attempts + 1;
      setCallState(ctx, prev.key, 'retrying', { patch: { attempts, requestRefs: [...prev.requestRefs, p.requestRef] } });
      const cur = callRec(ctx, prev.key);
      if (cur !== undefined && cur.attempts !== attempts)
        putCall(ctx, { ...cur, attempts, requestRefs: [...prev.requestRefs, p.requestRef] }, 'retry');
      alias(ctx, p.requestRef, prev.key);
      const ev: { callKey: ModelCallKey; attempt: number; maxAttempts?: number } = { callKey: prev.key, attempt: attempts };
      if (prev.retry?.max !== undefined) ev.maxAttempts = prev.retry.max;
      publish(ctx, 'modelCall.retrying', ev, { turnKey: prev.turn });
      correlateRequest(ctx, prev.key, p.txWall);
      return;
    }
  }
  const key = mint(ctx, 'call');
  const c: ModelCall = {
    key,
    requestRefs: [p.requestRef],
    attempts: 1,
    state: mkFact('started', srcOf(ctx), seqOf(ctx), nowOf(ctx)),
    bytesDown: 0,
    startedAt: nowOf(ctx),
  };
  if (turn !== undefined) c.turn = turn;
  if (agent !== undefined) c.agent = agent;
  if (p.requestDigest !== undefined) c.digest = p.requestDigest;
  putCall(ctx, c, 'call started');
  alias(ctx, p.requestRef, key);
  const t = turnRec(ctx, turn);
  if (t !== undefined) putTurn(ctx, { ...t, calls: [...t.calls, key] }, 'turn call');
  const ev: { callKey: ModelCallKey; requestRef?: string; attempt: number; agentKey?: AgentKey } = {
    callKey: key,
    requestRef: p.requestRef,
    attempt: 1,
  };
  if (agent !== undefined) ev.agentKey = agent;
  publish(ctx, 'modelCall.started', ev, { turnKey: turn });
  if (agent === undefined && turn !== undefined) {
    implicitFinalForTurn(ctx, turn);
    continueTurn(ctx, turn);
  }
  correlateRequest(ctx, key, p.txWall);
}

function alias(ctx: Ctx, ref: string, key: ModelCallKey): void {
  updRecon(ctx, (r) => ({ ...r, aliases: { ...r.aliases, requestRef: { ...r.aliases.requestRef, [ref]: key } } }));
}

/** The open main-thread call of the active turn (screen banners describe the main thread). */
function activeCall(ctx: Ctx): ModelCall | undefined {
  const t = mainTurn(ctx);
  if (t === undefined) return undefined;
  for (let i = t.calls.length - 1; i >= 0; i--) {
    const c = callRec(ctx, t.calls[i]);
    if (c !== undefined && isCallOpen(c.state.value)) return c;
  }
  return undefined;
}

const num = (v: JsonValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: JsonValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** Screen `retrying{attempt,max,retryInMs}` claim asserted → `retrying` (provisional). */
export function onRetryClaim(ctx: Ctx, value: JsonValue): void {
  const c = activeCall(ctx);
  if (c === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const v = value as Record<string, JsonValue>;
  const retry: NonNullable<ModelCall['retry']> = { attempt: num(v['attempt']) ?? c.attempts };
  const max = num(v['max']);
  const inMs = num(v['retryInMs']);
  const hint = str(v['errorHint']);
  if (max !== undefined) retry.max = max;
  if (inMs !== undefined) retry.retryInMs = inMs;
  if (hint !== undefined) retry.errorHint = hint;
  setCallState(ctx, c.key, 'retrying', { provisional: true, patch: { retry } });
  const ev: { callKey: ModelCallKey; attempt: number; maxAttempts?: number; retryInMs?: number; errorHint?: string } = {
    callKey: c.key,
    attempt: retry.attempt,
  };
  if (retry.max !== undefined) ev.maxAttempts = retry.max;
  if (retry.retryInMs !== undefined) ev.retryInMs = retry.retryInMs;
  if (retry.errorHint !== undefined) ev.errorHint = retry.errorHint;
  publish(ctx, 'modelCall.retrying', ev, { turnKey: c.turn, confirmed: false, sources: ['screen'] });
}

/** Screen `Waiting for API response` / stall banner claim → `stalled` (provisional), never during hostResumeGrace. */
export function onStallClaim(ctx: Ctx): void {
  const c = activeCall(ctx);
  if (c === undefined) return;
  const resumed = recon(ctx).lastHostResumeAt;
  if (resumed !== undefined && nowOf(ctx) < resumed + cfg(ctx).timeouts.hostResumeGraceMs) return;
  setCallState(ctx, c.key, 'stalled', { provisional: true });
  publish(ctx, 'modelCall.progress', { callKey: c.key, phase: 'stalled' }, { turnKey: c.turn, confirmed: false, sources: ['screen'] });
}

const STALL_CLAIMS = ['status:stalled', 'status:noResponse'] as const;
const claimShown = (ctx: Ctx, k: string): boolean => {
  const c = recon(ctx).claims[k];
  return c !== undefined && (c.status === 'asserted' || c.status === 'confirmed');
};

/**
 * A stall/retry banner claim ended (newer frame, TTL expiry, or the screen channel going down): a call whose
 * `stalled`/`retrying` state came only from that claim (provisional) returns to `waiting`. Screen facts affect
 * derived state only while asserted (§4.6 Claims, §4.7 rule 11 "stalled if network idle > stallMs or a stall claim").
 */
export function settleScreenCallStates(ctx: Ctx): void {
  const stallShown = STALL_CLAIMS.some((k) => claimShown(ctx, k));
  const retryShown = claimShown(ctx, 'status:retrying');
  for (const c of Object.values(dom(ctx).calls)) {
    // provisional call states come only from screen claims (onRetryClaim/onStallClaim); src may be screen or clock (the
    // stability deadline asserts a claim)
    if (!isCallOpen(c.state.value) || !c.state.provisional) continue;
    if (c.state.value === 'stalled' && !stallShown) setCallState(ctx, c.key, 'waiting');
    else if (c.state.value === 'retrying' && !retryShown) {
      const cur = callRec(ctx, c.key);
      if (cur === undefined) continue;
      const n: ModelCall = { ...cur };
      delete n.retry; // the screen-only retry detail ends with its banner
      putCall(ctx, n, 'screen retry ended');
      setCallState(ctx, c.key, 'waiting');
    }
  }
}

/** A call of a background / teammate / internal agent: session-scoped, not closed with the spawning turn (§4.8 rule 1). */
function isSessionScopedCall(ctx: Ctx, c: ModelCall): boolean {
  if (c.agent === undefined) return false;
  const a = dom(ctx).agents[c.agent];
  return a !== undefined && (a.background || a.kind !== 'subagent');
}

/**
 * Closing rule 1: open calls of a closed turn → aborted (interrupt) / failed / ended. Calls of background, teammate and
 * internal agents launched by the turn stay open: those agents are not closed with it (§4.8 rule 1, as ICR 0021 does for
 * their permissions); their own end, rule 3/4 or the agent stopping closes them.
 */
export function closeTurnCalls(ctx: Ctx, turn: TurnKey, how: 'aborted' | 'failed' | 'ended' | 'unknown'): void {
  const t = turnRec(ctx, turn);
  if (t === undefined) return;
  for (const k of t.calls) {
    const c = callRec(ctx, k);
    if (c !== undefined && isCallOpen(c.state.value) && !isSessionScopedCall(ctx, c)) setCallState(ctx, k, how);
  }
}

/** Open calls of an agent that stopped (rule 2) → `unknown`; the agent's requests cannot outlive it. */
export function closeAgentCalls(ctx: Ctx, agent: AgentKey): void {
  for (const c of Object.values(dom(ctx).calls)) if (c.agent === agent && isCallOpen(c.state.value)) setCallState(ctx, c.key, 'unknown');
}

/** Rule 4: every open call ends `unknown`, whatever its turn or agent. */
export function closeAllCalls(ctx: Ctx): void {
  for (const c of Object.values(dom(ctx).calls)) if (isCallOpen(c.state.value)) setCallState(ctx, c.key, 'unknown');
}
