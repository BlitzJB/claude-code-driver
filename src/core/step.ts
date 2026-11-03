// core/step.ts — step(core, input) → {core, events, intents, diagnostics}: the only entry point of the pure core
// (DESIGN.md §2.9, D-03). Total, synchronous, deterministic. Order (RC §10.2): (1) advance time; (2) fire due deadlines in
// (at, id) order; (3) apply the input via decide/*; (4) closing rules; (5) the input-policy machine; (6) derived status;
// (7) poll.cadence / auth.poll; (8) diagnostics.

import type { JsonValue } from '../model/json.js';
import type { Observation } from '../model/observation.js';
import type { AgentStatus } from '../model/state.js';
import type { MonoMs, WallMs } from '../model/time.js';
import { onClaimDeadline } from './claims.js';
import { closeProcess, onDrainDeadline, runClosing } from './closing.js';
import { apply, arm, cfg, diag, dom, emit, newCtx, nowOf, patch, publish, recon, setInputBlocked, setInputState, updRecon } from './ctx.js';
import type { Ctx } from './ctx.js';
import {
  onAgentFileMissing,
  onAgentMeta,
  onAgentStarted,
  onAgentStopped,
  onBgTaskStatus,
  linkAgentFromTool,
  upsertBgTasks,
} from './decide/agents.js';
import { addReason, onChannelHealth, onHookChannelError, onHookSeen } from './decide/channels.js';
import { handleCommand } from './decide/commands.js';
import { mainTurn, toolRec } from './decide/entities.js';
import { onInputRequestCleared, onInputRequested, onModalDeadline } from './decide/inputs-requested.js';
import { onMessageBlock, onRefusalFallback, onRefused, onTextDelta } from './decide/messages.js';
import { onRequestStarted } from './decide/model-calls.js';
import {
  onAdoptDeadline,
  onAutoDenied,
  onBindLateDeadline,
  onDecisionRecorded,
  onHookClosed,
  onHookResponded,
  onPathsResolved,
  onPermissionKeysDone,
  onPermissionRequested,
  onPolicyDeadline,
  onToolOutcome,
  retryDialogAdoption,
  tryLateBind,
} from './decide/permissions.js';
import {
  applyClaimEffects,
  checkPendingClose,
  onAuthStatus,
  onCloseExitFailed,
  onContinuedIn,
  onDurationForDrain,
  onFrame,
  onGenImplicitConfirm,
  onHookSessionId,
  onHostResumed,
  onHumanEditorDeadline,
  onIdentityMismatch,
  onLoopLag,
  onModeObserved,
  onModelSwitched,
  onProcessExited,
  onSessionSuspended,
  onProcessLaunched,
  onReadyStable,
  onRegistry,
  onRelocated,
  onSelfTestArmed,
  onSelfTestFailed,
  onSelfTestPassed,
  onSessionEnded,
  onSessionStarted,
  onStartupHookGrace,
  onStartupTimeout,
  onStopForDrain,
  authRequired,
} from './decide/session.js';
import {
  isAgentSpawnResponse,
  onToolBatch,
  onToolFailed,
  onToolPost,
  onToolPre,
  onToolResult,
  onToolUseBlock,
  onToolValidationError,
  toolResultState,
} from './decide/tools.js';
import {
  isNonce,
  noteMainActivity,
  onApiErrorRecorded,
  onPromptAbsorbed,
  onPromptBlocked,
  onPromptRecorded,
  onPromptSubmitted,
  onPromptWithdrawn,
  onRecordedGap,
  onStopGraceDeadline,
  onSubmitAcceptedByTranscript,
  onSubmitFailed,
  onSubmitStarted,
  onTranscriptSettle,
  onTurnDuration,
  onTurnFailed,
  onTurnInterruptConfirmDeadline,
  onTurnInterrupted,
  onTurnStopped,
  stopFailureError,
} from './decide/turns.js';
import {
  LIMIT_SETTLE_REF,
  markLimited,
  onLimitSettle,
  onMenuDismissed,
  onPromptAcceptedForUsage,
  onQuotaNotification,
  onUsageWake,
  onWakeDone,
  onWakeTurnUndelivered,
} from './decide/usage.js';
import { closeOpenReplayTurn, onReplayObservation } from './decide/history.js';
import { dueDeadlines } from './deadlines.js';
import { clearDeadline } from './deadlines.js';
import type { Deadline } from './facts.js';
import { computeInputBlocked, sameBlocked } from './input-policy/gating.js';
import { commandEvidence, onInputDone, onJobDeadline, runMachine } from './input-policy/machine.js';
import { onLivenessDeadline, onNetTunnel } from './reconcile/net-correlate.js';
import { awaitedNotifications } from './selectors.js';
import { deriveStatus } from './status/derive.js';
import type { CoreInput, CoreState, DetailedStepResult, StepResult } from './types.js';

