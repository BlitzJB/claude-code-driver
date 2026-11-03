// core/decide/usage.ts — usage limits and the library-owned wake-up (DESIGN.md §3.9, §4.6 UsageLimit, D-20; LC §3.3).
// The wake is a core *wall* deadline `usageWake` with deterministic jitter (rev 2 §10 G4, P-REV-36): no L3 randomness,
// replay-stable, different per session. Reset times are parsed in L1 only (core never parses dates).

import type { TurnKey } from '../../model/ids.js';
import type { JsonValue } from '../../model/json.js';
import type { Source } from '../../model/observation.js';
import type { UsageLimitState } from '../../model/state.js';
import type { WallMs } from '../../model/time.js';
import { arm, cfg, diag, disarm, dom, mint, nowOf, patch, publish, recon, updRecon, wallOf } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { rank } from '../facts.js';
import { fnv1a32 } from '../input-policy/ack-match.js';
import { dismissMenuJob, wakeEnterJob } from '../input-policy/jobs.js';
import { enqueueJob } from '../input-policy/machine.js';
import { sanitizePrompt } from '../input-policy/sanitize.js';
import { isRecord } from '../reconcile/canonical.js';
import { lastTurn } from '../selectors.js';
import { createLibraryTurn } from './turns.js';

const UNKNOWN_RESET_REARM_MS = 15 * 60 * 1000;

/** §3.9: jitterMs = jitterMinMs + (fnv1a32(sessionKey + ':' + resetsAtWall + ':' + rearms) mod (jitterMaxMs − jitterMinMs + 1)). */
export function wakeJitterMs(sessionKey: string, resetsAtWall: number, rearms: number, minMs: number, maxMs: number): number {
  const span = Math.max(0, maxMs - minMs) + 1;
  return minMs + (fnv1a32(`${sessionKey}:${resetsAtWall}:${rearms}`) % span);
}

export interface LimitEvidence {
  source: Source;
  limitName?: string | undefined;
  resetsAtWall?: WallMs | undefined;
  rateLimitType?: string | undefined;
  autoContinue?: UsageLimitState['autoContinue'];
}

function schedule(ctx: Ctx): void {
  const lim = dom(ctx).usage.limit;
  if (lim === undefined || lim.state === 'cleared' || !cfg(ctx).usage.autoResume) return;
  if (recon(ctx).wakeGaveUp === true) return;
  const u = cfg(ctx).usage;
  let atWall: number;
  let jitterMs = 0;
  if (lim.resetsAtWall !== undefined) {
    jitterMs = wakeJitterMs(dom(ctx).sessionKey, lim.resetsAtWall, lim.rearms, u.jitterMinMs, u.jitterMaxMs);
    atWall = lim.resetsAtWall + jitterMs;
  } else {
    atWall = wallOf(ctx) + UNKNOWN_RESET_REARM_MS;
  }
  arm(ctx, 'usageWake', 'limit', atWall, 'wall');
  const n: UsageLimitState = { ...lim, nextWakeAtWall: atWall as WallMs, jitterMs };
  patch(ctx, ['usage', 'limit'], n, 'wake scheduled');
  publish(ctx, 'usage.wakeScheduled', { atWall: atWall as WallMs, attempt: lim.rearms + 1, jitterMs });
}

/** Ref of the `transcriptSettle` deadline that bounds the wait for a hook-only limit's reset time. */
export const LIMIT_SETTLE_REF = 'usage';

function publishLimited(ctx: Ctx, n: UsageLimitState): void {
  const pl: { limitName?: string; resetsAtWall?: WallMs; source: Source; autoContinue: UsageLimitState['autoContinue'] } = {
    source: n.source,
    autoContinue: n.autoContinue,
  };
  if (n.limitName !== undefined) pl.limitName = n.limitName;
  if (n.resetsAtWall !== undefined) pl.resetsAtWall = n.resetsAtWall;
  publish(ctx, 'usage.limited', pl, { confirmed: n.source !== 'screen' });
}

function setAwaitingReset(ctx: Ctx, on: boolean): void {
  if ((recon(ctx).limitAwaitingReset === true) === on) return;
  updRecon(ctx, (r) => {
    const n = { ...r };
    if (on) n.limitAwaitingReset = true;
    else delete n.limitAwaitingReset;
    return n;
  });
  if (on) arm(ctx, 'transcriptSettle', LIMIT_SETTLE_REF, nowOf(ctx) + cfg(ctx).timeouts.transcriptSettleMs);
  else disarm(ctx, 'transcriptSettle', LIMIT_SETTLE_REF);
}

