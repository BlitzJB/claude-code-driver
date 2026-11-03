// testing/test-kernel.ts — `createTestKernel`: the REAL session (L3) + core (L2) + channels (L1) with every L0 port faked
// (DESIGN.md §6.1 `kernel` project, §6.3). The fakes come from testing/fake-ports.ts, the world (Claude in the pane) from
// testing/fake-claude.ts, time from one FakeClock that the harness pumps while a promise is pending.
//
// The L3 entry points are loaded at call time (`loadSessionModules`), not imported statically: in Phase 1 the kernel scenarios
// are written before WP-11/12/13 land (§8 "Phase 1 … WP-14 (scenarios as it.fails)"), and a static import of a file that does
// not exist yet would break `pnpm typecheck` for the whole repo. The expected L3 shape is the one §1.2/§2.10 name:
//   session/config.ts  resolveConfig(spec: SessionSpec, env: EnvPort, defaults?) → ResolvedConfig (sync or async)
//   session/kernel.ts  createSessionKernel(ports: Ports, config: ResolvedConfig) → SessionKernel (sync or async);
//                      an optional `start()` on the returned object is awaited (runtime/node.ts createKernel resolves at ready).
// The adapter is recorded in docs/icr/0014-wp14.md; a test may pass its own `modules` instead.
import type { Command, CommandResult } from '../model/commands.js';
import type { ResolvedConfig } from '../model/config.js';
import type { DebugRecord } from '../model/debug.js';
import type { DomainEvent } from '../model/events.js';
import type { EventSeq } from '../model/ids.js';
import type { KernelCloseOptions, KernelPermissionHandler, SessionExitInfo, SessionKernel } from '../model/kernel.js';
import type { SessionSpec } from '../model/spec.js';
import type { SessionState } from '../model/state.js';
import type { Ports } from '../platform/ports.js';
import { flushMicrotasks } from '../platform/clock/fake-clock.js';
import { FakeClaude, type FakeClaudeOptions, type FakeClaudeSession } from './fake-claude.js';
import { createFakePorts, type FakePortSet, type FakePortsOptions } from './fake-ports.js';

export interface SessionModules {
  resolveConfig(
    spec: SessionSpec,
    env: Ports['env'],
    defaults?: unknown,
    ids?: Pick<Ports['ids'], 'uuidV4' | 'shortHex'>,
  ): ResolvedConfig | Promise<ResolvedConfig>;
  createSessionKernel(ports: Ports, config: ResolvedConfig): SessionKernel | Promise<SessionKernel>;
  defaults?: unknown;
}

