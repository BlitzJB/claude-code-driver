// channels/screen/classify.ts — one capture → ScreenSnapshot (DESIGN.md §2.8; screen-parse.md §3–§7, §13, §14).
// Pure, synchronous, never throws, never presses keys (SP rule 7). Everything open-world: unknown status lines become
// `{kind:'none', raw}`, unknown paren segments go to `unknown`, an unknown bottom layout is `unknownModal` (P-SCREEN-24).
// Pitfalls: P-SCREEN-01..11/14/15/19/20/21/25/28..32/34, P-TMUX-28, P-INPUT-15/19/35, P-SEC-34, P-REV-29, P-TUI-15/20/21/24,
// LP-01 (ICR 0001 item 3: the external-editor alternate screen is `editorOpen`, not `unsupportedRenderer`).

import type { ScreenFacts, ScreenOption, StartupGateKind } from '../../model/screen-facts.js';
import type { MonoMs, WallMs } from '../../model/time.js';
import type { PaneStatus } from '../../platform/ports.js';
import { errorsExtras as errorsExtras2_1_316 } from '../profiles/claude-2.1.316/errors.js';
import type { ErrorsExtras } from '../profiles/claude-2.1.316/errors.js';
import { screenExtras as screenExtras2_1_316 } from '../profiles/claude-2.1.316/screen.js';
import type { ScreenExtras } from '../profiles/claude-2.1.316/screen.js';
import type { ClaudeProfile } from '../profiles/index.js';
import { hasEscapes, hashText, normalizeLine, normalizeStyledLines } from './normalize-text.js';
import { agentPanelRows, findInputBox, findRules, footerRows, indentOf, isDecoration, lastBlock, walkUpStatus } from './regions.js';
import type { Frame, InputBox, Vocab } from './regions.js';

// ---------------------------------------------------------------------------------------------------------------------------
// Types (§2.8, normative; `editorHint`, `autoContinueLine`, `rawLines` are additive WP-07 fields)
// ---------------------------------------------------------------------------------------------------------------------------

export type StatusLine =
  // SP §14 verbatim, plus `reset` parsed text
  | {
      kind: 'spinner';
      glyph: string;
      msg: string;
      elapsed?: string;
      tokens?: string;
      dir?: 'up' | 'down';
      thinking?: string;
      thoughtForS?: number;
      hooks?: { event: string; done: number; total: number };
      tool?: { state: 'running' | 'ran'; dur: string };
      recovering?: boolean;
      unknown?: string[];
    }
  | { kind: 'retrying'; msg: string; truncated: boolean; retryIn: string; attempt: number; max: number; reset?: string }
  | { kind: 'retryingUnparsed'; raw: string }
  | { kind: 'stalled'; retryIn: string }
  | { kind: 'noResponse'; waited: string; upTo: string; attempt?: number; max?: number; final: boolean }
  | { kind: 'lowPriority' | 'autoModeUnavailable'; msg: string; nextTryIn: string; attempt: number; max?: number }
  | { kind: 'done'; verb: string; dur: string; doneAt?: string; rest?: string }
  | { kind: 'waitingBackground'; what: string }
  | { kind: 'interrupted'; question: boolean }
  | { kind: 'none'; raw: string };

/** Status kinds under which the interrupt banner cannot be current: Claude still working, or the turn completed (done). */
const BANNER_EXCLUDING_STATUS: ReadonlySet<StatusLine['kind']> = new Set([
  'done',
  'spinner',
  'retrying',
  'retryingUnparsed',
  'stalled',
  'noResponse',
  'lowPriority',
  'autoModeUnavailable',
]);

type Notice = NonNullable<ScreenFacts['composer']>['notices'][number];
type DialogKind = NonNullable<ScreenFacts['dialog']>['kind'];

export interface ScreenSnapshot {
  // SP §14, extended (rev2: fully specified in §2.8)
  at: MonoMs;
  wallAt: WallMs;
  paneWidth: number;
  paneHeight: number;
  altScreen: boolean;
  inCopyMode: boolean;
  version?: string;
  kind: ScreenFacts['surface'];
  torn: boolean; // rule mismatch / footer missing → do not act
  status?: StatusLine; // only for kind 'main'
  footer?: { raw: string; mode: string | null; busy: boolean; hints: string[]; pasting: boolean; ctrlCExitArmed: boolean };
  input?: { text: string; placeholderLikely: boolean; pastedPlaceholder: boolean; notices: Notice[] }; // never authoritative
  dialog?: {
    kind: DialogKind;
    gate?: StartupGateKind;
    title?: string;
    question?: string;
    options: ScreenOption[];
    footer?: string;
    body: string[];
  };
  usageLimitLine?: string;
  authLine?: string;
  apiErrorLine?: string;
  versionTooOld: boolean;
  interruptedBanner: boolean;
  hookErrorLines: number;
  agentPanelRows: number;
  decorations: { tip?: string; effort?: string };
  unknown: string[]; // raw lines that drove an 'unknown*'/'none'
  frameHash: string;
  /** WP-07: `ctrl+g to edit in …` visible (footer or above the box): C-g opens the external editor (LP-01). */
  editorHint: boolean;
  /** WP-07: auto-continue line of the usage-limit wait (TUI §5.3), e.g. `Continuing automatically at 3:45pm · Esc to cancel`. */
  autoContinueLine?: string;
  /**
   * WP-07: the alternate screen shows Claude's own rule–❯–rule input box (the fullscreen renderer), so it is never the external
   * editor, whatever the editor phase or history says (P-SCREEN-20, LP-01).
   */
  rendererUi?: true;
}

