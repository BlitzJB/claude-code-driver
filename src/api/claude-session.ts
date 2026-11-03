// api/claude-session.ts — `ClaudeSession`, the one public facade (DESIGN.md §2.12, D-33). It talks to L3 only through the
// SessionKernel port (§2.10) and creates kernels only through runtime/node.ts `createKernel` (§1.3 api row).
//
// Rules this file keeps (AL §6.1): no logic beyond mapping; `exited` and every `turn.done` always resolve, `accepted` has a no-op
// catch (D-31, P-API-07); no `'error'` event (P-API-08); a throwing listener is reported as a `warning` and never breaks
// delivery (P-API-06); replayed history is not delivered unless `events({ fromSeq: 0 })` asks for it (P-API-22); iterators are
// bounded and gap (P-API-09); `Symbol.asyncDispose` is installed only where the runtime has it (P-API-29). `closeAll()` and the
// signal handlers find sessions of every installed package copy through a `globalThis` registry keyed on `Symbol.for` (P-REV-43).
//
// Declaration hygiene (§1.3): no exported or public member here may name a kernel/state type (private members are emitted
// without types), so the public `.d.ts` graph stays free of internal names.

import type { Command, CommandResult } from '../model/commands.js';
import { isCcdError } from '../model/errors.js';
import type { DomainEvent } from '../model/events.js';
import type { EventSeq } from '../model/ids.js';
import type { KernelListener, PermissionAsk, SessionKernel } from '../model/kernel.js';
import type { SessionSpec } from '../model/spec.js';
import type { SessionState } from '../model/state.js';
import { EventQueue, DEFAULT_HIGH_WATER_MARK, gapEvent } from './iterators.js';
import { ClaudeSessionError, isClaudeSessionError, publicError, toPublicError, toSessionError } from './map-errors.js';
import { toPublicEvents, type EventCtx } from './map-events.js';
import { TimeBase, toSnapshot, toTurnSnapshot } from './map-state.js';
import { toSessionSpec, type ClaudeSessionOptions, type MappedOptions } from './options.js';
import type {
  AgentStatus,
  PermissionDecision,
  PermissionKey,
  PermissionMode,
  PermissionRequest,
  SessionEvent,
  SessionEventOf,
  SessionEventType,
  SessionExitInfo,
  SessionKey,
  SessionSnapshot,
  SubagentKey,
  Turn,
  TurnKey,
  TurnSnapshot,
  Unsubscribe,
  UsageInfo,
  UsageMeter,
} from './public-types.js';
import { TurnImpl } from './turn.js';

type CreateKernel = (spec: SessionSpec, o?: { logger?: MappedOptions['logger']; signal?: AbortSignal }) => Promise<SessionKernel>;
interface Closable {
  close(o?: { mode?: 'graceful' | 'kill'; graceMs?: number }): Promise<unknown>;
}

const REGISTRY_KEY = Symbol.for('claude-code-driver.api-sessions.v1');
function liveSessions(): Set<Closable> {
  const g = globalThis as unknown as Record<symbol, Set<Closable> | undefined>;
  const existing = g[REGISTRY_KEY];
  if (existing !== undefined) return existing;
  const created = new Set<Closable>();
  g[REGISTRY_KEY] = created;
  return created;
}

/** Kept finished turns per session (older finished handles are dropped from `turn(key)`; snapshots stay in `turns()`). */
const FINISHED_TURNS_KEPT = 200;

// runtime/node.ts is WP-INT's composition root. It is loaded on first start() through a variable specifier so this package
// type-checks while that file has not landed (same convention as testing/test-kernel.ts, ICR 0014); tests inject a factory.
const RUNTIME_NODE = '../runtime/node.js';
let kernelFactory: CreateKernel | undefined;
async function loadCreateKernel(): Promise<CreateKernel> {
  if (kernelFactory !== undefined) return kernelFactory;
  const m = (await import(/* @vite-ignore */ RUNTIME_NODE)) as { createKernel?: unknown };
  if (typeof m.createKernel !== 'function') throw publicError('E_INVARIANT', 'runtime/node.js does not export createKernel');
  return m.createKernel as CreateKernel;
}

