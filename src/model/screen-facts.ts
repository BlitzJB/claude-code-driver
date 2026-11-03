// model/screen-facts.ts — profile-free screen facts (DESIGN.md §2.3).

import type { WallMs } from './time.js';

export type StartupGateKind =
  | 'configError'
  | 'settingsError'
  | 'onboarding'
  | 'login'
  | 'trust'
  | 'apiKey'
  | 'bypass'
  | 'mcpApproval'
  | 'claudeMdImports'
  | 'rendererOffer'
  | 'sessionInUse'
  | 'resumeDialog'
  | 'other';
export interface ScreenOption {
  n?: number;
  label: string;
  selected: boolean;
}
export interface ScreenFacts {
  surface:
    | 'main'
    | 'permissionDialog'
    | 'trustDialog'
    | 'usageLimitMenu'
    | 'resumeDialog'
    | 'startupGate'
    | 'modal'
    | 'unknownModal'
    | 'exited'
    | 'blank'
    | 'partialFrame'
    | 'unsupportedRenderer'
    // ICR 0007 (LP-01, ICR 0001 item 3): the pane is on the alternate screen because Claude handed the composer to the
    // external editor (C-g). Transient; never degrades the screen channel and never starts a claim (core, WP-09).
    | 'editorOpen';
  torn: boolean;
  altScreen: boolean;
  inCopyMode: boolean;
  paneWidth: number;
  paneHeight: number;
  frameHash: string; // hash of normalized bottom region
  status?: {
    kind:
      | 'spinner'
      | 'retrying'
      | 'retryingUnparsed'
      | 'stalled'
      | 'noResponse'
      | 'lowPriority'
      | 'autoModeUnavailable'
      | 'done'
      | 'waitingBackground'
      | 'interrupted'
      | 'none';
    attempt?: number;
    max?: number;
    retryInMs?: number;
    truncatedMsg?: boolean;
    errorHint?: 'rateLimit' | 'proxy' | 'network' | 'api' | 'unknown'; // from the untruncated prefix only
    resetText?: string;
    resetsAtWall?: WallMs; // rev2: `(<reset>)` form of the rate-limit retry line (SP §16 Q7, LP-30)
    hookWait?: { event: string; done: number; total: number }; // `running PreToolUse hooks… 1/2`
    tokens?: { dir: 'up' | 'down'; count: number };
    elapsedMs?: number;
    thinkingLabel?: string;
    doneDurationMs?: number;
    waitingBackground?: { agents?: number; workflows?: number };
  };
  interruptedBanner: boolean; // `⎿  Interrupted · …` in the last block, no newer prompt echo
  footer?: {
    busy: boolean;
    modeLabel: string | null;
    mode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk';
    pasting: boolean;
    ctrlCExitArmed: boolean;
    hints: string[];
  };
  composer?: {
    text: string;
    empty: boolean;
    placeholderLikely: boolean;
    pastedPlaceholder: boolean;
    notices: Array<'invisibleChars' | 'blockedByHook' | 'unknownCommand' | 'escAgainToClear' | 'stashed' | 'draftRestored'>;
  };
  dialog?: {
    kind:
      | 'permission'
      | 'trust'
      | 'usageLimitMenu'
      | 'resume'
      | 'survey'
      | 'rewind'
      | 'elicitation'
      | 'planApproval'
      | 'question'
      | 'gate'
      | 'other';
    gate?: StartupGateKind;
    title?: string;
    question?: string;
    options: ScreenOption[];
    footer?: string;
  };
  usageLimit?: {
    line: string;
    limitName?: string;
    resetsText?: string;
    resetsAtWall?: WallMs; // rev2: parsed in L1 by profile errors.ts parseResetText(text, meta.wallAt, tz) (§3.9)
    autoContinue?: 'waiting' | 'resetContinuing' | 'stalePressEnter' | 'cancelled' | 'stopped' | 'none';
  };
  auth?: { kind: 'loginExpired' | 'notLoggedIn' | 'tokenRevoked' | 'refreshLock' | 'transient' | 'other'; line: string };
  apiErrorLine?: string; // `API Error: …` (classification hint only)
  versionTooOld?: boolean; // claude_code_version_too_old regex (LC §11)
  hookErrorLines: number; // `<Event>:<Tool> hook error` lines in the last block
  agentPanelRows: number;
  headerVersion?: string; // `Claude Code v2.1.316`
}
