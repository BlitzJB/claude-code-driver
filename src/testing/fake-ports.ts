// testing/fake-ports.ts — aggregates the per-WP fakes into one `Ports` object (DESIGN.md §8 rule "fakes live with their real
// adapter … WP-14 only aggregates", §2.7, §6.3). Nothing here re-implements a port: every member is the fake its L0 owner
// wrote (and ran against the shared contract suite), constructed with consistent shared state:
//   - one FakeClock drives tmux, tail polling, hooks, editor, net, state-store locks;
//   - FakeProcess knows the owner (host) process, so the owner-watch identity check and K-22 work;
//   - FakeOwnerWatch reads watch.json from wherever L3 wrote it (settings-file port or state store) and kills the
//     FakeTmux server when the owner dies;
//   - the transcript tail is either the real poll+pread tail over FakeTailFs (default, K-27 rewrite semantics) or the
//     scripted FakeTranscriptTail.
import type { LogFields, Logger } from '../model/logger.js';
import { FakeClock } from '../platform/clock/fake-clock.js';
import { FakeEditorInjectorFactory, type FakeEditorOptions } from '../platform/editor/fake-editor.js';
import { FakeEnv } from '../platform/env/fake-env.js';
import { FakeTailFs, FakeTranscriptTailFactory } from '../platform/fs-tail/fake-tail-fs.js';
import { createTranscriptTailFactory } from '../platform/fs-tail/tail.js';
import { createFakeHookTransportFactory, type FakeHookTransportFactory } from '../platform/hook-server/fake-hooks.js';
import { FakeIds } from '../platform/ids/fake-ids.js';
import { FakeNetProxyFactory } from '../platform/netproxy/fake-net.js';
import type { Ports, SettingsLayers, TranscriptTailFactory, WorkspaceRisk } from '../platform/ports.js';
import { FakeClaudeBinary, type FakeClaudeBinaryOptions } from '../platform/process/fake-claude-binary.js';
import { FakeOwnerWatchFactory } from '../platform/process/fake-owner-watch.js';
import { FakeProcess } from '../platform/process/fake-process.js';
import { FakeClaudeRegistry } from '../platform/registry/fake-registry.js';
import { FakeRuntimeDir } from '../platform/runtime-dir/fake-runtime-dir.js';
import { FakeStateStore } from '../platform/runtime-dir/fake-state-store.js';
import { FakeClaudeConfig, FakeSettingsFile } from '../platform/settings/fake-config.js';
import { FakeTmux, type FakeProgramResolver } from '../platform/tmux/fake-tmux.js';

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: LogFields;
}