// §2.9: core/step.ts is the home of the L2 contract. The types live in the leaf module types.ts (so decide/* can name
// them without an import cycle through this file) and are re-exported here together with initialCore / nextDeadline,
// so L3 imports the whole contract from one module.
export type { CoreInit } from '../model/config.js';
export type { Diagnostic } from '../model/debug.js';
export type { CoreInput, CoreState, Counters, NextDeadline, ReconState, StepResult } from './types.js';
export { initialCore } from './init.js';
export { nextDeadline } from './deadlines.js';

const SEEN_UUID_CAP = 65536;
const MAX_DEADLINE_FIRES = 512;

// ------------------------------------------------------------------ (2) deadlines
function fireDeadline(ctx: Ctx, d: Deadline): void {
  switch (d.kind) {
    case 'startupHookGrace':
      onStartupHookGrace(ctx);
      return;
    case 'startup':
      onStartupTimeout(ctx);
      return;
    case 'readyStable':
      onReadyStable(ctx);
      return;
    case 'stopGrace':
      onStopGraceDeadline(ctx, d.ref);
      return;
    case 'transcriptSettle':
      if (d.ref === LIMIT_SETTLE_REF) onLimitSettle(ctx);
      else onTranscriptSettle(ctx, d.ref);
      return;
    case 'permBindLate':
      onBindLateDeadline(ctx, d.ref);
      return;
    case 'permissionPolicy':
      onPolicyDeadline(ctx, d.ref as never);
      return;
    case 'adoptDialog':
      if (d.ref === 'dialog') onAdoptDeadline(ctx);
      else if (d.ref.startsWith('input:')) onModalDeadline(ctx, d.ref.slice('input:'.length));
      return;
    case 'stall':
    case 'quiet':
      onLivenessDeadline(ctx, d.kind, d.ref);
      return;
    case 'claimTtl':
      applyClaimEffects(ctx, onClaimDeadline(ctx, d.ref));
      return;
    case 'genImplicitConfirm':
      onGenImplicitConfirm(ctx, d.ref);
      return;
    case 'drain':
      if (d.ref === 'close') checkPendingClose(ctx, true);
      else onDrainDeadline(ctx, d.ref);
      return;
    case 'usageWake':
      onUsageWake(ctx);
      return;
    case 'interruptedHold':
    case 'hostResumeGrace':
    case 'lateText':
    case 'escGap':
      return; // only forces a step: status / gates are recomputed after every input
    case 'hookGap':
      if (onJobDeadline(ctx, d.kind, d.ref)) return;
      if (d.ref.startsWith('ups:')) onRecordedGap(ctx, d.ref.slice(4));
      else if (d.ref.startsWith('tool:')) {
        const t = toolRec(ctx, d.ref.slice(5) as never);
        if (t?.state.value === 'proposed') addReason(ctx, 'hooks', 'hookGap:PreToolUse');
      }
      return;
    case 'interruptConfirm':
      if (onJobDeadline(ctx, d.kind, d.ref)) return;
      if (d.ref.startsWith('turn:')) onTurnInterruptConfirmDeadline(ctx, d.ref.slice(5) as never);
      return;
    case 'editorConsume':
      if (onJobDeadline(ctx, d.kind, d.ref)) return;
      if (d.ref === 'human') onHumanEditorDeadline(ctx);
      return;
    case 'settle':
    case 'submitAck':
    case 'keyGap':
    case 'modalEffect':
    case 'dialogSettle':
      onJobDeadline(ctx, d.kind, d.ref);
      return;
  }
}

