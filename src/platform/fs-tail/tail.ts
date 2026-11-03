// platform/fs-tail/tail.ts — TranscriptTail (DESIGN.md §2.7.4; transcript-tail.md §6, §8, §13). Rev 2 (§10 C3): poll + pread
// only. The tail knows files, bytes and lines; it has no Claude semantics beyond file naming (§13 layering).
//
// Mitigations implemented here (follower.ts and discovery.ts list theirs):
// - P-TAIL-16 fd slots ≤ maxActiveFollowers; the least recently grown follower (draining first, never the current main)
//   is demoted to dormant.
// - P-TAIL-23 observePath with the same session id and a new path is a relocation (`moved`); the subagent paths under the
//   old `<sid>/` dir are rebased; a path that disappears (fd still valid) triggers a `projects/*/<sid>.jsonl` search;
//   poke('CwdChanged') forces that search at once.
// - P-TAIL-24 a new session id makes the previous main follower `draining` (Claude appends the /clear withdrawal to it).
// - P-TAIL-25 every newly followed file starts at the beginning; content that existed before we looked is `replay:true`.
// - P-TAIL-30/P-TAIL-34 expectSubagent creates a waiting follower; `missing` after missingAgentTimeoutMs.
// - P-TAIL-32/P-TAIL-35 readdir backstop every SCAN_INTERVAL_MS finds agents whose hooks were lost (incl. workflows/*);
//   expectSubagent reactivates a dormant follower.
// - P-TAIL-33 realpath dedupe: a path that resolves to a file another follower already reads is never followed twice.
// - P-TAIL-36 per-file ordered streams only; listeners are called synchronously in file order per FileKey.
// - P-TAIL-37 the tail never blocks anyone: hooks only poke() it.
// - P-TX-05 a main file still missing is also searched as `projects/<slug-prefix>*/<sid>.jsonl` (hash-suffixed slugs).

import { resolve } from 'node:path';
import type { Cancel, Clock, MonoMs } from '../../model/time.js';
import type { FileKey, TailCheckpoint, TailEvent, TranscriptTail, TranscriptTailFactory } from '../ports.js';
import {
  expectedSubagentPath,
  locateMainBySessionId,
  locateSubagent,
  rebaseUnderSession,
  scanSubagents,
  slugPrefixOf,
} from './discovery.js';
import { fileKeyId, Follower, PollLoop, type FollowerEnv, type StartAt } from './follower.js';
import { describeError, nodeTailFs, type TailFs } from './node-fs.js';

/** Readdir backstop / relocation search period (DESIGN.md P-TAIL-19: "poll + readdir 2 s"). */
const SCAN_INTERVAL_MS = 2000;
/** observePath sources that mean "this session id is (again) the live one": the SessionStart hook or its `source`. */
const START_SOURCE_RE = /^(?:SessionStart|startup|resume|clear|compact|fork)$/i;

export type TranscriptTailOptions = Parameters<TranscriptTailFactory['create']>[0];

function validate(o: TranscriptTailOptions): void {
  const pos = (n: number, name: string): void => {
    if (!(Number.isFinite(n) && n > 0)) throw new RangeError(`TranscriptTail: ${name} must be a positive number`);
  };
  pos(o.pollIdleMs, 'pollIdleMs');
  pos(o.pollFastMs, 'pollFastMs');
  pos(o.maxLineBytes, 'maxLineBytes');
  pos(o.readChunkBytes, 'readChunkBytes');
  pos(o.maxActiveFollowers, 'maxActiveFollowers');
  if (!(o.fastBurstMs >= 0) || !(o.drainGraceMs >= 0) || !(o.missingAgentTimeoutMs >= 0))
    throw new RangeError('TranscriptTail: fastBurstMs, drainGraceMs and missingAgentTimeoutMs must be >= 0');
}

class Tail implements TranscriptTail {
  private readonly followers = new Map<string, Follower>();
  private readonly listeners = new Set<(e: TailEvent) => void>();
  private readonly loop: PollLoop;
  private readonly env: FollowerEnv;
  private readonly clock: Clock;
  private currentMain: string | undefined;
  private openSlots = 0;
  private nextScanAt = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private emitting = 0;

