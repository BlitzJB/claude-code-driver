// platform/fs-tail/follower.ts — one file follower plus the tail's poll loop (adapter timer A-6, DESIGN.md §4.12: 250 ms
// idle / 50 ms burst, produces TailEvent). DESIGN.md §1.2, §2.7.4 (rev 2 §10 C3), §5.3; transcript-tail.md §2, §5, §8, §11.
//
// Per poll of an open follower: path stat (identity) → fstat → shrink / anchor check → pread in readChunkBytes slices →
// split → emit. Shrink below the read position, an inode change at the path, or an anchor mismatch (a tombstone
// truncate + rewrite that already grew past our offset, exp4) → `rewrite` and a full rescan from 0 with replay:true and
// afterRewrite:true; the core drops already-seen uuids (D-42). No fingerprint ring, no fs.watch, no EXDEV special case.
//
// Mitigations implemented here:
// - P-TAIL-01/P-TAIL-03 ENOENT (file or parent dirs) is the `waiting` state, re-checked every poll (no error).
// - P-TAIL-06 the incomplete last line is reported as `torn-tail` only by finalDrain (close).
// - P-TAIL-07 a crash fragment sealed by Claude's '\n' is a `malformed` line; following continues.
// - P-TAIL-15/P-TAIL-41 one read in flight, readChunkBytes per read, `await` per read (the loop is serialized by PollLoop).
// - P-TAIL-16 fds are slots granted by the tail (≤ maxActiveFollowers, LRU to dormant); waiting followers stat, never open.
// - P-TAIL-18 own Clock-driven poll loop (no fs.watchFile).
// - P-TAIL-21 shrink / anchor mismatch → full rescan; P-TAIL-22 inode change at the path → full rescan.
// - P-TAIL-23 the fd is held across a same-device move (path ENOENT → keep reading the fd, the tail searches for the new
//   path); a new path with the same inode → `moved{sameInode:true}`; a different inode → `moved{sameInode:false}` + rescan.
// - P-TAIL-24/P-TAIL-35 draining followers keep polling for drainGraceMs after their last growth, then go dormant (fd
//   closed, path stat every DORMANT_POLL_MS); growth or a reactivation reopens them.
// - P-TAIL-38 every timer and deadline uses mono time; wall time is only stamped on lines (readAtWall) for diagnostics.
// - P-TAIL-39/P-TAIL-40 per-follower state is offset + a 256-byte anchor + the splitter's pending list; one shared read buffer.

import type { Cancel, Clock, MonoMs } from '../../model/time.js';
import type { FileKey, TailCheckpoint, TailEvent } from '../ports.js';
import { classifyLine, LineSplitter, type LineSink } from './line-splitter.js';
import { describeError, errnoOf, type TailFileHandle, type TailFs, type TailStat } from './node-fs.js';

export type FollowerState = 'waiting' | 'active' | 'draining' | 'dormant' | 'closed';
export type StartAt = 'beginning' | 'end' | { checkpoint: TailCheckpoint };

/** Bytes kept before the read position to detect in-place rewrites (transcript-tail.md §5.5 `anchor`). */
const ANCHOR_BYTES = 256;
/** Dormant followers: path stat period (transcript-tail.md §8.3 step 4). */
export const DORMANT_POLL_MS = 5000;
/** Window searched backwards for the last line boundary with startAt:'end'. */
const END_SCAN_MAX = 1 << 20;
const END_SCAN_STEP = 64 * 1024;

export function fileKeyId(k: FileKey): string {
  return k.kind === 'main' ? `main:${k.sessionId}` : `sub:${k.sessionId}:${k.agentId}`;
}

export interface FollowerEnv {
  readonly fs: TailFs;
  readonly clock: Clock;
  readonly maxLineBytes: number;
  readonly drainGraceMs: number;
  readonly skipParseTypes: ReadonlySet<string>;
  /** Shared pread buffer (passes are serialized, so one buffer serves every follower). */
  readonly readBuf: Buffer;
  emit(e: TailEvent): void;
  /** Ask for an fd slot (may demote another follower to dormant). false → try again next poll. */
  acquireSlot(f: Follower): Promise<boolean>;
  releaseSlot(f: Follower): void;
  /** Another live follower already follows this realpath (P-TAIL-33). */
  isDuplicate(f: Follower, realPath: string): boolean;
}

