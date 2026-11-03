// core/decide/agents.ts — subagents, internal ("ghost") agents, teammates, background tasks (DESIGN.md §4.5.2–§4.5.4,
// §4.5.9, §4.6 Agent; RC §5.3–§5.5, §10.3). Agents and bgTasks are session-scoped: a generation end never closes them.

import type { AgentKey, ToolKey, TurnKey } from '../../model/ids.js';
import type { AgentRef, BgTaskInfo, Observation } from '../../model/observation.js';
import type { AgentRecord, BackgroundTask } from '../../model/state.js';
import { arm, cfg, diag, dom, emit, mint, newProvenance, nowOf, patch, publish, recon, seqOf, srcOf, updRecon } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { mkFact } from '../facts.js';
import { isPermOpen, isToolTerminal } from '../lattice.js';
import type { ApplyVerdict } from '../lattice.js';
import { isRecord } from '../reconcile/canonical.js';
import { pickSpawnTool } from '../reconcile/spawn-link.js';
import { isBgTaskOpen } from '../selectors.js';
import { agentById, agentRec, putAgent, putTool, resumeAgent, setAgentState, setToolState, toolByUseId, toolRec } from './entities.js';
import { closeAgentCalls } from './model-calls.js';
import { abandonPermission } from './permissions.js';

function runInBackground(input: unknown): boolean {
  return isRecord(input) && input['run_in_background'] === true;
}

function warnTeammate(ctx: Ctx): void {
  if (recon(ctx).teammateWarned === true) return;
  updRecon(ctx, (r) => ({ ...r, teammateWarned: true }));
  publish(ctx, 'warning', {
    code: 'E_UNSUPPORTED_FEATURE',
    message: 'agent teams are unsupported in v1; teammate activity is attributed to its own agent',
    detail: { reason: 'agentTeams' },
  });
}

interface CreateOpts {
  agentId: string;
  agentType: string;
  kind: AgentRecord['kind'];
  background: boolean;
  spawnTool?: ToolKey | undefined;
  confirmed?: boolean;
}

function createAgent(ctx: Ctx, o: CreateOpts): AgentRecord {
  const key = mint(ctx, 'agent');
  const a: AgentRecord = {
    key,
    agentId: o.agentId,
    agentType: o.agentType,
    kind: o.kind,
    background: o.background,
    spawnLinkConfirmed: o.confirmed === true,
    depth: 1,
    state: mkFact('running', srcOf(ctx), seqOf(ctx), nowOf(ctx)),
    runs: 1,
    fileMissing: false,
    notifications: [],
    startedAt: nowOf(ctx),
    provenance: newProvenance(ctx),
  };
  const gen = dom(ctx).claude.currentGen;
  if (gen !== undefined) a.gen = gen;
  if (o.spawnTool !== undefined) {
    a.spawnTool = o.spawnTool;
    const t = toolRec(ctx, o.spawnTool);
    if (t?.agent !== undefined) {
      a.parent = t.agent;
      a.depth = (agentRec(ctx, t.agent)?.depth ?? 0) + 1;
    }
    if (t !== undefined) putTool(ctx, { ...t, spawned: key }, 'spawn link');
  }
  putAgent(ctx, a, 'agent created');
  updRecon(ctx, (r) => ({ ...r, aliases: { ...r.aliases, agentId: { ...r.aliases.agentId, [o.agentId]: key } } }));
  const ev: {
    agentKey: AgentKey;
    agentId: string;
    agentType: string;
    background: boolean;
    internal: boolean;
    teammate: boolean;
    spawnToolKey?: ToolKey;
  } = {
    agentKey: key,
    agentId: o.agentId,
    agentType: o.agentType,
    background: o.background,
    internal: o.kind === 'internal',
    teammate: o.kind === 'teammate',
  };
  if (o.spawnTool !== undefined) ev.spawnToolKey = o.spawnTool;
  publish(ctx, 'subagent.started', ev);
  if (o.spawnTool !== undefined)
    publish(ctx, 'subagent.linked', { agentKey: key, spawnToolKey: o.spawnTool, confirmed: o.confirmed === true });
  const sid = dom(ctx).claude.sessionId;
  if (sid !== undefined && o.kind !== 'teammate')
    emit<'tail.expectSubagent'>(ctx, { kind: 'tail.expectSubagent', sessionId: sid, agentId: o.agentId });
  if (o.kind === 'teammate') warnTeammate(ctx);
  return agentRec(ctx, key) ?? a;
}

