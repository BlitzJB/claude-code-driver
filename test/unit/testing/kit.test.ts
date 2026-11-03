// testing/arbitraries.ts, testing/fake-ports.ts wiring, and testing/test-kernel.ts mechanics (pump, until, waitForEvent,
// subscribe-from-0, start failure) against a minimal stand-in SessionModules that drives FakeClaude through the real fakes.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Command, CommandResult } from '../../../src/model/commands.js';
import type { ResolvedConfig } from '../../../src/model/config.js';
import type { DomainEvent } from '../../../src/model/events.js';
import type { EventSeq, SessionKey, TurnKey } from '../../../src/model/ids.js';
import type { KernelListener, SessionExitInfo, SessionKernel } from '../../../src/model/kernel.js';
import type { Observation } from '../../../src/model/observation.js';
import type { SessionState } from '../../../src/model/state.js';
import type { Ports, RawHookEvent, TmuxPane } from '../../../src/platform/ports.js';
import type { FakeEditorInjectorFactory } from '../../../src/platform/editor/fake-editor.js';
import {
  createArbitraries,
  delayChannel,
  dropChannel,
  duplicateAt,
  insertTicks,
  isConvergencePair,
  SEC_INPUT_VECTORS,
  swapAdjacent,
} from '../../../src/testing/arbitraries.js';
import { createFakePorts } from '../../../src/testing/fake-ports.js';
import {
  createTestKernel,
  expectStartFailure,
  loadSessionModules,
  SessionNotLanded,
  type SessionModules,
} from '../../../src/testing/test-kernel.js';
import * as testing from '../../../src/testing/index.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const arb = createArbitraries(fc);

describe('arbitraries', () => {
  it('observations are well-formed and sequences are strictly numbered with non-decreasing time', () => {
    fc.assert(
      fc.property(arb.sequence({ minLength: 2, maxLength: 30 }), (obs) => {
        obs.forEach((o, i) => {
          expect(o.meta.seq).toBe(i + 1);
          if (i > 0) expect(o.meta.at).toBeGreaterThanOrEqual(obs[i - 1]?.meta.at ?? 0);
          expect(typeof o.kind).toBe('string');
          expect(o.meta.source).toBeDefined();
        });
      }),
      { numRuns: 50 },
    );
  });

  it('commands and decisions are valid union members', () => {
    fc.assert(
      fc.property(arb.command, arb.permissionDecision, (c, d) => {
        expect(['prompt.send', 'prompt.cancel', 'slash.run', 'interrupt', 'permission.answer', 'mode.set', 'usage.wakeNow']).toContain(
          c.type,
        );
        expect(['allow', 'deny']).toContain(d.behavior);
      }),
      { numRuns: 50 },
    );
  });

  it('SEC vectors include the LP-45 rows (leading slash with/without space; ! ? & # prefixes)', () => {
    for (const v of ['/permissions', ' /permissions', '/cost', ' /cost', '!rm -rf ~', '?x', '&x', '#x', '👩‍💻'])
      expect(SEC_INPUT_VECTORS).toContain(v);
  });

  it('dropout / delay / duplicate / swap helpers renumber seq and keep the rest', () => {
    const [seq] = fc.sample(arb.sequence({ minLength: 6, maxLength: 6 }), { numRuns: 1, seed: 7 });
    const obs = seq ?? [];
    const noScreen = dropChannel(obs, 'screen');
    expect(noScreen.every((o) => o.meta.source !== 'screen')).toBe(true);
    const delayed = delayChannel(obs, 'transcript', 2000);
    expect(delayed.map((o) => o.meta.seq)).toEqual(delayed.map((_, i) => i + 1));
    expect(delayed.every((o, i) => i === 0 || o.meta.at >= (delayed[i - 1]?.meta.at ?? 0))).toBe(true);
    const sw = swapAdjacent(obs, 0);
    expect(sw[0]?.kind).toBe(obs[1]?.kind);
    expect(sw.every((o, i) => i === 0 || o.meta.at >= (sw[i - 1]?.meta.at ?? 0))).toBe(true);
  });
});

