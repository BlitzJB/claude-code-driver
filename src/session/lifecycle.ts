// session/lifecycle.ts — close(), crash finalisation, the process-exit cleanup registry and opt-in signal handlers
// (DESIGN.md §3.8, D-28, §4.12 A-1 heartbeat, rev 2 §10 E2).
//
// close({mode:'graceful'}):
//   (0) waitForBackgroundMs: wait until background work is quiescent or the timeout (P-LIFE-22)
//   (1) closing: the kernel rejects new sends and cancels wakes (ctx.beginClosing)
//   (2) deny all held permissions (ctx.denyHeldPermissions; the hook server also denies on close in step 7)
//   (3) idle + clean composer + no dialog → editor stage `/exit` + Enter; else SIGTERM to the verified pid
//   (4) wait pane_dead ≤ closeGraceMs (12 000: Claude's own failsafe is max(5000, 5000+5000), LC §4.1)
//   (5) SIGTERM again, + killAfterMs (3000) → SIGKILL after re-verifying the pid identity
//   (6) read pane_dead_status/signal, capture the final screen
//   (7) stop the owner-watch; hooks.close(deny), stop the proxy, close the tail (they outlive Claude, LC rule 13)
//   (8) tmux kill (+ socket unlink)
//   (9) unseed trust if we added it and no other session uses the cwd (ICR 0022), remove the session dir (incl.
//       claude-debug.log unless keepClaudeDebugFile), archive
//   (10) the kernel publishes session.exited with the returned SessionExitInfo
// mode:'kill' starts at (5) with SIGKILL.
//
// Pitfalls handled here (§5): P-LIFE-06 (exit code/signal → reason), P-LIFE-07/08 (12 s + 3 s, SIGTERM first),
// P-LIFE-11 (verify gone, escalate), P-LIFE-13 (hook server/proxy stop after the pane is dead), P-LIFE-22 (background wait),
// P-LIFE-29 (signal handlers opt-in), P-LIFE-44 (pid identity), P-LIFE-46 (dialog after /exit → SIGTERM),
// P-LIFE-09 / P-TMUX-43 (process-exit sync kill; the owner-watch covers SIGKILL of the owner), P-REV-27 (debug file deleted
// with the 0700 session dir), P-REV-43 (globalThis-keyed exit registry shared by two package copies), P-API-17 (sync
// `execSyncBestEffort` kill-server in `process.once('exit')`), P-TMUX-61 (pid recorded first, verified, SIGTERM → SIGKILL),
// P-SEC-31 (`verifySettingsIntegrity`: the recorded sha256 re-checked after SessionStart; a mismatch → `failClosed`, Claude
// killed), P-NET-25 / §3.10 / §3.5 (sidecar or hook worker death → `failClosed`: no restart on the same port, Claude killed).

import type { ResolvedConfig } from '../model/config.js';
import type { SessionKey } from '../model/ids.js';
import type { RegistryPatch } from '../model/intents.js';
import type { KernelCloseOptions, SessionExitInfo } from '../model/kernel.js';
import type { Cancel, MonoMs, WallMs } from '../model/time.js';
import type {
  EditorInjector,
  HookEndpoint,
  HookTransport,
  NetProxy,
  Ports,
  TmuxPane,
  TmuxServer,
  TranscriptTail,
} from '../platform/ports.js';
import { CcdError } from '../model/errors.js';
import { releaseTrustLocked, terminateVerified, verifyClaudeIdentity, type ClaudeIdentity, type TerminateOutcome } from './reaper.js';
import type { RegistryStore, SessionRecord } from './registry-store.js';

export const HEARTBEAT_MS = 10_000;
export const PANE_POLL_MS = 100;
export const EXIT_CONSUME_MS = 3_000;
export const EXIT_SETTLE_MS = 100;
/** After `/exit` + Enter, a dialog (worktree keep/remove, P-LIFE-46) is checked once after this delay. */
export const EXIT_DIALOG_CHECK_MS = 1_500;
export const DEFAULT_CLOSE_GRACE_MS = 12_000;
export const DEFAULT_KILL_AFTER_MS = 3_000;

