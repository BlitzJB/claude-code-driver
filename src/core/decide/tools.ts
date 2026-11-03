// core/decide/tools.ts — ToolRun transitions (DESIGN.md §4.6 ToolRun, RC §10.3; no elapsed-time timeout ever, RC §12).

import { stableStringify } from '../../model/json.js';
import type { ResponseRef } from '../../model/events.js';
import type { ToolKey, TurnKey } from '../../model/ids.js';
import type { AgentRef, Observation } from '../../model/observation.js';
import type { ToolRun, ToolState } from '../../model/state.js';
import { arm, cfg, diag, dom, mint, newProvenance, nowOf, publish, seqOf, srcOf, updRecon } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { mkFact } from '../facts.js';
import { sha256Hex } from '../input-policy/ack-match.js';
import { isToolTerminal } from '../lattice.js';
import { isRecord, strField } from '../reconcile/canonical.js';
import {
  agentById,
  continueTurn,
  mainTurn,
  putTool,
  putTurn,
  setToolState,
  toolByUseId,
  toolRec,
  turnOfAgent,
  turnRec,
} from './entities.js';
import type { ToolStateOpts } from './entities.js';
import { ensureAgentForRef } from './agents.js';
import { implicitFinalForTurn } from './messages.js';

const PREVIEW_BYTES = 4096;

function responseRefOf(response: unknown, truncated = false): ResponseRef {
  const s = typeof response === 'string' ? response : stableStringify(response ?? null);
  const preview = s.length > PREVIEW_BYTES ? s.slice(0, PREVIEW_BYTES) : s;
  return { bytes: s.length, sha256_16: sha256Hex(s).slice(0, 16), preview, truncated: truncated || s.length > PREVIEW_BYTES };
}

/** Turn of a tool observation: main thread → active turn; subagent → its spawning tool's turn (§4.4 attribution). */
function attribute(ctx: Ctx, agent: AgentRef | undefined): { turn?: TurnKey; agent?: ToolRun['agent'] } {
  if (agent === undefined) {
    const t = mainTurn(ctx);
    return t === undefined ? {} : { turn: t.key };
  }
  const a = ensureAgentForRef(ctx, agent);
  if (a === undefined) return {};
  const turn = turnOfAgent(ctx, a);
  return turn === undefined ? { agent: a.key } : { agent: a.key, turn };
}

function createTool(
  ctx: Ctx,
  f: {
    toolUseId?: string;
    name: string;
    input: unknown;
    agent?: AgentRef | undefined;
    state: ToolState;
    promptId?: string | undefined;
    provisional?: boolean;
  },
): ToolRun {
  const key = mint(ctx, 'tool');
  const at = attribute(ctx, f.agent);
  const t: ToolRun = {
    key,
    name: f.name,
    input: f.input,
    state: mkFact(f.state, srcOf(ctx), seqOf(ctx), nowOf(ctx), f.provisional === true),
    startedAt: nowOf(ctx),
    provenance: newProvenance(ctx),
  };
  if (f.toolUseId !== undefined && f.toolUseId !== '') t.toolUseId = f.toolUseId;
  if (at.turn !== undefined) t.turn = at.turn;
  if (at.agent !== undefined) t.agent = at.agent;
  if (f.promptId !== undefined && f.promptId !== '') t.promptIdAtPre = f.promptId;
  putTool(ctx, t, 'tool created');
  if (t.toolUseId !== undefined) {
    const id = t.toolUseId;
    updRecon(ctx, (r) => ({ ...r, aliases: { ...r.aliases, toolUseId: { ...r.aliases.toolUseId, [id]: key } } }));
  }
  if (at.turn !== undefined) {
    const turn = turnRec(ctx, at.turn);
    if (turn !== undefined && !turn.tools.includes(key)) putTurn(ctx, { ...turn, tools: [...turn.tools, key] }, 'turn tool');
  }
  const started: { toolKey: ToolKey; toolUseId?: string; name: string; input: unknown; agentKey?: NonNullable<ToolRun['agent']> } = {
    toolKey: key,
    name: t.name,
    input: t.input,
  };
  if (t.toolUseId !== undefined) started.toolUseId = t.toolUseId;
  if (t.agent !== undefined) started.agentKey = t.agent;
  publish(ctx, 'tool.started', started, { turnKey: t.turn });
  return toolRec(ctx, key) ?? t;
}

