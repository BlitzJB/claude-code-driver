// DESIGN.md §1.4 3e, D-39, P-REV-41: public option names live only in src/api/**.
// (1) No file outside src/api/** references a property name that is declared only in src/api/options.ts.
// (2) src/session/config.ts imports SessionSpec from model/spec.ts and nothing from api/**.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { importsOf, listFiles, parse, rel, SRC } from './helpers.js';

const OPTIONS = join(SRC, 'api', 'options.ts');
const CONFIG = join(SRC, 'session', 'config.ts');

function propName(n: ts.PropertyName | ts.BindingName | ts.MemberName): string | undefined {
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return undefined;
}

/** Property names *declared* in type positions (interface / type-literal members). */
function declaredProps(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if ((ts.isPropertySignature(n) || ts.isMethodSignature(n)) && propName(n.name) !== undefined) out.add(propName(n.name) ?? '');
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Property names *used* in value or type positions: `a.x`, `{ x: … }`, `{ x }`, `const { x } = …`, `T['x']`, member declarations. */
function usedProps(sf: ts.SourceFile): Map<string, number> {
  const out = new Map<string, number>();
  const add = (name: string | undefined, n: ts.Node): void => {
    if (name !== undefined && !out.has(name)) out.set(name, sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) add(n.name.text, n.name);
    else if (ts.isPropertyAssignment(n) || ts.isPropertySignature(n) || ts.isMethodSignature(n) || ts.isPropertyDeclaration(n))
      add(propName(n.name), n);
    else if (ts.isShorthandPropertyAssignment(n)) add(n.name.text, n);
    else if (ts.isBindingElement(n)) add(propName(n.propertyName ?? n.name), n);
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) add(n.argumentExpression.text, n);
    else if (ts.isIndexedAccessTypeNode(n) && ts.isLiteralTypeNode(n.indexType) && ts.isStringLiteral(n.indexType.literal))
      add(n.indexType.literal.text, n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The core algorithm, kept separate so it can be tested on synthetic sources. */
function optionLeaks(options: ts.SourceFile, inside: readonly ts.SourceFile[], outside: readonly ts.SourceFile[]): string[] {
  const elsewhere = new Set<string>();
  for (const sf of [...inside, ...outside]) for (const p of declaredProps(sf)) elsewhere.add(p);
  const onlyInOptions = [...declaredProps(options)].filter((p) => !elsewhere.has(p));
  const leaks: string[] = [];
  for (const sf of outside) {
    const used = usedProps(sf);
    for (const p of onlyInOptions) {
      const line = used.get(p);
      if (line !== undefined) leaks.push(`${sf.fileName}:${line} uses public-only option '${p}'`);
    }
  }
  return leaks;
}

describe('option isolation (§1.4 3e)', () => {
  it.skipIf(!existsSync(OPTIONS))('no file outside src/api/** references a property declared only in api/options.ts', () => {
    const all = listFiles(SRC, /\.ts$/).map((f) => parse(rel(f), readFileSync(f, 'utf8')));
    const options = all.find((s) => s.fileName === 'src/api/options.ts');
    expect(options).toBeDefined();
    if (options === undefined) return;
    const apiOthers = all.filter((s) => s.fileName.startsWith('src/api/') && s !== options);
    const outside = all.filter((s) => !s.fileName.startsWith('src/api/') && !s.fileName.startsWith('src/testing/'));
    expect(optionLeaks(options, apiOthers, outside)).toEqual([]);
  });

  it.skipIf(!existsSync(CONFIG))('session/config.ts imports SessionSpec from model/spec.ts and nothing from api/**', () => {
    const sf = parse(CONFIG);
    const imports = importsOf(sf);
    expect(imports.filter((i) => /(?:^|\/)api\//.test(i.specifier))).toEqual([]);
    const specImport = sf.statements.find(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === '../model/spec.js' &&
        s.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(s.importClause.namedBindings) &&
        s.importClause.namedBindings.elements.some((e) => e.name.text === 'SessionSpec'),
    );
    expect(specImport).toBeDefined();
  });

  it('the checker flags an L3 file that reads a public-only option name and ignores shared names', () => {
    const options = parse(
      'src/api/options.ts',
      'export interface ClaudeSessionOptions { cwd: string; usageLimit?: { autoResume?: boolean }; unstable_advanced?: unknown; debug?: { trace?: string } }',
    );
    const spec = parse(
      'src/model/spec.ts',
      'export interface SessionSpec { cwd: string; usageLimit?: { autoResume?: boolean }; debug?: { tracePath?: string } }',
    );
    const config = parse(
      'src/session/config.ts',
      'export function f(s: { debug?: { trace?: string } }) { const { unstable_advanced } = s as never; return s.debug?.trace ?? s.cwd; }',
    );
    expect(optionLeaks(options, [], [spec, config])).toEqual(["src/session/config.ts:1 uses public-only option 'unstable_advanced'"]);
    const config2 = parse('src/session/config.ts', 'export const g = (o: Record<string, unknown>) => o["unstable_advanced"];');
    expect(optionLeaks(options, [], [spec, config2])).toEqual(["src/session/config.ts:1 uses public-only option 'unstable_advanced'"]);
  });
});
