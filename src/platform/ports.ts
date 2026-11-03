// platform/ports.ts — ALL L0 port interfaces, types only (DESIGN.md §2.7). Copied verbatim from §2.7.
// L1 (channels) and L3 (session) may import this file with `import type` only (§1.3).

import type { FaultSpec } from '../model/commands.js';
import type { HookSeq } from '../model/ids.js';
import type { TmuxKeyName } from '../model/intents.js';
import type { Logger } from '../model/logger.js';
import type { Cancel, Clock, MonoMs, WallMs } from '../model/time.js';

export interface Ports {
  clock: Clock;
  ids: IdPort;
  process: ProcessPort;
  env: EnvPort;
  claude: ClaudeBinaryPort;
  runtimeDir: RuntimeDirPort;
  state: StateStorePort;
  settingsFile: SettingsFilePort;
  claudeConfig: ClaudeConfigPort;
  tmux: TmuxServerFactory;
  tail: TranscriptTailFactory;
  hooks: HookTransportFactory;
  editor: EditorInjectorFactory;
  net?: NetProxyFactory;
  registry: ClaudeRegistryReader;
  ownerWatch: OwnerWatchFactory;
  logger: Logger;
}

// ---- 2.7.1 process / env / ids / claude binary ----
export interface IdPort {
  uuidV4(): string;
  tokenHex(bytes: number): string /* lowercase hex only (no '$', SEC §2.2) */;
  shortHex(n: number): string;
}
export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface ProcessPort {
  which(bin: string, extraDirs: readonly string[]): Promise<string | undefined>;
  exec(
    file: string,
    args: readonly string[],
    o: { env: Readonly<Record<string, string>>; cwd?: string; timeoutMs: number; stdin?: string | Uint8Array; killOnTimeout: boolean },
  ): Promise<ExecResult>;
  execSyncBestEffort(file: string, args: readonly string[], env: Readonly<Record<string, string>>): void; // process.on('exit') only
  spawnDetached(
    file: string,
    args: readonly string[],
    o: { env: Readonly<Record<string, string>>; logPath: string; cwd?: string },
  ): Promise<{ pid: number }>;
  isAlive(pid: number): boolean; // kill(pid, 0)
  kill(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 'SIGHUP' | 'SIGUSR2'): boolean;
  identity(pid: number): Promise<{ startTime: string; command: string } | undefined>; // ps -o lstart=,command= -p <pid>
}
export interface EnvPort {
  snapshot(): Readonly<Record<string, string>>;
  homeDir(): string;
  userName(): string;
  uid(): number;
  platform(): 'darwin' | 'linux' | 'other';
  tmpDir(): string;
  execPath(): string;
  nodeVersion(): string;
  realpath(p: string): Promise<string>;
  lstat(p: string): Promise<{ isSymlink: boolean; isFile: boolean; isDir: boolean } | undefined>; // rev2: path resolver (§3.7)
  timeZone(): string;
} // rev2: Intl resolved zone, recorded in the trace header
export interface ClaudeBinaryPort {
  resolve(option?: string): Promise<{ exe: string; via: 'option' | 'consumer' | 'package' | 'path' } | undefined>; // prefers .../bin/claude.exe over the sh shim
  version(exe: string, env: Readonly<Record<string, string>>): Promise<string>; // parses '2.1.316 (Claude Code)'
  authStatus(
    exe: string,
    env: Readonly<Record<string, string>>,
  ): Promise<{ loggedIn: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string }>; // 10 s, killOnTimeout:false; apiProvider VERIFIED-CMD LC §1.3
}
export interface OwnerWatchFactory {
  // rev2 (D-28): node:* standalone, spawned detached, one per session
  start(o: {
    configPath: string /* 0600 watch.json: {ownerPid, ownerStart, claudePid, claudeStart, claudeExeSubstr, sessionIdSubstr, tmuxBin, socketName, pollMs, exitsLog} */;
    logPath: string;
  }): Promise<{ pid: number; stop(): Promise<void> }>; // stop = SIGTERM to the watcher (normal close)
}

