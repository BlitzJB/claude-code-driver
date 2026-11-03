// channels/profiles/claude-2.1.316/hooks.ts — OWNED BY WP-06 (DESIGN.md §1.2, §3.4, §2.4 normalizer mapping).
// Hook event names, the registration table, and every hook payload field name / enum string the hook normalizer reads.
// `hooksProfile` has the fixed export name and type the WP-00 assembly imports (§8); `hookExtras` carries the rest of the
// version-specific hook vocabulary (the assembly type has no slot for it), selected by version in channels/hooks/normalize.ts.
// Sources: official-docs.md §1.1/§1.6/§1.7 (VERIFIED [hooks]), fixtures/verify/{http,cmd}-hooks.jsonl (VERIFIED-LIVE 2.1.316),
// phase0-probes.md (scratchpad_dir + prompt_id on UPS/Notification/SessionEnd, SessionEnd reason `prompt_input_exit`).

import type { ClaudeProfile } from '../index.js';

/**
 * HTTP-registered observation events (§3.4 `<Ev>` list, D-34). `PreToolUse` and `MessageDisplay` are switchable
 * (`hookExtras.switchableEvents`); `PostToolBatch` is opt-in and therefore NOT in this default list (P-HOOK-48).
 * SessionStart and PermissionRequest are command hooks (`commandEvents`): HTTP SessionStart is never sent (P-HOOK-18) and
 * PermissionRequest must be holdable through the forwarder.
 */
const OBSERVATION_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'PermissionDenied',
  'MessageDisplay',
  'PostModelSwitch',
  'ConfigChange',
  'CwdChanged',
] as const;

/**
 * Never registered (§3.4): they replace git behaviour (Worktree*), block on timeout (PreModelSwitch), never fire interactively
 * (Setup), need watchPaths (FileChanged, P-HOOK-61), are blocking with UNVERIFIED empty-answer semantics (UserPromptExpansion,
 * Elicitation, ElicitationResult), belong to unsupported agent teams (TaskCreated, TaskCompleted, TeammateIdle, D-24), or carry
 * too little observation value (InstructionsLoaded, DirectoryAdded). P-HOOK-35/36.
 */
const NEVER_REGISTER = [
  'WorktreeCreate',
  'WorktreeRemove',
  'PreModelSwitch',
  'Setup',
  'FileChanged',
  'UserPromptExpansion',
  'Elicitation',
  'ElicitationResult',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'InstructionsLoaded',
  'DirectoryAdded',
] as const;

export const hooksProfile: ClaudeProfile['hooks'] = Object.freeze({
  observationEvents: Object.freeze([...OBSERVATION_EVENTS]),
  commandEvents: Object.freeze(['SessionStart', 'PermissionRequest'] as const),
  neverRegister: Object.freeze([...NEVER_REGISTER]),
});

/** Wire names of hook payload fields (official-docs.md §1.6/§1.7; VERIFIED in the 2.1.316 fixtures unless noted). */
const FIELDS = Object.freeze({
  // common
  hookEventName: 'hook_event_name',
  sessionId: 'session_id',
  transcriptPath: 'transcript_path',
  promptId: 'prompt_id', // absent until the first user input (P-DOCS-04)
  permissionMode: 'permission_mode', // not on every event (P-DOCS-03)
  agentId: 'agent_id',
  agentType: 'agent_type', // '' for internal agents
  teammateName: 'teammate_name', // agent teams (UNVERIFIED shape, D-24)
  // SessionStart / SessionEnd
  source: 'source',
  model: 'model',
  reason: 'reason',
  // UserPromptSubmit
  prompt: 'prompt',
  // tools
  toolName: 'tool_name',
  toolInput: 'tool_input',
  toolUseId: 'tool_use_id',
  toolResponse: 'tool_response',
  durationMs: 'duration_ms',
  error: 'error',
  isInterrupt: 'is_interrupt',
  toolCalls: 'tool_calls',
  permissionSuggestions: 'permission_suggestions',
  // Stop / StopFailure / SubagentStop
  stopHookActive: 'stop_hook_active',
  lastAssistantMessage: 'last_assistant_message',
  backgroundTasks: 'background_tasks',
  errorDetails: 'error_details',
  agentTranscriptPath: 'agent_transcript_path',
  // MessageDisplay
  turnId: 'turn_id',
  messageId: 'message_id',
  index: 'index',
  final: 'final',
  delta: 'delta',
  // Notification
  message: 'message',
  notificationType: 'notification_type',
  serverName: 'server_name', // elicitation_* (UNVERIFIED field name, LP-51)
  mcpServerName: 'mcp_server_name', // elicitation_* (UNVERIFIED alternative)
  // PreCompact / PostCompact
  trigger: 'trigger',
  // PostModelSwitch
  fromModel: 'from_model',
  toModel: 'to_model',
  // ConfigChange
  filePath: 'file_path',
  // CwdChanged
  oldCwd: 'old_cwd',
  newCwd: 'new_cwd',
});

