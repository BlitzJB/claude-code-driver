// testing/replay.ts raw level (DESIGN.md §6.6 "with raw records … drives L1+L2+L3 against fakes at recorded `at` on a FakeClock
// with `tz` from the header"; P-REV-35). The L3 here is a stand-in that only records what reaches it through the fake ports, so
// the replay plumbing is tested on its own: ordering, hold-back until a port exists, the header's tz and hook transport, the
// two start-failure paths, the redaction guard and the undelivered report.
import { describe, expect, it } from 'vitest';
import type { DebugRecord } from '../../../src/model/debug.js';
import type { ResolvedConfig } from '../../../src/model/config.js';
import type { SessionKey } from '../../../src/model/ids.js';
import type { SessionExitInfo, SessionKernel } from '../../../src/model/kernel.js';
import type { SessionSpec } from '../../../src/model/spec.js';
import type { SessionState } from '../../../src/model/state.js';
import type { Ports, RawHookEvent, TailEvent } from '../../../src/platform/ports.js';
import { testCoreInit } from '../../../src/testing/core-config.js';
import { replayRaw, replayTrace, TraceFormatError, type Trace, type TraceHeader } from '../../../src/testing/replay.js';
import type { SessionModules } from '../../../src/testing/test-kernel.js';

interface Observed {
  lifecycle: SessionState['lifecycle'];
  observed: string[];
  tz: string;
  transport: string | undefined;
  selfTest: string | undefined;
}

/** A recording stand-in for session/config.ts + session/kernel.ts (ports appear only after 400 ms of fake time). */
function recordingModules(o: { failConfig?: boolean; failStartAfterHooks?: boolean } = {}): SessionModules {
  return {
    resolveConfig: (spec: SessionSpec) => {
      if (o.failConfig === true) throw Object.assign(new Error('E_CONFIG_INVALID'), { code: 'E_CONFIG_INVALID' });
      return { spec, sessionKey: 's00000001' as SessionKey } as unknown as ResolvedConfig;
    },
    createSessionKernel: (ports: Ports, config: ResolvedConfig): SessionKernel => {
      const spec = (config as unknown as { spec: SessionSpec }).spec;
      const st: Observed = {
        lifecycle: 'launching',
        observed: [],
        tz: ports.env.timeZone(),
        transport: spec.hooks?.transport,
        selfTest: spec.selfTest,
      };
      let closed = false;
      const k: SessionKernel & { start(): Promise<void> } = {
        sessionKey: 's00000001' as SessionKey,
        getState: () => st as unknown as SessionState,
        async start() {
          await ports.clock.sleep(400); // records due before this must be held, not lost
          const dir = await ports.runtimeDir.createSessionDir();
          const hooks = ports.hooks.create({
            runtimeDir: dir,
            clock: ports.clock,
            ids: ports.ids,
            maxBodyBytes: 1 << 20,
            maxHeld: 4,
            maxConnections: 8,
            logger: ports.logger,
          });
          const transport = spec.hooks?.transport === 'http' ? 'http' : 'unix';
          await hooks.start({ sessionShortId: 's1', transport });
          let ready: () => void = () => undefined;
          const isReady = new Promise<void>((r) => {
            ready = r;
          });
          hooks.on((e: RawHookEvent) => {
            st.observed.push(`hook:${e.event}`);
            if (e.event === 'SessionStart') ready();
          });
          if (o.failStartAfterHooks === true) {
            const err = { code: 'E_TRUST_REQUIRED', message: 'trust dialog' };
            throw Object.assign(new Error(err.message), err);
          }
          const tail = ports.tail.create({
            configDir: '/HOME/.claude',
            clock: ports.clock,
            pollIdleMs: 250,
            pollFastMs: 50,
            fastBurstMs: 1000,
            drainGraceMs: 5000,
            missingAgentTimeoutMs: 10_000,
            maxLineBytes: 1 << 20,
            readChunkBytes: 1 << 16,
            maxActiveFollowers: 8,
            skipParseTypes: new Set(),
          });
          tail.on((e: TailEvent) => st.observed.push(`tail:${e.kind}`));
          const tmux = await ports.tmux.create({
            tmuxPath: '/opt/homebrew/bin/tmux',
            socketName: 'ccd-replay',
            clientEnv: {},
            historyLimit: 100,
            paneDiedLogPath: `${dir}/died.log`,
          });
          const pane = await tmux.spawnPane({
            sessionName: 'ccd-r',
            argv: ['/x/bin/claude.exe', '--permission-mode'],
            cwd: spec.cwd,
            cols: 250,
            rows: 80,
            nonSecretEnv: {},
          });
          void (async () => {
            let last = '';
            while (!closed) {
              const c = await pane.capture();
              const top = c.lines.find((l) => l.startsWith('frame-'));
              if (top !== undefined && top !== last) {
                last = top;
                st.observed.push(`screen:${top}`);
              }
              await ports.clock.sleep(50);
            }
          })();
          await isReady;
          st.lifecycle = 'ready';
        },
        dispatch: () => Promise.reject(new Error('not used')),
        subscribe: () => () => undefined,
        subscribeDebug: () => () => undefined,
        queryUsage: () => Promise.resolve({ meters: [], readAt: 0 }),
        setPermissionHandler: () => undefined,
        waitFor: () => Promise.reject(new Error('not used')),
        diagnostics: { viewCommand: () => '', captureScreen: () => Promise.resolve('') },
        close: (): Promise<SessionExitInfo> => {
          closed = true;
          return Promise.resolve({ exitStatus: 0, signal: null, reason: 'closed' });
        },
      };
      return k;
    },
  };
}

