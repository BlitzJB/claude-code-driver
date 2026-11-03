// WP-13 session/pollers.ts (DESIGN.md §4.11, §4.12 A-3/A-4/A-5; P-TMUX-37, P-SCREEN-21/23, P-LIFE-16, P-REV-35,
// ICR 0001 item 3b/3d (LP-01: no capture while the external editor is open)).
import { describe, expect, it } from 'vitest';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';
import type { IntentId } from '../../../src/model/ids.js';
import type { ObservationInput } from '../../../src/model/observation.js';
import { FakeClock, flushMicrotasks } from '../../../src/platform/clock/fake-clock.js';
import { FakeClaudeBinary } from '../../../src/platform/process/fake-claude-binary.js';
import { TmuxServerGone } from '../../../src/platform/tmux/errors.js';
import { FakeTmux, type FakeTmuxPane } from '../../../src/platform/tmux/fake-tmux.js';
import type { EditorGate } from '../../../src/session/input-executor.js';
import { CAPTURE_FAILURES_DEGRADED, createPollers, type Pollers } from '../../../src/session/pollers.js';
import { mainFrame, spinner } from '../../../src/testing/screens.js';

const BANNER = { version: '2.1.316', model: 'Opus 4.5', cwd: '/work' } as Parameters<typeof mainFrame>[0]['banner'];
const IDLE = mainFrame({ banner: BANNER, composer: '' });
const BUSY = mainFrame({ banner: BANNER, composer: '', status: spinner({ elapsedS: 3, tokens: 10 }), busy: true });

let n = 0;
const id = (): IntentId => ++n as IntentId;

class Gate implements EditorGate {
  phase = false;
  awaiting = false;
  private waiters: (() => void)[] = [];
  editorPhase(): boolean {
    return this.phase;
  }
  awaitingEditor(): boolean {
    return this.awaiting;
  }
  whenEditorIdle(): Promise<void> {
    return this.awaiting ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }
  finish(): void {
    this.awaiting = false;
    for (const w of this.waiters.splice(0)) w();
  }
}

interface World {
  clock: FakeClock;
  tmux: FakeTmux;
  pane: FakeTmuxPane;
  out: ObservationInput[];
  pollers: Pollers;
  gate: Gate;
  claude: FakeClaudeBinary;
}

