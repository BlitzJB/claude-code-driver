// model/json.ts stableStringify (DESIGN.md §2.1): canonical, total, deterministic.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { stableStringify, type JsonValue } from '../../../src/model/json.js';

describe('stableStringify', () => {
  it('sorts keys at every depth and emits no whitespace', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('equals JSON.stringify for JSON values up to key order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const s = stableStringify(v);
        expect(JSON.parse(s)).toEqual(JSON.parse(JSON.stringify(v)));
      }),
    );
  });

  it('is independent of key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (d) => {
        const reversed = Object.fromEntries(Object.entries(d).reverse()) as Record<string, JsonValue>;
        expect(stableStringify(reversed)).toBe(stableStringify(d));
      }),
    );
  });

  it('follows JSON.stringify for undefined, functions, symbols, non-finite numbers and toJSON', () => {
    expect(stableStringify({ a: undefined, b: () => 1, c: Symbol('s'), d: 1 })).toBe('{"d":1}');
    expect(stableStringify([undefined, () => 1, Symbol('s')])).toBe('[null,null,null]');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify([NaN, Infinity, -Infinity, -0])).toBe('[null,null,null,0]');
    expect(stableStringify(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(stableStringify({ toJSON: () => ({ y: 1, x: 2 }) })).toBe('{"x":2,"y":1}');
    expect(stableStringify('a"\n ')).toBe(JSON.stringify('a"\n '));
  });

  it('is total where JSON.stringify throws', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = cyc;
    expect(stableStringify(cyc)).toBe('{"a":1,"self":"[Circular]"}');
    expect(stableStringify({ n: 10n })).toBe('{"n":10}');
    const throwingGetter = Object.defineProperty({ ok: 1 }, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(stableStringify(throwingGetter)).toBe('{"ok":1}');
    expect(
      stableStringify({
        toJSON: () => {
          throw new Error('boom');
        },
        v: 1,
      }),
    ).toBe('{"v":1}');
  });

  it('a shared (non-cyclic) reference is written twice, not as [Circular]', () => {
    const shared = { x: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('serialises Map and Set by content', () => {
    expect(stableStringify(new Map<unknown, unknown>([['k', { b: 2, a: 1 }]]))).toBe('[["k",{"a":1,"b":2}]]');
    expect(stableStringify(new Set([1, 'x']))).toBe('[1,"x"]');
  });
});
