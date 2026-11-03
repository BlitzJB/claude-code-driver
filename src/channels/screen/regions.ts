// channels/screen/regions.ts — structural region finder (DESIGN.md §1.2; screen-parse.md §3, §7).
// Pure. Anchors on structure, not prose (SP rule 1): the live input box is the LAST rule–❯–rule pair from the bottom
// (P-SCREEN-09, P-REV-29); the footer is the block right after its bottom rule (P-SCREEN-08); the agent panel follows a blank
// line; the status candidate is found by walking up from the top rule over blank/effort/tip/notice decorations
// (P-SCREEN-01). No column logic anywhere: rules are recognised by run length relative to the pane width (P-SCREEN-15/35).

import type { ScreenStrings } from '../profiles/index.js';
import type { ScreenExtras } from '../profiles/claude-2.1.316/screen.js';

/** One capture prepared for region finding. Index i is the same row in every array. */
export interface Frame {
  /** Normalized lines, left indentation kept (TIP_CONT and option-column detection need it). */
  readonly lines: readonly string[];
  /** `lines[i].trim()`: what every catalogue regex is applied to. */
  readonly t: readonly string[];
  /** Normalized non-dim text of each row (`-e` captures); equals `lines` for plain captures. */
  readonly undimmed: readonly string[];
  readonly styled: boolean;
  readonly cols: number;
}

export interface Vocab {
  readonly s: ScreenStrings;
  readonly x: ScreenExtras;
}

/** Row indices of solid rules: `─{8,}` and, when the width is known, length ≥ minRuleRatio × cols. */
export function findRules(f: Frame, v: Vocab): number[] {
  const min = f.cols > 0 ? Math.ceil(f.cols * v.x.minRuleRatio) : 0;
  const out: number[] = [];
  for (let i = 0; i < f.t.length; i++) {
    const l = f.t[i] ?? '';
    if (l.length >= min && v.x.rule.test(l)) out.push(i);
  }
  return out;
}

export interface InputBox {
  readonly top: number;
  readonly bottom: number;
}

/**
 * The live input box: the last pair of consecutive rules (a, b) with b − a ≥ 2 and `❯` right after a. A pair below which a
 * dialog anchor appears (permission question, `Esc to cancel`, a selected numbered option) is a box drawn inside a dialog
 * body (tool output that prints a fake composer, P-REV-29) and is skipped.
 */
export function findInputBox(f: Frame, rules: readonly number[], v: Vocab): InputBox | undefined {
  for (let k = rules.length - 1; k >= 1; k--) {
    const a = rules[k - 1] ?? -1;
    const b = rules[k] ?? -1;
    if (b - a < 2 || !v.x.inputFirst.test(f.t[a + 1] ?? '')) continue;
    let forged = false;
    for (let i = b + 1; i < f.t.length && !forged; i++) {
      const l = f.t[i] ?? '';
      if (l !== '' && v.x.dialogOnlyBelowBox.some((re) => re.test(l))) forged = true;
    }
    if (!forged) return { top: a, bottom: b };
  }
  return undefined;
}

/** Footer = the non-blank rows right after the bottom rule, up to the first blank row (SP §3 step 4). */
export function footerRows(f: Frame, box: InputBox): { rows: number[]; end: number } {
  const rows: number[] = [];
  let i = box.bottom + 1;
  for (; i < f.t.length && (f.t[i] ?? '') !== ''; i++) rows.push(i);
  return { rows, end: i };
}

/** Agent panel = the non-blank rows after the blank row that ends the footer (SP §2.1). */
export function agentPanelRows(f: Frame, footerEnd: number): number[] {
  const rows: number[] = [];
  for (let i = footerEnd; i < f.t.length; i++) if ((f.t[i] ?? '') !== '') rows.push(i);
  return rows;
}

export interface WalkUp {
  /** Row of the status candidate (first non-decoration row above the top rule), if any. */
  readonly candidate?: number;
  /** Decoration rows skipped on the way (tips, effort, notices, hints). */
  readonly decorations: readonly number[];
  readonly tip?: string;
  readonly effort?: string;
}

/** True when row i is a wrapped tip continuation: indented ≥ 4 and a TIP row within `tipContLookback` rows above. */
function isTipContinuation(f: Frame, i: number, v: Vocab): boolean {
  if (!v.x.tipContRaw.test(f.lines[i] ?? '')) return false;
  for (let j = Math.max(0, i - v.x.tipContLookback); j < i; j++) if (v.s.tipLine.test(f.t[j] ?? '')) return true;
  return false;
}

export function isDecoration(f: Frame, i: number, v: Vocab): boolean {
  const l = f.t[i] ?? '';
  return v.x.effort.test(l) || v.s.tipLine.test(l) || v.x.decorations.some((re) => re.test(l)) || isTipContinuation(f, i, v);
}

/** Status walk-up from the row above the top rule (SP §3 step 4): never searches past the first non-decoration row. */
export function walkUpStatus(f: Frame, top: number, v: Vocab): WalkUp {
  const decorations: number[] = [];
  let tip: string | undefined;
  let effort: string | undefined;
  for (let i = top - 1; i >= 0; i--) {
    const l = f.t[i] ?? '';
    if (l === '') continue;
    if (v.x.headerLogo.test(l)) break; // the welcome header: no status line is drawn yet
    if (isDecoration(f, i, v)) {
      decorations.push(i);
      const tm = v.s.tipLine.exec(l);
      if (tm !== null && tip === undefined) tip = tm.groups?.['tip'] ?? '';
      if (effort === undefined && v.x.effort.test(l)) effort = l;
      continue;
    }
    return { candidate: i, decorations, ...(tip !== undefined ? { tip } : {}), ...(effort !== undefined ? { effort } : {}) };
  }
  return { decorations, ...(tip !== undefined ? { tip } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/**
 * The last block: non-blank rows walking up from row `from − 1`, at most `max` of them, stopping BEFORE the newest prompt echo
 * (`❯ <prompt>`), so a stale banner above a newer prompt never counts (P-SCREEN-06/25). Returned bottom-up.
 */
export function lastBlock(f: Frame, from: number, max: number, v: Vocab): number[] {
  const rows: number[] = [];
  for (let i = from - 1; i >= 0 && rows.length < max; i--) {
    const l = f.t[i] ?? '';
    if (l === '') continue;
    if (v.x.promptEcho.test(l) && !v.x.slashMenuRow.test(l)) break; // slash-menu rows (`❯ /exit   Exit the CLI`) are not echoes
    rows.push(i);
  }
  return rows;
}

/** Leading-space count of a normalized row. */
export function indentOf(line: string): number {
  const m = /^ */u.exec(line);
  return m === null ? 0 : m[0].length;
}
