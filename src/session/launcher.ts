// session/launcher.ts — orchestrates `start()` steps 1–13 (DESIGN.md §3.1): preflight → servers → settings → registry →
// tmux spawn → owner-watch → process.launched → tail. Readiness (step 14), the self-test (15) and `session.ready` (16) belong
// to the core and the kernel (session/kernel.ts), which call `launchSession` and then drive the returned handles.
//
// Each step either succeeds or throws the named CcdError; on failure everything created so far is torn down in reverse
// order. The version check precedes any tmux call (K-03). Every runtime path recorded in the registry is absolute (D-38).
//
// Pitfalls handled here (§5): P-TMUX-43 / P-LIFE-09 / P-REV-09 (owner-watch started right after the pane, registry record
// written before the spawn), P-REV-44 (LP-52: the pane key mode must be VT10x → E_TMUX_UNSUPPORTED{reason:'extendedKeys'};
// the L0 server checks `#{pane_key_mode}` right after spawn and the prelude sets `extended-keys off`), P-SEC-18 (secrets only in
// the tmux starting-client env; argv scanned), P-NET-31…34 (user proxy → network channel off + warning), P-REV-27/LP-50
// (`--debug-file` only as an advanced opt-in, inside the 0700 session dir), P-REV-32 (lifecheck-target.json rewritten by every
// start), D-23 (one registry read after launch for the pid/version cross-check, retried because the file appears late),
// P-SEC-31 (settings sha256 re-checked on every SessionStart; a mismatch kills Claude), P-NET-25 / §3.10 (sidecar death kills
// Claude, never a same-port restart), §3.5 (hook worker death kills Claude; fail closed like D-28).

import { fileURLToPath } from 'node:url';

import type { ResolvedConfig } from '../model/config.js';
import type { CcdErrorCode } from '../model/errors.js';
import type { JsonValue } from '../model/json.js';
import type { ObservationInput } from '../model/observation.js';
import type { Cancel } from '../model/time.js';
import type {
  HookEndpoint,
  HookTransport,
  NetProxy,
  Ports,
  RawHookEvent,
  TailEvent,
  TmuxPane,
  TmuxServer,
  TranscriptTail,
} from '../platform/ports.js';
import { CcdError, isCctError } from '../model/errors.js';
import { LIB_VERSION } from '../model/version.js';
import { buildClaudeArgv } from './argv-builder.js';
import { argvLeaksEnvSecret, buildChildEnv, checkCallerEnv, networkEligibility, type ChildEnv } from './env-builder.js';
import { CLOSE_DENY_BODY, runSteps, SessionLifecycle, type SessionHandles } from './lifecycle.js';
import {
  checkAccount,
  checkClaudeBinary,
  checkConfigShape,
  checkCwd,
  checkExtraArgs,
  checkNode,
  checkResumeHolder,
  checkSettingsLayers,
  checkStateRoot,
  checkTerminfo,
  assessTrust,
  seedTrustKey,
  chooseHookTransport,
  mapPortError,
  probeTmux,
  type AccountInfo,
  type ClaudeBinaryInfo,
  type PreflightWarning,
  type TrustVerdict,
} from './preflight.js';
import { reap, releaseTrustLocked, terminateVerified, toolEnv, type ReapReport } from './reaper.js';
import { RegistryStore, type SessionRecord } from './registry-store.js';
import { buildSettingsPlan } from './settings-plan.js';

/** Hook transport limits (§3.5). */
export const HOOK_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const HOOK_MAX_HELD = 32;
export const HOOK_MAX_CONNECTIONS = 64;
/** Transcript tail tuning (= platform/fs-tail DEFAULT_TAIL_TUNING; L3 may not import platform values, §1.3). */
export const TAIL_TUNING = Object.freeze({
  pollIdleMs: 250,
  pollFastMs: 50,
  fastBurstMs: 3000,
  drainGraceMs: 5000,
  missingAgentTimeoutMs: 10_000,
  maxLineBytes: 64 * 1024 * 1024,
  readChunkBytes: 1024 * 1024,
  maxActiveFollowers: 32,
});
export const TAIL_SKIP_PARSE_TYPES: ReadonlySet<string> = new Set(['api-request-blob', 'api-request-shape', 'file-history-snapshot']);
const IDENTITY_RETRIES = 5;
const IDENTITY_RETRY_MS = 100;
const REGISTRY_CHECK_TRIES = 5;
const REGISTRY_CHECK_GAP_MS = 500;

