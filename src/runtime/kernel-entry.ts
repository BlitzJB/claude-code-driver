// runtime/kernel-entry.ts — the `claude-code-driver/kernel` subpath (DESIGN.md §1.2, §7; @experimental). It exposes the
// SessionKernel port for alternative facades: `createKernel` plus the model types it speaks and the read-only selectors.
// Everything here may change in any minor release; the stable API is the package root (`claude-code-driver`).

/** @experimental */
export { createKernel } from './node.js';
export type { CreateKernelOptions } from './node.js';
/** @experimental */
export {
  backgroundCount,
  currentTurn,
  displayToolState,
  isBgTaskOpen,
  isQuiescent,
  lastTurn,
  pendingPermissions,
} from '../core/selectors.js';
export type { Command, CommandResult, PermissionDecision } from '../model/commands.js';
export type { DomainEvent, EventEnvelope, TurnOutcome } from '../model/events.js';
export type { EventSeq, PermissionKey, SessionKey, ToolKey, TurnKey } from '../model/ids.js';
export type {
  KernelCloseOptions,
  KernelListener,
  KernelPermissionHandler,
  PermissionAsk,
  SessionExitInfo,
  SessionKernel,
  Unsubscribe,
} from '../model/kernel.js';
export type { Logger, LogFields } from '../model/logger.js';
export type { SessionSpec } from '../model/spec.js';
export type { SessionState } from '../model/state.js';
export { SUPPORTED_CLAUDE_VERSION, LIB_VERSION } from '../model/version.js';