type Phase = 'waiting' | 'open' | 'reopen' | 'dormant' | 'closed';

const WAIT_CODES = new Set(['ENOENT', 'EACCES', 'ENOTDIR']);

export class Follower {
  readonly id: string;
  path: string;
  /** A path proposed by observePath / subagentStopped / a scan; applied (with realpath dedupe) at the next poll. */
  candidatePath: string | undefined;
  realPath: string | undefined;
  /** Set when the path no longer resolves while our fd is still valid (moved away). */
  pathMissing = false;
  draining = false;
  drainUntil = 0 as MonoMs;
  /** Subagents only: deadline for `missing` while waiting. */
  missingAt: MonoMs | undefined;
  readonly waitStart: MonoMs;
  lastActivity: MonoMs;
  discoveredBy: 'expect' | 'scan' | 'follow' | 'observe' | 'stop';

  private phase: Phase = 'waiting';
  private lastState: FollowerState | undefined;
  private startAt: StartAt;
  private existedAtFirstAttempt: boolean | undefined;
  private waitNote: string | undefined;
  private lastErrorNote: string | undefined;
  private reportedPath: string | undefined;
  private fh: TailFileHandle | undefined;
  private dev = -1;
  private ino = -1;
  private lastSize = 0;
  private lastMtime = -1;
  private generation = 0;
  private replayUntil = 0;
  private rescanUntil = -1;
  private anchor: Buffer = Buffer.alloc(0);
  private nextDormantCheck = 0 as MonoMs;
  private sizeAtDormancy = 0;
  private readonly splitter: LineSplitter;
  private readonly sink: LineSink;

  constructor(
    readonly key: FileKey,
    path: string,
    startAt: StartAt,
    private readonly env: FollowerEnv,
    discoveredBy: Follower['discoveredBy'],
  ) {
    this.id = fileKeyId(key);
    this.path = path;
    this.startAt = startAt;
    this.discoveredBy = discoveredBy;
    this.waitStart = env.clock.now();
    this.lastActivity = this.waitStart;
    this.splitter = new LineSplitter(env.maxLineBytes);
    this.sink = {
      line: (buf, s, e, offset) => {
        this.onLine(buf, s, e, offset);
      },
      oversize: (offset, bytes) => {
        this.env.emit({ kind: 'oversize', file: this.key, offset, bytes });
      },
    };
  }

  // ---------------------------------------------------------------- state

  get state(): FollowerState {
    switch (this.phase) {
      case 'waiting':
        return 'waiting';
      case 'dormant':
        return 'dormant';
      case 'closed':
        return 'closed';
      case 'open':
      case 'reopen':
        return this.draining ? 'draining' : 'active';
    }
  }
  private currentPhase(): Phase {
    return this.phase;
  }
  get hasFd(): boolean {
    return this.fh !== undefined;
  }
  get isClosed(): boolean {
    return this.phase === 'closed';
  }
  get isWaiting(): boolean {
    return this.phase === 'waiting';
  }
  get isDormant(): boolean {
    return this.phase === 'dormant';
  }
  /** The startAt option still matters only before the first open attempt. */
  setStartAt(s: StartAt): void {
    if (this.existedAtFirstAttempt === undefined) this.startAt = s;
  }

  publishState(): void {
    const s = this.state;
    if (s !== this.lastState) {
      this.lastState = s;
      this.env.emit({ kind: 'state', file: this.key, state: s });
    }
  }

  checkpointEntry(): TailCheckpoint['files'][number] | undefined {
    if (this.dev < 0 || this.phase === 'closed') return undefined;
    return { key: this.key, path: this.path, dev: this.dev, ino: this.ino, offset: this.splitter.consumed, generation: this.generation };
  }

