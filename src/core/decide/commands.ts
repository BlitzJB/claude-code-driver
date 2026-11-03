// core/decide/commands.ts — Command → state/jobs (validation, policy) (DESIGN.md §2.6 Command, §3.6 Commands/Interrupt/
// setMode, §4.4#1, D-16/D-17; P-REV-01/02; ICR 0001 items 1, 2, 6).

import type { Command } from '../../model/commands.js';
import type { CcdErrorData } from '../../model/errors.js';
import type { TurnKey } from '../../model/ids.js';
import type { PermissionMode } from '../../model/state.js';
import { cfg, dom, emit, err, inputState, mint, nowOf, publish } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { commandJob, interruptJob, setModeJob } from '../input-policy/jobs.js';
import { abortUnbegunSubmit, cancelQueuedJob, currentJob, enqueueJob, inflightSubmit, jobOf } from '../input-policy/machine.js';
import { sanitizeCommandArgs, sanitizePrompt } from '../input-policy/sanitize.js';
import { isTurnTerminal } from '../lattice.js';
import { canSubmit, whyNotSubmit } from '../selectors.js';
import { mainTurn, turnRec } from './entities.js';
import { onPermissionCommand, answerPermission, heldPermissionOfTurn, INTERRUPT_DENY } from './permissions.js';
import { onSelfTestRun, onSessionClose } from './session.js';
import { cancelQueuedTurn, createLibraryTurn } from './turns.js';
import { onUsageWake, onWakeTurnUndelivered } from './usage.js';

/**
 * Commands refused even with `unsafe:true` (LC §10.4, P-REV-02): `/exit` (and its alias `/quit`) is `immediate` and
 * runs while busy — close() is the only exit path; `/tui`, `/restart` and in-pane `/resume` relaunch Claude; `/rewind`
 * opens a picker with no driving flow. Checked on the raw and the canonical name, so an alias table gap cannot bypass it.
 */
const REFUSE_ALWAYS: ReadonlySet<string> = new Set(['/exit', '/quit', '/tui', '/restart', '/resume', '/rewind']);
const NAME_RE = /^\/[a-z][a-z0-9:_-]*$/;
const DANGEROUS: ReadonlySet<PermissionMode> = new Set(['bypassPermissions', 'auto', 'dontAsk']);

export type CmdOutcome = { kind: 'ok'; value: unknown } | { kind: 'error'; error: CcdErrorData } | { kind: 'deferred' };

const ok = (value: unknown = { ok: true }): CmdOutcome => ({ kind: 'ok', value });
const fail = (error: CcdErrorData): CmdOutcome => ({ kind: 'error', error });

/** Canonical slash-command name through the profile alias table (`/quit`→`/exit`, `/new`,`/reset`→`/clear`, `/cost`,`/stats`→`/usage`). */
export function canonicalCommand(name: string, aliases: Readonly<Record<string, string>>): string {
  let n = name;
  for (let i = 0; i < 4; i++) {
    const a = aliases[n];
    if (a === undefined || a === n) break;
    n = a;
  }
  return n;
}

export type SlashVerdict = { ok: true; canonical: string } | { ok: false; error: CcdErrorData };

/** §3.6 Commands: name shape → canonicalise → refuse-always → allowlist minus denylist, others need unsafe. */
export function checkSlash(
  name: string,
  unsafe: boolean,
  c: { allow: readonly string[]; deny: readonly string[]; refuseAlways: readonly string[]; aliases: Readonly<Record<string, string>> },
): SlashVerdict {
  if (typeof name !== 'string' || !NAME_RE.test(name))
    return { ok: false, error: err('E_INPUT_INVALID', `invalid command name ${name}`, { reason: 'badName' }) };
  const canonical = canonicalCommand(name, c.aliases);
  const refused = (n: string): boolean => REFUSE_ALWAYS.has(n) || c.refuseAlways.includes(n);
  if (refused(name) || refused(canonical)) {
    return { ok: false, error: err('E_COMMAND_FORBIDDEN', `${name} is never run by the library`, { reason: 'refused', name, canonical }) };
  }
  const allowed = c.allow.includes(canonical) && !c.deny.includes(canonical);
  if (!allowed && !unsafe) {
    return {
      ok: false,
      error: err('E_COMMAND_FORBIDDEN', `${name} needs unsafe:true`, {
        reason: c.deny.includes(canonical) ? 'denied' : 'notAllowed',
        name,
        canonical,
      }),
    };
  }
  return { ok: true, canonical };
}

function closedError(ctx: Ctx): CcdErrorData | undefined {
  const lc = dom(ctx).lifecycle;
  if (lc === 'exited') return err('E_SESSION_EXITED', 'the Claude process has exited');
  if (lc === 'closing') return err('E_SESSION_CLOSED', 'the session is closing');
  return undefined;
}

