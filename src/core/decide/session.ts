// core/decide/session.ts — lifecycle, generations, readiness, gates, auth, exit, self-test, close, screen frames
// (DESIGN.md §4.3, §3.1 steps 14–15, §3.8, §4.6 Claims effects; LV Q4/Q5; RC §7.1 implicit generations).

import type { Command } from '../../model/commands.js';
import type { CcdErrorData } from '../../model/errors.js';
import type { GenKey } from '../../model/ids.js';
import type { JsonValue } from '../../model/json.js';
import type { Observation } from '../../model/observation.js';
import type { ScreenFacts, StartupGateKind } from '../../model/screen-facts.js';
import type { Generation, PermissionMode, SessionState } from '../../model/state.js';
import type { MonoMs } from '../../model/time.js';
import { confirmClaim, isIdleMain, updateClaims } from '../claims.js';
import type { ClaimDelta } from '../claims.js';
import { checkDrainPending, closeProcess, endGenerationEntities } from '../closing.js';
import {
  arm,
  captureNow,
  cfg,
  diag,
  disarm,
  dom,
  emit,
  mint,
  nowOf,
  patch,
  publish,
  recon,
  seqOf,
  setInputState,
  setLifecycle,
  updRecon,
  inputState,
} from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { mergeFact, mkFact, rank } from '../facts.js';
import { commandJob, selftestJob } from '../input-policy/jobs.js';
import {
  abortAllJobs,
  commandEvidence,
  currentJob,
  enqueueJob,
  modeObserved,
  onFrameForJobs,
  selftestDisarmed,
} from '../input-policy/machine.js';
import { isTurnTerminal } from '../lattice.js';
import { isRecord } from '../reconcile/canonical.js';
import { backgroundCount } from '../selectors.js';
import { addReason, clearReason } from './channels.js';
import { genOfSession, genRec, mainTurn, putGen, setTurnState } from './entities.js';
import { MODAL_CLAIMS, onFrameForInputs, onModalClaimAsserted, onModalClaimEnded } from './inputs-requested.js';
import { onRetryClaim, onStallClaim, settleScreenCallStates } from './model-calls.js';
import { adoptionBlocked, denyAllHeld, onPermissionDialogAsserted, onPermissionDialogGone, permissionDialogShown } from './permissions.js';
import { corroborateStop, onInterruptBanner } from './turns.js';
import { markLimited, onRetryResetClaim, onUsageLimitClaim, resetUsageOnExit } from './usage.js';

const PRE_READY: ReadonlySet<SessionState['lifecycle']> = new Set(['preflight', 'launching', 'awaitingReady', 'gated', 'selfTest']);
const GATE_CLAIMS: Readonly<Record<string, StartupGateKind | 'fromValue'>> = {
  'surface:trustDialog': 'trust',
  'dialog:trust': 'trust',
  'surface:resumeDialog': 'resumeDialog',
  'dialog:resume': 'resumeDialog',
  'surface:startupGate': 'fromValue',
  'dialog:gate': 'fromValue',
};
const PERMISSION_CLAIMS = new Set(['surface:permissionDialog', 'dialog:permission', 'dialog:question', 'dialog:planApproval']);
const MAX_NONCES = 8;

// ------------------------------------------------------------------ process
export function onProcessLaunched(ctx: Ctx, o: Extract<Observation, { kind: 'process.launched' }>): void {
  const p = o.p;
  patch(
    ctx,
    ['claude'],
    { ...dom(ctx).claude, pid: p.pid, paneId: p.paneId, version: p.claudeVersion !== '' ? p.claudeVersion : dom(ctx).claude.version },
    'launched',
  );
  if (dom(ctx).lifecycle !== 'preflight') {
    diag(ctx, 'launched_twice', { lifecycle: dom(ctx).lifecycle });
    return;
  }
  setLifecycle(ctx, 'launching');
  const l = recon(ctx).launch;
  publish(ctx, 'session.launching', {
    cwd: l.cwdRealpath,
    claudeVersion: dom(ctx).claude.version,
    claudeSessionId: l.sessionId,
    resume: l.resume,
  });
  const t = cfg(ctx).timeouts;
  arm(ctx, 'startupHookGrace', 'startup', nowOf(ctx) + t.startupHookGraceMs);
  arm(ctx, 'startup', 'startup', nowOf(ctx) + t.startupMs);
}

function exitReason(
  ctx: Ctx,
  p: Extract<Observation, { kind: 'process.exited' }>['p'],
): 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone' {
  if (p.byOwnerWatch === true) return 'ownerGone';
  const lc = dom(ctx).lifecycle;
  if (lc === 'closing') return 'closed';
  if (PRE_READY.has(lc)) return 'startupFailed';
  if (p.exitStatus === 129 || p.signal === 'SIGHUP') return 'hangup';
  if (p.signal !== null) return 'killed';
  if (p.exitStatus === 0) return 'exitedByItself';
  return 'crashed';
}