  constructor(
    private readonly o: TranscriptTailOptions,
    private readonly fs: TailFs,
  ) {
    validate(o);
    this.clock = o.clock;
    this.env = {
      fs,
      clock: o.clock,
      maxLineBytes: o.maxLineBytes,
      drainGraceMs: o.drainGraceMs,
      skipParseTypes: o.skipParseTypes,
      readBuf: Buffer.allocUnsafe(o.readChunkBytes),
      emit: (e) => {
        this.emit(e);
      },
      acquireSlot: (f) => this.acquireSlot(f),
      releaseSlot: () => {
        this.openSlots = Math.max(0, this.openSlots - 1);
      },
      isDuplicate: (f, realPath) => {
        for (const g of this.followers.values()) if (g !== f && !g.isClosed && g.realPath === realPath) return true;
        return false;
      },
    };
    this.loop = new PollLoop(
      o.clock,
      { idleMs: o.pollIdleMs, fastMs: o.pollFastMs, burstMs: o.fastBurstMs },
      () => this.pass(),
      (e) => {
        this.emit({ kind: 'error', message: `poll: ${describeError(e)}`, fatal: false });
      },
    );
  }

  // ------------------------------------------------------------------ public API

  followMain(sessionId: string, path: string, o: { startAt?: 'beginning' | 'end' | { checkpoint: TailCheckpoint } } = {}): void {
    if (this.closed) return;
    const startAt: StartAt = o.startAt ?? 'beginning';
    const f = this.mainFollower(sessionId, resolve(path), startAt, 'follow');
    f.setStartAt(startAt);
    this.makeCurrent(sessionId);
    this.loop.kick();
  }

  /** Every hook payload's transcript_path lands here. A session id never seen before becomes the current main (the new
   *  generation's first hook may be a UserPromptSubmit that overtook SessionStart, K-17); a known non-current session
   *  becomes current again only on a session-start signal (`/resume` back to it); any other late hook of an old
   *  generation only extends its drain, so reordered hooks cannot flip the current file back and forth. */
  observePath(sessionId: string, path: string, source: string): void {
    if (this.closed || sessionId === '' || path === '') return;
    const known = this.followers.has(fileKeyId({ kind: 'main', sessionId }));
    const f = this.mainFollower(sessionId, resolve(path), 'beginning', 'observe');
    if (!known || this.currentMain === undefined || this.currentMain === sessionId || START_SOURCE_RE.test(source))
      this.makeCurrent(sessionId);
    else f.refreshDraining(this.clock.now());
    this.loop.poke();
  }

  expectSubagent(sessionId: string, agentId: string): void {
    if (this.closed || agentId === '') return;
    const now = this.clock.now();
    const existing = this.followers.get(fileKeyId({ kind: 'subagent', sessionId, agentId }));
    if (existing !== undefined && !existing.isClosed) {
      existing.makeLive();
      if (existing.isWaiting) existing.missingAt = (now + this.o.missingAgentTimeoutMs) as MonoMs;
    } else {
      const f = this.newSubagent(sessionId, agentId, undefined, 'expect');
      f.missingAt = (now + this.o.missingAgentTimeoutMs) as MonoMs;
    }
    this.loop.poke();
  }

  subagentStopped(sessionId: string, agentId: string, path?: string): void {
    if (this.closed || agentId === '') return;
    const now = this.clock.now();
    const p = path !== undefined && path !== '' ? resolve(path) : undefined;
    let f = this.followers.get(fileKeyId({ kind: 'subagent', sessionId, agentId }));
    if (f === undefined || f.isClosed) f = this.newSubagent(sessionId, agentId, p, 'stop');
    else if (p !== undefined) {
      if (f.path === '') f.applyPath(p);
      else f.propose(p);
    }
    if (f.isWaiting) f.missingAt = (now + this.o.missingAgentTimeoutMs) as MonoMs;
    f.startDraining(now);
    this.loop.poke();
  }

  poke(reason?: string): void {
    if (this.closed) return;
    if (reason !== undefined && /cwd/i.test(reason)) this.nextScanAt = 0; // CwdChanged: re-stat + relocation search now
    this.loop.poke();
  }

