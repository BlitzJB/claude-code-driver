// testing/index.ts — the `claude-code-driver/testing` subpath (@experimental, DESIGN.md §7 exports): the per-WP fakes (re-exported
// from their owners' folders, §8), the aggregated fake ports, the scripted Claude world, `createTestKernel`, the core scenario
// DSL, trace replay and the fast-check arbitraries. Nothing in src/ outside testing/ imports this (arch rule, §1.3).

export { FakeClock, flushMicrotasks } from '../platform/clock/fake-clock.js';
export { FakeEditorInjector, FakeEditorInjectorFactory } from '../platform/editor/fake-editor.js';
export { FakeEnv } from '../platform/env/fake-env.js';
export { FakeTailFs, FakeTranscriptTail, FakeTranscriptTailFactory } from '../platform/fs-tail/fake-tail-fs.js';
export { FakeHookTransport, createFakeHookTransportFactory } from '../platform/hook-server/fake-hooks.js';
export type { FakeHookCall, FakeHookReply, FakeHookTransportFactory } from '../platform/hook-server/fake-hooks.js';
export { FakeIds } from '../platform/ids/fake-ids.js';
export { FakeNetProxy, FakeNetProxyFactory } from '../platform/netproxy/fake-net.js';
export { FakeClaudeBinary } from '../platform/process/fake-claude-binary.js';
export { FakeOwnerWatchFactory } from '../platform/process/fake-owner-watch.js';
export { FakeProcess } from '../platform/process/fake-process.js';
export { FakeClaudeRegistry } from '../platform/registry/fake-registry.js';
export { FakeRuntimeDir } from '../platform/runtime-dir/fake-runtime-dir.js';
export { FakeStateStore } from '../platform/runtime-dir/fake-state-store.js';
export { FakeClaudeConfig, FakeSettingsFile } from '../platform/settings/fake-config.js';
export { FakeTmux, FakeTmuxPane, FakeTmuxServer } from '../platform/tmux/fake-tmux.js';

export { createFakePorts, MemoryLogger, DEFAULT_TEST_CWD, DEFAULT_TEST_HOME } from './fake-ports.js';
export type { FakePortSet, FakePortsOptions, LogRecord } from './fake-ports.js';
export { FakeClaude, FakeClaudeSession, projectSlug } from './fake-claude.js';
export type { FakeClaudeOptions, FakeStartup, FakeTurn, ToolOutcome, ToolSpec } from './fake-claude.js';
export * as screens from './screens.js';
export { DEFAULT_TEST_CORE_CONFIG, testCoreConfig, testCoreInit, TEST_SESSION_KEY, TEST_CLAUDE_SESSION_ID } from './core-config.js';
export type { CoreConfigOverrides } from './core-config.js';
export { createTestKernel, expectStartFailure, loadSessionModules, SessionNotLanded, testSpec } from './test-kernel.js';
export type { SessionModules, TestKernel, TestKernelOptions } from './test-kernel.js';
export { CoreScenario, coreScenario, defaultSource, lastIntentId, row, screenFacts } from './scenario.js';
export type { CoreApi, CoreInput, CoreScenarioOptions, CoreStepResult, MetaOverrides } from './scenario.js';
export {
  compareGolden,
  goldenEventsText,
  goldenPaths,
  goldenStateText,
  normalizeEvents,
  parseTrace,
  readTrace,
  replayObservations,
  replayRaw,
  replayTrace,
  serializeTrace,
  traceInputs,
  TraceFormatError,
  updateRequested,
} from './replay.js';
export type { GoldenComparison, RawReplayOptions, ReplayResult, Trace, TraceHeader } from './replay.js';
export {
  createArbitraries,
  delayChannel,
  dropChannel,
  duplicateAt,
  insertTicks,
  isConvergencePair,
  SEC_INPUT_VECTORS,
  swapAdjacent,
} from './arbitraries.js';
export type { Arbitraries } from './arbitraries.js';
