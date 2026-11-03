// discovery.ts helpers + their use by the tail (DESIGN.md §5.3: P-TAIL-26, P-TAIL-27, P-TAIL-31, P-TAIL-32, P-TAIL-33,
// P-TAIL-35; §5.12 P-TX-05).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileKey, TranscriptTail } from '../../../src/platform/ports.js';
import {
  agentIdOfFileName,
  expectedSubagentPath,
  findMainByFirstPrompt,
  isIgnoredName,
  isSessionFileName,
  locateMainBySessionId,
  locateSubagent,
  readFirstPrompt,
  rebaseUnderSession,
  scanSubagents,
  slugPrefixOf,
  subagentDir,
} from '../../../src/platform/fs-tail/discovery.js';
import { FakeTailFs } from '../../../src/platform/fs-tail/fake-tail-fs.js';
import { createTranscriptTailFactory, DEFAULT_TAIL_TUNING } from '../../../src/platform/fs-tail/tail.js';
import { entry, jl, ManualClock, Recorder, SID1, SID2 } from '../../contract/tail.contract.js';

const CONFIG = '/home/user/.claude';
const PROJ = `${CONFIG}/projects/-repo`;
const MAIN = `${PROJ}/${SID1}.jsonl`;
let fs: FakeTailFs;

beforeEach(() => {
  fs = new FakeTailFs();
  fs.mkdirp(PROJ);
});

describe('names (P-TAIL-26, P-TAIL-31)', () => {
  it('only <uuid>.jsonl is a session file; superseded / compact tmp / memory / meta are ignored', () => {
    expect(isSessionFileName(`${SID1}.jsonl`)).toBe(true);
    expect(isSessionFileName(`${SID1}.jsonl.superseded-1700000000000`)).toBe(false);
    expect(isSessionFileName(`${SID1}.jsonl.compact.tmp.0a1b2c3d`)).toBe(false);
    expect(isSessionFileName('notes.jsonl')).toBe(false);
    expect(isSessionFileName(`${SID2.toUpperCase()}.jsonl`)).toBe(false);
    expect(isIgnoredName('memory')).toBe(true);
    expect(isIgnoredName('agent-a1.meta.json')).toBe(true);
    expect(isIgnoredName('.DS_Store')).toBe(true);
    expect(agentIdOfFileName('agent-a1028a887bdb3ce93.jsonl')).toBe('a1028a887bdb3ce93');
    expect(agentIdOfFileName('agent-a1.meta.json')).toBeUndefined();
    expect(agentIdOfFileName('journal.jsonl')).toBeUndefined();
  });

  it('path rules: subagent dir, expected path, slug prefix, rebase under <sid>/', () => {
    expect(subagentDir(MAIN, SID1)).toBe(`${PROJ}/${SID1}/subagents`);
    expect(expectedSubagentPath(MAIN, SID1, 'a1')).toBe(`${PROJ}/${SID1}/subagents/agent-a1.jsonl`);
    const long = '-' + 'x'.repeat(250);
    expect(slugPrefixOf(`${CONFIG}/projects/${long}/${SID1}.jsonl`)).toBe(long.slice(0, 200));
    const newMain = `${CONFIG}/projects/-other/${SID1}.jsonl`;
    expect(rebaseUnderSession(`${PROJ}/${SID1}/subagents/agent-a.jsonl`, MAIN, newMain, SID1)).toBe(
      `${CONFIG}/projects/-other/${SID1}/subagents/agent-a.jsonl`,
    );
    expect(rebaseUnderSession(`/elsewhere/agent-a.jsonl`, MAIN, newMain, SID1)).toBeUndefined();
  });
});

