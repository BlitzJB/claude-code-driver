// channels/profiles/index.ts — profile types and selectProfile (DESIGN.md §2.8). WP-00; never edited after Phase 0.
// Every version-specific string lives in profiles/claude-<version>/* (P-API-01); ScreenFacts stay profile-free.

import type { StartupGateKind, ScreenFacts } from '../../model/screen-facts.js';
import type { PermissionMode } from '../../model/state.js';
import type { WallMs } from '../../model/time.js';
import type { UsageProfile } from './claude-2.1.316/usage.js';
import { profile as profile2_1_316 } from './claude-2.1.316/index.js';

// channels/profiles/index.ts  (WP-00; never edited after Phase 0)
export interface ScreenStrings {
  spinnerGlyphs: string; // '·✢✳✶✻✽*●'
  statusRegexes: Readonly<
    Record<
      | 'spinner'
      | 'retrying'
      | 'retryingReset'
      | 'stalled'
      | 'noResponse'
      | 'lowPriority'
      | 'autoModeUnavailable'
      | 'done'
      | 'waitingBackground'
      | 'interrupted'
      | 'hookWait',
      RegExp
    >
  >; // SP §13 verbatim; order = statusOrder
  statusOrder: readonly string[];
  footer: { escToInterrupt: RegExp; modeLabels: Readonly<Record<string, PermissionMode>>; pasting: RegExp; ctrlCExit: RegExp };
  composer: {
    promptGlyph: string /* '❯' */;
    ruleChar: string /* '─' */;
    notices: Readonly<Record<NonNullable<ScreenFacts['composer']>['notices'][number], RegExp>>;
    pastedPlaceholder: RegExp; /* /\[Pasted text #\d+/ */
  };
  dialogs: {
    permissionQuestion: RegExp;
    optionLine: RegExp;
    escFooter: RegExp;
    trustTitle: RegExp;
    resumeTitle: RegExp;
    usageMenu: RegExp;
    survey: RegExp;
    rewind: RegExp;
    elicitation?: RegExp;
    planApproval?: RegExp;
    question?: RegExp;
  }; // optional entries are UNVERIFIED (LP-46/51)
  exited: RegExp;
  headerVersion: RegExp;
  agentPanelRow: RegExp;
  hookErrorLine: RegExp;
  apiErrorLine: RegExp;
  tipLine: RegExp;
}
export interface ClaudeProfile {
  version: '2.1.316';
  hooks: {
    observationEvents: readonly string[];
    commandEvents: readonly ['SessionStart', 'PermissionRequest'];
    neverRegister: readonly string[];
  };
  transcript: {
    mergePolicy: Readonly<Record<string, 'transcript' | 'boundary-cleared' | 'accumulate' | 'last-wins'>>;
    skipParsePrefixes: readonly string[];
    markers: {
      interrupted: string;
      interruptedForToolUse: string;
      userRejectedToolResultPrefix: string;
      noResponseRequested: string;
      syntheticModel: '<synthetic>';
      safetyClassifierStop: string; /* 'Your response above was stopped by a safety classifier' */
    };
    notRealUserText: RegExp; /* ZHe */
  };
  screen: ScreenStrings;
  errors: {
    usageLimitPrefixes: readonly string[];
    limitNames: Readonly<Record<string, string>>;
    authLines: readonly RegExp[];
    versionTooOld: RegExp;
    startupGates: Readonly<Record<StartupGateKind, readonly RegExp[]>>;
    parseResetText(text: string, wallAt: WallMs, tz: string): WallMs | undefined;
  }; // rev2 (§3.9); tz comes from L3 (recorded in the trace header)
  commands: { aliases: Readonly<Record<string, string>> /* {'/quit':'/exit','/new':'/clear','/reset':'/clear'} VERIFIED-BIN */ };
  /** ICR 0040: parser for the `/usage` dialog text. */
  usage: UsageProfile;
}

const PROFILES: Readonly<Record<string, ClaudeProfile>> = Object.freeze({ [profile2_1_316.version]: profile2_1_316 });

/** Exact version match only: an unknown Claude version has no profile (BRIEF: fail loudly, E_CLAUDE_VERSION_MISMATCH upstream). */
export function selectProfile(version: string): ClaudeProfile | { unsupported: string } {
  const p = Object.prototype.hasOwnProperty.call(PROFILES, version) ? PROFILES[version] : undefined;
  return p ?? { unsupported: version };
}
