// test/unit/channels/screen-frames.ts (WP-07): synthetic frame builders for the screen tests. Every synthetic string is a
// template quoted in docs/caveats/screen-parse.md, docs/research/tui-known-issues.md or docs/caveats/lifecycle.md (BIN-only
// kinds have no corpus capture, DESIGN.md §6.2).
import type { PaneStatus } from '../../../src/platform/ports.js';
import { paneStatus } from './screen-corpus.js';

export const COLS = 120;
export const RULE = '─'.repeat(COLS);
export const HEADER = [' ▐▛███▛█   Claude Code v2.1.316', '▝▜██████▀  Opus 5.5 · Claude Plan', ' ▝▝   ▝▝   /private/tmp/x'];
export const IDLE_FOOTER = '  ⏸ manual mode on · ? for shortcuts';
export const BUSY_FOOTER = '  ⏸ manual mode on · esc to interrupt';

/**
 * A footer row as drawn at the default 250-col pane: the right-aligned segment (effort indicator, editor hint, usage warning)
 * shares the footer row (P0 run-main cases.jsonl, live-smoke run-48997/run-46445). `left` and `right` are verbatim captured texts.
 */
export const WIDE_COLS = 250;
export function wideFooter(left: string, right: string): string {
  const l = `  ${left}`;
  return l + ' '.repeat(Math.max(2, WIDE_COLS - 1 - l.length - right.length)) + right;
}

export interface MainOpts {
  above?: string[];
  input?: string[];
  footer?: string[];
  panel?: string[];
  header?: boolean;
  bottomRule?: string;
}

export function mainFrame(o: MainOpts = {}): string[] {
  return [
    '',
    ...(o.header === false ? [] : HEADER),
    ...(o.above ?? []),
    RULE,
    ...(o.input ?? ['❯ ']),
    o.bottomRule ?? RULE,
    ...(o.footer ?? [IDLE_FOOTER]),
    ...(o.panel !== undefined ? ['', ...o.panel] : []),
    '',
    '',
  ];
}

export function dialogFrame(body: string[], o: { above?: string[] } = {}): string[] {
  return ['', ...HEADER, ...(o.above ?? ['❯ do something']), RULE, ...body, ''];
}

export function st(o: Partial<PaneStatus> = {}): PaneStatus {
  return paneStatus({ cols: COLS, rows: 40, ...o });
}