/** @internal Test seam: replaces how `start()` obtains `createKernel` (`undefined` restores runtime/node.js). Not in index.ts. */
export function setKernelFactory(f: ((spec: never, o: never) => Promise<unknown>) | undefined): void {
  kernelFactory = f as CreateKernel | undefined;
}

let construct: (kernel: SessionKernel, mapped: MappedOptions) => ClaudeSession;

/** @internal Wraps an already-created kernel (tests, alternative composition roots). Not re-exported from index.ts. */
export function wrapKernel(kernel: unknown, opts: ClaudeSessionOptions): ClaudeSession {
  return construct(kernel as SessionKernel, toSessionSpec(opts));
}

type AnyListener = (e: SessionEvent) => void;

/** A replaying iterator (`events({ fromSeq })`): its own kernel subscription and the highest seq it has been handed. */
interface Replay {
  readonly q: EventQueue;
  readonly types: ReadonlySet<SessionEventType> | undefined;
  seen: number;
  unsub: Unsubscribe;
  done: boolean;
}

export class ClaudeSession implements AsyncDisposable {
  readonly key: SessionKey;
  readonly cwd: string;
  /** Always resolves (D-31). */
  readonly exited: Promise<SessionExitInfo>;
  readonly debug: { viewCommand(): string; captureScreen(): Promise<string>; readonly tracePath?: string };
  declare [Symbol.asyncDispose]: () => Promise<void>;

  private readonly kernel: SessionKernel;
  private readonly mapped: MappedOptions;
  private readonly time = new TimeBase();
  private readonly ctx: EventCtx;
  private readonly typed = new Map<SessionEventType, Set<AnyListener>>();
  private readonly any = new Set<AnyListener>();
  private readonly queues = new Set<{ q: EventQueue; types?: ReadonlySet<SessionEventType> }>();
  private readonly replays = new Set<Replay>();
  /** The `exited` event `close()` stood in with when the kernel's own session.exited had not reached us. */
  private standInExit: SessionEvent | undefined;
  private readonly turnMap = new Map<TurnKey, TurnImpl>();
  private readonly byRef = new Map<string, TurnImpl>();
  private readonly startSeq: number;
  private unsubscribe: Unsubscribe = () => undefined;
  private resolveExited!: (i: SessionExitInfo) => void;
  private exitInfo: SessionExitInfo | undefined;
  private closing: Promise<SessionExitInfo> | undefined;
  private closingMode: 'graceful' | 'kill' = 'graceful';
  private refSeq = 0;
  private cache: { state: SessionState; snap: SessionSnapshot } | undefined;
  /** Seq of the `session.exited` event (or the last seq when the kernel was already exited at wrap time). */
  private exitSeq: number | undefined;
  /** Whether listeners already got an `exited` event (the kernel's own, or the one `close()` stands in with). */
  private exitedDelivered = false;
  private readonly onAbort = (): void => void this.close({ mode: 'kill' }).catch(() => undefined);

  static {
    construct = (kernel, mapped) => new ClaudeSession(kernel, mapped);
  }

