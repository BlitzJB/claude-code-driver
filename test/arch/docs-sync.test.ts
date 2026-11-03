// Docs never drift from the public API (CLAUDE.md "Docs stay in sync").
//   1. Every public ClaudeSession member, SessionEvent type, AgentStatus kind, ClaudeSessionOptions key and package export
//      is named (in backticks) in docs/USAGE.md.
//   2. Every TypeScript example in README.md, docs/USAGE.md and site/guide/getting-started.md compiles against src/api.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const USAGE = read('docs/USAGE.md');
/** Named in backticks, bare (`send(`) or qualified (`ClaudeSession.closeAll()`). */
const mentioned = (name: string): boolean => USAGE.includes(`\`${name}`) || USAGE.includes(`.${name}`);

function sourceOf(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
}
function find<T extends ts.Node>(sf: ts.SourceFile, pred: (n: ts.Node) => n is T): T | undefined {
  let out: T | undefined;
  const visit = (n: ts.Node): void => {
    if (out !== undefined) return;
    if (pred(n)) out = n;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** String literal values of `prop` across the members of a union type alias (`type: 'ready'`, `kind: 'idle'`, …). */
function unionLiterals(rel: string, alias: string, prop: string): string[] {
  const sf = sourceOf(rel);
  const decl = find(sf, (n): n is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(n) && n.name.text === alias);
  if (decl === undefined) throw new Error(`${alias} not found in ${rel}`);
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    // { kind: 'x' } members
    if (ts.isPropertySignature(n) && n.name.getText(sf) === prop && n.type !== undefined && ts.isLiteralTypeNode(n.type)) {
      const lit = n.type.literal;
      if (ts.isStringLiteral(lit)) out.add(lit.text);
    }
    // Ev<'x', …> members
    if (ts.isTypeReferenceNode(n) && n.typeName.getText(sf) === 'Ev') {
      const a = n.typeArguments?.[0];
      if (a !== undefined && ts.isLiteralTypeNode(a) && ts.isStringLiteral(a.literal)) out.add(a.literal.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(decl.type);
  return [...out];
}

describe('docs/USAGE.md names the whole public API', () => {
  it('every public ClaudeSession member', () => {
    const sf = sourceOf('src/api/claude-session.ts');
    const cls = find(sf, (n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'ClaudeSession');
    expect(cls).toBeDefined();
    const names = (cls?.members ?? [])
      .filter((m) => !(ts.getCombinedModifierFlags(m as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)))
      .filter((m) => !ts.isConstructorDeclaration(m) && !ts.isClassStaticBlockDeclaration(m))
      .map((m) => m.name?.getText(sf) ?? '')
      .filter((n) => n !== '' && !n.startsWith('['));
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => !mentioned(n))).toEqual([]);
  });

  it('every SessionEvent type and AgentStatus kind', () => {
    const events = unionLiterals('src/api/public-types.ts', 'SessionEvent', 'type');
    const kinds = unionLiterals('src/api/public-types.ts', 'AgentStatus', 'kind');
    expect(events.length).toBeGreaterThan(20);
    expect(kinds.length).toBeGreaterThan(10);
    expect(events.filter((n) => !mentioned(n))).toEqual([]);
    expect(kinds.filter((n) => !mentioned(n))).toEqual([]);
  });

  it('every ClaudeSessionOptions key', () => {
    const sf = sourceOf('src/api/options.ts');
    const iface = find(sf, (n): n is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(n) && n.name.text === 'ClaudeSessionOptions');
    const keys = (iface?.members ?? []).map((m) => m.name?.getText(sf) ?? '').filter((k) => k !== '' && k !== 'unstable_advanced');
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((k) => !mentioned(k))).toEqual([]);
  });

  it('every export of the package entry', () => {
    const sf = sourceOf('src/api/index.ts');
    const names: string[] = [];
    ts.forEachChild(sf, (n) => {
      if (ts.isExportDeclaration(n) && n.exportClause !== undefined && ts.isNamedExports(n.exportClause))
        for (const e of n.exportClause.elements) names.push(e.name.text);
    });
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => !mentioned(n))).toEqual([]);
  });
});

describe('doc code examples compile against the current public API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-doccheck-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}'); // the snippets use top-level await
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('README.md, docs/USAGE.md and site/guide/getting-started.md', () => {
    const files: string[] = [];
    for (const doc of ['README.md', 'docs/USAGE.md', 'site/guide/getting-started.md']) {
      const re = /```(?:ts|typescript)\n([\s\S]*?)```/g;
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = re.exec(read(doc))) !== null) {
        let body = m[1] ?? '';
        // snippets that continue an earlier example get the names they rely on
        if (!/^import /m.test(body)) {
          const hasSession = /\b(const|using) session\b/.test(body);
          body = `import { ClaudeSession, installSignalHandlers, isClaudeSessionError } from 'claude-code-driver';\n${
            hasSession ? '' : 'declare const session: ClaudeSession;\n'
          }declare const cwd: string;\ndeclare const claudeSessionId: string;\n${body}\nexport {};\n`;
        }
        const f = join(dir, `${doc.replace(/\W/g, '_')}_${String(++i)}.ts`);
        writeFileSync(f, body);
        files.push(f);
      }
    }
    expect(files.length).toBeGreaterThan(8);
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2023,
      lib: ['lib.es2023.d.ts', 'lib.esnext.disposable.d.ts'],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
      typeRoots: [join(ROOT, 'node_modules/@types')],
      paths: { 'claude-code-driver': [join(ROOT, 'src/api/index.ts')] },
    });
    const errors = ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file === undefined ? '' : `${d.file.fileName.slice(dir.length + 1)}: `;
      return `${where}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
    expect(errors).toEqual([]);
  }, 60_000);
});
