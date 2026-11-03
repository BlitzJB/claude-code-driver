// P-TMUX-17 / DESIGN.md §1.4 3a: no global `window-size` option anywhere in src/ (tmux 3.5a SIGSEGV, TD §5.3).
import { describe, expect, it } from 'vitest';
import { findGlobalWindowSize, scanDirs } from '../../scripts/check-no-global-window-size.mjs';
import { SRC } from './helpers.js';

describe('no global window-size (P-TMUX-17)', () => {
  it('src/ contains no global window-size option in any spelling', () => {
    expect(scanDirs([SRC])).toEqual([]);
  });

  it.each([
    'tmux set -g window-size manual',
    "run(['set', '-g', 'window-size', 'manual'])",
    'run(["set-option", "-gw", "window-size", "manual"])',
    'setw -g window-size manual',
    'set-option -g window-size latest',
    'args.push(`-g`, `window-size`)',
  ])('flags %s', (line) => {
    expect(findGlobalWindowSize(line)).toHaveLength(1);
  });

  it.each([
    "set -w -t 'ccd:' window-size manual",
    "['set', '-w', '-t', `${s}:`, 'window-size', 'manual']",
    'resize-window -x 250 -y 80',
    '// window-size is set per window only',
  ])('accepts %s', (line) => {
    expect(findGlobalWindowSize(line)).toEqual([]);
  });
});