/**
 * `transcriptSettle` for the limit fired: no reset time arrived with the hook's StopFailure, so publish the limit now and
 * arm the unknown-reset (15 min) wake.
 */
export function onLimitSettle(ctx: Ctx): void {
  if (recon(ctx).limitAwaitingReset !== true) return;
  setAwaitingReset(ctx, false);
  const lim = dom(ctx).usage.limit;
  if (lim === undefined || lim.state === 'cleared') return;
  publishLimited(ctx, lim);
  schedule(ctx);
}

/** New usage-limit evidence (hook StopFailure / Notification > transcript synthetic > screen banner, §3.9). */
export function markLimited(ctx: Ctx, ev: LimitEvidence): void {
  const cur = dom(ctx).usage.limit;
  if (cur === undefined || cur.state === 'cleared') {
    const n: UsageLimitState = { state: 'limited', source: ev.source, autoContinue: ev.autoContinue ?? 'none', rearms: 0 };
    if (ev.limitName !== undefined) n.limitName = ev.limitName;
    if (ev.resetsAtWall !== undefined) n.resetsAtWall = ev.resetsAtWall;
    if (ev.rateLimitType !== undefined) n.rateLimitType = ev.rateLimitType;
    const active = dom(ctx).activeTurn;
    if (active !== undefined) n.interruptedTurn = active;
    // §3.9 step 5: our `continue` was accepted (which cleared the limit) and hit the limit again → this is a re-arm of the
    // same wake chain, not a fresh limit; past maxRearms the library gives up (warning, no wake).
    const chain = recon(ctx).wakeChainRearms;
    const failedTurn = lastTurn(dom(ctx));
    if (chain !== undefined) {
      updRecon(ctx, (r) => {
        const x = { ...r };
        delete x.wakeChainRearms;
        return x;
      });
      if (failedTurn?.origin.value === 'auto_continue') n.rearms = chain;
    }
    patch(ctx, ['usage', 'limit'], n, 'usage limited');
    if (n.rearms > cfg(ctx).usage.maxRearms) {
      publishLimited(ctx, n);
      giveUp(ctx, n.rearms);
      return;
    }
    // The hook's StopFailure carries no reset time; the transcript's synthetic API error (written just before it) does,
    // but reaches us one tail poll later. Wait for it (bounded by transcriptSettle) so `usage.limited` and the first
    // `usage.wakeScheduled` carry the real reset instead of a 15-min guess that is re-armed a moment later (K-19, K-51).
    if (n.resetsAtWall === undefined && ev.source === 'hook') {
      setAwaitingReset(ctx, true);
      return;
    }
    publishLimited(ctx, n);
    schedule(ctx);
    return;
  }
  if (cur.state === 'waking') {
    rearm(ctx, ev);
    return;
  }
  // limited: enrich (a better source or a learnt reset time re-arms the wake)
  const n: UsageLimitState = { ...cur };
  if (rank(ev.source) > rank(cur.source)) n.source = ev.source;
  if (ev.limitName !== undefined && n.limitName === undefined) n.limitName = ev.limitName;
  if (ev.rateLimitType !== undefined) n.rateLimitType = ev.rateLimitType;
  if (ev.autoContinue !== undefined && ev.autoContinue !== 'none') n.autoContinue = ev.autoContinue;
  const resetChanged =
    ev.resetsAtWall !== undefined &&
    ev.resetsAtWall !== cur.resetsAtWall &&
    (cur.resetsAtWall === undefined || rank(ev.source) >= rank(cur.source));
  if (resetChanged && ev.resetsAtWall !== undefined) n.resetsAtWall = ev.resetsAtWall;
  if (JSON.stringify(n) !== JSON.stringify(cur)) patch(ctx, ['usage', 'limit'], n, 'usage limit enriched');
  if (recon(ctx).limitAwaitingReset === true) {
    // the first event of this limit is still held: release it once a reset time (from any source) is known
    if (n.resetsAtWall === undefined) return;
    setAwaitingReset(ctx, false);
    publishLimited(ctx, n);
    schedule(ctx);
    return;
  }
  if (resetChanged) schedule(ctx);
}

