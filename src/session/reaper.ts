// session/reaper.ts — reap logic shared by `start()` and `ccd lifecheck` (DESIGN.md §3.8, D-28, rev 2 §10 G21).
//
// Under the registry lock, for each `sessions/*.json` whose owner is dead (pid gone, or the pid now has another start time):
// verify Claude's pid identity (start time + command contains `claude.exe` and the argv session id), SIGTERM, wait ≤ 12 s,
// SIGKILL (identity re-checked), `tmux -S <socketPath> kill-server` (one SIGHUP), unlink that socket, unseed trust if we added
// it, remove the session dir, archive. Socket sweep: only sockets named by a `sessions/` or `archive/` entry whose server fails
// `list-sessions` (2 s) on two attempts 5 s apart are unlinked; a `ccd-*` socket with no registry entry is never touched, only
// counted (other agents and tests use `ccd-` names).
//
// Pitfalls handled here (§5): P-TMUX-39 (stale sockets), P-LIFE-44 (macOS pid reuse), P-LIFE-45 / P-REV-33 (never touch other
// servers), P-REV-34 (only absolute registry paths are used), P-REV-46 (reaper on every start; heartbeats in owners/),
// P-LIFE-11 (verify gone, escalate), P-LIFE-08 (SIGTERM first, generous grace), P-TMUX-61 (kill-server sends one SIGHUP: a
// record written `launching` before the spawn has no Claude pid yet, so the pane pids are read from that server and each
// identity-matching Claude is terminated before kill-server).

import type { SessionKey } from '../model/ids.js';
import type { Logger } from '../model/logger.js';
import type { Clock, WallMs } from '../model/time.js';
import type { ClaudeConfigPort, EnvPort, ProcessPort, RuntimeDirPort } from '../platform/ports.js';
import type { RegistryStore, SessionRecord } from './registry-store.js';

const REAP_TERM_GRACE_MS = 12_000;
const REAP_POLL_MS = 100;
const SOCKET_PROBE_TIMEOUT_MS = 2_000;
const SOCKET_PROBE_GAP_MS = 5_000;
const OWNER_HUNG_MS = 60_000;
const TMUX_KILL_TIMEOUT_MS = 3_000;
const SAFE_ABS = /^\/[A-Za-z0-9/._-]+$/;
const CCD_SOCKET = /^ccd-[A-Za-z0-9._-]+$/;

export interface ClaudeIdentity {
  pid: number;
  startTime: string;
  /** Substring the command must contain (the exe basename, `claude.exe`). */
  exeSubstr: string;
  /** The argv session id (`--session-id` / `--resume`). */
  sessionId: string;
}

export type IdentityVerdict = 'match' | 'gone' | 'mismatch';

/** A recorded global config path we accept to edit: absolute, Claude's file name (`.claude.json`, legacy `.config.json`). */
const CONFIG_FILE = /^\/(?:[^\0]*\/)?\.(?:claude|config)\.json$/;

/** The global config file a record's trust decision applies to; a record of an older writer (none recorded) → `fallback`. */
function recordConfigPath(p: unknown, fallback: string): string {
  return typeof p === 'string' && CONFIG_FILE.test(p) && !p.split('/').includes('..') ? p : fallback;
}

/**
 * D-19 / P-SEC-15 with concurrent sessions (ICR 0022): a session that is done with its workspace releases the trust key the
 * library seeded there. The key is library-owned when this session's record (or `ownedHint`, the in-memory flag) says it
 * added it, or when `trust-seeds.json` lists the workspace. It is removed only when no other `sessions/*.json` record uses
 * the same workspace; otherwise the workspace stays listed in `trust-seeds.json` and the last session out removes it.
 * A workspace is (cwd, global config file) (ICR 0033): the key lives in the `.claude.json` of the CLAUDE_CONFIG_DIR the
 * seeding process resolved, which the record keeps (`claudeConfigPath`), so a reaper or lifecheck running under another
 * config dir unseeds that file and never its own. `self.configPath` overrides the record's (the launcher before the record
 * exists). The caller holds the registry lock (the launcher seeds and writes its record under the same lock).
 */
