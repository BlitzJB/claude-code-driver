// core/decide/inputs-requested.ts — MCP elicitation / unknown blocking modal → awaitingInput (DESIGN.md §4.6 PendingInput,
// rev 2 §10 G14, P-REV-14). v1 never answers an elicitation programmatically; the host is told and may interrupt().

import type { Observation } from '../../model/observation.js';
import type { PendingInput } from '../../model/state.js';
import type { ScreenFacts } from '../../model/screen-facts.js';
import { assertedClaim, claim, isIdleMain } from '../claims.js';
import { arm, diag, disarm, dom, nowOf, patch, publish, recon, unset, updRecon } from '../ctx.js';
import type { Ctx } from '../ctx.js';

// `dialog:other` = a modal whose structure is recognised (options / Esc footer) but whose kind is not: as blocking as an
// unknownModal for our purposes (K-40). ICR 0016.
export const MODAL_CLAIMS: readonly string[] = ['surface:unknownModal', 'dialog:elicitation', 'dialog:other'];
const MODAL_HOLD_MS = 2000;

function nextKey(ctx: Ctx): string {
  const n = recon(ctx).pendingInputSeq + 1;
  updRecon(ctx, (r) => ({ ...r, pendingInputSeq: n }));
  return `r${n}`;
}

function add(ctx: Ctx, kind: PendingInput['kind'], src: PendingInput['src'], message?: string): void {
  const key = nextKey(ctx);
  const p: PendingInput = { key, kind, since: nowOf(ctx), src };
  if (message !== undefined) p.message = message;
  patch(ctx, ['pendingInputs', key], p, 'input requested');
  const ev: { requestKey: string; kind: PendingInput['kind']; message?: string } = { requestKey: key, kind };
  if (message !== undefined) ev.message = message;
  publish(ctx, 'input.requested', ev, { confirmed: src !== 'screen', turnKey: dom(ctx).activeTurn });
}

function remove(ctx: Ctx, p: PendingInput, how: 'complete' | 'response' | 'screenGone' | 'interrupted'): void {
  unset(ctx, ['pendingInputs', p.key], `input cleared:${how}`);
  publish(ctx, 'input.cleared', { requestKey: p.key, how }, { turnKey: dom(ctx).activeTurn });
}

/**
 * Notification{elicitation_dialog | elicitation_url_dialog | agent_needs_input}. `agent_needs_input` reports another agent
 * or session entering the blocked band; it has no clearing notification. It is a pending input only while a turn is active
 * and only for the main thread or a foreground subagent: background agents never make main status non-idle (§4.6
 * PendingInput, §4.7). An elicitation is a real modal on main and counts even while idle; see onFrameForInputs. ICR 0021.
 */
export function onInputRequested(ctx: Ctx, o: Extract<Observation, { kind: 'input.requested' }>): void {
  if (o.p.kind === 'agentNeedsInput') {
    const id = o.meta.agentId;
    const k = id === undefined ? undefined : recon(ctx).aliases.agentId[id];
    const a = k === undefined ? undefined : dom(ctx).agents[k];
    const foreground = id === undefined || (a !== undefined && !a.background && a.kind === 'subagent');
    if (dom(ctx).activeTurn === undefined || !foreground) {
      diag(ctx, 'input_request_not_pending', { kind: o.p.kind, agentId: id ?? null, idle: dom(ctx).activeTurn === undefined });
      return;
    }
  }
  add(ctx, o.p.kind, 'hook', o.p.message);
}

/**
 * A hook-sourced request left over with no turn (no clearing notification came): once an idle main frame shows no modal
 * at all, and the request is older than the modal hold, nothing is waiting for input any more → cleared `screenGone`.
 * Without this, canSubmit stayed false and the queue waited forever (§4.6 "surface returns to main"). ICR 0021 item 4.
 */
export function onFrameForInputs(ctx: Ctx, f: ScreenFacts): void {
  if (dom(ctx).activeTurn !== undefined || !isIdleMain(f)) return;
  if (MODAL_CLAIMS.some((k) => claim(ctx, k) !== undefined)) return;
  for (const p of Object.values(dom(ctx).pendingInputs)) {
    if (p.src === 'hook' && nowOf(ctx) - p.since >= MODAL_HOLD_MS) remove(ctx, p, 'screenGone');
  }
}

/** Notification{elicitation_complete | elicitation_response}: clears the oldest request of that kind. */
export function onInputRequestCleared(ctx: Ctx, o: Extract<Observation, { kind: 'input.requestCleared' }>): void {
  const p = Object.values(dom(ctx).pendingInputs)
    .filter((x) => x.kind === o.p.kind)
    .sort((a, b) => a.since - b.since)[0];
  if (p !== undefined) remove(ctx, p, o.p.how);
}

/**
 * A modal counts only while a turn is active (§4.6 PendingInput), and never while one of our own command / mode jobs is
 * driving the screen (a modal command such as `/status` opens one on purpose).
 */
function modalEligible(ctx: Ctx): boolean {
  const cur = ctx.core.input.current;
  const job = cur === undefined ? undefined : ctx.core.input.jobs[cur];
  if (job !== undefined && (job.kind === 'command' || job.kind === 'setMode')) return false;
  return dom(ctx).activeTurn !== undefined;
}

/** An elicitation / unknown-modal claim asserted while eligible: becomes a pending input after 2 s. */
export function onModalClaimAsserted(ctx: Ctx, claimKey: string): void {
  if (!modalEligible(ctx)) return;
  const c = assertedClaim(ctx, claimKey);
  if (c === undefined) return;
  arm(ctx, 'adoptDialog', `input:${claimKey}`, Math.max(nowOf(ctx), c.stableSince + MODAL_HOLD_MS));
}

export function onModalDeadline(ctx: Ctx, claimKey: string): void {
  if (!modalEligible(ctx) || assertedClaim(ctx, claimKey) === undefined) return;
  if (Object.values(dom(ctx).pendingInputs).some((p) => p.src === 'screen' || p.kind === 'elicitation' || p.kind === 'elicitationUrl'))
    return;
  if (claimKey === 'dialog:other' && assertedClaim(ctx, 'surface:unknownModal') !== undefined) return; // counted once
  add(ctx, claimKey === 'dialog:elicitation' ? 'elicitation' : 'unknownModal', 'screen');
}

/** The modal left the screen: screen-sourced requests clear; hook-sourced ones clear when the surface is back on main. */
export function onModalClaimEnded(ctx: Ctx, claimKey: string): void {
  disarm(ctx, 'adoptDialog', `input:${claimKey}`);
  const mainNow = recon(ctx).lastFrame?.surface === 'main';
  for (const p of Object.values(dom(ctx).pendingInputs)) {
    if (p.src === 'screen' || mainNow) remove(ctx, p, 'screenGone');
  }
}

/** An interrupt or the turn's end clears every pending request (§4.6 PendingInput). */
export function clearAllInputs(ctx: Ctx, how: 'interrupted' | 'complete'): void {
  for (const p of Object.values(dom(ctx).pendingInputs)) remove(ctx, p, how);
}
