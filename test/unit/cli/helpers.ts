// test/unit/cli/helpers.ts — in-memory hosts for the cli unit tests.
import type { Classification, InstallHost, LifecheckHost, ReapedLine, ReapPassResult, SessionRecord } from '../../../src/cli/host.js';

export const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

export function rec(key: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key,
    v: 2,
    owner: { pid: 100, startTime: 'Tue Nov  3 11:00:00 2026' },
    tmux: {
      bin: '/opt/homebrew/bin/tmux',
      socketName: `ccd-100-${key}`,
      socketPath: `/tmp/tmux-501/ccd-100-${key}`,
      sessionName: `ccd-${key}`,
    },
    claude: { pid: 200, startTime: 'Tue Nov  3 11:00:01 2026', exe: '/x/claude.exe' },
    claudeSessionId: `uuid-${key}`,
    state: 'idle',
    ...over,
  };
}

export interface MemLifecheckState {
  sessions: SessionRecord[];
  classes: Map<string, { classification: Classification; heartbeatAt?: number }>;
  exits: Map<string, string[]>;
  calls: string[];
  written: unknown[];
  logs: string[];
  pass: ReapPassResult;
  reapError?: Error;
  listError?: Error;
  throwFor?: string;
  signalOk: boolean;
  now: number;
}

export const emptyPass = (over: Partial<ReapPassResult> = {}): ReapPassResult => ({
  reaped: [],
  skippedLive: [],
  socketsUnlinked: [],
  unknownCcdSockets: 0,
  sweptDirs: [],
  prunedArchive: [],
  ownersRemoved: [],
  errors: [],
  ...over,
});

export function memLifecheck(over: Partial<MemLifecheckState> = {}): { host: LifecheckHost; s: MemLifecheckState } {
  const s: MemLifecheckState = {
    sessions: [],
    classes: new Map(),
    exits: new Map(),
    calls: [],
    written: [],
    logs: [],
    pass: emptyPass(),
    signalOk: true,
    now: NOW,
    ...over,
  };
  const host: LifecheckHost = {
    stateDir: '/state',
    libVersion: '9.9.9',
    distPath: '/pkg/dist/cli/main.js',
    nowWall: () => s.now,
    listSessions: () => (s.listError ? Promise.reject(s.listError) : Promise.resolve(s.sessions)),
    classify: (r) => {
      s.calls.push(`classify:${r.key}`);
      if (s.throwFor === r.key) return Promise.reject(new Error('ps failed'));
      return Promise.resolve(s.classes.get(r.key) ?? { classification: 'owned-alive', heartbeatAt: s.now });
    },
    readExits: (k) => Promise.resolve(s.exits.get(k) ?? []),
    reapPass: () => {
      s.calls.push('reapPass');
      return s.reapError ? Promise.reject(s.reapError) : Promise.resolve(s.pass);
    },
    signalOwnerDiagnostics: (o) => {
      s.calls.push(`sigusr2:${o.pid}`);
      return Promise.resolve(s.signalOk);
    },
    writeLifecheckJson: (r) => {
      s.written.push(JSON.parse(JSON.stringify(r)));
      return Promise.resolve();
    },
    log: (l) => s.logs.push(l),
  };
  return { host, s };
}

export const reapedLine = (key: string, over: Partial<ReapedLine> = {}): ReapedLine => ({
  key,
  claude: 'terminated',
  server: 'killed',
  socketUnlinked: true,
  sessionDirRemoved: true,
  trustUnseeded: false,
  ...over,
});

export interface MemFs {
  files: Map<string, { text: string; mode: number }>;
  runs: { file: string; args: string[] }[];
  sleeps: number[];
  runResult: (file: string, args: readonly string[]) => { code: number | null; stdout: string; stderr: string };
}

export function memInstall(
  over: Partial<Pick<InstallHost, 'platform' | 'stateDir' | 'homeDir' | 'nodePath' | 'distPath'>> = {},
  fs: Partial<MemFs> = {},
): { host: InstallHost; fs: MemFs } {
  const m: MemFs = {
    files: new Map(),
    runs: [],
    sleeps: [],
    runResult: () => ({ code: 0, stdout: '', stderr: '' }),
    ...fs,
  };
  const host: InstallHost = {
    stateDir: '/Users/u/.local/state/claude-code-driver',
    homeDir: '/Users/u',
    uid: 501,
    platform: 'darwin',
    nodePath: '/Users/u/.nvm/versions/node/v22.23.2/bin/node',
    distPath: '/Users/u/proj/node_modules/claude-code-driver/dist/cli/main.js',
    ...over,
    nowWall: () => NOW,
    exists: (p) => Promise.resolve(m.files.has(p)),
    readText: (p) => Promise.resolve(m.files.get(p)?.text),
    writeFile: (p, text, mode) => {
      m.files.set(p, { text, mode });
      return Promise.resolve();
    },
    touch: (p, mode) => {
      m.files.set(p, { text: m.files.get(p)?.text ?? '', mode });
      return Promise.resolve();
    },
    remove: (p) => {
      m.files.delete(p);
      return Promise.resolve();
    },
    run: (file, args) => {
      m.runs.push({ file, args: [...args] });
      return Promise.resolve(m.runResult(file, args));
    },
    sleep: (ms) => {
      m.sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return { host, fs: m };
}