/** The body every still-held PermissionRequest gets at close (the core decides deny on close, SEC §4.1). */
export const CLOSE_DENY_BODY = Object.freeze({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied: session closing' } },
});

/** Everything a running session owns (built by launcher.ts). */
export interface SessionHandles {
  sessionKey: SessionKey;
  config: ResolvedConfig;
  sessionDir: string;
  cwdRealpath: string;
  ownerPid: number;
  claude: { exe: string; version: string; pid: number; startTime: string; argvSessionId: string };
  tmux: { bin: string; server: TmuxServer; pane: TmuxPane };
  hooks: { transport: HookTransport; endpoint: HookEndpoint };
  editor: EditorInjector;
  tail?: TranscriptTail;
  net?: NetProxy;
  ownerWatch?: { pid: number; stop(): Promise<void> };
  trustKeyAddedByLibrary: boolean;
  store: RegistryStore;
  /** The injected settings file and the sha256 recorded at write time (P-SEC-31 re-check after SessionStart). */
  settings?: { path: string; sha256: string };
  /** Env used for our own sync tmux invocation in the exit handler (minimal, no secrets). */
  toolEnv: Readonly<Record<string, string>>;
}

export interface CloseContext {
  /** Step 0: resolves when background agents/tasks are quiescent (or never; the timeout bounds it). */
  waitBackgroundQuiescent?(timeoutMs: number): Promise<void>;
  /** Step 1: `session.closing`, reject new sends, cancel wakes. */
  beginClosing?(): void | Promise<void>;
  /** Step 2: deny every held permission through the hook (the core answers). */
  denyHeldPermissions?(): void | Promise<void>;
  /** Step 3 precondition: idle, clean composer, no dialog. Default false (→ SIGTERM). */
  canExitGracefully?(): boolean;
  /** P-LIFE-46: a dialog appeared after `/exit`. */
  dialogVisible?(): boolean | Promise<boolean>;
}

// ------------------------------------------------------------------------------------------------ exit reason (P-LIFE-06)

export interface ExitFacts {
  exitStatus: number | null;
  signal: string | null;
  /** We were closing (close() was called). */
  closing: boolean;
  mode?: 'graceful' | 'kill';
  /** We had to send SIGKILL during close. */
  escalated?: boolean;
  /** The owner-watch killed it (owner gone). */
  ownerGone?: boolean;
  /** Death before `session.ready`. */
  startup?: boolean;
}

/** 0 → exitedByItself; 129/SIGHUP → hangup; 137/SIGKILL → killed; 143/SIGTERM from outside → killed; other → crashed. */
export function mapExitReason(f: ExitFacts): SessionExitInfo['reason'] {
  if (f.ownerGone === true) return 'ownerGone';
  if (f.closing) return f.mode === 'kill' || f.escalated === true ? 'killed' : 'closed';
  if (f.startup === true) return 'startupFailed';
  const sig = f.signal?.toUpperCase();
  if (sig === 'SIGHUP' || f.exitStatus === 129) return 'hangup';
  if (sig === 'SIGKILL' || sig === 'SIGTERM' || f.exitStatus === 137 || f.exitStatus === 143) return 'killed';
  if (f.exitStatus === 0 && sig === undefined) return 'exitedByItself';
  return 'crashed';
}

// ------------------------------------------------------------------------------------------------ global exit registry

export const EXIT_REGISTRY_KEY: unique symbol = Symbol.for('claude-code-driver.exit-registry.v1') as never;

export interface ExitEntry {
  sessionKey: string;
  /** Sync best effort (process 'exit'): SIGTERM the verified Claude pid, kill the private tmux server. */
  killSync(): void;
  close(o: KernelCloseOptions): Promise<unknown>;
}

interface ExitRegistry {
  v: 1;
  entries: Map<string, ExitEntry>;
  exitHookInstalled: boolean;
  signals: { installed: boolean; count: number; uninstall?: () => void };
}

type ProcessLike = Pick<NodeJS.Process, 'once' | 'on' | 'off' | 'kill' | 'pid'>;

