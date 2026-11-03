#!/usr/bin/env node
// scripts/check-no-global-window-size.mjs — P-TMUX-17 (DESIGN.md §1.4 3a, TD §5.3).
// `set -g window-size manual` SIGSEGVs tmux 3.5a. The driver must set window-size per window (`set -w -t <s>: window-size manual`).
// This greps src/ for every spelling of a *global* window-size option: the shell form (`set -g window-size`, `-gw window-size`,
// `setw -g window-size`, `set-option -g window-size`) and the execFile argv-array form (`'-g', 'window-size'`, `'-gw', …`).
// Usage: node scripts/check-no-global-window-size.mjs [dir…]   (default: src). Exit 1 on any hit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each pattern matches one forbidden spelling on a single line. */
export const GLOBAL_WINDOW_SIZE_PATTERNS = [
  // shell/string form: any -g… flag cluster (-g, -gw, -wg, -gq, …) directly before window-size
  /(?:^|[\s'"`])-[a-zA-Z]*g[a-zA-Z]*\s+window-size\b/,
  // argv-array form: '-g', 'window-size'  /  "-gw", "window-size"
  /['"`]-[a-zA-Z]*g[a-zA-Z]*['"`]\s*,\s*['"`]window-size['"`]/,
  // explicit spellings named in TD §5.3
  /\bset(?:-option|w|-window-option)?\s+-g\s+window-size\b/,
];

const SCANNED_EXT = /\.(?:[cm]?[jt]s|sh|json|tmpl)$/;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (SCANNED_EXT.test(name)) out.push(p);
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Array<{ line: number; text: string }>}
 */
export function findGlobalWindowSize(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (GLOBAL_WINDOW_SIZE_PATTERNS.some((re) => re.test(l))) hits.push({ line: i + 1, text: l.trim() });
  }
  return hits;
}

/**
 * @param {string[]} dirs absolute directories to scan
 * @returns {Array<{ file: string; line: number; text: string }>}
 */
export function scanDirs(dirs) {
  const hits = [];
  for (const d of dirs) {
    for (const f of walk(d)) {
      for (const h of findGlobalWindowSize(readFileSync(f, 'utf8'))) hits.push({ file: relative(root, f), ...h });
    }
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const dirs = (args.length > 0 ? args : ['src']).map((d) => join(root, d));
  const hits = scanDirs(dirs);
  if (hits.length > 0) {
    for (const h of hits) process.stderr.write(`${h.file}:${h.line}: global window-size option (SIGSEGV on tmux 3.5a): ${h.text}\n`);
    process.exit(1);
  }
  process.stdout.write('check-no-global-window-size: ok\n');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
