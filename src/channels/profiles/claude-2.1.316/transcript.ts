// channels/profiles/claude-2.1.316/transcript.ts — OWNED BY WP-06 (DESIGN.md §1.2, §2.4; transcript-format.md §3–§8).
// Entry types, the binary's merge-policy table, marker strings and regexes of the 2.1.316 transcript JSONL format.
// `transcriptProfile` has the fixed export name and type the WP-00 assembly imports (§8); `transcriptExtras` carries the
// rest of the version-specific vocabulary (no slot in the assembly type), selected by version in channels/transcript/normalize.ts.

import type { ClaudeProfile } from '../index.js';

/**
 * Binary merge-policy table `jco` (transcript-format.md §3, VERIFIED-BIN 2.1.316). Unknown types default to `accumulate`
 * (`Wco(e){return jco[e]??"accumulate"}`).
 */
const MERGE_POLICY = {
  user: 'transcript',
  assistant: 'transcript',
  system: 'transcript',
  attachment: 'transcript',
  progress: 'boundary-cleared',
  'file-history-snapshot': 'boundary-cleared',
  'file-history-delta': 'boundary-cleared',
  'last-prompt': 'boundary-cleared',
  'continued-in': 'boundary-cleared',
  'api-request-shape': 'boundary-cleared',
  'api-request-blob': 'boundary-cleared',
  'api-request': 'boundary-cleared',
  'content-replacement': 'accumulate',
  'fork-context-ref': 'accumulate',
  'frame-link': 'accumulate',
  'artifact-comment-monitor': 'accumulate',
  'memory-mode': 'accumulate',
  summary: 'last-wins',
  'custom-title': 'last-wins',
  'ended-by-model': 'last-wins',
  'ai-title': 'last-wins',
  tag: 'last-wins',
  relocated: 'last-wins',
  'agent-name': 'last-wins',
  'agent-color': 'last-wins',
  'agent-setting': 'last-wins',
  'pr-link': 'last-wins',
  'artifact-autoreact-ledger': 'last-wins',
  'bridge-session': 'last-wins',
  'history-suppression': 'last-wins',
  'attribution-snapshot': 'last-wins',
  mode: 'last-wins',
  'permission-mode': 'last-wins',
  'isolation-latch': 'last-wins',
  'dev-mods': 'last-wins',
  'atis-latch': 'last-wins',
  'tools-used': 'last-wins',
  'worktree-state': 'last-wins',
  'cost-state': 'last-wins',
  'queue-operation': 'last-wins',
  'observer-ref': 'last-wins',
} as const;

/**
 * Line prefixes the tail may skip without JSON.parse (P-TAIL-14): the bulk of file size; the key order puts `type` first for
 * these (VERIFIED fixtures). The closing quote matters: `{"type":"api-request"` alone would also match `api-request-blob`.
 */
const SKIP_PARSE_PREFIXES = ['{"type":"api-request-blob"', '{"type":"api-request-shape"', '{"type":"file-history-snapshot"'] as const;

export const transcriptProfile: ClaudeProfile['transcript'] = Object.freeze({
  mergePolicy: Object.freeze({ ...MERGE_POLICY }),
  skipParsePrefixes: Object.freeze([...SKIP_PARSE_PREFIXES]),
  markers: Object.freeze({
    interrupted: '[Request interrupted by user]',
    interruptedForToolUse: '[Request interrupted by user for tool use]',
    userRejectedToolResultPrefix: "The user doesn't want to proceed with this tool use.",
    noResponseRequested: 'No response requested.',
    syntheticModel: '<synthetic>' as const,
    safetyClassifierStop: 'Your response above was stopped by a safety classifier',
  }),
  // Binary `ZHe` (TF §4.2 item 6, VERIFIED-BIN): text that is not a real user prompt (P-TX-06).
  notRealUserText: /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/,
});

/** Tag names of local-command and bash-mode user entries (TF §4.4 `local_command`, IN §4.2; VERIFIED corpus 2.1.316). */
const TAGS = Object.freeze({
  commandName: 'command-name',
  commandMessage: 'command-message',
  commandArgs: 'command-args',
  localCommandStdout: 'local-command-stdout',
  localCommandStderr: 'local-command-stderr',
  bashInput: 'bash-input',
  bashStdout: 'bash-stdout',
  bashStderr: 'bash-stderr',
  toolUseError: 'tool_use_error',
});