export interface LaunchWarning {
  code: CcdErrorCode;
  reason: string;
  details?: Record<string, JsonValue>;
}

export interface LaunchSinks {
  /** Attached before the hook server starts, so no event is missed. */
  hook?: (e: RawHookEvent) => void;
  /** Attached before `followMain`. */
  tail?: (e: TailEvent) => void;
  /** `process.launched` (step 12). The caller's queue stamps `seq`. */
  observe?: (o: ObservationInput) => void;
  warning?: (w: LaunchWarning) => void;
  /**
   * A security alert raised by L0 (SEC §2.3: a burst of forged hook requests → `E_SECURITY_HOOK_FORGERY`). The kernel
   * publishes it as `security.alert`.
   */
  securityAlert?: (a: LaunchSecurityAlert) => void;
}

export interface LaunchSecurityAlert {
  code: 'E_SECURITY_HOOK_FORGERY';
  detail: Record<string, JsonValue>;
}

export interface LaunchOptions {
  sinks?: LaunchSinks;
  /** The owner process (default `process.pid`). */
  ownerPid?: number;
  /** Force the hook transport (the one automatic unix relaunch after an HTTP self-test failure, §3.1 step 15). */
  hookTransport?: 'http' | 'unix';
  /** selftest-cache lookup (session/selftest-cache.ts): an HTTP self-test failure for (version, cwd) within 24 h → unix. */
  httpSelfTestFailedRecently?(claudeVersion: string, cwdRealpath: string): boolean | Promise<boolean>;
  /** Step 13 `followMain` at launch (default: only when `sinks.tail` is attached; else the core's tail.followMain intent does it). */
  followTail?: boolean;
  /** Absolute `dist/cli/main.js` for lifecheck-target.json (P-REV-32); default resolved next to this module. */
  distCliPath?: string;
  /** Register in the process-exit registry and start the heartbeat (default true). */
  registerExit?: boolean;
  /** D-23 registry cross-check after launch (default true). */
  registryCrossCheck?: boolean;
  /** Run the reaper in step 3 (default true). */
  reap?: boolean;
}

export interface LaunchResult {
  handles: SessionHandles;
  lifecycle: SessionLifecycle;
  claude: ClaudeBinaryInfo;
  account: AccountInfo;
  trust: TrustVerdict;
  hookTransport: { transport: 'http' | 'unix'; reason: string };
  argv: readonly string[];
  /** Env variable names (never values). */
  childEnvNames: readonly string[];
  settingsPath: string;
  settingsSha256: string;
  expectedTranscriptPath: string;
  tmuxVersion: string;
  resumed: boolean;
  network: 'on' | 'off';
  warnings: LaunchWarning[];
  reapReport?: ReapReport;
}

/** Claude's project slug (cross-check only; the hook's `transcript_path` wins, TF §1). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function expectedTranscriptPath(configDir: string, cwdRealpath: string, sessionId: string): string {
  return `${configDir}/projects/${projectSlug(cwdRealpath)}/${sessionId}.jsonl`;
}

function defaultDistCliPath(): string | undefined {
  try {
    // fileURLToPath decodes %20 etc.; `.pathname` would record a percent-encoded path the shim cannot exec.
    return fileURLToPath(new URL('../cli/main.js', import.meta.url));
  } catch {
    return undefined;
  }
}

/** The reserved sidecar-death record of the net port (ICR 0004 item 1: tunnelId 0, kind 'error', error 'sidecarDied'). */
export function isSidecarDiedRecord(r: { tunnelId: number; kind: string; error?: string }): boolean {
  return r.tunnelId === 0 && r.kind === 'error' && r.error === 'sidecarDied';
}

/** Worker death is exposed by the concrete transport (ICR 0003 `HookTransportExtras.onDied`), not by the §2.7.5 port. */
function onWorkerDied(t: HookTransport, fn: () => void): Cancel | undefined {
  const f = (t as { onDied?: unknown }).onDied;
  if (typeof f !== 'function') return undefined;
  const off: unknown = (f as (this: HookTransport, l: () => void) => unknown).call(t, fn);
  return typeof off === 'function' ? (off as Cancel) : undefined;
}

/** Forgery bursts are exposed by the concrete transport too (ICR 0003 `HookTransportExtras.onForgery`). */
function onForgeryBurst(
  t: HookTransport,
  fn: (b: { count: number; windowMs: number; lastReason: string | undefined }) => void,
): Cancel | undefined {
  const f = (t as { onForgery?: unknown }).onForgery;
  if (typeof f !== 'function') return undefined;
  const off: unknown = (f as (this: HookTransport, l: typeof fn) => unknown).call(t, fn);
  return typeof off === 'function' ? (off as Cancel) : undefined;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function toJsonDetails(d: PreflightWarning['details']): Record<string, JsonValue> | undefined {
  if (d === undefined) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(d)) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}