function fireDue(ctx: Ctx): void {
  for (let i = 0; i < MAX_DEADLINE_FIRES; i++) {
    const due = dueDeadlines(recon(ctx), ctx.core.now, ctx.core.wallNow);
    const d = due[0];
    if (d === undefined) return;
    updRecon(ctx, (r) => clearDeadline(r, d.kind, d.ref));
    ctx.firing = d;
    fireDeadline(ctx, d);
    delete ctx.firing;
  }
  diag(ctx, 'deadline_storm', { limit: MAX_DEADLINE_FIRES });
}

// ------------------------------------------------------------------ (3) observations
/** D-42: transcript chain entries are de-duplicated by uuid per generation only. */
function seenBefore(ctx: Ctx, o: Observation): boolean {
  if (o.meta.source !== 'transcript' || o.meta.uuid === undefined) return false;
  const gen =
    (o.meta.claudeSessionId !== undefined ? recon(ctx).aliases.sessionId[o.meta.claudeSessionId] : undefined) ??
    dom(ctx).claude.currentGen ??
    'g0';
  const key = `${gen}|${o.meta.uuid}`;
  const s = recon(ctx).seenUuids;
  if (s.set[key] === true) return true;
  updRecon(ctx, (r) => {
    const ring = [...r.seenUuids.ring, key];
    const set = { ...r.seenUuids.set, [key]: true as const };
    while (ring.length > SEEN_UUID_CAP) {
      const old = ring.shift();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- bounded ring eviction
      if (old !== undefined) delete set[old];
    }
    return { ...r, seenUuids: { ring, set } };
  });
  return false;
}

