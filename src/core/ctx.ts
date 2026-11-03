// core/ctx.ts — the per-step context shared by decide/*, reconcile/*, closing.ts and input-policy/* (WP-09 helper).
// Domain changes go only through `apply()` → evolve (I1); recon/input/counters are core-private and written directly here.

import type { CcdErrorCode, CcdErrorData } from '../model/errors.js';
import type { CoreConfig } from '../model/config.js';
import type { Diagnostic } from '../model/debug.js';
import type { CoreEvent, DomainEvent, InternalEvent, Provenance } from '../model/events.js';
import type { GenKey, IntentId, ObsSeq, TurnKey } from '../model/ids.js';
import type { Intent } from '../model/intents.js';
import type { JsonValue } from '../model/json.js';
import type { Observation, Source } from '../model/observation.js';
import type { EntityProvenance, LifecyclePhase, SessionState } from '../model/state.js';
import type { MonoMs, WallMs } from '../model/time.js';
import { armDeadline, clearDeadline, clearDeadlinesWhere } from './deadlines.js';
import { encodePath, evolve } from './evolve.js';
import type { PatchOp } from './evolve.js';
import type { Deadline, DeadlineKind } from './facts.js';
import type { InputPolicyState, JobOutcome, PendingCommandResult } from './input-policy/jobs.js';
import { nextKey } from './keys.js';
import type { KeyKind, KeyOf } from './keys.js';
import type { CoreInput, CoreState, ReconState } from './types.js';

export interface Ctx {
  core: CoreState;
  readonly events: DomainEvent[];
  readonly coreEvents: CoreEvent[];
  readonly intents: Intent[];
  readonly diagnostics: Diagnostic[];
  /** the input being applied (undefined while firing deadlines) */
  input?: CoreInput;
  /** set while deadlines fire (source 'clock') */
  firing?: Deadline;
  /** the commandResult of this step (one slot, §2.9) */
  result?: PendingCommandResult;
  /** turns that became terminal this step (closing rule 1 runs in step (4)) */
  readonly closedTurns: TurnKey[];
  /** job outcomes produced by the input-policy machine, consumed by step (5) */
  readonly outcomes: JobOutcome[];
}

export function newCtx(core: CoreState, input?: CoreInput): Ctx {
  const c: Ctx = { core, events: [], coreEvents: [], intents: [], diagnostics: [], closedTurns: [], outcomes: [] };
  if (input !== undefined) c.input = input;
  return c;
}

// ---------------------------------------------------------------- reads
export const dom = (ctx: Ctx): SessionState => ctx.core.domain;
export const cfg = (ctx: Ctx): CoreConfig => ctx.core.config;
export const nowOf = (ctx: Ctx): MonoMs => ctx.core.now;
export const wallOf = (ctx: Ctx): WallMs => ctx.core.wallNow;
export const recon = (ctx: Ctx): ReconState => ctx.core.recon;
export const inputState = (ctx: Ctx): InputPolicyState => ctx.core.input;

function currentObs(ctx: Ctx): Observation | undefined {
  return ctx.input?.type === 'obs' ? ctx.input.obs : undefined;
}
/** Source of the current input: the observation's source, 'self' for commands, 'clock' for deadlines. */
export function srcOf(ctx: Ctx): Source {
  if (ctx.firing !== undefined) return 'clock';
  const o = currentObs(ctx);
  if (o !== undefined) return o.meta.source;
  return 'self';
}
export function seqOf(ctx: Ctx): ObsSeq {
  const o = currentObs(ctx);
  return (o?.meta.seq ?? 0) as ObsSeq;
}
function isReplay(ctx: Ctx): boolean {
  return currentObs(ctx)?.meta.replay === true;
}

