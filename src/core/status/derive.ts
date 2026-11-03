// core/status/derive.ts — deriveStatus(state): AgentStatus, first match wins (DESIGN.md §4.7, RC §9).
// Status is never stored as a primary field (D-06, P-REC-42); step recomputes it after every input.

import type { CoreConfig } from '../../model/config.js';
import type { Provenance } from '../../model/events.js';
import type { Source } from '../../model/observation.js';
import type { AgentStatus, EntityProvenance, PermissionRecord, SessionState, ToolRun } from '../../model/state.js';
import type { MonoMs } from '../../model/time.js';
import { isCallOpen, isToolTerminal } from '../lattice.js';
import { backgroundCount, isQuiescent, lastTurn } from '../selectors.js';

export interface DeriveExtras {
  now: MonoMs;
  config: CoreConfig;
  /** previous status (keeps `since` stable while the kind is unchanged) */
  prev?: AgentStatus;
  /** pending task notifications (queue.op enqueue without dequeue) */
  pendingNotifications?: number;
  /** last host resume (suppresses `stalled` for hostResumeGraceMs) */
  lastHostResumeAt?: MonoMs | undefined;
  /** an asserted screen stall banner claim (§4.7 rule 11: "or a stall claim") */
  screenStall?: boolean;
  /** an asserted screen retry banner claim */
  screenRetry?: { attempt?: number; max?: number; retryInMs?: number } | undefined;
}

function prov(p: EntityProvenance | undefined, extra: Source[] = []): Provenance {
  const sources = [...(p?.sources ?? [])];
  for (const s of extra) if (!sources.includes(s)) sources.push(s);
  return { confirmed: p?.confirmed ?? false, sources };
}

function sinceOf(prev: AgentStatus | undefined, kind: AgentStatus['kind'], fallback: MonoMs): MonoMs {
  return prev?.kind === kind ? prev.since : fallback;
}

function startingPhase(d: SessionState): 'launching' | 'gated' | 'waitingForSessionStart' | 'selfTest' {
  switch (d.lifecycle) {
    case 'gated':
      return 'gated';
    case 'selfTest':
      return 'selfTest';
    case 'awaitingReady':
      return 'waitingForSessionStart';
    case 'preflight':
    case 'launching':
    case 'ready':
    case 'closing':
    case 'exited':
      return 'launching';
  }
}

function openMainTools(d: SessionState, turnKey: string): ToolRun[] {
  return Object.values(d.tools).filter(
    (t) =>
      t.turn === turnKey &&
      t.agent === undefined && // subagent tools carry their spawn turn too; foreground ones count via fgAgentTools (§4.7 rule 9)
      (t.state.value === 'pending' ||
        t.state.value === 'running' ||
        t.state.value === 'launched' ||
        t.state.value === 'awaitingPermission'),
  );
}

