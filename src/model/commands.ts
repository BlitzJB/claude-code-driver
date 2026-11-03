// model/commands.ts — Command union (L3/L4 → L2) and CommandResult (DESIGN.md §2.6).

import type { PermissionKey, TurnKey } from './ids.js';
import type { CaptureUntil } from './intents.js';
import type { PermissionMode } from './state.js';

// ---------- commands.ts ----------
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message?: string; interrupt?: boolean };
export type PermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules';
      rules: { toolName: string; ruleContent?: string }[];
      behavior: 'allow' | 'deny' | 'ask';
      destination: 'session';
    }
  | { type: 'setMode'; mode: 'default' | 'acceptEdits' | 'plan'; destination: 'session' }; // dangerous modes only with allowDangerousModes
export type Command =
  | { type: 'prompt.send'; text: string; clientRef?: string; whenBusy: 'wait' | 'reject' }
  | { type: 'prompt.cancel'; turnKey: TurnKey } // only while still in libraryQueue
  | { type: 'turn.stop'; turnKey: TurnKey } // ICR 0023: atomic cancel-if-queued / interrupt-if-in-flight-or-running / no-op
  | { type: 'slash.run'; name: string; args?: string; unsafe?: boolean; capture?: { until: CaptureUntil; timeoutMs: number } } // ICR 0040
  | { type: 'interrupt'; clientRef?: string }
  | { type: 'permission.answer'; permissionKey: PermissionKey; decision: PermissionDecision; by: 'host' | 'handler' | 'policy' }
  | { type: 'permission.answerQuestion'; permissionKey: PermissionKey; answers: Record<string, string> } // AskUserQuestion
  | { type: 'permission.approvePlan'; permissionKey: PermissionKey; approve: boolean; mode?: 'default' | 'acceptEdits'; feedback?: string } // ExitPlanMode (rev2)
  | { type: 'mode.set'; mode: PermissionMode }
  | { type: 'usage.wakeNow' } // rev2: host-requested immediate wake check (the timer path is a core deadline)
  | { type: 'selftest.run'; nonce: string; cachedPass: boolean } // rev2: nonce minted by L3 (ids port); cachedPass → skip with selfTest 'cached'
  | { type: 'net.fault'; spec: FaultSpec | null }
  | { type: 'session.close'; mode: 'graceful' | 'kill'; graceMs: number; reason: string; waitForBackgroundMs?: number };
export type CommandResult<C extends Command> = C extends { type: 'prompt.send' }
  ? { turnKey: TurnKey }
  : C extends { type: 'interrupt' }
    ? { turnKey?: TurnKey }
    : C extends { type: 'turn.stop' }
      ? { ok: true; effect: 'cancelled' | 'interrupted' | 'none' }
      : C extends { type: 'slash.run' }
        ? { ok: true; effect: 'evidence' | 'modal' | 'none'; output?: string /* modal text, ≤ 16 KiB, normalized, redacted */ }
        : { ok: true };
export type FaultSpec =
  | { mode: 'refuse' }
  | { mode: 'blackhole' }
  | { mode: 'reset'; afterDownBytes: number }
  | { mode: 'stall'; afterDownBytes: number }
  | { mode: 'slow'; bytesPerSec: number };