export function onProcessExited(ctx: Ctx, o: Extract<Observation, { kind: 'process.exited' }>): void {
  const p = o.p;
  const prev = dom(ctx).exit;
  if (prev !== undefined) {
    // already finalized (self-test failure, startup timeout): only record the real status
    patch(ctx, ['exit'], { ...prev, exitStatus: p.exitStatus, signal: p.signal }, 'exit status');
    return;
  }
  const reason = exitReason(ctx, p);
  finalizeExit(ctx, { exitStatus: p.exitStatus, signal: p.signal, reason });
}

function finalizeExit(
  ctx: Ctx,
  e: {
    exitStatus: number | null;
    signal: string | null;
    reason: 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone';
  },
  finalizeReason?: string,
): void {
  if (dom(ctx).exit !== undefined) return;
  resetUsageOnExit(ctx);
  patch(ctx, ['exit'], { exitStatus: e.exitStatus, signal: e.signal, reason: e.reason }, 'exited');
  setLifecycle(ctx, 'exited');
  closeProcess(ctx, finalizeReason ?? e.reason);
  publish(ctx, 'session.exited', { exitStatus: e.exitStatus, signal: e.signal, reason: e.reason }, { sources: ['process'] });
}

export function onIdentityMismatch(ctx: Ctx, o: Extract<Observation, { kind: 'process.identityMismatch' }>): void {
  publish(ctx, 'warning', {
    code: 'E_INVARIANT',
    message: 'pane pid changed (Claude relaunched in place); the pane is killed',
    detail: { reason: 'identityMismatch', pid: o.p.pid },
  });
  emit<'process.signal'>(ctx, { kind: 'process.signal', signal: 'SIGKILL' });
  finalizeExit(ctx, { exitStatus: null, signal: null, reason: 'killed' }, 'identityMismatch');
}

// ------------------------------------------------------------------ generations
function sourceReason(src: string): 'startup' | 'clear' | 'resume' | 'fork' | 'unknown' {
  return src === 'startup' || src === 'clear' || src === 'resume' || src === 'fork' ? src : 'unknown';
}

function newGeneration(
  ctx: Ctx,
  sessionId: string,
  f: { startedBy: Generation['startedBy']; status: Generation['status']; source?: string; transcriptPath?: string },
): GenKey {
  const key = mint(ctx, 'gen');
  const g: Generation = { key, sessionId, status: f.status, startedBy: f.startedBy, startedAt: nowOf(ctx) };
  if (f.source !== undefined) g.source = f.source;
  if (f.transcriptPath !== undefined && f.transcriptPath !== '') g.transcriptPath = f.transcriptPath;
  putGen(ctx, g, 'generation');
  updRecon(ctx, (r) => ({ ...r, aliases: { ...r.aliases, sessionId: { ...r.aliases.sessionId, [sessionId]: key } } }));
  return key;
}

function endGeneration(ctx: Ctx, gen: GenKey, reason: string): void {
  const g = genRec(ctx, gen);
  if (g === undefined || g.status === 'ended') return;
  putGen(ctx, { ...g, status: 'ended', endReason: reason }, 'generation ended');
  endGenerationEntities(ctx, gen, 'session_end');
}

function switchTo(ctx: Ctx, gen: GenKey, reason: 'startup' | 'clear' | 'resume' | 'fork' | 'continuedIn' | 'implicit' | 'unknown'): void {
  const d = dom(ctx);
  const prev = d.claude.currentGen;
  const g = genRec(ctx, gen);
  if (g === undefined || prev === gen) return;
  const from = prev === undefined ? undefined : genRec(ctx, prev)?.sessionId;
  if (prev !== undefined) endGeneration(ctx, prev, `superseded:${reason}`);
  const claude: SessionState['claude'] = { ...dom(ctx).claude, currentGen: gen, sessionId: g.sessionId };
  if (g.transcriptPath !== undefined) claude.transcriptPath = g.transcriptPath;
  patch(ctx, ['claude'], claude, 'current generation');
  const ev: { from?: string; to: string; gen: GenKey; reason: typeof reason } = { to: g.sessionId, gen, reason };
  if (from !== undefined) ev.from = from;
  publish(ctx, 'session.generationChanged', ev, { gen });
  const rp: { claudeSessionId: string; transcriptPath?: string } = { claudeSessionId: g.sessionId };
  if (g.transcriptPath !== undefined) rp.transcriptPath = g.transcriptPath;
  emit<'registry.persist'>(ctx, { kind: 'registry.persist', patch: rp });
}

