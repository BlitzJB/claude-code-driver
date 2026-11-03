// platform/hook-server/http-server.ts — the loopback HTTP hook server (DESIGN.md §3.5, D-11, SEC §2.1–§2.6, HT §2.2/§6/§8/§9.4).
//
// Behaviour per request:
//   1. SEC §2.3 checks 1–5 (method, path+event, Host, Origin/Sec-Fetch-*, Content-Type, token). Failure → 403 with an empty
//      body, the socket is closed, the failure is counted (only a forger fails these; Claude always passes them).
//   2. Read the body to its end (cap; over cap: drain, discard, `truncated`). Never 413 (P-HOOK-49).
//   3. Write `200` with `Content-Length: 0` (constant: no echo, no template, P-SEC-04) — after the upload finished and before
//      parsing (rev 2 §10 G18, LP-53). The one exception is the armed self-test nonce on UserPromptSubmit, which is parsed
//      before answering and gets the constant block body (D-35).
//   4. `JSON.parse`, then hand the event to the sink. Bad JSON after a good token → already answered 200, only counted.
// `requestTimeout = 0` and `timeout = 0` (P-HOOK-60); bound to 127.0.0.1 only (P-HOOK-20); never redirects (P-HOOK-21).
//
// Loaded inside the hook worker by a computed `import()`: node:* imports and erasable syntax only (see auth.ts). The auth and
// body functions are injected by the worker for the same reason.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { HttpAuthConfig, HttpAuthResult, HttpRequestHead } from './auth.js';
import type { BodyResult } from './body.js';

export interface HookSinkEvent {
  transport: 'http' | 'unix';
  event: string;
  bytes: number;
  truncated: boolean;
  payload: unknown;
  holdable: boolean;
}

/** What the HTTP server reports to its owner (the worker). Every method must be cheap and must not throw. */
export interface HttpHookSink {
  authFailure(reason: string): void;
  /** Request accepted and answered but not forwarded (too many in flight, or the client aborted mid-upload). */
  dropped(reason: 'inFlight' | 'aborted'): void;
  badJson(): void;
  /** True when this event must be parsed before answering (the armed self-test nonce on UserPromptSubmit). */
  parseBeforeReply(event: string): boolean;
  /** The constant reply body for a parsed event: '' (empty 200) or the self-test block body. */
  replyFor(event: string, payload: unknown): string;
  /** Hands the event on; returns its hookSeq, or undefined when the bounded queue dropped it. */
  event(e: HookSinkEvent): number | undefined;
}

export interface HttpHookServerDeps {
  checkHttpRequest(head: HttpRequestHead, cfg: HttpAuthConfig): HttpAuthResult;
  readBody(stream: IncomingMessage, maxBytes: number): Promise<BodyResult>;
  tryParseJson(data: Buffer): { ok: true; value: unknown } | { ok: false };
}

export interface HttpHookServerOptions {
  sessionShortId: string;
  token: string;
  events: ReadonlySet<string>;
  maxBodyBytes: number;
  /** Concurrent requests being read; beyond it a request is drained, answered 200 empty and dropped (SEC §2.7). */
  maxInFlight: number;
  /** Hard socket cap (flood guard). Generous so Claude's own keep-alive connections are never refused. */
  maxSockets: number;
  deps: HttpHookServerDeps;
  sink: HttpHookSink;
}

export interface HttpHookServer {
  /** Binds `127.0.0.1:0` and resolves the port. */
  listen(): Promise<number>;
  readonly port: number;
  inFlight(): number;
  /** The underlying server (tests assert `requestTimeout`/`timeout` are 0 and the bind address). */
  readonly server: Server;
  /** Stops listening and destroys every connection. */
  close(): Promise<void>;
}

const FORBIDDEN_HEADERS = { 'content-length': '0', connection: 'close' } as const;

export function createHttpHookServer(o: HttpHookServerOptions): HttpHookServer {
  let port = 0;
  let inFlight = 0;
  const cfg = (): HttpAuthConfig => ({ sessionShortId: o.sessionShortId, port, token: o.token, events: o.events });

  const forbid = (req: IncomingMessage, res: ServerResponse, reason: string): void => {
    o.sink.authFailure(reason);
    res.on('finish', () => {
      req.socket.destroy();
    });
    res.writeHead(403, FORBIDDEN_HEADERS);
    res.end();
  };

  const answer = (res: ServerResponse, body: string): void => {
    if (res.headersSent || res.destroyed) return;
    if (body === '') {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const auth = o.deps.checkHttpRequest({ method: req.method, url: req.url, headers: req.headers }, cfg());
    if (!auth.ok) {
      forbid(req, res, auth.reason);
      return;
    }
    const event = auth.event;
    inFlight += 1;
    const overflow = inFlight > o.maxInFlight;
    o.deps
      .readBody(req, overflow ? 0 : o.maxBodyBytes)
      .then(
        (body) => {
          if (overflow) {
            answer(res, '');
            o.sink.dropped('inFlight');
            return;
          }
          let parsed: { ok: true; value: unknown } | { ok: false } | undefined;
          let reply = '';
          if (!body.truncated && body.data !== undefined && o.sink.parseBeforeReply(event)) {
            parsed = o.deps.tryParseJson(body.data);
            if (parsed.ok) reply = o.sink.replyFor(event, parsed.value);
          }
          answer(res, reply);
          if (body.truncated || body.data === undefined) {
            o.sink.event({ transport: 'http', event, bytes: body.bytes, truncated: true, payload: null, holdable: false });
            return;
          }
          parsed ??= o.deps.tryParseJson(body.data);
          if (!parsed.ok) {
            o.sink.badJson();
            return;
          }
          o.sink.event({ transport: 'http', event, bytes: body.bytes, truncated: false, payload: parsed.value, holdable: false });
        },
        () => {
          // The client went away mid-upload; nothing can be answered any more.
          o.sink.dropped('aborted');
          res.destroy();
        },
      )
      .catch(() => {
        // A sink bug must never leave Claude without an answer: fail open with an empty 200 (HT §4).
        answer(res, '');
      })
      .finally(() => {
        inFlight -= 1;
      });
  };

  const server: Server = createServer({ requestTimeout: 0 }, handle);
  server.requestTimeout = 0; // P-HOOK-60: long bodies / slow clients are never cut by our own server
  server.timeout = 0;
  server.maxConnections = o.maxSockets;
  server.on('clientError', (_err: Error, socket: Socket) => {
    socket.destroy(); // malformed HTTP: only a forger sends it; never answer with a body
  });

  return {
    listen(): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error): void => {
          reject(err);
        };
        server.once('error', onError);
        // P-HOOK-20 / SEC §2.1: the literal loopback address only; never reusePort (SEC §2.4).
        server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
          server.off('error', onError);
          const addr = server.address() as AddressInfo | null;
          if (addr?.address !== '127.0.0.1') {
            server.close();
            reject(new Error(`hook server bound to an unexpected address ${JSON.stringify(addr)}`));
            return;
          }
          port = addr.port;
          resolve(port);
        });
      });
    },
    get port(): number {
      return port;
    },
    server,
    inFlight(): number {
      return inFlight;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (!server.listening) {
          server.closeAllConnections();
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