  on(l: (e: TailEvent) => void): Cancel {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  checkpoint(): TailCheckpoint {
    const files: TailCheckpoint['files'] = [];
    for (const f of this.followers.values()) {
      const e = f.checkpointEntry();
      if (e !== undefined) files.push(e);
    }
    return { files };
  }

  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  // ------------------------------------------------------------------ internals

  private isClosing(): boolean {
    return this.closed;
  }

  private emit(e: TailEvent): void {
    if (this.listeners.size === 0) return;
    this.emitting++;
    try {
      for (const l of [...this.listeners]) {
        try {
          l(e);
        } catch (err) {
          // a throwing listener never stops the tail or other listeners; report once, never recursively
          if (this.emitting === 1 && e.kind !== 'error') {
            const message = `listener threw: ${describeError(err)}`;
            this.emit('file' in e ? { kind: 'error', file: e.file, message, fatal: false } : { kind: 'error', message, fatal: false });
          }
        }
      }
    } finally {
      this.emitting--;
    }
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    await this.loop.stop();
    for (const f of this.ordered()) {
      try {
        await f.finalDrain();
      } catch (e) {
        this.emit({ kind: 'error', file: f.key, message: `close: ${describeError(e)}`, fatal: false });
      }
    }
    this.followers.clear();
    this.listeners.clear();
  }

  private mainFollower(sessionId: string, path: string, startAt: StartAt, by: Follower['discoveredBy']): Follower {
    const id = fileKeyId({ kind: 'main', sessionId });
    const f = this.followers.get(id);
    if (f !== undefined && !f.isClosed) {
      if (f.path !== path) {
        if (f.isWaiting) this.relocateMain(f, path);
        else f.propose(path); // applied with realpath dedupe in the next pass
      }
      return f;
    }
    const nf = new Follower({ kind: 'main', sessionId }, path, startAt, this.env, by);
    this.followers.set(id, nf);
    nf.publishState();
    return nf;
  }

  private newSubagent(sessionId: string, agentId: string, path: string | undefined, by: Follower['discoveredBy']): Follower {
    const key: FileKey = { kind: 'subagent', sessionId, agentId };
    const main = this.followers.get(fileKeyId({ kind: 'main', sessionId }));
    const p = path ?? (main !== undefined && main.path !== '' ? expectedSubagentPath(main.path, sessionId, agentId) : '');
    const f = new Follower(key, p, 'beginning', this.env, by);
    this.followers.set(f.id, f);
    f.publishState();
    return f;
  }

  private makeCurrent(sessionId: string): void {
    if (this.currentMain === sessionId) {
      this.followers.get(fileKeyId({ kind: 'main', sessionId }))?.makeLive();
      return;
    }
    const now = this.clock.now();
    if (this.currentMain !== undefined) this.followers.get(fileKeyId({ kind: 'main', sessionId: this.currentMain }))?.startDraining(now);
    this.currentMain = sessionId;
    this.followers.get(fileKeyId({ kind: 'main', sessionId }))?.makeLive();
  }

  /** Main path change: move the main follower and rebase its subagents' paths under the old `<sid>/` dir (§5.3). */
  private relocateMain(f: Follower, path: string): void {
    const old = f.path;
    f.applyPath(path);
    if (f.key.kind !== 'main' || old === '') return;
    const sid = f.key.sessionId;
    for (const g of this.followers.values()) {
      if (g.key.kind !== 'subagent' || g.key.sessionId !== sid || g.isClosed) continue;
      if (g.path === '') {
        g.applyPath(expectedSubagentPath(path, sid, g.key.agentId));
        continue;
      }
      const r = rebaseUnderSession(g.path, old, path, sid);
      if (r !== undefined) g.applyPath(r);
    }
  }

  private async acquireSlot(f: Follower): Promise<boolean> {
    if (this.openSlots < this.o.maxActiveFollowers) {
      this.openSlots++;
      return true;
    }
    const currentId = this.currentMain !== undefined ? fileKeyId({ kind: 'main', sessionId: this.currentMain }) : undefined;
    let victim: Follower | undefined;
    for (const g of this.followers.values()) {
      if (g === f || !g.hasFd || g.id === currentId) continue;
      if (
        victim === undefined ||
        (g.draining && !victim.draining) ||
        (g.draining === victim.draining && g.lastActivity < victim.lastActivity)
      )
        victim = g;
    }
    if (victim === undefined) return false;
    await victim.toDormant(); // releases its slot
    if (this.openSlots < this.o.maxActiveFollowers) {
      this.openSlots++;
      return true;
    }
    return false;
  }

  /** Current main first, then live subagents, draining, waiting, dormant (serialized catch-up, P-TAIL-41). */
  private ordered(): Follower[] {
    const currentId = this.currentMain !== undefined ? fileKeyId({ kind: 'main', sessionId: this.currentMain }) : undefined;
    const rank = (f: Follower): number => {
      if (f.id === currentId) return 0;
      switch (f.state) {
        case 'active':
          return 1;
        case 'draining':
          return 2;
        case 'waiting':
          return 3;
        case 'dormant':
          return 4;
        case 'closed':
          return 5;
      }
    };
    return [...this.followers.values()].sort((a, b) => rank(a) - rank(b));
  }

  private async pass(): Promise<void> {
    if (this.closed) return;
    for (const f of this.ordered()) {
      if (this.isClosing()) return; // close() may begin during any await of the pass
      try {
        await this.applyCandidate(f);
        if (f.isWaiting && f.key.kind === 'subagent') await this.locateWaitingSubagent(f);
        await f.step(this.clock.now());
      } catch (e) {
        this.emit({ kind: 'error', file: f.key, message: `poll: ${describeError(e)}`, fatal: false });
      }
      if (f.isClosed) this.followers.delete(f.id);
    }
    const now = this.clock.now();
    if (now >= this.nextScanAt && !this.isClosing()) {
      this.nextScanAt = now + SCAN_INTERVAL_MS;
      try {
        await this.scan();
      } catch (e) {
        this.emit({ kind: 'error', message: `scan: ${describeError(e)}`, fatal: false });
      }
    }
  }

  /** Apply a proposed path unless it resolves to the file we already read (P-TAIL-33: e.g. the `tasks/*.output` symlink). */
  private async applyCandidate(f: Follower): Promise<void> {
    const c = f.candidatePath;
    if (c === undefined) return;
    if (f.realPath !== undefined) {
      let rp: string | undefined;
      try {
        rp = await this.fs.realpath(c);
      } catch {
        rp = undefined; // not there yet: still adopt it; the fd keeps reading and the path is re-checked every poll
      }
      if (rp === f.realPath && rp !== c) {
        f.candidatePath = undefined;
        return;
      }
      if (rp !== undefined) {
        for (const g of this.followers.values()) {
          if (g !== f && !g.isClosed && g.realPath === rp) {
            f.candidatePath = undefined; // another follower already reads that file
            return;
          }
        }
      }
    }
    if (f.key.kind === 'main') this.relocateMain(f, c);
    else f.applyPath(c);
  }

  private async locateWaitingSubagent(f: Follower): Promise<void> {
    if (f.key.kind !== 'subagent') return;
    const main = this.followers.get(fileKeyId({ kind: 'main', sessionId: f.key.sessionId }));
    if (main === undefined || main.path === '') return;
    if (f.path === '') f.applyPath(expectedSubagentPath(main.path, f.key.sessionId, f.key.agentId));
    if (f.discoveredBy === 'stop' && f.path !== expectedSubagentPath(main.path, f.key.sessionId, f.key.agentId)) return; // authoritative
    const found = await locateSubagent(this.fs, main.path, f.key.sessionId, f.key.agentId);
    if (found !== undefined && found !== f.path) f.applyPath(found);
  }

  private async scan(): Promise<void> {
    for (const f of [...this.followers.values()]) {
      if (this.isClosing()) return;
      if (f.isClosed || f.key.kind !== 'main') continue;
      const sid = f.key.sessionId;
      // P-TX-05 / P-TAIL-23: find the main file elsewhere when it is not where we think
      if (f.isWaiting || f.pathMissing) {
        const found = await locateMainBySessionId(this.fs, this.o.configDir, sid, f.isWaiting ? { slugPrefix: slugPrefixOf(f.path) } : {});
        const pick = found.find((p) => p !== f.path);
        if (pick !== undefined) f.propose(pick);
      }
      // P-TAIL-32 / P-TAIL-35: backstop for subagents whose hooks were lost
      if (f.isWaiting || f.isDormant) continue;
      for (const s of await scanSubagents(this.fs, f.path, sid)) {
        const id = fileKeyId({ kind: 'subagent', sessionId: sid, agentId: s.agentId });
        const g = this.followers.get(id);
        if (g === undefined || g.isClosed) {
          const nf = this.newSubagent(sid, s.agentId, s.path, 'scan');
          nf.startDraining(this.clock.now());
        } else if (g.isWaiting && g.path !== s.path) g.applyPath(s.path);
      }
    }
    // subagent files that moved away while their fd stayed valid
    for (const g of [...this.followers.values()]) {
      if (g.key.kind !== 'subagent' || !g.pathMissing || g.isClosed) continue;
      const main = this.followers.get(fileKeyId({ kind: 'main', sessionId: g.key.sessionId }));
      if (main === undefined || main.path === '') continue;
      const found = await locateSubagent(this.fs, main.path, g.key.sessionId, g.key.agentId);
      if (found !== undefined && found !== g.path) g.propose(found);
    }
  }
}

/** The TranscriptTailFactory over a TailFs (real node:fs by default; FakeTailFs in tests). */
export function createTranscriptTailFactory(fs: TailFs = nodeTailFs): TranscriptTailFactory {
  return { create: (o) => new Tail(o, fs) };
}

/** Default tuning values (DESIGN.md §2.7.4 comments, §4.12 A-6, transcript-tail.md §13); L3 config may override them. */
export const DEFAULT_TAIL_TUNING = {
  pollIdleMs: 250,
  pollFastMs: 50,
  fastBurstMs: 3000,
  drainGraceMs: 5000,
  missingAgentTimeoutMs: 10_000,
  maxLineBytes: 64 * 1024 * 1024,
  readChunkBytes: 1024 * 1024,
  maxActiveFollowers: 32,
  skipParseTypes: new Set(['api-request-blob', 'api-request-shape', 'file-history-snapshot']) as ReadonlySet<string>,
} as const;
