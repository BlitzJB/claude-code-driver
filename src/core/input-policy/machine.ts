// core/input-policy/machine.ts — the input job state machine → Intents (DESIGN.md §3.6; IN §12 single writer).
// Exactly one job runs at a time; the executor (L3 input-executor.ts) runs one primitive per `input` intent and reports
// `input.done`. Every wait is a core deadline. The machine never imports decide/*: consequences for turns, permissions,
// the self-test and the usage wake leave as JobOutcome records that `step` dispatches.

import type { CcdErrorCode, CcdErrorData } from '../../model/errors.js';
import type { InputJobKey, TurnKey } from '../../model/ids.js';
import type { InputPrimitive, TmuxKeyName } from '../../model/intents.js';
import type { JsonValue } from '../../model/json.js';
import type { Observation } from '../../model/observation.js';
import type { ScreenFacts } from '../../model/screen-facts.js';
import type { PermissionMode } from '../../model/state.js';
import {
  arm,
  captureNow,
  cfg,
  diag,
  disarm,
  disarmWhere,
  dom,
  emit,
  err,
  inputState,
  nowOf,
  permissionHeld,
  publish,
  recon,
  setInputState,
  setResult,
  updRecon,
} from '../ctx.js';
import type { Ctx } from '../ctx.js';
import type { DeadlineKind } from '../facts.js';
import { canSubmit } from '../selectors.js';
import { isTurnTerminal } from '../lattice.js';
import type { CoreState } from '../types.js';
import { normalizeForAck } from './ack-match.js';
import { surfaceGate } from './gating.js';
import { BYPASS_KINDS, clearComposerJob } from './jobs.js';
import type { ClearState, InputJob, InputJobOf, JobOutcome } from './jobs.js';
import { chunkForPaste, utf8Bytes } from './sanitize.js';

/** How long a job waits for a fresh frame after requesting a capture before using the last one (an unchanged screen is dropped by L1). */
const FRAME_WAIT_MS = 600;
const MENU_WAIT_MS = 1000;
const SETMODE_WAIT_MS = 500;
const SETMODE_MAX_PRESSES = 6;
const DISARM_WAIT_MS = 2000;
const MODAL_OUTPUT_MAX = 16 * 1024;

// ------------------------------------------------------------------ job table helpers
export function jobOf(ctx: Ctx, key: InputJobKey | undefined): InputJob | undefined {
  return key === undefined ? undefined : inputState(ctx).jobs[key];
}
export function currentJob(ctx: Ctx): InputJob | undefined {
  return jobOf(ctx, inputState(ctx).current);
}
function put(ctx: Ctx, j: InputJob): void {
  const s = inputState(ctx);
  setInputState(ctx, { ...s, jobs: { ...s.jobs, [j.key]: j } });
}
function upd(ctx: Ctx, key: InputJobKey, p: Partial<InputJob>): InputJob | undefined {
  const j = jobOf(ctx, key);
  if (j === undefined) return undefined;
  const n = { ...j, ...p } as InputJob;
  put(ctx, n);
  return n;
}
function drop(ctx: Ctx, key: InputJobKey, ...fields: (keyof InputJob)[]): InputJob | undefined {
  const j = jobOf(ctx, key);
  if (j === undefined) return undefined;
  const n: Record<string, unknown> = { ...j };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removes optional runtime fields by name
  for (const f of fields) delete n[f as string];
  put(ctx, n as unknown as InputJob);
  return n as unknown as InputJob;
}

export function enqueueJob(ctx: Ctx, j: InputJob, front = false): void {
  const s = inputState(ctx);
  setInputState(ctx, { ...s, jobs: { ...s.jobs, [j.key]: j }, order: front ? [j.key, ...s.order] : [...s.order, j.key] });
}

/** Remove a job that has not started (prompt.cancel, evidence that made it moot). */
export function cancelQueuedJob(ctx: Ctx, key: InputJobKey): boolean {
  const s = inputState(ctx);
  if (!(key in s.jobs) || s.current === key) return false;
  const { [key]: _gone, ...rest } = s.jobs;
  setInputState(ctx, { ...s, jobs: rest, order: s.order.filter((k) => k !== key) });
  return true;
}

/**
 * Drop the current submit job if it has not begun: made current but waiting for copy mode to exit, nothing typed yet
 * (turn.stop, ICR 0023). Its in-flight exitCopyMode primitive then reports for an unknown job (a diagnostic only).
 */
export function abortUnbegunSubmit(ctx: Ctx, key: InputJobKey): boolean {
  const j = jobOf(ctx, key);
  if (j?.kind !== 'submit' || inputState(ctx).current !== key || j.phase !== 'waitGate' || j.attempt !== 0) return false;
  removeJob(ctx, key);
  return true;
}

function removeJob(ctx: Ctx, key: InputJobKey): void {
  const s = inputState(ctx);
  const { [key]: _gone, ...rest } = s.jobs;
  const next = { ...s, jobs: rest, order: s.order.filter((k) => k !== key) };
  if (next.current === key) delete next.current;
  setInputState(ctx, next);
  disarmWhere(ctx, (d) => d.ref === key || d.ref.startsWith(`${key}:`) || d.ref === `job:${key}`);
}

function outcome(ctx: Ctx, o: JobOutcome): void {
  ctx.outcomes.push(o);
}

// ------------------------------------------------------------------ primitives
function textOf(j: InputJob): string {
  if (j.kind === 'submit') return j.text;
  if (j.kind === 'selftest') return j.nonce;
  if (j.kind === 'command') return j.args === undefined ? j.name : `${j.name} ${j.args}`;
  return '';
}

/** Emit one primitive for the job; false when the I6 guard held it back (re-sent by runMachine once the permission clears). */
function send(ctx: Ctx, key: InputJobKey, primitive: InputPrimitive): boolean {
  const j = jobOf(ctx, key);
  if (j === undefined) return false;
  const id = emit<'input'>(ctx, { kind: 'input', job: key, step: j.step + 1, primitive });
  if (id === undefined) {
    put(ctx, { ...j, deferred: primitive });
    return false;
  }
  const n: InputJob = { ...j, step: j.step + 1, pending: { intentId: id, primitive: primitive.kind } };
  delete n.deferred;
  put(ctx, n);
  if (primitive.kind === 'key' && primitive.key === 'Escape') setInputState(ctx, { ...inputState(ctx), lastEscAt: nowOf(ctx) });
  if (primitive.kind === 'key' && primitive.key === 'Enter') updRecon(ctx, (r) => ({ ...r, lastSentAt: nowOf(ctx) }));
  return true;
}
const key = (k: TmuxKeyName, gapAfterMs: number): InputPrimitive => ({ kind: 'key', key: k, gapAfterMs });

function screenUsable(ctx: Ctx): boolean {
  const t = recon(ctx).transport.screen ?? 'up';
  return t !== 'down' && t !== 'off';
}

/** Ask for a capture and wait for a frame taken after now (or FRAME_WAIT_MS, then use the last frame). */
function requestFrame(ctx: Ctx, k: InputJobKey, purpose: string, waitMs = FRAME_WAIT_MS): void {
  if (!screenUsable(ctx)) {
    frameResolved(ctx, k, purpose, undefined);
    return;
  }
  captureNow(ctx, `job:${purpose}`);
  upd(ctx, k, { waitFrame: { since: nowOf(ctx), purpose } });
  arm(ctx, 'keyGap', `${k}:frame`, nowOf(ctx) + waitMs);
}

// ------------------------------------------------------------------ failure / finish
function phaseFailed(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j !== undefined) put(ctx, { ...j, phase: 'failed' } as InputJob);
}

function finishJob(ctx: Ctx, k: InputJobKey): void {
  removeJob(ctx, k);
}

