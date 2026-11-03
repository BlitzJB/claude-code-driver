// channels/network/normalize.ts — TunnelRecord → ObservationInput building blocks (DESIGN.md §2.4, §2.8, §3.10; NP §3, §5).
// Pure and total: never throws, never does I/O or timers. The stateful per-tunnel phase machine lives in tunnel-tracker.ts
// and uses these helpers to classify a tunnel and to build observations.
//
// Classification (NP §3.2, §5.3 step 1; P-NET-20/27): only tunnels that carry token A (Claude's own credential) to
// `api.anthropic.com:443`, and whose TLS SNI (when seen) names the same host, are *model-relevant*: only they get burst
// phases (sending/awaiting/receiving/idle). Every other tunnel (Bash children, MCP, telemetry hosts, token 'none'/'bad')
// still produces its lifecycle facts (open/close/error/refused) so the core can count it as non-model traffic.
// An SNI that disagrees with the CONNECT host marks a client that does not follow the rules: it is demoted to non-model
// and reported once as an `unknown` network observation (NP §3.2).
// The reserved sidecar record (ICR 0004 item 1: tunnelId 0, kind 'error', error 'sidecarDied') is not a tunnel: it maps to
// `channel.health{network, down, sidecarDied}` (P-NET-23; §3.10 "Failure").

import type { ObsMeta, Observation, ObservationInput } from '../../model/observation.js';
import type { MonoMs, WallMs } from '../../model/time.js';
import type { TunnelRecord } from '../../platform/ports.js';

/** The only host whose token-A tunnels carry model calls (NP §3.1). */
const MODEL_HOST = 'api.anthropic.com';
const MODEL_PORT = 443;
/** Mirrors `platform/netproxy/client.ts` SIDECAR_TUNNEL_ID / SIDECAR_DIED (ICR 0004 item 1); channels may not import values from platform. */
export const SIDECAR_TUNNEL_ID = 0;
export const SIDECAR_DIED = 'sidecarDied';
/** HTTP/1.1 chunked terminator as one TLS 1.3 record (NP §2): a hint only, never confirmed (P-NET-29). */
export const TERMINATOR_RECORD_LEN = 22;
/** Longest host / error string carried into an observation (defensive bound; records come from our own sidecar). */
const MAX_TEXT = 256;

export type NetTunnelPayload = Extract<Observation, { kind: 'net.tunnel' }>['p'];
export type NetPhase = NetTunnelPayload['phase'];
type Meta = Omit<ObsMeta, 'seq'>;

/** Lower-case, strip one trailing dot and IPv6 brackets: `API.Anthropic.com.` → `api.anthropic.com`. */
export function normalizeHost(h: unknown): string {
  if (typeof h !== 'string') return '';
  let s = h.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

export function clipText(s: unknown): string | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/** Token A to api.anthropic.com:443 (the SNI check is applied separately once the ClientHello was seen). */
export function isModelEndpoint(token: unknown, host: unknown, port: unknown): boolean {
  return token === 'A' && normalizeHost(host) === MODEL_HOST && (port === undefined || port === MODEL_PORT);
}

/** True when the SNI is present and names another host than the CONNECT target. */
export function sniMismatch(host: unknown, sni: unknown): boolean {
  if (typeof sni !== 'string' || sni.length === 0) return false;
  return normalizeHost(sni) !== normalizeHost(host);
}

/** The client offered HTTP/2 (P-NET-18): one tunnel may then carry several requests at once. */
export function offersH2(alpn: unknown): boolean {
  return Array.isArray(alpn) && alpn.some((a) => a === 'h2');
}

export function isSidecarDied(r: Pick<TunnelRecord, 'tunnelId' | 'kind' | 'error'>): boolean {
  return r.tunnelId === SIDECAR_TUNNEL_ID && r.kind === 'error' && r.error === SIDECAR_DIED;
}

/** Non-negative finite byte count; anything else counts as 0. */
export function byteCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function isTunnelToken(t: unknown): t is TunnelRecord['token'] {
  return t === 'A' || t === 'none' || t === 'bad';
}

const RECORD_KINDS: ReadonlySet<string> = new Set(['open', 'established', 'up', 'down', 'close', 'error', 'refused']);

/** Shape check for a record arriving from the sidecar stream (or a replayed trace): never trust it blindly. */
export function isTunnelRecord(r: unknown): r is TunnelRecord {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o['tunnelId'] === 'number' &&
    Number.isInteger(o['tunnelId']) &&
    o['tunnelId'] >= 0 &&
    typeof o['at'] === 'number' &&
    Number.isFinite(o['at']) &&
    typeof o['wallAt'] === 'number' &&
    Number.isFinite(o['wallAt']) &&
    typeof o['kind'] === 'string' &&
    RECORD_KINDS.has(o['kind'])
  );
}

function networkMeta(at: MonoMs, wallAt: WallMs, tunnelId: number, tunnelSeq?: number): Meta {
  const origin: NonNullable<ObsMeta['origin']> =
    tunnelSeq === undefined ? { kind: 'network', tunnelId } : { kind: 'network', tunnelId, tunnelSeq };
  return { at, wallAt, source: 'network', origin };
}

/** One `net.tunnel` observation; `tunnelSeq` orders phases within a tunnel (§2.4 ordering keys, ICR 0008). */
export function tunnelObservation(at: MonoMs, wallAt: WallMs, tunnelSeq: number, p: NetTunnelPayload): ObservationInput {
  return { kind: 'net.tunnel', meta: networkMeta(at, wallAt, p.tunnelId, tunnelSeq), p };
}

/** `channel.health{network, down, sidecarDied}` for the reserved sidecar record (ICR 0004 item 1). */
export function sidecarDiedObservation(at: MonoMs, wallAt: WallMs): ObservationInput {
  return {
    kind: 'channel.health',
    meta: { at, wallAt, source: 'network' },
    p: { channel: 'network', health: 'down', reason: SIDECAR_DIED },
  };
}

/** A record the tracker cannot use (bad shape, or a rule-breaking SNI). Counted by the core as channel noise, never as a phase. */
export function unknownNetworkObservation(at: MonoMs, wallAt: WallMs, raw: unknown, tunnelId?: number): ObservationInput {
  const meta: Meta =
    tunnelId === undefined ? { at, wallAt, source: 'network' } : { at, wallAt, source: 'network', origin: { kind: 'network', tunnelId } };
  return { kind: 'unknown', meta, p: { channel: 'network', raw } };
}

/** Best-effort time stamps of a malformed record (0 when absent): the observation still needs a meta. */
export function timesOf(r: unknown): { at: MonoMs; wallAt: WallMs } {
  const o = typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {};
  const at = typeof o['at'] === 'number' && Number.isFinite(o['at']) ? o['at'] : 0;
  const wallAt = typeof o['wallAt'] === 'number' && Number.isFinite(o['wallAt']) ? o['wallAt'] : 0;
  return { at: at as MonoMs, wallAt: wallAt as WallMs };
}
