import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  compareWithGolden,
  explainEvent,
  formatExplanation,
  parseGolden,
  parseKinds,
  parseTrace,
  replayTrace,
  summarizeTrace,
  TraceError,
} from '../../../src/cli/trace.js';

const header = {
  r: 'header',
  format: 'ccd-trace',
  v: 1,
  lib: '0.0.0',
  claude: '2.1.316',
  tmux: '3.5a',
  node: 'v22',
  platform: 'darwin',
  startedWall: 0,
  tz: 'UTC',
  coreInit: {},
  profile: '2.1.316',
  redaction: 'meta',
  hookTransport: 'http',
};
const raw = { r: 'raw', i: 7, ch: 'hook', at: 100, wallAt: 1000, data: { event: 'Stop' } };
const obs = {
  r: 'obs',
  seq: 3,
  rawRef: 7,
  obs: { kind: 'turn.stop', meta: { seq: 3, at: 100, wallAt: 1000, source: 'hook' }, p: { x: 1 } },
};
const obs2 = { r: 'obs', seq: 4, obs: { kind: 'screen.facts', meta: { seq: 4, at: 120, wallAt: 1020, source: 'screen' }, p: {} } };
const ev = (seq: number, type: string, causedBy: number[], at = 101) => ({
  r: 'event',
  e: {
    v: 1,
    seq,
    type,
    at,
    wallAt: 1001 + seq,
    sessionKey: 's1',
    turnKey: 't1',
    provenance: { confirmed: true, sources: ['hook'] },
    causedBy,
    payload: { p: seq },
  },
});
const step = { r: 'step', inSeq: 3, events: [10, 11], intents: [{ kind: 'tail.poke', id: 5, reason: 'stop' }], durUs: 42 };
const effect = { r: 'effect', intentId: 5, at: 102, durMs: 1, ok: true };
const otherEffect = { r: 'effect', intentId: 99, at: 103, durMs: 1, ok: false, error: 'x' };
const cmd = { r: 'cmd', cmdId: 1, at: 50, wallAt: 950, cmd: { kind: 'send' } };
const diag = { r: 'diag', at: 130, code: 'loop.lag', detail: { ms: 300 } };
const drop = { r: 'drop', count: 2, reason: 'backpressure' };