/** `(none)+tool.pre → pending`; `proposed + tool.pre → pending` (§4.6). */
export function onToolPre(ctx: Ctx, o: Extract<Observation, { kind: 'tool.pre' }>): ToolKey {
  const p = o.p;
  const existing = toolByUseId(ctx, p.toolUseId);
  if (existing !== undefined) {
    const n: ToolRun = { ...existing, preSeq: o.meta.seq, preAt: nowOf(ctx) };
    if (p.promptId !== undefined && p.promptId !== '') n.promptIdAtPre = p.promptId;
    putTool(ctx, n, 'pre after transcript');
    if (existing.state.value === 'proposed') setToolState(ctx, existing.key, 'pending');
    return existing.key;
  }
  const t = createTool(ctx, {
    toolUseId: p.toolUseId,
    name: p.toolName,
    input: p.input,
    agent: p.agent,
    state: 'pending',
    promptId: p.promptId,
  });
  putTool(ctx, { ...t, preSeq: o.meta.seq, preAt: nowOf(ctx) }, 'pre');
  if (p.agent === undefined && t.turn !== undefined) {
    implicitFinalForTurn(ctx, t.turn);
    continueTurn(ctx, t.turn);
  }
  return t.key;
}

function closeOrCreate(
  ctx: Ctx,
  f: { toolUseId: string; name: string; input?: unknown; agent?: AgentRef | undefined },
  next: ToolState,
  opts: ToolStateOpts,
): ToolKey {
  const t = toolByUseId(ctx, f.toolUseId);
  if (t === undefined) {
    // first sight is terminal: placeholder (P-REC-26/31, anomaly post_without_pre)
    const created = createTool(ctx, { toolUseId: f.toolUseId, name: f.name, input: f.input ?? null, agent: f.agent, state: 'pending' });
    diag(ctx, 'post_without_pre', { toolUseId: f.toolUseId, name: f.name });
    setToolState(ctx, created.key, next, opts);
    return created.key;
  }
  setToolState(ctx, t.key, next, opts);
  return t.key;
}

/** PostToolUse: `async_launched` → launched then succeeded (the agent keeps running, P-REC-06); else succeeded. */
export function onToolPost(ctx: Ctx, o: Extract<Observation, { kind: 'tool.post' }>): ToolKey {
  const p = o.p;
  const ref = responseRefOf(p.response, p.responseTruncated === true);
  const base: ToolStateOpts = { outcomeFrom: 'post', responseRef: ref };
  if (p.durationMs !== undefined) base.durationMs = p.durationMs;
  let k: ToolKey;
  if (p.asyncAgentId !== undefined) {
    const t = toolByUseId(ctx, p.toolUseId);
    k = t?.key ?? closeOrCreate(ctx, { toolUseId: p.toolUseId, name: p.toolName, input: p.input, agent: p.agent }, 'launched', {});
    setToolState(ctx, k, 'launched');
    setToolState(ctx, k, 'succeeded', base);
  } else {
    k = closeOrCreate(ctx, { toolUseId: p.toolUseId, name: p.toolName, input: p.input, agent: p.agent }, 'succeeded', base);
  }
  const t = toolRec(ctx, k);
  if (t !== undefined && p.input !== undefined && t.input !== p.input) putTool(ctx, { ...t, input: p.input }, 'executed input'); // user hooks may rewrite (HT §1.2)
  if (p.agent === undefined) continueTurn(ctx, t?.turn);
  return k;
}

export function onToolFailed(ctx: Ctx, o: Extract<Observation, { kind: 'tool.failed' }>): ToolKey {
  const p = o.p;
  const k = closeOrCreate(
    ctx,
    { toolUseId: p.toolUseId, name: p.toolName, agent: p.agent },
    p.isInterrupt === true ? 'interrupted' : 'failed',
    {
      outcomeFrom: 'post_failure',
      error: p.error,
    },
  );
  if (p.agent === undefined && p.isInterrupt !== true) continueTurn(ctx, toolRec(ctx, k)?.turn);
  return k;
}

/** PostToolBatch closes listed still-running tools (outcome from batch); a later Post only enriches (P-REC-34). */
export function onToolBatch(ctx: Ctx, o: Extract<Observation, { kind: 'tool.batchDone' }>): void {
  for (const id of o.p.toolUseIds) {
    const t = toolByUseId(ctx, id);
    if (t === undefined || isToolTerminal(t.state.value)) continue;
    setToolState(ctx, t.key, 'succeeded', { outcomeFrom: 'batch' });
  }
}

/** transcript tool_result: succeeded | failed | denied (user-rejected / permission-rule) | interrupted. */
export function toolResultState(p: Extract<Observation, { kind: 'tool.result' }>['p']): ToolState {
  const dk = p.denialKind ?? '';
  if (p.interrupted === true || dk === 'interrupted') return 'interrupted';
  if (
    dk === 'user-rejected' ||
    dk === 'permission-rule' ||
    dk === 'rejected' ||
    dk === 'denied' ||
    dk.includes('reject') ||
    dk.includes('denied')
  )
    return 'denied';
  return p.isError ? 'failed' : 'succeeded';
}

