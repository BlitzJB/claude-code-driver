// core/decide/turns.ts — Turn transitions (DESIGN.md §4.4, §3.6 step 5 ack order; RC §3.2 never reopen, §6, §10.3).

import type { CcdErrorCode, CcdErrorData } from '../../model/errors.js';
import type { InputJobKey, TurnKey } from '../../model/ids.js';
import type { Observation, PromptOrigin } from '../../model/observation.js';
import type { TurnRecord } from '../../model/state.js';
import { confirmClaim } from '../claims.js';
import {
  arm,
  captureNow,
  cfg,
  diag,
  disarm,
  dom,
  err,
  inputState,
  mint,
  newProvenance,
  nowOf,
  patch,
  publish,
  recon,
  seqOf,
  srcOf,
  updRecon,
} from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { mkFact } from '../facts.js';
import { ackMatches, classifyAck, normalizeForAck } from '../input-policy/ack-match.js';
import { interruptJob, submitJob } from '../input-policy/jobs.js';
import {
  commandEvidence,
  enqueueClear,
  enqueueJob,
  extendAck,
  inflightSubmit,
  interruptEvidence,
  noteSelftestBlocked,
  promptBlocked,
  selftestAcked,
  submitAcked,
  transcriptAck,
  wakeVerified,
} from '../input-policy/machine.js';
import { isTurnTerminal } from '../lattice.js';
import { noteTaskNotification } from './agents.js';
import { addReason } from './channels.js';
import { mainTurn, putTurn, releaseHeldTurn, setActiveTurn, setTurnState, touchTurn, turnByPromptId, turnRec } from './entities.js';
import { implicitFinalForTurn } from './messages.js';

/** Self-test nonce shape (D-35); a prompt of this exact shape is never a Turn even when this core did not mint it (K-50). */
const NONCE_RE = /^ccd-selftest-[0-9a-f]{32}$/;

function noncesFor(ctx: Ctx, text: string): string[] {
  const n = recon(ctx).recentNonces;
  const t = normalizeForAck(text);
  return NONCE_RE.test(t) && !n.includes(t) ? [...n, t] : [...n];
}

export function isNonce(ctx: Ctx, text: string): boolean {
  const t = normalizeForAck(text);
  return noncesFor(ctx, text).some((n) => normalizeForAck(n) === t);
}

// ------------------------------------------------------------------ creation
function aliasPrompt(ctx: Ctx, promptId: string | undefined, k: TurnKey): void {
  if (promptId === undefined || promptId === '') return;
  updRecon(ctx, (r) => ({ ...r, aliases: { ...r.aliases, promptId: { ...r.aliases.promptId, [promptId]: k } } }));
}

function removeFromQueue(ctx: Ctx, k: TurnKey): void {
  const q = dom(ctx).libraryQueue;
  if (q.includes(k))
    patch(
      ctx,
      ['libraryQueue'],
      q.filter((x) => x !== k),
      'dequeue',
    );
}

/** `cmd prompt.send` (sanitized text) → queued library turn + its submit job (§4.4#1). */
export function createLibraryTurn(
  ctx: Ctx,
  text: string,
  o: { clientRef?: string | undefined; origin?: PromptOrigin; front?: boolean; forWake?: boolean } = {},
): TurnKey {
  const k = mint(ctx, 'turn');
  const job = mint(ctx, 'job');
  const origin = o.origin ?? 'library';
  const t: TurnRecord = {
    key: k,
    prompt: text,
    origin: mkFact(origin, 'self', seqOf(ctx), nowOf(ctx)),
    state: mkFact('queued', 'self', seqOf(ctx), nowOf(ctx)),
    job,
    backgroundPending: [],
    tools: [],
    messages: [],
    calls: [],
    queuedAt: nowOf(ctx),
    provenance: newProvenance(ctx, 'self'),
  };
  if (o.clientRef !== undefined) t.clientRef = o.clientRef;
  putTurn(ctx, t, 'library turn');
  patch(ctx, ['turnOrder'], [...dom(ctx).turnOrder, k], 'turn order');
  const q = dom(ctx).libraryQueue;
  patch(ctx, ['libraryQueue'], o.front === true ? [k, ...q] : [...q, k], 'enqueue');
  enqueueJob(
    ctx,
    submitJob({ key: job, seq: ctx.core.counters.job, createdAt: nowOf(ctx) }, k, text, cfg(ctx).input.method, o.forWake === true),
    o.front === true,
  );
  const ev: { prompt: string; origin: PromptOrigin; clientRef?: string } = { prompt: text, origin };
  if (o.clientRef !== undefined) ev.clientRef = o.clientRef;
  publish(ctx, 'turn.queued', ev, { turnKey: k, confirmed: true, sources: ['self'] });
  return k;
}