function failJob(ctx: Ctx, k: InputJobKey, e: CcdErrorData, opts: { clearComposer?: boolean } = {}): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  phaseFailed(ctx, k);
  switch (j.kind) {
    case 'submit':
      publish(ctx, 'input.rejected', { job: k, code: e.code, reason: e.message }, { turnKey: j.turn });
      outcome(ctx, { kind: 'submitFailed', job: k, turn: j.turn, error: e, clearComposer: opts.clearComposer === true });
      break;
    case 'selftest': {
      const step = typeof e.details?.['step'] === 'string' ? e.details['step'] : 'unknown';
      outcome(ctx, { kind: 'selftestFailed', step, transcriptEvidence: j.blockedSeen === true, error: e });
      break;
    }
    case 'command':
      publish(ctx, 'input.rejected', { job: k, code: e.code, reason: e.message });
      if (j.internal === true) outcome(ctx, { kind: 'closeExitFailed' });
      else setResult(ctx, { cmdId: j.cmdId, ok: false, error: e });
      break;
    case 'setMode':
      if (j.resultFor !== undefined) setResult(ctx, { cmdId: j.resultFor, ok: false, error: e });
      break;
    case 'permissionKeys':
      outcome(ctx, { kind: 'permissionKeysDone', permission: j.permission, action: j.action, ok: false });
      break;
    case 'wakeEnter':
      outcome(ctx, { kind: 'wakeDone', ok: false });
      break;
    case 'dismissMenu':
      outcome(ctx, { kind: 'menuDismissed', ok: false });
      break;
    case 'interrupt':
      publish(ctx, 'interrupt.ignored', { reason: 'noEvidence' }, j.turn !== undefined ? { turnKey: j.turn } : {});
      break;
    case 'clearComposer':
      publish(ctx, 'warning', { code: e.code, message: `composer not cleared: ${e.message}` });
      break;
  }
  diag(ctx, 'job_failed', { job: k, kind: j.kind, code: e.code, message: e.message });
  removeJob(ctx, k);
  if (opts.clearComposer === true && j.kind !== 'submit') enqueueClear(ctx, 'keys');
}

/** Queue a composer clear at the front (blocked prompt restored, collapsed paste, failed submit). */
export function enqueueClear(ctx: Ctx, mode: 'editor' | 'keys'): void {
  const key = nextJobKey(ctx);
  enqueueJob(ctx, clearComposerJob({ key, seq: ctx.core.counters.job, createdAt: nowOf(ctx) }, mode), true);
}

function nextJobKey(ctx: Ctx): InputJobKey {
  const n = ctx.core.counters.job + 1;
  ctx.core = { ...ctx.core, counters: { ...ctx.core.counters, job: n } };
  return `j${n}` as InputJobKey;
}

function commandResult(ctx: Ctx, j: InputJobOf<'command'>, effect: 'evidence' | 'modal' | 'none', output?: string): void {
  if (j.internal === true) {
    if (effect === 'none') outcome(ctx, { kind: 'closeExitFailed' });
    finishJob(ctx, j.key);
    return;
  }
  const value: Record<string, JsonValue> = { ok: true, effect };
  if (output !== undefined) value['output'] = output;
  setResult(ctx, { cmdId: j.cmdId, ok: true, value });
  finishJob(ctx, j.key);
}

// ------------------------------------------------------------------ start
function blockedOnlyByCopyMode(c: CoreState): CoreState {
  const d = c.domain;
  return { ...c, domain: { ...d, inputBlocked: { ...d.inputBlocked, copyMode: false } } };
}

function mayStart(ctx: Ctx, j: InputJob): boolean {
  const c = blockedOnlyByCopyMode(ctx.core);
  switch (j.kind) {
    case 'selftest':
      return canSubmit(c, { forSelfTest: true });
    case 'submit':
      return canSubmit(c, { forWake: j.forWake === true }) && recon(ctx).stopUncorroborated === undefined;
    case 'command':
      if (j.internal === true) {
        const d = dom(ctx);
        return d.exit === undefined && d.activeTurn === undefined && !d.inputBlocked.permission && !d.inputBlocked.dialog;
      }
      return canSubmit(c);
    case 'setMode':
      return canSubmit(c);
    case 'interrupt':
    case 'clearComposer':
    case 'permissionKeys':
    case 'wakeEnter':
    case 'dismissMenu':
      return true; // bypass kinds: only the surface gate applies
  }
}

/** Step (5): resend a held primitive or start the next job whose gates hold. */
export function runMachine(ctx: Ctx): void {
  for (let guard = 0; guard < 8; guard++) {
    const cur = currentJob(ctx);
    if (cur !== undefined) {
      if (cur.deferred !== undefined && cur.pending === undefined && !permissionHeld(dom(ctx))) {
        const prim = cur.deferred;
        if (send(ctx, cur.key, prim) && prim.kind === 'key' && prim.key === 'Enter') enterSent(ctx, cur.key);
      }
      return;
    }
    if (dom(ctx).lifecycle === 'exited') return;
    const s = inputState(ctx);
    let fifoBlocked = false;
    let started = false;
    for (const k of s.order) {
      const j = s.jobs[k];
      if (j === undefined) continue;
      const bypass = BYPASS_KINDS.has(j.kind);
      // a composer clear's Escapes would land on the dialog of a held or dialogOnly request (and deny it), dismiss another
      // dialog, or interrupt a running turn: it waits for an idle main surface showing the composer
      if (j.kind === 'clearComposer' && !clearMayStart(ctx)) continue;
      if (!bypass) {
        if (fifoBlocked) continue;
        fifoBlocked = true;
        if (!mayStart(ctx, j)) continue;
      }
      const g = surfaceGate(ctx.core);
      if (!g.open && g.exitCopyMode !== true) {
        if (g.retryAt !== undefined) arm(ctx, 'dialogSettle', 'gate', g.retryAt);
        continue;
      }
      start(ctx, k, g.exitCopyMode === true);
      started = true;
      break;
    }
    if (!started) return;
  }
}

function start(ctx: Ctx, k: InputJobKey, exitCopyFirst: boolean): void {
  const s = inputState(ctx);
  setInputState(ctx, { ...s, current: k, order: s.order.filter((x) => x !== k) });
  disarm(ctx, 'dialogSettle', 'gate');
  if (exitCopyFirst) {
    const j = jobOf(ctx, k);
    upd(ctx, k, { copyTries: (j?.copyTries ?? 0) + 1 });
    send(ctx, k, { kind: 'exitCopyMode' });
    return;
  }
  begin(ctx, k);
}