/** Shared by every copy of the package loaded in this process (P-REV-43). */
export function exitRegistry(): ExitRegistry {
  const g = globalThis as unknown as Record<symbol, ExitRegistry | undefined>;
  let r = g[EXIT_REGISTRY_KEY];
  if (r?.v !== 1) {
    r = { v: 1, entries: new Map(), exitHookInstalled: false, signals: { installed: false, count: 0 } };
    g[EXIT_REGISTRY_KEY] = r;
  }
  return r;
}

function runExitHandlers(): void {
  for (const e of [...exitRegistry().entries.values()]) {
    try {
      e.killSync();
    } catch {
      // best effort: never throw from process 'exit'
    }
  }
}

/** Register a live session for the process-exit sync cleanup. Returns the unregister function. */
export function registerForExit(entry: ExitEntry, proc: ProcessLike = process): () => void {
  const r = exitRegistry();
  r.entries.set(entry.sessionKey, entry);
  if (!r.exitHookInstalled) {
    r.exitHookInstalled = true;
    proc.once('exit', () => {
      exitRegistry().exitHookInstalled = false;
      runExitHandlers();
    });
  }
  return () => {
    if (r.entries.get(entry.sessionKey) === entry) r.entries.delete(entry.sessionKey);
  };
}

/** Close every live session of this process (all package copies). */
export async function closeAll(o: KernelCloseOptions = {}): Promise<void> {
  const entries = [...exitRegistry().entries.values()];
  await Promise.allSettled(entries.map((e) => e.close(o)));
}

/**
 * Opt-in signal handlers (P-LIFE-29): the first signal closes every session gracefully, then re-raises the signal with our
 * handlers removed (so the default action or the host's own handlers apply); a second signal during that forces `kill`.
 */
export function installSignalHandlers(o: { signals?: readonly NodeJS.Signals[]; proc?: ProcessLike } = {}): () => void {
  const r = exitRegistry();
  if (r.signals.installed && r.signals.uninstall !== undefined) return r.signals.uninstall;
  const proc = o.proc ?? process;
  const signals = o.signals ?? (['SIGINT', 'SIGTERM', 'SIGHUP'] as const);
  r.signals.count = 0;
  const handler = (sig: NodeJS.Signals): void => {
    r.signals.count++;
    if (r.signals.count === 1) {
      void closeAll({ mode: 'graceful', reason: `signal ${sig}` }).finally(() => {
        uninstall();
        proc.kill(proc.pid, sig);
      });
    } else {
      void closeAll({ mode: 'kill', reason: `second signal ${sig}` }).finally(() => {
        uninstall();
        proc.kill(proc.pid, sig);
      });
    }
  };
  for (const s of signals) proc.on(s, handler);
  const uninstall = (): void => {
    for (const s of signals) proc.off(s, handler);
    r.signals.installed = false;
    delete r.signals.uninstall;
  };
  r.signals.installed = true;
  r.signals.uninstall = uninstall;
  return uninstall;
}

// ------------------------------------------------------------------------------------------------ teardown helpers

interface Step {
  name: string;
  run: () => Promise<void> | void;
}

/** Run cleanup steps in order; a failing step is logged and never stops the others. */
export async function runSteps(steps: readonly Step[], warn: (msg: string, f: Record<string, unknown>) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const s of steps) {
    try {
      await s.run();
    } catch (e) {
      failed.push(s.name);
      warn(`lifecycle: cleanup step ${s.name} failed`, { step: s.name, error: e instanceof Error ? e.name : 'unknown' });
    }
  }
  return failed;
}

// ------------------------------------------------------------------------------------------------ lifecycle

export class SessionLifecycle {
  private closePromise: Promise<SessionExitInfo> | undefined;
  private heartbeatCancel: (() => void) | undefined;
  private unregister: (() => void) | undefined;
  private finalized = false;
  private escalated = false;
  private failClosedReason: string | undefined;
  private readonly guards: Cancel[] = [];

  constructor(
    private readonly ports: Pick<Ports, 'clock' | 'process' | 'claudeConfig' | 'runtimeDir' | 'logger'> &
      Partial<Pick<Ports, 'settingsFile'>>,
    readonly h: SessionHandles,
  ) {}