/**
 * A new turn starts while the previous main turn is still open. A turn already `stopping` had its Stop (only stopGrace /
 * a late MessageDisplay were pending): it completed, and the new UPS is the evidence (K-25: Stop and a task-notification
 * UPS in the same ms). Any other open turn never closed (hook gap): unknown, never silently kept running. (ICR 0016)
 */
function supersede(ctx: Ctx, prev: TurnRecord): void {
  diag(ctx, 'turn_superseded', { turn: prev.key, state: prev.state.value });
  if (prev.state.value === 'stopping') {
    disarm(ctx, 'stopGrace', prev.key);
    setTurnState(ctx, prev.key, 'completed', { endedBy: 'stop', src: 'hook' });
    arm(ctx, 'lateText', prev.key, nowOf(ctx) + cfg(ctx).timeouts.lateTextMs);
    return;
  }
  setTurnState(ctx, prev.key, 'unknown', { endedBy: 'stop' });
}

function externalTurn(
  ctx: Ctx,
  origin: PromptOrigin,
  text: string,
  promptId: string | undefined,
  o: { taskNotification?: { taskId: string; toolUseId?: string; status: string } | undefined; provisional?: boolean } = {},
): TurnKey {
  const prev = mainTurn(ctx);
  if (prev !== undefined && !isTurnTerminal(prev.state.value)) supersede(ctx, prev);
  const k = mint(ctx, 'turn');
  const src = srcOf(ctx);
  const t: TurnRecord = {
    key: k,
    prompt: text,
    origin: mkFact(origin, src, seqOf(ctx), nowOf(ctx), o.provisional === true),
    state: mkFact('running', src, seqOf(ctx), nowOf(ctx), o.provisional === true),
    backgroundPending: [],
    tools: [],
    messages: [],
    calls: [],
    queuedAt: nowOf(ctx),
    acceptedAt: nowOf(ctx),
    provenance: newProvenance(ctx),
  };
  const gen = dom(ctx).claude.currentGen;
  if (gen !== undefined) t.gen = gen;
  if (promptId !== undefined && promptId !== '') t.promptId = promptId;
  putTurn(ctx, t, 'external turn');
  patch(ctx, ['turnOrder'], [...dom(ctx).turnOrder, k], 'turn order');
  aliasPrompt(ctx, promptId, k);
  setActiveTurn(ctx, k, 'external turn');
  if (o.taskNotification !== undefined) {
    const cause = noteTaskNotification(ctx, k, o.taskNotification);
    const cb: NonNullable<TurnRecord['causedBy']> = { taskId: o.taskNotification.taskId };
    if (cause.agent !== undefined) cb.agent = cause.agent;
    if (cause.tool !== undefined) cb.tool = cause.tool;
    const cur = turnRec(ctx, k);
    if (cur !== undefined) putTurn(ctx, { ...cur, causedBy: cb }, 'caused by task notification');
  }
  const confirmed = o.provisional !== true;
  publish(ctx, 'turn.queued', { prompt: text, origin }, { turnKey: k, confirmed });
  publish(ctx, 'turn.accepted', { promptId: promptId ?? '' }, { turnKey: k, confirmed });
  return k;
}

/**
 * Two turns later found to be one (P-REC-37): a provisional transcript-first placeholder and our acked submit share a
 * prompt_id. The placeholder's tools/messages/calls move to ours, it ends `unknown`, and a redirect is recorded.
 */
function mergePlaceholder(ctx: Ctx, into: TurnKey, promptId: string | undefined): void {
  const ph = turnByPromptId(ctx, promptId);
  const target = turnRec(ctx, into);
  if (ph === undefined || target === undefined || ph.key === into || !ph.state.provisional) return;
  putTurn(
    ctx,
    {
      ...target,
      tools: [...target.tools, ...ph.tools],
      messages: [...target.messages, ...ph.messages],
      calls: [...target.calls, ...ph.calls],
    },
    'merged placeholder',
  );
  for (const k of ph.tools) {
    const tool = dom(ctx).tools[k];
    if (tool !== undefined) patch(ctx, ['tools', k, 'turn'], into, 'merged placeholder');
  }
  for (const k of ph.messages) if (dom(ctx).messages[k] !== undefined) patch(ctx, ['messages', k, 'turn'], into, 'merged placeholder');
  for (const k of ph.calls) if (dom(ctx).calls[k] !== undefined) patch(ctx, ['calls', k, 'turn'], into, 'merged placeholder');
  putTurn(ctx, { ...ph, tools: [], messages: [], calls: [] }, 'merged away');
  if (dom(ctx).activeTurn === ph.key) setActiveTurn(ctx, undefined, 'merged away');
  setTurnState(ctx, ph.key, 'unknown', { endedBy: 'merged' });
  updRecon(ctx, (r) => ({ ...r, redirects: { ...r.redirects, [ph.key]: into } }));
  diag(ctx, 'entity.merged', { from: ph.key, into });
}

