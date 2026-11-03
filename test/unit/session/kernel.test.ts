// session/kernel.ts — start protocol, self-test cache + nonce, start errors, the one unix relaunch, intent routing, L1
// ingestion with raw records, waitFor, close (DESIGN.md §2.10, §3.1 steps 13–16, D-35; P-REV-23, P-HOOK-06). The core
// `step` and the WP-12/13 services are stubbed; the full stack runs in test/kernel/**.
import { describe, expect, it } from 'vitest';
import { evolve } from '../../../src/core/evolve.js';
import type { CoreInput, CoreState, StepResult } from '../../../src/core/step.js';
import type { Command } from '../../../src/model/commands.js';
import type { DebugRecord } from '../../../src/model/debug.js';
import type { CoreEvent, DomainEvent } from '../../../src/model/events.js';
import type { EventSeq, HookSeq, IntentId } from '../../../src/model/ids.js';
import type { Intent } from '../../../src/model/intents.js';
import type { JsonValue } from '../../../src/model/json.js';
import type { SessionExitInfo } from '../../../src/model/kernel.js';
import type { Observation } from '../../../src/model/observation.js';
import type { LifecyclePhase } from '../../../src/model/state.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { createFakePorts } from '../../../src/testing/fake-ports.js';
import type { FakePortSet } from '../../../src/testing/fake-ports.js';
import { resolveConfig } from '../../../src/session/config.js';
import { createSessionKernel } from '../../../src/session/kernel.js';
import type { KernelHost, KernelServices, LaunchRequest, LaunchedSession, SessionKernelImpl } from '../../../src/session/kernel.js';
import { SELFTEST_CACHE_FILE } from '../../../src/session/selftest-cache.js';
import type { SessionSpec } from '../../../src/model/spec.js';
import { flushMicrotasks } from '../../../src/platform/clock/fake-clock.js';
import type { TraceFs } from '../../../src/session/debug-trace.js';

type Outcome = 'ready' | 'trustGate' | 'selftestAckHttp' | 'exitInUse' | 'never';

/** A scripted stand-in for the core: lifecycle via x.lifecycle, a few published events, command results. */
function stubCore(script: { outcomes: Outcome[]; seen: string[]; cmds: Command[] }) {
  let attempt = -1;
  return (c: CoreState, i: CoreInput): StepResult => {
    const events: DomainEvent[] = [];
    let core = c;
    const t = i.type === 'obs' ? { at: i.obs.meta.at, wallAt: i.obs.meta.wallAt } : { at: i.at, wallAt: i.wallAt };
    core = { ...core, now: Math.max(core.now, t.at) as MonoMs, wallNow: Math.max(core.wallNow, t.wallAt) as WallMs };
    const apply = (e: CoreEvent): void => {
      core = { ...core, domain: evolve(core.domain, e) };
    };
    const publish = (type: string, payload: JsonValue): void => {
      const seq = (core.counters.event + 1) as EventSeq;
      core = { ...core, counters: { ...core.counters, event: seq } };
      const e = {
        v: 1,
        seq,
        type,
        at: core.now,
        wallAt: core.wallNow,
        sessionKey: core.domain.sessionKey,
        provenance: { confirmed: true, sources: ['self'] },
        causedBy: [],
        payload,
      } as unknown as DomainEvent;
      events.push(e);
      apply(e);
    };
    const lifecycle = (phase: LifecyclePhase): void => {
      apply({ type: 'x.lifecycle', phase });
    };
    const intents: Intent[] = [];
    let commandResult: StepResult['commandResult'];
    if (i.type === 'obs') {
      script.seen.push(i.obs.kind);
      if (i.obs.kind === 'process.launched') {
        attempt++;
        lifecycle('launching');
        intents.push({ kind: 'poll.cadence', id: 1 as IntentId, channel: 'screen', intervalMs: 150 });
      }
    } else {
      script.cmds.push(i.cmd);
      commandResult = { cmdId: i.cmdId, ok: true, value: { ok: true } };
      if (i.cmd.type === 'selftest.run') {
        const out = script.outcomes[Math.max(0, attempt)] ?? 'ready';
        if (out === 'ready') {
          lifecycle('ready');
          publish('session.ready', {
            permissionMode: 'default',
            selfTest: i.cmd.cachedPass ? 'cached' : 'passed',
            resumed: false,
            hookTransport: 'http',
          });
        } else if (out === 'trustGate') {
          lifecycle('gated');
          apply({ type: 'x.patch', entity: 'gate', patch: { op: 'set', value: { kind: 'trust', text: 'Accessing workspace:' } } });
        } else if (out === 'selftestAckHttp') {
          publish('warning', {
            code: 'E_SELFTEST_FAILED',
            message: 'self-test failed at ack',
            detail: { step: 'ack', transcriptEvidence: true, hookTransport: 'http' },
          });
          lifecycle('exited');
          publish('session.exited', { exitStatus: null, signal: null, reason: 'startupFailed' });
        } else if (out === 'exitInUse') {
          lifecycle('exited');
          apply({ type: 'x.patch', entity: 'exit', patch: { op: 'set', value: { exitStatus: 1, signal: null, reason: 'startupFailed' } } });
        }
      }
      if (i.cmd.type === 'session.close') {
        lifecycle('closing');
      }
    }
    if (i.type === 'obs' && i.obs.kind === 'process.exited') lifecycle('exited');
    const r: StepResult = { core, events, intents, diagnostics: [] };
    if (commandResult !== undefined) r.commandResult = commandResult;
    return r;
  };
}

