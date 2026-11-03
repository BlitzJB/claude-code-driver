// session/debug-trace.ts — DebugRecord writer (trace v1 = replay fixture format, D-32) and the bounded screen ring
// (DESIGN.md §1.2, §4.12 A-9, §6.6; AL §4.6 L-6, §8.2; SEC §8.2, §8.5; P-API-20, P-SEC-42).
//
// - Redaction happens HERE, at write time, before a record reaches the file or any in-process debug listener (P-API-20):
//   exact library secrets + patterns always; `raw:'meta'` (default) replaces content fields by `{len, sha256_8}` and raw
//   records by a metadata summary; `raw:'none'` writes no raw records; `raw:'full'` keeps content (pattern-redacted).
// - The file is created 0600 (and re-chmodded, in case it pre-existed) and written asynchronously with one write in flight.
//   If the sink lags by more than 8 MiB, records are dropped and counted; a `drop` record is written once the sink catches
//   up. The step loop is never blocked (L-6).
// - A-9: the only timer here is the 250 ms flush timer (unref'd).
// - P-SEC-42: screen captures are kept in a bounded in-memory ring (default 20 frames) and written to disk ONLY when
//   `debug.dumpDir` is configured (dir 0700, file 0600, redacted).

import { chmod, mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { DebugRecord } from '../model/debug.js';
import type { JsonValue } from '../model/json.js';
import type { Unsubscribe } from '../model/kernel.js';
import type { Redactor } from './redact.js';
import { summarize } from './redact.js';

const TRACE_MAX_LAG_BYTES = 8 * 1024 * 1024;
const TRACE_FLUSH_MS = 250;

/** File operations the trace needs (injectable for tests; the default is node:fs/promises with 0600/0700 modes). */
export interface TraceFs {
  openAppend(path: string): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  writePrivate(dir: string, name: string, data: string): Promise<string>;
}

export const nodeTraceFs: TraceFs = {
  async openAppend(path: string) {
    const fh: FileHandle = await open(path, 'a', 0o600);
    await fh.chmod(0o600);
    return {
      write: async (data: string): Promise<void> => {
        await fh.write(data);
      },
      close: () => fh.close(),
    };
  },
  async writePrivate(dir: string, name: string, data: string): Promise<string> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const p = join(dir, name);
    const fh = await open(p, 'wx', 0o600);
    try {
      await fh.write(data);
    } finally {
      await fh.close();
    }
    return p;
  },
};

export type RawMode = 'none' | 'meta' | 'full';

/** Redact one DebugRecord per the raw policy. Returns undefined when the record must not be written at all. */
export function redactRecord(r: DebugRecord, mode: RawMode, redactor: Redactor): DebugRecord | undefined {
  const content = (v: unknown): JsonValue => (mode === 'full' ? redactor.value(v) : redactor.meta(v));
  switch (r.r) {
    case 'header':
      return { ...r, coreInit: redactor.value(r.coreInit) as unknown as typeof r.coreInit, redaction: mode };
    case 'raw': {
      if (mode === 'none') return undefined;
      if (mode === 'full') return { ...r, data: redactor.value(r.data) };
      return { ...r, data: rawMeta(r.ch, r.data, redactor) };
    }
    case 'obs':
      return { ...r, obs: { ...r.obs, meta: redactor.value(r.obs.meta), p: content(r.obs.p) } as unknown as typeof r.obs };
    case 'cmd':
      return { ...r, cmd: content(r.cmd) as unknown as typeof r.cmd };
    case 'step':
      return { ...r, intents: content(r.intents) as unknown as typeof r.intents };
    case 'event':
      return { ...r, e: { ...r.e, payload: content(r.e.payload) } as unknown as typeof r.e };
    case 'effect':
      return r.error === undefined ? r : { ...r, error: redactor.string(r.error) };
    case 'diag':
      return { ...r, detail: redactor.value(r.detail) };
    case 'drop':
      return r;
  }
}

