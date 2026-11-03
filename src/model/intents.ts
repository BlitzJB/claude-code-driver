// model/intents.ts — Intent union (L2 → L3), InputPrimitive, TmuxKeyName (DESIGN.md §2.6).

import type { FaultSpec, PermissionDecision } from './commands.js';
import type { HookSeq, InputJobKey, IntentId, PermissionKey } from './ids.js';
import type { AgentStatus, UsageLimitState } from './state.js';
import type { MonoMs } from './time.js';

// ---------- intents.ts ----------
/** ICR 0040: named readiness criteria for captureText; L3 evaluates them with the profile and re-captures until met. */
export type CaptureUntil = 'usageReady';

export type TmuxKeyName = 'Enter' | 'Escape' | 'BTab' | 'Up' | 'Down' | 'C-g' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
// Closed list. Up/Down only inside an allow-listed dialog job (resume dialog), digits only for screenAllow permission keys.
// NEVER: Tab, Right, Left, C-c, C-u, C-s, C-y, C-l, C-d, C-z, C-b, S-Enter, M-*, PageUp/Down (IN §12, PA I9, TUI §8.7, LC rule 5)
export type InputPrimitive =
  | { kind: 'editorStage'; text: string } // write staged file + arm nonce (L0 EditorInjector)
  | { kind: 'key'; key: TmuxKeyName; gapAfterMs: number }
  | { kind: 'pasteChunk'; text: string; bracketed: true } // ≤ 400 bytes, ≤ 2 LF, sanitized
  | { kind: 'typeLiteral'; text: string } // ≤ 200 bytes, single line, slash command fallback only
  | { kind: 'awaitEditorConsumed'; timeoutMs: number }
  | { kind: 'captureText'; rows: 'modal'; until?: CaptureUntil; timeoutMs?: number } // rev2: returns normalized modal text in input.done.output (slash.run modal output)
  | { kind: 'exitCopyMode' };
export type Intent =
  | { kind: 'input'; id: IntentId; job: InputJobKey; step: number; primitive: InputPrimitive }
  | { kind: 'screen.captureNow'; id: IntentId; reason: string }
  | { kind: 'poll.cadence'; id: IntentId; channel: 'screen'; intervalMs: number | null }
  | { kind: 'auth.poll'; id: IntentId; intervalMs: number | null } // rev2: L3 runs `claude auth status --json`, reports auth.status
  | { kind: 'hook.respond'; id: IntentId; hookSeq: HookSeq; body: PermissionResponseBody | null } // null = empty reply (no decision → dialog)
  | { kind: 'hook.armSelfTest'; id: IntentId; nonce: string } // rev2
  | { kind: 'hook.disarmSelfTest'; id: IntentId } // rev2
  | { kind: 'host.askPermission'; id: IntentId; permissionKey: PermissionKey; deadlineAt: MonoMs } // broker runs handler / emits to host; the timeout itself is core deadline `permissionPolicy`
  | { kind: 'host.cancelAsk'; id: IntentId; permissionKey: PermissionKey; reason: string } // rev2: aborts the handler's AbortSignal
  | { kind: 'permission.resolvePaths'; id: IntentId; permissionKey: PermissionKey; toolName: string; input: unknown } // rev2 (§3.7)
  | { kind: 'tail.followMain'; id: IntentId; sessionId: string; path: string; startAt: 'beginning' | 'end' }
  | { kind: 'tail.observePath'; id: IntentId; sessionId: string; path: string; source: string }
  | { kind: 'tail.expectSubagent'; id: IntentId; sessionId: string; agentId: string }
  | { kind: 'tail.subagentStopped'; id: IntentId; sessionId: string; agentId: string; path?: string }
  | { kind: 'tail.poke'; id: IntentId; reason: string }
  | { kind: 'registry.persist'; id: IntentId; patch: RegistryPatch }
  | { kind: 'net.fault'; id: IntentId; spec: FaultSpec | null }
  | { kind: 'process.signal'; id: IntentId; signal: 'SIGTERM' | 'SIGKILL' }
  | { kind: 'lifecycle.finalize'; id: IntentId; reason: string };
export type PermissionResponseBody = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: PermissionDecision } };
export interface RegistryPatch {
  claudeSessionId?: string;
  transcriptPath?: string;
  state?: AgentStatus['kind'];
  usageLimit?: UsageLimitState | null;
  lastEventSeq?: number;
}
