// Network sidecar (DESIGN.md §3.10, §5.6 P-NET-*, §5.9 P-SEC-16/17/44/47). In-process: startSidecar() with a local fake
// upstream reached through the test-only resolveOverrides; real loopback sockets everywhere.
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addressRefusal,
  classifyProxyAuth,
  parseClientHello,
  parseConfig,
  parseConnectTarget,
  parseHead,
  SIDECAR_DEFAULTS,
  startSidecar,
  TlsRecordScanner,
  validateFault,
  type Sidecar,
  type SidecarConfig,
  type SidecarDeps,
  type WireRecord,
} from '../../../src/platform/netproxy/standalone/sidecar.js';

const TOKEN = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const CTL = 'c'.repeat(64);
const b64 = (s: string): string => Buffer.from(s).toString('base64');
const AUTH = `Proxy-Authorization: Basic ${b64(`ccd:${TOKEN}`)}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

// ---- fake upstream (NP t1): echoes "ECHO:<data>", answers a client FIN 100 ms later with LATE-AFTER-FIN:<n> ----
interface Upstream {
  port: number;
  connections: number;
  server: net.Server;
  sockets: Set<net.Socket>;
}
async function startUpstream(host = '127.0.0.1', handler?: (s: net.Socket) => void): Promise<Upstream> {
  const u: Upstream = { port: 0, connections: 0, server: undefined as unknown as net.Server, sockets: new Set() };
  u.server = net.createServer({ allowHalfOpen: true }, (s) => {
    u.connections++;
    u.sockets.add(s);
    s.on('close', () => u.sockets.delete(s));
    s.on('error', () => undefined);
    if (handler !== undefined) {
      handler(s);
      return;
    }
    let n = 0;
    s.on('data', (d: Buffer) => {
      n += d.length;
      s.write(Buffer.concat([Buffer.from('ECHO:'), d]));
    });
    s.on('end', () => setTimeout(() => s.end(`LATE-AFTER-FIN:${n}`), 100));
  });
  await new Promise<void>((r) => u.server.listen(0, host, r));
  u.port = (u.server.address() as net.AddressInfo).port;
  return u;
}

// ---- harness ----
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface H {
  sc: Sidecar;
  cfg: SidecarConfig;
  up: Upstream;
  records: WireRecord[];
  logs: Record<string, unknown>[];
  exits: string[];
  dir: string;
}

async function setup(over: Partial<SidecarConfig> = {}, deps: SidecarDeps = {}, up?: Upstream): Promise<H> {
  const dir = mkdtempSync(join(tmpdir(), 'ccd-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const upstream = up ?? (await startUpstream());
  cleanups.push(() => {
    for (const s of upstream.sockets) s.destroy();
    upstream.server.close();
  });
  const target = { host: '127.0.0.1', port: upstream.port };
  const cfg: SidecarConfig = {
    v: 1,
    tokenA: TOKEN,
    controlToken: CTL,
    controlSocketPath: join(dir, 'net.sock'),
    allowPrivate: false,
    allowPorts: [443],
    denyPorts: [],
    ownerPid: process.pid,
    ...SIDECAR_DEFAULTS,
    resolveOverrides: {
      'api.anthropic.com:443': target,
      'example.com:443': target,
      'platform.claude.com:443': target,
    },
    ...over,
  };
  const logs: Record<string, unknown>[] = [];
  const exits: string[] = [];
  const sc = await startSidecar(cfg, {
    log: (o) => logs.push(o),
    allowTestOverrides: true,
    isAlive: () => true,
    onExit: (r) => exits.push(r),
    ...deps,
  });
  cleanups.push(() => sc.shutdown('test'));
  const records: WireRecord[] = [];
  sc.onRecord((r) => records.push(r));
  return { sc, cfg, up: upstream, records, logs, exits, dir };
}

interface Conn {
  sock: net.Socket;
  data: () => string;
  raw: () => Buffer;
  closed: Promise<string | undefined>;
}
function open(port: number): Conn {
  const sock = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
  const chunks: Buffer[] = [];
  sock.on('data', (d: Buffer) => chunks.push(d));
  sock.on('end', () => sock.end()); // the peer finished: finish our side too (allowHalfOpen keeps it open otherwise)
  const closed = new Promise<string | undefined>((r) => {
    let err: string | undefined;
    sock.on('error', (e: NodeJS.ErrnoException) => (err = e.code));
    sock.on('close', () => {
      r(err);
    });
  });
  return { sock, data: () => Buffer.concat(chunks).toString('latin1'), raw: () => Buffer.concat(chunks), closed };
}
const connectHead = (target: string, auth: string | null = AUTH): string =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: Keep-Alive\r\n${auth === null ? '' : `${auth}\r\n`}\r\n`;

// `untilHead`: instead of destroying the socket after a fixed real-time window (flaky under CPU load — the destroy timer can
// fire before the poll phase reads a reply that is already waiting), destroy it as soon as a complete response head
// (CRLFCRLF) has arrived or the server closed; `waitMs` (default 10 s here) is then only a hang guard.
async function run(
  port: number,
  writes: (string | Buffer)[],
  o: { halfClose?: boolean; waitMs?: number; untilHead?: boolean } = {},
): Promise<string> {
  const c = open(port);
  await new Promise<void>((r) =>
    c.sock.once('connect', () => {
      r();
    }),
  );
  for (const w of writes) {
    c.sock.write(w);
    await sleep(40);
  }
  if (o.halfClose === true) c.sock.end();
  else if (o.untilHead === true) {
    const guard = setTimeout(() => c.sock.destroy(), o.waitMs ?? 10_000);
    const check = (): void => {
      if (c.data().includes('\r\n\r\n')) c.sock.destroy();
    };
    c.sock.on('data', check);
    check();
    await c.closed;
    clearTimeout(guard);
    return c.data();
  } else setTimeout(() => c.sock.destroy(), o.waitMs ?? 300);
  await c.closed;
  return c.data();
}
const OK = 'HTTP/1.1 200 Connection Established\r\n\r\n';

