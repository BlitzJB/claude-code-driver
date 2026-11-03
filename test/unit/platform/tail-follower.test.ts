// Follower + PollLoop behaviour on FakeTailFs + ManualClock (DESIGN.md §4.12 A-6, §5.3: P-TAIL-14, P-TAIL-15, P-TAIL-16,
// P-TAIL-17, P-TAIL-18, P-TAIL-24, P-TAIL-41; rev 2 §10 C3 no fs.watch).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileKey, TranscriptTail } from '../../../src/platform/ports.js';
import { FakeTailFs } from '../../../src/platform/fs-tail/fake-tail-fs.js';
import { DORMANT_POLL_MS, fileKeyId, PollLoop } from '../../../src/platform/fs-tail/follower.js';
import { createTranscriptTailFactory, DEFAULT_TAIL_TUNING, type TranscriptTailOptions } from '../../../src/platform/fs-tail/tail.js';
import { entry, jl, ManualClock, Recorder, SID1, SID2 } from '../../contract/tail.contract.js';

const CONFIG = '/home/user/.claude';
const PROJ = `${CONFIG}/projects/-repo`;
const MAIN = `${PROJ}/${SID1}.jsonl`;
const main1: FileKey = { kind: 'main', sessionId: SID1 };
const sub = (agentId: string): FileKey => ({ kind: 'subagent', sessionId: SID1, agentId });

let fs: FakeTailFs;
let clock: ManualClock;
let tail: TranscriptTail;
let rec: Recorder;
const make = (over: Partial<TranscriptTailOptions> = {}): void => {
  tail = createTranscriptTailFactory(fs).create({ ...DEFAULT_TAIL_TUNING, configDir: CONFIG, clock, ...over });
  rec = new Recorder(tail);
};

beforeEach(() => {
  fs = new FakeTailFs();
  fs.mkdirp(PROJ);
  clock = new ManualClock();
  make();
});
afterEach(async () => {
  await tail.close();
});

