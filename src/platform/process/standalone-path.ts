// platform/process/standalone-path.ts — locate a node:*-only standalone script next to the module that spawns it.
// Published layout: dist/platform/<x>/standalone/<name>.js. In the source tree (tests run from src/ on Node ≥ 22.18, which
// strips types natively) the sibling is <name>.ts. The `.js` file always wins when both exist.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolveStandaloneScript(moduleUrl: string, relNoExt: string): string {
  const candidates = ['.js', '.ts'].map((ext) => fileURLToPath(new URL(`${relNoExt}${ext}`, moduleUrl)));
  return candidates.find((p) => existsSync(p)) ?? candidates[0] ?? relNoExt;
}
