// platform/hook-server/standalone/forward.ts — the command-hook forwarder (DESIGN.md §3.5, D-11/D-12, HT §2.3, SEC §2.2/§2.4).
//
// Settings register it in exec form: `"command": "<process.execPath>", "args": ["<abs>/forward.js", "<sessionDir>/fwd.json",
// "<Event>"]` (no shell, no PATH lookup: P-HOOK-29). For SessionStart (HTTP unsupported, P-HOOK-18), PermissionRequest
// (anti-squatting: the socket lives in our 0700 dir, SEC §2.4) and, with `hooks.transport:'unix'`, every event.
//
// Rules, each one a pitfall:
//   - socket path and token come from the 0600 `fwd.json` named in argv; the environment is ignored entirely (P-SEC-38: a
//     hostile NODE_OPTIONS is stripped by the env builder, and nothing here reads `process.env`; P-HOOK-28: a raw unix
//     socket, no HTTP client, so proxy variables cannot divert it);
//   - stdin is read to EOF before anything else (P-HOOK-24: exiting early gives Claude EPIPE);
//   - stdout carries exactly the reply body; `{}` (and anything that is not a JSON object) prints nothing, because plain
//     stdout on SessionStart/UserPromptSubmit becomes model context (P-HOOK-25);
//   - every failure (missing/invalid fwd.json, ENOENT, ECONNREFUSED, EPIPE, a closed connection) prints nothing and exits 0
//     (P-HOOK-27: no `hook error` notice; for PermissionRequest the native dialog appears and the core adopts it, §3.7 step 8);
//   - never forks and never leaves stdio open (P-HOOK-26); exits via `process.exit` once stdout is flushed;
//   - absolute paths only (P-HOOK-30); never writes `$CLAUDE_ENV_FILE` or any other file (P-SEC-21);
//   - when Claude terminates it (hook timeout or abort) while a request is held, it sends an abort line so the server reports
//     `closed: 'timeout'` instead of `'client_gone'` (P-HOOK-64).
//
// Standalone: imports `node:*` only (§1.4 3c) and uses erasable TypeScript syntax only (it also runs from src under Node's
// type stripping in tests).
import { readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export interface FwdConfig {
  socketPath: string;
  token: string;
}

export const ABORT_LINE = '{"v":1,"abort":"signal"}\n';
const TOKEN_RE = /^[0-9a-f]{64}$/;
const EVENT_RE = /^[A-Za-z]{1,64}$/;

/** Parses `fwd.json`; undefined for anything but `{socketPath: <absolute>, token: <64 hex>}`. */
export function parseFwdConfig(text: string): FwdConfig | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const { socketPath, token } = v as { socketPath?: unknown; token?: unknown };
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) return undefined;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
  return { socketPath, token };
}

export function isValidEventName(event: unknown): event is string {
  return typeof event === 'string' && EVENT_RE.test(event);
}

/**
 * The raw stdin JSON as one line: CR/LF become spaces (outside strings they are insignificant whitespace; inside strings JSON
 * forbids them anyway), surrounding whitespace is trimmed, an empty stdin becomes `null`. The forwarder never parses the
 * payload: the worker does (and counts bad JSON).
 */
export function payloadAsLine(stdin: Buffer): Buffer {
  const out = Buffer.from(stdin);
  for (let i = 0; i < out.length; i += 1) if (out[i] === 0x0a || out[i] === 0x0d) out[i] = 0x20;
  let start = 0;
  let end = out.length;
  const ws = (b: number | undefined): boolean => b === 0x20 || b === 0x09;
  while (start < end && ws(out[start])) start += 1;
  while (end > start && ws(out[end - 1])) end -= 1;
  return start === end ? Buffer.from('null') : out.subarray(start, end);
}

/** `{"v":1,"token":"…","event":"…","payload":<stdin>}\n` — the fixed prefix lets the server check the token first. */
export function buildRequestLine(cfg: FwdConfig, event: string, stdin: Buffer): Buffer {
  const head = Buffer.from(`{"v":1,"token":"${cfg.token}","event":"${event}","payload":`, 'utf8');
  return Buffer.concat([head, payloadAsLine(stdin), Buffer.from('}\n')]);
}