/** Optional capture context (WP-07 addition to the §2.8 signature; every field defaults safely). */
export interface ClassifyContext {
  /** Capture time (mono); defaults to 0. */
  at?: MonoMs;
  /** Capture wall time; `parseResetText` resolves reset texts against it. Defaults to 0. */
  wallAt?: WallMs;
  /**
   * The capture was requested while an `editorStage`/`awaitEditorConsumed` job phase is active (ICR 0001 item 3b): an
   * alternate screen is then `editorOpen`.
   */
  editorPhase?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Version-specific vocabulary not covered by the assembly type (selected by version, like hooks/normalize.ts)
// ---------------------------------------------------------------------------------------------------------------------------

const SCREEN_EXTRAS: Readonly<Record<ClaudeProfile['version'], ScreenExtras>> = Object.freeze({ '2.1.316': screenExtras2_1_316 });
const ERRORS_EXTRAS: Readonly<Record<ClaudeProfile['version'], ErrorsExtras>> = Object.freeze({ '2.1.316': errorsExtras2_1_316 });

export function screenExtrasFor(profile: ClaudeProfile): ScreenExtras {
  return SCREEN_EXTRAS[profile.version];
}
export function errorsExtrasFor(profile: ClaudeProfile): ErrorsExtras {
  return ERRORS_EXTRAS[profile.version];
}

const MAX_UNKNOWN = 20;
const MAX_LINE = 400;
const clip = (s: string): string => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s);

// ---------------------------------------------------------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------------------------------------------------------

function parseParen(paren: string | undefined, v: Vocab): Omit<Extract<StatusLine, { kind: 'spinner' }>, 'kind' | 'glyph' | 'msg'> {
  const out: Omit<Extract<StatusLine, { kind: 'spinner' }>, 'kind' | 'glyph' | 'msg'> = {};
  if (paren === undefined) return out;
  const p = v.x.paren;
  for (const seg of paren.split(p.separator)) {
    let m: RegExpExecArray | null;
    if ((m = p.elapsed.exec(seg)) !== null) out.elapsed = m.groups?.['dur'] ?? seg;
    else if ((m = p.tokens.exec(seg)) !== null) {
      out.dir = m.groups?.['dir'] === '↑' ? 'up' : 'down';
      out.tokens = m.groups?.['count'] ?? '';
    } else if ((m = v.s.statusRegexes.hookWait.exec(seg)) !== null)
      out.hooks = { event: m.groups?.['event'] ?? '', done: Number(m.groups?.['done']), total: Number(m.groups?.['total']) };
    else if ((m = p.thinking.exec(seg)) !== null) out.thinking = m.groups?.['label'] ?? seg;
    else if ((m = p.thought.exec(seg)) !== null) out.thoughtForS = Number(m.groups?.['s']);
    else if ((m = p.tool.exec(seg)) !== null)
      out.tool = { state: m.groups?.['state'] === 'ran' ? 'ran' : 'running', dur: m.groups?.['dur'] ?? '' };
    else if (p.recover.test(seg)) out.recovering = true;
    else (out.unknown ??= []).push(seg);
  }
  return out;
}

const num = (s: string | undefined): number => (s === undefined ? NaN : Number(s));

