// platform/tmux/fake-tmux.ts — in-memory TmuxServerFactory/TmuxServer/TmuxPane (DESIGN.md §2.7 "Fakes", §6.4 tmux row).
//
// Same validation and the same typed errors as the real driver (it reuses the real validators), and the same byte semantics
// towards the program in the pane: paste = text with LF kept (`-r`), wrapped in ESC[200~ … ESC[201~ when the program enabled
// bracketed paste (`-p`); keys map to the bytes tmux sends (TD §2.1). The shared contract suite (test/contract/tmux.contract.ts)
// runs against this fake and the real driver.
//
// Fault injection (§6.4): dropNextKey('Enter') (lost Enter), exitPane() (dead pane), vanish() (server crash), enterCopyMode(),
// queueFrames() (A→B→A frames), tearNextCapture() (half-drawn frame), setKeyMode() (extended keys), failNext().
// Every call is recorded in `invocations` so tests can assert "zero tmux invocations" (K-03).

import type { TmuxKeyName } from '../../model/intents.js';
import type { Cancel, Clock } from '../../model/time.js';
import type { Capture, PaneId, PaneInfo, PaneSpawnOptions, PaneStatus, TmuxPane, TmuxServer, TmuxServerFactory } from '../ports.js';
import { SAFE_PATH_RE, SOCKET_NAME_RE } from './args.js';
import {
  LITERAL_LIMIT_BYTES,
  TmuxArgTooLong,
  TmuxCrashed,
  TmuxDuplicate,
  TmuxInvalidInput,
  TmuxNotFound,
  TmuxPaneDead,
  TmuxPaneInMode,
  TmuxServerGone,
  TmuxSocketPathTooLong,
  TmuxTargetMissing,
  TmuxUnsupported,
  TmuxVersionUnsupported,
  type TmuxError,
} from './errors.js';
import { captureHash, isTmuxKeyName, isWellFormedString, normalizePasteText, viewCommandFor } from './pane.js';
import { SOCKET_PATH_LIMIT, validateSpawn } from './server.js';
import { featuresOf, isSupportedVersion, MIN_TMUX_VERSION, parseTmuxVersion } from './version.js';

/** Bytes tmux delivers for each key (TD §2.1, VERIFIED with rawecho). */
export const KEY_BYTES: Readonly<Record<TmuxKeyName, string>> = Object.freeze({
  Enter: '\r',
  Escape: '\u001b',
  BTab: '\u001b[Z',
  Up: '\u001b[A',
  Down: '\u001b[B',
  'C-g': '\u0007',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
});

const PASTE_FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const LITERAL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f]/;

export type FakeInvocation =
  | { op: 'probe'; tmuxPath: string | undefined }
  | { op: 'create'; socketName: string }
  | { op: 'spawn'; socketName: string; sessionName: string; argv: readonly string[] }
  | { op: 'paste'; paneId: PaneId; text: string }
  | { op: 'typeLiteral'; paneId: PaneId; text: string }
  | { op: 'sendKey'; paneId: PaneId; key: TmuxKeyName; dropped: boolean }
  | { op: 'capture'; paneId: PaneId }
  | { op: 'status'; paneId: PaneId }
  | { op: 'exitCopyMode'; paneId: PaneId }
  | { op: 'killPane'; paneId: PaneId }
  | { op: 'kill'; socketName: string };

/** What a fake program sees and can do (the stand-in for the process in the pane). */
export interface FakePaneIO {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly paneId: PaneId;
  /** Append a line to the screen (scrolls when full). */
  print(line: string): void;
  /** Replace the whole visible screen. */
  setScreen(lines: readonly string[]): void;
  /** Turn bracketed paste (DECSET 2004) on or off. */
  setBracketedPaste(on: boolean): void;
  setAlternate(on: boolean): void;
  /** Exit: `remain-on-exit on` keeps the pane, dead. */
  exit(status: number | null, signal?: string | null): void;
}