const lines = [
  header,
  cmd,
  raw,
  obs,
  step,
  ev(10, 'turn.completed', [3]),
  ev(11, 'session.idle', [3, 4]),
  effect,
  otherEffect,
  obs2,
  diag,
  drop,
];
const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n{not json\n{"r":"bogus"}\n';

describe('parseTrace', () => {
  it('keeps valid records and reports malformed lines by number', () => {
    const t = parseTrace(text);
    expect(t.records).toHaveLength(lines.length);
    expect(t.malformed).toEqual([
      { line: lines.length + 1, reason: 'invalid JSON' },
      { line: lines.length + 2, reason: 'unknown record kind "bogus"' },
    ]);
  });
  it.each([
    [{ r: 'header', format: 'x', v: 1 }, 'header is not ccd-trace v1'],
    [{ r: 'raw', i: 1, at: 1 }, 'raw needs i, ch, at'],
    [{ r: 'obs', seq: 1, obs: {} }, 'obs needs seq, obs.kind'],
    [{ r: 'event', e: { seq: 1 } }, 'event needs e.seq, e.type'],
    [{ r: 'step', inSeq: 1, events: [] }, 'step needs inSeq, events[], intents[]'],
    [{ r: 'cmd', cmdId: 'x' }, 'cmd needs cmdId, cmd'],
    [{ r: 'effect', intentId: 1 }, 'effect needs intentId, ok'],
    [{ r: 'diag' }, 'diag needs code'],
    [{ r: 'drop' }, 'drop needs count'],
    [[1], 'not an object'],
  ])('rejects %j', (v, reason) => {
    expect(parseTrace(JSON.stringify(v)).malformed).toEqual([{ line: 1, reason }]);
  });
});

describe('replay', () => {
  it('prints every record in order plus a summary', () => {
    const r = replayTrace(parseTrace(text));
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toMatch(/^header lib=0\.0\.0 claude=2\.1\.316 tmux=3\.5a/);
    expect(r.lines.findIndex((l) => l.includes('event#10 turn.completed t1'))).toBeGreaterThan(
      r.lines.findIndex((l) => l.startsWith('step in obs#3')),
    );
    expect(r.lines.some((l) => l.includes('effect intent#99 FAILED x'))).toBe(true);
    expect(r.lines.some((l) => l === 'drop 2 (backpressure)')).toBe(true);
    expect(r.lines.some((l) => l.startsWith('malformed line'))).toBe(true);
    expect(r.summary).toMatchObject({
      counts: { header: 1, cmd: 1, raw: 1, obs: 2, step: 1, event: 2, effect: 2, diag: 1, drop: 1 },
      rawByChannel: { hook: 1 },
      eventTypes: { 'turn.completed': 1, 'session.idle': 1 },
      monoSpanMs: 80,
      dropped: 2,
      malformed: 2,
      header: { tz: 'UTC', redaction: 'meta', hookTransport: 'http' },
    });
  });
  it('filters by kind', () => {
    const r = replayTrace(parseTrace(text), { kinds: parseKinds('event') });
    expect(r.lines.filter((l) => l.includes('event#'))).toHaveLength(2);
    expect(r.lines.some((l) => l.includes(' obs#'))).toBe(false);
    expect(() => parseKinds('event,nope')).toThrow(TraceError);
  });
  it('golden match / mismatch (wallAt normalised, key order irrelevant)', () => {
    const t = parseTrace(text);
    const events = t.records.flatMap((r) => (r.r === 'event' ? [r.e] : []));
    const golden = events.map((e) => JSON.stringify({ r: 'event', e: { ...e, wallAt: 0 } })).join('\n');
    expect(replayTrace(t, { golden }).golden).toEqual({ ok: true, compared: 2 });
    // bare events and reordered keys are accepted
    const bare = events.map((e) => JSON.stringify(Object.fromEntries(Object.entries({ ...e, wallAt: 999 }).reverse()))).join('\n');
    expect(compareWithGolden(events, bare).ok).toBe(true);
    const bad = replayTrace(t, { golden: golden.split('\n')[0] ?? '' });
    expect(bad.exitCode).toBe(1);
    expect(bad.golden?.firstMismatch?.index).toBe(1);
    expect(bad.golden?.firstMismatch?.expected).toBeUndefined();
    expect(bad.lines.some((l) => l.startsWith('golden MISMATCH at event index 1'))).toBe(true);
    expect(() => parseGolden('{')).toThrow(TraceError);
    expect(() => parseGolden('3')).toThrow(TraceError);
  });
});

describe('explain (AL §8.3)', () => {
  it('raw → obs → step → event → effects', () => {
    const x = explainEvent(parseTrace(text), 11);
    expect(x.event.type).toBe('session.idle');
    expect(x.observations.map((o) => [o.seq, o.record?.obs.kind, o.raw?.i])).toEqual([
      [3, 'turn.stop', 7],
      [4, 'screen.facts', undefined],
    ]);
    expect(x.step?.inSeq).toBe(3);
    expect(x.stepInput?.r).toBe('obs');
    expect(x.siblings).toEqual([10]);
    expect(x.effects).toEqual([effect]);
    const s = formatExplanation(x);
    expect(s).toContain('event #11 session.idle at 101 turn t1');
    expect(s).toContain('← @100 obs#3 turn.stop [hook] ←raw#7');
    expect(s).toContain('← @100 raw#7 hook');
    expect(s).toContain('intent tail.poke#5');
    expect(s).toContain('effect intent#5 ok');
    expect(s).toContain('same step also emitted events [10]');
  });
  it('a command-driven step (kernel writes inSeq = -cmdId) resolves to the cmd record, never to an obs with the same number', () => {
    const cmdStep = { r: 'step', inSeq: -3, events: [30], intents: [], durUs: 1 };
    const cmd3 = { r: 'cmd', cmdId: 3, at: 60, wallAt: 960, cmd: { kind: 'interrupt' } };
    // obs#3 exists too: a naive lookup by |inSeq| or by inSeq in both maps would pick the wrong record
    const t = parseTrace([header, obs, cmd3, cmdStep, ev(30, 'turn.interrupted', [])].map((l) => JSON.stringify(l)).join('\n'));
    const x = explainEvent(t, 30);
    expect(x.stepInput).toEqual(cmd3);
    const s = formatExplanation(x);
    expect(s).toContain('emitted by step in cmd#3 → events [30]');
    expect(s).toContain('input: @60 cmd#3');
    // an obs-driven step with inSeq 3 still resolves to obs#3, not cmd#3
    const t2 = parseTrace([header, obs, cmd3, step, ev(10, 'turn.completed', [3])].map((l) => JSON.stringify(l)).join('\n'));
    expect(explainEvent(t2, 10).stepInput).toEqual(obs);
    // a step whose input is not in the trace has no stepInput
    const t3 = parseTrace([header, { ...cmdStep, inSeq: -9 }, ev(30, 'x', [])].map((l) => JSON.stringify(l)).join('\n'));
    expect(explainEvent(t3, 30).stepInput).toBeUndefined();
  });

  it('missing pieces are named, not hidden', () => {
    const t = parseTrace(
      [header, { ...ev(20, 'x', [77]) }, { r: 'obs', seq: 78, rawRef: 5, obs: obs.obs }, ev(21, 'y', [78]), ev(22, 'z', [])]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    expect(formatExplanation(explainEvent(t, 20))).toContain('obs#77 (not in the trace)');
    expect(formatExplanation(explainEvent(t, 21))).toContain("raw#5 (not in the trace; raw:'meta' redaction?)");
    const z = formatExplanation(explainEvent(t, 22));
    expect(z).toContain('no observations; a deadline or command');
    expect(z).toContain('no step record emitted this event');
    expect(() => explainEvent(t, 999)).toThrow(TraceError);
  });
});

describe('real fixtures', () => {
  const dir = join(process.cwd(), 'fixtures', 'traces');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ccd.jsonl'));
  it('every committed trace parses without malformed lines', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const t = parseTrace(readFileSync(join(dir, f), 'utf8'));
      expect(t.malformed, f).toEqual([]);
      expect(summarizeTrace(t).header?.claude, f).toBe('2.1.316');
    }
  });
});
