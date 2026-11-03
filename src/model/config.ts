// model/config.ts — CoreConfig and ResolvedConfig (types only; resolveConfig lives in session/config.ts) (DESIGN.md §2.6).
// ICR 0001: CoreInit (§2.9) is declared here so model/debug.ts can name it in the trace header without importing core;
// core/init.ts and core/step.ts import (and may re-export) it from here.

import type { SessionKey } from './ids.js';
import type { PermissionMode } from './state.js';
import type { MonoMs, WallMs } from './time.js';

// ---------- config.ts ----------
export interface CoreConfig {
  // part of CoreInit; recorded in the trace header so replay is exact
  timeouts: {
    submitAckMs: number;
    submitAckFirstExtraMs: number;
    submitRetries: number;
    settleMs: number;
    escGapMs: number;
    keyGapMs: number;
    dialogSettleMs: number /* 150 */;
    interruptConfirmMs: number;
    stopGraceMs: number;
    transcriptSettleMs: number;
    permBindLateMs: number;
    hookGapMs: number;
    stallMs: number;
    quietMs: number;
    genImplicitConfirmMs: number;
    interruptedHoldMs: number;
    drainMs: number;
    startupHookGraceMs: number /* 3000, the only startup grace */;
    startupMs: number;
    readyStableMs: number;
    lateTextMs: number;
    editorConsumeMs: number;
    claimTtlMs: number;
    claimMinStableMs: number /* 100 */;
    claimDialogStableMs: number /* 250 */;
    hostResumeGraceMs: number;
    adoptDialogMs: number /* 500 */;
    usageWakeCheckMs: number /* 30000: wall re-check interval */;
    authPollMs: number; /* 60000 */
  };
  permissions: {
    policy: 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll' | 'handler';
    timeoutMs: number;
    onTimeout: 'deny' | 'tui';
    screenAllow: boolean;
    allowDangerousModes: boolean;
    allowAddDirectories: boolean;
    backgroundTimeoutMs: number; /* 10000 */
  };
  input: {
    method: 'editor' | 'pasteChunks';
    chunkBytes: number;
    chunkGapMs: number;
    maxPromptBytes: number;
    mentions: 'allow' | 'reject';
    whenBusyDefault: 'wait' | 'reject';
  };
  security: { onTamper: 'alert' | 'interrupt' };
  usage: {
    autoResume: boolean;
    resumePrompt: string;
    jitterMinMs: number /* 30000 */;
    jitterMaxMs: number /* 90000 */;
    maxRearms: number;
    builtinAutoContinue: boolean;
  };
  commands: { allow: string[]; deny: string[]; refuseAlways: string[]; aliases: Readonly<Record<string, string>> }; // aliases from the profile
  channels: {
    screen: { busyPollMs: number; idlePollMs: number; retryPollMs: number; startupPollMs: number };
    network: boolean;
    messageDisplay: boolean;
    preToolUse: boolean;
  };
  selfTest: 'once' | 'always' | 'off';
}
export interface ResolvedConfig {
  // built by session/config.ts from SessionSpec (§2.11); internal
  sessionKey: SessionKey;
  cwd: string;
  cwdRealpath: string;
  claudeSessionId: string;
  resume?: string;
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
  extraArgs: string[]; // already allowlist-validated (§3.3)
  claude: {
    bin?: string;
    expectVersion: string | 'any';
    configDir: string; /* respects inherited CLAUDE_CONFIG_DIR, never introduces one */
  };
  env: { inherit: 'minimal' | 'all' | string[]; set: Record<string, string>; scrubSubprocessEnv: boolean };
  tmux: { bin?: string; cols: number; rows: number; historyLimit: number };
  hooks: {
    transport: 'auto' | 'http' | 'unix';
    overrideDisableAllHooks: boolean;
    postToolBatch: boolean;
    permissionHookTimeoutS: number;
    observationTimeoutS: number;
    messageDisplayTimeoutS: number;
  };
  trust: { mode: 'require' | 'seed'; acceptRisks: boolean };
  network: false | { faults: boolean; allowPrivate: boolean; allowPorts: number[] };
  security: {
    denyTmuxInBash: boolean;
    crossSessionInbound: 'accept' | 'hold' | 'refuse';
    mcp: 'inherit' | 'strict';
    onTamper: 'alert' | 'interrupt';
  };
  lifecycle: {
    closeGraceMs: number;
    killAfterMs: number;
    heartbeatMs: number;
    stateDir: string;
    runtimeRoot: string;
    ownerWatchPollMs: number; /* 1000 */
  };
  /** ICR 0041: absent = never suspend on idle. */
  idle?: { suspendAfterMs: number };
  debug: {
    tracePath?: string;
    raw: 'none' | 'meta' | 'full';
    retainEvents: number;
    claudeDebugFile: boolean;
    keepClaudeDebugFile: boolean;
    dumpDir?: string /* screen dumps only here, 0700 (P-SEC-42) */;
    captureLimitFixtures: boolean; /* true (§3.9) */
  };
  core: CoreConfig;
}

// ---------- §2.9 CoreInit (ICR 0001: hosted in model so the trace header can carry it) ----------
export interface CoreInit {
  sessionKey: SessionKey;
  config: CoreConfig;
  claudeVersion: string;
  initialClaudeSessionId: string;
  resume: boolean;
  startedAt: MonoMs;
  wallAt: WallMs;
  cwdRealpath: string; /* for display only; never used for a containment decision (§3.7) */
}