export interface FakeProgram {
  start?(io: FakePaneIO): void;
  /** One read as the app would receive it (paste, literal or key bytes). */
  input?(bytes: string, io: FakePaneIO): void;
}

export type FakeProgramResolver = (argv: readonly string[], spawn: PaneSpawnOptions) => FakeProgram;

export interface FakeTmuxOptions {
  clock: Clock;
  /** `tmux -V` text after "tmux " (default `3.5a`). */
  version?: string;
  /** probe() fails with TmuxNotFound. */
  missing?: boolean;
  /** Path probe() reports (default `/opt/homebrew/bin/tmux`). */
  path?: string;
  /** Program per spawned argv (default: a silent program). */
  program?: FakeProgramResolver;
  uid?: number;
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

type FailOp = 'spawn' | 'paste' | 'typeLiteral' | 'sendKey' | 'capture' | 'status' | 'exitCopyMode' | 'killPane';

export class FakeTmux implements TmuxServerFactory {
  readonly invocations: FakeInvocation[] = [];
  readonly clock: Clock;
  private readonly versionText: string;
  private readonly missing: boolean;
  private readonly path: string;
  private readonly resolver: FakeProgramResolver;
  private readonly uid: number;
  private readonly servers = new Map<string, FakeTmuxServer>();
  /** In-memory exit logs (the real driver's pane-died run-shell appends to a file). */
  private readonly exitLogs = new Map<string, string[]>();
  private readonly sockets = new Set<string>();
  private dropKeys: TmuxKeyName[] = [];
  private failures: { op: FailOp; error: TmuxError }[] = [];

  constructor(o: FakeTmuxOptions) {
    this.clock = o.clock;
    this.versionText = o.version ?? '3.5a';
    this.missing = o.missing ?? false;
    this.path = o.path ?? '/opt/homebrew/bin/tmux';
    this.resolver = o.program ?? (() => ({}));
    this.uid = o.uid ?? 501;
  }

  // ------------------------------------------------------------ port

  probe(tmuxPath?: string): Promise<{ path: string; version: string }> {
    this.invocations.push({ op: 'probe', tmuxPath });
    if (this.missing) return Promise.reject(new TmuxNotFound([tmuxPath ?? this.path]));
    const v = parseTmuxVersion(`tmux ${this.versionText}`);
    if (v === undefined || !isSupportedVersion(v)) return Promise.reject(new TmuxVersionUnsupported(this.versionText, MIN_TMUX_VERSION));
    return Promise.resolve({ path: tmuxPath?.startsWith('/') === true ? tmuxPath : this.path, version: v.raw });
  }

  create(o: {
    tmuxPath: string;
    socketName: string;
    clientEnv: Readonly<Record<string, string>>;
    historyLimit: number;
    paneDiedLogPath: string;
  }): Promise<TmuxServer> {
    this.invocations.push({ op: 'create', socketName: o.socketName });
    try {
      if (this.missing) throw new TmuxNotFound([o.tmuxPath]);
      if (!SOCKET_NAME_RE.test(o.socketName)) throw new TmuxInvalidInput('badOption', `socket name must match ${String(SOCKET_NAME_RE)}`);
      if (!o.tmuxPath.startsWith('/')) throw new TmuxInvalidInput('badOption', 'tmuxPath must be absolute (use probe())');
      if (!o.paneDiedLogPath.startsWith('/') || !SAFE_PATH_RE.test(o.paneDiedLogPath))
        throw new TmuxInvalidInput('badOption', `paneDiedLogPath must be absolute and match ${String(SAFE_PATH_RE)}`);
      if (!Number.isInteger(o.historyLimit) || o.historyLimit < 0 || o.historyLimit > 10_000_000)
        throw new TmuxInvalidInput('badOption', 'historyLimit must be an integer in [0, 10000000]');
      const v = parseTmuxVersion(`tmux ${this.versionText}`);
      if (v === undefined || !isSupportedVersion(v)) throw new TmuxVersionUnsupported(this.versionText, MIN_TMUX_VERSION);
      const tmp = o.clientEnv['TMUX_TMPDIR'];
      const socketPath = `${tmp !== undefined && tmp !== '' ? tmp : '/tmp'}/tmux-${this.uid}/${o.socketName}`;
      const bytes = Buffer.byteLength(socketPath, 'utf8');
      if (bytes > SOCKET_PATH_LIMIT) throw new TmuxSocketPathTooLong(bytes, SOCKET_PATH_LIMIT);
      const existing = this.servers.get(o.socketName);
      if (existing?.alive === true) throw new TmuxDuplicate(`socket ${o.socketName} already has a running server`);
      const s = new FakeTmuxServer(this, {
        socketName: o.socketName,
        socketPath,
        tmuxPath: o.tmuxPath,
        version: v.raw,
        clientEnv: Object.fromEntries(Object.entries(o.clientEnv).filter(([k]) => k !== 'TMUX' && k !== 'TMUX_PANE')),
        historyLimit: o.historyLimit,
        paneDiedLogPath: o.paneDiedLogPath,
        allowPassthrough: featuresOf(v).allowPassthrough,
      });
      this.servers.set(o.socketName, s);
      return Promise.resolve(s);
    } catch (e) {
      return Promise.reject(asError(e));
    }
  }