function begin(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  const t = cfg(ctx).timeouts;
  switch (j.kind) {
    case 'submit':
      if (j.attempt === 0 && j.phase === 'waitGate') {
        upd(ctx, k, { attempt: 1 });
        outcome(ctx, { kind: 'submitStarted', job: k, turn: j.turn, attempt: 1, method: j.method });
      }
      stage(ctx, k);
      return;
    case 'selftest':
    case 'command':
      stage(ctx, k);
      return;
    case 'interrupt': {
      const at = dom(ctx).activeTurn;
      const atState = at === undefined ? undefined : dom(ctx).turns[at]?.state.value;
      // also a turn held after a provisional (screen) interrupt: it already stopped, Claude is idle (ICR 0028 item 5)
      if (atState === undefined || isTurnTerminal(atState)) {
        // the turn ended (or our submit failed) while the interrupt waited behind another job: an Escape now would only
        // hit an idle composer (a draft clear, or Rewind after a clear's Esc-Esc, IN §6.2)
        publish(ctx, 'interrupt.ignored', { reason: 'notBusy' }, j.turn !== undefined ? { turnKey: j.turn } : {});
        finishJob(ctx, k);
        return;
      }
      upd(ctx, k, { phase: 'escSent' });
      send(ctx, k, key('Escape', t.escGapMs));
      arm(ctx, 'interruptConfirm', k, nowOf(ctx) + t.interruptConfirmMs);
      return;
    }
    case 'clearComposer':
      clearStep(ctx, k);
      return;
    case 'permissionKeys':
      permissionKeysSend(ctx, k, recon(ctx).lastFrame, false);
      return;
    case 'setMode': {
      const mode = footerMode(recon(ctx).lastFrame);
      if (mode !== undefined && mode === j.target) {
        if (j.resultFor !== undefined) setResult(ctx, { cmdId: j.resultFor, ok: true, value: { ok: true } });
        finishJob(ctx, k);
        return;
      }
      upd(ctx, k, { phase: 'pressed', presses: j.presses + 1 });
      send(ctx, k, key('BTab', 0));
      return;
    }
    case 'wakeEnter': {
      const f = recon(ctx).lastFrame;
      if (f?.composer !== undefined && !f.composer.empty && !f.composer.placeholderLikely) {
        failJob(ctx, k, err('E_INPUT_GATED', 'wakeEnter needs an empty composer', { reason: 'composerNotEmpty' }));
        return;
      }
      upd(ctx, k, { phase: 'sent' });
      send(ctx, k, key('Enter', t.keyGapMs));
      return;
    }
    case 'dismissMenu':
      upd(ctx, k, { phase: 'sent' });
      send(ctx, k, key('Escape', t.escGapMs));
      return;
  }
}

const isPermissionDialog = (f: ScreenFacts | undefined): boolean =>
  f !== undefined &&
  (f.surface === 'permissionDialog' ||
    f.dialog?.kind === 'permission' ||
    f.dialog?.kind === 'question' ||
    f.dialog?.kind === 'planApproval');

/**
 * A key answer is pressed only for the dialog it was chosen for, checked right before the key (ICR 0028): the record is
 * still an open dialogOnly one with no answer of ours, the frame still shows a permission dialog and, for an allow, the
 * digit is still the dialog's one exact `Yes` (SEC §4.3). A dialog not shown yet gets one fresh frame; otherwise the job
 * ends without a key, never pressing a digit or Escape onto the next dialog or the running turn.
 */
function permissionKeysSend(ctx: Ctx, k: InputJobKey, f: ScreenFacts | undefined, fresh: boolean): void {
  const j = jobOf(ctx, k);
  if (j?.kind !== 'permissionKeys') return;
  const t = cfg(ctx).timeouts;
  const rec = dom(ctx).permissions[j.permission];
  const open = rec?.state.value === 'dialogOnly' && rec.ourAnswer === undefined;
  let why: string | undefined = open ? undefined : 'recordClosed';
  if (why === undefined && screenUsable(ctx)) {
    if (!isPermissionDialog(f)) {
      if (!fresh) {
        upd(ctx, k, { phase: 'check' });
        requestFrame(ctx, k, 'permKeysCheck');
        return;
      }
      why = 'dialogNotShown';
    } else if (j.action !== 'deny') {
      const digit = j.action.digit;
      const yeses = f?.dialog?.options.filter((op) => op.label.trim() === 'Yes' && op.n !== undefined && op.n >= 1 && op.n <= 9) ?? [];
      if (yeses.length !== 1 || yeses[0]?.n !== digit) why = 'optionChanged';
    }
  } else if (why === undefined && j.action !== 'deny') why = 'screenUnavailable'; // an allow is never pressed blind
  if (why !== undefined) {
    diag(ctx, 'permission_keys_skipped', { job: k, permission: j.permission, reason: why });
    outcome(ctx, { kind: 'permissionKeysDone', permission: j.permission, action: j.action, ok: false });
    finishJob(ctx, k);
    return;
  }
  upd(ctx, k, { phase: 'sent' });
  if (j.action === 'deny') send(ctx, k, key('Escape', t.escGapMs));
  else send(ctx, k, key(String(j.action.digit) as TmuxKeyName, t.keyGapMs));
}

function editorUsable(j: InputJob): boolean {
  if (j.editorFailed === true) return false;
  if (j.kind === 'submit' || j.kind === 'selftest') return j.method === 'editor';
  return true;
}

function stage(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  if (editorUsable(j)) {
    upd(ctx, k, { phase: 'staging' });
    send(ctx, k, { kind: 'editorStage', text: textOf(j) });
    return;
  }
  upd(ctx, k, { phase: 'staging' });
  requestFrame(ctx, k, j.kind === 'command' ? 'beforeType' : 'beforePaste');
}

function editorFailure(ctx: Ctx, k: InputJobKey, step: string): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  disarm(ctx, 'editorConsume', k);
  if (j.editorFailed === true) {
    failWithStep(ctx, k, step);
    return;
  }
  diag(ctx, 'editor_fallback', { job: k, step });
  const n = drop(ctx, k, 'pending', 'waitFrame');
  if (n === undefined) return;
  const patchJ: Partial<InputJob> = { editorFailed: true };
  if (n.kind === 'submit' || n.kind === 'selftest') (patchJ as { method?: string }).method = 'pasteChunks';
  upd(ctx, k, patchJ);
  // the fallback is a second delivery attempt of the same prompt: `turn.submitting{attempt:2, method:'pasteChunks'}` (K-07)
  if (n.kind === 'submit') outcome(ctx, { kind: 'submitStarted', job: k, turn: n.turn, attempt: 2, method: 'pasteChunks' });
  stage(ctx, k);
}

function failWithStep(ctx: Ctx, k: InputJobKey, step: string, extra: Record<string, JsonValue> = {}, code?: CcdErrorCode): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  if (j.kind === 'selftest') {
    failJob(ctx, k, err('E_SELFTEST_FAILED', `self-test failed at ${step}`, { step, ...extra }));
    return;
  }
  failJob(ctx, k, err(code ?? 'E_SUBMIT_UNCONFIRMED', `input not confirmed at ${step}`, { step, ...extra }), {
    clearComposer: step === 'collapse' || step === 'verify',
  });
}

// ------------------------------------------------------------------ input.done
export function onInputDone(ctx: Ctx, obs: Extract<Observation, { kind: 'input.done' }>): void {
  const p = obs.p;
  const k = p.job ?? inputState(ctx).current;
  const j = jobOf(ctx, k);
  if (j === undefined || k === undefined) {
    diag(ctx, 'input_done_unknown_job', { intentId: p.intentId, job: p.job ?? null });
    return;
  }
  if (j.pending?.intentId !== p.intentId) {
    diag(ctx, 'input_done_stale', { intentId: p.intentId, job: k });
    return;
  }
  drop(ctx, k, 'pending');
  if (!p.ok) {
    primFailed(ctx, k, p.primitive, p.error, p.detail);
    return;
  }
  primDone(ctx, k, p.primitive, p.output);
}

function primFailed(
  ctx: Ctx,
  k: InputJobKey,
  prim: InputPrimitive['kind'],
  code: CcdErrorCode | undefined,
  detail: string | undefined,
): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  if (j.clear !== undefined) {
    if (j.clear.mode === 'editor') switchClearToKeys(ctx, k);
    else clearEnd(ctx, k, false);
    return;
  }
  if (
    (j.kind === 'submit' || j.kind === 'selftest' || j.kind === 'command') &&
    (prim === 'editorStage' || prim === 'awaitEditorConsumed' || (prim === 'key' && (j.phase === 'staging' || j.phase === 'editorOpen')))
  ) {
    editorFailure(ctx, k, 'editor');
    return;
  }
  const e = err(code ?? 'E_INPUT_GATED', `input primitive ${prim} failed${detail !== undefined ? `: ${detail}` : ''}`, { primitive: prim });
  if (j.kind === 'selftest') {
    failJob(ctx, k, err('E_SELFTEST_FAILED', e.message, { step: prim }));
    return;
  }
  failJob(ctx, k, e);
}