describe('poll cadence (A-6, P-TAIL-18)', () => {
  it('polls every 250 ms when idle and every 50 ms for fastBurstMs after poke()', async () => {
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    await clock.advance(1); // first pass
    const s0 = fs.counters.stats;
    await clock.advance(2500);
    const idle = fs.counters.stats - s0;
    expect(idle).toBeGreaterThanOrEqual(9);
    expect(idle).toBeLessThanOrEqual(14); // 10 polls + at most one 2 s scan
    tail.poke('PreToolUse');
    const s1 = fs.counters.stats;
    await clock.advance(1000);
    const fast = fs.counters.stats - s1;
    expect(fast).toBeGreaterThanOrEqual(19); // ≈ 20 polls in 1 s at 50 ms
    await clock.advance(DEFAULT_TAIL_TUNING.fastBurstMs); // burst over
    const s2 = fs.counters.stats;
    await clock.advance(1000);
    expect(fs.counters.stats - s2).toBeLessThanOrEqual(6);
  });

  it('a hook poke reads a new line without waiting for the idle period', async () => {
    fs.writeFile(MAIN, '');
    tail.followMain(SID1, MAIN);
    await clock.advance(1);
    fs.appendFile(MAIN, entry(1));
    tail.poke('Stop');
    await clock.advance(1);
    expect(rec.lines(main1)).toHaveLength(1);
  });

  it('only the Clock port schedules: the fs-tail sources use no setTimeout/setInterval/fs.watch/watchFile (P-TAIL-17, C3)', () => {
    const dir = join(import.meta.dirname, '../../../src/platform/fs-tail');
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
      if (/\b(setTimeout|setInterval|watchFile|fs\.watch|\bwatch\()/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('PollLoop', () => {
  it('runs one pass at a time; a poke during a pass re-runs it once afterwards', async () => {
    let active = 0;
    let maxActive = 0;
    let passes = 0;
    let release: (() => void) | undefined;
    const loop = new PollLoop(
      clock,
      { idleMs: 250, fastMs: 50, burstMs: 500 },
      async () => {
        passes++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => (release = r));
        active--;
      },
      () => undefined,
    );
    loop.kick();
    await clock.advance(0);
    expect(passes).toBe(1);
    loop.poke();
    loop.poke();
    await clock.advance(10);
    expect(passes).toBe(1); // still in the first pass
    release?.();
    await clock.advance(0);
    expect(passes).toBe(2); // exactly one re-run
    expect(maxActive).toBe(1);
    release?.();
    await loop.stop();
    await clock.advance(1000);
    expect(passes).toBe(2);
  });

  it('reports a throwing pass and keeps polling', async () => {
    const errors: unknown[] = [];
    let n = 0;
    const loop = new PollLoop(
      clock,
      { idleMs: 100, fastMs: 10, burstMs: 0 },
      () => (++n === 1 ? Promise.reject(new Error('x')) : Promise.resolve()),
      (e) => errors.push(e),
    );
    loop.kick();
    await clock.advance(350);
    expect(errors).toHaveLength(1);
    expect(n).toBeGreaterThanOrEqual(4);
    await loop.stop();
  });
});

describe('reads (P-TAIL-15, P-TAIL-41)', () => {
  it('one read in flight across all followers even with slow reads and poke spam', async () => {
    let inFlightPeak = 0;
    fs.readDelay = async () => {
      inFlightPeak = Math.max(inFlightPeak, fs.counters.readsInFlight);
      await clock.sleep(5);
    };
    fs.writeFile(MAIN, entry(1).repeat(50));
    for (let i = 0; i < 5; i++) fs.writeFile(`${PROJ}/${SID1}/subagents/agent-a${i}.jsonl`, entry(i).repeat(20));
    make({ readChunkBytes: 64 });
    tail.followMain(SID1, MAIN);
    for (let i = 0; i < 5; i++) tail.expectSubagent(SID1, `a${i}`);
    for (let i = 0; i < 40; i++) {
      tail.poke('spam');
      await clock.advance(3);
    }
    await clock.advance(20_000);
    expect(rec.lines()).toHaveLength(150);
    expect(fs.counters.maxReadsInFlight).toBe(1);
    expect(inFlightPeak).toBe(1);
  });

  it('skipParseTypes lines are never JSON.parsed (P-TAIL-14)', async () => {
    const spy = vi.spyOn(JSON, 'parse');
    fs.writeFile(MAIN, jl({ type: 'api-request-blob', b: 'x'.repeat(100_000) }) + jl({ type: 'api-request-shape', s: 1 }));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    expect(rec.lines(main1).map((l) => [l.type, l.json])).toEqual([
      ['api-request-blob', undefined],
      ['api-request-shape', undefined],
    ]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('fd slots (P-TAIL-16)', () => {
  it('waiting followers hold no fd and never evict anyone', async () => {
    make({ maxActiveFollowers: 2 });
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    for (let i = 0; i < 50; i++) tail.expectSubagent(SID1, `w${i}`);
    await clock.advance(2000);
    expect(fs.counters.openFds).toBe(1);
    expect(rec.states(main1)).toEqual(['waiting', 'active']);
    expect(rec.of('state').filter((e) => e.state === 'dormant')).toEqual([]);
  });

  it('the current main is never evicted; draining followers are evicted before live ones', async () => {
    make({ maxActiveFollowers: 3 });
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    const p = (a: string): string => `${PROJ}/${SID1}/subagents/agent-${a}.jsonl`;
    fs.writeFile(p('live'), entry(1));
    fs.writeFile(p('done'), entry(1));
    tail.expectSubagent(SID1, 'live');
    tail.expectSubagent(SID1, 'done');
    await clock.advance(10);
    tail.subagentStopped(SID1, 'done');
    await clock.advance(10);
    fs.writeFile(p('new'), entry(1));
    tail.expectSubagent(SID1, 'new');
    await clock.advance(10);
    expect(rec.states(sub('done')).at(-1)).toBe('dormant');
    expect(rec.states(sub('live')).at(-1)).toBe('active');
    expect(rec.states(main1).at(-1)).toBe('active');
    expect(fs.counters.openFds).toBe(3);
  });

  it('EMFILE is a non-fatal error; the follower opens once a descriptor is free', async () => {
    fs.maxOpenFiles = 0;
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    await clock.advance(600);
    expect(rec.of('error', main1)).toHaveLength(1); // reported once, not every poll
    expect(rec.of('error', main1)[0]).toMatchObject({ fatal: false });
    expect(rec.of('error', main1)[0]?.message).toContain('EMFILE');
    fs.maxOpenFiles = Infinity;
    await clock.advance(300);
    expect(rec.lines(main1)).toHaveLength(1);
  });
});

describe('draining and dormancy (P-TAIL-24, P-TAIL-35)', () => {
  it('growth extends the drain; quiet for drainGraceMs → dormant; growth while dormant reopens it', async () => {
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    tail.observePath(SID2, `${PROJ}/${SID2}.jsonl`, 'SessionStart');
    await clock.advance(4000);
    fs.appendFile(MAIN, entry(2));
    await clock.advance(4000); // 8 s after the switch, 4 s after growth: still draining
    expect(rec.states(main1).at(-1)).toBe('draining');
    await clock.advance(1500);
    expect(rec.states(main1).at(-1)).toBe('dormant');
    expect(fs.counters.openFds).toBe(0);
    fs.appendFile(MAIN, entry(3));
    await clock.advance(DORMANT_POLL_MS + 300);
    expect(rec.ns(main1)).toEqual([1, 2, 3]);
    expect(rec.of('opened', main1)).toHaveLength(2);
    expect(rec.of('opened', main1)[1]?.startOffset).toBe(Buffer.byteLength(entry(1) + entry(2)));
  });

  it('a partial line held at dormancy is re-read whole after reactivation (no torn-tail, no malformed)', async () => {
    fs.writeFile(MAIN, entry(1) + '{"type":"user","n":2');
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    tail.observePath(SID2, `${PROJ}/${SID2}.jsonl`, 'SessionStart');
    await clock.advance(6000);
    expect(rec.states(main1).at(-1)).toBe('dormant');
    await clock.advance(DORMANT_POLL_MS * 3);
    expect(rec.of('opened', main1)).toHaveLength(1); // no spurious reactivation for an unchanged partial line
    fs.appendFile(MAIN, '}\n');
    await clock.advance(DORMANT_POLL_MS + 300);
    expect(rec.ns(main1)).toEqual([1, 2]);
    expect(rec.of('malformed')).toEqual([]);
    expect(rec.of('torn-tail')).toEqual([]);
  });

  it('an old generation whose file never appeared is closed after the grace period', async () => {
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    tail.observePath(SID2, `${PROJ}/${SID2}.jsonl`, 'SessionStart');
    await clock.advance(DEFAULT_TAIL_TUNING.drainGraceMs + 300);
    expect(rec.states(main1)).toEqual(['waiting', 'closed']);
    expect(tail.checkpoint().files).toEqual([]);
  });

  it('observePath back to an old session on SessionStart makes it current again', async () => {
    fs.writeFile(MAIN, entry(1));
    const p2 = `${PROJ}/${SID2}.jsonl`;
    fs.writeFile(p2, entry(1));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    tail.observePath(SID2, p2, 'SessionStart');
    await clock.advance(10_000);
    expect(rec.states(main1).at(-1)).toBe('dormant');
    tail.observePath(SID1, MAIN, 'resume');
    await clock.advance(10);
    expect(rec.states(main1).at(-1)).toBe('active');
    expect(rec.states({ kind: 'main', sessionId: SID2 }).at(-1)).toBe('draining');
  });
});

describe('misc', () => {
  it('a path that is a directory is reported once as an error and keeps waiting', async () => {
    fs.mkdirp(MAIN);
    tail.followMain(SID1, MAIN);
    await clock.advance(1000);
    expect(rec.of('error', main1)).toHaveLength(1);
    expect(rec.states(main1)).toEqual(['waiting']);
  });

  it('rejects invalid options', () => {
    const f = createTranscriptTailFactory(fs);
    expect(() => f.create({ ...DEFAULT_TAIL_TUNING, configDir: CONFIG, clock, pollIdleMs: 0 })).toThrow(RangeError);
    expect(() => f.create({ ...DEFAULT_TAIL_TUNING, configDir: CONFIG, clock, drainGraceMs: -1 })).toThrow(RangeError);
  });

  it('calls after close() are no-ops; fileKeyId is stable', async () => {
    await tail.close();
    tail.followMain(SID1, MAIN);
    tail.observePath(SID1, MAIN, 'x');
    tail.expectSubagent(SID1, 'a');
    tail.subagentStopped(SID1, 'a');
    tail.poke();
    fs.writeFile(MAIN, entry(1));
    await clock.advance(1000);
    expect(rec.events).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
    expect(fileKeyId(main1)).toBe(`main:${SID1}`);
    expect(fileKeyId(sub('a'))).toBe(`sub:${SID1}:a`);
  });

  it('a checkpoint resumes at its offset when (dev, ino) still match', async () => {
    fs.writeFile(MAIN, entry(1) + entry(2));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    const cp = tail.checkpoint();
    await tail.close();
    fs.appendFile(MAIN, entry(3));
    make();
    tail.followMain(SID1, MAIN, { startAt: { checkpoint: cp } });
    await clock.advance(10);
    expect(rec.ns(main1)).toEqual([3]);
    expect(rec.lines(main1)[0]?.replay).toBe(false);
  });

  it('a stale checkpoint (inode changed) falls back to a replay from the beginning', async () => {
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    const cp = tail.checkpoint();
    await tail.close();
    fs.replaceFile(MAIN, entry(7) + entry(8));
    make();
    tail.followMain(SID1, MAIN, { startAt: { checkpoint: cp } });
    await clock.advance(10);
    expect(rec.ns(main1)).toEqual([7, 8]);
    expect(rec.lines(main1).every((l) => l.replay)).toBe(true);
  });

  it('readAtMono comes from the mono clock', async () => {
    fs.writeFile(MAIN, '');
    tail.followMain(SID1, MAIN);
    await clock.advance(1000);
    fs.appendFile(MAIN, entry(1));
    await clock.advance(300);
    expect(rec.lines(main1)[0]?.readAtMono).toBeGreaterThanOrEqual(1000);
  });
});

describe('failure paths (verifier additions)', () => {
  const eio = (): Error => Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });

  it("an I/O error while positioning (startAt:'end') leaks no fd or slot, is non-fatal, and recovers", async () => {
    fs.writeFile(MAIN, entry(1) + entry(2));
    let failing = true;
    fs.readDelay = () => (failing ? Promise.reject(eio()) : Promise.resolve());
    tail.followMain(SID1, MAIN, { startAt: 'end' });
    await clock.advance(2000); // ~8 failed attempts
    expect(fs.counters.openFds).toBe(0);
    expect(rec.of('error', main1)).toHaveLength(1); // deduped, not one per poll
    expect(rec.of('error', main1)[0]).toMatchObject({ fatal: false });
    expect(rec.of('error', main1)[0]?.message).toContain('EIO');
    expect(rec.of('opened', main1)).toEqual([]);
    failing = false;
    await clock.advance(300);
    expect(rec.of('opened', main1)[0]?.startOffset).toBe(Buffer.byteLength(entry(1) + entry(2)));
    expect(fs.counters.openFds).toBe(1);
    fs.appendFile(MAIN, entry(3));
    await clock.advance(300);
    expect(rec.ns(main1)).toEqual([3]);
  });

  it('a read error mid-follow is non-fatal and loses or duplicates no line', async () => {
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    let failing = true;
    fs.readDelay = () => (failing ? Promise.reject(eio()) : Promise.resolve());
    fs.appendFile(MAIN, entry(2));
    await clock.advance(1000);
    expect(rec.of('error', main1)).toHaveLength(1);
    failing = false;
    fs.appendFile(MAIN, entry(3));
    await clock.advance(300);
    expect(rec.ns(main1)).toEqual([1, 2, 3]);
    expect(rec.of('rewrite')).toEqual([]);
  });

  it('a reactivated follower whose file is gone never takes or evicts an fd slot, and re-dormants after its drain', async () => {
    make({ maxActiveFollowers: 2 });
    const p = (a: string): string => `${PROJ}/${SID1}/subagents/agent-${a}.jsonl`;
    fs.writeFile(MAIN, entry(1));
    fs.writeFile(p('b'), entry(1));
    tail.followMain(SID1, MAIN);
    tail.expectSubagent(SID1, 'b');
    await clock.advance(10);
    tail.subagentStopped(SID1, 'b');
    await clock.advance(DEFAULT_TAIL_TUNING.drainGraceMs + 300);
    expect(rec.states(sub('b')).at(-1)).toBe('dormant');
    fs.writeFile(p('a'), entry(1));
    tail.expectSubagent(SID1, 'a');
    await clock.advance(10);
    expect(rec.states(sub('a')).at(-1)).toBe('active');
    // b's file disappears, then a late hook makes b live again (reopen) and drains it
    fs.unlink(p('b'));
    tail.subagentStopped(SID1, 'b');
    for (let i = 0; i < 10; i++) {
      fs.appendFile(p('a'), entry(10 + i));
      await clock.advance(250);
    }
    expect(rec.states(sub('a'))).not.toContain('dormant'); // never evicted for a failing reopen
    expect(rec.ns(sub('a'))).toEqual([1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(rec.of('error')).toEqual([]);
    expect(fs.counters.openFds).toBe(2);
    await clock.advance(DEFAULT_TAIL_TUNING.drainGraceMs);
    expect(rec.states(sub('b')).at(-1)).toBe('dormant');
  });

  it('a dormant old-generation file that moved is found by the relocation scan and read at its new path', async () => {
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    tail.observePath(SID2, `${PROJ}/${SID2}.jsonl`, 'SessionStart');
    await clock.advance(DEFAULT_TAIL_TUNING.drainGraceMs + 300);
    expect(rec.states(main1).at(-1)).toBe('dormant');
    const moved = `${CONFIG}/projects/-elsewhere/${SID1}.jsonl`;
    fs.mkdirp(`${CONFIG}/projects/-elsewhere`);
    fs.rename(MAIN, moved);
    await clock.advance(DORMANT_POLL_MS + 2500); // dormant stat notices, then a 2 s scan locates it
    fs.appendFile(moved, entry(2));
    await clock.advance(DORMANT_POLL_MS * 2 + 300);
    expect(rec.ns(main1)).toEqual([1, 2]);
    expect(rec.of('moved', main1)[0]).toMatchObject({ from: MAIN, to: moved, sameInode: true });
    expect(rec.of('rewrite')).toEqual([]);
  });

  it('a directory proposed as the path of an open file is not a move; following continues on the real file', async () => {
    fs.writeFile(MAIN, entry(1));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    const dir = `${CONFIG}/projects/-dir/${SID1}.jsonl`;
    fs.mkdirp(dir);
    tail.observePath(SID1, dir, 'PostToolUse');
    await clock.advance(3000);
    fs.appendFile(MAIN, entry(2));
    await clock.advance(3000);
    expect(rec.of('moved')).toEqual([]);
    expect(rec.of('rewrite')).toEqual([]);
    expect(rec.ns(main1)).toEqual([1, 2]);
  });
});