/**
 * The agent of a subagent-scoped observation; creates it when unknown: a teammate (teammate_name, §4.5.9), a subagent
 * linked to a spawn candidate (§4.5.2), else an internal agent (§4.5.3).
 */
export function ensureAgentForRef(ctx: Ctx, ref: AgentRef): AgentRecord | undefined {
  if (ref.agentId === '') return undefined;
  const known = agentById(ctx, ref.agentId);
  if (known !== undefined) return known;
  if (ref.teammateName !== undefined)
    return createAgent(ctx, { agentId: ref.agentId, agentType: ref.agentType ?? 'teammate', kind: 'teammate', background: true });
  const type = ref.agentType ?? '';
  const spawn = type === '' ? undefined : pickSpawnTool(dom(ctx), type);
  if (spawn !== undefined) {
    const t = toolRec(ctx, spawn);
    return createAgent(ctx, {
      agentId: ref.agentId,
      agentType: type,
      kind: 'subagent',
      background: runInBackground(t?.input),
      spawnTool: spawn,
    });
  }
  return createAgent(ctx, { agentId: ref.agentId, agentType: type, kind: type === '' ? 'internal' : 'unknown', background: false });
}

/** SubagentStart: link (§4.5.2) or resume a known id (runs++). */
export function onAgentStarted(ctx: Ctx, o: Extract<Observation, { kind: 'agent.started' }>): void {
  const ref = o.p.agent;
  const known = agentById(ctx, ref.agentId);
  if (known !== undefined) {
    if (known.state.value !== 'running') resumeAgent(ctx, known.key);
    if (known.kind === 'unknown' && ref.agentType !== undefined && ref.agentType !== '') {
      const spawn = pickSpawnTool(dom(ctx), ref.agentType);
      const n: AgentRecord = { ...(agentRec(ctx, known.key) ?? known), agentType: ref.agentType, kind: 'subagent' };
      if (spawn !== undefined && n.spawnTool === undefined) {
        n.spawnTool = spawn;
        const t = toolRec(ctx, spawn);
        if (t !== undefined) putTool(ctx, { ...t, spawned: known.key }, 'late spawn link');
        publish(ctx, 'subagent.linked', { agentKey: known.key, spawnToolKey: spawn, confirmed: false });
      }
      putAgent(ctx, n, 'agent typed');
    }
    return;
  }
  ensureAgentForRef(ctx, ref);
}

/** SubagentStop: stop; its open tools → unknown (closing rule 2); self entries in background_tasks are ignored (P-REC-08). */
export function onAgentStopped(ctx: Ctx, o: Extract<Observation, { kind: 'agent.stopped' }>): void {
  const p = o.p;
  const a = ensureAgentForRef(ctx, p.agent);
  if (a === undefined) return;
  const patchRec: Partial<AgentRecord> = {};
  if (p.lastAssistantMessage !== undefined) patchRec.lastAssistantMessage = p.lastAssistantMessage;
  if (p.transcriptPath !== undefined) patchRec.transcriptPath = p.transcriptPath;
  stopAgent(ctx, a.key, 'stopped', { patch: patchRec });
  upsertBgTasks(
    ctx,
    p.backgroundTasks.filter((t) => t.id !== a.agentId),
  );
  // a background agent stopping also stops its bgTask entry
  const bt = dom(ctx).bgTasks[a.agentId];
  if (bt !== undefined && isBgTaskOpen(bt.status)) upsertTask(ctx, { ...bt, status: 'completed', updatedAt: nowOf(ctx) });
}

/**
 * Every agent stop goes through here (SubagentStop, a finished task notification, meta.json `finished`, rule 3 / drain →
 * `unknown`). On the first stop: closing rule 2 (§4.8) — its open ToolRuns → unknown (`agent_stopped`), their open
 * permissions abandoned, its open model calls → unknown — then, for `stopped`, `subagent.stopped` and
 * `tail.subagentStopped`. A later stop of the same run is ignored by the lattice and only enriches the record.
 */