interface Launch {
  req: LaunchRequest;
  executed: Intent[];
  aborted: string[];
  closed: number;
  closeModes: string[];
}

function stubServices(
  o: {
    fail?: unknown;
    finalScreen?: string;
    hookTransport?: 'http' | 'unix';
    /** Resolves when the launch call may return (default: at once). */
    launchGate?: () => Promise<void>;
    /** Resolves when abort() may return (default: at once). */
    abortGate?: () => Promise<void>;
  } = {},
) {
  const launches: Launch[] = [];
  let hostRef: KernelHost | undefined;
  const services: KernelServices = {
    async launch(host: KernelHost, req: LaunchRequest): Promise<LaunchedSession> {
      hostRef = host;
      if (o.launchGate !== undefined) await o.launchGate();
      if (o.fail !== undefined) throw o.fail instanceof Error ? o.fail : new Error('launch failed');
      const l: Launch = { req, executed: [], aborted: [], closed: 0, closeModes: [] };
      launches.push(l);
      host.observe({
        kind: 'process.launched',
        meta: { at: host.ports.clock.now(), wallAt: host.ports.clock.wallNow(), source: 'process' },
        p: { pid: 4242, paneId: '%1', claudeVersion: '2.1.316', startTime: 'x' },
      });
      const exit: SessionExitInfo = { exitStatus: 0, signal: null, reason: 'closed' };
      return {
        info: {
          claudeVersion: '2.1.316',
          tmuxVersion: '3.5a',
          hookTransport: req.attempt > 0 ? 'unix' : (o.hookTransport ?? 'http'),
          trusted: true,
          claudeSessionId: req.claudeSessionId,
        },
        execute: (i: Intent) => {
          l.executed.push(i);
        },
        viewCommand: () => 'tmux -L ccd-x attach -r -t =ccd-s:',
        captureScreen: () => Promise.resolve('screen'),
        close: (co) => {
          l.closed++;
          l.closeModes.push(co.mode);
          host.observe({
            kind: 'process.exited',
            meta: { at: host.ports.clock.now(), wallAt: host.ports.clock.wallNow(), source: 'process' },
            p: { exitStatus: 0, signal: null },
          });
          return Promise.resolve(exit);
        },
        abort: async (reason: string) => {
          l.aborted.push(reason);
          if (o.abortGate !== undefined) await o.abortGate();
          return o.finalScreen === undefined ? exit : { ...exit, finalScreen: o.finalScreen };
        },
        tailCheckpoint: () => ({ files: [] }),
      };
    },
  };
  return { services, launches, host: () => hostRef };
}