function applyObservation(ctx: Ctx, o: Observation): void {
  if (seenBefore(ctx, o)) {
    diag(ctx, 'dup_uuid', { uuid: o.meta.uuid ?? null });
    return;
  }
  onHookSeen(ctx, o);
  onHookSessionId(ctx, o);
  if (o.meta.replay === true) {
    // historical catch-up (resume): facts plus the history's turns, never active and never reopened (decide/history.ts)
    if (o.kind === 'mode.observed') onModeObserved(ctx, o.p.permissionMode, 'transcript');
    else onReplayObservation(ctx, o, (text) => isNonce(ctx, text));
    return;
  }
  // the first live prompt ends any replayed turn the history left unfinished
  if (o.kind === 'prompt.submitted' || o.kind === 'prompt.recorded') closeOpenReplayTurn(ctx);
  switch (o.kind) {
    case 'session.started':
      onSessionStarted(ctx, o);
      return;
    case 'session.ended':
      onSessionEnded(ctx, o);
      return;
    case 'process.launched':
      onProcessLaunched(ctx, o);
      return;
    case 'process.exited':
      onProcessExited(ctx, o);
      return;
    case 'session.suspended':
      onSessionSuspended(ctx, o);
      return;
    case 'process.identityMismatch':
      onIdentityMismatch(ctx, o);
      return;
    case 'auth.status':
      onAuthStatus(ctx, o);
      return;
    case 'prompt.submitted': {
      const before = dom(ctx).activeTurn;
      onPromptSubmitted(ctx, o);
      const after = mainTurn(ctx);
      if (after !== undefined && after.key !== before) onPromptAcceptedForUsage(ctx, after.origin.value === 'auto_continue');
      else if (after !== undefined) {
        // a merge or our own acceptance into an existing active turn also proves Claude takes prompts again
        const ours = Object.values(dom(ctx).turns).some((t) => t.mergedInto === after.key && t.origin.value === 'auto_continue');
        onPromptAcceptedForUsage(ctx, ours);
      }
      return;
    }
    case 'prompt.recorded':
      onPromptRecorded(ctx, o);
      return;
    case 'queue.op': {
      const op = o.p.op;
      // 2.1.316 writes `content` on enqueue only (dequeue/popAll carry none): mirror the queue as a FIFO so a dequeue removes
      // its head, and count the task notifications still waiting in it (quiescence, §4.5.4). ICR 0016.
      const content = o.p.content;
      const tn = (content ?? '').trimStart().startsWith('<task-notification>');
      updRecon(ctx, (r) => {
        const fifo = [...(r.queueFifo ?? [])];
        if (op === 'enqueue') fifo.push(tn);
        else if (op === 'dequeue') fifo.shift();
        else if (op === 'remove') {
          const i = content === undefined ? 0 : fifo.indexOf(tn);
          if (i >= 0) fifo.splice(i, 1);
        } else if (op === 'popAll') fifo.length = 0;
        return { ...r, queueFifo: fifo, queuedOps: fifo.filter(Boolean).length };
      });
      return;
    }
    case 'prompt.absorbed':
      onPromptAbsorbed(ctx, o);
      return;
    case 'prompt.withdrawn':
      onPromptWithdrawn(ctx);
      return;
    case 'prompt.blocked':
      onPromptBlocked(ctx, o);
      return;
    case 'turn.stopped':
      if (o.p.sessionCrons !== undefined && o.p.sessionCrons !== dom(ctx).scheduledTasks)
        patch(ctx, ['scheduledTasks'], o.p.sessionCrons, 'session crons'); // ICR 0041
      upsertBgTasks(ctx, o.p.backgroundTasks);
      onStopForDrain(ctx, o);
      onTurnStopped(ctx, o);
      return;
    case 'turn.failed': {
      onTurnFailed(ctx, o);
      const e = stopFailureError(o.p.error, o.p.errorDetails ?? o.p.message ?? '');
      if (e.code === 'E_USAGE_LIMIT') markLimited(ctx, { source: 'hook' });
      if (e.code === 'E_AUTH_REQUIRED') authRequired(ctx, o.p.errorDetails ?? o.p.message ?? o.p.error);
      if (e.code === 'E_CLAUDE_VERSION_TOO_OLD') publish(ctx, 'warning', { code: 'E_CLAUDE_VERSION_TOO_OLD', message: e.message });
      return;
    }
    case 'turn.durationRecorded':
      onDurationForDrain(ctx, o);
      onTurnDuration(ctx, o);
      return;
    case 'turn.interrupted':
      onTurnInterrupted(ctx, o);
      return;
    case 'model.requestStarted':
      noteMainActivity(ctx, o.meta.agentId);
      onRequestStarted(ctx, o);
      return;
    case 'model.apiErrorRecorded': {
      onApiErrorRecorded(ctx, o);
      const p = o.p;
      if (p.error === 'rate_limit' || p.apiError === 'usage_limit_reached')
        markLimited(ctx, { source: 'transcript', resetsAtWall: p.resetsAtWall, rateLimitType: p.rateLimitType });
      if (p.error === 'authentication_failed') authRequired(ctx, p.text);
      return;
    }
    case 'model.refused':
      onRefused(ctx, o);
      return;
    case 'model.refusalFallback':
      onRefusalFallback(ctx, o);
      return;
    case 'message.textDelta':
      noteMainActivity(ctx, o.meta.agentId);
      onTextDelta(ctx, o);
      return;
    case 'message.block': {
      noteMainActivity(ctx, o.meta.agentId);
      const r = onMessageBlock(ctx, o);
      const p = o.p;
      if (p.block === 'tool_use' && p.toolUseId !== undefined) {
        onToolUseBlock(ctx, {
          toolUseId: p.toolUseId,
          name: p.toolName ?? 'unknown',
          input: p.input ?? null,
          apiMessageId: p.apiMessageId,
          blockIndex: p.blockIndex,
          agentId: o.meta.agentId,
        });
        const t = Object.values(dom(ctx).tools).find((x) => x.toolUseId === p.toolUseId);
        if (t !== undefined) tryLateBind(ctx, t.key);
      }
      if (r.turn === undefined) diag(ctx, 'block_without_turn', { apiMessageId: p.apiMessageId });
      return;
    }
    case 'tool.pre': {
      noteMainActivity(ctx, o.meta.agentId);
      const k = onToolPre(ctx, o);
      tryLateBind(ctx, k);
      return;
    }
    case 'tool.post': {
      const k = onToolPost(ctx, o);
      const t = toolRec(ctx, k);
      if (t !== undefined) {
        onToolOutcome(ctx, k, t.state.value);
        const agentId = o.p.asyncAgentId ?? isAgentSpawnResponse(o.p.response);
        if (agentId !== undefined) linkAgentFromTool(ctx, k, agentId, o.p.asyncAgentId !== undefined);
      }
      return;
    }
    case 'tool.failed': {
      const k = onToolFailed(ctx, o);
      const t = toolRec(ctx, k);
      if (t !== undefined) onToolOutcome(ctx, k, t.state.value);
      return;
    }
    case 'tool.batchDone':
      onToolBatch(ctx, o);
      return;
    case 'tool.result': {
      const k = onToolResult(ctx, o);
      if (k !== undefined) {
        // a user-rejected result that onToolResult read as an interrupt of a running tool resolves as one (F-4)
        const rs = toolResultState(o.p);
        onToolOutcome(ctx, k, rs === 'denied' && toolRec(ctx, k)?.state.value === 'interrupted' ? 'interrupted' : rs, o.p.denialKind);
        if (o.p.asyncAgentId !== undefined) linkAgentFromTool(ctx, k, o.p.asyncAgentId, true);
      }
      return;
    }
    case 'tool.validationError':
      onToolValidationError(ctx, o);
      return;
    case 'permission.requested':
      onPermissionRequested(ctx, o);
      return;
    case 'permission.hookClosed':
      onHookClosed(ctx, o);
      return;
    case 'permission.decisionRecorded':
      onDecisionRecorded(ctx, o);
      return;
    case 'permission.autoDenied':
      onAutoDenied(ctx, o);
      return;
    case 'permission.pathsResolved':
      onPathsResolved(ctx, o);
      return;
    case 'agent.started':
      onAgentStarted(ctx, o);
      return;
    case 'agent.stopped':
      onAgentStopped(ctx, o);
      return;
    case 'agent.meta':
      onAgentMeta(ctx, o);
      return;
    case 'agent.fileMissing':
      onAgentFileMissing(ctx, o);
      return;
    case 'bgtask.status':
      onBgTaskStatus(ctx, o);
      return;
    case 'notification':
      onQuotaNotification(ctx, o.p.type);
      if (o.p.type === 'permission_prompt' || o.p.type.startsWith('elicitation')) {
        emit<'screen.captureNow'>(ctx, { kind: 'screen.captureNow', reason: `notification:${o.p.type}` });
      }
      return;
    case 'input.requested':
      onInputRequested(ctx, o);
      return;
    case 'input.requestCleared':
      onInputRequestCleared(ctx, o);
      return;
    case 'compact.phase':
      if (o.p.phase === 'started') {
        const c: { trigger?: string; since: MonoMs } = { since: nowOf(ctx) };
        if (o.p.trigger !== undefined) c.trigger = o.p.trigger;
        apply(ctx, { type: 'x.patch', entity: 'compacting', patch: { op: 'set', value: c as unknown as JsonValue, why: 'compaction' } });
        const pl: { phase: 'started' | 'ended'; trigger?: string } = { phase: 'started' };
        if (o.p.trigger !== undefined) pl.trigger = o.p.trigger;
        publish(ctx, 'compaction', pl);
      } else {
        if (dom(ctx).compacting !== undefined)
          apply(ctx, { type: 'x.patch', entity: 'compacting', patch: { op: 'unset', why: 'compaction done' } });
        const pl: { phase: 'started' | 'ended'; trigger?: string } = { phase: 'ended' };
        if (o.p.trigger !== undefined) pl.trigger = o.p.trigger;
        publish(ctx, 'compaction', pl);
        commandEvidenceCompact(ctx);
      }
      return;
    case 'mode.observed':
      onModeObserved(ctx, o.p.permissionMode, o.meta.source === 'hook' ? 'hook' : 'transcript');
      return;
    case 'model.switched':
      onModelSwitched(ctx, o);
      return;
    case 'config.changed': {
      const pl: { source: string; filePath?: string } = { source: o.p.source };
      if (o.p.filePath !== undefined) pl.filePath = o.p.filePath;
      publish(ctx, 'config.changed', pl);
      return;
    }
    case 'cwd.changed':
      emit<'tail.poke'>(ctx, { kind: 'tail.poke', reason: 'cwdChanged' });
      diag(ctx, 'cwd_changed', { oldCwd: o.p.oldCwd, newCwd: o.p.newCwd });
      return;
    case 'transcript.relocated':
      onRelocated(ctx, o);
      return;
    case 'transcript.continuedIn':
      onContinuedIn(ctx, o);
      return;
    case 'transcript.file':
      diag(ctx, `transcript_${o.p.event}`, { fileKey: o.p.fileKey });
      return;
    case 'hookchannel.error':
      onHookChannelError(ctx, o);
      return;
    case 'screen.frame':
      onFrame(ctx, o);
      return;
    case 'net.tunnel':
      onNetTunnel(ctx, o);
      return;
    case 'registry':
      onRegistry(ctx, o);
      return;
    case 'input.done':
      onInputDone(ctx, o);
      return;
    case 'hook.responded':
      onHookResponded(ctx, o);
      return;
    case 'hook.selfTestArmed':
      onSelfTestArmed(ctx, o);
      return;
    case 'host.loopLag':
      onLoopLag(ctx, o);
      return;
    case 'clock.tick':
      return;
    case 'clock.hostResumed':
      onHostResumed(ctx);
      return;
    case 'channel.health':
      onChannelHealth(ctx, o);
      return;
    case 'unknown':
      diag(ctx, 'unknown_observation', { channel: o.p.channel });
      return;
  }
}

