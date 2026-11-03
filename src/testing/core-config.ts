// testing/core-config.ts — the CoreConfig / CoreInit the testing kit uses when a test or a trace does not bring its own
// (DESIGN.md §2.6, §2.9, §4.10, §6.6). Values are the §4.10 deadline defaults and the §2.6/§3.6 defaults; the canonical
// DEFAULTS table is `session/config.ts` (WP-11). `fixtures/traces/core-config.default.json` holds the same object for the
// fixture scripts (plain .mjs, which cannot import TypeScript); a unit test keeps the two identical.
import { commandsExtras, commandsProfile } from '../channels/profiles/claude-2.1.316/commands.js';
import type { CoreConfig, CoreInit } from '../model/config.js';
import type { SessionKey } from '../model/ids.js';
import type { MonoMs, WallMs } from '../model/time.js';

export const DEFAULT_TEST_CORE_CONFIG: CoreConfig = deepFreeze({
  timeouts: {
    submitAckMs: 3000,
    submitAckFirstExtraMs: 2000,
    submitRetries: 1,
    settleMs: 100,
    escGapMs: 250,
    keyGapMs: 15,
    dialogSettleMs: 150,
    interruptConfirmMs: 5000,
    stopGraceMs: 500,
    transcriptSettleMs: 5000,
    permBindLateMs: 2000,
    hookGapMs: 2000,
    stallMs: 25_000,
    quietMs: 15_000,
    genImplicitConfirmMs: 3000,
    interruptedHoldMs: 1500,
    drainMs: 5000,
    startupHookGraceMs: 3000,
    startupMs: 60_000,
    readyStableMs: 300,
    lateTextMs: 500,
    editorConsumeMs: 3000,
    claimTtlMs: 800,
    claimMinStableMs: 100,
    claimDialogStableMs: 250,
    hostResumeGraceMs: 30_000,
    adoptDialogMs: 500,
    usageWakeCheckMs: 30_000,
    authPollMs: 60_000,
  },
  permissions: {
    policy: 'handler',
    timeoutMs: 120_000,
    onTimeout: 'deny',
    screenAllow: false,
    allowDangerousModes: false,
    allowAddDirectories: false,
    backgroundTimeoutMs: 10_000,
  },
  input: { method: 'editor', chunkBytes: 400, chunkGapMs: 30, maxPromptBytes: 100_000, mentions: 'allow', whenBusyDefault: 'wait' },
  security: { onTamper: 'alert' },
  usage: { autoResume: true, resumePrompt: 'continue', jitterMinMs: 30_000, jitterMaxMs: 90_000, maxRearms: 3, builtinAutoContinue: false },
  commands: {
    allow: [...commandsExtras.allowed],
    deny: [...commandsExtras.denied],
    refuseAlways: [...commandsExtras.refusedAlways],
    aliases: { ...commandsProfile.aliases },
  },
  channels: {
    screen: { busyPollMs: 250, idlePollMs: 2000, retryPollMs: 1000, startupPollMs: 150 },
    network: false,
    messageDisplay: true,
    preToolUse: true,
  },
  selfTest: 'once',
});

/** Deep partial for overriding a CoreConfig in tests. */
export type CoreConfigOverrides = {
  [K in keyof CoreConfig]?: CoreConfig[K] extends readonly unknown[] ? CoreConfig[K] : Partial<CoreConfig[K]> | CoreConfig[K];
};

/** A fresh (mutable) CoreConfig: the defaults with `over` merged one level deep. */
export function testCoreConfig(over: CoreConfigOverrides = {}): CoreConfig {
  const base = structuredClone<CoreConfig>(DEFAULT_TEST_CORE_CONFIG);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over) as [string, unknown][]) {
    if (v === undefined) continue;
    const cur = (base as unknown as Record<string, unknown>)[k];
    out[k] =
      typeof v === 'object' && v !== null && !Array.isArray(v) && typeof cur === 'object' && cur !== null
        ? { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) }
        : v;
  }
  return out as unknown as CoreConfig;
}

export const TEST_SESSION_KEY = 's0000c0de' as SessionKey;
export const TEST_CLAUDE_SESSION_ID = '00000000-0000-4000-8000-000000000001';

/** A CoreInit for core-level scenarios and obs-only replays. */
export function testCoreInit(o: Partial<Omit<CoreInit, 'config'>> & { config?: CoreConfigOverrides | CoreConfig } = {}): CoreInit {
  const { config, ...rest } = o;
  return {
    sessionKey: TEST_SESSION_KEY,
    claudeVersion: '2.1.316',
    initialClaudeSessionId: TEST_CLAUDE_SESSION_ID,
    resume: false,
    startedAt: 1000 as MonoMs,
    wallAt: Date.UTC(2026, 10, 3, 12, 0, 0) as WallMs,
    cwdRealpath: '/work/project',
    ...rest,
    config: testCoreConfig(config ?? {}),
  };
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}
