// DESIGN.md §4.12 (rev 2 §10 G4, D-03): the closed list of adapter timers. Any setTimeout/setInterval (or node:timers import)
// outside the allowlisted files fails. Decision timers are core deadlines; the single decision timer is A-0 in scheduler.ts.
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { importsOf, listFiles, parse, rel, SRC } from './helpers.js';

/** File → adapter-timer ids it hosts (§4.12). */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/session/scheduler.ts': 'A-0 decision timer, A-7 loop-lag window',
  'src/session/lifecycle.ts': 'A-1 heartbeat',
  'src/session/pollers.ts': 'A-3 pane_dead poll, A-4 screen poll, A-5 auth poll',
  'src/platform/fs-tail/follower.ts': 'A-6 tail poll',
  'src/platform/process/standalone/owner-watch.ts': 'A-8 owner-watch (separate process)',
  'src/platform/netproxy/standalone/sidecar.ts': 'A-8 sidecar (separate process)',
  'src/session/debug-trace.ts': 'A-9 trace flush',
  // The Clock port implementation (§2.1 Clock.setTimer/sleep). Every other adapter that needs to wait goes through it, so the
  // closed list above stays the only place where timers are *scheduled* with a purpose.
  'src/platform/clock/real-clock.ts': 'Clock port implementation',
};
const ALLOWED_PATTERNS = [/^src\/testing\//, /\/fake-[^/]+\.ts$/];

const TIMER_FNS = new Set(['setTimeout', 'setInterval']);

/** An identifier read as a value that is not already counted as a call/qualified call and is not a declaration or key name. */
function isValueReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === n)
    return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)) && p.name === n)
    return false;
  return true;
}

function timerUses(fileName: string, text?: string): string[] {
  const sf = parse(fileName, text);
  const hits: string[] = [];
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name !== undefined && TIMER_FNS.has(name)) hits.push(`${name} (line ${at(n)})`);
    } else if (ts.isIdentifier(n) && TIMER_FNS.has(n.text) && isValueReference(n)) {
      hits.push(`${n.text} reference (line ${at(n)})`); // e.g. `const t = setTimeout; t(fn, 1)`
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const i of importsOf(sf))
    if (/^(?:node:)?timers(?:\/promises)?$/.test(i.specifier)) hits.push(`import '${i.specifier}' (line ${i.line})`);
  return hits;
}

describe('adapter timers are a closed list (§4.12)', () => {
  it('no setTimeout/setInterval/node:timers outside the allowlisted files', () => {
    const offenders = listFiles(SRC, /\.ts$/)
      .map((f) => rel(f))
      .filter((f) => ALLOWED[f] === undefined && !ALLOWED_PATTERNS.some((re) => re.test(f)))
      .map((f) => ({ file: f, uses: timerUses(f) }))
      .filter((x) => x.uses.length > 0);
    expect(offenders).toEqual([]);
  });

  it('the checker finds direct, qualified, aliased and imported timers', () => {
    const src = [
      'setTimeout(() => {}, 10);',
      'globalThis.setInterval(tick, 5);',
      'const t = setTimeout;',
      "import { setTimeout as sleep } from 'node:timers/promises';",
      'schedule(setInterval);',
    ].join('\n');
    expect(timerUses('x.ts', src)).toEqual([
      'setTimeout (line 1)',
      'setInterval (line 2)',
      'setTimeout reference (line 3)',
      'setInterval reference (line 5)',
      "import 'node:timers/promises' (line 4)",
    ]);
  });

  it('the checker ignores clock-port use and unrelated names', () => {
    const src = 'const c = clock.setTimer(at, fn);\nawait clock.sleep(5);\nconst setTimeoutMs = 3;';
    expect(timerUses('ok.ts', src)).toEqual([]);
  });
});
