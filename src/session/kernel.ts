// session/kernel.ts — createSessionKernel(ports, config) implementing model/kernel.ts SessionKernel (DESIGN.md §2.10,
// §3.1 steps 13–16, §3.9, §4.12; AL §4.6 L-1…L-8; D-35; P-API-05, P-API-06, P-API-09, P-REV-23, P-REV-25, P-HOOK-06).
//
// The kernel is the L3 integration point. It owns:
//   - the input queue (seq stamping, queue.ts), the single step loop (loop.ts), the event ring (event-log.ts), the decision
//     timer + host-sleep detector + loop-lag monitor (scheduler.ts), the debug trace and screen ring (debug-trace.ts), the
//     limit recorder (limit-recorder.ts), the redactor (redact.ts) and the self-test cache (selftest-cache.ts);
//   - L1 ingestion: raw L0 records (hook events, tail events, tunnel records, captures, registry reads) handed to it through
//     `KernelHost.ingest*` are recorded (trace `raw`, limit ring), normalized by the channel modules and enqueued;
//   - the start protocol (§3.1 steps 13–16): launch → core init → self-test dispatch (nonce minted here, cache looked up
//     here) → wait for ready / gated / exited → the start error; ONE automatic unix relaunch on an HTTP self-test ack failure
//     with transcript evidence (§3.1 step 15, K-37);
//   - close(): idempotent; core `session.close` command, then the launched session's §3.8 close, then teardown.
// What it does NOT own: the launch sequence itself (WP-12 launcher/lifecycle) and the intent executors (WP-13). They plug
// in through `KernelServices` (below; ICR docs/icr/0011-wp11.md): `createSessionKernel(ports, config, {services})`; with no
// services passed, `defaultKernelServices()` composes WP-12 `launchSession` + `SessionLifecycle` with the WP-13 input
// executor, permission broker, pollers, tail driver and path resolver, and routes every core intent to its owner.

import { createTranscriptNormalizer } from '../channels/transcript/normalize.js';
import type { TranscriptNormalizerWithStats } from '../channels/transcript/normalize.js';
import { heldUnclaimed, normalizeHook } from '../channels/hooks/normalize.js';
import { createScreenChannel } from '../channels/screen/debounce.js';
import type { ScreenChannel } from '../channels/screen/debounce.js';
import { createTunnelTracker } from '../channels/network/tunnel-tracker.js';
import type { TunnelTracker } from '../channels/network/tunnel-tracker.js';
import { normalizeRegistry } from '../channels/registry/normalize.js';
import { selectProfile } from '../channels/profiles/index.js';
import type { ClaudeProfile } from '../channels/profiles/index.js';
import { evolve } from '../core/evolve.js';
import { initialCore, nextDeadline, step as coreStep } from '../core/step.js';
import type { CoreState, StepResult } from '../core/step.js';
import type { Command, CommandResult } from '../model/commands.js';
import type { CoreInit, ResolvedConfig } from '../model/config.js';
import type { DebugRecord } from '../model/debug.js';
import { CcdError } from '../model/errors.js';
import type { CcdErrorCode } from '../model/errors.js';
import type { DomainEvent } from '../model/events.js';
import type { EventSeq, IntentId, SessionKey } from '../model/ids.js';
import type { Intent } from '../model/intents.js';
import type { JsonValue } from '../model/json.js';
import type {
  KernelCloseOptions,
  KernelListener,
  KernelPermissionHandler,
  SessionExitInfo,
  SessionKernel,
  Unsubscribe,
} from '../model/kernel.js';
import type { Logger } from '../model/logger.js';
import type { ObservationInput } from '../model/observation.js';
import type { ScreenFacts } from '../model/screen-facts.js';
import type { SessionState } from '../model/state.js';
import type { MonoMs } from '../model/time.js';
import type { UsageReport } from '../model/usage.js';
import { LIB_VERSION, SUPPORTED_CLAUDE_VERSION } from '../model/version.js';
import type { Capture, ClaudeRegistryRecord, Ports, RawHookEvent, TailEvent, TunnelRecord } from '../platform/ports.js';
import type { TranscriptNormalizer } from '../channels/transcript/normalize.js';
import { createInputExecutor } from './input-executor.js';
import type { InputExecutor } from './input-executor.js';
import { launchSession } from './launcher.js';
import type { LaunchResult } from './launcher.js';
import type { CloseContext } from './lifecycle.js';
import { createPathResolver } from './path-resolver.js';
import { createPermissionBroker } from './permission-broker.js';
import type { PermissionBroker } from './permission-broker.js';
import { createPollers } from './pollers.js';
import type { Pollers } from './pollers.js';
import { createTailDriver } from './tail-driver.js';
import type { TailDriver } from './tail-driver.js';
import { createDebugTrace, createScreenRing } from './debug-trace.js';
import type { DebugTrace, ScreenRing, TraceFs } from './debug-trace.js';
import { toCctError } from './errors-map.js';
import { createEventLog } from './event-log.js';
import type { EventLog } from './event-log.js';
import { createLimitRecorder } from './limit-recorder.js';
import type { LimitRecorder } from './limit-recorder.js';
import { createStepLoop } from './loop.js';
import type { StepLoop } from './loop.js';
import { createInputQueue } from './queue.js';
import type { QueueItem } from './queue.js';
import { createFixtureScrubber, createRedactor } from './redact.js';
import type { Redactor } from './redact.js';
import { createScheduler } from './scheduler.js';
import type { LagMonitorFactory, Scheduler } from './scheduler.js';
import { createSelfTestCache } from './selftest-cache.js';
import type { SelfTestCache, SelfTestKey } from './selftest-cache.js';

// ------------------------------------------------------------------------------------------- the L3 collaborator contract

/** What the kernel hands to the launcher and the executors (WP-12, WP-13). */
export interface KernelHost {
  readonly sessionKey: SessionKey;
  readonly ports: Ports;
  readonly config: ResolvedConfig;
  readonly profile: ClaudeProfile;
  readonly logger: Logger;
  readonly redactor: Redactor;
  /** IANA zone used for reset-time parsing (recorded in the trace header, P-REV-35). */
  readonly tz: string;
  /**
   * L1 ingestion of raw L0 records: recorded (trace `raw`, limit ring), normalized, enqueued. For a hook, returns true when
   * it is a held request that produced no `permission.requested` (rejected / malformed / L1 failure): the caller must
   * release it (`PermissionBroker.releaseUnclaimed`), since no core record will ever answer it (ICR 0026).
   */
  ingestHook(e: RawHookEvent): boolean;
  ingestTail(e: TailEvent): void;
  ingestTunnel(r: TunnelRecord): void;
  /** Classify + debounce one capture; returns the facts when the frame changed (and enqueues `screen.frame`). */
  ingestCapture(c: Capture, o?: { editorPhase?: boolean }): ScreenFacts | undefined;
  ingestRegistry(rec: ClaudeRegistryRecord | undefined): void;
  /**
   * The recording L1 channels, for executors that drive them themselves (pollers own the capture loop, the tail driver owns
   * the tail subscription): every push is recorded (trace `raw`, screen ring, limit ring) before it is normalized.
   */
  readonly channels: { readonly screen: ScreenChannel; readonly transcript: TranscriptNormalizer };
  /** Enqueue an observation built by L3 (`process.*`, `input.done`, `hook.responded`, `hook.selfTestArmed`, …). */
  observe(o: ObservationInput): void;
  /** Trace an intent's execution (`effect` record). */
  effect(intentId: IntentId, startedAt: MonoMs, ok: boolean, error?: string): void;
  /** Publish an L3 warning event (folded into the domain by evolve; seq from the core's counter). */
  warn(code: CcdErrorCode, message: string, detail?: JsonValue): void;
  /** Publish a `security.alert` raised below the core (hook forgery burst, SEC §2.3), like `warn`. */
  alert(code: 'E_SECURITY_HOOK_FORGERY', detail: JsonValue): void;
  /**
   * The launched session finished its post-exit teardown after Claude exited on its own (crash, `/exit` typed in the pane,
   * fail-closed kill) — no close() or start() owns it: the kernel tears itself down (trace, scheduler, loop, waiters).
   */
  exitFinalized(): void;
  /** Register a library secret for exact-match redaction (hook token, proxy/control tokens). */
  addSecret(secret: string): void;
  dispatch<C extends Command>(cmd: C): Promise<CommandResult<C>>;
  getState(): Readonly<SessionState>;
  subscribe(listener: KernelListener, opts?: { fromSeq?: EventSeq }): Unsubscribe;
  /** The user's permission handler (L-8: user code runs in L3, the core only sees `permission.answer`). */
  permissionHandler(): KernelPermissionHandler | null;
}

