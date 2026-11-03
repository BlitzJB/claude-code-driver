// channels/network/tunnel-tracker.ts — per-tunnel phase machine, TunnelRecord stream → `net.tunnel` observations
// (DESIGN.md §2.8, §3.10; NP §5.3 step 1; ICR 0004 record cadence; ICR 0008).
//
//   (open) → idle ──up──▶ sending ──(no up for sendSettleMs)──▶ awaiting ──down──▶ receiving ──22-byte record──▶ idle
//                            ▲                                                       │
//                            └──────────────────────── up (next request) ────────────┘  (emits idle, then sending)
//
// Pure and total: no I/O, no timers, never throws. Time comes only from the records (`r.at`) or from `tick(at)`, which L3
// may call on its poll cadence; `push` also settles other tunnels against the incoming record's time, so a replay of the
// record stream alone is deterministic.
//
// Rules and the pitfalls they implement:
// - Only token-A tunnels to api.anthropic.com:443 with a matching SNI get burst phases (P-NET-20, P-NET-27; NP §3.2, §5.3).
//   Others yield open/close/error/refused only, so Bash children and telemetry are counted but never drive status.
// - A tunnel is not a request (P-NET-19): pooled tunnels go back to `idle` and start new bursts; a new up burst while
//   `receiving` ends the previous response (`idle` without `endedBy`) before the new `sending`.
// - The 22-byte down record ends a response only as a hint (`endedBy:'terminator'`, P-NET-29); more down bytes after it
//   re-enter `receiving`. The core keeps all network-derived ends `confirmed:false` until the transcript agrees.
// - ALPN `h2` offered → `alpnH2:true` on every later phase of that tunnel (P-NET-18): the core must not assume one request
//   per tunnel and keeps the correlation unconfirmed.
// - `receiving` is refreshed at most every `refreshMs` (≤ 1 s, derived from `quietMs`) so `lastDownAtMono` is never more than
//   that stale when the core measures quiet/stalled (P-NET-28: thresholds 15 s / 25 s stay core deadlines), and the
//   observation rate stays bounded (≤ 1/s per receiving tunnel) whatever the sidecar cadence.
// - Sidecar death (reserved tunnelId 0 record, ICR 0004 item 1) → `channel.health{network, down, sidecarDied}` and a
//   `close{endedBy:'rst'}` for every live tunnel (P-NET-23): the channel is down, the agent is never "stalled" because the
//   proxy went silent (NP §4.7).
// - Bytes are cumulative per tunnel; `tunnelSeq` (origin) orders the phases of one tunnel (§2.4 ordering keys).

import type { ObservationInput } from '../../model/observation.js';
import type { MonoMs, WallMs } from '../../model/time.js';
import type { TunnelRecord } from '../../platform/ports.js';
import {
  byteCount,
  clipText,
  isModelEndpoint,
  isSidecarDied,
  isTunnelRecord,
  isTunnelToken,
  normalizeHost,
  offersH2,
  sidecarDiedObservation,
  SIDECAR_DIED,
  SIDECAR_TUNNEL_ID,
  sniMismatch,
  TERMINATOR_RECORD_LEN,
  timesOf,
  tunnelObservation,
  unknownNetworkObservation,
} from './normalize.js';
import type { NetPhase, NetTunnelPayload } from './normalize.js';

export interface TunnelTracker {
  push(r: TunnelRecord): ObservationInput[];
  /** Advance time without a record (L3 poll cadence): settles `sending` tunnels into `awaiting`. Optional for correctness. */
  tick(at: MonoMs, wallAt: WallMs): ObservationInput[];
  /** Live tunnels currently tracked (diagnostics, tests). */
  readonly size: number;
}

export interface TunnelTrackerOptions {
  quietMs: number;
  /** No up record for this long ends the request upload (`sending → awaiting`). Default 250 ms (sidecar coalesces ≤ 10/s). */
  sendSettleMs?: number;
  /** Bound on tracked tunnels; ended ones are evicted first, then the least recently active. Default 1024. */
  maxTunnels?: number;
}

const DEFAULT_QUIET_MS = 15_000;
const DEFAULT_SEND_SETTLE_MS = 250;
const DEFAULT_MAX_TUNNELS = 1024;

interface TunnelState {
  readonly id: number;
  readonly host: string;
  readonly token: TunnelRecord['token'];
  model: boolean;
  h2: boolean;
  sniSeen: boolean;
  phase: NetPhase | 'none';
  bytesUp: number;
  bytesDown: number;
  lastUpAt?: MonoMs;
  lastDownAt?: MonoMs;
  lastEmitAt?: MonoMs;
  lastAt: MonoMs;
  seq: number;
  ended: boolean;
}

/** `refreshMs` = quietMs / 15, clamped to [250, 1000] ms: 1 s for the default 15 s quiet threshold. */
export function refreshIntervalMs(quietMs: number): number {
  const q = Number.isFinite(quietMs) && quietMs > 0 ? quietMs : DEFAULT_QUIET_MS;
  return Math.min(1000, Math.max(250, Math.floor(q / 15)));
}