function observePath(ctx: Ctx, gen: GenKey, path: string, source: string, fromStart: boolean): void {
  const g = genRec(ctx, gen);
  if (g === undefined || path === '') return;
  if (g.transcriptPath !== path) {
    putGen(ctx, { ...g, transcriptPath: path }, 'transcript path');
    if (dom(ctx).claude.currentGen === gen) patch(ctx, ['claude', 'transcriptPath'], path, 'transcript path');
  }
  if (fromStart) emit<'tail.followMain'>(ctx, { kind: 'tail.followMain', sessionId: g.sessionId, path, startAt: 'beginning' });
  else emit<'tail.observePath'>(ctx, { kind: 'tail.observePath', sessionId: g.sessionId, path, source });
}

/** SessionStart (command hook): startup/resume → awaitingReady; clear → new generation; compact → no new generation. */
export function onSessionStarted(ctx: Ctx, o: Extract<Observation, { kind: 'session.started' }>): void {
  const p = o.p;
  captureNow(ctx, 'sessionStart');
  if (p.model !== undefined) setModel(ctx, p.model, 'hook', true);
  const known = genOfSession(ctx, p.sessionId);
  if (p.source === 'compact') {
    if (known === undefined && dom(ctx).claude.currentGen !== undefined) {
      const cur = dom(ctx).claude.currentGen;
      if (cur !== undefined)
        updRecon(ctx, (r) => ({ ...r, aliases: { ...r.aliases, sessionId: { ...r.aliases.sessionId, [p.sessionId]: cur } } }));
    }
    commandEvidence(ctx, { kind: 'sessionStart', source: 'compact' });
    return;
  }
  const lc = dom(ctx).lifecycle;
  let gen = known;
  if (gen === undefined) {
    gen = newGeneration(ctx, p.sessionId, {
      startedBy: 'SessionStart',
      status: 'active',
      source: p.source,
      transcriptPath: p.transcriptPath,
    });
    const reason = dom(ctx).claude.currentGen === undefined ? (recon(ctx).launch.resume ? 'resume' : 'startup') : sourceReason(p.source);
    switchTo(ctx, gen, reason);
    const replayHistory = (p.source === 'resume' || p.source === 'fork') && lc === 'ready';
    observePath(ctx, gen, p.transcriptPath, p.source, replayHistory);
  } else {
    const g = genRec(ctx, gen);
    if (g?.status === 'implicit') {
      putGen(ctx, { ...g, status: 'active', startedBy: 'SessionStart', source: p.source }, 'generation confirmed');
      disarm(ctx, 'genImplicitConfirm', gen);
      clearReason(ctx, 'hooks', (r) => r === `noSessionStart:${gen}`);
    }
    if (dom(ctx).claude.currentGen !== gen) switchTo(ctx, gen, sourceReason(p.source));
    observePath(ctx, gen, p.transcriptPath, p.source, false);
  }
  if (
    (p.source === 'startup' || p.source === 'resume') &&
    p.sessionId !== recon(ctx).launch.sessionId &&
    !recon(ctx).launch.resume &&
    PRE_READY.has(lc)
  ) {
    publish(ctx, 'warning', {
      code: 'E_INVARIANT',
      message: 'SessionStart reported an unexpected session id; using it',
      detail: { reason: 'unexpectedSessionId', sessionId: p.sessionId },
    });
  }
  if (lc === 'launching') {
    setLifecycle(ctx, 'awaitingReady');
    disarm(ctx, 'startupHookGrace', 'startup');
    maybeArmReady(ctx);
  }
  commandEvidence(ctx, { kind: 'sessionStart', source: p.source });
}

export function onSessionEnded(ctx: Ctx, o: Extract<Observation, { kind: 'session.ended' }>): void {
  const gen = genOfSession(ctx, o.p.sessionId) ?? dom(ctx).claude.currentGen;
  commandEvidence(ctx, { kind: 'sessionEnd', reason: o.p.reason });
  if (gen === undefined) return;
  endGeneration(ctx, gen, o.p.reason);
}

/** Any hook carrying an unseen session_id → implicit generation (the only place session ids are judged, §4.3#11). */
export function onHookSessionId(ctx: Ctx, o: Observation): void {
  if (o.meta.source !== 'hook' || o.kind === 'session.started' || o.kind === 'session.ended') return;
  const sid = o.meta.claudeSessionId;
  if (sid === undefined || sid === '' || genOfSession(ctx, sid) !== undefined) return;
  if (dom(ctx).lifecycle === 'exited') return;
  const gen = newGeneration(ctx, sid, { startedBy: 'implicit', status: 'implicit' });
  arm(ctx, 'genImplicitConfirm', gen, nowOf(ctx) + cfg(ctx).timeouts.genImplicitConfirmMs);
  switchTo(ctx, gen, 'implicit');
}

export function onGenImplicitConfirm(ctx: Ctx, gen: string): void {
  const g = genRec(ctx, gen as GenKey);
  if (g?.status !== 'implicit') return;
  diag(ctx, 'no_session_start', { gen });
  addReason(ctx, 'hooks', `noSessionStart:${gen}`);
}