export interface LaunchRequest {
  /** 0 for the first launch, 1 for the automatic unix relaunch (§3.1 step 15). */
  attempt: number;
  /** `--session-id` (fresh) or the `--resume` id. */
  claudeSessionId: string;
  resume?: string;
  /** 'auto' on the first attempt with the default config; always 'unix' on the relaunch. */
  transport: 'auto' | 'http' | 'unix';
}

export interface LaunchInfo {
  claudeVersion: string;
  tmuxVersion: string;
  hookTransport: 'http' | 'unix';
  /** cwdRealpath trust state at launch (self-test cache key, D-35). */
  trusted: boolean;
  claudeSessionId: string;
}

export interface LaunchedSession {
  readonly info: LaunchInfo;
  /** Execute one core intent. Never throws; failures come back as observations (L-2). */
  execute(intent: Intent): void;
  viewCommand(): string;
  captureScreen(): Promise<string>;
  /** §3.8 close sequence; idempotent. */
  close(o: KernelCloseOptions & { mode: 'graceful' | 'kill'; graceMs: number; reason: string }): Promise<SessionExitInfo>;
  /** Tear down after a failed start (gate, self-test failure, timeout): kill, never press anything. Idempotent. */
  abort(reason: string): Promise<SessionExitInfo | undefined>;
}

export interface KernelServices {
  /** §3.1 steps 2–13 (preflight … tail) with the executors wired; resolves once the pane is spawned. Throws a start error. */
  launch(host: KernelHost, req: LaunchRequest): Promise<LaunchedSession>;
}

export interface SessionKernelOptions {
  services?: KernelServices;
  /** Core entry points (tests stub `step`). */
  step?: (core: CoreState, input: Parameters<typeof coreStep>[1]) => StepResult;
  /** A-7 factory; false disables it. Default: the real monitorEventLoopDelay monitor. */
  lagMonitor?: LagMonitorFactory | false;
  traceFs?: TraceFs;
}

export interface SessionKernelImpl extends SessionKernel {
  /** §3.1 steps 13–16: resolves at `session.ready`, rejects with the start error (everything torn down). Idempotent. */
  start(): Promise<SessionKernel>;
  /** The KernelHost given to the services (tests). */
  readonly host: KernelHost;
}

/** §3.1 step 14: gates with their own start error; every other gate is E_STARTUP_GATE{gate,text}. */
const GATE_CODES: Readonly<Record<string, CcdErrorCode>> = Object.freeze({
  trust: 'E_TRUST_REQUIRED',
  sessionInUse: 'E_SESSION_ID_IN_USE',
  configError: 'E_CONFIG_CORRUPT',
  settingsError: 'E_SETTINGS_INVALID',
});
/** Gates recognised on the final screen of a pane that died before ready (the strings live in the profile, P-API-01). */
const EXIT_GATES = ['sessionInUse', 'settingsError', 'configError'] as const;
const TRANSCRIPT_EVIDENCE_WAIT_MS = 1500;

function exitGateOf(screen: string, profile: ClaudeProfile): { gate: string; code: CcdErrorCode } | undefined {
  const lines = screen.split('\n').map((l) => l.trim());
  for (const g of EXIT_GATES) {
    const res = profile.errors.startupGates[g];
    if (lines.some((l) => res.some((re) => re.test(l)))) return { gate: g, code: GATE_CODES[g] ?? 'E_STARTUP_GATE' };
  }
  return undefined;
}
/** Startup warnings whose code becomes the start error when the session exits before ready. */
const START_WARNING_CODES: ReadonlySet<string> = new Set([
  'E_STARTUP_TIMEOUT',
  'E_SELFTEST_FAILED',
  'E_HOOKS_UNAVAILABLE',
  'E_STARTUP_EXITED',
  'E_SESSION_ID_IN_USE',
  'E_RESUME_NOT_FOUND',
  'E_VERSION_POLICY',
  'E_SETTINGS_INVALID',
  'E_CONFIG_CORRUPT',
  'E_LOGIN_REQUIRED',
]);
const FINAL_SCREEN_MAX = 4000;
const CLOSE_EXIT_WAIT_MS = 2000;

interface Channels {
  transcript: TranscriptNormalizerWithStats;
  screen: ScreenChannel;
  tunnels: TunnelTracker;
}

type StartOutcome =
  { kind: 'ready' } | { kind: 'gated'; gate: string; text: string } | { kind: 'exited'; state: SessionState } | { kind: 'timeout' };