/** A Logger that keeps every record (assertions on warnings; never prints). */
export class MemoryLogger implements Logger {
  readonly records: LogRecord[] = [];
  debug(msg: string, fields?: LogFields): void {
    this.push('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.push('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.push('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.push('error', msg, fields);
  }
  /** Records at or above `level`. */
  at(level: LogRecord['level']): LogRecord[] {
    const order = ['debug', 'info', 'warn', 'error'];
    return this.records.filter((r) => order.indexOf(r.level) >= order.indexOf(level));
  }
  private push(level: LogRecord['level'], msg: string, fields: LogFields | undefined): void {
    this.records.push(fields === undefined ? { level, msg } : { level, msg, fields });
  }
}

export interface FakePortsOptions {
  /** Initial mono / wall time (FakeClock defaults: mono 1000, wall 2026-11-03T12:00Z). */
  mono?: number;
  wall?: number;
  /** IANA zone the env reports (recorded in trace headers, P-REV-35). Default `UTC`. */
  timeZone?: string;
  home?: string;
  user?: string;
  uid?: number;
  /** Working directory the session will use; trusted unless `trusted:false`. */
  cwd?: string;
  /** Extra realpath mappings (e.g. `/var/x` → `/private/var/x`). */
  realpaths?: Record<string, string>;
  /** lstat entries for the path resolver (K-49). */
  entries?: Record<string, { isSymlink: boolean; isFile: boolean; isDir: boolean }>;
  /** Host env variables. */
  envVars?: Record<string, string>;
  trusted?: boolean;
  /** Parsed ~/.claude.json, or a broken-file marker. Overrides `trusted`. */
  globalConfig?: Record<string, unknown> | 'missing' | 'invalidJson';
  layers?: Partial<SettingsLayers>;
  risk?: WorkspaceRisk;
  gitRoots?: readonly string[];
  claude?: FakeClaudeBinaryOptions;
  tmuxVersion?: string;
  tmuxMissing?: boolean;
  /** 'fs' (default): the real poll+pread tail over FakeTailFs. 'scripted': FakeTranscriptTail (tests push TailEvents). */
  tail?: 'fs' | 'scripted';
  editor?: FakeEditorOptions;
  /** Include the network port (default true; the channel itself is opt-in through the spec). */
  network?: boolean;
  /** Pid of the host ("owner") process; default the real `process.pid`. */
  ownerPid?: number;
  idSeed?: string;
}

export interface FakePortSet {
  readonly ports: Ports;
  readonly clock: FakeClock;
  readonly ids: FakeIds;
  readonly process: FakeProcess;
  readonly env: FakeEnv;
  readonly claude: FakeClaudeBinary;
  readonly runtimeDir: FakeRuntimeDir;
  readonly state: FakeStateStore;
  readonly settingsFile: FakeSettingsFile;
  readonly claudeConfig: FakeClaudeConfig;
  readonly tmux: FakeTmux;
  readonly tailFs: FakeTailFs;
  /** Present when `tail:'scripted'`. */
  readonly scriptedTail: FakeTranscriptTailFactory | undefined;
  readonly hooks: FakeHookTransportFactory;
  readonly editor: FakeEditorInjectorFactory;
  readonly net: FakeNetProxyFactory;
  readonly registry: FakeClaudeRegistry;
  readonly ownerWatch: FakeOwnerWatchFactory;
  readonly logger: MemoryLogger;
  readonly ownerPid: number;
  readonly cwd: string;
  readonly home: string;
  /** Lines the owner-watch appended to each exits log, by path. */
  readonly exitLogs: Map<string, string[]>;
  /** Install the program run in every new pane (FakeClaude does this). */
  setProgram(resolver: FakeProgramResolver): void;
  /** Read a JSON file L3 wrote through the settings-file port or the state store (absolute path). */
  readWritten(path: string): unknown;
}

export const DEFAULT_TEST_CWD = '/work/project';
export const DEFAULT_TEST_HOME = '/home/tester';

export function createFakePorts(o: FakePortsOptions = {}): FakePortSet {
  const clockOpts: { mono?: number; wall?: number } = {};
  if (o.mono !== undefined) clockOpts.mono = o.mono;
  if (o.wall !== undefined) clockOpts.wall = o.wall;
  const clock = new FakeClock(clockOpts);
  const ids = new FakeIds(o.idSeed ?? 'ccd-test');
  const proc = new FakeProcess();
  const ownerPid = proc.addProcess({ command: 'node /fake/host/app.js', pid: o.ownerPid ?? process.pid });
  const home = o.home ?? DEFAULT_TEST_HOME;
  const cwd = o.cwd ?? DEFAULT_TEST_CWD;
  const env = new FakeEnv({
    home,
    user: o.user ?? 'tester',
    uid: o.uid ?? 501,
    platform: 'darwin',
    tmpDir: '/fake/tmp',
    execPath: '/fake/bin/node',
    nodeVersion: '22.23.2',
    timeZone: o.timeZone ?? 'UTC',
    vars: { LANG: 'en_US.UTF-8', SHELL: '/bin/zsh', ...(o.envVars ?? {}) },
    realpaths: { ...(o.realpaths ?? {}) },
    entries: { [cwd]: { isSymlink: false, isFile: false, isDir: true }, ...(o.entries ?? {}) },
  });
  const claude = new FakeClaudeBinary(o.claude ?? {});
  const runtimeDir = new FakeRuntimeDir({ root: '/fake/run' });
  const state = new FakeStateStore({ clock, pid: ownerPid, isAlive: (pid) => proc.isAlive(pid) });
  const settingsFile = new FakeSettingsFile();
  const global = o.globalConfig ?? {
    hasCompletedOnboarding: true,
    projects: o.trusted === false ? {} : { [cwd]: { hasTrustDialogAccepted: true } },
  };
  const cfgOpts: ConstructorParameters<typeof FakeClaudeConfig>[0] = { global };
  if (o.layers !== undefined) cfgOpts.layers = o.layers;
  if (o.risk !== undefined) cfgOpts.risk = o.risk;
  if (o.gitRoots !== undefined) cfgOpts.gitRoots = o.gitRoots;
  const claudeConfig = new FakeClaudeConfig(cfgOpts);

  let resolver: FakeProgramResolver = () => ({});
  const tmuxOpts: ConstructorParameters<typeof FakeTmux>[0] = {
    clock,
    program: (argv, spawn) => resolver(argv, spawn),
    uid: o.uid ?? 501,
  };
  if (o.tmuxVersion !== undefined) tmuxOpts.version = o.tmuxVersion;
  if (o.tmuxMissing !== undefined) tmuxOpts.missing = o.tmuxMissing;
  const tmux = new FakeTmux(tmuxOpts);

  const tailFs = new FakeTailFs();
  const scriptedTail = o.tail === 'scripted' ? new FakeTranscriptTailFactory() : undefined;
  const tail: TranscriptTailFactory = scriptedTail ?? createTranscriptTailFactory(tailFs);
  const hooks = createFakeHookTransportFactory();
  const editor = new FakeEditorInjectorFactory(o.editor ?? {});
  const net = new FakeNetProxyFactory({ clock });
  const registry = new FakeClaudeRegistry((pid) => proc.isAlive(pid));
  const exitLogs = new Map<string, string[]>();

  const readWritten = (path: string): unknown => {
    const fromSettings = settingsFile.read(path);
    if (fromSettings !== undefined) return fromSettings;
    const root = `${state.root}/`;
    if (path.startsWith(root)) {
      const t = state.files.get(path.slice(root.length));
      if (t !== undefined) return JSON.parse(t) as unknown;
    }
    return undefined;
  };

  const ownerWatch = new FakeOwnerWatchFactory({
    process: proc,
    readConfig: readWritten,
    onKillServer: (cfg) => {
      const server = tmux.server(cfg.socketName);
      if (server === undefined) return;
      for (const p of server.panes) if (!p.removed) p.exitPane({ status: null, signal: 'SIGHUP' });
      server.vanish();
    },
    appendExit: (path, line) => {
      const list = exitLogs.get(path) ?? [];
      list.push(line);
      exitLogs.set(path, list);
    },
  });
  const logger = new MemoryLogger();

  const ports: Ports = {
    clock,
    ids,
    process: proc,
    env,
    claude,
    runtimeDir,
    state,
    settingsFile,
    claudeConfig,
    tmux,
    tail,
    hooks,
    editor,
    registry,
    ownerWatch,
    logger,
    ...(o.network === false ? {} : { net }),
  };

  return {
    ports,
    clock,
    ids,
    process: proc,
    env,
    claude,
    runtimeDir,
    state,
    settingsFile,
    claudeConfig,
    tmux,
    tailFs,
    scriptedTail,
    hooks,
    editor,
    net,
    registry,
    ownerWatch,
    logger,
    ownerPid,
    cwd,
    home,
    exitLogs,
    setProgram(r: FakeProgramResolver): void {
      resolver = r;
    },
    readWritten,
  };
}