async function world(o: { auth?: boolean } = {}): Promise<World> {
  const clock = new FakeClock();
  const tmux = new FakeTmux({ clock });
  const server = await tmux.create({
    tmuxPath: '/opt/homebrew/bin/tmux',
    socketName: 'ccd-ut-poll',
    clientEnv: {},
    historyLimit: 2000,
    paneDiedLogPath: '/tmp/ccd-ut-poll-exits.log',
  });
  const pane = (await server.spawnPane({
    sessionName: 'ccd-ut',
    argv: ['/usr/bin/env', '/fake/claude.exe'],
    cwd: '/work',
    cols: 250,
    rows: 80,
    nonSecretEnv: {},
  })) as FakeTmuxPane;
  pane.setScreen(IDLE);
  const out: ObservationInput[] = [];
  const gate = new Gate();
  const claude = new FakeClaudeBinary({ auth: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' } });
  const pollers = createPollers({
    clock,
    pane: () => pane,
    emit: (x) => out.push(x),
    profile,
    tz: 'UTC',
    editorGate: gate,
    ...(o.auth !== false ? { auth: { port: claude, exe: '/fake/claude.exe', env: { HOME: '/h' } } } : {}),
  });
  return { clock, tmux, pane, out, pollers, gate, claude };
}

const frames = (w: World) => w.out.filter((x): x is Extract<ObservationInput, { kind: 'screen.frame' }> => x.kind === 'screen.frame');
const captures = (w: World) => w.tmux.invocations.filter((x) => x.op === 'capture').length;

describe('pollers: A-4 screen poll (§4.11)', () => {
  it('captures at the poll.cadence interval and emits screen.frame only for changed frames', async () => {
    const w = await world();
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 250 });
    expect(w.pollers.screenIntervalMs()).toBe(250);
    await w.clock.advanceAsync(10);
    expect(captures(w)).toBe(1);
    expect(frames(w)).toHaveLength(1);
    expect(frames(w)[0]!.p.surface).toBe('main');
    expect(frames(w)[0]!.meta).toMatchObject({ source: 'screen', origin: { kind: 'screen', frameHash: frames(w)[0]!.p.frameHash } });
    await w.clock.advanceAsync(1000);
    expect(captures(w)).toBe(5);
    expect(frames(w)).toHaveLength(1); // unchanged → dropped (D-41)
    w.pane.setScreen(BUSY);
    await w.clock.advanceAsync(250);
    expect(frames(w)).toHaveLength(2);
  });

  it('A→B→A reaches the core as three frames (no windowed dedup, D-42 / K-43)', async () => {
    const w = await world();
    w.pane.queueFrames([IDLE, BUSY, IDLE]);
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 150 });
    await w.clock.advanceAsync(500);
    expect(frames(w).map((f) => f.p.status?.kind ?? 'none').length).toBe(3);
  });

  it('a slower cadence spaces captures; null stops polling', async () => {
    const w = await world();
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 2000 });
    await w.clock.advanceAsync(4100);
    expect(captures(w)).toBe(3);
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: null });
    expect(w.pollers.screenIntervalMs()).toBeNull();
    await w.clock.advanceAsync(10_000);
    expect(captures(w)).toBe(3);
  });

  it('switching to a faster cadence captures sooner (measured from the last capture)', async () => {
    const w = await world();
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 5000 });
    await w.clock.advanceAsync(10);
    expect(captures(w)).toBe(1);
    await w.clock.advanceAsync(100);
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 150 });
    await w.clock.advanceAsync(60);
    expect(captures(w)).toBe(2);
  });

  it('screen.captureNow captures immediately and resolves after the frame was emitted', async () => {
    const w = await world();
    await w.pollers.execute({ kind: 'screen.captureNow', id: id(), reason: 'PermissionRequest' });
    expect(captures(w)).toBe(1);
    expect(frames(w)).toHaveLength(1);
  });

  it('concurrent captureNow requests coalesce into one follow-up capture (captures never overlap)', async () => {
    const w = await world();
    const a = w.pollers.captureNow('a');
    const b = w.pollers.captureNow('b');
    const c = w.pollers.captureNow('c');
    await Promise.all([a, b, c]);
    expect(captures(w)).toBe(2);
  });

  it('copy-mode frames are still delivered (the core ignores them, P-SCREEN-21) with inCopyMode set', async () => {
    const w = await world();
    w.pane.enterCopyMode();
    await w.pollers.captureNow('x');
    expect(frames(w)[0]!.p.inCopyMode).toBe(true);
  });
});

describe('pollers: editor handoff (LP-01, ICR 0001 item 3)', () => {
  it('no capture at all while awaitEditorConsumed is pending; captureNow waits for the editor to finish', async () => {
    const w = await world();
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 150 });
    await w.clock.advanceAsync(10);
    const before = captures(w);
    w.gate.awaiting = true;
    w.gate.phase = true;
    w.pane.setAlternate(true);
    w.pane.setScreen([]);
    let done = false;
    void w.pollers.captureNow('verifyStaged').then(() => {
      done = true;
    });
    await w.clock.advanceAsync(1000);
    expect(captures(w)).toBe(before);
    expect(done).toBe(false);
    w.pane.setAlternate(false);
    w.pane.setScreen(mainFrame({ banner: BANNER, composer: 'fix the bug' }));
    w.gate.phase = false;
    w.gate.finish();
    await w.clock.advanceAsync(0);
    await flushMicrotasks();
    expect(done).toBe(true);
    expect(captures(w)).toBeGreaterThan(before);
    expect(frames(w).at(-1)!.p.surface).toBe('main');
    expect(frames(w).some((f) => f.p.surface === 'unsupportedRenderer')).toBe(false);
  });

  it('a capture during the editor phase (alternate screen) is tagged → editorOpen, not unsupportedRenderer', async () => {
    const w = await world();
    await w.pollers.captureNow('first');
    w.gate.phase = true;
    w.pane.setAlternate(true);
    w.pane.setScreen(['~', '~', '"staged.txt" 1L']);
    await w.pollers.captureNow('editor');
    expect(frames(w).at(-1)!.p.surface).toBe('editorOpen');
  });
});

