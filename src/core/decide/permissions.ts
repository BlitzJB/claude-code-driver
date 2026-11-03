// core/decide/permissions.ts — the permission flow, core parts (DESIGN.md §3.7, §4.5.1, §4.6 Permission; D-18 fail closed;
// SEC §4). L3 runs handlers (permission-broker.ts) and realpaths (path-resolver.ts); the policy timeout is the core
// deadline `permissionPolicy`. The response body is built only from the typed decision object (SEC §2.6).

import type { Command, PermissionDecision, PermissionUpdate } from '../../model/commands.js';
import type { CcdErrorData } from '../../model/errors.js';
import type { AgentKey, PermissionKey, ToolKey, TurnKey } from '../../model/ids.js';
import type { PermissionResponseBody } from '../../model/intents.js';

import type { Observation, PermissionDecider } from '../../model/observation.js';
import type { PermissionRecord, PermState, ToolState } from '../../model/state.js';
import { assertedClaim } from '../claims.js';
import {
  arm,
  captureNow,
  cfg,
  diag,
  disarm,
  dom,
  emit,
  err,
  inputState,
  mint,
  newProvenance,
  nowOf,
  publish,
  recon,
  seqOf,
  srcOf,
  updRecon,
} from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { mkFact } from '../facts.js';
import { enqueueJob, takeInterruptFor } from '../input-policy/machine.js';
import { permissionKeysJob } from '../input-policy/jobs.js';
import { sanitizeMessage } from '../input-policy/sanitize.js';
import { isPermOpen, isToolTerminal } from '../lattice.js';
import { canonicalEq, isRecord } from '../reconcile/canonical.js';
import { bindPermission, lateBindMatches } from '../reconcile/permission-binding.js';
import { agentById, agentRec, mainTurn, permRec, putPerm, putTool, setPermState, setToolState, toolRec, turnOfAgent } from './entities.js';

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);
const DANGEROUS_MODES = new Set(['bypassPermissions', 'auto', 'dontAsk']);
const SAFE_MODES = new Set(['default', 'acceptEdits', 'plan']);
const ADOPT_SUSPECT_WINDOW_MS = 2000;
const CLOSE_DENY: PermissionDecision = { behavior: 'deny', message: 'Denied: session closing' };
/** §3.6 Interrupt through the hook (also used by commands.ts interrupt()). */
export const INTERRUPT_DENY: PermissionDecision = { behavior: 'deny', message: 'Interrupted by the host', interrupt: true };

function needsOf(toolName: string): PermissionRecord['needs'] {
  if (toolName === 'AskUserQuestion') return 'answers';
  if (toolName === 'ExitPlanMode') return 'planApproval';
  return 'decision';
}