export function createSessionKernel(ports: Ports, config: ResolvedConfig, o: SessionKernelOptions = {}): SessionKernelImpl {
  const clock = ports.clock;
  const logger = ports.logger;
  const sessionKey = config.sessionKey;
  const prof = selectProfile(config.claude.expectVersion === 'any' ? SUPPORTED_CLAUDE_VERSION : config.claude.expectVersion);
  const fallback = selectProfile(SUPPORTED_CLAUDE_VERSION);
  const profile: ClaudeProfile = 'unsupported' in prof ? (fallback as ClaudeProfile) : prof;
  const redactor = createRedactor();
  const tz = safeTz(ports);
  const startedWall = clock.wallNow();
  const stepFn = o.step ?? coreStep;

  // ---- core init (claudeVersion is patched by process.launched; the trace header gets the launched versions) ----
  let coreInit: CoreInit = {
    sessionKey,
    config: config.core,
    claudeVersion: config.claude.expectVersion === 'any' ? SUPPORTED_CLAUDE_VERSION : config.claude.expectVersion,
    initialClaudeSessionId: config.claudeSessionId,
    resume: config.resume !== undefined,
    startedAt: clock.now(),
    wallAt: startedWall,
    cwdRealpath: config.cwdRealpath,
  };

  const debugEnabled = config.debug.tracePath !== undefined || config.debug.raw !== 'none';
  const trace: DebugTrace = createDebugTrace({
    ...(config.debug.tracePath !== undefined ? { path: config.debug.tracePath } : {}),
    raw: config.debug.raw,
    redactor,
    ...(o.traceFs !== undefined ? { fs: o.traceFs } : {}),
    onError: (e) => {
      logger.warn('debug trace write failed', { error: e instanceof Error ? e.name : typeof e });
    },
  });
  const screenRing: ScreenRing = createScreenRing({
    redactor,
    sessionKey,
    ...(config.debug.dumpDir !== undefined ? { dumpDir: config.debug.dumpDir } : {}),
    ...(o.traceFs !== undefined ? { fs: o.traceFs } : {}),
  });
  let rawIndex = 0;
  let header: Extract<DebugRecord, { r: 'header' }> | undefined;
  const traceOn = (): boolean => debugEnabled && trace.active;
  const record = (r: DebugRecord): void => {
    if (traceOn()) trace.record(r);
  };

  const log: EventLog = createEventLog({
    capacity: config.debug.retainEvents,
    sink: (e) => {
      record({ r: 'event', e });
    },
  });
  const queue = createInputQueue({
    onHighWater: (n) => {
      logger.warn('observation backlog', { size: n });
    },
  });

  let launched: LaunchedSession | undefined;
  const intentBacklog: Intent[] = [];
  let permissionHandler: KernelPermissionHandler | null = null;
  let closedForGood = false;
  /**
   * close() was called (set synchronously, before any await): start() stops at its next await and never launches again
   * (§3.8: nothing may be spawned after close). `closeMode` is the mode the running close works towards; a `kill` arriving
   * during a graceful close escalates it (`killEscalation` cancels the graceful waits).
   */
  let closeRequested = false;
  let closeMode: 'graceful' | 'kill' = 'graceful';
  const killEscalation = new AbortController();
  /** The in-flight `services.launch` of start() (settled → `launched` is attached); close() waits for this, never for start. */
  let launchInFlight: Promise<void> | undefined;
  /** The armed self-test nonce of the current attempt and whether the transcript recorded it (K-37 relaunch evidence). */
  let currentNonce: string | undefined;
  let nonceInTranscript = false;

  const execute = (i: Intent): void => {
    if (launched === undefined) {
      if (intentBacklog.length < 4096) intentBacklog.push(i);
      return;
    }
    try {
      launched.execute(i);
    } catch (e) {
      logger.warn('intent executor threw', { intent: i.kind, error: e instanceof Error ? e.name : typeof e });
    }
  };

  const loop: StepLoop = createStepLoop({
    core: initialCore(coreInit),
    step: stepFn,
    evolve,
    queue,
    log,
    logger,
    hooks: {
      beforeStep(item: QueueItem): void {
        if (item.type === 'obs' && currentNonce !== undefined && !nonceInTranscript) {
          const ob = item.obs;
          if (ob.kind === 'prompt.recorded' && typeof ob.p.text === 'string' && ob.p.text.includes(currentNonce)) nonceInTranscript = true;
        }
        if (!traceOn()) return;
        if (item.type === 'obs') {
          const rr = item.obs.meta.rawRef;
          record(
            rr === undefined
              ? { r: 'obs', seq: item.obs.meta.seq, obs: item.obs }
              : { r: 'obs', seq: item.obs.meta.seq, rawRef: rr, obs: item.obs },
          );
        } else record({ r: 'cmd', cmdId: item.cmdId, at: item.at, wallAt: item.wallAt, cmd: item.cmd });
      },
      afterStep(r: StepResult, item: QueueItem, durUs: number): void {
        if (traceOn()) {
          const inSeq = item.type === 'obs' ? item.obs.meta.seq : -item.cmdId;
          record({ r: 'step', inSeq, events: r.events.map((e) => e.seq), intents: r.intents, durUs });
          for (const d of r.diagnostics) record({ r: 'diag', at: d.at, code: d.code, detail: d.detail });
        }
        for (const d of r.diagnostics) logger.debug('core diagnostic', { code: d.code });
        for (const i of r.intents) execute(i);
        limit.onEvents(r.events, clock.wallNow());
        scheduler.rearm(nextDeadline(r.core));
      },
    },
  });

  const scheduler: Scheduler = createScheduler({
    clock,
    usageWakeCheckMs: config.core.timeouts.usageWakeCheckMs,
    onTick: () => {
      const at = clock.now();
      const wallAt = clock.wallNow();
      for (const x of channels.tunnels.tick(at, wallAt)) loop.observe(x); // the timer fire already ran the sleep check
      loop.observe({ kind: 'clock.tick', meta: { at, wallAt, source: 'clock' }, p: {} });
    },
    onHostResumed: (p) =>
      loop.observe({ kind: 'clock.hostResumed', meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'clock' }, p }),
    onLoopLag: (p) => loop.observe({ kind: 'host.loopLag', meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'self' }, p }),
    ...(o.lagMonitor !== undefined ? { lagMonitor: o.lagMonitor } : {}),
  });

  /**
   * Every L1/L3 observation enters the queue through here. The host-sleep check (L-4) runs first, so a sleep that is noticed
   * by the first observation after the wake (a screen poll, a hook) is enqueued as `clock.hostResumed` BEFORE that
   * observation and the core suppresses stall verdicts before it steps it (P-API-21, P-NET-42). The scheduler's own
   * `clock.*` observations already ran the check.
   */
  const enqueue = (x: ObservationInput): void => {
    if (x.meta.source !== 'clock') scheduler.check();
    loop.observe(x);
  };

  const limit: LimitRecorder = createLimitRecorder({
    enabled: config.debug.captureLimitFixtures,
    sessionKey,
    state: ports.state,
    scrubber: () =>
      createFixtureScrubber({
        home: safe(() => ports.env.homeDir()),
        user: safe(() => ports.env.userName()),
        tmpDir: safe(() => ports.env.tmpDir()),
        tokens: redactor.knownSecrets(),
      }),
    header: () => header ?? buildHeader(undefined),
    onCaptured: (path, trigger) =>
      loop.publishLocal('warning', {
        code: 'E_USAGE_LIMIT',
        message: 'a usage-limit fixture was captured for replay (narrow content, scrubbed)',
        detail: { reason: 'limitCaptured', path, trigger },
      }),
    onError: (e) => {
      logger.warn('limit capture failed', { error: e instanceof Error ? e.name : typeof e });
    },
  });

  const newChannels = (): Channels => ({
    transcript: createTranscriptNormalizer(profile, { now: () => ({ at: clock.now(), wallAt: clock.wallNow() }) }),
    screen: createScreenChannel({ frozenAfterMs: config.core.timeouts.stallMs, profile }),
    tunnels: createTunnelTracker({ quietMs: config.core.timeouts.quietMs }),
  });
  let channels: Channels = newChannels();

  const raw = (ch: Extract<DebugRecord, { r: 'raw' }>['ch'], at: number, wallAt: number, data: unknown): number | undefined => {
    if (!traceOn() || config.debug.raw === 'none') return undefined;
    const i = rawIndex++;
    record({ r: 'raw', i, ch, at, wallAt, data });
    return i;
  };
  const withRef = (x: ObservationInput, ref: number | undefined): ObservationInput =>
    ref === undefined ? x : { ...x, meta: { ...x.meta, rawRef: ref } };

  // ---- recording L1 channels (shared by ingest* and the executors that drive capture / tail themselves) ----
  let pendingScreenRef: number | undefined;
  const recordingScreen: ScreenChannel = {
    push(c, ctx) {
      const prevHash = screenRing.entries().at(-1)?.hash;
      if (prevHash !== c.hash) pendingScreenRef = raw('screen', c.at, ctx.wallAt, { capture: c });
      screenRing.push({ at: c.at, wallAt: ctx.wallAt, hash: c.hash, lines: c.lines });
      limit.recordCapture(c, ctx.wallAt);
      let facts: ScreenFacts | undefined;
      try {
        facts = channels.screen.push(c, ctx);
      } catch (err) {
        logger.warn('screen classifier threw', { error: err instanceof Error ? err.name : typeof err });
        return undefined;
      }
      if (facts === undefined) {
        pendingScreenRef = undefined;
        return undefined;
      }
      limit.onFrame(facts, c, ctx.wallAt);
      return facts;
    },
    frozen: () => channels.screen.frozen(),
    last: () => channels.screen.last(),
    telemetry: () => channels.screen.telemetry(),
  };
  const recordingTranscript: TranscriptNormalizer = {
    push(e: TailEvent): ObservationInput[] {
      const at = e.kind === 'line' ? e.line.readAtMono : clock.now();
      const wallAt = e.kind === 'line' ? e.line.readAtWall : clock.wallNow();
      const ref = raw('transcript', at, wallAt, e);
      limit.recordTail(e, at, wallAt);
      let out: ObservationInput[];
      try {
        out = channels.transcript.push(e);
      } catch (err) {
        logger.warn('transcript normalizer threw', { kind: e.kind, error: err instanceof Error ? err.name : typeof err });
        return [];
      }
      return ref === undefined ? out : out.map((x) => withRef(x, ref));
    },
    resetFile(fileKey: string): void {
      channels.transcript.resetFile(fileKey);
    },
  };

  // L3 warnings are published only while the loop is open.
  const warn = (code: CcdErrorCode, message: string, detail?: JsonValue): void => {
    loop.publishLocal('warning', detail === undefined ? { code, message } : { code, message, detail });
  };

  const dispatch = <C extends Command>(cmd: C): Promise<CommandResult<C>> => {
    if (closedForGood) return Promise.reject(new CcdError('E_SESSION_CLOSED', 'the session is closed'));
    return loop.dispatch(cmd, clock.now(), clock.wallNow()) as Promise<CommandResult<C>>;
  };

  const subscribe = (listener: KernelListener, opts?: { fromSeq?: EventSeq }): Unsubscribe => loop.subscribe(listener, opts?.fromSeq);

  const host: KernelHost = {
    sessionKey,
    ports,
    config,
    profile,
    logger,
    redactor,
    tz,
    ingestHook(e: RawHookEvent): boolean {
      const { closed: _closed, ...data } = e;
      const ref = raw('hook', e.at, e.wallAt, data);
      limit.recordHook(e);
      let res: ReturnType<typeof normalizeHook>;
      try {
        res = normalizeHook(e, { profile });
      } catch (err) {
        logger.warn('hook normalizer threw', { event: e.event, error: err instanceof Error ? err.name : typeof err });
        return heldUnclaimed(e, undefined);
      }
      if (res.rejected !== undefined)
        record({ r: 'diag', at: e.at, code: 'hook_rejected', detail: { event: e.event, reason: res.rejected } });
      for (const x of res.observations) enqueue(withRef(x, ref));
      return heldUnclaimed(e, res);
    },
    ingestTail(e: TailEvent): void {
      for (const x of recordingTranscript.push(e)) enqueue(x);
    },
    ingestTunnel(r: TunnelRecord): void {
      const ref = raw('network', r.at, r.wallAt, r);
      let out: ObservationInput[];
      try {
        out = channels.tunnels.push(r);
      } catch (err) {
        logger.warn('tunnel tracker threw', { error: err instanceof Error ? err.name : typeof err });
        return;
      }
      for (const x of out) enqueue(withRef(x, ref));
    },
    ingestCapture(c: Capture, opt?: { editorPhase?: boolean }): ScreenFacts | undefined {
      const wallAt = clock.wallNow();
      const facts = recordingScreen.push(c, opt?.editorPhase === true ? { wallAt, tz, editorPhase: true } : { wallAt, tz });
      if (facts === undefined) return undefined;
      host.observe({
        kind: 'screen.frame',
        meta: { at: c.at, wallAt, source: 'screen', origin: { kind: 'screen', frameHash: facts.frameHash } },
        p: facts,
      });
      return facts;
    },
    ingestRegistry(rec: ClaudeRegistryRecord | undefined): void {
      const at = clock.now();
      const wallAt = clock.wallNow();
      const ref = raw('registry', at, wallAt, rec ?? null);
      for (const x of normalizeRegistry(rec, at, wallAt)) enqueue(withRef(x, ref));
    },
    channels: { screen: recordingScreen, transcript: recordingTranscript },
    observe(x: ObservationInput): void {
      if (x.kind === 'screen.frame' && pendingScreenRef !== undefined && x.meta.rawRef === undefined) {
        x = withRef(x, pendingScreenRef);
        pendingScreenRef = undefined;
      }
      if (x.kind === 'process.exited' && traceOn()) {
        const p = x.p as { exitStatus: number | null; signal: string | null };
        x = withRef(x, raw('process', x.meta.at, x.meta.wallAt, { exitStatus: p.exitStatus, signal: p.signal }));
      }
      enqueue(x);
    },
    effect(intentId: IntentId, startedAt: MonoMs, ok: boolean, error?: string): void {
      const durMs = Math.max(0, clock.now() - startedAt);
      record(
        error === undefined
          ? { r: 'effect', intentId, at: startedAt, durMs, ok }
          : { r: 'effect', intentId, at: startedAt, durMs, ok, error },
      );
    },
    warn,
    alert(code: 'E_SECURITY_HOOK_FORGERY', detail: JsonValue): void {
      loop.publishLocal('security.alert', { code, detail });
    },
    exitFinalized(): void {
      // close() (and a failing start()) run the teardown themselves after their own sequence
      if (closeRequested || closedForGood) return;
      void teardown('exited').catch((e: unknown) => {
        logger.warn('teardown after exit failed', { error: e instanceof Error ? e.name : typeof e });
      });
    },
    addSecret: (s: string) => {
      redactor.addSecret(s);
    },
    dispatch,
    getState: () => loop.state,
    subscribe,
    permissionHandler: () => permissionHandler,
  };

  // ---- self-test cache, waiters ----
  const cache: SelfTestCache = createSelfTestCache({ state: ports.state, pid: process.pid });
  const waiterRejects = new Set<(e: unknown) => void>();

  const waitFor = (pred: (s: SessionState) => boolean, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SessionState> =>
    new Promise<SessionState>((resolve, rejectErr: (e: Error) => void) => {
      const reject = (e: unknown): void => {
        rejectErr(asError(e));
      };
      try {
        if (pred(loop.state)) {
          resolve(loop.state);
          return;
        }
      } catch (e) {
        reject(e);
        return;
      }
      if (closedForGood) {
        reject(new CcdError('E_SESSION_CLOSED', 'the session is closed'));
        return;
      }
      let done = false;
      const cleanups: (() => void)[] = [];
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        for (const c of cleanups) c();
        fn();
      };
      const onClose = (e: unknown): void => {
        finish(() => {
          reject(e);
        });
      };
      waiterRejects.add(onClose);
      cleanups.push(() => waiterRejects.delete(onClose));
      cleanups.push(
        loop.watch((s) => {
          let ok: boolean;
          try {
            ok = pred(s);
          } catch (e) {
            finish(() => {
              reject(e);
            });
            return;
          }
          if (ok)
            finish(() => {
              resolve(s);
            });
        }),
      );
      if (opts.timeoutMs !== undefined) {
        const ms = Math.max(0, opts.timeoutMs);
        cleanups.push(
          clock.setTimer((clock.now() + ms) as MonoMs, () => {
            finish(() => {
              reject(new CcdError('E_WAIT_TIMEOUT', `condition not reached within ${ms} ms`, { details: { timeoutMs: ms } }));
            });
          }),
        );
      }
      const sig = opts.signal;
      if (sig !== undefined) {
        const abortErr = (): unknown =>
          sig.reason !== undefined ? sig.reason : new DOMException('The operation was aborted', 'AbortError');
        if (sig.aborted) {
          finish(() => {
            reject(abortErr());
          });
          return;
        }
        const onAbort = (): void => {
          finish(() => {
            reject(abortErr());
          });
        };
        sig.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => {
          sig.removeEventListener('abort', onAbort);
        });
      }
    });

  // ---- bookkeeping watchers ----
  let startupWarning: { code: string; message: string; detail?: JsonValue } | undefined;
  let readyEvent: Extract<DomainEvent, { type: 'session.ready' }> | undefined;
  loop.watch((_s, events) => {
    for (const e of events) {
      if (e.type === 'warning' && START_WARNING_CODES.has(e.payload.code) && readyEvent === undefined) {
        startupWarning = e.payload.detail === undefined ? { code: e.payload.code, message: e.payload.message } : { ...e.payload };
      }
      if (e.type === 'session.ready') readyEvent = e;
    }
  });

  function buildHeader(info: LaunchInfo | undefined): Extract<DebugRecord, { r: 'header' }> {
    return {
      r: 'header',
      format: 'ccd-trace',
      v: 1,
      lib: LIB_VERSION,
      claude: SUPPORTED_CLAUDE_VERSION,
      tmux: info?.tmuxVersion ?? 'unknown',
      node: safe(() => ports.env.nodeVersion()) ?? process.versions.node,
      platform: safe(() => ports.env.platform()) ?? 'other',
      startedWall,
      tz,
      coreInit,
      profile: SUPPORTED_CLAUDE_VERSION,
      redaction: config.debug.raw,
      hookTransport: info?.hookTransport ?? (config.hooks.transport === 'unix' ? 'unix' : 'http'),
    };
  }

  const attachLaunched = (l: LaunchedSession): void => {
    launched = l;
    for (const i of intentBacklog.splice(0)) execute(i);
  };

  const waitStartOutcome = (): Promise<StartOutcome> => {
    const t = config.core.timeouts;
    const ceiling = t.startupMs + t.startupHookGraceMs + 30_000;
    return waitFor((s) => s.lifecycle === 'ready' || s.lifecycle === 'gated' || s.lifecycle === 'exited', { timeoutMs: ceiling }).then(
      (s): StartOutcome =>
        s.lifecycle === 'ready'
          ? { kind: 'ready' }
          : s.lifecycle === 'gated'
            ? { kind: 'gated', gate: s.gate?.kind ?? 'other', text: s.gate?.text ?? '' }
            : { kind: 'exited', state: s },
      (e: unknown): StartOutcome => {
        if (e instanceof CcdError && e.code === 'E_WAIT_TIMEOUT') return { kind: 'timeout' };
        throw e;
      },
    );
  };

  const finalScreen = (): string | undefined => {
    const last = screenRing.entries().at(-1);
    if (last === undefined) return undefined;
    const text = last.lines
      .map((l) => redactor.string(l))
      .join('\n')
      .trimEnd();
    return text.length > FINAL_SCREEN_MAX ? text.slice(-FINAL_SCREEN_MAX) : text;
  };

  const startError = (out: Exclude<StartOutcome, { kind: 'ready' }>, paneFinalScreen?: string): CcdError => {
    if (out.kind === 'gated') {
      const code = GATE_CODES[out.gate] ?? 'E_STARTUP_GATE';
      return new CcdError(code, `Claude stopped at a startup gate (${out.gate}); nothing was pressed`, {
        details: { reason: 'gate', gate: out.gate, text: redactor.string(out.text).slice(0, 2000) },
      });
    }
    if (out.kind === 'timeout') {
      return new CcdError('E_STARTUP_TIMEOUT', 'the session did not become ready', {
        details: { phase: loop.state.lifecycle, screenSummary: finalScreen()?.split('\n').slice(-3).join(' | ') ?? 'none' },
      });
    }
    const w = startupWarning;
    if (w !== undefined) {
      const detail =
        typeof w.detail === 'object' && w.detail !== null && !Array.isArray(w.detail) ? (w.detail as Record<string, JsonValue>) : {};
      return new CcdError(w.code as CcdErrorCode, w.message, { details: { ...detail } });
    }
    const ex = out.state.exit;
    const fs = paneFinalScreen ?? finalScreen();
    // §3.1 step 14: a pre-UI exit whose last screen names a known startup gate maps to that gate's code
    const gate = fs === undefined ? undefined : exitGateOf(fs, profile);
    if (gate !== undefined) {
      return new CcdError(gate.code, `Claude exited before the session was ready (${gate.gate})`, {
        details: { reason: 'exitedAtGate', gate: gate.gate, exitStatus: ex?.exitStatus ?? null, finalScreen: fs ?? '' },
      });
    }
    const details: Record<string, JsonValue> = {
      exitStatus: ex?.exitStatus ?? null,
      signal: ex?.signal ?? null,
      reason: ex?.reason ?? 'unknown',
    };
    if (fs !== undefined) details['finalScreen'] = fs;
    return new CcdError('E_STARTUP_EXITED', 'Claude exited before the session was ready', { details });
  };

  const selfTestKey = (info: LaunchInfo): SelfTestKey => ({
    claudeVersion: info.claudeVersion,
    cwdRealpath: config.cwdRealpath,
    trusted: info.trusted,
    transport: info.hookTransport,
  });

  let teardownPromise: Promise<void> | undefined;
  /** Idempotent; every caller (start failure, close) awaits the same teardown. */
  const teardown = (reason: string): Promise<void> => {
    teardownPromise ??= (async (): Promise<void> => {
      closedForGood = true;
      scheduler.stop();
      await loop.idle();
      loop.close(reason);
      const err = new CcdError('E_SESSION_CLOSED', `the session is closed (${reason})`);
      for (const r of [...waiterRejects]) r(err);
      await limit.idle();
      await trace.close();
    })();
    return teardownPromise;
  };

  let startPromise: Promise<SessionKernel> | undefined;
  let closePromise: Promise<SessionExitInfo> | undefined;

  const kernel: SessionKernelImpl = {
    sessionKey,
    host,
    getState: () => loop.state,
    dispatch,
    subscribe,
    subscribeDebug(l: (r: DebugRecord) => void): Unsubscribe {
      if (!debugEnabled) return () => undefined;
      return trace.subscribe(l);
    },
    // ICR 0040: `/usage` is allow-listed and `immediate` (no model call). slash.run captures the modal text and dismisses it
    // with Escape; the profile parses it. A first open may still be loading, so retry briefly before giving up.
    async queryUsage(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<UsageReport> {
      // ICR 0040: one open of /usage; the executor re-captures the open dialog until profile.usage.ready() (meters shown,
      // no "Refreshing…") or the timeout, then slash.run dismisses it. A timed-out read comes back `partial`.
      if (opts?.signal?.aborted === true) throw new CcdError('E_TURN_ABORTED', 'queryUsage aborted');
      const r = await dispatch({
        type: 'slash.run',
        name: '/usage',
        capture: { until: 'usageReady', timeoutMs: opts?.timeoutMs ?? 5_000 },
      });
      const report = r.output === undefined ? undefined : profile.usage.parse(r.output, clock.wallNow());
      if (report !== undefined) return report;
      throw new CcdError('E_USAGE_UNAVAILABLE', 'the /usage dialog showed no usage meters', { details: { reason: 'noMeters' } });
    },
    setPermissionHandler(h: KernelPermissionHandler | null): void {
      permissionHandler = h;
    },
    waitFor,
    diagnostics: {
      viewCommand: () => (launched !== undefined ? launched.viewCommand() : ''),
      captureScreen: () =>
        launched !== undefined
          ? launched.captureScreen()
          : Promise.reject(new CcdError('E_SESSION_EXITED', 'no pane (the session is not launched)')),
      ...(config.debug.tracePath !== undefined ? { tracePath: config.debug.tracePath } : {}),
    },

    start(): Promise<SessionKernel> {
      if (startPromise !== undefined) return startPromise;
      startPromise = (async (): Promise<SessionKernel> => {
        if (closedForGood) throw new CcdError('E_SESSION_CLOSED', 'the session is closed');
        const services = o.services ?? defaultKernelServices();
        // close() during start: the close owns `launched` (it kills it); start only stops and rejects.
        const closing = (): boolean => closeRequested || closedForGood;
        const closedDuringStart = (): CcdError => new CcdError('E_SESSION_CLOSED', 'the session was closed during start');
        let attempt = 0;
        let req: LaunchRequest = {
          attempt,
          claudeSessionId: config.claudeSessionId,
          transport: config.hooks.transport,
          ...(config.resume !== undefined ? { resume: config.resume } : {}),
        };
        for (;;) {
          if (closing()) throw closedDuringStart();
          let l: LaunchedSession;
          const launching = services.launch(host, req).then((x) => {
            // attached in the same continuation, so a close() waiting on `launchInFlight` always finds it
            attachLaunched(x);
            return x;
          });
          launchInFlight = launching.then(
            () => undefined,
            () => undefined,
          );
          try {
            l = await launching;
          } catch (e) {
            const err = toCctError(e, { op: 'start' });
            await teardown('startFailed');
            throw err;
          } finally {
            launchInFlight = undefined;
          }
          if (closing()) throw closedDuringStart();
          const attemptState = { aborted: false };
          const abortOnce = (why: string): Promise<SessionExitInfo | undefined> => {
            attemptState.aborted = true;
            return l.abort(why).catch(() => undefined);
          };
          try {
            if (attempt === 0) {
              header = buildHeader(l.info);
              trace.start(header);
            } else record({ r: 'diag', at: clock.now(), code: 'relaunch', detail: { attempt, transport: l.info.hookTransport } });

            // §3.1 step 15: nonce minted here (ids port), cache looked up here; the core decides what to do with it.
            const key = selfTestKey(l.info);
            let cachedPass = false;
            if (config.core.selfTest === 'once') cachedPass = await cache.cachedPass(key, clock.wallNow()).catch(() => false);
            if (closing()) throw closedDuringStart();
            const nonce = `ccd-selftest-${ports.ids.tokenHex(16)}`;
            currentNonce = nonce;
            nonceInTranscript = false;
            dispatch({ type: 'selftest.run', nonce, cachedPass }).catch((e: unknown) => {
              logger.debug('selftest.run rejected', { code: e instanceof CcdError ? e.code : 'unknown' });
            });

            const out = await waitStartOutcome();
            if (closing()) throw closedDuringStart();
            if (out.kind === 'ready') {
              if (readyEvent?.payload.selfTest === 'passed') await cache.record(key, 'pass', clock.wallNow()).catch(() => undefined);
              return kernel;
            }
            let err = startError(out);
            const st = typeof err.details?.['step'] === 'string' ? err.details['step'] : undefined;
            const ackOverHttp =
              err.code === 'E_SELFTEST_FAILED' &&
              st === 'ack' &&
              config.hooks.transport === 'auto' &&
              l.info.hookTransport === 'http' &&
              attempt === 0;
            const sawNonce = (): boolean => nonceInTranscript;
            if (ackOverHttp && err.details?.['transcriptEvidence'] !== true && !sawNonce()) {
              // the transcript lags hooks (P-TAIL-37): give the tail a moment to show the nonce prompt before deciding (the
              // launched session keeps its tail and Claude alive until abort() below)
              const until = clock.now() + TRANSCRIPT_EVIDENCE_WAIT_MS;
              while (!sawNonce() && clock.now() < until && !closing()) await clock.sleep(50);
            }
            if (closing()) throw closedDuringStart();
            const relaunch = ackOverHttp && (err.details?.['transcriptEvidence'] === true || sawNonce());
            if (err.code === 'E_SELFTEST_FAILED') await cache.record(key, 'fail', clock.wallNow(), st).catch(() => undefined);
            void screenRing.dump(`start-${err.code}`, clock.wallNow()).catch(() => undefined);
            const exitInfo = await abortOnce(relaunch ? 'selftestRelaunch' : `startFailed:${err.code}`);
            if (exitInfo?.finalScreen !== undefined && err.code === 'E_STARTUP_EXITED') err = startError(out, exitInfo.finalScreen);
            if (!relaunch) {
              await teardown('startFailed');
              throw err;
            }
            await loop.idle();
            if (closing()) throw closedDuringStart();
          } catch (e) {
            // any other way out of an attempt: the launched session never outlives the start (unless close() owns it)
            if (!attemptState.aborted && !closeRequested) {
              await abortOnce('startFailed');
              await teardown('startFailed');
            }
            throw e;
          }
          // ONE automatic relaunch with transport unix (fresh session id unless resuming); a fresh core that continues the
          // event and intent counters, so the published stream stays gap-free and strictly increasing.
          attempt = 1;
          const newId = config.resume ?? ports.ids.uuidV4();
          req = { attempt, claudeSessionId: newId, transport: 'unix', ...(config.resume !== undefined ? { resume: config.resume } : {}) };
          launched = undefined;
          intentBacklog.length = 0;
          startupWarning = undefined;
          readyEvent = undefined;
          const prev = loop.core;
          coreInit = { ...coreInit, initialClaudeSessionId: newId, startedAt: clock.now(), wallAt: clock.wallNow() };
          const fresh = initialCore(coreInit);
          loop.setCore({
            ...fresh,
            counters: { ...fresh.counters, event: prev.counters.event, intent: prev.counters.intent },
            domain: { ...fresh.domain, lastEventSeq: prev.domain.lastEventSeq },
          });
          channels = newChannels();
          scheduler.rearm(nextDeadline(loop.core));
        }
      })();
      return startPromise;
    },

    close(opts: KernelCloseOptions = {}): Promise<SessionExitInfo> {
      const requested = opts.mode ?? 'graceful';
      if (closePromise !== undefined) {
        // §3.8 / D-27: a kill during a graceful close escalates it (second signal, abort); the same promise settles
        if (requested === 'kill' && closeMode === 'graceful') {
          closeMode = 'kill';
          killEscalation.abort();
        }
        return closePromise;
      }
      closeRequested = true;
      closeMode = requested;
      if (requested === 'kill') killEscalation.abort();
      closePromise = (async (): Promise<SessionExitInfo> => {
        const graceMs = opts.graceMs ?? config.lifecycle.closeGraceMs;
        const reason = opts.reason ?? 'closed';
        // Only the in-flight launch call is awaited (its session is then killed at once); start() itself stops at its next
        // await because `closeRequested` is set.
        if (launched === undefined && launchInFlight !== undefined) await launchInFlight;
        const l = launched;
        if (closedForGood || l === undefined) {
          await teardown(reason);
          const ex = loop.state.exit;
          return { exitStatus: ex?.exitStatus ?? null, signal: ex?.signal ?? null, reason: mapExitReason(ex?.reason, 'closed') };
        }
        if (loop.state.lifecycle !== 'exited' && !(closeMode === 'graceful' && killEscalation.signal.aborted)) {
          // The core drives the graceful path itself (§3.8 steps 1–3: session.closing, deny held permissions, `/exit` job or
          // SIGTERM to the verified pid); the pollers' pane_dead poll reports the exit. We wait up to the grace period; a kill
          // arriving meanwhile cancels the wait (killEscalation) and goes straight to the SIGKILL below.
          const mode = closeMode;
          const cmd: Command = {
            type: 'session.close',
            mode,
            graceMs,
            reason,
            ...(opts.waitForBackgroundMs !== undefined ? { waitForBackgroundMs: opts.waitForBackgroundMs } : {}),
          };
          dispatch(cmd).catch(() => undefined);
          const budget = (mode === 'kill' ? Math.min(graceMs, 1000) : graceMs) + (opts.waitForBackgroundMs ?? 0);
          await waitFor((s) => s.lifecycle === 'exited', {
            timeoutMs: budget,
            ...(mode === 'graceful' ? { signal: killEscalation.signal } : {}),
          }).catch(() => undefined);
        }
        const mode = closeMode;
        let info: SessionExitInfo;
        try {
          // steps 4–10 (escalation when the pane is still alive, teardown, archive); its own grace is already spent above
          info = await l.close({ ...opts, mode, graceMs: loop.state.lifecycle === 'exited' ? graceMs : 1, reason });
        } catch (e) {
          logger.warn('close sequence failed', { code: toCctError(e).code });
          const ex = loop.state.exit;
          info = {
            exitStatus: ex?.exitStatus ?? null,
            signal: ex?.signal ?? null,
            reason: mapExitReason(ex?.reason, mode === 'kill' ? 'killed' : 'closed'),
          };
        }
        // give the core the process.exited observation (pane_dead poll) so session.exited is published before teardown
        await waitFor((s) => s.lifecycle === 'exited', { timeoutMs: CLOSE_EXIT_WAIT_MS }).catch(() => undefined);
        await teardown(reason);
        return info;
      })();
      return closePromise;
    },
  };
  return kernel;
}