export async function releaseTrustLocked(
  d: { store: RegistryStore; claudeConfig: ClaudeConfigPort },
  self: { sessionKey: SessionKey; cwdRealpath: string; ownedHint: boolean; configPath?: string },
): Promise<'none' | 'kept' | 'unseeded'> {
  const all = await d.store.listSessions();
  const mine = all.find((s) => s.sessionKey === self.sessionKey);
  const own = d.claudeConfig.globalConfigPath();
  const target = recordConfigPath(self.configPath ?? mine?.claudeConfigPath, own);
  const seeds = await d.store.readTrustSeeds();
  const listed = seeds.find((s) => s.cwd === self.cwdRealpath && recordConfigPath(s.configPath, own) === target);
  if (listed === undefined && mine?.trustKeyAddedByLibrary !== true && !self.ownedHint) return 'none';
  const shared = all.some(
    (s) => s.sessionKey !== self.sessionKey && s.cwdRealpath === self.cwdRealpath && recordConfigPath(s.claudeConfigPath, own) === target,
  );
  if (shared) {
    if (listed === undefined) await d.store.setTrustSeed(self.cwdRealpath, target, self.sessionKey);
    return 'kept';
  }
  await d.claudeConfig.unseedTrust(self.cwdRealpath, { globalConfigPath: target });
  if (listed !== undefined) await d.store.setTrustSeed(self.cwdRealpath, listed.configPath, undefined);
  return 'unseeded';
}

/** LC §6.3: identity = same start time, command contains the exe name **and** our session id (macOS reuses pids, P-LIFE-44). */
export async function verifyClaudeIdentity(proc: ProcessPort, id: ClaudeIdentity): Promise<IdentityVerdict> {
  if (!proc.isAlive(id.pid)) return 'gone';
  const cur = await proc.identity(id.pid);
  if (cur === undefined) return proc.isAlive(id.pid) ? 'mismatch' : 'gone';
  return cur.startTime === id.startTime && cur.command.includes(id.exeSubstr) && cur.command.includes(id.sessionId) ? 'match' : 'mismatch';
}

/** True while the owner (pid + start time) is the same live process. */
export async function isOwnerAlive(proc: ProcessPort, owner: { pid: number; startTime: string }): Promise<boolean> {
  if (!proc.isAlive(owner.pid)) return false;
  const cur = await proc.identity(owner.pid);
  if (cur === undefined) return proc.isAlive(owner.pid);
  return cur.startTime === owner.startTime;
}

export type TerminateOutcome = 'terminated' | 'killed' | 'gone' | 'identity-mismatch' | 'survived';

/**
 * SIGTERM the verified pid, poll for its death up to `graceMs`, then SIGKILL after re-verifying the identity.
 * Never signals a pid whose identity does not match (the pid may belong to another process by now).
 */
export async function terminateVerified(
  proc: ProcessPort,
  clock: Clock,
  id: ClaudeIdentity,
  o: { graceMs: number; killAfterMs?: number; startWith?: 'SIGTERM' | 'SIGKILL' },
): Promise<TerminateOutcome> {
  const first = await verifyClaudeIdentity(proc, id);
  if (first === 'gone') return 'gone';
  if (first === 'mismatch') return 'identity-mismatch';
  if (o.startWith !== 'SIGKILL') {
    proc.kill(id.pid, 'SIGTERM');
    if (await waitDead(proc, clock, id.pid, o.graceMs)) return 'terminated';
    const again = await verifyClaudeIdentity(proc, id);
    if (again === 'gone') return 'terminated';
    if (again === 'mismatch') return 'identity-mismatch';
  }
  proc.kill(id.pid, 'SIGKILL');
  if (await waitDead(proc, clock, id.pid, o.killAfterMs ?? 3_000)) return 'killed';
  return 'survived';
}

/** Poll `isAlive` every 100 ms (Clock.sleep, so FakeClock tests are deterministic). */
async function waitDead(proc: ProcessPort, clock: Clock, pid: number, maxMs: number): Promise<boolean> {
  const until = clock.now() + maxMs;
  while (proc.isAlive(pid)) {
    if (clock.now() >= until) return false;
    await clock.sleep(Math.min(REAP_POLL_MS, Math.max(1, until - clock.now())));
  }
  return true;
}

