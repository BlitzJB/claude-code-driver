// channels/network/* (WP-08; DESIGN.md §2.8, §3.10, NP §5.3, ICR 0004, ICR 0008): TunnelRecord stream → net.tunnel phases.
// Pitfalls: P-NET-18 (h2 ALPN flag), P-NET-19 (pooled tunnels: bursts, not opens), P-NET-20/27 (only token-A
// api.anthropic.com tunnels get burst phases), P-NET-23 (sidecar death → channel down, tunnels closed), P-NET-28 (bounded
// liveness refresh for the core's quiet/stalled deadlines), P-NET-29 (22-byte terminator = hint only), §2.8 L1 rules
// (never throw, no timers).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clipText,
  isModelEndpoint,
  isTunnelRecord,
  normalizeHost,
  offersH2,
  sniMismatch,
  timesOf,
} from '../../../src/channels/network/normalize.js';
import { createTunnelTracker, normalizeTunnelRecords, refreshIntervalMs } from '../../../src/channels/network/tunnel-tracker.js';
import type { Observation, ObservationInput } from '../../../src/model/observation.js';
import type { Clock, MonoMs, WallMs } from '../../../src/model/time.js';
import { FakeNetProxyFactory } from '../../../src/platform/netproxy/fake-net.js';
import type { TunnelRecord } from '../../../src/platform/ports.js';

type NetObs = Extract<Observation, { kind: 'net.tunnel' }>;
interface NetIn {
  kind: 'net.tunnel';
  meta: Omit<NetObs['meta'], 'seq'>;
  p: NetObs['p'];
}

const WALL0 = 1_793_000_000_000;
function rec(tunnelId: number, at: number, kind: TunnelRecord['kind'], o: Partial<TunnelRecord> = {}): TunnelRecord {
  return { tunnelId, at: at as MonoMs, wallAt: (WALL0 + at) as WallMs, token: 'A', host: 'api.anthropic.com', port: 443, kind, ...o };
}
const nets = (obs: ObservationInput[]): NetIn[] => obs.filter((o): o is NetIn => o.kind === 'net.tunnel');
const phases = (obs: ObservationInput[]): string[] => nets(obs).map((o) => o.p.phase);
function run(records: TunnelRecord[], quietMs = 15_000): ObservationInput[] {
  return normalizeTunnelRecords(records, { quietMs });
}

describe('normalize helpers', () => {
  it('normalizes hosts (case, trailing dot, IPv6 brackets, non-strings)', () => {
    expect(normalizeHost('API.Anthropic.COM.')).toBe('api.anthropic.com');
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost(undefined)).toBe('');
    expect(normalizeHost('x'.repeat(400))).toHaveLength(256);
  });

  it('classifies model endpoints: token A + api.anthropic.com + 443 only (P-NET-20/27)', () => {
    expect(isModelEndpoint('A', 'api.anthropic.com', 443)).toBe(true);
    expect(isModelEndpoint('A', 'API.ANTHROPIC.COM.', 443)).toBe(true);
    expect(isModelEndpoint('none', 'api.anthropic.com', 443)).toBe(false); // Bash children / unauthenticated
    expect(isModelEndpoint('bad', 'api.anthropic.com', 443)).toBe(false);
    expect(isModelEndpoint('A', 'platform.claude.com', 443)).toBe(false); // OAuth refresh
    expect(isModelEndpoint('A', 'http-intake.logs.us5.datadoghq.com', 443)).toBe(false);
    expect(isModelEndpoint('A', 'api.anthropic.com', 8443)).toBe(false);
  });

  it('detects SNI mismatch and h2 ALPN', () => {
    expect(sniMismatch('api.anthropic.com', 'api.anthropic.com')).toBe(false);
    expect(sniMismatch('api.anthropic.com', 'API.anthropic.com')).toBe(false);
    expect(sniMismatch('api.anthropic.com', undefined)).toBe(false);
    expect(sniMismatch('api.anthropic.com', 'evil.example')).toBe(true);
    expect(offersH2(['h2', 'http/1.1'])).toBe(true);
    expect(offersH2(['http/1.1'])).toBe(false);
    expect(offersH2(undefined)).toBe(false);
  });

  it('validates record shape and recovers time stamps', () => {
    expect(isTunnelRecord(rec(1, 1, 'open'))).toBe(true);
    expect(isTunnelRecord({ ...rec(1, 1, 'open'), kind: 'weird' })).toBe(false);
    expect(isTunnelRecord({ ...rec(1, 1, 'open'), tunnelId: -1 })).toBe(false);
    expect(isTunnelRecord({ ...rec(1, 1, 'open'), at: Number.NaN })).toBe(false);
    expect(isTunnelRecord(null)).toBe(false);
    expect(timesOf({ at: 5, wallAt: 6 })).toEqual({ at: 5, wallAt: 6 });
    expect(timesOf('x')).toEqual({ at: 0, wallAt: 0 });
    expect(clipText('')).toBeUndefined();
    expect(clipText('e'.repeat(300))).toHaveLength(256);
  });

  it('refresh interval is quietMs/15 clamped to [250, 1000]', () => {
    expect(refreshIntervalMs(15_000)).toBe(1000);
    expect(refreshIntervalMs(60_000)).toBe(1000);
    expect(refreshIntervalMs(6_000)).toBe(400);
    expect(refreshIntervalMs(1_000)).toBe(250);
    expect(refreshIntervalMs(Number.NaN)).toBe(1000);
    expect(refreshIntervalMs(-5)).toBe(1000);
  });
});

