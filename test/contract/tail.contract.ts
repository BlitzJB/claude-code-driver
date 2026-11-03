// test/contract/tail.contract.ts — the shared TranscriptTail contract (DESIGN.md §2.7 "Fakes", §6.4 tail row; transcript-tail.md
// §14 test matrix). `defineTailContract` runs every scenario against a TailWorld: FakeTailFs + ManualClock (deterministic),
// or the real node:fs in a temp dir with a real clock (tail.contract.test.ts runs both). Also exports the test kit
// (ManualClock, worlds, event recorder) used by the unit tests in test/unit/platform/tail-*.test.ts.

import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cancel, Clock, MonoMs, WallMs } from '../../src/model/time.js';
import type { FileKey, TailEvent, TailLine, TranscriptTail } from '../../src/platform/ports.js';
import { FakeTailFs } from '../../src/platform/fs-tail/fake-tail-fs.js';
import { nodeTailFs, type TailFileHandle, type TailFs } from '../../src/platform/fs-tail/node-fs.js';
import { createTranscriptTailFactory, DEFAULT_TAIL_TUNING, type TranscriptTailOptions } from '../../src/platform/fs-tail/tail.js';

// ====================================================================== clocks

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
};

/** Deterministic Clock: timers fire only inside advance(); microtasks/immediates are flushed between firings. */
export class ManualClock implements Clock {
  private t = 0;
  private wallBase = 1_700_000_000_000;
  private seq = 0;
  private timers: { at: number; seq: number; fn: () => void }[] = [];

