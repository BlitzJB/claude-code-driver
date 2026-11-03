// channels/profiles/claude-2.1.316/errors.ts — OWNED BY WP-07 (DESIGN.md §1.2, §2.8, §3.9; rev 2 §10 G27).
// Usage-limit, auth, version-too-old and startup-gate strings of Claude Code 2.1.316, plus `parseResetText`.
// Sources: TUI = docs/research/tui-known-issues.md §4–§7 (VERIFIED-BIN unless noted), LC = docs/caveats/lifecycle.md §1–§3, §11.
// `errorsProfile` has the fixed export name and type the WP-00 assembly imports (§8); `errorsExtras` carries what the assembly
// type has no slot for (auth kinds, auto-continue lines, limit-line grammar), selected by version in channels/screen/to-facts.ts.
// Pitfalls: P-TUI-21 (both limit templates + Claude's own prefixes), P-REV-35 (tz passed in, never the host zone),
// P-LIFE-24 (version-too-old classified), P-SCREEN-24 (strings versioned here only).
//
// `Intl` is used ONLY inside `parseResetText` (§2.8 L1 rule): the zone comes from the caller (L3 `env.timeZone()`, recorded in the
// trace header) or from an explicit ` (Zone/City)` suffix, so replay goldens never depend on the machine.

import type { ScreenFacts, StartupGateKind } from '../../../model/screen-facts.js';
import type { WallMs } from '../../../model/time.js';
import type { ClaudeProfile } from '../index.js';

/**
 * Claude's own usage-limit detection prefixes (`Wio`, TUI §5.1) and the legacy wordings still seen in the wild
 * (`session limit` before 2.1.316, `Limit reached · resets …`, `Usage limit reached`, P-TUI-21).
 */
const USAGE_LIMIT_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage · add funds to continue',
  'Your org is out of usage · contact your admin',
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'Fable 5 requires usage credits',
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
  // legacy / documentation forms
  'Usage limit reached',
  'Claude usage limit reached',
  'Limit reached · resets',
  '5-hour limit reached',
] as const;

/** `rate_limit_info.rateLimitType` → screen label (`qpe`, TUI §5.1). */
const LIMIT_NAMES = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  seven_day_overage_included: 'Fable limit',
  overage: 'usage credit limit',
} as const;

