// platform/process/standalone/owner-watch.ts — per-session owner watchdog (DESIGN.md §3.8, D-28, §4.12 A-8).
// node:* imports ONLY (arch test standalone-imports, §1.4 3c). Spawned detached by owner-watcher.ts as
//   node owner-watch.js <watch.json>
// with stdout/stderr appended to a 0600 log. Every `pollMs` (default 1000):
//   - Claude pid gone                        → append `watch=claude-gone` to the exits log, exit 0.
//   - owner pid gone, or its start time differs (pid reuse) → re-verify Claude's identity (start time + command contains
//     `claude.exe` and our session id, P-LIFE-44), SIGTERM it, wait ≤ 1 s, SIGKILL (identity re-checked first), then
//     `<tmuxBin> -L <socketName> kill-server`, append `watch=owner-gone`, exit 0. A Claude pid that now belongs to another
//     process is never signalled; the private tmux server is still killed (its socket name is ours, P-LIFE-45).
//   - SIGTERM (normal close stops us first) → exit 0 without any action.
// Window during which Claude can run with no hook server: ≤ pollMs + 1 s (P-REV-09, P-HOOK-02, P-SEC-03, P-TMUX-43).
import { execFile } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { argv, exit, getuid, kill, pid as selfPid } from 'node:process';
import { fileURLToPath } from 'node:url';

export interface WatchConfig {
  ownerPid: number;
  ownerStart: string;
  claudePid: number;
  claudeStart: string;
  claudeExeSubstr: string;
  sessionIdSubstr: string;
  tmuxBin: string;
  socketName: string;
  /** Optional, additive: absolute tmux socket path; when present `-S` is used instead of `-L` (immune to TMUX_TMPDIR). */
  socketPath?: string;
  pollMs: number;
  exitsLog: string;
}

const SAFE_PATH = /^\/[A-Za-z0-9/._-]+$/;
const SOCKET_NAME = /^ccd-[A-Za-z0-9._-]+$/;
const PS_TIMEOUT_MS = 2_000;
const TMUX_TIMEOUT_MS = 3_000;
const TERM_GRACE_MS = 1_000;
const DEATH_POLL_MS = 50;

/** Validate watch.json. Returns an error string instead of throwing so the caller can log it. */
export function parseWatchConfig(raw: unknown): WatchConfig | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'config is not an object';
  const r = raw as Record<string, unknown>;
  const int = (k: string): number | undefined => {
    const v = r[k];
    return typeof v === 'number' && Number.isInteger(v) && v > 1 ? v : undefined;
  };
  const str = (k: string): string | undefined => {
    const v = r[k];
    return typeof v === 'string' && v !== '' && !v.includes('\n') && !v.includes('\0') ? v : undefined;
  };
  const ownerPid = int('ownerPid');
  const claudePid = int('claudePid');
  const ownerStart = str('ownerStart');
  const claudeStart = str('claudeStart');
  const claudeExeSubstr = str('claudeExeSubstr');
  const sessionIdSubstr = str('sessionIdSubstr');
  const tmuxBin = str('tmuxBin');
  const socketName = str('socketName');
  const exitsLog = str('exitsLog');
  if (ownerPid === undefined) return 'ownerPid';
  if (claudePid === undefined) return 'claudePid';
  if (ownerPid === claudePid) return 'ownerPid equals claudePid';
  if (ownerStart === undefined) return 'ownerStart';
  if (claudeStart === undefined) return 'claudeStart';
  if (claudeExeSubstr === undefined) return 'claudeExeSubstr';
  if (sessionIdSubstr === undefined) return 'sessionIdSubstr';
  if (tmuxBin === undefined || !isAbsolute(tmuxBin) || !SAFE_PATH.test(tmuxBin)) return 'tmuxBin';
  if (socketName === undefined || !SOCKET_NAME.test(socketName)) return 'socketName';
  if (exitsLog === undefined || !SAFE_PATH.test(exitsLog)) return 'exitsLog';
  const pollRaw = r['pollMs'];
  const pollMs = pollRaw === undefined ? 1_000 : pollRaw;
  if (typeof pollMs !== 'number' || !Number.isInteger(pollMs) || pollMs < 50 || pollMs > 10_000) return 'pollMs';
  const cfg: WatchConfig = {
    ownerPid,
    ownerStart,
    claudePid,
    claudeStart,
    claudeExeSubstr,
    sessionIdSubstr,
    tmuxBin,
    socketName,
    pollMs,
    exitsLog,
  };
  const sp = r['socketPath'];
  if (sp !== undefined) {
    // The -S path must be the socket named by socketName, so -S can never reach another server (P-LIFE-45).
    if (typeof sp !== 'string' || !SAFE_PATH.test(sp) || basename(sp) !== socketName) return 'socketPath';
    cfg.socketPath = sp;
  }
  return cfg;
}

