// platform/netproxy/client.ts — NetProxyFactory: spawns the detached sidecar, talks to it over the 0700-dir control socket and
// turns its event stream into TunnelRecords (DESIGN.md §2.7.7, §3.10, D-21).
//
// - Spawn: `sh -c 'ulimit -n 8192 2>/dev/null; exec "$0" "$@"' <node> <sidecar.js> <sessionDir>/net.json` (P-NET-16), detached,
//   stdout/stderr to `logPath`. `exec` keeps the pid we get back equal to the sidecar's pid.
// - net.json is written 0600 with O_EXCL next to the control socket; the sidecar deletes it once read.
// - The control connection authenticates with the control token (P-SEC-17); requests are JSON lines with ids.
// - Sidecar death (connection lost while not stopping) is reported on the record stream as the reserved record
//   `{ tunnelId: 0, kind: 'error', error: 'sidecarDied' }` and every later request rejects. The owner then kills the pane with
//   `E_NETWORK_UNAVAILABLE{reason:'sidecarDied'}`; nothing here restarts the sidecar (rev 2: no same-port restart, P-NET-23/25).
// - Times: the sidecar stamps records with its own performance.now(); the hello reply carries its `now`, from which we derive
//   a constant offset onto our Clock's monotonic time. wallAt is passed through (joins with transcript timestamps, §3.10).
// No setTimeout/setInterval here (§4.12): all waiting goes through the injected Clock.

import { constants as fsc } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FaultSpec } from '../../model/commands.js';
import type { Logger } from '../../model/logger.js';
import type { Cancel, Clock, MonoMs, WallMs } from '../../model/time.js';
import type { NetProxy, NetProxyFactory, ProcessPort, TunnelRecord } from '../ports.js';

/** Reserved tunnel id for sidecar-level records (never used by a real tunnel; the sidecar numbers tunnels from 1). */
export const SIDECAR_TUNNEL_ID = 0;
export const SIDECAR_DIED = 'sidecarDied';

export type NetSidecarFailure =
  'configExists' | 'spawnFailed' | 'exited' | 'startTimeout' | 'handshake' | 'requestTimeout' | 'down' | 'stopped' | 'rejected';