function jobBase(ctx: Ctx): { key: ReturnType<typeof mint<'job'>>; seq: number; createdAt: ReturnType<typeof nowOf> } {
  const key = mint(ctx, 'job');
  return { key, seq: ctx.core.counters.job, createdAt: nowOf(ctx) };
}

export function handleCommand(ctx: Ctx, cmdId: number, cmd: Command): CmdOutcome {
  switch (cmd.type) {
    case 'prompt.send': {
      const closed = closedError(ctx);
      if (closed !== undefined) return fail(closed);
      const s = sanitizePrompt(cmd.text, { maxPromptBytes: cfg(ctx).input.maxPromptBytes, mentions: cfg(ctx).input.mentions });
      if (!s.ok) return fail(err(s.code, `prompt rejected: ${s.reason}`, { reason: s.reason }));
      const whenBusy = cmd.whenBusy;
      if (whenBusy === 'reject') {
        const lim = dom(ctx).usage.limit;
        if (lim !== undefined && lim.state !== 'cleared')
          return fail(err('E_USAGE_LIMIT', 'usage limit in effect', { reason: 'usageLimited' }));
        const why = whyNotSubmit(ctx.core) ?? (dom(ctx).libraryQueue.length > 0 ? 'queued' : undefined);
        if (why !== undefined || !canSubmit(ctx.core))
          return fail(err('E_BUSY', `session busy (${why ?? 'busy'})`, { reason: why ?? 'busy' }));
      }
      const turnKey = createLibraryTurn(ctx, s.text, { clientRef: cmd.clientRef });
      return ok({ turnKey });
    }
    case 'prompt.cancel': {
      const t = turnRec(ctx, cmd.turnKey);
      if (t === undefined) return fail(err('E_INPUT_INVALID', `unknown turn ${cmd.turnKey}`, { reason: 'unknownTurn' }));
      const job = t.job;
      if (job !== undefined && jobOf(ctx, job) !== undefined && inputState(ctx).current === job)
        return fail(err('E_INPUT_INVALID', 'the prompt is already being submitted', { reason: 'notQueued' }));
      if (!cancelQueuedTurn(ctx, cmd.turnKey))
        return fail(err('E_INPUT_INVALID', 'only queued prompts can be cancelled', { reason: 'notQueued' }));
      if (job !== undefined) cancelQueuedJob(ctx, job);
      onWakeTurnUndelivered(ctx, cmd.turnKey);
      return ok();
    }
    case 'slash.run': {
      const closed = closedError(ctx);
      if (closed !== undefined) return fail(closed);
      const c = cfg(ctx).commands;
      const v = checkSlash(cmd.name, cmd.unsafe === true, c);
      if (!v.ok) return fail(v.error);
      let args: string | undefined;
      if (cmd.args !== undefined) {
        const a = sanitizeCommandArgs(cmd.args);
        if (!a.ok) return fail(err(a.code, `command arguments rejected: ${a.reason}`, { reason: a.reason }));
        args = a.text === '' ? undefined : a.text;
      }
      let capture: { until: 'usageReady'; timeoutMs: number } | undefined;
      if (cmd.capture !== undefined) {
        const t = cmd.capture.timeoutMs;
        if (!Number.isInteger(t) || t < 0 || t > 30_000)
          return fail(err('E_INPUT_INVALID', 'invalid capture criterion', { reason: 'badCapture' }));
        capture = { until: cmd.capture.until, timeoutMs: t };
      }
      enqueueJob(ctx, commandJob(jobBase(ctx), v.canonical, args, cmdId, false, capture));
      return { kind: 'deferred' };
    }
    case 'interrupt':
      return interrupt(ctx);
    case 'turn.stop':
      return stopTurn(ctx, cmd.turnKey);
    case 'permission.answer':
    case 'permission.answerQuestion':
    case 'permission.approvePlan': {
      const r = onPermissionCommand(ctx, cmd);
      return r.ok ? ok() : fail(r.error);
    }
    case 'mode.set': {
      const closed = closedError(ctx);
      if (closed !== undefined) return fail(closed);
      if (DANGEROUS.has(cmd.mode) && !cfg(ctx).permissions.allowDangerousModes) {
        return fail(err('E_MODE_FORBIDDEN', `mode ${cmd.mode} needs allowDangerousModes`, { reason: 'dangerousMode', mode: cmd.mode }));
      }
      if (dom(ctx).claude.permissionMode?.value === cmd.mode && dom(ctx).claude.permissionMode?.provisional !== true) return ok();
      enqueueJob(ctx, setModeJob(jobBase(ctx), cmd.mode, cmdId));
      return { kind: 'deferred' };
    }
    case 'usage.wakeNow':
      onUsageWake(ctx);
      return ok();
    case 'selftest.run': {
      const e = onSelfTestRun(ctx, cmd);
      return e === undefined ? ok() : fail(e);
    }
    case 'net.fault':
      if (!cfg(ctx).channels.network) return fail(err('E_UNSUPPORTED_FEATURE', 'the network channel is off', { reason: 'networkOff' }));
      emit<'net.fault'>(ctx, { kind: 'net.fault', spec: cmd.spec });
      return ok();
    case 'session.close':
      onSessionClose(ctx, cmd);
      return ok();
  }
}