/** `raw:'meta'`: a raw record keeps its structure but no content (event names, sizes, hashes, ids). */
function rawMeta(ch: string, data: unknown, redactor: Redactor): JsonValue {
  if (typeof data !== 'object' || data === null) return summarize(data);
  const d = data as Record<string, unknown>;
  const out: Record<string, JsonValue> = { ch };
  for (const k of ['event', 'hookSeq', 'transport', 'bytes', 'truncated', 'kind', 'tunnelId', 'host', 'port', 'hash', 'at', 'wallAt']) {
    const v = d[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = typeof v === 'string' ? redactor.string(v) : v;
  }
  if ('payload' in d) out['payload'] = summarize(d['payload']);
  if ('line' in d) out['line'] = summarize(d['line']);
  if ('capture' in d) out['capture'] = summarize(d['capture']);
  return out;
}

export interface DebugTraceOptions {
  /** Absolute path of the `.ccd.jsonl` trace; undefined = in-process listeners only. */
  path?: string;
  raw: RawMode;
  redactor: Redactor;
  maxLagBytes?: number;
  flushMs?: number;
  fs?: TraceFs;
  onError?: (e: unknown) => void;
}

export interface DebugTrace {
  readonly path: string | undefined;
  /** Write the header (always the first line). Records recorded before `start` are held (within the lag cap) until then. */
  start(header: Extract<DebugRecord, { r: 'header' }>): void;
  /** Redact and fan out one record; never throws, never blocks. */
  record(r: DebugRecord): void;
  /** In-process listeners (kernel.subscribeDebug) get the redacted records. */
  subscribe(l: (r: DebugRecord) => void): Unsubscribe;
  /** True when a file or a listener consumes records (callers may skip building records otherwise). */
  readonly active: boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly stats: { written: number; dropped: number; pendingBytes: number; listenerErrors: number };
}

export function createDebugTrace(o: DebugTraceOptions): DebugTrace {
  const fs = o.fs ?? nodeTraceFs;
  const maxLag = o.maxLagBytes ?? TRACE_MAX_LAG_BYTES;
  const flushMs = o.flushMs ?? TRACE_FLUSH_MS;
  const listeners = new Set<(r: DebugRecord) => void>();
  const pending: string[] = [];
  let pendingBytes = 0;
  let started = false;
  let closed = false;
  let dropped = 0;
  let droppedUnreported = 0;
  let written = 0;
  let listenerErrors = 0;
  let file: Awaited<ReturnType<TraceFs['openAppend']>> | undefined;
  let opening: Promise<void> | undefined;
  let failed = false;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reportError = (e: unknown): void => {
    try {
      o.onError?.(e);
    } catch {
      // ignore
    }
  };

  const enqueueLine = (line: string): void => {
    if (o.path === undefined || failed || closed) return;
    const bytes = Buffer.byteLength(line);
    if (pendingBytes + bytes > maxLag) {
      dropped++;
      droppedUnreported++;
      return;
    }
    if (droppedUnreported > 0) {
      const d = `${JSON.stringify({ r: 'drop', count: droppedUnreported, reason: 'backpressure' })}\n`;
      droppedUnreported = 0;
      pending.push(d);
      pendingBytes += Buffer.byteLength(d);
    }
    pending.push(line);
    pendingBytes += bytes;
    if (started) schedule();
  };

  const schedule = (): void => {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void pump();
    }, flushMs);
    timer.unref();
  };

  const ensureOpen = async (): Promise<void> => {
    if (file !== undefined || failed || o.path === undefined) return;
    if (opening === undefined) {
      const path = o.path;
      opening = fs.openAppend(path).then(
        (f) => {
          file = f;
        },
        (e: unknown) => {
          failed = true;
          pending.length = 0;
          pendingBytes = 0;
          reportError(e);
        },
      );
    }
    await opening;
  };

  const pump = async (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      await ensureOpen();
      while (file !== undefined && pending.length > 0) {
        const chunk = pending.splice(0, pending.length).join('');
        const b = Buffer.byteLength(chunk);
        try {
          await file.write(chunk);
          written += chunk.split('\n').length - 1;
        } catch (e) {
          failed = true;
          reportError(e);
          pending.length = 0;
          pendingBytes = 0;
          return;
        } finally {
          pendingBytes = Math.max(0, pendingBytes - b);
        }
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const fanOut = (r: DebugRecord): void => {
    for (const l of [...listeners]) {
      try {
        l(r);
      } catch {
        listenerErrors++;
      }
    }
  };

  const serialize = (r: DebugRecord): string | undefined => {
    try {
      return `${JSON.stringify(r)}\n`;
    } catch (e) {
      reportError(e);
      return undefined;
    }
  };

  const headerHeld: string[] = [];
  let heldBytes = 0;
  return {
    path: o.path,
    start(header): void {
      if (started || closed) return;
      const red = redactRecord(header, o.raw, o.redactor);
      if (red === undefined) return;
      fanOut(red);
      const line = serialize(red);
      started = true;
      if (line !== undefined && o.path !== undefined && !failed) {
        pending.unshift(line);
        pendingBytes += Buffer.byteLength(line);
      }
      // records dropped before the header were recorded AFTER the held ones: their drop marker follows them
      const preDropped = droppedUnreported;
      droppedUnreported = 0;
      for (const l of headerHeld.splice(0)) enqueueLine(l);
      heldBytes = 0;
      droppedUnreported += preDropped;
      if (droppedUnreported > 0 && pendingBytes < maxLag) {
        const d = `${JSON.stringify({ r: 'drop', count: droppedUnreported, reason: 'backpressure' })}\n`;
        droppedUnreported = 0;
        pending.push(d);
        pendingBytes += Buffer.byteLength(d);
      }
      if (pending.length > 0) schedule();
    },
    record(r: DebugRecord): void {
      if (closed) return;
      let red: DebugRecord | undefined;
      try {
        red = redactRecord(r, o.raw, o.redactor);
      } catch (e) {
        reportError(e);
        return;
      }
      if (red === undefined) return;
      fanOut(red);
      if (o.path === undefined) return;
      const line = serialize(red);
      if (line === undefined) return;
      if (!started) {
        // the same 8 MiB lag cap (in UTF-8 bytes) applies while the header is not written yet
        const bytes = Buffer.byteLength(line);
        if (heldBytes + bytes > maxLag) {
          dropped++;
          droppedUnreported++;
          return;
        }
        headerHeld.push(line);
        heldBytes += bytes;
        return;
      }
      enqueueLine(line);
    },
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    get active(): boolean {
      return !closed && (listeners.size > 0 || (o.path !== undefined && !failed));
    },
    async flush(): Promise<void> {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (!started) return;
      await pump();
      if (pending.length > 0) await pump();
    },
    async close(): Promise<void> {
      if (closed) return;
      if (!started && headerHeld.length > 0) {
        // never started (start failed before the header): nothing is written, a trace without a header is unreadable
        headerHeld.length = 0;
        heldBytes = 0;
      }
      if (droppedUnreported > 0 && started) {
        const d = `${JSON.stringify({ r: 'drop', count: droppedUnreported, reason: 'backpressure' })}\n`;
        droppedUnreported = 0;
        pending.push(d);
        pendingBytes += Buffer.byteLength(d);
      }
      if (started) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        await pump();
        if (pending.length > 0) await pump();
      }
      closed = true;
      listeners.clear();
      const f = file;
      file = undefined;
      if (f !== undefined) await f.close().catch(reportError);
    },
    get stats() {
      return { written, dropped, pendingBytes, listenerErrors };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// P-SEC-42 / SEC §8.5: bounded in-memory screen ring; disk only with debug.dumpDir.

interface ScreenRingEntry {
  at: number;
  wallAt: number;
  hash: string;
  lines: readonly string[];
}

export interface ScreenRing {
  push(e: ScreenRingEntry): void;
  entries(): readonly ScreenRingEntry[];
  /** Write the ring (redacted) to `dumpDir` (0700) as one 0600 file; undefined when no dumpDir is configured or nothing is held. */
  dump(reason: string, wallNow: number): Promise<string | undefined>;
  readonly size: number;
}

export function createScreenRing(o: {
  capacity?: number;
  dumpDir?: string;
  redactor: Redactor;
  sessionKey: string;
  fs?: TraceFs;
}): ScreenRing {
  const cap = Math.max(1, o.capacity ?? 20);
  const ring: ScreenRingEntry[] = [];
  const fs = o.fs ?? nodeTraceFs;
  let n = 0;
  return {
    push(e: ScreenRingEntry): void {
      if (ring.length > 0 && ring[ring.length - 1]?.hash === e.hash) return; // unchanged frame: keep one copy
      ring.push(e);
      if (ring.length > cap) ring.shift();
    },
    entries: () => ring,
    get size(): number {
      return ring.length;
    },
    async dump(reason: string, wallNow: number): Promise<string | undefined> {
      if (o.dumpDir === undefined || ring.length === 0) return undefined;
      n++;
      const safeReason = reason.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
      const name = `screens-${Math.floor(wallNow)}-${o.sessionKey.replace(/[^A-Za-z0-9]/g, '')}-${n}-${safeReason}.txt`;
      const body = ring
        .map((e) => `--- frame at=${e.at} wallAt=${e.wallAt} hash=${e.hash}\n${e.lines.map((l) => o.redactor.string(l)).join('\n')}`)
        .join('\n');
      return fs.writePrivate(o.dumpDir, name, `${body}\n`);
    },
  };
}