  /** Live again (expectSubagent on a stopped/dormant agent, observePath back to an old session). */
  makeLive(): void {
    this.draining = false;
    if (this.phase === 'dormant') this.phase = 'reopen';
    this.publishState();
  }
  /** Activity on a non-current follower (a late hook of an old generation): drain at least drainGraceMs from now. */
  refreshDraining(now: MonoMs): void {
    this.draining = true;
    this.drainUntil = Math.max(this.drainUntil, now + this.env.drainGraceMs) as MonoMs;
    if (this.phase === 'dormant') this.phase = 'reopen';
    this.publishState();
  }
  startDraining(now: MonoMs): void {
    if (!this.draining) {
      this.draining = true;
      this.drainUntil = (now + this.env.drainGraceMs) as MonoMs;
    }
    this.publishState();
  }
  /** Path change requested from outside (applied by the tail at the next poll via applyPath). */
  propose(path: string): void {
    if (path !== this.path) this.candidatePath = path;
  }

  /** Apply a new best-known path. Open followers detect moved/replaced at their next path stat. */
  applyPath(path: string): void {
    this.candidatePath = undefined;
    if (path === this.path) return;
    this.path = path;
    this.waitNote = undefined;
    if (this.phase === 'dormant') this.nextDormantCheck = 0 as MonoMs;
  }

  markClosed(): void {
    this.phase = 'closed';
    this.publishState();
  }

  // ---------------------------------------------------------------- one poll

  async step(now: MonoMs): Promise<void> {
    switch (this.phase) {
      case 'closed':
        return;
      case 'waiting':
        if (this.key.kind === 'subagent' && this.missingAt !== undefined && now >= this.missingAt) {
          this.env.emit({ kind: 'missing', file: this.key, waitedMs: now - this.waitStart });
          this.markClosed();
          return;
        }
        if (this.key.kind === 'main' && this.draining && now >= this.drainUntil) {
          this.markClosed(); // an old generation whose file never appeared
          return;
        }
        await this.pollWaiting();
        return;
      case 'dormant':
        await this.pollDormant(now);
        return;
      case 'reopen':
        if (this.draining && now >= this.drainUntil) {
          // no fd is held in this phase: a drain that expired while the reopen kept failing simply becomes dormant
          this.toDormantWithoutFd(now);
          return;
        }
        await this.pollReopen();
        return;
      case 'open':
        await this.pollOpen();
        // pollOpen may have switched phase (reopen / closed) across its awaits
        if (this.currentPhase() === 'open' && this.draining && this.env.clock.now() >= this.drainUntil) await this.toDormant();
        return;
    }
  }

  private noteWaiting(reason: string): void {
    const note = `${reason}\0${this.path}`;
    if (note === this.waitNote) return;
    this.waitNote = note;
    if (reason === 'ENOENT' || reason === 'EACCES' || reason === 'ENOTDIR')
      this.env.emit({ kind: 'waiting', file: this.key, path: this.path, reason });
  }

  private noteError(e: unknown, what: string): void {
    const message = `${what}: ${describeError(e)}`;
    if (message === this.lastErrorNote) return;
    this.lastErrorNote = message;
    this.env.emit({ kind: 'error', file: this.key, message, fatal: false });
  }

  private async pollWaiting(): Promise<void> {
    if (this.path === '') return; // subagent whose main path is not known yet
    // stat first: probing a missing file must not take (or evict for) an fd slot (P-TAIL-16)
    let st: TailStat;
    try {
      st = await this.env.fs.stat(this.path);
    } catch (e) {
      const c = errnoOf(e);
      if (c !== undefined && WAIT_CODES.has(c)) {
        this.existedAtFirstAttempt ??= false;
        this.noteWaiting(c);
      } else this.noteError(e, 'stat');
      this.publishState();
      return;
    }
    if (!st.isFile) {
      this.existedAtFirstAttempt ??= false;
      this.noteError(new Error('not a regular file'), 'stat');
      return;
    }
    const opened = await this.openAt(this.path);
    if (opened === undefined) return;
    const { fh, stat, realPath } = opened;
    const existed = this.existedAtFirstAttempt ?? true;
    let start = 0;
    let skipPartial = false;
    let generation = this.generation;
    let anchor: Buffer;
    const s = this.startAt;
    try {
      if (typeof s === 'object') {
        const cp = s.checkpoint.files.find((x) => fileKeyId(x.key) === this.id);
        if (cp?.dev === stat.dev && cp.ino === stat.ino && cp.offset <= stat.size) {
          start = cp.offset;
          generation = cp.generation;
        }
      } else if (s === 'end' && existed) {
        const b = await this.lastLineBoundary(fh, stat.size);
        start = b.offset;
        skipPartial = b.skipPartial;
      }
      anchor = await this.readAnchorOf(fh, start);
    } catch (e) {
      // an I/O error before we commit (EIO, EBADF …): never leak the fd or its slot; stay waiting and retry next poll
      await fh.close().catch(() => undefined);
      this.env.releaseSlot(this);
      this.noteError(e, 'read');
      return;
    }
    this.existedAtFirstAttempt = existed;
    this.generation = generation;
    this.fh = fh;
    this.realPath = realPath;
    this.dev = stat.dev;
    this.ino = stat.ino;
    this.lastSize = stat.size;
    this.lastMtime = stat.mtimeMs;
    this.splitter.reset(start, { skipPartial });
    this.anchor = anchor;
    this.lastErrorNote = undefined;
    // content that existed before we looked is history (replay:true); a stale checkpoint falls back to the beginning
    this.replayUntil = existed && start === 0 && !skipPartial && s !== 'end' ? stat.size : 0;
    this.phase = 'open';
    this.reportedPath = this.path;
    this.env.emit({ kind: 'opened', file: this.key, path: this.path, dev: stat.dev, ino: stat.ino, size: stat.size, startOffset: start });
    this.publishState();
    await this.readTo(stat.size);
  }

