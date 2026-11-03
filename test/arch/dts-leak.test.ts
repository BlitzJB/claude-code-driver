// DESIGN.md §1.3 extra rules / §1.4 3b: no L0/L1/L2-internal type may appear in dist/api/index.d.ts (P-API-01).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, findLeaks, stripComments } from '../../scripts/api-report.mjs';
import { ROOT } from './helpers.js';

const ENTRY = join(ROOT, 'dist', 'api', 'index.d.ts');

describe('public .d.ts leak grep', () => {
  it.each([
    'export declare function f(x: TmuxPane): void;',
    'export type X = Fact<string>;',
    'readonly state: SessionState;',
    'export interface Y { e: DomainEvent }',
    'import type { SessionSpec } from "../model/spec.js";',
    'export type Z = Intent;',
    'export type C = Capture;',
    'export type O = ObservationInput;',
  ])('detects a leak in: %s', (src) => {
    expect(findLeaks(src).length).toBeGreaterThan(0);
  });

  it.each([
    'export interface SessionSnapshot { readonly key: SessionKey }',
    'captureScreen(): Promise<string>;',
    '/** maps SessionState onto the snapshot */ export type A = 1;',
    '// DomainEvent is mapped by map-events.ts',
    "export type I = 'Intent';",
  ])('ignores public names, comments and string literals: %s', (src) => {
    expect(findLeaks(src)).toEqual([]);
  });

  it('stripComments keeps string contents and removes both comment forms', () => {
    expect(stripComments("a /* x */ b // y\n'//not' `/*x*/`")).toBe("a  b \n'//not' `/*x*/`");
  });

  it.skipIf(!existsSync(ENTRY))('dist/api/index.d.ts and everything it references is leak-free', () => {
    expect(findLeaks(buildReport(ENTRY))).toEqual([]);
  });
});
