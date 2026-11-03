// DESIGN.md §1.4 item 1 + P-API-30: the dependency-cruiser rules are verified against planted violations, because the
// `standalone-builtins-only` rule and the per-facade isolation rules were UNVERIFIED in AL §3.2. Each planted file breaks exactly
// one rule; the clean files must produce no violation. Runs the real depcruise CLI on a throw-away tree.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from './helpers.js';

const BIN = join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');
const CONFIG = join(ROOT, '.dependency-cruiser.cjs');

const TREE: Readonly<Record<string, string>> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
    include: ['src'],
  }),
  'package.json': JSON.stringify({ name: 'planted', type: 'module', private: true }),
  // ---- clean modules (no violation) ----
  'src/model/ids.ts': "export type Key = string;\nexport const KEY = 'k';\n",
  'src/model/a.ts': "import type { B } from './b.js';\nexport interface A { b?: B }\n",
  'src/model/b.ts': "import type { A } from './a.js';\nexport interface B { a?: A }\n",
  'src/platform/ports.ts':
    "import type { Key } from '../model/ids.js';\nexport interface Port { k: Key }\nexport const PORT_VERSION = 1;\n",
  'src/platform/tmux/pane.ts': "import { KEY } from '../../model/ids.js';\nexport const pane = KEY;\n",
  'src/platform/tmux/fake-tmux.ts': "import { pane } from './pane.js';\nexport const fake = pane;\n",
  'src/platform/tmux/standalone/ok.ts': "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
  'src/channels/ok.ts': "import type { Port } from '../platform/ports.js';\nexport const c = (p: Port): string => p.k;\n",
  'src/core/selectors.ts': "import { KEY } from '../model/ids.js';\nexport const sel = KEY;\n",
  'src/session/ok.ts': "import type { Port } from '../platform/ports.js';\nexport const s = (p: Port): string => p.k;\n",
  'src/session/reaper.ts': 'export const reap = 1;\n',
  'src/runtime/node.ts': "import { pane } from '../platform/tmux/pane.js';\nexport const createKernel = pane;\n",
  'src/api/ok.ts':
    "import { sel } from '../core/selectors.js';\nimport { createKernel } from '../runtime/node.js';\nexport const api = [sel, createKernel];\n",
  'src/cli/ok.ts': "import { reap } from '../session/reaper.js';\nexport const cli = reap;\n",
  'src/testing/fake-ports.ts': "import { fake } from '../platform/tmux/fake-tmux.js';\nexport const fakes = fake;\n",
  'src/facades/mcp/index.ts': 'export const m = 1;\n',
  // ---- planted violations: file → the one rule it must trip ----
  'src/platform/tmux/standalone/bad.ts': "import { KEY } from '../../../model/ids.js';\nexport const b = KEY;\n",
  'src/platform/hook-server/worker.ts': "import { KEY } from '../../model/ids.js';\nexport const w = KEY;\n",
  'src/facades/rx/index.ts': "import { m } from '../mcp/index.js';\nexport const rx = m;\n",
  'src/core/uses-builtin.ts': "import { EventEmitter } from 'node:events';\nexport const e = EventEmitter;\n",
  'src/core/cycle-a.ts': "import { cb } from './cycle-b.js';\nexport const ca = (): number => cb() + 1;\n",
  'src/core/cycle-b.ts': "import { ca } from './cycle-a.js';\nexport const cb = (): number => ca() + 1;\n",
  'src/api/bad-session.ts': "import { s } from '../session/ok.js';\nexport const x = s;\n",
  'src/session/bad-value-port.ts': "import { PORT_VERSION } from '../platform/ports.js';\nexport const v = PORT_VERSION;\n",
  'src/channels/bad-value-platform.ts': "import { pane } from '../platform/tmux/pane.js';\nexport const p = pane;\n",
  'src/cli/bad-core.ts': "import { sel } from '../core/selectors.js';\nexport const y = sel;\n",
  'src/model/bad-up.ts': "import { sel } from '../core/selectors.js';\nexport const z = sel;\n",
  'src/runtime/bad-fake.ts': "import { fake } from '../platform/tmux/fake-tmux.js';\nexport const f = fake;\n",
};

const EXPECTED: readonly (readonly [string, string])[] = [
  ['src/platform/tmux/standalone/bad.ts', 'standalone-builtins-only'],
  ['src/platform/hook-server/worker.ts', 'standalone-builtins-only'],
  ['src/facades/rx/index.ts', 'facades-isolated-rx'],
  ['src/core/uses-builtin.ts', 'core-no-builtins'],
  ['src/core/cycle-a.ts', 'no-circular'], // depcruise reports a cycle once, from its first module
  ['src/api/bad-session.ts', 'facade-no-low'],
  ['src/session/bad-value-port.ts', 'session-platform-types-only'],
  ['src/channels/bad-value-platform.ts', 'channels-platform-types-only'],
  ['src/cli/bad-core.ts', 'cli-no-low'],
  ['src/model/bad-up.ts', 'model-imports-nothing'],
  ['src/runtime/bad-fake.ts', 'fakes-only-from-testing'],
];

interface Violation {
  from: string;
  to: string;
  rule: { name: string; severity: string };
}

let dir = '';
let violations: Violation[] = [];
let exitCode = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccd-depcruise-'));
  for (const [p, text] of Object.entries(TREE)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  const run = (outputType: string): { status: number; stdout: string } => {
    try {
      const stdout = execFileSync(process.execPath, [BIN, 'src', '--config', CONFIG, '--output-type', outputType], {
        cwd: dir,
        encoding: 'utf8',
      });
      return { status: 0, stdout };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string };
      return { status: err.status ?? -1, stdout: err.stdout ?? '' };
    }
  };
  // `err` output exits with the number of errors (the CI form); `json` gives the per-edge detail.
  exitCode = run('err').status;
  const out = run('json').stdout;
  const parsed = JSON.parse(out) as { summary: { violations: Violation[] } };
  violations = parsed.summary.violations.filter((v) => v.rule.severity === 'error');
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe('dependency-cruiser rules catch planted violations (P-API-30)', () => {
  it('exits non-zero (number of errors)', () => {
    expect(exitCode).toBeGreaterThan(0);
  });

  it.each(EXPECTED)('%s trips %s', (from, rule) => {
    expect(violations.filter((v) => v.from === from).map((v) => v.rule.name)).toContain(rule);
  });

  it('clean modules (incl. a type-only model cycle and a fake imported by testing/) produce no error', () => {
    const planted = new Set([...EXPECTED.map(([f]) => f), 'src/core/cycle-b.ts']);
    expect(violations.filter((v) => !planted.has(v.from)).map((v) => `${v.from} → ${v.to}: ${v.rule.name}`)).toEqual([]);
  });

  it('each planted file trips only its intended rule', () => {
    const cycleEdge = (v: Violation): boolean => v.rule.name === 'no-circular' && /^src\/core\/cycle-[ab]\.ts$/.test(v.from);
    const extra = violations.filter((v) => !cycleEdge(v) && !EXPECTED.some(([f, r]) => f === v.from && r === v.rule.name));
    expect(extra.map((v) => `${v.from} → ${v.to}: ${v.rule.name}`)).toEqual([]);
  });
});
