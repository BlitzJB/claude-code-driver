// core/input-policy/jobs.ts — InputJob types and constructors (DESIGN.md §2.9 normative types, §3.6 behaviour).
// The §2.9 union is `InputJobSpec`; `InputJob` adds the runtime bookkeeping the machine needs (additive, WP-09).

import type { CcdErrorData } from '../../model/errors.js';
import type { InputJobKey, IntentId, PermissionKey, TurnKey } from '../../model/ids.js';
import type { CaptureUntil, InputPrimitive } from '../../model/intents.js';
import type { GenKey } from '../../model/ids.js';
import type { PermissionMode } from '../../model/state.js';
import type { MonoMs } from '../../model/time.js';

export type SubmitPhase =
  'waitGate' | 'staging' | 'editorOpen' | 'verifyStaged' | 'settle' | 'enterSent' | 'awaitAck' | 'retryEnter' | 'done' | 'failed';
export type CommandPhase =
  'waitGate' | 'staging' | 'settle' | 'enterSent' | 'awaitEffect' | 'captureModal' | 'dismissModal' | 'done' | 'failed';

/** §2.9, verbatim. */
export type InputJobSpec =
  | {
      key: InputJobKey;
      kind: 'submit';
      turn: TurnKey;
      text: string /* sanitized */;
      method: 'editor' | 'pasteChunks';
      attempt: number;
      phase: SubmitPhase;
    }
  | {
      key: InputJobKey;
      kind: 'selftest';
      nonce: string;
      method: 'editor' | 'pasteChunks';
      phase: SubmitPhase | 'restoreCheck' | 'clearing';
    } // rev2: no Turn
  | {
      key: InputJobKey;
      kind: 'command';
      name: string /* canonical, aliases resolved */;
      args?: string;
      phase: CommandPhase;
      cmdId: number;
      output?: string;
      capture?: { until: CaptureUntil; timeoutMs: number }; // ICR 0040
    }
  | { key: InputJobKey; kind: 'interrupt'; turn?: TurnKey; phase: 'escSent' | 'confirming' | 'done' }
  | { key: InputJobKey; kind: 'clearComposer'; phase: 'editorClear' | 'esc1' | 'awaitHint' | 'esc2' | 'verify' | 'done' }
  | {
      key: InputJobKey;
      kind: 'permissionKeys';
      permission: PermissionKey;
      action: 'deny' | { digit: number };
      /** check: waiting for a fresh frame to confirm the dialog is still shown before any key (ICR 0028) */
      phase: 'check' | 'sent' | 'verify' | 'done';
    }
  | { key: InputJobKey; kind: 'setMode'; target: PermissionMode; presses: number; phase: 'pressed' | 'verify' | 'done' }
  | { key: InputJobKey; kind: 'wakeEnter'; phase: 'sent' | 'verify' | 'done' }
  | { key: InputJobKey; kind: 'dismissMenu'; phase: 'sent' | 'verify' | 'done' }; // rev2: one Escape on the usage-limit options menu

/** Composer-clear sub-sequence shared by clearComposer jobs, the self-test and the paste fallback (§3.6 clearComposer). */
export interface ClearState {
  mode: 'editor' | 'keys';
  step: 'stage' | 'cg' | 'await' | 'verify' | 'esc1' | 'hint' | 'esc2' | 'final';
  /** what to do when the sub-sequence ends */
  then: 'finish' | 'resumeSubmit' | 'selftestDisarm' | 'typeCommand';
}

/** Runtime bookkeeping (additive to §2.9). */
interface JobRuntime {
  /** creation order (FIFO between submit/command jobs) */
  seq: number;
  createdAt: MonoMs;
  /** number of input intents emitted so far (Intent.step) */
  step: number;
  /** the input intent whose input.done we wait for */
  pending?: { intentId: IntentId; primitive: InputPrimitive['kind'] };
  /** waiting for a fresh screen frame (captured after `since`) */
  waitFrame?: { since: MonoMs; purpose: string };
  /** composer-clear sub-sequence in progress */
  clear?: ClearState;
  /** submit/selftest/command: the editor failed once; fall back (§3.6 step 2) */
  editorFailed?: boolean;
  /** pasteChunks: the chunks and the next index */
  chunks?: string[];
  chunkIdx?: number;
  /** submit: the ack deadline was extended once for an external-shape UPS (§3.6 step 5.2) */
  ackExtended?: boolean;
  /** submit: composer empty at the ack deadline → waiting for transcript evidence within hookGapMs */
  awaitTranscript?: boolean;
  /** submit: library auto-continue after a usage-limit wake (canSubmit forWake) */
  forWake?: boolean;
  /** setMode / mode.set: the command id to resolve when the job ends */
  resultFor?: number;
  /** command: internal job (close's `/exit`), bypasses the refuse list */
  internal?: boolean;
  /** command: evidence seen so far (`/clear` needs SessionEnd(clear) + SessionStart(clear)) */
  evidence?: { sawEnd?: boolean };
  /** selftest: the transcript showed `prompt.blocked` for the nonce (cross-check, ICR 0002) */
  blockedSeen?: boolean;
  /** first-of-generation extra ack time applied */
  gen?: GenKey;
  enterAt?: MonoMs;
  /** a `blockedByHook` notice was already on screen when Enter went out (stale, e.g. the self-test's own block; ICR 0016) */
  blockNoticeAtEnter?: boolean;
  /** Enter retries so far (§3.6 step 6) */
  retries?: number;
  /** exitCopyMode attempts before the job's first primitive */
  copyTries?: number;
  /** selftest: hook.disarmSelfTest sent, waiting for hook.selfTestArmed{armed:false} */
  disarming?: boolean;
  /** a primitive the I6 guard held back while a permission was held; re-sent when it clears */
  deferred?: InputPrimitive;
}