export function onContinuedIn(ctx: Ctx, o: Extract<Observation, { kind: 'transcript.continuedIn' }>): void {
  const sid = o.p.continuedInSessionId;
  if (genOfSession(ctx, sid) !== undefined) return;
  const gen = newGeneration(ctx, sid, { startedBy: 'implicit', status: 'implicit' });
  arm(ctx, 'genImplicitConfirm', gen, nowOf(ctx) + cfg(ctx).timeouts.genImplicitConfirmMs);
  switchTo(ctx, gen, 'continuedIn');
}

export function onRelocated(ctx: Ctx, o: Extract<Observation, { kind: 'transcript.relocated' }>): void {
  const gen = genOfSession(ctx, o.p.sessionId);
  const g = genRec(ctx, gen);
  if (g === undefined || gen === undefined) return;
  putGen(ctx, { ...g, transcriptPath: o.p.newPath }, 'relocated');
  if (dom(ctx).claude.currentGen === gen) patch(ctx, ['claude', 'transcriptPath'], o.p.newPath, 'relocated');
}

// ------------------------------------------------------------------ model / mode facts
function setModel(ctx: Ctx, model: string, src: 'hook' | 'transcript' | 'screen', fromSessionStart = false): boolean {
  const cur = dom(ctx).claude.model;
  if (cur?.value === model) return false;
  if (fromSessionStart && cur !== undefined) return false; // SessionStart model is the lowest model authority (§4.1)
  patch(ctx, ['claude', 'model'], mkFact(model, src, seqOf(ctx), nowOf(ctx)), 'model');
  return true;
}

export function onModelSwitched(ctx: Ctx, o: Extract<Observation, { kind: 'model.switched' }>): void {
  setModel(ctx, o.p.toModel, 'hook');
  const ev: { model: string; source?: string } = { model: o.p.toModel, source: 'switch' };
  publish(ctx, 'session.modelChanged', ev);
  commandEvidence(ctx, { kind: 'modelSwitched' });
}

const MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);

export function onModeObserved(ctx: Ctx, mode: string, src: 'hook' | 'transcript' | 'screen'): void {
  if (!MODES.has(mode)) return;
  const m = mode as PermissionMode;
  const cur = dom(ctx).claude.permissionMode;
  if (src === 'screen' && cur !== undefined && cur.src !== 'screen') return; // the footer is provisional only
  const r = mergeFact(cur, m, src, seqOf(ctx), nowOf(ctx), rank('transcript'));
  if (src === 'hook' || src === 'transcript') {
    // last-wins between hook and transcript (the mode cycles); hooks win ties
    if (cur?.value !== m) {
      patch(ctx, ['claude', 'permissionMode'], mkFact(m, src, seqOf(ctx), nowOf(ctx)), 'mode');
      publish(ctx, 'session.modeChanged', { mode: m });
    }
    if (src === 'hook') modeObserved(ctx, m);
    return;
  }
  if (r.changed) {
    patch(ctx, ['claude', 'permissionMode'], r.fact, 'mode (screen)');
    publish(ctx, 'session.modeChanged', { mode: m }, { confirmed: false });
  }
}

// ------------------------------------------------------------------ auth
export function authRequired(ctx: Ctx, message: string): void {
  if (dom(ctx).auth.state === 'required') return;
  patch(ctx, ['auth'], { state: 'required', message, since: nowOf(ctx), polling: true }, 'auth required');
  publish(ctx, 'session.authRequired', { message });
}

function authRestored(ctx: Ctx): void {
  if (dom(ctx).auth.state !== 'required') return;
  patch(ctx, ['auth'], { state: 'ok', polling: false }, 'auth restored');
  publish(ctx, 'session.authRestored', {});
}

export function onAuthStatus(ctx: Ctx, o: Extract<Observation, { kind: 'auth.status' }>): void {
  const p = o.p;
  if (p.apiProvider !== undefined && p.apiProvider !== 'firstParty') {
    publish(ctx, 'warning', {
      code: 'E_API_PROVIDER_UNSUPPORTED',
      message: `apiProvider changed to ${p.apiProvider}; billing moved off the subscription`,
      detail: { apiProvider: p.apiProvider },
    });
    if (dom(ctx).lifecycle !== 'exited' && dom(ctx).lifecycle !== 'closing') {
      beginClosing(ctx, 'apiProviderChanged');
      emit<'process.signal'>(ctx, { kind: 'process.signal', signal: 'SIGTERM' });
    }
    return;
  }
  if (p.loggedIn) authRestored(ctx);
  else authRequired(ctx, 'not logged in');
}

// ------------------------------------------------------------------ readiness and startup deadlines
function maybeArmReady(ctx: Ctx): void {
  if (dom(ctx).lifecycle !== 'awaitingReady') return;
  const f = recon(ctx).lastFrame;
  if (isIdleMain(f)) {
    if (recon(ctx).deadlines['readyStable:ready'] === undefined)
      arm(ctx, 'readyStable', 'ready', (recon(ctx).lastFrameAt ?? nowOf(ctx)) + cfg(ctx).timeouts.readyStableMs);
  } else disarm(ctx, 'readyStable', 'ready');
}