function toolWasDenied(ctx: Ctx, t: ToolRun): boolean {
  if (t.state.value === 'denied') return true;
  const perm = t.permission === undefined ? undefined : dom(ctx).permissions[t.permission];
  if (perm === undefined) return false;
  return perm.resolved?.decision === 'deny' || (perm.resolved === undefined && perm.ourAnswer?.decision === 'deny');
}

function ranWithoutDialog(ctx: Ctx, t: ToolRun): boolean {
  if (t.state.value !== 'running') return false;
  if (t.permission === undefined) return true;
  const perm = dom(ctx).permissions[t.permission];
  return perm?.state.value === 'answered' && perm.ourAnswer?.decision === 'allow' && perm.ourAnswer.via === 'hook';
}

export function onToolResult(ctx: Ctx, o: Extract<Observation, { kind: 'tool.result' }>): ToolKey | undefined {
  const p = o.p;
  let next = toolResultState(p);
  const t = toolByUseId(ctx, p.toolUseId);
  // An error result of a tool whose permission was denied (our hook deny, a rule, the human) IS the denial: it confirms
  // `denied` instead of retracting it to `failed` (K-15; a hook deny writes no toolDenialKind). ICR 0016.
  if (next === 'failed' && t !== undefined && toolWasDenied(ctx, t)) next = 'denied';
  // 2.1.316 writes an Escape during a RUNNING tool exactly like a rejection at its permission dialog (`toolDenialKind:
  // "user-rejected"`, "User rejected tool use", no permissionDecision; live L-04, docs/research/live-results.md F-4). A tool
  // whose request we allowed through the hook (delivered: the record is still `answered`, not fallen back to dialogOnly), or
  // that needed no request at all, had no dialog to reject: that result is an interrupt of the running tool.
  if (next === 'denied' && p.denialKind === 'user-rejected' && t !== undefined && ranWithoutDialog(ctx, t)) next = 'interrupted';
  const opts: ToolStateOpts = { outcomeFrom: next === 'denied' ? 'permission_deny' : 'transcript' };
  if (p.contentPreview !== undefined) opts.responseRef = responseRefOf(p.contentPreview);
  if (t === undefined) {
    const agentId = o.meta.agentId;
    const ref: AgentRef | undefined = agentId !== undefined ? { agentId } : undefined;
    return closeOrCreate(ctx, { toolUseId: p.toolUseId, name: 'unknown', agent: ref }, next, opts);
  }
  setToolState(ctx, t.key, next, opts);
  return t.key;
}

export function onToolValidationError(ctx: Ctx, o: Extract<Observation, { kind: 'tool.validationError' }>): void {
  const t = toolByUseId(ctx, o.p.toolUseId);
  if (t === undefined) {
    diag(ctx, 'validation_error_unknown_tool', { toolUseId: o.p.toolUseId });
    return;
  }
  setToolState(ctx, t.key, 'failed', { outcomeFrom: 'transcript', error: 'validation error' });
}

/** transcript tool_use block: `(none) → proposed` (+ hookGap → hooks degraded); an existing tool only gets enriched (P-REC-31). */
export function onToolUseBlock(
  ctx: Ctx,
  f: { toolUseId: string; name: string; input: unknown; apiMessageId: string; blockIndex: number; agentId?: string | undefined },
): void {
  const t = toolByUseId(ctx, f.toolUseId);
  if (t !== undefined) {
    if (t.apiMessageId === undefined) putTool(ctx, { ...t, apiMessageId: f.apiMessageId, blockIndex: f.blockIndex }, 'enrich tool_use');
    return;
  }
  const agent: AgentRef | undefined =
    f.agentId !== undefined ? (agentById(ctx, f.agentId) !== undefined ? { agentId: f.agentId } : { agentId: f.agentId }) : undefined;
  const created = createTool(ctx, { toolUseId: f.toolUseId, name: f.name, input: f.input, agent, state: 'proposed' });
  putTool(ctx, { ...created, apiMessageId: f.apiMessageId, blockIndex: f.blockIndex }, 'transcript-first tool');
  if (cfg(ctx).channels.preToolUse && dom(ctx).channels.hooks.health !== 'off')
    arm(ctx, 'hookGap', `tool:${created.key}`, nowOf(ctx) + cfg(ctx).timeouts.hookGapMs);
}

export function isAgentSpawnResponse(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  return strField(response, 'agentId') ?? strField(response, 'agent_id');
}
