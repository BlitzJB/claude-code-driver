// channels/profiles/claude-2.1.316/screen.ts — OWNED BY WP-07 (DESIGN.md §1.2, §2.8; screen-parse.md §13 catalogue).
// Every version-specific screen string of the 2.1.316 classic inline renderer. `screenStrings` has the fixed export name and
// type the WP-00 assembly imports (§8); `screenExtras` carries the rest of the vocabulary the classifier needs (the assembly
// type has no slot for it), selected by version in channels/screen/classify.ts. All regexes apply to `normalize(line).trim()`
// unless the comment says "raw". Evidence: SP = docs/caveats/screen-parse.md, IN = docs/caveats/input.md,
// TUI = docs/research/tui-known-issues.md, LV = docs/research/live-verification.md, P0 = docs/research/phase0-probes.md.
// Pitfalls: P-SCREEN-02/03/04/05/11/18/19/24/28/29/31/32/34, P-TUI-20/24, P-INPUT-15/19, P-API-01.

import type { PermissionMode } from '../../../model/state.js';
import type { ScreenStrings } from '../index.js';

/** Duration as rendered by Claude's `ln()` formatter (`1s`, `0.5s`, `1m 26s`, `2h`, `1d 2h 3m`) (SP §4.4, VERIFIED-BIN). */
const DUR = String.raw`\d+(?:\.\d+)?[dhms](?: \d+[dhms]){0,3}`;
const rx = (src: string, flags = 'u'): RegExp => new RegExp(src, flags);
/** Parenthesised body with one nesting level: `3pm`, `resets 3pm (America/Los_Angeles)`. */
const PAREN_BODY = String.raw`[^()]*(?:\([^()]*\)[^()]*)*`;

/** Spinner glyph class (SP §4.1): default cycle + ghostty + ASCII `*` variant + reduced-motion `●` (P-SCREEN-02/18). */
const GLYPHS = '·✢✳✶✻✽*●';

const STATUS = Object.freeze({
  // `✢ Spelunking… (3s · thinking)`; the verb is never enumerated (P-SCREEN-19); message overrides contain spaces (SP §4.2).
  spinner: rx(String.raw`^(?<glyph>[${GLYPHS}]) (?<msg>\S.*?)…(?: \((?<paren>.*)\))?$`),
  // `✻ <msg…> · Retrying in <dur>[ (<reset>)] · attempt <n>/<max>`: anchored on the never-truncated suffix (P-SCREEN-04).
  retrying: rx(String.raw`^✻ (?<msg>.+?) · Retrying in (?<in>${DUR})(?: \((?<reset>${PAREN_BODY})\))? · attempt (?<n>\d+)\/(?<max>\d+)$`),
  // Rate-limit form with the reset in parentheses (SP §16 Q7, LP-30; UNVERIFIED live, template VERIFIED-BIN).
  retryingReset: rx(String.raw`^✻ (?<msg>.+?) · Retrying in (?<in>${DUR}) \((?<reset>${PAREN_BODY})\) · attempt (?<n>\d+)\/(?<max>\d+)$`),
  stalled: rx(String.raw`^✻ Waiting for API response · will retry in (?<in>${DUR}) · check your network$`),
  noResponse: rx(
    String.raw`^✻ (?<msg>No response from the API.*?) · retrying(?<once> once)?, waiting up to (?<upto>${DUR})(?: · attempt (?<n>\d+)\/(?<max>\d+))?$`,
  ),
  lowPriority: rx(
    String.raw`^✻ (?<msg>.*?) · next try in (?<in>${DUR}) · attempt (?<n>\d+)(?:\/(?<max>\d+))? · (?<key>\S+(?: \S+)?) to interrupt$`,
  ),
  autoModeUnavailable: rx(
    String.raw`^✻ (?<msg>Auto mode check unavailable) · next try in (?<in>${DUR}) · attempt (?<n>\d+)(?:\/(?<max>\d+))? · (?<key>\S+(?: \S+)?) to interrupt$`,
  ),
  // `✻ Worked for 1m 18s · done 2:24 AM`; verbs from `Rf` incl. `Sautéed` (Unicode classes, no NFKC, SP §8.2).
  done: rx(String.raw`^✻ (?<verb>\p{Lu}\p{Ll}+) for (?<dur>${DUR})(?: · done (?<at>[^·]+?))?(?<rest> · .*)?$`),
  // `✻ Waiting for 2 background agents to finish` (P-SCREEN-34).
  waitingBackground: /^✻ Waiting for (?<what>.+) to finish$/u,
  // `⎿  Interrupted · What should Claude do instead?` (SP §4.6; NBSP normalized first, P-SCREEN-11).
  interrupted: /^⎿ +Interrupted(?: · (?<q>What should Claude do instead\?))?$/u,
  // Paren segment `running PreToolUse hooks… 1/2` (P-SCREEN-32).
  hookWait: /^running (?<event>\w+) hooks… (?<done>\d+)\/(?<total>\d+)$/u,
});