function memFs(): TraceFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    openAppend: (path) =>
      Promise.resolve({
        write: (d: string) => {
          files.set(path, (files.get(path) ?? '') + d);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      }),
    writePrivate: (dir, name, data) => {
      files.set(`${dir}/${name}`, data);
      return Promise.resolve(`${dir}/${name}`);
    },
  };
}

async function build(o: {
  outcomes?: Outcome[];
  spec?: Partial<SessionSpec>;
  fakes?: FakePortSet;
  services?: ReturnType<typeof stubServices>;
  traceFs?: ReturnType<typeof memFs>;
}) {
  const fakes = o.fakes ?? createFakePorts();
  const script = { outcomes: o.outcomes ?? ['ready'], seen: [] as string[], cmds: [] as Command[] };
  const spec: SessionSpec = {
    cwd: fakes.cwd,
    permissions: { policy: 'handler' },
    lifecycle: { stateDir: fakes.state.root, runtimeRoot: fakes.runtimeDir.root },
    ...o.spec,
  };
  const config = await resolveConfig(spec, fakes.ports.env);
  const svc = o.services ?? stubServices();
  const k: SessionKernelImpl = createSessionKernel(fakes.ports, config, {
    services: svc.services,
    step: stubCore(script),
    lagMonitor: false,
    ...(o.traceFs !== undefined ? { traceFs: o.traceFs } : {}),
  });
  const events: DomainEvent[] = [];
  k.subscribe((b) => events.push(...b.events), { fromSeq: 0 as EventSeq });
  return { fakes, k, script, svc, events, config };
}

/** Let promise chains run; advance fake time while a promise is pending (bounded). */
async function pump<T>(fakes: FakePortSet, p: Promise<T>, maxMs = 10_000): Promise<T> {
  const st: { done: boolean; v?: T; e?: unknown; failed: boolean } = { done: false, failed: false };
  p.then(
    (v) => {
      st.done = true;
      st.v = v;
    },
    (e: unknown) => {
      st.done = true;
      st.failed = true;
      st.e = e;
    },
  );
  for (let spent = 0; !st.done; spent += 10) {
    if (spent > maxMs) throw new Error('pump: still pending');
    await flushMicrotasks();
    await new Promise<void>((r) => setImmediate(r));
    await fakes.clock.advanceAsync(10);
  }
  if (st.failed) throw st.e;
  return st.v as T;
}

const NONCE_RE = /^ccd-selftest-[0-9a-f]{32}$/;