function header(over: Partial<TraceHeader> = {}): TraceHeader {
  return {
    r: 'header',
    format: 'ccd-trace',
    v: 1,
    lib: '0.0.0',
    claude: '2.1.316',
    tmux: '3.5a',
    node: 'v22.23.2',
    platform: 'darwin',
    startedWall: 1_793_659_685_809,
    tz: 'Asia/Kolkata',
    coreInit: testCoreInit(),
    profile: '2.1.316',
    redaction: 'full',
    hookTransport: 'unix',
    ...over,
  };
}

const W = 1_793_659_685_809;
function raw(i: number, at: number, ch: Extract<DebugRecord, { r: 'raw' }>['ch'], data: unknown): DebugRecord {
  return { r: 'raw', i, ch, at, wallAt: W + at, data };
}
const hook = (event: string): unknown => ({ event, transport: 'unix', payload: { hook_event_name: event, session_id: 'x' } });
const screen = (top: string): unknown => ({ capture: { lines: [top, '❯ '] } });

function trace(records: DebugRecord[], over: Partial<TraceHeader> = {}): Trace {
  return { header: header(over), records };
}

describe('replayRaw', () => {
  it('delivers every record in order, holding early ones until their port exists; header tz, hook transport, selfTest off', async () => {
    const t = trace([
      raw(1, 1000, 'hook', hook('SessionStart')), // due before any port exists (the stand-in needs 400 ms)
      raw(2, 1050, 'transcript', { kind: 'line', line: {} }),
      raw(3, 1100, 'screen', screen('frame-1')),
      raw(4, 3000, 'hook', hook('Stop')),
      raw(5, 3200, 'screen', screen('frame-2')),
    ]);
    const r = await replayRaw(t, { kernel: { modules: recordingModules() }, drainMs: 500 });
    const st = r.state as unknown as Observed;
    expect(st.observed).toEqual(['hook:SessionStart', 'tail:line', 'screen:frame-1', 'hook:Stop', 'screen:frame-2']);
    expect(st.lifecycle).toBe('ready');
    expect(st.tz).toBe('Asia/Kolkata'); // P-REV-35: never the machine's zone
    expect(st.transport).toBe('unix');
    expect(st.selfTest).toBe('off');
    expect(r.startError).toBeUndefined();
    expect(r.diagnostics).toEqual([]);
  });

  it('uses the header transport over a caller-supplied one', async () => {
    const t = trace([raw(1, 1000, 'hook', { ...(hook('SessionStart') as object), transport: 'unix' })], { hookTransport: 'unix' });
    const r = await replayRaw(t, { kernel: { modules: recordingModules(), spec: { hooks: { transport: 'http' } } }, drainMs: 100 });
    expect((r.state as unknown as Observed).transport).toBe('unix');
  });

  it('reports records whose port never appears as replay.undelivered (nothing dropped silently)', async () => {
    const t = trace([
      raw(1, 1000, 'hook', hook('SessionStart')),
      raw(2, 1100, 'network', { kind: 'open', tunnelId: 1, at: 1100, wallAt: W }),
      raw(3, 1200, 'hook', hook('Stop')),
    ]);
    const r = await replayRaw(t, { kernel: { modules: recordingModules() }, drainMs: 1000 });
    expect(r.diagnostics).toEqual([{ r: 'diag', at: 1100, code: 'replay.undelivered', detail: { i: 2, ch: 'network' } }]);
    // the stuck network record does not hold back the other channels (per-channel FIFO, no head-of-line blocking)
    expect((r.state as unknown as Observed).observed).toEqual(['hook:SessionStart', 'hook:Stop']);
  });

  it('rejects at once when the kernel cannot be created, instead of pumping fake time over the whole trace', async () => {
    const t = trace([raw(1, 1000, 'hook', hook('SessionStart')), raw(2, 1000 + 3_600_000, 'hook', hook('Stop'))]);
    const t0 = Date.now();
    await expect(replayRaw(t, { kernel: { modules: recordingModules({ failConfig: true }) } })).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
    });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a kernel that was created but failed to start is a replay outcome: startError is returned with the state so far', async () => {
    const t = trace([raw(1, 1000, 'hook', hook('SessionStart')), raw(2, 900_000, 'screen', screen('frame-x'))]);
    const t0 = Date.now();
    const r = await replayRaw(t, { kernel: { modules: recordingModules({ failStartAfterHooks: true }) }, drainMs: 100 });
    expect(r.startError).toMatchObject({ code: 'E_TRUST_REQUIRED' });
    expect((r.state as unknown as Observed).lifecycle).toBe('launching');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("refuses a redaction:'meta' trace (no payload text to inject); replayTrace needs a core for obs level", async () => {
    await expect(replayRaw(trace([raw(1, 1000, 'hook', hook('SessionStart'))], { redaction: 'meta' }))).rejects.toBeInstanceOf(
      TraceFormatError,
    );
    await expect(replayTrace(trace([]), { level: 'obs' })).rejects.toThrow(/needs the core API/);
  });
});
