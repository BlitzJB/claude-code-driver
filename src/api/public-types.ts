// api/public-types.ts — the public, semver-stable types of `claude-code-driver` (DESIGN.md §2.12, normative).
//
// Declaration hygiene (§1.3 extra rules, P-API-01): nothing in this file may name an L0/L1/L2-internal type. Every public shape
// is written out here even where an internal one looks alike (`AgentStatus`, `Provenance`, `SessionExitInfo`), because the API
// report follows every relative import of the public `.d.ts` files and greps them for internal names.

import type { PublicErrorCode } from '../model/errors.js';
import type { ClaudeSessionError } from './map-errors.js';

export type { PublicErrorCode } from '../model/errors.js';

export type SessionKey = string & { readonly __brand: 'SessionKey' };
export type TurnKey = string & { readonly __brand: 'TurnKey' };
export type ToolKey = string & { readonly __brand: 'ToolKey' };
export type SubagentKey = string & { readonly __brand: 'SubagentKey' };
export type PermissionKey = string & { readonly __brand: 'PermissionKey' };
export type ChannelName = 'hooks' | 'transcript' | 'network' | 'screen';
/** Dangerous modes only via `unstable_advanced.permissions.allowDangerousModes`; they show as `'other'` in snapshots. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan';
export interface Provenance {
  readonly confirmed: boolean;
  readonly sources: readonly ChannelName[];
}

export interface Logger {
  debug(m: string, f?: Record<string, unknown>): void;
  info(m: string, f?: Record<string, unknown>): void;
  warn(m: string, f?: Record<string, unknown>): void;
  error(m: string, f?: Record<string, unknown>): void;
}

// ---------- permissions ----------
export interface PermissionRequest {
  readonly key: PermissionKey;
  readonly toolName: string;
  /** Permanently `unknown` (P-API-18): narrowing it later would be a breaking change. */
  readonly toolInput: unknown;
  readonly suggestions: readonly unknown[];
  readonly needs: 'decision' | 'answers' | 'planApproval';
  readonly turnKey?: TurnKey;
  readonly toolKey?: ToolKey;
  readonly subagentKey?: SubagentKey;
  readonly background: boolean;
  /** Wall-clock epoch ms. */
  readonly requestedAt: number;
  /** Wall-clock epoch ms after which the configured `onTimeout` applies. */
  readonly deadlineAt: number;
  /** Aborted when the request is no longer answerable (Claude withdrew it, the TUI answered, the session closed). */
  readonly signal: AbortSignal;
}
export type PermissionDecision =
  { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message?: string; interrupt?: boolean };
/** `undefined` = ask the host (a `permissionRequested` event; answer with `respondToPermission`). */
export type PermissionHandler = (req: PermissionRequest) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>;

// ---------- errors ----------
export interface ClaudeSessionErrorData {
  code: PublicErrorCode;
  message: string;
  /** `reason` carries the fine-grained internal code (documented, not frozen, D-40). */
  details: { reason: string } & Record<string, unknown>;
}

// ---------- state ----------
/** All times are wall-clock epoch ms. */
export type AgentStatus =
  | { kind: 'starting'; since: number }
  | { kind: 'idle'; since: number; backgroundAgents: number; queued: number; quiescent: boolean; lastError?: ClaudeSessionErrorData }
  | {
      kind: 'modelRequest';
      phase: 'waiting' | 'streaming' | 'retrying' | 'stalled';
      since: number;
      attempt?: number;
      maxAttempts?: number;
      retryInMs?: number;
      provenance: Provenance;
    }
  | { kind: 'writing'; since: number; provenance: Provenance }
  | { kind: 'runningTools'; tools: readonly ToolKey[]; since: number; provenance: Provenance }
  | { kind: 'awaitingPermission'; permission: PermissionKey; since: number }
  | {
      kind: 'awaitingInput';
      inputKind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput' | 'unknownModal';
      message?: string;
      since: number;
    }
  | { kind: 'interrupted'; since: number }
  | { kind: 'compacting'; since: number }
  | { kind: 'usageLimited'; since: number; resetsAt?: number; nextWakeAt?: number; autoResume: boolean }
  | { kind: 'authRequired'; since: number; message: string }
  | { kind: 'exited'; since: number; exitStatus: number | null; signal: string | null };

