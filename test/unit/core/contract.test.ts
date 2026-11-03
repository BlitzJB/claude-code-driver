// The L2 core contract (DESIGN.md §2.9, §4.1, §4.2): the exports other packages (L3 session, testing kit, api selectors)
// rely on, their shapes, and the fact/lattice rules every decide module goes through.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DomainEvent } from '../../../src/model/events.js';
import type { ObsSeq } from '../../../src/model/ids.js';
import type { MonoMs } from '../../../src/model/time.js';
import { evolve } from '../../../src/core/evolve.js';
import { RANK, jsonEq, mergeFact, mkFact } from '../../../src/core/facts.js';
import { initialDomain } from '../../../src/core/init.js';
import type { CommandPhase, InputJob, InputPolicyState, SubmitPhase } from '../../../src/core/input-policy/jobs.js';
import { applyStatus } from '../../../src/core/lattice.js';
import { canSubmit, currentTurn, displayToolState, isQuiescent, pendingPermissions } from '../../../src/core/selectors.js';
import { deserializeCore, initialCore, nextDeadline, serializeCore, step, stepDetailed } from '../../../src/core/step.js';
import type { CoreInit, CoreInput, CoreState, Counters, Diagnostic, NextDeadline, ReconState, StepResult } from '../../../src/core/step.js';
import { readyHarness, sendUntilEnter, testInit, ups } from './harness.js';

const at = (n: number) => n as MonoMs;
const seq = (n: number) => n as ObsSeq;

describe('§2.9 API surface', () => {
  it('initialCore(init) builds a preflight core with zeroed counters and the config recorded', () => {
    const init: CoreInit = testInit();
    const c: CoreState = initialCore(init);
    expect(c.domain.lifecycle).toBe('preflight');
    expect(c.domain.sessionKey).toBe(init.sessionKey);
    expect(c.config).toBe(init.config);
    expectTypeOf(c.counters).toEqualTypeOf<Counters>();
    expectTypeOf(c.recon).toEqualTypeOf<ReconState>();
    expectTypeOf(c.input).toEqualTypeOf<InputPolicyState>();
    expect(Object.values(c.counters).every((v) => v === 0)).toBe(true);
    expect(initialDomain(init)).toEqual(c.domain);
  });

  it('step(core, input) returns {core, events, intents, diagnostics, commandResult?} and never mutates its input', () => {
    const c = initialCore(testInit());
    const frozen = JSON.stringify(c);
    const input: CoreInput = { type: 'cmd', cmdId: 7, cmd: { type: 'interrupt' }, at: at(5), wallAt: c.wallNow };
    const r: StepResult = step(c, input);
    expectTypeOf(r.diagnostics).toEqualTypeOf<Diagnostic[]>();
    expect(JSON.stringify(c)).toBe(frozen);
    expect(r.core.now).toBe(5);
    expect(r.commandResult).toEqual({ cmdId: 7, ok: true, value: {} });
    expect(r.events.map((e) => e.type)).toEqual(['interrupt.ignored']);
    expect(r.events[0]).toMatchObject({ v: 1, seq: 1, sessionKey: c.domain.sessionKey, causedBy: [] });
    expect(stepDetailed(c, input).coreEvents.length).toBeGreaterThanOrEqual(r.events.length);
  });

  it('time is monotone: an input from the past never moves now backwards', () => {
    const c = step(initialCore(testInit()), {
      type: 'cmd',
      cmdId: 1,
      cmd: { type: 'usage.wakeNow' },
      at: at(100),
      wallAt: initialCore(testInit()).wallNow,
    }).core;
    const r = step(c, { type: 'cmd', cmdId: 2, cmd: { type: 'usage.wakeNow' }, at: at(50), wallAt: c.wallNow });
    expect(r.core.now).toBe(100);
  });

  it('nextDeadline: mono and wall separately (NextDeadline)', () => {
    const h = readyHarness();
    const n: NextDeadline = nextDeadline(h.core);
    expect(n.atWall).toBeUndefined();
    sendUntilEnter(h, 'x');
    expect(nextDeadline(h.core).atMono).toBeGreaterThan(h.now);
  });

  it('evolve is the only writer: published events fold into lastEventSeq/status; the domain snapshot is never mutated', () => {
    const h = readyHarness();
    const before = JSON.stringify(h.d);
    const e = h.events.find((x): x is Extract<DomainEvent, { type: 'status.changed' }> => x.type === 'status.changed');
    expect(e).toBeDefined();
    if (e === undefined) return;
    const d2 = evolve(h.d, { ...e, seq: 999 as never });
    expect(d2.lastEventSeq).toBe(999);
    expect(JSON.stringify(h.d)).toBe(before);
  });

  it('serializeCore/deserializeCore round-trip to an equal core', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'snap');
    const back = deserializeCore(serializeCore(h.core));
    expect(JSON.stringify(back)).toBe(JSON.stringify(h.core));
  });

  it('selectors used by the api facade', () => {
    const h = readyHarness();
    expect(canSubmit(h.core)).toBe(true);
    expect(currentTurn(h.d)).toBeUndefined();
    sendUntilEnter(h, 'x');
    ups(h, 'x', 'p1');
    expect(currentTurn(h.d)?.key).toBe('t1');
    expect(isQuiescent(h.d)).toBe(false);
    expect(pendingPermissions(h.d)).toEqual([]);
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Read', input: {} }, 'PreToolUse');
    const t = h.d.tools['u1' as never];
    expect(t !== undefined && displayToolState(t, at((t.preAt ?? 0) + 500))).toBe('running');
  });

  it('job phase types are the §2.9 ones', () => {
    expectTypeOf<SubmitPhase>().toEqualTypeOf<
      'waitGate' | 'staging' | 'editorOpen' | 'verifyStaged' | 'settle' | 'enterSent' | 'awaitAck' | 'retryEnter' | 'done' | 'failed'
    >();
    expectTypeOf<CommandPhase>().toEqualTypeOf<
      'waitGate' | 'staging' | 'settle' | 'enterSent' | 'awaitEffect' | 'captureModal' | 'dismissModal' | 'done' | 'failed'
    >();
    expectTypeOf<InputJob['kind']>().toEqualTypeOf<
      'submit' | 'selftest' | 'command' | 'interrupt' | 'clearComposer' | 'permissionKeys' | 'setMode' | 'wakeEnter' | 'dismissMenu'
    >();
    expect(true).toBe(true);
  });
});

