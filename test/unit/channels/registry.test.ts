// channels/registry/normalize.ts (WP-08; DESIGN.md §2.4, §2.8, D-23): the single post-launch registry read → `registry`
// observation. Pitfalls: P-PRIOR-04 (corrupt/stale registry, `*.key` never read: lenient normalizer over the lenient L0
// reader), rev 2 §10 A5 (session ids never filtered), §2.8 L1 rules (never throw).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeRegistry } from '../../../src/channels/registry/normalize.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { createClaudeRegistryReader } from '../../../src/platform/registry/claude-registry.js';
import { FakeClaudeRegistry } from '../../../src/platform/registry/fake-registry.js';
import type { ClaudeRegistryRecord, EnvPort } from '../../../src/platform/ports.js';

const AT = 1234 as MonoMs;
const WALL = 1_793_000_000_000 as WallMs;
const SID = '59129e0d-0328-40d1-93bb-5312bc731f39';

describe('normalizeRegistry', () => {
  it('maps a full record to one registry observation; sessionId also goes to meta.claudeSessionId', () => {
    const rec: ClaudeRegistryRecord = {
      pid: 4242,
      sessionId: SID,
      version: '2.1.316',
      status: 'busy',
      waitingFor: 'permission',
      tmux: '/TMP/ccd-x,123,0',
      procStart: 'Tue Nov  3 06:00:00 2026',
    };
    expect(normalizeRegistry(rec, AT, WALL)).toEqual([
      {
        kind: 'registry',
        meta: { at: AT, wallAt: WALL, source: 'registry', claudeSessionId: SID },
        p: { pid: 4242, sessionId: SID, version: '2.1.316', status: 'busy', waitingFor: 'permission' },
      },
    ]);
  });

  it('does not forward tmux/procStart (pid identity is an L3 check)', () => {
    const [o] = normalizeRegistry({ pid: 1, tmux: 'x', procStart: 'y' }, AT, WALL);
    expect(o).toEqual({ kind: 'registry', meta: { at: AT, wallAt: WALL, source: 'registry' }, p: { pid: 1 } });
  });

  it('a missing record (not written yet / unreadable) yields nothing', () => {
    expect(normalizeRegistry(undefined, AT, WALL)).toEqual([]);
    expect(normalizeRegistry(null as unknown as undefined, AT, WALL)).toEqual([]);
  });

  it('never filters by session id (rev 2 §10 A5): a foreign id is still reported', () => {
    const [o] = normalizeRegistry({ pid: 9, sessionId: 'someone-else' }, AT, WALL);
    expect(o?.kind).toBe('registry');
    expect(o?.meta.claudeSessionId).toBe('someone-else');
  });

  it('invalid pids become one unknown observation, never a fact', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, 5_000_000, '12'] as unknown[]) {
      const out = normalizeRegistry({ pid } as unknown as ClaudeRegistryRecord, AT, WALL);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        kind: 'unknown',
        meta: { source: 'registry' },
        p: { channel: 'registry', raw: { reason: 'invalidPid' } },
      });
    }
    expect(normalizeRegistry('junk' as unknown as ClaudeRegistryRecord, AT, WALL)[0]).toMatchObject({
      kind: 'unknown',
      p: { raw: { reason: 'notAnObject' } },
    });
  });

  it('lenient fields: wrong types and empty strings dropped, controls removed, long values cut (P-PRIOR-04)', () => {
    const rec = { pid: 7, sessionId: 42, version: '', status: '  idle\u0000\u001b[31m ', waitingFor: 'w'.repeat(1000) };
    const [o] = normalizeRegistry(rec as unknown as ClaudeRegistryRecord, AT, WALL);
    expect(o).toMatchObject({ kind: 'registry', p: { pid: 7, status: 'idle' } });
    if (o?.kind !== 'registry') throw new Error('expected registry');
    expect(o.p.sessionId).toBeUndefined();
    expect(o.p.version).toBeUndefined();
    expect(o.p.waitingFor).toHaveLength(256);
    expect(o.meta.claudeSessionId).toBeUndefined();
  });

  it('removes whole escape sequences, bidi overrides and zero-width characters; all-control values are dropped', () => {
    const rec = {
      pid: 8,
      status: '\u001b]0;pwned\u0007busy\u001b[0m',
      waitingFor: 'per\u202emission\u200b',
      version: '\u009b2J2.1.316\u001bc',
      sessionId: '\u001b[31m\u001b[0m\u200f',
    };
    const [o] = normalizeRegistry(rec, AT, WALL);
    expect(o).toEqual({
      kind: 'registry',
      meta: { at: AT, wallAt: WALL, source: 'registry' },
      p: { pid: 8, status: 'busy', waitingFor: 'permission', version: '2.1.316' },
    });
  });

  it('non-finite times are clamped to 0 in meta', () => {
    const [o] = normalizeRegistry({ pid: 3 }, Number.NaN as MonoMs, Number.POSITIVE_INFINITY as WallMs);
    expect(o?.meta).toMatchObject({ at: 0, wallAt: 0 });
  });

  it('a throwing getter is contained', () => {
    const evil = {
      pid: 3,
      get sessionId(): string {
        throw new Error('boom');
      },
    };
    expect(normalizeRegistry(evil as unknown as ClaudeRegistryRecord, AT, WALL)).toEqual([
      {
        kind: 'unknown',
        meta: { at: AT, wallAt: WALL, source: 'registry' },
        p: { channel: 'registry', raw: { reason: 'normalizeError' } },
      },
    ]);
  });

  it('property: total over arbitrary input, at most one observation, payload fields are bounded strings', () => {
    expect.assertions(1);
    const check = (): void => {
      fc.assert(
        fc.property(fc.anything(), (x) => {
          const out = normalizeRegistry(x as ClaudeRegistryRecord | undefined, AT, WALL);
          if (out.length > 1) return false;
          const o = out[0];
          if (o === undefined) return x === undefined || x === null;
          if (o.kind === 'unknown') return o.meta.source === 'registry';
          if (o.kind !== 'registry') return false;
          for (const v of [o.p.sessionId, o.p.status, o.p.waitingFor, o.p.version]) {
            if (v !== undefined && (typeof v !== 'string' || v.length === 0 || v.length > 256)) return false;
          }
          return Number.isInteger(o.p.pid) && o.p.pid > 0;
        }),
        { numRuns: 500 },
      );
    };
    expect(check).not.toThrow();
  });
});