  // ------------------------------------------------------------ fault injection / inspection

  /** The next sendKey(key) on any pane resolves normally but is never delivered (K-06 lost Enter). */
  dropNextKey(key: TmuxKeyName): void {
    this.dropKeys.push(key);
  }

  /** The next call of `op` (on any pane/server) rejects with `error`. */
  failNext(op: FailOp, error: TmuxError): void {
    this.failures.push({ op, error });
  }

  server(socketName: string): FakeTmuxServer | undefined {
    return this.servers.get(socketName);
  }

  /** Latest server created (convenience for kernel tests). */
  lastServer(): FakeTmuxServer | undefined {
    return [...this.servers.values()].at(-1);
  }

  /** Latest pane spawned on any server. */
  lastPane(): FakeTmuxPane | undefined {
    return this.lastServer()?.panes.at(-1);
  }

  exitLogLines(path: string): string[] {
    return [...(this.exitLogs.get(path) ?? [])];
  }

  socketExists(path: string): boolean {
    return this.sockets.has(path);
  }

  /** Invocations that reached a tmux server or binary (everything recorded). */
  invocationCount(): number {
    return this.invocations.length;
  }

  // ------------------------------------------------------------ internal (used by server/pane)

  /** @internal */
  takeDrop(key: TmuxKeyName): boolean {
    const i = this.dropKeys.indexOf(key);
    if (i < 0) return false;
    this.dropKeys.splice(i, 1);
    return true;
  }

  /** @internal */
  takeFailure(op: FailOp): TmuxError | undefined {
    const i = this.failures.findIndex((f) => f.op === op);
    if (i < 0) return undefined;
    const [f] = this.failures.splice(i, 1);
    return f?.error;
  }

  /** @internal */
  appendExitLog(path: string, line: string): void {
    const l = this.exitLogs.get(path) ?? [];
    l.push(line);
    this.exitLogs.set(path, l);
  }

  /** @internal */
  setSocket(path: string, present: boolean): void {
    if (present) this.sockets.add(path);
    else this.sockets.delete(path);
  }

  /** @internal */
  resolveProgram(argv: readonly string[], o: PaneSpawnOptions): FakeProgram {
    return this.resolver(argv, o);
  }