  /** Why `failClosed` killed Claude (undefined when it never ran). */
  get failedClosed(): string | undefined {
    return this.failClosedReason;
  }

  /** A listener (fail-closed guard) cancelled at teardown. After teardown it is cancelled at once. */
  addGuard(off: Cancel): void {
    if (this.finalized) {
      off();
      return;
    }
    this.guards.push(off);
  }

  /**
   * P-SEC-31: compare the settings file with the sha256 recorded when it was written (`SettingsFilePort.matches`).
   * `unknown` when there is nothing to compare (no recorded settings or no port). A read error counts as `tampered`.
   */
  async verifySettingsIntegrity(): Promise<'intact' | 'tampered' | 'unknown'> {
    const s = this.h.settings;
    const port = this.ports.settingsFile;
    if (s === undefined || port === undefined) return 'unknown';
    try {
      return (await port.matches(s.path, s.sha256)) ? 'intact' : 'tampered';
    } catch {
      return 'tampered';
    }
  }

  /**
   * Fail closed (D-28 pattern): kill the verified Claude pid so the pane dies and the normal exit path (pane_dead poll →
   * process.exited → finalize) runs. Used when the settings file was tampered with (P-SEC-31, `immediate`: SIGKILL at once,
   * Claude may already run foreign hooks), the network sidecar died (§3.10: no restart on the same port, P-NET-25) or the hook
   * worker died (§3.5: re-listening on a released port races a squatter). Runs once; never during close.
   */
  async failClosed(reason: string, o: { immediate?: boolean } = {}): Promise<TerminateOutcome | 'skipped'> {
    if (this.failClosedReason !== undefined || this.closing || this.finalized) return 'skipped';
    this.failClosedReason = reason;
    this.ports.logger.warn('lifecycle: failing closed, killing Claude', { sessionKey: this.h.sessionKey, reason });
    await this.h.store.appendExit(this.h.sessionKey, `failClosed reason=${reason}`).catch(() => undefined);
    const killAfterMs = this.h.config.lifecycle.killAfterMs > 0 ? this.h.config.lifecycle.killAfterMs : DEFAULT_KILL_AFTER_MS;
    return terminateVerified(
      this.ports.process,
      this.ports.clock,
      this.identity,
      o.immediate === true ? { graceMs: 0, killAfterMs, startWith: 'SIGKILL' } : { graceMs: killAfterMs, killAfterMs },
    );
  }

  get identity(): ClaudeIdentity {
    return {
      pid: this.h.claude.pid,
      startTime: this.h.claude.startTime,
      exeSubstr: basename(this.h.claude.exe),
      sessionId: this.h.claude.argvSessionId,
    };
  }

  get closing(): boolean {
    return this.closePromise !== undefined;
  }

  /** Register in the globalThis exit registry (P-REV-43). */
  registerExit(proc?: ProcessLike): void {
    if (this.unregister !== undefined) return;
    this.unregister = registerForExit(
      {
        sessionKey: this.h.sessionKey,
        killSync: () => {
          this.killSync();
        },
        close: (o) => this.close(o),
      },
      proc,
    );
  }

  /** A-1: owners/<pid>.json heartbeatAt every 10 s (housekeeping only; read by lifecheck). */
  startHeartbeat(periodMs = HEARTBEAT_MS): void {
    if (this.heartbeatCancel !== undefined) return;
    const clock = this.ports.clock;
    let cancelled = false;
    let cancelTimer: () => void = () => undefined;
    const tick = (): void => {
      if (cancelled) return;
      void this.h.store.heartbeat(this.h.ownerPid).catch(() => undefined);
      cancelTimer = clock.setTimer((clock.now() + periodMs) as MonoMs, tick);
    };
    cancelTimer = clock.setTimer((clock.now() + periodMs) as MonoMs, tick);
    this.heartbeatCancel = () => {
      cancelled = true;
      cancelTimer();
    };
  }

  stopHeartbeat(): void {
    this.heartbeatCancel?.();
    this.heartbeatCancel = undefined;
  }

  /** Registry state 'ready' (§3.1 step 16). */
  async markReady(): Promise<void> {
    await this.h.store.updateSession(this.h.sessionKey, { state: 'ready' });
  }

