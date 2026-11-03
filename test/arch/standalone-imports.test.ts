// DESIGN.md §1.4 3c, R-A, P-API-13: every src/platform/*/standalone/*.ts and hook-server/worker.ts imports only node:*.
// They are spawned as separate processes / worker threads from dist/ and must work with no other module present.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importsOf, listDirs, listFiles, parse, rel, SRC } from './helpers.js';

function standaloneFiles(): string[] {
  const platform = join(SRC, 'platform');
  const files = listDirs(platform)
    .filter((d) => d.endsWith('/standalone') && d.split('/').length === platform.split('/').length + 2)
    .flatMap((d) => listFiles(d, /\.ts$/));
  return [...files, ...listFiles(join(platform, 'hook-server'), /^worker\.ts$/)];
}

function nonBuiltinImports(fileName: string, text?: string): string[] {
  return importsOf(parse(fileName, text))
    .filter((i) => !i.specifier.startsWith('node:'))
    .map((i) => `${i.kind} '${i.specifier}' (line ${i.line})`);
}

describe('standalone scripts and the hook worker import node:* only', () => {
  it('every standalone/worker file in src/platform has only node:* imports', () => {
    const offenders = standaloneFiles()
      .map((f) => ({ file: rel(f), bad: nonBuiltinImports(f) }))
      .filter((x) => x.bad.length > 0);
    expect(offenders).toEqual([]);
  });

  it('the checker rejects relative, bare-builtin, npm, dynamic and require imports', () => {
    const src = [
      "import { a } from '../../model/ids.js';",
      "import fs from 'fs';",
      "import x from 'some-pkg';",
      "const m = await import('./other.js');",
      "const r = require('node:fs');",
      "const q = require('child_process');",
      "export { b } from './b.js';",
      "type T = import('../ports.js').Ports;",
    ].join('\n');
    expect(nonBuiltinImports('x.ts', src)).toEqual([
      "import '../../model/ids.js' (line 1)",
      "import 'fs' (line 2)",
      "import 'some-pkg' (line 3)",
      "dynamic './other.js' (line 4)",
      "require 'child_process' (line 6)",
      "export './b.js' (line 7)",
      "importType '../ports.js' (line 8)",
    ]);
  });

  it('the checker accepts node:* imports of every form', () => {
    const src =
      "import { readFileSync } from 'node:fs';\nimport type { Socket } from 'node:net';\nconst w = await import('node:worker_threads');";
    expect(nonBuiltinImports('ok.ts', src)).toEqual([]);
  });
});
