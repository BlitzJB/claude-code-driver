// platform/fs-tail/fake-tail-fs.ts — fakes owned by WP-02 (DESIGN.md §2.7 "Fakes", §6.4 tail row, §8).
//
// 1. FakeTailFs: an in-memory TailFs with POSIX-like semantics that the tail scenarios need: open fds keep reading their
//    inode across rename/unlink, rename keeps the inode (files and whole directories), replaceFile/copyNewInode give a
//    new inode (rename-replace, EXDEV-style copy), in-place truncate, symlinks (file and directory), EACCES, ENOTDIR,
//    an optional open-file limit (EMFILE) and counters (open fds, reads in flight) for the resource assertions.
//    Driven by FakeTailFs + `createTranscriptTailFactory(fakeFs)` the real tail is the fake tail of §6.4.
// 2. FakeTranscriptTail(+Factory): a scripted TranscriptTail for kernel scenarios (WP-14) that records every call and lets
//    the test push TailEvents directly.

import { posix } from 'node:path';
import type { Cancel, MonoMs, WallMs } from '../../model/time.js';
import type { FileKey, TailCheckpoint, TailEvent, TailLine, TranscriptTail, TranscriptTailFactory } from '../ports.js';
import type { TailDirEntry, TailFileHandle, TailFs, TailStat } from './node-fs.js';

interface Inode {
  dev: number;
  ino: number;
  data: Buffer; // capacity ≥ size
  size: number;
  mtimeMs: number;
}
type Node = { t: 'file'; inode: Inode } | { t: 'dir' } | { t: 'symlink'; target: string };

function fsError(code: string, syscall: string, path: string): Error {
  const e = new Error(`${code}: ${syscall} '${path}'`) as Error & { code: string; syscall: string; path: string };
  e.code = code;
  e.syscall = syscall;
  e.path = path;
  return e;
}

export interface FakeTailFsStats {
  opens: number;
  openFds: number;
  maxOpenFds: number;
  reads: number;
  readsInFlight: number;
  maxReadsInFlight: number;
  stats: number;
  readdirs: number;
}

export class FakeTailFs implements TailFs {
  private readonly nodes = new Map<string, Node>([['/', { t: 'dir' }]]);
  private nextIno = 1000;
  private mtime = 1_700_000_000_000;
  private readonly denied = new Set<string>();
  /** Open-file limit; opening beyond it throws EMFILE. */
  maxOpenFiles = Infinity;
  /** Optional hook awaited inside every read (e.g. to make reads slow or observe concurrency). */
  readDelay: (() => Promise<void>) | undefined;
  readonly counters: FakeTailFsStats = {
    opens: 0,
    openFds: 0,
    maxOpenFds: 0,
    reads: 0,
    readsInFlight: 0,
    maxReadsInFlight: 0,
    stats: 0,
    readdirs: 0,
  };

  constructor(readonly dev = 1) {}

  // ------------------------------------------------------------------ world operations (synchronous, for tests)

