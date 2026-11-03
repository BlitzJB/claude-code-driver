#!/usr/bin/env node
// scripts/check-table-coverage.mjs — table-row coverage (DESIGN.md §1.4 3g, §6.1, rev 2 §10 D7).
// Every row of the §4.3 / §4.4 / §4.10 tables, numbered by position (`§4.4#7` = 7th body row of §4.4), must be named in at
// least one test title (`it('§4.4#7 …')`, `test(…)`, `describe(…)`, incl. `.each`/`.fails`/`.skip` variants).
// Usage: node scripts/check-table-coverage.mjs [--report] [--json]
//   default  exit 1 when a row is uncovered   --report  print only, exit 0   --json  machine-readable report
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TABLE_SECTIONS = ['4.3', '4.4', '4.10'];

/**
 * Body rows of the first markdown table under `### <section> `.
 * @param {string} markdown
 * @param {string} section e.g. '4.4'
 * @returns {string[]} the raw row lines, in order (row n = index n-1)
 */
export function tableRows(markdown, section) {
  const lines = markdown.split('\n');
  const head = lines.findIndex((l) => l.startsWith(`### ${section} `));
  if (head < 0) return [];
  const rows = [];
  let inTable = false;
  let sawSeparator = false;
  for (let i = head + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (/^#{1,3} /.test(l)) break;
    if (l.startsWith('|')) {
      inTable = true;
      if (!sawSeparator) {
        if (/^\|\s*:?-{3,}/.test(l)) sawSeparator = true;
        continue; // header row and separator
      }
      rows.push(l);
    } else if (inTable) {
      break; // first table ended
    }
  }
  return rows;
}

/** @param {string} markdown @returns {string[]} every row id, e.g. ['§4.3#1', …] */
export function allRowIds(markdown) {
  const ids = [];
  for (const s of TABLE_SECTIONS) {
    const n = tableRows(markdown, s).length;
    for (let i = 1; i <= n; i++) ids.push(`§${s}#${i}`);
  }
  return ids;
}

const TITLE_RE = /\b(?:it|test|describe)(?:\.[A-Za-z]+)*(?:\([^()]*\))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const ROW_REF_RE = /§(4\.(?:3|4|10))#(\d+)(?!\d)/g;

/** @param {string} source a test file's text @returns {Set<string>} row ids named in test titles */
export function rowIdsInTitles(source) {
  const found = new Set();
  for (const m of source.matchAll(TITLE_RE)) {
    const title = m[2] ?? '';
    for (const r of title.matchAll(ROW_REF_RE)) found.add(`§${r[1]}#${r[2]}`);
  }
  return found;
}

/** @param {string} dir @returns {string[]} */
function testFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...testFiles(p));
    else if (/\.test\.[cm]?[jt]s$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * @param {{ designPath?: string; testDir?: string }} [o]
 * @returns {{ total: number; covered: string[]; uncovered: string[]; perSection: Record<string, number>; coveredBy: Record<string, string[]> }}
 */
export function coverageReport(o = {}) {
  const md = readFileSync(o.designPath ?? join(root, 'docs', 'DESIGN.md'), 'utf8');
  const ids = allRowIds(md);
  /** @type {Record<string, string[]>} */
  const coveredBy = {};
  for (const f of testFiles(o.testDir ?? join(root, 'test'))) {
    for (const id of rowIdsInTitles(readFileSync(f, 'utf8'))) (coveredBy[id] ??= []).push(relative(root, f));
  }
  /** @type {Record<string, number>} */
  const perSection = {};
  for (const s of TABLE_SECTIONS) perSection[s] = tableRows(md, s).length;
  return {
    total: ids.length,
    covered: ids.filter((id) => coveredBy[id] !== undefined),
    uncovered: ids.filter((id) => coveredBy[id] === undefined),
    perSection,
    coveredBy,
  };
}

function main() {
  const report = coverageReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const sections = Object.entries(report.perSection)
      .map(([s, n]) => `§${s}: ${n} rows`)
      .join(', ');
    process.stdout.write(`table coverage: ${report.covered.length}/${report.total} rows named by a test (${sections})\n`);
    if (report.uncovered.length > 0) process.stdout.write(`uncovered: ${report.uncovered.join(' ')}\n`);
  }
  if (report.total === 0) {
    process.stderr.write('check-table-coverage: no table rows found in docs/DESIGN.md (headings moved?)\n');
    process.exit(2);
  }
  if (!process.argv.includes('--report') && report.uncovered.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
