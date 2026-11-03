// api/map-state.ts — internal SessionState → public snapshots (DESIGN.md §2.12 mapping discipline, AL §6.4).
// Exhaustive switches end in assertNever, so a new internal status kind is a compile error here. Internal agents, teammates
// and their tools are never exposed (§2.12). Monotonic core times are shown as wall-clock epoch ms through `TimeBase`.

import { currentTurn, displayToolState, pendingPermissions } from '../core/selectors.js';
import type { TurnOutcome } from '../model/events.js';
import type { AgentKey, TurnKey } from '../model/ids.js';
import type { Source } from '../model/observation.js';
import type {
  AgentRecord,
  AgentStatus as InternalStatus,
  PermissionMode as InternalMode,
  SessionState,
  ToolRun,
  TurnRecord,
  TurnState,
} from '../model/state.js';
import type { MonoMs } from '../model/time.js';
import { toErrorData } from './map-errors.js';
import { outcomeError } from './outcome-error.js';
import type {
  AgentStatus,
  ChannelName,
  ClaudeSessionErrorData,
  PermissionMode,
  Provenance,
  SessionSnapshot,
  SubagentKey,
  SubagentSnapshot,
  ToolKey,
  ToolRunSnapshot,
  TurnSnapshot,
} from './public-types.js';

export function assertNever(x: never): never {
  throw new Error(`claude-code-driver: unmapped internal value ${JSON.stringify(x)}`);
}

/** `{ [k]: v }` when `v` is defined, else `{}` (exactOptionalPropertyTypes). */
export function opt<K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> {
  return (v === undefined ? {} : { [k]: v }) as Partial<Record<K, V>>;
}

/** Mono → wall translation, re-anchored on every event (`wallAt − at`); before the first event it uses the host clocks. */
export class TimeBase {
  private offset: number;
  constructor(
    private readonly wallNow: () => number = Date.now,
    private readonly monoNow: () => number = () => performance.now(),
  ) {
    this.offset = wallNow() - monoNow();
  }
  observe(at: number, wallAt: number): void {
    if (Number.isFinite(at) && Number.isFinite(wallAt)) this.offset = wallAt - at;
  }
  toWall(mono: number): number {
    return Math.round(mono + this.offset);
  }
  /** The core's current mono time, estimated from the wall clock (for the display-only tool rule). */
  nowMono(): MonoMs {
    return (this.wallNow() - this.offset) as MonoMs;
  }
}

export interface MapCtx {
  readonly cwd: string;
  readonly time: TimeBase;
}

const SOURCE_CHANNEL: Readonly<Partial<Record<Source, ChannelName>>> = {
  hook: 'hooks',
  transcript: 'transcript',
  network: 'network',
  screen: 'screen',
};

export function toProvenance(p: { confirmed: boolean; sources: readonly Source[] } | undefined): Provenance {
  if (p === undefined) return { confirmed: false, sources: [] };
  const sources: ChannelName[] = [];
  for (const s of p.sources) {
    const c = SOURCE_CHANNEL[s];
    if (c !== undefined && !sources.includes(c)) sources.push(c);
  }
  return { confirmed: p.confirmed, sources };
}

export function toMode(m: InternalMode | undefined): PermissionMode | 'other' {
  return m === 'default' || m === 'acceptEdits' || m === 'plan' ? m : m === undefined ? 'default' : 'other';
}