  /** Executes a core `registry.persist` intent. */
  async persist(patch: RegistryPatch): Promise<void> {
    const p: Partial<SessionRecord> = {};
    const remove: 'usageLimit'[] = [];
    if (patch.claudeSessionId !== undefined) p.claudeSessionId = patch.claudeSessionId;
    if (patch.transcriptPath !== undefined) p.transcriptPath = patch.transcriptPath;
    if (patch.state !== undefined) p.status = patch.state;
    if (patch.lastEventSeq !== undefined) p.lastEventSeq = patch.lastEventSeq;
    if (patch.usageLimit !== undefined) {
      if (patch.usageLimit === null) remove.push('usageLimit');
      else {
        const ul: NonNullable<SessionRecord['usageLimit']> = { since: this.wallNow() };
        const at = (patch.usageLimit as { resetsAtWall?: WallMs }).resetsAtWall;
        if (at !== undefined) ul.resetsAtWall = at;
        p.usageLimit = ul;
      }
    }
    await this.h.store.updateSession(this.h.sessionKey, p, remove);
  }

  /** Executes a core `process.signal` intent: only ever to the verified Claude pid (P-LIFE-44). */
  async signal(sig: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
    if ((await verifyClaudeIdentity(this.ports.process, this.identity)) !== 'match') return false;
    return this.ports.process.kill(this.h.claude.pid, sig);
  }

  /** process 'exit' (sync, best effort): SIGTERM the Claude pid, kill the private tmux server. Registry entries stay. */
  killSync(): void {
    try {
      if (this.ports.process.isAlive(this.h.claude.pid)) this.ports.process.kill(this.h.claude.pid, 'SIGTERM');
    } catch {
      // best effort
    }
    try {
      const server = this.h.tmux.server;
      const target = server.socketPath.startsWith('/') ? ['-S', server.socketPath] : ['-L', server.socketName];
      this.ports.process.execSyncBestEffort(this.h.tmux.bin, [...target, 'kill-server'], this.h.toolEnv);
    } catch {
      // best effort
    }
    try {
      this.h.tmux.server.killSync();
    } catch {
      // best effort
    }
  }

  /** Idempotent close (§3.8). */
  close(o: KernelCloseOptions = {}, ctx: CloseContext = {}): Promise<SessionExitInfo> {
    this.closePromise ??= this.doClose(o, ctx);
    return this.closePromise;
  }

  /** Claude exited by itself (pane dead): run steps 6–9 and report the mapped reason. Idempotent with close(). */
  finalizeAfterExit(o: { startup?: boolean; ownerGone?: boolean } = {}): Promise<SessionExitInfo> {
    this.closePromise ??= this.teardown({ closing: false, mode: 'graceful', ...o });
    return this.closePromise;
  }

  private async doClose(o: KernelCloseOptions, ctx: CloseContext): Promise<SessionExitInfo> {
    const cfg = this.h.config.lifecycle;
    const graceMs = o.graceMs ?? (cfg.closeGraceMs > 0 ? cfg.closeGraceMs : DEFAULT_CLOSE_GRACE_MS);
    const killAfterMs = cfg.killAfterMs > 0 ? cfg.killAfterMs : DEFAULT_KILL_AFTER_MS;
    const mode = o.mode ?? 'graceful';
    const log = this.ports.logger;
    await this.h.store.updateSession(this.h.sessionKey, { state: 'closing' }).catch(() => undefined);

    if (mode === 'graceful') {
      // (0)
      if (o.waitForBackgroundMs !== undefined && o.waitForBackgroundMs > 0 && ctx.waitBackgroundQuiescent !== undefined) {
        const timeout = o.waitForBackgroundMs;
        await Promise.race([ctx.waitBackgroundQuiescent(timeout).catch(() => undefined), this.ports.clock.sleep(timeout)]);
      }
      // (1), (2)
      await safely(() => ctx.beginClosing?.());
      await safely(() => ctx.denyHeldPermissions?.());
      // (3)
      if (!(await this.paneDead())) {
        let sentExit = false;
        if (ctx.canExitGracefully?.() === true) sentExit = await this.sendExitCommand();
        if (sentExit) {
          const deadEarly = await this.waitPaneDead(Math.min(EXIT_DIALOG_CHECK_MS, graceMs));
          if (!deadEarly && ctx.dialogVisible !== undefined && (await ctx.dialogVisible())) {
            log.info('lifecycle: dialog after /exit, sending SIGTERM', { sessionKey: this.h.sessionKey });
            await this.signal('SIGTERM');
          }
        } else await this.signal('SIGTERM');
        // (4)
        if (!(await this.waitPaneDead(graceMs))) {
          // (5)
          const out = await this.escalate(killAfterMs, 'SIGTERM');
          log.warn('lifecycle: Claude did not exit within the grace period', { sessionKey: this.h.sessionKey, outcome: out });
        }
      }
    } else {
      await safely(() => ctx.beginClosing?.());
      await this.escalate(killAfterMs, 'SIGKILL');
    }
    return this.teardown({ closing: true, mode });
  }