function primDone(ctx: Ctx, k: InputJobKey, prim: InputPrimitive['kind'], output: string | undefined): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  const t = cfg(ctx).timeouts;
  if (prim === 'exitCopyMode') {
    requestFrame(ctx, k, 'afterCopy');
    return;
  }
  if (j.clear !== undefined) {
    clearOnDone(ctx, k, prim);
    return;
  }
  switch (j.kind) {
    case 'submit':
    case 'selftest':
    case 'command': {
      if (prim === 'editorStage') {
        if (j.kind === 'submit' || j.kind === 'selftest') upd(ctx, k, { phase: 'editorOpen' });
        send(ctx, k, key('C-g', 50));
        return;
      }
      if (prim === 'key' && (j.phase === 'editorOpen' || (j.kind === 'command' && j.phase === 'staging' && j.editorFailed !== true))) {
        send(ctx, k, { kind: 'awaitEditorConsumed', timeoutMs: t.editorConsumeMs });
        arm(ctx, 'editorConsume', k, nowOf(ctx) + t.editorConsumeMs + 1000);
        return;
      }
      if (prim === 'awaitEditorConsumed') {
        disarm(ctx, 'editorConsume', k);
        if (j.kind !== 'command') upd(ctx, k, { phase: 'verifyStaged' });
        requestFrame(ctx, k, 'verifyStaged');
        return;
      }
      if (prim === 'pasteChunk') {
        const idx = (j.chunkIdx ?? 0) + 1;
        upd(ctx, k, { chunkIdx: idx });
        if (idx < (j.chunks?.length ?? 0)) {
          arm(ctx, 'keyGap', `${k}:chunk`, nowOf(ctx) + cfg(ctx).input.chunkGapMs);
          return;
        }
        upd(ctx, k, { phase: 'verifyStaged' });
        requestFrame(ctx, k, 'verifyStaged');
        return;
      }
      if (prim === 'typeLiteral') {
        requestFrame(ctx, k, 'typedVerify');
        return;
      }
      if (prim === 'captureText' && j.kind === 'command') {
        const out = output === undefined ? undefined : output.length > MODAL_OUTPUT_MAX ? output.slice(0, MODAL_OUTPUT_MAX) : output;
        const n = upd(ctx, k, { phase: 'dismissModal' });
        if (n !== undefined && out !== undefined) put(ctx, { ...n, output: out } as InputJob);
        send(ctx, k, key('Escape', t.escGapMs));
        return;
      }
      if (prim === 'key' && j.kind === 'command' && j.phase === 'dismissModal') {
        commandResult(ctx, j, 'modal', j.output);
        return;
      }
      // Enter: acks may already have arrived (phase moved on); deadlines were armed when Enter was sent.
      if (prim === 'key' && (j.phase === 'enterSent' || j.phase === 'retryEnter')) {
        if (j.kind === 'command') upd(ctx, k, { phase: 'awaitEffect' });
        else upd(ctx, k, { phase: 'awaitAck' });
      }
      return;
    }
    case 'interrupt':
      upd(ctx, k, { phase: 'confirming' });
      return;
    case 'permissionKeys':
      upd(ctx, k, { phase: 'verify' });
      requestFrame(ctx, k, 'permKeysVerify');
      return;
    case 'setMode':
      upd(ctx, k, { phase: 'verify' });
      arm(ctx, 'keyGap', `${k}:mode`, nowOf(ctx) + SETMODE_WAIT_MS);
      return;
    case 'wakeEnter':
      upd(ctx, k, { phase: 'verify' });
      arm(ctx, 'submitAck', k, nowOf(ctx) + t.submitAckMs);
      return;
    case 'dismissMenu':
      upd(ctx, k, { phase: 'verify' });
      requestFrame(ctx, k, 'menuVerify', MENU_WAIT_MS);
      return;
    case 'clearComposer':
      return;
  }
}

// ------------------------------------------------------------------ frames
/** A non-torn frame arrived: resolve the current job's frame wait and react to command effects. */
export function onFrameForJobs(ctx: Ctx, f: ScreenFacts, at: number): void {
  const j = currentJob(ctx);
  if (j === undefined) return;
  if (
    j.kind === 'command' &&
    (j.phase === 'awaitEffect' || j.phase === 'enterSent') &&
    j.pending === undefined &&
    j.deferred === undefined
  ) {
    if (f.composer?.notices.includes('unknownCommand') === true) {
      failJob(ctx, j.key, err('E_INPUT_REJECTED', `unknown command ${j.name}`, { reason: 'unknownCommand', name: j.name }));
      return;
    }
    if (selfOpenedModal(ctx, f) && j.internal !== true) {
      disarm(ctx, 'modalEffect', j.key);
      upd(ctx, j.key, { phase: 'captureModal' });
      send(
        ctx,
        j.key,
        j.capture === undefined
          ? { kind: 'captureText', rows: 'modal' }
          : { kind: 'captureText', rows: 'modal', until: j.capture.until, timeoutMs: j.capture.timeoutMs },
      );
      return;
    }
  }
  if (j.waitFrame !== undefined && at >= j.waitFrame.since) {
    const purpose = j.waitFrame.purpose;
    drop(ctx, j.key, 'waitFrame');
    disarm(ctx, 'keyGap', `${j.key}:frame`);
    frameResolved(ctx, j.key, purpose, f);
  }
}

/**
 * A modal our own keys can have opened (a command's local-jsx panel: `/context`, `/usage`, a picker; setMode's mode warning
 * after a BTab): a generic `modal`/`unknownModal` surface while no permission request is held or shown. Dialogs another actor
 * raises in the same window — the usage-limit menu, an AskUserQuestion, a plan approval, an elicitation, a
 * permission/trust/resume/gate dialog, a survey or rewind panel — are never ours: a job presses nothing on them, since an
 * Escape there dismisses the menu or declines/denies the request (§3.6 Commands and setMode, P-SCREEN-22, P-TUI-15, I6).
 */
function selfOpenedModal(ctx: Ctx, f: ScreenFacts): boolean {
  if (f.surface !== 'modal' && f.surface !== 'unknownModal') return false;
  if (f.dialog !== undefined && f.dialog.kind !== 'other') return false;
  return !permissionOpen(ctx);
}

/** A turn is running (or the footer shows Claude busy): an Escape now would interrupt it. */
function claudeBusy(ctx: Ctx): boolean {
  const d = dom(ctx);
  const t = d.activeTurn === undefined ? undefined : d.turns[d.activeTurn];
  return t?.state.value === 'running' || recon(ctx).lastFrame?.footer?.busy === true;
}

/** A clearComposer job may start: idle main surface with a composer, no permission request held or shown. */
function clearMayStart(ctx: Ctx): boolean {
  const f = recon(ctx).lastFrame;
  return f?.surface === 'main' && f.composer !== undefined && !permissionOpen(ctx) && !claudeBusy(ctx);
}

/** A permission request is held by our hook, or shown as a dialog nobody has answered yet (dialogOnly). */
function permissionOpen(ctx: Ctx): boolean {
  const d = dom(ctx);
  if (permissionHeld(d)) return true;
  return Object.values(d.permissions).some((p) => p.state.value === 'dialogOnly' && p.resolved === undefined && p.ourAnswer === undefined);
}

function composerText(f: ScreenFacts | undefined): string | undefined {
  if (f?.composer === undefined) return undefined;
  if (f.composer.empty || f.composer.placeholderLikely) return '';
  return f.composer.text;
}
const squash = (s: string): string => normalizeForAck(s).replace(/\s+/g, '');