// ---- identity (identical to platform/process/identity.ts; duplicated because standalones import node:* only) ----
// `stat` is read so a zombie (exited, not yet reaped by its parent: kill(pid, 0) still succeeds and lstart is unchanged)
// counts as gone. Without it a SIGKILLed owner whose parent does not reap would never be detected.
const PS_LINE = /^\s*(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*\S)\s*$/;

export function parsePsLine(stdout: string): { state: string; startTime: string; command: string; zombie: boolean } | undefined {
  const line = stdout.split('\n').find((l) => l.trim() !== '');
  if (line === undefined) return undefined;
  const m = PS_LINE.exec(line);
  if (m === null) return undefined;
  const [, state, startTime, command] = m;
  if (state === undefined || startTime === undefined || command === undefined) return undefined;
  return { state, startTime: startTime.replace(/\s+/g, ' '), command, zombie: state.startsWith('Z') };
}

export function parsePsIdentity(stdout: string): { startTime: string; command: string } | undefined {
  const p = parsePsLine(stdout);
  if (p === undefined || p.zombie) return undefined;
  return { startTime: p.startTime, command: p.command };
}

const norm = (s: string): string => s.replace(/\s+/g, ' ');

export function isClaudeIdentity(got: { startTime: string; command: string } | undefined, cfg: WatchConfig): boolean {
  return (
    got !== undefined &&
    norm(got.startTime) === norm(cfg.claudeStart) &&
    got.command.includes(cfg.claudeExeSubstr) &&
    got.command.includes(cfg.sessionIdSubstr)
  );
}