/** Auth lines by kind (TUI §6, LC §2). Order matters: the first matching kind wins. */
const AUTH_KINDS: readonly { readonly kind: NonNullable<ScreenFacts['auth']>['kind']; readonly re: RegExp }[] = Object.freeze([
  { kind: 'tokenRevoked', re: /\bOAuth token revoked\b/u },
  { kind: 'refreshLock', re: /\bCould not refresh your login because another Claude Code process is refreshing it\b/u },
  { kind: 'transient', re: /\bAuthentication error · This may be a temporary network issue\b/u },
  { kind: 'loginExpired', re: /\bLogin expired · Please run \/login\b/u },
  { kind: 'loginExpired', re: /\bOAuth token has expired\b/u },
  { kind: 'loginExpired', re: /\bSession expired\. Please run \/login to sign in again\b/u },
  { kind: 'loginExpired', re: /\bOAuth token refresh failed\b/u },
  { kind: 'notLoggedIn', re: /\bNot logged in · Please run \/login\b/u },
  { kind: 'notLoggedIn', re: /\bAuthentication required · Sign in again to continue\b/u },
  { kind: 'notLoggedIn', re: /\bClaude login not accepted\b/u },
  { kind: 'other', re: /\bInvalid API key · Fix external API key\b/u },
  { kind: 'other', re: /\bYour ANTHROPIC_API_KEY belongs to a disabled organization\b/u },
  { kind: 'other', re: /\bYour organization has disabled (?:API key authentication|Claude subscription access for Claude Code)\b/u },
  { kind: 'other', re: /\bCould not refresh your login: the disk\b/u },
  { kind: 'other', re: /\bCouldn't save your login\b/u },
  { kind: 'other', re: /\bAPI Error: 401 Invalid authentication credentials\b/u },
]);

/**
 * Startup gates (LC §1.1, §1.5; TUI §4). A gate is only looked for when the input box is missing (a full-screen dialog owns
 * the pane) or the pane is dead. Pre-UI exit strings map onto the closest kind: `sessionInUse`, `resumeDialog` (the resume
 * could not proceed: unknown id / nothing to continue), `other` (invalid id, could-not-start, org version policy; the matched
 * line is in `dialog.title` so L3 can refine the code).
 */
const STARTUP_GATES: Readonly<Record<StartupGateKind, readonly RegExp[]>> = Object.freeze({
  configError: Object.freeze([/^Configuration error\b/u, /^The configuration file at .+ contains invalid JSON\.$/u]),
  settingsError: Object.freeze([
    /^Settings (?:Error|Warning)$/u,
    /^Files with errors are skipped entirely, not just the invalid settings\.$/u,
  ]),
  onboarding: Object.freeze([
    /^Let's get started\.$/u,
    /^Choose the text style that looks best with your terminal$/u,
    /^To change this later, run \/theme$/u,
    /^Security notes:$/u,
    /^Use Claude Code's terminal setup\?$/u,
  ]),
  login: Object.freeze([/^Select login method:$/u, /^(?:❯ )?(?:\d+\. )?Claude account with subscription · /u]),
  trust: Object.freeze([/^Accessing workspace:$/u]),
  apiKey: Object.freeze([/^Detected a custom API key in your environment$/u, /^Do you want to use this API key\?$/u]),
  bypass: Object.freeze([/^WARNING: Claude Code running in Bypass Permissions mode$/u]),
  mcpApproval: Object.freeze([/^New MCP server found in this project: /u]),
  claudeMdImports: Object.freeze([/^Allow external CLAUDE\.md file imports\?$/u]),
  // The offer dialog's exact text is UNVERIFIED (TUI §4.3; pinned away by CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1).
  rendererOffer: Object.freeze([/\bflicker-free rendering\b/iu, /^(?:Try|Switch to) (?:the )?fullscreen renderer\b/iu]),
  sessionInUse: Object.freeze([/^Error: Session ID \S+ is already in use\.$/u]),
  resumeDialog: Object.freeze([/^No conversation found with session ID: \S+/u, /^No conversation found to continue$/u]),
  other: Object.freeze([
    /^Error: Invalid session ID\. Must be a valid UUID\.$/u,
    /^Claude Code could not start: /u,
    /^Claude Code exited: (?:startup failed after restoring the previous session|could not continue the previous session)\b/u,
    /\bis older than the minimum version required by your organization \(/u,
    /\bis newer than the maximum version allowed by your organization \(/u,
  ]),
});

/** `claude_code_version_too_old` (LC §11, VERIFIED-SRC). */
const VERSION_TOO_OLD =
  /\bClaude Code \S+ (?:does not support this model; version \S+ or newer is required|is older than the minimum version required by your organization's policy)/u;

// ---------------------------------------------------------------------------------------------------------------------------
// parseResetText
// ---------------------------------------------------------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
});

/**
 * Reset text grammar (TUI §5.1 `xR`, VERIFIED-BIN): `3pm`, `3:45pm`, `Nov 9, 4pm`, `Nov 9, 4:30pm`, `Nov 9, 2027, 4pm`
 * (year when it differs), optional ` (Zone/City)`. Tolerated too: a leading `at `, ` AM`/` PM`, `a.m.`, and the 24-hour
 * forms of the `timeFormat` setting (`15:45`, `15:45 UTC`).
 */
const RESET_TEXT = new RegExp(
  String.raw`^(?:resets? (?:at )?|reset at )?(?:at )?` +
    String.raw`(?:(?<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (?<day>\d{1,2}),?(?: (?<year>\d{4}),?)?(?: at)? )?` +
    String.raw`(?<h>\d{1,2})(?::(?<mi>\d{2}))?\s?(?<ampm>[ap]\.?m\.?)?` +
    String.raw`(?: \(?(?<zone>UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)?)?$`,
  'iu',
);

const dtfCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const hit = dtfCache.get(zone);
  if (hit !== undefined) return hit;
  let f: Intl.DateTimeFormat | null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    f = null; // RangeError: unknown time zone
  }
  if (dtfCache.size > 256) dtfCache.clear();
  dtfCache.set(zone, f);
  return f;
}

interface ZonedParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const PART_KEY: Readonly<Partial<Record<Intl.DateTimeFormatPartTypes, keyof ZonedParts>>> = Object.freeze({
  year: 'y',
  month: 'mo',
  day: 'd',
  hour: 'h',
  minute: 'mi',
  second: 's',
});

function zonedParts(f: Intl.DateTimeFormat, utcMs: number): ZonedParts {
  const out: ZonedParts = { y: 1970, mo: 1, d: 1, h: 0, mi: 0, s: 0 };
  for (const p of f.formatToParts(utcMs)) {
    const key = PART_KEY[p.type];
    if (key !== undefined) out[key] = Number(p.value);
  }
  if (out.h === 24) out.h = 0; // some ICU builds render midnight as 24 with hourCycle h23
  return out;
}

/** Zone offset (zone wall time − UTC) at the instant `utcMs`, in ms. */
function offsetAt(f: Intl.DateTimeFormat, utcMs: number): number {
  const p = zonedParts(f, utcMs);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - (utcMs - (((utcMs % 1000) + 1000) % 1000));
}