describe('subagent discovery (P-TAIL-32, P-TAIL-33)', () => {
  it('scanSubagents lists regular agent files in subagents/ and workflows/*/, skipping symlinks and meta files', async () => {
    const dir = subagentDir(MAIN, SID1);
    fs.writeFile(`${dir}/agent-a1.jsonl`, entry(1));
    fs.writeFile(`${dir}/agent-a1.meta.json`, '{}');
    fs.writeFile(`${dir}/workflows/wf-1/agent-w1.jsonl`, entry(1));
    fs.writeFile(`${dir}/workflows/wf-1/journal.jsonl`, jl({ type: 'launched' }));
    fs.symlink(`${dir}/agent-a1.jsonl`, `${dir}/agent-link.jsonl`);
    const found = await scanSubagents(fs, MAIN, SID1);
    expect(found).toEqual([
      { agentId: 'a1', path: `${dir}/agent-a1.jsonl` },
      { agentId: 'w1', path: `${dir}/workflows/wf-1/agent-w1.jsonl` },
    ]);
    expect(await scanSubagents(fs, `${CONFIG}/projects/-none/${SID2}.jsonl`, SID2)).toEqual([]);
  });

  it('locateSubagent prefers the default path, else searches workflows/*', async () => {
    const dir = subagentDir(MAIN, SID1);
    expect(await locateSubagent(fs, MAIN, SID1, 'w1')).toBeUndefined();
    fs.writeFile(`${dir}/workflows/wf-9/agent-w1.jsonl`, entry(1));
    expect(await locateSubagent(fs, MAIN, SID1, 'w1')).toBe(`${dir}/workflows/wf-9/agent-w1.jsonl`);
    fs.writeFile(`${dir}/agent-w1.jsonl`, entry(1));
    expect(await locateSubagent(fs, MAIN, SID1, 'w1')).toBe(`${dir}/agent-w1.jsonl`);
  });
});

