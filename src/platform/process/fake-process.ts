// platform/process/fake-process.ts — in-memory ProcessPort (DESIGN.md §6.4 "process": version mismatch, auth status,
// pid reuse (identity mismatch), SIGHUP survivor, resume holder). No real process is ever touched.
import type { ExecResult, ProcessPort } from '../ports.js';
import { ProcessSpawnError } from './errors.js';

export interface FakeProc {
  pid: number;
  command: string;
  startTime: string;
  alive: boolean;
  /** Signals this process ignores (e.g. ['SIGHUP'] for a SIGHUP survivor, ['SIGTERM'] for a stubborn Claude). */
  ignores: Set<string>;
  signals: string[];
  exitSignal: string | null;
}

export interface ExecCall {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string | undefined;
  timeoutMs: number;
  killOnTimeout: boolean;
  stdin: string | Uint8Array | undefined;
}

export type ExecHandler = (call: ExecCall) => ExecResult | Promise<ExecResult> | undefined;

export interface SpawnCall {
  pid: number;
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  logPath: string;
  cwd: string | undefined;
}

const START_BASE = Date.UTC(2026, 10, 3, 9, 0, 0);

/** A `ps -o lstart=`-shaped start time (C locale), deterministic per sequence number. */
export function fakeStartTime(seq: number): string {
  const d = new Date(START_BASE + seq * 1_000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] ?? 'Sun';
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] ?? 'Jan';
  const dd = String(d.getUTCDate()).padStart(2, ' ');
  const t = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${day} ${mon} ${dd} ${t} ${d.getUTCFullYear()}`;
}

export class FakeProcess implements ProcessPort {
  readonly procs = new Map<number, FakeProc>();
  readonly execCalls: ExecCall[] = [];
  readonly spawnCalls: SpawnCall[] = [];
  readonly syncCalls: { file: string; args: readonly string[] }[] = [];
  readonly killCalls: { pid: number; sig: string; delivered: boolean }[] = [];
  /** bin name → absolute path for `which`. */
  readonly binaries = new Map<string, string>();
  private handlers: ExecHandler[] = [];
  private exitListeners: ((p: FakeProc) => void)[] = [];
  private nextPid = 40_000;
  private startSeq = 0;

  /** Register a process; returns its pid. */
  addProcess(o: { command: string; pid?: number; startTime?: string; ignores?: readonly string[] }): number {
    const pid = o.pid ?? this.nextPid++;
    this.procs.set(pid, {
      pid,
      command: o.command,
      startTime: o.startTime ?? fakeStartTime(++this.startSeq),
      alive: true,
      ignores: new Set(o.ignores ?? []),
      signals: [],
      exitSignal: null,
    });
    return pid;
  }

  /** The process exits on its own (or is killed by something outside the port). */
  exit(pid: number, signal: string | null = null): void {
    const p = this.procs.get(pid);
    if (!p?.alive) return;
    p.alive = false;
    p.exitSignal = signal;
    for (const l of [...this.exitListeners]) l(p);
  }

  /** macOS pid reuse: the pid now belongs to a different process with a new start time (P-LIFE-44). */
  reusePid(pid: number, command: string): void {
    const old = this.procs.get(pid);
    if (old?.alive === true) this.exit(pid);
    this.procs.set(pid, {
      pid,
      command,
      startTime: fakeStartTime(++this.startSeq + 10_000),
      alive: true,
      ignores: new Set(),
      signals: [],
      exitSignal: null,
    });
  }

  onExit(fn: (p: FakeProc) => void): () => void {
    this.exitListeners.push(fn);
    return () => {
      this.exitListeners = this.exitListeners.filter((x) => x !== fn);
    };
  }

  /** First handler returning a result wins; later registrations take precedence. */
  onExec(h: ExecHandler): () => void {
    this.handlers.unshift(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }

  which(bin: string, _extraDirs: readonly string[]): Promise<string | undefined> {
    return Promise.resolve(this.binaries.get(bin));
  }

  async exec(
    file: string,
    args: readonly string[],
    o: { env: Readonly<Record<string, string>>; cwd?: string; timeoutMs: number; stdin?: string | Uint8Array; killOnTimeout: boolean },
  ): Promise<ExecResult> {
    const call: ExecCall = {
      file,
      args: [...args],
      env: { ...o.env },
      cwd: o.cwd,
      timeoutMs: o.timeoutMs,
      killOnTimeout: o.killOnTimeout,
      stdin: o.stdin,
    };
    this.execCalls.push(call);
    for (const h of this.handlers) {
      const r = await h(call);
      if (r !== undefined) return r;
    }
    throw new ProcessSpawnError(file, 'ENOENT');
  }

  execSyncBestEffort(file: string, args: readonly string[], _env: Readonly<Record<string, string>>): void {
    this.syncCalls.push({ file, args: [...args] });
  }

  spawnDetached(
    file: string,
    args: readonly string[],
    o: { env: Readonly<Record<string, string>>; logPath: string; cwd?: string },
  ): Promise<{ pid: number }> {
    const pid = this.addProcess({ command: [file, ...args].join(' ') });
    this.spawnCalls.push({ pid, file, args: [...args], env: { ...o.env }, logPath: o.logPath, cwd: o.cwd });
    return Promise.resolve({ pid });
  }

  isAlive(pid: number): boolean {
    return this.procs.get(pid)?.alive === true;
  }

  kill(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 'SIGHUP' | 'SIGUSR2'): boolean {
    const p = this.procs.get(pid);
    const delivered = p?.alive === true;
    this.killCalls.push({ pid, sig, delivered });
    if (!p?.alive) return false;
    p.signals.push(sig);
    if (sig === 'SIGKILL' || !p.ignores.has(sig)) this.exit(pid, sig);
    return true;
  }

  identity(pid: number): Promise<{ startTime: string; command: string } | undefined> {
    const p = this.procs.get(pid);
    return Promise.resolve(p?.alive === true ? { startTime: p.startTime, command: p.command } : undefined);
  }
}