describe('pollers: capture failures', () => {
  it(`${CAPTURE_FAILURES_DEGRADED} consecutive failures → channel.health screen degraded; next success → up`, async () => {
    const w = await world();
    for (let i = 0; i < CAPTURE_FAILURES_DEGRADED; i++) w.tmux.failNext('capture', new TmuxServerGone('gone'));
    for (let i = 0; i < CAPTURE_FAILURES_DEGRADED; i++) await w.pollers.captureNow('x');
    const h = w.out.filter((x) => x.kind === 'channel.health');
    expect(h.map((x) => x.p)).toEqual([{ channel: 'screen', health: 'degraded', reason: 'captureFailed' }]);
    await w.pollers.captureNow('x');
    expect(w.out.filter((x) => x.kind === 'channel.health').map((x) => x.p)).toEqual([
      { channel: 'screen', health: 'degraded', reason: 'captureFailed' },
      { channel: 'screen', health: 'up', reason: 'captureFailed' },
    ]);
  });
});

describe('pollers: no busy loop when a tick produces no capture (§4.12 A-4 period)', () => {
  it('a permanently failing capture is retried at the cadence, never re-armed at `now`', async () => {
    const w = await world();
    for (let i = 0; i < 200; i++) w.tmux.failNext('capture', new TmuxServerGone('gone'));
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 250 });
    const fired = await w.clock.advanceAsync(1000);
    expect(captures(w)).toBe(5); // t = 0, 250, 500, 750, 1000
    expect(fired).toBeLessThanOrEqual(6);
    expect(w.out.filter((x) => x.kind === 'channel.health').map((x) => x.p.health)).toEqual(['degraded']);
  });

  it('no pane yet: ticks keep the cadence and capture nothing', async () => {
    const out: ObservationInput[] = [];
    const clock = new FakeClock();
    const p = createPollers({ clock, pane: () => undefined, emit: (x) => out.push(x), profile, tz: 'UTC' });
    await p.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 150 });
    const fired = await clock.advanceAsync(1500);
    expect(fired).toBeLessThanOrEqual(11);
    expect(out).toEqual([]);
    p.close();
  });

  it('ticks skipped while the editor is open keep the cadence (no re-arm at `now`)', async () => {
    const w = await world();
    w.gate.awaiting = true;
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 150 });
    const fired = await w.clock.advanceAsync(3000);
    expect(captures(w)).toBe(0);
    expect(fired).toBeLessThanOrEqual(21);
    w.gate.finish();
    await w.clock.advanceAsync(150);
    expect(captures(w)).toBe(1);
  });

  it('close() releases a captureNow that is waiting for the editor; nothing is captured', async () => {
    const w = await world();
    w.gate.awaiting = true;
    let done = false;
    void w.pollers.captureNow('verifyStaged').then(() => {
      done = true;
    });
    await flushMicrotasks();
    w.pollers.close();
    await flushMicrotasks();
    expect(done).toBe(true);
    expect(captures(w)).toBe(0);
    expect(w.out).toEqual([]);
  });
});

describe('pollers: A-3 pane_dead (P-TMUX-37)', () => {
  it('the died event emits one process.exited with status and signal', async () => {
    const w = await world();
    w.pollers.watchPane();
    w.pane.exitPane({ status: null, signal: 'SIGTERM' });
    await w.clock.advanceAsync(2100); // the poll notices; reach() fires 'died'
    const ex = w.out.filter((x) => x.kind === 'process.exited');
    expect(ex).toHaveLength(1);
    expect(ex[0]!.p).toEqual({ exitStatus: null, signal: 'SIGTERM' });
    expect(ex[0]!.meta.source).toBe('process');
    await w.clock.advanceAsync(10_000);
    expect(w.out.filter((x) => x.kind === 'process.exited')).toHaveLength(1);
  });

  it('polls #{pane_dead} every 2 s', async () => {
    const w = await world();
    w.pollers.watchPane();
    await w.clock.advanceAsync(6100);
    expect(w.tmux.invocations.filter((x) => x.op === 'status').length).toBe(3);
    w.pane.exitPane({ status: 3 });
    await w.clock.advanceAsync(2000);
    expect(w.out.filter((x) => x.kind === 'process.exited').map((x) => x.p)).toEqual([{ exitStatus: 3, signal: null }]);
  });

  it('a vanished pane is an exit with unknown status', async () => {
    const w = await world();
    w.pollers.watchPane();
    w.pane.vanishPane();
    await w.clock.advanceAsync(2100);
    expect(w.out.filter((x) => x.kind === 'process.exited').map((x) => x.p)).toEqual([{ exitStatus: null, signal: null }]);
  });

  it('watchPane is idempotent', async () => {
    const w = await world();
    w.pollers.watchPane();
    w.pollers.watchPane();
    await w.clock.advanceAsync(2100);
    expect(w.tmux.invocations.filter((x) => x.op === 'status').length).toBe(1);
  });
});