function positive(n: number | undefined, dflt: number): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : dflt;
}

export function createTunnelTracker(o: TunnelTrackerOptions): TunnelTracker {
  const refreshMs = refreshIntervalMs(o.quietMs);
  const settleMs = positive(o.sendSettleMs, DEFAULT_SEND_SETTLE_MS);
  const maxTunnels = Math.floor(positive(o.maxTunnels, DEFAULT_MAX_TUNNELS));
  const tunnels = new Map<number, TunnelState>();

  const emit = (
    out: ObservationInput[],
    t: TunnelState,
    phase: NetPhase,
    at: MonoMs,
    wallAt: WallMs,
    extra: { endedBy?: NonNullable<NetTunnelPayload['endedBy']>; error?: string } = {},
  ): void => {
    t.seq += 1;
    t.lastEmitAt = at;
    if (phase !== 'close' && phase !== 'error' && phase !== 'refused') t.phase = phase;
    const p: NetTunnelPayload = { tunnelId: t.id, host: t.host, token: t.token, phase, bytesUp: t.bytesUp, bytesDown: t.bytesDown };
    if (t.lastDownAt !== undefined) p.lastDownAtMono = t.lastDownAt;
    if (extra.endedBy !== undefined) p.endedBy = extra.endedBy;
    if (extra.error !== undefined) p.error = extra.error;
    if (t.h2) p.alpnH2 = true;
    out.push(tunnelObservation(at, wallAt, t.seq, p));
  };

  /** Model tunnels whose upload went quiet become `awaiting`; `exceptId` is the tunnel of the record being handled. */
  const settle = (out: ObservationInput[], at: MonoMs, wallAt: WallMs, exceptId?: number): void => {
    for (const t of tunnels.values()) {
      if (t.id === exceptId || !t.model || t.ended || t.phase !== 'sending' || t.lastUpAt === undefined) continue;
      if (at - t.lastUpAt >= settleMs) emit(out, t, 'awaiting', at, wallAt);
    }
  };

  const evictIfFull = (): void => {
    if (tunnels.size < maxTunnels) return;
    let victim: TunnelState | undefined;
    for (const t of tunnels.values()) {
      if (t.ended) {
        victim = t;
        break;
      }
      if (victim === undefined || t.lastAt < victim.lastAt) victim = t;
    }
    if (victim !== undefined) tunnels.delete(victim.id);
  };

  const stateFor = (r: TunnelRecord): TunnelState => {
    const existing = tunnels.get(r.tunnelId);
    if (existing !== undefined) return existing;
    evictIfFull();
    const token = isTunnelToken(r.token) ? r.token : 'bad';
    const t: TunnelState = {
      id: r.tunnelId,
      host: normalizeHost(r.host),
      token,
      model: isModelEndpoint(token, r.host, r.port),
      h2: false,
      sniSeen: false,
      phase: 'none',
      bytesUp: 0,
      bytesDown: 0,
      lastAt: r.at,
      seq: 0,
      ended: false,
    };
    tunnels.set(t.id, t);
    return t;
  };

  /** SNI/ALPN arrive on the first `up` record (ICR 0004); they may in principle ride on any record, so check each. */
  const inspectHello = (out: ObservationInput[], t: TunnelState, r: TunnelRecord): void => {
    if (offersH2(r.alpn)) t.h2 = true;
    if (t.sniSeen || typeof r.sni !== 'string' || r.sni.length === 0) return;
    t.sniSeen = true;
    if (sniMismatch(t.host, r.sni)) {
      const wasModel = t.model;
      t.model = false;
      out.push(
        unknownNetworkObservation(
          r.at,
          r.wallAt,
          { reason: 'sniMismatch', tunnelId: t.id, host: t.host, sni: normalizeHost(r.sni), demoted: wasModel },
          t.id,
        ),
      );
    }
  };

  const onUp = (out: ObservationInput[], t: TunnelState, r: TunnelRecord): void => {
    t.bytesUp += byteCount(r.bytes);
    t.lastUpAt = r.at;
    if (!t.model || t.ended) return; // after a socket error only bytes are counted: the final meter flush is not a new burst
    switch (t.phase) {
      case 'sending':
        return; // the same upload continues (coalesced chunks)
      case 'receiving':
        emit(out, t, 'idle', r.at, r.wallAt); // HTTP/1.1: a new request means the previous response is over (no endedBy)
        emit(out, t, 'sending', r.at, r.wallAt);
        return;
      case 'none':
      case 'open':
      case 'idle':
      case 'awaiting': // the settle guess was early: the upload is still going (or, with h2, a new stream)
      case 'close':
      case 'error':
      case 'refused':
        emit(out, t, 'sending', r.at, r.wallAt);
        return;
    }
  };

  const onDown = (out: ObservationInput[], t: TunnelState, r: TunnelRecord): void => {
    t.bytesDown += byteCount(r.bytes);
    t.lastDownAt = r.at;
    if (!t.model || t.ended) return;
    const terminator = r.lastRecordLen === TERMINATOR_RECORD_LEN;
    if (t.phase !== 'receiving') {
      emit(out, t, 'receiving', r.at, r.wallAt);
    } else if (!terminator && (t.lastEmitAt === undefined || r.at - t.lastEmitAt >= refreshMs)) {
      emit(out, t, 'receiving', r.at, r.wallAt); // liveness refresh: carries the new lastDownAtMono / bytesDown
    }
    if (terminator) emit(out, t, 'idle', r.at, r.wallAt, { endedBy: 'terminator' });
  };

  const onClose = (out: ObservationInput[], t: TunnelState, r: TunnelRecord): void => {
    const extra: { endedBy: NonNullable<NetTunnelPayload['endedBy']>; error?: string } = {
      endedBy: r.closeKind === 'rst' || r.closeKind === 'error' ? 'rst' : 'close',
    };
    const err = clipText(r.error) ?? (r.closeKind === 'error' ? 'error' : undefined);
    if (err !== undefined) extra.error = err;
    emit(out, t, 'close', r.at, r.wallAt, extra);
    tunnels.delete(t.id);
  };

  const onSidecarDied = (out: ObservationInput[], at: MonoMs, wallAt: WallMs): void => {
    out.push(sidecarDiedObservation(at, wallAt));
    // Every tracked tunnel is still unclosed (close/refused delete it). An `error` is not terminal on the sidecar stream
    // (its `close` follows on socket teardown), so an errored tunnel also needs this close or the core would keep it open.
    for (const t of [...tunnels.values()].sort((a, b) => a.id - b.id)) {
      emit(out, t, 'close', at, wallAt, { endedBy: 'rst', error: SIDECAR_DIED });
    }
    tunnels.clear();
  };

  const handle = (r: TunnelRecord): ObservationInput[] => {
    const out: ObservationInput[] = [];
    if (isSidecarDied(r)) {
      onSidecarDied(out, r.at, r.wallAt);
      return out;
    }
    settle(out, r.at, r.wallAt, r.tunnelId);
    if (r.tunnelId === SIDECAR_TUNNEL_ID) {
      out.push(unknownNetworkObservation(r.at, r.wallAt, { reason: 'reservedTunnelId', record: r }, r.tunnelId));
      return out;
    }
    const t = stateFor(r);
    t.lastAt = r.at;
    inspectHello(out, t, r);
    switch (r.kind) {
      case 'open':
        emit(out, t, 'open', r.at, r.wallAt);
        return out;
      case 'established':
        if (t.model && !t.ended && (t.phase === 'none' || t.phase === 'open')) emit(out, t, 'idle', r.at, r.wallAt);
        return out;
      case 'up':
        onUp(out, t, r);
        return out;
      case 'down':
        onDown(out, t, r);
        return out;
      case 'close':
        onClose(out, t, r);
        return out;
      case 'error': {
        // Not terminal: the sidecar emits `error` on a socket error, then flushes pending meter bytes and emits `close` when
        // the socket is torn down. From here on the tunnel gets no burst phases (no stale sending/receiving/awaiting).
        t.ended = true;
        emit(out, t, 'error', r.at, r.wallAt, { error: clipText(r.error) ?? 'error' });
        return out;
      }
      case 'refused':
        emit(out, t, 'refused', r.at, r.wallAt, { error: clipText(r.error) ?? 'refused' });
        tunnels.delete(t.id);
        return out;
    }
  };

  return {
    push(r: TunnelRecord): ObservationInput[] {
      try {
        if (!isTunnelRecord(r)) {
          const { at, wallAt } = timesOf(r);
          return [unknownNetworkObservation(at, wallAt, { reason: 'malformedRecord', record: r as unknown })];
        }
        return handle(r);
      } catch (e) {
        // L1 never throws (§2.8). Unreachable by construction; kept as the last line of defence.
        const { at, wallAt } = timesOf(r);
        return [unknownNetworkObservation(at, wallAt, { reason: 'trackerError', detail: String(e) })];
      }
    },
    tick(at: MonoMs, wallAt: WallMs): ObservationInput[] {
      const out: ObservationInput[] = [];
      if (Number.isFinite(at)) settle(out, at, wallAt);
      return out;
    },
    get size() {
      return tunnels.size;
    },
  };
}

/** Run a fresh tracker over a recorded stream (replay of `raw` network records, §6.6). */
export function normalizeTunnelRecords(records: Iterable<TunnelRecord>, o: TunnelTrackerOptions): ObservationInput[] {
  const tracker = createTunnelTracker(o);
  const out: ObservationInput[] = [];
  for (const r of records) out.push(...tracker.push(r));
  return out;
}
