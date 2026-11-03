// platform/hook-server/unix-server.ts — the unix socket server for the command forwarder (DESIGN.md §3.5, D-11, SEC §2.4/§2.5,
// HT §2.3/§6/§9).
//
// Socket `<sessionDir>/h.sock` in the 0700 session dir; any stale socket file there is unlinked before listen (P-HOOK-40);
// `chmod 0600` after listen (Node creates it with the umask, P-HOOK-43); the path length is asserted by the caller.
//
// Wire protocol (one connection per hook call, written by standalone/forward.ts):
//   request  = `{"v":1,"token":"<64 hex>","event":"<Ev>","payload":<stdin JSON>}` + "\n"   (the token prefix is checked before
//              the payload is buffered, so an unauthenticated client never makes us hold a large line)
//   reply    = one line: the JSON body, or `{}` (the forwarder prints nothing for `{}`)
//   abort    = `{"v":1,"abort":"signal"}` + "\n" sent by the forwarder after the request when Claude terminated it (hook
//              timeout or turn abort) while the request was held → `closed` reason 'timeout'; a plain close → 'client_gone'.
// PermissionRequest is held (`holdable:true`) until `respond()`; every other event is answered at once, `{}` except the armed
// self-test nonce on UserPromptSubmit (constant block body). Limits: `maxConnections` concurrent connections and `maxHeld`
// held requests; excess is answered `{}` (the native dialog appears and the core adopts it, §3.7 step 8). No timeouts
// (P-HOOK-60): a hold lasts until we answer or Claude kills the forwarder.
//
// Loaded inside the hook worker by a computed `import()`: node:* imports and erasable syntax only (see auth.ts).
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { CappedAccumulator } from './body.js';
import type { HookSinkEvent } from './http-server.js';

