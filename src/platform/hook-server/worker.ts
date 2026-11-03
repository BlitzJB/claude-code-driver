// platform/hook-server/worker.ts — the `worker_threads` entry that hosts both hook servers (DESIGN.md §3.5, D-11, rev 2 §10 A7).
//
// Running the servers off the host event loop means a stalled host (a busy loop, a giant synchronous step) delays only our
// permission answers and our processing, never Claude's observation hook calls, whose 5 s timeout would otherwise drop them
// (P-REV-25, LV 4965 ms). The worker owns the HTTP server, the unix server, the body cap, `JSON.parse`, the self-test nonce
// check, the held PermissionRequest sockets and the bounded event queue towards the main thread (P-HOOK-39).
//
// Import rule (§1.4 3c, standalone-builtins-only): this file imports `node:*` only. The server modules it runs (auth.ts,
// body.ts, http-server.ts, unix-server.ts) import `node:*` only as well and are loaded with a computed `import()` relative to
// this file, so the worker's whole runtime closure is builtins-only, works from `dist/` without a bundler (P-API-13) and runs
// from `src/` under Node's type stripping in tests. Their shapes are restated below as `*Module` interfaces; a type test in
// test/unit/platform/hook-server.test.ts asserts each real module is assignable to its interface.
//
// Protocol (structured clone):
//   worker → main  {t:'ready', port, socketPath} | {t:'startError', …} | {t:'event', hookSeq, at, wallAt, transport, event,
//                  bytes, truncated, payload, holdable} | {t:'closed', hookSeq, reason} |
//                  {t:'responded', hookSeq, delivered} | {t:'armed', nonce} | {t:'stats', …} | {t:'log', …} | {t:'closedAll'}
// Every {t:'respond'} gets exactly one {t:'responded'}: `delivered: false` means the held request was already gone (its
// forwarder closed first; the matching {t:'closed'} was posted before it), so the main thread can still report the loss.
//   main → worker  {t:'respond', hookSeq, body: string|null} | {t:'arm', nonce|null} | {t:'close', heldBody: string|null} |
//                  {t:'ack', events, bytes}
// (`respond`/`close` bodies are serialized by the main thread, so a hostile object can never reach the worker.)
import { performance } from 'node:perf_hooks';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

/** The constant self-test answer (D-35, §3.5). The only non-empty body an observation endpoint ever writes (P-SEC-04). */
export const SELF_TEST_BLOCK_BODY = '{"decision":"block","reason":"ccd self-test"}';

export interface WorkerInit {
  ccd: 'hook-worker/v1';
  transport: 'http' | 'unix';
  sessionShortId: string;
  /** Present for transport 'http'. */
  httpToken?: string;
  unixToken: string;
  socketPath: string;
  httpEvents: string[];
  unixEvents: string[];
  holdEvents: string[];
  maxBodyBytes: number;
  maxConnections: number;
  maxHeld: number;
  maxQueuedEvents: number;
  maxQueuedBytes: number;
  /** main clock mono − (performance.timeOrigin + performance.now()) at start (§3.5 time stamping). */
  monoOffset: number;
  /** main clock wall − (performance.timeOrigin + performance.now()) at start. */
  wallOffset: number;
}

export interface WorkerStats {
  authFailures: number;
  dropped: number;
  truncated: number;
  badJson: number;
  heldOverflow: number;
  connectionOverflow: number;
  queueOverflow: number;
  held: number;
  /** Latest auth-failure reason, for the forgery-burst detector (metadata only). */
  lastAuthFailure?: string;
}

export type WorkerToMain =
  | { t: 'ready'; port: number | null; socketPath: string }
  | { t: 'startError'; name: string; message: string; code?: string }
  | {
      t: 'event';
      hookSeq: number;
      at: number;
      wallAt: number;
      transport: 'http' | 'unix';
      event: string;
      bytes: number;
      truncated: boolean;
      payload: unknown;
      holdable: boolean;
    }
  | { t: 'closed'; hookSeq: number; reason: 'client_gone' | 'timeout' }
  | { t: 'responded'; hookSeq: number; delivered: boolean }
  | { t: 'armed'; nonce: string | null }
  | ({ t: 'stats' } & WorkerStats)
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; fields?: Record<string, string | number | boolean> }
  | { t: 'closedAll' };

export type MainToWorker =
  | { t: 'respond'; hookSeq: number; body: string | null }
  | { t: 'arm'; nonce: string | null }
  | { t: 'close'; heldBody: string | null }
  | { t: 'ack'; events: number; bytes: number };

// ---- shapes of the modules loaded at runtime (kept in sync by a type test) ----
interface SinkEvent {
  transport: 'http' | 'unix';
  event: string;
  bytes: number;
  truncated: boolean;
  payload: unknown;
  holdable: boolean;
}
interface Accumulator {
  push(chunk: Buffer): void;
  readonly bytes: number;
  readonly truncated: boolean;
  concat(): Buffer | undefined;
}
type ParseResult = { ok: true; value: unknown } | { ok: false };
interface AuthHead {
  method: string | undefined;
  url: string | undefined;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}