/** waking → limited with a later reset (rearms++); give up after maxRearms with a warning (§3.9 step 5). */
function rearm(ctx: Ctx, ev?: LimitEvidence): void {
  const cur = dom(ctx).usage.limit;
  if (cur === undefined) return;
  const rearms = cur.rearms + 1;
  const n: UsageLimitState = { ...cur, state: 'limited', rearms };
  if (ev?.resetsAtWall !== undefined) n.resetsAtWall = ev.resetsAtWall;
  delete n.nextWakeAtWall;
  patch(ctx, ['usage', 'limit'], n, 'usage rearm');
  if (rearms > cfg(ctx).usage.maxRearms) {
    giveUp(ctx, rearms);
    return;
  }
  schedule(ctx);
}

function giveUp(ctx: Ctx, rearms: number): void {
  disarm(ctx, 'usageWake', 'limit');
  setAwaitingReset(ctx, false);
  updRecon(ctx, (r) => ({ ...r, wakeGaveUp: true }));
  publish(ctx, 'warning', {
    code: 'E_USAGE_LIMIT',
    message: 'usage limit still in effect after the maximum number of wake attempts',
    detail: { reason: 'maxRearms', rearms },
  });
}

function clearLimit(ctx: Ctx, reason: 'turnStarted' | 'autoResumeFired' | 'wokeByLibrary'): void {
  const cur = dom(ctx).usage.limit;
  if (cur === undefined || cur.state === 'cleared') return;
  disarm(ctx, 'usageWake', 'limit');
  setAwaitingReset(ctx, false);
  const n: UsageLimitState = { ...cur, state: 'cleared' };
  delete n.nextWakeAtWall;
  patch(ctx, ['usage', 'limit'], n, 'usage cleared');
  updRecon(ctx, (r) => {
    const x = { ...r, limitClearedAt: nowOf(ctx) };
    delete x.wakeGaveUp;
    if (reason === 'wokeByLibrary') x.wakeChainRearms = cur.rearms + 1;
    else delete x.wakeChainRearms;
    return x;
  });
  publish(ctx, 'usage.cleared', { reason });
}

/** The wake procedure (LC §3.3), on usageWake or usage.wakeNow. */
export function onUsageWake(ctx: Ctx): void {
  const lim = dom(ctx).usage.limit;
  if (lim === undefined || lim.state === 'cleared') return;
  if (dom(ctx).lifecycle !== 'ready') {
    diag(ctx, 'usage_wake_not_ready', { lifecycle: dom(ctx).lifecycle });
    return;
  }
  if (lim.state === 'limited') patch(ctx, ['usage', 'limit'], { ...lim, state: 'waking' }, 'waking');
  const f = recon(ctx).lastFrame;
  const base = (): { key: ReturnType<typeof mint<'job'>>; seq: number; createdAt: typeof ctx.core.now } => {
    const key = mint(ctx, 'job');
    return { key, seq: ctx.core.counters.job, createdAt: nowOf(ctx) };
  };
  if (f?.usageLimit?.autoContinue === 'stalePressEnter') {
    enqueueJob(ctx, wakeEnterJob(base()), true);
    return;
  }
  if (f?.surface === 'usageLimitMenu') {
    enqueueJob(ctx, dismissMenuJob(base()), true);
    return;
  }
  resumeSubmit(ctx);
}

/** Wake step (4): banner past its time (or gone) → submit the resume prompt (origin auto_continue); later reset → rearm. */
function resumeSubmit(ctx: Ctx): void {
  const lim = dom(ctx).usage.limit;
  if (lim === undefined || lim.state === 'cleared') return;
  const f = recon(ctx).lastFrame;
  // §3.9 authority order: once a reset time learnt from the hook/transcript has passed, a banner that still shows a later
  // reset is stale scrollback (its time-only form is parsed as the "next occurrence") and must not re-arm (ICR 0016).
  const authoritativePast = lim.resetsAtWall !== undefined && lim.source !== 'screen' && lim.resetsAtWall <= wallOf(ctx);
  const bannerReset = authoritativePast ? undefined : f?.usageLimit?.resetsAtWall;
  if (bannerReset !== undefined && bannerReset > wallOf(ctx)) {
    rearm(ctx, { source: 'screen', resetsAtWall: bannerReset });
    return;
  }
  const queued = dom(ctx).libraryQueue.some((k) => dom(ctx).turns[k]?.origin.value === 'auto_continue');
  if (!queued) createLibraryTurn(ctx, resumeText(ctx), { origin: 'auto_continue', front: true, forWake: true });
}

const DEFAULT_RESUME_PROMPT = 'continue';

