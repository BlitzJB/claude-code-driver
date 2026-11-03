// model/state.ts — SessionState and entity types (DESIGN.md §2.6). Internal, never public (rev2 §10 E2).

import type { CcdErrorData } from './errors.js';
import type {
  AgentKey,
  EventSeq,
  GenKey,
  HookSeq,
  InputJobKey,
  MsgKey,
  ModelCallKey,
  ObsSeq,
  PermissionKey,
  SessionKey,
  ToolKey,
  TurnKey,
} from './ids.js';
import type { ChannelName, PermissionDecider, PromptOrigin, RateLimitWindow, ResolvedPath, Source, TokenUsage } from './observation.js';
import type { Provenance, ResponseRef, ToolOutcomeFrom, TurnEndedBy, TurnOutcome } from './events.js';
import type { StartupGateKind } from './screen-facts.js';
import type { MonoMs, WallMs } from './time.js';

// ---------- state.ts ----------
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export interface Fact<T> {
  value: T;
  src: Source;
  seq: ObsSeq;
  at: MonoMs;
  corroborated: Source[];
  provisional: boolean;
  expiresAt?: MonoMs;
}
export interface EntityProvenance {
  sources: Source[];
  confirmed: boolean;
  firstSeq: ObsSeq;
  lastSeq: ObsSeq;
}

// ICR 0041: 'suspended' = Claude stopped on idle, the session (core, keys, history, subscribers) kept; a resume relaunches it.
export type LifecyclePhase =
  'preflight' | 'launching' | 'awaitingReady' | 'gated' | 'selfTest' | 'ready' | 'closing' | 'exited' | 'suspended';
export type TurnState =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'withdrawn'
  | 'notSubmitted'
  | 'aborted'
  | 'unknown'; // rev2: no 'absorbed'
export type ToolState =
  'proposed' | 'pending' | 'awaitingPermission' | 'running' | 'launched' | 'succeeded' | 'failed' | 'denied' | 'interrupted' | 'unknown'; // rev2: no 'cancelled'
export type PermState = 'pending' | 'answered' | 'dialogOnly' | 'resolved' | 'abandoned';
export type AgentState = 'running' | 'stopped' | 'unknown';
export type CallState =
  'started' | 'waiting' | 'streaming' | 'retrying' | 'stalled' | 'ended' | 'aborted' | 'failed' | 'refused' | 'unknown';

export interface Generation {
  key: GenKey;
  sessionId: string;
  transcriptPath?: string;
  status: 'implicit' | 'active' | 'ended';
  startedBy: 'SessionStart' | 'implicit' | 'launch';
  source?: string;
  endReason?: string;
  startedAt: MonoMs;
}