/** §3.6 step 3: composer non-empty and (≤ 200 chars) its text ends with the last 40 normalized chars of the prompt. */
export function stagedOk(text: string, f: ScreenFacts | undefined): 'ok' | 'mismatch' | 'collapsed' | 'unknown' {
  if (f?.composer === undefined) return 'unknown';
  if (f.composer.pastedPlaceholder) return 'collapsed';
  const c = composerText(f) ?? '';
  if (c === '') return 'mismatch';
  if (Array.from(text).length > 200) return 'ok';
  const want = squash(text);
  const tail = Array.from(want).slice(-40).join('');
  return squash(c).endsWith(tail) ? 'ok' : 'mismatch';
}

function footerMode(f: ScreenFacts | undefined): PermissionMode | undefined {
  if (f?.footer === undefined) return undefined;
  return f.footer.mode ?? 'default';
}

function frameResolved(ctx: Ctx, k: InputJobKey, purpose: string, f: ScreenFacts | undefined): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  const t = cfg(ctx).timeouts;
  if (purpose.startsWith('clear:')) {
    clearOnFrame(ctx, k, purpose, f);
    return;
  }
  switch (purpose) {
    case 'afterCopy':
      if (f?.inCopyMode === true) {
        if ((j.copyTries ?? 0) >= 2) {
          failJob(ctx, k, err('E_INPUT_GATED', 'pane stays in copy mode', { reason: 'copyMode' }));
          return;
        }
        upd(ctx, k, { copyTries: (j.copyTries ?? 0) + 1 });
        send(ctx, k, { kind: 'exitCopyMode' });
        return;
      }
      begin(ctx, k);
      return;
    case 'verifyStaged': {
      const v = f?.surface === 'editorOpen' ? 'mismatch' : stagedOk(textOf(j), f); // still in the editor (LP-01): not staged
      if (v === 'ok' || v === 'unknown') {
        upd(ctx, k, { phase: 'settle' });
        arm(ctx, 'settle', k, nowOf(ctx) + t.settleMs);
        return;
      }
      if (editorUsable(j)) {
        editorFailure(ctx, k, 'verify');
        return;
      }
      failWithStep(ctx, k, v === 'collapsed' ? 'collapse' : 'verify');
      return;
    }
    case 'beforePaste':
    case 'beforeType': {
      if (f?.surface === 'editorOpen') {
        failWithStep(ctx, k, 'editor', { reason: 'editorStillOpen' });
        return;
      }
      const c = composerText(f);
      const then: ClearState['then'] = purpose === 'beforePaste' ? 'resumeSubmit' : 'typeCommand';
      if (c !== undefined && c !== '') {
        upd(ctx, k, { clear: { mode: 'keys', step: 'esc1', then } });
        clearStep(ctx, k);
        return;
      }
      if (then === 'resumeSubmit') startChunks(ctx, k);
      else typeCommand(ctx, k);
      return;
    }
    case 'typedVerify': {
      const c = composerText(f);
      if (c === undefined || squash(c) === squash(textOf(j))) {
        upd(ctx, k, { phase: 'settle' });
        arm(ctx, 'settle', k, nowOf(ctx) + t.settleMs);
        return;
      }
      failJob(ctx, k, err('E_SUBMIT_UNCONFIRMED', 'typed command not shown in the composer', { step: 'typed' }), { clearComposer: true });
      return;
    }
    case 'ackCheck':
      ackCheck(ctx, k, f);
      return;
    case 'restore': {
      const c = composerText(f);
      if (c === '') {
        selftestDisarm(ctx, k);
        return;
      }
      upd(ctx, k, {
        phase: 'clearing',
        clear: editorUsable(j)
          ? { mode: 'editor', step: 'stage', then: 'selftestDisarm' }
          : { mode: 'keys', step: 'esc1', then: 'selftestDisarm' },
      });
      clearStep(ctx, k);
      return;
    }
    case 'permKeysCheck':
      permissionKeysSend(ctx, k, f, true);
      return;
    case 'permKeysVerify': {
      if (j.kind !== 'permissionKeys') return;
      const gone =
        f === undefined ||
        (f.surface !== 'permissionDialog' &&
          f.dialog?.kind !== 'permission' &&
          f.dialog?.kind !== 'question' &&
          f.dialog?.kind !== 'planApproval');
      if (gone) {
        outcome(ctx, { kind: 'permissionKeysDone', permission: j.permission, action: j.action, ok: true });
        finishJob(ctx, k);
      } else {
        failJob(ctx, k, err('E_PERMISSION_INVALID', 'permission dialog still shown after keys', { reason: 'dialogStillShown' }));
      }
      return;
    }
    case 'modeVerify': {
      if (j.kind !== 'setMode') return;
      const m = footerMode(f);
      if (m !== undefined && m === j.target) {
        if (j.resultFor !== undefined) setResult(ctx, { cmdId: j.resultFor, ok: true, value: { ok: true } });
        finishJob(ctx, k);
        return;
      }
      if (f !== undefined && (f.surface !== 'main' || permissionOpen(ctx))) {
        // only the dialog a BTab opened (the mode-entry warning) is dismissed; a permission / question / plan-approval /
        // elicitation dialog that a background agent raised meanwhile gets no key (Escape would deny or decline it)
        if (f.surface !== 'main' && selfOpenedModal(ctx, f)) send(ctx, k, key('Escape', t.escGapMs));
        failJob(
          ctx,
          k,
          err('E_MODE_FORBIDDEN', 'a dialog appeared while cycling the permission mode', { reason: 'dialog', surface: f.surface }),
        );
        return;
      }
      if (j.presses >= SETMODE_MAX_PRESSES) {
        failJob(ctx, k, err('E_INPUT_INVALID', `permission mode ${j.target} not reached`, { reason: 'modeNotReached', target: j.target }));
        return;
      }
      upd(ctx, k, { phase: 'pressed', presses: j.presses + 1 });
      send(ctx, k, key('BTab', 0));
      return;
    }
    case 'menuVerify':
      if (f?.surface !== 'usageLimitMenu') {
        outcome(ctx, { kind: 'menuDismissed', ok: true });
        finishJob(ctx, k);
      } else {
        failJob(ctx, k, err('E_USAGE_LIMIT', 'usage-limit menu not dismissed', { reason: 'menuNotDismissed' }));
      }
      return;
    default:
      diag(ctx, 'frame_wait_unknown_purpose', { job: k, purpose });
  }
}

function startChunks(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  const chunks = chunkForPaste(textOf(j), cfg(ctx).input.chunkBytes);
  upd(ctx, k, { chunks, chunkIdx: 0, phase: 'staging' });
  const first = chunks[0];
  if (first === undefined) {
    failWithStep(ctx, k, 'paste', { reason: 'empty' });
    return;
  }
  send(ctx, k, { kind: 'pasteChunk', text: first, bracketed: true });
}

function nextChunk(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  const c = j?.chunks?.[j.chunkIdx ?? 0];
  if (j === undefined || c === undefined) return;
  send(ctx, k, { kind: 'pasteChunk', text: c, bracketed: true });
}

function typeCommand(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  const line = textOf(j);
  if (line.includes('\n') || utf8Bytes(line) > 200) {
    failJob(ctx, k, err('E_SUBMIT_UNCONFIRMED', 'command too long for the typed fallback', { step: 'typed' }));
    return;
  }
  send(ctx, k, { kind: 'typeLiteral', text: line });
}

function sendEnter(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  upd(ctx, k, { phase: 'enterSent' });
  // an Enter held back by the I6 guard is not out: its ack / effect deadline starts when runMachine re-sends it (ICR 0028)
  if (send(ctx, k, key('Enter', cfg(ctx).timeouts.keyGapMs))) enterSent(ctx, k);
}