/** What to print for a reply line: the body when it is a non-empty JSON object, else nothing. */
export function stdoutForReply(reply: string): string {
  const text = reply.trim();
  if (text === '' || text === '{}') return '';
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length === 0) return '';
  } catch {
    return '';
  }
  return text;
}

export interface ForwarderIo {
  stdin: Readable;
  stdout: Writable;
  /** Ends the run (the real script calls `process.exit(0)` after stdout is flushed). */
  exit(): void;
  readFile(path: string): string;
  connect(path: string): Socket;
  /** Registers the termination handler (SIGTERM/SIGINT/SIGHUP in the real script). */
  onSignal(fn: () => void): void;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : (c as Buffer));
  } catch {
    // a broken stdin still counts as read: nothing more will come
  }
  return Buffer.concat(chunks);
}

/** One forwarder run: `argv` = [configPath, event]. Never throws; always ends with `io.exit()`. */
export async function runForwarder(argv: readonly string[], io: ForwarderIo): Promise<void> {
  let finished = false;
  const isFinished = (): boolean => finished;
  let socket: Socket | undefined;
  let connected = false;
  const finish = (out: string): void => {
    if (finished) return;
    finished = true;
    if (socket !== undefined && !socket.destroyed) socket.destroy();
    if (out === '') {
      io.exit();
      return;
    }
    try {
      io.stdout.write(out, () => {
        io.exit();
      });
    } catch {
      io.exit();
    }
  };
  let signalled = false;
  io.onSignal(() => {
    // Claude terminated us (hook timeout or abort): tell a held request why, print nothing, exit 0.
    if (finished) return;
    if (signalled) {
      finish(''); // a second signal: do not wait for the abort line to flush
      return;
    }
    signalled = true;
    const s = socket;
    if (s !== undefined && connected && !s.destroyed) {
      try {
        s.write(ABORT_LINE, () => {
          finish('');
        });
        return;
      } catch {
        // fall through
      }
    }
    finish('');
  });

  // P-HOOK-24: drain stdin first, whatever happens next.
  const stdin = await readAll(io.stdin);
  if (isFinished()) return; // a signal arrived while we were reading

  const [configPath, event] = argv;
  if (configPath === undefined || !isAbsolute(configPath) || !isValidEventName(event)) {
    finish('');
    return;
  }
  let cfg: FwdConfig | undefined;
  try {
    cfg = parseFwdConfig(io.readFile(configPath));
  } catch {
    cfg = undefined;
  }
  if (cfg === undefined) {
    finish('');
    return;
  }

  const line = buildRequestLine(cfg, event, stdin);
  await new Promise<void>((resolve) => {
    let reply = Buffer.alloc(0);
    const done = (out: string): void => {
      finish(out);
      resolve();
    };
    try {
      socket = io.connect(cfg.socketPath);
    } catch {
      done('');
      return;
    }
    const s = socket;
    s.on('connect', () => {
      connected = true;
      s.write(line);
    });
    s.on('data', (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      const nl = reply.indexOf(0x0a);
      if (nl !== -1) done(stdoutForReply(reply.subarray(0, nl).toString('utf8')));
      else if (reply.length > 64 * 1024 * 1024) done(''); // a reply this large is not ours
    });
    s.on('end', () => {
      done(stdoutForReply(reply.toString('utf8')));
    });
    s.on('error', () => {
      done(''); // ENOENT, ECONNREFUSED, EPIPE, ECONNRESET: fail open, silently (P-HOOK-27)
    });
    s.on('close', () => {
      done(stdoutForReply(reply.toString('utf8')));
    });
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const exit = (): void => {
    process.exit(0);
  };
  process.on('uncaughtException', exit);
  process.on('unhandledRejection', exit);
  process.stdout.on('error', exit); // Claude closed our stdout: nothing left to say
  void runForwarder(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    exit,
    readFile: (p) => readFileSync(p, 'utf8'),
    connect: (p) => connect(p),
    onSignal: (fn) => {
      process.on('SIGTERM', fn);
      process.on('SIGINT', fn);
      process.on('SIGHUP', fn);
    },
  });
}