  /** Open `path` with an fd slot and realpath dedupe. undefined → stay in the current phase and retry next poll. */
  private async openAt(path: string): Promise<{ fh: TailFileHandle; stat: TailStat; realPath: string } | undefined> {
    if (!(await this.env.acquireSlot(this))) return undefined;
    let fh: TailFileHandle;
    try {
      fh = await this.env.fs.open(path);
    } catch (e) {
      this.env.releaseSlot(this);
      const c = errnoOf(e);
      if (c !== undefined && WAIT_CODES.has(c) && this.phase === 'waiting') {
        this.existedAtFirstAttempt ??= false;
        this.noteWaiting(c);
      } else this.noteError(e, 'open');
      return undefined;
    }
    try {
      const stat = await fh.stat();
      let realPath = path;
      try {
        realPath = await this.env.fs.realpath(path);
      } catch {
        // keep the given path (it may have moved between open and realpath)
      }
      if (this.env.isDuplicate(this, realPath)) {
        await fh.close();
        this.env.releaseSlot(this);
        this.markClosed(); // P-TAIL-33: another follower already reads this file
        return undefined;
      }
      return { fh, stat, realPath };
    } catch (e) {
      await fh.close().catch(() => undefined);
      this.env.releaseSlot(this);
      this.noteError(e, 'fstat');
      return undefined;
    }
  }

  private async pollOpen(): Promise<void> {
    const fh = this.fh;
    if (fh === undefined) return;
    // 1. path identity (rename-replace, /cd move, EXDEV-style copy)
    let p: TailStat | undefined;
    try {
      p = await this.env.fs.stat(this.path);
    } catch (e) {
      const c = errnoOf(e);
      if (c === undefined || !WAIT_CODES.has(c)) this.noteError(e, 'stat');
    }
    if (p !== undefined && !p.isFile) p = undefined; // a directory (or other) at the path is not our file: treat as moved away
    if (p !== undefined && (p.dev !== this.dev || p.ino !== this.ino)) {
      if (this.path !== this.reportedPath) {
        this.env.emit({ kind: 'moved', file: this.key, from: this.reportedPath ?? this.path, to: this.path, sameInode: false });
        this.reportedPath = this.path;
      }
      await this.switchInode('replaced');
      return;
    }
    if (p !== undefined && this.path !== this.reportedPath) {
      this.env.emit({ kind: 'moved', file: this.key, from: this.reportedPath ?? this.path, to: this.path, sameInode: true });
      this.reportedPath = this.path;
      this.realPath = await this.env.fs.realpath(this.path).catch(() => this.path);
    }
    this.pathMissing = p === undefined;
    // 2. the inode we hold
    let s: TailStat;
    try {
      s = await fh.stat();
    } catch (e) {
      this.noteError(e, 'fstat');
      return;
    }
    await this.checkAndRead(s);
  }

