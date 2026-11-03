// model/kernel.ts — the SessionKernel port types (DESIGN.md §2.10, D-02). Implemented by session/kernel.ts;
// `createKernel(spec, o?)` lives in runtime/node.ts. Facades depend on these types only.

import type { Command, CommandResult, PermissionDecision } from './commands.js';
import type { UsageReport } from './usage.js';
import type { DebugRecord } from './debug.js';
import type { DomainEvent } from './events.js';
import type { AgentKey, EventSeq, PermissionKey, SessionKey, ToolKey, TurnKey } from './ids.js';
import type { SessionState } from './state.js';
import type { MonoMs } from './time.js';

// model/kernel.ts
export type Unsubscribe = () => void;
export interface SessionExitInfo {
  exitStatus: number | null;
  signal: string | null;
  reason: 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone';
  finalScreen?: string;
}
export type KernelListener = (batch: {
  events: readonly DomainEvent[];
  state: Readonly<SessionState>;
  gap?: { from: EventSeq; to: EventSeq };
}) => void;
export interface KernelCloseOptions {
  mode?: 'graceful' | 'kill';
  graceMs?: number;
  reason?: string;
  waitForBackgroundMs?: number;
}
export interface PermissionAsk {
  // what the broker hands to a user handler (facade maps it to PermissionRequest)
  permissionKey: PermissionKey;
  toolName: string;
  input: unknown;
  suggestions: readonly unknown[];
  needs: 'decision' | 'answers' | 'planApproval';
  turnKey?: TurnKey;
  toolKey?: ToolKey;
  agentKey?: AgentKey;
  background: boolean;
  deadlineAt: MonoMs;
  signal: AbortSignal;
}
export type KernelPermissionHandler = (ask: PermissionAsk) => PermissionDecision | Promise<PermissionDecision | undefined> | undefined; // undefined = ask the host (event)
export interface SessionKernel {
  readonly sessionKey: SessionKey;
  getState(): Readonly<SessionState>; // immutable snapshot (structural sharing)
  dispatch<C extends Command>(cmd: C): Promise<CommandResult<C>>; // resolves when the core accepted it (slash.run: when its job finished)
  subscribe(listener: KernelListener, opts?: { fromSeq?: EventSeq }): Unsubscribe; // ring replay; first batch carries `gap` if retention lost events
  subscribeDebug(listener: (r: DebugRecord) => void): Unsubscribe; // no-op unless debug enabled
  /** ICR 0040: runs `/usage` (no model call), parses the dialog, dismisses it. Rejects E_USAGE_UNAVAILABLE if unreadable. */
  queryUsage(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<UsageReport>;
  /** ICR 0041: stop Claude and keep the session; rejects E_BUSY{reason: first blocker} when not suspendable. */
  suspend(): Promise<void>;
  /** ICR 0041: relaunch a suspended session (no-op when live); rejects with the start error and stays suspended. */
  resume(): Promise<void>;
  setPermissionHandler(h: KernelPermissionHandler | null): void; // lives in L3 (user code); the core only sees permission.answer
  waitFor(pred: (s: SessionState) => boolean, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SessionState>; // rejects E_WAIT_TIMEOUT / AbortError
  readonly diagnostics: {
    viewCommand(): string /* tmux -L <sock> attach -r -t =<session>: */;
    captureScreen(): Promise<string>;
    tracePath?: string;
  };
  close(opts?: KernelCloseOptions): Promise<SessionExitInfo>; // idempotent
}