  /** (5): verified SIGTERM (or SIGKILL for mode kill), then SIGKILL after killAfterMs. */
  private async escalate(killAfterMs: number, startWith: 'SIGTERM' | 'SIGKILL'): Promise<TerminateOutcome> {
    const out = await terminateVerified(this.ports.process, this.ports.clock, this.identity, {
      graceMs: killAfterMs,
      killAfterMs,
      startWith,
    });
    if (out === 'killed' || out === 'survived' || startWith === 'SIGKILL') this.escalated = true;
    if (out !== 'identity-mismatch') await this.waitPaneDead(1_000);
    return out;
  }

  /** Editor stage `/exit` + C-g + consumed + settle + Enter (a staged leading `/` is parsed as a command, IN §3.1). */
  private async sendExitCommand(): Promise<boolean> {
    try {
      const pane = this.h.tmux.pane;
      const st = await pane.status();
      if (st.dead || st.inMode) return false;
      const { nonce } = await this.h.editor.stage('/exit');
      await pane.sendKey('C-g');
      const consumed = await this.h.editor.consumed(nonce, EXIT_CONSUME_MS);
      if (!consumed) {
        await this.h.editor.disarm().catch(() => undefined);
        return false;
      }
      await this.ports.clock.sleep(EXIT_SETTLE_MS);
      await pane.sendKey('Enter');
      return true;
    } catch {
      return false;
    }
  }

  private async paneDead(): Promise<boolean> {
    try {
      const st = await this.h.tmux.pane.status();
      return !st.exists || st.dead;
    } catch {
      return true; // pane or server gone
    }
  }

  private async waitPaneDead(maxMs: number): Promise<boolean> {
    const clock = this.ports.clock;
    const until = clock.now() + maxMs;
    for (;;) {
      if (await this.paneDead()) return true;
      if (clock.now() >= until) return false;
      await clock.sleep(Math.min(PANE_POLL_MS, Math.max(1, until - clock.now())));
    }
  }