/** `background_tasks[]` element fields (official-docs.md §1.7 Stop). */
const BG_TASK_FIELDS = Object.freeze({
  id: 'id',
  type: 'type',
  status: 'status',
  description: 'description',
  agentType: 'agent_type',
});

/** `tool_response` of an Agent PostToolUse (official-docs.md §1.7; VERIFIED hookprobe). */
const AGENT_RESPONSE = Object.freeze({ status: 'status', agentId: 'agentId', asyncLaunched: 'async_launched' });

/** `<task-notification>` vocabulary (transcript-format.md §4.2 item 2, VERIFIED probe). */
const TASK_NOTIFICATION = Object.freeze({
  root: 'task-notification',
  taskId: 'task-id',
  toolUseId: 'tool-use-id',
  status: 'status',
  outputFile: 'output-file',
  summary: 'summary',
  /** Subagent files prefix the same notification with this banner (TF §4.2 item 2). */
  systemPrefix: '[SYSTEM NOTIFICATION - NOT USER INPUT]',
});

/** Notification `notification_type` values that map to `input.requested` / `input.requestCleared` (§2.4, rev 2 §10 G14). */
const INPUT_REQUESTED = Object.freeze({
  elicitation_dialog: 'elicitation',
  elicitation_url_dialog: 'elicitationUrl',
  agent_needs_input: 'agentNeedsInput',
} as const);
const INPUT_CLEARED = Object.freeze({
  elicitation_complete: { kind: 'elicitation', how: 'complete' },
  elicitation_response: { kind: 'elicitation', how: 'response' },
} as const);

export interface HookExtras {
  /** Registered only when the host opts in (`PostToolBatch`, P-HOOK-48). */
  readonly optInEvents: readonly string[];
  /** Registered by default but switchable off (§3.4 starred). */
  readonly switchableEvents: readonly string[];
  /** Per-event `timeout` (seconds) in the settings plan; `default` applies to every other event (P-HOOK-33). */
  readonly timeoutsSec: Readonly<Record<string, number>>;
  readonly fields: typeof FIELDS;
  readonly bgTaskFields: typeof BG_TASK_FIELDS;
  readonly agentResponse: typeof AGENT_RESPONSE;
  readonly taskNotification: typeof TASK_NOTIFICATION;
  /** `background_tasks[].type` of an agent-teams teammate → `bgtask.status{taskType:'teammate'}` (§2.4). */
  readonly teammateTaskType: string;
  /** `AgentRef.agentId` prefix for a teammate payload that has `teammate_name` but no `agent_id` (§4.5.9). */
  readonly teammateKeyPrefix: string;
  readonly inputRequested: Readonly<Record<string, 'elicitation' | 'elicitationUrl' | 'agentNeedsInput'>>;
  readonly inputCleared: Readonly<
    Record<string, { readonly kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput'; readonly how: 'complete' | 'response' }>
  >;
  /** Hook `permission_mode` aliases: Manual mode is sent as `default`; tolerate `manual` anyway (P-DOCS-03). */
  readonly permissionModeAliases: Readonly<Record<string, string>>;
  readonly compactPhases: { readonly PreCompact: 'started' | 'finished'; readonly PostCompact: 'started' | 'finished' };
}

export const hookExtras: HookExtras = Object.freeze({
  optInEvents: Object.freeze(['PostToolBatch']),
  switchableEvents: Object.freeze(['PreToolUse', 'MessageDisplay']),
  timeoutsSec: Object.freeze({ default: 5, MessageDisplay: 3 }),
  fields: FIELDS,
  bgTaskFields: BG_TASK_FIELDS,
  agentResponse: AGENT_RESPONSE,
  taskNotification: TASK_NOTIFICATION,
  teammateTaskType: 'teammate',
  teammateKeyPrefix: 'teammate:',
  inputRequested: INPUT_REQUESTED,
  inputCleared: INPUT_CLEARED,
  permissionModeAliases: Object.freeze({ manual: 'default' }),
  compactPhases: Object.freeze({ PreCompact: 'started', PostCompact: 'finished' } as const),
});
