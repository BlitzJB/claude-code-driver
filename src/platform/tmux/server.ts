// platform/tmux/server.ts — TmuxServerFactory / TmuxServer: probe, prelude, spawnPane, kill, socket cleanup (DESIGN.md §2.7.3).
//
// One private server per ClaudeSession (D-07, P-TMUX-40). execFile only, no control-mode client (rev 2 §10 C1).
// The server prelude and the pane creation run in ONE invocation, because `start-server` alone exits as soon as its command
// list ends and because options must exist before the window does (TD R5/R6, D-09):
//
//   start-server ; set -s escape-time 10 ; set -s focus-events off ; set -s set-clipboard off ; set -s extended-keys off ;
//   set -g history-limit H ; set -g remain-on-exit on ; set -g status off ; set -g mouse off ;
//   set -g default-terminal tmux-256color ; [3.3+] set -g allow-passthrough off ;
//   new-session -d -P -F '#{session_id} #{window_id} #{pane_id} #{pane_pid}' -s ccd-<key> -c <cwd> -x C -y R [-e K=V …] -- argv… ;
//   set -w -t =ccd-<key>: window-size manual ; set -w -t =ccd-<key>: remain-on-exit on ; set -t =ccd-<key>: status off ;
//   set-hook -t =ccd-<key>: pane-died "run-shell 'echo died pane=… >> <exitsLog>'"
//
// Pitfalls: P-TMUX-17 (window-size only per window, never global), P-TMUX-18/19 (manual size, status off, verify size after
// spawn), P-TMUX-20 (remain-on-exit globally and in the same invocation), P-TMUX-22 (history-limit before the window),
// P-TMUX-23 (the server env is the client env of this invocation = the full child env; non-secret extras via -e),
// P-TMUX-25 (-c always), P-TMUX-37/P-LIFE-12 (pane-died run-shell exit record), P-TMUX-38/39/60 (short fresh socket names,
// socket unlinked on kill, wait ≤ 1 s for the socket to close), P-TMUX-41/42 (PATH + known dirs, ≥ 3.2), P-TMUX-47
// (focus-events off), P-TMUX-48/P-REV-28 (allow-passthrough off, set-clipboard off), P-REV-44/LP-52 (extended-keys off +
// `#{pane_key_mode}` must be VT10x after spawn → TmuxUnsupported{reason:'extendedKeys'}).

import { constants as fsConstants, rmSync } from 'node:fs';
import { access, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Logger } from '../../model/logger.js';
import type { Cancel, Clock } from '../../model/time.js';
import type { PaneId, PaneSpawnOptions, TmuxPane, TmuxServer, TmuxServerFactory } from '../ports.js';
import { commandList, ENV_NAME_RE, exactTarget, SAFE_PATH_RE, SESSION_NAME_RE, type CommandSpec } from './args.js';
import {
  isServerGoneError,
  TmuxDuplicate,
  TmuxInvalidInput,
  TmuxNotFound,
  TmuxSocketPathTooLong,
  TmuxSpawnFailed,
  TmuxUnsupported,
  TmuxVersionUnsupported,
} from './errors.js';
import { assertSocketName, nodeExecFile, nodeExecFileSync, TmuxExec, type ExecFileFn, type ExecFileSyncFn } from './exec.js';
import { TmuxPaneImpl, type PaneHost } from './pane.js';
import { featuresOf, isSupportedVersion, MIN_TMUX_VERSION, parseTmuxVersion, type TmuxFeatures, type TmuxVersion } from './version.js';

/** TD rule 19: GUI/launchd/cron PATHs often lack Homebrew. */
const KNOWN_TMUX_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] as const;
/** Same margin the runtime dir uses for its sockets (macOS sun_path 104, Linux 108). */
export const SOCKET_PATH_LIMIT = 100;
const SOCKET_GONE_WAIT_MS = 1000;
const SOCKET_GONE_POLL_MS = 50;
const MAX_PANE_DIM = 10_000; // TD §5.1: `width too large` above 10000

/** Filesystem operations the driver needs (injectable for unit tests). */
export interface TmuxFs {
  isExecutableFile(path: string): Promise<boolean>;
  rmForce(path: string): Promise<void>;
  rmForceSync(path: string): void;
  /** realpath(3) of an existing directory; the input unchanged when it cannot be resolved. tmux resolves its socket base
   * dir the same way (macOS: /tmp → /private/tmp), so the length guard must measure the resolved path. */
  realpathOr(path: string): Promise<string>;
}

