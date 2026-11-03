// session/pollers.ts — adapter timers A-3 (pane_dead poll), A-4 (screen poll), A-5 (auth poll) and `screen.captureNow`
// (DESIGN.md §4.11 poll cadence policy, §4.12 closed adapter-timer list, §2.6 intents `poll.cadence`, `auth.poll`,
// `screen.captureNow`).
//
// None of these timers decides anything (rev 2 §10 G4): they only produce observations.
//   A-4 screen: the core emits `poll.cadence{intervalMs}` when its class changes (150/250/1000/2000/5000 ms or null); the
//       poller captures the whole visible pane (plain, `-N`; never `-J` or `-S -`: TmuxPane.capture, P-TMUX-27/30), runs the
//       L1 screen channel (classifier + consecutive-identical drop + capture-hash short-circuit, D-41, P-SCREEN-23) and emits
//       `screen.frame` only for a changed frame. Captures never overlap; `captureNow` requests coalesce into one follow-up.
//       While the external editor is open (`awaitEditorConsumed` pending, LP-01 / ICR 0001 item 3d) no capture is taken at
//       all: periodic ticks are skipped and `captureNow` waits for the editor to finish. Captures taken during an editor
//       phase are tagged so an alternate screen classifies as `editorOpen`, not `unsupportedRenderer` (item 3b).
//   A-3 pane_dead: every 2 s `#{pane_dead}` plus the pane's `died`/`gone` events → one `process.exited` (P-TMUX-37: the
//       `refresh-client -B` path does not report pane death).
//   A-5 auth: while the core says so (`auth.poll{intervalMs}`, 60 s, only while `auth.state==='required'`), run
//       `claude auth status --json` and report `auth.status` (P-LIFE-16, rev 2 §10 G22). Runs never overlap.

import type { Intent } from '../model/intents.js';
import type { Logger } from '../model/logger.js';
import type { ScreenFacts } from '../model/screen-facts.js';
import type { Cancel, Clock, MonoMs } from '../model/time.js';
import type { ClaudeBinaryPort, TmuxPane } from '../platform/ports.js';
import type { ClaudeProfile } from '../channels/profiles/index.js';
import { createScreenChannel } from '../channels/screen/debounce.js';
import type { ScreenChannel } from '../channels/screen/debounce.js';
import type { EditorGate, ObservationSink } from './input-executor.js';

export type PollerIntent = Extract<Intent, { kind: 'poll.cadence' | 'auth.poll' | 'screen.captureNow' }>;

export const PANE_DEAD_POLL_MS = 2000;
/** Consecutive capture failures before `channel.health screen degraded{captureFailed}` (restored by the next success). */
export const CAPTURE_FAILURES_DEGRADED = 3;
const FROZEN_AFTER_MS = 3000;

export interface PollersOptions {
  clock: Clock;
  pane: () => TmuxPane | undefined;
  emit: ObservationSink;
  profile: ClaudeProfile;
  /** IANA zone for reset-time parsing (EnvPort.timeZone(), recorded in the trace header; P-REV-35). */
  tz: string;
  /** The input executor (editor handoff state). */
  editorGate?: EditorGate;
  /** For A-5: the resolved claude.exe and the child env (auth status must see the same config dir). */
  auth?: { port: ClaudeBinaryPort; exe: string; env: Readonly<Record<string, string>> };
  /** Override the L1 screen channel (tests). */
  screen?: ScreenChannel;
  paneDeadPollMs?: number;
  logger?: Logger;
}

export interface Pollers {
  /** Execute one poller intent. `screen.captureNow` resolves after its capture; the others resolve at once. Never rejects. */
  execute(intent: PollerIntent): Promise<void>;
  /** Capture now (coalesced with an in-flight capture). Resolves when a capture that started after this call finished. */
  captureNow(reason: string): Promise<void>;
  /** Start A-3 (pane_dead poll + died/gone listeners). Call once the pane exists; idempotent. */
  watchPane(): void;
  screenIntervalMs(): number | null;
  authIntervalMs(): number | null;
  /** Last emitted screen facts. */
  lastFacts(): ScreenFacts | undefined;
  /** Stop every timer; no observation is emitted afterwards. Idempotent. */
  close(): void;
}

