// model/spec.ts — the internal SessionSpec, the only input of session/config.ts resolveConfig (DESIGN.md §2.11, D-39).
// Plain data, grouped by concern; every field optional except `cwd` and `permissions.policy`.

import type { CoreConfig } from './config.js';
import type { PermissionMode } from './state.js';

export interface SessionSpec {
  cwd: string;
  sessionId?: string;
  resume?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  extraArgs?: readonly string[];
  claude?: { bin?: string; expectVersion?: string | 'any' };
  env?: { inherit?: 'minimal' | 'all' | readonly string[]; set?: Readonly<Record<string, string>>; scrubSubprocessEnv?: boolean };
  tmux?: { bin?: string; cols?: number; rows?: number; historyLimit?: number };
  permissions: {
    policy: 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll' | 'handler';
    timeoutMs?: number;
    onTimeout?: 'deny' | 'tui';
    screenAllow?: boolean;
    allowDangerousModes?: boolean;
    allowAddDirectories?: boolean;
  };
  trust?: { mode?: 'require' | 'seed'; acceptRisks?: boolean };
  input?: { method?: 'editor' | 'pasteChunks'; mentions?: 'allow' | 'reject'; maxPromptBytes?: number; whenBusy?: 'wait' | 'reject' };
  hooks?: {
    transport?: 'auto' | 'http' | 'unix';
    overrideDisableAllHooks?: boolean;
    preToolUse?: boolean;
    messageDisplay?: boolean;
    postToolBatch?: boolean;
  };
  network?: false | { faults?: boolean; allowPrivate?: boolean };
  security?: {
    denyTmuxInBash?: boolean;
    crossSessionInbound?: 'accept' | 'hold' | 'refuse';
    mcp?: 'inherit' | 'strict';
    onTamper?: 'alert' | 'interrupt';
  };
  usageLimit?: {
    autoResume?: boolean;
    resumePrompt?: string;
    jitterMinMs?: number;
    jitterMaxMs?: number;
    maxRearms?: number;
    builtinAutoContinue?: boolean;
  };
  lifecycle?: { closeGraceMs?: number; killAfterMs?: number; stateDir?: string; runtimeRoot?: string };
  selfTest?: 'once' | 'always' | 'off';
  debug?: {
    tracePath?: string;
    raw?: 'none' | 'meta' | 'full';
    retainEvents?: number;
    claudeDebugFile?: boolean;
    keepClaudeDebugFile?: boolean;
    dumpDir?: string;
    captureLimitFixtures?: boolean;
  };
  timeouts?: Partial<CoreConfig['timeouts']>;
  /** ICR 0041: stop Claude after this long continuously suspendable; resume on the next call that needs it. */
  idle?: { suspendAfterMs?: number };
}