export interface TranscriptExtras {
  /** Types whose lines the tail may skip-parse; they never yield an observation (P-TAIL-14). */
  readonly skipParseTypes: readonly string[];
  /** Types known to the normalizer that carry no fact the core needs (dropped silently, counted). */
  readonly ignoredTypes: readonly string[];
  /** `system` subtypes that are persisted but carry no fact the core needs (TF §4.4). */
  readonly ignoredSystemSubtypes: readonly string[];
  readonly tags: typeof TAGS;
  /**
   * Leading tags Claude itself writes into user text entries that are never a typed prompt (ICR 0025). `ZHe` matches any
   * leading `<tag`, which also hits real prompts (`<div> breaks layout`, `<pasted_content …>` pastes, VERIFIED corpus
   * 2.1.316: origin human, no isMeta), so a tag-led text is not-real only when its tag is listed here.
   */
  readonly generatedLeadTags: readonly string[];
  /** LP-47 (VERIFIED-LIVE): a hook-blocked UPS writes only this `system/informational` entry. */
  readonly blockedByHook: {
    readonly endingKind: string;
    readonly contentPrefix: string;
    readonly originalPromptMarker: string;
  };
  /** `last-prompt.leafUuid` of a withdrawn checkpoint (TF §4.7, TT §5.4: also `null` after `/clear`). */
  readonly zeroLeafUuid: string;
  /** meta.uuid of `api-request` records (D-42). */
  readonly apiRequestUuidPrefix: string;
  /** Only ids with this prefix are tool ids; hook attachments for UPS/Stop carry a plain uuid (P-REC-38). */
  readonly toolUseIdPrefix: string;
  /** `toolUseResult.status` of an async (background) Agent launch. */
  readonly asyncLaunchedStatus: string;
  /** `toolDenialKind` that marks an interrupted tool (TF §8.5). */
  readonly interruptedDenialKind: string;
  /** `toolDenialKind` of a rejection at a permission prompt; assigned from the rejection text when the field is absent. */
  readonly userRejectedDenialKind: string;
  /** `permissionDecision.source` → decider (RC §2.3). `config` + `reasonType:'classifier'` → classifier. */
  readonly deciderBySource: Readonly<Record<string, 'hook' | 'user_keys' | 'config' | 'classifier'>>;
  readonly classifierReasonType: string;
  /** Hook-attachment types → `hookchannel.error.kind` (RC §2.3, LV §Q1). */
  readonly hookErrorAttachments: Readonly<Record<string, 'non_blocking_error' | 'cancelled'>>;
  /** `hook_permission_decision.decision` → transcript decision. */
  readonly attachmentDecision: Readonly<Record<string, 'accept' | 'reject'>>;
  readonly attachments: {
    readonly hookPermissionDecision: string;
    readonly queuedCommand: string;
    readonly taskStatus: string;
  };
  /** Assistant content block types; `redacted_thinking` folds into `thinking`. */
  readonly blockTypes: Readonly<Record<string, 'thinking' | 'text' | 'tool_use'>>;
  /** Max characters of tool_result text kept as `contentPreview`. */
  readonly previewChars: number;
}

export const transcriptExtras: TranscriptExtras = Object.freeze({
  skipParseTypes: Object.freeze(['api-request-blob', 'api-request-shape', 'file-history-snapshot']),
  ignoredTypes: Object.freeze([
    'progress',
    'file-history-delta',
    'content-replacement',
    'fork-context-ref',
    'frame-link',
    'artifact-comment-monitor',
    'memory-mode',
    'summary',
    'custom-title',
    'ended-by-model',
    'ai-title',
    'tag',
    'agent-name',
    'agent-color',
    'agent-setting',
    'pr-link',
    'artifact-autoreact-ledger',
    'bridge-session',
    'history-suppression',
    'attribution-snapshot',
    'mode',
    'isolation-latch',
    'dev-mods',
    'atis-latch',
    'tools-used',
    'worktree-state',
    'cost-state',
    'observer-ref',
  ]),
  ignoredSystemSubtypes: Object.freeze([
    'stop_hook_summary',
    'away_summary',
    'agents_killed',
    'scheduled_task_fire',
    'microcompact_boundary',
  ]),
  tags: TAGS,
  generatedLeadTags: Object.freeze([
    'system-reminder',
    'local-command-caveat',
    TAGS.localCommandStdout,
    TAGS.localCommandStderr,
    TAGS.commandMessage,
    TAGS.commandArgs,
    TAGS.bashStdout,
    TAGS.bashStderr,
    TAGS.toolUseError,
    'user-prompt-submit-hook',
    'tools-used-before-summary',
  ]),
  blockedByHook: Object.freeze({
    endingKind: 'blocked_by_hook',
    contentPrefix: 'UserPromptSubmit operation blocked by hook:\n',
    originalPromptMarker: '\n\nOriginal prompt: ',
  }),
  zeroLeafUuid: '00000000-0000-0000-0000-000000000000',
  apiRequestUuidPrefix: 'txreq:',
  toolUseIdPrefix: 'toolu_',
  asyncLaunchedStatus: 'async_launched',
  interruptedDenialKind: 'interrupted',
  userRejectedDenialKind: 'user-rejected',
  deciderBySource: Object.freeze({
    hook: 'hook',
    user_temporary: 'user_keys',
    user_permanent: 'user_keys',
    user_reject: 'user_keys',
    user_abort: 'user_keys',
    config: 'config',
    classifier: 'classifier',
  } as const),
  classifierReasonType: 'classifier',
  hookErrorAttachments: Object.freeze({ hook_non_blocking_error: 'non_blocking_error', hook_cancelled: 'cancelled' } as const),
  attachmentDecision: Object.freeze({ allow: 'accept', deny: 'reject', accept: 'accept', reject: 'reject' } as const),
  attachments: Object.freeze({
    hookPermissionDecision: 'hook_permission_decision',
    queuedCommand: 'queued_command',
    taskStatus: 'task_status',
  }),
  blockTypes: Object.freeze({ thinking: 'thinking', redacted_thinking: 'thinking', text: 'text', tool_use: 'tool_use' } as const),
  previewChars: 1024,
});