export function stopAgent(
  ctx: Ctx,
  k: AgentKey,
  next: 'stopped' | 'unknown',
  o: { patch?: Partial<AgentRecord>; abandonReason?: string } = {},
): ApplyVerdict {
  const v = setAgentState(ctx, k, next, o.patch ?? {});
  if (v === 'ignore') return v;
  closeAgentRun(ctx, k, o.abandonReason ?? 'agentStopped');
  const a = agentRec(ctx, k);
  if (next !== 'stopped' || a === undefined) return v;
  const ev: { agentKey: AgentKey; lastAssistantMessage?: string; fileMissing: boolean } = { agentKey: k, fileMissing: a.fileMissing };
  if (o.patch?.lastAssistantMessage !== undefined) ev.lastAssistantMessage = o.patch.lastAssistantMessage;
  publish(ctx, 'subagent.stopped', ev);
  // its task-notification is due (selectors.awaitedNotifications): re-derive the status when the grace ends (F-2)
  if (a.background && a.kind === 'subagent' && a.notifications.length === 0)
    arm(ctx, 'escGap', `notify:${k}`, nowOf(ctx) + cfg(ctx).timeouts.transcriptSettleMs);
  const sid = dom(ctx).claude.sessionId;
  if (sid !== undefined && a.kind !== 'teammate') {
    const it: { kind: 'tail.subagentStopped'; sessionId: string; agentId: string; path?: string } = {
      kind: 'tail.subagentStopped',
      sessionId: sid,
      agentId: a.agentId,
    };
    if (a.transcriptPath !== undefined) it.path = a.transcriptPath;
    emit<'tail.subagentStopped'>(ctx, it);
  }
  return v;
}

/** Closing rule 2: an agent stopped → its open ToolRuns → unknown (`agent_stopped`), their permissions abandoned, its calls unknown. */
function closeAgentRun(ctx: Ctx, k: AgentKey, abandonReason: string): void {
  for (const t of Object.values(dom(ctx).tools)) {
    if (t.agent !== k || isToolTerminal(t.state.value)) continue;
    setToolState(ctx, t.key, 'unknown', { outcomeFrom: 'closing_rule', error: 'agent_stopped' });
    const perm = t.permission === undefined ? undefined : dom(ctx).permissions[t.permission];
    if (perm !== undefined && isPermOpen(perm.state.value)) abandonPermission(ctx, perm.key, abandonReason);
  }
  closeAgentCalls(ctx, k);
}

/** agent.meta (meta.json): toolUseId confirms or re-binds the spawn link; spawnDepth enriches. */
export function onAgentMeta(ctx: Ctx, o: Extract<Observation, { kind: 'agent.meta' }>): void {
  const p = o.p;
  const a =
    agentById(ctx, p.agentId) ??
    ensureAgentForRef(ctx, { agentId: p.agentId, ...(p.agentType !== undefined ? { agentType: p.agentType } : {}) });
  if (a === undefined) return;
  let n: AgentRecord = { ...a };
  if (p.spawnDepth !== undefined) n.depth = p.spawnDepth;
  if (p.agentType !== undefined && n.agentType === '') n.agentType = p.agentType;
  putAgent(ctx, n, 'agent meta');
  if (p.toolUseId !== undefined) confirmSpawnLink(ctx, a.key, p.toolUseId);
  n = agentRec(ctx, a.key) ?? n;
  if (p.finished === true && n.state.value === 'running') stopAgent(ctx, a.key, 'stopped');
}

/** Confirm (or re-bind) the spawn link from evidence naming the Agent tool's tool_use_id (§4.5.2). */
function confirmSpawnLink(ctx: Ctx, agentKey: AgentKey, toolUseId: string): void {
  const a = agentRec(ctx, agentKey);
  const t = toolByUseId(ctx, toolUseId);
  if (a === undefined || t === undefined) return;
  if (a.spawnTool === t.key) {
    if (!a.spawnLinkConfirmed) {
      putAgent(ctx, { ...a, spawnLinkConfirmed: true }, 'spawn link confirmed');
      publish(ctx, 'subagent.linked', { agentKey, spawnToolKey: t.key, confirmed: true });
    }
    return;
  }
  if (a.spawnTool !== undefined) {
    const old = toolRec(ctx, a.spawnTool);
    if (old?.spawned === agentKey) {
      const o2 = { ...old };
      delete o2.spawned;
      putTool(ctx, o2, 'spawn unlink');
    }
  }
  const kind: AgentRecord['kind'] = a.kind === 'internal' || a.kind === 'unknown' ? 'subagent' : a.kind;
  putAgent(ctx, { ...a, spawnTool: t.key, spawnLinkConfirmed: true, kind }, 'spawn link rebound');
  putTool(ctx, { ...t, spawned: agentKey }, 'spawn link');
  publish(ctx, 'subagent.linked', { agentKey, spawnToolKey: t.key, confirmed: true });
}