export function onStartupHookGrace(ctx: Ctx): void {
  updRecon(ctx, (r) => ({ ...r, hookGraceFired: true }));
  if (dom(ctx).lifecycle !== 'launching') return;
  captureNow(ctx, 'startupHookGrace');
  if (isIdleMain(recon(ctx).lastFrame)) degradedReadiness(ctx);
}

function degradedReadiness(ctx: Ctx): void {
  addReason(ctx, 'hooks', 'noSessionStart');
  setLifecycle(ctx, 'awaitingReady');
  maybeArmReady(ctx);
}

export function onStartupTimeout(ctx: Ctx): void {
  const lc = dom(ctx).lifecycle;
  if (!PRE_READY.has(lc)) return;
  const f = recon(ctx).lastFrame;
  publish(ctx, 'warning', {
    code: 'E_STARTUP_TIMEOUT',
    message: `no readiness within ${cfg(ctx).timeouts.startupMs} ms`,
    detail: { phase: lc, screenSummary: f?.surface ?? 'none' },
  });
  finalizeExit(ctx, { exitStatus: null, signal: null, reason: 'startupFailed' }, 'E_STARTUP_TIMEOUT');
}

export function onReadyStable(ctx: Ctx): void {
  if (dom(ctx).lifecycle !== 'awaitingReady') return;
  if (!isIdleMain(recon(ctx).lastFrame)) return;
  enterSelfTest(ctx);
}

function enterSelfTest(ctx: Ctx): void {
  setLifecycle(ctx, 'selfTest');
  if (cfg(ctx).selfTest === 'off') {
    patch(ctx, ['selfTest'], { state: 'skipped' }, 'self-test off');
    ready(ctx, 'skipped');
    return;
  }
  const pending = recon(ctx).pendingSelfTest;
  if (pending !== undefined) {
    updRecon(ctx, (r) => {
      const n = { ...r };
      delete n.pendingSelfTest;
      return n;
    });
    runSelfTest(ctx, pending.nonce, pending.cachedPass);
  }
}

function ready(ctx: Ctx, selfTest: 'passed' | 'cached' | 'skipped'): void {
  setLifecycle(ctx, 'ready');
  disarm(ctx, 'startup', 'startup');
  const d = dom(ctx);
  const ev: {
    permissionMode: PermissionMode;
    model?: string;
    selfTest: typeof selfTest;
    resumed: boolean;
    hookTransport: 'http' | 'unix';
  } = {
    permissionMode: d.claude.permissionMode?.value ?? 'default',
    selfTest,
    resumed: recon(ctx).launch.resume,
    hookTransport: recon(ctx).hookTransport ?? 'http',
  };
  if (d.claude.model !== undefined) ev.model = d.claude.model.value;
  publish(ctx, 'session.ready', ev);
  const rp: { state: 'idle'; claudeSessionId?: string; transcriptPath?: string } = { state: 'idle' };
  if (d.claude.sessionId !== undefined) rp.claudeSessionId = d.claude.sessionId;
  if (d.claude.transcriptPath !== undefined) rp.transcriptPath = d.claude.transcriptPath;
  emit<'registry.persist'>(ctx, { kind: 'registry.persist', patch: rp });
}

// ------------------------------------------------------------------ self-test (§3.1 step 15, D-35)
export function onSelfTestRun(ctx: Ctx, cmd: Extract<Command, { type: 'selftest.run' }>): CcdErrorData | undefined {
  const lc = dom(ctx).lifecycle;
  if (lc === 'exited' || lc === 'closing') return { code: 'E_SESSION_CLOSED', message: 'session is closing' };
  if (lc === 'ready') return undefined;
  if (lc !== 'selfTest') {
    updRecon(ctx, (r) => ({ ...r, pendingSelfTest: { nonce: cmd.nonce, cachedPass: cmd.cachedPass } }));
    return undefined;
  }
  runSelfTest(ctx, cmd.nonce, cmd.cachedPass);
  return undefined;
}

function runSelfTest(ctx: Ctx, nonce: string, cachedPass: boolean): void {
  if (cachedPass) {
    patch(ctx, ['selfTest'], { state: 'cached' }, 'self-test cached');
    ready(ctx, 'cached');
    return;
  }
  if (cfg(ctx).selfTest === 'off') {
    patch(ctx, ['selfTest'], { state: 'skipped' }, 'self-test off');
    ready(ctx, 'skipped');
    return;
  }
  patch(ctx, ['selfTest'], { state: 'idle', nonce }, 'self-test arming');
  updRecon(ctx, (r) => ({ ...r, recentNonces: [...r.recentNonces.filter((n) => n !== nonce), nonce].slice(-MAX_NONCES) }));
  emit<'hook.armSelfTest'>(ctx, { kind: 'hook.armSelfTest', nonce });
}

