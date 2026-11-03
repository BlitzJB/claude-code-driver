// api/index.ts — the `claude-code-driver` entry point (DESIGN.md §2.12). Semver-stable surface only; the kernel port lives behind
// the `./kernel` subpath (@experimental). Nothing here may re-export a module whose declarations name an internal type (§1.3).

export { SUPPORTED_CLAUDE_VERSION } from '../model/version.js';
export { ClaudeSession, installSignalHandlers } from './claude-session.js';
export { ClaudeSessionError, isClaudeSessionError, PUBLIC_ERROR_CODES } from './map-errors.js';
export { consoleLogger } from './options.js';
export type { ClaudeSessionOptions } from './options.js';
export { redactEvent } from './iterators.js';
export type {
  AgentStatus,
  ChannelName,
  ClaudeSessionErrorData,
  Logger,
  PermissionDecision,
  PermissionHandler,
  PermissionKey,
  PermissionMode,
  PermissionRequest,
  Provenance,
  PublicErrorCode,
  SessionEvent,
  SessionEventOf,
  SessionEventType,
  SessionExitInfo,
  SessionKey,
  SessionSnapshot,
  SubagentKey,
  SubagentSnapshot,
  ToolKey,
  ToolRunSnapshot,
  Turn,
  TurnKey,
  TurnOutcome,
  TurnResult,
  TurnSnapshot,
  Unsubscribe,
  UsageInfo,
  UsageMeter,
} from './public-types.js';