/** Steps 1–13 of `start()`. */
export async function launchSession(ports: Ports, config: ResolvedConfig, o: LaunchOptions = {}): Promise<LaunchResult> {
  const log = ports.logger;
  const clock = ports.clock;
  const key = config.sessionKey;
  const ownerPid = o.ownerPid ?? process.pid;
  const warnings: LaunchWarning[] = [];
  const warn = (w: LaunchWarning): void => {
    warnings.push(w);
    log.warn(`launch: ${w.reason}`, { sessionKey: key, code: w.code });
    try {
      o.sinks?.warning?.(w);
    } catch {
      // a listener never breaks the launch
    }
  };
  const undo: { name: string; run: () => Promise<void> | void }[] = [];
  /** Undo steps that run after the reversed `undo` list (trust release, then the registry archive). */
  const finalUndo: { name: string; run: () => Promise<void> | void }[] = [];
  const offs: Cancel[] = [];
  /** Fail-closed guards (P-SEC-31, sidecar / hook worker death); handed to the lifecycle on success. */
  const guardOffs: Cancel[] = [];
  const guard: {
    lifecycle?: SessionLifecycle;
    tripped?: { reason: string; code: CcdErrorCode; immediate: boolean };
  } = {};
  const trip = (reason: string, code: CcdErrorCode, immediate: boolean): void => {
    warn({ code, reason });
    const l = guard.lifecycle;
    if (l !== undefined) void l.failClosed(reason, { immediate }).catch(() => undefined);
    else guard.tripped ??= { reason, code, immediate };
  };

  /** Map any failure of `fn` to a CcdError with the step's fallback code. */
  const step = async <T>(fallback: CcdErrorCode, what: string, fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw isCctError(e) ? e : mapPortError(e, fallback, what);
    }
  };

  try {
    // ---- 1. Config (the L3 launch parts; resolveConfig already ran) ----
    checkConfigShape(config);
    checkCallerEnv(config.env.set);
    const extraArgv = await step('E_FORBIDDEN_ARG', 'extraArgs', () => checkExtraArgs(config.extraArgs, ports.env));
    const cwdRealpath = await checkCwd(ports.env, config.cwd);
    if (cwdRealpath !== config.cwdRealpath) log.debug('launch: cwd realpath differs from the resolved config', { sessionKey: key });

    // ---- 2. Node ----
    checkNode(ports.env.nodeVersion());

    // ---- 3. Runtime and state dirs, reaper ----
    await step('E_UNSAFE_RUNTIME_DIR', 'runtime dir', () => ports.runtimeDir.ensureRoot());
    await checkStateRoot(ports.env, ports.state.root);
    const store = new RegistryStore(ports.state, () => clock.wallNow());
    const sessionDir = await step('E_UNSAFE_RUNTIME_DIR', 'session dir', () => ports.runtimeDir.createSessionDir());
    undo.push({ name: 'removeSessionDir', run: () => ports.runtimeDir.removeSessionDir(sessionDir) });
    const tEnv = toolEnv(ports.env);
    const ownerIdent = await ports.process.identity(ownerPid);
    if (ownerIdent === undefined) throw new CcdError('E_INVARIANT', `cannot read the owner process identity (pid ${ownerPid})`);
    let reapReport: ReapReport | undefined;
    if (o.reap !== false) {
      try {
        reapReport = await reap(
          {
            process: ports.process,
            clock,
            env: ports.env,
            runtimeDir: ports.runtimeDir,
            claudeConfig: ports.claudeConfig,
            logger: log,
            store,
          },
          { selfPid: ownerPid, selfStartTime: ownerIdent.startTime, reapedBy: 'reaper' },
        );
      } catch (e) {
        warn({ code: 'E_UNSAFE_RUNTIME_DIR', reason: 'reaperFailed', details: { error: e instanceof Error ? e.name : 'unknown' } });
      }
    }
    const prevOwner = await store.readOwner(ownerPid);
    const nowWall = clock.wallNow();
    await store.writeOwner({
      pid: ownerPid,
      startTime: ownerIdent.startTime,
      argv0: ports.env.execPath(),
      nodeVersion: ports.env.nodeVersion(),
      libVersion: LIB_VERSION,
      createdAt: prevOwner?.startTime === ownerIdent.startTime ? prevOwner.createdAt : nowWall,
      heartbeatAt: nowWall,
    });

    // ---- 4. Child env, phase 1 (no library proxy) ----
    const host = ports.env.snapshot();
    const envBase = {
      host,
      homeDir: ports.env.homeDir(),
      userName: ports.env.userName(),
      platform: ports.env.platform(),
      inherit: config.env.inherit,
      set: config.env.set,
      scrubSubprocessEnv: config.env.scrubSubprocessEnv,
    };
    const env1 = buildChildEnv({ ...envBase, visualPath: `${sessionDir}/ccd-editor` });
    for (const w of env1.warnings) warn({ code: w.code, reason: w.reason, details: { names: w.names } });

    // ---- 5. Claude binary and version (before any tmux call) ----
    const bin = await checkClaudeBinary(ports.claude, config.claude, env1.env);

    // ---- 6. Account ----
    const account = await checkAccount({ claudeConfig: ports.claudeConfig, claude: ports.claude, clock }, bin.exe, env1.env);

    // ---- 7. Settings layers, transport, trust, resume holder ----
    const layers = await checkSettingsLayers(ports.claudeConfig, cwdRealpath, {
      overrideDisableAllHooks: config.hooks.overrideDisableAllHooks,
    });
    for (const w of layers.warnings) {
      const details = toJsonDetails(w.details);
      warn(details === undefined ? { code: w.code, reason: w.reason } : { code: w.code, reason: w.reason, details });
    }
    for (const w of layers.envWarnings) warn({ code: w.code, reason: w.reason, details: { names: w.names } });
    const selfTestFailed =
      o.httpSelfTestFailedRecently === undefined ? false : await o.httpSelfTestFailedRecently(bin.version, cwdRealpath);
    const hookTransport =
      o.hookTransport !== undefined
        ? { transport: o.hookTransport, reason: 'forced' }
        : chooseHookTransport(config.hooks.transport, layers, selfTestFailed);
    // Checked here (fail fast); the key itself is seeded in step 11, under the registry lock and after the record exists, so a
    // crash can never leave a seeded key without a record that the reaper unseeds (ICR 0022).
    const trustPre = await assessTrust(ports.claudeConfig, cwdRealpath, config.trust);
    let trust: TrustVerdict = trustPre.seedNeeded ? { trusted: true, trustKeyAddedByLibrary: false } : trustPre.verdict;
    if (config.resume !== undefined) await checkResumeHolder(ports.registry, store, config.resume);
    const terminfo = await checkTerminfo(ports.process, ports.env, tEnv);
    if (terminfo !== undefined) {
      const details = toJsonDetails(terminfo.details);
      warn(
        details === undefined
          ? { code: terminfo.code, reason: terminfo.reason }
          : { code: terminfo.code, reason: terminfo.reason, details },
      );
    }

    // ---- 9 (before 8, see below). Hook transport + editor ----
    // The hook server starts before the sidecar so the sidecar can refuse our own hook port (SEC §6.3).
    const transport: HookTransport = ports.hooks.create({
      runtimeDir: sessionDir,
      clock,
      ids: ports.ids,
      maxBodyBytes: HOOK_MAX_BODY_BYTES,
      maxHeld: HOOK_MAX_HELD,
      maxConnections: HOOK_MAX_CONNECTIONS,
      logger: log,
    });
    const sinkHook = o.sinks?.hook;
    if (sinkHook !== undefined) offs.push(transport.on(sinkHook));
    const endpoint: HookEndpoint = await step('E_HOOKS_UNAVAILABLE', 'hook transport start', () =>
      transport.start({ sessionShortId: key, transport: hookTransport.transport }),
    );
    undo.push({ name: 'hooks.close', run: () => transport.close(CLOSE_DENY_BODY) });
    const offDied = onWorkerDied(transport, () => {
      trip('hookWorkerDied', 'E_HOOKS_UNAVAILABLE', false);
    });
    if (offDied !== undefined) guardOffs.push(offDied);
    // DESIGN §3.5 / SEC §2.3: refused hook requests are counted by the worker; a burst becomes a security alert for the host
    const offForgery = onForgeryBurst(transport, (b) => {
      const detail: Record<string, JsonValue> = { count: b.count, windowMs: b.windowMs, lastReason: b.lastReason ?? null };
      log.warn('launch: burst of forged hook requests', { sessionKey: key, count: b.count, lastReason: b.lastReason ?? 'unknown' });
      try {
        o.sinks?.securityAlert?.({ code: 'E_SECURITY_HOOK_FORGERY', detail });
      } catch {
        // a listener never breaks the transport
      }
    });
    if (offForgery !== undefined) guardOffs.push(offForgery);
    const editor = ports.editor.create({ clock, ids: ports.ids });
    const { visualPath } = await step('E_INVARIANT', 'editor setup', () => editor.setup(sessionDir, ports.env.execPath()));
    undo.push({ name: 'editor.disarm', run: () => editor.disarm() });

    // ---- 8. Network channel (opt-in) → child env phase 2 ----
    let net: NetProxy | undefined;
    let libraryProxy: { tokenA: string; port: number } | undefined;
    if (config.network !== false) {
      const elig = networkEligibility(host);
      if (ports.net === undefined) warn({ code: 'E_NETWORK_UNAVAILABLE', reason: 'noNetPort' });
      else if (!elig.ok) warn({ code: 'E_NETWORK_UNAVAILABLE', reason: elig.reason });
      else {
        const tokenA = ports.ids.tokenHex(32);
        try {
          const proxy = await ports.net.start({
            tokenA,
            controlSocketPath: `${sessionDir}/net.sock`,
            controlToken: ports.ids.tokenHex(32),
            logPath: `${sessionDir}/net.log`,
            allowPrivate: config.network.allowPrivate,
            allowPorts: config.network.allowPorts.length > 0 ? [...config.network.allowPorts] : [443],
            denyPorts: endpoint.http !== undefined ? [endpoint.http.port] : [],
          });
          net = proxy;
          undo.push({ name: 'net.stop', run: () => proxy.stop() });
          guardOffs.push(
            proxy.on((r) => {
              if (isSidecarDiedRecord(r)) trip('sidecarDied', 'E_NETWORK_UNAVAILABLE', false);
            }),
          );
          libraryProxy = { tokenA, port: proxy.port };
        } catch (e) {
          warn({
            code: 'E_NETWORK_UNAVAILABLE',
            reason: 'sidecarStartFailed',
            details: { error: e instanceof Error ? e.name : 'unknown' },
          });
        }
      }
    }
    const childEnv: ChildEnv = buildChildEnv(
      libraryProxy === undefined ? { ...envBase, visualPath } : { ...envBase, visualPath, libraryProxy },
    );
    log.debug('launch: child env', { sessionKey: key, names: childEnv.names });

    // ---- 10. Settings file ----
    const plan = buildSettingsPlan({
      endpoint,
      switches: {
        preToolUse: config.core.channels.preToolUse,
        messageDisplay: config.core.channels.messageDisplay,
        postToolBatch: config.hooks.postToolBatch,
      },
      permissionTimeoutS: config.hooks.permissionHookTimeoutS,
      observationTimeoutS: config.hooks.observationTimeoutS,
      messageDisplayTimeoutS: config.hooks.messageDisplayTimeoutS,
      crossSessionInbound: config.security.crossSessionInbound,
      denyTmuxInBash: config.security.denyTmuxInBash,
      allowedHttpHookUrlsDefined: layers.allowedHttpHookUrlsDefined,
      writeDisableAllHooksFalse: layers.writeDisableAllHooksFalse,
    });
    const settingsPath = `${sessionDir}/settings.json`;
    const written = await step('E_UNSAFE_RUNTIME_DIR', 'settings file', () => ports.settingsFile.writeExclusive(settingsPath, plan));
    // P-SEC-31: Claude reads the file at startup (and again for a /clear generation); every SessionStart re-checks the sha256.
    guardOffs.push(
      transport.on((e) => {
        if (e.event !== 'SessionStart') return;
        const check = guard.lifecycle?.verifySettingsIntegrity() ?? matchesOrTampered(ports, settingsPath, written.sha256);
        void check.then((v) => {
          if (v === 'tampered') trip('settingsTampered', 'E_SECURITY_SETTINGS_TAMPERED', true);
        });
      }),
    );

    const argvSessionId = config.resume ?? config.claudeSessionId;
    const argv = buildClaudeArgv({
      exe: bin.exe,
      ...(config.resume !== undefined ? { resume: config.resume } : { sessionId: config.claudeSessionId }),
      settingsPath,
      permissionMode: config.permissionMode,
      allowDangerousModes: config.core.permissions.allowDangerousModes,
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.effort !== undefined ? { effort: config.effort } : {}),
      strictMcp: config.security.mcp === 'strict',
      ...(config.debug.claudeDebugFile ? { debugFile: `${sessionDir}/claude-debug.log` } : {}),
      extraArgs: extraArgv,
    });
    if (argvLeaksEnvSecret(argv, childEnv.env)) throw new CcdError('E_INVARIANT', 'a secret reached the pane argv (P-SEC-18)');

    // ---- 12a. tmux probe + server (no pane yet) ----
    const probe = await probeTmux(ports.tmux, ports.process, config.tmux.bin);
    const socketName = `ccd-${ownerPid.toString(36)}-${ports.ids.shortHex(8)}`;
    const exitsLog = store.exitsLogPath(key);
    await store.appendExit(key, `launched owner=${ownerPid} wall=${clock.wallNow()}`);
    const server: TmuxServer = await step('E_TMUX_UNSUPPORTED', 'tmux server', () =>
      ports.tmux.create({
        tmuxPath: probe.path,
        socketName,
        clientEnv: childEnv.env,
        historyLimit: config.tmux.historyLimit,
        paneDiedLogPath: exitsLog,
      }),
    );
    undo.push({ name: 'tmux.kill', run: () => server.kill() });

    // ---- 11. Registry record 'launching' BEFORE the spawn ----
    const created = clock.wallNow();
    // The global config the trust key is seeded in (CLAUDE_CONFIG_DIR-aware): recorded so whoever releases it (close, a
    // reaper or lifecheck under another env) unseeds that file (ICR 0033).
    const claudeConfigPath = ports.claudeConfig.globalConfigPath();
    const record: SessionRecord = {
      v: 2,
      sessionKey: key,
      owner: { pid: ownerPid, startTime: ownerIdent.startTime },
      tmux: { bin: probe.path, socketName, socketPath: server.socketPath, sessionName: `ccd-${key}` },
      claude: { exe: bin.exe, version: bin.version },
      claudeSessionId: config.claudeSessionId,
      initialSessionId: argvSessionId,
      transcriptPath: expectedTranscriptPath(config.claude.configDir, cwdRealpath, argvSessionId),
      cwdRealpath,
      sessionDir,
      settingsFile: settingsPath,
      settingsSha256: written.sha256,
      hook: {
        transport: endpoint.transport,
        ...(endpoint.http !== undefined ? { port: endpoint.http.port } : {}),
        socketPath: endpoint.unix.socketPath,
      },
      ...(net !== undefined ? { net: { port: net.port, pid: net.pid, controlSocket: `${sessionDir}/net.sock` } } : {}),
      trustKeyAddedByLibrary: trustPre.seedNeeded,
      claudeConfigPath,
      permissionMode: config.permissionMode,
      ...(config.model !== undefined ? { model: config.model } : {}),
      state: 'launching',
      lastEventSeq: 0,
      createdAt: created,
      updatedAt: created,
    };
    // On failure these run after everything else (tmux kill, Claude terminate …): the record is archived last, so an owner
    // death during the undo still leaves a reapable record.
    finalUndo.push(
      {
        name: 'unseedTrust',
        run: async () => {
          await store.withLock(() =>
            releaseTrustLocked(
              { store, claudeConfig: ports.claudeConfig },
              { sessionKey: key, cwdRealpath, ownedHint: trust.trustKeyAddedByLibrary, configPath: claudeConfigPath },
            ),
          );
        },
      },
      {
        name: 'registry.archive',
        run: async () => {
          await store.archive(key, {
            reapedBy: 'close',
            state: 'exited',
            exit: { exitStatus: null, signal: null, reason: 'startupFailed' },
          });
        },
      },
    );
    await store.withLock(async () => {
      await store.writeSession(record);
      // Trust (D-19, ICR 0022): the record (trustKeyAddedByLibrary = we are about to seed) exists before the key is written.
      // Under the lock, a session closing in this cwd either sees this record (and keeps the key) or released it before:
      // then the check of step 7 is repeated.
      let seed = trustPre.seedNeeded;
      if (!seed && !(await ports.claudeConfig.trustOf(cwdRealpath)).trusted) {
        const again = await assessTrust(ports.claudeConfig, cwdRealpath, config.trust);
        if (again.seedNeeded) {
          seed = true;
          await store.updateSession(key, { trustKeyAddedByLibrary: true });
        } else trust = again.verdict;
      }
      if (seed) {
        const added = await seedTrustKey(ports.claudeConfig, cwdRealpath, claudeConfigPath);
        trust = { trusted: true, trustKeyAddedByLibrary: added };
        if (!added) await store.updateSession(key, { trustKeyAddedByLibrary: false });
      }
    });

    // ---- 12b. Spawn (window-size manual, remain-on-exit, pane-died hook: all in the L0 invocation, D-09) ----
    const pane: TmuxPane = await step('E_TMUX_UNSUPPORTED', 'tmux spawn', () =>
      server.spawnPane({
        sessionName: `ccd-${key}`,
        argv,
        cwd: cwdRealpath,
        cols: config.tmux.cols,
        rows: config.tmux.rows,
        nonSecretEnv: {},
      }),
    );
    const pid = pane.info.pid;
    let ident: { startTime: string; command: string } | undefined;
    for (let i = 0; i < IDENTITY_RETRIES; i++) {
      ident = await ports.process.identity(pid);
      if (ident !== undefined) break;
      await clock.sleep(IDENTITY_RETRY_MS);
    }
    const exeName = basename(bin.exe);
    if (ident?.command.includes(exeName) !== true || !ident.command.includes(argvSessionId)) {
      const st = await pane.status().catch(() => undefined);
      const cap = await pane.capture().catch(() => undefined);
      throw new CcdError('E_STARTUP_EXITED', 'the pane process is not our Claude (exited at once, or the identity check failed)', {
        details: {
          reason: ident === undefined ? 'noProcess' : 'identityMismatch',
          exitStatus: st?.exitStatus ?? null,
          finalScreen: cap === undefined ? '' : cap.lines.join('\n').trimEnd().slice(-4096),
        },
      });
    }
    const claudeStart = ident.startTime;
    // A later failure must not rely on kill-server's single SIGHUP (P-LIFE-11, P-TMUX-61): terminate the verified pid first.
    undo.push({
      name: 'claude.terminate',
      run: async () => {
        await terminateVerified(
          ports.process,
          clock,
          { pid, startTime: claudeStart, exeSubstr: exeName, sessionId: argvSessionId },
          guard.tripped?.immediate === true
            ? { graceMs: 0, killAfterMs: 1_000, startWith: 'SIGKILL' }
            : { graceMs: 1_000, killAfterMs: 1_000 },
        );
      },
    });

    // Owner-watch right after the pane (D-28): fail closed if it cannot run.
    const watchPath = `${sessionDir}/watch.json`;
    await step('E_UNSAFE_RUNTIME_DIR', 'watch.json', () =>
      ports.settingsFile.writeExclusive(watchPath, {
        ownerPid,
        ownerStart: ownerIdent.startTime,
        claudePid: pid,
        claudeStart,
        claudeExeSubstr: exeName,
        sessionIdSubstr: argvSessionId,
        tmuxBin: probe.path,
        socketName,
        ...(server.socketPath.startsWith('/') ? { socketPath: server.socketPath } : {}),
        pollMs: config.lifecycle.ownerWatchPollMs,
        exitsLog,
      }),
    );
    const ownerWatch = await step('E_INVARIANT', 'owner-watch', () =>
      ports.ownerWatch.start({ configPath: watchPath, logPath: store.ownerWatchLogPath(key) }),
    );
    undo.push({ name: 'ownerWatch.stop', run: () => ownerWatch.stop() });
    if (net !== undefined) {
      const proxy = net;
      await proxy.bindClaudePid(pid).catch((e: unknown) => {
        warn({ code: 'E_NETWORK_UNAVAILABLE', reason: 'bindClaudePidFailed', details: { error: e instanceof Error ? e.name : 'unknown' } });
      });
    }
    await store.updateSession(key, {
      claude: { pid, startTime: claudeStart, exe: bin.exe, version: bin.version },
      tmux: { ...record.tmux, paneId: pane.info.paneId },
      ownerWatch: { pid: ownerWatch.pid },
    });
    try {
      o.sinks?.observe?.({
        kind: 'process.launched',
        meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'process' },
        p: { pid, paneId: pane.info.paneId, claudeVersion: bin.version, startTime: claudeStart },
      });
    } catch {
      // a listener never breaks the launch
    }

    // ---- 13. Tail ----
    const tail: TranscriptTail = ports.tail.create({
      configDir: config.claude.configDir,
      clock,
      ...TAIL_TUNING,
      skipParseTypes: TAIL_SKIP_PARSE_TYPES,
    });
    undo.push({ name: 'tail.close', run: () => tail.close() });
    const sinkTail = o.sinks?.tail;
    if (sinkTail !== undefined) offs.push(tail.on(sinkTail));
    const transcriptPath = expectedTranscriptPath(config.claude.configDir, cwdRealpath, argvSessionId);
    // Following without a listener would drop the first lines (a resume replays history at once), so by default the launcher
    // follows only when a tail sink is attached; otherwise the core's `tail.followMain` intent (on SessionStart) starts it.
    if (o.followTail ?? sinkTail !== undefined) tail.followMain(argvSessionId, transcriptPath, { startAt: 'beginning' });

    // Lifecheck target (P-REV-32), best effort.
    const distPath = o.distCliPath ?? defaultDistCliPath();
    if (distPath !== undefined)
      await store.writeLifecheckTarget({ distPath, nodePath: ports.env.execPath(), libVersion: LIB_VERSION }).catch(() => undefined);

    const handles: SessionHandles = {
      sessionKey: key,
      config,
      sessionDir,
      cwdRealpath,
      ownerPid,
      claude: { exe: bin.exe, version: bin.version, pid, startTime: claudeStart, argvSessionId },
      tmux: { bin: probe.path, server, pane },
      hooks: { transport, endpoint },
      editor,
      tail,
      ...(net !== undefined ? { net } : {}),
      ownerWatch,
      trustKeyAddedByLibrary: trust.trustKeyAddedByLibrary,
      store,
      settings: { path: settingsPath, sha256: written.sha256 },
      toolEnv: tEnv,
    };
    // A guard that fired before the lifecycle existed (e.g. SessionStart with a tampered file) fails the start.
    const early = guard.tripped;
    if (early !== undefined) throw new CcdError(early.code, `launch aborted: ${early.reason}`, { details: { reason: early.reason } });
    const lifecycle = new SessionLifecycle(ports, handles);
    guard.lifecycle = lifecycle;
    for (const off of guardOffs.splice(0)) lifecycle.addGuard(off);
    if (o.registerExit !== false) {
      lifecycle.registerExit();
      lifecycle.startHeartbeat();
    }
    if (o.registryCrossCheck !== false) void crossCheckRegistry(ports, pid, bin.version, argvSessionId, warn, () => lifecycle.closing);

    const result: LaunchResult = {
      handles,
      lifecycle,
      claude: bin,
      account,
      trust,
      hookTransport,
      argv,
      childEnvNames: childEnv.names,
      settingsPath,
      settingsSha256: written.sha256,
      expectedTranscriptPath: transcriptPath,
      tmuxVersion: probe.version,
      resumed: config.resume !== undefined,
      network: net !== undefined ? 'on' : 'off',
      warnings,
    };
    if (reapReport !== undefined) result.reapReport = reapReport;
    return result;
  } catch (e) {
    for (const off of [...offs, ...guardOffs]) off();
    await runSteps([...[...undo].reverse(), ...finalUndo], (m, f) => {
      log.warn(m, { sessionKey: key, ...f });
    });
    throw isCctError(e) ? e : mapPortError(e, 'E_INVARIANT', 'launch failed');
  }
}

