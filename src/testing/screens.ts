// testing/screens.ts — frame builders that draw what Claude Code 2.1.316 shows in a tmux pane, line for line in the shapes of
// the recorded corpus (fixtures/verify/screen-*.log, faultproxy screens; DESIGN.md §6.2, SP §13). FakeClaude and the kernel
// scenarios use them so the real screen classifier (WP-07) sees realistic frames: banner, the history block, the status line
// above the composer, rule – `❯ text` – rule, and the footer. Every string here is copied from a captured frame; none is
// invented, except where a comment says the corpus has no frame (then the SP §13 regex text is used).

export interface Frame {
  readonly lines: readonly string[];
}

export interface BannerOptions {
  version?: string;
  model?: string;
  cwd: string;
}

export const DEFAULT_COLS = 250;
export const DEFAULT_ROWS = 80;

/** Footer mode labels (screen-A/D/faultproxy frames). `default` shows as "manual mode" in 2.1.316 (P-DOCS-03). */
export const MODE_FOOTER: Readonly<Record<string, string>> = Object.freeze({
  default: '⏸ manual mode on',
  acceptEdits: '⏵⏵ accept edits on',
  plan: '⏸ plan mode on',
  auto: '⏵⏵ auto mode on',
  bypassPermissions: '⏵⏵ bypass permissions on',
  dontAsk: '⏵⏵ don’t ask on',
});

export function banner(o: BannerOptions): string[] {
  return [
    '',
    ` ▐▛███▛█   Claude Code v${o.version ?? '2.1.316'}`,
    `▝▜██████▀  ${o.model ?? 'Opus 5.5 · Claude Plan'}`,
    ` ▝▝   ▝▝   ${o.cwd}`,
  ];
}

export function rule(cols = DEFAULT_COLS): string {
  return '─'.repeat(Math.max(20, Math.min(cols, 400)));
}

export interface MainFrameOptions {
  cols?: number;
  banner: BannerOptions;
  /** History block lines between the banner and the status line (prompt echoes, tool rows, assistant text). */
  history?: readonly string[];
  /** Status line right above the composer (spinner / retry / done). */
  status?: string;
  /** Composer text; '' = empty box; undefined = the startup placeholder. */
  composer?: string;
  /** Extra lines inside the composer (multi-line drafts). */
  composerMore?: readonly string[];
  mode?: string;
  busy?: boolean;
  /** Notice line next to the box (e.g. `Esc again to clear`, input.md §6). */
  notice?: string;
  /** Agent panel rows under the footer. */
  agentRows?: readonly string[];
}

const EFFORT_LINE = `${' '.repeat(91)}◐ medium · /effort`;

/** The main surface: banner, history, status, effort hint, rule, composer, rule, footer (screen-A.log 1793659694851). */
export function mainFrame(o: MainFrameOptions): string[] {
  const cols = o.cols ?? DEFAULT_COLS;
  const lines = [...banner(o.banner), ...(o.history ?? [])];
  if (o.status !== undefined) lines.push(o.status);
  lines.push(EFFORT_LINE, rule(cols));
  if (o.composer === undefined) lines.push('❯ Try "how do I log an error?"');
  else lines.push(o.composer === '' ? '❯ ' : `❯ ${o.composer}`);
  for (const l of o.composerMore ?? []) lines.push(`  ${l}`);
  lines.push(rule(cols));
  const mode = MODE_FOOTER[o.mode ?? 'default'] ?? MODE_FOOTER['default'] ?? '';
  lines.push(`  ${mode} · ${o.busy === true ? 'esc to interrupt' : '? for shortcuts'}`);
  if (o.notice !== undefined) lines.push(`  ${o.notice}`);
  for (const r of o.agentRows ?? []) lines.push(r);
  return lines;
}

/** Spinner status (`✻ Working… (3s · ↓ 12 tokens)`; spinnerVerbs replaced by "Working", §3.4). */
export function spinner(
  o: { elapsedS?: number; tokens?: number; glyph?: string; hooks?: { event: string; done: number; total: number } } = {},
): string {
  const g = o.glyph ?? '✻';
  if (o.hooks !== undefined)
    return `${g} Working… (running ${o.hooks.event} hooks… ${o.hooks.done}/${o.hooks.total} · ${o.elapsedS ?? 0}s)`;
  if (o.elapsedS === undefined) return `${g} Working…`;
  return `${g} Working… (${o.elapsedS}s · ↓ ${o.tokens ?? 0} tokens)`;
}

