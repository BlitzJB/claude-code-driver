// model/ids.ts KEY_RE (DESIGN.md §2.1, D-05): session-scoped deterministic counters.
import { describe, expect, it } from 'vitest';
import { KEY_RE } from '../../../src/model/ids.js';

describe('KEY_RE', () => {
  it.each([
    ['turn', 't1'],
    ['tool', 'u40'],
    ['agent', 'a3'],
    ['perm', 'p5'],
    ['call', 'c9'],
    ['msg', 'm14'],
    ['job', 'j7'],
    ['gen', 'g2'],
  ] as const)('%s matches %s', (kind, key) => {
    expect(KEY_RE[kind].test(key)).toBe(true);
  });

  it('keys of one kind never match another kind', () => {
    const samples = { turn: 't1', tool: 'u1', agent: 'a1', perm: 'p1', call: 'c1', msg: 'm1', job: 'j1', gen: 'g1' } as const;
    for (const [k, re] of Object.entries(KEY_RE)) {
      for (const [k2, s] of Object.entries(samples)) expect(re.test(s)).toBe(k === k2);
    }
  });

  it.each(['t', 'T1', 't1a', ' t1', 'tx', 'g1.2', 'gen1'])('rejects %s', (s) => {
    expect(Object.values(KEY_RE).some((re) => re.test(s))).toBe(false);
  });
});