function commandEvidenceCompact(ctx: Ctx): void {
  commandEvidence(ctx, { kind: 'compactDone' });
}

// ------------------------------------------------------------------ (5) machine + outcomes
function drainOutcomes(ctx: Ctx): void {
  for (let i = 0; i < 64 && ctx.outcomes.length > 0; i++) {
    const o = ctx.outcomes.shift();
    if (o === undefined) break;
    switch (o.kind) {
      case 'submitStarted':
        onSubmitStarted(ctx, o.turn, o.attempt, o.method);
        break;
      case 'submitFailed':
        onSubmitFailed(ctx, o.turn, o.error, o.clearComposer);
        onWakeTurnUndelivered(ctx, o.turn);
        break;
      case 'submitAcceptedByTranscript':
        onSubmitAcceptedByTranscript(ctx, o.job, o.turn, o.promptId);
        break;
      case 'selftestPassed':
        onSelfTestPassed(ctx);
        break;
      case 'selftestFailed':
        onSelfTestFailed(ctx, o.step, o.transcriptEvidence, o.error);
        break;
      case 'permissionKeysDone':
        onPermissionKeysDone(ctx, o.permission, o.action, o.ok);
        break;
      case 'wakeDone':
        onWakeDone(ctx, o.ok);
        break;
      case 'menuDismissed':
        onMenuDismissed(ctx, o.ok);
        break;
      case 'closeExitFailed':
        onCloseExitFailed(ctx);
        break;
    }
  }
}

