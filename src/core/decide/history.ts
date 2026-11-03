// core/decide/history.ts — resumed history (DESIGN.md §4.9 "replay observations update state silently: their events are
// emitted with replayed:true", §3.1 step 13, P-TAIL-25, K-22, L-08). WP-INT addition (docs/icr/0016-wp-int.md).
//
// On `start({resume})` the tail re-reads the transcript from the beginning with `meta.replay:true`. Replay rebuilds the
// conversation's *turns* (prompt, final text, outcome) so a resumed session shows its history, and nothing else:
//   - a replayed turn is never the active turn (it can never block the queue, the status or canSubmit);
//   - it is never matched against an in-flight submit and never starts jobs, deadlines or intents;
//   - it ends on its replayed `turn_duration` (completed) or interrupt marker (interrupted); a replayed prompt that follows
//     an unfinished one closes that one as `unknown` (the history does not say how it ended);
//   - tools, permissions, agents and model calls are not rebuilt (facts only; a historical tool is not "running").
// Every event published here is stamped `replayed:true` by `publish` (the current observation is a replay observation).

import type { TurnKey } from '../../model/ids.js';
import type { Observation } from '../../model/observation.js';
import type { TurnRecord } from '../../model/state.js';
import { dom, mint, newProvenance, nowOf, patch, publish, recon, seqOf, updRecon } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { mkFact } from '../facts.js';
import { isTurnTerminal } from '../lattice.js';
import { putTurn, setTurnState, turnRec } from './entities.js';

function openReplayTurn(ctx: Ctx): TurnRecord | undefined {
  const t = turnRec(ctx, recon(ctx).replayTurn);
  return t !== undefined && !isTurnTerminal(t.state.value) ? t : undefined;
}

function setReplayTurn(ctx: Ctx, k: TurnKey | undefined): void {
  updRecon(ctx, (r) => {
    const n = { ...r };
    if (k === undefined) delete n.replayTurn;
    else n.replayTurn = k;
    return n;
  });
}

/** Close the open replayed turn (if any) as `unknown`: the history does not show how it ended. */
export function closeOpenReplayTurn(ctx: Ctx): void {
  const t = openReplayTurn(ctx);
  if (t !== undefined) setTurnState(ctx, t.key, 'unknown', { endedBy: 'session_end', src: 'transcript' });
  setReplayTurn(ctx, undefined);
}

/** Is `text` a self-test nonce (never a turn, §4.4#4)? Passed in by the caller to keep this module free of turn logic. */
export type NonceTest = (text: string) => boolean;

/** One replayed observation (`meta.replay === true`). Returns true when it was consumed here. */
export function onReplayObservation(ctx: Ctx, o: Observation, isNonce: NonceTest): boolean {
  if (o.kind === 'prompt.recorded') {
    const p = o.p;
    const text = p.text ?? '';
    if (p.isMeta || p.localCommand !== undefined || text === '' || isNonce(text)) return true;
    if (p.promptId !== undefined && Object.values(dom(ctx).turns).some((t) => t.promptId === p.promptId)) return true;
    closeOpenReplayTurn(ctx);
    const k = mint(ctx, 'turn');
    const origin = p.bashInput === true ? 'bash_mode' : 'unknown';
    const t: TurnRecord = {
      key: k,
      prompt: text,
      origin: mkFact(origin, 'transcript', seqOf(ctx), nowOf(ctx)),
      state: mkFact('running', 'transcript', seqOf(ctx), nowOf(ctx)),
      backgroundPending: [],
      tools: [],
      messages: [],
      calls: [],
      queuedAt: nowOf(ctx),
      acceptedAt: nowOf(ctx),
      provenance: newProvenance(ctx),
    };
    const gen = dom(ctx).claude.currentGen;
    if (gen !== undefined) t.gen = gen;
    if (p.promptId !== undefined && p.promptId !== '') t.promptId = p.promptId;
    putTurn(ctx, t, 'replayed turn');
    patch(ctx, ['turnOrder'], [...dom(ctx).turnOrder, k], 'turn order');
    setReplayTurn(ctx, k);
    publish(ctx, 'turn.queued', { prompt: text, origin }, { turnKey: k, confirmed: true, sources: ['transcript'] });
    publish(ctx, 'turn.accepted', { promptId: p.promptId ?? '' }, { turnKey: k, confirmed: true, sources: ['transcript'] });
    return true;
  }
  if (o.kind === 'message.block') {
    const t = openReplayTurn(ctx);
    if (t === undefined || o.meta.agentId !== undefined) return true;
    const p = o.p;
    if (p.block === 'text' && p.text !== undefined && !p.synthetic)
      putTurn(ctx, { ...t, finalText: mkFact(p.text, 'transcript', seqOf(ctx), nowOf(ctx)) }, 'replayed final text');
    return true;
  }
  if (o.kind === 'turn.durationRecorded') {
    const t = openReplayTurn(ctx);
    if (t === undefined) return true;
    putTurn(ctx, { ...t, durationMs: o.p.durationMs }, 'replayed duration');
    setTurnState(ctx, t.key, 'completed', { endedBy: 'turn_duration', src: 'transcript' });
    setReplayTurn(ctx, undefined);
    return true;
  }
  if (o.kind === 'turn.interrupted') {
    const t = openReplayTurn(ctx);
    if (t === undefined) return true;
    setTurnState(ctx, t.key, 'interrupted', { endedBy: o.p.marker === 'tool_use' ? 'tool_use_interrupt' : 'interrupt', src: 'transcript' });
    setReplayTurn(ctx, undefined);
    return true;
  }
  return false;
}