export function createPollers(o: PollersOptions): Pollers {
  const clock = o.clock;
  const channel = o.screen ?? createScreenChannel({ frozenAfterMs: FROZEN_AFTER_MS, profile: o.profile });
  const paneDeadMs = Math.max(100, o.paneDeadPollMs ?? PANE_DEAD_POLL_MS);
  let closed = false;
  const isClosed = (): boolean => closed;
  /** Resolves on close(): an editor wait never outlives the pollers. */
  let signalClosed: () => void = () => undefined;
  const closedP = new Promise<void>((r) => {
    signalClosed = r;
  });

  // ------------------------------------------------------------------------------------------------ A-4 screen
  let screenMs: number | null = null;
  let screenTimer: Cancel | undefined;
  /**
   * When the last capture attempt ended: success, failure, a skipped tick (editor open) or no pane yet. The next periodic
   * tick is measured from here, so a failing or skipped capture can never re-arm a timer at `now` (no busy loop).
   */
  let lastAttemptAt: number | undefined;
  let inFlight: Promise<void> | undefined;
  let again: { reasons: string[]; promise: Promise<void>; resolve: () => void } | undefined;
  let failures = 0;
  let degraded = false;
  let frozenReported = false;

  const emitHealth = (health: 'up' | 'degraded', reason: string): void => {
    o.emit({
      kind: 'channel.health',
      meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'channel' },
      p: { channel: 'screen', health, reason },
    });
  };

  const captureOnce = async (reason: string): Promise<void> => {
    try {
      await attempt(reason);
    } finally {
      lastAttemptAt = clock.now();
    }
  };

  const attempt = async (reason: string): Promise<void> => {
    const gate = o.editorGate;
    if (gate?.awaitingEditor() === true) {
      if (reason === 'poll') return; // periodic tick: skip, the next tick (or the job's captureNow) follows
      await Promise.race([gate.whenEditorIdle(), closedP]);
      if (isClosed()) return;
    }
    const pane = o.pane();
    if (pane === undefined || closed) return;
    const editorPhase = gate?.editorPhase() === true;
    try {
      const c = await pane.capture();
      if (isClosed()) return;
      if (degraded) {
        degraded = false;
        emitHealth('up', 'captureFailed');
      }
      failures = 0;
      const facts = channel.push(c, { wallAt: clock.wallNow(), tz: o.tz, editorPhase });
      const frozen = channel.frozen();
      if (frozen !== undefined && !frozenReported) {
        frozenReported = true;
        o.logger?.debug('pollers: spinner frame unchanged', { forMs: frozen.forMs });
      } else if (frozen === undefined) frozenReported = false;
      if (facts === undefined) return;
      o.emit({
        kind: 'screen.frame',
        meta: { at: c.at, wallAt: clock.wallNow(), source: 'screen', origin: { kind: 'screen', frameHash: facts.frameHash } },
        p: facts,
      });
    } catch (e) {
      if (isClosed()) return;
      failures++;
      o.logger?.debug('pollers: capture failed', { reason, error: e instanceof Error ? e.name : typeof e, failures });
      if (failures >= CAPTURE_FAILURES_DEGRADED && !degraded) {
        degraded = true;
        emitHealth('degraded', 'captureFailed');
      }
    }
  };

  /** Run captures back to back until no follow-up was requested. */
  const pump = (reason: string): Promise<void> => {
    if (inFlight !== undefined) {
      if (again === undefined) {
        let resolve: () => void = () => undefined;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        again = { reasons: [reason], promise, resolve };
      } else again.reasons.push(reason);
      return again.promise;
    }
    const run = async (first: string): Promise<void> => {
      let r = first;
      let resolves: (() => void)[] = [];
      for (;;) {
        await captureOnce(r);
        for (const f of resolves) f();
        const next = again;
        again = undefined;
        if (next === undefined || closed) {
          next?.resolve();
          return;
        }
        r = next.reasons.find((x) => x !== 'poll') ?? 'poll';
        resolves = [next.resolve];
      }
    };
    inFlight = run(reason).finally(() => {
      inFlight = undefined;
      scheduleScreen();
    });
    return inFlight;
  };

  const scheduleScreen = (): void => {
    screenTimer?.();
    screenTimer = undefined;
    if (closed || screenMs === null) return;
    const now = clock.now();
    const at = Math.max(now, (lastAttemptAt ?? now - screenMs) + screenMs);
    screenTimer = clock.setTimer(at as MonoMs, () => {
      screenTimer = undefined;
      if (closed) return;
      if (inFlight !== undefined) return; // pump() reschedules when the in-flight capture ends
      void pump('poll');
    });
  };

  // ------------------------------------------------------------------------------------------------ A-3 pane_dead
  let paneTimer: Cancel | undefined;
  let watching = false;
  let exitedSent = false;
  const paneCancels: Cancel[] = [];

  const exited = (exitStatus: number | null, signal: string | null, why: string): void => {
    if (exitedSent || closed) return;
    exitedSent = true;
    paneTimer?.();
    paneTimer = undefined;
    o.logger?.info('pollers: Claude pane exited', { why, exitStatus, signal });
    o.emit({ kind: 'process.exited', meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'process' }, p: { exitStatus, signal } });
  };

  const pollPane = async (): Promise<void> => {
    const pane = o.pane();
    if (pane === undefined) return;
    try {
      const st = await pane.status();
      if (!st.exists) exited(null, null, 'paneGone');
      else if (st.dead) exited(st.exitStatus, st.exitSignal, 'paneDead');
    } catch (e) {
      o.logger?.debug('pollers: pane status failed', { error: e instanceof Error ? e.name : typeof e });
    }
  };

  const schedulePane = (): void => {
    if (closed || exitedSent) return;
    paneTimer = clock.setTimer((clock.now() + paneDeadMs) as MonoMs, () => {
      paneTimer = undefined;
      void pollPane().finally(schedulePane);
    });
  };

  // ------------------------------------------------------------------------------------------------ A-5 auth
  let authMs: number | null = null;
  let authTimer: Cancel | undefined;
  let authRunning = false;
  let authGen = 0;

  const runAuth = async (): Promise<void> => {
    const a = o.auth;
    if (a === undefined) return;
    authRunning = true;
    try {
      const r = await a.port.authStatus(a.exe, a.env);
      // A cadence change during the run does not make this result stale; only a stopped poll (null) drops it.
      if (closed || authMs === null) return;
      const p: { loggedIn: boolean; authMethod?: string; apiProvider?: string } = { loggedIn: r.loggedIn };
      if (r.authMethod !== undefined) p.authMethod = r.authMethod;
      if (r.apiProvider !== undefined) p.apiProvider = r.apiProvider;
      o.emit({ kind: 'auth.status', meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'process' }, p });
    } catch (e) {
      o.logger?.debug('pollers: auth status failed', { error: e instanceof Error ? e.name : typeof e });
    } finally {
      authRunning = false;
      // Always re-arm with the *current* cadence: an `auth.poll` that arrived during this run could not arm a timer
      // (runs never overlap), so it relies on this call; scheduleAuth() itself stops when the poll is off (null).
      scheduleAuth();
    }
  };

  const scheduleAuth = (): void => {
    authTimer?.();
    authTimer = undefined;
    if (closed || authMs === null || authRunning || o.auth === undefined) return;
    const gen = authGen;
    authTimer = clock.setTimer((clock.now() + authMs) as MonoMs, () => {
      authTimer = undefined;
      if (closed || gen !== authGen) return;
      void runAuth();
    });
  };

  // ------------------------------------------------------------------------------------------------ API
  return {
    async execute(intent: PollerIntent): Promise<void> {
      if (closed) return;
      switch (intent.kind) {
        case 'poll.cadence': {
          const ms = intent.intervalMs;
          screenMs = ms === null || !Number.isFinite(ms) ? null : Math.max(50, ms);
          if (inFlight === undefined) scheduleScreen();
          return;
        }
        case 'auth.poll': {
          const ms = intent.intervalMs;
          const next = ms === null || !Number.isFinite(ms) ? null : Math.max(1000, ms);
          if (next === authMs) return;
          authMs = next;
          authGen++;
          scheduleAuth();
          return;
        }
        case 'screen.captureNow':
          await pump(intent.reason);
          return;
      }
    },
    captureNow(reason: string): Promise<void> {
      if (closed) return Promise.resolve();
      return pump(reason);
    },
    watchPane(): void {
      if (watching || closed) return;
      const pane = o.pane();
      if (pane === undefined) return;
      watching = true;
      paneCancels.push(
        pane.on('died', (s) => {
          exited(s.exitStatus, s.exitSignal, 'died');
        }),
      );
      paneCancels.push(
        pane.on('gone', () => {
          exited(null, null, 'gone');
        }),
      );
      schedulePane();
    },
    screenIntervalMs: () => screenMs,
    authIntervalMs: () => authMs,
    lastFacts: () => channel.last(),
    close(): void {
      if (closed) return;
      closed = true;
      screenTimer?.();
      paneTimer?.();
      authTimer?.();
      for (const c of paneCancels) c();
      paneCancels.length = 0;
      again?.resolve();
      again = undefined;
      signalClosed();
    },
  };
}