function refreshInputBlocked(ctx: Ctx): void {
  const next = computeInputBlocked(ctx.core);
  if (!sameBlocked(next, dom(ctx).inputBlocked)) setInputBlocked(ctx, next);
}

function machineLoop(ctx: Ctx): void {
  for (let i = 0; i < 16; i++) {
    refreshInputBlocked(ctx);
    runMachine(ctx);
    if (ctx.outcomes.length === 0 && ctx.closedTurns.length === 0) break;
    drainOutcomes(ctx);
    runClosing(ctx);
  }
  refreshInputBlocked(ctx);
}

// ------------------------------------------------------------------ (6) status, (7) cadence
function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function recomputeStatus(ctx: Ctx): void {
  const prev = dom(ctx).status;
  const r = recon(ctx);
  const asserted = (k: string): boolean => {
    const c = r.claims[k];
    return c !== undefined && (c.status === 'asserted' || c.status === 'confirmed');
  };
  const retry = r.claims['status:retrying'];
  let screenRetry: { attempt?: number; max?: number; retryInMs?: number } | undefined;
  if (
    retry !== undefined &&
    asserted('status:retrying') &&
    typeof retry.value === 'object' &&
    retry.value !== null &&
    !Array.isArray(retry.value)
  ) {
    const v = retry.value;
    screenRetry = {};
    if (typeof v['attempt'] === 'number') screenRetry.attempt = v['attempt'];
    if (typeof v['max'] === 'number') screenRetry.max = v['max'];
    if (typeof v['retryInMs'] === 'number') screenRetry.retryInMs = v['retryInMs'];
  }
  const next: AgentStatus = deriveStatus(dom(ctx), {
    now: nowOf(ctx),
    config: cfg(ctx),
    prev,
    pendingNotifications: r.queuedOps + awaitedNotifications(dom(ctx), nowOf(ctx), cfg(ctx).timeouts.transcriptSettleMs),
    lastHostResumeAt: r.lastHostResumeAt,
    screenStall: asserted('status:stalled') || asserted('status:noResponse'),
    screenRetry,
  });
  if (deepEq(prev, next)) return;
  publish(ctx, 'status.changed', { from: prev, to: next }, { turnKey: dom(ctx).activeTurn });
  if (prev.kind !== next.kind && dom(ctx).lifecycle !== 'preflight')
    emit<'registry.persist'>(ctx, { kind: 'registry.persist', patch: { state: next.kind } });
}