export type InputJob = InputJobSpec & JobRuntime;
export type InputJobOf<K extends InputJobSpec['kind']> = Extract<InputJobSpec, { kind: K }> & JobRuntime;

export interface PendingCommandResult {
  cmdId: number;
  ok: boolean;
  value?: unknown;
  error?: CcdErrorData;
}

export interface InputPolicyState {
  jobs: Record<InputJobKey, InputJob>;
  order: InputJobKey[];
  current?: InputJobKey;
  lastEscAt?: MonoMs;
  lastCtrlCAt?: MonoMs;
  firstPromptSentInGen: Record<GenKey, true>;
  /** additive: command results produced at job end, delivered one per step through StepResult.commandResult */
  pendingResults: PendingCommandResult[];
}

/** Jobs that bypass the idle/limit conditions of canSubmit (but not copy-mode, torn or settle rules), §3.6 Gate. */
export const BYPASS_KINDS: ReadonlySet<InputJobSpec['kind']> = new Set([
  'permissionKeys',
  'interrupt',
  'wakeEnter',
  'dismissMenu',
  'clearComposer',
]);

export function initialInputPolicy(): InputPolicyState {
  return { jobs: {}, order: [], firstPromptSentInGen: {}, pendingResults: [] };
}

interface Base {
  key: InputJobKey;
  seq: number;
  createdAt: MonoMs;
}
const rt = (b: Base): JobRuntime => ({ seq: b.seq, createdAt: b.createdAt, step: 0 });

export function submitJob(b: Base, turn: TurnKey, text: string, method: 'editor' | 'pasteChunks', forWake = false): InputJobOf<'submit'> {
  const j: InputJobOf<'submit'> = { key: b.key, kind: 'submit', turn, text, method, attempt: 0, phase: 'waitGate', ...rt(b) };
  if (forWake) j.forWake = true;
  return j;
}
export function selftestJob(b: Base, nonce: string, method: 'editor' | 'pasteChunks'): InputJobOf<'selftest'> {
  return { key: b.key, kind: 'selftest', nonce, method, phase: 'waitGate', ...rt(b) };
}
export function commandJob(
  b: Base,
  name: string,
  args: string | undefined,
  cmdId: number,
  internal = false,
  capture?: { until: CaptureUntil; timeoutMs: number },
): InputJobOf<'command'> {
  const j: InputJobOf<'command'> = { key: b.key, kind: 'command', name, phase: 'waitGate', cmdId, ...rt(b) };
  if (capture !== undefined) j.capture = { until: capture.until, timeoutMs: capture.timeoutMs };
  if (args !== undefined && args !== '') j.args = args;
  if (internal) j.internal = true;
  return j;
}
export function interruptJob(b: Base, turn: TurnKey | undefined): InputJobOf<'interrupt'> {
  const j: InputJobOf<'interrupt'> = { key: b.key, kind: 'interrupt', phase: 'escSent', ...rt(b) };
  if (turn !== undefined) j.turn = turn;
  return j;
}
export function clearComposerJob(b: Base, mode: 'editor' | 'keys'): InputJobOf<'clearComposer'> {
  return {
    key: b.key,
    kind: 'clearComposer',
    phase: mode === 'editor' ? 'editorClear' : 'esc1',
    ...rt(b),
    clear: { mode, step: mode === 'editor' ? 'stage' : 'esc1', then: 'finish' },
  };
}
export function permissionKeysJob(b: Base, permission: PermissionKey, action: 'deny' | { digit: number }): InputJobOf<'permissionKeys'> {
  return { key: b.key, kind: 'permissionKeys', permission, action, phase: 'sent', ...rt(b) };
}
export function setModeJob(b: Base, target: PermissionMode, resultFor: number): InputJobOf<'setMode'> {
  return { key: b.key, kind: 'setMode', target, presses: 0, phase: 'pressed', ...rt(b), resultFor };
}
export function wakeEnterJob(b: Base): InputJobOf<'wakeEnter'> {
  return { key: b.key, kind: 'wakeEnter', phase: 'sent', ...rt(b) };
}
export function dismissMenuJob(b: Base): InputJobOf<'dismissMenu'> {
  return { key: b.key, kind: 'dismissMenu', phase: 'sent', ...rt(b) };
}

/**
 * What a finished or advancing job means for the rest of the core. The machine never imports decide/* (no cycles); `step`
 * hands these to the decide modules after each machine run.
 */
export type JobOutcome =
  | { kind: 'submitStarted'; job: InputJobKey; turn: TurnKey; attempt: number; method: 'editor' | 'pasteChunks' }
  | { kind: 'submitFailed'; job: InputJobKey; turn: TurnKey; error: CcdErrorData; clearComposer: boolean }
  | { kind: 'submitAcceptedByTranscript'; job: InputJobKey; turn: TurnKey; promptId?: string }
  | { kind: 'selftestFailed'; step: string; transcriptEvidence: boolean; error: CcdErrorData }
  | { kind: 'selftestPassed' }
  | { kind: 'permissionKeysDone'; permission: PermissionKey; action: 'deny' | { digit: number }; ok: boolean }
  | { kind: 'wakeDone'; ok: boolean }
  | { kind: 'menuDismissed'; ok: boolean }
  | { kind: 'closeExitFailed' };