interface AuthCfg {
  sessionShortId: string;
  port: number;
  token: string;
  events: ReadonlySet<string>;
}
export interface AuthModule {
  checkHttpRequest(head: AuthHead, cfg: AuthCfg): { ok: true; event: string } | { ok: false; reason: string };
  tokenEquals(given: string | undefined, expected: string): boolean;
}
export interface BodyModule {
  CappedAccumulator: new (maxBytes: number) => Accumulator;
  readBody(stream: Readable, maxBytes: number): Promise<{ bytes: number; truncated: boolean; data: Buffer | undefined }>;
  tryParseJson(data: Buffer): ParseResult;
}
export interface HttpServerModule {
  createHttpHookServer(o: {
    sessionShortId: string;
    token: string;
    events: ReadonlySet<string>;
    maxBodyBytes: number;
    maxInFlight: number;
    maxSockets: number;
    deps: {
      checkHttpRequest: AuthModule['checkHttpRequest'];
      readBody(stream: IncomingMessage, maxBytes: number): ReturnType<BodyModule['readBody']>;
      tryParseJson(data: Buffer): ParseResult;
    };
    sink: {
      authFailure(reason: string): void;
      dropped(reason: 'inFlight' | 'aborted'): void;
      badJson(): void;
      parseBeforeReply(event: string): boolean;
      replyFor(event: string, payload: unknown): string;
      event(e: SinkEvent): number | undefined;
    };
  }): { listen(): Promise<number>; close(): Promise<void> };
}
export interface UnixServerModule {
  createUnixHookServer(o: {
    socketPath: string;
    token: string;
    events: ReadonlySet<string>;
    holdEvents: ReadonlySet<string>;
    maxBodyBytes: number;
    maxConnections: number;
    maxHeld: number;
    deps: {
      newAccumulator(maxBytes: number): Accumulator;
      tokenEquals: AuthModule['tokenEquals'];
      tryParseJson(data: Buffer): ParseResult;
    };
    sink: {
      authFailure(reason: string): void;
      dropped(reason: 'connections' | 'event' | 'held' | 'queue'): void;
      badJson(): void;
      replyFor(event: string, payload: unknown): string;
      event(e: SinkEvent): number | undefined;
      closed(hookSeq: number, reason: 'client_gone' | 'timeout'): void;
    };
  }): {
    listen(): Promise<void>;
    respond(hookSeq: number, body: string | null): boolean;
    heldCount(): number;
    close(heldBody: string | null): Promise<void>;
  };
}

/** Bytes an event holds in the worker → main queue; the main thread acks the same amount (transport.ts). */
export function queuedBytesOf(e: { bytes: number; truncated: boolean }): number {
  return e.truncated ? 0 : e.bytes;
}

export function isWorkerInit(v: unknown): v is WorkerInit {
  return typeof v === 'object' && v !== null && (v as { ccd?: unknown }).ccd === 'hook-worker/v1';
}

/** `./<name>.js` from dist, `./<name>.ts` when this file itself runs from src under type stripping. */
async function loadSibling<T>(name: string): Promise<T> {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return (await import(new URL(`./${name}${ext}`, import.meta.url).href)) as T;
}

/**
 * Runs both servers for `init` and speaks the protocol on `port`. The worker entry below calls it with `parentPort`; tests call
 * it in-process with one end of a `MessageChannel`.
 */