/**
 * turn.stop (ICR 0023): stop one turn, decided on the state this step sees, so a facade never races a read of an older
 * state against the input machine. Ended → no-op. Queued (its submit job not current) → cancelled like prompt.cancel; its
 * job current but not begun (waiting for copy mode to exit) → that job is dropped and the turn cancelled. The main turn →
 * the session interrupt. Its submit in progress (typing, Enter, awaiting the ack) → an interrupt job queued right behind
 * it, so the Escape lands once the prompt is accepted (an interrupt job that starts with no active turn is ignored).
 */
function stopTurn(ctx: Ctx, key: TurnKey): CmdOutcome {
  const t = turnRec(ctx, key);
  if (t === undefined) return fail(err('E_INPUT_INVALID', `unknown turn ${key}`, { reason: 'unknownTurn' }));
  const effect = (e: 'cancelled' | 'interrupted' | 'none'): CmdOutcome => ok({ ok: true, effect: e });
  if (isTurnTerminal(t.state.value)) return effect('none');
  const job = t.job !== undefined ? jobOf(ctx, t.job) : undefined;
  const isCurrent = job !== undefined && inputState(ctx).current === job.key;
  if (t.state.value === 'queued' && dom(ctx).libraryQueue.includes(key)) {
    const unbegun = isCurrent && job.kind === 'submit' && job.phase === 'waitGate' && job.attempt === 0;
    if (!isCurrent || unbegun) {
      cancelQueuedTurn(ctx, key);
      if (job !== undefined) {
        if (unbegun) abortUnbegunSubmit(ctx, job.key);
        else cancelQueuedJob(ctx, job.key);
      }
      onWakeTurnUndelivered(ctx, key);
      return effect('cancelled');
    }
  }
  if (mainTurn(ctx)?.key === key) {
    interrupt(ctx);
    return effect('interrupted');
  }
  if (isCurrent) {
    const queued = inputState(ctx).order.some((k) => jobOf(ctx, k)?.kind === 'interrupt');
    if (!queued) enqueueJob(ctx, interruptJob(jobBase(ctx), key), true);
    return effect('interrupted');
  }
  // running but not the main turn (merged into another turn, or superseded): the session interrupt stops what runs it
  if (t.state.value === 'running' || t.state.value === 'stopping') {
    interrupt(ctx);
    return effect('interrupted');
  }
  return effect('none');
}

/** §3.6 Interrupt: not busy → ignored; permission held → deny{interrupt:true} through the hook; else one Escape. */
function interrupt(ctx: Ctx): CmdOutcome {
  // a turn held after a provisional (screen) interrupt already stopped: Claude is idle, and a second Escape would land on
  // the idle composer (a draft clear, or with the first one a double press, IN §6.2). ICR 0028 item 5.
  const main = mainTurn(ctx);
  const active = main !== undefined && isTurnTerminal(main.state.value) ? undefined : main;
  const inflight = inflightSubmit(ctx);
  const turnKey: TurnKey | undefined = active?.key ?? (inflight?.kind === 'submit' ? inflight.turn : undefined);
  const res = (): CmdOutcome => ok(turnKey === undefined ? {} : { turnKey });
  if (dom(ctx).lifecycle !== 'ready' || turnKey === undefined) {
    publish(ctx, 'interrupt.ignored', { reason: 'notBusy' });
    return ok({});
  }
  // only a request of the turn being interrupted (main thread or its foreground subagent): denying a background agent's
  // request would abort that agent's tool and leave the main turn running (§3.6 Interrupt, §4.7 rule 3; ICR 0021)
  const held = active === undefined ? undefined : heldPermissionOfTurn(ctx, active.key);
  if (held !== undefined) {
    answerPermission(ctx, held.key, INTERRUPT_DENY, 'host');
    return res();
  }
  const cur = currentJob(ctx);
  const queued = inputState(ctx).order.some((k) => jobOf(ctx, k)?.kind === 'interrupt');
  if (cur?.kind === 'interrupt' || queued) return res(); // never a second Escape without evidence the first landed (IN §6.2)
  enqueueJob(ctx, interruptJob(jobBase(ctx), turnKey), true);
  return res();
}