  private async checkAndRead(s: TailStat): Promise<void> {
    const readPos = this.splitter.position;
    if (s.size < readPos) {
      await this.rescan('truncated', s);
      return;
    }
    if (readPos > 0 && (s.size !== this.lastSize || s.mtimeMs !== this.lastMtime)) {
      let same: boolean;
      try {
        same = await this.anchorMatches();
      } catch (e) {
        // a transient read error proves nothing about a rewrite: report it and re-check at the next poll
        this.noteError(e, 'read');
        return;
      }
      if (!same) {
        await this.rescan('rewritten', s);
        return;
      }
    }
    this.lastSize = s.size;
    this.lastMtime = s.mtimeMs;
    await this.readTo(s.size);
  }

  /** Close the old fd, open the current path (a different inode), full rescan. */
  private async switchInode(reason: 'replaced'): Promise<void> {
    const old = this.fh;
    this.fh = undefined;
    if (old !== undefined) {
      await old.close().catch(() => undefined);
      this.env.releaseSlot(this);
    }
    const opened = await this.openAt(this.path);
    if (opened === undefined) {
      if (this.phase !== 'closed') {
        this.phase = 'reopen';
        this.publishState();
      }
      return;
    }
    this.fh = opened.fh;
    this.lastErrorNote = undefined;
    this.realPath = opened.realPath;
    this.dev = opened.stat.dev;
    this.ino = opened.stat.ino;
    this.phase = 'open';
    this.reportedPath = this.path;
    this.env.emit({
      kind: 'opened',
      file: this.key,
      path: this.path,
      dev: opened.stat.dev,
      ino: opened.stat.ino,
      size: opened.stat.size,
      startOffset: 0,
    });
    this.publishState();
    await this.rescan(reason, opened.stat);
  }

  private async rescan(reason: 'truncated' | 'replaced' | 'rewritten', s: TailStat): Promise<void> {
    this.generation += 1;
    this.env.emit({ kind: 'rewrite', file: this.key, reason, oldSize: this.lastSize, newSize: s.size, generation: this.generation });
    this.splitter.reset(0);
    this.anchor = Buffer.alloc(0);
    this.rescanUntil = s.size;
    this.replayUntil = s.size;
    this.lastSize = s.size;
    this.lastMtime = s.mtimeMs;
    await this.readTo(s.size);
  }

  private async readTo(size: number): Promise<void> {
    const fh = this.fh;
    if (fh === undefined) return;
    const buf = this.env.readBuf;
    while (this.splitter.position < size && this.fh === fh) {
      const pos = this.splitter.position;
      const n = Math.min(buf.length, size - pos);
      let got: number;
      try {
        got = await fh.read(buf, 0, n, pos); // one read in flight; the await yields to the loop (P-TAIL-15)
      } catch (e) {
        this.noteError(e, 'read');
        return;
      }
      if (got <= 0) break;
      this.lastErrorNote = undefined; // healthy again: a later identical error is reported anew
      this.splitter.push(buf, 0, got, this.sink);
      this.updateAnchor(buf, got);
      const now = this.env.clock.now();
      this.lastActivity = now;
      if (this.draining) this.drainUntil = (now + this.env.drainGraceMs) as MonoMs;
    }
    if (this.rescanUntil >= 0 && this.splitter.position >= this.rescanUntil) {
      this.rescanUntil = -1;
      this.env.emit({ kind: 'resynced', file: this.key, fullRescan: true, generation: this.generation });
    }
  }

  private onLine(buf: Buffer, s: number, e: number, offset: number): void {
    const c = classifyLine(buf, s, e, this.env.skipParseTypes);
    const bytes = e - s;
    switch (c.kind) {
      case 'empty':
        return;
      case 'malformed':
        this.env.emit({ kind: 'malformed', file: this.key, offset, bytes, reason: c.reason, preview: c.preview });
        return;
      case 'parsed':
      case 'skipped': {
        const end = offset + bytes + 1;
        this.env.emit({
          kind: 'line',
          line: {
            file: this.key,
            generation: this.generation,
            offset,
            bytes,
            type: c.type,
            json: c.kind === 'parsed' ? c.json : undefined,
            replay: end <= this.replayUntil,
            afterRewrite: this.generation > 0 && this.rescanUntil >= 0 && end <= this.rescanUntil,
            readAtMono: this.env.clock.now(),
            readAtWall: this.env.clock.wallNow(),
          },
        });
        return;
      }
    }
  }

