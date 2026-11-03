// session/registry-store.ts — the library's own registry in the 0700 state dir (DESIGN.md §3.8, D-28, D-38).
//
// Layout (every path absolute, D-38 / P-REV-34):
//   owners/<ownerPid>.json      {pid, startTime, argv0, nodeVersion, libVersion, createdAt, heartbeatAt}
//   sessions/<sessionKey>.json  SessionRecord v2 (written with state 'launching' BEFORE the spawn, §3.1 step 11)
//   archive/<sessionKey>.json   SessionRecord + {archivedAt, exit?} (kept 7 days: resume lookups, sweep rule)
//   exits/<sessionKey>.log      appended by tmux `pane-died` run-shell and by the owner-watch
//   lock                        O_EXCL, stale if the holder is dead or > 60 s
//   lifecheck-target.json       {distPath, nodePath, libVersion, writtenAt} rewritten by every start (§3.12 F1)
//   trust-seeds.json            {v:2, seeds:[{cwd, configPath?, by, at}]}: workspaces whose trust key the library seeded (in
//                               the global config file `configPath`) and still has to remove once no session uses them (ICR
//                               0022, 0030; written under the lock only). A v:1 file ({cwds:{<cwd>:{by, at}}}) is read as
//                               entries without `configPath`.
//
// Pitfalls handled here: P-LIFE-10 (registry/pidfile), P-REV-34 (absolute paths), P-LIFE-12 (exits log path).
// The store only talks to `StateStorePort`; it never computes a runtime path from the environment.

import type { SessionKey } from '../model/ids.js';
import type { PermissionMode } from '../model/state.js';
import type { WallMs } from '../model/time.js';
import type { StateStorePort } from '../platform/ports.js';
import { CcdError } from '../model/errors.js';

const REGISTRY_VERSION = 2;
export const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_NAME = 'lock';
const LOCK_STALE_MS = 60_000;
export const TRUST_SEEDS_FILE = 'trust-seeds.json';

export type SessionRecordState = 'launching' | 'ready' | 'closing' | 'exited' | 'reaped';

export interface OwnerRecord {
  pid: number;
  startTime: string;
  argv0: string;
  nodeVersion: string;
  libVersion: string;
  createdAt: WallMs;
  heartbeatAt: WallMs;
}

export interface SessionRecord {
  v: 2;
  sessionKey: SessionKey;
  owner: { pid: number; startTime: string };
  tmux: { bin: string; socketName: string; socketPath?: string; sessionName: string; paneId?: string };
  /** Absent while `launching` (the pane does not exist yet). */
  claude: { pid?: number; startTime?: string; exe: string; version: string };
  claudeSessionId: string;
  /** The id on the argv (`--session-id` / `--resume`): the identity check uses it, `/clear` does not change it. */
  initialSessionId: string;
  transcriptPath?: string;
  cwdRealpath: string;
  sessionDir: string;
  settingsFile: string;
  settingsSha256: string;
  hook: { transport: 'http' | 'unix'; port?: number; socketPath: string };
  net?: { port: number; pid: number; controlSocket: string };
  ownerWatch?: { pid: number };
  trustKeyAddedByLibrary: boolean;
  /**
   * Absolute path of the global Claude config (`.claude.json`) this session's trust decision applies to: the file a library
   * seed was written to (CLAUDE_CONFIG_DIR-aware). Absent in records of older writers (= the reader's own config, ICR 0033).
   */
  claudeConfigPath?: string;
  permissionMode: PermissionMode;
  model?: string;
  state: SessionRecordState;
  /** Derived status kind persisted by the core's `registry.persist` intent (diagnostics for lifecheck). */
  status?: string;
  usageLimit?: { resetsAtWall?: WallMs; since: WallMs };
  lastEventSeq: number;
  /** Set when the session dir was deliberately kept at close (`keepClaudeDebugFile`). */
  keptSessionDir?: boolean;
  createdAt: WallMs;
  updatedAt: WallMs;
}

/** One `trust-seeds.json` entry: a trust key the library seeded in `configPath` (absent: legacy v:1 entry) for `cwd`. */
export interface TrustSeed {
  cwd: string;
  configPath?: string;
  by: SessionKey;
  at: WallMs;
}

export interface ArchivedRecord extends SessionRecord {
  archivedAt: WallMs;
  exit?: { exitStatus: number | null; signal: string | null; reason: string };
  reapedBy?: 'close' | 'reaper' | 'lifecheck';
}

export interface LifecheckTarget {
  distPath: string;
  nodePath: string;
  libVersion: string;
  writtenAt: WallMs;
}