const nodeTmuxFs: TmuxFs = {
  async isExecutableFile(path) {
    try {
      await access(path, fsConstants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  async rmForce(path) {
    await rm(path, { force: true });
  },
  rmForceSync(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  },
  async realpathOr(path) {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  },
};

export interface TmuxDeps {
  clock: Clock;
  /** Environment used to search `$PATH` in probe() (the library's own env snapshot). */
  env?: Readonly<Record<string, string>>;
  execFile?: ExecFileFn;
  execFileSync?: ExecFileSyncFn;
  fs?: TmuxFs;
  /** getuid(): the default socket dir is `${TMUX_TMPDIR:-/tmp}/tmux-<uid>`. */
  uid?: number;
  logger?: Logger;
  timeoutMs?: number;
}

function defaultUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

export function createTmuxServerFactory(deps: TmuxDeps): TmuxServerFactory {
  return new RealTmuxServerFactory(deps);
}

class RealTmuxServerFactory implements TmuxServerFactory {
  private readonly versions = new Map<string, TmuxVersion>();
  constructor(private readonly deps: TmuxDeps) {}

  private get fs(): TmuxFs {
    return this.deps.fs ?? nodeTmuxFs;
  }

  private candidates(tmuxPath: string | undefined): string[] {
    if (tmuxPath !== undefined && isAbsolute(tmuxPath)) return [tmuxPath];
    const name = tmuxPath ?? 'tmux';
    if (name.includes('/')) throw new TmuxInvalidInput('badOption', 'tmux path must be absolute or a bare command name');
    const pathDirs = (this.deps.env?.['PATH'] ?? '').split(':').filter((d) => d !== '' && isAbsolute(d));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of [...pathDirs, ...KNOWN_TMUX_DIRS]) {
      const p = join(d, name);
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }

  async probe(tmuxPath?: string): Promise<{ path: string; version: string }> {
    const candidates = this.candidates(tmuxPath);
    let found: string | undefined;
    for (const c of candidates) {
      if (await this.fs.isExecutableFile(c)) {
        found = c;
        break;
      }
    }
    if (found === undefined) throw new TmuxNotFound(candidates);
    const v = await this.readVersion(found);
    return { path: found, version: v.raw };
  }

  private async readVersion(path: string): Promise<TmuxVersion> {
    const cached = this.versions.get(path);
    if (cached !== undefined) return cached;
    const r = await (this.deps.execFile ?? nodeExecFile)(path, ['-V'], {
      env: this.deps.env ?? {},
      timeoutMs: this.deps.timeoutMs ?? 5000,
      maxBuffer: 64 * 1024,
    });
    if (r.errorCode === 'ENOENT' || r.errorCode === 'EACCES') throw new TmuxNotFound([path]);
    const text = r.stdout.trim();
    const v = parseTmuxVersion(text);
    if (r.code !== 0 || v === undefined)
      throw new TmuxVersionUnsupported(text === '' ? 'unknown' : text.replace(/^tmux\s+/, ''), MIN_TMUX_VERSION);
    if (!isSupportedVersion(v)) throw new TmuxVersionUnsupported(v.raw, MIN_TMUX_VERSION);
    this.versions.set(path, v);
    return v;
  }

  async create(o: {
    tmuxPath: string;
    socketName: string;
    clientEnv: Readonly<Record<string, string>>;
    historyLimit: number;
    paneDiedLogPath: string;
  }): Promise<TmuxServer> {
    assertSocketName(o.socketName);
    if (!isAbsolute(o.tmuxPath)) throw new TmuxInvalidInput('badOption', 'tmuxPath must be absolute (use probe())');
    if (!isAbsolute(o.paneDiedLogPath) || !SAFE_PATH_RE.test(o.paneDiedLogPath))
      throw new TmuxInvalidInput('badOption', `paneDiedLogPath must be absolute and match ${String(SAFE_PATH_RE)}`);
    if (!Number.isInteger(o.historyLimit) || o.historyLimit < 0 || o.historyLimit > 10_000_000)
      throw new TmuxInvalidInput('badOption', 'historyLimit must be an integer in [0, 10000000]');
    const version = await this.readVersion(o.tmuxPath);
    const tmpDir = o.clientEnv['TMUX_TMPDIR'];
    const baseDir = await this.fs.realpathOr(tmpDir !== undefined && tmpDir !== '' ? tmpDir : '/tmp');
    const socketPath = join(baseDir, `tmux-${this.deps.uid ?? defaultUid()}`, o.socketName);
    const bytes = Buffer.byteLength(socketPath, 'utf8');
    if (bytes > SOCKET_PATH_LIMIT) throw new TmuxSocketPathTooLong(bytes, SOCKET_PATH_LIMIT);
    const exec = new TmuxExec({
      tmuxPath: o.tmuxPath,
      socketName: o.socketName,
      env: o.clientEnv,
      execFile: this.deps.execFile ?? nodeExecFile,
      execFileSync: this.deps.execFileSync ?? nodeExecFileSync,
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}),
    });
    // P-TMUX-60: a fresh name must not reach a live server (ours from an earlier session, or anyone else's).
    try {
      await exec.run(commandList([{ name: 'list-sessions', flags: [['-F', '#{session_id}']] }]));
      throw new TmuxDuplicate(`socket ${o.socketName} already has a running server`);
    } catch (e) {
      if (!isServerGoneError(e)) throw e;
    }
    return new RealTmuxServer({
      exec,
      clock: this.deps.clock,
      fs: this.fs,
      version,
      socketPath,
      historyLimit: o.historyLimit,
      paneDiedLogPath: o.paneDiedLogPath,
      logger: this.deps.logger,
    });
  }
}

interface ServerInit {
  exec: TmuxExec;
  clock: Clock;
  fs: TmuxFs;
  version: TmuxVersion;
  socketPath: string;
  historyLimit: number;
  paneDiedLogPath: string;
  logger: Logger | undefined;
}

/** The pane-died exit record (§3.8). The path is validated by SAFE_PATH_RE, so it needs no shell quoting. */
export function paneDiedHookCommand(logPath: string): string {
  if (!SAFE_PATH_RE.test(logPath)) throw new TmuxInvalidInput('badOption', 'unsafe pane-died log path');
  return `run-shell 'echo died pane=#{pane_id} pid=#{pane_pid} status=#{pane_dead_status} signal=#{pane_dead_signal} >> ${logPath}'`;
}

/** Server options set before the session exists (TD R5; LP-52; §10 G16). */
export function preludeCommands(historyLimit: number, features: TmuxFeatures): CommandSpec[] {
  const s = (name: string, value: string): CommandSpec => ({ name: 'set-option', flags: [['-s']], positional: [name, value] });
  const g = (name: string, value: string): CommandSpec => ({ name: 'set-option', flags: [['-g']], positional: [name, value] });
  const cmds: CommandSpec[] = [{ name: 'start-server' }, s('escape-time', '10'), s('focus-events', 'off'), s('set-clipboard', 'off')];
  if (features.extendedKeys) cmds.push(s('extended-keys', 'off'));
  cmds.push(
    g('history-limit', String(historyLimit)),
    g('remain-on-exit', 'on'),
    g('status', 'off'),
    g('mouse', 'off'),
    g('default-terminal', 'tmux-256color'),
  );
  if (features.allowPassthrough) cmds.push(g('allow-passthrough', 'off'));
  return cmds;
}

const SPAWN_FORMAT = '#{session_id} #{window_id} #{pane_id} #{pane_pid}';
const VERIFY_FORMAT = '#{pane_id}|#{pane_width}|#{pane_height}|#{pane_key_mode}|#{socket_path}';

export function validateSpawn(o: PaneSpawnOptions): void {
  if (!SESSION_NAME_RE.test(o.sessionName)) throw new TmuxInvalidInput('badOption', `sessionName must match ${String(SESSION_NAME_RE)}`);
  // P-TMUX-24: a single-element argv would run through `default-shell -c`; the type demands ≥ 2, the runtime checks too.
  if ((o.argv as readonly string[]).length < 2) throw new TmuxInvalidInput('badOption', 'argv needs at least 2 elements');
  if (!isAbsolute(o.argv[0])) throw new TmuxInvalidInput('badOption', 'argv[0] must be an absolute path');
  for (const a of o.argv) if (a.includes('\0')) throw new TmuxInvalidInput('controlChar', 'argv element contains NUL');
  if (!isAbsolute(o.cwd)) throw new TmuxInvalidInput('badOption', 'cwd must be absolute');
  for (const [dim, v] of [
    ['cols', o.cols],
    ['rows', o.rows],
  ] as const)
    if (!Number.isInteger(v) || v < 1 || v > MAX_PANE_DIM)
      throw new TmuxInvalidInput('badOption', `${dim} must be an integer in [1, ${MAX_PANE_DIM}]`);
  for (const [k, v] of Object.entries(o.nonSecretEnv)) {
    if (!ENV_NAME_RE.test(k)) throw new TmuxInvalidInput('badOption', `invalid env name: ${k.slice(0, 40)}`);
    if (v.includes('\0')) throw new TmuxInvalidInput('controlChar', `env ${k} contains NUL`);
  }
}

/** The single spawn invocation (prelude + new-session + per-window options + pane-died hook). */
export function spawnCommands(o: PaneSpawnOptions, historyLimit: number, features: TmuxFeatures, paneDiedLogPath: string): CommandSpec[] {
  const t = exactTarget(o.sessionName);
  const flags: (readonly [string] | readonly [string, string])[] = [
    ['-d'],
    ['-P'],
    ['-F', SPAWN_FORMAT],
    ['-s', o.sessionName],
    ['-c', o.cwd],
    ['-x', String(o.cols)],
    ['-y', String(o.rows)],
  ];
  for (const [k, v] of Object.entries(o.nonSecretEnv)) flags.push(['-e', `${k}=${v}`]);
  return [
    ...preludeCommands(historyLimit, features),
    { name: 'new-session', flags, positional: [...o.argv], endOfFlags: true },
    { name: 'set-option', flags: [['-w'], ['-t', t]], positional: ['window-size', 'manual'] },
    { name: 'set-option', flags: [['-w'], ['-t', t]], positional: ['remain-on-exit', 'on'] },
    { name: 'set-option', flags: [['-t', t]], positional: ['status', 'off'] },
    { name: 'set-hook', flags: [['-t', t]], positional: ['pane-died', paneDiedHookCommand(paneDiedLogPath)] },
  ];
}

export function parseSpawnOutput(out: string): { sessionId: string; windowId: string; paneId: PaneId; pid: number } | undefined {
  for (const line of out.split('\n')) {
    const m = /^(\$\d+) (@\d+) (%\d+) (\d+)$/.exec(line.trim());
    if (m !== null) return { sessionId: m[1] ?? '', windowId: m[2] ?? '', paneId: (m[3] ?? '%0') as PaneId, pid: Number(m[4]) };
  }
  return undefined;
}

class RealTmuxServer implements TmuxServer, PaneHost {
  readonly socketName: string;
  readonly version: string;
  readonly tmuxPath: string;
  readonly exec: TmuxExec;
  readonly clock: Clock;
  readonly features: TmuxFeatures;
  readonly logger: Logger | undefined;
  private socketPathValue: string;
  private readonly computedSocketPath: string;
  private readonly fs: TmuxFs;
  private readonly historyLimit: number;
  private readonly paneDiedLogPath: string;
  private readonly panes = new Set<TmuxPaneImpl>();
  private readonly goneListeners = new Set<() => void>();
  private killedFlag = false;
  private goneFired = false;

  constructor(i: ServerInit) {
    this.exec = i.exec;
    this.clock = i.clock;
    this.fs = i.fs;
    this.socketName = i.exec.socketName;
    this.tmuxPath = i.exec.tmuxPath;
    this.version = i.version.raw;
    this.features = featuresOf(i.version);
    this.socketPathValue = i.socketPath;
    this.computedSocketPath = i.socketPath;
    this.historyLimit = i.historyLimit;
    this.paneDiedLogPath = i.paneDiedLogPath;
    this.logger = i.logger;
  }

  get socketPath(): string {
    return this.socketPathValue;
  }

  get killed(): boolean {
    return this.killedFlag;
  }

  serverGone(): void {
    if (this.killedFlag || this.goneFired) return;
    this.goneFired = true;
    for (const p of this.panes) p.markGone();
    for (const l of [...this.goneListeners]) {
      try {
        l();
      } catch (err) {
        this.logger?.warn('tmux server gone listener threw', { error: String(err) });
      }
    }
  }

  onGone(fn: () => void): Cancel {
    this.goneListeners.add(fn);
    return () => this.goneListeners.delete(fn);
  }

  private async run(cmds: readonly CommandSpec[]): Promise<string> {
    try {
      return await this.exec.run(commandList(cmds));
    } catch (e) {
      if (isServerGoneError(e)) this.serverGone();
      throw e;
    }
  }

  private async killSessionQuietly(sessionName: string): Promise<void> {
    try {
      await this.exec.run(commandList([{ name: 'kill-session', flags: [['-t', `=${sessionName}`]] }]));
    } catch {
      /* already gone */
    }
  }

  /** True while a pane this server spawned under `sessionName` has not been observed gone. */
  private holdsSessionName(sessionName: string): boolean {
    for (const p of this.panes) if (p.sessionNameValue === sessionName && !p.isGone) return true;
    return false;
  }

  async spawnPane(o: PaneSpawnOptions): Promise<TmuxPane> {
    if (this.killedFlag || this.goneFired) throw new TmuxSpawnFailed('paneMissing', 'server was killed or is gone');
    validateSpawn(o);
    let out: string;
    try {
      out = await this.run(spawnCommands(o, this.historyLimit, this.features, this.paneDiedLogPath));
    } catch (e) {
      // A failure after new-session (option or hook) leaves a half-configured session behind: remove it. Never for
      // `duplicate session`: that session is someone else's (killing it can also take the whole server down via
      // exit-empty, VERIFIED 3.5a), and never for a name one of our live panes still holds.
      if (!isServerGoneError(e) && !(e instanceof TmuxDuplicate) && !this.holdsSessionName(o.sessionName))
        await this.killSessionQuietly(o.sessionName);
      throw e;
    }
    const spawned = parseSpawnOutput(out);
    if (spawned === undefined) {
      await this.killSessionQuietly(o.sessionName);
      throw new TmuxSpawnFailed('unparsableOutput', 'new-session -P output not recognised');
    }
    let v = await this.verify(spawned.paneId);
    if (v === undefined) throw new TmuxSpawnFailed('paneMissing', `pane ${spawned.paneId} vanished right after spawn`);
    if (v.cols !== o.cols || v.rows !== o.rows) {
      // TD R7: pin the size again (resize-window also switches the window to manual).
      await this.run([
        {
          name: 'resize-window',
          flags: [
            ['-t', spawned.paneId],
            ['-x', String(o.cols)],
            ['-y', String(o.rows)],
          ],
        },
      ]);
      v = await this.verify(spawned.paneId);
      if (v?.cols !== o.cols || v.rows !== o.rows) {
        await this.killSessionQuietly(o.sessionName);
        throw new TmuxSpawnFailed('sizeMismatch', `wanted ${o.cols}x${o.rows}, got ${v?.cols ?? 0}x${v?.rows ?? 0}`);
      }
    }
    // LP-52 / P-REV-44: Enter must stay a plain CR. Where the format exists it must read VT10x.
    if ((v.keyMode !== '' && v.keyMode !== 'VT10x') || (v.keyMode === '' && this.features.paneKeyMode)) {
      await this.killSessionQuietly(o.sessionName);
      throw new TmuxUnsupported('extendedKeys', v.keyMode === '' ? '(empty)' : v.keyMode);
    }
    if (v.socketPath !== '') this.socketPathValue = v.socketPath;
    const pane = new TmuxPaneImpl(
      this,
      { paneId: spawned.paneId, sessionId: spawned.sessionId, windowId: spawned.windowId, pid: spawned.pid, cols: v.cols, rows: v.rows },
      o.sessionName,
    );
    this.panes.add(pane);
    return pane;
  }

  private async verify(paneId: PaneId): Promise<{ cols: number; rows: number; keyMode: string; socketPath: string } | undefined> {
    const out = await this.run([
      {
        name: 'list-panes',
        flags: [
          ['-t', paneId],
          ['-F', VERIFY_FORMAT],
        ],
      },
    ]);
    for (const line of out.split('\n')) {
      const f = line.split('|');
      if (f.length === 5 && f[0] === paneId) return { cols: Number(f[1]), rows: Number(f[2]), keyMode: f[3] ?? '', socketPath: f[4] ?? '' };
    }
    return undefined;
  }

  async kill(): Promise<void> {
    this.killedFlag = true;
    try {
      await this.exec.run(commandList([{ name: 'kill-server' }]));
    } catch (e) {
      if (!isServerGoneError(e)) this.logger?.warn('tmux kill-server failed', { error: String(e) });
    }
    // P-TMUX-60 / TD R19: wait (≤ 1 s) until the server no longer answers before the socket file is removed.
    const deadline = this.clock.now() + SOCKET_GONE_WAIT_MS;
    for (;;) {
      try {
        await this.exec.run(commandList([{ name: 'list-sessions', flags: [['-F', '#{session_id}']] }]));
      } catch {
        break; // no server running / error connecting (or anything else: it is not answering)
      }
      if (this.clock.now() >= deadline) {
        this.logger?.warn('tmux server still answering 1 s after kill-server', { socket: this.socketName });
        break;
      }
      await this.clock.sleep(SOCKET_GONE_POLL_MS);
    }
    await this.fs.rmForce(this.socketPathValue);
    if (this.computedSocketPath !== this.socketPathValue) await this.fs.rmForce(this.computedSocketPath);
    for (const p of this.panes) p.markGone();
  }

  killSync(): void {
    this.killedFlag = true;
    this.exec.runSyncBestEffort(commandList([{ name: 'kill-server' }]));
    this.fs.rmForceSync(this.socketPathValue);
    if (this.computedSocketPath !== this.socketPathValue) this.fs.rmForceSync(this.computedSocketPath);
  }
}