describe('§4.1 authority and mergeFact (RC §4.1)', () => {
  it('RANK order: process > hook > transcript > network > registry > screen > self = clock = channel', () => {
    expect(RANK).toEqual({ self: 0, clock: 0, channel: 0, screen: 1, registry: 2, network: 3, transcript: 4, hook: 5, process: 6 });
  });
  it('same value corroborates and upgrades provisional → confirmed when a higher source agrees', () => {
    const cur = mkFact('plan', 'screen', seq(1), at(1), true);
    const r = mergeFact(cur, 'plan', 'hook', seq(2), at(2), RANK.transcript);
    expect(r).toMatchObject({ changed: false, corroborated: true, fact: { value: 'plan', provisional: false, src: 'hook' } });
  });
  it('a different value replaces only with a higher rank or same rank and newer seq; a confirmed replacement is a conflict', () => {
    const cur = mkFact('a', 'transcript', seq(5), at(1));
    expect(mergeFact(cur, 'b', 'screen', seq(6), at(2), 0)).toMatchObject({ changed: false, conflict: 'screen<transcript' });
    expect(mergeFact(cur, 'b', 'hook', seq(6), at(2), 0)).toMatchObject({
      changed: true,
      conflict: 'transcript->hook',
      fact: { value: 'b' },
    });
    expect(mergeFact(cur, 'b', 'transcript', seq(7), at(2), 0)).toMatchObject({ changed: true });
    expect(mergeFact(cur, 'b', 'transcript', seq(4), at(2), 0)).toMatchObject({ changed: false });
    expect(jsonEq({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
});

describe('§4.2 lattices (applyStatus)', () => {
  it('forward moves apply, backward moves are ignored', () => {
    const f = mkFact('running' as const, 'hook', seq(1), at(1));
    expect(applyStatus('turn', f, 'completed', 'hook', seq(2), at(2)).verdict).toBe('apply');
    expect(applyStatus('turn', mkFact('completed' as const, 'hook', seq(1), at(1)), 'running', 'hook', seq(2), at(2)).verdict).toBe(
      'ignore',
    );
    expect(applyStatus('tool', mkFact('succeeded' as const, 'hook', seq(1), at(1)), 'pending', 'hook', seq(2), at(2)).verdict).toBe(
      'ignore',
    );
  });
  it('unknown → concrete terminal is resolvedLate; provisional terminal + higher-rank contradiction is retract', () => {
    expect(
      applyStatus('turn', mkFact('unknown' as const, 'process', seq(1), at(1)), 'interrupted', 'transcript', seq(2), at(2)).verdict,
    ).toBe('resolvedLate');
    expect(
      applyStatus('turn', mkFact('interrupted' as const, 'screen', seq(1), at(1), true), 'completed', 'hook', seq(2), at(2)).verdict,
    ).toBe('retract');
    expect(
      applyStatus('turn', mkFact('interrupted' as const, 'transcript', seq(1), at(1)), 'completed', 'hook', seq(2), at(2)).verdict,
    ).toBe('ignore');
  });
  it('call states of order 1 are mutually updatable', () => {
    expect(applyStatus('call', mkFact('retrying' as const, 'screen', seq(1), at(1)), 'streaming', 'network', seq(2), at(2)).verdict).toBe(
      'apply',
    );
    expect(applyStatus('call', mkFact('ended' as const, 'transcript', seq(1), at(1)), 'streaming', 'network', seq(2), at(2)).verdict).toBe(
      'ignore',
    );
  });
  it('agent stopped → running is not a lattice move (only an explicit resume)', () => {
    expect(applyStatus('agent', mkFact('stopped' as const, 'hook', seq(1), at(1)), 'running', 'hook', seq(2), at(2)).verdict).toBe(
      'ignore',
    );
  });
});