  /** @internal */
  record(i: FakeInvocation): void {
    this.invocations.push(i);
  }
}

interface FakeServerInit {
  socketName: string;
  socketPath: string;
  tmuxPath: string;
  version: string;
  clientEnv: Readonly<Record<string, string>>;
  historyLimit: number;
  paneDiedLogPath: string;
  allowPassthrough: boolean;
}

export class FakeTmuxServer implements TmuxServer {
  readonly socketName: string;
  readonly socketPath: string;
  readonly version: string;
  readonly tmuxPath: string;
  readonly panes: FakeTmuxPane[] = [];
  /** Server/global/window options as the real prelude sets them (inspection for the contract suite). */
  readonly options = new Map<string, string>();
  /** Paste buffers currently held (always empty after a successful paste: `-d`). */
  readonly buffers = new Set<string>();
  readonly clientEnv: Readonly<Record<string, string>>;
  readonly historyLimit: number;
  readonly paneDiedLogPath: string;
  private readonly fake: FakeTmux;
  private readonly allowPassthrough: boolean;
  private state: 'running' | 'idle' | 'crashed' | 'killed' = 'idle';
  private goneFired = false;
  private paneSeq = 0;
  private pidSeq = 50_000;
  private keyMode = 'VT10x';
  private readonly goneListeners = new Set<() => void>();

  constructor(fake: FakeTmux, i: FakeServerInit) {
    this.fake = fake;
    this.socketName = i.socketName;
    this.socketPath = i.socketPath;
    this.tmuxPath = i.tmuxPath;
    this.version = i.version;
    this.clientEnv = i.clientEnv;
    this.historyLimit = i.historyLimit;
    this.paneDiedLogPath = i.paneDiedLogPath;
    this.allowPassthrough = i.allowPassthrough;
  }

  get alive(): boolean {
    return this.state === 'running';
  }

  // ------------------------------------------------------------ port

  async spawnPane(o: PaneSpawnOptions): Promise<TmuxPane> {
    await Promise.resolve();
    this.fake.record({ op: 'spawn', socketName: this.socketName, sessionName: o.sessionName, argv: [...o.argv] });
    this.ensureUsable();
    const injected = this.fake.takeFailure('spawn');
    if (injected !== undefined) throw injected;
    validateSpawn(o);
    if (this.panes.some((p) => p.sessionName === o.sessionName && !p.removed)) throw new TmuxDuplicate(`session ${o.sessionName}`);
    if (this.keyMode !== 'VT10x') throw new TmuxUnsupported('extendedKeys', this.keyMode);
    if (this.state === 'idle') {
      this.state = 'running';
      this.fake.setSocket(this.socketPath, true);
      this.options.set('escape-time', '10');
      this.options.set('focus-events', 'off');
      this.options.set('set-clipboard', 'off');
      this.options.set('extended-keys', 'off');
      this.options.set('history-limit', String(this.historyLimit));
      this.options.set('remain-on-exit', 'on');
      this.options.set('status', 'off');
      this.options.set('mouse', 'off');
      this.options.set('default-terminal', 'tmux-256color');
      if (this.allowPassthrough) this.options.set('allow-passthrough', 'off');
    }
    this.options.set('window-size', 'manual');
    const n = this.paneSeq++;
    const info: PaneInfo = {
      paneId: `%${n}`,
      sessionId: `$${n}`,
      windowId: `@${n}`,
      pid: this.pidSeq++,
      cols: o.cols,
      rows: o.rows,
    };
    const env: Record<string, string> = {
      ...this.clientEnv,
      ...o.nonSecretEnv,
      TMUX: `${this.socketPath},${this.pidSeq},${n}`,
      TMUX_PANE: info.paneId,
      TERM: 'tmux-256color',
      TERM_PROGRAM: 'tmux',
    };
    const pane = new FakeTmuxPane(this.fake, this, info, o, env);
    this.panes.push(pane);
    pane.startProgram(this.fake.resolveProgram(o.argv, o));
    return pane;
  }

  onGone(fn: () => void): Cancel {
    this.goneListeners.add(fn);
    return () => this.goneListeners.delete(fn);
  }

  kill(): Promise<void> {
    this.fake.record({ op: 'kill', socketName: this.socketName });
    if (this.state !== 'crashed') this.state = 'killed';
    this.fake.setSocket(this.socketPath, false);
    for (const p of this.panes) p.markRemoved(true);
    return Promise.resolve();
  }

