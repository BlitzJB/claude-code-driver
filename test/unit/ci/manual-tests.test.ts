// test/unit/ci/manual-tests.test.ts — docs/MANUAL-TESTS.md carries the manual tests of DESIGN.md §6.7 (WP-CI): M-01
// (P-LIFE-57), M-02 (LP-27 / AL L-4), M-03 (marked removed per docs/icr/0000-drop-wp-orch.md), M-04 (P-REV-32), and the
// self-hosted live-run rules (P-SEC-43). The M-02 probe script must at least compile.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const doc = readFileSync(join(ROOT, 'docs', 'MANUAL-TESTS.md'), 'utf8');

/** The body of the `## <id> …` section up to the next `## `. */
function section(id: string): string {
  const start = doc.search(new RegExp(`^## ${id}\\b`, 'm'));
  if (start < 0) return '';
  const rest = doc.slice(start + 3);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('docs/MANUAL-TESTS.md', () => {
  it('has a section for each of M-01…M-04 and lists them in the index table', () => {
    for (const id of ['M-01', 'M-02', 'M-03', 'M-04']) {
      expect(section(id), id).not.toBe('');
      expect(doc).toMatch(new RegExp(`^\\| ${id} +\\|`, 'm'));
    }
  });

  it('M-01 checks the LaunchAgent after a real sleep of at least 10 minutes (P-LIFE-57)', () => {
    const s = section('M-01');
    expect(s).toContain('P-LIFE-57');
    expect(s).toContain('ccd lifecheck install');
    expect(s).toContain('ccd lifecheck status');
    expect(s).toMatch(/at least 10 minutes/);
    expect(s).toContain('ranAt');
    expect(s).toMatch(/Pass:/);
    expect(s).toMatch(/Cleanup:/);
  });

  it('M-02 records whether performance.now() advances in sleep (LP-27) with a script that compiles', () => {
    const s = section('M-02');
    expect(s).toContain('LP-27');
    expect(s).toMatch(/at least 5 minutes/);
    const code = /```js\n([\s\S]*?)```/.exec(s)?.[1];
    expect(code).toBeDefined();
    expect(() => new Script(code ?? '', { filename: 'ccd-m02.mjs' })).not.toThrow();
    expect(code).toContain('performance.now()');
    expect(code).toContain('Date.now()');
    expect(code).toMatch(/5000/);
  });

  it('M-03 is marked removed and points at the ICR that dropped WP-ORCH', () => {
    const s = section('M-03');
    expect(s).toMatch(/removed/i);
    expect(s).toContain('docs/icr/0000-drop-wp-orch.md');
  });

  it('M-04 covers the nvm default switch and reinstall against the shim (P-REV-32)', () => {
    const s = section('M-04');
    expect(s).toContain('P-REV-32');
    expect(s).toContain('nvm alias default');
    expect(s).toContain('lifecheck-target.json');
    expect(s).toMatch(/Pass:/);
  });

  it('documents self-hosted live runs without enabling them in CI, one runner uid per runner (P-SEC-43)', () => {
    const s = section('Self-hosted live runs');
    expect(s).toContain('P-SEC-43');
    expect(s).toContain('CCD_LIVE=1');
    expect(s).toMatch(/Do not add `CCD_LIVE=1` to a hosted GitHub workflow/);
  });

  it('ends with a results log table', () => {
    expect(section('Results log')).toMatch(/\| Date \| Test \|/);
  });
});