/** Status candidate → StatusLine, in `statusOrder` (P-SCREEN-03); `undefined` when nothing matched. */
export function parseStatusLine(cand: string, v: Vocab): StatusLine | undefined {
  for (const name of v.s.statusOrder) {
    const re = (v.s.statusRegexes as Readonly<Record<string, RegExp>>)[name] ?? v.x.statusFallbacks[name];
    if (re === undefined || name === 'hookWait') continue;
    const m = re.exec(cand);
    if (m === null) continue;
    const g = m.groups ?? {};
    switch (name) {
      case 'stalled':
        return { kind: 'stalled', retryIn: g['in'] ?? '' };
      case 'noResponse': {
        const waited = v.x.noResponseWaited.exec(g['msg'] ?? '')?.groups?.['dur'] ?? '';
        return {
          kind: 'noResponse',
          waited,
          upTo: g['upto'] ?? '',
          ...(g['n'] !== undefined ? { attempt: num(g['n']) } : {}),
          ...(g['max'] !== undefined ? { max: num(g['max']) } : {}),
          final: g['once'] !== undefined,
        };
      }
      case 'autoModeUnavailable':
      case 'lowPriority':
        return {
          kind: name,
          msg: g['msg'] ?? '',
          nextTryIn: g['in'] ?? '',
          attempt: num(g['n']),
          ...(g['max'] !== undefined ? { max: num(g['max']) } : {}),
        };
      case 'retryingReset':
      case 'retrying': {
        const msg = g['msg'] ?? '';
        return {
          kind: 'retrying',
          msg,
          truncated: msg.endsWith('…'),
          retryIn: g['in'] ?? '',
          attempt: num(g['n']),
          max: num(g['max']),
          ...(g['reset'] !== undefined ? { reset: g['reset'] } : {}),
        };
      }
      case 'retryingUnparsed':
        return { kind: 'retryingUnparsed', raw: cand };
      case 'spinner':
        return { kind: 'spinner', glyph: g['glyph'] ?? '', msg: g['msg'] ?? '', ...parseParen(g['paren'], v) };
      case 'done':
        return {
          kind: 'done',
          verb: g['verb'] ?? '',
          dur: g['dur'] ?? '',
          ...(g['at'] !== undefined ? { doneAt: g['at'] } : {}),
          ...(g['rest'] !== undefined ? { rest: g['rest'] } : {}),
        };
      case 'waitingBackground':
        return { kind: 'waitingBackground', what: g['what'] ?? '' };
      case 'interrupted':
        return { kind: 'interrupted', question: g['q'] !== undefined };
      default:
        break; // a profile may order kinds this classifier does not know: ignore them (open world)
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Dialog body
// ---------------------------------------------------------------------------------------------------------------------------

function parseOptions(f: Frame, rows: readonly number[], v: Vocab): ScreenOption[] {
  const opts: ScreenOption[] = [];
  // Numbered options (`❯ 1. Yes`, `   2. No`), with wrapped continuations appended (SP §7 notes).
  let lastIndent = -1;
  for (const i of rows) {
    const l = f.t[i] ?? '';
    const m = v.s.dialogs.optionLine.exec(l);
    if (m !== null) {
      opts.push({ n: Number(m.groups?.['n']), label: m.groups?.['label'] ?? '', selected: m.groups?.['cur'] !== undefined });
      const raw = f.lines[i] ?? '';
      lastIndent = indentOf(raw) + (m.groups?.['cur'] !== undefined ? 2 : 0) + (m.groups?.['n'] ?? '').length + 2;
      continue;
    }
    const prev = opts[opts.length - 1];
    if (prev !== undefined && lastIndent >= 0 && indentOf(f.lines[i] ?? '') >= lastIndent && !v.s.dialogs.escFooter.test(l)) {
      prev.label = `${prev.label} ${l}`;
      continue;
    }
    lastIndent = -1;
  }
  if (opts.length > 0) return opts;
  // Unnumbered options (trust dialog: `❯ No, exit` / `   Yes, I trust this folder`): the rows next to the `❯` row whose
  // indentation equals the selected label's column.
  const sel = rows.findIndex((i) => v.x.bareOption.test(f.t[i] ?? ''));
  if (sel < 0) return opts;
  const selRow = rows[sel] ?? 0;
  const selRaw = f.lines[selRow] ?? '';
  const col = indentOf(selRaw) + 2;
  const isPeer = (i: number): boolean => {
    const l = f.t[i] ?? '';
    return l !== '' && indentOf(f.lines[i] ?? '') === col && !v.s.dialogs.escFooter.test(l);
  };
  const before: ScreenOption[] = [];
  for (let k = sel - 1; k >= 0; k--) {
    const r = rows[k] ?? 0;
    if (r !== (rows[k + 1] ?? 0) - 1 || !isPeer(r)) break;
    before.unshift({ label: f.t[r] ?? '', selected: false });
  }
  const after: ScreenOption[] = [];
  for (let k = sel + 1; k < rows.length; k++) {
    const r = rows[k] ?? 0;
    if (r !== (rows[k - 1] ?? 0) + 1 || !isPeer(r)) break;
    after.push({ label: f.t[r] ?? '', selected: false });
  }
  const label = v.x.bareOption.exec(f.t[selRow] ?? '')?.groups?.['label'] ?? '';
  return [...before, { label, selected: true }, ...after];
}

/**
 * The permission dialog's own question and option block, anchored on structure (P-REV-29, SEC §4.3/§4.6): the LAST
 * `Do you want to …?` row below the last dashed `╌` rule (everything between dashed rules is the tool-input preview, which
 * Claude draws untransformed for Bash, so a command line can read `3. Yes, ship it` or `Do you want to delete the repo?`),
 * then only the contiguous numbered-option rows (with their wrapped continuations) directly under it. Rows after the block
 * (the Esc footer) end it. `rows` are the non-blank body rows, top-down.
 */
function anchoredQuestion(f: Frame, rows: readonly number[], v: Vocab): { q: number; options: ScreenOption[] } | undefined {
  let floor = 0;
  for (let k = rows.length - 1; k >= 0; k--) {
    if (v.x.dashedRule.test(f.t[rows[k] ?? -1] ?? '')) {
      floor = k + 1;
      break;
    }
  }
  let q = -1;
  for (let k = rows.length - 1; k >= floor; k--) {
    if (v.s.dialogs.permissionQuestion.test(f.t[rows[k] ?? -1] ?? '')) {
      q = k;
      break;
    }
  }
  if (q < 0) return undefined;
  const block: number[] = [];
  let lastIndent = -1;
  for (let k = q + 1; k < rows.length; k++) {
    const i = rows[k] ?? -1;
    const l = f.t[i] ?? '';
    const m = v.s.dialogs.optionLine.exec(l);
    if (m !== null) {
      block.push(i);
      lastIndent = indentOf(f.lines[i] ?? '') + (m.groups?.['cur'] !== undefined ? 2 : 0) + (m.groups?.['n'] ?? '').length + 2;
      continue;
    }
    if (lastIndent >= 0 && indentOf(f.lines[i] ?? '') >= lastIndent && !v.s.dialogs.escFooter.test(l)) {
      block.push(i);
      continue;
    }
    break;
  }
  const options = block.length > 0 ? parseOptions(f, block, v) : [];
  return { q: rows[q] ?? -1, options: options.filter((o) => o.n !== undefined) };
}

function firstGate(lines: readonly string[], profile: ClaudeProfile): { gate: StartupGateKind; line: string } | undefined {
  const gates = profile.errors.startupGates;
  for (const kind of Object.keys(gates) as StartupGateKind[]) {
    for (const re of gates[kind]) {
      const line = lines.find((l) => re.test(l));
      if (line !== undefined) return { gate: kind, line };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Shared line scans (limit / auth / API error / hook errors / notices)
// ---------------------------------------------------------------------------------------------------------------------------

interface LineFacts {
  usageLimitLine?: string;
  autoContinueLine?: string;
  authLine?: string;
  apiErrorLine?: string;
  versionTooOld: boolean;
  hookErrorLines: number;
  notices: Notice[];
  editorHint: boolean;
}

/** A usage-limit banner in Claude's own wording (TUI §5.1), not prose that shares a prefix with one. */
function isLimitBanner(bare: string, profile: ClaudeProfile, ex: ErrorsExtras): boolean {
  if (!/^You've (?:hit|reached) your /u.test(bare)) {
    // every other prefix: the whole row is Claude's phrase plus, at most, one of its own tails (ICR 0027)
    return profile.errors.usageLimitPrefixes.some((p) => {
      if (!bare.startsWith(p)) return false;
      // a prefix that ends in a tail keyword awaiting its argument (`Limit reached · resets`) is checked from its head
      const head = / · (?:limit )?(?:resets|reset at)$/u.test(p) ? (p.split(' · ')[0] ?? p) : p;
      return ex.limitPrefixRest.test(bare.slice(head.length));
    });
  }
  if (!profile.errors.usageLimitPrefixes.some((p) => bare.startsWith(p))) return false;
  const m = ex.limitTemplate.exec(bare);
  if (m === null) return false;
  const tail = m.groups?.['tail'] ?? '';
  return tail !== '' ? ex.limitTail.test(tail) : ex.limitLabels.includes(m.groups?.['label'] ?? '');
}

/** An auth error row: the phrase opens the row, after at most Claude's own `Failed to authenticate:` / `API Error:` lead. */
function isAuthBanner(bare: string, profile: ClaudeProfile, ex: ErrorsExtras): boolean {
  return profile.errors.authLines.some((re) => {
    const m = re.exec(bare);
    return m !== null && ex.authLead.test(bare.slice(0, m.index));
  });
}

/** The version-too-old phrase opens the row (after the bullet prefix), after at most Claude's own `API Error:` lead. */
function isVersionTooOldBanner(bare: string, profile: ClaudeProfile, ex: ErrorsExtras): boolean {
  const m = profile.errors.versionTooOld.exec(bare);
  return m !== null && ex.versionLead.test(bare.slice(0, m.index));
}

/**
 * `lines` are scanned for API errors, hook errors, notices and the editor hint; limit, auth, auto-continue and version-too-old
 * banners only in `banner` (the rows Claude draws them in, `bannerScanLines`): a turn's own output that prints such text is
 * never a limit, an auth failure or a version floor (P-REV-29, ICR 0027).
 */
function scanLines(
  lines: readonly string[],
  banner: readonly string[],
  profile: ClaudeProfile,
  x: ScreenExtras,
  ex: ErrorsExtras,
): LineFacts {
  const s = profile.screen;
  const out: LineFacts = { versionTooOld: false, hookErrorLines: 0, notices: [], editorHint: false };
  const notices = new Set<Notice>();
  for (const l of banner) {
    if (l === '') continue;
    const bare = l.replace(ex.linePrefix, '');
    if (out.usageLimitLine === undefined && isLimitBanner(bare, profile, ex)) out.usageLimitLine = clip(bare);
    if (out.autoContinueLine === undefined && ex.autoContinue.some((a) => a.re.test(bare))) out.autoContinueLine = clip(bare);
    if (out.authLine === undefined && isAuthBanner(bare, profile, ex)) out.authLine = clip(bare);
    if (!out.versionTooOld && isVersionTooOldBanner(bare, profile, ex)) out.versionTooOld = true;
  }
  for (const l of lines) {
    if (l === '') continue;
    if (out.apiErrorLine === undefined) {
      const m = s.apiErrorLine.exec(l);
      if (m !== null) out.apiErrorLine = clip(m.groups?.['line'] ?? m[0]);
    }
    if (s.hookErrorLine.test(l)) out.hookErrorLines++;
    if (x.editorHint.test(l)) out.editorHint = true;
    for (const [k, re] of Object.entries(s.composer.notices) as [Notice, RegExp][]) if (re.test(l)) notices.add(k);
  }
  out.notices = [...notices];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// classifyFrame
// ---------------------------------------------------------------------------------------------------------------------------

function prepare(lines: readonly string[], cols: number): Frame {
  if (hasEscapes(lines)) {
    const st = normalizeStyledLines(lines);
    const ls = st.map((x) => x.text);
    return { lines: ls, t: ls.map((l) => l.trim()), undimmed: st.map((x) => x.undimmed), styled: true, cols };
  }
  const ls = lines.map(normalizeLine);
  return { lines: ls, t: ls.map((l) => l.trim()), undimmed: ls, styled: false, cols };
}

function headerVersion(f: Frame, profile: ClaudeProfile): string | undefined {
  for (const l of f.t) {
    const m = profile.screen.headerVersion.exec(l);
    if (m !== null) return m[1];
  }
  return undefined;
}

function frameHashOf(parts: readonly (string | number | boolean)[], rows: readonly string[]): string {
  return hashText(`${parts.join('\u0001')}\u0002${rows.join('\n')}`);
}

function base(
  status: PaneStatus,
  ctx: ClassifyContext,
  f: Frame,
  profile: ClaudeProfile,
): Omit<ScreenSnapshot, 'kind' | 'torn' | 'frameHash'> {
  const version = headerVersion(f, profile);
  return {
    at: ctx.at ?? (0 as MonoMs),
    wallAt: ctx.wallAt ?? (0 as WallMs),
    paneWidth: status.cols,
    paneHeight: status.rows,
    altScreen: status.alternateOn,
    inCopyMode: status.inMode,
    ...(version !== undefined ? { version } : {}),
    versionTooOld: false,
    interruptedBanner: false,
    hookErrorLines: 0,
    agentPanelRows: 0,
    decorations: {},
    unknown: [],
    editorHint: false,
  };
}

function withLineFacts(
  snap: Omit<ScreenSnapshot, 'kind' | 'torn' | 'frameHash'>,
  lf: LineFacts,
): Omit<ScreenSnapshot, 'kind' | 'torn' | 'frameHash'> {
  return {
    ...snap,
    ...(lf.usageLimitLine !== undefined ? { usageLimitLine: lf.usageLimitLine } : {}),
    ...(lf.autoContinueLine !== undefined ? { autoContinueLine: lf.autoContinueLine } : {}),
    ...(lf.authLine !== undefined ? { authLine: lf.authLine } : {}),
    ...(lf.apiErrorLine !== undefined ? { apiErrorLine: lf.apiErrorLine } : {}),
    versionTooOld: lf.versionTooOld,
    hookErrorLines: lf.hookErrorLines,
    editorHint: lf.editorHint,
  };
}

/** `[left, right]` of a trimmed footer row split at the first right-alignment gap (`right` is '' when there is none). */
function splitFooterRow(l: string, x: ScreenExtras): [string, string] {
  const m = x.footerRightGap.exec(l);
  return m === null ? [l, ''] : [l.slice(0, m.index), l.slice(m.index + m[0].length)];
}

function classifyMain(
  f: Frame,
  box: InputBox,
  status: PaneStatus,
  ctx: ClassifyContext,
  profile: ClaudeProfile,
  v: Vocab,
  ex: ErrorsExtras,
): ScreenSnapshot {
  const s = profile.screen;
  const { x } = v;
  let snap = base(status, ctx, f, profile);
  // ---- input box (P-INPUT-19: strictly between the two rules; P-SCREEN-07: never authoritative)
  const firstRow = box.top + 1;
  const glyph = s.composer.promptGlyph;
  const stripGlyph = (l: string): string => {
    const t = l.trimStart();
    return t.startsWith(glyph) ? t.slice(glyph.length).replace(/^ /u, '') : t;
  };
  const contRow = (l: string): string => l.replace(/^ {1,2}/u, '').trimEnd();
  const rowsText = (src: readonly string[]): string => {
    const out = [stripGlyph(src[firstRow] ?? '').trimEnd()];
    for (let i = firstRow + 1; i < box.bottom; i++) out.push(contRow(src[i] ?? ''));
    while (out.length > 1 && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  };
  const plainText = rowsText(f.lines);
  const typedText = f.styled ? rowsText(f.undimmed) : plainText;
  const dimOnly = f.styled && typedText.trim() === '' && plainText.trim() !== '';
  const placeholderLikely = dimOnly || x.placeholder.test(plainText);
  const text = f.styled ? typedText : plainText;
  // ---- footer and agent panel (P-SCREEN-08)
  const fr = footerRows(f, box);
  const fullFooterTexts = fr.rows.map((i) => f.t[i] ?? '');
  // Right-aligned segments (effort, editor hint, usage warning) share the footer row at wide panes (ICR 0019).
  const rightSegs: string[] = [];
  const footerTexts = fullFooterTexts.map((l) => {
    const [left, right] = splitFooterRow(l, x);
    if (right !== '') rightSegs.push(...right.split(x.footerHintSeparator).filter((h) => h !== ''));
    return left;
  });
  const panel = agentPanelRows(f, fr.end);
  const panelCount = panel.filter((i) => s.agentPanelRow.test(f.t[i] ?? '')).length;
  let footer: ScreenSnapshot['footer'];
  const f0 = footerTexts[0];
  if (f0 !== undefined) {
    const fm = x.footerMode.exec(f0);
    const modeLabel = fm?.groups?.['mode'] ?? null;
    const rest = fm !== null ? (fm.groups?.['rest'] ?? '') : f0;
    const hints = [
      ...(fm?.groups?.['hint'] !== undefined ? [fm.groups['hint']] : []),
      ...rest.split(x.footerHintSeparator).filter((h) => h !== ''),
      ...footerTexts.slice(1),
      ...rightSegs,
    ];
    const all = fullFooterTexts.join(' · ');
    footer = {
      raw: f0,
      mode: modeLabel,
      busy: footerTexts.some((l) => s.footer.escToInterrupt.test(l)),
      hints,
      pasting: s.footer.pasting.test(all),
      ctrlCExitArmed: s.footer.ctrlCExit.test(all),
    };
  }
  // ---- status walk-up (P-SCREEN-01) + one-line join retry for a wrapped candidate (P-SCREEN-14)
  const wu = walkUpStatus(f, box.top, v);
  let status_: StatusLine | undefined;
  const unknown: string[] = [];
  if (wu.candidate !== undefined) {
    const cand = f.t[wu.candidate] ?? '';
    status_ = parseStatusLine(cand, v);
    if (status_ === undefined && !x.glyphStart.test(cand)) {
      for (let j = wu.candidate - 1; j >= 0; j--) {
        const above = f.t[j] ?? '';
        if (above === '') continue;
        if (x.glyphStart.test(above)) status_ = parseStatusLine(`${above} ${cand}`, v) ?? parseStatusLine(`${above}${cand}`, v);
        break;
      }
    }
    if (status_ === undefined) {
      status_ = { kind: 'none', raw: clip(cand) };
      unknown.push(clip(cand));
    } else if (status_.kind === 'spinner' && status_.unknown !== undefined) unknown.push(...status_.unknown);
  } else status_ = { kind: 'none', raw: '' };
  // ---- last block: interrupted banner (P-SCREEN-25), limits, auth, API errors, hook errors (P-SCREEN-31), notices
  const block = lastBlock(f, box.top, x.lastBlockMaxLines, v);
  const nearRows = block.filter((i) => !isDecoration(f, i, v)).slice(0, x.interruptScanLines);
  // A real banner is drawn only once Claude has stopped, and an interrupted turn draws no done line: while the status line
  // or footer shows Claude still working, or a done line shows the turn completed, a `⎿  Interrupted` row near the box is
  // tool or hook output, not the interrupt banner (ICR 0030).
  const bannerExcluded = footer?.busy === true || BANNER_EXCLUDING_STATUS.has(status_.kind);
  const interruptedBanner = !bannerExcluded && nearRows.some((i) => s.statusRegexes.interrupted.test(f.t[i] ?? ''));
  const scanRows = [...new Set([...block, ...wu.decorations])];
  const bannerRows = [...new Set([...block.filter((i) => !isDecoration(f, i, v)).slice(0, x.bannerScanLines), ...wu.decorations])];
  // the right-aligned footer segments too: at wide panes 2.1.316 draws the composer overlays (`Esc again to clear`, …) there,
  // and their anchored patterns never match the whole footer row (live LP-32, docs/research/live-results.md F-5)
  const lf = scanLines(
    [...scanRows.map((i) => f.t[i] ?? ''), ...fullFooterTexts, ...rightSegs],
    [...bannerRows.map((i) => f.t[i] ?? ''), ...fullFooterTexts],
    profile,
    x,
    ex,
  );
  snap = withLineFacts(snap, lf);
  // ---- surveys keep the input box (P-SCREEN-30): surfaced as a dialog fact on the main surface
  let dialog: ScreenSnapshot['dialog'];
  // only the rows nearest the box: a survey line printed by tool output further up is conversation text (P-REV-29)
  const surveyRow = nearRows.find((i) => s.dialogs.survey.test(f.t[i] ?? ''));
  if (surveyRow !== undefined)
    dialog = { kind: 'survey', title: f.t[surveyRow] ?? '', options: [], body: block.map((i) => f.t[i] ?? '').reverse() };
  const torn = (f.t[box.top] ?? '').length !== (f.t[box.bottom] ?? '').length || footer === undefined;
  // ---- frame hash over the bottom region only (conversation scroll above it never re-emits a frame, P-SCREEN-23)
  const regionStart = Math.min(box.top, wu.candidate ?? box.top, ...block);
  const region = f.lines.slice(regionStart);
  const rows = f.styled ? [...region, '\u0003', ...f.undimmed.slice(box.top, box.bottom + 1)] : region;
  const frameHash = frameHashOf(['main', torn, status.alternateOn, status.inMode, status.cols, status.rows], rows);
  return {
    ...snap,
    kind: 'main',
    torn,
    status: status_,
    ...(footer !== undefined ? { footer } : {}),
    input: { text, placeholderLikely, pastedPlaceholder: s.composer.pastedPlaceholder.test(text), notices: lf.notices },
    ...(dialog !== undefined ? { dialog } : {}),
    interruptedBanner,
    agentPanelRows: panelCount,
    decorations: { ...(wu.tip !== undefined ? { tip: wu.tip } : {}), ...(wu.effort !== undefined ? { effort: wu.effort } : {}) },
    unknown,
    frameHash,
  };
}

function classifyNoBox(
  f: Frame,
  rules: readonly number[],
  status: PaneStatus,
  ctx: ClassifyContext,
  profile: ClaudeProfile,
  v: Vocab,
  ex: ErrorsExtras,
): ScreenSnapshot {
  const s = profile.screen;
  const { x } = v;
  const lastRule = rules.length > 0 ? (rules[rules.length - 1] ?? -1) : -1;
  const bodyRows: number[] = [];
  for (let i = lastRule + 1; i < f.t.length; i++) if ((f.t[i] ?? '') !== '') bodyRows.push(i);
  const body = bodyRows.map((i) => f.t[i] ?? '');
  const all = f.t.filter((l) => l !== '');
  let snap = base(status, ctx, f, profile);
  const block = lastBlock(f, f.t.length, x.lastBlockMaxLines, v).map((i) => f.t[i] ?? '');
  snap = withLineFacts(snap, scanLines(block, block.slice(0, x.bannerScanLines), profile, x, ex));
  const hashParts = (kind: string): string =>
    frameHashOf([kind, status.alternateOn, status.inMode, status.cols, status.rows], f.lines.slice(Math.max(0, lastRule)));
  // the dialog's own question + option block (never a preview row, P-REV-29); other dialogs keep the whole-body option scan
  const anchored = anchoredQuestion(f, bodyRows, v);
  const dialogOf = (kind: DialogKind, extra: { gate?: StartupGateKind; title?: string } = {}): NonNullable<ScreenSnapshot['dialog']> => {
    const options = kind === 'permission' ? (anchored?.options ?? []) : parseOptions(f, bodyRows, v);
    const qLine = anchored !== undefined ? f.t[anchored.q] : undefined;
    const footerLine = body.find((l) => s.dialogs.escFooter.test(l));
    const title = extra.title ?? body.find((l) => !x.dashedRule.test(l));
    return {
      kind,
      ...(extra.gate !== undefined ? { gate: extra.gate } : {}),
      ...(title !== undefined ? { title: clip(title) } : {}),
      ...(qLine !== undefined ? { question: qLine } : {}),
      options,
      ...(footerLine !== undefined ? { footer: footerLine } : {}),
      body: body.slice(0, 60).map(clip),
    };
  };
  const done = (
    kind: ScreenFacts['surface'],
    dialog?: NonNullable<ScreenSnapshot['dialog']>,
    torn = false,
    unknown: string[] = [],
  ): ScreenSnapshot => ({
    ...snap,
    kind,
    torn,
    ...(dialog !== undefined ? { dialog } : {}),
    unknown,
    frameHash: hashParts(kind),
  });

  const hasOption = body.some((l) => s.dialogs.optionLine.test(l));
  const hasBare = body.some((l) => x.bareOption.test(l));
  const isGateLine = (l: string): boolean => Object.values(profile.errors.startupGates).some((res) => res.some((re) => re.test(l)));
  // 0. permission dialog first on a live pane: question + ≥ 1 numbered option (P-INPUT-35: options by label). It precedes the
  // gate checks so that a tool input shown in the dialog body (a Bash command line that reads `Accessing workspace:`) can never
  // turn it into a trust/startup gate (P-REV-29, P-SEC-34). A question that is itself a gate line (`Do you want to use this API
  // key?`) is left to the gate checks. Question and options are the anchored block only: a Bash preview between the dashed
  // rules can print both a question and numbered lines, and those must never become (or forge) the dialog (P-SEC-34).
  if (!status.dead && anchored !== undefined && anchored.options.length > 0 && !isGateLine(f.t[anchored.q] ?? ''))
    return done('permissionDialog', dialogOf('permission'));
  // 1. trust dialog (gate `trust`; never answered by the library, D-19)
  if (body.some((l) => s.dialogs.trustTitle.test(l))) return done('trustDialog', dialogOf('trust', { gate: 'trust' }));
  // 2. other startup gates and pre-UI exit strings (LC §1.1, §1.5); on a dead pane the whole screen is the body
  const gate = firstGate(status.dead || lastRule < 0 ? all : body, profile);
  if (gate !== undefined && gate.gate !== 'trust') return done('startupGate', dialogOf('gate', { gate: gate.gate, title: gate.line }));
  // A dead pane is `exited` whatever is left on it (P-SCREEN-29: pane_dead is the truth, the screen only corroborates).
  if (status.dead) return done('exited');
  // 4. usage-limit options menu (TUI §5.4)
  if (body.some((l) => s.dialogs.usageMenu.test(l))) return done('usageLimitMenu', dialogOf('usageLimitMenu'));
  // 5. resume warning dialog
  if (body.some((l) => s.dialogs.resumeTitle.test(l))) return done('resumeDialog', dialogOf('resume'));
  // 6. specific modals, then any generic modal (options / Esc footer): surfaced, never answered (P-SCREEN-22, P-TUI-15)
  if (body.some((l) => s.dialogs.survey.test(l))) return done('modal', dialogOf('survey'));
  if (body.some((l) => s.dialogs.rewind.test(l))) return done('modal', dialogOf('rewind'));
  for (const [k, re] of [
    ['elicitation', s.dialogs.elicitation],
    ['planApproval', s.dialogs.planApproval],
    ['question', s.dialogs.question],
  ] as const) {
    if (re !== undefined && body.some((l) => re.test(l))) return done('modal', dialogOf(k));
  }
  // a rule followed by the `❯` row with no bottom rule yet is a half-drawn composer, not a bare-option modal (P-SCREEN-10)
  const firstBody = bodyRows[0];
  const hasEscFooter = body.some((l) => s.dialogs.escFooter.test(l));
  if (lastRule >= 0 && firstBody === lastRule + 1 && x.inputFirst.test(f.t[firstBody] ?? '') && !hasOption && !hasEscFooter)
    return done('partialFrame', undefined, true);
  if (hasOption || hasBare || hasEscFooter) return done('modal', dialogOf('other'));
  // 7. exit screen (P-SCREEN-29: corroboration only)
  if (all.some((l) => s.exited.test(l) || x.resumeHint.test(l))) return done('exited');
  // 8. partial frame: a rule followed by the `❯` row (no bottom rule yet), or only footer-like rows after the rule
  if (lastRule >= 0) {
    const nextRow = bodyRows[0];
    const isFooterLike = (row: string): boolean => {
      const [l] = splitFooterRow(row, x);
      return x.footerMode.test(l) || x.footerHints.some((re) => re.test(l)) || s.footer.escToInterrupt.test(l);
    };
    if ((nextRow !== undefined && x.inputFirst.test(f.t[nextRow] ?? '')) || (body.length > 0 && body.every(isFooterLike)))
      return done('partialFrame', undefined, true);
  }
  // 9. blank
  if (all.length === 0) return done('blank');
  // 10. unknown bottom layout: raw lines kept for telemetry (P-SCREEN-24)
  return done('unknownModal', dialogOf('other'), false, (body.length > 0 ? body : all).slice(-MAX_UNKNOWN).map(clip));
}

/**
 * Classify one capture of the visible pane. `lines` are the captured rows (plain or `-e`); `status` is the PaneStatus captured
 * in the same tmux invocation. Pure; never throws (any internal failure yields an `unknownModal` snapshot).
 */
export function classifyFrame(
  lines: readonly string[],
  status: PaneStatus,
  profile: ClaudeProfile,
  ctx: ClassifyContext = {},
): ScreenSnapshot {
  const v: Vocab = { s: profile.screen, x: screenExtrasFor(profile) };
  const ex = errorsExtrasFor(profile);
  try {
    const f = prepare(lines, status.cols);
    // D-10 / P-SCREEN-20, amended by LP-01: the alternate screen is the external editor while an editor phase is active,
    // otherwise an unsupported renderer. The debouncer adds the history-based editor fallback (ICR 0001 item 3b).
    if (status.alternateOn) {
      const rendererUi = findInputBox(f, findRules(f, v), v) !== undefined;
      const kind: ScreenFacts['surface'] = ctx.editorPhase === true && !rendererUi ? 'editorOpen' : 'unsupportedRenderer';
      const nonBlank = f.t.filter((l) => l !== '');
      return {
        ...base(status, ctx, f, profile),
        kind,
        torn: false,
        ...(rendererUi ? { rendererUi: true as const } : {}),
        unknown: nonBlank.slice(0, MAX_UNKNOWN).map(clip),
        frameHash: frameHashOf([kind, true, status.inMode, status.cols, status.rows], f.lines),
      };
    }
    const rules = findRules(f, v);
    const box = findInputBox(f, rules, v);
    if (box !== undefined && !status.dead) return classifyMain(f, box, status, ctx, profile, v, ex);
    return classifyNoBox(f, rules, status, ctx, profile, v, ex);
  } catch (e: unknown) {
    const raw = lines.slice(-MAX_UNKNOWN).map((l) => clip(normalizeLine(l)));
    return {
      at: ctx.at ?? (0 as MonoMs),
      wallAt: ctx.wallAt ?? (0 as WallMs),
      paneWidth: status.cols,
      paneHeight: status.rows,
      altScreen: status.alternateOn,
      inCopyMode: status.inMode,
      kind: 'unknownModal',
      torn: true,
      versionTooOld: false,
      interruptedBanner: false,
      hookErrorLines: 0,
      agentPanelRows: 0,
      decorations: {},
      unknown: [`classifier error: ${e instanceof Error ? e.message : String(e)}`, ...raw],
      frameHash: hashText(`error\u0001${lines.join('\n')}`),
      editorHint: false,
    };
  }
}
