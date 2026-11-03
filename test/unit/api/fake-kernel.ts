// test/unit/api/fake-kernel.ts — a scripted SessionKernel (DESIGN.md §2.10) for the facade's unit tests. The test drives it
// by emitting DomainEvents together with the state they produced; it records dispatched commands and close calls.
import { initialDomain } from '../../../src/core/init.js';
import type { Command, CommandResult } from '../../../src/model/commands.js';
import type { CcdErrorCode } from '../../../src/model/errors.js';
import { CcdError } from '../../../src/model/errors.js';
import type { DomainEvent, EventEnvelope } from '../../../src/model/events.js';
import type { EventSeq, SessionKey, TurnKey } from '../../../src/model/ids.js';
import type {
  KernelCloseOptions,
  KernelListener,
  KernelPermissionHandler,
  SessionExitInfo,
  SessionKernel,
} from '../../../src/model/kernel.js';
import type { UsageReport } from '../../../src/model/usage.js';
import type {
  AgentRecord,
  EntityProvenance,
  Fact,
  MessageRecord,
  PermissionRecord,
  SessionState,
  ToolRun,
  TurnRecord,
} from '../../../src/model/state.js';
import type { AgentKey, MsgKey, ObsSeq, PermissionKey, ToolKey } from '../../../src/model/ids.js';
import type { Source } from '../../../src/model/observation.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { testCoreInit } from '../../../src/testing/core-config.js';

/** wallAt − at for every event this fake emits. */
export const WALL_OFFSET = 1_800_000_000_000;

export function readyState(over: Partial<SessionState> = {}): SessionState {
  const d = initialDomain(testCoreInit());
  return {
    ...d,
    lifecycle: 'ready',
    claude: { version: '2.1.316', sessionId: 'claude-session-1' },
    status: { kind: 'idle', since: 1000 as MonoMs, backgroundAgents: 0, queued: 0, quiescent: true },
    inputBlocked: { ...d.inputBlocked, startup: false },
    ...over,
  };
}

/** The payload of event type `T` (also for envelopes typed with a union of names, e.g. permission.bound | permission.rebound). */
export type Payload<T extends DomainEvent['type']> = DomainEvent extends infer E
  ? E extends { type: infer U; payload: infer P }
    ? T extends U
      ? P
      : never
    : never
  : never;

export class FakeKernel implements SessionKernel {
  readonly sessionKey: SessionKey;
  state: SessionState;
  readonly log: DomainEvent[] = [];
  readonly dispatched: Command[] = [];
  readonly closeCalls: KernelCloseOptions[] = [];
  handler: KernelPermissionHandler | null = null;
  /** Override per command type; default results follow CommandResult. */
  respond: (cmd: Command) => unknown = (cmd) => this.defaultResult(cmd);
  closeImpl: ((o: KernelCloseOptions) => Promise<SessionExitInfo>) | undefined;
  now = 2000;
  private seq = 0;
  private nextTurn = 0;
  private readonly listeners = new Set<KernelListener>();
  private readonly waiters = new Set<() => void>();
  readonly diagnostics = {
    viewCommand: (): string => 'tmux -L ccd-test attach -r -t =ccd-test:',
    captureScreen: (): Promise<string> => Promise.resolve('screen text'),
    tracePath: '/tmp/trace.ccd.jsonl',
  };

