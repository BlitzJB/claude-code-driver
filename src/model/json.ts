// model/json.ts — JSON value type and canonical stringify (DESIGN.md §2.1).
// stableStringify is one of the two pieces of logic allowed in model/ (the other is isCcdError).
// It is total: it never throws, so the pure core may call it from `step` (invariant I2).

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace.
 * Used for canonical tool_input equality and trace hashing.
 *
 * Semantics follow JSON.stringify where JSON.stringify is defined, and are total elsewhere:
 * - `toJSON()` is honoured (Date → ISO string); a throwing `toJSON` is treated as a missing one;
 * - `undefined`, functions and symbols are omitted from objects and become `null` in arrays and at the top level;
 * - non-finite numbers become `null`; `-0` becomes `0`; bigint becomes its decimal digits as a JSON number;
 * - a cycle is written as the string `"[Circular]"` (JSON.stringify would throw);
 * - `Map` and `Set` serialise as their entries (`[[k, v], …]`) and values (`[…]`) so canonical equality does not
 *   collapse them to `{}`.
 */
export function stableStringify(v: unknown): string {
  return write(v, new Set<object>()) ?? 'null';
}

function write(v: unknown, stack: Set<object>): string | undefined {
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return Number.isFinite(v) ? (Object.is(v, -0) ? '0' : String(v)) : 'null';
    case 'bigint':
      return v.toString(10);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
  }
  if (v === null) return 'null';
  const obj: object = v;
  if (stack.has(obj)) return '"[Circular]"';
  const viaToJson = callToJson(obj);
  if (viaToJson.used) {
    if (viaToJson.value === obj) return writeObject(obj, stack);
    return write(viaToJson.value, stack);
  }
  return writeObject(obj, stack);
}

function writeObject(obj: object, stack: Set<object>): string {
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj as unknown[]) parts.push(write(item, stack) ?? 'null');
      return `[${parts.join(',')}]`;
    }
    if (obj instanceof Map) {
      const parts: string[] = [];
      for (const [k, val] of obj as Map<unknown, unknown>) parts.push(`[${write(k, stack) ?? 'null'},${write(val, stack) ?? 'null'}]`);
      return `[${parts.join(',')}]`;
    }
    if (obj instanceof Set) {
      const parts: string[] = [];
      for (const item of obj as Set<unknown>) parts.push(write(item, stack) ?? 'null');
      return `[${parts.join(',')}]`;
    }
    const keys = Object.keys(obj).sort(compareCodeUnits);
    const parts: string[] = [];
    for (const k of keys) {
      const s = write(readProp(obj, k), stack);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(obj);
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readProp(obj: object, k: string): unknown {
  try {
    return (obj as Record<string, unknown>)[k];
  } catch {
    return undefined; // a throwing getter is treated as an absent property
  }
}

function callToJson(obj: object): { used: boolean; value?: unknown } {
  let fn: unknown;
  try {
    fn = (obj as { toJSON?: unknown }).toJSON;
  } catch {
    return { used: false };
  }
  if (typeof fn !== 'function') return { used: false };
  try {
    return { used: true, value: (fn as (this: object, key: string) => unknown).call(obj, '') };
  } catch {
    return { used: false };
  }
}
