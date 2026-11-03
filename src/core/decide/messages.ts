// core/decide/messages.ts — assistant blocks, MessageDisplay deltas, final text, refusal retraction
// (DESIGN.md §4.5.6, §4.5.10, §4.6 Message; RC §5.7; TF §4.3 usage once per (message.id, requestId)).

import type { MsgKey, ModelCallKey, TurnKey } from '../../model/ids.js';
import type { Observation, TokenUsage } from '../../model/observation.js';
import type { MessageRecord } from '../../model/state.js';
import { arm, cfg, diag, dom, mint, nowOf, patch, publish, recon, seqOf, srcOf, updRecon } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { mkFact } from '../facts.js';
import { isTurnTerminal } from '../lattice.js';
import { matchUiMessage } from '../reconcile/text-match.js';
import {
  agentById,
  callRec,
  continueTurn,
  mainTurn,
  msgRec,
  putCall,
  putMsg,
  putTurn,
  setCallState,
  setTurnState,
  turnByPromptId,
  turnOfAgent,
  turnRec,
} from './entities.js';

function newMsg(ctx: Ctx, turn: TurnKey | undefined, o: Partial<MessageRecord>): MessageRecord {
  const key = mint(ctx, 'msg');
  const m: MessageRecord = {
    key,
    uuids: [],
    text: '',
    final: false,
    confirmed: false,
    retracted: false,
    blocks: 0,
    usageCounted: false,
    ...o,
  };
  if (turn !== undefined) m.turn = turn;
  putMsg(ctx, m, 'message created');
  const t = turnRec(ctx, turn);
  if (t !== undefined && !t.messages.includes(key)) putTurn(ctx, { ...t, messages: [...t.messages, key] }, 'turn message');
  return m;
}

/** Implicit final (rev 2 §10 A10): a later tool.pre, model request, newer uiMessageId, Stop or turn end finals open UiMessages. */
export function implicitFinalForTurn(ctx: Ctx, turn: TurnKey | undefined, except?: MsgKey): void {
  const t = turnRec(ctx, turn);
  if (t === undefined) return;
  for (const k of t.messages) {
    if (k === except) continue;
    const m = msgRec(ctx, k);
    if (m?.uiMessageId !== undefined && !m.final) putMsg(ctx, { ...m, final: true, finalBy: 'implicit' }, 'implicit final');
  }
}

/** MessageDisplay delta (hook): UiMessage keyed by uiMessageId, concatenated by index (out-of-order accepted). */
export function onTextDelta(ctx: Ctx, o: Extract<Observation, { kind: 'message.textDelta' }>): void {
  const p = o.p;
  const byPrompt = turnByPromptId(ctx, p.promptId);
  const active = mainTurn(ctx);
  let turn = active ?? byPrompt;
  if (byPrompt !== undefined && isTurnTerminal(byPrompt.state.value)) turn = byPrompt;
  turn ??= mainTurn(ctx, true);
  if (turn === undefined) {
    diag(ctx, 'text_delta_no_turn', { uiMessageId: p.uiMessageId });
    return;
  }
  const held = turn.state.provisional && dom(ctx).activeTurn === turn.key; // provisional (screen) interrupt
  const late = isTurnTerminal(turn.state.value) && !held;
  if (late) {
    const endedAt = turn.endedAt ?? nowOf(ctx);
    if (nowOf(ctx) - endedAt > cfg(ctx).timeouts.lateTextMs) {
      diag(ctx, 'late_text_dropped', { turn: turn.key, uiMessageId: p.uiMessageId });
      return;
    }
  }
  const existing = msgRec(ctx, recon(ctx).aliases.uiMsgId[p.uiMessageId]);
  let m: MessageRecord;
  if (existing !== undefined) m = existing;
  else {
    m = newMsg(ctx, turn.key, { uiMessageId: p.uiMessageId });
    const mk = m.key;
    updRecon(ctx, (r) => ({ ...r, aliases: { ...r.aliases, uiMsgId: { ...r.aliases.uiMsgId, [p.uiMessageId]: mk } } }));
    implicitFinalForTurn(ctx, turn.key, m.key);
  }
  const chunks = { ...(recon(ctx).uiChunks[m.key] ?? {}), [p.index]: p.delta };
  updRecon(ctx, (r) => ({ ...r, uiChunks: { ...r.uiChunks, [m.key]: chunks } }));
  const text = Object.keys(chunks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => chunks[i] ?? '')
    .join('');
  const n: MessageRecord = { ...m, text };
  if (p.final) {
    n.final = true;
    n.finalBy = 'flag';
  }
  putMsg(ctx, n, 'text delta');
  publish(ctx, 'assistant.textDelta', { msgKey: m.key, index: p.index, delta: p.delta, final: p.final }, { turnKey: turn.key });
  if (late) {
    publish(ctx, 'turn.textAppended', { msgKey: m.key }, { turnKey: turn.key });
    return;
  }
  // A MessageDisplay that arrives after the Stop (turn `stopping`, inside stopGrace) is text shown after the turn's final
  // answer was fixed from `last_assistant_message`: `turn.textAppended` (events §2.5, P-REC-32, K-26). WP-INT fix (ICR 0016).
  if (turn.state.value === 'stopping') publish(ctx, 'turn.textAppended', { msgKey: m.key }, { turnKey: turn.key });
  continueTurn(ctx, turn.key);
  // stopping + final MessageDisplay → completed (§4.4#11)
  const t = turnRec(ctx, turn.key);
  if (p.final && t?.state.value === 'stopping') {
    setTurnState(ctx, t.key, 'completed', { endedBy: 'stop', src: 'hook' });
    arm(ctx, 'lateText', t.key, nowOf(ctx) + cfg(ctx).timeouts.lateTextMs);
  }
}

