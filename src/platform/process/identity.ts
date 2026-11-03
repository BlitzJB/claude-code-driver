// platform/process/identity.ts — pid identity via `ps -o stat=,lstart=,command=` (LC §6.3, P-LIFE-44: macOS reuses pids).
// The owner-watch standalone carries an identical copy of `parsePsLine` (it may import node:* only); the unit tests run
// both against the same inputs.
//
// The `stat` column is read so a zombie counts as "no such process": a SIGKILLed owner whose parent has not reaped it yet
// still answers kill(pid, 0) and keeps its lstart (VERIFIED on macOS: `ZN   Tue Nov  3 07:10:59 2026     <defunct>`), so
// without it the owner-watch / reaper would wait forever for an owner that is already dead.

/**
 * `ps` invocation used everywhere: fixed C locale so `lstart` has one format, `-ww` so `command` is never truncated, and
 * `TZ=UTC0` so `lstart` is rendered in one zone. Without TZ, ps formats the start time in whatever zone /etc/localtime
 * names when it runs, so a time-zone change on a running host (macOS automatic time zone, a user edit) would make every
 * recorded start time mismatch and every live owner look dead (ICR 0031). `UTC0` is POSIX-form and needs no tz database.
 */
export const PS_ARGS = (pid: number): string[] => ['-ww', '-o', 'stat=,lstart=,command=', '-p', String(pid)];
export const PS_ENV: Readonly<Record<string, string>> = Object.freeze({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC0', PATH: '/usr/bin:/bin' });
export const PS_CANDIDATES: readonly string[] = Object.freeze(['/bin/ps', '/usr/bin/ps']);

const PS_LINE = /^\s*(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*\S)\s*$/;

export interface PsLine {
  /** `ps` process state (e.g. `Ss`, `R+`, `Z`). */
  state: string;
  startTime: string;
  command: string;
  /** State `Z`: exited but not yet reaped by its parent. Treat as gone. */
  zombie: boolean;
}

/** Parse the single output line of `ps -ww -o stat=,lstart=,command= -p <pid>`; `undefined` when there is no such line. */
export function parsePsLine(stdout: string): PsLine | undefined {
  const line = stdout.split('\n').find((l) => l.trim() !== '');
  if (line === undefined) return undefined;
  const m = PS_LINE.exec(line);
  if (m === null) return undefined;
  const [, state, startTime, command] = m;
  if (state === undefined || startTime === undefined || command === undefined) return undefined;
  return { state, startTime: startTime.replace(/\s+/g, ' '), command, zombie: state.startsWith('Z') };
}

/** The identity of a LIVE process: `undefined` when there is no such process or it is a zombie. */
export function parsePsIdentity(stdout: string): { startTime: string; command: string } | undefined {
  const p = parsePsLine(stdout);
  if (p === undefined || p.zombie) return undefined;
  return { startTime: p.startTime, command: p.command };
}

/**
 * Identity rule shared by the owner-watch, the reaper and close (LC §6.3): same start time, and the command line contains
 * every required substring (e.g. `claude.exe` and our session id).
 */
export function identityMatches(
  got: { startTime: string; command: string } | undefined,
  want: { startTime: string; mustContain: readonly string[] },
): boolean {
  if (got === undefined) return false;
  if (got.startTime.replace(/\s+/g, ' ') !== want.startTime.replace(/\s+/g, ' ')) return false;
  return want.mustContain.every((s) => s !== '' && got.command.includes(s));
}