function desiredCadence(ctx: Ctx): number | null {
  const d = dom(ctx);
  const s = cfg(ctx).channels.screen;
  if (d.lifecycle === 'exited' || d.lifecycle === 'preflight') return null;
  const st = d.status;
  const lastSent = recon(ctx).lastSentAt;
  const recentSend = lastSent !== undefined && nowOf(ctx) - lastSent < 5000;
  if (
    st.kind === 'starting' ||
    st.kind === 'awaitingPermission' ||
    st.kind === 'awaitingInput' ||
    ctx.core.input.current !== undefined ||
    recentSend
  ) {
    if (recentSend) arm(ctx, 'escGap', 'cadence', lastSent + 5000);
    return s.startupPollMs;
  }
  if (st.kind === 'modelRequest' && (st.phase === 'retrying' || st.phase === 'stalled')) return s.retryPollMs;
  if (
    st.kind === 'modelRequest' ||
    st.kind === 'runningTools' ||
    st.kind === 'writing' ||
    st.kind === 'interrupted' ||
    st.kind === 'compacting'
  )
    return s.busyPollMs;
  if (st.kind === 'idle' && st.quiescent) {
    const since = recon(ctx).quiescentSince;
    if (since === undefined) {
      updRecon(ctx, (r) => ({ ...r, quiescentSince: nowOf(ctx) }));
      arm(ctx, 'escGap', 'cadence:quiet', nowOf(ctx) + 60_000);
      return s.idlePollMs;
    }
    if (nowOf(ctx) - since >= 60_000) return Math.max(s.idlePollMs, 5000);
    return s.idlePollMs;
  }
  return s.idlePollMs;
}

function recomputeCadence(ctx: Ctx): void {
  const st = dom(ctx).status;
  if (!(st.kind === 'idle' && st.quiescent) && recon(ctx).quiescentSince !== undefined) {
    updRecon(ctx, (r) => {
      const n = { ...r };
      delete n.quiescentSince;
      return n;
    });
  }
  const want = desiredCadence(ctx);
  if (recon(ctx).cadence !== want && !(recon(ctx).cadence === undefined && want === null)) {
    updRecon(ctx, (r) => ({ ...r, cadence: want }));
    emit<'poll.cadence'>(ctx, { kind: 'poll.cadence', channel: 'screen', intervalMs: want });
  }
  const auth = dom(ctx).auth.state === 'required' && dom(ctx).lifecycle !== 'exited' ? cfg(ctx).timeouts.authPollMs : null;
  if (recon(ctx).authPoll !== auth && !(recon(ctx).authPoll === undefined && auth === null)) {
    updRecon(ctx, (r) => ({ ...r, authPoll: auth }));
    emit<'auth.poll'>(ctx, { kind: 'auth.poll', intervalMs: auth });
  }
}

