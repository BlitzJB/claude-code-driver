// test/unit/channels/screen-corpus.ts (WP-07): loads the scrubbed screen corpus `fixtures/screens/*.log` (DESIGN.md §6.2).
// Each `=== <stamp>` header starts one frame (a full `capture-pane -p` or, for the faultproxy logs, the bottom 12 non-blank
// rows). The corpus records no pane width, so a file's width is its longest solid rule (the probes ran 111-column rules).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PaneStatus } from '../../../src/platform/ports.js';

export const SCREENS_DIR = fileURLToPath(new URL('../../../fixtures/screens/', import.meta.url));

export interface CorpusFrame {
  file: string;
  frame: number;
  stamp: string;
  lines: string[];
  status: PaneStatus;
}

export function paneStatus(o: Partial<PaneStatus> = {}): PaneStatus {
  return {
    exists: true,
    dead: false,
    exitStatus: null,
    exitSignal: null,
    inMode: false,
    alternateOn: false,
    cursorX: 0,
    cursorY: 0,
    cols: 111,
    rows: 40,
    historySize: 0,
    ...o,
  };
}

export function corpusFiles(): string[] {
  return readdirSync(SCREENS_DIR)
    .filter((f) => f.endsWith('.log'))
    .sort();
}

export function loadCorpus(): CorpusFrame[] {
  const out: CorpusFrame[] = [];
  for (const file of corpusFiles()) {
    const text = readFileSync(SCREENS_DIR + file, 'utf8');
    const cols = Math.max(
      0,
      ...text
        .split('\n')
        .filter((l) => /^─{8,}$/u.test(l.trim()))
        .map((l) => l.trim().length),
    );
    const chunks = text.split(/^=== (.*)$/mu); // ['', stamp1, body1, stamp2, body2, …]
    let frame = 0;
    for (let i = 1; i < chunks.length; i += 2) {
      const stamp = chunks[i] ?? '';
      const body = (chunks[i + 1] ?? '').replace(/^\n/u, '').replace(/\n$/u, '');
      const lines = body.split('\n');
      out.push({ file, frame, stamp, lines, status: paneStatus({ cols, rows: Math.max(lines.length, 1) }) });
      frame++;
    }
  }
  return out;
}
