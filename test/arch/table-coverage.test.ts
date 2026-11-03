// DESIGN.md §1.4 3g: scripts/check-table-coverage.mjs numbers every row of the §4.3/§4.4/§4.10 tables and finds test titles
// that name them. This arch test keeps the checker honest (the rows are found; titles are parsed); the enforcement itself is
// `pnpm check:tables` (part of `pnpm check` and CI), because the rows are covered by WP-09/WP-14 tests that land later.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allRowIds, coverageReport, rowIdsInTitles, tableRows } from '../../scripts/check-table-coverage.mjs';
import { ROOT } from './helpers.js';

const DESIGN = readFileSync(join(ROOT, 'docs', 'DESIGN.md'), 'utf8');

describe('table-row coverage checker (§1.4 3g)', () => {
  it.each(['4.3', '4.4', '4.10'])('finds the body rows of the §%s table', (s) => {
    const rows = tableRows(DESIGN, s);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => r.startsWith('|') && !/^\|\s*-{3}/.test(r))).toBe(true);
  });

  it('numbers rows by position', () => {
    const md = '### 4.4 Turn\n\n| From | To |\n|---|---|\n| a | b |\n| c | d |\n\nprose\n\n| other | table |\n|---|---|\n| x | y |\n';
    expect(tableRows(md, '4.4')).toEqual(['| a | b |', '| c | d |']);
    expect(allRowIds(md)).toEqual(['§4.4#1', '§4.4#2']);
  });

  it('reads row ids only from test titles, including .each/.fails variants', () => {
    const src = [
      "it('§4.4#7 lost Enter retries once', () => {});",
      'test.fails(`§4.10#12 permissionPolicy fires`, () => {});',
      "describe.each([1])('§4.3#2 and §4.3#20 launch', () => {});",
      "const s = '§4.4#9 not a title';",
    ].join('\n');
    expect([...rowIdsInTitles(src)].sort()).toEqual(['§4.10#12', '§4.3#2', '§4.3#20', '§4.4#7'].sort());
  });

  it('produces a report over the real design and test tree', () => {
    const r = coverageReport();
    expect(r.total).toBe(r.covered.length + r.uncovered.length);
    expect(Object.keys(r.perSection)).toEqual(['4.3', '4.4', '4.10']);
  });
});
