// runtime/node.ts — the L3.5 composition root (DESIGN.md §1.1, §1.2, §2.10; WP-INT). It is the only module that constructs
// the real L0 adapters and wires them into the L3 session kernel:
//
//   createNodePorts(config) → Ports          every §2.7 port backed by node:* (tmux via execFile, poll+pread tail, the hook
//                                            worker, the netproxy sidecar client, editor injector, owner-watch, …).
//   createKernel(spec, {logger, signal})     resolveConfig(spec) → createNodePorts(stateDir/runtimeRoot from the config) →
//                                            createSessionKernel(ports, config).start(); resolves at `session.ready`.
//
// Rules this file keeps:
//   - one Clock instance is shared by every port that schedules (process exec timeouts, tmux, hooks, net, owner-watch,
//     state-store locks), so mono timestamps from every channel are on one base (D-03);
//   - the host env is read once through the EnvPort snapshot and passed to the adapters that record the user's editor or
//     forward TMUX_TMPDIR/HOME/TMPDIR (D-25: no adapter reads process.env itself for child envs);
//   - the runtime root is passed to the runtime-dir port only when the caller set it explicitly: the port's own candidate
//     list (macOS $TMPDIR, Linux $XDG_RUNTIME_DIR, then /tmp/ccd-<uid>) is what makes a too-long or unsafe $TMPDIR fall back
//     (P-SEC-15, P-TMUX-21 socket path length guard);
//   - the state root must equal the requested stateDir exactly (cli lifecheck asserts it; a lifecheck must never reap the
//     wrong registry);
//   - the network sidecar factory is always present; the channel is opt-in through `spec.network` (§3.10);
//   - createKernel honours `signal`: aborted before launch → AbortError, aborted during start → the kernel is killed and the
//     start rejects (the kernel tears everything down on a failed start, §3.1 step 16).
import type { SessionKernel } from '../model/kernel.js';
import type { LogFields, Logger } from '../model/logger.js';
import type { SessionSpec } from '../model/spec.js';
import type { Clock } from '../model/time.js';
import { createRealClock } from '../platform/clock/real-clock.js';
import { createEditorInjectorFactory } from '../platform/editor/injector.js';
import { createEnvPort } from '../platform/env/env-port.js';
import { createTranscriptTailFactory } from '../platform/fs-tail/tail.js';
import { createNodeHookTransportFactory } from '../platform/hook-server/transport.js';
import { createCryptoIds } from '../platform/ids/crypto-ids.js';
import { createNetProxyFactory } from '../platform/netproxy/client.js';
import type { EnvPort, Ports } from '../platform/ports.js';
import { createClaudeBinaryPort } from '../platform/process/claude-binary.js';
import { createOwnerWatchFactory } from '../platform/process/owner-watcher.js';
import { createProcessPort } from '../platform/process/process-port.js';
import { createClaudeRegistryReader } from '../platform/registry/claude-registry.js';
import { createRuntimeDirPort } from '../platform/runtime-dir/runtime-dir.js';
import { createStateStore } from '../platform/runtime-dir/state-store.js';
import { createClaudeConfigPort } from '../platform/settings/claude-config.js';
import { createSettingsFilePort } from '../platform/settings/settings-file.js';
import { createTmuxServerFactory } from '../platform/tmux/server.js';
import { resolveConfig } from '../session/config.js';
import { createSessionKernel } from '../session/kernel.js';

/** What the composition root needs to know before a config exists (cli lifecheck passes only `stateDir`). */
export interface NodePortsConfig {
  /** State root (registry, self-test cache, limit captures). Default: `$XDG_STATE_HOME|~/.local/state` + `/claude-code-driver`. */
  stateDir?: string;
  /** Explicit runtime root for session dirs and sockets. Default: the runtime-dir port's candidate list (see header). */
  runtimeRoot?: string;
  logger?: Logger;
  /** Directory searched (with its ancestors) for the consumer's `node_modules/@anthropic-ai/claude-code` (default cwd). */
  consumerDir?: string;
  /** Shared clock (default: the real performance.now/Date.now clock). */
  clock?: Clock;
  /** Shared env port (default: the real host env). */
  env?: EnvPort;
}