  killSync(): void {
    this.fake.record({ op: 'kill', socketName: this.socketName });
    if (this.state !== 'crashed') this.state = 'killed';
    this.fake.setSocket(this.socketPath, false);
    for (const p of this.panes) p.markRemoved();
  }

  // ------------------------------------------------------------ fault injection

  /** Server crash: every pane vanishes. Like the real driver, it is noticed by the next command (status/capture/input). */
  vanish(): void {
    this.state = 'crashed';
  }

  /** Simulate a tmux whose pane key mode is not VT10x (LP-52); affects later spawns and input on existing panes. */
  setKeyMode(mode: string): void {
    this.keyMode = mode;
  }

  get currentKeyMode(): string {
    return this.keyMode;
  }

  // ------------------------------------------------------------ internal

  /** @internal Throws the error a real command would get on a dead server, and fires onGone once. */
  ensureUsable(): void {
    if (this.state === 'crashed') {
      this.fireGone();
      throw new TmuxCrashed('server exited unexpectedly');
    }
    if (this.state === 'killed') throw new TmuxServerGone(`no server running on ${this.socketPath}`);
  }

  /** @internal */
  get crashed(): boolean {
    return this.state === 'crashed';
  }

  private fireGone(): void {
    if (this.goneFired) return;
    this.goneFired = true;
    for (const p of this.panes) p.markRemoved(true);
    for (const l of [...this.goneListeners]) {
      try {
        l();
      } catch {
        /* listener errors never break the fake */
      }
    }
  }
}

export interface FakeInput {
  kind: 'paste' | 'typeLiteral' | 'key';
  text: string;
  key?: TmuxKeyName;
  dropped: boolean;
  at: number;
}

export class FakeTmuxPane implements TmuxPane {
  readonly info: PaneInfo;
  private geom: { cols: number; rows: number } | undefined;
  readonly sessionName: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Every input op in order (dropped keys included with `dropped:true`). */
  readonly inputs: FakeInput[] = [];
  /** Byte chunks the program received, one per read (paste, literal, key). */
  readonly received: string[] = [];
  private readonly fake: FakeTmux;
  private readonly server: FakeTmuxServer;
  private screen: string[];
  private frames: string[][] = [];
  private tornNext = false;
  private previousScreen: string[] | undefined;
  private program: FakeProgram = {};
  private bracketed = false;
  private alternate = false;
  private inMode = false;
  private dead = false;
  private exitStatus: number | null = null;
  private exitSignal: string | null = null;
  private cursorX = 0;
  private cursorY = 0;
  private removedFlag = false;
  private goneFired = false;
  private diedFired = false;
  private readonly diedListeners = new Set<(s: { exitStatus: number | null; exitSignal: string | null }) => void>();
  private readonly goneListeners = new Set<() => void>();

  constructor(fake: FakeTmux, server: FakeTmuxServer, info: PaneInfo, o: PaneSpawnOptions, env: Readonly<Record<string, string>>) {
    this.fake = fake;
    this.server = server;
    this.info = Object.freeze({ ...info });
    this.sessionName = o.sessionName;
    this.argv = [...o.argv];
    this.cwd = o.cwd;
    this.env = env;
    this.screen = Array.from({ length: info.rows }, () => '');
  }

  get removed(): boolean {
    return this.removedFlag;
  }

  // ------------------------------------------------------------ program side

  /** @internal */
  startProgram(p: FakeProgram): void {
    this.program = p;
    p.start?.(this.io());
  }

  private io(): FakePaneIO {
    return {
      argv: this.argv,
      cwd: this.cwd,
      env: this.env,
      paneId: this.info.paneId,
      print: (line) => {
        this.print(line);
      },
      setScreen: (lines) => {
        this.setScreen(lines);
      },
      setBracketedPaste: (on) => {
        this.bracketed = on;
      },
      setAlternate: (on) => {
        this.alternate = on;
      },
      exit: (status, signal) => {
        this.exitPane({ status, signal: signal ?? null });
      },
    };
  }

