// core/decide/channels.ts — channel health, hook gaps, degraded mode (DESIGN.md §4.3, §4.10 hookGap, rev 2 §10 A9).
// Health = the L0/L3 transport fact (`channel.health` observation) when it is down/off, else `degraded` while any
// core reason is set, else `up`. Reasons are added and cleared individually (a late SessionStart clears only its own).

import type { Observation, ChannelName } from '../../model/observation.js';
import { dom, patch, publish, recon, updRecon } from '../ctx.js';
import type { Ctx } from '../ctx.js';
import { expireAllClaims } from '../claims.js';
import { settleScreenCallStates } from './model-calls.js';

type Health = 'up' | 'degraded' | 'down' | 'off';

function computeHealth(ctx: Ctx, ch: ChannelName, reasons: readonly string[]): Health {
  const t = recon(ctx).transport[ch];
  if (t === 'down' || t === 'off') return t;
  if (t === 'degraded' || reasons.length > 0) return 'degraded';
  return 'up';
}

function store(ctx: Ctx, ch: ChannelName, reasons: string[], why: string, announce?: string): void {
  const cur = dom(ctx).channels[ch];
  const health = computeHealth(ctx, ch, reasons);
  const same = cur.health === health && cur.reasons.length === reasons.length && cur.reasons.every((r, i) => r === reasons[i]);
  if (same) return;
  patch(ctx, ['channels', ch], { health, reasons }, why);
  if (cur.health !== health) {
    const payload: { channel: ChannelName; health: Health; reason?: string } = { channel: ch, health };
    const reason = announce ?? reasons[reasons.length - 1];
    if (reason !== undefined) payload.reason = reason;
    publish(ctx, 'channel.health', payload);
  }
}

export function addReason(ctx: Ctx, ch: ChannelName, reason: string): void {
  const cur = dom(ctx).channels[ch];
  if (cur.reasons.includes(reason)) return;
  store(ctx, ch, [...cur.reasons, reason], `degrade:${reason}`, reason);
}

export function clearReason(ctx: Ctx, ch: ChannelName, pred: (r: string) => boolean, announce = 'restored'): void {
  const cur = dom(ctx).channels[ch];
  const kept = cur.reasons.filter((r) => !pred(r));
  if (kept.length === cur.reasons.length) return;
  store(ctx, ch, kept, `restore:${announce}`, announce);
}

/** `channel.health` observation: an L0/L3 transport fact (never auth, §2.4). */
export function onChannelHealth(ctx: Ctx, o: Extract<Observation, { kind: 'channel.health' }>): void {
  const { channel, health } = o.p;
  updRecon(ctx, (r) => ({ ...r, transport: { ...r.transport, [channel]: health } }));
  const cur = dom(ctx).channels[channel];
  store(ctx, channel, cur.reasons, `transport:${health}`, o.p.reason);
  if (channel === 'screen' && (health === 'down' || health === 'off')) {
    expireAllClaims(ctx);
    settleScreenCallStates(ctx); // a stall/retry banner's call state ends with its claim (§4.6)
  }
}

/** Any authenticated hook observation: clears `noSessionStart` degradation and the hook-gap reason of its event (§4.3#5). */
export function onHookSeen(ctx: Ctx, o: Observation): void {
  if (o.meta.source !== 'hook') return;
  const event = o.meta.origin?.kind === 'hook' ? o.meta.origin.event : undefined;
  if (o.meta.origin?.kind === 'hook' && event !== 'SessionStart' && event !== 'PermissionRequest') {
    const tr = o.meta.origin.transport;
    if (recon(ctx).hookTransport !== tr) updRecon(ctx, (r) => ({ ...r, hookTransport: tr }));
  }
  clearReason(
    ctx,
    'hooks',
    (r) =>
      r === 'noSessionStart' ||
      r.startsWith('noSessionStart:') ||
      (event !== undefined && (r === `hookGap:${event}` || r === `hookError:${event}`)),
  );
}

/** transcript `hookchannel.error` attachments: the endpoint failed for that event (K-20, P-REC-29). */
export function onHookChannelError(ctx: Ctx, o: Extract<Observation, { kind: 'hookchannel.error' }>): void {
  addReason(ctx, 'hooks', `hookError:${o.p.hookEvent}`);
}