/** Retry banner (faultproxy screens-refuse.log 1793652821000). */
export function retryLine(o: { attempt: number; max?: number; inS?: number; msg?: string }): string {
  const msg = o.msg ?? 'Couldn’t connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused…';
  return `✻ ${msg} · Retrying in ${o.inS ?? 1}s · attempt ${o.attempt}/${o.max ?? 10}`;
}

/** Stall banner (SP §13 `stalled`, VERIFIED-LOG: `✻ Waiting for API response · will retry in 2m 40s · check your network`). */
export function stalledLine(o: { inS?: number } = {}): string {
  return `✻ Waiting for API response · will retry in ${o.inS ?? 5}s · check your network`;
}

/** Done line (screen-A.log 1793659703445). */
export function doneLine(o: { seconds: number; at?: string }): string {
  return `✻ Worked for ${o.seconds}s${o.at === undefined ? '' : ` · done ${o.at}`}`;
}

/** Interrupt banner in the last block (SP §13 `interrupted`; no corpus frame, the regex text). */
export const INTERRUPTED_BANNER = '  ⎿  Interrupted · What should Claude do instead?';

/** Permission dialog for a Bash call (screen-A.log 1793659756267). */
export function permissionDialog(o: { cols?: number; title?: string; description: string; command: string; cwd: string }): string[] {
  const cols = o.cols ?? DEFAULT_COLS;
  const dash = '╌'.repeat(Math.max(20, Math.min(cols, 400)));
  return [
    '',
    `  ${o.description}`,
    `  ⎿  $ ${o.command}`,
    rule(cols),
    ` ${o.title ?? 'Bash command'}`,
    ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    ` ${o.description}`,
    dash,
    ` ${o.command}`,
    dash,
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    `   2. Yes, and always allow access to ${o.cwd} from this project`,
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   4. No',
    ' Esc to cancel · Tab to amend',
  ];
}

/** Workspace trust dialog (screen-B.log 1793660125534). */
export function trustDialog(o: { cols?: number; cwd: string }): string[] {
  return [
    '',
    rule(o.cols ?? DEFAULT_COLS),
    ' Accessing workspace:',
    ` ${o.cwd}`,
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
    " source project, or work from your team). If not, take a moment to review what's in this folder first.",
    " Claude Code'll be able to read, edit, and execute files here.",
    ' Security guide',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel',
  ];
}

/** A generic modal (slash-command output pane, e.g. `/usage`); the body is free text, closed by Esc. */
export function modalFrame(o: { cols?: number; title: string; body: readonly string[] }): string[] {
  return ['', rule(o.cols ?? DEFAULT_COLS), ` ${o.title}`, '', ...o.body.map((l) => ` ${l}`), '', ' Esc to cancel'];
}

/** Usage-limit history line (TUI §5 shape) followed by the main surface. */
export function usageLimitLine(o: { resetText: string }): string {
  return `  ⎿  You've hit your limit · resets ${o.resetText}`;
}

/** Copy-mode indicator tmux draws in the top-right corner (`[0/123]`). */
export function copyModeIndicator(cols = DEFAULT_COLS): string {
  return `${' '.repeat(Math.max(0, cols - 8))}[0/0]`;
}

/** Prompt echo in the history block (`❯ text`). */
export function promptEcho(text: string): string {
  return `❯ ${text.split('\n')[0] ?? ''}`;
}

/** Assistant text row (`⏺ text`). */
export function assistantRow(text: string): string {
  return `⏺ ${text}`;
}

/** Tool rows (`  Ran 1 shell command` / `  ⎿  …`). */
export function toolRows(o: { summary: string; detail?: string }): string[] {
  return o.detail === undefined ? [`  ${o.summary}`] : [`  ${o.summary}`, `  ⎿  ${o.detail}`];
}

/** A startup gate screen: the given lines under a rule (LC §1.1 strings come from the profile, not from here). */
export function gateFrame(o: { cols?: number; lines: readonly string[] }): string[] {
  return ['', rule(o.cols ?? DEFAULT_COLS), ...o.lines.map((l) => ` ${l}`)];
}
