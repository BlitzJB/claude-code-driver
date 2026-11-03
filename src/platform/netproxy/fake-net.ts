// platform/netproxy/fake-net.ts — in-memory NetProxyFactory for kernel scenarios and unit tests (DESIGN.md §2.7 "Fakes", §8 WP-04).
// Same observable contract as client.ts (test/contract/net.contract.ts runs against both):
//   - start → port/pid; bindClaudePid/setFault resolve while up and reject after stop or death;
//   - records flow to `on` listeners until cancelled; death emits the reserved `{tunnelId:0, kind:'error', error:'sidecarDied'}`;
//   - `simulateTunnel` produces the record sequence the real sidecar would, honouring the current fault (api.anthropic.com only).

import type { FaultSpec } from '../../model/commands.js';
import type { Cancel, Clock, MonoMs, WallMs } from '../../model/time.js';
import type { NetProxy, NetProxyFactory, TunnelRecord } from '../ports.js';
import { NetSidecarError, SIDECAR_DIED, SIDECAR_TUNNEL_ID } from './client.js';

type StartOptions = Parameters<NetProxyFactory['start']>[0];
export type FakeRecordInput = Omit<TunnelRecord, 'at' | 'wallAt'> & { at?: MonoMs; wallAt?: WallMs };

export class FakeNetProxy implements NetProxy {
  readonly boundPids: number[] = [];
  readonly faults: (FaultSpec | null)[] = [];
  readonly emitted: TunnelRecord[] = [];
  fault: FaultSpec | null = null;
  state: 'up' | 'stopped' | 'down' = 'up';
  private readonly listeners = new Set<(r: TunnelRecord) => void>();
  private nextTunnel = 1;
  private tick = 0;

  constructor(
    readonly port: number,
    readonly pid: number,
    readonly options: StartOptions,
    private readonly clock: Clock | undefined,
  ) {}

  on(l: (r: TunnelRecord) => void): Cancel {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  bindClaudePid(pid: number): Promise<void> {
    const e = this.unavailable();
    if (e !== undefined) return Promise.reject(e);
    if (!Number.isInteger(pid) || pid < 2)
      return Promise.reject(new NetSidecarError('rejected', 'network sidecar refused the request: badPid'));
    this.boundPids.push(pid);
    return Promise.resolve();
  }

  setFault(spec: FaultSpec | null): Promise<void> {
    const e = this.unavailable();
    if (e !== undefined) return Promise.reject(e);
    this.fault = spec;
    this.faults.push(spec);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.state === 'up') this.state = 'stopped';
    return Promise.resolve();
  }

  /** Delivers a record to listeners (stamping at/wallAt from the clock when absent). No-op unless up. */
  emit(r: FakeRecordInput): TunnelRecord | undefined {
    if (this.state !== 'up') return undefined;
    const full = { ...r, at: r.at ?? this.monoNow(), wallAt: r.wallAt ?? this.wallNow() };
    this.deliver(full);
    return full;
  }

  /**
   * Emits what one CONNECT through the real sidecar produces: open, then refused (fault `refuse` on api.anthropic.com) or
   * established + one up + one down burst + close. Returns the tunnel id.
   */
  simulateTunnel(o: { host: string; port?: number; upBytes?: number; downBytes?: number; keepOpen?: boolean }): number {
    const tunnelId = this.nextTunnel++;
    const base = { tunnelId, token: 'A' as const, host: o.host, port: o.port ?? 443 };
    this.emit({ ...base, kind: 'open' });
    const faulted = o.host === 'api.anthropic.com' ? this.fault : null;
    if (faulted?.mode === 'refuse') {
      this.emit({ ...base, kind: 'refused', error: 'fault:refuse' });
      return tunnelId;
    }
    this.emit({ ...base, kind: 'established' });
    const up = o.upBytes ?? 517;
    this.emit({ ...base, kind: 'up', bytes: up, records: 1, lastRecordLen: up - 5 });
    if (faulted?.mode !== 'blackhole') {
      let down = o.downBytes ?? 1024;
      if (faulted?.mode === 'reset' || faulted?.mode === 'stall') down = Math.min(down, faulted.afterDownBytes);
      if (down > 0) this.emit({ ...base, kind: 'down', bytes: down, records: 1, lastRecordLen: 22 });
      if (faulted?.mode === 'reset') {
        this.emit({ ...base, kind: 'close', closeKind: 'rst', bytes: up + down, error: 'fault:reset' });
        return tunnelId;
      }
    }
    if (o.keepOpen !== true && faulted?.mode !== 'stall' && faulted?.mode !== 'blackhole')
      this.emit({ ...base, kind: 'close', closeKind: 'fin', bytes: up + (o.downBytes ?? 1024) });
    return tunnelId;
  }

  /** Simulates the sidecar process dying: one `sidecarDied` record, then every request rejects. */
  die(): void {
    if (this.state !== 'up') return;
    this.state = 'down';
    this.deliver({
      tunnelId: SIDECAR_TUNNEL_ID,
      at: this.monoNow(),
      wallAt: this.wallNow(),
      token: 'none',
      host: '',
      port: this.port,
      kind: 'error',
      error: SIDECAR_DIED,
    });
  }

  private deliver(r: TunnelRecord): void {
    this.emitted.push(r);
    for (const l of [...this.listeners]) {
      try {
        l(r);
      } catch {
        /* same as the real client: a listener bug never stops the stream */
      }
    }
  }

  private unavailable(): NetSidecarError | undefined {
    if (this.state === 'down') return new NetSidecarError('down', 'network sidecar is down');
    if (this.state === 'stopped') return new NetSidecarError('stopped', 'network sidecar stopped');
    return undefined;
  }

  private monoNow(): MonoMs {
    return this.clock?.now() ?? (++this.tick as MonoMs);
  }

  private wallNow(): WallMs {
    return this.clock?.wallNow() ?? ((1_700_000_000_000 + this.tick) as WallMs);
  }
}

export class FakeNetProxyFactory implements NetProxyFactory {
  readonly proxies: FakeNetProxy[] = [];
  readonly starts: StartOptions[] = [];
  /** When set, the next start() rejects with this error (then it is cleared). */
  failNextStart: Error | undefined;
  private nextPort = 40_001;
  private nextPid = 70_001;

  constructor(private readonly o: { clock?: Clock } = {}) {}

  start(opts: StartOptions): Promise<NetProxy> {
    this.starts.push(opts);
    const f = this.failNextStart;
    if (f !== undefined) {
      this.failNextStart = undefined;
      return Promise.reject(f);
    }
    const p = new FakeNetProxy(this.nextPort++, this.nextPid++, opts, this.o.clock);
    this.proxies.push(p);
    return Promise.resolve(p);
  }

  get last(): FakeNetProxy | undefined {
    return this.proxies[this.proxies.length - 1];
  }
}
