// model/observation.ts — semantic observations, L1 → L2 (DESIGN.md §2.4, D-04, D-42).

import type { CcdErrorCode } from './errors.js';
import type { HookSeq, InputJobKey, IntentId, ObsSeq, PermissionKey } from './ids.js';
import type { InputPrimitive } from './intents.js';
import type { ScreenFacts } from './screen-facts.js';
import type { MonoMs, WallMs } from './time.js';

export type Source = 'hook' | 'transcript' | 'network' | 'registry' | 'screen' | 'self' | 'clock' | 'process' | 'channel';
type ObsOrigin =
  | { kind: 'hook'; transport: 'http' | 'unix'; event: string; hookSeq: HookSeq }
  | { kind: 'transcript'; fileKey: string; generation: number; offset: number; entryUuid?: string; entryTs?: string; sidechain: boolean }
  | { kind: 'screen'; frameHash: string }
  | { kind: 'network'; tunnelId: number; tunnelSeq?: number } // ICR 0008: per-tunnel sequence of net.tunnel phases (§2.4 ordering keys)
  | { kind: 'self'; intentId: IntentId };
export interface ObsMeta {
  seq: ObsSeq;
  at: MonoMs;
  wallAt: WallMs;
  source: Source;
  uuid?: string; // rev2: transcript entry uuid; the ONLY de-duplication key (core, per generation; D-42)
  claudeSessionId?: string; // as reported by the record (generation join; never filtered in L1)
  agentId?: string; // present for subagent-scoped records
  replay?: boolean; // historical transcript catch-up (resume) → silent state rebuild
  origin?: ObsOrigin;
  rawRef?: number;
}
interface Obs<K extends string, P> {
  kind: K;
  meta: ObsMeta;
  p: P;
}
export type ObservationInput = {
  [O in Observation as O['kind']]: { kind: O['kind']; meta: Omit<ObsMeta, 'seq'>; p: O['p'] };
}[Observation['kind']];

export type PromptOrigin =
  'human' | 'library' | 'selftest' | 'task_notification' | 'scheduled' | 'auto_continue' | 'peer_message' | 'bash_mode' | 'unknown';
export type PermissionDecider = 'hook' | 'user_keys' | 'config' | 'classifier' | 'unknown';
export interface AgentRef {
  agentId: string;
  agentType?: string;
  teammateName?: string;
} // agentType '' = internal agent
export interface BgTaskInfo {
  id: string;
  type: string;
  status: string;
  description?: string;
  agentType?: string;
}
export interface RateLimitWindow {
  name: 'five_hour' | 'seven_day' | 'spend_limit' | string;
  usedPct?: number;
  resetsAtWall?: WallMs;
}
export interface ResolvedPath {
  arg: 'file_path' | 'path' | 'pattern' | 'glob' | 'notebook_path' | string;
  raw: string;
  real?: string;
  inside: boolean;
  reason?: 'outside' | 'symlinkOut' | 'absolutePattern' | 'parentSegment' | 'tilde' | 'enoent' | 'unknownArg';
}

