// platform/process/process-port.ts — ProcessPort (DESIGN.md §2.7.1): execFile wrapper, liveness, signals, pid identity,
// detached spawn. Never a shell; the child env is exactly the env passed in (never merged with process.env, D-25).
//   - `killOnTimeout:false` (P-LIFE-38: `claude auth status` killed mid-refresh signs the user out): on timeout the promise
//     resolves with `timedOut:true` and the child keeps running untouched (pipes stay open so it never gets SIGPIPE).
//   - errors carry the file name and errno only, never argv (P-SEC-40, SEC §7.1).
import { execFile, execFileSync, spawn, type ExecFileException } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import type { Clock, MonoMs } from '../../model/time.js';
import type { ExecResult, ProcessPort } from '../ports.js';
import { ProcessSpawnError } from './errors.js';
import { parsePsIdentity, PS_ARGS, PS_CANDIDATES, PS_ENV } from './identity.js';
import { isExecutableFile, which } from './which.js';

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const SYNC_TIMEOUT_MS = 2_000;
const IDENTITY_TIMEOUT_MS = 5_000;
/** killOnTimeout: SIGTERM at the deadline, SIGKILL this much later. */
export const KILL_GRACE_MS = 1_000;

export interface ProcessPortOptions {
  clock: Clock;
  /** PATH used by `which` (default: the host's PATH at construction time). */
  pathEnv?: string;
  maxBuffer?: number;
}

export function createProcessPort(o: ProcessPortOptions): ProcessPort {
  const pathEnv = o.pathEnv ?? process.env['PATH'];
  const maxBuffer = o.maxBuffer ?? DEFAULT_MAX_BUFFER;
  let psPath: string | undefined;

  const exec: ProcessPort['exec'] = (file, args, eo) =>
    new Promise<ExecResult>((resolvePromise, reject) => {
      let settled = false;
      let timedOut = false;
      let cancelTimer: (() => void) | undefined;
      const settle = (f: () => void): void => {
        if (settled) return;
        settled = true;
        cancelTimer?.();
        f();
      };
      const at = (ms: number): MonoMs => (o.clock.now() + Math.max(0, ms)) as MonoMs;
      const child = execFile(
        file,
        [...args],
        {
          env: { ...eo.env },
          ...(eo.cwd !== undefined ? { cwd: eo.cwd } : {}),
          encoding: 'utf8',
          maxBuffer,
          // Timeouts are driven by the injected clock below (Node's own timeout only sends one SIGTERM and then waits
          // forever for a child that ignores it).
          timeout: 0,
          windowsHide: true,
        },
        (err: ExecFileException | null, stdout: string, stderr: string) => {
          settle(() => {
            if (err === null) {
              resolvePromise({ code: 0, signal: null, stdout, stderr, timedOut });
              return;
            }
            if (typeof err.code === 'string' && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              reject(new ProcessSpawnError(file, err.code));
              return;
            }
            resolvePromise({
              code: typeof err.code === 'number' ? err.code : null,
              signal: err.signal ?? null,
              stdout,
              stderr,
              timedOut,
            });
          });
        },
      );
      child.stdin?.on('error', () => undefined); // EPIPE when the child does not read stdin
      if (eo.stdin !== undefined) child.stdin?.end(eo.stdin);
      else child.stdin?.end();
      if (!eo.killOnTimeout) {
        cancelTimer = o.clock.setTimer(at(eo.timeoutMs), () => {
          settle(() => {
            // Leave the child alone: no signal, no pipe teardown. It only stops pinning the event loop.
            child.unref();
            resolvePromise({ code: null, signal: null, stdout: '', stderr: '', timedOut: true });
          });
        });
        return;
      }
      // killOnTimeout: SIGTERM at the deadline, SIGKILL after KILL_GRACE_MS, and a hard resolve after another grace in case
      // a grandchild still holds the pipes open (the exec callback waits for the pipes, not only for the exit).
      cancelTimer = o.clock.setTimer(at(Math.max(1, eo.timeoutMs)), () => {
        timedOut = true;
        child.kill('SIGTERM');
        cancelTimer = o.clock.setTimer(at(KILL_GRACE_MS), () => {
          child.kill('SIGKILL');
          cancelTimer = o.clock.setTimer(at(KILL_GRACE_MS), () => {
            settle(() => {
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.unref();
              resolvePromise({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true });
            });
          });
        });
      });
    });

  const port: ProcessPort = {
    which: (bin, extraDirs) => which(bin, { pathEnv, extraDirs }),

    exec,

    execSyncBestEffort(file, args, env) {
      try {
        execFileSync(file, [...args], { env: { ...env }, stdio: 'ignore', timeout: SYNC_TIMEOUT_MS, windowsHide: true });
      } catch {
        // best effort only (process.on('exit'))
      }
    },

    async spawnDetached(file, args, so) {
      const fd = openSync(so.logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        const child = spawn(file, [...args], {
          env: { ...so.env },
          ...(so.cwd !== undefined ? { cwd: so.cwd } : {}),
          detached: true,
          stdio: ['ignore', fd, fd],
          windowsHide: true,
        });
        await new Promise<void>((res, rej) => {
          child.once('spawn', () => {
            res();
          });
          child.once('error', (e: NodeJS.ErrnoException) => {
            rej(new ProcessSpawnError(file, e.code ?? 'EUNKNOWN'));
          });
        });
        child.unref();
        const pid = child.pid;
        if (pid === undefined) throw new ProcessSpawnError(file, 'ENOPID');
        return { pid };
      } finally {
        closeSync(fd);
      }
    },

    isAlive: (pid) => isPidAlive(pid),

    kill(pid, sig) {
      if (!isSignalablePid(pid)) return false;
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },

    async identity(pid) {
      if (!isSignalablePid(pid)) return undefined;
      psPath ??= await findPs();
      if (psPath === undefined) return undefined;
      try {
        const r = await exec(psPath, PS_ARGS(pid), { env: PS_ENV, timeoutMs: IDENTITY_TIMEOUT_MS, killOnTimeout: true });
        if (r.code !== 0) return undefined;
        return parsePsIdentity(r.stdout);
      } catch {
        return undefined;
      }
    },
  };
  return port;
}

/** pid 0 / negative pids address process groups and 1 is init: never signal those. */
export function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/** `kill(pid, 0)`: EPERM means the process exists but belongs to someone else (alive). */
export function isPidAlive(pid: number): boolean {
  if (!isSignalablePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function findPs(): Promise<string | undefined> {
  for (const p of PS_CANDIDATES) if (await isExecutableFile(p)) return p;
  return undefined;
}