describe('contract: normalizer over the L0 registry readers (real file reader and the WP-05 fake)', () => {
  let home: string;
  let sessions: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ccd-wp08-reg-'));
    sessions = join(home, 'sessions');
    mkdirSync(sessions, { mode: 0o700 });
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const env: Pick<EnvPort, 'snapshot' | 'homeDir'> = { snapshot: () => ({}), homeDir: () => home };

  it('real reader: concatenated/torn file → first object; *.key never read; symlink not followed; absent → []', async () => {
    const reader = createClaudeRegistryReader({ env, sessionsDir: sessions, isAlive: () => true });
    writeFileSync(
      join(sessions, '101.json'),
      `{"pid":101,"sessionId":"${SID}","status":"idle","version":"2.1.316","extra":{"x":1}}{"pid":101,"sessionId":"later"`,
    );
    writeFileSync(join(sessions, '102.key'), 'sk-ant-SECRET');
    writeFileSync(join(sessions, '103.json'), '{"pid":999}'); // names another pid than its file → untrusted
    writeFileSync(join(home, 'target.json'), '{"pid":104}');
    symlinkSync(join(home, 'target.json'), join(sessions, '104.json'));

    expect(normalizeRegistry(await reader.read(101), AT, WALL)).toEqual([
      {
        kind: 'registry',
        meta: { at: AT, wallAt: WALL, source: 'registry', claudeSessionId: SID },
        p: { pid: 101, sessionId: SID, status: 'idle', version: '2.1.316' },
      },
    ]);
    expect(normalizeRegistry(await reader.read(102), AT, WALL)).toEqual([]);
    expect(normalizeRegistry(await reader.read(103), AT, WALL)).toEqual([]);
    expect(normalizeRegistry(await reader.read(104), AT, WALL)).toEqual([]);
    expect(normalizeRegistry(await reader.read(105), AT, WALL)).toEqual([]);
    const scanned = (await reader.scan()).flatMap((r) => normalizeRegistry(r, AT, WALL));
    expect(scanned.map((o) => o.kind === 'registry' && o.p.pid)).toEqual([101]);
  });

  it('fake reader: same observable mapping', async () => {
    const fake = new FakeClaudeRegistry();
    fake.put({ pid: 77, sessionId: SID, status: 'busy' });
    expect(normalizeRegistry(await fake.read(77), AT, WALL)).toEqual([
      {
        kind: 'registry',
        meta: { at: AT, wallAt: WALL, source: 'registry', claudeSessionId: SID },
        p: { pid: 77, sessionId: SID, status: 'busy' },
      },
    ]);
    expect(normalizeRegistry(await fake.read(78), AT, WALL)).toEqual([]);
  });
});
