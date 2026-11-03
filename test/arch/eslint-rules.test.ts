// DESIGN.md §1.4 item 2: the ESLint rules that dependency-cruiser cannot express are exercised on planted code.
// P-API-03 (core determinism), P-API-08 (emit('error')), P-API-14 (top-level await), invariant I1 (only evolve.ts writes
// `domain`), and the per-layer import mirror. The rules are taken from eslint.config.js itself (non-type-aware subset), so a
// change to the config is what is tested.
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import config from '../../eslint.config.js';
import { ROOT } from './helpers.js';

const TYPE_AWARE_FREE = new Set([
  'no-restricted-syntax',
  'no-restricted-globals',
  'no-restricted-properties',
  '@typescript-eslint/no-restricted-imports',
]);

/** The effective rules eslint.config.js gives `filePath`, restricted to rules that need no type information. */
function rulesFor(filePath: string): Linter.RulesRecord {
  const rules: Linter.RulesRecord = {};
  for (const entry of config as Linter.Config[]) {
    const files = (entry.files ?? []).flat();
    const applies = files.some((g) => typeof g === 'string' && matches(g, filePath));
    if (!applies || entry.rules === undefined) continue;
    for (const [k, v] of Object.entries(entry.rules)) if (TYPE_AWARE_FREE.has(k) && v !== undefined) rules[k] = v;
  }
  return rules;
}

function matches(glob: string, path: string): boolean {
  const re = new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:.*/)?')
      .replace(/\u0001/g, '.*')}$`,
  );
  return re.test(path);
}

async function lint(filePath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser, sourceType: 'module', ecmaVersion: 2023 },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: rulesFor(filePath),
      },
    ],
  });
  const [res] = await eslint.lintText(code, { filePath });
  return (res?.messages ?? []).map((m) => `${m.line}:${m.ruleId ?? 'parse'}`);
}

describe('ESLint rules on planted code', () => {
  it('core: no clock, random, timers, process, console, crypto, Intl, await or throw (P-API-03, D-03)', async () => {
    const code = [
      'export function f(): number {',
      '  const a = Date.now();',
      '  const b = Math.random();',
      '  setTimeout(() => undefined, 1);',
      '  const c = performance.now();',
      '  console.log(process.pid);',
      "  if (a > b + c) throw new Error('x');",
      '  return crypto.randomUUID().length + Intl.DateTimeFormat().resolvedOptions().timeZone.length;',
      '}',
      'export async function g(): Promise<void> { await Promise.resolve(); }',
    ].join('\n');
    const msgs = await lint('src/core/decide/turns.ts', code);
    expect(msgs).toEqual(
      expect.arrayContaining([
        '2:no-restricted-globals',
        '3:no-restricted-properties',
        '4:no-restricted-globals',
        '5:no-restricted-globals',
        '6:no-restricted-globals',
        '7:no-restricted-syntax',
        '8:no-restricted-globals',
        '10:no-restricted-syntax',
      ]),
    );
  });

  it('core: only evolve.ts may write `domain` (I1)', async () => {
    const code = [
      'declare const domain: { x: number; t: Record<string, number> };',
      'declare const core: { domain: unknown };',
      'domain.x = 1;',
      "domain.t['a'] = 2;",
      'core.domain = {};',
      'domain.x++;',
      "delete domain.t['a'];",
    ].join('\n');
    expect(await lint('src/core/closing.ts', code)).toEqual([
      '3:no-restricted-syntax',
      '4:no-restricted-syntax',
      '5:no-restricted-syntax',
      '6:no-restricted-syntax',
      '7:no-restricted-syntax',
    ]);
    expect(await lint('src/core/evolve.ts', code)).toEqual([]);
  });

  it("everywhere: no emit('error') and no top-level await (P-API-08, P-API-14)", async () => {
    const code = [
      "import { EventEmitter } from 'node:events';",
      "new EventEmitter().emit('error', new Error('x'));",
      'export const v = await Promise.resolve(1);',
      'for await (const x of [Promise.resolve(1)]) void x;',
      'export async function ok(): Promise<number> { for await (const y of [Promise.resolve(2)]) void y; return await Promise.resolve(2); }',
    ].join('\n');
    expect(await lint('src/session/loop.ts', code)).toEqual(['2:no-restricted-syntax', '3:no-restricted-syntax', '4:no-restricted-syntax']);
  });

  it.each([
    ['src/channels/screen/classify.ts', "import { step } from '../../core/step.js';"],
    ['src/platform/tmux/pane.ts', "import { x } from '../../channels/hooks/normalize.js';"],
    ['src/model/state.ts', "import type { Ports } from '../platform/ports.js';"],
    ['src/api/claude-session.ts', "import { launch } from '../session/launcher.js';"],
    ['src/cli/lifecheck.ts', "import { canSubmit } from '../core/selectors.js';"],
    ['src/session/kernel.ts', "import { ClaudeSession } from '../api/claude-session.js';"],
  ])('layer import mirror: %s rejects %s', async (file, code) => {
    expect(await lint(file, `${code}\nexport {};`)).toEqual(['1:@typescript-eslint/no-restricted-imports']);
  });
});
