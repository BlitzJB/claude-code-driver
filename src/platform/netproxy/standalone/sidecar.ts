// platform/netproxy/standalone/sidecar.ts — the network channel's CONNECT pass-through proxy (DESIGN.md §3.10, D-21, NP §1–§4,
// SEC §6). Runs as its own detached process: `node sidecar.js <sessionDir>/net.json`, spawned through
// `sh -c 'ulimit -n 8192 2>/dev/null; exec "$0" "$@"'` (P-NET-16). Imports node:* only (§1.4 3c); timers are adapter timer A-8.
//
// What it does, and nothing else (NP §4.3 "keep the sidecar dumb"):
//   - CONNECT pass-through on 127.0.0.1:<ephemeral port> with a per-session Basic token (P-SEC-16), never TLS termination (P-NET-17);
//   - absolute-form / any non-CONNECT request → 405 (P-SEC-44, rev 2); post-DNS target policy (P-SEC-17);
//   - byte + TLS-record metering in separate `data` listeners (P-NET-13), SNI/ALPN from the ClientHello (P-NET-18);
//   - faults on token-A tunnels to api.anthropic.com only (P-NET-15/21/27);
//   - control + event stream over a 0700-dir unix socket with a control token (P-SEC-17), never over the proxy port;
//   - lifetime bound to Claude's pid: polls kill(pid,0) every 1 s, exits 5 s after Claude (P-NET-23).
// It never restarts itself and is never restarted on the same port (rev 2; P-NET-24/25 handled by the owner killing the pane).

import { timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { chmodSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------------------------------------------
// Wire types (duplicated from platform/ports.ts and model/commands.ts on purpose: standalone files may import node:* only).

export type SidecarFault =
  | { mode: 'refuse' }
  | { mode: 'blackhole' }
  | { mode: 'reset'; afterDownBytes: number }
  | { mode: 'stall'; afterDownBytes: number }
  | { mode: 'slow'; bytesPerSec: number };

export type TokenClass = 'A' | 'none' | 'bad';
export type WireKind = 'open' | 'established' | 'up' | 'down' | 'close' | 'error' | 'refused';

/** One event on the control stream. `mono` is the sidecar's performance.now(); the client rebases it onto its own clock. */
export interface WireRecord {
  tunnelId: number;
  mono: number;
  wallAt: number;
  token: TokenClass;
  host: string;
  port: number;
  kind: WireKind;
  sni?: string;
  alpn?: string[];
  bytes?: number;
  records?: number;
  lastRecordLen?: number;
  closeKind?: 'fin' | 'rst' | 'error';
  error?: string;
}

export interface SidecarConfig {
  v: 1;
  tokenA: string;
  controlSocketPath: string;
  controlToken: string;
  allowPrivate: boolean;
  allowPorts: number[];
  denyPorts: number[];
  /** The library process that spawned us; before a Claude pid is bound, its death ends the sidecar. */
  ownerPid: number;
  maxTunnels: number;
  maxPendingHeads: number;
  headMaxBytes: number;
  headTimeoutMs: number;
  connectTimeoutMs: number;
  pollMs: number;
  exitGraceMs: number;
  /** Bytes buffered for one control subscriber before its events are dropped (NP §4.3: tunnels never feel backpressure). */
  subscriberHighWater: number;
  /**
   * Test only: `host:port` (IPv6 hosts in brackets) → the address actually dialled, exempt from the IP policy. Honoured only
   * when the process runs with NODE_ENV=test (main) or the in-process caller sets `allowTestOverrides`.
   */
  resolveOverrides?: Record<string, { host: string; port: number }>;
}

export const SIDECAR_DEFAULTS = {
  maxTunnels: 512,
  maxPendingHeads: 256,
  headMaxBytes: 16 * 1024,
  headTimeoutMs: 10_000,
  connectTimeoutMs: 15_000,
  pollMs: 1_000,
  exitGraceMs: 5_000,
  subscriberHighWater: 1024 * 1024,
} as const;

/** Only this host is ever faulted (NP §3.2); platform.claude.com (OAuth refresh) never is (P-NET-21). */
export const FAULT_HOST = 'api.anthropic.com';
const TOKEN_USER = 'ccd';
const METER_WINDOW_MS = 100;
const CONTROL_LINE_MAX = 64 * 1024;
const CONTROL_HELLO_MS = 5_000;
const ERROR_LINGER_MS = 2_000;

// ---------------------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for unit tests).

export interface ParsedHead {
  method: string;
  target: string;
  version: string;
  headers: [name: string, value: string][];
}

/** Parses an HTTP/1.x request head (without the final CRLFCRLF). Returns undefined for anything that is not a request line. */
export function parseHead(raw: string): ParsedHead | undefined {
  const lines = raw.split('\r\n');
  const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) (HTTP\/1\.[01])$/.exec(lines[0] ?? '');
  if (m === null) return undefined;
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) return undefined;
    headers.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
  }
  return { method: m[1] ?? '', target: m[2] ?? '', version: m[3] ?? '', headers };
}

/** `host:port` or `[v6]:port` → host without brackets (P-NET-06), lowercased, trailing dot stripped. */
export function parseConnectTarget(target: string): { host: string; port: number; key: string } | undefined {
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/.exec(target);
  if (m === null) return undefined;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (m[1] !== undefined) {
    if (!net.isIPv6(m[1])) return undefined;
    const host = m[1].toLowerCase();
    return { host, port, key: `[${host}]:${port}` };
  }
  let host = (m[2] ?? '').toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || host.startsWith('.') || host.includes('..')) return undefined;
  return { host, port, key: `${host}:${port}` };
}