  constructor(state: SessionState = readyState(), preEvents = 2) {
    this.state = state;
    this.sessionKey = state.sessionKey;
    // History published before the facade subscribed (session.launching, session.ready).
    for (let i = 0; i < preEvents; i++)
      this.record(this.envelope('session.launching', { cwd: '/w', claudeVersion: '2.1.316', claudeSessionId: 'x', resume: false }));
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  getState(): Readonly<SessionState> {
    return this.state;
  }

  async dispatch<C extends Command>(cmd: C): Promise<CommandResult<C>> {
    this.dispatched.push(cmd);
    return (await this.respond(cmd)) as CommandResult<C>;
  }

  subscribe(listener: KernelListener, opts?: { fromSeq?: EventSeq }): () => void {
    this.listeners.add(listener);
    const from = opts?.fromSeq;
    if (from !== undefined) {
      const replay = this.log.filter((e) => e.seq >= from);
      if (replay.length > 0) listener({ events: replay, state: this.state });
    }
    return () => void this.listeners.delete(listener);
  }

  subscribeDebug(): () => void {
    return () => undefined;
  }

  usageReport: UsageReport | Error = {
    meters: [
      {
        window: 'week',
        scope: 'all models',
        label: 'Current week (all models)',
        usedPct: 98,
        resetsText: 'Nov 3 at 7:30pm (Etc/UTC)',
      },
    ],
    credits: 'off',
    readAt: 1234,
  };
  readonly lifecycleCalls: ('suspend' | 'resume')[] = [];
  suspendImpl: () => Promise<void> = () => Promise.resolve();
  resumeImpl: () => Promise<void> = () => Promise.resolve();
  suspend(): Promise<void> {
    this.lifecycleCalls.push('suspend');
    return this.suspendImpl();
  }
  resume(): Promise<void> {
    this.lifecycleCalls.push('resume');
    return this.resumeImpl();
  }
  queryUsage(): Promise<UsageReport> {
    return this.usageReport instanceof Error ? Promise.reject(this.usageReport) : Promise.resolve(this.usageReport);
  }
  setPermissionHandler(h: KernelPermissionHandler | null): void {
    this.handler = h;
  }

  waitFor(pred: (s: SessionState) => boolean, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SessionState> {
    if (pred(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = (): void => {
        if (!pred(this.state)) return;
        this.waiters.delete(check);
        if (timer !== undefined) clearTimeout(timer);
        resolve(this.state);
      };
      this.waiters.add(check);
      if (opts.timeoutMs !== undefined)
        timer = setTimeout(() => {
          this.waiters.delete(check);
          reject(new CcdError('E_WAIT_TIMEOUT', 'waitFor timed out', { details: { timeoutMs: opts.timeoutMs ?? 0 } }));
        }, opts.timeoutMs);
    });
  }

  async close(o: KernelCloseOptions = {}): Promise<SessionExitInfo> {
    this.closeCalls.push(o);
    if (this.closeImpl !== undefined) return this.closeImpl(o);
    const info: SessionExitInfo = { exitStatus: 0, signal: null, reason: o.mode === 'kill' ? 'killed' : 'closed' };
    if (this.state.exit === undefined) this.exit(info);
    return info;
  }

  // ------------------------------------------------------------------------------------------------------ driving

  envelope<T extends DomainEvent['type']>(type: T, payload: Payload<T>, extra: Partial<EventEnvelope<T, Payload<T>>> = {}): DomainEvent {
    this.seq += 1;
    this.now += 10;
    return {
      v: 1,
      seq: this.seq as EventSeq,
      type,
      at: this.now as MonoMs,
      wallAt: (this.now + WALL_OFFSET) as WallMs,
      sessionKey: this.sessionKey,
      provenance: { confirmed: true, sources: ['hook'] },
      causedBy: [],
      payload,
      ...extra,
    } as DomainEvent;
  }

  /** Publishes one batch: applies `patch` to the state, then delivers `events` (built with `envelope`). */
  emit(events: DomainEvent[], patch?: (s: SessionState) => SessionState, gap?: { from: EventSeq; to: EventSeq }): void {
    if (patch !== undefined) this.state = patch(this.state);
    for (const e of events) this.record(e);
    const batch = { events, state: this.state, ...(gap === undefined ? {} : { gap }) };
    for (const l of [...this.listeners]) l(batch);
    for (const w of [...this.waiters]) w();
  }

  /** Convenience: emit one event. */
  ev<T extends DomainEvent['type']>(
    type: T,
    payload: Payload<T>,
    extra: Partial<EventEnvelope<T, Payload<T>>> = {},
    patch?: (s: SessionState) => SessionState,
  ): DomainEvent {
    const e = this.envelope(type, payload, extra);
    this.emit([e], patch);
    return e;
  }

  exit(info: SessionExitInfo): void {
    this.ev('session.exited', { exitStatus: info.exitStatus, signal: info.signal, reason: info.reason }, {}, (s) => ({
      ...s,
      lifecycle: 'exited',
      exit: { exitStatus: info.exitStatus, signal: info.signal, reason: info.reason },
      status: { kind: 'exited', since: this.now as MonoMs, exitStatus: info.exitStatus, signal: info.signal },
    }));
  }

  mintTurnKey(): TurnKey {
    this.nextTurn += 1;
    return `t${this.nextTurn}` as TurnKey;
  }

  reject(code: CcdErrorCode, message: string = code): void {
    this.respond = () => Promise.reject(new CcdError(code, message, { details: { why: 'test' } }));
  }

  private record(e: DomainEvent): void {
    this.log.push(e);
    this.state = { ...this.state, lastEventSeq: Math.max(this.state.lastEventSeq, e.seq) as EventSeq };
  }

  private defaultResult(cmd: Command): unknown {
    if (cmd.type === 'prompt.send') return { turnKey: this.mintTurnKey() };
    if (cmd.type === 'interrupt') return {};
    if (cmd.type === 'slash.run') return { ok: true, effect: 'modal', output: `ran ${cmd.name}` };
    return { ok: true };
  }
}

// ------------------------------------------------------------------------------------------------------ state builders

export function fact<T>(value: T, src: Source = 'hook'): Fact<T> {
  return { value, src, seq: 1 as ObsSeq, at: 1000 as MonoMs, corroborated: [], provisional: false };
}
const prov = (sources: Source[] = ['hook']): EntityProvenance => ({
  sources,
  confirmed: true,
  firstSeq: 1 as ObsSeq,
  lastSeq: 1 as ObsSeq,
});

export function turnRecord(key: string, over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    key: key as TurnKey,
    prompt: `prompt ${key}`,
    origin: fact('library'),
    state: fact('running'),
    backgroundPending: [],
    tools: [],
    messages: [],
    calls: [],
    queuedAt: 1100 as MonoMs,
    provenance: prov(),
    ...over,
  };
}
export function toolRun(key: string, over: Partial<ToolRun> = {}): ToolRun {
  return {
    key: key as ToolKey,
    name: 'Bash',
    input: { command: 'ls' },
    state: fact('running'),
    startedAt: 1200 as MonoMs,
    provenance: prov(['hook', 'self']),
    ...over,
  };
}
export function agentRecord(key: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    key: key as AgentKey,
    agentId: `agent-${key}`,
    agentType: 'general-purpose',
    kind: 'subagent',
    background: false,
    spawnLinkConfirmed: true,
    depth: 1,
    state: fact('running'),
    runs: 1,
    fileMissing: false,
    notifications: [],
    startedAt: 1300 as MonoMs,
    provenance: prov(),
    ...over,
  };
}
export function message(key: string, text: string, over: Partial<MessageRecord> = {}): MessageRecord {
  return { key: key as MsgKey, uuids: [], text, final: true, confirmed: true, retracted: false, blocks: 1, usageCounted: false, ...over };
}
export function permissionRecord(key: string, over: Partial<PermissionRecord> = {}): PermissionRecord {
  return {
    key: key as PermissionKey,
    toolName: 'Bash',
    input: { command: 'rm -rf x' },
    suggestions: [],
    binding: { kind: 'unique', confirmed: true },
    state: fact('pending'),
    autoAnswerAllowed: true,
    needs: 'decision',
    requestedAt: 1500 as MonoMs,
    suspect: false,
    adopted: false,
    provenance: prov(),
    ...over,
  };
}