export interface TurnRecord {
  key: TurnKey;
  gen?: GenKey;
  promptId?: string;
  prompt: string;
  origin: Fact<PromptOrigin>;
  clientRef?: string;
  state: Fact<TurnState>;
  endedBy?: TurnEndedBy;
  error?: CcdErrorData;
  job?: InputJobKey;
  causedBy?: { agent?: AgentKey; tool?: ToolKey; taskId?: string };
  mergedInto?: TurnKey; // rev2: Claude queued our prompt into this running turn (race only, §4.4)
  refused?: { refusedMessageId: string; fallbackModel?: string };
  finalText?: Fact<string>;
  truncated?: boolean;
  durationMs?: number;
  backgroundPending: string[];
  tools: ToolKey[];
  messages: MsgKey[];
  calls: ModelCallKey[];
  queuedAt: MonoMs;
  acceptedAt?: MonoMs;
  endedAt?: MonoMs;
  provenance: EntityProvenance;
}
export interface ToolRun {
  key: ToolKey;
  toolUseId?: string;
  name: string;
  input: unknown;
  turn?: TurnKey;
  agent?: AgentKey;
  promptIdAtPre?: string;
  preSeq?: ObsSeq;
  preAt?: MonoMs;
  state: Fact<ToolState>;
  outcomeFrom?: ToolOutcomeFrom;
  responseRef?: ResponseRef;
  error?: string;
  durationMs?: number;
  permission?: PermissionKey;
  spawned?: AgentKey;
  apiMessageId?: string;
  blockIndex?: number;
  startedAt: MonoMs;
  endedAt?: MonoMs;
  provenance: EntityProvenance;
}
export interface PermissionBinding {
  kind: 'unique' | 'ambiguous-equivalent' | 'ambiguous-agents' | 'unbound' | 'screen-only';
  confirmed: boolean;
}
export interface PermissionRecord {
  key: PermissionKey;
  hookSeq?: HookSeq;
  toolName: string;
  input: unknown;
  suggestions: unknown[];
  tool?: ToolKey;
  agent?: AgentKey;
  binding: PermissionBinding;
  state: Fact<PermState>;
  autoAnswerAllowed: boolean;
  needs: 'decision' | 'answers' | 'planApproval'; // rev2: AskUserQuestion → answers, ExitPlanMode → planApproval
  paths?: { state: 'pending' | 'resolved'; allInside?: boolean; detail?: ResolvedPath[] }; // rev2: allowRead evidence from L3 (§3.7)
  ourAnswer?: { decision: 'allow' | 'deny'; by: 'host' | 'handler' | 'policy' | 'timeout' | 'close'; via: 'hook' | 'keys'; seq: ObsSeq };
  resolved?: { decision: 'allow' | 'deny'; decider: PermissionDecider; overridden: boolean };
  requestedAt: MonoMs;
  suspect: boolean; // screen-only dialog with no matching hook/PreToolUse within 2 s (SEC §4.6)
  adopted: boolean; // rev2: created from a screen dialog with no hook record (§4.6)
  provenance: EntityProvenance;
}
export interface AgentRecord {
  key: AgentKey;
  agentId: string;
  agentType: string;
  kind: 'subagent' | 'internal' | 'teammate' | 'unknown';
  background: boolean;
  gen?: GenKey; // generation it was launched in; never closed by a generation end (closing rule 3)
  spawnTool?: ToolKey;
  spawnLinkConfirmed: boolean;
  parent?: AgentKey;
  depth: number;
  state: Fact<AgentState>;
  runs: number;
  transcriptPath?: string;
  fileMissing: boolean;
  lastAssistantMessage?: string;
  notifications: TurnKey[];
  startedAt: MonoMs;
  endedAt?: MonoMs;
  provenance: EntityProvenance;
}
export interface ModelCall {
  key: ModelCallKey;
  turn?: TurnKey;
  agent?: AgentKey;
  requestRefs: string[];
  digest?: string;
  attempts: number;
  state: Fact<CallState>;
  tunnelId?: number;
  lastDownAt?: MonoMs;
  bytesDown: number;
  retry?: { attempt: number; max?: number; retryInMs?: number; errorHint?: string };
  usage?: TokenUsage;
  startedAt: MonoMs;
  endedAt?: MonoMs;
}
export interface MessageRecord {
  key: MsgKey;
  turn?: TurnKey;
  agent?: AgentKey;
  apiMessageId?: string;
  uiMessageId?: string;
  uuids: string[];
  text: string;
  final: boolean;
  finalBy?: 'flag' | 'implicit';
  confirmed: boolean;
  retracted: boolean;
  blocks: number;
  usageCounted: boolean;
}
export interface BackgroundTask {
  id: string;
  type: string;
  status: string;
  toolUseId?: string;
  agent?: AgentKey;
  gen?: GenKey;
  updatedAt: MonoMs;
}
export interface PendingInput {
  key: string;
  kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput' | 'unknownModal';
  message?: string;
  since: MonoMs;
  src: Source;
}
export interface UsageLimitState {
  state: 'limited' | 'waking' | 'cleared';
  limitName?: string;
  rateLimitType?: string;
  resetsAtWall?: WallMs;
  source: Source;
  autoContinue: 'armed' | 'stale' | 'cancelled' | 'disabled' | 'none';
  interruptedTurn?: TurnKey;
  rearms: number;
  nextWakeAtWall?: WallMs;
  jitterMs?: number; // rev2: jitter = deterministic function of (sessionKey, resetsAtWall, rearms) (§3.9)
}
export type AgentStatus =
  | { kind: 'starting'; phase: 'launching' | 'gated' | 'waitingForSessionStart' | 'selfTest'; gate?: StartupGateKind; since: MonoMs }
  | {
      kind: 'idle';
      since: MonoMs;
      backgroundAgents: number;
      queued: number;
      quiescent: boolean;
      lastTurn?: { outcome: TurnOutcome; error?: CcdErrorData };
    } // rev2: apiError is an attribute, not a status (§10 A8)
  | {
      kind: 'modelRequest';
      phase: 'waiting' | 'streaming' | 'retrying' | 'stalled';
      since: MonoMs;
      attempt?: number;
      maxAttempts?: number;
      retryInMs?: number;
      provenance: Provenance;
    }
  | { kind: 'writing'; since: MonoMs; provenance: Provenance }
  | { kind: 'runningTools'; tools: ToolKey[]; since: MonoMs; provenance: Provenance }
  | { kind: 'awaitingPermission'; permission: PermissionKey; since: MonoMs }
  | { kind: 'awaitingInput'; request: string; inputKind: PendingInput['kind']; message?: string; since: MonoMs } // rev2: MCP elicitation / unknown modal
  | { kind: 'interrupted'; since: MonoMs; provenance: Provenance }
  | { kind: 'compacting'; since: MonoMs }
  | { kind: 'usageLimited'; since: MonoMs; resetsAtWall?: WallMs; autoResume: boolean; nextWakeAtWall?: WallMs }
  | { kind: 'authRequired'; since: MonoMs; message: string }
  | { kind: 'exited'; since: MonoMs; exitStatus: number | null; signal: string | null }
  | { kind: 'suspended'; since: MonoMs; claudeSessionId: string }; // ICR 0041

