// test/arch/helpers.ts — shared utilities for the architecture tests (DESIGN.md §1.4 item 3).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SRC = join(ROOT, 'src');

/** Repo-relative POSIX path. */
export function rel(abs: string): string {
  return relative(ROOT, abs).split(sep).join('/');
}

/** Every file below `dir` (absolute) whose name matches `re`; missing dirs yield []. */
export function listFiles(dir: string, re = /\.ts$/): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, re));
    else if (re.test(name)) out.push(p);
  }
  return out.sort();
}

/** Every directory below `dir` (absolute), depth-first. */
export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(p, ...listDirs(p));
  }
  return out.sort();
}

export function parse(fileName: string, text?: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text ?? readFileSync(fileName, 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
}

export interface ImportRef {
  specifier: string;
  typeOnly: boolean;
  kind: 'import' | 'export' | 'dynamic' | 'require' | 'importType';
  line: number;
}

/** All module specifiers a file references: static imports/exports, `import()`, `require()`, `import('x').T` types. */
export function importsOf(sf: ts.SourceFile): ImportRef[] {
  const out: ImportRef[] = [];
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      out.push({ specifier: n.moduleSpecifier.text, typeOnly, kind: 'import', line: lineOf(n) });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ specifier: n.moduleSpecifier.text, typeOnly: n.isTypeOnly, kind: 'export', line: lineOf(n) });
    } else if (ts.isCallExpression(n)) {
      const [arg] = n.arguments;
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && arg !== undefined && ts.isStringLiteralLike(arg)) {
        out.push({ specifier: arg.text, typeOnly: false, kind: 'dynamic', line: lineOf(n) });
      } else if (ts.isIdentifier(n.expression) && n.expression.text === 'require' && arg !== undefined && ts.isStringLiteralLike(arg)) {
        out.push({ specifier: arg.text, typeOnly: false, kind: 'require', line: lineOf(n) });
      }
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push({ specifier: n.argument.literal.text, typeOnly: true, kind: 'importType', line: lineOf(n) });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (ts.isStringLiteral(e)) out.push({ specifier: e.text, typeOnly: n.isTypeOnly, kind: 'require', line: lineOf(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** True when `node` is the expression `process.env` (also `globalThis.process.env`, `process['env']`). */
export function isProcessEnv(node: ts.Node): boolean {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n))
    n = n.expression;
  const isProcess = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && e.text === 'process') ||
    (ts.isPropertyAccessExpression(e) && e.name.text === 'process' && ts.isIdentifier(e.expression) && e.expression.text === 'globalThis');
  if (ts.isPropertyAccessExpression(n)) return n.name.text === 'env' && isProcess(n.expression);
  if (ts.isElementAccessExpression(n))
    return ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'env' && isProcess(n.expression);
  return false;
}