export function onSelfTestArmed(ctx: Ctx, o: Extract<Observation, { kind: 'hook.selfTestArmed' }>): void {
  const st = dom(ctx).selfTest;
  if (!o.p.armed) {
    if (!selftestDisarmed(ctx)) diag(ctx, 'selftest_disarm_unexpected', { nonce: o.p.nonce });
    return;
  }
  if (st.nonce !== o.p.nonce || st.state !== 'idle' || dom(ctx).lifecycle !== 'selfTest') {
    diag(ctx, 'selftest_armed_unexpected', { nonce: o.p.nonce });
    return;
  }
  patch(ctx, ['selfTest'], { state: 'armed', nonce: o.p.nonce }, 'self-test armed');
  const key = mint(ctx, 'job');
  enqueueJob(ctx, selftestJob({ key, seq: ctx.core.counters.job, createdAt: nowOf(ctx) }, o.p.nonce, cfg(ctx).input.method), true);
}

export function onSelfTestPassed(ctx: Ctx): void {
  const nonce = dom(ctx).selfTest.nonce;
  patch(ctx, ['selfTest'], nonce === undefined ? { state: 'passed' } : { state: 'passed', nonce }, 'self-test passed');
  ready(ctx, 'passed');
}

export function onSelfTestFailed(ctx: Ctx, step: string, transcriptEvidence: boolean, e: CcdErrorData): void {
  const nonce = dom(ctx).selfTest.nonce;
  patch(ctx, ['selfTest'], nonce === undefined ? { state: 'failed' } : { state: 'failed', nonce }, 'self-test failed');
  emit<'hook.disarmSelfTest'>(ctx, { kind: 'hook.disarmSelfTest' });
  publish(ctx, 'warning', {
    code: 'E_SELFTEST_FAILED',
    message: e.message,
    detail: { step, transcriptEvidence, hookTransport: recon(ctx).hookTransport ?? 'http' },
  });
  finalizeExit(ctx, { exitStatus: null, signal: null, reason: 'startupFailed' }, 'E_SELFTEST_FAILED');
}

// ------------------------------------------------------------------ close (§3.8)
function beginClosing(ctx: Ctx, reason: string): void {
  setLifecycle(ctx, 'closing');
  publish(ctx, 'session.closing', { reason });
  disarm(ctx, 'usageWake', 'limit');
}

export function onSessionClose(ctx: Ctx, cmd: Extract<Command, { type: 'session.close' }>): void {
  const lc = dom(ctx).lifecycle;
  if (lc === 'exited' || lc === 'closing' || recon(ctx).closePending !== undefined) return;
  const wait = cmd.waitForBackgroundMs ?? 0;
  if (wait > 0 && cmd.mode === 'graceful' && backgroundCount(dom(ctx)) > 0) {
    updRecon(ctx, (r) => ({ ...r, closePending: { mode: cmd.mode, reason: cmd.reason, until: (nowOf(ctx) + wait) as MonoMs } }));
    arm(ctx, 'drain', 'close', nowOf(ctx) + wait);
    return;
  }
  proceedClose(ctx, cmd.mode, cmd.reason);
}

/** Step end / drain('close'): a pending close proceeds once quiescent or when waitForBackgroundMs ran out. */
export function checkPendingClose(ctx: Ctx, timedOut = false): void {
  const p = recon(ctx).closePending;
  if (p === undefined) return;
  if (!timedOut && backgroundCount(dom(ctx)) > 0) return;
  updRecon(ctx, (r) => {
    const n = { ...r };
    delete n.closePending;
    return n;
  });
  disarm(ctx, 'drain', 'close');
  proceedClose(ctx, p.mode, p.reason);
}

function proceedClose(ctx: Ctx, mode: 'graceful' | 'kill', reason: string): void {
  const wasReady = dom(ctx).lifecycle === 'ready';
  beginClosing(ctx, reason);
  denyAllHeld(ctx);
  // queued library turns never run
  abortAllJobs(ctx, 'close');
  for (const k of dom(ctx).libraryQueue) {
    const t = dom(ctx).turns[k];
    if (t !== undefined && !isTurnTerminal(t.state.value))
      setTurnState(ctx, k, 'aborted', {
        endedBy: 'library_abort',
        error: { code: 'E_SESSION_CLOSED', message: 'session closed' },
        src: 'self',
      });
  }
  if (dom(ctx).libraryQueue.length > 0) patch(ctx, ['libraryQueue'], [], 'close');
  if (mode === 'kill') {
    emit<'process.signal'>(ctx, { kind: 'process.signal', signal: 'SIGKILL' });
    return;
  }
  const f = recon(ctx).lastFrame;
  const clean = f === undefined || (f.surface === 'main' && (f.composer === undefined || f.composer.empty || f.composer.placeholderLikely));
  const idle = dom(ctx).activeTurn === undefined && !dom(ctx).inputBlocked.permission && permissionDialogShown(ctx) === undefined;
  if (idle && clean && wasReady && dom(ctx).exit === undefined) {
    const key = mint(ctx, 'job');
    enqueueJob(ctx, commandJob({ key, seq: ctx.core.counters.job, createdAt: nowOf(ctx) }, '/exit', undefined, 0, true), true);
    return;
  }
  emit<'process.signal'>(ctx, { kind: 'process.signal', signal: 'SIGTERM' });
}