  private updateAnchor(buf: Buffer, got: number): void {
    if (got >= ANCHOR_BYTES) this.anchor = Buffer.from(buf.subarray(got - ANCHOR_BYTES, got));
    else {
      const joined = Buffer.concat([this.anchor, buf.subarray(0, got)]);
      this.anchor = Buffer.from(joined.subarray(Math.max(0, joined.length - ANCHOR_BYTES)));
    }
  }

  private async readAnchor(end: number): Promise<Buffer> {
    return this.readAnchorOf(this.fh, end);
  }

  private async readAnchorOf(fh: TailFileHandle | undefined, end: number): Promise<Buffer> {
    const len = Math.min(ANCHOR_BYTES, end);
    if (fh === undefined || len === 0) return Buffer.alloc(0);
    const b = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = await fh.read(b, got, len - got, end - len + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? b : Buffer.alloc(0);
  }

  private async anchorMatches(): Promise<boolean> {
    if (this.anchor.length === 0) return true;
    const cur = await this.readAnchor(this.splitter.position);
    return cur.length === this.anchor.length && cur.equals(this.anchor);
  }

  private async lastLineBoundary(fh: TailFileHandle, size: number): Promise<{ offset: number; skipPartial: boolean }> {
    if (size === 0) return { offset: 0, skipPartial: false };
    const b = Buffer.alloc(Math.min(END_SCAN_STEP, size));
    let end = size;
    while (end > 0 && size - end < END_SCAN_MAX) {
      const start = Math.max(0, end - b.length);
      const len = end - start;
      let got = 0;
      while (got < len) {
        const n = await fh.read(b, got, len - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      const idx = b.subarray(0, got).lastIndexOf(0x0a);
      if (idx !== -1) return { offset: start + idx + 1, skipPartial: false };
      end = start;
    }
    // the last line is longer than END_SCAN_MAX (or the file has none): start at EOF and drop the partial line
    return end === 0 ? { offset: 0, skipPartial: false } : { offset: size, skipPartial: true };
  }

  // ---------------------------------------------------------------- dormancy (P-TAIL-16, P-TAIL-35)

  /** Close the fd (LRU eviction or drain expiry). The partial line is dropped and re-read whole on reactivation. */
  async toDormant(): Promise<void> {
    const fh = this.fh;
    if (fh === undefined || this.phase === 'closed') return;
    const consumed = this.splitter.consumed;
    this.sizeAtDormancy = this.lastSize;
    this.anchor = await this.readAnchor(consumed).catch(() => Buffer.alloc(0));
    this.fh = undefined;
    await fh.close().catch(() => undefined);
    this.env.releaseSlot(this);
    this.splitter.reset(consumed);
    this.lastSize = consumed;
    this.phase = 'dormant';
    this.nextDormantCheck = (this.env.clock.now() + DORMANT_POLL_MS) as MonoMs;
    this.publishState();
  }

  private async pollDormant(now: MonoMs): Promise<void> {
    if (now < this.nextDormantCheck) return;
    this.nextDormantCheck = (now + DORMANT_POLL_MS) as MonoMs;
    let p: TailStat;
    try {
      p = await this.env.fs.stat(this.path);
    } catch {
      this.pathMissing = true; // gone: nothing to read; a hook or the relocation scan may give a new path (P-TAIL-23)
      return;
    }
    this.pathMissing = !p.isFile;
    if (!p.isFile) return;
    if (p.size !== this.sizeAtDormancy || p.dev !== this.dev || p.ino !== this.ino || p.mtimeMs !== this.lastMtime) {
      // grew or changed while dormant: reactivate as draining (growth extends the grace window)
      this.draining = true;
      this.drainUntil = (now + this.env.drainGraceMs) as MonoMs;
      this.phase = 'reopen';
      await this.pollReopen();
    }
  }

  /** Drain expired while in 'reopen' (no fd held): become dormant without touching a descriptor. */
  private toDormantWithoutFd(now: MonoMs): void {
    // sizeAtDormancy keeps the value of the last real dormancy (or the replaced inode's identity differs anyway)
    this.splitter.reset(this.splitter.consumed);
    this.phase = 'dormant';
    this.nextDormantCheck = (now + DORMANT_POLL_MS) as MonoMs;
    this.publishState();
  }

  private async pollReopen(): Promise<void> {
    // stat first: a path that is gone must not take (or evict another follower for) an fd slot every poll (P-TAIL-16)
    try {
      const st = await this.env.fs.stat(this.path);
      if (!st.isFile) {
        this.pathMissing = true;
        return;
      }
    } catch (e) {
      const c = errnoOf(e);
      if (c !== undefined && WAIT_CODES.has(c)) this.pathMissing = true;
      else this.noteError(e, 'stat');
      return;
    }
    this.pathMissing = false;
    const opened = await this.openAt(this.path);
    if (opened === undefined) return;
    this.fh = opened.fh;
    this.lastErrorNote = undefined;
    this.realPath = opened.realPath;
    this.phase = 'open';
    this.env.emit({
      kind: 'opened',
      file: this.key,
      path: this.path,
      dev: opened.stat.dev,
      ino: opened.stat.ino,
      size: opened.stat.size,
      startOffset: this.splitter.position,
    });
    if (this.path !== this.reportedPath) {
      const same = opened.stat.dev === this.dev && opened.stat.ino === this.ino;
      this.env.emit({ kind: 'moved', file: this.key, from: this.reportedPath ?? this.path, to: this.path, sameInode: same });
      this.reportedPath = this.path;
    }
    this.publishState();
    if (opened.stat.dev !== this.dev || opened.stat.ino !== this.ino) {
      this.dev = opened.stat.dev;
      this.ino = opened.stat.ino;
      await this.rescan('replaced', opened.stat);
      return;
    }
    await this.checkAndRead(opened.stat);
  }

  // ---------------------------------------------------------------- close

  /** One last poll, then `torn-tail` for an incomplete last line, close the fd, state `closed`. */
  async finalDrain(): Promise<void> {
    if (this.phase === 'open') {
      await this.pollOpen();
      const rem = this.splitter.remainder();
      if (rem !== undefined) this.env.emit({ kind: 'torn-tail', file: this.key, offset: rem.offset, bytes: rem.bytes });
    }
    const fh = this.fh;
    this.fh = undefined;
    if (fh !== undefined) {
      await fh.close().catch(() => undefined);
      this.env.releaseSlot(this);
    }
    this.markClosed();
  }
}

/** Adapter timer A-6 (§4.12): runs `pass` every pollIdleMs, every pollFastMs for fastBurstMs after poke(); one pass at a
 *  time (a poke during a pass re-runs it once right after). Scheduling only through the Clock port. */
export class PollLoop {
  private cancel: Cancel | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  private stopped = false;
  private fastUntil = 0;

  constructor(
    private readonly clock: Clock,
    private readonly o: { idleMs: number; fastMs: number; burstMs: number },
    private readonly pass: () => Promise<void>,
    private readonly onError: (e: unknown) => void,
  ) {}

  /** Run a pass now (no burst). */
  kick(): void {
    if (this.stopped) return;
    if (this.running !== undefined) this.rerun = true;
    else this.schedule(0);
  }

  /** Run a pass now and poll fast for burstMs. */
  poke(): void {
    if (this.stopped) return;
    this.fastUntil = this.clock.now() + this.o.burstMs;
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancel?.();
    this.cancel = undefined;
    await this.running;
  }

  private schedule(delayMs: number): void {
    this.cancel?.();
    const at = (this.clock.now() + delayMs) as MonoMs;
    this.cancel = this.clock.setTimer(at, () => {
      this.cancel = undefined;
      this.run();
    });
  }

  private run(): void {
    if (this.stopped) return;
    if (this.running !== undefined) {
      this.rerun = true;
      return;
    }
    this.running = (async () => {
      try {
        await this.pass();
      } catch (e) {
        this.onError(e);
      }
    })().finally(() => {
      this.running = undefined;
      if (this.stopped) return;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(0);
      } else this.schedule(this.clock.now() < this.fastUntil ? this.o.fastMs : this.o.idleMs);
    });
  }
}