export function deriveStatus(d: SessionState, x: DeriveExtras): AgentStatus {
  const { now, prev } = x;
  // 1 exited
  if (d.lifecycle === 'exited' || d.exit !== undefined) {
    return { kind: 'exited', since: sinceOf(prev, 'exited', now), exitStatus: d.exit?.exitStatus ?? null, signal: d.exit?.signal ?? null };
  }
  // 2 starting
  if (d.lifecycle !== 'ready' && d.lifecycle !== 'closing') {
    const s: AgentStatus = { kind: 'starting', phase: startingPhase(d), since: sinceOf(prev, 'starting', now) };
    if (d.gate !== undefined) s.gate = d.gate.kind;
    if (prev?.kind === 'starting' && prev.phase !== s.phase) s.since = now;
    return s;
  }
  const active = d.activeTurn === undefined ? undefined : d.turns[d.activeTurn];
  // 3 awaitingPermission: any permission of the active turn or a linked foreground subagent (incl. adopted ones)
  // An `allow` we delivered through the hook is acted on at once: Claude runs the tool, so the session is running tools,
  // not waiting (live smoke, a 30 s Bash call showed awaitingPermission throughout). A failed delivery moves the record to
  // dialogOnly, which still counts. Answers through keys keep counting until the dialog is gone. WP-INT, ICR 0016.
  const delivered = (p: PermissionRecord): boolean =>
    p.state.value === 'answered' && p.ourAnswer?.via === 'hook' && p.ourAnswer.decision === 'allow';
  const perms = Object.values(d.permissions)
    .filter((p) => p.state.value === 'pending' || p.state.value === 'answered' || p.state.value === 'dialogOnly')
    .filter((p) => !delivered(p))
    .filter((p) => {
      if (p.agent !== undefined) {
        const a = d.agents[p.agent];
        if (a !== undefined && (a.background || a.kind === 'internal' || a.kind === 'teammate')) return false;
      }
      return true;
    })
    .sort((a, b) => a.requestedAt - b.requestedAt);
  const perm = perms[0];
  if (perm !== undefined) {
    return {
      kind: 'awaitingPermission',
      permission: perm.key,
      since: prev?.kind === 'awaitingPermission' && prev.permission === perm.key ? prev.since : perm.requestedAt,
    };
  }
  // 4 awaitingInput
  const inputs = Object.values(d.pendingInputs).sort((a, b) => a.since - b.since);
  const inp = inputs[0];
  if (inp !== undefined) {
    const s: AgentStatus = { kind: 'awaitingInput', request: inp.key, inputKind: inp.kind, since: inp.since };
    if (inp.message !== undefined) s.message = inp.message;
    return s;
  }
  // 5 interrupted (active/last turn ended interrupted < interruptedHoldMs ago, or a provisional interrupt still pending)
  const lt = lastTurn(d);
  const hold = x.config.timeouts.interruptedHoldMs;
  if (active?.state.value === 'interrupted') {
    return { kind: 'interrupted', since: active.endedAt ?? now, provenance: prov(active.provenance) };
  }
  if (active === undefined && lt?.state.value === 'interrupted' && lt.endedAt !== undefined && now - lt.endedAt < hold) {
    const q0 = d.libraryQueue[0];
    const newer = q0 !== undefined && d.turns[q0]?.state.value === 'submitting';
    if (!newer) return { kind: 'interrupted', since: lt.endedAt, provenance: prov(lt.provenance) };
  }
  // 6 authRequired
  if (d.auth.state === 'required')
    return { kind: 'authRequired', since: d.auth.since ?? sinceOf(prev, 'authRequired', now), message: d.auth.message ?? '' };
  // 7 usageLimited
  const lim = d.usage.limit;
  if (lim !== undefined && lim.state !== 'cleared' && active === undefined) {
    const s: AgentStatus = { kind: 'usageLimited', since: sinceOf(prev, 'usageLimited', now), autoResume: x.config.usage.autoResume };
    if (lim.resetsAtWall !== undefined) s.resetsAtWall = lim.resetsAtWall;
    if (lim.nextWakeAtWall !== undefined) s.nextWakeAtWall = lim.nextWakeAtWall;
    return s;
  }
  // 8 compacting
  if (d.compacting !== undefined) return { kind: 'compacting', since: d.compacting.since };
  if (
    active !== undefined &&
    (active.state.value === 'running' || active.state.value === 'stopping' || active.state.value === 'submitting')
  ) {
    // 9 runningTools (main-thread tools of the active turn, or a foreground subagent with a running tool)
    const tools = openMainTools(d, active.key).filter((t) => t.state.value !== 'awaitingPermission');
    const fgAgentTools = Object.values(d.tools).filter((t) => {
      if (t.agent === undefined || isToolTerminal(t.state.value)) return false;
      const a = d.agents[t.agent];
      if (a === undefined || a.background || a.kind !== 'subagent' || a.state.value !== 'running') return false;
      const spawn = a.spawnTool === undefined ? undefined : d.tools[a.spawnTool];
      return spawn?.turn === active.key;
    });
    const running = [...tools, ...fgAgentTools];
    if (running.length > 0) {
      const keys = running.map((t) => t.key);
      const since = prev?.kind === 'runningTools' ? prev.since : Math.min(...running.map((t) => t.preAt ?? t.startedAt));
      return { kind: 'runningTools', tools: keys, since: since as MonoMs, provenance: prov(running[0]?.provenance) };
    }
    // 10 writing (a UiMessage of the active turn with deltas and not final)
    const writing = active.messages
      .map((k) => d.messages[k])
      .find((m) => m?.uiMessageId !== undefined && !m.final && !m.retracted && m.text !== '');
    if (writing !== undefined)
      return { kind: 'writing', since: sinceOf(prev, 'writing', now), provenance: { confirmed: true, sources: ['hook'] } };
    // 11 modelRequest
    const calls = active.calls.map((k) => d.calls[k]).filter((c) => c !== undefined && isCallOpen(c.state.value));
    const call = calls[calls.length - 1];
    let phase: 'waiting' | 'streaming' | 'retrying' | 'stalled' = 'waiting';
    const graceUntil = x.lastHostResumeAt === undefined ? -Infinity : x.lastHostResumeAt + x.config.timeouts.hostResumeGraceMs;
    if (x.screenStall === true && now >= graceUntil) phase = 'stalled';
    else if (x.screenRetry !== undefined) phase = 'retrying';
    else if (call !== undefined) {
      if (call.state.value === 'stalled' && now >= graceUntil) phase = 'stalled';
      else if (call.state.value === 'retrying') phase = 'retrying';
      else if (call.state.value === 'streaming' && call.lastDownAt !== undefined && now - call.lastDownAt <= 2000) phase = 'streaming';
      else if (call.state.value === 'streaming' && call.lastDownAt === undefined) phase = 'streaming';
    }
    const s: AgentStatus = {
      kind: 'modelRequest',
      phase,
      since: prev?.kind === 'modelRequest' && prev.phase === phase ? prev.since : now,
      provenance: prov(active.provenance, call?.state.src === 'screen' ? ['screen'] : []),
    };
    // A retry/stall phase taken from a screen claim alone is provisional (K-16 "network off → provisional only"): the open
    // turn's confirmation does not confirm the phase. WP-INT fix, docs/icr/0016-wp-int.md.
    const screenPhase =
      (phase === 'stalled' && x.screenStall === true) || (phase === 'retrying' && x.screenRetry !== undefined && call?.retry === undefined);
    if (screenPhase && call?.state.src !== 'network') s.provenance = { confirmed: false, sources: ['screen'] };
    const sr = x.screenRetry;
    if (phase === 'retrying' && sr !== undefined && call?.retry === undefined) {
      if (sr.attempt !== undefined) s.attempt = sr.attempt;
      if (sr.max !== undefined) s.maxAttempts = sr.max;
      if (sr.retryInMs !== undefined) s.retryInMs = sr.retryInMs;
    } else if (call !== undefined) {
      if (call.retry?.attempt !== undefined) s.attempt = call.retry.attempt;
      else if (call.attempts > 1) s.attempt = call.attempts;
      if (call.retry?.max !== undefined) s.maxAttempts = call.retry.max;
      if (call.retry?.retryInMs !== undefined) s.retryInMs = call.retry.retryInMs;
    }
    return s;
  }
  // 12 idle
  const s: AgentStatus = {
    kind: 'idle',
    since: sinceOf(prev, 'idle', now),
    backgroundAgents: backgroundCount(d),
    queued: d.libraryQueue.length,
    quiescent: isQuiescent(d, x.pendingNotifications ?? 0),
  };
  if (lt !== undefined && lt.state.value !== 'running' && lt.state.value !== 'stopping') {
    const outcome =
      lt.state.value === 'completed' ||
      lt.state.value === 'failed' ||
      lt.state.value === 'interrupted' ||
      lt.state.value === 'aborted' ||
      lt.state.value === 'notSubmitted' ||
      lt.state.value === 'withdrawn' ||
      lt.state.value === 'unknown'
        ? lt.state.value
        : 'unknown';
    s.lastTurn = lt.error !== undefined ? { outcome, error: lt.error } : { outcome };
  }
  return s;
}
