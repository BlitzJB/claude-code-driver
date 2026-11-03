// test/unit/session/wp12-helpers.ts — shared fixtures of the WP-12 tests (launch + lifecycle): a ResolvedConfig over the fake
// ports, a pump that drives the FakeClock until a promise settles, and a launched session with a FakeClaude world.
import type { ResolvedConfig } from '../../../src/model/config.js';
import type { SessionKey } from '../../../src/model/ids.js';
import type { WallMs } from '../../../src/model/time.js';
import type { SessionRecord } from '../../../src/session/registry-store.js';
import { launchSession, type LaunchOptions, type LaunchResult } from '../../../src/session/launcher.js';
import { DEFAULT_TEST_CORE_CONFIG, TEST_CLAUDE_SESSION_ID, TEST_SESSION_KEY } from '../../../src/testing/core-config.js';
import { FakeClaude, type FakeClaudeOptions } from '../../../src/testing/fake-claude.js';
import { createFakePorts, type FakePortSet, type FakePortsOptions } from '../../../src/testing/fake-ports.js';

export type ConfigOverrides = {
  [K in keyof ResolvedConfig]?: ResolvedConfig[K] extends object
    ? ResolvedConfig[K] extends unknown[]
      ? ResolvedConfig[K]
      : Partial<ResolvedConfig[K]>
    : ResolvedConfig[K];
};

export function testConfig(fakes: FakePortSet, over: ConfigOverrides = {}): ResolvedConfig {
  const base: ResolvedConfig = {
    sessionKey: TEST_SESSION_KEY,
    cwd: fakes.cwd,
    cwdRealpath: fakes.cwd,
    claudeSessionId: TEST_CLAUDE_SESSION_ID,
    permissionMode: 'default',
    extraArgs: [],
    claude: { expectVersion: '2.1.316', configDir: `${fakes.home}/.claude` },
    env: { inherit: 'minimal', set: {}, scrubSubprocessEnv: false },
    tmux: { cols: 250, rows: 80, historyLimit: 10_000 },
    hooks: {
      transport: 'auto',
      overrideDisableAllHooks: false,
      postToolBatch: false,
      permissionHookTimeoutS: 330,
      observationTimeoutS: 5,
      messageDisplayTimeoutS: 3,
    },
    trust: { mode: 'require', acceptRisks: false },
    network: false,
    security: { denyTmuxInBash: false, crossSessionInbound: 'refuse', mcp: 'inherit', onTamper: 'alert' },
    lifecycle: {
      closeGraceMs: 12_000,
      killAfterMs: 3_000,
      heartbeatMs: 10_000,
      stateDir: fakes.state.root,
      runtimeRoot: fakes.runtimeDir.root,
      ownerWatchPollMs: 1_000,
    },
    debug: { raw: 'none', retainEvents: 1000, claudeDebugFile: false, keepClaudeDebugFile: false, captureLimitFixtures: true },
    core: structuredClone<ResolvedConfig['core']>(DEFAULT_TEST_CORE_CONFIG),
  };
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const cur = (base as unknown as Record<string, unknown>)[k];
    out[k] = typeof v === 'object' && !Array.isArray(v) && typeof cur === 'object' && cur !== null ? { ...cur, ...(v as object) } : v;
  }
  return out as unknown as ResolvedConfig;
}

/** Drive the FakeClock in `stepMs` steps until `p` settles (rejects after `maxMs` of fake time). */
export async function pump<T>(fakes: FakePortSet, p: Promise<T>, maxMs = 120_000, stepMs = 10): Promise<T> {
  const st: { done: boolean; failed: boolean; value?: T; error?: unknown } = { done: false, failed: false };
  p.then(
    (v) => {
      st.done = true;
      st.value = v;
    },
    (e: unknown) => {
      st.done = true;
      st.failed = true;
      st.error = e;
    },
  );
  const settled = (): boolean => st.done;
  let spent = 0;
  for (;;) {
    for (let i = 0; i < 5 && !settled(); i++) await new Promise<void>((r) => setImmediate(r));
    if (settled()) break;
    if (spent >= maxMs) throw new Error(`pump: promise did not settle within ${maxMs} ms of fake time`);
    await fakes.clock.advanceAsync(stepMs);
    spent += stepMs;
  }
  if (st.failed) throw st.error;
  return st.value as T;
}

export interface Launched {
  fakes: FakePortSet;
  world: FakeClaude;
  config: ResolvedConfig;
  result: LaunchResult;
}

export async function launchWorld(
  o: {
    ports?: FakePortsOptions;
    claude?: FakeClaudeOptions;
    config?: ConfigOverrides;
    launch?: LaunchOptions;
    fakes?: FakePortSet;
    world?: FakeClaude;
  } = {},
): Promise<Launched> {
  const fakes = o.fakes ?? createFakePorts(o.ports ?? {});
  const world = o.world ?? new FakeClaude(fakes, o.claude ?? {});
  const config = testConfig(fakes, o.config ?? {});
  const result = await pump(fakes, launchSession(fakes.ports, config, { registerExit: false, ...(o.launch ?? {}) }));
  return { fakes, world, config, result };
}

export const KEY2 = 's00000002' as SessionKey;

/** A complete v2 session record (registry/reaper tests). */
export function record(key: SessionKey = TEST_SESSION_KEY, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    v: 2,
    sessionKey: key,
    owner: { pid: 4242, startTime: 'Tue Nov  3 09:00:01 2026' },
    tmux: {
      bin: '/opt/homebrew/bin/tmux',
      socketName: 'ccd-39a-0011aabb',
      socketPath: '/tmp/tmux-501/ccd-39a-0011aabb',
      sessionName: `ccd-${key}`,
    },
    claude: { pid: 50000, startTime: 'Tue Nov  3 09:00:02 2026', exe: '/n/bin/claude.exe', version: '2.1.316' },
    claudeSessionId: '00000000-0000-4000-8000-000000000001',
    initialSessionId: '00000000-0000-4000-8000-000000000001',
    cwdRealpath: '/work/project',
    sessionDir: '/fake/run/ccd-000001',
    settingsFile: '/fake/run/ccd-000001/settings.json',
    settingsSha256: 'ab'.repeat(32),
    hook: { transport: 'http', port: 45000, socketPath: '/fake/run/ccd-000001/h.sock' },
    trustKeyAddedByLibrary: false,
    permissionMode: 'default',
    state: 'ready',
    lastEventSeq: 0,
    createdAt: 1 as WallMs,
    updatedAt: 1 as WallMs,
    ...over,
  };
}