export interface SessionState {
  v: 1;
  sessionKey: SessionKey;
  lifecycle: LifecyclePhase;
  gate?: { kind: StartupGateKind; text: string };
  claude: {
    version: string;
    pid?: number;
    paneId?: string;
    currentGen?: GenKey;
    sessionId?: string;
    transcriptPath?: string;
    model?: Fact<string>;
    permissionMode?: Fact<PermissionMode>;
  };
  generations: Readonly<Record<GenKey, Generation>>;
  status: AgentStatus; // cache of deriveStatus(state); recomputed every step; never set by decide/*
  turns: Readonly<Record<TurnKey, TurnRecord>>;
  turnOrder: TurnKey[];
  activeTurn?: TurnKey;
  libraryQueue: TurnKey[];
  tools: Readonly<Record<ToolKey, ToolRun>>;
  agents: Readonly<Record<AgentKey, AgentRecord>>;
  permissions: Readonly<Record<PermissionKey, PermissionRecord>>;
  calls: Readonly<Record<ModelCallKey, ModelCall>>;
  messages: Readonly<Record<MsgKey, MessageRecord>>;
  bgTasks: Readonly<Record<string, BackgroundTask>>;
  pendingInputs: Readonly<Record<string, PendingInput>>; // rev2
  usage: { limit?: UsageLimitState; contextUsedPct?: number; rateLimits?: RateLimitWindow[]; tokensTotal: TokenUsage };
  auth: { state: 'ok' | 'required'; message?: string; since?: MonoMs; polling: boolean };
  compacting?: { trigger?: string; since: MonoMs };
  channels: Readonly<Record<ChannelName, { health: 'up' | 'degraded' | 'down' | 'off'; reasons: string[] }>>; // rev2: reasons are cleared individually (§10 A9)
  inputBlocked: {
    permission: boolean;
    dialog: boolean;
    startup: boolean;
    copyMode: boolean;
    input: boolean; // input = pendingInputs non-empty
    // ICR 0009 (WP-09, LP-01 / ICR 0001 item 3c): the external editor stayed open (`editorOpen` surface) longer than
    // editorConsumeMs with no library job active (a human pressed C-g). Optional so existing constructors stay valid.
    editor?: boolean;
  };
  selfTest: { state: 'idle' | 'armed' | 'passed' | 'failed' | 'cached' | 'skipped'; nonce?: string };
  exit?: { exitStatus: number | null; signal: string | null; reason: string };
  /** ICR 0041: in-session scheduled tasks (`session_crons` of the last Stop/SubagentStop); they die with the process. */
  scheduledTasks?: number;
  /** ICR 0041: set while lifecycle is `suspended`. */
  suspended?: { since: MonoMs; claudeSessionId: string; reason: 'idle' | 'manual' };
  lastEventSeq: EventSeq;
}