describe('kernel start', () => {
  it('launch → selftest.run{nonce, cachedPass:false} → ready; pass cached; second kernel in the process → cachedPass', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    expect(a.k.getState().lifecycle).toBe('ready');
    expect(a.svc.launches).toHaveLength(1);
    expect(a.svc.launches[0]?.req).toMatchObject({ attempt: 0, transport: 'auto', claudeSessionId: a.config.claudeSessionId });
    const st = a.script.cmds.find((c) => c.type === 'selftest.run');
    expect(st).toMatchObject({ cachedPass: false });
    expect(st?.type === 'selftest.run' ? st.nonce : '').toMatch(NONCE_RE);
    expect(a.fakes.state.files.get(SELFTEST_CACHE_FILE)).toContain('"result": "pass"');
    expect(a.events.some((e) => e.type === 'session.ready')).toBe(true);
    // start() is idempotent
    expect(a.k.start()).toBe(a.k.start());

    const b = await build({ fakes: a.fakes });
    await pump(b.fakes, b.k.start());
    expect(b.script.cmds.find((c) => c.type === 'selftest.run')).toMatchObject({ cachedPass: true });
    const always = await build({ fakes: a.fakes, spec: { selfTest: 'always' } });
    await pump(always.fakes, always.k.start());
    expect(always.script.cmds.find((c) => c.type === 'selftest.run')).toMatchObject({ cachedPass: false });
  });

  it('intents emitted before the launch resolved are buffered and then executed in order', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    expect(a.svc.launches[0]?.executed.map((i) => i.kind)).toEqual(['poll.cadence']);
  });

  it('a trust gate → E_TRUST_REQUIRED, the pane is aborted (nothing pressed), the kernel is closed', async () => {
    const a = await build({ outcomes: ['trustGate'] });
    await expect(pump(a.fakes, a.k.start())).rejects.toMatchObject({ code: 'E_TRUST_REQUIRED', details: { gate: 'trust' } });
    expect(a.svc.launches[0]?.aborted).toEqual(['startFailed:E_TRUST_REQUIRED']);
    await expect(a.k.dispatch({ type: 'interrupt' })).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
  });

  it('a pre-UI exit whose final screen names "Session ID … is already in use" → E_SESSION_ID_IN_USE (profile strings)', async () => {
    const svc = stubServices({ finalScreen: 'Error: Session ID 00000000-0000-4000-8000-000000000001 is already in use.' });
    const a = await build({ outcomes: ['exitInUse'], services: svc });
    await expect(pump(a.fakes, a.k.start())).rejects.toMatchObject({
      code: 'E_SESSION_ID_IN_USE',
      details: { gate: 'sessionInUse', exitStatus: 1 },
    });
  });

  it('a plain pre-UI exit → E_STARTUP_EXITED with exit status and final screen', async () => {
    const svc = stubServices({ finalScreen: 'Claude Code could not start: boom' });
    const a = await build({ outcomes: ['exitInUse'], services: svc });
    await expect(pump(a.fakes, a.k.start())).rejects.toMatchObject({
      code: 'E_STARTUP_EXITED',
      details: { exitStatus: 1, finalScreen: 'Claude Code could not start: boom' },
    });
  });

  it('a launch error is mapped through errors-map (typed fields only)', async () => {
    const tmuxMissing = Object.assign(new Error('tmux not found'), { name: 'TmuxNotFound', kind: 'TmuxNotFound', searched: ['/usr/bin'] });
    const a = await build({ services: stubServices({ fail: tmuxMissing }) });
    await expect(pump(a.fakes, a.k.start())).rejects.toMatchObject({
      code: 'E_TMUX_NOT_FOUND',
      details: { searched: ['/usr/bin'], op: 'start' },
    });
  });

  it('HTTP self-test ack failure with transcript evidence → ONE unix relaunch, fresh session id, failure + pass cached (K-37)', async () => {
    const a = await build({ outcomes: ['selftestAckHttp', 'ready'] });
    await pump(a.fakes, a.k.start());
    expect(a.svc.launches.map((l) => l.req.transport)).toEqual(['auto', 'unix']);
    expect(a.svc.launches[1]?.req.attempt).toBe(1);
    expect(a.svc.launches[1]?.req.claudeSessionId).not.toBe(a.svc.launches[0]?.req.claudeSessionId);
    expect(a.svc.launches[0]?.aborted).toEqual(['selftestRelaunch']);
    const file = a.fakes.state.files.get(SELFTEST_CACHE_FILE) ?? '';
    expect(file).toContain('"transport": "unix"');
    expect(file).toContain('"result": "fail"');
    // the published stream stays strictly increasing across the relaunch
    const seqs = a.events.map((e) => e.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(a.k.getState().lifecycle).toBe('ready');
  });

  it('no relaunch when the transport was forced (not auto)', async () => {
    const a = await build({ outcomes: ['selftestAckHttp', 'ready'], spec: { hooks: { transport: 'http' } } });
    await expect(pump(a.fakes, a.k.start())).rejects.toMatchObject({ code: 'E_SELFTEST_FAILED', details: { step: 'ack' } });
    expect(a.svc.launches).toHaveLength(1);
  });
});