/** The Enter of a submit / selftest / command really went out (now, or re-sent after an I6 hold): arm its deadline. */
function enterSent(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j === undefined) return;
  const t = cfg(ctx).timeouts;
  if (j.kind === 'command' && j.phase === 'enterSent') {
    upd(ctx, k, { enterAt: nowOf(ctx) });
    const ms = j.internal === true ? Math.max(t.submitAckMs, 5000) : j.name === '/compact' ? 300_000 : 5000;
    arm(ctx, 'modalEffect', k, nowOf(ctx) + ms);
    return;
  }
  if (j.kind !== 'submit' && j.kind !== 'selftest') return;
  if (j.phase === 'retryEnter') {
    arm(ctx, 'submitAck', k, nowOf(ctx) + t.submitAckMs);
    return;
  }
  if (j.phase !== 'enterSent') return;
  const gen = dom(ctx).claude.currentGen;
  const s = inputState(ctx);
  let extra = 0;
  if (gen !== undefined && s.firstPromptSentInGen[gen] !== true) {
    extra = t.submitAckFirstExtraMs;
    setInputState(ctx, { ...s, firstPromptSentInGen: { ...s.firstPromptSentInGen, [gen]: true } });
  } else if (gen === undefined) extra = t.submitAckFirstExtraMs;
  const staleBlock = recon(ctx).lastFrame?.composer?.notices.includes('blockedByHook') === true;
  upd(ctx, k, { enterAt: nowOf(ctx), blockNoticeAtEnter: staleBlock });
  arm(ctx, 'submitAck', k, nowOf(ctx) + t.submitAckMs + extra);
}

// ------------------------------------------------------------------ ack handling (called by decide/turns)
/** The submit/selftest job whose Enter is out and whose ack is awaited (§3.6 step 5). */
export function inflightSubmit(ctx: Ctx): InputJobOf<'submit'> | InputJobOf<'selftest'> | undefined {
  const j = currentJob(ctx);
  if (j === undefined) return undefined;
  if (j.kind !== 'submit' && j.kind !== 'selftest') return undefined;
  if (j.phase === 'enterSent' || j.phase === 'awaitAck' || j.phase === 'retryEnter') return j;
  return undefined;
}

/** Our submit was acked (match, mismatch or merge): the job is done. */
export function submitAcked(ctx: Ctx, k: InputJobKey): void {
  disarm(ctx, 'submitAck', k);
  disarm(ctx, 'hookGap', `job:${k}`);
  finishJob(ctx, k);
}

/** §3.6 step 5.2: an external-shape UPS while ours is in flight extends our ack deadline once. */
export function extendAck(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j === undefined || j.ackExtended === true) return;
  upd(ctx, k, { ackExtended: true });
  arm(ctx, 'submitAck', k, nowOf(ctx) + cfg(ctx).timeouts.submitAckMs);
}

/** Self-test nonce ack (§3.1 step 15): no Turn; check the composer got the prompt back, clear it, disarm. */
export function selftestAcked(ctx: Ctx): boolean {
  const j = inflightSubmit(ctx);
  if (j?.kind !== 'selftest') return false;
  disarm(ctx, 'submitAck', j.key);
  upd(ctx, j.key, { phase: 'restoreCheck' });
  requestFrame(ctx, j.key, 'restore');
  return true;
}

export function noteSelftestBlocked(ctx: Ctx): void {
  const j = currentJob(ctx);
  if (j?.kind === 'selftest') upd(ctx, j.key, { blockedSeen: true });
}

function selftestDisarm(ctx: Ctx, k: InputJobKey): void {
  upd(ctx, k, { disarming: true, phase: 'clearing' });
  emit<'hook.disarmSelfTest'>(ctx, { kind: 'hook.disarmSelfTest' });
  arm(ctx, 'editorConsume', `${k}:disarm`, nowOf(ctx) + DISARM_WAIT_MS);
}

/** hook.selfTestArmed{armed:false}: the self-test passed. */
export function selftestDisarmed(ctx: Ctx): boolean {
  const j = currentJob(ctx);
  if (j?.kind !== 'selftest' || j.disarming !== true) return false;
  outcome(ctx, { kind: 'selftestPassed' });
  finishJob(ctx, j.key);
  return true;
}

function ackCheck(ctx: Ctx, k: InputJobKey, f: ScreenFacts | undefined): void {
  const j = jobOf(ctx, k);
  if (j === undefined || (j.kind !== 'submit' && j.kind !== 'selftest')) return;
  const t = cfg(ctx).timeouts;
  const notices = f?.composer?.notices ?? [];
  if (notices.includes('invisibleChars')) {
    if (j.kind === 'selftest') failWithStep(ctx, k, 'ack', { reason: 'invisible' });
    else failJob(ctx, k, err('E_INPUT_INVALID', 'Claude refused invisible characters', { reason: 'invisible' }), { clearComposer: true });
    return;
  }
  if (notices.includes('unknownCommand')) {
    if (j.kind === 'selftest') failWithStep(ctx, k, 'ack', { reason: 'slash' });
    else failJob(ctx, k, err('E_INPUT_REJECTED', 'prompt parsed as an unknown command', { reason: 'slash' }), { clearComposer: true });
    return;
  }
  // only a notice that appeared after our Enter is ours (a lost Enter leaves the old screen, incl. an earlier block notice)
  if (notices.includes('blockedByHook') && j.kind === 'submit' && j.blockNoticeAtEnter !== true) {
    failJob(ctx, k, err('E_TURN_BLOCKED_BY_HOOK', 'a UserPromptSubmit hook blocked the prompt', { source: 'screen' }), {
      clearComposer: true,
    });
    return;
  }
  const c = composerText(f);
  const retries = j.retries ?? 0;
  if (c !== undefined && c !== '' && stagedOk(textOf(j), f) === 'ok' && retries < t.submitRetries) {
    upd(ctx, k, { phase: 'retryEnter', retries: retries + 1 });
    if (send(ctx, k, key('Enter', t.keyGapMs))) enterSent(ctx, k);
    return;
  }
  if (j.kind === 'selftest') {
    failWithStep(ctx, k, 'ack', { attempts: retries + 1 });
    return;
  }
  if (c === undefined || c === '') {
    // composer empty: the prompt left the box; accept on transcript evidence within hookGapMs (§3.6 step 6)
    const rec = Object.entries(recon(ctx).pendingRecorded).find(([, r]) => normalizeForAck(r.text) === normalizeForAck(j.text));
    if (rec !== undefined) {
      const o: JobOutcome = { kind: 'submitAcceptedByTranscript', job: k, turn: j.turn };
      if (rec[1].promptId !== undefined) o.promptId = rec[1].promptId;
      updRecon(ctx, (r) => {
        const { [rec[0]]: _gone, ...rest } = r.pendingRecorded;
        return { ...r, pendingRecorded: rest };
      });
      outcome(ctx, o);
      submitAcked(ctx, k);
      return;
    }
    upd(ctx, k, { awaitTranscript: true, phase: 'awaitAck' });
    arm(ctx, 'hookGap', `job:${k}`, nowOf(ctx) + t.hookGapMs);
    return;
  }
  failJob(
    ctx,
    k,
    err('E_SUBMIT_UNCONFIRMED', 'no UserPromptSubmit ack', { attempts: retries + 1, screenSummary: Array.from(c).slice(0, 80).join('') }),
    {
      clearComposer: true,
    },
  );
}