  private print(line: string): void {
    const firstFree = this.screen.findIndex((l, i) => l === '' && this.screen.slice(i).every((x) => x === ''));
    if (firstFree >= 0) this.screen[firstFree] = line;
    else {
      this.screen.shift();
      this.screen.push(line);
    }
    this.cursorY = Math.min(this.viewRows() - 1, (firstFree >= 0 ? firstFree : this.viewRows() - 1) + 1);
    this.cursorX = 0;
  }

  private deliver(bytes: string): void {
    this.received.push(bytes);
    if (!this.dead) this.program.input?.(bytes, this.io());
  }

  // ------------------------------------------------------------ test controls

  /**
   * Report a different visible geometry from now on (status cols/rows, capture height). Replay uses it to show recorded
   * frames at the size they were captured at (the classifier's rules span the full pane width, P-SCREEN-14). WP-INT, ICR 0016.
   */
  setGeometry(cols: number, rows: number): void {
    this.geom = { cols: Math.max(1, Math.floor(cols)), rows: Math.max(1, Math.floor(rows)) };
    this.screen = Array.from({ length: this.viewRows() }, (_, i) => this.screen[i] ?? '');
  }

  private viewRows(): number {
    return this.geom?.rows ?? this.info.rows;
  }

  /** Replace the visible screen (rows beyond the pane height are dropped, missing rows are blank). */
  setScreen(lines: readonly string[]): void {
    this.previousScreen = this.screen;
    this.screen = Array.from({ length: this.viewRows() }, (_, i) => lines[i] ?? '');
  }

  /** Each later capture() shows the next frame (then the last one stays): e.g. A, B, A within 2 s (K-43). */
  queueFrames(frames: readonly (readonly string[])[]): void {
    for (const f of frames) this.frames.push(Array.from({ length: this.viewRows() }, (_, i) => f[i] ?? ''));
  }

  /** The next capture() returns a torn frame: the top half of the new screen over the bottom half of the previous one. */
  tearNextCapture(): void {
    this.tornNext = true;
  }

  setCursor(x: number, y: number): void {
    this.cursorX = x;
    this.cursorY = y;
  }

  setAlternate(on: boolean): void {
    this.alternate = on;
  }

  enterCopyMode(): void {
    this.inMode = true;
  }

  /** The process exits; with remain-on-exit the pane stays dead and the pane-died record is appended. */
  exitPane(o: { status: number | null; signal?: string | null }): void {
    if (this.dead) return;
    this.dead = true;
    this.exitStatus = o.signal !== undefined && o.signal !== null ? null : o.status;
    this.exitSignal = o.signal ?? null;
    const sig = this.exitSignal === null ? '' : this.exitSignal.replace(/^SIG/, '').toLowerCase();
    this.fake.appendExitLog(
      this.server.paneDiedLogPath,
      `died pane=${this.info.paneId} pid=${this.info.pid} status=${this.exitStatus ?? ''} signal=${sig}`,
    );
    this.screen[this.viewRows() - 1] =
      this.exitSignal !== null ? `Pane is dead (signal ${sig})` : `Pane is dead (status ${this.exitStatus ?? ''})`;
  }

  /** Remove the pane without a death (as if a human ran kill-pane). */
  vanishPane(): void {
    this.markRemoved();
  }

  /** @internal `fire`: emit 'gone' now (server kill/crash noticed), as the real driver does. */
  markRemoved(fire = false): void {
    this.removedFlag = true;
    if (fire) this.fireGone();
  }

  // ------------------------------------------------------------ port: events

  on(e: 'died', fn: (s: { exitStatus: number | null; exitSignal: string | null }) => void): Cancel;
  on(e: 'gone', fn: () => void): Cancel;
  on(e: 'died' | 'gone', fn: ((s: { exitStatus: number | null; exitSignal: string | null }) => void) | (() => void)): Cancel {
    if (e === 'died') {
      const f = fn;
      this.diedListeners.add(f);
      return () => this.diedListeners.delete(f);
    }
    const g = fn as () => void;
    this.goneListeners.add(g);
    return () => this.goneListeners.delete(g);
  }

