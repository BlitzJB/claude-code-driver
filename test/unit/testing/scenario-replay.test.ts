// testing/scenario.ts (core DSL), testing/replay.ts (trace parsing, obs-level replay, goldens), testing/core-config.ts.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Intent } from '../../../src/model/intents.js';
import { DEFAULT_TEST_CORE_CONFIG, testCoreConfig, testCoreInit } from '../../../src/testing/core-config.js';
import {
  compareGolden,
  goldenEventsText,
  normalizeEvents,
  parseTrace,
  replayObservations,
  serializeTrace,
  traceInputs,
  TraceFormatError,
  updateRequested,
} from '../../../src/testing/replay.js';
import { coreScenario, defaultSource, row, screenFacts } from '../../../src/testing/scenario.js';
import { toyCore } from './toy-core.js';

const tmp = mkdtempSync(join(tmpdir(), 'ccd-wp14-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('core-config', () => {
  it('defaults are the §4.10 values and deep-frozen; testCoreConfig merges one level', () => {
    expect(DEFAULT_TEST_CORE_CONFIG.timeouts).toMatchObject({
      startupHookGraceMs: 3000,
      readyStableMs: 300,
      submitAckMs: 3000,
      adoptDialogMs: 500,
      usageWakeCheckMs: 30_000,
    });
    expect(Object.isFrozen(DEFAULT_TEST_CORE_CONFIG.timeouts)).toBe(true);
    expect(DEFAULT_TEST_CORE_CONFIG.commands.allow).toContain('/usage');
    expect(DEFAULT_TEST_CORE_CONFIG.commands.allow).not.toContain('/cost');
    expect(DEFAULT_TEST_CORE_CONFIG.commands.aliases['/cost']).toBe('/usage');
    const c = testCoreConfig({ timeouts: { submitAckMs: 10 }, permissions: { policy: 'deny' } });
    expect(c.timeouts.submitAckMs).toBe(10);
    expect(c.timeouts.settleMs).toBe(100);
    expect(c.permissions).toMatchObject({ policy: 'deny', timeoutMs: 120_000 });
    c.timeouts.settleMs = 1;
    expect(DEFAULT_TEST_CORE_CONFIG.timeouts.settleMs).toBe(100);
    expect(testCoreInit({ resume: true }).resume).toBe(true);
  });
});

describe('scenario DSL', () => {
  it('stamps seq/at/source, keeps every step, and fires deadlines through ticks', () => {
    const s = coreScenario(toyCore);
    const r = s.obs('prompt.submitted', { promptId: 'p', text: 'hi' });
    expect(r.events.map((e) => e.type)).toEqual(['turn.queued']);
    const first = s.steps[0]?.input;
    expect(first?.type === 'obs' ? [first.obs.meta.seq, first.obs.meta.source, first.obs.meta.origin?.kind] : []).toEqual([
      1,
      'hook',
      'hook',
    ]);
    s.at(500).tick();
    expect(s.eventsOf('warning')).toHaveLength(0);
    s.runFor(600);
    expect(s.eventsOf('warning')).toHaveLength(1);
    expect(s.now).toBe(1000 + 500 + 600);
    expect(s.nextDeadlineTick()).toBeUndefined();
  });

  it('done()/ackInputs report input.done for the last step’s input intents', () => {
    const s = coreScenario(toyCore);
    s.obs('prompt.submitted', { promptId: 'p', text: 'hi' });
    const acks = s.ackInputs();
    expect(acks).toHaveLength(1);
    const last = s.steps.at(-1)?.input;
    expect(last?.type === 'obs' ? last.obs.kind : '').toBe('input.done');
    expect(last?.type === 'obs' && last.obs.kind === 'input.done' ? last.obs.p : undefined).toMatchObject({ primitive: 'key', ok: true });
    expect(s.primitives().map((p) => p.kind)).toEqual(['key']);
    const cmd = s.cmd({ type: 'interrupt' });
    expect(cmd.events).toEqual([]);
  });

  it('snapshotRestore round-trips (I7 helper); row() names table rows', () => {
    const s = coreScenario(toyCore);
    s.obs('prompt.submitted', { promptId: 'p', text: 'hi' });
    const before = JSON.stringify(s.core);
    s.snapshotRestore();
    expect(JSON.stringify(s.core)).toBe(before);
    expect(row('4.4', 7, 'Stop closes the turn')).toBe('§4.4#7 Stop closes the turn');
  });

  it('defaultSource maps kinds to their L1 channel; screenFacts builds a complete idle frame', () => {
    expect(defaultSource('tool.pre')).toBe('hook');
    expect(defaultSource('tool.result')).toBe('transcript');
    expect(defaultSource('screen.frame')).toBe('screen');
    expect(defaultSource('input.done')).toBe('self');
    expect(defaultSource('clock.tick')).toBe('clock');
    expect(defaultSource('process.exited')).toBe('process');
    expect(screenFacts({ surface: 'permissionDialog' })).toMatchObject({
      surface: 'permissionDialog',
      composer: { empty: true },
      torn: false,
    });
  });
});