function mapExitReason(r: string | undefined, dflt: SessionExitInfo['reason']): SessionExitInfo['reason'] {
  switch (r) {
    case undefined:
      return dflt;
    case 'closed':
    case 'crashed':
    case 'killed':
    case 'hangup':
    case 'startupFailed':
    case 'exitedByItself':
    case 'ownerGone':
      return r;
    default:
      return dflt;
  }
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(typeof e === 'string' ? e : 'rejected');
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function safeTz(ports: Ports): string {
  const z = safe(() => ports.env.timeZone());
  return typeof z === 'string' && z !== '' ? z : 'UTC';
}

// ------------------------------------------------------------------------------------------------ default composition

/**
 * The default `KernelServices`: WP-12 `launchSession` (§3.1 steps 1–13) + `SessionLifecycle` (§3.8) with the WP-13 executors.
 * Intent routing (L-2: one owner per intent kind; failures come back as observations, the core decides about retries):
 *   input → input executor; screen.captureNow / poll.cadence / auth.poll → pollers; hook.* / host.* → permission broker;
 *   permission.resolvePaths → path resolver; tail.* → tail driver; registry.persist / process.signal / lifecycle.finalize →
 *   lifecycle; net.fault → the sidecar.
 */
export function defaultKernelServices(o: { launch?: typeof launchSession } = {}): KernelServices {
  const launch = o.launch ?? launchSession;
  return {
    async launch(host: KernelHost, req: LaunchRequest): Promise<LaunchedSession> {
      const { ports, logger, profile, tz } = host;
      const clock = ports.clock;
      const config: ResolvedConfig =
        req.claudeSessionId === host.config.claudeSessionId ? host.config : { ...host.config, claudeSessionId: req.claudeSessionId };
      const cache = createSelfTestCache({ state: ports.state, pid: process.pid });
      const late: { broker?: PermissionBroker; tailDriver?: TailDriver } = {};
      const early: { e: RawHookEvent; unclaimed: boolean }[] = [];
      const onHook = (e: RawHookEvent): void => {
        const unclaimed = host.ingestHook(e);
        const broker = late.broker;
        if (broker === undefined) {
          // A held request is kept even past the cap: dropping it would leave the forwarder blocked (ICR 0026).
          if (early.length < 1024 || e.holdable) early.push({ e, unclaimed });
          return;
        }
        broker.trackHookEvent(e);
        if (unclaimed) broker.releaseUnclaimed(e);
        late.tailDriver?.noteHookEvent(e);
      };
      const forced: 'http' | 'unix' | undefined = req.attempt > 0 ? 'unix' : req.transport === 'auto' ? undefined : req.transport;
      const res: LaunchResult = await launch(ports, config, {
        sinks: {
          hook: onHook,
          observe: (x) => {
            host.observe(x);
          },
          warning: (w) => {
            host.warn(w.code, `launch: ${w.reason}`, w.details === undefined ? { reason: w.reason } : { reason: w.reason, ...w.details });
          },
          securityAlert: (a) => {
            host.alert(a.code, a.detail);
          },
        },
        ...(forced !== undefined ? { hookTransport: forced } : {}),
        httpSelfTestFailedRecently: (v, cwd) => cache.httpFailedRecently(v, cwd, clock.wallNow()),
      });
      const h = res.handles;
      const lifecycle = res.lifecycle;
      // §3.10: the launcher refused or could not start the network channel (user proxy, NO_PROXY covers the API, proxy auth
      // helper, no net port, sidecar start failure). The core starts with `network: up` whenever it is configured, so the
      // refusal must reach it as a transport fact, or the snapshot keeps reporting `up` (live L-07, live-results F-3).
      if (config.core.channels.network && res.network === 'off') {
        const w = res.warnings.find((x) => x.code === 'E_NETWORK_UNAVAILABLE');
        host.observe({
          kind: 'channel.health',
          meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'channel' },
          p: { channel: 'network', health: 'off', reason: w?.reason ?? 'unavailable' },
        });
      }
      if (h.hooks.endpoint.http !== undefined) host.addSecret(h.hooks.endpoint.http.token);
      const emit = (x: ObservationInput): void => {
        host.observe(x);
      };
      const input: InputExecutor = createInputExecutor({
        clock,
        pane: () => h.tmux.pane,
        editor: h.editor,
        emit,
        profile,
        redact: (t) => host.redactor.string(t),
        logger,
        chunkGapMs: config.core.input.chunkGapMs,
        escGapMs: config.core.timeouts.escGapMs,
      });
      const b = createPermissionBroker({
        clock,
        hooks: h.hooks.transport,
        emit,
        dispatch: (c) => host.dispatch(c),
        getState: () => host.getState(),
        logger,
      });
      b.setHandler((ask) => {
        const user = host.permissionHandler();
        return user === null ? undefined : user(ask);
      });
      late.broker = b;
      const authEnv: Record<string, string> = { ...h.toolEnv };
      const cfgDir = ports.env.snapshot()['CLAUDE_CONFIG_DIR'];
      if (cfgDir !== undefined && cfgDir !== '') authEnv['CLAUDE_CONFIG_DIR'] = cfgDir;
      const pollers: Pollers = createPollers({
        clock,
        pane: () => h.tmux.pane,
        emit,
        profile,
        tz,
        editorGate: input,
        auth: { port: ports.claude, exe: h.claude.exe, env: authEnv },
        screen: host.channels.screen,
        logger,
      });
      const td =
        h.tail !== undefined
          ? createTailDriver({ clock, tail: h.tail, emit, profile, normalizer: host.channels.transcript, logger })
          : undefined;
      if (td !== undefined) late.tailDriver = td;
      const paths = createPathResolver({ clock, fs: ports.env, cwdRealpath: h.cwdRealpath, emit, logger });
      for (const { e, unclaimed } of early.splice(0)) {
        b.trackHookEvent(e);
        if (unclaimed) b.releaseUnclaimed(e);
        td?.noteHookEvent(e);
      }
      const offNet = h.net?.on((r) => {
        host.ingestTunnel(r);
      });
      pollers.watchPane();

      let ready = false;
      /** A `lifecycle.finalize` that arrived before ready: start() owns that teardown (abort), see finalize(). */
      let finalizeDeferred = false;
      const offReady = host.subscribe((batch) => {
        if (!ready && batch.events.some((e) => e.type === 'session.ready')) {
          ready = true;
          void lifecycle.markReady().catch(() => undefined);
          if (finalizeDeferred) finalize();
        }
      });

      let stopped = false;
      const stopExecutors = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        offReady();
        offNet?.();
        b.close();
        pollers.close();
        paths.close();
        await input.close().catch(() => undefined);
        await td?.close().catch(() => undefined);
      };

      const track = (intent: Intent, p: Promise<unknown> | undefined): void => {
        const t0 = clock.now();
        if (p === undefined) {
          host.effect(intent.id, t0, true);
          return;
        }
        p.then(
          () => {
            host.effect(intent.id, t0, true);
          },
          (e: unknown) => {
            host.effect(intent.id, t0, false, e instanceof Error ? e.name : 'error');
          },
        );
      };

      function finalize(): void {
        if (lifecycle.closing) return;
        if (!ready) {
          // A startup failure (self-test, pre-UI exit): the kernel's start() decides what happens next and then calls abort()
          // (or close() does). Until then the executors and the tail stay up and Claude is not killed, so the K-37 wait for a
          // lagging transcript (P-TAIL-37, ICR 0011 item 5) can still see the nonce prompt.
          finalizeDeferred = true;
          return;
        }
        const st = host.getState();
        void (async () => {
          await stopExecutors();
          await lifecycle.finalizeAfterExit({ startup: !ready, ownerGone: st.exit?.reason === 'ownerGone' });
        })()
          .catch((e: unknown) => {
            logger.warn('finalize after exit failed', { code: toCctError(e).code });
          })
          .finally(() => {
            host.exitFinalized();
          });
      }

      const reportExit = (info: SessionExitInfo): void => {
        if (host.getState().lifecycle === 'exited') return;
        host.observe({
          kind: 'process.exited',
          meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'process' },
          p: { exitStatus: info.exitStatus, signal: info.signal },
        });
      };

      return {
        info: {
          claudeVersion: res.claude.version,
          tmuxVersion: res.tmuxVersion,
          hookTransport: res.hookTransport.transport,
          trusted: res.trust.trusted,
          claudeSessionId: h.claude.argvSessionId,
        },
        execute(intent: Intent): void {
          if (stopped && intent.kind !== 'lifecycle.finalize') return;
          try {
            switch (intent.kind) {
              case 'input':
                track(intent, input.execute(intent));
                return;
              case 'screen.captureNow':
              case 'poll.cadence':
              case 'auth.poll':
                track(intent, pollers.execute(intent));
                return;
              case 'hook.respond':
              case 'hook.armSelfTest':
              case 'hook.disarmSelfTest':
              case 'host.askPermission':
              case 'host.cancelAsk':
                track(intent, b.execute(intent));
                return;
              case 'permission.resolvePaths':
                track(intent, paths.execute(intent));
                return;
              case 'tail.followMain':
              case 'tail.observePath':
              case 'tail.expectSubagent':
              case 'tail.subagentStopped':
              case 'tail.poke':
                td?.execute(intent);
                track(intent, undefined);
                return;
              case 'registry.persist':
                track(intent, lifecycle.persist(intent.patch));
                return;
              case 'net.fault':
                track(intent, h.net?.setFault(intent.spec));
                return;
              case 'process.signal':
                track(intent, lifecycle.signal(intent.signal));
                return;
              case 'lifecycle.finalize':
                finalize();
                return;
            }
          } catch (e) {
            host.effect(intent.id, clock.now(), false, e instanceof Error ? e.name : 'error');
          }
        },
        viewCommand: () => h.tmux.pane.viewCommand(),
        async captureScreen(): Promise<string> {
          const c = await h.tmux.pane.capture();
          return c.lines
            .map((l) => host.redactor.string(l))
            .join('\n')
            .trimEnd();
        },
        async close(co): Promise<SessionExitInfo> {
          const ctx: CloseContext = {
            // the core already ran §3.8 steps 0–3 (session.close command); never a second `/exit`
            canExitGracefully: () => false,
            dialogVisible: () => pollers.lastFacts()?.dialog !== undefined,
          };
          const info = await lifecycle.close({ mode: co.mode, graceMs: co.graceMs, reason: co.reason }, ctx);
          reportExit(info);
          await stopExecutors();
          return info;
        },
        async abort(_reason: string): Promise<SessionExitInfo | undefined> {
          await stopExecutors();
          const info = await lifecycle.finalizeAfterExit({ startup: true });
          reportExit(info);
          return info;
        },
      };
    },
  };
}