/** Classifies `Proxy-Authorization` (SEC §6.2). Never returns, logs or stores the credential itself. */
export function classifyProxyAuth(headers: readonly (readonly [string, string])[], tokenA: Buffer): TokenClass {
  const values = headers.filter(([n]) => n === 'proxy-authorization').map(([, v]) => v);
  if (values.length === 0) return 'none';
  if (values.length > 1) return 'bad';
  const m = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(values[0] ?? '');
  if (m === null) return 'bad';
  const decoded = Buffer.from(m[1] ?? '', 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0 || decoded.slice(0, colon) !== TOKEN_USER) return 'bad';
  const pass = Buffer.from(decoded.slice(colon + 1), 'utf8');
  if (pass.length !== tokenA.length) return 'bad';
  return timingSafeEqual(pass, tokenA) ? 'A' : 'bad';
}

const ALWAYS_BLOCKED = new net.BlockList();
ALWAYS_BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS_BLOCKED.addSubnet('100.64.0.0', 10, 'ipv4');
ALWAYS_BLOCKED.addAddress('::1', 'ipv6');
ALWAYS_BLOCKED.addAddress('::', 'ipv6');
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6');
// Hardening beyond SEC §6.3's list: deprecated IPv4-compatible ::a.b.c.d, multicast and broadcast are never a valid target.
ALWAYS_BLOCKED.addSubnet('::', 96, 'ipv6');
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addAddress('255.255.255.255', 'ipv4');
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6');
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

/** The post-DNS target policy (SEC §6.3). Returns a refusal reason, or undefined when the address may be dialled. */
export function addressRefusal(ip: string, allowPrivate: boolean): string | undefined {
  let addr = ip.toLowerCase();
  let family: 'ipv4' | 'ipv6';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped?.[1] !== undefined) addr = mapped[1];
  if (net.isIPv4(addr)) family = 'ipv4';
  else if (net.isIPv6(addr)) family = 'ipv6';
  else return 'notAnAddress';
  if (ALWAYS_BLOCKED.check(addr, family)) return 'blockedAddress';
  if (!allowPrivate && PRIVATE.check(addr, family)) return 'privateAddress';
  return undefined;
}

/** SNI + offered ALPN from a TLS ClientHello record (NP §2). Bounds-checked; undefined when the bytes are not a ClientHello. */
export function parseClientHello(b: Buffer): { sni?: string; alpn: string[] } | undefined {
  try {
    if (b.length < 9 || b[0] !== 0x16 || b[5] !== 0x01) return undefined;
    const recEnd = Math.min(b.length, 5 + b.readUInt16BE(3));
    let p = 5 + 4 + 2 + 32; // handshake header, client_version, random
    const need = (n: number): void => {
      if (p + n > recEnd) throw new RangeError('short');
    };
    need(1);
    p += 1 + (b[p] ?? 0); // session id
    need(2);
    p += 2 + b.readUInt16BE(p); // cipher suites
    need(1);
    p += 1 + (b[p] ?? 0); // compression methods
    need(2);
    const extEnd = Math.min(recEnd, p + 2 + b.readUInt16BE(p));
    p += 2;
    const out: { sni?: string; alpn: string[] } = { alpn: [] };
    while (p + 4 <= extEnd) {
      const type = b.readUInt16BE(p);
      const len = b.readUInt16BE(p + 2);
      const body = b.subarray(p + 4, Math.min(extEnd, p + 4 + len));
      if (type === 0 && body.length >= 5 && body[2] === 0) {
        const n = body.readUInt16BE(3);
        out.sni = body.subarray(5, 5 + n).toString('latin1');
      } else if (type === 16 && body.length >= 2) {
        let q = 2;
        while (q < body.length) {
          const n = body[q] ?? 0;
          out.alpn.push(body.subarray(q + 1, q + 1 + n).toString('latin1'));
          q += 1 + n;
        }
      }
      p += 4 + len;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Streaming TLS record-layer counter (NP §2): counts complete records and remembers the last record length, buffering only the
 * 5-byte header. Non-TLS bytes switch it off for good; it never throws into the data path.
 */
export class TlsRecordScanner {
  private readonly hdr = Buffer.alloc(5);
  private hdrFill = 0;
  private remaining = 0;
  private curLen = 0;
  valid = true;

  push(chunk: Buffer): { records: number; lastLen?: number } {
    let records = 0;
    let lastLen: number | undefined;
    let i = 0;
    while (this.valid && i < chunk.length) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - i);
        this.remaining -= take;
        i += take;
        if (this.remaining === 0) {
          records++;
          lastLen = this.curLen;
        }
        continue;
      }
      this.hdr[this.hdrFill++] = chunk[i++] ?? 0;
      if (this.hdrFill < 5) continue;
      this.hdrFill = 0;
      const type = this.hdr[0] ?? 0;
      const len = this.hdr.readUInt16BE(3);
      if (type < 20 || type > 24 || this.hdr[1] !== 3 || len > 18432) {
        this.valid = false;
        break;
      }
      this.curLen = len;
      this.remaining = len;
      if (len === 0) {
        records++;
        lastLen = 0;
      }
    }
    return lastLen === undefined ? { records } : { records, lastLen };
  }
}

export function validateFault(v: unknown): SidecarFault | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const int = (x: unknown, min: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min;
  switch (o['mode']) {
    case 'refuse':
      return { mode: 'refuse' };
    case 'blackhole':
      return { mode: 'blackhole' };
    case 'reset':
    case 'stall':
      return int(o['afterDownBytes'], 0) ? { mode: o['mode'], afterDownBytes: o['afterDownBytes'] } : undefined;
    case 'slow':
      return int(o['bytesPerSec'], 1) ? { mode: 'slow', bytesPerSec: o['bytesPerSec'] } : undefined;
    default:
      return undefined;
  }
}

const isTokenString = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{32,256}$/.test(s);
const isPortList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((p) => typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535);
const posInt = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : dflt);