// ---------------------------------------------------------------- writes (domain via evolve only)
export function apply(ctx: Ctx, e: CoreEvent): void {
  ctx.core = { ...ctx.core, domain: evolve(ctx.core.domain, e) };
  ctx.coreEvents.push(e);
}
export function patch(ctx: Ctx, path: readonly string[], value: unknown, why: string): void {
  const op: PatchOp = { op: 'set', value: value as JsonValue, why };
  const e: InternalEvent = { type: 'x.patch', entity: encodePath(path), patch: op as unknown as JsonValue };
  apply(ctx, e);
}
export function unset(ctx: Ctx, path: readonly string[], why: string): void {
  const op: PatchOp = { op: 'unset', why };
  apply(ctx, { type: 'x.patch', entity: encodePath(path), patch: op as unknown as JsonValue });
}
export function setLifecycle(ctx: Ctx, phase: LifecyclePhase): void {
  if (dom(ctx).lifecycle !== phase) apply(ctx, { type: 'x.lifecycle', phase });
}
export function setInputBlocked(ctx: Ctx, value: SessionState['inputBlocked']): void {
  apply(ctx, { type: 'x.inputBlocked', value });
}

function setRecon(ctx: Ctx, r: ReconState): void {
  ctx.core = { ...ctx.core, recon: r };
}
export function updRecon(ctx: Ctx, f: (r: ReconState) => ReconState): void {
  setRecon(ctx, f(ctx.core.recon));
}
export function setInputState(ctx: Ctx, s: InputPolicyState): void {
  ctx.core = { ...ctx.core, input: s };
}

export function mint<K extends KeyKind>(ctx: Ctx, kind: K): KeyOf[K] {
  const [k, counters] = nextKey(ctx.core.counters, kind);
  ctx.core = { ...ctx.core, counters };
  return k;
}

// ---------------------------------------------------------------- deadlines
export function arm(ctx: Ctx, kind: DeadlineKind, ref: string, at: number, clock: 'mono' | 'wall' = 'mono'): void {
  updRecon(ctx, (r) => armDeadline(r, kind, ref, at, clock));
}
export function disarm(ctx: Ctx, kind: DeadlineKind, ref: string): void {
  updRecon(ctx, (r) => clearDeadline(r, kind, ref));
}
export function disarmWhere(ctx: Ctx, pred: (d: Deadline) => boolean): void {
  updRecon(ctx, (r) => clearDeadlinesWhere(r, pred));
}

// ---------------------------------------------------------------- outputs
export function diag(ctx: Ctx, code: string, detail: JsonValue = null): void {
  const d: Diagnostic = { code, at: ctx.core.now, detail };
  ctx.diagnostics.push(d);
  updRecon(ctx, (r) => {
    const anomalies = r.anomalies.length >= 256 ? [...r.anomalies.slice(r.anomalies.length - 255), d] : [...r.anomalies, d];
    return { ...r, anomalies };
  });
}
export function countConflict(ctx: Ctx, key: string): void {
  updRecon(ctx, (r) => ({ ...r, conflicts: { ...r.conflicts, [key]: (r.conflicts[key] ?? 0) + 1 } }));
}

type DistributiveOf<T extends DomainEvent['type']> = DomainEvent extends infer E
  ? E extends { type: infer U }
    ? T extends U
      ? E
      : never
    : never
  : never;
export type EventOf<T extends DomainEvent['type']> = DistributiveOf<T>;

export interface PublishOpts {
  turnKey?: TurnKey | undefined;
  gen?: GenKey | undefined;
  provenance?: Provenance;
  confirmed?: boolean;
  sources?: Source[];
}

function provenanceOf(ctx: Ctx, confirmed?: boolean, sources?: Source[]): Provenance {
  const s = srcOf(ctx);
  return { confirmed: confirmed ?? s !== 'screen', sources: sources ?? [s] };
}

export function publish<T extends DomainEvent['type']>(ctx: Ctx, type: T, payload: EventOf<T>['payload'], o: PublishOpts = {}): void {
  const seq = ctx.core.counters.event + 1;
  ctx.core = { ...ctx.core, counters: { ...ctx.core.counters, event: seq } };
  const obs = currentObs(ctx);
  const env: Record<string, unknown> = {
    v: 1,
    seq,
    type,
    at: ctx.core.now,
    wallAt: ctx.core.wallNow,
    sessionKey: ctx.core.domain.sessionKey,
    provenance: o.provenance ?? provenanceOf(ctx, o.confirmed, o.sources),
    causedBy: obs !== undefined ? [obs.meta.seq] : [],
    payload,
  };
  const gen = o.gen ?? ctx.core.domain.claude.currentGen;
  if (gen !== undefined) env['gen'] = gen;
  if (o.turnKey !== undefined) env['turnKey'] = o.turnKey;
  if (obs?.meta.replay === true) env['replayed'] = true;
  const e = env as unknown as DomainEvent;
  ctx.events.push(e);
  apply(ctx, e);
}

