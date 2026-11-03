// model/events.ts — DomainEvent (L2 → L3/L4) and the internal CoreEvent (DESIGN.md §2.5).

import type { CcdErrorCode, CcdErrorData } from './errors.js';
import type {
  AgentKey,
  EventSeq,
  GenKey,
  MsgKey,
  ModelCallKey,
  ObsSeq,
  InputJobKey,
  PermissionKey,
  SessionKey,
  ToolKey,
  TurnKey,
} from './ids.js';
import type { JsonValue } from './json.js';
import type { ChannelName, PermissionDecider, PromptOrigin, RateLimitWindow, Source, TokenUsage } from './observation.js';
import type { StartupGateKind } from './screen-facts.js';
import type {
  AgentStatus,
  EntityProvenance,
  Fact,
  LifecyclePhase,
  PermissionBinding,
  PermissionMode,
  SessionState,
  ToolState,
  UsageLimitState,
} from './state.js';
import type { MonoMs, WallMs } from './time.js';

export interface Provenance {
  confirmed: boolean;
  sources: Source[];
}
export interface EventEnvelope<T extends string, P> {
  v: 1;
  seq: EventSeq;
  type: T;
  at: MonoMs;
  wallAt: WallMs;
  sessionKey: SessionKey;
  gen?: GenKey;
  turnKey?: TurnKey;
  provenance: Provenance;
  causedBy: ObsSeq[];
  replayed?: boolean;
  payload: P;
}
type E<T extends string, P> = EventEnvelope<T, P>;
export type DomainEvent =
  | E<'session.launching', { cwd: string; claudeVersion: string; claudeSessionId: string; resume: boolean }>
  | E<'session.gated', { gate: StartupGateKind; text: string }>
  | E<
      'session.ready',
      {
        permissionMode: PermissionMode;
        model?: string;
        selfTest: 'passed' | 'cached' | 'skipped';
        resumed: boolean;
        hookTransport: 'http' | 'unix';
      }
    >
  | E<
      'session.generationChanged',
      { from?: string; to: string; gen: GenKey; reason: 'startup' | 'clear' | 'resume' | 'fork' | 'continuedIn' | 'implicit' | 'unknown' }
    >
  | E<'session.modeChanged', { mode: PermissionMode }>
  | E<'session.modelChanged', { model: string; source?: 'switch' | 'refusalFallback' | 'command' | string; savedAsDefault?: boolean }>
  | E<'session.authRequired', { message: string }>
  | E<'session.authRestored', {}>
  | E<'session.closing', { reason: string }>
  | E<
      'session.exited',
      {
        exitStatus: number | null;
        signal: string | null;
        reason: 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone';
        finalScreen?: string;
      }
    >
  | E<'status.changed', { from: AgentStatus; to: AgentStatus }>
  | E<'turn.queued', { prompt: string; origin: PromptOrigin; clientRef?: string }>
  | E<'turn.submitting', { attempt: number; method: 'editor' | 'pasteChunks' }>
  | E<'turn.accepted', { promptId: string; mergedInto?: TurnKey }>
  | E<
      'turn.ended',
      {
        outcome: TurnOutcome;
        endedBy: TurnEndedBy;
        error?: CcdErrorData;
        durationMs?: number;
        finalText?: string;
        truncated?: boolean;
        refused?: boolean;
      }
    >
  | E<'turn.resolvedLate', { from: 'unknown'; to: TurnOutcome }>
  | E<'turn.textAppended', { msgKey: MsgKey }> // late MessageDisplay after Stop (stopGrace)
  | E<'assistant.textDelta', { msgKey: MsgKey; index: number; delta: string; final: boolean }>
  | E<
      'assistant.block',
      {
        msgKey: MsgKey;
        apiMessageId: string;
        blockIndex: number;
        block: 'thinking' | 'text' | 'tool_use';
        text?: string;
        agentKey?: AgentKey;
      }
    >
  | E<'assistant.retracted', { msgKeys: MsgKey[]; reason: 'refusalFallback' | 'refused' }> // rev2: logical retraction (§4.5.10)
  | E<'tool.started', { toolKey: ToolKey; toolUseId?: string; name: string; input: unknown; agentKey?: AgentKey }>
  | E<'tool.updated', { toolKey: ToolKey; state: ToolState }>
  | E<'tool.ended', { toolKey: ToolKey; state: ToolState; outcomeFrom: ToolOutcomeFrom; durationMs?: number; responseRef?: ResponseRef }>
  | E<'tool.resolvedLate', { toolKey: ToolKey; to: ToolState }>
  | E<
      'permission.requested',
      {
        permissionKey: PermissionKey;
        toolKey?: ToolKey;
        toolName: string;
        input: unknown;
        suggestions: unknown[];
        binding: PermissionBinding['kind'];
        autoAnswerAllowed: boolean;
        agentKey?: AgentKey;
        needs: 'decision' | 'answers' | 'planApproval';
        adopted?: boolean;
        /** §3.7 step 10: the request carries an agent, or its tool belongs to a background agent (backgroundTimeoutMs applies). */
        background: boolean;
        /** The armed `permissionPolicy` deadline: after it the configured onTimeout applies (ICR 0023). */
        deadlineAt: MonoMs;
      }
    >
  | E<'permission.bound' | 'permission.rebound', { permissionKey: PermissionKey; toolKey: ToolKey; confirmed: boolean }>
  | E<
      'permission.answered',
      {
        permissionKey: PermissionKey;
        decision: 'allow' | 'deny';
        by: 'host' | 'handler' | 'policy' | 'timeout' | 'close';
        via: 'hook' | 'keys';
      }
    >
  | E<'permission.resolved', { permissionKey: PermissionKey; decision: 'allow' | 'deny'; decider: PermissionDecider; overridden: boolean }>
  | E<'permission.needsKeys', { permissionKey: PermissionKey }>
  | E<'permission.abandoned', { permissionKey: PermissionKey; reason: string }>
  | E<
      'input.requested',
      { requestKey: string; kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput' | 'unknownModal'; message?: string }
    > // rev2
  | E<'input.cleared', { requestKey: string; how: 'complete' | 'response' | 'screenGone' | 'interrupted' }> // rev2
  | E<
      'subagent.started',
      {
        agentKey: AgentKey;
        agentId: string;
        agentType: string;
        background: boolean;
        internal: boolean;
        teammate: boolean;
        spawnToolKey?: ToolKey;
      }
    >
  | E<'subagent.linked', { agentKey: AgentKey; spawnToolKey: ToolKey; confirmed: boolean }>
  | E<'subagent.stopped', { agentKey: AgentKey; lastAssistantMessage?: string; fileMissing: boolean }>
  | E<'bgtask.updated', { taskId: string; type: string; status: string }>
  | E<'modelCall.started', { callKey: ModelCallKey; requestRef?: string; attempt: number; agentKey?: AgentKey }>
  | E<
      'modelCall.progress',
      { callKey: ModelCallKey; phase: 'waiting' | 'streaming' | 'quiet' | 'stalled'; bytesDown?: number; sinceLastByteMs?: number }
    >
  | E<'modelCall.retrying', { callKey: ModelCallKey; attempt: number; maxAttempts?: number; retryInMs?: number; errorHint?: string }>
  | E<'modelCall.ended', { callKey: ModelCallKey; outcome: 'ok' | 'error' | 'aborted' | 'refused' | 'unknown'; usage?: TokenUsage }>
  | E<'usage.limited', { limitName?: string; resetsAtWall?: WallMs; source: Source; autoContinue: UsageLimitState['autoContinue'] }>
  | E<'usage.wakeScheduled', { atWall: WallMs; attempt: number; jitterMs: number }>
  | E<'usage.cleared', { reason: 'turnStarted' | 'autoResumeFired' | 'wokeByLibrary' }>
  | E<'usage.info', { contextUsedPct?: number; rateLimits?: RateLimitWindow[] }>
  | E<'compaction', { phase: 'started' | 'ended'; trigger?: string }>
  | E<'claim.asserted' | 'claim.confirmed' | 'claim.retracted' | 'claim.expired', { claim: string; value: JsonValue }>
  | E<'channel.health', { channel: ChannelName; health: 'up' | 'degraded' | 'down' | 'off'; reason?: string }>
  | E<'interrupt.ignored', { reason: 'noEvidence' | 'notBusy' }>
  | E<'input.rejected', { job: InputJobKey; code: CcdErrorCode; reason: string }>
  | E<'config.changed', { source: string; filePath?: string }>
  | E<
      'security.alert',
      {
        code: 'E_SECURITY_UNEXPECTED_INPUT' | 'E_SECURITY_HOOK_FORGERY' | 'E_SECURITY_SETTINGS_TAMPERED' | 'E_INPUT_TAMPERED';
        detail: JsonValue;
      }
    >
  | E<'warning', { code: CcdErrorCode; message: string; detail?: JsonValue }>;

export type TurnOutcome = 'completed' | 'interrupted' | 'failed' | 'aborted' | 'notSubmitted' | 'withdrawn' | 'unknown';
export type TurnEndedBy =
  | 'stop'
  | 'stop_failure'
  | 'interrupt'
  | 'tool_use_interrupt'
  | 'withdrawn'
  | 'turn_duration'
  | 'session_end'
  | 'process_exit'
  | 'submit_failed'
  | 'library_abort'
  | 'merged';
export type ToolOutcomeFrom = 'post' | 'post_failure' | 'batch' | 'transcript' | 'permission_deny' | 'closing_rule';
export interface ResponseRef {
  bytes: number;
  sha256_16: string;
  preview: string /* ≤ 4 KiB, redaction applied by facade */;
  truncated: boolean;
}

// ---- rev2 (§10 B2): internal events. They change `domain` but are never published. ----
export type InternalEvent =
  | { type: 'x.fact'; path: string; fact: Fact<JsonValue> } // corroboration, provisional→confirmed, conflict replacement
  | { type: 'x.provenance'; entity: string; provenance: EntityProvenance } // sources/lastSeq growth
  | { type: 'x.inputBlocked'; value: SessionState['inputBlocked'] }
  | { type: 'x.lifecycle'; phase: LifecyclePhase }
  | { type: 'x.patch'; entity: string; patch: JsonValue }; // any other field change not carried by a DomainEvent (must name its reason in a diagnostic code)
export type CoreEvent = DomainEvent | InternalEvent;