/**
 * Test order on the status candidate (SP §13 note, P-SCREEN-03): banners that share the static `✻` first, the spinner after
 * every banner, `retryingUnparsed` (an `screenExtras.statusFallbacks` entry) right after the parsed retry forms.
 * `hookWait` is a paren segment of the spinner, not a line kind, so it is not in the order.
 */
const STATUS_ORDER = [
  'stalled',
  'noResponse',
  'autoModeUnavailable',
  'lowPriority',
  'retryingReset',
  'retrying',
  'retryingUnparsed',
  'spinner',
  'done',
  'waitingBackground',
  'interrupted',
] as const;

/** Footer mode labels (SP §5, VERIFIED-BIN mode table; bypass/dontAsk footer text UNVERIFIED). */
const MODE_LABELS: Readonly<Record<string, PermissionMode>> = Object.freeze({
  'manual mode on': 'default',
  'default mode on': 'default',
  'accept edits on': 'acceptEdits',
  'plan mode on': 'plan',
  'auto mode on': 'auto',
  'bypass permissions on': 'bypassPermissions',
  'bypass permissions mode on': 'bypassPermissions',
  "don't ask on": 'dontAsk',
  "don't ask mode on": 'dontAsk',
});

export const screenStrings: ScreenStrings = Object.freeze({
  spinnerGlyphs: GLYPHS,
  statusRegexes: STATUS,
  statusOrder: Object.freeze([...STATUS_ORDER]),
  footer: Object.freeze({
    // Busy is a footer fact (P-SCREEN-05); any key text, because keybindings.json can rebind interrupt (P-SCREEN-19).
    escToInterrupt: /(?:^| · )\S+ to interrupt(?: ·| {2}|$)/u,
    modeLabels: MODE_LABELS,
    pasting: /(?:^| · )Pasting…(?: ·|$)/u, // TUI §1.2 `lT("pasting","Pasting…")`
    ctrlCExit: /Press Ctrl-C again to exit/u, // IN §8 (VERIFIED-EXP)
  }),
  composer: Object.freeze({
    promptGlyph: '❯',
    ruleChar: '─',
    notices: Object.freeze({
      // TUI §3.7 `A9e`: `Removed 1 invisible character · review and press Enter to send` and variants.
      invisibleChars: /\bRemoved \d+ invisible characters?\b/u,
      // IN testing trick / P0 LP-47: `⏺ UserPromptSubmit operation blocked by hook:`.
      blockedByHook: /\bUserPromptSubmit operation blocked by hook\b/u,
      // IN §4.1: `⏺ Unknown command: /zzqq` (optionally `. Did you mean /new?`).
      unknownCommand: /^(?:[⏺●] +)?Unknown command: \/\S+/u,
      // IN §6/§8 overlays above the box (right-aligned, trimmed here).
      escAgainToClear: /^Esc again to clear$/iu,
      stashed: /^› stashed$/u,
      draftRestored: /^Draft restored\b/u,
    }),
    pastedPlaceholder: /\[Pasted text #\d+/u,
  }),
  dialogs: Object.freeze({
    permissionQuestion: /^Do you want to (?<what>.+)\?$/u,
    optionLine: /^(?<cur>❯ )?(?<n>\d+)\. (?<label>.+)$/u,
    // Both trust-footer wordings (P-SCREEN-28: SP §2.4 VERIFIED-LOG vs TUI §4.1 VERIFIED-BIN) and `Press <key> again to exit`.
    escFooter: /^(?:Esc to cancel|Enter to confirm|enter confirm|esc cancel|Press .+ to continue|Press .+ again to exit)\b/iu,
    trustTitle: /^Accessing workspace:$/u,
    // Resume-cost warning on Pro/Max (TUI §5.6; exact wording UNVERIFIED): anchor on the two documented choices.
    resumeTitle: /^(?:❯ )?(?:\d+\. )?(?:Resume anyway|Start a new conversation)\b/iu,
    // Usage-limit options menu (TUI §5.4, VERIFIED-BIN rows) and the spend-limit dialog title.
    usageMenu:
      /^(?:❯ )?(?:\d+\. )?(?:Stop and wait for limit to reset|Wait for limit to reset|Wait here, then continue automatically|Don[’']t continue automatically|Continue now at lower priority|Reset your 5-hour limit now|Use an available limit reset and keep working)\b/u,
    // Feedback survey (TUI §3.6 `J6`/`Z6`); digit-capturing, disabled by env but detected anyway (P-SCREEN-30).
    survey: /(?:^|[●⏺] )How is Claude doing this session\?/u,
    // Rewind picker (`/rewind`, double Esc on an empty box, IN §6.2). Option texts VERIFIED-BIN
    // (`Restore the code and/or conversation to the point before…`, `Restore the conversation to the point before…`);
    // the surrounding layout is UNVERIFIED.
    rewind: /^(?:❯ )?(?:\d+\. )?Restore the (?:code and\/or )?conversation to the point before…$/u,
    // elicitation / planApproval / question: no corpus frames (LP-46/LP-51) → deliberately absent (they classify as modal or
    // unknownModal, never idle, §2.3).
  }),
  // Exit screen (SP §2.5; P-SCREEN-29: corroboration only, pane_dead is truth).
  exited: /^Resume this session with:$/u,
  headerVersion: /^▐▛███▛█ +Claude Code v(\d+\.\d+\.\d+)/u,
  // Agent panel below the footer (SP §2.1): `⏺ main`, `◯ general-purpose  Run sleep and echo A   12s`.
  agentPanelRow: /^[⏺●◯○◉◐] \S/u,
  // `⎿  PreToolUse:Bash hook error`, `⎿  Stop hook error: connect …`, `Stop hook error occurred · ctrl+o to see`,
  // `<Event> hook returned blocking error` (LV Q1, VERIFIED-LIVE; P-SCREEN-31).
  hookErrorLine: /^(?:⎿ +)?\w+(?::\S+)? hook (?:error\b|returned blocking error\b)/u,
  apiErrorLine: /^(?:[⏺●⎿] +)?(?<line>API Error: .+)$/u,
  tipLine: /^⎿ +Tip: (?<tip>.*)$/u,
});

/** Screen vocabulary the assembly type has no slot for. */
export interface ScreenExtras {
  /** Duration grammar source, shared with to-facts (`DUR`). */
  readonly durSource: string;
  /** Rule = run of `ruleChar` (≥ 8) whose length is ≥ `minRuleRatio` × pane cols (P-SCREEN-15/35, P-TMUX-28). */
  readonly rule: RegExp;
  readonly minRuleRatio: number;
  readonly dashedRule: RegExp;
  /** First input-box row: `❯`, `❯ text` (P-SCREEN-09). */
  readonly inputFirst: RegExp;
  /** Prompt echo in the conversation (`❯ Use the Bash tool …`): bounds the last-block scans (P-SCREEN-25). */
  readonly promptEcho: RegExp;
  /** Slash-menu row (`❯ /exit   Exit the CLI`): starts like a prompt echo but is an overlay row, never an echo (P-SCREEN-30). */
  readonly slashMenuRow: RegExp;
  /** `No response from the API after <dur>`: the waited duration inside a noResponse message (TUI §7). */
  readonly noResponseWaited: RegExp;
  /** `· attempt <n>/<max>` at the end of a tier-A `retryingUnparsed` line. */
  readonly attemptSuffix: RegExp;
  /** Counts inside a `waitingBackground` text (`2 background agents and 1 dynamic workflow`, P-SCREEN-34). */
  readonly waitingAgents: RegExp;
  readonly waitingWorkflows: RegExp;
  /** `Try "how do I log an error?"` (SP §6). */
  readonly placeholder: RegExp;
  /** Decorations skipped by the status walk-up (P-SCREEN-01). */
  readonly effort: RegExp;
  /** Raw-line regex of a wrapped tip continuation (needs a tip within `tipContLookback` rows above). */
  readonly tipContRaw: RegExp;
  readonly tipContLookback: number;
  /** Lines that may sit between the status line and the top rule and are never the status (right-aligned notices, hints). */
  readonly decorations: readonly RegExp[];
  /** Fallback kinds referenced by `statusOrder` that are not in `statusRegexes`. */
  readonly statusFallbacks: Readonly<Record<string, RegExp>>;
  /** Spinner paren segments (SP §4.3); `hooks` is `statusRegexes.hookWait`. */
  readonly paren: {
    readonly separator: string;
    readonly elapsed: RegExp;
    readonly tokens: RegExp;
    readonly thinking: RegExp;
    readonly thought: RegExp;
    readonly tool: RegExp;
    readonly recover: RegExp;
  };
  /** Footer `⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt`. */
  readonly footerMode: RegExp;
  /** Hints of a footer with no mode label (default mode without auto mode): their presence means mode `default`. */
  readonly footerHints: readonly RegExp[];
  readonly footerHintSeparator: string;
  /**
   * Gap before the right-aligned segment of a footer row. At wide panes (the default 250 cols) Claude draws the effort
   * indicator, the `ctrl+g to edit in …` hint and the usage warning on the footer row itself, right-aligned:
   * `⏸ manual mode on · esc to interrupt<spaces>◐ medium · /effort` (P0 run-main, live-smoke 250-col traces). The left
   * segment (mode label, hints, busy) is everything before the first match; the rest is extra hints. ICR 0019.
   */
  readonly footerRightGap: RegExp;
  /** `❯ Yes, I trust this folder` (only inside a dialog body). */
  readonly bareOption: RegExp;
  /** `claude --resume <uuid>` / `claude --cloud <id>` under `Resume this session with:`. */
  readonly resumeHint: RegExp;
  /** `ctrl+g to edit in <Editor>`: the composer has a draft and C-g opens the external editor (P0 LP-01). */
  readonly editorHint: RegExp;
  /** Tool-output sanity anchors that, when found below a candidate input box, prove it is inside a dialog (P-REV-29). */
  readonly dialogOnlyBelowBox: readonly RegExp[];
  /** The three logo rows of the welcome header: the walk-up stops there (nothing above them is a status line). */
  readonly headerLogo: RegExp;
  /** Lines in the last block that start with a TUI glyph (one-line join retry for wrapped candidates, P-SCREEN-14). */
  readonly glyphStart: RegExp;
  /** Max non-blank lines scanned upward for the interrupted banner (SP §4.6) and for the last block. */
  readonly interruptScanLines: number;
  readonly lastBlockMaxLines: number;
  /**
   * Limit / auth / auto-continue banners are looked for only in the rows Claude draws them in: this many non-decoration rows of
   * the last block nearest the composer (or the bottom of a box-less screen), plus the walk-up decorations and the footer.
   * Anything further up is conversation or tool output (P-REV-29).
   */
  readonly bannerScanLines: number;
  readonly agentDone: RegExp;
  readonly backgroundLaunched: RegExp;
  readonly hookVerdict: RegExp;
  /**
   * Retry-message prefix → error-class hint (classification hint only, P-SCREEN-04; SP §4.4 `<msg>` selection). First match
   * wins; no match → `unknown`.
   */
  readonly errorHints: readonly { readonly hint: 'rateLimit' | 'proxy' | 'network' | 'api'; readonly re: RegExp }[];
}

export const screenExtras: ScreenExtras = Object.freeze({
  durSource: DUR,
  rule: /^─{8,}$/u,
  minRuleRatio: 0.5,
  dashedRule: /^╌{8,}$/u,
  inputFirst: /^❯(?: (?<text>.*))?$/u,
  promptEcho: /^❯ \S/u,
  slashMenuRow: /^❯ \/\S+ {2,}\S/u,
  noResponseWaited: rx(String.raw`\bafter (?<dur>${DUR})`),
  attemptSuffix: /· attempt (?<n>\d+)\/(?<max>\d+)$/u,
  waitingAgents: /(?<n>\d+) background agents?\b/u,
  waitingWorkflows: /(?<n>\d+) dynamic workflows?\b/u,
  placeholder: /^Try "(?<text>.+)"$/u,
  effort: /^(?:[○◐●◉◈]|effort:) \S.*? · (?:\/effort|may wait for your next message)$/u,
  tipContRaw: /^ {4,}\S/u,
  tipContLookback: 3,
  decorations: Object.freeze([
    /^A proxy or gateway that buffers streaming responses can cause this\b/u, // NO_RESPONSE_HINT (SP §13)
    /^\w+ hook error occurred · \S+ to see$/u, // LV Q1 right-aligned notification (counted as a hook error line too)
    /\bctrl\+g to edit in\b/iu, // IN §5, P0 LP-01
    /^Esc again to clear$/iu,
    /^Ctrl\+Y to paste deleted text$/iu,
    /^› stashed$/u,
    /^Draft restored\b/u,
    /^Press Ctrl-C again to exit$/u,
    /^Removed \d+ invisible characters?\b/u,
    /^paste again to expand$/iu, // P-INPUT-15
  ]),
  statusFallbacks: Object.freeze({
    // Tier-A fallback (SP §12.1): any `✻ … · attempt n/m` the parsed retry forms missed.
    retryingUnparsed: /^✻ .* · attempt \d+\/\d+$/u,
  }),
  paren: Object.freeze({
    separator: ' · ',
    elapsed: rx(String.raw`^(?<dur>${DUR})$`),
    tokens: /^(?<dir>[↓↑]) (?<count>[\d.]+k?) tokens$/u,
    thinking: /^(?<label>thinking|still thinking|thinking more|thinking some more|deep in thought)$/u,
    thought: /^thought for (?<s>\d+)s$/u,
    tool: /^(?<state>running|ran) tool for (?<dur>.+)$/u,
    recover: /^picking the thought back up(?: \((?<i>\d+) of (?<n>\d+)\))?$/u,
  }),
  footerMode: /^(?:(?<sym>⏸|⏵⏵|⏵) )?(?<mode>[a-z' ]+? on)(?: \((?<hint>[^)]*)\))?(?: · (?<rest>.*))?$/u,
  footerHints: Object.freeze([
    /^\? for shortcuts$/u,
    /^\S+ to interrupt$/u,
    /^← for agents$/u,
    /^\/tasks to see subagents$/u,
    /^↓ to manage$/u,
  ]),
  footerHintSeparator: ' · ',
  footerRightGap: / {2,}/u,
  bareOption: /^❯ (?!\d+\. )(?<label>\S.*)$/u,
  resumeHint: /^claude --(?:resume|cloud) (?<id>[0-9A-Za-z-]{8,})$/u,
  editorHint: /\bctrl\+g to edit in\b/iu,
  dialogOnlyBelowBox: Object.freeze([
    /^Do you want to .+\?$/u,
    /^(?:Esc to cancel|Enter to confirm|enter confirm|esc cancel)\b/iu,
    /^❯ \d+\. \S/u,
  ]),
  headerLogo: /^(?:▐▛███▛█|▝▜██████▀|▝▝ +▝▝)(?: |$)/u,
  glyphStart: /^[·✢✳✶✻✽*●⏺⎿]/u,
  interruptScanLines: 6,
  lastBlockMaxLines: 40,
  bannerScanLines: 6,
  agentDone: rx(String.raw`^[⏺●] Agent "(?<desc>.*)" finished · (?<dur>${DUR})$`),
  backgroundLaunched: /^[⏺●] (?<n>\d+) background agents? launched\b/u,
  hookVerdict: /^⎿ +(?<verdict>Allowed|Denied) by (?<hook>\w+) hook$/u,
  errorHints: Object.freeze([
    // `${Label} reached` with Label from the limit names (SP §4.4), plus the headerless-429 capacity text (TUI §5.6).
    { hint: 'rateLimit', re: /\b(?:limit reached|usage limit|rate limit|temporarily limiting requests)\b/iu },
    { hint: 'rateLimit', re: /^(?:5-hour|weekly|Opus|Sonnet|Fable|usage credit|session) limit\b/iu },
    // `Couldn't connect through your proxy (ERR_PROXY_TUNNEL) …` (VERIFIED-LOG)
    { hint: 'proxy', re: /\bproxy\b/iu },
    // `Can't reach the API server …`, `No internet route …`, `Unable to connect to API …`, SSL errors
    { hint: 'network', re: /\b(?:reach|connect|connection|internet|DNS|network|route|offline|VPN|SSL|certificate|timed out)\b/iu },
    // `API error`, `API error (status N)`, overload
    { hint: 'api', re: /\bAPI error\b|\bstatus \d{3}\b|\bOverloaded\b/iu },
  ] as const),
});