/**
 * Zone wall time → UTC instant, deterministic on DST edges: a non-existent local time (spring-forward gap) maps to the later
 * instant; an ambiguous one (fall-back fold) maps to the earlier instant.
 */
function zonedToUtc(f: Intl.DateTimeFormat, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const DAY = 86_400_000;
  const offs = [...new Set([offsetAt(f, guess - DAY), offsetAt(f, guess), offsetAt(f, guess + DAY)])];
  const consistent = offs.map((o) => guess - o).filter((t) => guess - offsetAt(f, t) === t);
  if (consistent.length > 0) return Math.min(...consistent);
  return Math.max(...offs.map((o) => guess - o));
}

function addDays(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function parseResetText(text: string, wallAt: WallMs, tz: string): WallMs | undefined {
  try {
    const m = RESET_TEXT.exec(
      text
        .trim()
        .replace(/[.\s]+$/u, '')
        .replace(/\s+/gu, ' '),
    );
    const g = m?.groups;
    if (g?.['h'] === undefined) return undefined;
    let h = Number(g['h']);
    const mi = g['mi'] === undefined ? 0 : Number(g['mi']);
    const ampm = g['ampm']?.toLowerCase().replace(/\./gu, '');
    if (mi > 59) return undefined;
    if (ampm !== undefined) {
      if (h < 1 || h > 12) return undefined;
      h = (h % 12) + (ampm === 'pm' ? 12 : 0);
    } else if (h > 23) return undefined;
    const explicit = g['zone'];
    const zoneName = explicit?.toUpperCase() === 'GMT' ? 'UTC' : explicit;
    const f = (zoneName !== undefined ? formatterFor(zoneName) : null) ?? formatterFor(tz);
    if (f === null) return undefined;
    const now = zonedParts(f, wallAt);
    const floor = wallAt - 60_000;
    const mon = g['mon'];
    if (mon === undefined) {
      // Time only: the next occurrence at or after wallAt − 60 s (§3.9).
      let t = zonedToUtc(f, now.y, now.mo, now.d, h, mi);
      if (t < floor) {
        const n = addDays(now.y, now.mo, now.d, 1);
        t = zonedToUtc(f, n.y, n.mo, n.d, h, mi);
      }
      return t as WallMs;
    }
    const mo = MONTHS[mon.slice(0, 3).toLowerCase()];
    const d = Number(g['day']);
    if (mo === undefined || d < 1 || d > 31) return undefined;
    const check = new Date(Date.UTC(2000, mo - 1, d)); // leap year: Feb 29 allowed
    if (check.getUTCMonth() !== mo - 1) return undefined;
    if (g['year'] !== undefined) return zonedToUtc(f, Number(g['year']), mo, d, h, mi) as WallMs;
    // No year: the candidate year closest to wallAt (Claude omits the year only when it equals the current one; a reset
    // just past New Year resolves forward, a stale banner resolves to its recent past instant).
    const candidates = [now.y - 1, now.y, now.y + 1]
      .filter((y) => new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() === mo - 1)
      .map((y) => zonedToUtc(f, y, mo, d, h, mi));
    let best: number | undefined;
    for (const c of candidates) if (best === undefined || Math.abs(c - wallAt) < Math.abs(best - wallAt)) best = c;
    return best as WallMs | undefined;
  } catch {
    return undefined; // L1 never throws
  }
}

export const errorsProfile: ClaudeProfile['errors'] = Object.freeze({
  usageLimitPrefixes: Object.freeze([...USAGE_LIMIT_PREFIXES]),
  limitNames: Object.freeze({ ...LIMIT_NAMES }),
  authLines: Object.freeze(AUTH_KINDS.map((a) => a.re)),
  versionTooOld: VERSION_TOO_OLD,
  startupGates: STARTUP_GATES,
  parseResetText,
});

export type AutoContinueState = NonNullable<NonNullable<ScreenFacts['usageLimit']>['autoContinue']>;

/** Error vocabulary the assembly type has no slot for. */
export interface ErrorsExtras {
  readonly authKinds: typeof AUTH_KINDS;
  /** Bullet prefixes stripped before prefix matching (`⏺ `, `● `, `⎿  `). */
  readonly linePrefix: RegExp;
  /** Label of `You've hit your <label>[ · resets <reset>][ · …]` / `You've reached your …` (TUI §5.1); reset via `resetIn`. */
  readonly limitLine: RegExp;
  /**
   * Full grammar of a `You've hit your …` / `You've reached your …` banner: the label, then the ` · `-joined tail (TUI §5.1).
   * A line with that prefix counts as a limit banner only when it fits this grammar AND either its first tail segment is one of
   * Claude's own (`limitTail`) or it has no tail and its label is a known limit label (`limitLabels`). Prose that merely starts
   * with the prefix (`You've reached your GitHub API rate limit …`) is conversation text, never a limit.
   */
  readonly limitTemplate: RegExp;
  readonly limitTail: RegExp;
  readonly limitLabels: readonly string[];
  /**
   * What may follow every OTHER limit prefix (for a prefix ending in an argument-taking keyword, `Limit reached · resets`,
   * what follows its head `Limit reached`): nothing, Claude's own ` · `/` ∙ `/` - ` tail starting with one
   * of its segments (`resets`, `limit resets`, `contact`, `add funds`, `continuing …`, `/upgrade`, …), or the legacy
   * `. Your limit will reset at …` sentence. Prose that merely starts with the phrase (`Usage limit reached for key …`,
   * `5-hour limit reached is what the docs say`) is conversation text, never a limit (ICR 0027).
   */
  readonly limitPrefixRest: RegExp;
  /**
   * What may precede the version-too-old phrase on its row (after the bullet prefix): nothing or Claude's `API Error:
   * [<status> …]` wrapper (ICR 0027).
   */
  readonly versionLead: RegExp;
  /**
   * What may precede an auth phrase on its row (after the bullet prefix): nothing, `Failed to authenticate: `, or Claude's
   * `API Error: <status> …` wrapper. An auth phrase anywhere else in a row is conversation/tool text.
   */
  readonly authLead: RegExp;
  /** Generic reset extractor for every limit-ish line (`· resets 3pm`, `limit resets 3:45pm`, `continuing automatically at 3:45pm`). */
  readonly resetIn: RegExp;
  /** Legacy limit labels → `rateLimitType` (`session limit` is the pre-2.1.316 name of the 5-hour window). */
  readonly legacyLimitNames: Readonly<Record<string, string>>;
  /** Auto-continue lines (TUI §5.3, LC §3.1 notice table), first match wins in this order. */
  readonly autoContinue: readonly { readonly state: AutoContinueState; readonly re: RegExp }[];
}

export const errorsExtras: ErrorsExtras = Object.freeze({
  authKinds: AUTH_KINDS,
  linePrefix: /^(?:[⏺●] +|⎿ +)/u,
  limitLine: /^You've (?:hit|reached) your (?<label>[^·]+?)\s*(?: · |$)/u,
  limitTemplate: /^You've (?:hit|reached) your (?<label>[^·]+?)(?<tail>(?: · [^·]+)*)$/u,
  limitTail: /^ · (?:resets\b|reset at\b|contact\b|raise it\b|ask your admin\b|progress saved\b|\/upgrade\b|\/usage-credits\b|try \/)/u,
  limitLabels: Object.freeze([
    ...Object.values(LIMIT_NAMES),
    'usage limit',
    'session limit',
    'limit',
    'monthly spend limit',
    "org's monthly spend limit",
    "channel's monthly spend limit",
    "team's shared budget",
  ]),
  limitPrefixRest:
    /^(?: again)?(?: [·∙-] (?:limit )?(?:resets?\b|reset at\b|contact\b|raise it\b|ask your admin\b|progress saved\b|add funds\b|continuing\b|\/upgrade\b|\/usage-credits\b|\/rate-limit-options\b|(?:Run|try) \/)[^·∙]*(?: [·∙] [^·∙]+)*|\. (?:Your limit will reset at\b|Run \/usage-credits\b|\/upgrade\b|\/usage-credits\b)[^·]*)?\.?$/u,
  versionLead: /^(?:(?:API )?Error: (?:\d{3}\b.*)?)?$/u,
  authLead: /^(?:Failed to authenticate: |(?:API )?Error: (?:\d{3}\b.*)?)?$/u,
  resetIn: /\b(?:resets|reset at|continuing automatically at|Continuing automatically at)(?: at)? (?<reset>[^·]+?)\s*(?:·|$)/u,
  legacyLimitNames: Object.freeze({ 'session limit': 'five_hour' }),
  autoContinue: Object.freeze([
    { state: 'stopped', re: /^Automatic continue (?:stopped|did not run|was turned off)\b/iu },
    { state: 'cancelled', re: /^Automatic continue cancelled\b/iu },
    { state: 'stalePressEnter', re: /^(?:Usage limit has reset · )?Press enter to continue$/iu },
    { state: 'stalePressEnter', re: /^Your usage limit has reset$/iu },
    { state: 'resetContinuing', re: /^Usage limit (?:reset|available again) · (?:Continuing automatically|continuing now)\b/iu },
    { state: 'waiting', re: /^(?:Usage limit reached(?: again)? · )?[Cc]ontinuing (?:automatically|shortly)\b.*\b(?:Esc|esc) to cancel$/u },
  ] as const),
});