/** Thrown when an L3 module the kit needs has not landed yet (the scenarios run as `it.fails` until it does). */
export class SessionNotLanded extends Error {
  constructor(
    readonly modulePath: string,
    cause: unknown,
  ) {
    super(`testing/test-kernel: ${modulePath} is not available yet (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = 'SessionNotLanded';
  }
}

async function importOptional(spec: string): Promise<Record<string, unknown>> {
  try {
    return (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
  } catch (e) {
    throw new SessionNotLanded(spec, e);
  }
}

/** Load session/config.ts and session/kernel.ts at run time (see the header). */
export async function loadSessionModules(): Promise<SessionModules> {
  // Variable specifiers on purpose: the files may not exist while Phase 1 runs (header).
  const configPath = '../session/config.js';
  const kernelPath = '../session/kernel.js';
  const cfg = await importOptional(configPath);
  const ker = await importOptional(kernelPath);
  const resolveConfig = cfg['resolveConfig'];
  const create = ker['createSessionKernel'];
  if (typeof resolveConfig !== 'function') throw new SessionNotLanded(configPath, new Error('no resolveConfig export'));
  if (typeof create !== 'function') throw new SessionNotLanded(kernelPath, new Error('no createSessionKernel export'));
  const defaults = cfg['DEFAULTS'];
  const out: SessionModules = {
    resolveConfig: resolveConfig as SessionModules['resolveConfig'],
    createSessionKernel: create as SessionModules['createSessionKernel'],
  };
  if (defaults !== undefined) out.defaults = defaults;
  return out;
}

export interface TestKernelOptions {
  /** Merged over `{ cwd: fakes.cwd, permissions: { policy: 'handler' } }`. */
  spec?: Omit<Partial<SessionSpec>, 'permissions'> & { permissions?: SessionSpec['permissions'] };
  ports?: FakePortsOptions;
  /** Reuse an existing fake world (K-30 two kernels, K-50 second start). */
  fakes?: FakePortSet;
  claude?: FakeClaudeOptions;
  /** Reuse an existing FakeClaude (second start in the same world). */
  world?: FakeClaude;
  permissionHandler?: KernelPermissionHandler;
  /** Await readiness before returning (default true). With false, `started` is pumped by later `advance` calls. */
  awaitReady?: boolean;
  /** FakeClock ms the harness may spend reaching ready (default 70 000 > startupMs 60 000). */
  maxStartMs?: number;
  modules?: SessionModules;
}

export interface TestKernel {
  readonly fakes: FakePortSet;
  readonly world: FakeClaude;
  /** Settles when the kernel reached ready (or failed to start). */
  readonly started: Promise<SessionKernel>;
  /** Every DomainEvent published so far (subscribe fromSeq 0, so nothing before the first listener is lost). */
  readonly events: DomainEvent[];
  readonly debug: DebugRecord[];
  /** The kernel; throws if start has not succeeded. */
  readonly kernel: SessionKernel;
  /** Start failure, if any (after `started` settled). */
  readonly startError: unknown;
  /** The Claude session in the current pane. */
  claude(): FakeClaudeSession;
  state(): Readonly<SessionState>;
  eventsOf<T extends DomainEvent['type']>(type: T): Extract<DomainEvent, { type: T }>[];
  /** Advance FakeClock by `ms` in `stepMs` steps, letting promise continuations and immediates run in between. */
  advance(ms: number, stepMs?: number): Promise<void>;
  /** Pump the clock until `p` settles (rejects after `maxMs` of fake time). */
  pump<T>(p: Promise<T>, maxMs?: number): Promise<T>;
  /** Pump until `pred()` holds. */
  until(pred: () => boolean, maxMs?: number, what?: string): Promise<void>;
  /** Pump until an event of `type` (matching `pred`) is published after index `from`; returns it. */
  waitForEvent<T extends DomainEvent['type']>(
    type: T,
    o?: { pred?: (e: Extract<DomainEvent, { type: T }>) => boolean; maxMs?: number; from?: number },
  ): Promise<Extract<DomainEvent, { type: T }>>;
  dispatch<C extends Command>(cmd: C, maxMs?: number): Promise<CommandResult<C>>;
  close(o?: KernelCloseOptions, maxMs?: number): Promise<SessionExitInfo>;
}

const STEP_MS = 10;

async function settleHost(): Promise<void> {
  await flushMicrotasks();
  await new Promise<void>((r) => setImmediate(r));
  await flushMicrotasks();
}

/** Default spec for scenarios: trusted cwd, handler policy, self-test on, fakes' paths. */
export function testSpec(fakes: FakePortSet, over: TestKernelOptions['spec'] = {}): SessionSpec {
  const base: SessionSpec = {
    cwd: fakes.cwd,
    permissions: { policy: 'handler' },
    lifecycle: { stateDir: fakes.state.root, runtimeRoot: fakes.runtimeDir.root },
  };
  return { ...base, ...over, permissions: over.permissions ?? base.permissions };
}

export async function createTestKernel(o: TestKernelOptions = {}): Promise<TestKernel> {
  const fakes = o.fakes ?? createFakePorts(o.ports ?? {});
  const world = o.world ?? new FakeClaude(fakes, o.claude ?? {});
  const events: DomainEvent[] = [];
  const debug: DebugRecord[] = [];
  let kernel: SessionKernel | undefined;
  let startError: unknown;

  const advance = async (ms: number, stepMs = STEP_MS): Promise<void> => {
    let left = Math.max(0, ms);
    await settleHost();
    while (left > 0) {
      const d = Math.min(stepMs, left);
      await fakes.clock.advanceAsync(d);
      await settleHost();
      left -= d;
    }
  };

  const pump = async <T>(p: Promise<T>, maxMs = 30_000): Promise<T> => {
    // A holder object: the settle callbacks mutate it, so the loop condition is not narrowed to a constant.
    const st: { done: boolean; failed: boolean; value?: T; error?: unknown } = { done: false, failed: false };
    p.then(
      (v) => {
        st.done = true;
        st.value = v;
      },
      (e: unknown) => {
        st.done = true;
        st.failed = true;
        st.error = e;
      },
    );
    let spent = 0;
    await settleHost();
    while (!st.done) {
      if (spent >= maxMs) throw new Error(`testing/test-kernel: promise still pending after ${maxMs} ms of fake time`);
      await fakes.clock.advanceAsync(STEP_MS);
      await settleHost();
      spent += STEP_MS;
    }
    if (st.failed) throw st.error;
    return st.value as T;
  };

  const until = async (pred: () => boolean, maxMs = 10_000, what = 'condition'): Promise<void> => {
    let spent = 0;
    await settleHost();
    while (!pred()) {
      if (spent >= maxMs) throw new Error(`testing/test-kernel: ${what} not reached within ${maxMs} ms of fake time`);
      await fakes.clock.advanceAsync(STEP_MS);
      await settleHost();
      spent += STEP_MS;
    }
  };

  // Import the L3 graph BEFORE any fake time is pumped: the import takes real time, and `pump` would otherwise spend the
  // whole fake-time start budget while the modules load (WP-INT fix, docs/icr/0016-wp-int.md item 1).
  const mods = o.modules ?? (await loadSessionModules());
  const started = (async (): Promise<SessionKernel> => {
    const spec = testSpec(fakes, o.spec);
    // the fake id port mints the session key and Claude session id, so a test kernel (and a replay) is deterministic
    const config = await mods.resolveConfig(spec, fakes.ports.env, mods.defaults, fakes.ports.ids);
    const k = await mods.createSessionKernel(fakes.ports, config);
    kernel = k;
    k.subscribe(
      (b) => {
        events.push(...b.events);
      },
      { fromSeq: 0 as EventSeq },
    );
    k.subscribeDebug((r) => debug.push(r));
    if (o.permissionHandler !== undefined) k.setPermissionHandler(o.permissionHandler);
    const start = (k as unknown as { start?: () => Promise<unknown> }).start;
    if (typeof start === 'function') await start.call(k);
    else
      await k.waitFor((s) => s.lifecycle === 'ready' || s.lifecycle === 'exited' || s.lifecycle === 'gated', {
        timeoutMs: o.maxStartMs ?? 70_000,
      });
    const s = k.getState();
    if (s.lifecycle !== 'ready') throw new Error(`testing/test-kernel: session did not become ready (lifecycle ${s.lifecycle})`);
    return k;
  })();
  started.catch((e: unknown) => {
    startError = e;
  });

  const tk: TestKernel = {
    fakes,
    world,
    started,
    events,
    debug,
    get kernel(): SessionKernel {
      if (kernel === undefined) throw new Error('testing/test-kernel: kernel not created (start failed or still pending)');
      return kernel;
    },
    get startError(): unknown {
      return startError;
    },
    claude: () => world.current(),
    state: () => tk.kernel.getState(),
    eventsOf: <T extends DomainEvent['type']>(type: T) => events.filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type),
    advance,
    pump,
    until,
    async waitForEvent(type, w = {}) {
      const from = w.from ?? 0;
      let found: DomainEvent | undefined;
      await until(
        () => {
          found = events.slice(from).find((e) => e.type === type && (w.pred === undefined || w.pred(e as never)));
          return found !== undefined;
        },
        w.maxMs ?? 10_000,
        `event ${type}`,
      );
      return found as never;
    },
    dispatch: (cmd, maxMs) => pump(tk.kernel.dispatch(cmd), maxMs),
    close: (c, maxMs = 30_000) => pump(tk.kernel.close(c), maxMs),
  };

  if (o.awaitReady !== false) await pump(started, o.maxStartMs ?? 70_000);
  return tk;
}

/**
 * Start a kernel that is expected to FAIL to start; resolves with the rejection (the harness pumps time meanwhile). A missing
 * L3 module (`SessionNotLanded`) is not a start failure of the session under test and is rethrown.
 */
export async function expectStartFailure(o: TestKernelOptions = {}): Promise<{ tk: TestKernel; error: unknown }> {
  const tk = await createTestKernel({ ...o, awaitReady: false });
  try {
    await tk.pump(tk.started, o.maxStartMs ?? 70_000);
  } catch (error) {
    if (error instanceof SessionNotLanded) throw error;
    return { tk, error };
  }
  throw new Error('testing/test-kernel: start succeeded but a failure was expected');
}