/** Validates net.json (written 0600 by the client). Throws with a message that never contains a token. */
export function parseConfig(text: string): SidecarConfig {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('config: not an object');
  const o = raw as Record<string, unknown>;
  if (o['v'] !== 1) throw new Error('config: unsupported version');
  if (!isTokenString(o['tokenA'])) throw new Error('config: tokenA must be lowercase hex');
  if (!isTokenString(o['controlToken'])) throw new Error('config: controlToken must be lowercase hex');
  if (typeof o['controlSocketPath'] !== 'string' || !o['controlSocketPath'].startsWith('/')) throw new Error('config: controlSocketPath');
  if (typeof o['allowPrivate'] !== 'boolean') throw new Error('config: allowPrivate');
  if (!isPortList(o['allowPorts']) || !isPortList(o['denyPorts'])) throw new Error('config: ports');
  if (typeof o['ownerPid'] !== 'number' || !Number.isInteger(o['ownerPid']) || o['ownerPid'] < 1) throw new Error('config: ownerPid');
  const cfg: SidecarConfig = {
    v: 1,
    tokenA: o['tokenA'],
    controlToken: o['controlToken'],
    controlSocketPath: o['controlSocketPath'],
    allowPrivate: o['allowPrivate'],
    allowPorts: o['allowPorts'],
    denyPorts: o['denyPorts'],
    ownerPid: o['ownerPid'],
    maxTunnels: posInt(o['maxTunnels'], SIDECAR_DEFAULTS.maxTunnels),
    maxPendingHeads: posInt(o['maxPendingHeads'], SIDECAR_DEFAULTS.maxPendingHeads),
    headMaxBytes: posInt(o['headMaxBytes'], SIDECAR_DEFAULTS.headMaxBytes),
    headTimeoutMs: posInt(o['headTimeoutMs'], SIDECAR_DEFAULTS.headTimeoutMs),
    connectTimeoutMs: posInt(o['connectTimeoutMs'], SIDECAR_DEFAULTS.connectTimeoutMs),
    pollMs: posInt(o['pollMs'], SIDECAR_DEFAULTS.pollMs),
    exitGraceMs: posInt(o['exitGraceMs'], SIDECAR_DEFAULTS.exitGraceMs),
    subscriberHighWater: posInt(o['subscriberHighWater'], SIDECAR_DEFAULTS.subscriberHighWater),
  };
  const ov = o['resolveOverrides'];
  if (ov !== undefined) {
    if (typeof ov !== 'object' || ov === null) throw new Error('config: resolveOverrides');
    const out: Record<string, { host: string; port: number }> = {};
    for (const [k, t] of Object.entries(ov as Record<string, unknown>)) {
      const tt = t as { host?: unknown; port?: unknown } | null;
      if (typeof tt?.host !== 'string' || net.isIP(tt.host) === 0 || !isPortList([tt.port]))
        throw new Error('config: resolveOverrides entry');
      out[k] = { host: tt.host, port: tt.port as number };
    }
    cfg.resolveOverrides = out;
  }
  return cfg;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The proxy.

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;
export interface SidecarDeps {
  log?: (o: Record<string, unknown>) => void;
  lookup?: LookupFn;
  connect?: (o: net.NetConnectOpts) => net.Socket;
  isAlive?: (pid: number) => boolean;
  /** Called once when the sidecar decides to end (Claude gone, owner gone before bind, `stop`, SIGTERM). */
  onExit?: (reason: string) => void;
  allowTestOverrides?: boolean;
}

export interface SidecarStats {
  tunnels: number;
  opened: number;
  refused: number;
  authFailures: number;
  dropped: number;
  subscribers: number;
  uncaught: number;
}

export interface Sidecar {
  readonly port: number;
  readonly controlSocketPath: string;
  onRecord(fn: (r: WireRecord) => void): () => void;
  setFault(spec: SidecarFault | null): void;
  bindClaudePid(pid: number): void;
  stats(): SidecarStats;
  noteUncaught(e: unknown): void;
  shutdown(reason: string): Promise<void>;
}

interface Meter {
  dir: 'up' | 'down';
  scanner: TlsRecordScanner;
  windowOpen: boolean;
  pendBytes: number;
  pendRecords: number;
  pendLastLen: number | undefined;
  lastChunkMono: number;
  total: number;
}

interface Tunnel {
  id: number;
  host: string;
  port: number;
  token: TokenClass;
  faultable: boolean;
  client: net.Socket;
  upstream: net.Socket | undefined;
  up: Meter;
  down: Meter;
  helloBuf: Buffer | undefined;
  errors: string[];
  rst: boolean;
  finished: boolean;
  /** Fault queue for `slow`. */
  slowQueue: Buffer[];
  slowQueued: number;
  slowBudget: number;
  slowRate: number;
  upstreamEnded: boolean;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  407: 'Proxy Authentication Required',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const errCode = (e: unknown): string => {
  if (typeof e === 'object' && e !== null) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && c !== '') return c;
  }
  return 'EUNKNOWN';
};

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
};

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

function assertPrivateDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('control dir is not a directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('control dir has a foreign owner');
  if ((st.mode & 0o077) !== 0) throw new Error('control dir is group/world accessible');
}