export function toStatus(s: InternalStatus, t: TimeBase): AgentStatus {
  const since = t.toWall(s.since);
  switch (s.kind) {
    case 'starting':
    case 'compacting':
      return { kind: s.kind, since };
    case 'idle': {
      const err = s.lastTurn?.error;
      return {
        kind: 'idle',
        since,
        backgroundAgents: s.backgroundAgents,
        queued: s.queued,
        quiescent: s.quiescent,
        ...opt('lastError', err && toErrorData(err)),
      };
    }
    case 'modelRequest':
      return {
        kind: 'modelRequest',
        phase: s.phase,
        since,
        provenance: toProvenance(s.provenance),
        ...opt('attempt', s.attempt),
        ...opt('maxAttempts', s.maxAttempts),
        ...opt('retryInMs', s.retryInMs),
      };
    case 'writing':
      return { kind: 'writing', since, provenance: toProvenance(s.provenance) };
    case 'runningTools':
      return { kind: 'runningTools', tools: [...s.tools] as ToolKey[], since, provenance: toProvenance(s.provenance) };
    case 'awaitingPermission':
      return { kind: 'awaitingPermission', permission: s.permission, since };
    case 'awaitingInput':
      return { kind: 'awaitingInput', inputKind: s.inputKind, since, ...opt('message', s.message) };
    case 'interrupted':
      return { kind: 'interrupted', since };
    case 'usageLimited':
      return {
        kind: 'usageLimited',
        since,
        autoResume: s.autoResume,
        ...opt('resetsAt', s.resetsAtWall),
        ...opt('nextWakeAt', s.nextWakeAtWall),
      };
    case 'authRequired':
      return { kind: 'authRequired', since, message: s.message };
    case 'exited':
      return { kind: 'exited', since, exitStatus: s.exitStatus, signal: s.signal };
    case 'suspended':
      return { kind: 'suspended', since, claudeSessionId: s.claudeSessionId };
    default:
      return assertNever(s);
  }
}

/** Internal agents and teammates are not part of the public surface. */
export function isPublicAgent(a: AgentRecord | undefined): boolean {
  return a === undefined || a.kind === 'subagent' || a.kind === 'unknown';
}

export function isPublicTool(d: SessionState, t: ToolRun): boolean {
  return t.agent === undefined || isPublicAgent(d.agents[t.agent]);
}

export function toToolSnapshot(d: SessionState, t: ToolRun, ctx: MapCtx): ToolRunSnapshot {
  const raw = displayToolState(t, ctx.time.nowMono());
  const state: ToolRunSnapshot['state'] = raw === 'proposed' ? 'pending' : raw;
  const agent = t.agent === undefined ? undefined : d.agents[t.agent];
  return {
    key: t.key,
    name: t.name,
    input: t.input,
    state,
    startedAt: ctx.time.toWall(t.startedAt),
    provenance: toProvenance(t.provenance),
    ...opt('toolUseId', t.toolUseId),
    ...opt('turnKey', t.turn),
    ...opt('subagentKey', agent === undefined ? undefined : (agent.key as string as SubagentKey)),
    ...opt('endedAt', t.endedAt === undefined ? undefined : ctx.time.toWall(t.endedAt)),
  };
}

export function toSubagentSnapshot(a: AgentRecord, ctx: MapCtx): SubagentSnapshot {
  return {
    key: a.key as string as SubagentKey,
    agentId: a.agentId,
    agentType: a.agentType,
    background: a.background,
    state: a.state.value,
    startedAt: ctx.time.toWall(a.startedAt),
    ...opt('endedAt', a.endedAt === undefined ? undefined : ctx.time.toWall(a.endedAt)),
  };
}

const TURN_STATE: Readonly<Record<TurnState, TurnSnapshot['state']>> = {
  queued: 'queued',
  submitting: 'submitting',
  running: 'running',
  stopping: 'running',
  completed: 'completed',
  failed: 'failed',
  interrupted: 'interrupted',
  withdrawn: 'withdrawn',
  notSubmitted: 'notSubmitted',
  aborted: 'aborted',
  unknown: 'unknown',
};

/** The turn's assistant text: the final text when known, else the live main-thread messages (retracted ones dropped). */
export function turnText(d: SessionState, t: TurnRecord): string {
  if (t.finalText !== undefined) return t.finalText.value;
  const parts: string[] = [];
  for (const k of t.messages) {
    const m = d.messages[k];
    if (m !== undefined && !m.retracted && m.agent === undefined && m.text.length > 0) parts.push(m.text);
  }
  return parts.join('\n\n');
}