/** Our submit acked: running, promptId aliased, active (§4.4#7). */
function accept(ctx: Ctx, job: InputJobKey, turn: TurnKey, promptId: string | undefined, confirmed: boolean): void {
  const t = turnRec(ctx, turn);
  if (t === undefined) return;
  mergePlaceholder(ctx, turn, promptId);
  const prev = mainTurn(ctx);
  if (prev !== undefined && prev.key !== turn && !isTurnTerminal(prev.state.value)) supersede(ctx, prev);
  const n: TurnRecord = { ...(turnRec(ctx, turn) ?? t), acceptedAt: nowOf(ctx) };
  if (promptId !== undefined && promptId !== '') n.promptId = promptId;
  const gen = dom(ctx).claude.currentGen;
  if (gen !== undefined) n.gen = gen;
  putTurn(ctx, n, 'accepted');
  if (t.state.value === 'queued') setTurnState(ctx, turn, 'submitting', { src: 'self' });
  setTurnState(ctx, turn, 'running', { provisional: !confirmed });
  aliasPrompt(ctx, promptId, turn);
  removeFromQueue(ctx, turn);
  setActiveTurn(ctx, turn, 'accepted');
  publish(ctx, 'turn.accepted', { promptId: promptId ?? '' }, { turnKey: turn, confirmed });
  submitAcked(ctx, job);
}

/** Claude queued our prompt into a running turn (IN §7.3): ours runs with mergedInto = host (§4.4#8). */
function merge(ctx: Ctx, job: InputJobKey, turn: TurnKey, host: TurnKey): void {
  const t = turnRec(ctx, turn);
  if (t === undefined) return;
  putTurn(ctx, { ...t, mergedInto: host, acceptedAt: nowOf(ctx) }, 'merged');
  if (t.state.value === 'queued') setTurnState(ctx, turn, 'submitting', { src: 'self' });
  setTurnState(ctx, turn, 'running');
  removeFromQueue(ctx, turn);
  publish(ctx, 'turn.accepted', { promptId: turnRec(ctx, host)?.promptId ?? '', mergedInto: host }, { turnKey: turn });
  submitAcked(ctx, job);
}

// ------------------------------------------------------------------ prompts
/** UserPromptSubmit (§3.6 step 5): nonce → external shape → match → mismatch; no in-flight submit → external turn. */
export function onPromptSubmitted(ctx: Ctx, o: Extract<Observation, { kind: 'prompt.submitted' }>): void {
  const p = o.p;
  const inflight = inflightSubmit(ctx);
  const sent = inflight?.kind === 'submit' ? inflight.text : undefined;
  const v = classifyAck(p.text, { nonces: noncesFor(ctx, p.text), sent, hasTaskNotification: p.taskNotification !== undefined });
  if (v.kind === 'selftest') {
    if (!selftestAcked(ctx)) diag(ctx, 'nonce_ups_without_job', { promptId: p.promptId });
    return; // consumed by the self-test, never a Turn (§4.4#4)
  }
  wakeVerified(ctx);
  // drop transcript-first placeholders this UPS answers
  for (const [u, r] of Object.entries(recon(ctx).pendingRecorded)) {
    if ((r.promptId !== undefined && r.promptId === p.promptId) || normalizeForAck(r.text) === normalizeForAck(p.text)) {
      disarm(ctx, 'hookGap', `ups:${u}`);
      updRecon(ctx, (x) => {
        const { [u]: _gone, ...rest } = x.pendingRecorded;
        return { ...x, pendingRecorded: rest };
      });
    }
  }
  if (inflight?.kind === 'submit') {
    if (v.kind === 'external') {
      externalTurn(ctx, v.origin, p.text, p.promptId, { taskNotification: p.taskNotification });
      extendAck(ctx, inflight.key);
      return;
    }
    const host = turnByPromptId(ctx, p.promptId);
    if (
      host !== undefined &&
      host.key !== inflight.turn &&
      !host.state.provisional &&
      !isTurnTerminal(host.state.value) &&
      ackMatches(p.text, inflight.text)
    ) {
      merge(ctx, inflight.key, inflight.turn, host.key);
      return;
    }
    if (v.kind === 'match') {
      accept(ctx, inflight.key, inflight.turn, p.promptId, true);
      return;
    }
    // mismatch: still ours (one submit in flight); alert, never interrupt by default (rev 2 §10 A3)
    const turn = inflight.turn;
    accept(ctx, inflight.key, turn, p.promptId, false);
    const detail = v.kind === 'mismatch' ? v.detail : {};
    publish(ctx, 'security.alert', { code: 'E_INPUT_TAMPERED', detail }, { turnKey: turn, confirmed: false });
    if (cfg(ctx).security.onTamper === 'interrupt') {
      enqueueJob(ctx, interruptJob({ key: mint(ctx, 'job'), seq: ctx.core.counters.job, createdAt: nowOf(ctx) }, turn), true);
    }
    return;
  }
  const existing = turnByPromptId(ctx, p.promptId);
  if (existing !== undefined) {
    // transcript-first placeholder or a queued UPS reusing prompt_id (IN §7.3): enrich, never reopen (RC §3.2)
    touchTurn(ctx, existing.key);
    if (existing.state.value === 'running' && existing.state.provisional) setTurnState(ctx, existing.key, 'running');
    return;
  }
  let origin: PromptOrigin = v.kind === 'external' ? v.origin : 'unknown';
  if (origin === 'unknown') {
    const cleared = recon(ctx).limitClearedAt;
    if (cleared !== undefined && nowOf(ctx) - cleared < 60_000) origin = 'auto_continue';
  }
  if (origin === 'unknown')
    publish(ctx, 'security.alert', { code: 'E_SECURITY_UNEXPECTED_INPUT', detail: { promptId: p.promptId, origin } }, { confirmed: false });
  externalTurn(ctx, origin, p.text, p.promptId, { taskNotification: p.taskNotification });
}