// -------------------------------------------------------------------------------------------------------------------------
describe('test helper run() (regression: no fixed real-time window)', () => {
  it('untilHead waits for a reply that arrives well after the old 20 ms window, and returns as soon as the head is in', async () => {
    const srv = net.createServer((s) => {
      s.on('error', () => undefined);
      s.once('data', () => setTimeout(() => s.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'), 250));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const t0 = Date.now();
      const out = await run(port, ['CONNECT x:443 HTTP/1.1\r\n\r\n'], { untilHead: true });
      expect(out).toBe('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      expect(Date.now() - t0).toBeLessThan(5_000); // closed on the head, not on the hang guard
    } finally {
      await new Promise<void>((r) => {
        srv.close(() => {
          r();
        });
      });
    }
  });
});

describe('CONNECT correctness (NP §1, t1 cases)', () => {
  it('A: normal head then data', async () => {
    const h = await setup();
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'hello'])).toBe(`${OK}ECHO:hello`);
  });

  it('B: head split across two packets is accumulated to CRLFCRLF (P-NET-01)', async () => {
    const h = await setup();
    const H = connectHead('api.anthropic.com:443');
    expect(await run(h.sc.port, [H.slice(0, 5), H.slice(5), 'hello'])).toBe(`${OK}ECHO:hello`);
  });

  it('C: bytes pipelined with the head are forwarded (P-NET-02) and nothing is lost before pipe (P-NET-04)', async () => {
    const h = await setup();
    const out = await run(h.sc.port, [connectHead('api.anthropic.com:443') + 'early']);
    expect(out).toBe(`${OK}ECHO:early`);
  });

  it('D: half-close is honoured both ways (P-NET-03)', async () => {
    const h = await setup();
    const out = await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'bye'], { halfClose: true });
    expect(out).toBe(`${OK}ECHO:byeLATE-AFTER-FIN:3`);
    await waitFor(() => h.records.some((r) => r.kind === 'close'));
    expect(h.records.find((r) => r.kind === 'close')?.closeKind).toBe('fin');
  });

  it('IPv6 literal targets have their brackets stripped (P-NET-06)', async () => {
    let up6: Upstream;
    try {
      up6 = await startUpstream('::1');
    } catch {
      expect(parseConnectTarget('[::1]:443')).toEqual({ host: '::1', port: 443, key: '[::1]:443' }); // no IPv6 loopback here
      return;
    }
    const h = await setup({ resolveOverrides: { '[::1]:443': { host: '::1', port: up6.port } } }, {}, up6);
    expect(await run(h.sc.port, [connectHead('[::1]:443'), 'v6'])).toBe(`${OK}ECHO:v6`);
    // without an override the same literal is refused by the policy (loopback), not mis-dialled
    const h2 = await setup({ resolveOverrides: {} });
    expect(await run(h2.sc.port, [connectHead('[::1]:443')])).toMatch(/^HTTP\/1\.1 403 /);
  });

  it('sockets get setNoDelay(true) and keep-alive 30 s, and never an idle timeout (P-NET-11, P-NET-14)', async () => {
    const noDelay = vi.spyOn(net.Socket.prototype, 'setNoDelay');
    const keepAlive = vi.spyOn(net.Socket.prototype, 'setKeepAlive');
    const idle = vi.spyOn(net.Socket.prototype, 'setTimeout');
    const h = await setup();
    await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'x']);
    expect(noDelay.mock.calls.filter((c) => c[0] === true).length).toBeGreaterThanOrEqual(2);
    expect(keepAlive.mock.calls.filter((c) => c[0] === true && c[1] === 30_000).length).toBeGreaterThanOrEqual(2);
    expect(idle).not.toHaveBeenCalled();
  });

  it('large transfers keep backpressure through pipe and arrive intact (P-NET-12)', async () => {
    const SIZE = 8 * 1024 * 1024;
    const blob = Buffer.alloc(SIZE, 7);
    const up = await startUpstream('127.0.0.1', (s) => {
      s.once('data', () => s.end(blob));
    });
    const h = await setup({}, {}, up);
    const c = open(h.sc.port);
    await new Promise<void>((r) =>
      c.sock.once('connect', () => {
        r();
      }),
    );
    c.sock.write(connectHead('api.anthropic.com:443'));
    await waitFor(() => c.data().startsWith(OK));
    c.sock.pause();
    c.sock.write('go');
    await sleep(150); // reader stalled: the sidecar must not buffer the whole blob in memory for us
    c.sock.resume();
    await waitFor(() => c.raw().length >= OK.length + SIZE, 10_000);
    expect(c.raw().length).toBe(OK.length + SIZE);
    c.sock.destroy();
  });

  it('a throwing record listener never stops bytes (P-NET-13)', async () => {
    const h = await setup();
    h.sc.onRecord(() => {
      throw new Error('meter bug');
    });
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'still']).then((s) => s)).toBe(`${OK}ECHO:still`);
    expect(h.logs.some((l) => l['ev'] === 'listenerThrew')).toBe(true);
  });

  it('an upstream FIN on an idle tunnel is a normal close, not an error (P-NET-14)', async () => {
    const up = await startUpstream('127.0.0.1', (s) => setTimeout(() => s.end(), 20));
    const h = await setup({}, {}, up);
    await run(h.sc.port, [connectHead('example.com:443')], { waitMs: 200 });
    await waitFor(() => h.records.some((r) => r.kind === 'close'));
    const close = h.records.find((r) => r.kind === 'close');
    expect(close?.closeKind).toBe('fin');
    expect(close?.error).toBeUndefined();
  });
});