export interface ToolRunSnapshot {
  readonly key: ToolKey;
  readonly toolUseId?: string;
  readonly name: string;
  readonly input: unknown;
  /** 'running' is also shown for a tool pending > 150 ms without a permission (display rule, §4.6). */
  readonly state: 'pending' | 'awaitingPermission' | 'running' | 'launched' | 'succeeded' | 'failed' | 'denied' | 'interrupted' | 'unknown';
  readonly turnKey?: TurnKey;
  readonly subagentKey?: SubagentKey;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly provenance: Provenance;
}
export interface SubagentSnapshot {
  readonly key: SubagentKey;
  readonly agentId: string;
  readonly agentType: string;
  readonly background: boolean;
  readonly state: 'running' | 'stopped' | 'unknown';
  readonly startedAt: number;
  readonly endedAt?: number;
}
export interface TurnSnapshot {
  readonly key: TurnKey;
  readonly prompt: string;
  readonly promptId?: string;
  readonly origin: 'library' | 'external';
  readonly state:
    'queued' | 'submitting' | 'running' | 'completed' | 'interrupted' | 'failed' | 'aborted' | 'notSubmitted' | 'withdrawn' | 'unknown';
  readonly tools: readonly ToolKey[];
  readonly subagents: readonly SubagentKey[];
  readonly text: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: ClaudeSessionErrorData;
}
export interface SessionSnapshot {
  readonly key: SessionKey;
  readonly claudeSessionId: string;
  readonly cwd: string;
  readonly claudeVersion: string;
  readonly status: AgentStatus;
  readonly mode: PermissionMode | 'other';
  readonly model?: string;
  readonly currentTurn?: TurnSnapshot;
  readonly queuedTurns: readonly TurnKey[];
  readonly activeTools: readonly ToolRunSnapshot[];
  readonly subagents: readonly SubagentSnapshot[];
  readonly pendingPermissions: readonly PermissionKey[];
  readonly usage: { readonly contextUsedPct?: number; readonly limitedUntil?: number };
  readonly channels: Readonly<Record<ChannelName, 'up' | 'degraded' | 'down' | 'off'>>;
  readonly lastEventSeq: number;
}