async function matchesOrTampered(ports: Pick<Ports, 'settingsFile'>, path: string, sha256: string): Promise<'intact' | 'tampered'> {
  try {
    return (await ports.settingsFile.matches(path, sha256)) ? 'intact' : 'tampered';
  } catch {
    return 'tampered';
  }
}

/** D-23: one read of `~/.claude/sessions/<pid>.json` after launch (the file appears late, ICR 0001 notes → retried). */
async function crossCheckRegistry(
  ports: Pick<Ports, 'registry' | 'clock'>,
  pid: number,
  version: string,
  sessionId: string,
  warn: (w: LaunchWarning) => void,
  stop: () => boolean,
): Promise<void> {
  for (let i = 0; i < REGISTRY_CHECK_TRIES; i++) {
    if (stop()) return;
    try {
      const rec = await ports.registry.read(pid);
      if (rec !== undefined) {
        if (rec.version !== undefined && rec.version !== version)
          warn({
            code: 'E_CLAUDE_VERSION_MISMATCH',
            reason: 'registryVersionMismatch',
            details: { expected: version, found: rec.version },
          });
        if (rec.sessionId !== undefined && rec.sessionId !== sessionId) warn({ code: 'E_INVARIANT', reason: 'registrySessionIdMismatch' });
        return;
      }
    } catch {
      // unreadable: retry
    }
    await ports.clock.sleep(REGISTRY_CHECK_GAP_MS);
  }
}
