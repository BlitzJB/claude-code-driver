// Structural rules from DESIGN.md §1.2/§1.3 that neither depcruise nor ESLint can express:
// P-API-28 no subfolder named after a layer; R-F no barrel index.ts below the subpath roots; model/** imports nothing and no
// node:*; version.ts in sync with package.json (single source of truth for SUPPORTED_CLAUDE_VERSION).
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderVersionFile } from '../../scripts/gen-version.mjs';
import { importsOf, listDirs, listFiles, parse, rel, ROOT, SRC } from './helpers.js';

const LAYER_NAMES = new Set(['model', 'platform', 'channels', 'core', 'session', 'runtime', 'api', 'facades', 'cli', 'testing']);
const ALLOWED_INDEX = new Set([
  'src/api/index.ts',
  'src/testing/index.ts',
  'src/channels/profiles/index.ts',
  'src/channels/profiles/claude-2.1.316/index.ts',
]);
const ALLOWED_INDEX_RE = [/^src\/facades\/[^/]+\/index\.ts$/];

describe('layering structure', () => {
  it('no directory below a layer root is named after a layer (P-API-28: the ESLint import globs match the import string)', () => {
    const bad = listDirs(SRC)
      .map((d) => rel(d))
      .filter((d) => d.split('/').length > 2 && LAYER_NAMES.has(basename(d)));
    expect(bad).toEqual([]);
  });

  it('top-level src/ folders are layers only', () => {
    const top = listDirs(SRC)
      .map((d) => rel(d))
      .filter((d) => d.split('/').length === 2)
      .map((d) => basename(d));
    expect(top.filter((d) => !LAYER_NAMES.has(d))).toEqual([]);
  });

  it('no barrel index.ts outside the subpath roots (R-F)', () => {
    const bad = listFiles(SRC, /^index\.ts$/)
      .map((f) => rel(f))
      .filter((f) => !ALLOWED_INDEX.has(f) && !ALLOWED_INDEX_RE.some((re) => re.test(f)));
    expect(bad).toEqual([]);
  });

  it('model/** imports only model/** and no node:* or npm module', () => {
    const offenders = listFiles(join(SRC, 'model')).flatMap((f) =>
      importsOf(parse(f))
        .filter((i) => !/^\.\/[a-z-]+\.js$/.test(i.specifier))
        .map((i) => `${rel(f)}:${i.line} ${i.specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('platform/ports.ts is types only (no runtime value exports or value imports)', () => {
    const file = join(SRC, 'platform', 'ports.ts');
    const text = readFileSync(file, 'utf8');
    expect(importsOf(parse(file)).every((i) => i.typeOnly)).toBe(true);
    expect(text).not.toMatch(/^export (?:const|let|var|function|class|enum)\b/m);
  });

  it('src/model/version.ts matches package.json (run `pnpm gen-version`)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(readFileSync(join(SRC, 'model', 'version.ts'), 'utf8')).toBe(renderVersionFile(pkg));
  });

  it('package.json pins the toolchain exactly (P-API-23/25/26) and has zero runtime dependencies (D-29)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
      engines: Record<string, string>;
      claudeCodeVersion: string;
      type: string;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.type).toBe('module');
    expect(pkg.engines['node']).toBe('>=20');
    expect(pkg.claudeCodeVersion).toBe('2.1.316');
    expect(pkg.devDependencies).toMatchObject({
      '@anthropic-ai/claude-code': '2.1.316',
      typescript: '6.0.3',
      'typescript-eslint': '8.72.1',
      eslint: '10.14.0',
      prettier: '3.9.10',
      vitest: '4.1.12',
      '@vitest/coverage-v8': '4.1.12',
      'fast-check': '4.10.2',
      'dependency-cruiser': '17.4.3',
      publint: '0.3.25',
      '@arethetypeswrong/cli': '0.18.5',
      knip: '6.44.1',
      '@types/node': '^20',
    });
    expect(readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()).toBe('22');
  });
});