describe('kernel runtime', () => {
  it('ingestHook → L1 normalizer → queue (seq-stamped, rawRef), raw records in the trace', async () => {
    const traceFs = memFs();
    const a = await build({ spec: { debug: { tracePath: '/t/x.ccd.jsonl', raw: 'full' } }, traceFs });
    await pump(a.fakes, a.k.start());
    const host = a.svc.host();
    const debug: DebugRecord[] = [];
    a.k.subscribeDebug((r) => debug.push(r));
    host?.ingestHook({
      hookSeq: 1 as HookSeq,
      at: a.fakes.clock.now(),
      wallAt: a.fakes.clock.wallNow(),
      transport: 'http',
      event: 'Notification',
      bytes: 10,
      truncated: false,
      payload: {
        hook_event_name: 'Notification',
        session_id: a.config.claudeSessionId,
        notification_type: 'idle_prompt',
        message: 'waiting',
      },
      holdable: false,
    });
    await pump(
      a.fakes,
      a.k.waitFor(() => a.script.seen.includes('notification'), { timeoutMs: 1000 }),
    );
    const raw = debug.find((r) => r.r === 'raw');
    const obsRec = debug.find((r): r is Extract<DebugRecord, { r: 'obs' }> => r.r === 'obs' && r.obs.kind === 'notification');
    expect(raw).toMatchObject({ ch: 'hook' });
    expect(obsRec?.rawRef).toBe(raw?.r === 'raw' ? raw.i : -1);
    expect(obsRec?.obs.meta.seq).toBeGreaterThan(0);
    await pump(a.fakes, a.k.close({ graceMs: 100 }));
    const file = traceFs.files.get('/t/x.ccd.jsonl') ?? '';
    expect(file.split('\n')[0]).toContain('"r":"header"');
    // P-REV-35: the zone used for reset-time parsing is in the header, so replay is machine-independent
    const hdr = JSON.parse(file.split('\n')[0] ?? '{}') as Record<string, unknown>;
    expect(hdr['tz']).toBe(host?.tz);
    expect(typeof hdr['tz']).toBe('string');
    expect(hdr['redaction']).toBe('full');
    expect(file).toContain('"r":"raw"');
    expect(a.k.diagnostics.tracePath).toBe('/t/x.ccd.jsonl');
  });

  it('subscribeDebug is a no-op with raw:none and no trace', async () => {
    const a = await build({ spec: { debug: { raw: 'none' } } });
    const got: DebugRecord[] = [];
    a.k.subscribeDebug((r) => got.push(r))();
    await pump(a.fakes, a.k.start());
    expect(got).toEqual([]);
  });

  it('host-sleep: a wall jump is reported as clock.hostResumed on the next step (scheduler wiring)', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    a.fakes.clock.jumpWall(60_000);
    a.svc
      .host()
      ?.observe({ kind: 'clock.tick', meta: { at: a.fakes.clock.now(), wallAt: a.fakes.clock.wallNow(), source: 'clock' }, p: {} });
    await pump(
      a.fakes,
      a.k.waitFor(() => a.script.seen.includes('clock.hostResumed'), { timeoutMs: 1000 }),
    );
    expect(a.script.seen.filter((k) => k === 'clock.hostResumed')).toHaveLength(1);
  });

  it('host-sleep: the first L1 observation after a wake is preceded by clock.hostResumed (L-4, P-API-21)', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    await pump(
      a.fakes,
      a.k.waitFor(() => true),
    );
    const from = a.script.seen.length;
    a.fakes.clock.jumpWall(10 * 60_000); // mono paused during sleep (LP-27 outcome 1)
    a.svc.host()?.ingestHook({
      hookSeq: 7 as HookSeq,
      at: a.fakes.clock.now(),
      wallAt: a.fakes.clock.wallNow(),
      transport: 'http',
      event: 'Notification',
      bytes: 10,
      truncated: false,
      payload: { hook_event_name: 'Notification', session_id: a.config.claudeSessionId, notification_type: 'idle_prompt', message: 'w' },
      holdable: false,
    });
    await pump(
      a.fakes,
      a.k.waitFor(() => a.script.seen.slice(from).includes('notification'), { timeoutMs: 1000 }),
    );
    const after = a.script.seen.slice(from);
    expect(after.indexOf('clock.hostResumed')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('clock.hostResumed')).toBeLessThan(after.indexOf('notification'));
    expect(after.filter((k) => k === 'clock.hostResumed')).toHaveLength(1);
  });

  it('observations ingested after close are dropped (no growth, no step)', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    const host = a.svc.host();
    await pump(a.fakes, a.k.close({ graceMs: 10 }), 20_000);
    const n = a.script.seen.length;
    host?.ingestRegistry({ pid: 4242, sessionId: a.config.claudeSessionId, version: '2.1.316', status: 'idle' });
    await flushMicrotasks();
    await new Promise<void>((r) => setImmediate(r));
    expect(a.script.seen.length).toBe(n);
  });

  it('host.warn publishes a warning DomainEvent through the core seq', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    const before = a.k.getState().lastEventSeq;
    a.svc.host()?.warn('E_NETWORK_UNAVAILABLE', 'launch: userProxy', { reason: 'userProxy' });
    await flushMicrotasks();
    const w = a.events.find((e) => e.type === 'warning' && e.payload.code === 'E_NETWORK_UNAVAILABLE');
    expect(w?.seq).toBe(before + 1);
    expect(a.k.getState().lastEventSeq).toBe(before + 1);
  });

  it('waitFor: resolves on a later step, rejects E_WAIT_TIMEOUT and on abort', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    await expect(
      pump(
        a.fakes,
        a.k.waitFor(() => false, { timeoutMs: 50 }),
      ),
    ).rejects.toMatchObject({ code: 'E_WAIT_TIMEOUT', details: { timeoutMs: 50 } });
    const ac = new AbortController();
    const p = a.k.waitFor(() => false, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const pre = new AbortController();
    pre.abort(new Error('custom'));
    await expect(a.k.waitFor(() => false, { signal: pre.signal })).rejects.toThrow('custom');
    await expect(
      a.k.waitFor(() => {
        throw new Error('pred bug');
      }),
    ).rejects.toThrow('pred bug');
    const later = a.k.waitFor((s) => s.lifecycle === 'closing');
    void a.k.dispatch({ type: 'session.close', mode: 'graceful', graceMs: 1, reason: 'x' });
    await expect(pump(a.fakes, later)).resolves.toMatchObject({ lifecycle: 'closing' });
  });

  it('close: session.close to the core, then the launched close; idempotent; pending waiters rejected; diagnostics', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    expect(a.k.diagnostics.viewCommand()).toContain('attach -r');
    await expect(a.k.diagnostics.captureScreen()).resolves.toBe('screen');
    const waiting = a.k.waitFor(() => false);
    const c1 = a.k.close({ reason: 'bye' });
    const c2 = a.k.close();
    expect(c1).toBe(c2);
    const info = await pump(a.fakes, c1, 20_000);
    expect(info).toEqual({ exitStatus: 0, signal: null, reason: 'closed' });
    expect(a.script.cmds.find((c) => c.type === 'session.close')).toMatchObject({ mode: 'graceful', reason: 'bye', graceMs: 12_000 });
    expect(a.svc.launches[0]?.closed).toBe(1);
    await expect(waiting).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    await expect(a.k.dispatch({ type: 'interrupt' })).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    await expect(a.k.waitFor(() => false)).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
  });

  it('close() while a failed attempt is being aborted → no relaunch after close; start rejects E_SESSION_CLOSED', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const svc = stubServices({ abortGate: () => gate });
    const a = await build({ outcomes: ['selftestAckHttp', 'ready'], services: svc });
    const started = a.k.start();
    started.catch(() => undefined);
    for (let i = 0; i < 500 && svc.launches[0]?.aborted.length !== 1; i++) await a.fakes.clock.advanceAsync(10);
    expect(svc.launches[0]?.aborted).toEqual(['selftestRelaunch']);
    const info = await pump(a.fakes, a.k.close());
    expect(info.reason).toBe('closed');
    release();
    await expect(pump(a.fakes, started)).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    // nothing was launched after the close; the one launched session was closed
    expect(svc.launches).toHaveLength(1);
    expect(svc.launches[0]?.closed).toBe(1);
  });

  it("close({mode:'kill'}) during a running graceful close escalates it at once (same promise, kill mode)", async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    const t0 = a.fakes.clock.now();
    const graceful = a.k.close();
    await a.fakes.clock.advanceAsync(200);
    const kill = a.k.close({ mode: 'kill' });
    expect(kill).toBe(graceful);
    const info = await pump(a.fakes, kill, 20_000);
    expect(a.fakes.clock.now() - t0).toBeLessThan(2_000); // not the 12 s grace budget
    expect(a.svc.launches[0]?.closeModes).toEqual(['kill']);
    expect(info.exitStatus).toBe(0);
  });

  it("close({mode:'kill'}) while the launch call is in flight kills right after it returns; the self-test never runs", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const svc = stubServices({ launchGate: () => gate });
    const a = await build({ outcomes: ['never'], services: svc });
    const started = a.k.start();
    started.catch(() => undefined);
    await a.fakes.clock.advanceAsync(50);
    const closing = a.k.close({ mode: 'kill', reason: 'aborted' });
    await a.fakes.clock.advanceAsync(50);
    release();
    const t0 = a.fakes.clock.now();
    await pump(a.fakes, closing, 5_000);
    expect(a.fakes.clock.now() - t0).toBeLessThan(3_000);
    expect(svc.launches).toHaveLength(1);
    expect(svc.launches[0]?.closeModes).toEqual(['kill']);
    expect(a.script.cmds.some((c) => c.type === 'selftest.run')).toBe(false);
    await expect(pump(a.fakes, started)).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
  });

  it('close before start is a clean no-op exit; start after close is refused', async () => {
    const a = await build({});
    const info = await pump(a.fakes, a.k.close());
    expect(info.reason).toBe('closed');
    await expect(a.k.start()).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    expect(a.k.diagnostics.viewCommand()).toBe('');
    await expect(a.k.diagnostics.captureScreen()).rejects.toMatchObject({ code: 'E_SESSION_EXITED' });
  });

  it('the permission handler set on the kernel is what the host hands to the broker', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    const h = (): undefined => undefined;
    a.k.setPermissionHandler(h);
    expect(a.svc.host()?.permissionHandler()).toBe(h);
    a.k.setPermissionHandler(null);
    expect(a.svc.host()?.permissionHandler()).toBeNull();
  });

  it('ingestCapture / ingestTail / ingestRegistry feed the recording channels', async () => {
    const a = await build({});
    await pump(a.fakes, a.k.start());
    const host = a.svc.host();
    const status = {
      exists: true,
      dead: false,
      exitStatus: null,
      exitSignal: null,
      inMode: false,
      alternateOn: false,
      cursorX: 0,
      cursorY: 0,
      cols: 120,
      rows: 3,
      historySize: 0,
    };
    host?.ingestCapture({ lines: ['', '', ''], status, at: a.fakes.clock.now(), hash: 'h0' });
    host?.ingestTail({ kind: 'waiting', file: { kind: 'main', sessionId: 'x' }, path: '/p', reason: 'ENOENT' });
    host?.ingestRegistry({ pid: 4242, sessionId: a.config.claudeSessionId, version: '2.1.316', status: 'idle' });
    await pump(
      a.fakes,
      a.k.waitFor(() => a.script.seen.includes('registry'), { timeoutMs: 1000 }),
    );
    expect(a.script.seen).toContain('screen.frame');
    expect(host?.channels.screen.last()).toBeDefined();
    expect(a.script.seen.some((k) => k === 'transcript.file')).toBe(true);
  });
});

describe('observation helpers', () => {
  it('Observation kinds used by the stub are real union members', () => {
    const kinds: Observation['kind'][] = [
      'process.launched',
      'process.exited',
      'clock.tick',
      'clock.hostResumed',
      'notification',
      'screen.frame',
      'registry',
    ];
    expect(kinds).toHaveLength(7);
  });
});