type IntentKind = Intent['kind'];
type IntentOf<K extends IntentKind> = Extract<Intent, { kind: K }>;
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** Text-carrying primitives and every key but Escape: what invariant I6 forbids while a permission is held (DESIGN.md §2.9 I6). */
function violatesI6(ctx: Ctx, i: WithoutId<Intent>): boolean {
  if (i.kind !== 'input') return false;
  if (!permissionHeld(ctx.core.domain)) return false;
  const p = i.primitive;
  if (p.kind === 'editorStage' || p.kind === 'pasteChunk' || p.kind === 'typeLiteral') return true;
  // only Escape (an explicit interrupt / deny-by-keys) may reach the pane while a request is held: Enter/digits answer or
  // submit, BTab cycles the mode, C-g opens the editor, Up/Down move a selection
  if (p.kind === 'key') return p.key !== 'Escape';
  return false;
}

/**
 * inputBlocked.permission: a PermissionRequest is held by our hook server (pending, not yet answered). Once we answered
 * through the hook Claude has its decision and shows no dialog; a visible dialog (dialogOnly) is inputBlocked.dialog.
 */
export function permissionHeld(d: SessionState): boolean {
  for (const p of Object.values(d.permissions)) {
    if (p.state.value === 'pending' && p.hookSeq !== undefined) return true;
  }
  return false;
}

export function emit<K extends IntentKind>(ctx: Ctx, intent: WithoutId<IntentOf<K>>): IntentId | undefined {
  if (violatesI6(ctx, intent)) {
    diag(ctx, 'I6_guard', { intent: intent.kind });
    return undefined;
  }
  if (isReplay(ctx) && intent.kind === 'screen.captureNow') return undefined;
  const id = (ctx.core.counters.intent + 1) as IntentId;
  ctx.core = { ...ctx.core, counters: { ...ctx.core.counters, intent: id } };
  ctx.intents.push({ ...intent, id } as Intent);
  return id;
}

export function captureNow(ctx: Ctx, reason: string): void {
  if (ctx.core.domain.lifecycle === 'exited') return;
  if (ctx.intents.some((i) => i.kind === 'screen.captureNow')) return;
  emit<'screen.captureNow'>(ctx, { kind: 'screen.captureNow', reason });
}

export function err(code: CcdErrorCode, message: string, details?: Record<string, JsonValue>): CcdErrorData {
  const e: CcdErrorData = { code, message };
  if (details !== undefined) e.details = details;
  return e;
}

export function setResult(ctx: Ctx, r: PendingCommandResult): void {
  if (ctx.result === undefined) ctx.result = r;
  else setInputState(ctx, { ...ctx.core.input, pendingResults: [...ctx.core.input.pendingResults, r] });
}

// ---------------------------------------------------------------- provenance helpers
export function newProvenance(ctx: Ctx, src?: Source): EntityProvenance {
  const s = src ?? srcOf(ctx);
  const seq = seqOf(ctx);
  return { sources: [s], confirmed: s !== 'screen' && s !== 'self', firstSeq: seq, lastSeq: seq };
}
export function growProvenance(p: EntityProvenance, ctx: Ctx, src?: Source): EntityProvenance {
  const s = src ?? srcOf(ctx);
  const seq = seqOf(ctx);
  const sources = p.sources.includes(s) ? p.sources : [...p.sources, s];
  const confirmed = p.confirmed || (s !== 'screen' && s !== 'self' && s !== 'clock');
  if (sources === p.sources && confirmed === p.confirmed && seq <= p.lastSeq) return p;
  return { ...p, sources, confirmed, lastSeq: Math.max(p.lastSeq, seq) as ObsSeq };
}