/** Starts the proxy listener and the control socket. Resolves once both listen. */
export async function startSidecar(cfg: SidecarConfig, deps: SidecarDeps = {}): Promise<Sidecar> {
  const log =
    deps.log ??
    ((o: Record<string, unknown>): void => {
      process.stderr.write(`${JSON.stringify({ t: Date.now(), ...o })}\n`);
    });
  const lookup = deps.lookup ?? defaultLookup;
  const connect = deps.connect ?? ((o: net.NetConnectOpts): net.Socket => net.connect(o));
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const overrides = deps.allowTestOverrides === true ? (cfg.resolveOverrides ?? {}) : {};
  const tokenA = Buffer.from(cfg.tokenA, 'utf8');
  const controlToken = Buffer.from(cfg.controlToken, 'utf8');
  const allowPorts = new Set(cfg.allowPorts);
  const denyPorts = new Set(cfg.denyPorts);

  assertPrivateDir(dirname(cfg.controlSocketPath));

  const listeners = new Set<(r: WireRecord) => void>();
  const tunnels = new Map<number, Tunnel>();
  const subscribers = new Set<net.Socket>();
  const clients = new Set<net.Socket>();
  const st: SidecarStats = { tunnels: 0, opened: 0, refused: 0, authFailures: 0, dropped: 0, subscribers: 0, uncaught: 0 };
  let nextId = 1;
  let pendingHeads = 0;
  let fault: SidecarFault | null = null;
  let claudePid: number | undefined;
  let deadSince: number | undefined;
  let shuttingDown: Promise<void> | undefined;
  let authWindowStart = 0;
  let authWindowCount = 0;

  const emit = (r: WireRecord): void => {
    for (const l of listeners) {
      try {
        l(r);
      } catch (e) {
        log({ ev: 'listenerThrew', code: errCode(e) }); // a listener bug never touches tunnel bytes (P-NET-13)
      }
    }
  };
  const rec = (t: { id: number; token: TokenClass; host: string; port: number }, kind: WireKind, extra: Partial<WireRecord> = {}): void => {
    emit({ tunnelId: t.id, mono: performance.now(), wallAt: Date.now(), token: t.token, host: t.host, port: t.port, kind, ...extra });
  };

  const respond = (c: net.Socket, code: number, extraHeaders: string[] = []): void => {
    if (c.destroyed || c.writableEnded) return;
    const head = [`HTTP/1.1 ${code} ${STATUS_TEXT[code] ?? 'Error'}`, ...extraHeaders, 'Connection: close', 'Content-Length: 0', '', ''];
    c.end(head.join('\r\n'));
    const t = setTimeout(() => c.destroy(), ERROR_LINGER_MS);
    t.unref();
    c.once('close', () => {
      clearTimeout(t);
    });
  };

  const refuse = (
    c: net.Socket,
    t: { id: number; token: TokenClass; host: string; port: number },
    code: number,
    reason: string,
    extraHeaders: string[] = [],
  ): void => {
    st.refused++;
    log({ ev: 'refused', id: t.id, host: t.host, port: t.port, token: t.token, status: code, reason });
    rec(t, 'refused', { error: reason });
    respond(c, code, extraHeaders);
  };

  const noteAuthFailure = (): void => {
    st.authFailures++;
    const now = performance.now();
    if (now - authWindowStart > 10_000) {
      authWindowStart = now;
      authWindowCount = 0;
    }
    if (++authWindowCount === 10) log({ ev: 'authBurst', count: authWindowCount, windowMs: 10_000 }); // P-SEC-47
  };

  // ---- metering (separate data listeners, never a Transform in the path; P-NET-13) ----
  const newMeter = (dir: 'up' | 'down'): Meter => ({
    dir,
    scanner: new TlsRecordScanner(),
    windowOpen: false,
    pendBytes: 0,
    pendRecords: 0,
    pendLastLen: undefined,
    lastChunkMono: 0,
    total: 0,
  });
  const flushMeter = (t: Tunnel, m: Meter, extra: Partial<WireRecord> = {}): void => {
    const r: Partial<WireRecord> = { bytes: m.pendBytes, records: m.pendRecords, ...extra };
    if (m.pendLastLen !== undefined) r.lastRecordLen = m.pendLastLen;
    emit({ tunnelId: t.id, mono: m.lastChunkMono, wallAt: Date.now(), token: t.token, host: t.host, port: t.port, kind: m.dir, ...r });
    m.pendBytes = 0;
    m.pendRecords = 0;
    m.pendLastLen = undefined;
  };
  const meterChunk = (t: Tunnel, m: Meter, d: Buffer): void => {
    try {
      const now = performance.now();
      m.total += d.length;
      const s = m.scanner.push(d);
      m.pendBytes += d.length;
      m.pendRecords += s.records;
      if (s.lastLen !== undefined) m.pendLastLen = s.lastLen;
      m.lastChunkMono = now;
      const extra: Partial<WireRecord> = {};
      if (m.dir === 'up' && t.helloBuf !== undefined) {
        t.helloBuf = Buffer.concat([t.helloBuf, d]);
        const full = t.helloBuf.length >= 5 && t.helloBuf.length >= 5 + t.helloBuf.readUInt16BE(3);
        if (full || t.helloBuf.length >= 16 * 1024) {
          const h = parseClientHello(t.helloBuf);
          t.helloBuf = undefined;
          if (h !== undefined) {
            if (h.sni !== undefined) extra.sni = h.sni;
            extra.alpn = h.alpn;
            if (h.sni !== undefined && h.sni.toLowerCase() !== t.host) log({ ev: 'sniMismatch', id: t.id, host: t.host, sni: h.sni });
            if (h.alpn.includes('h2')) log({ ev: 'alpnH2', id: t.id, host: t.host }); // P-NET-18: correlation stays unconfirmed
          }
        }
      }
      if (!m.windowOpen || extra.alpn !== undefined) {
        // First chunk after a quiet window goes out at once: burst starts keep their exact time (±250 ms join, §3.10).
        m.windowOpen = true;
        flushMeter(t, m, extra);
      }
    } catch (e) {
      log({ ev: 'meterError', id: t.id, code: errCode(e) });
    }
  };

  const ticker = setInterval(() => {
    for (const t of tunnels.values()) {
      for (const m of [t.up, t.down]) {
        if (!m.windowOpen) continue;
        if (m.pendBytes > 0) flushMeter(t, m);
        else m.windowOpen = false;
      }
      if (t.slowRate > 0) drainSlow(t);
    }
  }, METER_WINDOW_MS);
  ticker.unref();

  // ---- tunnel teardown ----
  const finish = (t: Tunnel): void => {
    if (t.finished) return;
    t.finished = true;
    tunnels.delete(t.id);
    st.tunnels = tunnels.size;
    for (const m of [t.up, t.down]) if (m.pendBytes > 0) flushMeter(t, m);
    const closeKind = t.rst ? 'rst' : t.errors.length > 0 ? 'error' : 'fin';
    const extra: Partial<WireRecord> = { closeKind, bytes: t.up.total + t.down.total };
    if (t.errors.length > 0) extra.error = t.errors.join(',');
    log({ ev: 'close', id: t.id, host: t.host, up: t.up.total, down: t.down.total, closeKind, error: extra.error });
    rec(t, 'close', extra);
  };
  const onSocketError = (t: Tunnel, side: 'client' | 'upstream', e: unknown): void => {
    const code = errCode(e);
    if (code === 'ECONNRESET' || code === 'EPIPE') t.rst = true;
    t.errors.push(`${side}:${code}`);
    rec(t, 'error', { error: `${side}:${code}` });
  };
  const killTunnel = (t: Tunnel, why: string): void => {
    t.rst = true;
    t.errors.push(why);
    t.client.resetAndDestroy();
    t.upstream?.destroy();
  };

  // ---- faulted down path (manual forwarding with backpressure; the normal path is pipe only, P-NET-12) ----
  function drainSlow(t: Tunnel): void {
    t.slowBudget = Math.min(t.slowRate, t.slowBudget + Math.max(1, Math.floor(t.slowRate / (1000 / METER_WINDOW_MS))));
    while (t.slowBudget > 0 && t.slowQueue.length > 0 && !t.client.destroyed && !t.client.writableNeedDrain) {
      const head = t.slowQueue[0];
      if (head === undefined) break;
      const n = Math.min(head.length, t.slowBudget);
      t.client.write(head.subarray(0, n));
      t.slowBudget -= n;
      t.slowQueued -= n;
      if (n === head.length) t.slowQueue.shift();
      else t.slowQueue[0] = head.subarray(n);
    }
    if (t.slowQueued < 64 * 1024 && t.upstream?.isPaused() === true && !t.upstreamEnded) t.upstream.resume();
    if (t.slowQueue.length === 0 && t.upstreamEnded && !t.client.writableEnded) t.client.end();
  }
  const wireFaultedDown = (t: Tunnel, u: net.Socket, spec: SidecarFault): void => {
    let forwarded = 0;
    let stalled = false;
    const write = (b: Buffer): void => {
      if (b.length === 0 || t.client.destroyed) return;
      if (!t.client.write(b)) {
        u.pause();
        t.client.once('drain', () => {
          if (!stalled) u.resume();
        });
      }
    };
    u.on('data', (d: Buffer) => {
      if (spec.mode === 'slow') {
        t.slowQueue.push(d);
        t.slowQueued += d.length;
        if (t.slowQueued >= 64 * 1024) u.pause();
        return;
      }
      if (stalled) return;
      const n = spec.mode === 'reset' || spec.mode === 'stall' ? spec.afterDownBytes : Infinity;
      const room = n - forwarded;
      if (d.length < room) {
        forwarded += d.length;
        write(d);
        return;
      }
      write(d.subarray(0, room));
      forwarded = n;
      if (spec.mode === 'reset') {
        log({ ev: 'fault', id: t.id, mode: 'reset', afterDownBytes: n });
        killTunnel(t, 'fault:reset');
      } else {
        stalled = true; // stall: silence, sockets stay open (the stall the core must detect)
        u.pause();
        log({ ev: 'fault', id: t.id, mode: 'stall', afterDownBytes: n });
      }
    });
    u.on('end', () => {
      t.upstreamEnded = true;
      if (spec.mode === 'slow') drainSlow(t);
      else if (!stalled && !t.client.writableEnded) t.client.end();
    });
  };

  // ---- CONNECT handling ----
  const handleConnect = (c: net.Socket, id: number, head: ParsedHead, rest: Buffer): void => {
    const target = parseConnectTarget(head.target);
    const token = classifyProxyAuth(head.headers, tokenA);
    const base = { id, token, host: target?.host ?? '', port: target?.port ?? 0 };
    rec(base, 'open');
    if (token !== 'A') {
      noteAuthFailure();
      refuse(c, base, 407, 'auth', ['Proxy-Authenticate: Basic realm="ccd"']);
      return;
    }
    if (target === undefined) {
      refuse(c, base, 400, 'badTarget');
      return;
    }
    if (denyPorts.has(target.port) || !allowPorts.has(target.port)) {
      refuse(c, base, 403, 'port');
      return;
    }
    if (target.host === 'localhost' || target.host.endsWith('.localhost')) {
      refuse(c, base, 403, 'blockedAddress');
      return;
    }
    let active = 0;
    for (const t of tunnels.values()) if (t.token === 'A') active++;
    if (active >= cfg.maxTunnels) {
      refuse(c, base, 503, 'tunnelCap'); // P-NET-16
      return;
    }
    // Only token A reaches this point (407 above), so `faultable` is "token A and api.anthropic.com" (P-NET-15).
    const faultable = target.host === FAULT_HOST;
    const spec = faultable ? fault : null;
    if (spec?.mode === 'refuse') {
      refuse(c, base, 502, 'fault:refuse');
      return;
    }

    const t: Tunnel = {
      id,
      host: target.host,
      port: target.port,
      token,
      faultable,
      client: c,
      upstream: undefined,
      up: newMeter('up'),
      down: newMeter('down'),
      helloBuf: Buffer.alloc(0),
      errors: [],
      rst: false,
      finished: false,
      slowQueue: [],
      slowQueued: 0,
      slowBudget: 0,
      slowRate: spec?.mode === 'slow' ? spec.bytesPerSec : 0,
      upstreamEnded: false,
    };
    tunnels.set(id, t);
    st.tunnels = tunnels.size;
    st.opened++;
    c.on('error', (e) => {
      onSocketError(t, 'client', e);
    });
    c.on('close', () => {
      t.upstream?.destroy();
      finish(t);
    });

    if (spec?.mode === 'blackhole') {
      // 200 then silence: never dial upstream, swallow the client's bytes.
      c.setNoDelay(true);
      c.setKeepAlive(true, 30_000);
      c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      log({ ev: 'established', id, host: t.host, port: t.port, fault: 'blackhole' });
      rec(t, 'established');
      if (rest.length > 0) meterChunk(t, t.up, rest);
      c.on('data', (d: Buffer) => {
        meterChunk(t, t.up, d);
      });
      c.resume();
      return;
    }

    void dial(t, target, rest, spec);
  };

  const resolveTarget = async (target: {
    host: string;
    port: number;
    key: string;
  }): Promise<{ host: string; port: number; addrs?: { address: string; family: number }[] } | { refusal: string; status: number }> => {
    const ov = overrides[target.key];
    if (ov !== undefined) return { host: ov.host, port: ov.port };
    if (net.isIP(target.host) !== 0) {
      const why = addressRefusal(target.host, cfg.allowPrivate);
      return why === undefined ? { host: target.host, port: target.port } : { refusal: why, status: 403 };
    }
    let addrs: { address: string; family: number }[];
    try {
      addrs = await lookup(target.host);
    } catch (e) {
      return { refusal: errCode(e), status: 502 }; // DNS happens here (P-NET-10): the real errno, never a guess
    }
    if (addrs.length === 0) return { refusal: 'ENOTFOUND', status: 502 };
    for (const a of addrs) {
      const why = addressRefusal(a.address, cfg.allowPrivate);
      if (why !== undefined) return { refusal: why, status: 403 }; // every address is checked (DNS rebinding, SEC §6.3)
    }
    return { host: target.host, port: target.port, addrs };
  };

  const dial = async (
    t: Tunnel,
    target: { host: string; port: number; key: string },
    rest: Buffer,
    spec: SidecarFault | null,
  ): Promise<void> => {
    const c = t.client;
    const r = await resolveTarget(target);
    if (c.destroyed) return;
    if ('refusal' in r) {
      tunnels.delete(t.id);
      st.tunnels = tunnels.size;
      t.finished = true;
      refuse(c, t, r.status, r.refusal);
      return;
    }
    const opts: net.TcpNetConnectOpts = { host: r.host, port: r.port, allowHalfOpen: true };
    if (r.addrs !== undefined) {
      const addrs = r.addrs;
      // Dial exactly the addresses we checked (never re-resolve), keeping Happy Eyeballs (NP §1.2).
      opts.lookup = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void): void => {
        if (o.all === true) cb(null, addrs);
        else cb(null, addrs[0]?.address, addrs[0]?.family);
      }) as unknown as net.LookupFunction;
    }
    let u: net.Socket;
    try {
      u = connect(opts);
    } catch (e) {
      tunnels.delete(t.id);
      st.tunnels = tunnels.size;
      t.finished = true;
      refuse(c, t, 502, errCode(e));
      return;
    }
    t.upstream = u;
    let connected = false;
    const timer = setTimeout(() => {
      if (connected || t.finished) return; // the client may have gone away while we were dialling
      u.destroy();
      tunnels.delete(t.id);
      st.tunnels = tunnels.size;
      t.finished = true;
      refuse(c, t, 504, 'connectTimeout'); // P-NET-09: a black-holed SYN is a 504 after 15 s, not a 3-minute "model stall"
    }, cfg.connectTimeoutMs);
    timer.unref();
    u.once('close', () => {
      if (!connected) clearTimeout(timer); // dial abandoned (client closed → upstream destroyed): no late 504 after `close`
    });
    u.once('error', (e) => {
      if (connected || t.finished) return;
      clearTimeout(timer);
      tunnels.delete(t.id);
      st.tunnels = tunnels.size;
      t.finished = true;
      refuse(c, t, 502, errCode(e)); // P-NET-08: 502 with the real errno
    });
    u.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      if (c.destroyed) {
        u.destroy();
        return;
      }
      u.on('error', (e) => {
        onSocketError(t, 'upstream', e);
      });
      u.on('close', () => {
        // Upstream fully closed. A FIN was already forwarded by pipe (client.end(), pending bytes still flush); an error or
        // reset is propagated by destroying the client. A stalled tunnel stays silent and open (the stall under test).
        if (spec?.mode === 'stall' || t.client.destroyed) return;
        if (t.rst || t.errors.length > 0) t.client.destroy();
        else if (!t.client.writableEnded && spec === null) t.client.end();
      });
      u.on('end', () => {
        log({ ev: 'upstreamFin', id: t.id });
      }); // FIN on an idle pooled tunnel is normal (P-NET-14)
      c.on('end', () => {
        log({ ev: 'clientFin', id: t.id });
      });
      c.setNoDelay(true); // P-NET-11
      u.setNoDelay(true);
      c.setKeepAlive(true, 30_000);
      u.setKeepAlive(true, 30_000);
      // 200 only after the upstream connected (P-NET-08); leftover head bytes go upstream first (P-NET-02).
      c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      log({ ev: 'established', id: t.id, host: t.host, port: t.port, remote: u.remoteAddress, fault: spec?.mode });
      rec(t, 'established');
      if (rest.length > 0) {
        u.write(rest);
        meterChunk(t, t.up, rest);
      }
      c.pipe(u); // backpressure + FIN forwarding (P-NET-03, P-NET-12)
      if (spec === null) u.pipe(c);
      else wireFaultedDown(t, u, spec);
      c.on('data', (d: Buffer) => {
        meterChunk(t, t.up, d);
      });
      u.on('data', (d: Buffer) => {
        meterChunk(t, t.down, d);
      });
      c.resume(); // paused since the head (P-NET-04)
    });
  };

  const onClient = (c: net.Socket): void => {
    if (shuttingDown !== undefined || pendingHeads >= cfg.maxPendingHeads) {
      c.destroy();
      return;
    }
    pendingHeads++;
    clients.add(c);
    c.once('close', () => clients.delete(c));
    const id = nextId++;
    let head: Buffer = Buffer.alloc(0);
    let headDone = false;
    const endHead = (): void => {
      if (headDone) return;
      headDone = true;
      pendingHeads--;
      clearTimeout(headTimer);
      c.off('data', onData);
    };
    // Head bound: 16 KiB / 10 s (P-NET-05). No socket idle timeout ever (P-NET-14).
    const headTimer = setTimeout(() => {
      endHead();
      log({ ev: 'headTimeout', id, bytes: head.length });
      c.destroy();
    }, cfg.headTimeoutMs);
    headTimer.unref();
    const onData = (d: Buffer): void => {
      try {
        head = head.length === 0 ? d : Buffer.concat([head, d]);
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) {
          if (head.length > cfg.headMaxBytes) {
            endHead();
            log({ ev: 'headTooLarge', id, bytes: head.length });
            c.destroy();
          }
          return; // accumulate until CRLFCRLF (P-NET-01)
        }
        if (i > cfg.headMaxBytes) {
          endHead();
          log({ ev: 'headTooLarge', id, bytes: i });
          c.destroy();
          return;
        }
        endHead();
        c.pause(); // no data event may fire without a listener until pipe() (P-NET-04)
        const rest = head.subarray(i + 4);
        const parsed = parseHead(head.subarray(0, i).toString('latin1'));
        head = Buffer.alloc(0);
        if (parsed === undefined) {
          refuse(c, { id, token: 'none', host: '', port: 0 }, 400, 'badHead');
          return;
        }
        if (parsed.method !== 'CONNECT') {
          // Absolute-form http:// and every other method: 405, never forwarded, never logged beyond the method (P-SEC-44).
          refuse(c, { id, token: 'none', host: '', port: 0 }, 405, `method:${parsed.method.slice(0, 16)}`, ['Allow: CONNECT']);
          return;
        }
        handleConnect(c, id, parsed, rest);
      } catch (e) {
        log({ ev: 'headError', id, code: errCode(e) });
        c.destroy();
      }
    };
    c.on('data', onData);
    c.on('end', () => {
      // FIN before a complete head (allowHalfOpen keeps the socket open otherwise): free the pending-head slot now, not at the
      // head timeout, so half-closed probes cannot hold the cap (P-NET-05/16).
      if (headDone) return;
      endHead();
      c.destroy();
    });
    c.on('error', () => {
      if (!headDone) endHead();
    });
    c.on('close', () => {
      if (!headDone) endHead();
    });
  };

  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: false }, onClient);
  server.on('error', (e) => {
    log({ ev: 'serverError', code: errCode(e) });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  // ---- control socket (0700 dir + control token; never on the proxy port, SEC §6.5) ----
  const sendLine = (s: net.Socket, o: unknown): void => {
    if (s.destroyed) return;
    if (s.writableLength > cfg.subscriberHighWater) {
      st.dropped++; // a slow subscriber loses events; tunnels never feel backpressure (NP §4.3)
      return;
    }
    s.write(`${JSON.stringify(o)}\n`);
  };
  const subscriberListener = (r: WireRecord): void => {
    for (const s of subscribers) sendLine(s, { t: 'rec', r });
  };
  listeners.add(subscriberListener);

  const handleControl = (s: net.Socket, msg: Record<string, unknown>, authed: { ok: boolean }): void => {
    const id = typeof msg['id'] === 'number' ? msg['id'] : 0;
    const reply = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      sendLine(s, { t: 'reply', id, ok, ...extra });
    };
    if (!authed.ok) {
      const tok = typeof msg['token'] === 'string' ? Buffer.from(msg['token'], 'utf8') : Buffer.alloc(0);
      if (msg['op'] !== 'hello' || tok.length !== controlToken.length || !timingSafeEqual(tok, controlToken)) {
        log({ ev: 'controlAuthFailed' });
        s.end(`${JSON.stringify({ t: 'hello', ok: false })}\n`);
        s.destroy();
        return;
      }
      authed.ok = true;
      subscribers.add(s);
      st.subscribers = subscribers.size;
      sendLine(s, { t: 'hello', ok: true, v: 1, port, pid: process.pid, now: performance.now(), wallNow: Date.now() });
      return;
    }
    switch (msg['op']) {
      case 'bind': {
        const pid = msg['pid'];
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 2) {
          reply(false, { error: 'badPid' });
          return;
        }
        api.bindClaudePid(pid);
        reply(true);
        return;
      }
      case 'fault': {
        const spec = validateFault(msg['spec']);
        if (spec === undefined) {
          reply(false, { error: 'badFault' });
          return;
        }
        api.setFault(spec);
        reply(true);
        return;
      }
      case 'stats':
        reply(true, { stats: api.stats() });
        return;
      case 'stop':
        reply(true);
        void api.shutdown('stop');
        return;
      default:
        reply(false, { error: 'badOp' });
    }
  };

  const control = net.createServer((s) => {
    const authed = { ok: false };
    let buf = '';
    const helloTimer = setTimeout(() => {
      if (!authed.ok) s.destroy();
    }, CONTROL_HELLO_MS);
    helloTimer.unref();
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      buf += d;
      if (buf.length > CONTROL_LINE_MAX && !buf.includes('\n')) {
        s.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          log({ ev: 'controlBadJson' });
          if (!authed.ok) s.destroy();
          continue;
        }
        if (typeof msg !== 'object' || msg === null) continue;
        try {
          handleControl(s, msg as Record<string, unknown>, authed);
        } catch (e) {
          log({ ev: 'controlError', code: errCode(e) });
        }
        if (s.destroyed) return;
      }
    });
    s.on('error', () => undefined);
    s.on('close', () => {
      clearTimeout(helloTimer);
      subscribers.delete(s);
      st.subscribers = subscribers.size;
    });
  });
  control.on('error', (e) => {
    log({ ev: 'controlServerError', code: errCode(e) });
  });
  try {
    const old = lstatSync(cfg.controlSocketPath);
    if (old.isSocket())
      unlinkSync(cfg.controlSocketPath); // stale socket from a crashed run in our own 0700 dir
    else throw new Error('control socket path exists and is not a socket');
  } catch (e) {
    if (errCode(e) !== 'ENOENT') {
      server.close();
      throw e;
    }
  }
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(cfg.controlSocketPath, () => {
      control.off('error', reject);
      resolve();
    });
  });
  chmodSync(cfg.controlSocketPath, 0o600);

  // ---- lifetime (A-8: 1 s poll; exits exitGraceMs after Claude, P-NET-23) ----
  const lifeTimer = setInterval(() => {
    const pid = claudePid ?? cfg.ownerPid;
    if (isAlive(pid)) {
      deadSince = undefined;
      return;
    }
    const now = performance.now();
    deadSince ??= now;
    if (now - deadSince >= cfg.exitGraceMs) void api.shutdown(claudePid === undefined ? 'ownerGone' : 'claudeExited');
  }, cfg.pollMs);
  lifeTimer.unref();

  const api: Sidecar = {
    port,
    controlSocketPath: cfg.controlSocketPath,
    onRecord(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setFault(spec) {
      fault = spec;
      let killed = 0;
      for (const t of [...tunnels.values()]) {
        // Switching kills only token-A tunnels to api.anthropic.com; tool/OAuth tunnels never notice (P-NET-15, P-NET-21).
        if (t.faultable) {
          killTunnel(t, 'faultSwitch');
          killed++;
        }
      }
      log({ ev: 'faultSet', mode: spec?.mode ?? null, killed });
    },
    bindClaudePid(pid) {
      claudePid = pid;
      deadSince = undefined;
      log({ ev: 'bound', pid });
    },
    stats: () => ({ ...st }),
    noteUncaught(e) {
      st.uncaught++;
      log({ ev: 'uncaught', code: errCode(e), message: e instanceof Error ? e.message.slice(0, 200) : 'non-error' });
    },
    shutdown(reason) {
      shuttingDown ??= (async () => {
        log({ ev: 'shutdown', reason });
        clearInterval(ticker);
        clearInterval(lifeTimer);
        for (const t of [...tunnels.values()]) {
          t.client.destroy();
          t.upstream?.destroy();
        }
        for (const c of clients) c.destroy();
        for (const s of subscribers) {
          s.end();
          setTimeout(() => s.destroy(), 500).unref();
        }
        await Promise.all([
          new Promise<void>((r) =>
            server.close(() => {
              r();
            }),
          ),
          new Promise<void>((r) =>
            control.close(() => {
              r();
            }),
          ),
        ]);
        try {
          unlinkSync(cfg.controlSocketPath);
        } catch {
          /* already gone */
        }
        deps.onExit?.(reason);
      })();
      return shuttingDown;
    },
  };
  log({ ev: 'listening', port, pid: process.pid });
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Process entry: `node sidecar.js <net.json>`.

async function main(argv: readonly string[]): Promise<void> {
  const configPath = argv[2];
  const log = (o: Record<string, unknown>): void => {
    process.stderr.write(`${JSON.stringify({ t: Date.now(), ...o })}\n`);
  };
  let sidecar: Sidecar | undefined;
  // A bug in one tunnel must not take the listener down (NP §4.3).
  process.on('uncaughtException', (e) => {
    if (sidecar !== undefined) sidecar.noteUncaught(e);
    else log({ ev: 'uncaught', message: e.message.slice(0, 200) });
  });
  process.on('unhandledRejection', (e) => {
    if (sidecar !== undefined) sidecar.noteUncaught(e);
    else log({ ev: 'unhandledRejection' });
  });
  if (configPath === undefined) {
    log({ ev: 'fatal', reason: 'usage: sidecar.js <net.json>' });
    process.exit(2);
  }
  let cfg: SidecarConfig;
  try {
    cfg = parseConfig(readFileSync(configPath, 'utf8'));
    unlinkSync(configPath); // the tokens now live only in memory and in the owner
  } catch (e) {
    log({ ev: 'fatal', reason: 'config', message: e instanceof Error ? e.message : 'unknown' });
    process.exit(2);
  }
  try {
    sidecar = await startSidecar(cfg, {
      log,
      allowTestOverrides: process.env['NODE_ENV'] === 'test',
      onExit: (reason) => {
        log({ ev: 'exit', reason });
        process.exit(0);
      },
    });
  } catch (e) {
    log({ ev: 'fatal', reason: 'start', code: errCode(e), message: e instanceof Error ? e.message : 'unknown' });
    process.exit(3);
  }
  const s = sidecar;
  process.on('SIGTERM', () => void s.shutdown('SIGTERM'));
  process.on('SIGINT', () => void s.shutdown('SIGINT'));
  process.on('SIGHUP', () => undefined); // detached: a dying terminal must not take the proxy down
}

const entry = process.argv[1];
let isMain = false;
try {
  isMain = entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  isMain = false;
}
if (isMain) void main(process.argv);