export interface CreateKernelOptions {
  logger?: Logger;
  signal?: AbortSignal;
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

/** A logger that drops everything (the library prints nothing unless the host asks, AL §8.1). */
export const silentLogger: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

/**
 * The default operator logger: silent unless `CCD_LOG=debug|info|warn|error` is set in the host env, then one JSON line per
 * record on stderr at or above that level. Structured fields only (the session layer never logs prompt or tool content).
 */
export function defaultLogger(env: Readonly<Record<string, string>>, write: (line: string) => void = stderrWrite): Logger {
  const want = env['CCD_LOG'];
  const min = LEVELS.indexOf(want as Level);
  if (min < 0) return silentLogger;
  const emit =
    (level: Level) =>
    (msg: string, fields?: LogFields): void => {
      if (LEVELS.indexOf(level) < min) return;
      let line: string;
      try {
        line = JSON.stringify({ level, msg, ...(fields ?? {}) });
      } catch {
        line = JSON.stringify({ level, msg, fields: '[unserializable]' });
      }
      write(line);
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

function stderrWrite(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* a closed stderr must never break the session */
  }
}

/** Build every §2.7 port from node:* adapters (one shared clock, one env snapshot). */
export function createNodePorts(config: NodePortsConfig = {}): Ports {
  const clock = config.clock ?? createRealClock();
  const env = config.env ?? createEnvPort();
  const hostEnv = env.snapshot();
  const logger = config.logger ?? defaultLogger(hostEnv);
  const uid = env.uid();
  const proc = createProcessPort({ clock, ...(hostEnv['PATH'] === undefined ? {} : { pathEnv: hostEnv['PATH'] }) });

  const ports: Ports = {
    clock,
    ids: createCryptoIds(),
    process: proc,
    env,
    claude: createClaudeBinaryPort({ process: proc, ...(config.consumerDir === undefined ? {} : { consumerDir: config.consumerDir }) }),
    runtimeDir: createRuntimeDirPort({ env, ...(config.runtimeRoot === undefined ? {} : { root: config.runtimeRoot }) }),
    state: createStateStore({ env, clock, ...(config.stateDir === undefined ? {} : { root: config.stateDir }) }),
    settingsFile: createSettingsFilePort(uid >= 0 ? { uid } : {}),
    claudeConfig: createClaudeConfigPort({ env }),
    tmux: createTmuxServerFactory({ clock, env: hostEnv, logger, ...(uid >= 0 ? { uid } : {}) }),
    tail: createTranscriptTailFactory(),
    hooks: createNodeHookTransportFactory(),
    editor: createEditorInjectorFactory({ hostEnv }),
    net: createNetProxyFactory({ process: proc, clock, logger, nodePath: env.execPath(), ownerPid: process.pid }),
    registry: createClaudeRegistryReader({ env }),
    ownerWatch: createOwnerWatchFactory({ process: proc, clock, nodePath: env.execPath(), hostEnv }),
    logger,
  };
  return ports;
}

function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  const e = new Error(typeof r === 'string' ? r : 'The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * §2.10: resolve the spec, build the real ports, create the session kernel and start it. Resolves at `session.ready`;
 * rejects with the start error (a CcdError) after the kernel tore everything down.
 */
export async function createKernel(spec: SessionSpec, o: CreateKernelOptions = {}): Promise<SessionKernel> {
  const signal = o.signal;
  const isAborted = (): boolean => signal?.aborted === true;
  if (signal !== undefined && isAborted()) throw abortError(signal);
  const env = createEnvPort();
  const config = await resolveConfig(spec, env);
  if (signal !== undefined && isAborted()) throw abortError(signal);
  const ports = createNodePorts({
    env,
    stateDir: config.lifecycle.stateDir,
    ...(spec.lifecycle?.runtimeRoot === undefined ? {} : { runtimeRoot: config.lifecycle.runtimeRoot }),
    ...(o.logger === undefined ? {} : { logger: o.logger }),
  });
  const kernel = createSessionKernel(ports, config);
  // The kill-close the abort listener starts is kept: the start may reject (E_SESSION_CLOSED, ICR 0022) while that close is
  // still running (SIGKILL escalation, tmux kill-server, trust unseed, registry archive, teardown). createKernel settles only
  // after it finished, so a host that exits right after the rejection leaves nothing behind (ICR 0024).
  let killing: Promise<unknown> | undefined;
  const killClose = (): Promise<unknown> => (killing ??= kernel.close({ mode: 'kill', reason: 'aborted' }).catch(() => undefined));
  const killOnAbort = (): void => {
    void killClose();
  };
  signal?.addEventListener('abort', killOnAbort, { once: true });
  try {
    await kernel.start();
  } catch (e) {
    if (signal !== undefined && isAborted()) {
      await killClose();
      throw abortError(signal);
    }
    throw e;
  } finally {
    signal?.removeEventListener('abort', killOnAbort);
  }
  if (signal !== undefined && isAborted()) {
    // aborted in the same tick the kernel became ready: the abort listener already ran; make sure the close finished
    await killClose();
    throw abortError(signal);
  }
  return kernel;
}