function alive(p: number): boolean {
  try {
    kill(p, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const PS_BIN = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
/** Same as identity.ts PS_ENV: C locale and `TZ=UTC0`, so `lstart` never follows a host time-zone change (ICR 0031). */
export const PS_ENV: Readonly<Record<string, string>> = Object.freeze({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC0', PATH: '/usr/bin:/bin' });

/** `undefined` = no such (live) process, zombies included; `null` = ps itself failed (transient: never treated as a death). */
function psIdentity(p: number): Promise<{ startTime: string; command: string } | undefined | null> {
  return new Promise((res) => {
    execFile(
      PS_BIN,
      ['-ww', '-o', 'stat=,lstart=,command=', '-p', String(p)],
      { env: { ...PS_ENV }, timeout: PS_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        if (err !== null) {
          // ps exits 1 when the pid does not exist; anything else (timeout, spawn failure) is "unknown".
          res(typeof err.code === 'number' && err.code === 1 ? undefined : null);
          return;
        }
        const line = parsePsLine(stdout);
        res(line === undefined ? null : line.zombie ? undefined : { startTime: line.startTime, command: line.command });
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function log(msg: string): void {
  try {
    writeSync(1, `${new Date().toISOString()} owner-watch[${selfPid}] ${msg}\n`);
  } catch {
    // log is best effort
  }
}

function appendExit(cfg: WatchConfig, line: string): void {
  try {
    const fd = openSync(cfg.exitsLog, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    log(`exits log append failed: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}

function killTmuxServer(cfg: WatchConfig): Promise<boolean> {
  const target = cfg.socketPath !== undefined ? ['-S', cfg.socketPath] : ['-L', cfg.socketName];
  return new Promise((res) => {
    execFile(cfg.tmuxBin, [...target, 'kill-server'], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: TMUX_TIMEOUT_MS }, (err) => {
      res(err === null);
    });
  });
}

async function waitDead(p: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(p)) return true;
    await delay(DEATH_POLL_MS);
  }
  return !alive(p);
}

/** Owner gone: kill the verified Claude pid, then the private tmux server. Never throws. */
export async function handleOwnerGone(cfg: WatchConfig): Promise<{ claude: string; server: string }> {
  let claude: string;
  const ident = alive(cfg.claudePid) ? await psIdentity(cfg.claudePid) : undefined;
  if (ident === undefined) claude = 'gone';
  else if (ident === null) claude = 'unverified';
  else if (!isClaudeIdentity(ident, cfg)) claude = 'identity-mismatch';
  else {
    try {
      kill(cfg.claudePid, 'SIGTERM');
    } catch {
      // already gone
    }
    if (await waitDead(cfg.claudePid, TERM_GRACE_MS)) claude = 'terminated';
    else {
      const again = await psIdentity(cfg.claudePid);
      if (again !== null && again !== undefined && isClaudeIdentity(again, cfg)) {
        try {
          kill(cfg.claudePid, 'SIGKILL');
        } catch {
          // already gone
        }
        claude = (await waitDead(cfg.claudePid, TERM_GRACE_MS)) ? 'killed' : 'survived';
      } else claude = 'terminated';
    }
  }
  const server = (await killTmuxServer(cfg)) ? 'killed' : 'kill-failed';
  return { claude, server };
}

export async function runWatch(cfg: WatchConfig): Promise<never> {
  const state = { stopping: false };
  const stop = (sig: string): void => {
    state.stopping = true;
    log(`${sig}: stopping without action`);
    exit(0);
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
  process.on('SIGHUP', () => undefined); // detached; a hangup of the owner's terminal is not an owner death
  log(`watching owner=${cfg.ownerPid} claude=${cfg.claudePid} socket=${cfg.socketName} pollMs=${cfg.pollMs}`);
  for (;;) {
    if (state.stopping) exit(0);
    if (!alive(cfg.claudePid)) {
      appendExit(cfg, `watch=claude-gone at=${new Date().toISOString()} claudePid=${cfg.claudePid} watcher=${selfPid}`);
      log('claude gone; exiting');
      exit(0);
    }
    let ownerGone = !alive(cfg.ownerPid);
    if (!ownerGone) {
      const id = await psIdentity(cfg.ownerPid);
      // A different start time means the owner pid was reused by another process: the owner is gone.
      ownerGone = id === undefined || (id !== null && norm(id.startTime) !== norm(cfg.ownerStart));
    }
    if (ownerGone) {
      log('owner gone; killing claude and the tmux server');
      const r = await handleOwnerGone(cfg);
      appendExit(
        cfg,
        `watch=owner-gone at=${new Date().toISOString()} ownerPid=${cfg.ownerPid} claudePid=${cfg.claudePid} claude=${r.claude} server=${r.server} watcher=${selfPid}`,
      );
      log(`done claude=${r.claude} server=${r.server}`);
      exit(0);
    }
    await delay(cfg.pollMs);
  }
}

/**
 * Read watch.json only if it is a regular file (not a symlink: O_NOFOLLOW), owned by us and not group/world accessible
 * (P-SEC-18: this process kills pids named in it, so nobody else may be able to write it). Error string on failure.
 */
export function readPrivateConfig(path: string): { value: unknown } | string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? 'open failed';
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return 'not a regular file';
    if ((st.mode & 0o077) !== 0) return 'mode must be 0600';
    if (typeof getuid === 'function' && st.uid !== getuid()) return 'not owned by us';
    try {
      return { value: JSON.parse(readFileSync(fd, 'utf8')) };
    } catch {
      return 'invalid JSON';
    }
  } finally {
    closeSync(fd);
  }
}

function main(): void {
  const configPath = argv[2];
  if (configPath === undefined || !isAbsolute(configPath)) {
    log('usage: owner-watch <abs watch.json>');
    exit(2);
  }
  const raw = readPrivateConfig(configPath);
  if (typeof raw === 'string') {
    log(`cannot read config: ${raw}`);
    exit(2);
  }
  const cfg = parseWatchConfig(raw.value);
  if (typeof cfg === 'string') {
    log(`invalid config: ${cfg}`);
    exit(2);
  }
  runWatch(cfg).catch((e: unknown) => {
    log(`crashed: ${e instanceof Error ? e.message : 'unknown'}`);
    exit(1);
  });
}

/** True when this module is the process entry script (unit tests import the pure helpers without running main). */
function isEntry(): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) main();