  private fireGone(): void {
    if (this.goneFired) return;
    this.goneFired = true;
    for (const l of [...this.goneListeners]) {
      try {
        l();
      } catch {
        /* ignored */
      }
    }
  }

  private fireDied(): void {
    if (this.diedFired) return;
    this.diedFired = true;
    const ev = { exitStatus: this.exitStatus, exitSignal: this.exitSignal };
    for (const l of [...this.diedListeners]) {
      try {
        l(ev);
      } catch {
        /* ignored */
      }
    }
  }

  // ------------------------------------------------------------ port: status / output

  private currentStatus(): PaneStatus {
    return {
      exists: true,
      dead: this.dead,
      exitStatus: this.exitStatus,
      exitSignal: this.exitSignal,
      inMode: this.inMode,
      alternateOn: this.alternate,
      cursorX: this.cursorX,
      cursorY: this.cursorY,
      cols: this.geom?.cols ?? this.info.cols,
      rows: this.viewRows(),
      historySize: 0,
    };
  }

  private goneStatus(): PaneStatus {
    return { ...this.currentStatus(), exists: false, inMode: false, alternateOn: false, cursorX: 0, cursorY: 0 };
  }

  /** Throws like the real pane would when the server or the pane is gone; fires 'gone'/'died' as observed. */
  private reach(): void {
    try {
      this.server.ensureUsable();
    } catch (e) {
      this.fireGone();
      throw e;
    }
    if (this.removedFlag) {
      this.fireGone();
      throw new TmuxTargetMissing(this.info.paneId);
    }
    if (this.dead) this.fireDied();
  }

  status(): Promise<PaneStatus> {
    this.fake.record({ op: 'status', paneId: this.info.paneId });
    try {
      const injected = this.fake.takeFailure('status');
      if (injected !== undefined) throw injected;
      this.reach();
      return Promise.resolve(this.currentStatus());
    } catch (e) {
      if (e instanceof TmuxTargetMissing || e instanceof TmuxCrashed || e instanceof TmuxServerGone)
        return Promise.resolve(this.goneStatus());
      return Promise.reject(asError(e));
    }
  }

  capture(o: { styles?: boolean; startRow?: number; endRow?: number } = {}): Promise<Capture> {
    this.fake.record({ op: 'capture', paneId: this.info.paneId });
    try {
      const injected = this.fake.takeFailure('capture');
      if (injected !== undefined) throw injected;
      if (o.startRow !== undefined && !Number.isInteger(o.startRow)) throw new TmuxInvalidInput('badOption', 'startRow must be an integer');
      if (o.endRow !== undefined && !Number.isInteger(o.endRow)) throw new TmuxInvalidInput('badOption', 'endRow must be an integer');
      if (o.startRow !== undefined && o.endRow !== undefined && o.startRow > o.endRow)
        throw new TmuxInvalidInput('badOption', 'startRow > endRow');
      this.reach();
      const next = this.frames.shift();
      if (next !== undefined) {
        this.previousScreen = this.screen;
        this.screen = next;
      }
      let shown = this.screen;
      if (this.tornNext) {
        this.tornNext = false;
        const prev = this.previousScreen ?? Array.from({ length: this.viewRows() }, () => '');
        const half = Math.floor(this.viewRows() / 2);
        shown = [...this.screen.slice(0, half), ...prev.slice(half)];
      }
      const start = Math.max(0, o.startRow ?? 0);
      const end = Math.min(this.viewRows() - 1, o.endRow ?? this.viewRows() - 1);
      const lines = shown.slice(start, end + 1);
      const status = this.currentStatus();
      return Promise.resolve({ lines, status, at: this.fake.clock.now(), hash: captureHash(lines, status) });
    } catch (e) {
      return Promise.reject(asError(e));
    }
  }

  // ------------------------------------------------------------ port: input