const KEY_RE = /^s[0-9a-f]{8,32}$/;
const SAFE_ABS = /^\/[A-Za-z0-9/._-]+$/;

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new CcdError('E_INVARIANT', `invalid session key ${JSON.stringify(key.slice(0, 40))}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Lenient shape check of a stored session record (a damaged or foreign file is ignored, never trusted blindly). */
export function isSessionRecord(v: unknown): v is SessionRecord {
  if (!isObject(v) || v['v'] !== REGISTRY_VERSION) return false;
  const owner = v['owner'];
  const tmux = v['tmux'];
  const claude = v['claude'];
  const hook = v['hook'];
  return (
    typeof v['sessionKey'] === 'string' &&
    KEY_RE.test(v['sessionKey']) &&
    isObject(owner) &&
    typeof owner['pid'] === 'number' &&
    typeof owner['startTime'] === 'string' &&
    isObject(tmux) &&
    typeof tmux['bin'] === 'string' &&
    typeof tmux['socketName'] === 'string' &&
    isObject(claude) &&
    isObject(hook) &&
    typeof v['sessionDir'] === 'string' &&
    typeof v['cwdRealpath'] === 'string' &&
    typeof v['initialSessionId'] === 'string' &&
    typeof v['state'] === 'string'
  );
}

function isOwnerRecord(v: unknown): v is OwnerRecord {
  return isObject(v) && typeof v['pid'] === 'number' && typeof v['startTime'] === 'string' && typeof v['heartbeatAt'] === 'number';
}

/** One parsed line of `exits/<key>.log` (tmux pane-died `died pane=%1 pid=123 status=0 signal=` or owner-watch `watch=…`). */
export interface ExitLine {
  kind: 'died' | 'watch' | 'launched' | 'other';
  fields: Record<string, string>;
  raw: string;
}

export function parseExitLine(raw: string): ExitLine {
  const line = raw.trim();
  const fields: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Za-z]+)=(\S*)/g)) if (m[1] !== undefined) fields[m[1]] = m[2] ?? '';
  const kind: ExitLine['kind'] = line.startsWith('died ')
    ? 'died'
    : line.startsWith('watch=')
      ? 'watch'
      : line.startsWith('launched ')
        ? 'launched'
        : 'other';
  return { kind, fields, raw: line };
}

/** tmux 3.5 prints `term`, 3.3/3.4 print `15`, 3.2a nothing: normalize to `SIGTERM` (or null). */
const SIGNALS: Readonly<Record<string, string>> = {
  '1': 'HUP',
  '2': 'INT',
  '3': 'QUIT',
  '6': 'ABRT',
  '9': 'KILL',
  '13': 'PIPE',
  '14': 'ALRM',
  '15': 'TERM',
};
function signalName(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const name = /^\d+$/.test(t) ? (SIGNALS[t] ?? t) : t.toUpperCase();
  return name.startsWith('SIG') ? name : `SIG${name}`;
}

/** The last `died` line of an exits log → exit status and signal (null when tmux printed nothing). */
export function lastDeath(text: string): { exitStatus: number | null; signal: string | null } | undefined {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = parseExitLine(lines[i] ?? '');
    if (p.kind !== 'died') continue;
    const st = p.fields['status'] ?? '';
    const sig = p.fields['signal'] ?? '';
    return { exitStatus: /^\d+$/.test(st) ? Number(st) : null, signal: signalName(sig) };
  }
  return undefined;
}

/**
 * In-process serialisation of `updateSession` and `archive` per record (`<root>\0<key>`, shared by every RegistryStore over
 * the same state dir). The owner runs `registry.persist` intents fire-and-forget while its teardown archives the record; an
 * unserialised read-modify-write could read the record before `archive` removes it and rename it back after, resurrecting
 * an archived session. Under this mutex `updateSession` re-reads the record and is a no-op once it was archived.
 */
const recordMutex = new Map<string, Promise<unknown>>();

function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = recordMutex.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  recordMutex.set(id, tail);
  void tail.then(() => {
    if (recordMutex.get(id) === tail) recordMutex.delete(id);
  });
  return run;
}

export class RegistryStore {
  constructor(
    readonly state: StateStorePort,
    private readonly now: () => WallMs,
  ) {}

  get root(): string {
    return this.state.root;
  }

  // ---------------------------------------------------------------- paths (absolute, D-38)

  /** Absolute path of `exits/<key>.log`; validated for the tmux run-shell command line (LC §4.2). */
  exitsLogPath(key: SessionKey): string {
    assertKey(key);
    const p = `${this.state.root}/exits/${key}.log`;
    if (!SAFE_ABS.test(p))
      throw new CcdError('E_UNSAFE_RUNTIME_DIR', 'state dir path contains characters tmux run-shell cannot take safely', {
        details: { reason: 'stateDirChars' },
      });
    return p;
  }

  ownerWatchLogPath(key: SessionKey): string {
    assertKey(key);
    return `${this.state.root}/exits/${key}.owner-watch.log`;
  }

  // ---------------------------------------------------------------- sessions

  async writeSession(rec: SessionRecord): Promise<void> {
    assertKey(rec.sessionKey);
    await this.state.writeJsonAtomic(`sessions/${rec.sessionKey}.json`, rec);
  }

  async readSession(key: SessionKey): Promise<SessionRecord | undefined> {
    assertKey(key);
    const v = await this.state.readJson<unknown>(`sessions/${key}.json`);
    return isSessionRecord(v) ? v : undefined;
  }

  /**
   * Read-modify-write of one record (the owner is the only writer of its own records; the reaper only archives records of
   * dead owners). Serialised with `archive` of the same key in this process, so a record that was archived is never
   * written back (a no-op returning undefined).
   */
  updateSession(
    key: SessionKey,
    patch: Partial<Omit<SessionRecord, 'v' | 'sessionKey' | 'createdAt'>>,
    remove: readonly ('usageLimit' | 'transcriptPath' | 'model' | 'status' | 'net' | 'ownerWatch')[] = [],
  ): Promise<SessionRecord | undefined> {
    assertKey(key);
    return serialized(this.mutexId(key), async () => {
      const cur = await this.readSession(key);
      if (cur === undefined) return undefined;
      const next: SessionRecord = { ...cur, ...patch, v: 2, sessionKey: cur.sessionKey, createdAt: cur.createdAt, updatedAt: this.now() };
      for (const k of remove) Reflect.deleteProperty(next, k);
      await this.writeSession(next);
      return next;
    });
  }

  private mutexId(key: SessionKey): string {
    return `${this.state.root}\0${key}`;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.listRecords('sessions', isSessionRecord);
  }

  async removeSession(key: SessionKey): Promise<void> {
    assertKey(key);
    await this.state.remove(`sessions/${key}.json`);
  }

  /** Move `sessions/<key>.json` to `archive/<key>.json` (with the exit info). Idempotent; serialised with `updateSession`. */
  archive(
    key: SessionKey,
    extra: {
      exit?: ArchivedRecord['exit'];
      reapedBy: NonNullable<ArchivedRecord['reapedBy']>;
      state?: SessionRecordState;
      keptSessionDir?: boolean;
    },
  ): Promise<ArchivedRecord | undefined> {
    assertKey(key);
    return serialized(this.mutexId(key), () => this.archiveNow(key, extra));
  }

  private async archiveNow(key: SessionKey, extra: Parameters<RegistryStore['archive']>[1]): Promise<ArchivedRecord | undefined> {
    const cur = await this.readSession(key);
    if (cur === undefined) return this.readArchive(key);
    const now = this.now();
    const rec: ArchivedRecord = {
      ...cur,
      state: extra.state ?? (extra.reapedBy === 'close' ? 'exited' : 'reaped'),
      updatedAt: now,
      archivedAt: now,
      reapedBy: extra.reapedBy,
    };
    if (extra.exit !== undefined) rec.exit = extra.exit;
    if (extra.keptSessionDir === true) rec.keptSessionDir = true;
    await this.state.writeJsonAtomic(`archive/${key}.json`, rec);
    await this.state.remove(`sessions/${key}.json`);
    return rec;
  }

  async readArchive(key: SessionKey): Promise<ArchivedRecord | undefined> {
    assertKey(key);
    const v = await this.state.readJson<unknown>(`archive/${key}.json`);
    return isSessionRecord(v) ? (v as ArchivedRecord) : undefined;
  }

  async listArchive(): Promise<ArchivedRecord[]> {
    return (await this.listRecords('archive', isSessionRecord)) as ArchivedRecord[];
  }

  /** The most recent archived record for a Claude session id (`start({resume})` lookups, §3.8 recovery). */
  async findArchivedByClaudeSessionId(id: string): Promise<ArchivedRecord | undefined> {
    const all = await this.listArchive();
    return all.filter((r) => r.claudeSessionId === id || r.initialSessionId === id).sort((a, b) => b.archivedAt - a.archivedAt)[0];
  }

  /** Remove archive entries older than `ttlMs` (7 days). Returns the removed keys. */
  async pruneArchive(ttlMs = ARCHIVE_TTL_MS): Promise<SessionKey[]> {
    const now = this.now();
    const removed: SessionKey[] = [];
    for (const r of await this.listArchive()) {
      const at = typeof r.archivedAt === 'number' ? r.archivedAt : r.updatedAt;
      if (now - at > ttlMs) {
        await this.state.remove(`archive/${r.sessionKey}.json`);
        removed.push(r.sessionKey);
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------- owners

  async writeOwner(rec: OwnerRecord): Promise<void> {
    await this.state.writeJsonAtomic(`owners/${rec.pid}.json`, rec);
  }

  async readOwner(pid: number): Promise<OwnerRecord | undefined> {
    const v = await this.state.readJson<unknown>(`owners/${pid}.json`);
    return isOwnerRecord(v) ? v : undefined;
  }

  async heartbeat(pid: number): Promise<void> {
    const cur = await this.readOwner(pid);
    if (cur === undefined) return;
    await this.writeOwner({ ...cur, heartbeatAt: this.now() });
  }

  async removeOwner(pid: number): Promise<void> {
    await this.state.remove(`owners/${pid}.json`);
  }

  async listOwners(): Promise<OwnerRecord[]> {
    return this.listRecords('owners', isOwnerRecord);
  }

  // ---------------------------------------------------------------- exits, lock, lifecheck target

  async appendExit(key: SessionKey, line: string): Promise<void> {
    assertKey(key);
    await this.state.appendLine(`exits/${key}.log`, line.replace(/[\r\n]+/g, ' '));
  }

  async removeExits(key: SessionKey): Promise<void> {
    assertKey(key);
    await this.state.remove(`exits/${key}.log`);
    await this.state.remove(`exits/${key}.owner-watch.log`);
  }

  // ---------------------------------------------------------------- seeded trust keys (ICR 0022)

  /** cwdRealpath → the session that seeded it (only the presence matters for the unseed decision). */
  async readTrustSeeds(): Promise<TrustSeed[]> {
    const v = await this.state.readJson<unknown>(TRUST_SEEDS_FILE);
    if (!isObject(v)) return [];
    const out: TrustSeed[] = [];
    const entry = (cwd: unknown, e: unknown): void => {
      if (typeof cwd !== 'string' || !isObject(e) || typeof e['by'] !== 'string' || typeof e['at'] !== 'number') return;
      const s: TrustSeed = { cwd, by: e['by'] as SessionKey, at: e['at'] as WallMs };
      if (typeof e['configPath'] === 'string') s.configPath = e['configPath'];
      out.push(s);
    };
    if (Array.isArray(v['seeds'])) for (const e of v['seeds'] as unknown[]) entry(isObject(e) ? e['cwd'] : undefined, e);
    else if (isObject(v['cwds'])) for (const [cwd, e] of Object.entries(v['cwds'])) entry(cwd, e);
    return out;
  }

  /**
   * Mark (by ≠ undefined) or clear a library-seeded workspace; the key is (cwd, configPath), an absent configPath being a
   * legacy entry. Call under `withLock`.
   */
  async setTrustSeed(cwdRealpath: string, configPath: string | undefined, by: SessionKey | undefined): Promise<void> {
    const seeds = await this.readTrustSeeds();
    const i = seeds.findIndex((s) => s.cwd === cwdRealpath && s.configPath === configPath);
    if (by === undefined) {
      if (i < 0) return;
      seeds.splice(i, 1);
    } else {
      const s: TrustSeed = { cwd: cwdRealpath, by, at: this.now() };
      if (configPath !== undefined) s.configPath = configPath;
      if (i < 0) seeds.push(s);
      else seeds[i] = s;
    }
    if (seeds.length === 0) await this.state.remove(TRUST_SEEDS_FILE);
    else await this.state.writeJsonAtomic(TRUST_SEEDS_FILE, { v: 2, seeds });
  }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.state.withLock(LOCK_NAME, fn, { staleMs: LOCK_STALE_MS });
  }

  async writeLifecheckTarget(t: Omit<LifecheckTarget, 'writtenAt'>): Promise<void> {
    await this.state.writeJsonAtomic('lifecheck-target.json', { ...t, writtenAt: this.now() } satisfies LifecheckTarget);
  }

  async readLifecheckTarget(): Promise<LifecheckTarget | undefined> {
    const v = await this.state.readJson<unknown>('lifecheck-target.json');
    return isObject(v) && typeof v['distPath'] === 'string' ? (v as unknown as LifecheckTarget) : undefined;
  }

  // ---------------------------------------------------------------- internal

  private async listRecords<T>(dir: string, guard: (v: unknown) => v is T): Promise<T[]> {
    const out: T[] = [];
    for (const name of await this.state.list(dir)) {
      if (!name.endsWith('.json')) continue;
      const v = await this.state.readJson<unknown>(`${dir}/${name}`);
      if (guard(v)) out.push(v);
    }
    return out;
  }
}
