// test/unit/platform/hook-server.test.ts — WP-03 hook server units (DESIGN.md §3.5, §5.4 P-HOOK-*, P-SEC-02/04/27,
// P-REV-25/47, P-LIVE-03, P-LIFE-43). The server modules are exercised in-process (with the real auth/body functions injected,
// as the worker does), the transport with its real worker thread.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createConnection } from 'node:net';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MessageChannel } from 'node:worker_threads';
import ts from 'typescript';
import { afterAll, afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as authModule from '../../../src/platform/hook-server/auth.js';
import { checkHttpRequest, isValidSessionShortId, isValidToken, tokenEquals } from '../../../src/platform/hook-server/auth.js';
import type { HttpAuthConfig } from '../../../src/platform/hook-server/auth.js';
import * as bodyModule from '../../../src/platform/hook-server/body.js';
import { CappedAccumulator, DEFAULT_MAX_BODY_BYTES, readBody, tryParseJson } from '../../../src/platform/hook-server/body.js';
import { HookTransportError, HookWorkerDied, SocketPathTooLong, UnsafeRuntimeDir } from '../../../src/platform/hook-server/errors.js';
import { createFakeHookTransportFactory } from '../../../src/platform/hook-server/fake-hooks.js';
import * as httpModule from '../../../src/platform/hook-server/http-server.js';
import { createHttpHookServer } from '../../../src/platform/hook-server/http-server.js';
import type { HookSinkEvent, HttpHookServer, HttpHookSink } from '../../../src/platform/hook-server/http-server.js';
import {
  ackBytesOf,
  createNodeHookTransportFactory,
  HTTP_HOOK_EVENTS,
  SOCKET_PATH_MAX_BYTES,
} from '../../../src/platform/hook-server/transport.js';
import type { NodeHookTransport } from '../../../src/platform/hook-server/transport.js';
import * as unixModule from '../../../src/platform/hook-server/unix-server.js';
import { createUnixHookServer, UNIX_REQUEST_RE } from '../../../src/platform/hook-server/unix-server.js';
import type { UnixHookServer, UnixHookSink } from '../../../src/platform/hook-server/unix-server.js';
import type {
  AuthModule,
  BodyModule,
  HttpServerModule,
  MainToWorker,
  UnixServerModule,
  WorkerInit,
  WorkerToMain,
} from '../../../src/platform/hook-server/worker.js';
import { isWorkerInit, queuedBytesOf, runWorker, SELF_TEST_BLOCK_BODY } from '../../../src/platform/hook-server/worker.js';
import type { HookEndpoint, RawHookEvent } from '../../../src/platform/ports.js';
import {
  buildHookServerDist,
  HOOK_SRC,
  httpHook,
  memLogger,
  privateDir,
  realClock,
  realIds,
  unixHook,
} from '../../contract/hooks.contract.helpers.js';

const TOKEN = 'a'.repeat(64);
const dist = buildHookServerDist();
afterAll(() => {
  dist.remove();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auth: SEC §2.3 request checks (P-SEC-02, P-HOOK-41)', () => {
  const cfg: HttpAuthConfig = { sessionShortId: 's1', port: 4242, token: TOKEN, events: new Set(['Stop', 'PreToolUse']) };
  const ok = {
    method: 'POST',
    url: '/h/s1/Stop',
    headers: { host: '127.0.0.1:4242', 'content-type': 'application/json', 'x-ccd-token': TOKEN },
  };

  it('accepts exactly the request Claude sends', () => {
    expect(checkHttpRequest(ok, cfg)).toEqual({ ok: true, event: 'Stop' });
    expect(checkHttpRequest({ ...ok, headers: { ...ok.headers, 'content-type': 'Application/JSON; charset=utf-8' } }, cfg)).toEqual({
      ok: true,
      event: 'Stop',
    });
  });

  it.each([
    ['method', { ...ok, method: 'GET' }],
    ['method', { ...ok, method: 'OPTIONS' }],
    ['path', { ...ok, url: '/h/s2/Stop' }],
    ['path', { ...ok, url: '/h/s1/Stop?x=1' }],
    ['path', { ...ok, url: '/h/s1/Stop/' }],
    ['path', { ...ok, url: '/x' }],
    ['event', { ...ok, url: '/h/s1/PermissionRequest' }],
    ['host', { ...ok, headers: { ...ok.headers, host: 'localhost:4242' } }],
    ['host', { ...ok, headers: { ...ok.headers, host: 'evil.example:4242' } }],
    ['host', { ...ok, headers: { ...ok.headers, host: undefined } }],
    ['origin', { ...ok, headers: { ...ok.headers, origin: 'http://evil.example' } }],
    ['origin', { ...ok, headers: { ...ok.headers, 'sec-fetch-site': 'cross-site' } }],
    ['contentType', { ...ok, headers: { ...ok.headers, 'content-type': 'text/plain' } }],
    ['contentType', { ...ok, headers: { ...ok.headers, 'content-type': undefined } }],
    ['token', { ...ok, headers: { ...ok.headers, 'x-ccd-token': 'b'.repeat(64) } }],
    ['token', { ...ok, headers: { ...ok.headers, 'x-ccd-token': TOKEN.slice(1) } }],
    ['token', { ...ok, headers: { ...ok.headers, 'x-ccd-token': [TOKEN, TOKEN] } }],
    ['token', { ...ok, headers: { ...ok.headers, 'x-ccd-token': undefined } }],
  ])('refuses with reason %s', (reason, head) => {
    expect(checkHttpRequest(head, cfg)).toEqual({ ok: false, reason });
  });

  it('reports the first failing check in SEC §2.3 order', () => {
    const bad = { method: 'GET', url: '/nope', headers: { host: 'x', origin: 'o' } };
    expect(checkHttpRequest(bad, cfg)).toEqual({ ok: false, reason: 'method' });
    expect(checkHttpRequest({ ...bad, method: 'POST' }, cfg)).toEqual({ ok: false, reason: 'path' });
    expect(checkHttpRequest({ ...bad, method: 'POST', url: '/h/s1/Stop' }, cfg)).toEqual({ ok: false, reason: 'host' });
  });

  it('tokenEquals is a length-checked constant-time compare; tokens are hex only (P-HOOK-22)', () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
    expect(tokenEquals(TOKEN.toUpperCase(), TOKEN)).toBe(false);
    expect(tokenEquals('', '')).toBe(false);
    expect(tokenEquals(undefined, TOKEN)).toBe(false);
    expect(isValidToken(TOKEN)).toBe(true);
    expect(isValidToken(`$${TOKEN.slice(1)}`)).toBe(false);
    expect(isValidToken('ab')).toBe(false);
    expect(isValidSessionShortId('s1a2')).toBe(true);
    expect(isValidSessionShortId('../x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('body: streamed with a cap and a truncation flag (P-HOOK-48/49)', () => {
  it('CappedAccumulator keeps up to the cap, then only counts', () => {
    const a = new CappedAccumulator(5);
    a.push(Buffer.from('abc'));
    expect(a.concat()?.toString()).toBe('abc');
    a.push(Buffer.from('de'));
    expect(a.concat()?.toString()).toBe('abcde');
    a.push(Buffer.from('f'));
    expect(a.truncated).toBe(true);
    expect(a.concat()).toBeUndefined();
    a.push(Buffer.from('ghij'));
    expect(a.bytes).toBe(10);
  });

  it('readBody resolves after the end of the stream with the data or the truncation flag', async () => {
    expect(await readBody(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]), 100)).toEqual({
      bytes: 7,
      truncated: false,
      data: Buffer.from('{"a":1}'),
    });
    expect(await readBody(Readable.from([Buffer.from('x'.repeat(50))]), 10)).toEqual({ bytes: 50, truncated: true, data: undefined });
  });

  it('readBody rejects when the client aborts', async () => {
    const r = new Readable({ read: () => undefined });
    const p = readBody(r, 100);
    r.destroy(new Error('boom'));
    await expect(p).rejects.toThrow();
  });

  it('tryParseJson never throws; default cap is 32 MiB', () => {
    expect(tryParseJson(Buffer.from('{"a":[1]}'))).toEqual({ ok: true, value: { a: [1] } });
    expect(tryParseJson('{nope')).toEqual({ ok: false });
    expect(DEFAULT_MAX_BODY_BYTES).toBe(32 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
interface CapturingSink extends HttpHookSink {
  events: HookSinkEvent[];
  authFailures: string[];
  drops: string[];
  bad: number;
  nonce: string | null;
}
function httpSink(): CapturingSink {
  const s: CapturingSink = {
    events: [],
    authFailures: [],
    drops: [],
    bad: 0,
    nonce: null,
    authFailure: (r) => s.authFailures.push(r),
    dropped: (r) => s.drops.push(r),
    badJson: () => {
      s.bad += 1;
    },
    parseBeforeReply: (e) => s.nonce !== null && e === 'UserPromptSubmit',
    replyFor: (e, p) =>
      s.nonce !== null && e === 'UserPromptSubmit' && (p as { prompt?: unknown } | null)?.prompt === s.nonce ? SELF_TEST_BLOCK_BODY : '',
    event: (e) => {
      s.events.push(e);
      return s.events.length;
    },
  };
  return s;
}

async function startHttp(
  o: { maxBodyBytes?: number; maxInFlight?: number } = {},
): Promise<{ srv: HttpHookServer; sink: CapturingSink; ep: HookEndpoint }> {
  const sink = httpSink();
  const srv = createHttpHookServer({
    sessionShortId: 's1',
    token: TOKEN,
    events: new Set(HTTP_HOOK_EVENTS),
    maxBodyBytes: o.maxBodyBytes ?? 1024 * 1024,
    maxInFlight: o.maxInFlight ?? 64,
    maxSockets: 256,
    deps: { checkHttpRequest, readBody, tryParseJson },
    sink,
  });
  const port = await srv.listen();
  cleanups.push(() => srv.close());
  const ep: HookEndpoint = {
    transport: 'http',
    http: { port, urlBase: `http://127.0.0.1:${port}/h/s1/`, token: TOKEN },
    unix: { socketPath: '/nonexistent/h.sock', forwarderConfigPath: '/nonexistent/fwd.json' },
    forwarder: { nodePath: process.execPath, scriptPath: '/nonexistent/forward.js' },
  };
  return { srv, sink, ep };
}

function rawResponse(port: number, head: string, bodyParts: string[], gapMs = 0): Promise<{ text: string; firstByteBeforeEnd: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    let text = '';
    let ended = false;
    let firstByteBeforeEnd = false;
    sock.on('data', (c: Buffer) => {
      if (!ended && text === '') firstByteBeforeEnd = true;
      text += c.toString();
    });
    sock.on('close', () => {
      resolve({ text, firstByteBeforeEnd });
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(head);
      const send = (i: number): void => {
        const part = bodyParts[i];
        if (part === undefined) {
          ended = true;
          sock.end();
          return;
        }
        sock.write(part);
        if (i === bodyParts.length - 1) ended = true; // the whole body is on the wire now
        setTimeout(() => {
          send(i + 1);
        }, gapMs);
      };
      send(0);
    });
  });
}

describe('http-server (P-HOOK-20/21/23/34/39/41/49/60, P-SEC-04, P-LIVE-03)', () => {
  it('binds 127.0.0.1 only, with requestTimeout = 0 and timeout = 0', async () => {
    const { srv } = await startHttp();
    expect((srv.server.address() as { address: string }).address).toBe('127.0.0.1');
    expect(srv.server.requestTimeout).toBe(0);
    expect(srv.server.timeout).toBe(0);
  });

  it('answers a constant empty 200 (Content-Length 0, no Content-Type, no CORS) and only then forwards the parsed event', async () => {
    const { ep, sink } = await startHttp();
    const PRE_BODY = '{"tool_name":"Bash","additionalContext":"echo me"}';
    const res = await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: ep.http?.port,
          method: 'POST',
          path: '/h/s1/PreToolUse',
          headers: { 'content-type': 'application/json', 'x-ccd-token': TOKEN },
          agent: false,
        },
        (r) => {
          let b = '';
          r.on('data', (c: Buffer) => (b += c.toString()));
          r.on('end', () => {
            resolve({ status: r.statusCode ?? 0, headers: r.headers, body: b });
          });
        },
      );
      req.on('error', reject);
      req.end(PRE_BODY);
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-length']).toBe('0');
    expect(res.headers['content-type']).toBeUndefined();
    expect(Object.keys(res.headers).some((h) => h.startsWith('access-control'))).toBe(false);
    expect(sink.events).toEqual([
      {
        transport: 'http',
        event: 'PreToolUse',
        bytes: Buffer.byteLength(PRE_BODY),
        truncated: false,
        payload: { tool_name: 'Bash', additionalContext: 'echo me' },
        holdable: false,
      },
    ]);
  });

  it('writes the 200 only after the whole body was received (rev 2 §10 G18)', async () => {
    const { ep } = await startHttp();
    const body = '{"a":"' + 'x'.repeat(100) + '"}';
    const head = `POST /h/s1/Stop HTTP/1.1\r\nHost: 127.0.0.1:${ep.http?.port}\r\nContent-Type: application/json\r\nX-CCD-Token: ${TOKEN}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    const r = await rawResponse(ep.http?.port ?? 0, head, [body.slice(0, 40), body.slice(40)], 150);
    expect(r.text.startsWith('HTTP/1.1 200')).toBe(true);
    expect(r.firstByteBeforeEnd).toBe(false);
  });

  it('refuses forged requests with an empty 403 and closes the connection; nothing is forwarded', async () => {
    const { ep, sink } = await startHttp();
    const forged = [
      httpHook(ep, 'Stop', '{}', { headers: { 'x-ccd-token': 'f'.repeat(64) } }),
      httpHook(ep, 'Stop', '{}', { headers: { host: 'localhost' } }),
      httpHook(ep, 'Stop', '{}', { headers: { origin: 'http://evil' } }),
      httpHook(ep, 'Stop', '{}', { headers: { 'content-type': 'text/plain' } }),
      httpHook(ep, 'Stop', '{}', { method: 'OPTIONS' }),
      httpHook(ep, 'WorktreeCreate', '{}'),
    ];
    for (const f of forged) expect(await f.reply).toEqual({ status: 403, body: '' });
    expect(sink.authFailures).toEqual(['token', 'host', 'origin', 'contentType', 'method', 'event']);
    expect(sink.events).toHaveLength(0);
  });

  it('a body over the cap is drained and answered 200 empty, reported truncated (never 413)', async () => {
    const { ep, sink } = await startHttp({ maxBodyBytes: 1000 });
    const big = JSON.stringify({ big: 'y'.repeat(50_000) });
    const r = await httpHook(ep, 'PostToolUse', big).reply;
    expect(r).toEqual({ status: 200, body: '' });
    expect(sink.events).toEqual([
      { transport: 'http', event: 'PostToolUse', bytes: big.length, truncated: true, payload: null, holdable: false },
    ]);
  });

  it('authenticated bad JSON: 200 empty, counted, no event', async () => {
    const { ep, sink } = await startHttp();
    expect(await httpHook(ep, 'Stop', '{"oops').reply).toEqual({ status: 200, body: '' });
    expect(sink.bad).toBe(1);
    expect(sink.events).toHaveLength(0);
  });

  it('self-test nonce: parsed before answering, constant block body only for the exact prompt', async () => {
    const { ep, sink } = await startHttp();
    sink.nonce = 'ccd-selftest-n1';
    expect(await httpHook(ep, 'UserPromptSubmit', '{"prompt":"ccd-selftest-n1"}').reply).toEqual({
      status: 200,
      body: SELF_TEST_BLOCK_BODY,
    });
    expect(await httpHook(ep, 'UserPromptSubmit', '{"prompt":"other"}').reply).toEqual({ status: 200, body: '' });
    expect(await httpHook(ep, 'Stop', '{"prompt":"ccd-selftest-n1"}').reply).toEqual({ status: 200, body: '' });
    expect(sink.events).toHaveLength(3);
  });

  it('too many requests in flight: the excess is drained, answered 200 empty and dropped (bounded, P-HOOK-39)', async () => {
    const { srv, ep, sink } = await startHttp({ maxInFlight: 1 });
    const port = ep.http?.port ?? 0;
    const body = '{"slow":true}';
    const head = `POST /h/s1/Stop HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nX-CCD-Token: ${TOKEN}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    const slow = rawResponse(port, head, [body.slice(0, 3), body.slice(3)], 300);
    await vi.waitFor(() => {
      expect(srv.inFlight()).toBe(1);
    });
    expect(await httpHook(ep, 'Stop', '{"fast":true}').reply).toEqual({ status: 200, body: '' });
    expect(sink.drops).toEqual(['inFlight']);
    expect((await slow).text.startsWith('HTTP/1.1 200')).toBe(true);
    expect(sink.events.map((e) => e.payload)).toEqual([{ slow: true }]);
  });

  it('a client that aborts mid-upload is counted as dropped and never forwarded', async () => {
    const { ep, sink } = await startHttp();
    const port = ep.http?.port ?? 0;
    const sock = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((r) => sock.on('connect', r));
    sock.write(
      `POST /h/s1/Stop HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nX-CCD-Token: ${TOKEN}\r\nContent-Length: 100\r\n\r\n{"a":`,
    );
    await new Promise((r) => setTimeout(r, 50));
    sock.destroy();
    await vi.waitFor(() => {
      expect(sink.drops).toEqual(['aborted']);
    });
    expect(sink.events).toHaveLength(0);
  });

  it('latency: 200 small sequential requests answered fast (P-HOOK-34, P-LIVE-03)', async () => {
    const { ep } = await startHttp();
    const lat: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t0 = performance.now();
      await httpHook(ep, 'MessageDisplay', `{"i":${i}}`).reply;
      lat.push(performance.now() - t0);
    }
    lat.sort((a, b) => a - b);
    expect(lat[Math.floor(lat.length * 0.95)]).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
interface CapturingUnixSink extends UnixHookSink {
  events: HookSinkEvent[];
  authFailures: string[];
  drops: string[];
  closedSeqs: [number, string][];
  bad: number;
}
function unixSink(): CapturingUnixSink {
  const s: CapturingUnixSink = {
    events: [],
    authFailures: [],
    drops: [],
    closedSeqs: [],
    bad: 0,
    authFailure: (r) => s.authFailures.push(r),
    dropped: (r) => s.drops.push(r),
    badJson: () => {
      s.bad += 1;
    },
    replyFor: () => '',
    event: (e) => {
      s.events.push(e);
      return s.events.length;
    },
    closed: (seq, reason) => s.closedSeqs.push([seq, reason]),
  };
  return s;
}

async function startUnix(o: { maxConnections?: number; maxHeld?: number } = {}): Promise<{
  srv: UnixHookServer;
  sink: CapturingUnixSink;
  socketPath: string;
  dir: string;
}> {
  const d = privateDir();
  cleanups.push(d.remove);
  const socketPath = join(d.dir, 'h.sock');
  const sink = unixSink();
  const srv = createUnixHookServer({
    socketPath,
    token: TOKEN,
    events: new Set(['SessionStart', 'PermissionRequest', 'Stop']),
    holdEvents: new Set(['PermissionRequest']),
    maxBodyBytes: 1024 * 1024,
    maxConnections: o.maxConnections ?? 64,
    maxHeld: o.maxHeld ?? 32,
    deps: { newAccumulator: (n) => new CappedAccumulator(n), tokenEquals, tryParseJson },
    sink,
  });
  await srv.listen();
  cleanups.push(() => srv.close(null));
  return { srv, sink, socketPath, dir: d.dir };
}

function unixRaw(socketPath: string, data: string, o: { end?: boolean } = {}): { reply: Promise<string>; sock: Socket } {
  const sock = connect(socketPath);
  const reply = new Promise<string>((resolve) => {
    let buf = '';
    sock.on('data', (c: Buffer) => (buf += c.toString()));
    sock.on('close', () => {
      resolve(buf);
    });
    sock.on('error', () => {
      resolve(buf);
    });
  });
  sock.on('connect', () => {
    if (o.end === true) sock.end(data);
    else sock.write(data);
  });
  return { reply, sock };
}
const line = (event: string, payload: string, token = TOKEN): string =>
  `{"v":1,"token":"${token}","event":"${event}","payload":${payload}}\n`;

describe('unix-server (P-HOOK-40/43/60, P-SEC-27)', () => {
  it('creates the socket 0600 (whatever the umask) and refuses to replace a non-socket file', async () => {
    const { socketPath } = await startUnix();
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    const d = privateDir();
    cleanups.push(d.remove);
    const p = join(d.dir, 'h.sock');
    writeFileSync(p, 'not a socket');
    const srv = createUnixHookServer({
      socketPath: p,
      token: TOKEN,
      events: new Set(),
      holdEvents: new Set(),
      maxBodyBytes: 10,
      maxConnections: 1,
      maxHeld: 1,
      deps: { newAccumulator: (n) => new CappedAccumulator(n), tokenEquals, tryParseJson },
      sink: unixSink(),
    });
    await expect(srv.listen()).rejects.toThrow(/non-socket/);
    expect(readFileSync(p, 'utf8')).toBe('not a socket');
    await srv.close(null); // the cleanup after a failed start must not delete the file it refused to replace
    expect(readFileSync(p, 'utf8')).toBe('not a socket');
  });

  it('unlinks a stale socket left by a dead process before listening', async () => {
    const d = privateDir();
    cleanups.push(d.remove);
    const p = join(d.dir, 'h.sock');
    spawnSync(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(p)}, () => process.kill(process.pid, 'SIGKILL'))`,
    ]);
    expect(lstatSync(p).isSocket()).toBe(true);
    const srv = createUnixHookServer({
      socketPath: p,
      token: TOKEN,
      events: new Set(['Stop']),
      holdEvents: new Set(),
      maxBodyBytes: 1000,
      maxConnections: 4,
      maxHeld: 1,
      deps: { newAccumulator: (n) => new CappedAccumulator(n), tokenEquals, tryParseJson },
      sink: unixSink(),
    });
    await srv.listen();
    cleanups.push(() => srv.close(null));
    expect((await unixRaw(p, line('Stop', '{}')).reply).trim()).toBe('{}');
  });

  it('bad prefix or bad token: no reply, connection destroyed, counted; unknown event: {} and dropped', async () => {
    const { socketPath, sink } = await startUnix();
    expect(await unixRaw(socketPath, '{"hello":1}\n').reply).toBe('');
    expect(await unixRaw(socketPath, line('Stop', '{}', 'b'.repeat(64))).reply).toBe('');
    expect(await unixRaw(socketPath, `${'z'.repeat(400)}\n`).reply).toBe('');
    expect(sink.authFailures).toEqual(['format', 'token', 'format']);
    expect((await unixRaw(socketPath, line('WorktreeCreate', '{}')).reply).trim()).toBe('{}');
    expect(sink.drops).toEqual(['event']);
    expect(sink.events).toHaveLength(0);
  });

  it('a request ended without a newline (half-close) is still processed; trailing whitespace is fine', async () => {
    const { socketPath, sink } = await startUnix();
    expect((await unixRaw(socketPath, line('Stop', '{"a":1}  ').trimEnd(), { end: true }).reply).trim()).toBe('{}');
    expect(sink.events).toEqual([{ transport: 'unix', event: 'Stop', bytes: 9, truncated: false, payload: { a: 1 }, holdable: false }]);
  });

  it('holds PermissionRequest; respond() answers once; client gone → closed client_gone; respond after that is false', async () => {
    const { srv, socketPath, sink } = await startUnix();
    const c = unixRaw(socketPath, line('PermissionRequest', '{"tool_name":"Bash"}'));
    await vi.waitFor(() => {
      expect(srv.heldCount()).toBe(1);
    });
    expect(srv.respond(1, '{"x":1}')).toBe(true);
    expect(srv.respond(1, '{"x":2}')).toBe(false);
    expect((await c.reply).trim()).toBe('{"x":1}');
    const c2 = unixRaw(socketPath, line('PermissionRequest', '{}'));
    await vi.waitFor(() => {
      expect(srv.heldCount()).toBe(1);
    });
    c2.sock.destroy();
    await vi.waitFor(() => {
      expect(sink.closedSeqs).toEqual([[2, 'client_gone']]);
    });
    expect(srv.respond(2, '{}')).toBe(false);
  });

  it("respond() on a held socket destroyed before its 'close' ran still reports closed (answer lost, not silent)", async () => {
    const { srv, socketPath, sink } = await startUnix();
    const c = unixRaw(socketPath, line('PermissionRequest', '{}'));
    await vi.waitFor(() => {
      expect(srv.heldCount()).toBe(1);
    });
    // The forwarder half-closes: the server destroys its side in 'end'; we answer in the gap before 'close' fires.
    const results: boolean[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-invoked with the right `this` below
    const orig = Socket.prototype.destroy;
    const spy = vi.spyOn(Socket.prototype, 'destroy').mockImplementation(function (this: Socket, err?: Error) {
      const r = orig.call(this, err);
      if (results.length === 0 && srv.heldCount() === 1) results.push(srv.respond(1, '{"x":1}'));
      return r;
    });
    try {
      c.sock.end();
      await vi.waitFor(() => {
        expect(results).toEqual([false]);
      });
    } finally {
      spy.mockRestore();
    }
    await c.reply;
    await new Promise((r) => setImmediate(r));
    expect(sink.closedSeqs).toEqual([[1, 'client_gone']]);
  });

  it('connections beyond maxConnections are answered {} at once and dropped', async () => {
    const { socketPath, sink } = await startUnix({ maxConnections: 2 });
    const a = unixRaw(socketPath, line('PermissionRequest', '{}'));
    const b = unixRaw(socketPath, line('PermissionRequest', '{}'));
    await vi.waitFor(() => {
      expect(sink.events).toHaveLength(2);
    });
    expect((await unixRaw(socketPath, line('Stop', '{}')).reply).trim()).toBe('{}');
    expect(sink.drops).toEqual(['connections']);
    a.sock.destroy();
    b.sock.destroy();
  });

  it('close(heldBody) answers held requests and unlinks the socket', async () => {
    const { srv, socketPath } = await startUnix();
    const c = unixRaw(socketPath, line('PermissionRequest', '{}'));
    await vi.waitFor(() => {
      expect(srv.heldCount()).toBe(1);
    });
    await srv.close('{"deny":true}');
    expect((await c.reply).trim()).toBe('{"deny":true}');
    expect(existsSync(socketPath)).toBe(false);
  });

  it('the request prefix regex matches what the forwarder builds', () => {
    expect(UNIX_REQUEST_RE.test(line('Stop', '{}'))).toBe(true);
    expect(UNIX_REQUEST_RE.test(line('Stop', '{}', 'G'.repeat(64)))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('worker closure is builtins-only and the runtime-loaded module shapes match (§1.4 3c, P-API-13)', () => {
  it('auth/body/http-server/unix-server import only node:* at runtime (type-only imports are erased)', () => {
    for (const f of ['auth', 'body', 'http-server', 'unix-server', 'worker']) {
      const sf = ts.createSourceFile(`${f}.ts`, readFileSync(join(HOOK_SRC, `${f}.ts`), 'utf8'), ts.ScriptTarget.ES2023, true);
      const runtime: string[] = [];
      sf.forEachChild((n) => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
          const typeOnly = n.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
          if (!typeOnly && !n.moduleSpecifier.text.startsWith('node:')) runtime.push(n.moduleSpecifier.text);
        }
        if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) runtime.push('re-export');
      });
      expect({ f, runtime }).toEqual({ f, runtime: [] });
    }
  });

  it('the real modules satisfy the interfaces worker.ts loads them by', () => {
    expectTypeOf(authModule).toExtend<AuthModule>();
    expectTypeOf(bodyModule).toExtend<BodyModule>();
    expectTypeOf(httpModule).toExtend<HttpServerModule>();
    expectTypeOf(unixModule).toExtend<UnixServerModule>();
    expect(typeof unixModule.createUnixHookServer).toBe('function');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('worker protocol, run in-process over a MessageChannel', () => {
  async function startWorker(o: Partial<WorkerInit> = {}): Promise<{
    msgs: WorkerToMain[];
    send: (m: MainToWorker) => void;
    init: WorkerInit;
    ready: Extract<WorkerToMain, { t: 'ready' }>;
  }> {
    const d = privateDir();
    cleanups.push(d.remove);
    const ch = new MessageChannel();
    const msgs: WorkerToMain[] = [];
    ch.port2.on('message', (m: WorkerToMain) => msgs.push(m));
    cleanups.push(() => {
      ch.port2.close();
    });
    const init: WorkerInit = {
      ccd: 'hook-worker/v1',
      transport: 'http',
      sessionShortId: 'sW',
      httpToken: TOKEN,
      unixToken: 'd'.repeat(64),
      socketPath: join(d.dir, 'h.sock'),
      httpEvents: [...HTTP_HOOK_EVENTS],
      unixEvents: ['SessionStart', 'PermissionRequest', 'Stop'],
      holdEvents: ['PermissionRequest'],
      maxBodyBytes: 1024 * 1024,
      maxConnections: 8,
      maxHeld: 4,
      maxQueuedEvents: 100,
      maxQueuedBytes: 1024 * 1024,
      monoOffset: 1_000_000,
      wallOffset: 0,
      ...o,
    };
    await runWorker(init, ch.port1);
    await vi.waitFor(() => {
      expect(msgs.some((m) => m.t === 'ready' || m.t === 'startError')).toBe(true);
    });
    const ready = msgs.find((m) => m.t === 'ready');
    if (ready?.t !== 'ready') throw new Error(`worker did not start: ${JSON.stringify(msgs)}`);
    cleanups.push(async () => {
      if (!msgs.some((m) => m.t === 'closedAll')) {
        ch.port2.postMessage({ t: 'close', heldBody: null } satisfies MainToWorker);
        await vi.waitFor(() => {
          expect(msgs.some((m) => m.t === 'closedAll')).toBe(true);
        });
      }
    });
    return {
      msgs,
      send: (m) => {
        ch.port2.postMessage(m);
      },
      init,
      ready,
    };
  }
  const epFor = (init: WorkerInit, port: number): HookEndpoint => ({
    transport: init.transport,
    http: { port, urlBase: `http://127.0.0.1:${port}/h/${init.sessionShortId}/`, token: TOKEN },
    unix: { socketPath: init.socketPath, forwarderConfigPath: '/unused' },
    forwarder: { nodePath: process.execPath, scriptPath: '/unused' },
  });
  const unixLine = (init: WorkerInit, event: string, payload: string): string =>
    `{"v":1,"token":"${init.unixToken}","event":"${event}","payload":${payload}}\n`;

  it('ready → event (stamped with the fixed offsets) → stats; arm → armed; close → closedAll', async () => {
    const { msgs, send, init, ready } = await startWorker();
    expect(ready.socketPath).toBe(init.socketPath);
    const ep = epFor(init, ready.port ?? 0);
    const t0 = performance.timeOrigin + performance.now();
    expect(await httpHook(ep, 'Stop', '{"a":1}').reply).toEqual({ status: 200, body: '' });
    await vi.waitFor(() => {
      expect(msgs.some((m) => m.t === 'event')).toBe(true);
    });
    const ev = msgs.find((m) => m.t === 'event');
    expect(ev).toMatchObject({ t: 'event', hookSeq: 1, event: 'Stop', transport: 'http', payload: { a: 1 }, holdable: false });
    if (ev?.t !== 'event') throw new Error('unreachable');
    expect(ev.at).toBeGreaterThanOrEqual(t0 + 1_000_000);
    expect(ev.wallAt).toBeGreaterThanOrEqual(t0);
    send({ t: 'ack', events: 1, bytes: ev.bytes });
    send({ t: 'arm', nonce: 'ccd-selftest-w' });
    await vi.waitFor(() => {
      expect(msgs).toContainEqual({ t: 'armed', nonce: 'ccd-selftest-w' });
    });
    expect(await httpHook(ep, 'UserPromptSubmit', '{"prompt":"ccd-selftest-w"}').reply).toEqual({
      status: 200,
      body: SELF_TEST_BLOCK_BODY,
    });
    expect((await httpHook(ep, 'Stop', '{}', { headers: { 'x-ccd-token': 'f'.repeat(64) } }).reply).status).toBe(403);
    await vi.waitFor(() => {
      expect(msgs.some((m) => m.t === 'stats' && m.authFailures === 1 && m.lastAuthFailure === 'token')).toBe(true);
    });
    send({ t: 'close', heldBody: null });
    await vi.waitFor(() => {
      expect(msgs.at(-1)).toEqual({ t: 'closedAll' });
    });
    expect(existsSync(init.socketPath)).toBe(false);
  });

  it('holds PermissionRequest until respond; reports closed; answers held requests with heldBody on close', async () => {
    const { msgs, send, init } = await startWorker();
    const c1 = unixRaw(init.socketPath, unixLine(init, 'PermissionRequest', '{"tool_name":"Bash"}'));
    await vi.waitFor(() => {
      expect(msgs.filter((m) => m.t === 'event')).toHaveLength(1);
    });
    send({ t: 'respond', hookSeq: 1, body: '{"ok":1}' });
    expect((await c1.reply).trim()).toBe('{"ok":1}');
    const c2 = unixRaw(init.socketPath, unixLine(init, 'PermissionRequest', '{}'));
    await vi.waitFor(() => {
      expect(msgs.filter((m) => m.t === 'event')).toHaveLength(2);
    });
    c2.sock.destroy();
    await vi.waitFor(() => {
      expect(msgs).toContainEqual({ t: 'closed', hookSeq: 2, reason: 'client_gone' });
    });
    const c3 = unixRaw(init.socketPath, unixLine(init, 'PermissionRequest', '{}'));
    await vi.waitFor(() => {
      expect(msgs.filter((m) => m.t === 'event')).toHaveLength(3);
    });
    send({ t: 'close', heldBody: '{"deny":1}' });
    expect((await c3.reply).trim()).toBe('{"deny":1}');
  });

  it('every respond is confirmed: delivered:true when answered, delivered:false after the forwarder already left', async () => {
    const { msgs, send, init } = await startWorker();
    const c1 = unixRaw(init.socketPath, unixLine(init, 'PermissionRequest', '{}'));
    await vi.waitFor(() => {
      expect(msgs.filter((m) => m.t === 'event')).toHaveLength(1);
    });
    send({ t: 'respond', hookSeq: 1, body: '{"ok":1}' });
    expect((await c1.reply).trim()).toBe('{"ok":1}');
    await vi.waitFor(() => {
      expect(msgs).toContainEqual({ t: 'responded', hookSeq: 1, delivered: true });
    });
    const c2 = unixRaw(init.socketPath, unixLine(init, 'PermissionRequest', '{}'));
    await vi.waitFor(() => {
      expect(msgs.filter((m) => m.t === 'event')).toHaveLength(2);
    });
    c2.sock.destroy();
    await vi.waitFor(() => {
      expect(msgs).toContainEqual({ t: 'closed', hookSeq: 2, reason: 'client_gone' });
    });
    // The main thread answered before it saw that 'closed' (the messages crossed): the loss is reported back.
    send({ t: 'respond', hookSeq: 2, body: '{"ok":2}' });
    await vi.waitFor(() => {
      expect(msgs).toContainEqual({ t: 'responded', hookSeq: 2, delivered: false });
    });
  });

  it('without acks the queue cap drops and counts; Claude is still answered', async () => {
    const { msgs, init, ready } = await startWorker({ maxQueuedEvents: 2 });
    const ep = epFor(init, ready.port ?? 0);
    for (let i = 0; i < 5; i += 1) expect(await httpHook(ep, 'Stop', `{"i":${i}}`).reply).toEqual({ status: 200, body: '' });
    await vi.waitFor(() => {
      expect(msgs.some((m) => m.t === 'stats' && m.queueOverflow === 3 && m.dropped === 3)).toBe(true);
    });
    expect(msgs.filter((m) => m.t === 'event')).toHaveLength(2);
  });

  it('queue bytes count only carried payloads: truncated events cost 0, one large event is accepted by an empty queue', async () => {
    const { msgs, send, init, ready } = await startWorker({ maxQueuedBytes: 50, maxBodyBytes: 200 });
    const ep = epFor(init, ready.port ?? 0);
    const events = (): Extract<WorkerToMain, { t: 'event' }>[] => msgs.filter((m) => m.t === 'event');
    const large = JSON.stringify({ p: 'x'.repeat(100) }); // > maxQueuedBytes, < maxBodyBytes
    expect(await httpHook(ep, 'Stop', large).reply).toEqual({ status: 200, body: '' });
    expect(await httpHook(ep, 'PostToolUse', JSON.stringify({ p: 'y'.repeat(500) })).reply).toEqual({ status: 200, body: '' });
    await vi.waitFor(() => {
      expect(events()).toHaveLength(2);
    });
    expect(events().map((e) => [e.truncated, queuedBytesOf(e)])).toEqual([
      [false, Buffer.byteLength(large)],
      [true, 0],
    ]);
    expect(await httpHook(ep, 'Stop', '{"small":1}').reply).toEqual({ status: 200, body: '' }); // over the byte budget
    await vi.waitFor(() => {
      expect(msgs.some((m) => m.t === 'stats' && m.queueOverflow === 1)).toBe(true);
    });
    send({ t: 'ack', events: 2, bytes: events().reduce((n, e) => n + ackBytesOf(e), 0) });
    await new Promise((r) => setTimeout(r, 20));
    expect(await httpHook(ep, 'Stop', '{"small":2}').reply).toEqual({ status: 200, body: '' });
    await vi.waitFor(() => {
      expect(events()).toHaveLength(3);
    });
    expect(events()[2]?.payload).toEqual({ small: 2 });
  });

  it('the main thread acks exactly what the worker charged (ackBytesOf ≡ queuedBytesOf)', () => {
    for (const e of [
      { bytes: 0, truncated: false },
      { bytes: 123, truncated: false },
      { bytes: 40_000_000, truncated: true },
    ])
      expect(ackBytesOf(e)).toBe(queuedBytesOf(e));
  });

  it("transport 'unix' opens no HTTP port; a start failure is reported as startError", async () => {
    const { ready } = await startWorker({ transport: 'unix' });
    expect(ready.port).toBeNull();
    const d = privateDir();
    cleanups.push(d.remove);
    writeFileSync(join(d.dir, 'h.sock'), 'file');
    const ch = new MessageChannel();
    const msgs: WorkerToMain[] = [];
    ch.port2.on('message', (m: WorkerToMain) => msgs.push(m));
    cleanups.push(() => {
      ch.port2.close();
    });
    await runWorker(
      {
        ccd: 'hook-worker/v1',
        transport: 'unix',
        sessionShortId: 's',
        unixToken: TOKEN,
        socketPath: join(d.dir, 'h.sock'),
        httpEvents: [],
        unixEvents: [],
        holdEvents: [],
        maxBodyBytes: 10,
        maxConnections: 1,
        maxHeld: 1,
        maxQueuedEvents: 1,
        maxQueuedBytes: 10,
        monoOffset: 0,
        wallOffset: 0,
      },
      ch.port1,
    );
    await vi.waitFor(() => {
      expect(msgs.some((m) => m.t === 'startError')).toBe(true);
    });
    const failed = msgs.find((m) => m.t === 'startError');
    expect(failed?.t === 'startError' ? failed.message : '').toContain('non-socket');
    expect(readFileSync(join(d.dir, 'h.sock'), 'utf8')).toBe('file'); // the worker's start-failure cleanup kept it
    expect(isWorkerInit({ ccd: 'hook-worker/v1' })).toBe(true);
    expect(isWorkerInit({ ccd: 'other' })).toBe(false);
    expect(isWorkerInit(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
async function realTransport(
  o: { maxQueuedEvents?: number; maxBodyBytes?: number; transport?: 'http' | 'unix' } = {},
): Promise<{ t: NodeHookTransport; ep: HookEndpoint; events: RawHookEvent[]; dir: string; logger: ReturnType<typeof memLogger> }> {
  const d = privateDir();
  const logger = memLogger();
  const t = createNodeHookTransportFactory({
    workerUrl: dist.workerUrl,
    forwarderScriptPath: dist.forwarderPath,
    ...(o.maxQueuedEvents !== undefined ? { maxQueuedEvents: o.maxQueuedEvents } : {}),
  }).create({
    runtimeDir: d.dir,
    clock: realClock(),
    ids: realIds(),
    maxBodyBytes: o.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    maxHeld: 32,
    maxConnections: 64,
    logger,
  }) as NodeHookTransport;
  const events: RawHookEvent[] = [];
  t.on((e) => events.push(e));
  cleanups.push(async () => {
    await t.close(null);
    d.remove();
  });
  const ep = await t.start({ sessionShortId: 'sX', transport: o.transport ?? 'http' });
  return { t, ep, events, dir: d.dir, logger };
}

/** A separate process that fires `n` hook POSTs `gapMs` apart and prints their latencies (the "Claude" side). */
function hookClientProcess(ep: HookEndpoint, n: number, gapMs: number): Promise<number[]> {
  const http = ep.http;
  if (http === undefined) throw new Error('no http');
  const script = `
    const http = require('node:http');
    const lat = [];
    let i = 0;
    const one = () => {
      const t0 = performance.now();
      const req = http.request({ host: '127.0.0.1', port: ${http.port}, method: 'POST', path: ${JSON.stringify(new URL(http.urlBase).pathname + 'MessageDisplay')},
        headers: { 'content-type': 'application/json', 'x-ccd-token': ${JSON.stringify(http.token)} }, agent: false }, (res) => {
        res.resume(); res.on('end', () => { lat.push(performance.now() - t0); if (++i < ${n}) setTimeout(one, ${gapMs}); else console.log(JSON.stringify(lat)); });
      });
      req.on('error', () => { lat.push(-1); if (++i < ${n}) setTimeout(one, ${gapMs}); else console.log(JSON.stringify(lat)); });
      req.end(JSON.stringify({ i }));
    };
    one();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', reject);
    child.on('exit', () => {
      resolve(JSON.parse(out) as number[]);
    });
  });
}

function busyLoop(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // the host event loop is blocked (P-REV-25)
  }
}

describe('NodeHookTransport (real worker)', () => {
  it(
    'main thread blocked 6 s: Claude-side hook calls are still answered at once by the worker (P-REV-25, K-52)',
    { timeout: 30_000 },
    async () => {
      const { ep, events } = await realTransport();
      const client = hookClientProcess(ep, 20, 200);
      await new Promise((r) => setTimeout(r, 300)); // the client process is up and sending
      busyLoop(6000);
      const lat = await client;
      expect(lat).toHaveLength(20);
      expect(lat.every((l) => l >= 0)).toBe(true);
      expect(Math.max(...lat)).toBeLessThan(1000); // the 5 s observation timeout is never approached
      await vi.waitFor(() => {
        expect(events).toHaveLength(20);
      });
    },
  );

  it(
    'the worker → main queue is bounded: while the host is blocked the excess is dropped and counted, Claude still answered',
    { timeout: 30_000 },
    async () => {
      const { t, ep, events } = await realTransport({ maxQueuedEvents: 3 });
      const client = hookClientProcess(ep, 10, 50);
      await new Promise((r) => setTimeout(r, 200));
      busyLoop(2500);
      const lat = await client;
      expect(lat.every((l) => l >= 0)).toBe(true);
      await vi.waitFor(() => {
        expect(events.length + t.stats().dropped).toBe(10);
      });
      expect(t.detailedStats().queueOverflow).toBe(t.stats().dropped);
      expect(t.stats().dropped).toBeGreaterThan(0);
    },
  );

  it('a 40 MB body over the 32 MiB cap: 200 empty, truncated event, no 413', { timeout: 30_000 }, async () => {
    const { ep, events } = await realTransport();
    const r = await httpHook(ep, 'PostToolUse', Buffer.alloc(40 * 1000 * 1000, 0x61)).reply;
    expect(r).toEqual({ status: 200, body: '' });
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events[0]).toMatchObject({ truncated: true, payload: null, bytes: 40_000_000 });
  });

  it('stamps at/wallAt on the main clock and hookSeq in receipt order (P-HOOK-45)', async () => {
    const before = performance.now();
    const wallBefore = Date.now();
    const { ep, events } = await realTransport();
    await httpHook(ep, 'Stop', '{}').reply;
    await unixHook(ep, 'SessionStart', '{}').reply;
    await vi.waitFor(() => {
      expect(events).toHaveLength(2);
    });
    const [a, b] = events;
    expect(a?.at).toBeGreaterThanOrEqual(before);
    expect(a?.at).toBeLessThanOrEqual(performance.now());
    expect(a?.wallAt).toBeGreaterThanOrEqual(wallBefore - 5);
    expect(b?.hookSeq).toBe((a?.hookSeq ?? 0) + 1);
    expect(b?.at).toBeGreaterThanOrEqual(a?.at ?? 0);
  });

  it('writes fwd.json 0600 with {socketPath, token} only; tokens differ and never appear in the URL (D-12)', async () => {
    const { ep, dir } = await realTransport();
    const cfg = JSON.parse(readFileSync(ep.unix.forwarderConfigPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(cfg).sort()).toEqual(['socketPath', 'token']);
    expect(cfg['socketPath']).toBe(join(dir, 'h.sock'));
    expect(cfg['token']).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg['token']).not.toBe(ep.http?.token);
    expect(lstatSync(ep.unix.forwarderConfigPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(ep.unix.socketPath).mode & 0o777).toBe(0o600);
    expect(ep.http?.urlBase).not.toContain(ep.http?.token ?? 'x');
    expect(ep.forwarder.nodePath).toBe(process.execPath);
  });

  it('close() removes the socket and fwd.json; after close no port answers (no squattable leftovers)', async () => {
    const { t, ep } = await realTransport();
    await t.close(null);
    expect(existsSync(ep.unix.socketPath)).toBe(false);
    expect(existsSync(ep.unix.forwarderConfigPath)).toBe(false);
    await expect(httpHook(ep, 'Stop', '{}').reply).rejects.toThrow();
    expect(t.respond(1 as never, null)).toBe(false);
  });

  it('a burst of forged requests fires onForgery once per window (→ E_SECURITY_HOOK_FORGERY)', async () => {
    const { t, ep } = await realTransport();
    const bursts: number[] = [];
    t.onForgery((b) => bursts.push(b.count));
    for (let i = 0; i < 7; i += 1) await httpHook(ep, 'Stop', '{}', { headers: { 'x-ccd-token': 'e'.repeat(64) } }).reply;
    await vi.waitFor(() => {
      expect(t.stats().authFailures).toBe(7);
    });
    expect(bursts).toEqual([5]);
  });

  it('killing the worker fails closed: onDied with HookWorkerDied and no restart (P-REV-47, L-13)', async () => {
    const { t, ep } = await realTransport();
    const died: HookWorkerDied[] = [];
    t.onDied((e) => died.push(e));
    await t.killWorkerForTest();
    await vi.waitFor(() => {
      expect(died).toHaveLength(1);
    });
    expect(died[0]).toBeInstanceOf(HookWorkerDied);
    await expect(httpHook(ep, 'Stop', '{}').reply).rejects.toThrow(); // the port is gone, nothing answers in our name
    expect(t.stats().workerRestarts).toBe(0);
  });

  it('refuses an unsafe runtime dir (group/other bits, symlink, missing) and an over-long socket path', async () => {
    const mk = (dir: string) =>
      createNodeHookTransportFactory({ workerUrl: dist.workerUrl }).create({
        runtimeDir: dir,
        clock: realClock(),
        ids: realIds(),
        maxBodyBytes: 1000,
        maxHeld: 1,
        maxConnections: 1,
        logger: memLogger(),
      });
    const d = privateDir();
    cleanups.push(d.remove);
    const open = join(d.dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    await expect(mk(open).start({ sessionShortId: 's', transport: 'http' })).rejects.toBeInstanceOf(UnsafeRuntimeDir);
    const link = join(d.dir, 'link');
    const priv = join(d.dir, 'priv');
    mkdirSync(priv, { mode: 0o700 });
    symlinkSync(priv, link);
    await expect(mk(link).start({ sessionShortId: 's', transport: 'http' })).rejects.toBeInstanceOf(UnsafeRuntimeDir);
    await expect(mk(join(d.dir, 'missing')).start({ sessionShortId: 's', transport: 'http' })).rejects.toBeInstanceOf(UnsafeRuntimeDir);
    let deep = d.dir;
    while (Buffer.byteLength(join(deep, 'h.sock')) <= SOCKET_PATH_MAX_BYTES) {
      deep = join(deep, 'dddddddddd');
      mkdirSync(deep, { mode: 0o700 });
    }
    await expect(mk(deep).start({ sessionShortId: 's', transport: 'http' })).rejects.toBeInstanceOf(SocketPathTooLong);
    expect(existsSync(join(deep, 'fwd.json'))).toBe(false);
  });

  it('start fails cleanly when fwd.json already exists or the socket path is taken by a file; nothing is left behind', async () => {
    const mk = (dir: string) =>
      createNodeHookTransportFactory({ workerUrl: dist.workerUrl }).create({
        runtimeDir: dir,
        clock: realClock(),
        ids: realIds(),
        maxBodyBytes: 1000,
        maxHeld: 1,
        maxConnections: 1,
        logger: memLogger(),
      });
    const d1 = privateDir();
    cleanups.push(d1.remove);
    writeFileSync(join(d1.dir, 'fwd.json'), '{}');
    await expect(mk(d1.dir).start({ sessionShortId: 's', transport: 'http' })).rejects.toMatchObject({ reason: 'fwdConfigExists' });
    const d2 = privateDir();
    cleanups.push(d2.remove);
    writeFileSync(join(d2.dir, 'h.sock'), 'file');
    const t = mk(d2.dir);
    await expect(t.start({ sessionShortId: 's', transport: 'unix' })).rejects.toBeInstanceOf(HookTransportError);
    expect(existsSync(join(d2.dir, 'fwd.json'))).toBe(false);
    expect(readFileSync(join(d2.dir, 'h.sock'), 'utf8')).toBe('file'); // refused, and not deleted by the failed start
    await expect(t.start({ sessionShortId: 's', transport: 'unix' })).rejects.toThrow(/once/);
    await expect(mk(d2.dir).start({ sessionShortId: 'bad/id', transport: 'unix' })).rejects.toMatchObject({ reason: 'badSessionShortId' });
  });

  it('the self-test nonce is armed only after the worker acked; invalid nonces are refused', async () => {
    const { t, ep } = await realTransport({ transport: 'unix' });
    await t.armSelfTestNonce('ccd-selftest-abc');
    expect(await unixHook(ep, 'UserPromptSubmit', '{"prompt":"ccd-selftest-abc"}').reply).toEqual({
      status: 200,
      body: SELF_TEST_BLOCK_BODY,
    });
    await expect(t.armSelfTestNonce('')).rejects.toMatchObject({ reason: 'badNonce' });
    await expect(t.armSelfTestNonce('x'.repeat(300))).rejects.toMatchObject({ reason: 'badNonce' });
  });

  it(
    'a forwarder close that crosses our respond() still resolves `closed` (the answer was lost, K-52 stall)',
    { timeout: 15_000 },
    async () => {
      const { t, ep, events } = await realTransport();
      const c = unixHook(ep, 'PermissionRequest', '{}');
      await vi.waitFor(() => {
        expect(events).toHaveLength(1);
      });
      const ev = events[0];
      if (ev?.closed === undefined) throw new Error('held event has no closed promise');
      let gone: string | undefined;
      void ev.closed.then((r) => (gone = r));
      c.abort();
      // The main thread is stalled while the worker sees the close and posts {t:'closed'}; we answer before handling it.
      busyLoop(500);
      expect(t.respond(ev.hookSeq, { behavior: 'allow' })).toBe(true);
      await vi.waitFor(() => {
        expect(gone).toBe('client_gone');
      });
      expect(t.stats().held).toBe(0);
    },
  );

  it('a delivered respond() never resolves `closed` later, even when the forwarder then exits', async () => {
    const { t, ep, events } = await realTransport();
    const c = unixHook(ep, 'PermissionRequest', '{}');
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    const ev = events[0];
    if (ev?.closed === undefined) throw new Error('held event has no closed promise');
    let gone: string | undefined;
    void ev.closed.then((r) => (gone = r));
    expect(t.respond(ev.hookSeq, { x: 1 })).toBe(true);
    expect((await c.reply).body).toBe('{"x":1}');
    await new Promise((r) => setTimeout(r, 100));
    expect(gone).toBeUndefined();
  });

  it('respond() with an unserializable body answers empty (the human decides) instead of throwing', async () => {
    const { t, ep, events } = await realTransport();
    const c = unixHook(ep, 'PermissionRequest', '{}');
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(t.respond(events[0]?.hookSeq ?? (0 as never), cyclic)).toBe(true);
    expect(await c.reply).toEqual({ status: 200, body: '' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('FakeHookTransport extras', () => {
  const create = () =>
    createFakeHookTransportFactory().create({
      runtimeDir: '/fake/dir',
      clock: realClock(),
      ids: realIds(),
      maxBodyBytes: 100,
      maxHeld: 1,
      maxConnections: 4,
      logger: memLogger(),
    });

  it('failNextStart makes start reject (endpoint refuse); calls on a refused endpoint are never answered', async () => {
    const t = create();
    t.failNextStart();
    await expect(t.start({ sessionShortId: 's', transport: 'http' })).rejects.toBeInstanceOf(HookTransportError);
    expect(t.deliver('Stop', {}).settled()).toBeUndefined();
  });

  it('setHang: observation calls are received but never answered (accept-and-hang)', async () => {
    const t = create();
    await t.start({ sessionShortId: 's', transport: 'http' });
    t.setHang(true);
    const c = t.deliver('Stop', {});
    expect(c.hookSeq).toBe(1);
    expect(c.settled()).toBeUndefined();
    expect(t.stats().received).toBe(1);
  });

  it('records arm history, responses and closedWith; forge bursts reach onForgery', async () => {
    const t = create();
    const bursts: number[] = [];
    t.onForgery((b) => bursts.push(b.count));
    await t.start({ sessionShortId: 's', transport: 'unix' });
    await t.armSelfTestNonce('n');
    await t.armSelfTestNonce(null);
    expect(t.armHistory).toEqual(['n', null]);
    const c = t.deliver('PermissionRequest', {});
    expect(t.respond(c.hookSeq ?? (0 as never), { a: 1 })).toBe(true);
    expect(t.responses).toEqual([{ hookSeq: 1, body: { a: 1 } }]);
    for (let i = 0; i < 5; i += 1) t.forge();
    expect(bursts).toEqual([5]);
    await t.close({ deny: true });
    expect(t.closedWith).toEqual({ deny: true });
    expect(t.state).toBe('closed');
  });
});