  now(): MonoMs {
    return this.t as MonoMs;
  }
  wallNow(): WallMs {
    return (this.wallBase + this.t) as WallMs;
  }
  /** Step the wall clock (NTP step, sleep/wake) without moving mono time. */
  jumpWall(ms: number): void {
    this.wallBase += ms;
  }
  setTimer(atMono: MonoMs, fn: () => void): Cancel {
    const rec = { at: atMono, seq: this.seq++, fn };
    this.timers.push(rec);
    return () => {
      this.timers = this.timers.filter((x) => x !== rec);
    };
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((res) => {
      const c = this.setTimer((this.t + ms) as MonoMs, res);
      signal?.addEventListener('abort', () => {
        c();
        res();
      });
    });
  }
  get pendingTimers(): number {
    return this.timers.length;
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await flush();
    for (;;) {
      let next: (typeof this.timers)[number] | undefined;
      for (const x of this.timers)
        if (x.at <= target && (next === undefined || x.at < next.at || (x.at === next.at && x.seq < next.seq))) next = x;
      if (next === undefined) break;
      const fire = next;
      this.timers = this.timers.filter((x) => x !== fire);
      this.t = Math.max(this.t, fire.at);
      fire.fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

/** Real Clock (performance.now / Date.now / setTimeout) with an adjustable wall offset. */
class RealClock implements Clock {
  private wallOffset = 0;
  now(): MonoMs {
    return performance.now() as MonoMs;
  }
  wallNow(): WallMs {
    return (Date.now() + this.wallOffset) as WallMs;
  }
  jumpWall(ms: number): void {
    this.wallOffset += ms;
  }
  setTimer(atMono: MonoMs, fn: () => void): Cancel {
    const h = setTimeout(fn, Math.max(0, atMono - performance.now()));
    return () => {
      clearTimeout(h);
    };
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ====================================================================== worlds

interface WorldCounters {
  openFds: number;
  maxOpenFds: number;
  maxReadsInFlight: number;
  maxReadLength: number;
}

export interface TailWorld {
  readonly name: 'fake' | 'real';
  readonly configDir: string;
  readonly clock: ManualClock | RealClock;
  readonly fs: TailFs;
  readonly opts: TranscriptTailOptions;
  counters(): WorldCounters;
  write(path: string, data: string | Buffer): void;
  append(path: string, data: string | Buffer): void;
  truncate(path: string, len: number): void;
  removeLineContaining(path: string, needle: string): void;
  rename(from: string, to: string): void;
  replace(path: string, data: string): void;
  copyNewInode(from: string, to: string): void;
  unlink(path: string): void;
  symlink(target: string, path: string): void;
  mkdirp(dir: string): void;
  deny(path: string): void;
  jumpWall(ms: number): void;
  /** Let `ms` of tail time pass (manual: advance; real: sleep). */
  advance(ms: number): Promise<void>;
  dispose(): void;
}

/** Wrap a TailFs to count open descriptors, reads in flight and read lengths. */
function countingFs(inner: TailFs): { fs: TailFs; counters: WorldCounters } {
  const c: WorldCounters = { openFds: 0, maxOpenFds: 0, maxReadsInFlight: 0, maxReadLength: 0 };
  let inFlight = 0;
  const fs: TailFs = {
    async open(p) {
      const h = await inner.open(p);
      c.openFds++;
      c.maxOpenFds = Math.max(c.maxOpenFds, c.openFds);
      let closed = false;
      const wrapped: TailFileHandle = {
        stat: () => h.stat(),
        async read(buf, off, len, pos) {
          inFlight++;
          c.maxReadsInFlight = Math.max(c.maxReadsInFlight, inFlight);
          c.maxReadLength = Math.max(c.maxReadLength, len);
          try {
            return await h.read(buf, off, len, pos);
          } finally {
            inFlight--;
          }
        },
        async close() {
          if (!closed) {
            closed = true;
            c.openFds--;
          }
          await h.close();
        },
      };
      return wrapped;
    },
    stat: (p) => inner.stat(p),
    readdir: (p) => inner.readdir(p),
    realpath: (p) => inner.realpath(p),
  };
  return { fs, counters: c };
}

export function makeFakeWorld(over: Partial<TranscriptTailOptions> = {}): TailWorld & { fake: FakeTailFs } {
  const fake = new FakeTailFs();
  const clock = new ManualClock();
  const { fs, counters } = countingFs(fake);
  const configDir = '/home/user/.claude';
  fake.mkdirp(configDir);
  return {
    name: 'fake',
    fake,
    configDir,
    clock,
    fs,
    opts: { ...DEFAULT_TAIL_TUNING, configDir, clock, ...over },
    counters: () => counters,
    write: (p, d) => {
      fake.writeFile(p, d);
    },
    append: (p, d) => {
      fake.appendFile(p, d);
    },
    truncate: (p, n) => {
      fake.truncate(p, n);
    },
    removeLineContaining: (p, n) => {
      fake.removeLineContaining(p, n);
    },
    rename: (a, b) => {
      fake.mkdirp(dirname(b)); // like Claude's relocation: mkdir the new slug dir first
      fake.rename(a, b);
    },
    replace: (p, d) => {
      fake.replaceFile(p, d);
    },
    copyNewInode: (a, b) => {
      fake.copyNewInode(a, b);
    },
    unlink: (p) => {
      fake.unlink(p);
    },
    symlink: (t, p) => {
      fake.symlink(t, p);
    },
    mkdirp: (d) => {
      fake.mkdirp(d);
    },
    deny: (p) => {
      fake.setDenied(p, true);
    },
    jumpWall: (ms) => {
      clock.jumpWall(ms);
    },
    advance: (ms) => clock.advance(ms),
    dispose: () => undefined,
  };
}

export function makeRealWorld(over: Partial<TranscriptTailOptions> = {}): TailWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-tail-')));
  const configDir = join(root, '.claude');
  mkdirSync(configDir, { recursive: true });
  const clock = new RealClock();
  const { fs, counters } = countingFs(nodeTailFs);
  const ensure = (p: string): void => {
    mkdirSync(dirname(p), { recursive: true });
  };
  return {
    name: 'real',
    configDir,
    clock,
    fs,
    opts: {
      ...DEFAULT_TAIL_TUNING,
      configDir,
      clock,
      pollIdleMs: 20,
      pollFastMs: 5,
      fastBurstMs: 200,
      drainGraceMs: 300,
      missingAgentTimeoutMs: 500,
      ...over,
    },
    counters: () => counters,
    write: (p, d) => {
      ensure(p);
      writeFileSync(p, d);
    },
    append: (p, d) => {
      ensure(p);
      appendFileSync(p, d);
    },
    truncate: (p, n) => {
      truncateSync(p, n);
    },
    removeLineContaining: (p, needle) => {
      const content = readFileSync(p);
      const at = content.lastIndexOf(needle);
      if (at === -1) throw new Error(`'${needle}' not found`);
      const start = content.lastIndexOf(0x0a, at) + 1;
      const nl = content.indexOf(0x0a, at);
      const after = Buffer.from(content.subarray(nl === -1 ? content.length : nl + 1));
      truncateSync(p, start);
      appendFileSync(p, after);
    },
    rename: (a, b) => {
      ensure(b);
      renameSync(a, b);
    },
    replace: (p, d) => {
      const tmp = `${p}.compact.tmp.0000abcd`;
      writeFileSync(tmp, d);
      renameSync(tmp, p);
    },
    copyNewInode: (a, b) => {
      ensure(b);
      copyFileSync(a, b);
      unlinkSync(a);
    },
    unlink: (p) => {
      unlinkSync(p);
    },
    symlink: (t, p) => {
      ensure(p);
      symlinkSync(t, p);
    },
    mkdirp: (d) => {
      mkdirSync(d, { recursive: true });
    },
    deny: (p) => {
      chmodSync(p, 0o000);
    },
    jumpWall: (ms) => {
      clock.jumpWall(ms);
    },
    advance: (ms) => new Promise((r) => setTimeout(r, ms)),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ====================================================================== recorder + helpers

export class Recorder {
  readonly events: TailEvent[] = [];
  constructor(tail: TranscriptTail) {
    tail.on((e) => this.events.push(e));
  }
  of<K extends TailEvent['kind']>(kind: K, file?: FileKey): Extract<TailEvent, { kind: K }>[] {
    return this.events.filter(
      (e): e is Extract<TailEvent, { kind: K }> => e.kind === kind && (file === undefined || ('file' in e && sameKey(e.file, file))),
    );
  }
  lines(file?: FileKey): TailLine[] {
    return this.of('line')
      .map((e) => e.line)
      .filter((l) => file === undefined || sameKey(l.file, file));
  }
  /** `json.n` of every parsed line (scenario lines carry a numeric `n`). */
  ns(file?: FileKey): number[] {
    return this.lines(file).map((l) => (l.json as { n?: number } | undefined)?.n ?? -1);
  }
  states(file: FileKey): string[] {
    return this.of('state', file).map((e) => e.state);
  }
}

function sameKey(a: FileKey | undefined, b: FileKey): boolean {
  if (a?.kind !== b.kind || a.sessionId !== b.sessionId) return false;
  return a.kind === 'main' || (b.kind === 'subagent' && a.agentId === b.agentId);
}

export const jl = (o: object): string => JSON.stringify(o) + '\n';
export const entry = (n: number, extra: object = {}): string => jl({ type: 'user', uuid: `u${n}`, n, ...extra });

export const SID1 = '11111111-2222-4333-8444-555555555555';
export const SID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';

/** Advance in steps until `cond()` holds; fails the test with `what` after `maxMs` of tail time. */
async function until(w: TailWorld, cond: () => boolean, what: string, maxMs?: number): Promise<void> {
  const step = w.name === 'fake' ? w.opts.pollIdleMs : 10;
  const limit = maxMs ?? (w.name === 'fake' ? 60_000 : 8_000);
  let waited = 0;
  while (!cond()) {
    if (waited >= limit) throw new Error(`timed out waiting for: ${what}`);
    await w.advance(step);
    waited += step;
  }
}

// ====================================================================== the contract

export function defineTailContract(name: string, make: () => TailWorld): void {
  describe(`TranscriptTail contract (${name})`, () => {
    let w: TailWorld;
    let tail: TranscriptTail;
    let rec: Recorder;
    let projDir: string;
    let mainPath: string;
    const main1: FileKey = { kind: 'main', sessionId: SID1 };
    const main2: FileKey = { kind: 'main', sessionId: SID2 };
    const sub = (agentId: string): FileKey => ({ kind: 'subagent', sessionId: SID1, agentId });

    const start = (over: Partial<TranscriptTailOptions> = {}): void => {
      tail = createTranscriptTailFactory(w.fs).create({ ...w.opts, ...over });
      rec = new Recorder(tail);
    };

    beforeEach(() => {
      w = make();
      projDir = join(w.configDir, 'projects', '-work-repo');
      mainPath = join(projDir, `${SID1}.jsonl`);
      start();
    });
    afterEach(async () => {
      await tail.close();
      w.dispose();
    });

    it('#1 ENOENT (file and parent dirs) is `waiting`, then the created file is opened and its lines are live', async () => {
      tail.followMain(SID1, mainPath);
      await until(w, () => rec.of('waiting', main1).length > 0, 'waiting');
      expect(rec.of('waiting', main1)[0]).toMatchObject({ reason: 'ENOENT', path: mainPath });
      expect(rec.of('error')).toEqual([]);
      w.append(mainPath, entry(1) + entry(2));
      await until(w, () => rec.lines(main1).length === 2, 'two lines');
      expect(rec.of('opened', main1)[0]).toMatchObject({ path: mainPath, startOffset: 0 });
      expect(rec.lines(main1).map((l) => [l.replay, l.afterRewrite, l.generation, l.type])).toEqual([
        [false, false, 0, 'user'],
        [false, false, 0, 'user'],
      ]);
      expect(rec.states(main1)).toEqual(['waiting', 'active']);
    });

    it('#2 a 5 MB line written in 512 KiB chunks is exactly one line, never malformed', async () => {
      tail.followMain(SID1, mainPath);
      const pad = 'x'.repeat(5 * 1024 * 1024);
      const line = Buffer.from(jl({ type: 'user', n: 1, pad }));
      w.write(mainPath, '');
      for (let i = 0; i < line.length; i += 512 * 1024) {
        w.append(mainPath, line.subarray(i, Math.min(line.length, i + 512 * 1024)));
        await w.advance(w.opts.pollIdleMs + 1);
      }
      await until(w, () => rec.lines(main1).length === 1, 'the big line');
      expect(rec.of('malformed')).toEqual([]);
      expect(rec.lines(main1)[0]?.bytes).toBe(line.length - 1);
      expect((rec.lines(main1)[0]?.json as { pad: string }).pad.length).toBe(pad.length);
    });

    it('#3 a crash fragment sealed by a newline is one `malformed`, then the valid lines follow', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1) + '{"type":"assistant","message":{"con');
      await until(w, () => rec.lines(main1).length === 1, 'first line');
      w.append(mainPath, '\n' + entry(2) + entry(3));
      await until(w, () => rec.lines(main1).length === 3, 'lines after the seal');
      const m = rec.of('malformed', main1);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ reason: 'json', offset: Buffer.byteLength(entry(1)) });
      expect(rec.ns(main1)).toEqual([1, 2, 3]);
    });

    it('#4 tombstone truncate + rewrite that grows past the old offset → `rewritten`, full rescan, no garbage line', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1) + entry(2) + entry(3) + entry(4));
      await until(w, () => rec.lines(main1).length === 4, 'four lines');
      w.removeLineContaining(mainPath, '"uuid":"u2"');
      w.append(mainPath, entry(5, { pad: 'p'.repeat(80) }));
      await until(w, () => rec.of('resynced', main1).length === 1, 'resynced');
      const rw = rec.of('rewrite', main1);
      expect(rw).toHaveLength(1);
      expect(rw[0]).toMatchObject({ reason: 'rewritten', generation: 1 });
      expect(rec.of('malformed')).toEqual([]);
      const rescanned = rec.lines(main1).slice(4);
      expect(rescanned.map((l) => (l.json as { n: number }).n)).toEqual([1, 3, 4, 5]);
      expect(rescanned.every((l) => l.replay && l.afterRewrite && l.generation === 1)).toBe(true);
      expect(rec.of('resynced', main1)[0]).toMatchObject({ fullRescan: true, generation: 1 });
      w.append(mainPath, entry(6));
      await until(w, () => rec.lines(main1).length === 9, 'live line after resync');
      expect(rec.lines(main1)[8]).toMatchObject({ replay: false, afterRewrite: false, generation: 1 });
    });