/** L0 error thrown by the client (mapped to E_NETWORK_UNAVAILABLE by session/errors-map.ts). Never carries a token. */
export class NetSidecarError extends Error {
  override readonly name = 'NetSidecarError';
  constructor(
    readonly reason: NetSidecarFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface NetProxyFactoryDeps {
  process: ProcessPort;
  clock: Clock;
  logger: Logger;
  /** Absolute path of the node binary (process.execPath). */
  nodePath: string;
  /** The library pid; before bindClaudePid the sidecar exits when it dies. */
  ownerPid: number;
  /** Defaults to `standalone/sidecar.js` next to this module (dist/). */
  scriptPath?: string;
  /** Env of the sidecar process. The sidecar needs nothing from the environment; tests pass NODE_ENV=test. */
  sidecarEnv?: Readonly<Record<string, string>>;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Extra sidecar config fields (tests: headTimeoutMs, connectTimeoutMs, pollMs, exitGraceMs, resolveOverrides…). */
  sidecarConfig?: Readonly<Record<string, unknown>>;
}

const SH_WRAPPER = 'ulimit -n 8192 2>/dev/null; exec "$0" "$@"';
const MAX_LINE = 1024 * 1024;

interface WireRecord {
  tunnelId: number;
  mono: number;
  wallAt: number;
  token: TunnelRecord['token'];
  host: string;
  port: number;
  kind: TunnelRecord['kind'];
  sni?: string;
  alpn?: string[];
  bytes?: number;
  records?: number;
  lastRecordLen?: number;
  closeKind?: TunnelRecord['closeKind'];
  error?: string;
}

const KINDS: ReadonlySet<string> = new Set(['open', 'established', 'up', 'down', 'close', 'error', 'refused']);
const TOKENS: ReadonlySet<string> = new Set(['A', 'none', 'bad']);
const CLOSE_KINDS: ReadonlySet<string> = new Set(['fin', 'rst', 'error']);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Maps one wire record onto a TunnelRecord with our clock's monotonic base. Undefined for malformed records. */
export function toTunnelRecord(w: unknown, monoOffset: number): TunnelRecord | undefined {
  if (typeof w !== 'object' || w === null) return undefined;
  const r = w as Partial<Record<keyof WireRecord, unknown>>;
  if (!isNum(r.tunnelId) || !isNum(r.mono) || !isNum(r.wallAt) || !isNum(r.port)) return undefined;
  if (typeof r.host !== 'string' || typeof r.kind !== 'string' || !KINDS.has(r.kind)) return undefined;
  if (typeof r.token !== 'string' || !TOKENS.has(r.token)) return undefined;
  const out: TunnelRecord = {
    tunnelId: r.tunnelId,
    at: (r.mono + monoOffset) as MonoMs,
    wallAt: r.wallAt as WallMs,
    token: r.token as TunnelRecord['token'],
    host: r.host,
    port: r.port,
    kind: r.kind as TunnelRecord['kind'],
  };
  if (typeof r.sni === 'string') out.sni = r.sni;
  if (Array.isArray(r.alpn) && r.alpn.every((a) => typeof a === 'string')) out.alpn = r.alpn;
  if (isNum(r.bytes)) out.bytes = r.bytes;
  if (isNum(r.records)) out.records = r.records;
  if (isNum(r.lastRecordLen)) out.lastRecordLen = r.lastRecordLen;
  if (typeof r.closeKind === 'string' && CLOSE_KINDS.has(r.closeKind))
    out.closeKind = r.closeKind as NonNullable<TunnelRecord['closeKind']>;
  if (typeof r.error === 'string') out.error = r.error;
  return out;
}

const errCode = (e: unknown): string => {
  if (typeof e === 'object' && e !== null) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return 'EUNKNOWN';
};

async function writeExclusive0600(path: string, text: string): Promise<void> {
  let fh;
  try {
    fh = await open(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    if (errCode(e) === 'EEXIST') throw new NetSidecarError('configExists', `sidecar config already exists: ${path}`);
    throw e;
  }
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function logTail(path: string): Promise<string> {
  try {
    const t = await readFile(path, 'utf8');
    return t.slice(-2048).trim();
  } catch {
    return '';
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* gone */
  }
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  cancelTimer: Cancel;
}

/** The live connection to one sidecar. */
export class NetProxyClient implements NetProxy {
  private readonly listeners = new Set<(r: TunnelRecord) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextReq = 1;
  private buf = '';
  private state: 'up' | 'stopping' | 'stopped' | 'down' = 'up';
  private stopPromise: Promise<void> | undefined;
  private readonly closed: Promise<void>;
  private sidecarStats: Record<string, unknown> | undefined;

  constructor(
    private readonly sock: net.Socket,
    readonly port: number,
    readonly pid: number,
    private readonly monoOffset: number,
    private readonly deps: NetProxyFactoryDeps,
    private readonly paths: { configPath: string; controlSocketPath: string },
    initialBuffer: string,
  ) {
    this.closed = new Promise<void>((resolve) =>
      sock.once('close', () => {
        resolve();
      }),
    );
    sock.on('data', (d: string) => {
      this.onData(d);
    });
    sock.on('error', (e) => {
      deps.logger.warn('netproxy: control socket error', { code: errCode(e) });
    });
    sock.on('close', () => {
      this.onClose();
    });
    if (initialBuffer !== '') this.onData(initialBuffer);
    sock.resume(); // paused at the end of the hello handshake
  }

  on(l: (r: TunnelRecord) => void): Cancel {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  async bindClaudePid(pid: number): Promise<void> {
    await this.request({ op: 'bind', pid });
  }

  async setFault(spec: FaultSpec | null): Promise<void> {
    await this.request({ op: 'fault', spec });
  }

  /** Sidecar counters (tunnels, refused, authFailures, dropped, …) for diagnostics. */
  async stats(): Promise<Record<string, unknown>> {
    const r = await this.request({ op: 'stats' });
    const s = r['stats'];
    this.sidecarStats = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
    return this.sidecarStats;
  }

  get isDown(): boolean {
    return this.state === 'down';
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    const wasUp = this.state === 'up';
    if (wasUp) this.state = 'stopping';
    if (wasUp) {
      try {
        await this.request({ op: 'stop' }, true);
        await this.waitClosed(this.deps.stopTimeoutMs ?? 3000);
      } catch (e) {
        this.deps.logger.warn('netproxy: stop request failed', { reason: e instanceof NetSidecarError ? e.reason : errCode(e) });
      }
    }
    this.sock.destroy();
    this.state = 'stopped';
    this.rejectAll(new NetSidecarError('stopped', 'network sidecar stopped'));
    // Make sure the process is gone even if it ignored `stop` (SIGTERM, then SIGKILL).
    const { process: proc, clock } = this.deps;
    if (proc.isAlive(this.pid)) {
      proc.kill(this.pid, 'SIGTERM');
      const until = clock.now() + 1000;
      while (proc.isAlive(this.pid) && clock.now() < until) await clock.sleep(25);
      if (proc.isAlive(this.pid)) proc.kill(this.pid, 'SIGKILL');
    }
    await unlinkQuiet(this.paths.configPath);
    await unlinkQuiet(this.paths.controlSocketPath);
  }

  private async waitClosed(ms: number): Promise<void> {
    let cancel: Cancel = () => undefined;
    const timeout = new Promise<void>((resolve) => {
      cancel = this.deps.clock.setTimer((this.deps.clock.now() + ms) as MonoMs, resolve);
    });
    await Promise.race([this.closed, timeout]);
    cancel();
  }

  private request(msg: Record<string, unknown>, allowWhileStopping = false): Promise<Record<string, unknown>> {
    if (this.state === 'down') return Promise.reject(new NetSidecarError('down', 'network sidecar is down'));
    if (this.state === 'stopped' || (this.state === 'stopping' && !allowWhileStopping))
      return Promise.reject(new NetSidecarError('stopped', 'network sidecar stopped'));
    const id = this.nextReq++;
    const { clock } = this.deps;
    return new Promise((resolve, reject) => {
      const cancelTimer = clock.setTimer((clock.now() + (this.deps.requestTimeoutMs ?? 5000)) as MonoMs, () => {
        this.pending.delete(id);
        reject(new NetSidecarError('requestTimeout', `network sidecar did not answer ${String(msg['op'])}`));
      });
      this.pending.set(id, { resolve, reject, cancelTimer });
      this.sock.write(`${JSON.stringify({ ...msg, id })}\n`);
    });
  }

  private onData(d: string): void {
    this.buf += d;
    if (this.buf.length > MAX_LINE && !this.buf.includes('\n')) {
      this.deps.logger.warn('netproxy: oversize control line dropped', { bytes: this.buf.length });
      this.buf = '';
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim() !== '') this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.deps.logger.warn('netproxy: malformed control line');
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (m['t'] === 'rec') {
      const r = toTunnelRecord(m['r'], this.monoOffset);
      if (r !== undefined) this.dispatch(r);
      return;
    }
    if (m['t'] === 'reply' && typeof m['id'] === 'number') {
      const p = this.pending.get(m['id']);
      if (p === undefined) return;
      this.pending.delete(m['id']);
      p.cancelTimer();
      if (m['ok'] === true) p.resolve(m);
      else p.reject(new NetSidecarError('rejected', `network sidecar refused the request: ${String(m['error'])}`));
    }
  }

  private dispatch(r: TunnelRecord): void {
    for (const l of [...this.listeners]) {
      try {
        l(r);
      } catch (e) {
        this.deps.logger.warn('netproxy: record listener threw', { message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private rejectAll(e: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.cancelTimer();
      p.reject(e);
    }
  }

  private onClose(): void {
    if (this.state !== 'up') return;
    this.state = 'down';
    this.rejectAll(new NetSidecarError('down', 'network sidecar connection lost'));
    this.deps.logger.error('netproxy: sidecar connection lost', { pid: this.pid, alive: this.deps.process.isAlive(this.pid) });
    const { clock } = this.deps;
    this.dispatch({
      tunnelId: SIDECAR_TUNNEL_ID,
      at: clock.now(),
      wallAt: clock.wallNow(),
      token: 'none',
      host: '',
      port: this.port,
      kind: 'error',
      error: SIDECAR_DIED,
    });
  }
}

/** Connects to the control socket and completes the hello handshake. Resolves undefined when the socket is not there yet. */
async function tryHandshake(
  socketPath: string,
  controlToken: string,
  clock: Clock,
  timeoutMs: number,
): Promise<{ sock: net.Socket; hello: Record<string, unknown>; rest: string; offset: number } | undefined> {
  const sock = net.createConnection(socketPath);
  sock.setEncoding('utf8');
  const connected = await new Promise<boolean>((resolve, reject) => {
    sock.once('connect', () => {
      resolve(true);
    });
    sock.once('error', (e) => {
      const code = errCode(e);
      if (code === 'ENOENT' || code === 'ECONNREFUSED') resolve(false);
      else reject(new NetSidecarError('handshake', `control socket: ${code}`));
    });
  });
  if (!connected) {
    sock.destroy();
    return undefined;
  }
  const sentAt = clock.now();
  sock.write(`${JSON.stringify({ op: 'hello', token: controlToken })}\n`);
  let cancel: Cancel = () => undefined;
  try {
    const got = await new Promise<{ line: string; rest: string }>((resolve, reject) => {
      let buf = '';
      cancel = clock.setTimer((clock.now() + timeoutMs) as MonoMs, () => {
        reject(new NetSidecarError('handshake', 'network sidecar did not answer hello'));
      });
      const onData = (d: string): void => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          sock.off('data', onData);
          sock.pause(); // nothing may flow without a listener until NetProxyClient attaches its own
          resolve({ line: buf.slice(0, nl), rest: buf.slice(nl + 1) });
        } else if (buf.length > MAX_LINE) reject(new NetSidecarError('handshake', 'oversize hello'));
      };
      sock.on('data', onData);
      sock.once('close', () => {
        reject(new NetSidecarError('handshake', 'control socket closed during hello'));
      });
    });
    const receivedAt = clock.now();
    const hello = JSON.parse(got.line) as Record<string, unknown>;
    if (hello['t'] !== 'hello' || hello['ok'] !== true || !isNum(hello['port']) || !isNum(hello['pid']) || !isNum(hello['now']))
      throw new NetSidecarError('handshake', 'network sidecar rejected the control token or sent a bad hello');
    // Offset at the midpoint of the round trip.
    const offset = (sentAt + receivedAt) / 2 - hello['now'];
    return { sock, hello, rest: got.rest, offset };
  } catch (e) {
    sock.destroy();
    if (e instanceof NetSidecarError) throw e;
    throw new NetSidecarError('handshake', `bad hello: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    cancel();
  }
}

export function createNetProxyFactory(deps: NetProxyFactoryDeps): NetProxyFactory {
  const scriptPath = deps.scriptPath ?? fileURLToPath(new URL('./standalone/sidecar.js', import.meta.url));
  return {
    async start(o) {
      const { process: proc, clock, logger } = deps;
      const configPath = join(dirname(o.controlSocketPath), 'net.json');
      const config = {
        ...deps.sidecarConfig,
        v: 1,
        tokenA: o.tokenA,
        controlSocketPath: o.controlSocketPath,
        controlToken: o.controlToken,
        allowPrivate: o.allowPrivate,
        allowPorts: o.allowPorts,
        denyPorts: o.denyPorts,
        ownerPid: deps.ownerPid,
      };
      await writeExclusive0600(configPath, JSON.stringify(config));
      let pid: number;
      try {
        ({ pid } = await proc.spawnDetached('/bin/sh', ['-c', SH_WRAPPER, deps.nodePath, scriptPath, configPath], {
          env: deps.sidecarEnv ?? {},
          logPath: o.logPath,
        }));
      } catch (e) {
        await unlinkQuiet(configPath);
        throw new NetSidecarError('spawnFailed', `could not spawn the network sidecar: ${e instanceof Error ? e.message : String(e)}`);
      }
      const startTimeoutMs = deps.startTimeoutMs ?? 10_000;
      const deadline = clock.now() + startTimeoutMs;
      const fail = async (reason: NetSidecarFailure, msg: string): Promise<never> => {
        if (proc.isAlive(pid)) proc.kill(pid, 'SIGKILL');
        await unlinkQuiet(configPath);
        const tail = await logTail(o.logPath);
        throw new NetSidecarError(reason, tail === '' ? msg : `${msg}; sidecar log: ${tail}`);
      };
      for (;;) {
        let hs: Awaited<ReturnType<typeof tryHandshake>>;
        try {
          hs = await tryHandshake(o.controlSocketPath, o.controlToken, clock, Math.max(500, deadline - clock.now()));
        } catch (e) {
          return fail('handshake', e instanceof Error ? e.message : String(e));
        }
        if (hs !== undefined) {
          const port = hs.hello['port'] as number;
          const helloPid = hs.hello['pid'] as number;
          if (helloPid !== pid) logger.warn('netproxy: sidecar pid differs from the spawned pid', { spawned: pid, hello: helloPid });
          logger.info('netproxy: sidecar up', { pid: helloPid, port });
          return new NetProxyClient(
            hs.sock,
            port,
            helloPid,
            hs.offset,
            deps,
            { configPath, controlSocketPath: o.controlSocketPath },
            hs.rest,
          );
        }
        if (!proc.isAlive(pid)) return fail('exited', 'network sidecar exited during start');
        if (clock.now() >= deadline) return fail('startTimeout', `network sidecar did not come up within ${startTimeoutMs} ms`);
        await clock.sleep(20);
      }
    },
  };
}