export async function runWorker(init: WorkerInit, port: MessagePort): Promise<void> {
  const [auth, body, httpMod, unixMod] = await Promise.all([
    loadSibling<AuthModule>('auth'),
    loadSibling<BodyModule>('body'),
    loadSibling<HttpServerModule>('http-server'),
    loadSibling<UnixServerModule>('unix-server'),
  ]);

  const post = (m: WorkerToMain): void => {
    port.postMessage(m);
  };
  const stats: WorkerStats = {
    authFailures: 0,
    dropped: 0,
    truncated: 0,
    badJson: 0,
    heldOverflow: 0,
    connectionOverflow: 0,
    queueOverflow: 0,
    held: 0,
  };
  const postStats = (): void => {
    stats.held = unix.heldCount();
    post({ t: 'stats', ...stats });
  };

  let seq = 0;
  let nonce: string | null = null;
  let queuedEvents = 0;
  let queuedBytes = 0;

  const stamp = (): { at: number; wallAt: number } => {
    const abs = performance.timeOrigin + performance.now();
    return { at: abs + init.monoOffset, wallAt: abs + init.wallOffset };
  };

  /**
   * Bounded hand-off to the main thread: over the cap the event is dropped and counted; Claude was already answered. The byte
   * budget counts what the message carries (a truncated event has a null payload, so it costs 0, see `queuedBytesOf`, and is
   * bounded by the event count only), and an empty queue always accepts one event, so a single large payload is never dropped
   * for its size alone.
   */
  const forward = (e: SinkEvent): number | undefined => {
    const cost = queuedBytesOf(e);
    if (queuedEvents >= init.maxQueuedEvents || (cost > 0 && queuedEvents > 0 && queuedBytes + cost > init.maxQueuedBytes)) {
      stats.dropped += 1;
      stats.queueOverflow += 1;
      postStats();
      return undefined;
    }
    seq += 1;
    queuedEvents += 1;
    queuedBytes += cost;
    if (e.truncated) {
      stats.truncated += 1;
      postStats();
    }
    post({ t: 'event', hookSeq: seq, ...stamp(), ...e });
    return seq;
  };

  const isNoncePrompt = (event: string, payload: unknown): boolean =>
    nonce !== null &&
    event === 'UserPromptSubmit' &&
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { prompt?: unknown }).prompt === nonce;

  const replyFor = (event: string, payload: unknown): string => (isNoncePrompt(event, payload) ? SELF_TEST_BLOCK_BODY : '');
  const authFailure = (reason: string): void => {
    stats.authFailures += 1;
    stats.lastAuthFailure = reason;
    postStats();
  };
  const badJson = (): void => {
    stats.badJson += 1;
    postStats();
  };

  const unix = unixMod.createUnixHookServer({
    socketPath: init.socketPath,
    token: init.unixToken,
    events: new Set(init.unixEvents),
    holdEvents: new Set(init.holdEvents),
    maxBodyBytes: init.maxBodyBytes,
    maxConnections: init.maxConnections,
    maxHeld: init.maxHeld,
    deps: {
      newAccumulator: (n) => new body.CappedAccumulator(n),
      tokenEquals: (given, expected) => auth.tokenEquals(given, expected),
      tryParseJson: (data) => body.tryParseJson(data),
    },
    sink: {
      authFailure,
      dropped: (reason) => {
        stats.dropped += 1;
        if (reason === 'held') stats.heldOverflow += 1;
        if (reason === 'connections') stats.connectionOverflow += 1;
        postStats();
      },
      badJson,
      replyFor,
      event: (e) => {
        const s = forward(e);
        if (e.holdable) postStats();
        return s;
      },
      closed: (hookSeq, reason) => {
        post({ t: 'closed', hookSeq, reason });
        postStats();
      },
    },
  });

  const http =
    init.transport === 'http' && init.httpToken !== undefined
      ? httpMod.createHttpHookServer({
          sessionShortId: init.sessionShortId,
          token: init.httpToken,
          events: new Set(init.httpEvents),
          maxBodyBytes: init.maxBodyBytes,
          maxInFlight: init.maxConnections,
          maxSockets: init.maxConnections * 4,
          deps: {
            checkHttpRequest: (head, cfg) => auth.checkHttpRequest(head, cfg),
            readBody: (stream, maxBytes) => body.readBody(stream, maxBytes),
            tryParseJson: (data) => body.tryParseJson(data),
          },
          sink: {
            authFailure,
            dropped: () => {
              stats.dropped += 1;
              postStats();
            },
            badJson,
            parseBeforeReply: (event) => nonce !== null && event === 'UserPromptSubmit',
            replyFor,
            event: forward,
          },
        })
      : undefined;

  let closing = false;
  port.on('message', (m: MainToWorker) => {
    switch (m.t) {
      case 'ack':
        queuedEvents = Math.max(0, queuedEvents - m.events);
        queuedBytes = Math.max(0, queuedBytes - m.bytes);
        break;
      case 'respond': {
        // A forwarder that went away just before our answer reached the worker (its 'closed' crossed this message) must not
        // read as answered: report the failure so the main thread still resolves `closed` for it.
        const delivered = unix.respond(m.hookSeq, m.body);
        post({ t: 'responded', hookSeq: m.hookSeq, delivered });
        postStats();
        break;
      }
      case 'arm':
        nonce = m.nonce;
        post({ t: 'armed', nonce });
        break;
      case 'close':
        if (closing) break;
        closing = true;
        void Promise.allSettled([unix.close(m.heldBody), http?.close()]).then(() => {
          postStats();
          post({ t: 'closedAll' });
          port.close();
        });
        break;
    }
  });

  try {
    const httpPort = http === undefined ? null : await http.listen();
    await unix.listen();
    post({ t: 'ready', port: httpPort, socketPath: init.socketPath });
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    await Promise.allSettled([unix.close(null), http?.close()]);
    post({
      t: 'startError',
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : String(err),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
    });
    port.close();
  }
}

if (!isMainThread && parentPort !== null && isWorkerInit(workerData)) {
  const port = parentPort;
  runWorker(workerData, port).catch((err: unknown) => {
    port.postMessage({ t: 'startError', name: 'Error', message: err instanceof Error ? err.message : String(err) } satisfies WorkerToMain);
    port.close();
  });
}