// ---------- events ----------
interface Ev<T extends string, P> {
  readonly type: T;
  readonly seq: number;
  /** Wall-clock epoch ms. */
  readonly at: number;
  readonly turnKey?: TurnKey;
  readonly provenance: Provenance;
  readonly data: P;
}
export type SessionEvent =
  | Ev<'ready', { mode: PermissionMode | 'other'; model?: string }>
  | Ev<'status', { from: AgentStatus; to: AgentStatus }>
  | Ev<'claudeSessionChanged', { from?: string; to: string; reason: string }>
  | Ev<'turnQueued', { prompt: string; origin: TurnSnapshot['origin'] }>
  | Ev<'turnStarted', { promptId: string }>
  | Ev<'externalTurn', { prompt: string; kind: 'taskNotification' | 'scheduled' | 'autoContinue' | 'human' | 'unknown' }>
  | Ev<'text', { delta: string; messageId: string; final: boolean }>
  | Ev<'textRetracted', { messageIds: readonly string[] }>
  | Ev<'message', { messageId: string; text: string }>
  | Ev<'toolStarted', ToolRunSnapshot>
  | Ev<'toolEnded', ToolRunSnapshot>
  | Ev<'permissionRequested', Omit<PermissionRequest, 'signal'>>
  | Ev<'permissionResolved', { key: PermissionKey; decision: 'allow' | 'deny'; by: 'library' | 'tui' | 'policy' | 'unknown' }>
  | Ev<'inputRequested', { inputKind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput' | 'unknownModal'; message?: string }>
  | Ev<'subagentStarted', SubagentSnapshot>
  | Ev<'subagentEnded', SubagentSnapshot>
  | Ev<'modelCall', { phase: 'started' | 'waiting' | 'streaming' | 'retrying' | 'stalled' | 'ended'; attempt?: number; retryInMs?: number }>
  | Ev<'usageLimited', { resetsAt?: number; nextWakeAt?: number }>
  | Ev<'compaction', { phase: 'started' | 'ended' }>
  | Ev<'turnEnded', TurnResult>
  | Ev<'channel', { channel: ChannelName; health: 'up' | 'degraded' | 'down' | 'off'; reason?: string }>
  | Ev<'authRequired', { message: string }>
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- §2.12 verbatim: an event with no data
  | Ev<'authRestored', {}>
  | Ev<'security', { code: 'E_SECURITY'; reason: string }>
  | Ev<'warning', { code: PublicErrorCode; reason: string; message: string }>
  | Ev<'gap', { from: number; to: number }>
  | Ev<'exited', SessionExitInfo>;
export type SessionEventType = SessionEvent['type'];
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;

// ---------- turns ----------
export type TurnOutcome = 'completed' | 'interrupted' | 'failed' | 'aborted' | 'notSubmitted' | 'withdrawn' | 'unknown';
export interface TurnResult {
  readonly turnKey: TurnKey;
  readonly outcome: TurnOutcome;
  readonly text: string;
  readonly refused: boolean;
  readonly tools: readonly ToolRunSnapshot[];
  readonly durationMs: number;
  readonly error?: ClaudeSessionError;
}
export interface Turn extends AsyncIterable<SessionEvent> {
  /**
   * The turn's key. `send()` returns before the core has queued the prompt; until then (normally one event-loop turn) this is
   * a provisional `pending:<n>` reference that `session.turn()` also accepts.
   */
  readonly key: TurnKey;
  readonly prompt: string;
  /** Rejects E_SUBMIT_UNCONFIRMED / E_BUSY / E_INPUT_REJECTED / E_SESSION_EXITED / E_SESSION_CLOSED; never unhandled (P-API-07). */
  readonly accepted: Promise<{ promptId: string }>;
  /** Always resolves (D-31). */
  readonly done: Promise<TurnResult>;
  /** Resolves on 'completed', else throws `TurnResult.error`. */
  completed(): Promise<TurnResult>;
  snapshot(): TurnSnapshot;
  events(opts?: { highWaterMark?: number }): AsyncIterableIterator<SessionEvent>;
  interrupt(): Promise<void>;
}

// ---------- session ----------
export interface SessionExitInfo {
  readonly exitStatus: number | null;
  readonly signal: string | null;
  readonly reason: 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone';
}
export type Unsubscribe = () => void;

/** One meter from Claude's `/usage` dialog (subscription usage). */
export interface UsageMeter {
  readonly window: 'session' | 'week';
  /** Weekly model scope as Claude prints it ("all models", "Fable", …). */
  readonly scope?: string;
  readonly label: string;
  /** 0–100. */
  readonly usedPct: number;
  /** Reset time exactly as Claude prints it, e.g. "Nov 3 at 7:30pm (Etc/UTC)". */
  readonly resetsText?: string;
}
export interface UsageInfo {
  readonly meters: readonly UsageMeter[];
  /** Convenience: the session meter, if shown. */
  readonly session?: UsageMeter;
  /** Convenience: the "all models" weekly meter (or the first weekly meter). */
  readonly week?: UsageMeter;
  readonly credits?: 'on' | 'off';
  /** true when Claude was still refreshing the dialog after retries: some meters may be missing or stale. */
  readonly partial?: true;
  /** Epoch ms when the dialog was read. */
  readonly readAt: number;
}