export function onCloseExitFailed(ctx: Ctx): void {
  if (dom(ctx).exit !== undefined) return;
  emit<'process.signal'>(ctx, { kind: 'process.signal', signal: 'SIGTERM' });
}

// ------------------------------------------------------------------ screen frames
function gateOf(key: string, value: JsonValue): StartupGateKind {
  const kind = GATE_CLAIMS[key];
  if (kind !== undefined && kind !== 'fromValue') return kind;
  const g = isRecord(value) ? value['gate'] : undefined;
  return typeof g === 'string' ? (g as StartupGateKind) : 'other';
}

function gateText(value: JsonValue): string {
  if (!isRecord(value)) return '';
  for (const k of ['question', 'title', 'surface']) {
    const v = value[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

function authKindRequired(key: string): boolean {
  return key === 'auth:loginExpired' || key === 'auth:notLoggedIn' || key === 'auth:tokenRevoked';
}

/** Effects of claim transitions (§4.6 scope: the screen never creates or ends a Turn/ToolRun/Agent except provisional interrupted). */
export function applyClaimEffects(ctx: Ctx, delta: ClaimDelta): void {
  for (const c of delta.asserted) {
    const k = c.key;
    if (k in GATE_CLAIMS && (dom(ctx).lifecycle === 'launching' || dom(ctx).lifecycle === 'awaitingReady')) {
      const gate = gateOf(k, c.value);
      const text = gateText(c.value);
      setLifecycle(ctx, 'gated');
      patch(ctx, ['gate'], { kind: gate, text }, 'gated');
      publish(ctx, 'session.gated', { gate, text }, { confirmed: false, sources: ['screen'] });
      continue;
    }
    if (PERMISSION_CLAIMS.has(k)) {
      if (adoptionBlocked(ctx)) confirmClaim(ctx, k);
      else onPermissionDialogAsserted(ctx);
      continue;
    }
    if (MODAL_CLAIMS.includes(k)) {
      onModalClaimAsserted(ctx, k);
      continue;
    }
    switch (k) {
      case 'interruptedBanner':
        onInterruptBanner(ctx);
        break;
      case 'status:retrying':
        onRetryClaim(ctx, c.value);
        onRetryResetClaim(ctx, c.value);
        break;
      case 'status:stalled':
      case 'status:noResponse':
        onStallClaim(ctx);
        break;
      case 'status:done':
        corroborateStop(ctx);
        break;
      case 'usageLimit':
        onUsageLimitClaim(ctx, c.value);
        break;
      case 'surface:usageLimitMenu':
        markLimited(ctx, { source: 'screen' });
        break;
      case 'versionTooOld': {
        publish(
          ctx,
          'warning',
          { code: 'E_CLAUDE_VERSION_TOO_OLD', message: 'Claude reports its version is too old', detail: null },
          { confirmed: false },
        );
        const t = mainTurn(ctx);
        if (t !== undefined)
          setTurnState(ctx, t.key, 'failed', {
            endedBy: 'stop_failure',
            error: { code: 'E_CLAUDE_VERSION_TOO_OLD', message: 'Claude version too old' },
            src: 'screen',
          });
        break;
      }
      default:
        if (authKindRequired(k))
          authRequired(
            ctx,
            gateText(c.value) === '' && isRecord(c.value) && typeof c.value['line'] === 'string' ? c.value['line'] : 'login required',
          );
    }
  }
  for (const c of delta.updated) {
    if (c.key === 'status:retrying') onRetryClaim(ctx, c.value);
    else if (c.key === 'usageLimit') onUsageLimitClaim(ctx, c.value);
  }
  for (const c of delta.ended) {
    if (PERMISSION_CLAIMS.has(c.key) && permissionDialogShown(ctx) === undefined) onPermissionDialogGone(ctx);
    else if (MODAL_CLAIMS.includes(c.key)) onModalClaimEnded(ctx, c.key);
    else if (c.key === 'status:stalled' || c.key === 'status:noResponse' || c.key === 'status:retrying') settleScreenCallStates(ctx);
  }
}

export function onFrame(ctx: Ctx, o: Extract<Observation, { kind: 'screen.frame' }>): void {
  const f: ScreenFacts = o.p;
  const at = o.meta.at;
  if (f.torn) {
    updRecon(ctx, (r) => ({ ...r, lastFrameTorn: true }));
    return;
  }
  const prev = recon(ctx).lastFrame;
  if (f.surface === 'editorOpen') {
    // transient (LP-01): no claim, no degradation; a human editor (no library job) blocks input after editorConsumeMs
    updRecon(ctx, (r) => ({ ...r, lastFrame: f, lastFrameAt: at, lastFrameTorn: false }));
    const j = currentJob(ctx);
    if (j === undefined && recon(ctx).editorOpenSince === undefined) {
      updRecon(ctx, (r) => ({ ...r, editorOpenSince: at }));
      arm(ctx, 'editorConsume', 'human', at + cfg(ctx).timeouts.editorConsumeMs);
    }
    onFrameForJobs(ctx, f, at);
    return;
  }
  if (recon(ctx).editorOpenSince !== undefined) {
    updRecon(ctx, (r) => {
      const n = { ...r };
      delete n.editorOpenSince;
      return n;
    });
    disarm(ctx, 'editorConsume', 'human');
  }
  const surfaceChanged =
    prev === undefined || prev.torn || prev.surface === 'editorOpen' ? prev?.surface !== f.surface : prev.surface !== f.surface;
  updRecon(ctx, (r) => ({
    ...r,
    lastFrame: f,
    lastFrameAt: at,
    lastFrameTorn: false,
    surfaceSince: surfaceChanged || r.surfaceSince === undefined ? at : r.surfaceSince,
  }));
  if (f.footer?.ctrlCExitArmed === true) setInputState(ctx, { ...inputState(ctx), lastCtrlCAt: at });
  if (f.surface === 'unsupportedRenderer') {
    addReason(ctx, 'screen', 'unsupportedRenderer');
  } else clearReason(ctx, 'screen', (r) => r === 'unsupportedRenderer');
  const delta = updateClaims(ctx, f, at);
  applyClaimEffects(ctx, delta);
  // readiness (§4.3#4, #6)
  const lc = dom(ctx).lifecycle;
  if (lc === 'launching' && recon(ctx).hookGraceFired === true && isIdleMain(f)) degradedReadiness(ctx);
  else if (lc === 'awaitingReady') maybeArmReady(ctx);
  if (isIdleMain(f) && dom(ctx).activeTurn === undefined) corroborateStop(ctx);
  onFrameForInputs(ctx, f);
  if (f.footer?.mode !== undefined) onModeObserved(ctx, f.footer.mode, 'screen');
  onFrameForJobs(ctx, f, at);
}

/** editorOpen with no library job for editorConsumeMs (ICR 0001 item 3c): inputBlocked.editor + warning. */
export function onHumanEditorDeadline(ctx: Ctx): void {
  if (recon(ctx).editorOpenSince === undefined) return;
  publish(ctx, 'warning', {
    code: 'E_INPUT_GATED',
    message: 'an external editor is open in the pane; input is blocked until it closes',
    detail: { reason: 'editorOpen' },
  });
}

// ------------------------------------------------------------------ misc observations
export function onStopForDrain(ctx: Ctx, o: Extract<Observation, { kind: 'turn.stopped' }>): void {
  checkDrainPending(
    ctx,
    o.p.backgroundTasks.map((t) => t.id),
    0,
  );
}
export function onDurationForDrain(ctx: Ctx, o: Extract<Observation, { kind: 'turn.durationRecorded' }>): void {
  checkDrainPending(ctx, [], o.p.pendingBackgroundAgentCount);
}

export function onRegistry(ctx: Ctx, o: Extract<Observation, { kind: 'registry' }>): void {
  const d = dom(ctx);
  if (d.claude.pid !== undefined && o.p.pid !== d.claude.pid) diag(ctx, 'registry_pid_mismatch', { pid: o.p.pid, expected: d.claude.pid });
  if (o.p.version !== undefined && o.p.version !== d.claude.version) {
    publish(ctx, 'warning', {
      code: 'E_CLAUDE_VERSION_MISMATCH',
      message: `Claude registry reports version ${o.p.version}`,
      detail: { found: o.p.version, expected: d.claude.version },
    });
  }
}

export function onHostResumed(ctx: Ctx): void {
  updRecon(ctx, (r) => ({ ...r, lastHostResumeAt: nowOf(ctx) }));
  arm(ctx, 'hostResumeGrace', 'host', nowOf(ctx) + cfg(ctx).timeouts.hostResumeGraceMs);
}

export function onLoopLag(ctx: Ctx, o: Extract<Observation, { kind: 'host.loopLag' }>): void {
  publish(ctx, 'warning', {
    code: 'E_HOST_LOOP_LAG',
    message: `host event loop lag p99 ${o.p.p99Ms} ms; permission answers may be late`,
    detail: { p99Ms: o.p.p99Ms, maxMs: o.p.maxMs, windowMs: o.p.windowMs },
  });
}