  mkdirp(dir: string): void {
    const parts = posix.resolve(dir).split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      const n = this.nodes.get(cur);
      if (n === undefined) this.nodes.set(cur, { t: 'dir' });
      else if (n.t === 'symlink') cur = this.resolve(cur, true, 'mkdir');
      else if (n.t !== 'dir') throw fsError('ENOTDIR', 'mkdir', cur);
    }
  }

  /** Create (or overwrite in place, same inode) a file; parent dirs are created like Claude's writer does. */
  writeFile(path: string, data: string | Buffer): void {
    const p = this.writablePath(path);
    const existing = this.nodes.get(p);
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    if (existing?.t === 'file') {
      existing.inode.data = Buffer.from(buf);
      existing.inode.size = buf.length;
      existing.inode.mtimeMs = this.tick();
      return;
    }
    this.nodes.set(p, { t: 'file', inode: this.newInode(buf) });
  }

  appendFile(path: string, data: string | Buffer): void {
    const p = this.writablePath(path);
    const n = this.nodes.get(p);
    if (n?.t !== 'file') {
      this.writeFile(p, data);
      return;
    }
    const add = typeof data === 'string' ? Buffer.from(data) : data;
    const ino = n.inode;
    const need = ino.size + add.length;
    if (need > ino.data.length) {
      const grown = Buffer.alloc(Math.max(need, ino.data.length * 2, 1024));
      ino.data.copy(grown, 0, 0, ino.size);
      ino.data = grown;
    }
    add.copy(ino.data, ino.size);
    ino.size = need;
    ino.mtimeMs = this.tick();
  }

  /** In-place truncate (same inode). */
  truncate(path: string, len: number): void {
    const ino = this.fileInode(path, 'truncate');
    if (len < ino.size) ino.data.fill(0, len, ino.size);
    else if (len > ino.data.length) {
      const grown = Buffer.alloc(len);
      ino.data.copy(grown, 0, 0, ino.size);
      ino.data = grown;
    }
    ino.size = len;
    ino.mtimeMs = this.tick();
  }

  /** Claude's tombstone removal (transcript-tail.md §5.1): truncate at the line start, rewrite the bytes after the line. */
  removeLineContaining(path: string, needle: string): void {
    const ino = this.fileInode(path, 'open');
    const content = ino.data.subarray(0, ino.size);
    const at = content.lastIndexOf(needle);
    if (at === -1) throw new Error(`removeLineContaining: '${needle}' not found`);
    const start = content.lastIndexOf(0x0a, at) + 1;
    const nl = content.indexOf(0x0a, at);
    const end = nl === -1 ? ino.size : nl + 1;
    const after = Buffer.from(content.subarray(end));
    this.truncate(path, start);
    this.appendFile(path, after);
  }

  /** rename(2): same inode; moves whole directory trees; replaces a destination file. */
  rename(from: string, to: string): void {
    const src = this.resolveParent(from, 'rename');
    const n = this.nodes.get(src);
    if (n === undefined) throw fsError('ENOENT', 'rename', from);
    const dst = this.writablePath(to, false);
    if (n.t === 'dir') {
      const moved: [string, Node][] = [];
      for (const [k, v] of this.nodes) if (k === src || k.startsWith(src + '/')) moved.push([k, v]);
      for (const [k] of moved) this.nodes.delete(k);
      for (const [k, v] of moved) this.nodes.set(dst + k.slice(src.length), v);
    } else {
      this.nodes.delete(src);
      this.nodes.set(dst, n);
    }
  }

  /** Atomic replace (write tmp + rename over): a NEW inode at `path` (local-GC compaction, transcript-tail.md §5.2). */
  replaceFile(path: string, data: string | Buffer): void {
    const p = this.writablePath(path);
    this.nodes.set(p, { t: 'file', inode: this.newInode(typeof data === 'string' ? Buffer.from(data) : data) });
  }

  /** EXDEV-style move: copy the bytes to a new inode at `to` (optionally another device), then unlink `from`. */
  copyNewInode(from: string, to: string, o: { dev?: number } = {}): void {
    const src = this.fileInode(from, 'copy');
    const p = this.writablePath(to);
    const inode = this.newInode(Buffer.from(src.data.subarray(0, src.size)));
    if (o.dev !== undefined) inode.dev = o.dev;
    this.nodes.set(p, { t: 'file', inode });
    this.unlink(from);
  }

  unlink(path: string): void {
    const p = this.resolveParent(path, 'unlink');
    const n = this.nodes.get(p);
    if (n === undefined) throw fsError('ENOENT', 'unlink', path);
    if (n.t === 'dir') throw fsError('EISDIR', 'unlink', path);
    this.nodes.delete(p);
  }

  /** rm -rf. */
  removeTree(path: string): void {
    const p = this.resolveParent(path, 'rm');
    for (const k of [...this.nodes.keys()]) if (k === p || k.startsWith(p + '/')) this.nodes.delete(k);
  }

  symlink(target: string, path: string): void {
    const p = this.writablePath(path);
    this.nodes.set(p, { t: 'symlink', target });
  }

  /** Make open/stat/readdir of exactly this path fail with EACCES (null clears). */
  setDenied(path: string, denied: boolean): void {
    const p = posix.resolve(path);
    if (denied) this.denied.add(p);
    else this.denied.delete(p);
  }

  /** Current bytes of a file (test assertions). */
  read(path: string): Buffer {
    const ino = this.fileInode(path, 'open');
    return Buffer.from(ino.data.subarray(0, ino.size));
  }

  exists(path: string): boolean {
    try {
      this.resolve(path, true, 'stat');
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ TailFs

  open(path: string): Promise<TailFileHandle> {
    return this.async(() => {
      const p = this.resolve(path, true, 'open');
      this.checkDenied(p, 'open', path);
      const n = this.nodes.get(p);
      if (n === undefined) throw fsError('ENOENT', 'open', path);
      if (n.t === 'dir') throw fsError('EISDIR', 'open', path);
      if (n.t !== 'file') throw fsError('ENOENT', 'open', path);
      if (this.counters.openFds >= this.maxOpenFiles) throw fsError('EMFILE', 'open', path);
      this.counters.opens++;
      this.counters.openFds++;
      this.counters.maxOpenFds = Math.max(this.counters.maxOpenFds, this.counters.openFds);
      return this.handle(n.inode);
    });
  }

  stat(path: string): Promise<TailStat> {
    return this.async(() => {
      this.counters.stats++;
      const p = this.resolve(path, true, 'stat');
      this.checkDenied(p, 'stat', path);
      const n = this.nodes.get(p);
      if (n === undefined) throw fsError('ENOENT', 'stat', path);
      if (n.t === 'dir') return { dev: this.dev, ino: 1, size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
      if (n.t !== 'file') throw fsError('ENOENT', 'stat', path);
      return statOf(n.inode);
    });
  }

  readdir(path: string): Promise<TailDirEntry[]> {
    return this.async(() => {
      this.counters.readdirs++;
      const p = this.resolve(path, true, 'scandir');
      this.checkDenied(p, 'scandir', path);
      const n = this.nodes.get(p);
      if (n === undefined) throw fsError('ENOENT', 'scandir', path);
      if (n.t !== 'dir') throw fsError('ENOTDIR', 'scandir', path);
      const prefix = p === '/' ? '/' : p + '/';
      const out: TailDirEntry[] = [];
      for (const [k, v] of this.nodes) {
        if (!k.startsWith(prefix) || k === p) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes('/')) continue;
        out.push({ name: rest, kind: v.t === 'file' ? 'file' : v.t === 'dir' ? 'dir' : 'symlink' });
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }

  realpath(path: string): Promise<string> {
    return this.async(() => this.resolve(path, true, 'realpath'));
  }

  // ------------------------------------------------------------------ internals

  private tick(): number {
    this.mtime += 1;
    return this.mtime;
  }

  private newInode(buf: Buffer): Inode {
    return { dev: this.dev, ino: this.nextIno++, data: Buffer.from(buf), size: buf.length, mtimeMs: this.tick() };
  }

  private async<T>(fn: () => T): Promise<T> {
    return Promise.resolve().then(fn);
  }

  private checkDenied(p: string, syscall: string, path: string): void {
    if (this.denied.has(p)) throw fsError('EACCES', syscall, path);
  }

  private handle(inode: Inode): TailFileHandle {
    let closed = false;
    return {
      stat: () =>
        this.async(() => {
          if (closed) throw fsError('EBADF', 'fstat', '');
          return statOf(inode);
        }),
      read: async (buf, offset, length, position) => {
        if (closed) throw fsError('EBADF', 'read', '');
        this.counters.reads++;
        this.counters.readsInFlight++;
        this.counters.maxReadsInFlight = Math.max(this.counters.maxReadsInFlight, this.counters.readsInFlight);
        try {
          await Promise.resolve();
          if (this.readDelay !== undefined) await this.readDelay();
          if (position >= inode.size) return 0;
          const n = Math.min(length, inode.size - position);
          inode.data.copy(buf, offset, position, position + n);
          return n;
        } finally {
          this.counters.readsInFlight--;
        }
      },
      close: () =>
        this.async(() => {
          if (closed) return;
          closed = true;
          this.counters.openFds--;
        }),
    };
  }

  private fileInode(path: string, syscall: string): Inode {
    const p = this.resolve(path, true, syscall);
    const n = this.nodes.get(p);
    if (n?.t !== 'file') throw fsError('ENOENT', syscall, path);
    return n.inode;
  }

  /** Path for creating `path`: parents created (mkdirp) and resolved; the last component itself is not followed. */
  private writablePath(path: string, mkdir = true): string {
    const abs = posix.resolve(path);
    const dir = posix.dirname(abs);
    if (mkdir) this.mkdirp(dir);
    const rdir = this.resolve(dir, true, 'open');
    const dn = this.nodes.get(rdir);
    if (dn === undefined) throw fsError('ENOENT', 'open', path);
    if (dn.t !== 'dir') throw fsError('ENOTDIR', 'open', path);
    return posix.join(rdir, posix.basename(abs));
  }

  /** Resolve the parent dirs but not the last component (unlink/rename semantics). */
  private resolveParent(path: string, syscall: string): string {
    const abs = posix.resolve(path);
    return posix.join(this.resolve(posix.dirname(abs), true, syscall), posix.basename(abs));
  }

  /** Resolve symlinks in every component (and the last one when `followLast`). Throws ENOENT/ENOTDIR/ELOOP. */
  private resolve(path: string, followLast: boolean, syscall: string): string {
    let hops = 0;
    let parts = posix.resolve(path).split('/').filter(Boolean);
    let cur = '';
    let i = 0;
    while (i < parts.length) {
      const next = `${cur}/${parts[i] ?? ''}`;
      const n = this.nodes.get(next);
      const last = i === parts.length - 1;
      if (n === undefined) {
        // a missing component: ENOENT, or ENOTDIR when a parent is a file
        throw fsError('ENOENT', syscall, path);
      }
      if (n.t === 'symlink' && (!last || followLast)) {
        if (++hops > 40) throw fsError('ELOOP', syscall, path);
        const target = posix.resolve(cur === '' ? '/' : cur, n.target);
        parts = [...target.split('/').filter(Boolean), ...parts.slice(i + 1)];
        cur = '';
        i = 0;
        continue;
      }
      if (!last && n.t === 'file') throw fsError('ENOTDIR', syscall, path);
      cur = next;
      i++;
    }
    return cur === '' ? '/' : cur;
  }
}

function statOf(i: Inode): TailStat {
  return { dev: i.dev, ino: i.ino, size: i.size, mtimeMs: i.mtimeMs, isFile: true, isDirectory: false };
}

// ====================================================================== scripted TranscriptTail

export type FakeTailCall =
  | { m: 'followMain'; sessionId: string; path: string; startAt: 'beginning' | 'end' | { checkpoint: TailCheckpoint } }
  | { m: 'observePath'; sessionId: string; path: string; source: string }
  | { m: 'expectSubagent'; sessionId: string; agentId: string }
  | { m: 'subagentStopped'; sessionId: string; agentId: string; path: string | undefined }
  | { m: 'poke'; reason: string | undefined }
  | { m: 'close' };

/** A TranscriptTail that does no I/O: it records calls and emits what the test pushes. */
export class FakeTranscriptTail implements TranscriptTail {
  readonly calls: FakeTailCall[] = [];
  closed = false;
  private readonly listeners = new Set<(e: TailEvent) => void>();
  private readonly offsets = new Map<string, number>();
  private mono = 0;
  private wall = 0;

  constructor(readonly options?: Parameters<TranscriptTailFactory['create']>[0]) {}

  followMain(sessionId: string, path: string, o: { startAt?: 'beginning' | 'end' | { checkpoint: TailCheckpoint } } = {}): void {
    this.calls.push({ m: 'followMain', sessionId, path, startAt: o.startAt ?? 'beginning' });
  }
  observePath(sessionId: string, path: string, source: string): void {
    this.calls.push({ m: 'observePath', sessionId, path, source });
  }
  expectSubagent(sessionId: string, agentId: string): void {
    this.calls.push({ m: 'expectSubagent', sessionId, agentId });
  }
  subagentStopped(sessionId: string, agentId: string, path?: string): void {
    this.calls.push({ m: 'subagentStopped', sessionId, agentId, path });
  }
  poke(reason?: string): void {
    this.calls.push({ m: 'poke', reason });
  }
  on(l: (e: TailEvent) => void): Cancel {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  checkpoint(): TailCheckpoint {
    return { files: [] };
  }
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.calls.push({ m: 'close' });
      this.listeners.clear();
    }
    return Promise.resolve();
  }

  /** Push any TailEvent to the listeners (no-op after close). */
  emit(e: TailEvent): void {
    if (this.closed) return;
    for (const l of [...this.listeners]) l(e);
  }

  /** Push a `line` event for a JSON object; offsets advance per file like a real append-only file. */
  emitLine(
    file: FileKey,
    json: object,
    o: { replay?: boolean; afterRewrite?: boolean; generation?: number; at?: MonoMs; wallAt?: WallMs } = {},
  ): TailLine {
    const text = JSON.stringify(json);
    const bytes = Buffer.byteLength(text);
    const id = file.kind === 'main' ? `m:${file.sessionId}` : `s:${file.sessionId}:${file.agentId}`;
    const offset = this.offsets.get(id) ?? 0;
    this.offsets.set(id, offset + bytes + 1);
    const t = (json as Record<string, unknown>)['type'];
    const line: TailLine = {
      file,
      generation: o.generation ?? 0,
      offset,
      bytes,
      type: typeof t === 'string' ? t : undefined,
      json,
      replay: o.replay ?? false,
      afterRewrite: o.afterRewrite ?? false,
      readAtMono: o.at ?? (this.mono++ as MonoMs),
      readAtWall: o.wallAt ?? (this.wall++ as WallMs),
    };
    this.emit({ kind: 'line', line });
    return line;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export class FakeTranscriptTailFactory implements TranscriptTailFactory {
  readonly created: FakeTranscriptTail[] = [];
  create(o: Parameters<TranscriptTailFactory['create']>[0]): FakeTranscriptTail {
    const t = new FakeTranscriptTail(o);
    this.created.push(t);
    return t;
  }
  /** The most recently created tail. */
  get last(): FakeTranscriptTail | undefined {
    return this.created[this.created.length - 1];
  }
}