/**
 * §3.6 Commands / LC §10.3: the `/model` result line `Set model to <m> and saved as your default for new sessions` means
 * the user's default model changed as a side effect → `session.modelChanged{savedAsDefault:true}` + a warning.
 * (`… for this session only` is the harmless form.) Matched on the transcript `<local-command-stdout>`, independent of
 * whether a command job is still waiting (model.switched may have ended it first).
 */
function modelSavedAsDefault(ctx: Ctx, name: string, stdout: string | undefined): void {
  if (name.replace(/^\//, '').toLowerCase() !== 'model' || stdout === undefined) return;
  if (!/saved as your default/i.test(stdout)) return;
  const m = /set model to\s+(.+?)\s+and saved as your default/i.exec(stdout);
  const model = m?.[1]?.trim() ?? dom(ctx).claude.model?.value ?? '';
  publish(ctx, 'session.modelChanged', { model, source: 'command', savedAsDefault: true });
  publish(ctx, 'warning', {
    code: 'E_INVARIANT',
    message: '/model also changed the default model for new sessions',
    detail: { reason: 'modelSavedAsDefault', model },
  });
}

/** transcript user entry (§4.4#3–#6). */
export function onPromptRecorded(ctx: Ctx, o: Extract<Observation, { kind: 'prompt.recorded' }>): void {
  const p = o.p;
  const text = p.text ?? '';
  if (text !== '' && isNonce(ctx, text)) return; // §4.4#4
  if (p.localCommand !== undefined) {
    modelSavedAsDefault(ctx, p.localCommand.name, p.localCommand.stdout);
    commandEvidence(ctx, { kind: 'localCommand', name: p.localCommand.name, stdout: p.localCommand.stdout });
    return;
  }
  if (p.isMeta) return;
  const known = turnByPromptId(ctx, p.promptId);
  if (known !== undefined) {
    touchTurn(ctx, known.key);
    return;
  }
  if (o.meta.replay === true) return;
  if (p.bashInput === true) {
    externalTurn(ctx, 'bash_mode', text, p.promptId); // a human in the pane (IN §4.2): no UPS
    return;
  }
  if (transcriptAck(ctx, text, p.promptId)) return;
  const gen = dom(ctx).claude.currentGen;
  const rec: { promptId?: string; text: string; at: typeof o.meta.at; seq: number; gen?: NonNullable<typeof gen> } = {
    text,
    at: nowOf(ctx),
    seq: o.meta.seq,
  };
  if (p.promptId !== undefined) rec.promptId = p.promptId;
  if (gen !== undefined) rec.gen = gen;
  const id = p.uuid;
  updRecon(ctx, (r) => ({ ...r, pendingRecorded: { ...r.pendingRecorded, [id]: rec } }));
  // an in-flight submit of ours may still be acked by the hook: only start the gap timer
  arm(ctx, 'hookGap', `ups:${id}`, nowOf(ctx) + cfg(ctx).timeouts.hookGapMs);
}

/** hookGap for a transcript-first prompt: running (provisional) + hooks degraded{UserPromptSubmit} (§4.4#6). */
export function onRecordedGap(ctx: Ctx, uuid: string): void {
  const r = recon(ctx).pendingRecorded[uuid];
  if (r === undefined) return;
  updRecon(ctx, (x) => {
    const { [uuid]: _gone, ...rest } = x.pendingRecorded;
    return { ...x, pendingRecorded: rest };
  });
  if (turnByPromptId(ctx, r.promptId) !== undefined) return;
  const j = inflightSubmit(ctx);
  if (j?.kind === 'submit' && ackMatches(r.text, j.text)) {
    // it is our own prompt whose UPS never came: accept it from the transcript (§3.6 step 6)
    onSubmitAcceptedByTranscript(ctx, j.key, j.turn, r.promptId);
    submitAcked(ctx, j.key);
    return;
  }
  addReason(ctx, 'hooks', 'hookGap:UserPromptSubmit');
  externalTurn(ctx, 'unknown', r.text, r.promptId, { provisional: true });
}

export function onPromptAbsorbed(ctx: Ctx, o: Extract<Observation, { kind: 'prompt.absorbed' }>): void {
  const inflight = inflightSubmit(ctx);
  const host = mainTurn(ctx);
  if (inflight?.kind !== 'submit' || host === undefined || host.key === inflight.turn) return;
  if (!ackMatches(o.p.text, inflight.text)) return;
  merge(ctx, inflight.key, inflight.turn, host.key);
}

/** §4.4#17: interrupt sent + no output yet + prompt withdrawn → withdrawn. */
export function onPromptWithdrawn(ctx: Ctx): void {
  const t = mainTurn(ctx);
  if (t === undefined) return;
  const esc = inputState(ctx).lastEscAt;
  const recentEsc = esc !== undefined && nowOf(ctx) - esc <= cfg(ctx).timeouts.interruptConfirmMs;
  const output = t.tools.length > 0 || t.messages.some((m) => (dom(ctx).messages[m]?.text ?? '') !== '');
  if (!recentEsc || output) {
    diag(ctx, 'withdrawn_ignored', { turn: t.key, recentEsc, output });
    return;
  }
  setTurnState(ctx, t.key, 'withdrawn', { endedBy: 'withdrawn' });
  interruptEvidence(ctx);
}

/** transcript `prompt.blocked` (ICR 0002, LP-47): self-test cross-check, or E_TURN_BLOCKED_BY_HOOK evidence (§3.6 step 6). */
export function onPromptBlocked(ctx: Ctx, o: Extract<Observation, { kind: 'prompt.blocked' }>): void {
  const text = o.p.text;
  if (isNonce(ctx, text)) {
    noteSelftestBlocked(ctx);
    return;
  }
  if (promptBlocked(ctx, text)) return;
  diag(ctx, 'prompt_blocked_by_user_hook', { reason: o.p.reason });
}

// ------------------------------------------------------------------ ends
export function onTurnStopped(ctx: Ctx, o: Extract<Observation, { kind: 'turn.stopped' }>): void {
  const p = o.p;
  captureNow(ctx, 'stop');
  const gen = dom(ctx).claude.currentGen;
  if (gen !== undefined) updRecon(ctx, (r) => ({ ...r, stopSeenInGen: { ...r.stopSeenInGen, [gen]: true } }));
  const t = mainTurn(ctx);
  if (t === undefined) {
    // a provisional (screen) interrupt that was already released, contradicted by Stop (§4.4#22)
    const last = mainTurn(ctx, true);
    if (last?.state.value === 'interrupted' && last.state.provisional && !p.stopHookActive) {
      setTurnState(ctx, last.key, 'completed', { endedBy: 'stop', src: 'hook' });
      return;
    }
    diag(ctx, 'stop_without_turn', { promptId: p.promptId ?? null });
    return;
  }
  if (p.stopHookActive) {
    diag(ctx, 'stop_hook_active', { turn: t.key }); // a user Stop hook blocked; more Stops follow (§4.4#10)
    return;
  }
  const n: TurnRecord = { ...t, backgroundPending: p.backgroundTasks.map((b) => b.id) };
  if (p.lastAssistantMessage !== undefined) n.finalText = mkFact(p.lastAssistantMessage, 'hook', seqOf(ctx), nowOf(ctx));
  putTurn(ctx, n, 'stop');
  implicitFinalForTurn(ctx, t.key);
  interruptEvidence(ctx);
  if (t.state.value === 'interrupted' && t.state.provisional) {
    setTurnState(ctx, t.key, 'completed', { endedBy: 'stop', src: 'hook' }); // retract the provisional interrupt
    return;
  }
  setTurnState(ctx, t.key, 'stopping');
  arm(ctx, 'stopGrace', t.key, nowOf(ctx) + cfg(ctx).timeouts.stopGraceMs);
}

/** stopGrace / turn_duration grace / transcript API-error grace (§4.4#11, #18, #20). */
export function onStopGraceDeadline(ctx: Ctx, ref: string): void {
  const t = cfg(ctx).timeouts;
  if (ref.startsWith('dur:')) {
    const k = ref.slice(4) as TurnKey;
    const turn = turnRec(ctx, k);
    // the evidence is the transcript's turn_duration; stopGrace only waited for a Stop that never came (K-20)
    if (turn?.state.value === 'running') setTurnState(ctx, k, 'completed', { endedBy: 'turn_duration', src: 'transcript' });
    return;
  }
  if (ref.startsWith('apierr:')) {
    const k = ref.slice(7) as TurnKey;
    const turn = turnRec(ctx, k);
    if (turn !== undefined && (turn.state.value === 'running' || turn.state.value === 'stopping')) {
      setTurnState(ctx, k, 'failed', {
        endedBy: 'stop_failure',
        error: turn.error ?? err('E_TURN_API_ERROR', 'API error recorded in the transcript'),
      });
    }
    return;
  }
  const k = ref as TurnKey;
  const turn = turnRec(ctx, k);
  if (turn?.state.value !== 'stopping') return;
  setTurnState(ctx, k, 'completed', { endedBy: 'stop', src: 'hook' });
  arm(ctx, 'lateText', k, nowOf(ctx) + t.lateTextMs);
  // forged-Stop guard (K-32): the queue drains only after turn_duration or a done-line/idle screen corroborates
  if (turn.durationMs === undefined) {
    updRecon(ctx, (r) => ({ ...r, stopUncorroborated: k }));
    arm(ctx, 'transcriptSettle', k, nowOf(ctx) + t.transcriptSettleMs);
  }
}

/** Corroboration of a Stop-completed turn (turn_duration, done line, idle main screen). */
export function corroborateStop(ctx: Ctx): void {
  if (recon(ctx).stopUncorroborated === undefined) return;
  const k = recon(ctx).stopUncorroborated;
  updRecon(ctx, (r) => {
    const n = { ...r };
    delete n.stopUncorroborated;
    return n;
  });
  if (k !== undefined) disarm(ctx, 'transcriptSettle', k);
}

export function onTranscriptSettle(ctx: Ctx, ref: string): void {
  if (recon(ctx).stopUncorroborated === ref) {
    diag(ctx, 'stop_uncorroborated', { turn: ref });
    corroborateStop(ctx);
  }
}

export function stopFailureError(error: string, text: string): CcdErrorData {
  const code: CcdErrorCode =
    error === 'rate_limit'
      ? 'E_USAGE_LIMIT'
      : error === 'authentication_failed' || error === 'oauth_org_not_allowed'
        ? 'E_AUTH_REQUIRED'
        : error === 'claude_code_version_too_old' || /version.{0,40}(too old|no longer supported|outdated)/i.test(text)
          ? 'E_CLAUDE_VERSION_TOO_OLD'
          : 'E_TURN_API_ERROR';
  return err(code, text === '' ? error : text, { error });
}

/** StopFailure (§4.4#12). */
export function onTurnFailed(ctx: Ctx, o: Extract<Observation, { kind: 'turn.failed' }>): void {
  const p = o.p;
  const t = mainTurn(ctx) ?? turnByPromptId(ctx, p.promptId);
  captureNow(ctx, 'stopFailure');
  if (t === undefined) {
    diag(ctx, 'stop_failure_without_turn', { error: p.error });
    return;
  }
  let e = stopFailureError(p.error, p.errorDetails ?? p.message ?? '');
  if (e.code === 'E_TURN_API_ERROR' && t.refused !== undefined) e = err('E_TURN_REFUSED', e.message, { error: p.error });
  disarm(ctx, 'stopGrace', `apierr:${t.key}`);
  setTurnState(ctx, t.key, 'failed', { endedBy: 'stop_failure', error: e });
}

/**
 * The turn a turn-level transcript line (turn_duration, the synthetic API-error stand-in) belongs to — never simply the
 * active one. The line is bound by its prompt chain (`promptId`, the file's current prompt when it was written). Without a
 * binding, a turn that already had its Stop (or StopFailure) and ended within transcriptSettle with no such line yet comes
 * first: the line is written after the Stop hook and reaches us a tail poll late, when Claude may already have started the
 * next queued prompt (K-25). A turn whose own promptId differs from the line's is never chosen. ICR 0021 item 1.
 */
function turnOfTurnLine(ctx: Ctx, promptId: string | undefined, endedBy: 'stop' | 'stop_failure'): TurnRecord | undefined {
  const byId = turnByPromptId(ctx, promptId);
  if (byId !== undefined) return byId;
  const fits = (t: TurnRecord): boolean => promptId === undefined || t.promptId === undefined || t.promptId === promptId;
  const active = mainTurn(ctx);
  if (active?.state.value === 'stopping' && fits(active)) return active;
  const d = dom(ctx);
  const settle = cfg(ctx).timeouts.transcriptSettleMs;
  for (let i = d.turnOrder.length - 1, n = 0; i >= 0 && n < 16; i--, n++) {
    const t = turnRec(ctx, d.turnOrder[i]);
    if (t === undefined || t.key === active?.key || t.mergedInto !== undefined || !fits(t)) continue;
    if (t.endedAt === undefined || nowOf(ctx) - t.endedAt > settle) continue;
    const ended = endedBy === 'stop' ? t.state.value === 'completed' && t.durationMs === undefined : t.state.value === 'failed';
    if (ended && t.endedBy === endedBy) return t;
  }
  const fallback = active ?? mainTurn(ctx, true);
  return fallback !== undefined && fits(fallback) ? fallback : undefined;
}

/** transcript turn_duration (§4.4#15): ends its turn when no Stop came within stopGrace; corroborates a Stop otherwise. */
export function onTurnDuration(ctx: Ctx, o: Extract<Observation, { kind: 'turn.durationRecorded' }>): void {
  if (fromAgentFile(o)) {
    diag(ctx, 'agent_turn_line_ignored', { kind: o.kind, agentId: o.meta.agentId ?? null });
    return;
  }
  const t = turnOfTurnLine(ctx, o.p.promptId, 'stop');
  if (t === undefined) {
    diag(ctx, 'turn_duration_without_turn', { promptId: o.p.promptId ?? null });
    return;
  }
  if (t.durationMs === undefined) putTurn(ctx, { ...t, durationMs: o.p.durationMs }, 'duration');
  if (recon(ctx).stopUncorroborated === t.key) corroborateStop(ctx);
  if (dom(ctx).activeTurn === t.key && t.state.value === 'running')
    arm(ctx, 'stopGrace', `dur:${t.key}`, nowOf(ctx) + cfg(ctx).timeouts.stopGraceMs);
}

/**
 * Main-thread work (PreToolUse, a MessageDisplay delta, a model request, an assistant block) shows the active turn is still
 * going: a pending turn_duration grace for it can only have come from a line that was not its own. ICR 0021 item 1.
 */
export function noteMainActivity(ctx: Ctx, agentId: string | undefined): void {
  const k = dom(ctx).activeTurn;
  if (agentId !== undefined || k === undefined || recon(ctx).deadlines[`stopGrace:dur:${k}`] === undefined) return;
  disarm(ctx, 'stopGrace', `dur:${k}`);
  diag(ctx, 'turn_duration_grace_disarmed', { turn: k });
}

/** transcript interrupt markers (§4.4#13): confirmed interrupt; tool_use marker → endedBy tool_use_interrupt. */
export function onTurnInterrupted(ctx: Ctx, o: Extract<Observation, { kind: 'turn.interrupted' }>): void {
  if (fromAgentFile(o)) {
    diag(ctx, 'agent_turn_line_ignored', { kind: o.kind, agentId: o.meta.agentId ?? null });
    return;
  }
  const p = o.p;
  const t = turnByPromptId(ctx, p.promptId) ?? mainTurn(ctx) ?? mainTurn(ctx, true);
  if (t === undefined) return;
  const endedBy = p.marker === 'tool_use' ? 'tool_use_interrupt' : 'interrupt';
  const v = setTurnState(ctx, t.key, 'interrupted', { endedBy, src: 'transcript' });
  if (v !== 'ignore') {
    confirmClaim(ctx, 'interruptedBanner');
    arm(ctx, 'interruptedHold', t.key, nowOf(ctx) + cfg(ctx).timeouts.interruptedHoldMs);
  }
  disarm(ctx, 'interruptConfirm', `turn:${t.key}`);
  interruptEvidence(ctx);
}

/** screen interruptedBanner claim asserted (§4.4#14): provisional interrupted; the turn stays active until confirmed. */
export function onInterruptBanner(ctx: Ctx): void {
  const t = mainTurn(ctx);
  if (t === undefined || (t.state.value !== 'running' && t.state.value !== 'stopping')) return;
  setTurnState(ctx, t.key, 'interrupted', { endedBy: 'interrupt', provisional: true, keepActive: true, src: 'screen' });
  arm(ctx, 'interruptConfirm', `turn:${t.key}`, nowOf(ctx) + cfg(ctx).timeouts.interruptConfirmMs);
  interruptEvidence(ctx);
}

export function onTurnInterruptConfirmDeadline(ctx: Ctx, k: TurnKey): void {
  releaseHeldTurn(ctx, k);
  const t = turnRec(ctx, k);
  if (t?.state.value === 'interrupted') arm(ctx, 'interruptedHold', k, nowOf(ctx) + cfg(ctx).timeouts.interruptedHoldMs);
}

/** transcript synthetic isApiErrorMessage (§4.4#20): fail after stopGrace unless a StopFailure arrives. */
/**
 * A line of a subagent (sidechain) transcript file. Its user entries carry the spawning prompt's promptId, which the
 * normalizer stamps onto the file's turn lines, but "prompt_id never assigns subagent work to a turn" (reconciliation.md,
 * §4.5): a subagent's API error, interrupt marker or turn_duration never ends the main turn.
 */
function fromAgentFile(o: Observation): boolean {
  return o.meta.agentId !== undefined || (o.meta.origin?.kind === 'transcript' && o.meta.origin.sidechain);
}

export function onApiErrorRecorded(ctx: Ctx, o: Extract<Observation, { kind: 'model.apiErrorRecorded' }>): void {
  if (fromAgentFile(o)) {
    diag(ctx, 'agent_turn_line_ignored', { kind: o.kind, agentId: o.meta.agentId ?? null });
    return;
  }
  const t = turnOfTurnLine(ctx, o.p.promptId, 'stop_failure');
  if (t === undefined || isTurnTerminal(t.state.value)) return; // a late line of a turn that already ended (ICR 0021)
  const e = stopFailureError(o.p.error, o.p.text);
  putTurn(ctx, { ...t, error: e }, 'api error recorded');
  arm(ctx, 'stopGrace', `apierr:${t.key}`, nowOf(ctx) + cfg(ctx).timeouts.stopGraceMs);
}

// ------------------------------------------------------------------ job outcomes
export function onSubmitStarted(ctx: Ctx, turn: TurnKey, attempt: number, method: 'editor' | 'pasteChunks'): void {
  setTurnState(ctx, turn, 'submitting', { src: 'self' });
  publish(ctx, 'turn.submitting', { attempt, method }, { turnKey: turn, confirmed: true, sources: ['self'] });
}

export function onSubmitFailed(ctx: Ctx, turn: TurnKey, error: CcdErrorData, clearComposer: boolean): void {
  removeFromQueue(ctx, turn);
  setTurnState(ctx, turn, 'notSubmitted', { endedBy: 'submit_failed', error, src: 'self' });
  if (clearComposer) enqueueClear(ctx, 'keys');
}

export function onSubmitAcceptedByTranscript(ctx: Ctx, job: InputJobKey, turn: TurnKey, promptId: string | undefined): void {
  const t = turnRec(ctx, turn);
  if (t === undefined) return;
  addReason(ctx, 'hooks', 'hookGap:UserPromptSubmit');
  mergePlaceholder(ctx, turn, promptId);
  const n: TurnRecord = { ...(turnRec(ctx, turn) ?? t), acceptedAt: nowOf(ctx) };
  if (promptId !== undefined && promptId !== '') n.promptId = promptId;
  putTurn(ctx, n, 'accepted by transcript');
  setTurnState(ctx, turn, 'running', { src: 'transcript' });
  aliasPrompt(ctx, promptId, turn);
  removeFromQueue(ctx, turn);
  setActiveTurn(ctx, turn, 'accepted by transcript');
  publish(ctx, 'turn.accepted', { promptId: promptId ?? '' }, { turnKey: turn, confirmed: false });
  diag(ctx, 'accepted_by_transcript', { job, turn });
}

/** prompt.cancel: only while still queued (§2.6). */
export function cancelQueuedTurn(ctx: Ctx, k: TurnKey): boolean {
  const t = turnRec(ctx, k);
  if (t?.state.value !== 'queued' || !dom(ctx).libraryQueue.includes(k)) return false;
  removeFromQueue(ctx, k);
  setTurnState(ctx, k, 'aborted', { endedBy: 'library_abort', error: err('E_TURN_ABORTED', 'cancelled before submission'), src: 'self' });
  return true;
}