// ---- 2.7.2 runtime dir / state / settings / claude config ----
export interface RuntimeDirPort {
  ensureRoot(): Promise<string>; // lstat: dir, !symlink, uid===getuid, (mode & 0o077)===0; else E_UNSAFE_RUNTIME_DIR
  createSessionDir(): Promise<string>; // mkdtemp(root/ccd-) → 0700; asserts Buffer.byteLength(sessionDir+'/net.sock') ≤ 100 (longest socket name used; macOS limit 104) else SocketPathTooLong
  removeSessionDir(path: string): Promise<void>;
  sweepStale(known: ReadonlyArray<{ path: string; ownerAlive: boolean }>): Promise<string[]>; // rev2: only dirs named by a registry entry (live or archived) are ever removed
}
export interface StateStorePort {
  readonly root: string; // 0700, same lstat checks
  writeJsonAtomic(rel: string, v: unknown): Promise<void>; // tmp in same dir, mode 0600, fsync, rename
  readJson<T>(rel: string): Promise<T | undefined>;
  list(relDir: string): Promise<string[]>;
  remove(rel: string): Promise<void>;
  appendLine(rel: string, line: string): Promise<void>;
  withLock<T>(name: string, fn: () => Promise<T>, o: { staleMs: number }): Promise<T>; // O_EXCL lockfile with pid; stale if pid dead or older than staleMs
}
export interface SettingsFilePort {
  writeExclusive(path: string, json: unknown): Promise<{ sha256: string; bytes: number }>;
  matches(path: string, sha256: string): Promise<boolean>;
}
export interface SettingsLayers {
  user?: unknown;
  project?: unknown;
  local?: unknown;
  keybindings?: unknown; // parsed leniently; managed is unreadable here
  disableAllHooksTrueIn: Array<'user' | 'project' | 'local'>;
  allowedHttpHookUrlsDefinedIn: Array<'user' | 'project' | 'local'>;
  editorMode?: string;
  statusLineDefined: boolean;
  parseErrors: string[];
}
export interface WorkspaceRisk {
  empty: boolean;
  items: Array<{
    file: string;
    kind:
      | 'hooks'
      | 'permissions.allow'
      | 'env'
      | 'apiKeyHelper'
      | 'statusLine'
      | 'otelHeadersHelper'
      | 'additionalDirectories'
      | 'mcpServers'
      | 'enableAllProjectMcpServers';
    detail: string;
  }>;
}
export interface ClaudeConfigPort {
  readGlobal(): Promise<{ ok: true; hasCompletedOnboarding: boolean } | { ok: false; reason: 'missing' | 'invalidJson' }>;
  trustOf(realCwd: string): Promise<{ trusted: boolean; viaPath?: string }>; // cwd or any ancestor up to git root (rootOnly respected)
  /** Absolute path of the global config file this process resolves now (`$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`). */
  globalConfigPath(): string;
  // `o.globalConfigPath` addresses another config file than the one this process resolves (ICR 0033: a record seeded under
  // another CLAUDE_CONFIG_DIR is unseeded in that file, never in ours).
  seedTrust(realCwd: string, o?: { globalConfigPath?: string }): Promise<{ added: boolean }>; // fresh read → set ONLY projects[realCwd].hasTrustDialogAccepted=true → tmp+rename, original mode preserved
  unseedTrust(realCwd: string, o?: { globalConfigPath?: string }): Promise<void>; // removes only that key; never the project entry
  readLayers(realCwd: string): Promise<SettingsLayers>;
  inspectWorkspace(realCwd: string): Promise<WorkspaceRisk>;
}

// ---- 2.7.3 tmux ----
export type PaneId = `%${number}`;
export interface TmuxServerFactory {
  probe(tmuxPath?: string): Promise<{ path: string; version: string }>; // ENOENT → TmuxNotFound; version < 3.2 → TmuxVersionUnsupported
  create(o: {
    tmuxPath: string;
    socketName: string;
    clientEnv: Readonly<Record<string, string>>;
    historyLimit: number;
    paneDiedLogPath: string;
  }): Promise<TmuxServer>;
  // rev2: no attach(), no control mode (§10 C1/G1)
}
export interface PaneSpawnOptions {
  sessionName: string;
  argv: readonly [string, string, ...string[]];
  cwd: string;
  cols: number;
  rows: number;
  nonSecretEnv: Readonly<Record<string, string>>;
}
export interface PaneInfo {
  paneId: PaneId;
  sessionId: string;
  windowId: string;
  pid: number;
  cols: number;
  rows: number;
}
export interface PaneStatus {
  exists: boolean;
  dead: boolean;
  exitStatus: number | null;
  exitSignal: string | null;
  inMode: boolean;
  alternateOn: boolean;
  cursorX: number;
  cursorY: number;
  cols: number;
  rows: number;
  historySize: number;
}
export interface Capture {
  lines: string[];
  status: PaneStatus;
  at: MonoMs;
  hash: string;
}
export interface TmuxServer {
  readonly socketName: string;
  readonly socketPath: string;
  readonly version: string;
  readonly tmuxPath: string;
  spawnPane(o: PaneSpawnOptions): Promise<TmuxPane>;
  kill(): Promise<void>; // kill-server, wait socket gone (≤1 s), unlink socket file
  killSync(): void; // exit handler
  onGone(fn: () => void): Cancel;
}
export interface TmuxPane {
  readonly info: PaneInfo;
  paste(text: string): Promise<void>; // load-buffer -b ccd-<pane>-<n> - (stdin) ; paste-buffer -t %N -b … -d -p -r ; never Enter
  typeLiteral(text: string): Promise<void>; // send-keys -t %N -l -- escapeArg(text); ≤ 8 KiB; no secrets
  sendKey(k: TmuxKeyName): Promise<void>; // one key per invocation; never batched
  capture(o?: { styles?: boolean; startRow?: number; endRow?: number }): Promise<Capture>; // display + capture-pane -p -N in one batch; never -J; never -S -
  status(): Promise<PaneStatus>; // cached ≤ 100 ms (adapter timer A-2, §4.12); checked before every input
  exitCopyMode(): Promise<void>; // send-keys -X cancel (only if inMode)
  killPane(): Promise<void>;
  on(e: 'died', fn: (s: { exitStatus: number | null; exitSignal: string | null }) => void): Cancel;
  on(e: 'gone', fn: () => void): Cancel;
  viewCommand(): string; // `tmux -L <sock> attach -r -t =<session>:` (read-only view for humans)
}