  /** Steps 6–9. Never throws: every step is best effort, failures are logged. */
  private async teardown(f: {
    closing: boolean;
    mode: 'graceful' | 'kill';
    startup?: boolean;
    ownerGone?: boolean;
  }): Promise<SessionExitInfo> {
    if (this.finalized) throw new CcdError('E_INVARIANT', 'lifecycle teardown ran twice');
    this.finalized = true;
    this.stopHeartbeat();
    for (const off of this.guards.splice(0)) {
      try {
        off();
      } catch {
        // a guard's cancel never blocks the teardown
      }
    }
    const h = this.h;
    const log = this.ports.logger;
    const warn = (m: string, x: Record<string, unknown>): void => {
      log.warn(m, { sessionKey: h.sessionKey, ...x });
    };

    // (6) exit status + final screen
    let exitStatus: number | null = null;
    let signal: string | null = null;
    let finalScreen: string | undefined;
    try {
      const st = await h.tmux.pane.status();
      exitStatus = st.exitStatus;
      signal = st.exitSignal;
    } catch {
      // pane gone: status unknown
    }
    try {
      const cap = await h.tmux.pane.capture();
      exitStatus ??= cap.status.exitStatus;
      signal ??= cap.status.exitSignal;
      finalScreen = trimScreen(cap.lines);
    } catch {
      // pane gone
    }
    // Whatever happened, Claude must not outlive the hook server (LC rule 13).
    if (this.ports.process.isAlive(h.claude.pid)) {
      const out = await terminateVerified(this.ports.process, this.ports.clock, this.identity, { graceMs: 1_000, killAfterMs: 1_000 });
      if (out === 'killed') this.escalated = true;
    }

    const reason = mapExitReason({
      exitStatus,
      signal,
      closing: f.closing,
      mode: f.mode,
      escalated: this.escalated,
      ...(f.ownerGone === undefined ? {} : { ownerGone: f.ownerGone }),
      ...(f.startup === undefined ? {} : { startup: f.startup }),
    });
    const keepDir = h.config.debug.claudeDebugFile && h.config.debug.keepClaudeDebugFile;

    await runSteps(
      [
        // (7)
        { name: 'ownerWatch.stop', run: () => h.ownerWatch?.stop() },
        { name: 'hooks.close', run: () => h.hooks.transport.close(CLOSE_DENY_BODY) },
        { name: 'net.stop', run: () => h.net?.stop() },
        { name: 'tail.close', run: () => h.tail?.close() },
        { name: 'editor.disarm', run: () => h.editor.disarm() },
        // (8)
        { name: 'tmux.kill', run: () => h.tmux.server.kill() },
        // (9)
        {
          // ICR 0022: never while another session uses this cwd (the last one out removes the key)
          name: 'unseedTrust',
          run: async () => {
            if (!h.trustKeyAddedByLibrary && !(await h.store.readTrustSeeds()).some((x) => x.cwd === h.cwdRealpath)) return;
            await h.store.withLock(() =>
              releaseTrustLocked(
                { store: h.store, claudeConfig: this.ports.claudeConfig },
                { sessionKey: h.sessionKey, cwdRealpath: h.cwdRealpath, ownedHint: h.trustKeyAddedByLibrary },
              ),
            );
          },
        },
        { name: 'removeSessionDir', run: () => (keepDir ? undefined : this.ports.runtimeDir.removeSessionDir(h.sessionDir)) },
        {
          name: 'registry.archive',
          run: async () => {
            await h.store.appendExit(h.sessionKey, `closed reason=${reason} status=${exitStatus ?? ''} signal=${signal ?? ''}`);
            await h.store.archive(h.sessionKey, {
              reapedBy: 'close',
              exit: { exitStatus, signal, reason },
              ...(keepDir ? { keptSessionDir: true } : {}),
            });
          },
        },
        { name: 'owner.remove', run: () => this.removeOwnerIfLast() },
      ],
      warn,
    );
    if (keepDir) warn('lifecycle: kept the session dir with claude-debug.log (keepClaudeDebugFile)', { sessionDir: h.sessionDir });
    this.unregister?.();
    this.unregister = undefined;
    const info: SessionExitInfo = { exitStatus, signal, reason };
    if (finalScreen !== undefined) info.finalScreen = finalScreen;
    return info;
  }

  private async removeOwnerIfLast(): Promise<void> {
    const others = [...exitRegistry().entries.keys()].filter((k) => k !== this.h.sessionKey);
    const mine = (await this.h.store.listSessions()).filter((s) => s.owner.pid === this.h.ownerPid && s.sessionKey !== this.h.sessionKey);
    if (others.length === 0 && mine.length === 0) await this.h.store.removeOwner(this.h.ownerPid);
  }

  private wallNow(): WallMs {
    return this.ports.clock.wallNow();
  }
}

async function safely(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    // a failing context callback never blocks close
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** Final screen: trailing blank lines removed, ≤ 80 lines, ≤ 16 KiB (it may be shown in an error). */
export function trimScreen(lines: readonly string[]): string {
  const out = lines.map((l) => l.replace(/\s+$/, ''));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  let text = out.slice(-80).join('\n');
  if (text.length > 16_384) text = text.slice(-16_384);
  return text;
}
