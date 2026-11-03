// test/replay/fixtures-build.test.ts — the replay fixtures are reproducible from the committed live corpus (DESIGN.md §6.6
// "Initial fixtures built without new live runs by scripts/fixtures-from-verify.mjs"; WP-INT).
//
// Running the builder over fixtures/verify alone (the BRIEF probe dirs are machine-local and not committed) must reproduce
// every verify-derived trace in fixtures/traces byte for byte, scrubbed and lint-clean. The probe-derived traces
// (bg-agents-task-notification, esc-*, ghost-agent-after-stop, retry-storm) were built once with --hookprobe/--faultproxy;
// they are checked for shape here.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readTrace } from '../../src/testing/replay.js';

const ROOT = join(import.meta.dirname, '..', '..');
const TRACES = join(ROOT, 'fixtures', 'traces');
const out = mkdtempSync(join(tmpdir(), 'ccd-fixtures-'));

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe('fixtures-from-verify', () => {
  it('rebuilds every verify-derived trace byte for byte', () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'fixtures-from-verify.mjs'), '--out', out], { cwd: ROOT, stdio: 'pipe' });
    // committed fixtures are depersonalized (scripts/fixtures-depersonalize.mjs); apply the same pass to the rebuild
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'fixtures-depersonalize.mjs'), out], { cwd: ROOT, stdio: 'pipe' });
    const built = readdirSync(out).filter((f) => f.endsWith('.ccd.jsonl'));
    expect(built.length).toBeGreaterThanOrEqual(9);
    for (const f of built) expect(readFileSync(join(out, f), 'utf8'), f).toBe(readFileSync(join(TRACES, f), 'utf8'));
  });

  it('every committed trace is well-formed, pinned to 2.1.316 and has a sane time span', () => {
    for (const f of readdirSync(TRACES).filter((x) => x.endsWith('.ccd.jsonl'))) {
      const t = readTrace(join(TRACES, f));
      expect(t.header.claude, f).toBe('2.1.316');
      const ats = t.records.flatMap((r) => (r.r === 'raw' ? [r.at] : []));
      expect(ats.length, f).toBeGreaterThan(0);
      // a missing timestamp once turned into an epoch-sized span (ICR 0016): every trace is a minutes-long window
      expect(Math.max(...ats) - Math.min(...ats), f).toBeLessThan(60 * 60 * 1000);
      expect(
        t.records.every((r) => r.r !== 'raw' || r.wallAt > 0),
        f,
      ).toBe(true);
    }
  });
});
