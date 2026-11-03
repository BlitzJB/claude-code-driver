// core/reconcile/net-correlate.ts — api-request ↔ token-A tunnel bursts and network liveness (DESIGN.md §3.10, §4.5.7;
// NP §5.3–§5.4). Telemetry bursts with no api-request stay non-model. A silent proxy never yields `stalled` (NP §4.7).

import type { ModelCallKey } from '../../model/ids.js';
import type { Observation } from '../../model/observation.js';
import type { ModelCall } from '../../model/state.js';
import type { MonoMs, WallMs } from '../../model/time.js';
import { arm, captureNow, cfg, disarm, dom, nowOf, publish, recon, updRecon } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { isCallOpen } from '../lattice.js';
import { callRec, putCall, setCallState } from '../decide/entities.js';

const MODEL_HOST = 'api.anthropic.com';
const JOIN_WINDOW_MS = 250;

/** Call start (wall) per call key, for the ±250 ms join; kept on the call's first requestRef entry via recon tunnels. */
function txWallOf(c: ModelCall, txWalls: Readonly<Record<string, number>>): number | undefined {
  return txWalls[c.key];
}

function boundCalls(ctx: Ctx): Set<string> {
  const s = new Set<string>();
  for (const t of Object.values(recon(ctx).tunnels)) if (t.callKey !== undefined) s.add(t.callKey);
  return s;
}

/** Bind a model call to the api.anthropic.com tunnel whose `sending` began within ±250 ms of its api-request (FIFO). */
export function correlateRequest(ctx: Ctx, callKey: ModelCallKey, txWall: WallMs | undefined): void {
  if (!cfg(ctx).channels.network || txWall === undefined) return;
  updRecon(ctx, (r) => ({ ...r, txWalls: { ...r.txWalls, [callKey]: txWall } }));
  const cands = Object.entries(recon(ctx).tunnels)
    .filter(
      ([, t]) =>
        t.host === MODEL_HOST &&
        t.callKey === undefined &&
        t.sendingAtWall !== undefined &&
        Math.abs(t.sendingAtWall - txWall) <= JOIN_WINDOW_MS,
    )
    .sort((a, b) => (a[1].sendingAtWall ?? 0) - (b[1].sendingAtWall ?? 0));
  const first = cands[0];
  if (first === undefined) return;
  const id = Number(first[0]);
  updRecon(ctx, (r) => ({ ...r, tunnels: { ...r.tunnels, [id]: { ...first[1], callKey } } }));
  const c = callRec(ctx, callKey);
  if (c !== undefined) putCall(ctx, { ...c, tunnelId: id }, 'tunnel bound');
}

function armLiveness(ctx: Ctx, k: ModelCallKey, from: MonoMs): void {
  const t = cfg(ctx).timeouts;
  arm(ctx, 'quiet', k, from + t.quietMs);
  arm(ctx, 'stall', k, from + t.stallMs);
}