    it('#5 truncate below the offset → `truncated` + rescan', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1) + entry(2) + entry(3));
      await until(w, () => rec.lines(main1).length === 3, 'three lines');
      w.truncate(mainPath, Buffer.byteLength(entry(1)));
      await until(w, () => rec.of('resynced', main1).length === 1, 'resynced');
      expect(rec.of('rewrite', main1)[0]).toMatchObject({ reason: 'truncated', newSize: Buffer.byteLength(entry(1)) });
      expect(rec.ns(main1)).toEqual([1, 2, 3, 1]);
    });

    it('#6 rename-replace (new inode) → `replaced` + full rescan of the new file', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1) + entry(2) + entry(3));
      await until(w, () => rec.lines(main1).length === 3, 'three lines');
      w.replace(mainPath, entry(10) + entry(3));
      await until(w, () => rec.of('resynced', main1).length === 1, 'resynced');
      expect(rec.of('rewrite', main1)[0]).toMatchObject({ reason: 'replaced', generation: 1 });
      expect(rec.of('opened', main1)).toHaveLength(2);
      expect(rec.ns(main1).slice(3)).toEqual([10, 3]);
      expect(
        rec
          .lines(main1)
          .slice(3)
          .every((l) => l.replay && l.afterRewrite),
      ).toBe(true);
    });

    it('#7 same-device mv of the file and `<sid>/` (/cd): no lost bytes; `moved{sameInode}` after observePath', async () => {
      const subPath = join(projDir, SID1, 'subagents', 'agent-a1.jsonl');
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1));
      tail.expectSubagent(SID1, 'a1');
      w.append(subPath, entry(100));
      await until(w, () => rec.lines(main1).length === 1 && rec.lines(sub('a1')).length === 1, 'initial lines');
      const newDir = join(w.configDir, 'projects', '-work-other');
      const newMain = join(newDir, `${SID1}.jsonl`);
      w.rename(mainPath, newMain);
      w.rename(join(projDir, SID1), join(newDir, SID1));
      w.append(newMain, entry(2));
      w.append(join(newDir, SID1, 'subagents', 'agent-a1.jsonl'), entry(101));
      await until(w, () => rec.lines(main1).length === 2 && rec.lines(sub('a1')).length === 2, 'lines through the held fds');
      tail.observePath(SID1, newMain, 'CwdChanged');
      await until(w, () => rec.of('moved', main1).length === 1 && rec.of('moved', sub('a1')).length === 1, 'moved');
      expect(rec.of('moved', main1)[0]).toMatchObject({ from: mainPath, to: newMain, sameInode: true });
      expect(rec.of('moved', sub('a1'))[0]).toMatchObject({ sameInode: true, to: join(newDir, SID1, 'subagents', 'agent-a1.jsonl') });
      expect(rec.of('rewrite')).toEqual([]);
      w.append(newMain, entry(3));
      await until(w, () => rec.lines(main1).length === 3, 'line after the move');
      expect(rec.ns(main1)).toEqual([1, 2, 3]);
      expect(tail.checkpoint().files.find((f) => sameKey(f.key, main1))?.path).toBe(newMain);
    });

    it('#7b without a hook, a moved main file is found by the relocation search', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1));
      await until(w, () => rec.lines(main1).length === 1, 'line');
      const newMain = join(w.configDir, 'projects', '-elsewhere', `${SID1}.jsonl`);
      w.rename(mainPath, newMain);
      tail.poke('CwdChanged');
      await until(w, () => rec.of('moved', main1).length === 1, 'moved via scan');
      expect(rec.of('moved', main1)[0]).toMatchObject({ to: newMain, sameInode: true });
    });

    it('#8 EXDEV-style copy (new inode, same bytes) + observePath → `moved{sameInode:false}` + full rescan (rev 2)', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1) + entry(2));
      await until(w, () => rec.lines(main1).length === 2, 'two lines');
      const newMain = join(w.configDir, 'projects', '-other-volume', `${SID1}.jsonl`);
      w.copyNewInode(mainPath, newMain);
      tail.observePath(SID1, newMain, 'CwdChanged');
      await until(w, () => rec.of('resynced', main1).length === 1, 'resynced');
      expect(rec.of('moved', main1)[0]).toMatchObject({ from: mainPath, to: newMain, sameInode: false });
      expect(rec.of('rewrite', main1)[0]).toMatchObject({ reason: 'replaced' });
      expect(rec.ns(main1)).toEqual([1, 2, 1, 2]);
      expect(
        rec
          .lines(main1)
          .slice(2)
          .every((l) => l.replay),
      ).toBe(true);
    });

    it('#9 /clear: the old file drains (withdrawal append is emitted under the old key), the new file opens later', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1));
      await until(w, () => rec.lines(main1).length === 1, 'line');
      const path2 = join(projDir, `${SID2}.jsonl`);
      tail.observePath(SID2, path2, 'SessionStart');
      await until(w, () => rec.states(main1).includes('draining'), 'old draining');
      w.append(mainPath, jl({ type: 'last-prompt', leafUuid: null, explicit: true, n: 2 }));
      await until(w, () => rec.lines(main1).length === 2, 'withdrawal line');
      expect(rec.lines(main1)[1]?.type).toBe('last-prompt');
      w.append(path2, entry(1));
      await until(w, () => rec.lines(main2).length === 1, 'new generation line');
      await until(w, () => rec.states(main1).includes('dormant'), 'old dormant after the grace period');
      // a late hook of the old generation must not steal "current" back
      tail.observePath(SID1, mainPath, 'PostToolUse');
      w.append(path2, entry(2));
      await until(w, () => rec.lines(main2).length === 2, 'new file still followed');
      expect(rec.states(main2).at(-1)).toBe('active');
    });

    it('#10 subagents: file appears after expect; workflow path found by readdir; never-written → `missing`', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1));
      await until(w, () => rec.lines(main1).length === 1, 'main line');
      tail.expectSubagent(SID1, 'a1');
      tail.expectSubagent(SID1, 'wf7');
      tail.expectSubagent(SID1, 'ghost');
      await w.advance(100);
      w.append(join(projDir, SID1, 'subagents', 'agent-a1.jsonl'), entry(1));
      w.append(join(projDir, SID1, 'subagents', 'workflows', 'wf-1', 'agent-wf7.jsonl'), entry(7));
      await until(w, () => rec.lines(sub('a1')).length === 1 && rec.lines(sub('wf7')).length === 1, 'subagent lines');
      expect(rec.lines(sub('a1'))[0]?.replay).toBe(false);
      tail.subagentStopped(SID1, 'ghost', join(projDir, SID1, 'subagents', 'agent-ghost.jsonl'));
      await until(w, () => rec.of('missing', sub('ghost')).length === 1, 'missing');
      expect(rec.of('missing', sub('ghost'))[0]?.waitedMs).toBeGreaterThanOrEqual(w.opts.missingAgentTimeoutMs);
      expect(rec.states(sub('ghost')).at(-1)).toBe('closed');
    });

    it('#10b an agent whose hooks were lost is found by the readdir backstop', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1));
      w.append(join(projDir, SID1, 'subagents', 'agent-lost.jsonl'), entry(5));
      await until(w, () => rec.lines(sub('lost')).length === 1, 'backstop discovery', w.name === 'fake' ? 10_000 : 5000);
      expect(rec.of('opened', sub('lost'))).toHaveLength(1);
    });

    it('#11 the `tasks/<id>.output` symlink is never followed twice (realpath dedupe)', async () => {
      const subPath = join(projDir, SID1, 'subagents', 'agent-a1.jsonl');
      const link = join(w.configDir, '..', 'tmp', '-work-repo', SID1, 'tasks', 'a1.output');
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1));
      tail.expectSubagent(SID1, 'a1');
      w.append(subPath, entry(1));
      w.symlink(subPath, link);
      await until(w, () => rec.lines(sub('a1')).length === 1, 'sub line');
      tail.subagentStopped(SID1, 'a1', link);
      w.append(subPath, entry(2));
      await until(w, () => rec.lines(sub('a1')).length === 2, 'second sub line');
      await w.advance(w.opts.pollIdleMs * 4);
      expect(rec.of('opened', sub('a1'))).toHaveLength(1);
      expect(rec.of('moved')).toEqual([]);
      expect(rec.ns(sub('a1'))).toEqual([1, 2]);
    });

    it('#12 100 subagent files with maxActiveFollowers 32: never more than 32 fds, every line delivered', async () => {
      await tail.close();
      start({ maxActiveFollowers: 32 });
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(0));
      for (let i = 0; i < 100; i++) {
        tail.expectSubagent(SID1, `x${i}`);
        w.append(join(projDir, SID1, 'subagents', `agent-x${i}.jsonl`), entry(i));
      }
      const all = (): number => rec.lines().filter((l) => l.file.kind === 'subagent').length;
      await until(w, () => all() === 100, '100 first lines');
      for (let i = 0; i < 100; i++) w.append(join(projDir, SID1, 'subagents', `agent-x${i}.jsonl`), entry(1000 + i));
      await until(w, () => all() === 200, '100 second lines (dormant followers reactivate)', w.name === 'fake' ? 120_000 : 15_000);
      expect(w.counters().maxOpenFds).toBeLessThanOrEqual(32);
      expect(rec.states(sub('x0'))).toContain('dormant');
      expect(rec.of('malformed')).toEqual([]);
    }, 30_000);

    it('#14 a wall clock jump of -1 h changes nothing but readAtWall', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1));
      await until(w, () => rec.lines(main1).length === 1, 'line');
      const wall1 = rec.lines(main1)[0]!.readAtWall;
      w.jumpWall(-3_600_000);
      w.append(mainPath, entry(2));
      await until(w, () => rec.lines(main1).length === 2, 'line after jump');
      const l2 = rec.lines(main1)[1]!;
      expect(l2.readAtWall).toBeLessThan(wall1);
      expect(l2.readAtMono).toBeGreaterThanOrEqual(rec.lines(main1)[0]!.readAtMono);
      expect(rec.events.map((e) => e.kind)).toEqual(['state', 'opened', 'state', 'line', 'line']);
    });

    it('#15 a large catch-up uses bounded reads, one read in flight, and keeps the event loop responsive', async () => {
      const size = w.name === 'fake' ? 100 * 1024 * 1024 : 24 * 1024 * 1024;
      const one = jl({ type: 'assistant', n: 0, pad: 'z'.repeat(1000) });
      const block = Buffer.from(one.repeat(1024));
      w.write(mainPath, '');
      for (let done = 0; done < size; done += block.length) w.append(mainPath, block);
      const expected = Math.ceil(size / block.length) * 1024;
      let ticks = 0;
      let ticking = true;
      const tick = (): void => {
        ticks++;
        if (ticking) setImmediate(tick);
      };
      setImmediate(tick);
      let count = 0;
      tail.on((e) => {
        if (e.kind === 'line') count++;
      });
      tail.followMain(SID1, mainPath);
      await until(w, () => count === expected, 'catch-up', w.name === 'fake' ? 60_000 : 15_000);
      ticking = false;
      expect(w.counters().maxReadsInFlight).toBe(1);
      expect(w.counters().maxReadLength).toBeLessThanOrEqual(w.opts.readChunkBytes);
      expect(rec.lines(main1).every((l) => l.replay)).toBe(true);
      if (w.name === 'real') expect(ticks).toBeGreaterThan(10);
    }, 60_000);

    it('skipParseTypes lines carry their type without json; others are parsed', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, jl({ type: 'api-request-blob', blob: 'b'.repeat(1000) }) + entry(1));
      await until(w, () => rec.lines(main1).length === 2, 'two lines');
      expect(rec.lines(main1)[0]).toMatchObject({ type: 'api-request-blob', json: undefined });
      expect(rec.lines(main1)[1]?.json).toMatchObject({ n: 1 });
    });

    it("startAt:'end' skips existing content and the partial last line; checkpoint reports the offset", async () => {
      w.append(mainPath, entry(1) + entry(2) + '{"type":"user","n":3,');
      tail.followMain(SID1, mainPath, { startAt: 'end' });
      await until(w, () => rec.of('opened', main1).length === 1, 'opened');
      const startOffset = Buffer.byteLength(entry(1) + entry(2));
      expect(rec.of('opened', main1)[0]?.startOffset).toBe(startOffset);
      w.append(mainPath, '"x":1}\n' + entry(4));
      await until(w, () => rec.lines(main1).length === 2, 'live lines');
      expect(rec.ns(main1)).toEqual([3, 4]);
      const cp = tail.checkpoint().files.find((f) => sameKey(f.key, main1));
      expect(cp).toMatchObject({ path: mainPath, generation: 0 });
      expect(cp?.offset).toBe(startOffset + Buffer.byteLength('{"type":"user","n":3,"x":1}\n' + entry(4)));
    });

    it("startAt:'beginning' on an existing file replays it (replay:true up to the attach size)", async () => {
      w.append(mainPath, entry(1) + entry(2));
      tail.followMain(SID1, mainPath);
      await until(w, () => rec.lines(main1).length === 2, 'replayed');
      w.append(mainPath, entry(3));
      await until(w, () => rec.lines(main1).length === 3, 'live');
      expect(rec.lines(main1).map((l) => l.replay)).toEqual([true, true, false]);
    });

    it('close() does one last poll, reports `torn-tail` for a partial line, then `closed`; idempotent', async () => {
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1));
      await until(w, () => rec.lines(main1).length === 1, 'line');
      w.append(mainPath, entry(2) + '{"type":"user","n":3');
      const closing = tail.close();
      expect(tail.close()).toBe(closing);
      await closing;
      expect(rec.ns(main1)).toEqual([1, 2]);
      expect(rec.of('torn-tail', main1)[0]).toMatchObject({ bytes: Buffer.byteLength('{"type":"user","n":3') });
      expect(rec.states(main1).at(-1)).toBe('closed');
      expect(w.counters().openFds).toBe(0);
    });

    it('EACCES is a waiting reason, not an error', async () => {
      w.write(mainPath, entry(1));
      w.deny(mainPath);
      tail.followMain(SID1, mainPath);
      await until(w, () => rec.of('waiting', main1).length > 0, 'waiting');
      expect(rec.of('waiting', main1)[0]?.reason).toBe('EACCES');
      expect(rec.of('error')).toEqual([]);
    });

    it('a throwing listener does not stop the tail or the other listeners', async () => {
      tail.on(() => {
        throw new Error('boom');
      });
      tail.followMain(SID1, mainPath);
      w.append(mainPath, entry(1) + entry(2));
      await until(w, () => rec.lines(main1).length === 2, 'lines');
      expect(rec.of('error').some((e) => e.message.includes('listener threw'))).toBe(true);
    });
  });
}