/**
 * The resume prompt through the same sanitizer as every prompt (D-16, P-SEC-07): a leading `!` is escaped, a trailing `\`
 * gets its space, controls and invisibles go. A value the sanitizer rejects (a leading `/` would run a command past the
 * commands lists) is never typed: a warning, and the default prompt instead, so the wake still submits. ICR 0028 item 6.
 */
function resumeText(ctx: Ctx): string {
  const c = cfg(ctx);
  const s = sanitizePrompt(c.usage.resumePrompt, { maxPromptBytes: c.input.maxPromptBytes, mentions: c.input.mentions });
  if (s.ok) return s.text;
  publish(ctx, 'warning', {
    code: 'E_CONFIG_INVALID',
    message: `usageLimit.resumePrompt rejected (${s.reason}); using "${DEFAULT_RESUME_PROMPT}"`,
    detail: { reason: s.reason },
  });
  return DEFAULT_RESUME_PROMPT;
}

/**
 * The wake's own resume turn (origin auto_continue) ended without reaching Claude — its submit failed or it was cancelled —
 * while the limit is `waking`: the usageWake deadline was used up, so re-arm (§3.9 step 5) instead of staying `waking`
 * with no deadline and blocking every library prompt. ICR 0021 item 5.
 */
export function onWakeTurnUndelivered(ctx: Ctx, turn: TurnKey): void {
  if (dom(ctx).usage.limit?.state !== 'waking') return;
  if (dom(ctx).turns[turn]?.origin.value !== 'auto_continue') return;
  diag(ctx, 'usage_wake_submit_failed', { turn });
  rearm(ctx);
}

export function onWakeDone(ctx: Ctx, ok: boolean): void {
  if (!ok) rearm(ctx);
}

export function onMenuDismissed(ctx: Ctx, ok: boolean): void {
  if (ok) resumeSubmit(ctx);
  else rearm(ctx);
}

/** A UPS while limited/waking: Claude accepted a prompt → cleared (wokeByLibrary for our auto-continue). */
export function onPromptAcceptedForUsage(ctx: Ctx, autoContinue: boolean): void {
  const lim = dom(ctx).usage.limit;
  if (lim === undefined || lim.state === 'cleared') return;
  clearLimit(ctx, autoContinue ? 'wokeByLibrary' : 'turnStarted');
}

/** Notification{quota_auto_resume_*} (§3.9 detection; the builtin auto-continue is off in our settings, D-20). */
export function onQuotaNotification(ctx: Ctx, type: string): void {
  if (!type.startsWith('quota_auto_resume')) return;
  if (type.includes('fired') || type.includes('resumed')) {
    clearLimit(ctx, 'autoResumeFired');
    return;
  }
  if (type.includes('cancel')) {
    markLimited(ctx, { source: 'hook', autoContinue: 'cancelled' });
    return;
  }
  markLimited(ctx, { source: 'hook', autoContinue: 'armed' });
}

const num = (v: JsonValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: JsonValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** Screen usage-limit banner / menu claim (provisional source, L1-parsed resetsAtWall). */
export function onUsageLimitClaim(ctx: Ctx, value: JsonValue): void {
  if (!isRecord(value)) return;
  const v = value as Record<string, JsonValue>;
  const ac = str(v['autoContinue']);
  const autoContinue: UsageLimitState['autoContinue'] =
    ac === 'waiting' || ac === 'resetContinuing' ? 'armed' : ac === 'stalePressEnter' ? 'stale' : ac === 'cancelled' ? 'cancelled' : 'none';
  const reset = num(v['resetsAtWall']);
  markLimited(ctx, { source: 'screen', limitName: str(v['limitName']), resetsAtWall: reset as WallMs | undefined, autoContinue });
}

/** A screen rate-limit retry line with a `(<reset>)` form (SP §16 Q7, LP-30). */
export function onRetryResetClaim(ctx: Ctx, value: JsonValue): void {
  if (!isRecord(value)) return;
  const v = value as Record<string, JsonValue>;
  const reset = num(v['resetsAtWall']);
  if (reset === undefined || str(v['errorHint']) !== 'rateLimit') return;
  markLimited(ctx, { source: 'screen', resetsAtWall: reset as WallMs });
}

export function resetUsageOnExit(ctx: Ctx): void {
  disarm(ctx, 'usageWake', 'limit');
  setAwaitingReset(ctx, false);
  const lim = dom(ctx).usage.limit;
  if (lim?.nextWakeAtWall !== undefined) {
    const n = { ...lim };
    delete n.nextWakeAtWall;
    patch(ctx, ['usage', 'limit'], n, 'exit: no wake');
  }
}