/** transcript prompt.recorded matching our in-flight text while waiting for it (composer emptied, no UPS). */
export function transcriptAck(ctx: Ctx, text: string, promptId: string | undefined): boolean {
  const j = currentJob(ctx);
  if (j?.kind !== 'submit') return false;
  // Accept from the transcript at once when the deadline already asked for it, or when Claude reported that the
  // UserPromptSubmit hook failed (ECONNREFUSED attachment): that UPS will never come, and waiting for the ack deadline
  // would drop the turn's own early transcript evidence (turn_duration) on the floor (K-20). ICR 0016.
  const upsHookFailed =
    (j.phase === 'enterSent' || j.phase === 'awaitAck' || j.phase === 'retryEnter') &&
    dom(ctx).channels.hooks.reasons.includes('hookError:UserPromptSubmit');
  if (j.awaitTranscript !== true && !upsHookFailed) return false;
  if (normalizeForAck(text) !== normalizeForAck(j.text)) return false;
  const o: JobOutcome = { kind: 'submitAcceptedByTranscript', job: j.key, turn: j.turn };
  if (promptId !== undefined) o.promptId = promptId;
  outcome(ctx, o);
  submitAcked(ctx, j.key);
  return true;
}

/** transcript `prompt.blocked` (ICR 0002) for our in-flight text: a user UPS hook blocked it. */
export function promptBlocked(ctx: Ctx, text: string): boolean {
  const j = currentJob(ctx);
  if (j?.kind !== 'submit') return false;
  if (normalizeForAck(text) !== normalizeForAck(j.text)) return false;
  failJob(ctx, j.key, err('E_TURN_BLOCKED_BY_HOOK', 'a UserPromptSubmit hook blocked the prompt', { source: 'transcript' }), {
    clearComposer: true,
  });
  return true;
}

// ------------------------------------------------------------------ command evidence (called by decide/*)
export type CommandEvidence =
  | { kind: 'sessionEnd'; reason: string }
  | { kind: 'sessionStart'; source: string }
  | { kind: 'compactDone' }
  | { kind: 'modelSwitched' }
  | { kind: 'localCommand'; name: string; stdout?: string | undefined };