/** Fixed request prefix: version, token, event name, then the raw payload JSON (built by the forwarder without parsing). */
export const UNIX_REQUEST_RE = /^\{"v":1,"token":"([0-9a-f]{64})","event":"([A-Za-z]{1,64})","payload":/;
/** Longest possible prefix: 16 + 64 + 11 + 64 + 12 bytes. */
const UNIX_PREFIX_MAX = 167;
const ABORT_MARK = '"abort"';
const EMPTY_REPLY = '{}';

export interface UnixHookSink {
  authFailure(reason: string): void;
  dropped(reason: 'connections' | 'event' | 'held' | 'queue'): void;
  badJson(): void;
  /** The constant reply body for a non-held event: '' (→ `{}`) or the self-test block body. */
  replyFor(event: string, payload: unknown): string;
  event(e: HookSinkEvent): number | undefined;
  /** A held request's connection closed before we answered. */
  closed(hookSeq: number, reason: 'client_gone' | 'timeout'): void;
}

interface UnixHookServerDeps {
  newAccumulator(maxBytes: number): CappedAccumulator;
  tokenEquals(given: string | undefined, expected: string): boolean;
  tryParseJson(data: Buffer): { ok: true; value: unknown } | { ok: false };
}

export interface UnixHookServerOptions {
  socketPath: string;
  token: string;
  /** Events accepted over the forwarder. */
  events: ReadonlySet<string>;
  /** Events held until `respond()` (PermissionRequest). */
  holdEvents: ReadonlySet<string>;
  maxBodyBytes: number;
  maxConnections: number;
  maxHeld: number;
  deps: UnixHookServerDeps;
  sink: UnixHookSink;
}

export interface UnixHookServer {
  listen(): Promise<void>;
  /** Answers a held request once; false when it is unknown, already answered or its client is gone. */
  respond(hookSeq: number, body: string | null): boolean;
  heldCount(): number;
  connectionCount(): number;
  /** Answers every held request with `heldBody` (null → `{}`), stops listening, closes sockets, unlinks the socket file. */
  close(heldBody: string | null): Promise<void>;
}

interface Held {
  socket: Socket;
  abortSeen: boolean;
}

export function createUnixHookServer(o: UnixHookServerOptions): UnixHookServer {
  const held = new Map<number, Held>();
  const sockets = new Set<Socket>();
  let closing = false;
  /** True once our own listen() created the socket file: only then may close() unlink it (never a file we refused). */
  let ownsSocketFile = false;

  const reply = (socket: Socket, body: string): void => {
    if (socket.destroyed) return;
    socket.end(`${body === '' ? EMPTY_REPLY : body}\n`);
  };

  const onConnection = (socket: Socket): void => {
    socket.on('error', () => {
      // EPIPE / ECONNRESET from a forwarder that died: 'close' follows.
    });
    if (closing || sockets.size >= o.maxConnections) {
      o.sink.dropped('connections');
      socket.resume();
      reply(socket, '');
      return;
    }
    sockets.add(socket);

    const acc = o.deps.newAccumulator(o.maxBodyBytes + UNIX_PREFIX_MAX + 2);
    let head = Buffer.alloc(0);
    let headChecked = false;
    let state: 'reading' | 'held' | 'done' = 'reading';
    let heldSeq = 0;
    let tail = '';
    const currentState = (): 'reading' | 'held' | 'done' => state; // read through a call: `finish()` changes it

    const reject = (reason: string): void => {
      state = 'done';
      o.sink.authFailure(reason);
      socket.destroy();
    };

    /** Validates the fixed prefix as soon as enough bytes are in; returns the event name or undefined (socket destroyed). */
    const checkHead = (complete: boolean): { event: string; prefixLen: number } | undefined => {
      if (!complete && head.length < UNIX_PREFIX_MAX) return { event: '', prefixLen: 0 };
      const m = UNIX_REQUEST_RE.exec(head.toString('latin1'));
      if (m === null) {
        reject('format');
        return undefined;
      }
      if (!o.deps.tokenEquals(m[1], o.token)) {
        reject('token');
        return undefined;
      }
      headChecked = true;
      return { event: m[2] ?? '', prefixLen: m[0].length };
    };

    const finish = (): void => {
      if (state !== 'reading') return;
      const h = checkHead(true);
      if (h === undefined) return;
      const { event, prefixLen } = h;
      if (!o.events.has(event)) {
        state = 'done';
        o.sink.dropped('event');
        reply(socket, '');
        return;
      }
      const line = acc.concat();
      if (acc.truncated || line === undefined) {
        state = 'done';
        reply(socket, '');
        o.sink.event({
          transport: 'unix',
          event,
          bytes: Math.max(0, acc.bytes - prefixLen - 1),
          truncated: true,
          payload: null,
          holdable: false,
        });
        return;
      }
      let end = line.length;
      while (end > prefixLen && (line[end - 1] === 0x20 || line[end - 1] === 0x09 || line[end - 1] === 0x0d)) end -= 1;
      if (end <= prefixLen || line[end - 1] !== 0x7d /* } */) {
        state = 'done';
        o.sink.badJson();
        reply(socket, '');
        return;
      }
      const raw = line.subarray(prefixLen, end - 1);
      const parsed = o.deps.tryParseJson(raw);
      if (!parsed.ok) {
        state = 'done';
        o.sink.badJson();
        reply(socket, '');
        return;
      }
      const base = { transport: 'unix' as const, event, bytes: raw.length, truncated: false, payload: parsed.value };
      if (o.holdEvents.has(event)) {
        if (held.size >= o.maxHeld) {
          // SEC §2.7: over the held cap → `{}` at once; the dialog appears and the core adopts it (§3.7 step 8).
          state = 'done';
          o.sink.dropped('held');
          reply(socket, '');
          o.sink.event({ ...base, holdable: false });
          return;
        }
        const seq = o.sink.event({ ...base, holdable: true });
        if (seq === undefined) {
          state = 'done';
          reply(socket, '');
          return;
        }
        state = 'held';
        heldSeq = seq;
        held.set(seq, { socket, abortSeen: false });
        return;
      }
      state = 'done';
      reply(socket, o.sink.replyFor(event, parsed.value));
      o.sink.event({ ...base, holdable: false });
    };

    socket.on('data', (chunk: Buffer) => {
      if (state === 'held') {
        // After the request only the forwarder's abort line can arrive; keep a small tail to find it across chunks.
        tail = (tail + chunk.toString('latin1')).slice(-256);
        const h = held.get(heldSeq);
        if (h !== undefined && tail.includes(ABORT_MARK)) h.abortSeen = true;
        return;
      }
      if (state !== 'reading') return;
      const nl = chunk.indexOf(0x0a);
      const part = nl === -1 ? chunk : chunk.subarray(0, nl);
      if (head.length < UNIX_PREFIX_MAX) head = Buffer.concat([head, part.subarray(0, UNIX_PREFIX_MAX - head.length)]);
      if (!headChecked && checkHead(false) === undefined) return;
      acc.push(part);
      if (nl !== -1) {
        finish();
        if (currentState() === 'held') {
          tail = chunk.subarray(nl + 1).toString('latin1');
          const h = held.get(heldSeq);
          if (h !== undefined && tail.includes(ABORT_MARK)) h.abortSeen = true;
        }
      }
    });
    socket.on('end', () => {
      // A forwarder that half-closes without a newline still gets its request processed.
      if (state === 'reading' && acc.bytes > 0) finish();
      else if (state === 'reading') {
        state = 'done';
        socket.end();
      } else if (state === 'held') {
        // Our forwarder never half-closes while it waits for the answer, so EOF on a held request means it is gone
        // (killed by Claude). Close our side too, so 'close' reports it.
        socket.destroy();
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      if (state === 'held') {
        const h = held.get(heldSeq);
        if (h?.socket === socket) {
          held.delete(heldSeq);
          o.sink.closed(heldSeq, h.abortSeen ? 'timeout' : 'client_gone');
        }
      }
      state = 'done';
    });
  };

  // allowHalfOpen: a forwarder that ends its write side still receives the reply.
  const server: Server = createServer({ allowHalfOpen: true }, onConnection);

  return {
    async listen(): Promise<void> {
      // P-HOOK-40: unlink a stale socket from a previous run, but only a socket (never a file or a symlink we did not make).
      const st = await lstat(o.socketPath).catch((err: unknown) => {
        if ((err as { code?: string }).code === 'ENOENT') return undefined;
        throw err;
      });
      if (st !== undefined) {
        if (!st.isSocket()) throw new Error(`refusing to replace non-socket ${o.socketPath}`);
        await unlink(o.socketPath);
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          reject(err);
        };
        server.once('error', onError);
        server.listen({ path: o.socketPath, exclusive: true }, () => {
          server.off('error', onError);
          ownsSocketFile = true;
          resolve();
        });
      });
      await chmod(o.socketPath, 0o600);
    },
    respond(hookSeq: number, body: string | null): boolean {
      const h = held.get(hookSeq);
      if (h === undefined) return false;
      held.delete(hookSeq);
      if (h.socket.destroyed) {
        // Destroyed but its 'close' has not run yet: that handler will no longer find the entry, so report the loss here.
        o.sink.closed(hookSeq, h.abortSeen ? 'timeout' : 'client_gone');
        return false;
      }
      reply(h.socket, body ?? '');
      return true;
    },
    heldCount(): number {
      return held.size;
    },
    connectionCount(): number {
      return sockets.size;
    },
    async close(heldBody: string | null): Promise<void> {
      closing = true;
      const line = `${heldBody === null || heldBody === '' ? EMPTY_REPLY : heldBody}\n`;
      const flushes = [...held].map(([seq, h]) => {
        held.delete(seq);
        return new Promise<void>((resolve) => {
          if (h.socket.destroyed) {
            resolve();
            return;
          }
          h.socket.once('close', () => {
            resolve();
          });
          h.socket.end(line, () => {
            resolve(); // 'finish': the answer reached the kernel
          });
        });
      });
      await Promise.all(flushes);
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
      });
      if (ownsSocketFile) {
        ownsSocketFile = false;
        // Unlink only what is still a socket at our path: a failed start must never delete the non-socket file it refused
        // to replace (P-HOOK-40), and a socket file we never created is not ours to remove.
        const st = await lstat(o.socketPath).catch(() => undefined);
        if (st?.isSocket() === true) await unlink(o.socketPath).catch(() => undefined);
      }
    },
  };
}