export type Observation =
  // ---- session / process ----
  | Obs<
      'session.started',
      { sessionId: string; transcriptPath: string; source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | string; model?: string }
    >
  | Obs<'session.ended', { sessionId: string; reason: string }>
  | Obs<'process.launched', { pid: number; paneId: string; claudeVersion: string; startTime: string }>
  | Obs<'process.exited', { exitStatus: number | null; signal: string | null; byOwnerWatch?: boolean }>
  | Obs<'process.identityMismatch', { pid: number }>
  | Obs<'auth.status', { loggedIn: boolean; authMethod?: string; apiProvider?: string }> // rev2: result of an auth.poll intent
  // ---- prompts / turns ----
  | Obs<'prompt.submitted', { promptId: string; text: string; taskNotification?: { taskId: string; toolUseId?: string; status: string } }> // UPS
  | Obs<
      'prompt.recorded',
      {
        promptId?: string;
        uuid: string;
        parentUuid: string | null;
        text?: string;
        origin?: string;
        promptSource?: string;
        isMeta: boolean;
        bashInput?: boolean;
        localCommand?: { name: string; args?: string; stdout?: string };
      }
    >
  | Obs<'queue.op', { op: 'enqueue' | 'dequeue' | 'remove' | 'popAll' | string; content?: string; reason?: string }>
  | Obs<'prompt.absorbed', { text: string; deliveryId?: string }> // queued_command attachment: evidence for TurnRecord.mergedInto only
  | Obs<'prompt.withdrawn', {}>
  | Obs<'prompt.blocked', { reason: string; text: string }> // ICR 0002 (LP-47): transcript system/informational promptSubmitEnding.ending.kind 'blocked_by_hook'
  | Obs<'turn.stopped', { promptId?: string; lastAssistantMessage?: string; backgroundTasks: BgTaskInfo[]; stopHookActive: boolean }>
  | Obs<'turn.failed', { promptId?: string; error: string; errorDetails?: string; message?: string }> // StopFailure
  | Obs<'turn.durationRecorded', { durationMs: number; pendingBackgroundAgentCount: number; promptId?: string }> // promptId: the file's prompt chain when written (ICR 0021)
  | Obs<'turn.interrupted', { marker: 'request' | 'tool_use' | 'aborted_mid_stream'; interruptedMessageId?: string; promptId?: string }>
  // ---- model calls ----
  | Obs<'model.requestStarted', { requestRef: string; querySource?: string; requestDigest?: string; isRetry: boolean; txWall?: WallMs }>
  | Obs<
      'model.apiErrorRecorded',
      { error: string; apiError?: string; text: string; resetsAtWall?: WallMs; rateLimitType?: string; promptId?: string }
    > // synthetic isApiErrorMessage
  | Obs<'model.refused', { refusedMessageId: string; text: string; uuid: string }> // rev2: TF §4.2 item 8 (isMeta + turnCompanion + refusedMessageId)
  | Obs<
      'model.refusalFallback',
      {
        retractedMessageUuids: string[];
        refusedUserMessageUuid?: string;
        originalModel?: string;
        fallbackModel?: string;
        requestId?: string;
        trigger?: string;
        scope?: string;
        category?: string;
      }
    > // rev2: TF §4.4 system:model_refusal_fallback
  // ---- assistant output ----
  | Obs<'message.textDelta', { promptId?: string; uiTurnId: string; uiMessageId: string; index: number; final: boolean; delta: string }>
  | Obs<
      'message.block',
      {
        apiMessageId: string;
        requestId?: string;
        requestRef?: string;
        blockIndex: number;
        block: 'thinking' | 'text' | 'tool_use';
        toolUseId?: string;
        toolName?: string;
        input?: unknown;
        text?: string;
        stopReason: string | null;
        synthetic: boolean;
        abortedMidStream: boolean;
        uuid: string;
        parentUuid: string | null;
        usage?: TokenUsage;
      }
    >
  // ---- tools ----
  | Obs<'tool.pre', { toolUseId: string; toolName: string; input: unknown; promptId?: string; agent?: AgentRef }>
  | Obs<
      'tool.post',
      {
        toolUseId: string;
        toolName: string;
        input?: unknown;
        response: unknown;
        responseTruncated?: boolean;
        durationMs?: number;
        agent?: AgentRef;
        asyncAgentId?: string;
      }
    >
  | Obs<'tool.failed', { toolUseId: string; toolName: string; error: string; isInterrupt?: boolean; agent?: AgentRef }>
  | Obs<'tool.batchDone', { toolUseIds: string[]; agent?: AgentRef }>
  | Obs<
      'tool.result',
      {
        toolUseId: string;
        isError: boolean;
        denialKind?: string;
        interrupted?: boolean;
        asyncAgentId?: string;
        uuid: string;
        contentPreview?: string;
      }
    >
  | Obs<'tool.validationError', { toolUseId: string }>
  // ---- permissions ----
  | Obs<
      'permission.requested',
      {
        hookSeq: HookSeq;
        /**
         * `false`: the transport did not hold this request — it already answered `{}` (over the held cap, SEC §2.7, or a
         * non-unix transport), so Claude shows the native dialog and `hookSeq` cannot be responded to (§3.7 step 8, ICR
         * 0017). Absent means held.
         */
        holdable?: false;
        toolName: string;
        input: unknown;
        promptId?: string;
        agent?: AgentRef;
        suggestions: unknown[];
        permissionMode?: string;
      }
    >
  | Obs<'permission.hookClosed', { hookSeq: HookSeq; reason: 'answered' | 'client_gone' | 'timeout' }>
  | Obs<
      'permission.decisionRecorded',
      {
        toolUseId: string;
        decision: 'accept' | 'reject';
        decider: PermissionDecider;
        via: 'attachment' | 'tool_result';
        reasonCode?: string;
      }
    >
  | Obs<'permission.autoDenied', { toolUseId: string; toolName: string; reason: string }>
  | Obs<'permission.pathsResolved', { permissionKey: PermissionKey; cwdRealpath: string; paths: ResolvedPath[] }> // rev2: result of permission.resolvePaths (§3.7)
  // ---- agents / background ----
  | Obs<'agent.started', { agent: AgentRef; promptId?: string }>
  | Obs<'agent.stopped', { agent: AgentRef; transcriptPath?: string; lastAssistantMessage?: string; backgroundTasks: BgTaskInfo[] }>
  | Obs<'agent.meta', { agentId: string; toolUseId?: string; agentType?: string; spawnDepth?: number; finished?: boolean }>
  | Obs<'agent.fileMissing', { agentId: string }>
  | Obs<'bgtask.status', { taskId: string; taskType: string; status: string; toolUseId?: string }>
  // ---- misc hook facts ----
  | Obs<'notification', { type: string; message?: string }>
  | Obs<'input.requested', { kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput'; message?: string; server?: string }> // rev2: Notification elicitation_dialog / elicitation_url_dialog / agent_needs_input
  | Obs<'input.requestCleared', { kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput'; how: 'complete' | 'response' }> // rev2: elicitation_complete / elicitation_response
  | Obs<'compact.phase', { phase: 'started' | 'finished'; trigger?: string }>
  | Obs<'mode.observed', { permissionMode: string }>
  | Obs<'model.switched', { fromModel?: string; toModel: string; source?: string }> // PostModelSwitch
  | Obs<'config.changed', { source: string; filePath?: string }> // ConfigChange
  | Obs<'cwd.changed', { oldCwd: string; newCwd: string }> // CwdChanged
  | Obs<'transcript.relocated', { sessionId: string; newPath: string }>
  | Obs<'transcript.continuedIn', { continuedInSessionId: string }>
  | Obs<
      'transcript.file',
      {
        event: 'waiting' | 'opened' | 'moved' | 'rewrite' | 'resynced' | 'malformed' | 'oversize' | 'missing';
        fileKey: string;
        detail: unknown;
      }
    >
  | Obs<
      'hookchannel.error',
      { hookEvent: string; toolUseId?: string; kind: 'non_blocking_error' | 'cancelled' | 'blocked_url' | 'untrusted'; detail?: string }
    >
  // ---- screen / network / registry ----
  | Obs<'screen.frame', ScreenFacts>
  | Obs<
      'net.tunnel',
      {
        tunnelId: number;
        host: string;
        token: 'A' | 'none' | 'bad';
        phase: 'open' | 'sending' | 'awaiting' | 'receiving' | 'idle' | 'close' | 'error' | 'refused';
        bytesUp: number;
        bytesDown: number;
        lastDownAtMono?: MonoMs;
        endedBy?: 'terminator' | 'close' | 'rst';
        error?: string;
        alpnH2?: boolean; // ICR 0008 (P-NET-18): the client offered ALPN h2 → the tunnel may multiplex; correlation stays unconfirmed
      }
    >
  | Obs<'registry', { pid: number; sessionId?: string; status?: string; waitingFor?: string; version?: string }> // single post-launch read
  // ---- self (facts about the library's own actions) ----
  | Obs<
      'input.done',
      {
        intentId: IntentId;
        job?: InputJobKey;
        primitive: InputPrimitive['kind'];
        ok: boolean;
        error?: CcdErrorCode;
        detail?: string;
        output?: string;
      }
    >
  | Obs<'hook.responded', { hookSeq: HookSeq; ok: boolean; clientGone: boolean }>
  | Obs<'hook.selfTestArmed', { nonce: string; armed: boolean }> // rev2: ack of hook.armSelfTest / hook.disarmSelfTest
  | Obs<'host.loopLag', { p99Ms: number; maxMs: number; windowMs: number }> // rev2: L3 monitorEventLoopDelay, only when p99 > 500 ms
  // ---- time / channel health ----
  | Obs<'clock.tick', {}>
  | Obs<'clock.hostResumed', { monoGapMs: number; wallGapMs: number }>
  | Obs<'channel.health', { channel: ChannelName; health: 'up' | 'degraded' | 'down' | 'off'; reason?: string }> // L0/L3 transport facts only (never auth)
  | Obs<'unknown', { channel: Source; raw: unknown }>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}
export type ChannelName = 'hooks' | 'transcript' | 'screen' | 'network';