/** PostToolUse(Agent) with tool_response.agentId / async_launched: the agent exists (created if first), link confirmed. */
export function linkAgentFromTool(ctx: Ctx, toolKey: ToolKey, agentId: string, background: boolean): void {
  const t = toolRec(ctx, toolKey);
  if (t === undefined) return;
  let a = agentById(ctx, agentId);
  if (a === undefined) {
    const type = isRecord(t.input) && typeof t.input['subagent_type'] === 'string' ? t.input['subagent_type'] : 'general-purpose';
    a = createAgent(ctx, { agentId, agentType: type, kind: 'subagent', background, spawnTool: toolKey, confirmed: true });
    return;
  }
  if (background && !a.background) putAgent(ctx, { ...a, background: true }, 'background agent');
  if (t.toolUseId !== undefined) confirmSpawnLink(ctx, a.key, t.toolUseId);
}

function upsertTask(ctx: Ctx, t: BackgroundTask): void {
  const cur = dom(ctx).bgTasks[t.id];
  if (cur?.status === t.status && cur.type === t.type) return;
  patch(ctx, ['bgTasks', t.id], t, 'bgtask');
  publish(ctx, 'bgtask.updated', { taskId: t.id, type: t.type, status: t.status });
}

export function upsertBgTasks(ctx: Ctx, tasks: readonly BgTaskInfo[]): void {
  for (const info of tasks) {
    const cur = dom(ctx).bgTasks[info.id];
    const t: BackgroundTask = { ...(cur ?? {}), id: info.id, type: info.type, status: info.status, updatedAt: nowOf(ctx) };
    const a = agentById(ctx, info.id);
    if (a !== undefined) t.agent = a.key;
    const gen = dom(ctx).claude.currentGen;
    if (t.gen === undefined && gen !== undefined) t.gen = gen;
    upsertTask(ctx, t);
    if (info.type === 'teammate') ensureTeammate(ctx, info.id, info.agentType);
  }
}

function ensureTeammate(ctx: Ctx, id: string, agentType: string | undefined): void {
  if (agentById(ctx, id) !== undefined) return;
  createAgent(ctx, { agentId: id, agentType: agentType ?? 'teammate', kind: 'teammate', background: true });
}

/** bgtask.status (teammate entries of background_tasks, task notifications). */
export function onBgTaskStatus(ctx: Ctx, o: Extract<Observation, { kind: 'bgtask.status' }>): void {
  const p = o.p;
  const info: BgTaskInfo = { id: p.taskId, type: p.taskType, status: p.status };
  upsertBgTasks(ctx, [info]);
  const t = dom(ctx).bgTasks[p.taskId];
  if (t !== undefined && p.toolUseId !== undefined && t.toolUseId === undefined)
    patch(ctx, ['bgTasks', p.taskId], { ...t, toolUseId: p.toolUseId }, 'bgtask tool');
}

/** A `<task-notification>` turn: link causedBy, record the notification, stop a finished background agent (§4.5.4). */
export function noteTaskNotification(
  ctx: Ctx,
  turn: TurnKey,
  n: { taskId: string; toolUseId?: string | undefined; status: string },
): { agent?: AgentKey; tool?: ToolKey } {
  let a = agentById(ctx, n.taskId);
  const tool = toolByUseId(ctx, n.toolUseId);
  if (a === undefined && tool?.spawned !== undefined) a = agentRec(ctx, tool.spawned);
  const r: { agent?: AgentKey; tool?: ToolKey } = {};
  if (tool !== undefined) r.tool = tool.key;
  if (a !== undefined) {
    r.agent = a.key;
    putAgent(ctx, { ...a, notifications: [...a.notifications, turn] }, 'task notification');
    if (!isBgTaskOpen(n.status) && a.state.value === 'running') stopAgent(ctx, a.key, 'stopped');
    if (tool?.toolUseId !== undefined) confirmSpawnLink(ctx, a.key, tool.toolUseId);
  } else {
    diag(ctx, 'task_notification_unknown_agent', { taskId: n.taskId });
  }
  const bt = dom(ctx).bgTasks[n.taskId];
  upsertTask(ctx, {
    ...(bt ?? { type: 'local_agent' }),
    id: n.taskId,
    status: n.status,
    updatedAt: nowOf(ctx),
    ...(r.agent !== undefined ? { agent: r.agent } : {}),
  });
  return r;
}

export function onAgentFileMissing(ctx: Ctx, o: Extract<Observation, { kind: 'agent.fileMissing' }>): void {
  const a = agentById(ctx, o.p.agentId);
  if (a === undefined) return;
  if (!a.fileMissing) putAgent(ctx, { ...a, fileMissing: true }, 'file missing');
  if (a.kind !== 'internal') diag(ctx, 'agent_file_missing', { agentId: a.agentId });
}