export function onNetTunnel(ctx: Ctx, o: Extract<Observation, { kind: 'net.tunnel' }>): void {
  if (!cfg(ctx).channels.network) return;
  const p = o.p;
  const prev = recon(ctx).tunnels[p.tunnelId];
  const isModel = p.host === MODEL_HOST && p.token === 'A';
  const next: { phase: string; callKey?: ModelCallKey; lastDownAt?: MonoMs; sendingAtWall?: WallMs; host?: string } = {
    ...(prev ?? {}),
    phase: p.phase,
    host: p.host,
  };
  if (p.phase === 'sending' && prev?.phase !== 'sending') {
    next.sendingAtWall = o.meta.wallAt;
    delete next.callKey; // a new request on a reused tunnel
  }
  if (p.lastDownAtMono !== undefined) next.lastDownAt = p.lastDownAtMono;
  updRecon(ctx, (r) => ({ ...r, tunnels: { ...r.tunnels, [p.tunnelId]: next } }));
  if (!isModel) return;
  if (p.phase === 'error' || p.phase === 'refused') captureNow(ctx, `net:${p.phase}`); // §4.11 immediate capture
  if (p.phase === 'sending' && next.callKey === undefined) {
    // the api-request may already be known (transcript lagging less than the tunnel, rare): join the earliest open call
    const txWalls = recon(ctx).txWalls;
    const bound = boundCalls(ctx);
    const open = Object.values(dom(ctx).calls)
      .filter((c) => isCallOpen(c.state.value) && !bound.has(c.key))
      .filter((c) => {
        const w = txWallOf(c, txWalls);
        return w !== undefined && Math.abs(w - o.meta.wallAt) <= JOIN_WINDOW_MS;
      })
      .sort((a, b) => a.startedAt - b.startedAt);
    const c = open[0];
    if (c !== undefined) {
      updRecon(ctx, (r) => ({ ...r, tunnels: { ...r.tunnels, [p.tunnelId]: { ...next, callKey: c.key } } }));
      putCall(ctx, { ...c, tunnelId: p.tunnelId }, 'tunnel bound');
    }
    return;
  }
  const k = recon(ctx).tunnels[p.tunnelId]?.callKey;
  const c = callRec(ctx, k);
  if (c === undefined || k === undefined || !isCallOpen(c.state.value)) return;
  switch (p.phase) {
    case 'awaiting': {
      setCallState(ctx, k, 'waiting', { patch: { bytesDown: p.bytesDown } });
      const t = cfg(ctx).timeouts;
      arm(ctx, 'stall', k, nowOf(ctx) + Math.min(t.stallMs, t.quietMs + 5000));
      return;
    }
    case 'receiving': {
      const at = p.lastDownAtMono ?? o.meta.at;
      const wasStreaming = c.state.value === 'streaming';
      setCallState(ctx, k, 'streaming', { patch: { lastDownAt: at, bytesDown: p.bytesDown } });
      armLiveness(ctx, k, at);
      if (!wasStreaming)
        publish(ctx, 'modelCall.progress', { callKey: k, phase: 'streaming', bytesDown: p.bytesDown }, { turnKey: c.turn });
      return;
    }
    case 'idle':
    case 'close':
    case 'error':
    case 'refused':
      disarm(ctx, 'quiet', k);
      disarm(ctx, 'stall', k);
      return;
    case 'open':
    case 'sending':
      return;
  }
}

/** `quiet` / `stall` deadlines of a call (§4.10). Stall verdicts are suppressed during hostResumeGrace. */
export function onLivenessDeadline(ctx: Ctx, kind: 'quiet' | 'stall', ref: string): void {
  const k = ref as ModelCallKey;
  const c = callRec(ctx, k);
  if (c === undefined || !isCallOpen(c.state.value)) return;
  const since = c.lastDownAt === undefined ? undefined : nowOf(ctx) - c.lastDownAt;
  if (kind === 'quiet') {
    const pl: { callKey: ModelCallKey; phase: 'quiet'; sinceLastByteMs?: number } = { callKey: k, phase: 'quiet' };
    if (since !== undefined) pl.sinceLastByteMs = since;
    publish(ctx, 'modelCall.progress', pl, { turnKey: c.turn });
    captureNow(ctx, 'net:byteStall'); // §4.11: byte stall > 15 s (quietMs) → immediate capture for retry/stall banners
    return;
  }
  const resumed = recon(ctx).lastHostResumeAt;
  const graceEnd = resumed === undefined ? undefined : resumed + cfg(ctx).timeouts.hostResumeGraceMs;
  if (graceEnd !== undefined && nowOf(ctx) < graceEnd) {
    arm(ctx, 'stall', k, graceEnd);
    return;
  }
  setCallState(ctx, k, 'stalled');
  const pl: { callKey: ModelCallKey; phase: 'stalled'; sinceLastByteMs?: number } = { callKey: k, phase: 'stalled' };
  if (since !== undefined) pl.sinceLastByteMs = since;
  publish(ctx, 'modelCall.progress', pl, { turnKey: c.turn });
}