  private assertInputReady(): void {
    this.reach();
    if (this.dead) throw new TmuxPaneDead(this.info.paneId, this.exitStatus, this.exitSignal);
    if (this.inMode) throw new TmuxPaneInMode(this.info.paneId);
    const km = this.server.currentKeyMode;
    if (km !== 'VT10x') throw new TmuxUnsupported('extendedKeys', km);
  }

  paste(text: string): Promise<void> {
    this.fake.record({ op: 'paste', paneId: this.info.paneId, text });
    try {
      const injected = this.fake.takeFailure('paste');
      if (injected !== undefined) throw injected;
      if (!isWellFormedString(text)) throw new TmuxInvalidInput('notWellFormed', 'paste text has a lone surrogate');
      const body = normalizePasteText(text);
      if (PASTE_FORBIDDEN.test(body)) throw new TmuxInvalidInput('controlChar', 'paste text may contain only LF and TAB controls');
      if (body === '') return Promise.resolve();
      this.assertInputReady();
      this.inputs.push({ kind: 'paste', text: body, dropped: false, at: this.fake.clock.now() });
      this.deliver(this.bracketed ? `\u001b[200~${body}\u001b[201~` : body);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(asError(e));
    }
  }

  typeLiteral(text: string): Promise<void> {
    this.fake.record({ op: 'typeLiteral', paneId: this.info.paneId, text });
    try {
      const injected = this.fake.takeFailure('typeLiteral');
      if (injected !== undefined) throw injected;
      if (!isWellFormedString(text)) throw new TmuxInvalidInput('notWellFormed', 'literal text has a lone surrogate');
      if (LITERAL_FORBIDDEN.test(text)) throw new TmuxInvalidInput('controlChar', 'literal text must be one line without controls');
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > LITERAL_LIMIT_BYTES) throw new TmuxArgTooLong(bytes, LITERAL_LIMIT_BYTES);
      if (text === '') return Promise.resolve();
      this.assertInputReady();
      this.inputs.push({ kind: 'typeLiteral', text, dropped: false, at: this.fake.clock.now() });
      this.deliver(text);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(asError(e));
    }
  }

  sendKey(k: TmuxKeyName): Promise<void> {
    try {
      if (!isTmuxKeyName(k)) throw new TmuxInvalidInput('unknownKey', `key not in the closed list: ${String(k).slice(0, 16)}`);
      const injected = this.fake.takeFailure('sendKey');
      if (injected !== undefined) {
        this.fake.record({ op: 'sendKey', paneId: this.info.paneId, key: k, dropped: false });
        throw injected;
      }
      this.assertInputReady();
      const dropped = this.fake.takeDrop(k);
      this.fake.record({ op: 'sendKey', paneId: this.info.paneId, key: k, dropped });
      this.inputs.push({ kind: 'key', text: KEY_BYTES[k], key: k, dropped, at: this.fake.clock.now() });
      if (!dropped) this.deliver(KEY_BYTES[k]);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(asError(e));
    }
  }

  exitCopyMode(): Promise<void> {
    this.fake.record({ op: 'exitCopyMode', paneId: this.info.paneId });
    try {
      const injected = this.fake.takeFailure('exitCopyMode');
      if (injected !== undefined) throw injected;
      this.reach();
      this.inMode = false;
      return Promise.resolve();
    } catch (e) {
      // Like the real pane: a missing pane or a gone server has no copy mode to leave.
      if (e instanceof TmuxTargetMissing || e instanceof TmuxCrashed || e instanceof TmuxServerGone) return Promise.resolve();
      return Promise.reject(asError(e));
    }
  }

  killPane(): Promise<void> {
    this.fake.record({ op: 'killPane', paneId: this.info.paneId });
    const injected = this.fake.takeFailure('killPane');
    if (injected !== undefined) return Promise.reject(injected);
    if (this.server.crashed || this.removedFlag) return Promise.resolve();
    this.markRemoved();
    return Promise.resolve();
  }

  viewCommand(): string {
    return viewCommandFor(this.server.tmuxPath, this.server.socketName, this.sessionName);
  }
}
