// DESIGN.md §1.4 3d, D-25, SEC §7.2: src/session/env-builder.ts never spreads or copies process.env wholesale.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isProcessEnv, parse, SRC } from './helpers.js';

const ENV_BUILDER = join(SRC, 'session', 'env-builder.ts');

/** Wholesale copies of process.env: spread, Object.assign / Object.entries / structuredClone / new Map over it, `for…in`. */
function processEnvCopies(fileName: string, text?: string): string[] {
  const sf = parse(fileName, text);
  const hits: string[] = [];
  const at = (n: ts.Node): string => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node): void => {
    if ((ts.isSpreadAssignment(n) || ts.isSpreadElement(n)) && isProcessEnv(n.expression)) hits.push(`spread ${at(n)}`);
    if (ts.isCallExpression(n) && n.arguments.some((a) => isProcessEnv(a))) {
      const callee = n.expression.getText(sf);
      if (/^(?:Object\.(?:assign|entries|keys|values|fromEntries)|structuredClone|JSON\.(?:stringify|parse))$/.test(callee)) {
        hits.push(`${callee}(process.env) ${at(n)}`);
      }
    }
    if (ts.isNewExpression(n) && (n.arguments ?? []).some((a) => isProcessEnv(a))) hits.push(`new …(process.env) ${at(n)}`);
    if (ts.isForInStatement(n) && isProcessEnv(n.expression)) hits.push(`for…in process.env ${at(n)}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe('no process.env spread in the child env builder (D-25)', () => {
  it.skipIf(!existsSync(ENV_BUILDER))('src/session/env-builder.ts never copies process.env wholesale', () => {
    expect(processEnvCopies(ENV_BUILDER)).toEqual([]);
  });

  it('the checker finds every wholesale-copy form', () => {
    const src = [
      'const a = { ...process.env };',
      'const b = Object.assign({}, process.env);',
      'const c = Object.entries(process.env);',
      "const d = { ...process['env'] };",
      'for (const k in process.env) {}',
      'const e = structuredClone(globalThis.process.env);',
      'const f = new Map(Object.entries(process.env as Record<string, string>));',
    ].join('\n');
    expect(processEnvCopies('x.ts', src)).toEqual([
      'spread line 1',
      'Object.assign(process.env) line 2',
      'Object.entries(process.env) line 3',
      'spread line 4',
      'for…in process.env line 5',
      'structuredClone(process.env) line 6',
      'Object.entries(process.env) line 7',
    ]);
  });

  it('the checker accepts allowlisted single-variable reads', () => {
    const src = "const home = process.env['HOME'];\nconst env = { HOME: process.env.HOME ?? '' };\nconst s = { ...callerEnv };";
    expect(processEnvCopies('ok.ts', src)).toEqual([]);
  });
});
