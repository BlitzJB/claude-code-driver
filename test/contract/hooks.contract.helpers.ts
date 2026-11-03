// test/contract/hooks.contract.helpers.ts — shared helpers for the WP-03 hook transport tests: a real-clock/ids/logger triple,
// private runtime dirs, a "dist-like" build of the worker + forwarder (plain .js, no type stripping needed), and the real
// Claude-side drivers (an HTTP client that behaves like Claude's axios hook client, and a unix client that speaks the
// forwarder's wire protocol).
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { Logger, LogFields } from '../../src/model/logger.js';
import type { Clock, MonoMs, WallMs } from '../../src/model/time.js';
import type { HookEndpoint, IdPort } from '../../src/platform/ports.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HOOK_SRC = join(ROOT, 'src', 'platform', 'hook-server');

export function realClock(): Clock {
  return {
    now: () => performance.now() as MonoMs,
    wallNow: () => Date.now() as WallMs,
    setTimer: () => () => undefined,
    sleep: (ms: number) =>
      new Promise<void>((r) => {
        setTimeout(r, ms);
      }),
  };
}

export function realIds(): IdPort {
  return {
    uuidV4: () => crypto.randomUUID(),
    tokenHex: (bytes: number) => randomBytes(bytes).toString('hex'),
    shortHex: (n: number) =>
      randomBytes(Math.ceil(n / 2))
        .toString('hex')
        .slice(0, n),
  };
}

export interface MemLogger extends Logger {
  lines: { level: string; m: string; f?: LogFields }[];
}
export function memLogger(): MemLogger {
  const lines: MemLogger['lines'] = [];
  const at =
    (level: string) =>
    (m: string, f?: LogFields): void => {
      lines.push(f === undefined ? { level, m } : { level, m, f });
    };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A fresh 0700 dir under os.tmpdir() (per-user 0700 on macOS; 66-byte socket paths, SEC §2.5). */
export function privateDir(prefix = 'ccd-'): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const WORKER_CLOSURE = ['worker', 'auth', 'body', 'http-server', 'unix-server'];

/**
 * Transpiles the worker closure and the forwarder into `<tmp>/dist/platform/hook-server/**.js`, the same layout `tsc` emits,
 * so tests can spawn them exactly as production does (P-API-13) on any Node version.
 */
export function buildHookServerDist(): { root: string; workerUrl: URL; forwarderPath: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ccd-hookdist-'));
  const outDir = join(root, 'dist', 'platform', 'hook-server');
  mkdirSync(join(outDir, 'standalone'), { recursive: true });
  const emit = (srcRel: string): void => {
    const src = readFileSync(join(HOOK_SRC, `${srcRel}.ts`), 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
      fileName: `${srcRel}.ts`,
    });
    writeFileSync(join(outDir, `${srcRel}.js`), out.outputText);
  };
  for (const f of WORKER_CLOSURE) emit(f);
  emit('standalone/forward');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  return {
    root,
    workerUrl: pathToFileURL(join(outDir, 'worker.js')),
    forwarderPath: join(outDir, 'standalone', 'forward.js'),
    remove: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** True when this Node can run the src `.ts` files directly (Node ≥ 22.18 type stripping). */
export const CAN_STRIP_TYPES = Boolean((process.features as { typescript?: unknown }).typescript);

export interface ClientReply {
  status: number;
  /** '' for an empty body; for unix, `{}` is normalised to '' (the forwarder prints nothing for it). */
  body: string;
}

export interface ClientCall {
  reply: Promise<ClientReply>;
  /** The client goes away (Claude killed the forwarder / aborted the request). */
  abort(): void;
  /** The forwarder's abort line, then close (Claude's hook timeout). */
  timeout(): void;
}

/** Like Claude's axios hook client: POST, JSON content type, literal token header, Host from the URL. */
export function httpHook(
  ep: HookEndpoint,
  event: string,
  body: string | Buffer,
  o: { headers?: Record<string, string | undefined>; method?: string; path?: string } = {},
): ClientCall {
  const http = ep.http;
  if (http === undefined) throw new Error('endpoint has no http part');
  let abort = (): void => undefined;
  const reply = new Promise<ClientReply>((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-ccd-token': http.token };
    for (const [k, v] of Object.entries(o.headers ?? {})) {
      if (v === undefined) Reflect.deleteProperty(headers, k);
      else headers[k] = v;
    }
    const req = request(
      {
        host: '127.0.0.1',
        port: http.port,
        method: o.method ?? 'POST',
        path: o.path ?? `${new URL(http.urlBase).pathname}${event}`,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    abort = () => {
      req.destroy();
    };
    req.end(body);
  });
  return { reply, abort, timeout: abort };
}

/** Speaks the forwarder protocol over the unix socket (token read from fwd.json, like the real forwarder). */
export function unixHook(ep: HookEndpoint, event: string, payloadJson: string, o: { token?: string; raw?: string } = {}): ClientCall {
  const cfg = JSON.parse(readFileSync(ep.unix.forwarderConfigPath, 'utf8')) as { socketPath: string; token: string };
  const sock = connect(cfg.socketPath);
  const reply = new Promise<ClientReply>((resolve) => {
    let buf = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const line = buf.split('\n')[0] ?? '';
      resolve({ status: 200, body: line === '{}' ? '' : line });
    };
    sock.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      if (buf.includes('\n')) finish();
    });
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', finish);
  });
  sock.on('connect', () => {
    sock.write(o.raw ?? `{"v":1,"token":"${o.token ?? cfg.token}","event":"${event}","payload":${payloadJson}}\n`);
  });
  return {
    reply,
    abort: () => {
      sock.destroy();
    },
    timeout: () => {
      sock.write('{"v":1,"abort":"signal"}\n', () => {
        sock.destroy(); // the forwarder exits right after its abort line
      });
    },
  };
}