  private constructor(kernel: SessionKernel, mapped: MappedOptions) {
    this.kernel = kernel;
    this.mapped = mapped;
    this.key = kernel.sessionKey;
    this.cwd = mapped.cwd;
    this.ctx = { cwd: mapped.cwd, time: this.time };
    this.exited = new Promise((res) => {
      this.resolveExited = res;
    });
    const d = kernel.diagnostics;
    this.debug = {
      viewCommand: () => d.viewCommand(),
      captureScreen: () => d.captureScreen().catch((e: unknown) => Promise.reject(toPublicError(e))),
      ...(d.tracePath === undefined ? {} : { tracePath: d.tracePath }),
    };
    const initial = kernel.getState();
    this.startSeq = initial.lastEventSeq;
    if (mapped.handler !== undefined) kernel.setPermissionHandler((ask) => this.runHandler(ask));
    // Inclusive replay of the last pre-start event anchors the mono→wall offset; it is not delivered (seq ≤ startSeq).
    const unsub = kernel.subscribe(
      (b) => {
        this.onBatch(b);
      },
      { fromSeq: Math.max(0, initial.lastEventSeq) as EventSeq },
    );
    if (this.exitInfo === undefined) this.unsubscribe = unsub;
    else unsub();
    liveSessions().add(this);
    if (initial.exit !== undefined) {
      this.exitSeq = initial.lastEventSeq;
      this.markExited({ exitStatus: initial.exit.exitStatus, signal: initial.exit.signal, reason: 'exitedByItself' });
    } else if (mapped.signal?.aborted === true)
      this.onAbort(); // aborted while createKernel was settling
    else mapped.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  /** Resolves at ready; rejects ClaudeSessionError (E_CONFIG for invalid options, E_SESSION_CLOSED{aborted} on abort, startup codes otherwise). */
  static async start(opts: ClaudeSessionOptions): Promise<ClaudeSession> {
    const mapped = toSessionSpec(opts);
    const aborted = (): boolean => mapped.signal?.aborted === true;
    if (aborted()) throw publicError('E_SESSION_CLOSED', 'start() aborted by its signal before launch', { detail: 'aborted' });
    let kernel: SessionKernel;
    try {
      const create = await loadCreateKernel();
      kernel = await create(mapped.spec as unknown as SessionSpec, {
        ...(mapped.logger === undefined ? {} : { logger: mapped.logger }),
        ...(mapped.signal === undefined ? {} : { signal: mapped.signal }),
      });
    } catch (e) {
      // One shape for a caller's abort, whatever the abort reason was (undefined → DOMException, a string → an Error named
      // AbortError, an Error as is) and wherever start() was: the same E_SESSION_CLOSED{aborted} as an abort before launch.
      if (aborted())
        throw new ClaudeSessionError(
          'E_SESSION_CLOSED',
          'start() aborted by its signal',
          { reason: 'E_SESSION_CLOSED', detail: 'aborted' },
          { cause: e },
        );
      throw toPublicError(e);
    }
    return new ClaudeSession(kernel, mapped);
  }

  /** Closes every live session of this process (every package copy). */
  static async closeAll(): Promise<void> {
    await closeAllWith({});
  }

  get claudeSessionId(): string {
    return this.kernel.getState().claude.sessionId ?? '';
  }

  get state(): SessionSnapshot {
    return this.snap(this.kernel.getState());
  }

  get status(): AgentStatus {
    return this.state.status;
  }

  send(prompt: string, opts: { whenBusy?: 'wait' | 'reject'; signal?: AbortSignal } = {}): Turn {
    const ref = `pending:${++this.refSeq}` as TurnKey;
    const turn = new TurnImpl(this.host, prompt, ref);
    const blocked = this.blocked();
    if (blocked !== undefined) {
      turn.fail(blocked);
      return turn;
    }
    if (opts.signal?.aborted === true) {
      turn.fail(publicError('E_TURN_ABORTED', 'send() aborted by its signal before submission'));
      return turn;
    }
    this.byRef.set(ref, turn);
    const cmd = { type: 'prompt.send', text: prompt, clientRef: ref, whenBusy: opts.whenBusy ?? this.mapped.whenBusy } as const;
    this.kernel.dispatch(cmd).then(
      (r) => {
        this.bindTurn(turn, r.turnKey);
      },
      (e: unknown) => {
        this.byRef.delete(ref);
        turn.fail(toSessionError(e));
      },
    );
    const signal = opts.signal;
    if (signal !== undefined) {
      const onAbort = (): void => void turn.interrupt().catch(() => undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      void turn.done.then(() => {
        signal.removeEventListener('abort', onAbort);
      });
    }
    return turn;
  }

  async command(name: string, args?: string, opts: { unsafe?: boolean } = {}): Promise<{ output?: string }> {
    const r = await this.call({
      type: 'slash.run',
      name,
      ...(args === undefined ? {} : { args }),
      ...(opts.unsafe === undefined ? {} : { unsafe: opts.unsafe }),
    });
    return r.output === undefined ? {} : { output: r.output };
  }

  async interrupt(): Promise<{ turnKey?: TurnKey }> {
    const r = await this.call({ type: 'interrupt' });
    return r.turnKey === undefined ? {} : { turnKey: r.turnKey };
  }

  async respondToPermission(key: PermissionKey, decision: PermissionDecision): Promise<void> {
    await this.call({ type: 'permission.answer', permissionKey: key, decision, by: 'host' });
  }

  async answerQuestion(key: PermissionKey, answers: Readonly<Record<string, string>>): Promise<void> {
    await this.call({ type: 'permission.answerQuestion', permissionKey: key, answers: { ...answers } });
  }

  async approvePlan(key: PermissionKey, o: { approve: boolean; mode?: 'default' | 'acceptEdits'; feedback?: string }): Promise<void> {
    await this.call({
      type: 'permission.approvePlan',
      permissionKey: key,
      approve: o.approve,
      ...(o.mode === undefined ? {} : { mode: o.mode }),
      ...(o.feedback === undefined ? {} : { feedback: o.feedback }),
    });
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.call({ type: 'mode.set', mode });
  }

  /**
   * Current subscription usage, read from Claude's `/usage` dialog. Costs no model call; the dialog is dismissed afterwards.
   * Rejects `E_ENVIRONMENT` (`details.reason: 'noMeters'`) when the dialog shows no usage meters.
   */
  async usage(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<UsageInfo> {
    const blocked = this.blocked();
    if (blocked !== undefined) throw blocked;
    let r: Awaited<ReturnType<SessionKernel['queryUsage']>>;
    try {
      r = await this.kernel.queryUsage({
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      });
    } catch (e) {
      throw toPublicError(e);
    }
    const meters: UsageMeter[] = r.meters.map((m) => ({
      window: m.window,
      ...(m.scope === undefined ? {} : { scope: m.scope }),
      label: m.label,
      usedPct: m.usedPct,
      ...(m.resetsText === undefined ? {} : { resetsText: m.resetsText }),
    }));
    const session = meters.find((m) => m.window === 'session');
    const week = meters.find((m) => m.window === 'week' && m.scope === 'all models') ?? meters.find((m) => m.window === 'week');
    return {
      meters,
      ...(session === undefined ? {} : { session }),
      ...(week === undefined ? {} : { week }),
      ...(r.credits === undefined ? {} : { credits: r.credits }),
      ...(r.partial === true ? { partial: true as const } : {}),
      readAt: r.readAt,
    };
  }

  async wakeNow(): Promise<void> {
    await this.call({ type: 'usage.wakeNow' });
  }

  on<T extends SessionEventType>(type: T, l: (e: SessionEventOf<T>) => void): Unsubscribe {
    const set = this.typed.get(type) ?? new Set<AnyListener>();
    this.typed.set(type, set);
    const fn = l as AnyListener;
    set.add(fn);
    return () => void set.delete(fn);
  }

  onAny(l: (e: SessionEvent) => void): Unsubscribe {
    this.any.add(l);
    return () => void this.any.delete(l);
  }

  events(
    opts: { fromSeq?: number; highWaterMark?: number; types?: readonly SessionEventType[] } = {},
  ): AsyncIterableIterator<SessionEvent> {
    const types = opts.types === undefined ? undefined : new Set(opts.types);
    const hwm = opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    if (opts.fromSeq === undefined) {
      const entry: { q: EventQueue; types?: ReadonlySet<SessionEventType> } = {
        q: new EventQueue(hwm, () => this.queues.delete(entry)),
        ...(types === undefined ? {} : { types }),
      };
      if (this.exitInfo !== undefined) entry.q.end();
      else this.queues.add(entry);
      return entry.q;
    }
    // A replaying iterator has its own kernel subscription (ring replay from `fromSeq`; `gap` when retention lost events).
    // It ends on a domain session.exited, or — once the session exited — when it has been handed everything up to exitSeq
    // (close() may resolve before the kernel published session.exited; that event then never comes, ICR 0023).
    const withReplayed = opts.fromSeq === 0;
    const r: Replay = {
      q: new EventQueue(hwm, () => {
        this.dropReplay(r);
      }),
      types,
      seen: -1,
      unsub: () => undefined,
      done: false,
    };
    // Nothing at or after `fromSeq` can still come once the session exited before it: end at once instead of hanging.
    if (this.exitSeq !== undefined && opts.fromSeq > this.exitSeq) {
      r.q.end();
      return r.q;
    }
    this.replays.add(r);
    r.unsub = this.kernel.subscribe(
      (b) => {
        if (r.done) return;
        if (b.gap !== undefined) {
          r.q.push(gapEvent(b.gap.from, b.gap.to));
          r.seen = Math.max(r.seen, b.gap.to);
        }
        for (const e of b.events) {
          r.seen = Math.max(r.seen, e.seq);
          if (e.replayed === true && !withReplayed) continue;
          for (const pe of this.map(e, b.state)) if (types === undefined || types.has(pe.type)) r.q.push(pe);
          if (e.type === 'session.exited') {
            r.q.end();
            this.dropReplay(r);
            return;
          }
        }
        this.settleReplay(r);
      },
      { fromSeq: opts.fromSeq as EventSeq },
    );
    // a kernel may replay synchronously inside subscribe(): a replay that already ended there drops its subscription now
    if (r.done || r.q.isClosed) this.dropReplay(r);
    else this.settleReplay(r);
    return r.q;
  }

  /**
   * Rejects E_TIMEOUT{E_WAIT_TIMEOUT}, E_SESSION_CLOSED/… for kernel failures, the caller's own `signal.reason` as is when the
   * signal aborts (a DOMException AbortError/TimeoutError, or whatever the host passed to `abort(reason)`), and the host
   * predicate's own exception as is: neither is a library invariant failure (ICR 0029).
   */
  async waitFor(pred: (s: SessionSnapshot) => boolean, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SessionSnapshot> {
    let hostThrew: { error: unknown } | undefined;
    const guarded = (s: Readonly<SessionState>): boolean => {
      const snapshot = this.snap(s);
      try {
        return pred(snapshot);
      } catch (error) {
        hostThrew ??= { error };
        throw error;
      }
    };
    try {
      return this.snap(await this.kernel.waitFor(guarded, opts));
    } catch (e) {
      // the kernel may have wrapped a non-Error value (session/kernel.ts asError): hand back the host's own values, not the wrap
      if (hostThrew !== undefined) throw hostThrew.error;
      const sig = opts.signal;
      if (sig?.aborted === true && !isCcdError(e) && !isClaudeSessionError(e)) throw sig.reason;
      throw toPublicError(e);
    }
  }

  /** Idle with an empty library queue (a suspended session counts); rejects E_SESSION_EXITED if the session exits first. */
  waitForIdle(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SessionSnapshot> {
    return this.waitSettled(
      (s) => s.status.kind === 'suspended' || (s.status.kind === 'idle' && s.status.queued === 0 && s.queuedTurns.length === 0),
      opts,
    );
  }

  /** Idle, nothing queued, no background agents or tasks (P-LIFE-21; a suspended session counts). */
  waitForQuiescence(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SessionSnapshot> {
    return this.waitSettled(
      (s) => s.status.kind === 'suspended' || (s.status.kind === 'idle' && s.status.quiescent && s.queuedTurns.length === 0),
      opts,
    );
  }

  /**
   * Stop Claude now and keep the session (ICR 0041). The next `send`, `command`, `usage` or `setMode` resumes the same
   * conversation. Rejects `E_BUSY` (`details.blocker` names the first blocker, e.g. `permission`; `details.blockers` lists all)
   * when anything is in progress or waiting for an answer; a suspend never denies or drops a prompt.
   */
  async suspend(): Promise<void> {
    const blocked = this.blocked();
    if (blocked !== undefined) throw blocked;
    try {
      await this.kernel.suspend();
    } catch (e) {
      throw toPublicError(e);
    }
  }

  /** Resume a suspended session now (resolves at ready; no-op when live). Rejects with the start error and stays suspended. */
  async resume(): Promise<void> {
    const blocked = this.blocked();
    if (blocked !== undefined) throw blocked;
    try {
      await this.kernel.resume();
    } catch (e) {
      throw toPublicError(e);
    }
  }

  turn(key: TurnKey): Turn | undefined {
    return this.turnMap.get(key) ?? this.byRef.get(key);
  }

  turns(): readonly TurnSnapshot[] {
    const d = this.kernel.getState();
    const out: TurnSnapshot[] = [];
    for (const k of d.turnOrder) {
      const t = d.turns[k];
      if (t !== undefined && t.origin.value !== 'selftest') out.push(toTurnSnapshot(d, t, this.ctx));
    }
    return out;
  }

  /** Idempotent; a `kill` while a graceful close is still running escalates it. */
  close(opts: { mode?: 'graceful' | 'kill'; graceMs?: number; waitForBackgroundMs?: number } = {}): Promise<SessionExitInfo> {
    const mode = opts.mode ?? 'graceful';
    if (this.closing !== undefined && !(mode === 'kill' && this.closingMode === 'graceful')) return this.closing;
    this.closingMode = mode;
    const p: Promise<SessionExitInfo> = this.kernel
      .close({
        mode,
        reason: 'host',
        ...(opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
        ...(opts.waitForBackgroundMs === undefined ? {} : { waitForBackgroundMs: opts.waitForBackgroundMs }),
      })
      .then(
        (i) => {
          const info: SessionExitInfo = { exitStatus: i.exitStatus, signal: i.signal, reason: i.reason };
          // The kernel normally publishes session.exited before close() resolves; if that batch has not reached us, listeners
          // and iterators still get one `exited` (the subscription ends in markExited, so this can never be a duplicate).
          if (this.exitInfo === undefined && !this.exitedDelivered) {
            const seq = this.kernel.getState().lastEventSeq;
            this.standInExit = { type: 'exited', seq, at: Date.now(), provenance: { confirmed: true, sources: [] }, data: info };
            this.emit(this.standInExit);
          }
          return this.markExited(info);
        },
        (e: unknown) => {
          if (this.closing === p) this.closing = undefined; // a failed close may be retried
          throw toPublicError(e);
        },
      );
    this.closing = p;
    return p;
  }

  // ------------------------------------------------------------------------------------------------------ internals

  private readonly host = {
    snapshotOf: (key: TurnKey): TurnSnapshot | undefined => {
      const d = this.kernel.getState();
      const t = d.turns[key];
      return t === undefined ? undefined : toTurnSnapshot(d, t, this.ctx);
    },
    // One core command decides cancel / interrupt / no-op on the state its step sees: a branch on getState() here would race
    // the input machine (the job made current, or the turn submitting, between our read and the command, ICR 0023).
    stopTurn: async (key: TurnKey): Promise<void> => {
      if (this.kernel.getState().turns[key] === undefined) return;
      await this.call({ type: 'turn.stop', turnKey: key });
    },
  };

  private snap(state: SessionState): SessionSnapshot {
    if (this.cache?.state !== state) this.cache = { state, snap: toSnapshot(state, this.ctx) };
    return this.cache.snap;
  }

  private map(e: DomainEvent, state: SessionState): SessionEvent[] {
    this.time.observe(e.at, e.wallAt);
    return toPublicEvents(e, state, this.ctx);
  }

  private blocked(): ReturnType<typeof publicError> | undefined {
    if (this.closing !== undefined) return publicError('E_SESSION_CLOSED', 'the session is closed');
    if (this.exitInfo !== undefined)
      return publicError('E_SESSION_EXITED', 'the Claude session has exited', { exitReason: this.exitInfo.reason });
    return undefined;
  }

  private async call<C extends Command>(cmd: C): Promise<CommandResult<C>> {
    const blocked = this.blocked();
    if (blocked !== undefined) throw blocked;
    try {
      return await this.kernel.dispatch(cmd);
    } catch (e) {
      throw toPublicError(e);
    }
  }

  private async waitSettled(
    pred: (s: SessionSnapshot) => boolean,
    opts: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SessionSnapshot> {
    const s = await this.waitFor((x) => pred(x) || x.status.kind === 'exited', opts);
    if (pred(s)) return s;
    throw publicError('E_SESSION_EXITED', 'the Claude session exited while waiting');
  }

  private bindTurn(turn: TurnImpl, key: TurnKey): void {
    turn.bind(key);
    this.turnMap.set(turn.key, turn);
    this.byRef.delete(turn.ref);
  }

  private onBatch(b: Parameters<KernelListener>[0]): void {
    if (b.gap !== undefined) this.emit(gapEvent(b.gap.from, b.gap.to));
    for (const e of b.events) {
      this.time.observe(e.at, e.wallAt);
      if (e.seq <= this.startSeq || e.replayed === true) continue;
      if (e.type === 'turn.queued' && e.turnKey !== undefined)
        this.trackQueued(e.turnKey, e.payload.prompt, e.payload.origin, e.payload.clientRef);
      for (const pe of toPublicEvents(e, b.state, this.ctx)) {
        if (pe.type === 'exited') this.exitedDelivered = true;
        this.emit(pe);
        if (pe.turnKey !== undefined) this.turnMap.get(pe.turnKey)?.deliver(pe);
      }
      if (e.type === 'turn.ended') this.pruneTurns();
      if (e.type === 'session.exited') {
        this.exitSeq = e.seq;
        this.markExited({ exitStatus: e.payload.exitStatus, signal: e.payload.signal, reason: e.payload.reason });
      }
    }
  }

  private trackQueued(key: TurnKey, prompt: string, origin: string, clientRef: string | undefined): void {
    if (origin === 'selftest' || this.turnMap.has(key)) return;
    const mine = clientRef === undefined ? undefined : this.byRef.get(clientRef);
    if (mine !== undefined) this.bindTurn(mine, key);
    else {
      const t = new TurnImpl(this.host, prompt, key, origin === 'library' ? 'library' : 'external');
      t.bind(key);
      this.turnMap.set(key, t);
    }
  }

  private pruneTurns(): void {
    let finished = 0;
    for (const t of this.turnMap.values()) if (t.isFinished) finished++;
    for (const [k, t] of this.turnMap) {
      if (finished <= FINISHED_TURNS_KEPT) break;
      if (t.isFinished) {
        this.turnMap.delete(k);
        finished--;
      }
    }
  }

  private emit(e: SessionEvent, fromListenerError = false): void {
    const fns = [...(this.typed.get(e.type) ?? []), ...this.any];
    for (const fn of fns) {
      try {
        fn(e);
      } catch (err) {
        this.mapped.logger?.error('event listener threw', {
          type: e.type,
          seq: e.seq,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!fromListenerError)
          this.emit(
            {
              type: 'warning',
              seq: e.seq,
              at: Date.now(),
              provenance: { confirmed: true, sources: [] },
              data: { code: 'E_INTERNAL', reason: 'E_LISTENER_THREW', message: `a '${e.type}' listener threw` },
            },
            true,
          );
      }
    }
    for (const { q, types } of this.queues) if (types === undefined || types.has(e.type)) q.push(e);
  }

  private markExited(info: SessionExitInfo): SessionExitInfo {
    if (this.exitInfo !== undefined) return this.exitInfo;
    this.exitInfo = info;
    this.exitSeq ??= this.kernel.getState().lastEventSeq;
    liveSessions().delete(this);
    this.mapped.signal?.removeEventListener('abort', this.onAbort);
    const err = publicError('E_SESSION_EXITED', 'the Claude session exited before the turn ended', { exitReason: info.reason });
    for (const t of new Set([...this.turnMap.values(), ...this.byRef.values()])) {
      if (t.isBound) t.abandon(err);
      else t.fail(err);
    }
    for (const { q } of this.queues) q.end();
    this.queues.clear();
    for (const r of [...this.replays]) this.settleReplay(r);
    this.unsubscribe();
    this.resolveExited(info);
    return info;
  }

  /** Ends a replaying iterator once the session exited and it was handed everything up to exitSeq (and no session.exited). */
  private settleReplay(r: Replay): void {
    if (r.done || this.exitInfo === undefined || this.exitSeq === undefined || r.seen < this.exitSeq) return;
    const x = this.standInExit;
    if (x !== undefined && (r.types === undefined || r.types.has(x.type))) r.q.push(x);
    r.q.end();
    this.dropReplay(r);
  }

  private dropReplay(r: Replay): void {
    r.done = true;
    this.replays.delete(r);
    r.unsub();
  }

  private runHandler(ask: PermissionAsk): PermissionDecision | Promise<PermissionDecision | undefined> | undefined {
    const handler = this.mapped.handler;
    if (handler === undefined) return undefined;
    const rec = this.kernel.getState().permissions[ask.permissionKey];
    const agent = ask.agentKey;
    const req: PermissionRequest = {
      key: ask.permissionKey,
      toolName: ask.toolName,
      toolInput: ask.input,
      suggestions: ask.suggestions,
      needs: ask.needs,
      background: ask.background,
      requestedAt: this.time.toWall(rec?.requestedAt ?? this.time.nowMono()),
      deadlineAt: this.time.toWall(ask.deadlineAt),
      signal: ask.signal,
      ...(ask.turnKey === undefined ? {} : { turnKey: ask.turnKey }),
      ...(ask.toolKey === undefined ? {} : { toolKey: ask.toolKey }),
      ...(agent === undefined ? {} : { subagentKey: agent as string as SubagentKey }),
    };
    const failClosed = (err: unknown): PermissionDecision => {
      this.mapped.logger?.error('permission handler threw; denying', {
        toolName: ask.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      return { behavior: 'deny', message: 'permission handler failed' };
    };
    try {
      const r: unknown = handler(req);
      // Any thenable (another realm's Promise included) is adopted so its rejection also fails closed.
      if (typeof (r as { then?: unknown } | null | undefined)?.then === 'function')
        return Promise.resolve(r as PromiseLike<PermissionDecision | undefined>).then((d) => d, failClosed);
      return r as PermissionDecision | undefined;
    } catch (e) {
      return failClosed(e);
    }
  }
}

if (typeof Symbol.asyncDispose === 'symbol')
  Object.defineProperty(ClaudeSession.prototype, Symbol.asyncDispose, {
    configurable: true,
    writable: true,
    value: async function (this: ClaudeSession): Promise<void> {
      await this.close();
    },
  });

async function closeAllWith(o: { mode?: 'graceful' | 'kill'; graceMs?: number }): Promise<void> {
  await Promise.allSettled([...liveSessions()].map((s) => s.close(o)));
}

// --------------------------------------------------------------------------------------------- signal handlers (LC §7)

/** The signals the opt-in handlers cover (a local type: the public declarations must not need `@types/node`). */
export type HandledSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** The slice of `process` the signal handlers use (injectable for tests). */
export interface SignalProcess {
  readonly pid: number;
  on(sig: HandledSignal, fn: () => void): unknown;
  off(sig: HandledSignal, fn: () => void): unknown;
  kill(pid: number, sig: HandledSignal): unknown;
  exit(code: number): unknown;
}

const SIGNALS: readonly HandledSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SIGNAL_NUMBER: Readonly<Record<HandledSignal, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * @internal The implementation behind `installSignalHandlers` (P-LIFE-29, opt-in). First signal: graceful `closeAll` of every
 * session, then the signal is re-raised with the default disposition; a second signal of the same kind escalates to `kill` and
 * exits with 128 + signal number. There is no facade timer (the closed adapter-timer list, §4.12): the bound on a graceful close
 * is the kernel's own SIGTERM → SIGKILL escalation (D-27).
 */
export function installSignalHandlersOn(proc: SignalProcess, o: { graceMs?: number } = {}): Unsubscribe {
  const seen = new Set<HandledSignal>();
  const handlers = new Map<HandledSignal, () => void>();
  const uninstall = (): void => {
    for (const [sig, fn] of handlers) proc.off(sig, fn);
    handlers.clear();
  };
  const hardExit = (sig: HandledSignal): void => {
    uninstall();
    void closeAllWith({ mode: 'kill' }).finally(() => proc.exit(128 + SIGNAL_NUMBER[sig]));
  };
  for (const sig of SIGNALS) {
    const fn = (): void => {
      if (seen.has(sig)) {
        hardExit(sig);
        return;
      }
      const first = seen.size === 0;
      seen.add(sig);
      if (!first) return;
      void closeAllWith({ mode: 'graceful', ...(o.graceMs === undefined ? {} : { graceMs: o.graceMs }) }).finally(() => {
        if (handlers.size === 0) return; // escalated meanwhile
        uninstall();
        proc.kill(proc.pid, sig);
      });
    };
    handlers.set(sig, fn);
    proc.on(sig, fn);
  }
  return uninstall;
}

/** Opt-in SIGINT/SIGTERM/SIGHUP handling that closes every session before the process dies (LC §7). */
export function installSignalHandlers(o: { graceMs?: number } = {}): Unsubscribe {
  return installSignalHandlersOn(process, o);
}