// ---- 2.7.4 transcript tail (TT §13, adopted verbatim with these types) ----
export type FileKey = { kind: 'main'; sessionId: string } | { kind: 'subagent'; sessionId: string; agentId: string };
export interface TailLine {
  file: FileKey;
  generation: number;
  offset: number;
  bytes: number;
  type: string | undefined;
  json: unknown | undefined;
  replay: boolean;
  afterRewrite: boolean;
  readAtMono: MonoMs;
  readAtWall: WallMs;
}
export type TailEvent =
  | { kind: 'line'; line: TailLine }
  | { kind: 'waiting'; file: FileKey; path: string; reason: 'ENOENT' | 'EACCES' | 'ENOTDIR' }
  | { kind: 'opened'; file: FileKey; path: string; dev: number; ino: number; size: number; startOffset: number }
  | { kind: 'moved'; file: FileKey; from: string; to: string; sameInode: boolean }
  | { kind: 'rewrite'; file: FileKey; reason: 'truncated' | 'replaced' | 'rewritten'; oldSize: number; newSize: number; generation: number }
  | { kind: 'resynced'; file: FileKey; fullRescan: boolean; generation: number }
  | { kind: 'malformed'; file: FileKey; offset: number; bytes: number; reason: 'json' | 'not-object'; preview: string }
  | { kind: 'oversize'; file: FileKey; offset: number; bytes: number }
  | { kind: 'torn-tail'; file: FileKey; offset: number; bytes: number }
  | { kind: 'missing'; file: FileKey; waitedMs: number }
  | { kind: 'state'; file: FileKey; state: 'waiting' | 'active' | 'draining' | 'dormant' | 'closed' }
  | { kind: 'error'; file?: FileKey; message: string; fatal: boolean };
export interface TailCheckpoint {
  files: Array<{ key: FileKey; path: string; dev: number; ino: number; offset: number; generation: number }>;
} // diagnostic only in v1 (no attach)
export interface TranscriptTail {
  followMain(sessionId: string, path: string, o?: { startAt?: 'beginning' | 'end' | { checkpoint: TailCheckpoint } }): void;
  observePath(sessionId: string, path: string, source: string): void;
  expectSubagent(sessionId: string, agentId: string): void;
  subagentStopped(sessionId: string, agentId: string, path?: string): void;
  poke(reason?: string): void;
  on(l: (e: TailEvent) => void): Cancel;
  checkpoint(): TailCheckpoint;
  close(): Promise<void>;
}
export interface TranscriptTailFactory {
  create(o: {
    configDir: string;
    clock: Clock;
    pollIdleMs: number /* 250 */;
    pollFastMs: number /* 50 */;
    fastBurstMs: number;
    drainGraceMs: number;
    missingAgentTimeoutMs: number;
    maxLineBytes: number;
    readChunkBytes: number;
    maxActiveFollowers: number;
    skipParseTypes: ReadonlySet<string>;
  }): TranscriptTail;
}
// rev2 (§10 C3): poll + pread only. Each poll: fstat; if (dev,ino) changed or size < offset → emit `rewrite` and re-read the file from 0
// with `replay:true, afterRewrite:true`; the core drops already-seen uuids (D-42). No fingerprint ring, no fs.watch, no EXDEV special case.