describe('head bounds and request forms', () => {
  it('a head over 16 KiB without CRLFCRLF is dropped (P-NET-05)', async () => {
    const h = await setup();
    const c = open(h.sc.port);
    await new Promise<void>((r) =>
      c.sock.once('connect', () => {
        r();
      }),
    );
    c.sock.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nX: ${'a'.repeat(17 * 1024)}`);
    await c.closed;
    expect(c.data()).toBe('');
    expect(h.logs.some((l) => l['ev'] === 'headTooLarge')).toBe(true);
  });

  it('a slow head is dropped after the head timeout (slowloris, P-NET-05)', async () => {
    const h = await setup({ headTimeoutMs: 80 });
    const c = open(h.sc.port);
    await new Promise<void>((r) =>
      c.sock.once('connect', () => {
        r();
      }),
    );
    c.sock.write('CONNECT api.anth');
    await c.closed;
    expect(h.logs.some((l) => l['ev'] === 'headTimeout')).toBe(true);
  });

  it('absolute-form http:// and other methods get 405 and are never forwarded (P-SEC-44, P-NET-07 rev 2)', async () => {
    const h = await setup();
    const out = await run(h.sc.port, [`GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n${AUTH}\r\n\r\n`]);
    expect(out).toMatch(/^HTTP\/1\.1 405 Method Not Allowed\r\n/);
    expect(out).toContain('Allow: CONNECT');
    expect(h.up.connections).toBe(0);
    expect(await run(h.sc.port, [`connect api.anthropic.com:443 HTTP/1.1\r\n\r\n`])).toMatch(/^HTTP\/1\.1 405 /); // case-sensitive
  });

  it('garbage heads get 400', async () => {
    const h = await setup();
    expect(await run(h.sc.port, ['\x16\x03\x01 garbage\r\n\r\n'])).toMatch(/^HTTP\/1\.1 400 /);
    expect(await run(h.sc.port, [connectHead('bad_host!:443')])).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('parseHead / parseConnectTarget grammar', () => {
    expect(parseHead('CONNECT a.b:443 HTTP/1.0\r\nHost: a.b:443')).toEqual({
      method: 'CONNECT',
      target: 'a.b:443',
      version: 'HTTP/1.0',
      headers: [['host', 'a.b:443']],
    });
    expect(parseHead('CONNECT a.b:443 HTTP/2')).toBeUndefined();
    expect(parseHead('CONNECT a.b:443 HTTP/1.1\r\nbroken')).toBeUndefined();
    expect(parseConnectTarget('API.Anthropic.com.:443')).toEqual({ host: 'api.anthropic.com', port: 443, key: 'api.anthropic.com:443' });
    expect(parseConnectTarget('[2001:db8::1]:8443')?.host).toBe('2001:db8::1');
    expect(parseConnectTarget('[nothex]:443')).toBeUndefined();
    expect(parseConnectTarget('host:0')).toBeUndefined();
    expect(parseConnectTarget('host:70000')).toBeUndefined();
    expect(parseConnectTarget('host')).toBeUndefined();
    expect(parseConnectTarget('a..b:443')).toBeUndefined();
  });
});

describe('authentication (P-SEC-16, P-SEC-47)', () => {
  it('no or wrong credentials → 407 with Proxy-Authenticate; the token is never logged', async () => {
    const h = await setup();
    const none = await run(h.sc.port, [connectHead('api.anthropic.com:443', null)]);
    expect(none).toMatch(/^HTTP\/1\.1 407 Proxy Authentication Required\r\n/);
    expect(none).toContain('Proxy-Authenticate: Basic realm="ccd"');
    const bad = await run(h.sc.port, [connectHead('api.anthropic.com:443', `Proxy-Authorization: Basic ${b64('ccd:wrong')}`)]);
    expect(bad).toMatch(/^HTTP\/1\.1 407 /);
    expect(h.up.connections).toBe(0);
    await waitFor(() => h.records.filter((r) => r.kind === 'refused').length === 2);
    expect(h.records.filter((r) => r.kind === 'open').map((r) => r.token)).toEqual(['none', 'bad']);
    expect(h.sc.stats().authFailures).toBe(2);
    await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'ok']);
    const text = JSON.stringify(h.logs) + JSON.stringify(h.records);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(b64(`ccd:${TOKEN}`));
    expect(text.toLowerCase()).not.toContain('proxy-authorization');
  });

  it('a burst of 407s is logged once per window', async () => {
    const h = await setup();
    for (let i = 0; i < 10; i++) await run(h.sc.port, [connectHead('api.anthropic.com:443', null)], { waitMs: 30 });
    expect(h.logs.filter((l) => l['ev'] === 'authBurst')).toHaveLength(1);
  });

  it('classifyProxyAuth', () => {
    const tok = Buffer.from(TOKEN);
    const hdr = (v: string): [string, string][] => [['proxy-authorization', v]];
    expect(classifyProxyAuth([], tok)).toBe('none');
    expect(classifyProxyAuth(hdr(`Basic ${b64(`ccd:${TOKEN}`)}`), tok)).toBe('A');
    expect(classifyProxyAuth(hdr(`basic ${b64(`ccd:${TOKEN}`)}`), tok)).toBe('A');
    expect(classifyProxyAuth(hdr(`Basic ${b64(`bob:${TOKEN}`)}`), tok)).toBe('bad');
    expect(classifyProxyAuth(hdr(`Basic ${b64(`ccd:${TOKEN}x`)}`), tok)).toBe('bad');
    expect(classifyProxyAuth(hdr(`Bearer ${TOKEN}`), tok)).toBe('bad');
    expect(classifyProxyAuth([...hdr(`Basic ${b64(`ccd:${TOKEN}`)}`), ...hdr('Basic x')], tok)).toBe('bad');
  });
});

describe('target policy after DNS (P-SEC-17, P-NET-08/09/10)', () => {
  it('ports outside allowPorts or inside denyPorts → 403', async () => {
    const h = await setup({ allowPorts: [443, 8443], denyPorts: [8443] });
    expect(await run(h.sc.port, [connectHead('example.com:22')])).toMatch(/^HTTP\/1\.1 403 /);
    expect(await run(h.sc.port, [connectHead('example.com:8443')])).toMatch(/^HTTP\/1\.1 403 /);
  });

  it.each(['127.0.0.1:443', '[::1]:443', 'localhost:443', '169.254.169.254:443', '0.0.0.0:443', '100.64.1.1:443', '10.1.2.3:443'])(
    'literal %s → 403',
    async (t) => {
      const h = await setup({ resolveOverrides: {} });
      expect(await run(h.sc.port, [connectHead(t)])).toMatch(/^HTTP\/1\.1 403 /);
    },
  );

  it('every resolved address is checked (DNS rebinding) and private ranges need allowPrivate', async () => {
    const lookup = vi.fn((host: string) =>
      Promise.resolve(
        host === 'rebind.test'
          ? [
              { address: '93.184.216.34', family: 4 },
              { address: '127.0.0.1', family: 4 },
            ]
          : [{ address: '10.9.8.7', family: 4 }],
      ),
    );
    const h = await setup({ resolveOverrides: {} }, { lookup });
    expect(await run(h.sc.port, [connectHead('rebind.test:443')])).toMatch(/^HTTP\/1\.1 403 /);
    expect(await run(h.sc.port, [connectHead('corp.test:443')])).toMatch(/^HTTP\/1\.1 403 /);
    await waitFor(() => h.records.filter((r) => r.kind === 'refused').length === 2);
    expect(h.records.filter((r) => r.kind === 'refused').map((r) => r.error)).toEqual(['blockedAddress', 'privateAddress']);
  });

  it('the checked addresses are the ones dialled (no second resolution)', async () => {
    const lookup = vi.fn(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]));
    const seen: net.TcpNetConnectOpts[] = [];
    const h = await setup(
      { resolveOverrides: {}, connectTimeoutMs: 100 },
      {
        lookup,
        connect: (o) => {
          seen.push(o as net.TcpNetConnectOpts);
          return new net.Socket(); // never connects
        },
      },
    );
    await run(h.sc.port, [connectHead('example.org:443')], { waitMs: 400 });
    const lk = seen[0]?.lookup;
    expect(lk).toBeTypeOf('function');
    const all = await new Promise<unknown>((r) =>
      lk?.('example.org', { all: true }, (_e: unknown, a: unknown) => {
        r(a);
      }),
    );
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('DNS failure → 502 with the real errno (P-NET-10)', async () => {
    const lookup = (): Promise<never> => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    const h = await setup({ resolveOverrides: {} }, { lookup });
    expect(await run(h.sc.port, [connectHead('nx.example:443')])).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
    await waitFor(() => h.records.some((r) => r.kind === 'refused'));
    expect(h.records.find((r) => r.kind === 'refused')?.error).toBe('ENOTFOUND');
  });

  it('upstream refused → 502 ECONNREFUSED, and no 200 is ever sent first (P-NET-08)', async () => {
    const dead = await startUpstream();
    dead.server.close();
    await sleep(20);
    const h = await setup({ resolveOverrides: { 'example.com:443': { host: '127.0.0.1', port: dead.port } } });
    const out = await run(h.sc.port, [connectHead('example.com:443')]);
    expect(out).toMatch(/^HTTP\/1\.1 502 /);
    expect(out).not.toContain('200');
    await waitFor(() => h.records.some((r) => r.kind === 'refused'));
    expect(h.records.find((r) => r.kind === 'refused')?.error).toBe('ECONNREFUSED');
  });

  it('a black-holed connect → 504 after the connect timeout (P-NET-09)', async () => {
    const h = await setup({ connectTimeoutMs: 100 }, { connect: () => new net.Socket() });
    const t0 = Date.now();
    const out = await run(h.sc.port, [connectHead('example.com:443')], { waitMs: 600 });
    expect(out).toMatch(/^HTTP\/1\.1 504 Gateway Timeout\r\n/);
    expect(out).not.toContain(' 200 ');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it('addressRefusal ranges', () => {
    expect(addressRefusal('127.8.8.8', true)).toBe('blockedAddress');
    expect(addressRefusal('::1', true)).toBe('blockedAddress');
    expect(addressRefusal('::ffff:127.0.0.1', true)).toBe('blockedAddress');
    expect(addressRefusal('fe80::1', true)).toBe('blockedAddress');
    expect(addressRefusal('169.254.169.254', true)).toBe('blockedAddress');
    expect(addressRefusal('100.127.255.255', true)).toBe('blockedAddress');
    expect(addressRefusal('0.1.2.3', true)).toBe('blockedAddress');
    for (const p of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', 'fd00::1']) {
      expect(addressRefusal(p, false)).toBe('privateAddress');
      expect(addressRefusal(p, true)).toBeUndefined();
    }
    expect(addressRefusal('172.32.0.1', false)).toBeUndefined();
    expect(addressRefusal('160.79.104.10', false)).toBeUndefined();
    expect(addressRefusal('2607:6bc0::10', false)).toBeUndefined();
    expect(addressRefusal('nonsense', false)).toBe('notAnAddress');
  });

  it('per-token tunnel cap → 503 (P-NET-16)', async () => {
    const h = await setup({ maxTunnels: 1 });
    const first = open(h.sc.port);
    first.sock.write(connectHead('example.com:443'));
    await waitFor(() => first.data().startsWith(OK));
    expect(await run(h.sc.port, [connectHead('example.com:443')])).toMatch(/^HTTP\/1\.1 503 /);
    first.sock.destroy();
  });
});

// ---- TLS metering ----
const u16 = (n: number): Buffer => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u24 = (n: number): Buffer => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
function clientHello(sni: string, alpn: string[]): Buffer {
  const name = Buffer.from(sni);
  const sniExt = Buffer.concat([u16(0), u16(name.length + 5), u16(name.length + 3), Buffer.from([0]), u16(name.length), name]);
  const list = Buffer.concat(alpn.map((a) => Buffer.concat([Buffer.from([a.length]), Buffer.from(a)])));
  const alpnExt = Buffer.concat([u16(16), u16(list.length + 2), u16(list.length), list]);
  const exts = Buffer.concat([sniExt, alpnExt]);
  const body = Buffer.concat([
    u16(0x0303),
    Buffer.alloc(32, 1),
    Buffer.from([0]),
    u16(2),
    u16(0x1301),
    Buffer.from([1, 0]),
    u16(exts.length),
    exts,
  ]);
  const hs = Buffer.concat([Buffer.from([1]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);
}
const appRecord = (len: number): Buffer => Buffer.concat([Buffer.from([0x17, 3, 3]), u16(len), Buffer.alloc(len, 9)]);

describe('metering (P-NET-13, P-NET-18, NP §2)', () => {
  it('parseClientHello extracts SNI and offered ALPN', () => {
    expect(parseClientHello(clientHello('api.anthropic.com', ['http/1.1']))).toEqual({ sni: 'api.anthropic.com', alpn: ['http/1.1'] });
    expect(parseClientHello(clientHello('x.test', ['h2', 'http/1.1']))?.alpn).toEqual(['h2', 'http/1.1']);
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1'))).toBeUndefined();
    expect(parseClientHello(clientHello('x.test', ['h2']).subarray(0, 30))).toBeUndefined();
  });

  it('TlsRecordScanner counts records across arbitrary chunking and switches off on non-TLS bytes', () => {
    const s = new TlsRecordScanner();
    const stream = Buffer.concat([appRecord(445), appRecord(623), appRecord(17)]);
    const r1 = s.push(stream.subarray(0, 3));
    const r2 = s.push(stream.subarray(3, 460));
    const r3 = s.push(stream.subarray(460));
    expect(r1.records + r2.records + r3.records).toBe(3);
    expect(r2.lastLen).toBe(445);
    expect(r3.lastLen).toBe(17);
    const bad = new TlsRecordScanner();
    expect(bad.push(Buffer.from('HTTP/1.1 200 OK\r\n')).records).toBe(0);
    expect(bad.valid).toBe(false);
  });

  it('a tunnel yields open → established → up(sni, alpn) → down → close with byte and record counts', async () => {
    const up = await startUpstream('127.0.0.1', (s) => {
      s.once('data', () => s.write(Buffer.concat([appRecord(600), appRecord(17)])));
      s.on('end', () => s.end());
    });
    const h = await setup({}, {}, up);
    const c = open(h.sc.port);
    c.sock.write(connectHead('api.anthropic.com:443'));
    await waitFor(() => c.data().startsWith(OK));
    c.sock.write(clientHello('api.anthropic.com', ['http/1.1']));
    await waitFor(() => c.raw().length >= OK.length + 605 + 22);
    c.sock.end();
    await waitFor(() => h.records.some((r) => r.kind === 'close'));
    const kinds = [...new Set(h.records.map((r) => r.kind))];
    expect(kinds).toEqual(['open', 'established', 'up', 'down', 'close']);
    const firstUp = h.records.find((r) => r.kind === 'up');
    expect(firstUp).toMatchObject({ sni: 'api.anthropic.com', alpn: ['http/1.1'], token: 'A', host: 'api.anthropic.com', port: 443 });
    const downs = h.records.filter((r) => r.kind === 'down');
    expect(downs.reduce((a, r) => a + (r.bytes ?? 0), 0)).toBe(605 + 22);
    expect(downs.reduce((a, r) => a + (r.records ?? 0), 0)).toBe(2);
    expect(downs.at(-1)?.lastRecordLen).toBe(17);
    expect(new Set(h.records.map((r) => r.tunnelId)).size).toBe(1);
    const monos = h.records.map((r) => r.mono);
    expect([...monos].sort((a, b) => a - b)).toEqual(monos);
  });

  it('logs offered h2 (P-NET-18) and SNI/host mismatches', async () => {
    const h = await setup();
    const c = open(h.sc.port);
    c.sock.write(connectHead('example.com:443'));
    await waitFor(() => c.data().startsWith(OK));
    c.sock.write(clientHello('evil.test', ['h2', 'http/1.1']));
    await waitFor(() => h.logs.some((l) => l['ev'] === 'alpnH2'));
    expect(h.logs.some((l) => l['ev'] === 'sniMismatch' && l['sni'] === 'evil.test')).toBe(true);
    c.sock.destroy();
  });
});

describe('faults (§3.10; P-NET-15, P-NET-21, P-NET-27)', () => {
  it('refuse → 502 on api.anthropic.com only; tool and OAuth hosts pass through', async () => {
    const h = await setup();
    h.sc.setFault({ mode: 'refuse' });
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443')])).toMatch(/^HTTP\/1\.1 502 /);
    expect(await run(h.sc.port, [connectHead('platform.claude.com:443'), 'oauth'])).toBe(`${OK}ECHO:oauth`);
    expect(await run(h.sc.port, [connectHead('example.com:443'), 'tool'])).toBe(`${OK}ECHO:tool`);
    h.sc.setFault(null);
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'back'])).toBe(`${OK}ECHO:back`);
  });

  it('blackhole → 200 then silence, upstream never dialled', async () => {
    const h = await setup();
    h.sc.setFault({ mode: 'blackhole' });
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'anyone?'], { waitMs: 250 })).toBe(OK);
    expect(h.up.connections).toBe(0);
  });

  it('reset:N → exactly N down bytes, then a reset', async () => {
    const h = await setup();
    h.sc.setFault({ mode: 'reset', afterDownBytes: 7 });
    const c = open(h.sc.port);
    c.sock.write(connectHead('api.anthropic.com:443'));
    await waitFor(() => c.data().startsWith(OK));
    c.sock.write('hello world');
    const err = await c.closed;
    expect(c.data()).toBe(`${OK}ECHO:he`);
    // macOS surfaces the RST as ECONNRESET; Linux may report a plain close first. The sidecar's own record proves the reset.
    expect([undefined, 'ECONNRESET', 'EPIPE']).toContain(err);
    await waitFor(() => h.records.some((r) => r.kind === 'close'));
    expect(h.records.find((r) => r.kind === 'close')?.closeKind).toBe('rst');
  });

  it('stall:N → N down bytes, then silence with the tunnel left open', async () => {
    const h = await setup();
    h.sc.setFault({ mode: 'stall', afterDownBytes: 5 });
    const c = open(h.sc.port);
    c.sock.write(connectHead('api.anthropic.com:443'));
    await waitFor(() => c.data().startsWith(OK));
    c.sock.write('abc');
    await sleep(250);
    expect(c.data()).toBe(`${OK}ECHO:`);
    expect(c.sock.destroyed).toBe(false);
    c.sock.destroy();
  });

  it('slow:R → bytes are paced at ~R bytes/s', async () => {
    const h = await setup();
    h.sc.setFault({ mode: 'slow', bytesPerSec: 50 });
    const c = open(h.sc.port);
    c.sock.write(connectHead('api.anthropic.com:443'));
    await waitFor(() => c.data().startsWith(OK));
    const t0 = Date.now();
    c.sock.write('0123456789'); // 15 bytes back
    await sleep(60);
    expect(c.data().length).toBeLessThan(OK.length + 15);
    await waitFor(() => c.data() === `${OK}ECHO:0123456789`, 3000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    c.sock.destroy();
  });

  it('switching a fault kills only token-A tunnels to api.anthropic.com', async () => {
    const h = await setup();
    const api = open(h.sc.port);
    const tool = open(h.sc.port);
    const oauth = open(h.sc.port);
    api.sock.write(connectHead('api.anthropic.com:443'));
    tool.sock.write(connectHead('example.com:443'));
    oauth.sock.write(connectHead('platform.claude.com:443'));
    await waitFor(() => [api, tool, oauth].every((c) => c.data().startsWith(OK)));
    h.sc.setFault({ mode: 'stall', afterDownBytes: 0 });
    await api.closed;
    tool.sock.write('t');
    oauth.sock.write('o');
    await waitFor(() => tool.data().endsWith('ECHO:t') && oauth.data().endsWith('ECHO:o'));
    expect(tool.sock.destroyed).toBe(false);
    expect(h.logs.find((l) => l['ev'] === 'faultSet')).toMatchObject({ mode: 'stall', killed: 1 });
    tool.sock.destroy();
    oauth.sock.destroy();
  });

  it('validateFault', () => {
    expect(validateFault(null)).toBeNull();
    expect(validateFault({ mode: 'reset', afterDownBytes: 3 })).toEqual({ mode: 'reset', afterDownBytes: 3 });
    expect(validateFault({ mode: 'slow', bytesPerSec: 0 })).toBeUndefined();
    expect(validateFault({ mode: 'stall', afterDownBytes: -1 })).toBeUndefined();
    expect(validateFault({ mode: 'explode' })).toBeUndefined();
    expect(validateFault('refuse')).toBeUndefined();
  });
});

// ---- control socket ----
function controlClient(path: string): { sock: net.Socket; lines: Record<string, unknown>[]; send: (o: unknown) => void } {
  const sock = net.createConnection(path);
  sock.setEncoding('utf8');
  const lines: Record<string, unknown>[] = [];
  let buf = '';
  sock.on('data', (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      buf = buf.slice(nl + 1);
    }
  });
  sock.on('error', () => undefined);
  return { sock, lines, send: (o) => sock.write(`${JSON.stringify(o)}\n`) };
}

describe('control socket (P-SEC-17, SEC §6.5)', () => {
  it('is 0600 in a private dir and rejects a wrong control token', async () => {
    const h = await setup();
    expect(statSync(h.cfg.controlSocketPath).mode & 0o777).toBe(0o600);
    const cc = controlClient(h.cfg.controlSocketPath);
    cc.send({ op: 'hello', token: 'f'.repeat(64) });
    await new Promise<void>((r) =>
      cc.sock.once('close', () => {
        r();
      }),
    );
    expect(cc.lines).toEqual([{ t: 'hello', ok: false }]);
    expect(h.logs.some((l) => l['ev'] === 'controlAuthFailed')).toBe(true);
  });

  it('a request before hello is refused', async () => {
    const h = await setup();
    const cc = controlClient(h.cfg.controlSocketPath);
    cc.send({ op: 'fault', id: 1, spec: { mode: 'refuse' } });
    await new Promise<void>((r) =>
      cc.sock.once('close', () => {
        r();
      }),
    );
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'x'])).toBe(`${OK}ECHO:x`);
  });

  it('hello → port/pid; bind, fault, stats; records stream; stop exits', async () => {
    const h = await setup();
    const cc = controlClient(h.cfg.controlSocketPath);
    cc.send({ op: 'hello', token: CTL });
    await waitFor(() => cc.lines.length === 1);
    expect(cc.lines[0]).toMatchObject({ t: 'hello', ok: true, v: 1, port: h.sc.port, pid: process.pid });
    cc.send({ op: 'bind', id: 1, pid: 4242 });
    cc.send({ op: 'bind', id: 2, pid: 'x' });
    cc.send({ op: 'fault', id: 3, spec: { mode: 'refuse' } });
    cc.send({ op: 'fault', id: 4, spec: { mode: 'bogus' } });
    cc.send({ op: 'nope', id: 5 });
    await waitFor(() => cc.lines.filter((l) => l['t'] === 'reply').length === 5);
    expect(cc.lines.filter((l) => l['t'] === 'reply').map((l) => [l['id'], l['ok']])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, false],
      [5, false],
    ]);
    await run(h.sc.port, [connectHead('api.anthropic.com:443')]);
    await waitFor(() => cc.lines.some((l) => l['t'] === 'rec' && (l['r'] as WireRecord).kind === 'refused'));
    cc.send({ op: 'stats', id: 6 });
    await waitFor(() => cc.lines.some((l) => l['id'] === 6));
    expect((cc.lines.find((l) => l['id'] === 6)?.['stats'] as { refused: number }).refused).toBe(1);
    cc.send({ op: 'stop', id: 7 });
    await waitFor(() => h.exits.length === 1);
    expect(h.exits).toEqual(['stop']);
    expect(() => statSync(h.cfg.controlSocketPath)).toThrow();
  });

  it('refuses to start when the control dir is group/world accessible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccd-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    chmodSync(dir, 0o755);
    const cfg = parseConfig(
      JSON.stringify({
        v: 1,
        tokenA: TOKEN,
        controlToken: CTL,
        controlSocketPath: join(dir, 'net.sock'),
        allowPrivate: false,
        allowPorts: [443],
        denyPorts: [],
        ownerPid: process.pid,
      }),
    );
    await expect(startSidecar(cfg, { log: () => undefined })).rejects.toThrow(/group\/world/);
  });
});

describe('lifetime (P-NET-23, A-8)', () => {
  it('exits exitGraceMs after the bound Claude pid dies', async () => {
    let alive = true;
    const h = await setup({ pollMs: 10, exitGraceMs: 60 }, { isAlive: (pid) => (pid === 4242 ? alive : true) });
    h.sc.bindClaudePid(4242);
    await sleep(50);
    expect(h.exits).toEqual([]);
    alive = false;
    const t0 = Date.now();
    await waitFor(() => h.exits.length === 1);
    expect(h.exits).toEqual(['claudeExited']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it('a pid that comes back within the grace does not end it', async () => {
    let alive = false;
    const h = await setup({ pollMs: 10, exitGraceMs: 200 }, { isAlive: () => alive });
    h.sc.bindClaudePid(4242);
    await sleep(40);
    alive = true;
    await sleep(250);
    expect(h.exits).toEqual([]);
  });

  it('before a bind, the owner dying ends it', async () => {
    const h = await setup({ pollMs: 10, exitGraceMs: 20 }, { isAlive: (pid) => pid !== 999_999 });
    expect(h.exits).toEqual([]);
    const h2 = await setup({ pollMs: 10, exitGraceMs: 20, ownerPid: 999_999 }, { isAlive: (pid) => pid !== 999_999 });
    await waitFor(() => h2.exits.length === 1);
    expect(h2.exits).toEqual(['ownerGone']);
    expect(h.exits).toEqual([]);
  });

  it('shutdown closes live tunnels and stops listening', async () => {
    const h = await setup();
    const c = open(h.sc.port);
    c.sock.write(connectHead('example.com:443'));
    await waitFor(() => c.data().startsWith(OK));
    await h.sc.shutdown('test');
    await c.closed;
    const refused = await new Promise<string | undefined>((r) => {
      const s = net.connect(h.sc.port, '127.0.0.1');
      s.on('error', (e: NodeJS.ErrnoException) => {
        r(e.code);
      });
      s.on('connect', () => {
        s.destroy();
        r('connected');
      });
    });
    expect(refused).toBe('ECONNREFUSED');
  });
});

describe('parseConfig', () => {
  const base = {
    v: 1,
    tokenA: TOKEN,
    controlToken: CTL,
    controlSocketPath: '/x/net.sock',
    allowPrivate: false,
    allowPorts: [443],
    denyPorts: [],
    ownerPid: 5,
  };
  it('fills defaults', () => {
    expect(parseConfig(JSON.stringify(base))).toMatchObject({ ...base, ...SIDECAR_DEFAULTS });
  });
  it.each([
    [{ tokenA: 'NOT-HEX' }, /tokenA/],
    [{ controlToken: 'short' }, /controlToken/],
    [{ controlSocketPath: 'rel/net.sock' }, /controlSocketPath/],
    [{ allowPorts: [0] }, /ports/],
    [{ ownerPid: 0 }, /ownerPid/],
    [{ v: 2 }, /version/],
    [{ resolveOverrides: { 'a:443': { host: 'not-an-ip', port: 1 } } }, /resolveOverrides/],
  ])('rejects %j without echoing secrets', (patch, re) => {
    let msg = '';
    try {
      parseConfig(JSON.stringify({ ...base, ...patch }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(re);
    expect(msg).not.toContain(TOKEN);
  });
});

describe('verifier additions (WP-04 audit)', () => {
  it('bytes sent after the head but before the upstream connects are held, then forwarded in order (P-NET-04)', async () => {
    const h = await setup(
      {},
      {
        connect: (o) => {
          const s = new net.Socket({ allowHalfOpen: true });
          setTimeout(() => s.connect(o as net.TcpNetConnectOpts), 150); // slow dial
          return s;
        },
      },
    );
    const c = open(h.sc.port);
    await new Promise<void>((r) =>
      c.sock.once('connect', () => {
        r();
      }),
    );
    c.sock.write(connectHead('api.anthropic.com:443'));
    await sleep(30);
    c.sock.write('one');
    await sleep(30);
    c.sock.write('two');
    expect(c.data()).toBe(''); // no 200 before the upstream connected (P-NET-08)
    await waitFor(() => c.data().length >= `${OK}ECHO:onetwo`.length);
    expect(c.data()).toBe(`${OK}ECHO:onetwo`);
    c.sock.destroy();
  });

  it('a client that leaves during the dial ends with exactly one terminal record and no leaked tunnel', async () => {
    const h = await setup({ connectTimeoutMs: 150 }, { connect: () => new net.Socket() });
    const c = open(h.sc.port);
    await new Promise<void>((r) =>
      c.sock.once('connect', () => {
        r();
      }),
    );
    c.sock.write(connectHead('example.com:443'));
    await sleep(40);
    c.sock.destroy();
    // The client is paused during the dial, so its FIN is only seen once the 504 is written: one terminal record, no leak.
    await sleep(400);
    expect(h.records.map((r) => r.kind)).toEqual(['open', 'refused']);
    expect(h.records[1]?.error).toBe('connectTimeout');
    expect(h.sc.stats().tunnels).toBe(0);
  });

  it('the pending-head cap drops extra head-less connections; a FIN before the head frees the slot at once (P-NET-16)', async () => {
    const h = await setup({ maxPendingHeads: 2 });
    const a = open(h.sc.port);
    const b = open(h.sc.port);
    await Promise.all(
      [a, b].map(
        (x) =>
          new Promise<void>((r) =>
            x.sock.once('connect', () => {
              r();
            }),
          ),
      ),
    );
    await sleep(30);
    const third = open(h.sc.port);
    await third.closed; // destroyed at once, nothing written
    expect(third.data()).toBe('');
    a.sock.destroy();
    b.sock.destroy();
    await Promise.all([a.closed, b.closed]);
    await sleep(30);
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'ok'])).toBe(`${OK}ECHO:ok`);
  });

  it('a subscriber that stops reading loses events; tunnels keep flowing (NP §4.3)', async () => {
    const h = await setup({ subscriberHighWater: 1024 });
    const cc = controlClient(h.cfg.controlSocketPath);
    cc.send({ op: 'hello', token: CTL });
    await waitFor(() => cc.lines.length === 1);
    cc.sock.pause(); // a stuck consumer
    // Each 407 puts two records on the stream; keep going until the kernel and the socket buffer are full.
    for (let batch = 0; batch < 40 && h.sc.stats().dropped === 0; batch++) {
      const outs = await Promise.all(
        Array.from({ length: 50 }, () => run(h.sc.port, [connectHead('api.anthropic.com:443', null)], { untilHead: true })),
      );
      expect(outs.every((o) => o.startsWith('HTTP/1.1 407 '))).toBe(true);
    }
    expect(h.sc.stats().dropped).toBeGreaterThan(0);
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'live'])).toBe(`${OK}ECHO:live`);
    cc.sock.destroy();
  });

  it('noteUncaught counts and logs the error and the proxy keeps serving (NP §4.3)', async () => {
    const h = await setup();
    h.sc.noteUncaught(Object.assign(new Error('boom'), { code: 'EBOOM' }));
    expect(h.sc.stats().uncaught).toBe(1);
    expect(h.logs.some((l) => l['ev'] === 'uncaught' && l['code'] === 'EBOOM')).toBe(true);
    expect(await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'x'])).toBe(`${OK}ECHO:x`);
  });

  it('numeric host spellings are resolved and then checked (post-DNS policy), and hex v4-mapped literals are refused', async () => {
    const h = await setup({ resolveOverrides: {} }, { lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]) });
    expect(await run(h.sc.port, [connectHead('127.1:443')])).toMatch(/^HTTP\/1\.1 403 /);
    expect(await run(h.sc.port, [connectHead('[::ffff:7f00:1]:443')])).toMatch(/^HTTP\/1\.1 403 /);
    expect(h.up.connections).toBe(0);
    for (const a of ['::ffff:a9fe:a9fe', '::127.0.0.1', '224.0.0.1', 'ff02::1', '255.255.255.255'])
      expect(addressRefusal(a, true)).toBe('blockedAddress');
    expect(addressRefusal('::ffff:a00:1', false)).toBe('privateAddress');
  });

  it('the 407 path never logs or emits the presented credential', async () => {
    const h = await setup();
    const wrong = `Proxy-Authorization: Basic ${b64('ccd:deadbeefdeadbeefdeadbeefdeadbeef')}`;
    await run(h.sc.port, [connectHead('api.anthropic.com:443', wrong)]);
    await run(h.sc.port, [connectHead('api.anthropic.com:443'), 'x']);
    const all = JSON.stringify(h.logs) + JSON.stringify(h.records);
    expect(all).not.toContain('deadbeefdeadbeef');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(b64(`ccd:${TOKEN}`));
    expect(all.toLowerCase()).not.toContain('proxy-authorization');
  });
});