function bodyOf(decision: PermissionDecision): PermissionResponseBody {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function isBackground(ctx: Ctx, rec: PermissionRecord): boolean {
  // §3.7 step 10: the request carries an agent (any subagent: may be blocking-before-dialog, HT §9.2), or its tool
  // belongs to a background agent
  if (rec.agent !== undefined) return true;
  const t = toolRec(ctx, rec.tool);
  if (t?.agent !== undefined) return agentRec(ctx, t.agent)?.background === true;
  return false;
}

/**
 * A request of the main thread or of a foreground subagent (§4.8 rule 1, §4.7 rule 3). Background, teammate and internal
 * agents are session-scoped (§4.5.4): their requests outlive the main turn. A carried agent id we cannot resolve is
 * never treated as main-thread. ICR 0021 item 2.
 */
export function isMainScoped(ctx: Ctx, rec: PermissionRecord): boolean {
  const ak = rec.agent ?? toolRec(ctx, rec.tool)?.agent;
  if (ak === undefined) return recon(ctx).permAgentId[rec.key] === undefined;
  const a = agentRec(ctx, ak);
  return a !== undefined && !a.background && a.kind === 'subagent';
}

/** The request held by the hook that belongs to turn `turn` (main thread or a linked foreground subagent), oldest first. */
export function heldPermissionOfTurn(ctx: Ctx, turn: string): PermissionRecord | undefined {
  return Object.values(dom(ctx).permissions)
    .filter(
      (p) =>
        p.state.value === 'pending' &&
        p.hookSeq !== undefined &&
        p.ourAnswer === undefined &&
        recon(ctx).permTurn[p.key] === turn &&
        isMainScoped(ctx, p),
    )
    .sort((a, b) => a.requestedAt - b.requestedAt || (a.key < b.key ? -1 : 1))[0];
}

/** The armed `permissionPolicy` deadline of a request (armed before the request is published or asked). */
function policyDeadline(ctx: Ctx, k: PermissionKey): PermissionRecord['requestedAt'] {
  const deadline = recon(ctx).deadlines[`permissionPolicy:${k}`];
  return (deadline?.at ?? nowOf(ctx) + cfg(ctx).permissions.timeoutMs) as PermissionRecord['requestedAt'];
}

function ask(ctx: Ctx, rec: PermissionRecord): void {
  const deadlineAt = policyDeadline(ctx, rec.key);
  emit<'host.askPermission'>(ctx, { kind: 'host.askPermission', permissionKey: rec.key, deadlineAt });
  updRecon(ctx, (r) => ({ ...r, asks: { ...r.asks, [rec.key]: true } }));
}

function cancelAsk(ctx: Ctx, k: PermissionKey, reason: string): void {
  if (recon(ctx).asks[k] !== true) return;
  emit<'host.cancelAsk'>(ctx, { kind: 'host.cancelAsk', permissionKey: k, reason });
  updRecon(ctx, (r) => {
    const { [k]: _gone, ...rest } = r.asks;
    return { ...r, asks: rest };
  });
}

// ------------------------------------------------------------------ request
/** §3.7 step 1: new PermissionRecord, bind (§4.5.1), policy deadline, named policy or ask. */
export function onPermissionRequested(ctx: Ctx, o: Extract<Observation, { kind: 'permission.requested' }>): PermissionKey {
  const p = o.p;
  captureNow(ctx, 'permissionRequest'); // §4.11 immediate capture
  const key = mint(ctx, 'perm');
  const agent: AgentKey | undefined = p.agent !== undefined ? agentById(ctx, p.agent.agentId)?.key : undefined;
  const b = bindPermission(dom(ctx), {
    toolName: p.toolName,
    input: p.input,
    agent,
    agentCarried: p.agent !== undefined,
    agentId: p.agent?.agentId,
    promptId: p.promptId,
  });
  const needs = needsOf(p.toolName);
  // Not held by the transport (over maxHeld, SEC §2.7): it already answered `{}`, so Claude shows the native dialog. The
  // record is born dialogOnly with no hookSeq, so it is answered by keys and stands for that dialog (§3.7 step 8, ICR 0018).
  const held = p.holdable !== false;
  const rec: PermissionRecord = {
    key,
    toolName: p.toolName,
    input: p.input,
    suggestions: p.suggestions,
    binding: { kind: b.binding, confirmed: false },
    state: mkFact<PermState>(held ? 'pending' : 'dialogOnly', srcOf(ctx), seqOf(ctx), nowOf(ctx)),
    autoAnswerAllowed: b.autoOk,
    needs,
    requestedAt: nowOf(ctx),
    suspect: false,
    adopted: false,
    provenance: newProvenance(ctx),
  };
  if (held) rec.hookSeq = p.hookSeq;
  if (b.tool !== undefined) rec.tool = b.tool;
  const toolAgent = toolRec(ctx, b.tool)?.agent;
  if (agent !== undefined) rec.agent = agent;
  else if (toolAgent !== undefined) rec.agent = toolAgent;
  putPerm(ctx, rec, 'permission requested');
  if (held) updRecon(ctx, (r) => ({ ...r, aliases: { ...r.aliases, hookSeq: { ...r.aliases.hookSeq, [p.hookSeq]: key } } }));
  if (p.agent !== undefined) {
    const agentId = p.agent.agentId;
    updRecon(ctx, (r) => ({ ...r, permAgentId: { ...r.permAgentId, [key]: agentId } }));
  }
  // an agent's unbound request belongs to its agent's turn (spawn chain), never to whatever main turn is active (ICR 0021)
  const turn = toolRec(ctx, b.tool)?.turn ?? (p.agent !== undefined ? turnOfAgent(ctx, agentRec(ctx, agent)) : mainTurn(ctx)?.key);
  if (turn !== undefined) updRecon(ctx, (r) => ({ ...r, permTurn: { ...r.permTurn, [key]: turn } }));
  if (b.tool !== undefined) {
    const t = toolRec(ctx, b.tool);
    if (t !== undefined) {
      putTool(ctx, { ...t, permission: key }, 'permission bound');
      setToolState(ctx, t.key, 'awaitingPermission');
    }
  } else {
    arm(ctx, 'permBindLate', key, nowOf(ctx) + cfg(ctx).timeouts.permBindLateMs);
  }
  const timeout = isBackground(ctx, rec) ? cfg(ctx).permissions.backgroundTimeoutMs : cfg(ctx).permissions.timeoutMs;
  arm(ctx, 'permissionPolicy', key, nowOf(ctx) + timeout);
  publishRequested(ctx, rec);
  if (b.tool !== undefined) publish(ctx, 'permission.bound', { permissionKey: key, toolKey: b.tool, confirmed: false });
  // close() fails closed (D-18, SEC §1 rule 9): a request that arrives after closing began is denied, never given to a
  // policy or an asker (ICR 0028 item 7)
  const closing = dom(ctx).lifecycle === 'closing';
  if (held) {
    if (closing) answerPermission(ctx, key, CLOSE_DENY, 'close');
    else if (interruptPendingFor(ctx, rec, turn)) answerPermission(ctx, key, INTERRUPT_DENY, 'host');
    else applyPolicy(ctx, key);
    return key;
  }
  diag(ctx, 'permission_not_held', { permissionKey: key, hookSeq: p.hookSeq });
  publish(ctx, 'permission.needsKeys', { permissionKey: key }, { turnKey: recon(ctx).permTurn[key] });
  // As for an adopted dialog: deny stays deny (by keys); an allow cannot be written to a hook, so other policies ask.
  if (closing) answerPermission(ctx, key, CLOSE_DENY, 'close');
  else if (cfg(ctx).permissions.policy === 'deny') answerPermission(ctx, key, { behavior: 'deny', message: 'Denied by policy' }, 'policy');
  else ask(ctx, rec);
  return key;
}

/**
 * The request belongs to the main turn (or its foreground subagent) and an interrupt of that turn is pending: the host
 * asked to stop before this request reached us, so it is answered deny{interrupt:true} instead of being given to the
 * policy or the handler, and the interrupt's not-yet-sent Escape is withdrawn (it would land on the native dialog).
 */
function interruptPendingFor(ctx: Ctx, rec: PermissionRecord, turn: TurnKey | undefined): boolean {
  if (turn === undefined || mainTurn(ctx)?.key !== turn || !isMainScoped(ctx, rec)) return false;
  return takeInterruptFor(ctx, turn);
}

function publishRequested(ctx: Ctx, rec: PermissionRecord): void {
  const ev: {
    permissionKey: PermissionKey;
    toolKey?: ToolKey;
    toolName: string;
    input: unknown;
    suggestions: unknown[];
    binding: PermissionRecord['binding']['kind'];
    autoAnswerAllowed: boolean;
    agentKey?: AgentKey;
    needs: PermissionRecord['needs'];
    adopted?: boolean;
    background: boolean;
    deadlineAt: PermissionRecord['requestedAt'];
  } = {
    permissionKey: rec.key,
    toolName: rec.toolName,
    input: rec.input,
    suggestions: rec.suggestions,
    binding: rec.binding.kind,
    autoAnswerAllowed: rec.autoAnswerAllowed,
    needs: rec.needs,
    // the same rule and deadline the handler path sees (askFromState, host.askPermission): one source for both (ICR 0023)
    background: isBackground(ctx, rec),
    deadlineAt: policyDeadline(ctx, rec.key),
  };
  if (rec.tool !== undefined) ev.toolKey = rec.tool;
  if (rec.agent !== undefined) ev.agentKey = rec.agent;
  if (rec.adopted) ev.adopted = true;
  publish(ctx, 'permission.requested', ev, { turnKey: recon(ctx).permTurn[rec.key], confirmed: !rec.adopted });
}

/** Named policies (§3.7 step 1–2): deny stays deny; auto-allow needs autoAnswerAllowed and needs === 'decision'. */
function applyPolicy(ctx: Ctx, k: PermissionKey): void {
  const rec = permRec(ctx, k);
  if (rec === undefined) return;
  const pol = cfg(ctx).permissions.policy;
  const auto = rec.autoAnswerAllowed && !rec.suspect && !rec.adopted && rec.needs === 'decision';
  switch (pol) {
    case 'deny':
      answerPermission(ctx, k, { behavior: 'deny', message: 'Denied by policy' }, 'policy');
      return;
    case 'dangerouslyAllowAll':
      if (auto) answerPermission(ctx, k, { behavior: 'allow' }, 'policy');
      else ask(ctx, rec);
      return;
    case 'allowRead':
      if (auto && READ_TOOLS.has(rec.toolName)) {
        putPerm(ctx, { ...rec, paths: { state: 'pending' } }, 'resolve paths');
        emit<'permission.resolvePaths'>(ctx, {
          kind: 'permission.resolvePaths',
          permissionKey: k,
          toolName: rec.toolName,
          input: rec.input,
        });
      } else ask(ctx, rec);
      return;
    case 'ask':
    case 'handler':
      ask(ctx, rec);
      return;
  }
}

/** permission.pathsResolved (L3 path-resolver): all inside → allow (policy); otherwise ask (§3.7 step 1, K-44, K-49). */
export function onPathsResolved(ctx: Ctx, o: Extract<Observation, { kind: 'permission.pathsResolved' }>): void {
  const rec = permRec(ctx, o.p.permissionKey);
  if (rec === undefined) return;
  const allInside = o.p.paths.length > 0 ? o.p.paths.every((x) => x.inside) : true;
  putPerm(ctx, { ...rec, paths: { state: 'resolved', allInside, detail: o.p.paths } }, 'paths resolved');
  if (rec.state.value !== 'pending' || rec.ourAnswer !== undefined) return;
  if (allInside && rec.autoAnswerAllowed && !rec.suspect && !rec.adopted) answerPermission(ctx, rec.key, { behavior: 'allow' }, 'policy');
  else {
    const cur = permRec(ctx, rec.key);
    if (cur !== undefined) ask(ctx, cur);
  }
}

// ------------------------------------------------------------------ validation (§3.7 step 4)
type Validation = { ok: true; decision: PermissionDecision } | { ok: false; error: CcdErrorData; keepPending: boolean };

function invalid(reason: string, message: string, keepPending = false): Validation {
  return { ok: false, error: err('E_PERMISSION_INVALID', message, { reason }), keepPending };
}

function validateUpdates(ctx: Ctx, ups: unknown): { ok: true; value: PermissionUpdate[] } | { ok: false; v: Validation } {
  if (ups === undefined) return { ok: true, value: [] };
  if (!Array.isArray(ups)) return { ok: false, v: invalid('updatedPermissions', 'updatedPermissions must be an array') };
  const out: PermissionUpdate[] = [];
  for (const u of ups as unknown[]) {
    if (!isRecord(u)) return { ok: false, v: invalid('updatedPermissions', 'updatedPermissions entries must be objects') };
    const type = u['type'];
    if (type === 'setMode') {
      const mode = u['mode'];
      if (typeof mode !== 'string') return { ok: false, v: invalid('setMode', 'setMode needs a mode') };
      if (DANGEROUS_MODES.has(mode) && !cfg(ctx).permissions.allowDangerousModes)
        return { ok: false, v: invalid('dangerousMode', `mode ${mode} needs allowDangerousModes`) };
      if (!SAFE_MODES.has(mode) && !DANGEROUS_MODES.has(mode)) return { ok: false, v: invalid('setMode', `unknown mode ${mode}`) };
      out.push({ type: 'setMode', mode: mode as 'default', destination: 'session' });
      continue;
    }
    if (type === 'addRules' || type === 'replaceRules' || type === 'removeRules') {
      const rules = u['rules'];
      const behavior = u['behavior'];
      if (!Array.isArray(rules) || !(behavior === 'allow' || behavior === 'deny' || behavior === 'ask'))
        return { ok: false, v: invalid('rules', 'rules update needs rules[] and behavior') };
      const rs: { toolName: string; ruleContent?: string }[] = [];
      for (const r of rules as unknown[]) {
        if (!isRecord(r) || typeof r['toolName'] !== 'string') return { ok: false, v: invalid('rules', 'each rule needs a toolName') };
        const rule: { toolName: string; ruleContent?: string } = { toolName: r['toolName'] };
        if (typeof r['ruleContent'] === 'string') rule.ruleContent = r['ruleContent'];
        rs.push(rule);
      }
      out.push({ type, rules: rs, behavior, destination: 'session' }); // destination forced to session (D-18, SEC §4.4)
      continue;
    }
    if (type === 'addDirectories') {
      if (!cfg(ctx).permissions.allowAddDirectories)
        return { ok: false, v: invalid('addDirectories', 'addDirectories needs allowAddDirectories') };
      out.push({ ...(u as object), destination: 'session' } as unknown as PermissionUpdate);
      continue;
    }
    return { ok: false, v: invalid('updatedPermissions', `unknown update type ${String(type)}`) };
  }
  return { ok: true, value: out };
}

function validateDecision(ctx: Ctx, rec: PermissionRecord, d: unknown): Validation {
  if (!isRecord(d)) return invalid('shape', 'decision must be an object');
  const behavior = d['behavior'];
  if (behavior === 'deny') {
    const dec: PermissionDecision = { behavior: 'deny' };
    if (typeof d['message'] === 'string') dec.message = sanitizeMessage(d['message']);
    if (d['interrupt'] === true) dec.interrupt = true;
    return { ok: true, decision: dec };
  }
  if (behavior !== 'allow') return invalid('behavior', 'behavior must be allow or deny');
  const updatedInput = d['updatedInput'];
  if (rec.needs !== 'decision' && updatedInput === undefined) {
    return invalid(
      'structuredAnswerRequired',
      `${rec.toolName} needs ${rec.needs === 'answers' ? 'answerQuestion()' : 'approvePlan()'} or an explicit updatedInput`,
      true,
    );
  }
  if (updatedInput !== undefined && !isRecord(updatedInput))
    return invalid('updatedInput', 'updatedInput must keep the tool input object shape');
  // §3.7 step 4 (rev 2 §10 G7): AskUserQuestion is answered only with its answers; an allow without them does nothing
  if (rec.needs === 'answers' && (!isRecord(updatedInput) || !isRecord(updatedInput['answers']))) {
    return invalid('structuredAnswerRequired', `${rec.toolName} needs answerQuestion() (updatedInput.answers)`, true);
  }
  const ups = validateUpdates(ctx, d['updatedPermissions']);
  if (!ups.ok) return ups.v;
  const dec: PermissionDecision = { behavior: 'allow' };
  if (updatedInput !== undefined) dec.updatedInput = updatedInput;
  if (ups.value.length > 0) dec.updatedPermissions = ups.value;
  return { ok: true, decision: dec };
}

// ------------------------------------------------------------------ answering
export type AnswerResult = { ok: true } | { ok: false; error: CcdErrorData };

/** Write our decision: to the held hook (pending), or by keys (dialogOnly: deny = Escape, allow only with screenAllow). */
export function answerPermission(
  ctx: Ctx,
  k: PermissionKey,
  decision: unknown,
  by: 'host' | 'handler' | 'policy' | 'timeout' | 'close',
): AnswerResult {
  const rec = permRec(ctx, k);
  if (rec === undefined) return { ok: false, error: err('E_PERMISSION_UNKNOWN', `unknown permission ${k}`) };
  if (!isPermOpen(rec.state.value) || rec.ourAnswer !== undefined || rec.state.value === 'answered' || keysQueued(ctx, k)) {
    return {
      ok: false,
      error: err('E_PERMISSION_INVALID', `permission ${k} is not pending`, { reason: 'notPending', state: rec.state.value }),
    };
  }
  const v = validateDecision(ctx, rec, decision);
  let dec: PermissionDecision;
  let result: AnswerResult = { ok: true };
  if (!v.ok) {
    if (v.keepPending) return { ok: false, error: v.error };
    // invalid decision → error to the caller and deny to Claude (fail closed, D-18)
    dec = { behavior: 'deny', message: 'Denied: invalid decision' };
    result = { ok: false, error: v.error };
  } else dec = v.decision;
  if (rec.state.value === 'pending' && rec.hookSeq !== undefined) {
    emit<'hook.respond'>(ctx, { kind: 'hook.respond', hookSeq: rec.hookSeq, body: bodyOf(dec) });
    const answer = { decision: dec.behavior, by, via: 'hook' as const, seq: seqOf(ctx) };
    setPermState(ctx, k, 'answered', { ourAnswer: answer });
    disarm(ctx, 'permissionPolicy', k);
    // a handler still running learns the record left pending through its AbortSignal (§3.7 step 3): every answer but the
    // handler's own cancels the ask; the handler's own run removes its controller
    if (by === 'policy' || by === 'timeout' || by === 'close') cancelAsk(ctx, k, by);
    else if (by === 'host') cancelAsk(ctx, k, 'answered');
    else
      updRecon(ctx, (r) => {
        const { [k]: _gone, ...rest } = r.asks;
        return { ...r, asks: rest };
      });
    publish(ctx, 'permission.answered', { permissionKey: k, decision: dec.behavior, by, via: 'hook' }, { turnKey: recon(ctx).permTurn[k] });
    const t = toolRec(ctx, rec.tool);
    if (t !== undefined && !isToolTerminal(t.state.value)) {
      if (dec.behavior === 'allow') setToolState(ctx, t.key, 'running', { provisional: true, src: 'self' });
      else setToolState(ctx, t.key, 'denied', { provisional: true, src: 'self', outcomeFrom: 'permission_deny' });
    }
    return result;
  }
  // dialogOnly: keys
  if (dec.behavior === 'deny') {
    queueKeys(ctx, k, 'deny', by);
    return result;
  }
  if (!cfg(ctx).permissions.screenAllow) {
    return { ok: false, error: err('E_PERMISSION_INVALID', 'allow by keys needs screenAllow:true', { reason: 'screenAllowDisabled' }) };
  }
  if (rec.needs !== 'decision' || rec.suspect) {
    return {
      ok: false,
      error: err('E_PERMISSION_INVALID', 'this dialog cannot be allowed by keys', { reason: rec.suspect ? 'suspect' : 'structured' }),
    };
  }
  const f = recon(ctx).lastFrame;
  // SEC §4.3: the option at the key reads exactly `Yes` (never `Yes, and …`, which adds a rule or switches the mode), and it is
  // the only such option (a second one means the parse is not the dialog's own block, P-REV-29).
  const yeses = f?.dialog?.options.filter((op) => op.label.trim() === 'Yes' && op.n !== undefined && op.n >= 1 && op.n <= 9) ?? [];
  const yes = yeses.length === 1 ? yeses[0] : undefined;
  if (f?.surface !== 'permissionDialog' || yes?.n === undefined) {
    return { ok: false, error: err('E_PERMISSION_INVALID', 'no "Yes" option visible on the permission dialog', { reason: 'noOption' }) };
  }
  queueKeys(ctx, k, { digit: yes.n }, by);
  return result;
}

/** A permissionKeys job of this record is queued or running: its answer is taken (ICR 0028 item 2). */
function keysQueued(ctx: Ctx, k: PermissionKey): boolean {
  return Object.values(inputState(ctx).jobs).some((j) => j.kind === 'permissionKeys' && j.permission === k);
}

/**
 * Answer a dialogOnly record by keys: one job per record (a second answer is notPending until the job ends) and every
 * other asker is cancelled, so the handler and the host cannot both press a key. ICR 0028 item 2.
 */
function queueKeys(ctx: Ctx, k: PermissionKey, action: 'deny' | { digit: number }, by: Parameters<typeof answerPermission>[3]): void {
  enqueueJob(ctx, permissionKeysJob({ key: mint(ctx, 'job'), seq: ctx.core.counters.job, createdAt: nowOf(ctx) }, k, action), true);
  disarm(ctx, 'permissionPolicy', k);
  cancelAsk(ctx, k, by === 'host' || by === 'handler' ? 'answered' : by);
}

/** permissionKeys job ended (outcome): record our answer via keys. */
export function onPermissionKeysDone(ctx: Ctx, k: PermissionKey, action: 'deny' | { digit: number }, ok: boolean): void {
  const rec = permRec(ctx, k);
  if (rec === undefined) return;
  if (!ok) {
    publish(ctx, 'warning', {
      code: 'E_PERMISSION_INVALID',
      message: `keys for permission ${k} did not close the dialog`,
      detail: { permissionKey: k },
    });
    return;
  }
  const decision: 'allow' | 'deny' = action === 'deny' ? 'deny' : 'allow';
  if (rec.ourAnswer === undefined) {
    putPerm(ctx, { ...rec, ourAnswer: { decision, by: 'host', via: 'keys', seq: seqOf(ctx) } }, 'answered by keys');
    publish(ctx, 'permission.answered', { permissionKey: k, decision, by: 'host', via: 'keys' }, { turnKey: recon(ctx).permTurn[k] });
  }
}

/** permission.answer / answerQuestion / approvePlan commands (§3.7 step 4, structured tools rev 2 §10 G7). */
export function onPermissionCommand(
  ctx: Ctx,
  cmd: Extract<Command, { type: 'permission.answer' | 'permission.answerQuestion' | 'permission.approvePlan' }>,
): AnswerResult {
  const rec = permRec(ctx, cmd.permissionKey);
  if (rec === undefined) return { ok: false, error: err('E_PERMISSION_UNKNOWN', `unknown permission ${cmd.permissionKey}`) };
  switch (cmd.type) {
    case 'permission.answer':
      return answerPermission(ctx, rec.key, cmd.decision, cmd.by);
    case 'permission.answerQuestion': {
      if (rec.needs !== 'answers')
        return { ok: false, error: err('E_PERMISSION_INVALID', 'not an AskUserQuestion request', { reason: 'notAQuestion' }) };
      const base = isRecord(rec.input) ? rec.input : {};
      return answerPermission(ctx, rec.key, { behavior: 'allow', updatedInput: { ...base, answers: cmd.answers } }, 'host');
    }
    case 'permission.approvePlan': {
      if (rec.needs !== 'planApproval')
        return { ok: false, error: err('E_PERMISSION_INVALID', 'not an ExitPlanMode request', { reason: 'notAPlan' }) };
      if (!cmd.approve) return answerPermission(ctx, rec.key, { behavior: 'deny', message: cmd.feedback ?? 'Plan rejected' }, 'host');
      // K-36: a dangerous mode is impossible by type and refused at runtime, exactly like mode.set (ICR 0016)
      if (cmd.mode !== undefined && DANGEROUS_MODES.has(cmd.mode) && !cfg(ctx).permissions.allowDangerousModes)
        return {
          ok: false,
          error: err('E_MODE_FORBIDDEN', `mode ${cmd.mode} needs allowDangerousModes`, { reason: 'dangerousMode', mode: cmd.mode }),
        };
      const dec: Record<string, unknown> = { behavior: 'allow', updatedInput: isRecord(rec.input) ? rec.input : {} };
      if (cmd.mode !== undefined) dec['updatedPermissions'] = [{ type: 'setMode', mode: cmd.mode, destination: 'session' }];
      return answerPermission(ctx, rec.key, dec, 'host');
    }
  }
}

// ------------------------------------------------------------------ deadlines and hook lifecycle
/** permissionPolicy fired (§3.7 step 3): onTimeout 'deny' → deny; 'tui' → empty reply, the native dialog stays. */
export function onPolicyDeadline(ctx: Ctx, k: PermissionKey): void {
  const rec = permRec(ctx, k);
  if (rec === undefined || rec.ourAnswer !== undefined || !isPermOpen(rec.state.value) || rec.state.value === 'answered') return;
  cancelAsk(ctx, k, 'timeout');
  if (rec.state.value === 'dialogOnly') {
    if (cfg(ctx).permissions.onTimeout === 'deny')
      answerPermission(ctx, k, { behavior: 'deny', message: 'Denied: permission timeout' }, 'timeout');
    return;
  }
  if (cfg(ctx).permissions.onTimeout === 'deny') {
    answerPermission(ctx, k, { behavior: 'deny', message: 'Denied: permission timeout' }, 'timeout');
    return;
  }
  if (rec.hookSeq !== undefined) emit<'hook.respond'>(ctx, { kind: 'hook.respond', hookSeq: rec.hookSeq, body: null });
  setPermState(ctx, k, 'dialogOnly');
  publish(ctx, 'permission.needsKeys', { permissionKey: k }, { turnKey: recon(ctx).permTurn[k] });
}

/** permission.hookClosed before we answered → dialogOnly + needsKeys (§3.7 step 7). */
export function onHookClosed(ctx: Ctx, o: Extract<Observation, { kind: 'permission.hookClosed' }>): void {
  const k = recon(ctx).aliases.hookSeq[o.p.hookSeq];
  const rec = permRec(ctx, k);
  if (rec === undefined || k === undefined) return;
  if (o.p.reason === 'answered' || rec.state.value !== 'pending') return;
  setPermState(ctx, k, 'dialogOnly');
  publish(ctx, 'permission.needsKeys', { permissionKey: k }, { turnKey: recon(ctx).permTurn[k] });
}

export function onHookResponded(ctx: Ctx, o: Extract<Observation, { kind: 'hook.responded' }>): void {
  const k = recon(ctx).aliases.hookSeq[o.p.hookSeq];
  if (k === undefined) return;
  if (!o.p.ok || o.p.clientGone) {
    diag(ctx, 'hook_respond_failed', { permissionKey: k, clientGone: o.p.clientGone });
    const rec = permRec(ctx, k);
    // Our answer never reached Claude (forwarder gone, or the seq was no longer held): the native dialog is what remains,
    // so the record falls back to keys and our undelivered answer is dropped so the host can answer the dialog (§3.7 step 7).
    if (rec?.state.value === 'answered') {
      setPermState(ctx, k, 'dialogOnly');
      const cur = permRec(ctx, k);
      if (cur !== undefined && cur.ourAnswer?.via === 'hook') {
        const { ourAnswer: _undelivered, ...rest } = cur;
        putPerm(ctx, rest, 'hook answer undelivered');
      }
      publish(ctx, 'permission.needsKeys', { permissionKey: k }, { turnKey: recon(ctx).permTurn[k] });
    }
  }
}

/** Unbound at request and nothing matched within permBindLateMs: stays unbound, auto-answer off. */
export function onBindLateDeadline(ctx: Ctx, ref: string): void {
  if (ref.startsWith('gone:')) {
    const k = ref.slice('gone:'.length) as PermissionKey;
    const rec = permRec(ctx, k);
    if (rec?.state.value === 'dialogOnly' && rec.resolved === undefined) abandonPermission(ctx, k, 'dialogGone');
    return;
  }
  const rec = permRec(ctx, ref as PermissionKey);
  if (rec !== undefined && rec.tool === undefined) diag(ctx, 'permission_unbound', { permissionKey: rec.key, toolName: rec.toolName });
}

/** A late tool.pre / transcript tool_use binds an unbound request (§4.5.1). */
export function tryLateBind(ctx: Ctx, toolKey: ToolKey): void {
  const t = toolRec(ctx, toolKey);
  if (t === undefined || t.permission !== undefined) return;
  const window = cfg(ctx).timeouts.permBindLateMs;
  for (const rec of Object.values(dom(ctx).permissions)) {
    if (rec.tool !== undefined || !isPermOpen(rec.state.value) || rec.adopted) continue;
    if (nowOf(ctx) - rec.requestedAt > window) continue;
    const agentId = recon(ctx).permAgentId[rec.key];
    const carried = agentId !== undefined || rec.agent !== undefined;
    if (!lateBindMatches(dom(ctx), t, { toolName: rec.toolName, input: rec.input, agent: rec.agent, agentCarried: carried, agentId }))
      continue;
    putPerm(
      ctx,
      { ...rec, tool: toolKey, binding: { kind: rec.binding.kind === 'unbound' ? 'unique' : rec.binding.kind, confirmed: false } },
      'late bind',
    );
    putTool(ctx, { ...t, permission: rec.key }, 'late bind');
    disarm(ctx, 'permBindLate', rec.key);
    publish(ctx, 'permission.bound', { permissionKey: rec.key, toolKey, confirmed: false });
    if (rec.state.value === 'pending' || rec.state.value === 'dialogOnly') setToolState(ctx, toolKey, 'awaitingPermission');
    else if (rec.ourAnswer?.decision === 'allow') setToolState(ctx, toolKey, 'running', { provisional: true, src: 'self' });
    return;
  }
}

// ------------------------------------------------------------------ resolution (Claude-side evidence, §3.7 step 6)
function resolvePermission(ctx: Ctx, k: PermissionKey, decision: 'allow' | 'deny', decider: PermissionDecider): void {
  const rec = permRec(ctx, k);
  if (rec === undefined || !isPermOpen(rec.state.value)) return;
  const prev = rec.state.value;
  const ours = rec.ourAnswer;
  let overridden: boolean;
  if (decider === 'hook' || decider === 'unknown') overridden = ours !== undefined && ours.decision !== decision;
  else overridden = (prev === 'pending' || prev === 'answered') && !(ours?.via === 'keys' && ours.decision === decision);
  const held = prev === 'pending' && rec.hookSeq !== undefined && ours === undefined;
  setPermState(ctx, k, 'resolved', {
    resolved: { decision, decider, overridden },
    binding: { ...rec.binding, confirmed: rec.tool !== undefined },
  });
  if (held && rec.hookSeq !== undefined) emit<'hook.respond'>(ctx, { kind: 'hook.respond', hookSeq: rec.hookSeq, body: null }); // release (HT §9.2)
  disarm(ctx, 'permissionPolicy', k);
  disarm(ctx, 'permBindLate', `gone:${k}`);
  cancelAsk(ctx, k, 'resolved');
  publish(ctx, 'permission.resolved', { permissionKey: k, decision, decider, overridden }, { turnKey: recon(ctx).permTurn[k] });
  const t = toolRec(ctx, rec.tool);
  if (t !== undefined && !isToolTerminal(t.state.value)) {
    if (decision === 'allow' && (t.state.value === 'awaitingPermission' || t.state.value === 'pending'))
      setToolState(ctx, t.key, 'running');
    if (decision === 'deny') setToolState(ctx, t.key, 'denied', { outcomeFrom: 'permission_deny' });
  }
}

/**
 * §4.5.1 "evidence of a wrong guess → permission.rebound": the attachment names a tool that has no permission while an
 * open, unconfirmed record of the same tool name and canonical-equal input is bound to another tool (an
 * `ambiguous-equivalent` FIFO guess). The record moves to the named tool; the other tool keeps its state and becomes
 * free for the next request. The decision itself was written to the request's own response, so only the label moves.
 */
function rebindWrongGuess(ctx: Ctx, toolKey: ToolKey): PermissionKey | undefined {
  const t = toolRec(ctx, toolKey);
  if (t === undefined) return undefined;
  const rec = Object.values(dom(ctx).permissions)
    .filter(
      (r) =>
        r.tool !== undefined &&
        r.tool !== toolKey &&
        !r.binding.confirmed &&
        isPermOpen(r.state.value) &&
        r.toolName === t.name &&
        canonicalEq(r.input, t.input),
    )
    .sort((a, b) => a.requestedAt - b.requestedAt || (a.key < b.key ? -1 : 1))[0];
  if (rec === undefined) return undefined;
  const old = toolRec(ctx, rec.tool);
  if (old?.permission === rec.key) {
    const freed = { ...old };
    delete freed.permission;
    putTool(ctx, freed, 'permission rebound away');
  }
  putPerm(ctx, { ...rec, tool: toolKey, binding: { kind: rec.binding.kind, confirmed: true } }, 'permission rebound');
  putTool(ctx, { ...t, permission: rec.key }, 'permission rebound');
  if (!isToolTerminal(t.state.value) && (t.state.value === 'pending' || t.state.value === 'proposed'))
    setToolState(ctx, toolKey, 'awaitingPermission');
  publish(ctx, 'permission.rebound', { permissionKey: rec.key, toolKey, confirmed: true }, { turnKey: recon(ctx).permTurn[rec.key] });
  return rec.key;
}

/** permission.decisionRecorded (transcript attachment / tool_result permissionDecision). */
export function onDecisionRecorded(ctx: Ctx, o: Extract<Observation, { kind: 'permission.decisionRecorded' }>): void {
  const p = o.p;
  const t = Object.values(dom(ctx).tools).find((x) => x.toolUseId === p.toolUseId);
  let k = t?.permission;
  if (k === undefined && t !== undefined && p.via === 'attachment') {
    // bind an unbound / screen-only record of this very tool: same name, canonical-equal input and the agent rule (as a
    // late bind), or an adopted dialog record; with several, the one whose answer matches the decision; still ambiguous →
    // no bind (a wrong binding would release or resolve another request's hook, SEC §4.2). ICR 0021 item 8.
    const want = p.decision === 'accept' ? 'allow' : 'deny';
    let cands = Object.values(dom(ctx).permissions).filter((r) => {
      if (r.tool !== undefined || !isPermOpen(r.state.value)) return false;
      if (r.adopted) return true; // a screen-adopted dialog has no reliable name/input; ambiguity is checked below
      const agentId = recon(ctx).permAgentId[r.key];
      const carried = agentId !== undefined || r.agent !== undefined;
      return lateBindMatches(dom(ctx), t, { toolName: r.toolName, input: r.input, agent: r.agent, agentCarried: carried, agentId });
    });
    if (cands.length > 1) {
      const answered = cands.filter((r) => r.ourAnswer?.decision === want);
      if (answered.length > 0) cands = answered;
    }
    const cand = cands.length === 1 ? cands[0] : undefined;
    if (cands.length > 1) diag(ctx, 'attachment_bind_ambiguous', { toolUseId: p.toolUseId, candidates: cands.map((r) => r.key) });
    if (cand !== undefined) {
      putPerm(ctx, { ...cand, tool: t.key, binding: { kind: cand.binding.kind, confirmed: true } }, 'bound by attachment');
      putTool(ctx, { ...t, permission: cand.key }, 'bound by attachment');
      publish(ctx, 'permission.bound', { permissionKey: cand.key, toolKey: t.key, confirmed: true });
      k = cand.key;
    } else {
      k = rebindWrongGuess(ctx, t.key);
    }
  }
  if (k === undefined) {
    diag(ctx, 'decision_without_permission', { toolUseId: p.toolUseId, decider: p.decider });
    if (t !== undefined && p.decision === 'reject' && !isToolTerminal(t.state.value))
      setToolState(ctx, t.key, 'denied', { outcomeFrom: 'permission_deny' });
    return;
  }
  resolvePermission(ctx, k, p.decision === 'accept' ? 'allow' : 'deny', p.decider);
}

/** PermissionDenied hook (auto-mode classifier). */
export function onAutoDenied(ctx: Ctx, o: Extract<Observation, { kind: 'permission.autoDenied' }>): void {
  const t = Object.values(dom(ctx).tools).find((x) => x.toolUseId === o.p.toolUseId);
  if (t === undefined) return;
  if (t.permission !== undefined) resolvePermission(ctx, t.permission, 'deny', 'classifier');
  if (!isToolTerminal(t.state.value)) setToolState(ctx, t.key, 'denied', { outcomeFrom: 'permission_deny', error: o.p.reason });
}

/** Tool evidence that resolves its permission: ran → allow; denied by transcript → deny (decider from the denial kind). */
export function onToolOutcome(ctx: Ctx, toolKey: ToolKey, state: ToolState, denialKind?: string): void {
  const t = toolRec(ctx, toolKey);
  const k = t?.permission;
  const rec = permRec(ctx, k);
  if (rec === undefined || k === undefined || !isPermOpen(rec.state.value)) return;
  if (state === 'succeeded' || state === 'failed' || state === 'running' || state === 'launched') {
    // The request reached us, so no allow rule decided it. With no allow of ours (released / empty reply / Claude's own
    // hook timeout) the only thing that can have allowed the tool is the dialog → a human at the pane (K-10, ICR 0016).
    const ours = rec.ourAnswer;
    const decider: PermissionDecider =
      ours?.via === 'hook' && ours.decision === 'allow'
        ? 'hook'
        : ours?.decision !== 'allow' || ours.via === 'keys'
          ? 'user_keys'
          : 'unknown';
    resolvePermission(ctx, k, 'allow', decider);
  } else if (state === 'interrupted' && rec.ourAnswer?.via === 'hook' && rec.ourAnswer.decision === 'allow') {
    resolvePermission(ctx, k, 'allow', 'hook'); // it ran on our allow and was then interrupted (F-4)
  } else if (state === 'denied') {
    const decider: PermissionDecider =
      denialKind === 'user-rejected'
        ? 'user_keys'
        : denialKind === 'permission-rule'
          ? 'config'
          : rec.ourAnswer?.via === 'hook'
            ? 'hook'
            : 'unknown';
    resolvePermission(ctx, k, 'deny', decider);
  }
}

// ------------------------------------------------------------------ dialog adoption (§3.7 step 8)
const DIALOG_CLAIMS = ['surface:permissionDialog', 'dialog:permission', 'dialog:question', 'dialog:planApproval'];

/**
 * §3.7 step 8: a visible permission dialog is adopted unless a record of the active turn is pending|answered|dialogOnly.
 * Records of other turns and of session-scoped (background / teammate) agents do not stand for it — except a dialogOnly
 * record of any scope, which is by definition the native dialog on screen (abandoned once that dialog leaves). ICR 0028.
 */
export function adoptionBlocked(ctx: Ctx): boolean {
  const active = dom(ctx).activeTurn;
  return Object.values(dom(ctx).permissions).some((p) => {
    const s = p.state.value;
    if (s === 'dialogOnly') return true;
    if (s !== 'pending' && s !== 'answered') return false;
    return isMainScoped(ctx, p) && recon(ctx).permTurn[p.key] === active;
  });
}

export function permissionDialogShown(ctx: Ctx): string | undefined {
  for (const k of DIALOG_CLAIMS) if (assertedClaim(ctx, k) !== undefined) return k;
  return undefined;
}

/** A permission-like dialog claim was asserted with no open record → adopt after adoptDialogMs. */
export function onPermissionDialogAsserted(ctx: Ctx): void {
  if (dom(ctx).lifecycle !== 'ready' && dom(ctx).lifecycle !== 'closing') return;
  if (adoptionBlocked(ctx)) return;
  if (recon(ctx).deadlines['adoptDialog:dialog'] !== undefined) return;
  arm(ctx, 'adoptDialog', 'dialog', nowOf(ctx) + cfg(ctx).timeouts.adoptDialogMs);
}

/**
 * Step end: a permission dialog claim that stays asserted while the records that blocked its adoption close is adopted
 * after all (a claim on screen never asserts again). The claim may still be the closed record's own dialog on a frame
 * that is about to change, so the retry waits a full idle poll beyond adoptDialogMs: a dialog that left produces a new
 * frame and its claim expires; one that stays produces none (an unchanged screen) and is adopted. ICR 0028 item 8.
 */
export function retryDialogAdoption(ctx: Ctx): void {
  if (recon(ctx).deadlines['adoptDialog:dialog'] !== undefined) return;
  if (dom(ctx).lifecycle !== 'ready' && dom(ctx).lifecycle !== 'closing') return;
  if (permissionDialogShown(ctx) === undefined || adoptionBlocked(ctx)) return;
  const c = cfg(ctx);
  arm(ctx, 'adoptDialog', 'dialog', nowOf(ctx) + c.timeouts.adoptDialogMs + c.channels.screen.idlePollMs);
}

export function onAdoptDeadline(ctx: Ctx): void {
  const claimKey = permissionDialogShown(ctx);
  if (claimKey === undefined || adoptionBlocked(ctx)) return;
  const c = assertedClaim(ctx, claimKey);
  const v = c?.value;
  const title = isRecord(v) && typeof v['title'] === 'string' ? v['title'] : undefined;
  const kind = isRecord(v) && typeof v['kind'] === 'string' ? v['kind'] : undefined;
  const needs: PermissionRecord['needs'] =
    kind === 'question' || claimKey === 'dialog:question'
      ? 'answers'
      : kind === 'planApproval' || claimKey === 'dialog:planApproval'
        ? 'planApproval'
        : 'decision';
  const recent = Object.values(dom(ctx).tools).filter(
    (t) =>
      (t.state.value === 'pending' || t.state.value === 'awaitingPermission') &&
      t.preAt !== undefined &&
      nowOf(ctx) - t.preAt <= ADOPT_SUSPECT_WINDOW_MS + cfg(ctx).timeouts.adoptDialogMs,
  );
  const named = title === undefined ? recent : recent.filter((t) => title.includes(t.name) || t.name.includes(title));
  const match = named.length === 1 ? named[0] : recent.length === 1 ? recent[0] : undefined;
  const key = mint(ctx, 'perm');
  const toolName =
    match?.name ?? (needs === 'answers' ? 'AskUserQuestion' : needs === 'planApproval' ? 'ExitPlanMode' : (title ?? 'unknown'));
  const rec: PermissionRecord = {
    key,
    toolName,
    input: match?.input ?? null,
    suggestions: [],
    binding: { kind: 'screen-only', confirmed: false },
    state: mkFact<PermState>('dialogOnly', 'screen', seqOf(ctx), nowOf(ctx), true),
    autoAnswerAllowed: false,
    needs,
    requestedAt: nowOf(ctx),
    suspect: match === undefined,
    adopted: true,
    provenance: newProvenance(ctx, 'screen'),
  };
  if (match !== undefined) {
    rec.tool = match.key;
    putTool(ctx, { ...match, permission: key }, 'adopted dialog');
    setToolState(ctx, match.key, 'awaitingPermission', { provisional: true, src: 'screen' });
  }
  putPerm(ctx, rec, 'dialog adopted');
  const turn = match?.turn ?? mainTurn(ctx)?.key;
  if (turn !== undefined) updRecon(ctx, (r) => ({ ...r, permTurn: { ...r.permTurn, [key]: turn } }));
  arm(ctx, 'permissionPolicy', key, nowOf(ctx) + cfg(ctx).permissions.timeoutMs); // before publishRequested: it carries the deadline
  publishRequested(ctx, rec);
  publish(ctx, 'permission.needsKeys', { permissionKey: key }, { turnKey: turn, confirmed: false, sources: ['screen'] });
  // deny stays deny (§3.7 step 2): a deny policy denies an adopted dialog by keys; other policies ask the host
  if (cfg(ctx).permissions.policy === 'deny') answerPermission(ctx, key, { behavior: 'deny' }, 'policy');
  else ask(ctx, rec);
}

/** The permission dialog claim ended: dialogOnly records with no evidence are abandoned after permBindLateMs. */
export function onPermissionDialogGone(ctx: Ctx): void {
  disarm(ctx, 'adoptDialog', 'dialog');
  for (const rec of Object.values(dom(ctx).permissions)) {
    if (rec.state.value === 'dialogOnly' && rec.resolved === undefined)
      arm(ctx, 'permBindLate', `gone:${rec.key}`, nowOf(ctx) + cfg(ctx).timeouts.permBindLateMs);
  }
}

// ------------------------------------------------------------------ closing
/** Closing (turn closed, generation ended, process exit): abandoned + release if held (§3.7 step 9). */
export function abandonPermission(ctx: Ctx, k: PermissionKey, reason: string): void {
  const rec = permRec(ctx, k);
  if (rec === undefined || !isPermOpen(rec.state.value)) return;
  const held = rec.state.value === 'pending' && rec.hookSeq !== undefined && rec.ourAnswer === undefined && dom(ctx).lifecycle !== 'exited';
  setPermState(ctx, k, 'abandoned');
  if (held && rec.hookSeq !== undefined) emit<'hook.respond'>(ctx, { kind: 'hook.respond', hookSeq: rec.hookSeq, body: null });
  disarm(ctx, 'permissionPolicy', k);
  disarm(ctx, 'permBindLate', k);
  disarm(ctx, 'permBindLate', `gone:${k}`);
  cancelAsk(ctx, k, reason);
  publish(ctx, 'permission.abandoned', { permissionKey: k, reason }, { turnKey: recon(ctx).permTurn[k] });
}

/** close(): deny every held request (D-18, SEC §4.1). */
export function denyAllHeld(ctx: Ctx): void {
  for (const rec of Object.values(dom(ctx).permissions)) {
    if (rec.state.value === 'pending' && rec.hookSeq !== undefined) answerPermission(ctx, rec.key, CLOSE_DENY, 'close');
  }
}

export function permissionsOfTurn(ctx: Ctx, turn: string): PermissionKey[] {
  const out: PermissionKey[] = [];
  for (const [k, t] of Object.entries(recon(ctx).permTurn)) if (t === turn) out.push(k as PermissionKey);
  return out;
}