describe('main file discovery (P-TX-05, P-TAIL-27)', () => {
  it('locateMainBySessionId finds projects/*/<sid>.jsonl, optionally limited to a slug prefix', async () => {
    const long = '-' + 'y'.repeat(240);
    const hashed = `${long.slice(0, 200)}-1k3j9x`;
    fs.writeFile(`${CONFIG}/projects/${hashed}/${SID1}.jsonl`, entry(1));
    fs.writeFile(`${CONFIG}/projects/-unrelated/${SID2}.jsonl`, entry(1));
    expect(await locateMainBySessionId(fs, CONFIG, SID1)).toEqual([`${CONFIG}/projects/${hashed}/${SID1}.jsonl`]);
    expect(await locateMainBySessionId(fs, CONFIG, SID1, { slugPrefix: long.slice(0, 200) })).toHaveLength(1);
    expect(await locateMainBySessionId(fs, CONFIG, SID1, { slugPrefix: '-nope' })).toEqual([]);
    expect(await locateMainBySessionId(fs, CONFIG, 'not-a-uuid')).toEqual([]);
    expect(await locateMainBySessionId(fs, '/no/such/config', SID1)).toEqual([]);
  });

  it('the tail follows a hash-suffixed slug file when the computed (unsuffixed) path never appears', async () => {
    const clock = new ManualClock();
    const tail = createTranscriptTailFactory(fs).create({ ...DEFAULT_TAIL_TUNING, configDir: CONFIG, clock });
    const rec = new Recorder(tail);
    const long = '-' + 'z'.repeat(230);
    const expected = `${CONFIG}/projects/${long}/${SID1}.jsonl`;
    const real = `${CONFIG}/projects/${long.slice(0, 200)}-abc123/${SID1}.jsonl`;
    tail.followMain(SID1, expected);
    fs.writeFile(real, entry(1));
    await clock.advance(5000);
    const main1: FileKey = { kind: 'main', sessionId: SID1 };
    expect(rec.of('opened', main1)[0]?.path).toBe(real);
    expect(rec.ns(main1)).toEqual([1]);
    await tail.close();
  });

  it('findMainByFirstPrompt accepts exactly one file whose first real user prompt matches (P-TAIL-27)', async () => {
    const meta = jl({ type: 'user', isMeta: true, message: { role: 'user', content: 'ccd-selftest prompt' } });
    const userStr = (t: string): string => jl({ type: 'user', message: { role: 'user', content: t } });
    const userArr = (t: string): string => jl({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
    const a = `${PROJ}/${SID1}.jsonl`;
    const b = `${PROJ}/${SID2}.jsonl`;
    fs.writeFile(a, jl({ type: 'mode', mode: 'default' }) + meta + userStr('  build the thing  ') + userStr('later'));
    fs.writeFile(b, userArr('something else'));
    fs.writeFile(`${PROJ}/${SID1}.jsonl.superseded-1`, userStr('build the thing'));
    expect(await readFirstPrompt(fs, a)).toBe('  build the thing  ');
    expect(await readFirstPrompt(fs, b)).toBe('something else');
    expect(await findMainByFirstPrompt(fs, PROJ, 'build the thing')).toEqual({ path: a, sessionId: SID1 });
    expect(await findMainByFirstPrompt(fs, PROJ, 'build the thing', { exclude: new Set([a]) })).toBeUndefined();
    expect(await findMainByFirstPrompt(fs, PROJ, 'nothing typed')).toBeUndefined();
    expect(await findMainByFirstPrompt(fs, PROJ, '   ')).toBeUndefined();
    // ambiguous: another session in the same cwd typed the same text
    const c = `${PROJ}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl`;
    fs.writeFile(c, userArr('build the thing'));
    expect(await findMainByFirstPrompt(fs, PROJ, 'build the thing')).toBeUndefined();
  });

  it('readFirstPrompt never parses an incomplete last line and tolerates a missing file', async () => {
    fs.writeFile(MAIN, '{"type":"user","message":{"content":"partial"}}');
    expect(await readFirstPrompt(fs, MAIN)).toBeUndefined();
    expect(await readFirstPrompt(fs, `${PROJ}/missing.jsonl`)).toBeUndefined();
  });
});

describe('tail lifetime of subagents (P-TAIL-31, P-TAIL-35)', () => {
  let clock: ManualClock;
  let tail: TranscriptTail;
  let rec: Recorder;
  const a1: FileKey = { kind: 'subagent', sessionId: SID1, agentId: 'a1' };
  const p1 = `${PROJ}/${SID1}/subagents/agent-a1.jsonl`;
  beforeEach(() => {
    clock = new ManualClock();
    tail = createTranscriptTailFactory(fs).create({ ...DEFAULT_TAIL_TUNING, configDir: CONFIG, clock });
    rec = new Recorder(tail);
  });
  afterEach(async () => {
    await tail.close();
  });

  it('a stopped agent drains then goes dormant; a new SubagentStart reactivates it (background agent resumed)', async () => {
    fs.writeFile(MAIN, entry(0));
    tail.followMain(SID1, MAIN);
    tail.expectSubagent(SID1, 'a1');
    fs.writeFile(p1, entry(1));
    await clock.advance(300);
    tail.subagentStopped(SID1, 'a1', p1);
    fs.writeFile(`${PROJ}/${SID1}/subagents/agent-a1.meta.json`, '{"finished":true}');
    await clock.advance(6000);
    expect(rec.states(a1)).toEqual(['waiting', 'active', 'draining', 'dormant']);
    tail.expectSubagent(SID1, 'a1');
    fs.appendFile(p1, entry(2));
    await clock.advance(300);
    expect(rec.states(a1).at(-1)).toBe('active');
    expect(rec.ns(a1)).toEqual([1, 2]);
    // the meta file is never followed as a transcript
    expect(rec.of('opened').map((e) => e.path)).not.toContain(`${PROJ}/${SID1}/subagents/agent-a1.meta.json`);
  });

  it('subagentStopped before the file exists: authoritative path, `missing` 10 s after the stop', async () => {
    fs.writeFile(MAIN, entry(0));
    tail.followMain(SID1, MAIN);
    await clock.advance(10);
    tail.subagentStopped(SID1, 'gone', `${PROJ}/${SID1}/subagents/agent-gone.jsonl`);
    await clock.advance(9000);
    expect(rec.of('missing')).toEqual([]);
    await clock.advance(1500);
    expect(rec.of('missing')).toHaveLength(1);
  });

  it('expectSubagent before the main path is known waits for it, then uses the default path', async () => {
    tail.expectSubagent(SID1, 'early');
    await clock.advance(300);
    tail.followMain(SID1, MAIN);
    fs.writeFile(MAIN, entry(0));
    fs.writeFile(`${PROJ}/${SID1}/subagents/agent-early.jsonl`, entry(5));
    await clock.advance(300);
    expect(rec.ns({ kind: 'subagent', sessionId: SID1, agentId: 'early' })).toEqual([5]);
  });
});
