// platform/tmux/exec.ts — run(args, {stdin}) for one private tmux server (DESIGN.md §2.7.3, D-07; TD R1–R4).
//
// Every invocation is `execFile(tmux, ['-u', '-L', <socket>, '-f', '/dev/null', ...args])`:
//   -u            force UTF-8 regardless of the (launchd/cron) locale (P-TMUX-49)
//   -L <socket>   never the caller's server via $TMUX (P-TMUX-01); a short name, never `-S <path>` (P-TMUX-38)
//   -f /dev/null  the user's ~/.tmux.conf never changes keys, escape-time, history, extended-keys, mouse (P-TMUX-02, P-TMUX-46)
// No shell (P-TMUX-03), env without TMUX/TMUX_PANE, timeout 5 s, maxBuffer 16 MiB, argv ≤ 12 KiB (P-TMUX-06).

import { execFile, execFileSync } from 'node:child_process';
import type { Logger } from '../../model/logger.js';
import { argvBytes, commandNames, SOCKET_NAME_RE, toArgv, type TmuxArg } from './args.js';
import { ARG_LIMIT_BYTES, mapTmuxFailure, TmuxCommandFailed, TmuxInvalidInput, TmuxNotFound, type TmuxError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const CONFIG_FILE = '/dev/null';

export interface RawExecResult {
  /** Exit code; null when killed by a signal or when the binary could not be started. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Node error code when the process could not run (`ENOENT`, `EACCES`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`). */
  errorCode?: string;
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  o: { env: Readonly<Record<string, string>>; timeoutMs: number; maxBuffer: number; stdin?: string },
) => Promise<RawExecResult>;

export type ExecFileSyncFn = (
  file: string,
  args: readonly string[],
  o: { env: Readonly<Record<string, string>>; timeoutMs: number },
) => void;

/** The real runner: `child_process.execFile` (no shell); stdin is written and closed at once so tmux never waits on it. */
export const nodeExecFile: ExecFileFn = (file, args, o) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { env: { ...o.env }, timeout: o.timeoutMs, maxBuffer: o.maxBuffer, encoding: 'utf8', killSignal: 'SIGKILL', windowsHide: true },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ code: 0, signal: null, stdout, stderr, timedOut: false });
          return;
        }
        const e = err as Error & { code?: unknown; killed?: boolean; signal?: string | null };
        const code = typeof e.code === 'number' ? e.code : null;
        const errorCode = typeof e.code === 'string' ? e.code : undefined;
        const timedOut = e.killed === true && errorCode === undefined && code === null;
        resolve({
          code,
          signal: e.signal ?? null,
          stdout,
          stderr,
          timedOut,
          ...(errorCode !== undefined ? { errorCode } : {}),
        });
      },
    );
    child.stdin?.on('error', () => {
      /* EPIPE when tmux exits before reading stdin: the exit status reports the real failure */
    });
    child.stdin?.end(o.stdin ?? '');
  });

export const nodeExecFileSync: ExecFileSyncFn = (file, args, o) => {
  execFileSync(file, [...args], { env: { ...o.env }, timeout: o.timeoutMs, stdio: 'ignore', killSignal: 'SIGKILL', windowsHide: true });
};

/** P-TMUX-01/P-TMUX-26: the tmux *client* env never carries the caller's TMUX/TMUX_PANE. */
export function sanitizeClientEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (k !== 'TMUX' && k !== 'TMUX_PANE') out[k] = v;
  return out;
}

/** Prepended to every invocation (R1). */
export function baseArgs(socketName: string): string[] {
  return ['-u', '-L', socketName, '-f', CONFIG_FILE];
}

export function assertSocketName(socketName: string): void {
  if (!SOCKET_NAME_RE.test(socketName)) throw new TmuxInvalidInput('badOption', `socket name must match ${String(SOCKET_NAME_RE)}`);
}

export interface TmuxExecOptions {
  tmuxPath: string;
  socketName: string;
  env: Readonly<Record<string, string>>;
  execFile?: ExecFileFn;
  execFileSync?: ExecFileSyncFn;
  timeoutMs?: number;
  maxBuffer?: number;
  logger?: Logger;
}

/** Runs commands against one private server. Stateless apart from the configuration. */
export class TmuxExec {
  readonly tmuxPath: string;
  readonly socketName: string;
  readonly env: Readonly<Record<string, string>>;
  private readonly execFileFn: ExecFileFn;
  private readonly execFileSyncFn: ExecFileSyncFn;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly logger: Logger | undefined;

  constructor(o: TmuxExecOptions) {
    assertSocketName(o.socketName);
    this.tmuxPath = o.tmuxPath;
    this.socketName = o.socketName;
    this.env = Object.freeze(sanitizeClientEnv(o.env));
    this.execFileFn = o.execFile ?? nodeExecFile;
    this.execFileSyncFn = o.execFileSync ?? nodeExecFileSync;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = o.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.logger = o.logger;
  }

  /** Full argv for an arg list (exported for tests and the sync path). */
  argv(args: readonly TmuxArg[]): string[] {
    return [...baseArgs(this.socketName), ...toArgv(args)];
  }

  /**
   * Run one invocation. Resolves with stdout; rejects with a typed TmuxError.
   * `stdin` is the only channel for user text of unbounded size (load-buffer -, P-TMUX-06/P-TMUX-59).
   */
  async run(args: readonly TmuxArg[], o: { stdin?: string } = {}): Promise<string> {
    const argv = this.argv(args);
    const bytes = argvBytes(argv);
    const commands = commandNames(args);
    if (bytes > ARG_LIMIT_BYTES)
      throw mapTmuxFailure({ code: null, stderr: 'command too long', commands, timedOut: false, argvBytes: bytes });
    const r = await this.execFileFn(this.tmuxPath, argv, {
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxBuffer: this.maxBuffer,
      ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    });
    if (r.errorCode === 'ENOENT') throw new TmuxNotFound([this.tmuxPath]);
    if (r.code === 0 && !r.timedOut) return r.stdout;
    const err: TmuxError =
      r.errorCode !== undefined && r.errorCode !== 'ENOENT'
        ? new TmuxCommandFailed(r.code, `${r.errorCode} ${r.stderr}`.trim(), commands, r.timedOut)
        : mapTmuxFailure({ code: r.code, stderr: r.stderr, commands, timedOut: r.timedOut, argvBytes: bytes });
    this.logger?.debug('tmux command failed', { commands, code: r.code, kind: err.kind });
    throw err;
  }

  /** Synchronous best effort (process 'exit' handler only). Never throws. */
  runSyncBestEffort(args: readonly TmuxArg[], timeoutMs = 2000): void {
    try {
      this.execFileSyncFn(this.tmuxPath, this.argv(args), { env: this.env, timeoutMs });
    } catch {
      /* best effort */
    }
  }
}