// ------------------------------------------------------------------ results
function deliverResult(ctx: Ctx): StepResult['commandResult'] {
  if (ctx.result === undefined) {
    const s = ctx.core.input;
    const next = s.pendingResults[0];
    if (next !== undefined) {
      setInputState(ctx, { ...s, pendingResults: s.pendingResults.slice(1) });
      ctx.result = next;
    }
  }
  if (ctx.core.input.pendingResults.length > 0) arm(ctx, 'modalEffect', 'results', nowOf(ctx));
  const r = ctx.result;
  if (r === undefined) return undefined;
  if (r.ok) return { cmdId: r.cmdId, ok: true, value: r.value };
  return { cmdId: r.cmdId, ok: false, error: r.error ?? { code: 'E_INVARIANT', message: 'command failed' } };
}

// ------------------------------------------------------------------ step
function inputTimes(input: CoreInput): { at: MonoMs; wallAt: WallMs } {
  return input.type === 'obs' ? { at: input.obs.meta.at, wallAt: input.obs.meta.wallAt } : { at: input.at, wallAt: input.wallAt };
}

export function stepDetailed(core: CoreState, input: CoreInput): DetailedStepResult {
  const t = inputTimes(input);
  const advanced: CoreState = {
    ...core,
    now: (Number.isFinite(t.at) ? Math.max(core.now, t.at) : core.now) as MonoMs,
    wallNow: (Number.isFinite(t.wallAt) ? Math.max(core.wallNow, t.wallAt) : core.wallNow) as WallMs,
  };
  const ctx = newCtx(advanced, input);
  try {
    fireDue(ctx);
    if (input.type === 'obs') applyObservation(ctx, input.obs);
    else {
      const out = handleCommand(ctx, input.cmdId, input.cmd);
      if (out.kind === 'ok') ctx.result = { cmdId: input.cmdId, ok: true, value: out.value };
      else if (out.kind === 'error') ctx.result = { cmdId: input.cmdId, ok: false, error: out.error };
    }
    runClosing(ctx);
    machineLoop(ctx);
    checkPendingClose(ctx);
    retryDialogAdoption(ctx);
    if (dom(ctx).lifecycle === 'exited' && dom(ctx).exit === undefined) closeProcess(ctx, 'exited');
    recomputeStatus(ctx);
    recomputeCadence(ctx);
    const commandResult = deliverResult(ctx);
    const r: DetailedStepResult = {
      core: ctx.core,
      events: ctx.events,
      intents: ctx.intents,
      diagnostics: ctx.diagnostics,
      coreEvents: ctx.coreEvents,
    };
    if (commandResult !== undefined) r.commandResult = commandResult;
    return r;
  } catch (e) {
    // I2: step never throws. A bug is reported as a diagnostic; state stays at the input (time advanced).
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const diagnostics = [
      { code: 'step_exception', at: advanced.now, detail: { message: msg, input: input.type === 'obs' ? input.obs.kind : input.cmd.type } },
    ];
    const r: DetailedStepResult = { core: advanced, events: [], intents: [], diagnostics, coreEvents: [] };
    if (input.type === 'cmd') r.commandResult = { cmdId: input.cmdId, ok: false, error: { code: 'E_INVARIANT', message: msg } };
    return r;
  }
}

/** The only entry point (§2.9): total, synchronous, deterministic. */
export function step(core: CoreState, input: CoreInput): StepResult {
  const r = stepDetailed(core, input);
  const out: StepResult = { core: r.core, events: r.events, intents: r.intents, diagnostics: r.diagnostics };
  if (r.commandResult !== undefined) out.commandResult = r.commandResult;
  return out;
}

/** §2.9: snapshot/restore (I7). CoreState is plain JSON data by construction. */
export function serializeCore(c: CoreState): JsonValue {
  return JSON.parse(JSON.stringify(c)) as JsonValue;
}
export function deserializeCore(j: JsonValue): CoreState {
  return JSON.parse(JSON.stringify(j)) as CoreState;
}