function turnSubagents(d: SessionState, t: TurnRecord): SubagentKey[] {
  const out: SubagentKey[] = [];
  for (const k of t.tools) {
    const spawned: AgentKey | undefined = d.tools[k]?.spawned;
    if (spawned !== undefined && isPublicAgent(d.agents[spawned])) out.push(spawned as string as SubagentKey);
  }
  return out;
}

export function toTurnSnapshot(d: SessionState, t: TurnRecord, ctx: MapCtx): TurnSnapshot {
  const tools = t.tools.filter((k) => {
    const run = d.tools[k];
    return run === undefined || isPublicTool(d, run);
  });
  return {
    key: t.key,
    prompt: t.prompt,
    origin: t.origin.value === 'library' ? 'library' : 'external',
    state: TURN_STATE[t.state.value],
    tools,
    subagents: turnSubagents(d, t),
    text: turnText(d, t),
    ...opt('promptId', t.promptId),
    ...opt('startedAt', t.acceptedAt === undefined ? undefined : ctx.time.toWall(t.acceptedAt)),
    ...opt('endedAt', t.endedAt === undefined ? undefined : ctx.time.toWall(t.endedAt)),
    ...opt('error', turnError(t)),
  };
}

/** The unsuccessful outcome a terminal turn state stands for; undefined while open or when completed. */
const FAILED_OUTCOME: Readonly<Record<TurnState, Exclude<TurnOutcome, 'completed'> | undefined>> = {
  queued: undefined,
  submitting: undefined,
  running: undefined,
  stopping: undefined,
  completed: undefined,
  failed: 'failed',
  interrupted: 'interrupted',
  withdrawn: 'withdrawn',
  notSubmitted: 'notSubmitted',
  aborted: 'aborted',
  unknown: 'unknown',
};

/** The turn's error as TurnResult.error reports it: the recorded one, else the one its outcome implies (same rule as toTurnResult). */
function turnError(t: TurnRecord): ClaudeSessionErrorData | undefined {
  if (t.error !== undefined) return toErrorData(t.error);
  const outcome = FAILED_OUTCOME[t.state.value];
  return outcome === undefined ? undefined : outcomeError(outcome, t.endedBy).toJSON();
}

const ACTIVE_TOOL: ReadonlySet<ToolRun['state']['value']> = new Set(['proposed', 'pending', 'awaitingPermission', 'running', 'launched']);

export function toSnapshot(d: SessionState, ctx: MapCtx): SessionSnapshot {
  const cur = currentTurn(d);
  const limit = d.usage.limit;
  return {
    key: d.sessionKey,
    claudeSessionId: d.claude.sessionId ?? '',
    cwd: ctx.cwd,
    claudeVersion: d.claude.version,
    status: toStatus(d.status, ctx.time),
    mode: toMode(d.claude.permissionMode?.value),
    ...opt('model', d.claude.model?.value),
    ...opt('currentTurn', cur === undefined ? undefined : toTurnSnapshot(d, cur, ctx)),
    queuedTurns: [...d.libraryQueue] as TurnKey[],
    activeTools: Object.values(d.tools)
      .filter((t) => ACTIVE_TOOL.has(t.state.value) && isPublicTool(d, t))
      .map((t) => toToolSnapshot(d, t, ctx)),
    subagents: Object.values(d.agents)
      .filter((a) => a.kind === 'subagent' || a.kind === 'unknown')
      .map((a) => toSubagentSnapshot(a, ctx)),
    pendingPermissions: pendingPermissions(d).map((p) => p.key),
    usage: {
      ...opt('contextUsedPct', d.usage.contextUsedPct),
      ...opt('limitedUntil', limit !== undefined && limit.state !== 'cleared' ? limit.resetsAtWall : undefined),
    },
    channels: {
      hooks: d.channels.hooks.health,
      transcript: d.channels.transcript.health,
      network: d.channels.network.health,
      screen: d.channels.screen.health,
    },
    lastEventSeq: d.lastEventSeq,
  };
}