/** tmux CLI args addressing a library server: `-S <abs socket>` when recorded (immune to TMUX_TMPDIR), else `-L <name>`. */
export function tmuxTarget(rec: Pick<SessionRecord['tmux'], 'socketName' | 'socketPath'>): string[] | undefined {
  if (rec.socketPath !== undefined && SAFE_ABS.test(rec.socketPath) && CCD_SOCKET.test(basename(rec.socketPath)))
    return ['-S', rec.socketPath];
  if (CCD_SOCKET.test(rec.socketName)) return ['-L', rec.socketName];
  return undefined;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** Minimal env for our own tmux/rm invocations (never the child env: it may carry the proxy token). */
export function toolEnv(env: EnvPort): Record<string, string> {
  const host = env.snapshot();
  const out: Record<string, string> = { PATH: host['PATH'] ?? '/usr/bin:/bin', HOME: env.homeDir(), LC_ALL: 'C' };
  const tmp = host['TMUX_TMPDIR'];
  if (tmp !== undefined) out['TMUX_TMPDIR'] = tmp;
  return out;
}

export interface ReaperDeps {
  process: ProcessPort;
  clock: Clock;
  env: EnvPort;
  runtimeDir: RuntimeDirPort;
  claudeConfig: ClaudeConfigPort;
  logger: Logger;
  store: RegistryStore;
}

export interface ReapOptions {
  /**
   * The caller's own process (pid + start time): its records are never reaped even if the identity read fails. Both must
   * match: a record of an earlier process that had the same pid (containers give node the same pid on every run, macOS
   * reuses pids, P-LIFE-44) is checked like any other owner (`isOwnerAlive`).
   */
  selfPid?: number;
  selfStartTime?: string;
  termGraceMs?: number;
  /** Skip the socket sweep (a lifecheck run with a tight budget). */
  sweepSockets?: boolean;
  socketProbeGapMs?: number;
  /** Where unknown `ccd-*` sockets are counted; default `$TMUX_TMPDIR/tmux-$UID` or `/tmp/tmux-$UID`. */
  socketDir?: string;
  reapedBy?: 'reaper' | 'lifecheck';
}

interface ReapedSession {
  sessionKey: SessionKey;
  claude: TerminateOutcome | 'n/a';
  server: 'killed' | 'gone' | 'failed' | 'n/a';
  socketUnlinked: boolean;
  sessionDirRemoved: boolean;
  trustUnseeded: boolean;
  /** kill-server failed and the server may still run: socket, session dir, trust key and record were left for a retry. */
  retained?: true;
}

export interface ReapReport {
  reaped: ReapedSession[];
  skippedLive: SessionKey[];
  sockets: { unlinked: string[]; alive: string[]; unknownCctSockets: number };
  sweptDirs: string[];
  prunedArchive: SessionKey[];
  ownersRemoved: number[];
  errors: string[];
}

/** One full reap pass under the registry lock. Never throws for a single bad record (errors are collected). */
export async function reap(d: ReaperDeps, o: ReapOptions = {}): Promise<ReapReport> {
  return d.store.withLock(() => reapLocked(d, o));
}

async function reapLocked(d: ReaperDeps, o: ReapOptions): Promise<ReapReport> {
  const report: ReapReport = {
    reaped: [],
    skippedLive: [],
    sockets: { unlinked: [], alive: [], unknownCctSockets: 0 },
    sweptDirs: [],
    prunedArchive: [],
    ownersRemoved: [],
    errors: [],
  };
  const sessions = await d.store.listSessions();
  const live = new Map<SessionKey, boolean>();
  for (const rec of sessions) {
    try {
      const alive = isSelf(o, rec.owner) || (await isOwnerAlive(d.process, rec.owner));
      live.set(rec.sessionKey, alive);
      if (alive) {
        report.skippedLive.push(rec.sessionKey);
        continue;
      }
      const r = await reapOne(d, rec, o);
      report.reaped.push(r);
      if (r.retained === true) report.errors.push(`${rec.sessionKey}: tmux server could not be killed; record kept for a retry`);
    } catch (e) {
      report.errors.push(`${rec.sessionKey}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Dead owners' heartbeat files.
  for (const owner of await d.store.listOwners()) {
    if (isSelf(o, owner)) continue;
    if (!(await isOwnerAlive(d.process, owner))) {
      await d.store.removeOwner(owner.pid);
      report.ownersRemoved.push(owner.pid);
    }
  }

  // Session dirs: only dirs named by a registry entry (live or archived) are ever removed (rev 2 sweepStale contract).
  try {
    const archive = await d.store.listArchive();
    const known = [
      ...sessions.filter((s) => live.get(s.sessionKey) === true).map((s) => ({ path: s.sessionDir, ownerAlive: true })),
      ...archive.filter((a) => a.keptSessionDir !== true).map((a) => ({ path: a.sessionDir, ownerAlive: false })),
    ];
    report.sweptDirs = await d.runtimeDir.sweepStale(known);
  } catch (e) {
    report.errors.push(`sweepStale: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (o.sweepSockets !== false) {
    try {
      report.sockets = await sweepSockets(d, o, live);
    } catch (e) {
      report.errors.push(`sweepSockets: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  report.prunedArchive = await d.store.pruneArchive();
  return report;
}

function isSelf(o: ReapOptions, owner: { pid: number; startTime: string }): boolean {
  return o.selfPid !== undefined && owner.pid === o.selfPid && o.selfStartTime !== undefined && owner.startTime === o.selfStartTime;
}

async function reapOne(d: ReaperDeps, rec: SessionRecord, o: ReapOptions): Promise<ReapedSession> {
  const out: ReapedSession = {
    sessionKey: rec.sessionKey,
    claude: 'n/a',
    server: 'n/a',
    socketUnlinked: false,
    sessionDirRemoved: false,
    trustUnseeded: false,
  };
  const graceMs = o.termGraceMs ?? REAP_TERM_GRACE_MS;
  if (rec.claude.pid !== undefined && rec.claude.startTime !== undefined) {
    out.claude = await terminateVerified(
      d.process,
      d.clock,
      { pid: rec.claude.pid, startTime: rec.claude.startTime, exeSubstr: basename(rec.claude.exe), sessionId: rec.initialSessionId },
      { graceMs },
    );
  } else {
    // Crash between spawn and the record update (§3.1 step 11): the pane may hold a Claude whose pid we never stored.
    for (const id of await paneClaudes(d, rec)) {
      const r = await terminateVerified(d.process, d.clock, id, { graceMs });
      if (out.claude === 'n/a' || r === 'killed' || r === 'survived') out.claude = r;
    }
  }
  out.server = await killServer(d, rec);
  if (out.server === 'failed' && !(await serverUnreachable(d, rec, o))) {
    // kill-server failed and the server may still be running (it answered, or tmux could not even be run): its socket is
    // the only name left for it, so neither the socket nor the record goes (rev 2 §10 G21, ICR 0033). The record stays in
    // sessions/ and the next reaper / lifecheck pass retries.
    out.retained = true;
    d.logger.warn('reaper: tmux server could not be killed; record kept for a retry', { sessionKey: rec.sessionKey, claude: out.claude });
    return out;
  }
  if (rec.tmux.socketPath !== undefined) out.socketUnlinked = await unlinkSocket(d, rec.tmux.socketPath);
  try {
    // the record is re-read: an earlier reaped record of the same cwd may have left the key to this one (ICR 0022)
    const r = await releaseTrustLocked(d, { sessionKey: rec.sessionKey, cwdRealpath: rec.cwdRealpath, ownedHint: false });
    out.trustUnseeded = r === 'unseeded';
  } catch (e) {
    d.logger.warn('reaper: unseedTrust failed', { sessionKey: rec.sessionKey, error: e instanceof Error ? e.name : 'unknown' });
  }
  try {
    await d.runtimeDir.removeSessionDir(rec.sessionDir);
    out.sessionDirRemoved = true;
  } catch (e) {
    d.logger.warn('reaper: removeSessionDir failed', { sessionKey: rec.sessionKey, error: e instanceof Error ? e.name : 'unknown' });
  }
  await d.store.appendExit(rec.sessionKey, `reaped by=${o.reapedBy ?? 'reaper'} claude=${out.claude} server=${out.server}`);
  await d.store.archive(rec.sessionKey, { reapedBy: o.reapedBy ?? 'reaper' });
  d.logger.info('reaper: reaped orphaned session', { sessionKey: rec.sessionKey, claude: out.claude, server: out.server });
  return out;
}

/**
 * Pane processes of a record's server that are identity-matching Claudes (command contains the exe basename and the argv
 * session id). Their start time is read now; `terminateVerified` re-checks it before every signal.
 */
async function paneClaudes(d: ReaperDeps, rec: SessionRecord): Promise<ClaudeIdentity[]> {
  const target = tmuxTarget(rec.tmux);
  if (target === undefined || !SAFE_ABS.test(rec.tmux.bin)) return [];
  let stdout: string;
  try {
    const r = await d.process.exec(rec.tmux.bin, [...target, 'list-panes', '-a', '-F', '#{pane_pid}'], {
      env: toolEnv(d.env),
      timeoutMs: SOCKET_PROBE_TIMEOUT_MS,
      killOnTimeout: true,
    });
    if (r.code !== 0 || r.timedOut) return [];
    stdout = r.stdout;
  } catch {
    return [];
  }
  const exeSubstr = basename(rec.claude.exe);
  const out: ClaudeIdentity[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!/^\d{1,10}$/.test(t)) continue;
    const pid = Number(t);
    if (pid <= 1) continue;
    const cur = await d.process.identity(pid);
    if (cur === undefined || !cur.command.includes(exeSubstr) || !cur.command.includes(rec.initialSessionId)) continue;
    out.push({ pid, startTime: cur.startTime, exeSubstr, sessionId: rec.initialSessionId });
  }
  return out;
}

async function killServer(d: ReaperDeps, rec: SessionRecord): Promise<ReapedSession['server']> {
  const target = tmuxTarget(rec.tmux);
  if (target === undefined || !SAFE_ABS.test(rec.tmux.bin)) return 'failed';
  try {
    const r = await d.process.exec(rec.tmux.bin, [...target, 'kill-server'], {
      env: toolEnv(d.env),
      timeoutMs: TMUX_KILL_TIMEOUT_MS,
      killOnTimeout: true,
    });
    if (r.code === 0) return 'killed';
    return /no server running|error connecting|No such file/i.test(r.stderr) ? 'gone' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * After a failed kill-server: true when the server provably no longer answers — two `list-sessions` probes `socketProbeGapMs`
 * apart that ran and got no answer (the G21 sweep rule) — or nothing can ever address it (no valid target). A probe that
 * cannot run (tmux binary missing) proves nothing: false.
 */
async function serverUnreachable(d: ReaperDeps, rec: SessionRecord, o: ReapOptions): Promise<boolean> {
  const target = tmuxTarget(rec.tmux);
  if (target === undefined) return true;
  if (!SAFE_ABS.test(rec.tmux.bin)) return false;
  if ((await probeServer(d, rec.tmux.bin, target)) !== 'silent') return false;
  await d.clock.sleep(o.socketProbeGapMs ?? SOCKET_PROBE_GAP_MS);
  return (await probeServer(d, rec.tmux.bin, target)) === 'silent';
}

/** One `list-sessions` probe: answered (exit 0 in time), silent (ran, no answer or timed out), unknown (could not run). */
async function probeServer(d: ReaperDeps, bin: string, target: string[]): Promise<'answers' | 'silent' | 'unknown'> {
  try {
    const r = await d.process.exec(bin, [...target, 'list-sessions'], {
      env: toolEnv(d.env),
      timeoutMs: SOCKET_PROBE_TIMEOUT_MS,
      killOnTimeout: true,
    });
    return !r.timedOut && r.code === 0 ? 'answers' : 'silent';
  } catch {
    return 'unknown';
  }
}

/** `tmux list-sessions` answered within the timeout (any exit code means a server answered only when code === 0). */
async function serverAnswers(d: ReaperDeps, bin: string, target: string[]): Promise<boolean> {
  try {
    const r = await d.process.exec(bin, [...target, 'list-sessions'], {
      env: toolEnv(d.env),
      timeoutMs: SOCKET_PROBE_TIMEOUT_MS,
      killOnTimeout: true,
    });
    return !r.timedOut && r.code === 0;
  } catch {
    return false;
  }
}

async function unlinkSocket(d: ReaperDeps, path: string): Promise<boolean> {
  if (!SAFE_ABS.test(path) || !CCD_SOCKET.test(basename(path))) return false;
  const st = await d.env.lstat(path);
  if (st === undefined) return false;
  if (st.isDir || st.isSymlink) return false;
  try {
    const r = await d.process.exec('/bin/rm', ['-f', '--', path], { env: toolEnv(d.env), timeoutMs: 2_000, killOnTimeout: true });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Socket sweep (rev 2 §10 G21): registry-named sockets only; two failed probes 5 s apart; unknown `ccd-*` only counted. */
async function sweepSockets(d: ReaperDeps, o: ReapOptions, live: ReadonlyMap<SessionKey, boolean>): Promise<ReapReport['sockets']> {
  const out: ReapReport['sockets'] = { unlinked: [], alive: [], unknownCctSockets: 0 };
  const candidates = new Map<string, { bin: string; target: string[] }>();
  const named = new Set<string>();
  const add = (r: SessionRecord): void => {
    if (r.tmux.socketPath === undefined) return;
    named.add(r.tmux.socketPath);
    if (live.get(r.sessionKey) === true) return; // a live owner's server is never probed for removal
    const target = tmuxTarget(r.tmux);
    if (target === undefined || !SAFE_ABS.test(r.tmux.bin)) return;
    candidates.set(r.tmux.socketPath, { bin: r.tmux.bin, target });
  };
  for (const r of await d.store.listSessions()) add(r);
  for (const r of await d.store.listArchive()) add(r);

  const firstFailed: string[] = [];
  for (const [path, c] of candidates) {
    if ((await d.env.lstat(path)) === undefined) continue;
    if (await serverAnswers(d, c.bin, c.target)) out.alive.push(path);
    else firstFailed.push(path);
  }
  if (firstFailed.length > 0) {
    await d.clock.sleep(o.socketProbeGapMs ?? SOCKET_PROBE_GAP_MS);
    for (const path of firstFailed) {
      const c = candidates.get(path);
      if (c === undefined) continue;
      if (await serverAnswers(d, c.bin, c.target)) out.alive.push(path);
      else if (await unlinkSocket(d, path)) out.unlinked.push(path);
    }
  }

  // Count (never touch) ccd-* sockets that no registry entry names.
  const dir = o.socketDir ?? defaultSocketDir(d.env);
  out.unknownCctSockets = (await listSocketDir(d, dir)).filter((n) => CCD_SOCKET.test(n) && !named.has(`${dir}/${n}`)).length;
  return out;
}

export function defaultSocketDir(env: EnvPort): string {
  const tmp = env.snapshot()['TMUX_TMPDIR'];
  return `${tmp !== undefined && tmp !== '' ? tmp : '/tmp'}/tmux-${env.uid()}`;
}

async function listSocketDir(d: ReaperDeps, dir: string): Promise<string[]> {
  if (!SAFE_ABS.test(dir)) return [];
  const st = await d.env.lstat(dir);
  if (st?.isDir !== true) return [];
  try {
    const r = await d.process.exec('/bin/ls', ['-1', '-A', '--', dir], { env: toolEnv(d.env), timeoutMs: 2_000, killOnTimeout: true });
    if (r.code !== 0) return [];
    return r.stdout.split('\n').filter((l) => l !== '');
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------------------------------------ lifecheck support

export type SessionClass = 'owned-alive' | 'owned-hung' | 'orphan' | 'dead';

/**
 * §3.12 classification (used by `ccd lifecheck`): owner alive with a fresh heartbeat → `owned-alive`, stale heartbeat (> 60 s)
 * → `owned-hung` (never killed, P-LIFE-58); owner dead and Claude (verified) or its tmux socket still present → `orphan`;
 * otherwise `dead`.
 */
export async function classifySession(
  d: Pick<ReaperDeps, 'process' | 'env' | 'store'>,
  rec: SessionRecord,
  nowWall: WallMs,
): Promise<SessionClass> {
  if (await isOwnerAlive(d.process, rec.owner)) {
    const owner = await d.store.readOwner(rec.owner.pid);
    if (owner !== undefined && nowWall - owner.heartbeatAt > OWNER_HUNG_MS) return 'owned-hung';
    return 'owned-alive';
  }
  if (rec.claude.pid !== undefined && rec.claude.startTime !== undefined) {
    const v = await verifyClaudeIdentity(d.process, {
      pid: rec.claude.pid,
      startTime: rec.claude.startTime,
      exeSubstr: basename(rec.claude.exe),
      sessionId: rec.initialSessionId,
    });
    if (v === 'match') return 'orphan';
  }
  if (rec.tmux.socketPath !== undefined && (await d.env.lstat(rec.tmux.socketPath)) !== undefined) return 'orphan';
  return 'dead';
}

/** Directory of a socket path (exported for the CLI's report). */
