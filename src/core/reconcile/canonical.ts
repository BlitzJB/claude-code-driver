// core/reconcile/canonical.ts — canonical JSON equality for tool_input (DESIGN.md §4.5.1, RC §5.1).

import { stableStringify } from '../../model/json.js';

/** Sorted-key, whitespace-free JSON equality (`stableStringify` is total, so this never throws). */
export function canonicalEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

export function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function strField(v: unknown, k: string): string | undefined {
  if (!isRecord(v)) return undefined;
  const x = v[k];
  return typeof x === 'string' ? x : undefined;
}