describe('property-input helpers on hand-built sequences (§6.2)', () => {
  const o = (kind: string, source: string, at: number, seq: number): Observation =>
    ({ kind, meta: { seq, at, wallAt: 10_000 + at, source }, p: {} }) as unknown as Observation;
  const base = [o('tool.pre', 'hook', 1000, 1), o('prompt.recorded', 'transcript', 1100, 2), o('screen.frame', 'screen', 1200, 3)];

  it('duplicateAt duplicates transcript lines only (hook duplicates are never generated)', () => {
    const dup = duplicateAt(base, 1);
    expect(dup.map((x) => x.kind)).toEqual(['tool.pre', 'prompt.recorded', 'prompt.recorded', 'screen.frame']);
    expect(dup.map((x) => x.meta.seq)).toEqual([1, 2, 3, 4]);
    expect(duplicateAt(base, 0).map((x) => x.kind)).toEqual(['tool.pre', 'prompt.recorded', 'screen.frame']);
    expect(duplicateAt(base, 9)).toHaveLength(3);
  });

  it('delayChannel moves both at and wallAt of the delayed channel and re-sorts', () => {
    const d = delayChannel(base, 'transcript', 2000);
    expect(d.map((x) => x.kind)).toEqual(['tool.pre', 'screen.frame', 'prompt.recorded']);
    const moved = d.find((x) => x.kind === 'prompt.recorded');
    expect([moved?.meta.at, moved?.meta.wallAt]).toEqual([3100, 13_100]);
    expect(d.map((x) => x.meta.seq)).toEqual([1, 2, 3]);
  });

  it('isConvergencePair: different sources within 250 ms, or two hooks within ±5 ms', () => {
    expect(isConvergencePair(base[0]!, base[1]!)).toBe(true);
    expect(isConvergencePair(base[0]!, o('screen.frame', 'screen', 1300, 9))).toBe(false);
    expect(isConvergencePair(base[0]!, o('tool.post', 'hook', 1005, 9))).toBe(true);
    expect(isConvergencePair(base[0]!, o('tool.post', 'hook', 1006, 9))).toBe(false);
    expect(isConvergencePair(base[1]!, o('tool.result', 'transcript', 1100, 9))).toBe(false);
  });

  it('insertTicks adds clock.tick observations at the given times, in order, with consistent wall time', () => {
    const t = insertTicks(base, [1050, 5000, 900]);
    expect(t.map((x) => `${x.kind}@${x.meta.at}`)).toEqual([
      'clock.tick@1000',
      'tool.pre@1000',
      'clock.tick@1050',
      'prompt.recorded@1100',
      'screen.frame@1200',
      'clock.tick@5000',
    ]);
    expect(t.find((x) => x.meta.at === 1050)?.meta.wallAt).toBe(11_050);
    expect(t.map((x) => x.meta.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(t.filter((x) => x.kind === 'clock.tick').every((x) => x.meta.source === 'clock')).toBe(true);
  });
});

describe('fake ports aggregation', () => {
  it('one clock everywhere, the owner registered, every Ports member present', () => {
    const f = createFakePorts({ network: true });
    const keys: (keyof Ports)[] = [
      'clock',
      'ids',
      'process',
      'env',
      'claude',
      'runtimeDir',
      'state',
      'settingsFile',
      'claudeConfig',
      'tmux',
      'tail',
      'hooks',
      'editor',
      'net',
      'registry',
      'ownerWatch',
      'logger',
    ];
    for (const k of keys) expect(f.ports[k], k).toBeDefined();
    expect(f.process.isAlive(f.ownerPid)).toBe(true);
    expect(f.tmux.clock).toBe(f.clock);
    expect(createFakePorts({ network: false }).ports.net).toBeUndefined();
  });

  it('owner-watch reads watch.json from the settings-file port and kills the tmux server when the owner dies', async () => {
    const f = createFakePorts();
    const server = await f.tmux.create({
      tmuxPath: '/opt/homebrew/bin/tmux',
      socketName: 'ccd-k22',
      clientEnv: {},
      historyLimit: 100,
      paneDiedLogPath: '/fake/run/died.log',
    });
    const pane = await server.spawnPane({
      sessionName: 'ccd-x',
      argv: ['/bin/sh', '-c', 'true'],
      cwd: f.cwd,
      cols: 120,
      rows: 40,
      nonSecretEnv: {},
    });
    const claudePid = f.process.addProcess({ command: '/x/claude.exe --session-id abc', pid: pane.info.pid });
    const owner = (await f.process.identity(f.ownerPid)) ?? { startTime: '', command: '' };
    const claude = (await f.process.identity(claudePid)) ?? { startTime: '', command: '' };
    await f.settingsFile.writeExclusive('/fake/run/ccd-000001/watch.json', {
      ownerPid: f.ownerPid,
      ownerStart: owner.startTime,
      claudePid,
      claudeStart: claude.startTime,
      claudeExeSubstr: 'claude.exe',
      sessionIdSubstr: 'abc',
      tmuxBin: '/opt/homebrew/bin/tmux',
      socketName: 'ccd-k22',
      pollMs: 1000,
      exitsLog: '/fake/state/exits.log',
    });
    const w = await f.ownerWatch.start({ configPath: '/fake/run/ccd-000001/watch.json', logPath: '/fake/run/w.log' });
    expect(w.pid).toBeGreaterThan(0);
    f.process.exit(f.ownerPid);
    expect(f.ownerWatch.reports.at(-1)).toMatchObject({ kind: 'owner-gone', claude: 'terminated', serverKilled: true });
    expect(f.process.isAlive(claudePid)).toBe(false);
    expect((await pane.status().catch(() => ({ dead: true }))).dead).toBe(true);
    expect(f.exitLogs.get('/fake/state/exits.log')?.[0]).toMatch(/^watch=owner-gone/);
  });

  it('readWritten finds JSON written through the state store too', async () => {
    const f = createFakePorts();
    await f.state.writeJsonAtomic('sessions/s1.json', { a: 1 });
    expect(f.readWritten(`${f.state.root}/sessions/s1.json`)).toEqual({ a: 1 });
    expect(f.readWritten('/nope')).toBeUndefined();
  });

  it('the index re-exports the kit and every fake', () => {
    for (const name of [
      'createFakePorts',
      'FakeClaude',
      'createTestKernel',
      'coreScenario',
      'replayTrace',
      'createArbitraries',
      'FakeTmux',
      'FakeClock',
      'FakeHookTransport',
      'FakeTailFs',
      'FakeProcess',
      'FakeOwnerWatchFactory',
      'FakeNetProxyFactory',
      'FakeEditorInjectorFactory',
      'FakeClaudeConfig',
      'FakeSettingsFile',
      'FakeStateStore',
      'FakeRuntimeDir',
      'FakeClaudeRegistry',
      'FakeIds',
      'FakeEnv',
      'FakeClaudeBinary',
    ])
      expect((testing as Record<string, unknown>)[name], name).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// A minimal stand-in for session/config.ts + session/kernel.ts: just enough L3 to drive the world (spawn, SessionStart → ready,
// prompt.send → editor stage + C-g + Enter, Stop → turn.ended). It exists only to test the harness mechanics.

function stubModules(o: { failStart?: string } = {}): SessionModules {
  return {
    resolveConfig: (spec) => ({ cwd: spec.cwd, sessionKey: 's00000001' as SessionKey }) as unknown as ResolvedConfig,
    createSessionKernel: (ports: Ports, config: ResolvedConfig): SessionKernel => {
      const listeners = new Set<KernelListener>();
      const log: DomainEvent[] = [];
      let lifecycle: SessionState['lifecycle'] = 'launching';
      let pane: TmuxPane | undefined;
      let turns = 0;
      const state = (): SessionState => ({ v: 1, sessionKey: config.sessionKey, lifecycle }) as unknown as SessionState;
      const publish = (type: 'session.ready' | 'turn.ended', turnKey?: TurnKey): void => {
        const e = {
          v: 1,
          seq: (log.length + 1) as EventSeq,
          type,
          at: ports.clock.now(),
          wallAt: ports.clock.wallNow(),
          sessionKey: config.sessionKey,
          ...(turnKey === undefined ? {} : { turnKey }),
          provenance: { confirmed: true, sources: ['hook'] },
          causedBy: [],
          payload:
            type === 'session.ready'
              ? { permissionMode: 'default', selfTest: 'skipped', resumed: false, hookTransport: 'http' }
              : { outcome: 'completed', endedBy: 'stop' },
        } as DomainEvent;
        log.push(e);
        for (const l of listeners) l({ events: [e], state: state() });
      };
      let current: TurnKey | undefined;
      const k: SessionKernel & { start(): Promise<void> } = {
        sessionKey: config.sessionKey,
        getState: state,
        async start() {
          if (o.failStart !== undefined) throw Object.assign(new Error(o.failStart), { code: o.failStart });
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
          await hooks.start({ sessionShortId: 's1', transport: 'http' });
          const ready = new Promise<void>((resolve) => {
            hooks.on((e: RawHookEvent) => {
              if (e.event === 'SessionStart') {
                lifecycle = 'ready';
                publish('session.ready');
                resolve();
              }
              if (e.event === 'Stop' && current !== undefined) publish('turn.ended', current);
            });
          });
          const editor = (ports.editor as FakeEditorInjectorFactory).create({ clock: ports.clock, ids: ports.ids });
          const { visualPath } = await editor.setup(dir, '/fake/bin/node');
          const tmux = await ports.tmux.create({
            tmuxPath: '/opt/homebrew/bin/tmux',
            socketName: 'ccd-stub',
            clientEnv: { VISUAL: visualPath },
            historyLimit: 100,
            paneDiedLogPath: `${dir}/died.log`,
          });
          pane = await tmux.spawnPane({
            sessionName: 'ccd-s',
            argv: ['/x/bin/claude.exe', '--session-id', '11111111-2222-4333-8444-555555555555'],
            cwd: config.cwd,
            cols: 250,
            rows: 80,
            nonSecretEnv: {},
          });
          await ready;
        },
        async dispatch<C extends Command>(cmd: C): Promise<CommandResult<C>> {
          if (cmd.type !== 'prompt.send' || pane === undefined) return { ok: true } as CommandResult<C>;
          current = `t${++turns}` as TurnKey;
          const inj = (ports.editor as FakeEditorInjectorFactory).last;
          await inj?.stage(cmd.text);
          await pane.sendKey('C-g');
          await ports.clock.sleep(100);
          await pane.sendKey('Enter');
          return { turnKey: current } as CommandResult<C>;
        },
        subscribe(l, opts) {
          listeners.add(l);
          const from = opts?.fromSeq ?? (log.length as EventSeq);
          const back = log.filter((e) => e.seq >= from);
          if (back.length > 0) l({ events: back, state: state() });
          return () => listeners.delete(l);
        },
        subscribeDebug: () => () => undefined,
        queryUsage: () => Promise.resolve({ meters: [], readAt: 0 }),
        suspend: () => Promise.resolve(),
        resume: () => Promise.resolve(),
        setPermissionHandler: () => undefined,
        waitFor: (pred) => (pred(state()) ? Promise.resolve(state()) : Promise.reject(new Error('E_WAIT_TIMEOUT'))),
        diagnostics: { viewCommand: () => 'tmux -L ccd-stub attach -r -t =ccd-s:', captureScreen: () => Promise.resolve('') },
        close: (): Promise<SessionExitInfo> => Promise.resolve({ exitStatus: 0, signal: null, reason: 'closed' }),
      };
      return k;
    },
  };
}

describe('test kernel harness', () => {
  it('loadSessionModules reports SessionNotLanded while session/** is missing', async () => {
    if (existsSync(join(ROOT, 'src', 'session', 'kernel.ts')) && existsSync(join(ROOT, 'src', 'session', 'config.ts'))) {
      const m = await loadSessionModules();
      expect(typeof m.createSessionKernel).toBe('function');
      return;
    }
    await expect(loadSessionModules()).rejects.toBeInstanceOf(SessionNotLanded);
  });

  it('pumps fake time through start, subscribes from seq 0, and waits for events', async () => {
    const tk = await createTestKernel({ modules: stubModules() });
    expect(tk.state().lifecycle).toBe('ready');
    expect(tk.eventsOf('session.ready')).toHaveLength(1);
    const r: { turnKey: TurnKey } = await tk.dispatch<Extract<Command, { type: 'prompt.send' }>>({
      type: 'prompt.send',
      text: 'Reply with OK',
      whenBusy: 'wait',
    });
    const e = await tk.waitForEvent('turn.ended', { pred: (x) => x.turnKey === r.turnKey });
    expect(e.payload.outcome).toBe('completed');
    expect(tk.claude().prompts.map((p) => p.text)).toEqual(['Reply with OK']);
    expect(tk.fakes.clock.now()).toBeGreaterThan(1000);
    expect(await tk.close()).toEqual({ exitStatus: 0, signal: null, reason: 'closed' });
  });

  it('expectStartFailure returns the start rejection; until() times out in fake time', async () => {
    const { error } = await expectStartFailure({ modules: stubModules({ failStart: 'E_TRUST_REQUIRED' }) });
    expect((error as { code?: string }).code).toBe('E_TRUST_REQUIRED');
    const tk = await createTestKernel({ modules: stubModules() });
    const t0 = tk.fakes.clock.now();
    await expect(tk.until(() => false, 200, 'never')).rejects.toThrow(/never not reached within 200 ms/);
    expect(tk.fakes.clock.now() - t0).toBeGreaterThanOrEqual(200);
    await expect(tk.pump(new Promise<never>(() => undefined), 100)).rejects.toThrow(/still pending/);
    expect(tk.fakes.clock.now() > t0).toBe(true);
  });
});