function addUsage(
  ctx: Ctx,
  apiMessageId: string,
  requestId: string | undefined,
  usage: TokenUsage | undefined,
  m: MessageRecord,
  call?: ModelCallKey,
): void {
  if (usage === undefined) return;
  const k = `${apiMessageId}|${requestId ?? ''}`;
  if (recon(ctx).usageCounted[k] === true) return;
  updRecon(ctx, (r) => ({ ...r, usageCounted: { ...r.usageCounted, [k]: true } }));
  const tot = dom(ctx).usage.tokensTotal;
  const next: TokenUsage = {
    inputTokens: tot.inputTokens + usage.inputTokens,
    outputTokens: tot.outputTokens + usage.outputTokens,
  };
  const cc = (tot.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  const cr = (tot.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  if (cc > 0) next.cacheCreationInputTokens = cc;
  if (cr > 0) next.cacheReadInputTokens = cr;
  patch(ctx, ['usage', 'tokensTotal'], next, 'usage');
  const cur = msgRec(ctx, m.key);
  if (cur !== undefined) putMsg(ctx, { ...cur, usageCounted: true }, 'usage counted');
  const c = callRec(ctx, call);
  if (c !== undefined) putCall(ctx, { ...c, usage }, 'call usage');
}

/** transcript assistant block (thinking | text | tool_use). Tool-use ToolRuns are handled by decide/tools.ts. */
export function onMessageBlock(
  ctx: Ctx,
  o: Extract<Observation, { kind: 'message.block' }>,
): { msgKey: MsgKey; turn?: TurnKey | undefined } {
  const p = o.p;
  const agent = agentById(ctx, o.meta.agentId);
  const turnKey = agent !== undefined ? turnOfAgent(ctx, agent) : mainTurn(ctx, true)?.key;
  let call: ModelCallKey | undefined = p.requestRef !== undefined ? recon(ctx).aliases.requestRef[p.requestRef] : undefined;
  if (call === undefined && p.requestId !== undefined) call = recon(ctx).aliases.requestRef[p.requestId];
  let m = msgRec(ctx, recon(ctx).aliases.apiMsgId[p.apiMessageId]);
  if (m === undefined && p.block === 'text' && p.text !== undefined && agent === undefined) {
    const ui = matchUiMessage(dom(ctx), turnKey, p.text);
    if (ui !== undefined) m = msgRec(ctx, ui);
  }
  if (m === undefined) {
    const init: Partial<MessageRecord> = { apiMessageId: p.apiMessageId, final: true, confirmed: true };
    if (agent !== undefined) init.agent = agent.key;
    m = newMsg(ctx, turnKey, init);
  }
  const n: MessageRecord = { ...m, apiMessageId: p.apiMessageId, blocks: m.blocks + 1, confirmed: true };
  if (o.meta.uuid !== undefined && !n.uuids.includes(o.meta.uuid)) n.uuids = [...n.uuids, o.meta.uuid];
  if (p.uuid !== '' && !n.uuids.includes(p.uuid)) n.uuids = [...n.uuids, p.uuid];
  if (p.block === 'text' && p.text !== undefined && m.uiMessageId === undefined) n.text = m.text === '' ? p.text : `${m.text}\n${p.text}`;
  putMsg(ctx, n, 'message block');
  const mk = m.key;
  updRecon(ctx, (r) => ({
    ...r,
    aliases: {
      ...r.aliases,
      apiMsgId: { ...r.aliases.apiMsgId, [p.apiMessageId]: mk },
      entryUuid: p.uuid !== '' ? { ...r.aliases.entryUuid, [p.uuid]: mk } : r.aliases.entryUuid,
    },
    msgCall: call !== undefined ? { ...r.msgCall, [mk]: call } : r.msgCall,
  }));
  addUsage(ctx, p.apiMessageId, p.requestId, p.usage, n, call);
  const ev: {
    msgKey: MsgKey;
    apiMessageId: string;
    blockIndex: number;
    block: 'thinking' | 'text' | 'tool_use';
    text?: string;
    agentKey?: NonNullable<MessageRecord['agent']>;
  } = {
    msgKey: mk,
    apiMessageId: p.apiMessageId,
    blockIndex: p.blockIndex,
    block: p.block,
  };
  if (p.text !== undefined && p.block !== 'thinking') ev.text = p.text;
  if (agent !== undefined) ev.agentKey = agent.key;
  publish(ctx, 'assistant.block', ev, { turnKey });
  // a block of a call ends the call (usage once); a stop_reason of null means more blocks follow
  if (call !== undefined && p.stopReason !== null) setCallState(ctx, call, 'ended');
  return { msgKey: mk, turn: turnKey };
}

function retract(ctx: Ctx, keys: MsgKey[], reason: 'refusalFallback' | 'refused'): void {
  const fresh = keys.filter((k) => {
    const m = msgRec(ctx, k);
    return m !== undefined && !m.retracted;
  });
  if (fresh.length === 0) return;
  const turns = new Set<TurnKey>();
  for (const k of fresh) {
    const m = msgRec(ctx, k);
    if (m === undefined) continue;
    putMsg(ctx, { ...m, retracted: true }, `retracted:${reason}`);
    if (m.turn !== undefined) turns.add(m.turn);
    const c = recon(ctx).msgCall[k];
    if (c !== undefined) setCallState(ctx, c, 'refused');
  }
  publish(ctx, 'assistant.retracted', { msgKeys: fresh, reason });
  // finalText: retracted text is removed unless Stop.last_assistant_message (hook) states it (§4.5.10)
  for (const tk of turns) {
    const t = turnRec(ctx, tk);
    if (t?.finalText === undefined || t.finalText.src === 'hook') continue;
    const text = t.messages
      .map((k) => msgRec(ctx, k))
      .filter((m): m is MessageRecord => m !== undefined && !m.retracted && m.final)
      .map((m) => m.text)
      .join('\n');
    putTurn(ctx, { ...t, finalText: mkFact(text, srcOf(ctx), seqOf(ctx), nowOf(ctx)) }, 'finalText without retracted');
  }
}

/** transcript isMeta user entry with refusedMessageId (TF §4.2 #8). */
export function onRefused(ctx: Ctx, o: Extract<Observation, { kind: 'model.refused' }>): void {
  const k = recon(ctx).aliases.apiMsgId[o.p.refusedMessageId];
  const m = msgRec(ctx, k);
  const turn = m?.turn ?? mainTurn(ctx, true)?.key;
  const t = turnRec(ctx, turn);
  if (t !== undefined && t.refused === undefined) putTurn(ctx, { ...t, refused: { refusedMessageId: o.p.refusedMessageId } }, 'refused');
  if (k !== undefined) retract(ctx, [k], 'refused');
  else diag(ctx, 'refused_unknown_message', { refusedMessageId: o.p.refusedMessageId });
}

/** system:model_refusal_fallback (TF §4.4): logical retraction of the listed uuids, model ← fallbackModel. */
export function onRefusalFallback(ctx: Ctx, o: Extract<Observation, { kind: 'model.refusalFallback' }>): void {
  const p = o.p;
  const keys = new Set<MsgKey>();
  for (const u of p.retractedMessageUuids) {
    const viaAlias = recon(ctx).aliases.entryUuid[u];
    if (viaAlias !== undefined) keys.add(viaAlias);
  }
  for (const m of Object.values(dom(ctx).messages)) if (m.uuids.some((u) => p.retractedMessageUuids.includes(u))) keys.add(m.key);
  const list = [...keys];
  const first = msgRec(ctx, list[0]);
  const t = turnRec(ctx, first?.turn ?? mainTurn(ctx, true)?.key);
  if (t !== undefined) {
    const refused: NonNullable<typeof t.refused> = { refusedMessageId: t.refused?.refusedMessageId ?? p.refusedUserMessageUuid ?? '' };
    if (p.fallbackModel !== undefined) refused.fallbackModel = p.fallbackModel;
    putTurn(ctx, { ...t, refused }, 'refusal fallback');
  }
  retract(ctx, list, 'refusalFallback');
  if (p.fallbackModel !== undefined) {
    patch(ctx, ['claude', 'model'], mkFact(p.fallbackModel, 'transcript', seqOf(ctx), nowOf(ctx)), 'refusal fallback model');
    publish(ctx, 'session.modelChanged', { model: p.fallbackModel, source: 'refusalFallback' });
  }
}