function trace(records: unknown[]): string {
  const header = {
    r: 'header',
    format: 'ccd-trace',
    v: 1,
    lib: '0',
    claude: '2.1.316',
    tmux: '3.5a',
    node: 'v22',
    platform: 'darwin',
    startedWall: 0,
    tz: 'UTC',
    coreInit: testCoreInit(),
    profile: '2.1.316',
    redaction: 'none',
    hookTransport: 'http',
  };
  return [header, ...records].map((r) => JSON.stringify(r)).join('\n');
}

describe('replay', () => {
  const obs = (seq: number, at: number, kind: string, p: unknown) => ({
    r: 'obs',
    seq,
    obs: { kind, meta: { seq, at, wallAt: at, source: 'hook' }, p },
  });

  it('parseTrace validates header, kinds and monotonic numbering', () => {
    expect(() => parseTrace('')).toThrow(TraceFormatError);
    expect(() => parseTrace('{"r":"obs"}')).toThrow(/header/);
    expect(() => parseTrace(trace([obs(2, 1, 'clock.tick', {}), obs(2, 2, 'clock.tick', {})]))).toThrow(/obs.seq/);
    expect(() => parseTrace(trace([{ r: 'raw', i: 1, ch: 'bogus', at: 0, wallAt: 0, data: {} }]))).toThrow(/raw.ch/);
    expect(() => parseTrace(trace([{ r: 'nope' }]))).toThrow(/DebugRecord/);
    const bad = trace([]).replace('"tz":"UTC"', '"tz":""');
    expect(() => parseTrace(bad)).toThrow(/P-REV-35/);
    const t = parseTrace(
      trace([
        obs(1, 1000, 'prompt.submitted', { promptId: 'a', text: 'x' }),
        { r: 'cmd', cmdId: 1, at: 1001, wallAt: 1001, cmd: { type: 'interrupt' } },
      ]),
    );
    expect(traceInputs(t).map((i) => i.type)).toEqual(['obs', 'cmd']);
    expect(parseTrace(serializeTrace(t.records)).records).toHaveLength(3);
  });

  it('obs-level replay is deterministic and drains deadlines; goldens normalise wallAt and detect diffs', () => {
    const t = parseTrace(trace([obs(1, 1000, 'prompt.submitted', { promptId: 'a', text: 'x' })]));
    const a = replayObservations(t, toyCore, { drainMs: 2000 });
    const b = replayObservations(t, toyCore, { drainMs: 2000 });
    expect(a.events.map((e) => e.type)).toEqual(['turn.queued', 'warning']);
    expect(goldenEventsText(a.events)).toBe(goldenEventsText(b.events));
    expect(normalizeEvents(a.events).every((e) => e.wallAt === 0)).toBe(true);
    expect(compareGolden('toy', a, { root: tmp })).toMatchObject({ ok: false });
    expect(compareGolden('toy', a, { root: tmp, update: true })).toEqual({ ok: true, written: true });
    expect(compareGolden('toy', b, { root: tmp, update: false })).toEqual({ ok: true, written: false });
    expect(readFileSync(join(tmp, 'toy.events.jsonl'), 'utf8').split('\n')[0]).toContain('"wallAt":0');
    const c = replayObservations(t, toyCore, { drainMs: 0 });
    const diff = compareGolden('toy', c, { root: tmp, update: false });
    expect(diff.ok).toBe(false);
    expect(diff.diff?.[0]?.line).toBe(2);
  });

  it('updateRequested honours -u / --update / CCD_UPDATE_GOLDENS=1 only', () => {
    expect(updateRequested(['vitest', 'run'], {})).toBe(false);
    expect(updateRequested(['vitest', '-u'], {})).toBe(true);
    expect(updateRequested(['vitest', '--update'], {})).toBe(true);
    expect(updateRequested([], { CCD_UPDATE_GOLDENS: '1' })).toBe(true);
  });
});

describe('input primitive helpers', () => {
  it('intentsOf filters by kind', () => {
    const s = coreScenario(toyCore);
    s.obs('prompt.submitted', { promptId: 'p', text: 'x' });
    const input: Intent[] = s.intentsOf('input');
    expect(input).toHaveLength(1);
    expect(s.intentsOf('poll.cadence')).toEqual([]);
  });
});
