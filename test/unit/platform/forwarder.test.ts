// test/unit/platform/forwarder.test.ts — the command-hook forwarder (DESIGN.md §3.5, HT §2.3): P-HOOK-24/25/26/27/28/30/64,
// P-SEC-21/38. Pure helpers, `runForwarder` with injected io against a real unix socket, a static source audit, and (where
// Node strips types) the script spawned from src exactly as Claude runs it.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ABORT_LINE,
  buildRequestLine,
  isValidEventName,
  parseFwdConfig,
  payloadAsLine,
  runForwarder,
  stdoutForReply,
} from '../../../src/platform/hook-server/standalone/forward.js';
import type { ForwarderIo } from '../../../src/platform/hook-server/standalone/forward.js';
import { UNIX_REQUEST_RE } from '../../../src/platform/hook-server/unix-server.js';
import { CAN_STRIP_TYPES, HOOK_SRC, privateDir } from '../../contract/hooks.contract.helpers.js';

const TOKEN = 'c'.repeat(64);
const FORWARD_SRC = join(HOOK_SRC, 'standalone', 'forward.ts');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('forwarder helpers', () => {
  it('parseFwdConfig accepts only {absolute socketPath, 64-hex token}', () => {
    expect(parseFwdConfig(JSON.stringify({ socketPath: '/d/h.sock', token: TOKEN }))).toEqual({ socketPath: '/d/h.sock', token: TOKEN });
    expect(parseFwdConfig(JSON.stringify({ socketPath: 'rel/h.sock', token: TOKEN }))).toBeUndefined(); // P-HOOK-30
    expect(parseFwdConfig(JSON.stringify({ socketPath: '/d/h.sock', token: 'x' }))).toBeUndefined();
    expect(parseFwdConfig('[1]')).toBeUndefined();
    expect(parseFwdConfig('null')).toBeUndefined();
    expect(parseFwdConfig('{nope')).toBeUndefined();
  });

  it('event names are plain identifiers', () => {
    expect(isValidEventName('PermissionRequest')).toBe(true);
    expect(isValidEventName('Perm","x')).toBe(false);
    expect(isValidEventName(undefined)).toBe(false);
  });

  it('payloadAsLine keeps JSON valid on one line; empty stdin is null', () => {
    const pretty = Buffer.from('{\r\n  "a": 1,\n  "b": [2]\n}\n');
    const out = payloadAsLine(pretty);
    expect(out.includes(0x0a)).toBe(false);
    expect(JSON.parse(out.toString())).toEqual({ a: 1, b: [2] });
    expect(payloadAsLine(Buffer.alloc(0)).toString()).toBe('null');
    expect(payloadAsLine(Buffer.from(' \n\t ')).toString()).toBe('null');
  });

  it('buildRequestLine produces exactly the prefix the unix server checks', () => {
    const l = buildRequestLine({ socketPath: '/s', token: TOKEN }, 'SessionStart', Buffer.from('{"source":"startup"}'));
    const text = l.toString();
    expect(text.endsWith('}\n')).toBe(true);
    expect(UNIX_REQUEST_RE.exec(text)?.slice(1)).toEqual([TOKEN, 'SessionStart']);
    expect(JSON.parse(text)).toEqual({ v: 1, token: TOKEN, event: 'SessionStart', payload: { source: 'startup' } });
  });

  it('stdoutForReply prints only a non-empty JSON object (P-HOOK-25)', () => {
    expect(stdoutForReply('{}')).toBe('');
    expect(stdoutForReply('')).toBe('');
    expect(stdoutForReply('  {}  ')).toBe('');
    expect(stdoutForReply('[]')).toBe('');
    expect(stdoutForReply('"text"')).toBe('');
    expect(stdoutForReply('garbage')).toBe('');
    expect(stdoutForReply('{"hookSpecificOutput":{"x":1}}')).toBe('{"hookSpecificOutput":{"x":1}}');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
interface FakeServer {
  socketPath: string;
  configPath: string;
  lines: string[];
  sockets: Socket[];
  /** What to answer for the next request; undefined = hold (no answer). */
  answer: string | undefined;
  server: Server;
}

async function fakeServer(): Promise<FakeServer> {
  const d = privateDir();
  cleanups.push(d.remove);
  const socketPath = join(d.dir, 'h.sock');
  const configPath = join(d.dir, 'fwd.json');
  writeFileSync(configPath, JSON.stringify({ socketPath, token: TOKEN }), { mode: 0o600 });
  const fs: FakeServer = { socketPath, configPath, lines: [], sockets: [], answer: '{}', server: undefined as unknown as Server };
  fs.server = createServer((s) => {
    fs.sockets.push(s);
    let buf = '';
    s.on('data', (c: Buffer) => {
      buf += c.toString();
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        fs.lines.push(l);
        if (!l.includes('"abort"') && fs.answer !== undefined) s.end(`${fs.answer}\n`);
        nl = buf.indexOf('\n');
      }
    });
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => fs.server.listen(socketPath, r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const s of fs.sockets) s.destroy();
        fs.server.close(() => {
          r();
        });
      }),
  );
  return fs;
}

interface TestIo extends ForwarderIo {
  out: () => string;
  exits: number;
  connects: number;
  stdinEndedBeforeConnect: boolean | undefined;
  signal: () => void;
  stdinStream: PassThrough;
}

function testIo(): TestIo {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c: Buffer) => (out += c.toString()));
  let stdinEnded = false;
  stdin.on('end', () => (stdinEnded = true));
  let sig: () => void = () => undefined;
  const io: TestIo = {
    stdin,
    stdinStream: stdin,
    stdout,
    out: () => out,
    exits: 0,
    connects: 0,
    stdinEndedBeforeConnect: undefined,
    exit: () => {
      io.exits += 1;
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    connect: (p) => {
      io.connects += 1;
      io.stdinEndedBeforeConnect = stdinEnded;
      return connect(p);
    },
    onSignal: (fn) => {
      sig = fn;
    },
    signal: () => {
      sig();
    },
  };
  return io;
}

describe('runForwarder (injected io, real unix socket)', () => {
  it('reads stdin to EOF before connecting, sends one request line, prints exactly the decision body (P-HOOK-24)', async () => {
    const srv = await fakeServer();
    srv.answer = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
    const io = testIo();
    const run = runForwarder([srv.configPath, 'PermissionRequest'], io);
    io.stdinStream.write('{"tool_name":');
    io.stdinStream.end('"Bash"}');
    await run;
    expect(io.stdinEndedBeforeConnect).toBe(true);
    expect(srv.lines).toHaveLength(1);
    expect(JSON.parse(srv.lines[0] ?? '')).toEqual({ v: 1, token: TOKEN, event: 'PermissionRequest', payload: { tool_name: 'Bash' } });
    expect(io.out()).toBe(srv.answer);
    expect(io.exits).toBe(1);
  });

  it('an empty reply {} prints nothing (SessionStart/UPS stdout would become model context, P-HOOK-25)', async () => {
    const srv = await fakeServer();
    const io = testIo();
    const run = runForwarder([srv.configPath, 'SessionStart'], io);
    io.stdinStream.end('{"source":"startup"}');
    await run;
    expect(io.out()).toBe('');
    expect(io.exits).toBe(1);
  });

  it.each([
    ['missing config file', (_c: string) => ['/nonexistent/fwd.json', 'Stop']],
    ['relative config path (P-HOOK-30)', (_c: string) => ['fwd.json', 'Stop']],
    ['bad event name', (c: string) => [c, 'Stop","x']],
    ['no args', (_c: string) => []],
  ])('%s: drains stdin, never connects, prints nothing, exits once', async (_name, args) => {
    const srv = await fakeServer();
    const io = testIo();
    const run = runForwarder(args(srv.configPath), io);
    io.stdinStream.end('{"x":1}');
    await run;
    expect(io.connects).toBe(0);
    expect(io.out()).toBe('');
    expect(io.exits).toBe(1);
  });

  it('a dead endpoint (socket gone / refused) fails open silently (P-HOOK-27)', async () => {
    const srv = await fakeServer();
    await new Promise<void>((r) => {
      srv.server.close(() => {
        r();
      });
    });
    const io = testIo();
    const run = runForwarder([srv.configPath, 'PermissionRequest'], io);
    io.stdinStream.end('{}');
    await run;
    expect(io.connects).toBe(1);
    expect(io.out()).toBe('');
    expect(io.exits).toBe(1);
  });

  it('the server closing without an answer prints nothing', async () => {
    const srv = await fakeServer();
    srv.answer = undefined;
    const io = testIo();
    const run = runForwarder([srv.configPath, 'Stop'], io);
    io.stdinStream.end('{}');
    await vi.waitFor(() => {
      expect(srv.lines).toHaveLength(1);
    });
    for (const s of srv.sockets) s.end();
    await run;
    expect(io.out()).toBe('');
    expect(io.exits).toBe(1);
  });

  it('a signal while held sends the abort line, prints nothing and exits (P-HOOK-64)', async () => {
    const srv = await fakeServer();
    srv.answer = undefined;
    const io = testIo();
    const run = runForwarder([srv.configPath, 'PermissionRequest'], io);
    io.stdinStream.end('{}');
    await vi.waitFor(() => {
      expect(srv.lines).toHaveLength(1);
    });
    io.signal();
    await run;
    await vi.waitFor(() => {
      expect(srv.lines).toEqual([expect.stringContaining('"PermissionRequest"'), ABORT_LINE.trim()]);
    });
    expect(io.out()).toBe('');
    expect(io.exits).toBe(1);
  });

  it('a signal before stdin ended exits at once without connecting', async () => {
    const srv = await fakeServer();
    const io = testIo();
    const run = runForwarder([srv.configPath, 'Stop'], io);
    io.signal();
    io.stdinStream.end('{}');
    await run;
    expect(io.connects).toBe(0);
    expect(io.exits).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('forwarder source audit', () => {
  const src = readFileSync(FORWARD_SRC, 'utf8');
  const sf = ts.createSourceFile('forward.ts', src, ts.ScriptTarget.ES2023, true);
  const imports: string[] = [];
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) imports.push(n.moduleSpecifier.text);
    if (ts.isPropertyAccessExpression(n)) names.add(`${n.expression.getText(sf)}.${n.name.text}`);
    if (ts.isIdentifier(n)) names.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  it('imports node:* only and never child_process (never forks, P-HOOK-26)', () => {
    expect(imports.every((i) => i.startsWith('node:'))).toBe(true);
    expect(imports).not.toContain('node:child_process');
    expect(imports).not.toContain('node:http');
  });

  it('never reads the environment (P-SEC-38, P-HOOK-28) and never writes a file (P-SEC-21: no $CLAUDE_ENV_FILE)', () => {
    expect(names.has('process.env')).toBe(false);
    for (const w of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'openSync'])
      expect(names.has(w)).toBe(false);
    expect(src.includes('CLAUDE_ENV_FILE')).toBe(true); // only in the comment that documents the rule
    expect(src.match(/CLAUDE_ENV_FILE/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.runIf(CAN_STRIP_TYPES)('forwarder spawned from src (Node type stripping)', () => {
  const run = (
    args: string[],
    stdin: Buffer | string,
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; out: string; ms: number }> =>
    new Promise((resolve, reject) => {
      const t0 = performance.now();
      const child = spawn(process.execPath, [FORWARD_SRC, ...args], {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin', ...env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.on('error', reject);
      child.on('exit', (code) => {
        resolve({ code, out, ms: performance.now() - t0 });
      });
      child.stdin.on('error', () => undefined); // an EPIPE here would be the bug P-HOOK-24 describes
      child.stdin.end(stdin);
    });

  it('dead endpoint: exit 0, no output, fast (P-HOOK-27)', async () => {
    const d = privateDir();
    cleanups.push(d.remove);
    const cfg = join(d.dir, 'fwd.json');
    writeFileSync(cfg, JSON.stringify({ socketPath: join(d.dir, 'h.sock'), token: TOKEN }));
    const r = await run([cfg, 'SessionStart'], '{"source":"startup"}');
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(r.ms).toBeLessThan(3000);
  });

  it(
    'a 10 MB stdin is read completely and forwarded; CLAUDE_ENV_FILE and proxy vars change nothing (P-SEC-21, P-HOOK-28)',
    { timeout: 20_000 },
    async () => {
      const srv = await fakeServer();
      const envFile = join(srv.socketPath, '..', 'claude-env');
      const payload = JSON.stringify({ big: 'z'.repeat(10 * 1000 * 1000) });
      const r = await run([srv.configPath, 'PostToolUse'], payload, {
        CLAUDE_ENV_FILE: envFile,
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
      });
      expect(r).toMatchObject({ code: 0, out: '' });
      expect(srv.lines).toHaveLength(1);
      expect((JSON.parse(srv.lines[0] ?? '') as { payload: { big: string } }).payload.big).toHaveLength(10 * 1000 * 1000);
      expect(existsSync(envFile)).toBe(false);
    },
  );
});
