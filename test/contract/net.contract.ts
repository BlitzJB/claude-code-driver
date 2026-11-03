// Shared NetProxy contract (DESIGN.md §2.7.7, §3.10, §6.4 "network"): run by net.contract.test.ts against both the fake
// (src/platform/netproxy/fake-net.ts) and the real client + sidecar process. Anything the core or L3 relies on is asserted here.
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/model/time.js';
import type { NetProxy, NetProxyFactory, TunnelRecord } from '../../src/platform/ports.js';

export type StartOptions = Parameters<NetProxyFactory['start']>[0];

export interface NetContractContext {
  factory: NetProxyFactory;
  clock: Clock;
  startOptions: StartOptions;
  /** Opens one CONNECT tunnel through the proxy to `host:443` and closes it again; 'established' when bytes made it through. */
  driveTunnel(proxy: NetProxy, host: string): Promise<'established' | 'refused'>;
  /** Kills the sidecar behind the client's back (SIGKILL for the real one). */
  killSidecar(proxy: NetProxy): Promise<void>;
  /** A live pid to bind (a child process for the real harness). */
  claudePid: number;
  dispose(): Promise<void>;
}

export interface NetContractHarness {
  name: string;
  create(): Promise<NetContractContext>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

async function withProxy(
  h: NetContractHarness,
  fn: (ctx: NetContractContext, p: NetProxy, recs: TunnelRecord[]) => Promise<void>,
): Promise<void> {
  const ctx = await h.create();
  let p: NetProxy | undefined;
  try {
    p = await ctx.factory.start(ctx.startOptions);
    const recs: TunnelRecord[] = [];
    p.on((r) => recs.push(r));
    await fn(ctx, p, recs);
  } finally {
    await p?.stop();
    await ctx.dispose();
  }
}

const closesOf = (recs: TunnelRecord[], id: number): TunnelRecord[] => recs.filter((r) => r.tunnelId === id && r.kind === 'close');

export function netProxyContract(h: NetContractHarness): void {
  describe(`NetProxy contract: ${h.name}`, () => {
    it('start → a loopback port and a pid; bindClaudePid resolves', async () => {
      await withProxy(h, async (ctx, p) => {
        expect(Number.isInteger(p.port) && p.port > 0 && p.port < 65536).toBe(true);
        expect(Number.isInteger(p.pid) && p.pid > 1).toBe(true);
        await expect(p.bindClaudePid(ctx.claudePid)).resolves.toBeUndefined();
      });
    });

    it('a tunnel produces open → established → up → down → close for one tunnelId, on our clock', async () => {
      await withProxy(h, async (ctx, p, recs) => {
        expect(await ctx.driveTunnel(p, 'api.anthropic.com')).toBe('established');
        await waitFor(() => recs.some((r) => r.kind === 'close'));
        const id = recs[0]?.tunnelId ?? -1;
        expect(id).toBeGreaterThan(0);
        const mine = recs.filter((r) => r.tunnelId === id);
        const kinds = mine.map((r) => r.kind).filter((k, i, a) => a.indexOf(k) === i);
        expect(kinds).toEqual(['open', 'established', 'up', 'down', 'close']);
        expect(mine[0]).toMatchObject({ token: 'A', host: 'api.anthropic.com', port: 443 });
        expect(mine.filter((r) => r.kind === 'up').reduce((a, r) => a + (r.bytes ?? 0), 0)).toBeGreaterThan(0);
        expect(mine.filter((r) => r.kind === 'down').reduce((a, r) => a + (r.bytes ?? 0), 0)).toBeGreaterThan(0);
        expect(closesOf(recs, id)).toHaveLength(1);
        expect(closesOf(recs, id)[0]?.closeKind).toBe('fin');
        const now = ctx.clock.now();
        const wall = ctx.clock.wallNow();
        for (const r of mine) {
          expect(Math.abs(now - r.at)).toBeLessThan(10_000);
          expect(Math.abs(wall - r.wallAt)).toBeLessThan(10_000);
        }
        const ats = mine.map((r) => r.at);
        expect([...ats].sort((a, b) => a - b)).toEqual(ats);
      });
    });

    it('setFault(refuse) refuses api.anthropic.com only; setFault(null) restores it', async () => {
      await withProxy(h, async (ctx, p, recs) => {
        await p.setFault({ mode: 'refuse' });
        expect(await ctx.driveTunnel(p, 'api.anthropic.com')).toBe('refused');
        expect(await ctx.driveTunnel(p, 'example.com')).toBe('established');
        await waitFor(() => recs.some((r) => r.kind === 'refused'));
        expect(recs.find((r) => r.kind === 'refused')).toMatchObject({ host: 'api.anthropic.com', error: 'fault:refuse' });
        await p.setFault(null);
        expect(await ctx.driveTunnel(p, 'api.anthropic.com')).toBe('established');
      });
    });

    it('every FaultSpec mode is accepted', async () => {
      await withProxy(h, async (_ctx, p) => {
        for (const spec of [
          { mode: 'blackhole' },
          { mode: 'reset', afterDownBytes: 10 },
          { mode: 'stall', afterDownBytes: 0 },
          { mode: 'slow', bytesPerSec: 1000 },
          null,
        ] as const)
          await expect(p.setFault(spec)).resolves.toBeUndefined();
      });
    });

    it('a cancelled listener receives nothing more', async () => {
      await withProxy(h, async (ctx, p, recs) => {
        const mine: TunnelRecord[] = [];
        const cancel = p.on((r) => mine.push(r));
        cancel();
        expect(await ctx.driveTunnel(p, 'example.com')).toBe('established');
        await waitFor(() => recs.some((r) => r.kind === 'close'));
        expect(mine).toEqual([]);
      });
    });

    it('a throwing listener does not stop the stream for others', async () => {
      await withProxy(h, async (ctx, p, recs) => {
        p.on(() => {
          throw new Error('listener bug');
        });
        expect(await ctx.driveTunnel(p, 'example.com')).toBe('established');
        await waitFor(() => recs.some((r) => r.kind === 'close'));
        expect(recs.length).toBeGreaterThanOrEqual(5);
      });
    });

    it('sidecar death → one reserved sidecarDied record (tunnelId 0); requests reject; stop still resolves (P-NET-23)', async () => {
      await withProxy(h, async (ctx, p, recs) => {
        await ctx.killSidecar(p);
        await waitFor(() => recs.some((r) => r.error === 'sidecarDied'));
        const died = recs.filter((r) => r.error === 'sidecarDied');
        expect(died).toHaveLength(1);
        expect(died[0]).toMatchObject({ tunnelId: 0, kind: 'error', port: p.port });
        await expect(p.setFault({ mode: 'refuse' })).rejects.toMatchObject({ name: 'NetSidecarError', reason: 'down' });
        await expect(p.bindClaudePid(ctx.claudePid)).rejects.toMatchObject({ reason: 'down' });
        await expect(p.stop()).resolves.toBeUndefined();
      });
    });

    it('stop is idempotent, emits no sidecarDied, and later requests reject with stopped', async () => {
      await withProxy(h, async (ctx, p, recs) => {
        await p.stop();
        await p.stop();
        await sleep(50);
        expect(recs.filter((r) => r.error === 'sidecarDied')).toEqual([]);
        await expect(p.setFault(null)).rejects.toMatchObject({ reason: 'stopped' });
        await expect(p.bindClaudePid(ctx.claudePid)).rejects.toMatchObject({ reason: 'stopped' });
      });
    });
  });
}
