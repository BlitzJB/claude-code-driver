// platform/hook-server/transport.ts — the HookTransport port implementation (DESIGN.md §2.7.5, §3.5): a main-thread proxy to
// the hook worker (worker.ts). It mints the two tokens, writes the forwarder's 0600 `fwd.json`, spawns the worker, brands and
// re-stamps nothing (the worker stamps `hookSeq`, `at`, `wallAt` with a fixed offset to the main clock), fans events out to
// listeners, acknowledges them for the worker's bounded queue, tracks held PermissionRequests and their `closed` promises,
// and turns a worker exit into `HookWorkerDied` (no restart: re-listening on a released port races a squatter, SEC §2.4).
import { lstat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { HookSeq } from '../../model/ids.js';
import type { Cancel, MonoMs, WallMs } from '../../model/time.js';
import type { HookEndpoint, HookTransport, HookTransportFactory, RawHookEvent } from '../ports.js';
import { isValidSessionShortId, isValidToken } from './auth.js';
import { DEFAULT_MAX_BODY_BYTES } from './body.js';
import { HookTransportError, HookWorkerDied, SocketPathTooLong, UnsafeRuntimeDir } from './errors.js';
import type { MainToWorker, WorkerInit, WorkerStats, WorkerToMain } from './worker.js';

/** Must equal worker.ts `queuedBytesOf` (the worker charges, the main thread acks); restated so this module never loads the
 *  worker entry at runtime. A unit test asserts both agree. */
export function ackBytesOf(e: { bytes: number; truncated: boolean }): number {
  return e.truncated ? 0 : e.bytes;
}

/** HTTP observation events (§3.4 `<Ev>` list, D-34). SessionStart (HTTP unsupported, P-HOOK-18) and PermissionRequest
 *  (anti-squatting, SEC §2.4) never go over HTTP; a request naming them is refused like any unregistered event. */
export const HTTP_HOOK_EVENTS: readonly string[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'PermissionDenied',
  'MessageDisplay',
  'PostModelSwitch',
  'ConfigChange',
  'CwdChanged',
];
/** Events the forwarder may carry: SessionStart + PermissionRequest always, every HTTP event with transport 'unix'. */
export const UNIX_HOOK_EVENTS: readonly string[] = ['SessionStart', 'PermissionRequest', ...HTTP_HOOK_EVENTS];
/** The only event we hold (HT §10.2). */
export const HOLD_HOOK_EVENTS: readonly string[] = ['PermissionRequest'];

export const DEFAULT_MAX_HELD = 32;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_QUEUED_EVENTS = 8192;
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024 * 1024;
/** `sun_path` incl. the NUL terminator: macOS 104, Linux 108 (HT §6 VERIFIED bench: 105 bytes → EINVAL). */
export const SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107;
export const SOCKET_NAME = 'h.sock';
export const FWD_CONFIG_NAME = 'fwd.json';

/** Local defaults for development from `src/` (Node type stripping); `dist/` resolves the `.js` siblings. */
function sibling(rel: string): URL {
  const fromSrc = import.meta.url.endsWith('.ts');
  return new URL(fromSrc ? rel.replace(/\.js$/, '.ts') : rel, import.meta.url);
}
function defaultWorkerUrl(): URL {
  return sibling('./worker.js');
}
function defaultForwarderScriptPath(): string {
  return fileURLToPath(sibling('./standalone/forward.js'));
}

export interface NodeHookTransportOptions {
  /** The worker entry (default: `./worker.js` next to this module). */
  workerUrl?: URL;
  /** Absolute path of the forwarder script written into the settings file (default: `./standalone/forward.js`). */
  forwarderScriptPath?: string;
  /** Node binary that runs the forwarder (default: `process.execPath`, never a PATH lookup, P-HOOK-29). */
  nodePath?: string;
  maxQueuedEvents?: number;
  maxQueuedBytes?: number;
  httpEvents?: readonly string[];
  /** Forgery burst detector: `count` auth failures within `windowMs` → one `onForgery` callback per window (SEC §2.3). */
  forgeryBurst?: { count: number; windowMs: number };
}

export interface ForgeryBurst {
  count: number;
  windowMs: number;
  lastReason: string | undefined;
}

export interface DetailedHookStats extends WorkerStats {
  received: number;
}

/**
 * Members beyond the §2.7.5 port: worker death and forgery bursts have no channel in `HookTransport`, so the concrete
 * transport (and the fake) expose them here; docs/icr/0003-wp03.md proposes adding them to `ports.ts`.
 */
export interface HookTransportExtras {
  /** The worker died while the transport was open (§3.5 → channel hooks down, the pane is killed). Fires once. */
  onDied(fn: (err: HookWorkerDied) => void): Cancel;
  /** A burst of 403s / bad unix tokens (→ `security.alert E_SECURITY_HOOK_FORGERY`). */
  onForgery(fn: (b: ForgeryBurst) => void): Cancel;
  detailedStats(): DetailedHookStats;
}

type CreateOptions = Parameters<HookTransportFactory['create']>[0];

export function createNodeHookTransportFactory(opts: NodeHookTransportOptions = {}): HookTransportFactory {
  return {
    create(o: CreateOptions): NodeHookTransport {
      return new NodeHookTransport(o, opts);
    },
  };
}

type TransportState = 'new' | 'starting' | 'open' | 'closing' | 'closed' | 'dead';

function emptyWorkerStats(): WorkerStats {
  return { authFailures: 0, dropped: 0, truncated: 0, badJson: 0, heldOverflow: 0, connectionOverflow: 0, queueOverflow: 0, held: 0 };
}

export class NodeHookTransport implements HookTransport, HookTransportExtras {
  readonly #o: CreateOptions;
  readonly #opts: NodeHookTransportOptions;
  #worker: Worker | undefined;
  #state: TransportState = 'new';
  #endpoint: HookEndpoint | undefined;
  #fwdConfigPath: string | undefined;
  #socketPath: string | undefined;
  readonly #listeners = new Set<(e: RawHookEvent) => void>();
  readonly #diedListeners = new Set<(err: HookWorkerDied) => void>();
  readonly #forgeryListeners = new Set<(b: ForgeryBurst) => void>();
  /** Held (holdable, not yet answered or closed) hookSeq → resolver of its `closed` promise. */
  readonly #held = new Map<number, (r: 'client_gone' | 'timeout') => void>();
  /** Answered on our side but not yet confirmed by the worker: a `closed` (or a failed delivery) that crossed our `respond`
   *  still resolves the request's `closed` promise, so the loss is reported instead of reading as delivered. */
  readonly #responding = new Map<number, (r: 'client_gone' | 'timeout') => void>();
  readonly #armWaiters: { nonce: string | null; resolve: () => void; reject: (e: Error) => void }[] = [];
  #closeWaiter: (() => void) | undefined;
  #received = 0;
  #workerStats: WorkerStats = emptyWorkerStats();
  #ackEvents = 0;
  #ackBytes = 0;
  #ackScheduled = false;
  #authWindow: { startedAt: number; count: number; fired: boolean } = { startedAt: 0, count: 0, fired: false };
  #diedError: HookWorkerDied | undefined;

  /** Read through a call: `close()` may change the state while `start()` awaits. */
  #currentState(): TransportState {
    return this.#state;
  }

  constructor(o: CreateOptions, opts: NodeHookTransportOptions) {
    this.#o = o;
    this.#opts = opts;
  }

  async start(so: { sessionShortId: string; transport: 'http' | 'unix' }): Promise<HookEndpoint> {
    if (this.#state !== 'new') throw new HookTransportError('alreadyStarted', 'HookTransport.start() may be called once');
    if (!isValidSessionShortId(so.sessionShortId))
      throw new HookTransportError('badSessionShortId', 'sessionShortId must match /^[A-Za-z0-9_-]{1,64}$/');
    if (!(['http', 'unix'] as readonly string[]).includes(so.transport))
      throw new HookTransportError('badTransport', 'transport must be http or unix');
    this.#state = 'starting';
    const dir = this.#o.runtimeDir;
    try {
      await assertPrivateDir(dir);
      const socketPath = join(dir, SOCKET_NAME);
      const bytes = Buffer.byteLength(socketPath);
      if (bytes > SOCKET_PATH_MAX_BYTES) throw new SocketPathTooLong(bytes, SOCKET_PATH_MAX_BYTES);
      const unixToken = this.#o.ids.tokenHex(32);
      const httpToken = so.transport === 'http' ? this.#o.ids.tokenHex(32) : undefined;
      if (!isValidToken(unixToken) || (httpToken !== undefined && !isValidToken(httpToken)))
        throw new HookTransportError('badToken', 'IdPort.tokenHex(32) must return 64 lowercase hex characters (P-HOOK-22)');

      // D-12: the forwarder reads socket path + token from a 0600 file named in its args; the token is never in argv/env.
      const fwdConfigPath = join(dir, FWD_CONFIG_NAME);
      await writeFile(fwdConfigPath, `${JSON.stringify({ socketPath, token: unixToken })}\n`, { flag: 'wx', mode: 0o600 }).catch(
        (err: unknown) => {
          if ((err as { code?: string }).code === 'EEXIST')
            throw new HookTransportError('fwdConfigExists', `${fwdConfigPath} already exists`);
          throw err;
        },
      );
      this.#fwdConfigPath = fwdConfigPath;
      this.#socketPath = socketPath;

      const abs = performance.timeOrigin + performance.now();
      const init: WorkerInit = {
        ccd: 'hook-worker/v1',
        transport: so.transport,
        sessionShortId: so.sessionShortId,
        ...(httpToken !== undefined ? { httpToken } : {}),
        unixToken,
        socketPath,
        httpEvents: [...(this.#opts.httpEvents ?? HTTP_HOOK_EVENTS)],
        unixEvents: [...UNIX_HOOK_EVENTS],
        holdEvents: [...HOLD_HOOK_EVENTS],
        maxBodyBytes: this.#o.maxBodyBytes > 0 ? this.#o.maxBodyBytes : DEFAULT_MAX_BODY_BYTES,
        maxConnections: this.#o.maxConnections > 0 ? this.#o.maxConnections : DEFAULT_MAX_CONNECTIONS,
        maxHeld: this.#o.maxHeld >= 0 ? this.#o.maxHeld : DEFAULT_MAX_HELD,
        maxQueuedEvents: this.#opts.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS,
        maxQueuedBytes: this.#opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
        monoOffset: this.#o.clock.now() - abs,
        wallOffset: this.#o.clock.wallNow() - abs,
      };

      const ready = await this.#spawn(init);
      if (this.#currentState() !== 'starting') throw new HookTransportError('closed', 'hook transport closed during start');
      const port = ready.port;
      this.#endpoint = {
        transport: so.transport,
        ...(httpToken !== undefined && port !== null
          ? { http: { port, urlBase: `http://127.0.0.1:${port}/h/${so.sessionShortId}/`, token: httpToken } }
          : {}),
        unix: { socketPath, forwarderConfigPath: fwdConfigPath },
        forwarder: {
          nodePath: this.#opts.nodePath ?? process.execPath,
          scriptPath: this.#opts.forwarderScriptPath ?? defaultForwarderScriptPath(),
        },
      };
      if (!isAbsolute(this.#endpoint.forwarder.scriptPath) || !isAbsolute(this.#endpoint.forwarder.nodePath))
        throw new HookTransportError('relativePath', 'forwarder paths must be absolute (P-HOOK-30)');
      this.#state = 'open';
      this.#o.logger.debug('hook transport started', { transport: so.transport, httpPort: port ?? 0 });
      return this.#endpoint;
    } catch (err) {
      await this.#teardownAfterFailedStart();
      throw err;
    }
  }

  #spawn(init: WorkerInit): Promise<{ port: number | null }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(this.#opts.workerUrl ?? defaultWorkerUrl(), { workerData: init, env: {}, execArgv: [] });
      this.#worker = worker;
      worker.on('message', (m: WorkerToMain) => {
        if (!settled && m.t === 'ready') {
          settled = true;
          resolve({ port: m.port });
          return;
        }
        if (!settled && m.t === 'startError') {
          settled = true;
          const err = new HookTransportError(m.code ?? m.name, `hook worker failed to start: ${m.message}`);
          reject(err);
          return;
        }
        this.#onMessage(m);
      });
      worker.on('error', (err: Error) => {
        this.#o.logger.error('hook worker error', { message: err.message });
        if (!settled) {
          settled = true;
          reject(new HookWorkerDied(null, err.message));
        }
      });
      worker.on('exit', (code: number) => {
        if (!settled) {
          settled = true;
          reject(new HookWorkerDied(code, 'exited during start'));
          return;
        }
        this.#onExit(code);
      });
    });
  }

  #onMessage(m: WorkerToMain): void {
    switch (m.t) {
      case 'event': {
        this.#received += 1;
        const e: RawHookEvent = {
          hookSeq: m.hookSeq as HookSeq,
          at: m.at as MonoMs,
          wallAt: m.wallAt as WallMs,
          transport: m.transport,
          event: m.event,
          bytes: m.bytes,
          truncated: m.truncated,
          payload: m.payload,
          holdable: m.holdable,
        };
        if (m.holdable) {
          e.closed = new Promise<'client_gone' | 'timeout'>((resolve) => {
            this.#held.set(m.hookSeq, resolve);
          });
        }
        for (const l of [...this.#listeners]) {
          try {
            l(e);
          } catch (err) {
            this.#o.logger.warn('hook listener threw', { message: err instanceof Error ? err.message : String(err) });
          }
        }
        this.#ack(ackBytesOf(m));
        break;
      }
      case 'closed': {
        const resolve = this.#held.get(m.hookSeq) ?? this.#responding.get(m.hookSeq);
        if (resolve !== undefined) {
          this.#held.delete(m.hookSeq);
          this.#responding.delete(m.hookSeq);
          resolve(m.reason);
        }
        break;
      }
      case 'responded': {
        const resolve = this.#responding.get(m.hookSeq);
        this.#responding.delete(m.hookSeq);
        if (!m.delivered) resolve?.('client_gone');
        break;
      }
      case 'armed': {
        const i = this.#armWaiters.findIndex((w) => w.nonce === m.nonce);
        if (i >= 0) {
          const [w] = this.#armWaiters.splice(i, 1);
          w?.resolve();
        }
        break;
      }
      case 'stats': {
        const before = this.#workerStats.authFailures;
        const { t: _t, ...rest } = m;
        this.#workerStats = rest;
        if (rest.authFailures > before) this.#noteAuthFailures(rest.authFailures - before, rest.lastAuthFailure);
        break;
      }
      case 'log':
        this.#o.logger[m.level](m.msg, m.fields);
        break;
      case 'closedAll':
        this.#closeWaiter?.();
        break;
      case 'ready':
      case 'startError':
        break;
    }
  }

  /** Batched acknowledgements free the worker's bounded queue (P-HOOK-39); a stalled main thread simply stops acking. */
  #ack(bytes: number): void {
    this.#ackEvents += 1;
    this.#ackBytes += bytes;
    if (this.#ackScheduled) return;
    this.#ackScheduled = true;
    queueMicrotask(() => {
      this.#ackScheduled = false;
      const msg: MainToWorker = { t: 'ack', events: this.#ackEvents, bytes: this.#ackBytes };
      this.#ackEvents = 0;
      this.#ackBytes = 0;
      this.#post(msg);
    });
  }

  #noteAuthFailures(n: number, reason: string | undefined): void {
    const burst = this.#opts.forgeryBurst ?? { count: 5, windowMs: 10_000 };
    const now = this.#o.clock.now();
    const w = this.#authWindow;
    if (now - w.startedAt > burst.windowMs) {
      w.startedAt = now;
      w.count = 0;
      w.fired = false;
    }
    w.count += n;
    this.#o.logger.warn('hook request refused', { reason: reason ?? 'unknown', inWindow: w.count });
    if (!w.fired && w.count >= burst.count) {
      w.fired = true;
      const b: ForgeryBurst = { count: w.count, windowMs: burst.windowMs, lastReason: reason };
      for (const l of [...this.#forgeryListeners]) {
        try {
          l(b);
        } catch {
          // listener bugs never break the transport
        }
      }
    }
  }

  #onExit(code: number): void {
    const expected = this.#state === 'closing' || this.#state === 'closed';
    this.#worker = undefined;
    this.#closeWaiter?.();
    if (expected) return;
    this.#state = 'dead';
    const err = new HookWorkerDied(code);
    this.#diedError = err;
    this.#o.logger.error('hook worker died', { code });
    this.#releaseAll('client_gone');
    for (const w of this.#armWaiters.splice(0)) w.reject(err);
    for (const l of [...this.#diedListeners]) {
      try {
        l(err);
      } catch {
        // listener bugs never break the transport
      }
    }
  }

  #releaseAll(reason: 'client_gone' | 'timeout'): void {
    const all = [...this.#held.values(), ...this.#responding.values()];
    this.#held.clear();
    this.#responding.clear();
    for (const r of all) r(reason);
  }

  #post(m: MainToWorker): boolean {
    const w = this.#worker;
    if (w === undefined) return false;
    try {
      w.postMessage(m);
      return true;
    } catch {
      return false;
    }
  }

  on(l: (e: RawHookEvent) => void): Cancel {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }

  onDied(fn: (err: HookWorkerDied) => void): Cancel {
    this.#diedListeners.add(fn);
    return () => {
      this.#diedListeners.delete(fn);
    };
  }

  onForgery(fn: (b: ForgeryBurst) => void): Cancel {
    this.#forgeryListeners.add(fn);
    return () => {
      this.#forgeryListeners.delete(fn);
    };
  }

  respond(hookSeq: HookSeq, body: object | null): boolean {
    if (this.#state !== 'open') return false;
    const resolve = this.#held.get(hookSeq);
    if (resolve === undefined) return false;
    // Answered: `closed` resolves from now on only if the worker reports the forwarder gone before our answer reached it.
    this.#held.delete(hookSeq);
    this.#responding.set(hookSeq, resolve);
    let text: string | null = null;
    if (body !== null && typeof body === 'object') {
      try {
        const s = JSON.stringify(body);
        text = s === '{}' ? null : s;
      } catch (err) {
        // An unserializable decision cannot be applied; `{}` lets the native dialog appear (the human decides).
        this.#o.logger.error('hook response not serializable; answering empty', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (this.#post({ t: 'respond', hookSeq, body: text })) return true;
    this.#responding.delete(hookSeq);
    return false;
  }

  armSelfTestNonce(nonce: string | null): Promise<void> {
    if (nonce !== null && (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 256))
      return Promise.reject(new HookTransportError('badNonce', 'nonce must be a non-empty string of at most 256 characters'));
    if (this.#state === 'dead') return Promise.reject(this.#diedError ?? new HookWorkerDied(null));
    if (this.#state !== 'open') return Promise.reject(new HookTransportError('notOpen', 'hook transport is not open'));
    return new Promise<void>((resolve, reject) => {
      this.#armWaiters.push({ nonce, resolve, reject });
      if (!this.#post({ t: 'arm', nonce })) {
        this.#armWaiters.pop();
        reject(new HookWorkerDied(null, 'cannot reach the worker'));
      }
    });
  }

  async close(heldBody: object | null): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'closing') return;
    if (this.#state === 'new') {
      this.#state = 'closed';
      return;
    }
    const wasDead = this.#state === 'dead';
    this.#state = 'closing';
    const worker = this.#worker;
    if (!wasDead && worker !== undefined) {
      let text: string | null = null;
      if (heldBody !== null) {
        try {
          const s = JSON.stringify(heldBody);
          text = s === '{}' ? null : s;
        } catch {
          text = null;
        }
      }
      const done = new Promise<void>((resolve) => {
        this.#closeWaiter = resolve;
      });
      if (this.#post({ t: 'close', heldBody: text })) await done;
      this.#closeWaiter = undefined;
      await worker.terminate().catch(() => undefined);
    }
    this.#responding.clear();
    this.#held.clear(); // answered with heldBody by the worker: their `closed` promises never resolve
    for (const w of this.#armWaiters.splice(0)) w.reject(new HookTransportError('closed', 'hook transport closed'));
    await this.#removeFiles();
    this.#state = 'closed';
  }

  stats(): { received: number; dropped: number; truncated: number; authFailures: number; held: number; workerRestarts: number } {
    const w = this.#workerStats;
    return {
      received: this.#received,
      dropped: w.dropped,
      truncated: w.truncated,
      authFailures: w.authFailures,
      held: this.#held.size,
      workerRestarts: 0, // never restarted (§3.5)
    };
  }

  detailedStats(): DetailedHookStats {
    return { ...this.#workerStats, held: this.#held.size, received: this.#received };
  }

  /** Test hook (live L-13, fault "worker crash"): terminate the worker as if it had crashed. */
  async killWorkerForTest(): Promise<void> {
    await this.#worker?.terminate();
  }

  async #teardownAfterFailedStart(): Promise<void> {
    this.#state = 'closed';
    const w = this.#worker;
    this.#worker = undefined;
    if (w !== undefined) await w.terminate().catch(() => undefined);
    await this.#removeFiles();
  }

  async #removeFiles(): Promise<void> {
    if (this.#fwdConfigPath !== undefined) await unlink(this.#fwdConfigPath).catch(() => undefined);
    if (this.#socketPath !== undefined) {
      const st = await lstat(this.#socketPath).catch(() => undefined);
      if (st?.isSocket() === true) await unlink(this.#socketPath).catch(() => undefined);
    }
  }
}

/** The session dir must be a real directory we own with no group/other bits (SEC §2.5, P-HOOK-17/43). */
async function assertPrivateDir(dir: string): Promise<void> {
  if (!isAbsolute(dir)) throw new UnsafeRuntimeDir(dir, 'not absolute');
  const st = await lstat(dir).catch(() => undefined);
  if (st === undefined) throw new UnsafeRuntimeDir(dir, 'missing');
  if (st.isSymbolicLink()) throw new UnsafeRuntimeDir(dir, 'symlink');
  if (!st.isDirectory()) throw new UnsafeRuntimeDir(dir, 'not a directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new UnsafeRuntimeDir(dir, 'owned by another uid');
  if ((st.mode & 0o077) !== 0) throw new UnsafeRuntimeDir(dir, `mode ${(st.mode & 0o777).toString(8)} is not private`);
}
