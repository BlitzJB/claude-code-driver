// core/types.ts — the L2 core contract types of DESIGN.md §2.9 (CoreState, ReconState, CoreInput, StepResult, …).
// Kept in one leaf module so decide/*, reconcile/* and input-policy/* can name them without an import cycle through
// step.ts; step.ts re-exports them (§2.9 names it as their home).

import type { Command } from '../model/commands.js';
import type { CoreConfig } from '../model/config.js';
import type { CcdErrorData } from '../model/errors.js';
import type { Diagnostic } from '../model/debug.js';
import type { CoreEvent, DomainEvent } from '../model/events.js';
import type { AgentKey, GenKey, ModelCallKey, MsgKey, PermissionKey, ToolKey, TurnKey } from '../model/ids.js';
import type { Intent } from '../model/intents.js';
import type { Observation } from '../model/observation.js';
import type { ScreenFacts } from '../model/screen-facts.js';
import type { SessionState } from '../model/state.js';
import type { MonoMs, WallMs } from '../model/time.js';
import type { Claim, Deadline } from './facts.js';
import type { InputPolicyState } from './input-policy/jobs.js';

export interface ReconState {
  // private; never part of SessionState
  aliases: {
    sessionId: Record<string, GenKey>;
    promptId: Record<string, TurnKey>;
    toolUseId: Record<string, ToolKey>;
    agentId: Record<string, AgentKey>;
    apiMsgId: Record<string, MsgKey>;
    uiMsgId: Record<string, MsgKey>;
    requestRef: Record<string, ModelCallKey>;
    hookSeq: Record<number, PermissionKey>;
    entryUuid: Record<string, MsgKey>;
  };
  redirects: Record<string, string>;
  claims: Record<string, Claim>;
  deadlines: Record<string, Deadline>;
  tunnels: Record<number, { phase: string; callKey?: ModelCallKey; lastDownAt?: MonoMs; sendingAtWall?: WallMs; host?: string }>;
  seenUuids: { ring: string[]; set: Record<string, true> }; // bounded (64k) per generation; full set only during a rescan
  usageCounted: Record<string, true>; // `${message.id}|${requestId}`
  conflicts: Record<string, number>;
  anomalies: Diagnostic[]; // bounded ring 256
  lastHostResumeAt?: MonoMs;
  lastFrame?: ScreenFacts;
  lastFrameAt?: MonoMs;
  surfaceSince?: MonoMs;
  // ---- additive WP-09 bookkeeping (all private) ----
  /** launch parameters (CoreInit) the decide modules need */
  launch: { sessionId: string; resume: boolean; cwdRealpath: string; startedAt: MonoMs };
  /** the last frame was torn (gate rule, §3.6) */
  lastFrameTorn?: boolean;
  /** startupHookGrace fired without a SessionStart (degraded readiness path, §4.3#4) */
  hookGraceFired?: boolean;
  /** `selftest.run` arrived before lifecycle reached `selfTest` */
  pendingSelfTest?: { nonce: string; cachedPass: boolean };
  /** nonces used by this core (the armed one last); a prompt carrying one is never a Turn (§4.4#4) */
  recentNonces: string[];
  /** transport of the last observation hook (http|unix), for session.ready */
  hookTransport?: 'http' | 'unix';
  /** L0/L3 transport health per channel (`channel.health` observations); core reasons live in domain.channels */
  transport: Partial<Record<'hooks' | 'transcript' | 'screen' | 'network', 'up' | 'degraded' | 'down' | 'off'>>;
  /** last emitted poll.cadence interval / auth.poll interval */
  cadence?: number | null;
  authPoll?: number | null;
  /** last time the library pressed Enter (cadence 150 ms for 5 s after a send, §4.11) */
  lastSentAt?: MonoMs;
  /** idle-and-quiescent since (5000 ms cadence after 60 s) */
  quiescentSince?: MonoMs;
  /** transcript prompt.recorded waiting for its UPS within hookGapMs (§4.4#6) */
  pendingRecorded: Record<string, { promptId?: string; text: string; at: MonoMs; seq: number; gen?: GenKey }>;
  /** queue.op enqueue without dequeue (pending task notifications, §4.5.4) */
  queuedOps: number;
  /** the permission's turn at request time */
  permTurn: Record<string, TurnKey>;
  /** the raw agent_id a PermissionRequest carried (P-REC-44: binding needs agent equality only when present) */
  permAgentId: Record<string, string>;
  /** ask intents outstanding (host.askPermission emitted, not yet cancelled/answered) */
  asks: Record<string, true>;
  /** MessageDisplay chunks by message key and index */
  uiChunks: Record<string, Record<number, string>>;
  /** a turn completed by Stop is not corroborated yet (forged-Stop guard, K-32) */
  stopUncorroborated?: TurnKey;
  /** background agents of an ended generation awaiting the new generation's first Stop/turn_duration (§4.5.4) */
  drainPending: AgentKey[];
  /** first teammate warning sent (§4.5.9) */
  teammateWarned?: boolean;
  /** external editor open with no library job (ICR 0001 item 3c) */
  editorOpenSince?: MonoMs;
  /** a `session.close` waiting for background quiescence (waitForBackgroundMs) */
  closePending?: { mode: 'graceful' | 'kill'; reason: string; until: MonoMs };
  /** the usage limit cleared recently with no library send (origin auto_continue, §3.6 step 5) */
  limitClearedAt?: MonoMs;
  /** A hook-only usage limit whose `usage.limited` + wake wait for the transcript's reset time (ICR 0016). */
  limitAwaitingReset?: true;
  /** Re-arm count carried across a library wake whose `continue` hit the limit again (§3.9 step 5 cap, ICR 0016). */
  wakeChainRearms?: number;
  /** The wake chain hit maxRearms: no further wake for this limit (cleared by the next accepted prompt). */
  wakeGaveUp?: true;
  /** The replayed (resumed-history) turn still waiting for its turn_duration / interrupt marker (decide/history.ts). */
  replayTurn?: TurnKey;
  /** Claude's prompt queue as seen in `queue-operation` entries, oldest first: true = a task notification (ICR 0016). */
  queueFifo?: boolean[];
  /** monotone counter for pending-input keys and similar */
  pendingInputSeq: number;
  /** generations whose drain window ended */
  drained: Record<string, true>;
  /** api-request wall time per model call (network join, §4.5.7) */
  txWalls: Record<string, number>;
  /** message → the model call whose block it is (refusal marks that call `refused`) */
  msgCall: Record<string, ModelCallKey>;
  /** Stop seen for the generation (first Stop of a new generation checks drainPending) */
  stopSeenInGen: Record<string, true>;
}

export interface Counters {
  gen: number;
  turn: number;
  tool: number;
  agent: number;
  perm: number;
  call: number;
  msg: number;
  job: number;
  intent: number;
  event: number;
  input: number;
}

export interface CoreState {
  domain: SessionState;
  recon: ReconState;
  input: InputPolicyState;
  counters: Counters;
  now: MonoMs;
  wallNow: WallMs;
  config: CoreConfig;
}

export type CoreInput = { type: 'obs'; obs: Observation } | { type: 'cmd'; cmdId: number; cmd: Command; at: MonoMs; wallAt: WallMs };

export interface StepResult {
  core: CoreState;
  events: DomainEvent[];
  intents: Intent[];
  diagnostics: Diagnostic[];
  commandResult?: { cmdId: number; ok: true; value: unknown } | { cmdId: number; ok: false; error: CcdErrorData };
}

/** `step` plus the internal events it folded (I1 property, trace tooling). */
export interface DetailedStepResult extends StepResult {
  coreEvents: CoreEvent[];
}

export interface NextDeadline {
  atMono?: MonoMs;
  atWall?: WallMs;
}