describe('pollers: A-5 auth poll (P-LIFE-16)', () => {
  it('runs auth status every intervalMs while armed and reports auth.status; null stops it', async () => {
    const w = await world();
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: 60_000 });
    await w.clock.advanceAsync(59_000);
    expect(w.claude.calls.filter((c) => c.op === 'authStatus')).toHaveLength(0);
    await w.clock.advanceAsync(1_000);
    expect(w.claude.calls.filter((c) => c.op === 'authStatus')).toHaveLength(1);
    expect(w.claude.calls[0]).toMatchObject({ arg: '/fake/claude.exe', env: { HOME: '/h' } });
    const a = w.out.filter((x) => x.kind === 'auth.status');
    expect(a.map((x) => x.p)).toEqual([{ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }]);
    expect(a[0]!.meta.source).toBe('process');
    w.claude.auth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };
    await w.clock.advanceAsync(60_000);
    expect(w.out.filter((x) => x.kind === 'auth.status').at(-1)!.p).toMatchObject({ loggedIn: true });
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: null });
    await w.clock.advanceAsync(300_000);
    expect(w.claude.calls.filter((c) => c.op === 'authStatus')).toHaveLength(2);
  });

  it('an auth status failure emits nothing and keeps polling', async () => {
    const w = await world();
    w.claude.auth = 'timeout';
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: 60_000 });
    await w.clock.advanceAsync(120_000);
    expect(w.claude.calls.filter((c) => c.op === 'authStatus')).toHaveLength(2);
    expect(w.out.filter((x) => x.kind === 'auth.status')).toEqual([]);
  });

  it('a cadence change that arrives during a run takes effect after it (runs never overlap)', async () => {
    const w = await world();
    let release: () => void = () => undefined;
    const real = w.claude.authStatus.bind(w.claude);
    let slow = true;
    w.claude.authStatus = async (exe, env) => {
      if (slow) {
        slow = false;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return real(exe, env);
    };
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: 60_000 });
    await w.clock.advanceAsync(60_000); // run 1 starts and blocks
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: 30_000 });
    await w.clock.advanceAsync(90_000);
    expect(w.claude.calls.filter((c) => c.op === 'authStatus')).toHaveLength(0); // still blocked: no overlap
    release();
    await flushMicrotasks();
    expect(w.out.filter((x) => x.kind === 'auth.status')).toHaveLength(1); // the result of run 1 is still reported
    expect(w.pollers.authIntervalMs()).toBe(30_000);
    await w.clock.advanceAsync(30_000);
    expect(w.claude.calls.filter((c) => c.op === 'authStatus')).toHaveLength(2); // re-armed with the new cadence
  });

  it('a stop (null) during a run drops its result and arms nothing', async () => {
    const w = await world();
    let release: () => void = () => undefined;
    const real = w.claude.authStatus.bind(w.claude);
    w.claude.authStatus = async (exe, env) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return real(exe, env);
    };
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: 60_000 });
    await w.clock.advanceAsync(60_000);
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: null });
    release();
    await flushMicrotasks();
    expect(w.out.filter((x) => x.kind === 'auth.status')).toEqual([]);
    expect(w.clock.pending()).toBe(0);
  });

  it('without an auth port configured it never runs', async () => {
    const w = await world({ auth: false });
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: 60_000 });
    await w.clock.advanceAsync(120_000);
    expect(w.claude.calls).toEqual([]);
  });
});

describe('pollers: close', () => {
  it('stops every timer and emits nothing afterwards', async () => {
    const w = await world();
    await w.pollers.execute({ kind: 'poll.cadence', id: id(), channel: 'screen', intervalMs: 150 });
    await w.pollers.execute({ kind: 'auth.poll', id: id(), intervalMs: 60_000 });
    w.pollers.watchPane();
    await w.clock.advanceAsync(10);
    const count = w.out.length;
    w.pollers.close();
    w.pane.setScreen(BUSY);
    w.pane.exitPane({ status: 0 });
    await w.clock.advanceAsync(120_000);
    expect(w.out.length).toBe(count);
    expect(w.clock.pending()).toBe(0);
    await w.pollers.execute({ kind: 'screen.captureNow', id: id(), reason: 'x' });
    expect(w.out.length).toBe(count);
  });
});