// ---- 2.7.5 hooks ----
export interface HookEndpoint {
  transport: 'http' | 'unix'; // rev2: 'unix' = every event through the forwarder (§3.5)
  http?: { port: number; urlBase: string /* http://127.0.0.1:<port>/h/<sid>/ */; token: string /* 64 hex */ };
  unix: { socketPath: string; forwarderConfigPath: string /* fwd.json 0600: {socketPath, token} */ };
  forwarder: { nodePath: string /* process.execPath */; scriptPath: string /* dist/platform/hook-server/standalone/forward.js */ };
}
export interface RawHookEvent {
  hookSeq: HookSeq;
  at: MonoMs;
  wallAt: WallMs;
  transport: 'http' | 'unix';
  event: string;
  bytes: number;
  truncated: boolean;
  payload: unknown; // parsed JSON (untrusted)
  holdable: boolean; // true only for PermissionRequest over unix
  closed?: Promise<'client_gone' | 'timeout'>; // resolves when the forwarder connection closes before our answer reached it
}
export interface HookTransport {
  start(o: { sessionShortId: string; transport: 'http' | 'unix' }): Promise<HookEndpoint>; // spawns the worker (hook-server/worker.ts); rev2: no reuse/attach
  on(l: (e: RawHookEvent) => void): Cancel;
  respond(hookSeq: HookSeq, body: object | null): boolean; // once; later calls no-op → false
  armSelfTestNonce(nonce: string | null): Promise<void>; // resolves once the worker acked; UPS endpoint (HTTP or unix) returns the constant block body for exactly this prompt
  close(heldBody: object | null): Promise<void>; // answers every held request with heldBody, stops listening, unlinks socket
  stats(): { received: number; dropped: number; truncated: number; authFailures: number; held: number; workerRestarts: number };
}
export interface HookTransportFactory {
  create(o: {
    runtimeDir: string;
    clock: Clock;
    ids: IdPort;
    maxBodyBytes: number /* 32 MiB */;
    maxHeld: number;
    maxConnections: number;
    logger: Logger;
  }): HookTransport;
}

// ---- 2.7.6 editor injection ----
export interface EditorInjector {
  setup(sessionDir: string, nodePath: string): Promise<{ visualPath: string }>; // writes 0700 sh wrapper: exec '<node>' '<editor.js>' '<arm.json>' "$@"
  stage(text: string): Promise<{ nonce: string }>; // writes staged.txt 0600 + arm.json {nonce, stagedPath, expiresAtWall}
  consumed(nonce: string, timeoutMs: number): Promise<boolean>; // editor.js writes done-<nonce> after copying
  disarm(): Promise<void>;
}
export interface EditorInjectorFactory {
  create(o: { clock: Clock; ids: IdPort }): EditorInjector;
}

// ---- 2.7.7 network proxy ----
export interface TunnelRecord {
  tunnelId: number;
  at: MonoMs;
  wallAt: WallMs;
  token: 'A' | 'none' | 'bad';
  host: string;
  port: number;
  sni?: string;
  alpn?: string[];
  kind: 'open' | 'established' | 'up' | 'down' | 'close' | 'error' | 'refused';
  bytes?: number;
  records?: number;
  lastRecordLen?: number;
  closeKind?: 'fin' | 'rst' | 'error';
  error?: string;
}
export interface NetProxy {
  readonly port: number;
  readonly pid: number;
  bindClaudePid(pid: number): Promise<void>;
  on(l: (r: TunnelRecord) => void): Cancel;
  setFault(spec: FaultSpec | null): Promise<void>; // in-process control over 0700 unix socket with a control token
  stop(): Promise<void>;
}
export interface NetProxyFactory {
  start(o: {
    tokenA: string;
    controlSocketPath: string;
    controlToken: string;
    logPath: string;
    allowPrivate: boolean;
    allowPorts: number[];
    denyPorts: number[];
  }): Promise<NetProxy>;
  // rev2 (§10 C2): no tokenB, upstream, plainHttp (absolute-form → 405), fixed port or attach
}

// ---- 2.7.8 Claude's own registry (read-only) ----
export interface ClaudeRegistryRecord {
  pid: number;
  sessionId?: string;
  version?: string;
  status?: string;
  waitingFor?: string;
  tmux?: string;
  procStart?: string;
}
export interface ClaudeRegistryReader {
  read(pid: number): Promise<ClaudeRegistryRecord | undefined>;
  scan(): Promise<ClaudeRegistryRecord[]>; // rev2: every ~/.claude/sessions/*.json whose pid is alive (preflight resume-holder check, §3.1 step 7)
}
// lenient: first complete JSON object (#96438); never opens *.key files (#100824)
