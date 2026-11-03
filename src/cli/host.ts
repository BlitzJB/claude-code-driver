// cli/host.ts — the narrow I/O surface the `ccd` commands run against (DESIGN.md §3.12, §1.3 cli row).
//
// The commands themselves (lifecheck.ts, launchd.ts, view.ts, trace.ts) are pure orchestration over these interfaces, so they
// are unit-tested with in-memory hosts. `lifecheck-host.ts` builds the real lifecheck host from `runtime/node.ts`
// `createNodePorts()` plus `session/reaper.ts` and `session/registry-store.ts` — the only lower-layer edges §1.3 allows the
// cli (no kernel, no keys, no hook port; rev 2 §10 G19). `node-host.ts` holds the node:* hosts for install/status/view/trace.

/** `sessions/<sessionKey>.json` as the cli needs it (§3.8; v:2). Parsed leniently: unknown fields are ignored. */
export interface SessionRecord {
  key: string;
  v: number;
  owner: { pid: number; startTime: string };
  tmux: { bin: string; socketName: string; socketPath?: string; sessionName: string; paneId?: string };
  /** pid/startTime are absent while the record is `launching` (written before the spawn, §3.1 step 11). */
  claude: { pid?: number; startTime?: string; exe: string; version?: string };
  claudeSessionId: string;
  initialSessionId?: string;
  transcriptPath?: string;
  cwdRealpath?: string;
  sessionDir?: string;
  /** Registry lifecycle state (`launching`, `ready`, `closing`, …) or, from older writers, an AgentStatus kind. */
  state?: string;
  /** Present while the session is usage-limited (§3.9). */
  usageLimit?: { resetsAtWall?: number };
  ownerWatch?: { pid: number };
  trustKeyAddedByLibrary?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** `owners/<ownerPid>.json` (§3.8). */
export interface OwnerRecord {
  pid: number;
  startTime: string;
  heartbeatAt: number;
  libVersion?: string;
}

export type Classification = 'owned-alive' | 'owned-hung' | 'orphan' | 'dead';

/** One session the reaper reaped (`session/reaper.ts` ReapedSession, keyed by our `key`). */
export interface ReapedLine {
  key: string;
  /** terminateVerified outcome: terminated | killed | gone | identity-mismatch | survived | n/a. */
  claude: string;
  /** killed | gone | failed | n/a. */
  server: string;
  socketUnlinked: boolean;
  sessionDirRemoved: boolean;
  trustUnseeded: boolean;
}

/** Result of one reaper pass (`session/reaper.ts reap()`, which takes the registry lock itself). */
export interface ReapPassResult {
  reaped: ReapedLine[];
  skippedLive: string[];
  socketsUnlinked: string[];
  unknownCcdSockets: number;
  sweptDirs: string[];
  prunedArchive: string[];
  ownersRemoved: number[];
  errors: string[];
}

/**
 * Everything `ccd lifecheck` (run mode) touches. Classification and the reap pass are the reaper's (single source of truth
 * shared with `start()`); this cli only orchestrates, reports and writes `lifecheck.json`.
 */
export interface LifecheckHost {
  readonly stateDir: string;
  readonly libVersion: string;
  /** Absolute path of the running `dist/cli/main.js` (recorded as `distPath`). */
  readonly distPath: string;
  nowWall(): number;
  listSessions(): Promise<SessionRecord[]>;
  /**
   * §3.12 classification (reaper `classifySession`): owner alive (pid + start time) with a heartbeat ≤ 60 s old →
   * `owned-alive`, older → `owned-hung`; owner dead and Claude's verified identity (or its socket) still present → `orphan`;
   * else `dead`. `heartbeatAt` is the owner's last heartbeat when the owner is alive and its record matches.
   */
  classify(rec: SessionRecord): Promise<{ classification: Classification; heartbeatAt?: number }>;
  readExits(key: string): Promise<string[]>;
  /** One full reap pass under the registry lock (§3.8 reap of every dead-owner session + registry-named socket sweep). */
  reapPass(): Promise<ReapPassResult>;
  /** Diagnostic dump request (SIGUSR2) to a hung owner, only after re-verifying its pid + start time. Never a kill. */
  signalOwnerDiagnostics(owner: SessionRecord['owner']): Promise<boolean>;
  writeLifecheckJson(report: unknown): Promise<void>;
  log(line: string): void;
}

/** Filesystem + command surface for `install` / `uninstall` / `status` (launchd.ts). */
export interface InstallHost {
  readonly stateDir: string;
  readonly homeDir: string;
  readonly uid: number;
  readonly platform: 'darwin' | 'linux' | 'other';
  /** Absolute `process.execPath` of the running node. */
  readonly nodePath: string;
  readonly distPath: string;
  nowWall(): number;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | undefined>;
  /** Atomic write (tmp + rename in the same dir) with an explicit mode; parent dirs created 0700. */
  writeFile(path: string, text: string, mode: number): Promise<void>;
  /** Creates an empty file with `mode` if it does not exist; chmods it to `mode` if it does. */
  touch(path: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  run(file: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Wall-clock wait (the launchctl bootout → bootstrap retry). */
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Lenient record parsing (the registry is written by other library versions too; never trust its shape).

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pid = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) && n > 1 ? n : undefined;
};

export function parseSessionRecord(key: string, json: unknown): { record: SessionRecord } | { error: string } {
  if (!isObj(json)) return { error: 'not an object' };
  const owner = json['owner'];
  const tmux = json['tmux'];
  const claude = json['claude'];
  if (!isObj(owner) || !isObj(tmux) || !isObj(claude)) return { error: 'missing owner/tmux/claude' };
  const ownerPid = pid(owner['pid']);
  const ownerStart = str(owner['startTime']);
  const claudePid = claude['pid'] === undefined ? undefined : pid(claude['pid']);
  const claudeStart = str(claude['startTime']);
  const claudeExe = str(claude['exe']);
  if (claude['pid'] !== undefined && claudePid === undefined) return { error: 'bad claude pid' };
  const socketName = str(tmux['socketName']);
  const socketPath = str(tmux['socketPath']);
  const sessionName = str(tmux['sessionName']);
  const tmuxBin = str(tmux['bin']);
  const sid = str(json['claudeSessionId']) ?? str(json['initialSessionId']);
  if (ownerPid === undefined || ownerStart === undefined) return { error: 'bad owner' };
  if (claudeExe === undefined) return { error: 'bad claude' };
  if (socketName === undefined || sessionName === undefined || tmuxBin === undefined) return { error: 'bad tmux' };
  if (sid === undefined) return { error: 'missing claudeSessionId' };
  const rec: SessionRecord = {
    key,
    v: num(json['v']) ?? 0,
    owner: { pid: ownerPid, startTime: ownerStart },
    tmux: { bin: tmuxBin, socketName, sessionName },
    claude: { exe: claudeExe },
    claudeSessionId: sid,
  };
  if (socketPath !== undefined) rec.tmux.socketPath = socketPath;
  if (claudePid !== undefined) rec.claude.pid = claudePid;
  if (claudeStart !== undefined) rec.claude.startTime = claudeStart;
  const paneId = str(tmux['paneId']);
  if (paneId !== undefined) rec.tmux.paneId = paneId;
  const version = str(claude['version']);
  if (version !== undefined) rec.claude.version = version;
  const opt = <K extends keyof SessionRecord>(k: K, v: SessionRecord[K] | undefined): void => {
    if (v !== undefined) rec[k] = v;
  };
  opt('initialSessionId', str(json['initialSessionId']));
  opt('transcriptPath', str(json['transcriptPath']));
  opt('cwdRealpath', str(json['cwdRealpath']));
  opt('sessionDir', str(json['sessionDir']));
  opt('state', str(json['state']));
  opt('createdAt', num(json['createdAt']));
  opt('updatedAt', num(json['updatedAt']));
  if (typeof json['trustKeyAddedByLibrary'] === 'boolean') rec.trustKeyAddedByLibrary = json['trustKeyAddedByLibrary'];
  const ul = json['usageLimit'];
  if (isObj(ul)) {
    const r = num(ul['resetsAtWall']) ?? num(ul['resetsAt']);
    rec.usageLimit = r === undefined ? {} : { resetsAtWall: r };
  }
  const ow = json['ownerWatch'];
  if (isObj(ow)) {
    const p = pid(ow['pid']);
    if (p !== undefined) rec.ownerWatch = { pid: p };
  }
  return { record: rec };
}

export function parseOwnerRecord(json: unknown): OwnerRecord | undefined {
  if (!isObj(json)) return undefined;
  const p = pid(json['pid']);
  const st = str(json['startTime']);
  const hb = num(json['heartbeatAt']);
  if (p === undefined || st === undefined || hb === undefined) return undefined;
  const o: OwnerRecord = { pid: p, startTime: st, heartbeatAt: hb };
  const lv = str(json['libVersion']);
  if (lv !== undefined) o.libVersion = lv;
  return o;
}