const bare = (n: string): string => n.replace(/^\//, '').toLowerCase();

export function commandEvidence(ctx: Ctx, ev: CommandEvidence): boolean {
  const j = currentJob(ctx);
  if (j?.kind !== 'command') return false;
  if (j.phase !== 'enterSent' && j.phase !== 'awaitEffect') return false;
  const name = j.name;
  if (name === '/clear') {
    if (ev.kind === 'sessionEnd' && ev.reason === 'clear') {
      upd(ctx, j.key, { evidence: { sawEnd: true } });
      return true;
    }
    if (ev.kind === 'sessionStart' && ev.source === 'clear') {
      commandResult(ctx, j, 'evidence');
      return true;
    }
    if (ev.kind === 'localCommand' && bare(ev.name) === 'clear') return true;
    return false;
  }
  if (name === '/compact') {
    if (ev.kind === 'compactDone' || (ev.kind === 'sessionStart' && ev.source === 'compact')) {
      commandResult(ctx, j, 'evidence');
      return true;
    }
    return false;
  }
  if (name === '/model' && ev.kind === 'modelSwitched') {
    commandResult(ctx, j, 'evidence');
    return true;
  }
  if (ev.kind === 'localCommand' && bare(ev.name) === bare(name)) {
    commandResult(ctx, j, 'evidence', ev.stdout);
    return true;
  }
  return false;
}

/** Evidence that an interrupt landed (transcript marker, Stop, banner claim, withdrawn): the interrupt job ends. */
export function interruptEvidence(ctx: Ctx): void {
  const s = inputState(ctx);
  for (const k of [s.current, ...s.order]) {
    const j = jobOf(ctx, k);
    if (j?.kind !== 'interrupt') continue;
    if (k === s.current) finishJob(ctx, j.key);
    else cancelQueuedJob(ctx, j.key);
  }
}

/**
 * A PermissionRequest arrived for `turn` while an interrupt job of that turn exists (live smoke, docs/research/
 * live-results.md F-1): the interrupt was asked between PreToolUse and PermissionRequest, so its Escape was held back by the
 * I6 guard and would be released the moment the request is answered — onto the native dialog Claude still shows, where
 * it rejects the tool as the user. The caller answers the request deny{interrupt:true} through the hook instead; here an
 * Escape that has not been emitted yet is withdrawn (a queued job, or the current one deferred / still leaving copy mode).
 * An Escape already sent stays, and its job keeps waiting for the interrupt evidence. Returns whether such a job existed.
 */
export function takeInterruptFor(ctx: Ctx, turn: TurnKey): boolean {
  const s = inputState(ctx);
  let found = false;
  for (const k of [s.current, ...s.order]) {
    const j = jobOf(ctx, k);
    if (j?.kind !== 'interrupt' || (j.turn !== undefined && j.turn !== turn)) continue;
    found = true;
    if (k !== s.current) cancelQueuedJob(ctx, j.key);
    else if (j.phase === 'escSent' && (j.pending === undefined || j.pending.primitive === 'exitCopyMode')) removeJob(ctx, j.key);
  }
  return found;
}

/** Hook `permission_mode` confirms a setMode job (§3.6 setMode). */
export function modeObserved(ctx: Ctx, mode: PermissionMode): void {
  const j = currentJob(ctx);
  if (j?.kind !== 'setMode' || j.target !== mode) return;
  if (j.resultFor !== undefined) setResult(ctx, { cmdId: j.resultFor, ok: true, value: { ok: true } });
  finishJob(ctx, j.key);
}

/** A UPS or quota_auto_resume_fired verifies a wakeEnter (§3.6 wakeEnter). */
export function wakeVerified(ctx: Ctx): void {
  const j = currentJob(ctx);
  if (j?.kind !== 'wakeEnter') return;
  outcome(ctx, { kind: 'wakeDone', ok: true });
  finishJob(ctx, j.key);
}

/** Process exit / close: every job ends; nothing is sent any more. */
export function abortAllJobs(ctx: Ctx, reason: string): void {
  const s = inputState(ctx);
  const keys = [...(s.current !== undefined ? [s.current] : []), ...s.order];
  for (const k of keys) {
    const j = jobOf(ctx, k);
    if (j === undefined) continue;
    const e = err(reason === 'exit' ? 'E_SESSION_EXITED' : 'E_SESSION_CLOSED', `input job aborted (${reason})`);
    if (j.kind === 'command' && j.internal !== true) setResult(ctx, { cmdId: j.cmdId, ok: false, error: e });
    else if (j.kind === 'setMode' && j.resultFor !== undefined) setResult(ctx, { cmdId: j.resultFor, ok: false, error: e });
    else if (j.kind === 'submit') outcome(ctx, { kind: 'submitFailed', job: k, turn: j.turn, error: e, clearComposer: false });
    removeJob(ctx, k);
  }
}

// ------------------------------------------------------------------ deadlines
const JOB_KINDS: ReadonlySet<DeadlineKind> = new Set([
  'keyGap',
  'settle',
  'submitAck',
  'hookGap',
  'editorConsume',
  'interruptConfirm',
  'modalEffect',
  'dialogSettle',
]);

export function onJobDeadline(ctx: Ctx, kind: DeadlineKind, ref: string): boolean {
  if (!JOB_KINDS.has(kind)) return false;
  if (kind === 'dialogSettle') return ref === 'gate';
  const raw = ref.startsWith('job:') ? ref.slice(4) : ref;
  const m = /^(j\d+)(?::(.*))?$/.exec(raw);
  if (m === null) return false;
  const k = (m[1] ?? '') as InputJobKey;
  const sub = m[2];
  const j = jobOf(ctx, k);
  if (j === undefined) return true; // stale deadline of a finished job
  // a primitive held back by the I6 guard: its ack / effect clock is re-armed when it goes out (ICR 0028)
  if ((kind === 'submitAck' || kind === 'modalEffect') && j.deferred !== undefined) return true;
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- kinds outside JOB_KINDS returned above
  switch (kind) {
    case 'keyGap':
      if (sub === 'frame' && j.waitFrame !== undefined) {
        const purpose = j.waitFrame.purpose;
        drop(ctx, k, 'waitFrame');
        frameResolved(ctx, k, purpose, recon(ctx).lastFrame);
      } else if (sub === 'chunk') nextChunk(ctx, k);
      else if (sub === 'mode') requestFrame(ctx, k, 'modeVerify');
      return true;
    case 'settle':
      if (j.phase === 'settle') sendEnter(ctx, k);
      return true;
    case 'submitAck':
      if (j.kind === 'wakeEnter') {
        publish(ctx, 'warning', { code: 'E_USAGE_LIMIT', message: 'wake Enter not confirmed', detail: { reason: 'wakeUnconfirmed' } });
        failJob(ctx, k, err('E_USAGE_LIMIT', 'wake Enter not confirmed', { reason: 'wakeUnconfirmed' }));
      } else if (j.kind === 'submit' || j.kind === 'selftest') requestFrame(ctx, k, 'ackCheck');
      return true;
    case 'hookGap':
      if (j.kind === 'submit' && j.awaitTranscript === true) {
        failJob(
          ctx,
          k,
          err('E_SUBMIT_UNCONFIRMED', 'no UserPromptSubmit ack and no transcript entry', { attempts: (j.retries ?? 0) + 1, step: 'ack' }),
        );
      }
      return true;
    case 'editorConsume':
      if (sub === 'disarm') {
        if (j.kind === 'selftest' && j.disarming === true) failWithStep(ctx, k, 'disarm');
        return true;
      }
      if (j.pending?.primitive === 'awaitEditorConsumed' || j.phase === 'editorOpen' || j.phase === 'staging') {
        drop(ctx, k, 'pending');
        if (j.clear !== undefined) switchClearToKeys(ctx, k);
        else editorFailure(ctx, k, 'editor');
      }
      return true;
    case 'interruptConfirm':
      if (j.kind === 'interrupt') {
        publish(ctx, 'interrupt.ignored', { reason: 'noEvidence' }, j.turn !== undefined ? { turnKey: j.turn } : {});
        finishJob(ctx, k);
      }
      return true;
    case 'modalEffect':
      if (j.kind === 'command' && (j.phase === 'awaitEffect' || j.phase === 'enterSent')) commandResult(ctx, j, 'none');
      return true;
    default:
      return false;
  }
}

// ------------------------------------------------------------------ composer clear sub-sequence (§3.6 clearComposer)
function setClear(ctx: Ctx, k: InputJobKey, c: ClearState): void {
  const j = upd(ctx, k, { clear: c });
  if (j?.kind === 'clearComposer') {
    const phase =
      c.step === 'stage' || c.step === 'cg' || c.step === 'await'
        ? 'editorClear'
        : c.step === 'esc1'
          ? 'esc1'
          : c.step === 'hint'
            ? 'awaitHint'
            : c.step === 'esc2'
              ? 'esc2'
              : 'verify';
    upd(ctx, k, { phase });
  }
}

function clearStep(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  const c = j?.clear;
  if (j === undefined || c === undefined) return;
  const t = cfg(ctx).timeouts;
  if (c.mode === 'editor') {
    setClear(ctx, k, { ...c, step: 'stage' });
    send(ctx, k, { kind: 'editorStage', text: '' });
    return;
  }
  // keys: never Escape an empty composer (double Esc on an empty box opens Rewind, IN §6.2)
  const f = recon(ctx).lastFrame;
  const ct = composerText(f);
  if (ct === '') {
    clearEnd(ctx, k, true);
    return;
  }
  // …nor anything but a visible composer on an idle main surface: Escape on a dialog denies / dismisses it, and Escape
  // while Claude works interrupts the turn (and flushes its queue, IN §6.2)
  if (ct === undefined || f?.surface !== 'main' || permissionOpen(ctx) || claudeBusy(ctx)) {
    diag(ctx, 'clear_skipped', { job: k, surface: f?.surface ?? null });
    clearEnd(ctx, k, false);
    return;
  }
  setClear(ctx, k, { ...c, step: 'esc1' });
  send(ctx, k, key('Escape', Math.max(300, t.escGapMs)));
}

function switchClearToKeys(ctx: Ctx, k: InputJobKey): void {
  const j = jobOf(ctx, k);
  if (j?.clear === undefined) return;
  disarm(ctx, 'editorConsume', k);
  setClear(ctx, k, { ...j.clear, mode: 'keys', step: 'esc1' });
  requestFrame(ctx, k, 'clear:pre');
}

function clearOnDone(ctx: Ctx, k: InputJobKey, prim: InputPrimitive['kind']): void {
  const j = jobOf(ctx, k);
  const c = j?.clear;
  if (j === undefined || c === undefined) return;
  const t = cfg(ctx).timeouts;
  switch (c.step) {
    case 'stage':
      setClear(ctx, k, { ...c, step: 'cg' });
      send(ctx, k, key('C-g', 50));
      return;
    case 'cg':
      setClear(ctx, k, { ...c, step: 'await' });
      send(ctx, k, { kind: 'awaitEditorConsumed', timeoutMs: t.editorConsumeMs });
      arm(ctx, 'editorConsume', k, nowOf(ctx) + t.editorConsumeMs + 1000);
      return;
    case 'await':
      disarm(ctx, 'editorConsume', k);
      setClear(ctx, k, { ...c, step: 'verify' });
      requestFrame(ctx, k, 'clear:verify');
      return;
    case 'esc1':
      requestFrame(ctx, k, 'clear:hint');
      return;
    case 'esc2':
      setClear(ctx, k, { ...c, step: 'final' });
      requestFrame(ctx, k, 'clear:final');
      return;
    case 'verify':
    case 'hint':
    case 'final':
      diag(ctx, 'clear_unexpected_done', { job: k, step: c.step, prim });
  }
}

function clearOnFrame(ctx: Ctx, k: InputJobKey, purpose: string, f: ScreenFacts | undefined): void {
  const j = jobOf(ctx, k);
  const c = j?.clear;
  if (j === undefined || c === undefined) return;
  const ct = composerText(f);
  switch (purpose) {
    case 'clear:pre':
      clearStep(ctx, k);
      return;
    case 'clear:verify':
      if (ct === '' || ct === undefined) clearEnd(ctx, k, true);
      else switchClearToKeys(ctx, k);
      return;
    case 'clear:hint':
      if (ct === '' || ct === undefined) {
        clearEnd(ctx, k, true);
        return;
      }
      if (f?.composer?.notices.includes('escAgainToClear') === true) {
        setClear(ctx, k, { ...c, step: 'esc2' });
        send(ctx, k, key('Escape', Math.max(300, cfg(ctx).timeouts.escGapMs)));
        return;
      }
      clearEnd(ctx, k, false);
      return;
    case 'clear:final':
      clearEnd(ctx, k, ct === '' || ct === undefined);
      return;
    default:
      diag(ctx, 'clear_unexpected_frame', { job: k, purpose });
  }
}

function clearEnd(ctx: Ctx, k: InputJobKey, ok: boolean): void {
  const j = jobOf(ctx, k);
  const c = j?.clear;
  if (j === undefined || c === undefined) return;
  drop(ctx, k, 'clear');
  switch (c.then) {
    case 'finish':
      if (ok) finishJob(ctx, k);
      else failJob(ctx, k, err('E_INPUT_GATED', 'composer could not be cleared', { reason: 'clearFailed' }));
      return;
    case 'resumeSubmit':
      if (ok) startChunks(ctx, k);
      else failWithStep(ctx, k, 'clear');
      return;
    case 'typeCommand':
      if (ok) typeCommand(ctx, k);
      else failWithStep(ctx, k, 'clear');
      return;
    case 'selftestDisarm':
      if (ok) selftestDisarm(ctx, k);
      else failWithStep(ctx, k, 'clear');
      return;
  }
}