describe('tunnel tracker: model tunnel phase machine (NP §5.3)', () => {
  it('open → idle → sending → awaiting → receiving → idle(terminator) → close, cumulative bytes, per-tunnel seq', () => {
    const t = createTunnelTracker({ quietMs: 15_000 });
    const out: ObservationInput[] = [];
    out.push(...t.push(rec(1, 0, 'open')));
    out.push(...t.push(rec(1, 3, 'established')));
    out.push(...t.push(rec(1, 5, 'up', { bytes: 600, sni: 'api.anthropic.com', alpn: ['http/1.1'] })));
    out.push(...t.push(rec(1, 60, 'up', { bytes: 4000 })));
    out.push(...t.tick(400 as MonoMs, (WALL0 + 400) as WallMs));
    out.push(...t.push(rec(1, 900, 'down', { bytes: 300, lastRecordLen: 300 })));
    out.push(...t.push(rec(1, 1200, 'down', { bytes: 700, lastRecordLen: 22 })));
    out.push(...t.push(rec(1, 30_000, 'close', { closeKind: 'fin', bytes: 5600 })));
    expect(phases(out)).toEqual(['open', 'idle', 'sending', 'awaiting', 'receiving', 'idle', 'close']);
    const n = nets(out);
    expect(n.map((o) => o.meta.origin)).toEqual(n.map((_, i) => ({ kind: 'network', tunnelId: 1, tunnelSeq: i + 1 })));
    expect(n.every((o) => o.meta.source === 'network')).toBe(true);
    const awaiting = n[3]!;
    expect(awaiting.p.bytesUp).toBe(4600);
    expect(awaiting.meta.at).toBe(400);
    expect(awaiting.meta.wallAt).toBe(WALL0 + 400);
    const end = n[5]!;
    expect(end.p).toMatchObject({ endedBy: 'terminator', bytesDown: 1000, lastDownAtMono: 1200 });
    expect(n[6]!.p).toMatchObject({ phase: 'close', endedBy: 'close', bytesUp: 4600, bytesDown: 1000 });
    expect(n[6]!.p.error).toBeUndefined();
    expect(n[6]!.p.alpnH2).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it('pooled tunnel: a second request is a new burst, not a new open (P-NET-19)', () => {
    const out = run([
      rec(1, 0, 'open'),
      rec(1, 2, 'established'),
      rec(1, 4, 'up', { bytes: 500 }),
      rec(1, 800, 'down', { bytes: 900, lastRecordLen: 22 }),
      rec(1, 5000, 'up', { bytes: 700 }),
      rec(1, 6000, 'down', { bytes: 100, lastRecordLen: 100 }),
    ]);
    expect(phases(out)).toEqual(['open', 'idle', 'sending', 'receiving', 'idle', 'sending', 'receiving']);
    expect(nets(out).filter((o) => o.p.phase === 'open')).toHaveLength(1);
  });

  it('an up burst while receiving ends the response without endedBy, then starts sending', () => {
    const out = run([rec(1, 0, 'up', { bytes: 10 }), rec(1, 500, 'down', { bytes: 10 }), rec(1, 2000, 'up', { bytes: 10 })]);
    expect(phases(out)).toEqual(['sending', 'receiving', 'idle', 'sending']);
    expect(nets(out)[2]!.p.endedBy).toBeUndefined();
  });

  it('down bytes after a terminator re-enter receiving (terminator is only a hint, P-NET-29)', () => {
    const out = run([
      rec(1, 0, 'up', { bytes: 10 }),
      rec(1, 100, 'down', { bytes: 22, lastRecordLen: 22 }),
      rec(1, 200, 'down', { bytes: 300, lastRecordLen: 300 }),
    ]);
    expect(phases(out)).toEqual(['sending', 'receiving', 'idle', 'receiving']);
  });

  it('a whole response in one coalesced record yields receiving then idle(terminator)', () => {
    const out = run([rec(1, 0, 'up', { bytes: 10 }), rec(1, 300, 'down', { bytes: 2000, records: 4, lastRecordLen: 22 })]);
    expect(phases(out)).toEqual(['sending', 'receiving', 'idle']);
  });

  it('awaiting is inferred from another tunnel record time (deterministic without tick)', () => {
    const out = run([
      rec(1, 0, 'up', { bytes: 10 }),
      rec(2, 100, 'open', { host: 'example.com', token: 'none' }),
      rec(2, 300, 'close', { host: 'example.com', token: 'none', closeKind: 'fin' }),
    ]);
    expect(out.map((o) => (o.kind === 'net.tunnel' ? `${o.p.tunnelId}:${o.p.phase}` : o.kind))).toEqual([
      '1:sending',
      '2:open',
      '1:awaiting',
      '2:close',
    ]);
  });

  it('a slow upload on the same tunnel does not flip to awaiting; an up after awaiting goes back to sending', () => {
    const t = createTunnelTracker({ quietMs: 15_000, sendSettleMs: 250 });
    const out: ObservationInput[] = [];
    out.push(...t.push(rec(1, 0, 'up', { bytes: 10 })));
    out.push(...t.push(rec(1, 1000, 'up', { bytes: 10 }))); // same tunnel: no self-settle
    out.push(...t.tick(1100 as MonoMs, (WALL0 + 1100) as WallMs)); // 100 ms < 250: still sending
    out.push(...t.tick(1300 as MonoMs, (WALL0 + 1300) as WallMs));
    out.push(...t.push(rec(1, 1400, 'up', { bytes: 10 })));
    expect(phases(out)).toEqual(['sending', 'awaiting', 'sending']);
  });

  it('receiving refresh is bounded: at most one per refreshMs, and a resume after a gap is reported (P-NET-28)', () => {
    const records: TunnelRecord[] = [rec(1, 0, 'up', { bytes: 10 })];
    for (let at = 100; at <= 10_000; at += 100) records.push(rec(1, at, 'down', { bytes: 50, lastRecordLen: 50 }));
    records.push(rec(1, 30_000, 'down', { bytes: 50, lastRecordLen: 50 }));
    const n = nets(run(records));
    const recv = n.filter((o) => o.p.phase === 'receiving');
    expect(recv[0]!.meta.at).toBe(100);
    for (let i = 1; i < recv.length; i++) expect(recv[i]!.meta.at - recv[i - 1]!.meta.at).toBeGreaterThanOrEqual(1000);
    expect(recv.length).toBeLessThanOrEqual(12); // 100 down records over 10 s → ≤ 11 + the resume
    expect(recv.at(-1)!.p.lastDownAtMono).toBe(30_000);
    // staleness of lastDownAtMono before the gap is < refreshMs
    const beforeGap = recv.at(-2)!;
    expect(10_000 - (beforeGap.p.lastDownAtMono ?? 0)).toBeLessThan(1000);
  });

  it('close kinds: rst and error map to endedBy rst with an error text', () => {
    const out = run([
      rec(1, 0, 'up', { bytes: 1 }),
      rec(1, 1, 'close', { closeKind: 'rst', error: 'fault:reset' }),
      rec(2, 2, 'up', { bytes: 1 }),
      rec(2, 3, 'close', { closeKind: 'error' }),
      rec(3, 4, 'close', {}),
    ]);
    const closes = nets(out).filter((o) => o.p.phase === 'close');
    expect(closes.map((o) => [o.p.tunnelId, o.p.endedBy, o.p.error])).toEqual([
      [1, 'rst', 'fault:reset'],
      [2, 'rst', 'error'],
      [3, 'close', undefined],
    ]);
  });

  it('error then close: both reported; refused deletes the tunnel', () => {
    const t = createTunnelTracker({ quietMs: 15_000 });
    const out = [
      ...t.push(rec(1, 0, 'open')),
      ...t.push(rec(1, 1, 'error', { error: 'ECONNRESET' })),
      ...t.push(rec(1, 2, 'close', { closeKind: 'error' })),
      ...t.push(rec(2, 3, 'open')),
      ...t.push(rec(2, 4, 'refused', { error: 'connectTimeout' })),
    ];
    expect(nets(out).map((o) => [o.p.tunnelId, o.p.phase, o.p.error])).toEqual([
      [1, 'open', undefined],
      [1, 'error', 'ECONNRESET'],
      [1, 'close', 'error'],
      [2, 'open', undefined],
      [2, 'refused', 'connectTimeout'],
    ]);
    expect(t.size).toBe(0);
  });

  it('sidecar order error → meter flush → close: flushed bytes are counted but drive no burst phase', () => {
    // sidecar.ts: onSocketError emits `error`; finish() on socket close flushes pending meter bytes, then emits `close`.
    const t = createTunnelTracker({ quietMs: 15_000 });
    const out = [
      ...t.push(rec(1, 0, 'up', { bytes: 100 })),
      ...t.push(rec(1, 400, 'down', { bytes: 50, lastRecordLen: 50 })),
      ...t.push(rec(1, 500, 'error', { error: 'upstream:ECONNRESET' })),
      ...t.push(rec(1, 510, 'down', { bytes: 30, lastRecordLen: 22 })),
      ...t.push(rec(1, 511, 'up', { bytes: 7 })),
      ...t.push(rec(1, 520, 'close', { closeKind: 'rst', error: 'upstream:ECONNRESET' })),
    ];
    expect(phases(out)).toEqual(['sending', 'receiving', 'error', 'close']);
    expect(nets(out).at(-1)!.p).toMatchObject({ endedBy: 'rst', bytesUp: 107, bytesDown: 80, lastDownAtMono: 510 });
    expect(t.size).toBe(0);
  });

  it('an errored tunnel that was sending is never settled into awaiting', () => {
    const t = createTunnelTracker({ quietMs: 15_000 });
    const out = [
      ...t.push(rec(1, 0, 'up', { bytes: 100 })),
      ...t.push(rec(1, 10, 'error', { error: 'client:EPIPE' })),
      ...t.tick(5000 as MonoMs, (WALL0 + 5000) as WallMs),
      ...t.push(rec(2, 6000, 'open')),
    ];
    expect(out.map((o) => (o.kind === 'net.tunnel' ? `${o.p.tunnelId}:${o.p.phase}` : o.kind))).toEqual(['1:sending', '1:error', '2:open']);
  });

  it('records for an unseen tunnel are tracked lazily (tracker started mid-stream)', () => {
    const out = run([rec(7, 10, 'down', { bytes: 5 }), rec(7, 20, 'down', { bytes: 5, lastRecordLen: 22 })]);
    expect(phases(out)).toEqual(['receiving', 'idle']);
    expect(nets(out)[1]!.p.bytesDown).toBe(10);
  });
});

describe('tunnel tracker: non-model tunnels (P-NET-20, P-NET-26, P-NET-27)', () => {
  it('telemetry hosts, token none/bad and platform.claude.com yield lifecycle phases only', () => {
    const hosts: Partial<TunnelRecord>[] = [
      { host: 'http-intake.logs.us5.datadoghq.com' },
      { host: 'platform.claude.com' },
      { host: 'api.anthropic.com', token: 'none' },
      { host: 'api.anthropic.com', token: 'bad' },
      { host: 'registry.npmjs.org', token: 'none' },
    ];
    for (const h of hosts) {
      const out = run([
        rec(1, 0, 'open', h),
        rec(1, 1, 'established', h),
        rec(1, 2, 'up', { ...h, bytes: 100 }),
        rec(1, 500, 'down', { ...h, bytes: 100, lastRecordLen: 22 }),
        rec(1, 900, 'close', { ...h, closeKind: 'fin' }),
      ]);
      expect(phases(out)).toEqual(['open', 'close']);
      const close = nets(out)[1]!.p;
      expect(close).toMatchObject({ bytesUp: 100, bytesDown: 100, host: normalizeHost(h.host) });
    }
  });

  it('an unknown token value is treated as bad, never as A', () => {
    const out = run([rec(1, 0, 'open', { token: 'Z' as TunnelRecord['token'] }), rec(1, 1, 'up', { bytes: 1 })]);
    expect(nets(out).map((o) => [o.p.phase, o.p.token])).toEqual([['open', 'bad']]);
  });

  it('SNI mismatch demotes a model tunnel and is reported once as unknown', () => {
    const out = run([
      rec(1, 0, 'open'),
      rec(1, 1, 'up', { bytes: 10, sni: 'evil.example' }),
      rec(1, 2, 'up', { bytes: 10, sni: 'evil.example' }),
      rec(1, 300, 'down', { bytes: 10 }),
      rec(1, 400, 'close', { closeKind: 'fin' }),
    ]);
    expect(out.map((o) => o.kind)).toEqual(['net.tunnel', 'unknown', 'net.tunnel']);
    const u = out[1]!;
    expect(u.kind === 'unknown' && u.p).toEqual({
      channel: 'network',
      raw: { reason: 'sniMismatch', tunnelId: 1, host: 'api.anthropic.com', sni: 'evil.example', demoted: true },
    });
    expect(u.meta.origin).toEqual({ kind: 'network', tunnelId: 1 });
  });
});

describe('tunnel tracker: ALPN h2 (P-NET-18)', () => {
  it('flags every phase after an h2 offer', () => {
    const out = run([
      rec(1, 0, 'open'),
      rec(1, 1, 'up', { bytes: 10, sni: 'api.anthropic.com', alpn: ['h2', 'http/1.1'] }),
      rec(1, 400, 'down', { bytes: 10 }),
      rec(1, 500, 'close', { closeKind: 'fin' }),
    ]);
    const n = nets(out);
    expect(n.map((o) => [o.p.phase, o.p.alpnH2])).toEqual([
      ['open', undefined],
      ['sending', true],
      ['receiving', true],
      ['close', true],
    ]);
  });
});

describe('tunnel tracker: sidecar death (P-NET-23, ICR 0004 item 1)', () => {
  it('maps the reserved record to channel.health down and closes live tunnels with rst', () => {
    const t = createTunnelTracker({ quietMs: 15_000 });
    t.push(rec(2, 0, 'up', { bytes: 10 }));
    t.push(rec(1, 1, 'open', { host: 'example.com', token: 'none' }));
    t.push(rec(3, 2, 'open'));
    t.push(rec(3, 3, 'error', { error: 'EPIPE' })); // errored but its close never came: still needs one
    const out = t.push({
      tunnelId: 0,
      at: 50 as MonoMs,
      wallAt: (WALL0 + 50) as WallMs,
      token: 'none',
      host: '',
      port: 40001,
      kind: 'error',
      error: 'sidecarDied',
    });
    expect(out[0]).toEqual({
      kind: 'channel.health',
      meta: { at: 50, wallAt: WALL0 + 50, source: 'network' },
      p: { channel: 'network', health: 'down', reason: 'sidecarDied' },
    });
    expect(nets(out).map((o) => [o.p.tunnelId, o.p.phase, o.p.endedBy, o.p.error])).toEqual([
      [1, 'close', 'rst', 'sidecarDied'],
      [2, 'close', 'rst', 'sidecarDied'],
      [3, 'close', 'rst', 'sidecarDied'],
    ]);
    expect(t.size).toBe(0);
    expect(phases(out)).not.toContain('awaiting'); // never infers a stall-like phase from the death
  });

  it('other tunnelId 0 records are unknown, not a tunnel', () => {
    const out = run([rec(0, 1, 'up', { bytes: 3 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('unknown');
  });
});

describe('tunnel tracker: robustness (§2.8 L1 rules)', () => {
  it('malformed records become one unknown observation and never throw', () => {
    const t = createTunnelTracker({ quietMs: 15_000 });
    for (const bad of [
      null,
      42,
      'x',
      {},
      { tunnelId: 1, at: 1, wallAt: 1, kind: 'nope' },
      { tunnelId: 1.5, at: 1, wallAt: 1, kind: 'up' },
    ]) {
      const out = t.push(bad as unknown as TunnelRecord);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: 'unknown', p: { channel: 'network', raw: { reason: 'malformedRecord' } } });
    }
  });

  it('a throwing getter on a record is contained', () => {
    const t = createTunnelTracker({ quietMs: 15_000 });
    const evil = {
      ...rec(1, 1, 'up'),
      get bytes(): number {
        throw new Error('boom');
      },
    };
    const out = t.push(evil);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'unknown', p: { raw: { reason: 'trackerError' } } });
  });

  it('negative / NaN byte counts count as 0; options with bad values fall back to defaults', () => {
    const t = createTunnelTracker({ quietMs: Number.NaN, sendSettleMs: -1, maxTunnels: 0 });
    const out = [...t.push(rec(1, 0, 'up', { bytes: -5 })), ...t.push(rec(1, 1, 'down', { bytes: Number.NaN }))];
    expect(nets(out).map((o) => [o.p.bytesUp, o.p.bytesDown])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(t.tick(Number.NaN as MonoMs, 0 as WallMs)).toEqual([]);
  });

  it('bounds tracked tunnels, evicting ended ones first, then the least recently active', () => {
    const t = createTunnelTracker({ quietMs: 15_000, maxTunnels: 3 });
    t.push(rec(1, 0, 'open'));
    t.push(rec(2, 1, 'open'));
    t.push(rec(2, 2, 'error', { error: 'x' }));
    t.push(rec(3, 3, 'open'));
    t.push(rec(4, 4, 'open')); // evicts 2 (ended)
    expect(t.size).toBe(3);
    t.push(rec(5, 5, 'open')); // evicts 1 (oldest)
    expect(t.size).toBe(3);
    const out = t.push(rec(1, 6, 'down', { bytes: 1 })); // 1 is re-created lazily
    expect(nets(out)[0]!.p).toMatchObject({ tunnelId: 1, phase: 'receiving', bytesDown: 1 });
  });

  const kindArb = fc.constantFrom<TunnelRecord['kind']>('open', 'established', 'up', 'down', 'close', 'error', 'refused');
  const recordArb = fc.record({
    tunnelId: fc.integer({ min: 0, max: 4 }),
    dt: fc.integer({ min: 0, max: 3000 }),
    kind: kindArb,
    token: fc.constantFrom<TunnelRecord['token']>('A', 'A', 'none', 'bad'),
    host: fc.constantFrom('api.anthropic.com', 'platform.claude.com', 'example.com'),
    bytes: fc.integer({ min: -10, max: 100_000 }),
    lastRecordLen: fc.constantFrom(22, 50, 600),
    alpnH2: fc.boolean(),
    died: fc.integer({ min: 0, max: 40 }),
  });

  it('property: never throws, seq strictly increases per tunnel, burst phases only on model tunnels, bounded refresh', () => {
    expect.assertions(1);
    const check = (): void => {
      fc.assert(
        fc.property(fc.array(recordArb, { maxLength: 120 }), (xs) => {
          let at = 0;
          const records: TunnelRecord[] = xs.map((x) => {
            at += x.dt;
            if (x.died === 0) return rec(0, at, 'error', { token: 'none', host: '', error: 'sidecarDied' });
            return rec(x.tunnelId, at, x.kind, {
              token: x.token,
              host: x.host,
              bytes: x.bytes,
              lastRecordLen: x.lastRecordLen,
              ...(x.alpnH2 ? { alpn: ['h2'] } : {}),
            });
          });
          const out = run(records);
          const lastSeq = new Map<number, number>();
          const lastRecvAt = new Map<number, number>();
          const errored = new Set<number>();
          for (const o of out) {
            if (o.kind === 'channel.health') {
              lastSeq.clear();
              lastRecvAt.clear();
              errored.clear();
              continue;
            }
            if (o.kind !== 'net.tunnel') continue;
            const origin = o.meta.origin;
            if (origin?.kind !== 'network' || origin.tunnelSeq === undefined) return false;
            const prev = lastSeq.get(origin.tunnelId) ?? 0;
            // a closed/refused tunnel id may be reused by a lazily re-created state: seq restarts at 1
            if (!(origin.tunnelSeq > prev || origin.tunnelSeq === 1)) return false;
            lastSeq.set(origin.tunnelId, origin.tunnelSeq);
            const burst = ['sending', 'awaiting', 'receiving', 'idle'].includes(o.p.phase);
            if (burst && !(o.p.token === 'A' && o.p.host === 'api.anthropic.com')) return false;
            if (burst && errored.has(o.p.tunnelId)) return false; // no burst phase between error and close
            if (o.p.phase === 'error') errored.add(o.p.tunnelId);
            if (o.p.bytesUp < 0 || o.p.bytesDown < 0) return false;
            if (o.p.phase === 'receiving') {
              const pr = lastRecvAt.get(o.p.tunnelId);
              lastRecvAt.set(o.p.tunnelId, o.meta.at);
              // consecutive receiving refreshes without an intervening phase change are ≥ refreshMs apart
              if (pr !== undefined && o.meta.at - pr < 1000 && pr !== -1) return false;
            } else {
              lastRecvAt.set(o.p.tunnelId, -1);
            }
            if (o.p.phase === 'close' || o.p.phase === 'refused') {
              lastSeq.set(o.p.tunnelId, 0);
              errored.delete(o.p.tunnelId);
            }
          }
          return true;
        }),
        { numRuns: 300 },
      );
    };
    expect(check).not.toThrow();
  });
});

describe('contract: tracker over the WP-04 fake sidecar stream (same record contract as the real sidecar)', () => {
  function fakeClock(): Clock & { advance(ms: number): void } {
    let mono = 0;
    return {
      now: () => mono as MonoMs,
      wallNow: () => (WALL0 + mono) as WallMs,
      setTimer: () => () => undefined,
      sleep: () => Promise.resolve(),
      advance(ms: number) {
        mono += ms;
      },
    };
  }
  const startOpts = {
    tokenA: 'TOKEN',
    controlSocketPath: '/TMP/net.sock',
    controlToken: 'CTL',
    logPath: '/TMP/net.log',
    allowPrivate: false,
    allowPorts: [443],
    denyPorts: [],
  };

  it('a normal model tunnel, a refused fault, a reset fault and sidecar death', async () => {
    const clock = fakeClock();
    const factory = new FakeNetProxyFactory({ clock });
    await factory.start(startOpts);
    const proxy = factory.proxies[0]!;
    const tracker = createTunnelTracker({ quietMs: 15_000 });
    const out: ObservationInput[] = [];
    proxy.on((r) => {
      clock.advance(1);
      out.push(...tracker.push(r));
    });
    proxy.simulateTunnel({ host: 'api.anthropic.com' });
    expect(phases(out)).toEqual(['open', 'idle', 'sending', 'receiving', 'idle', 'close']);
    expect(nets(out).at(-2)!.p.endedBy).toBe('terminator');

    out.length = 0;
    await proxy.setFault({ mode: 'refuse' });
    proxy.simulateTunnel({ host: 'api.anthropic.com' });
    expect(nets(out).map((o) => [o.p.phase, o.p.error])).toEqual([
      ['open', undefined],
      ['refused', 'fault:refuse'],
    ]);

    out.length = 0;
    await proxy.setFault({ mode: 'reset', afterDownBytes: 100 });
    proxy.simulateTunnel({ host: 'api.anthropic.com' });
    expect(nets(out).at(-1)!.p).toMatchObject({ phase: 'close', endedBy: 'rst', error: 'fault:reset' });

    out.length = 0;
    await proxy.setFault(null);
    proxy.simulateTunnel({ host: 'example.com' });
    expect(phases(out)).toEqual(['open', 'close']); // non-model: lifecycle only

    out.length = 0;
    proxy.simulateTunnel({ host: 'api.anthropic.com', keepOpen: true });
    proxy.die();
    expect(out.filter((o) => o.kind === 'channel.health')).toHaveLength(1);
    expect(nets(out).at(-1)!.p).toMatchObject({ phase: 'close', endedBy: 'rst', error: 'sidecarDied' });
    expect(tracker.size).toBe(0);
  });
});
