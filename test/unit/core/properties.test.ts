// core — property tests for invariants I1–I7 (DESIGN.md §2.9) and the §6.2 robustness properties: permutation
// convergence (deadline-free pairs, rev 2 §10 D2), duplicate injection, channel dropout, delay injection, deadline
// jitter, snapshot/restore (P-REC-10/11/19/20/43, P-TMUX-54).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Command } from '../../../src/model/commands.js';
import type { CoreEvent } from '../../../src/model/events.js';
import type { HookSeq, ObsSeq } from '../../../src/model/ids.js';
import type { Intent } from '../../../src/model/intents.js';
import type { Observation, ObsMeta, Source } from '../../../src/model/observation.js';
import type { ScreenFacts } from '../../../src/model/screen-facts.js';
import type { SessionState } from '../../../src/model/state.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { permissionHeld } from '../../../src/core/ctx.js';
import { foldEvents } from '../../../src/core/evolve.js';
import { initialCore, initialDomain } from '../../../src/core/init.js';
import { isToolTerminal, isTurnTerminal } from '../../../src/core/lattice.js';
import { deserializeCore, serializeCore, step, stepDetailed } from '../../../src/core/step.js';
import type { CoreInput, CoreState } from '../../../src/core/types.js';
import { SESSION_ID, WALL0, busyFrame, composerFrame, frame, idleFrame, testConfig, testInit } from './harness.js';

// ------------------------------------------------------------------ a tiny scenario language
type Act =
  | { a: 'ups'; text: number; promptId: number }
  | { a: 'stop'; active: boolean }
  | { a: 'stopFailure'; error: number }
  | { a: 'pre'; tool: number; agent: number }
  | { a: 'post'; tool: number; agent: number }
  | { a: 'fail'; tool: number }
  | { a: 'perm'; tool: number }
  | { a: 'answer'; perm: number; allow: boolean }
  | { a: 'subStart'; agent: number }
  | { a: 'subStop'; agent: number }
  | { a: 'delta'; msg: number; final: boolean }
  | { a: 'txResult'; tool: number; kind: number }
  | { a: 'txInterrupt' }
  | { a: 'txDuration' }
  | { a: 'txRecorded'; text: number; promptId: number }
  | { a: 'frame'; kind: number }
  | { a: 'send'; text: number }
  | { a: 'interrupt' }
  | { a: 'slash'; name: number }
  | { a: 'done'; ok: boolean }
  | { a: 'tick'; ms: number }
  | { a: 'clear' }
  | { a: 'exit' }
  | { a: 'garbage' };

const actArb: fc.Arbitrary<Act> = fc.oneof(
  fc.record({ a: fc.constant('ups' as const), text: fc.nat(3), promptId: fc.nat(3) }),
  fc.record({ a: fc.constant('stop' as const), active: fc.boolean() }),
  fc.record({ a: fc.constant('stopFailure' as const), error: fc.nat(2) }),
  fc.record({ a: fc.constant('pre' as const), tool: fc.nat(3), agent: fc.nat(2) }),
  fc.record({ a: fc.constant('post' as const), tool: fc.nat(3), agent: fc.nat(2) }),
  fc.record({ a: fc.constant('fail' as const), tool: fc.nat(3) }),
  fc.record({ a: fc.constant('perm' as const), tool: fc.nat(3) }),
  fc.record({ a: fc.constant('answer' as const), perm: fc.nat(3), allow: fc.boolean() }),
  fc.record({ a: fc.constant('subStart' as const), agent: fc.nat(2) }),
  fc.record({ a: fc.constant('subStop' as const), agent: fc.nat(2) }),
  fc.record({ a: fc.constant('delta' as const), msg: fc.nat(2), final: fc.boolean() }),
  fc.record({ a: fc.constant('txResult' as const), tool: fc.nat(3), kind: fc.nat(3) }),
  fc.record({ a: fc.constant('txInterrupt' as const) }),
  fc.record({ a: fc.constant('txDuration' as const) }),
  fc.record({ a: fc.constant('txRecorded' as const), text: fc.nat(3), promptId: fc.nat(3) }),
  fc.record({ a: fc.constant('frame' as const), kind: fc.nat(6) }),
  fc.record({ a: fc.constant('send' as const), text: fc.nat(3) }),
  fc.record({ a: fc.constant('interrupt' as const) }),
  fc.record({ a: fc.constant('slash' as const), name: fc.nat(3) }),
  fc.record({ a: fc.constant('done' as const), ok: fc.boolean() }),
  fc.record({ a: fc.constant('tick' as const), ms: fc.integer({ min: 1, max: 6000 }) }),
  fc.record({ a: fc.constant('clear' as const) }),
  fc.record({ a: fc.constant('exit' as const) }),
  fc.record({ a: fc.constant('garbage' as const) }),
);

const TEXTS = ['hello', 'fix the bug', '!ls', 'multi\nline'];
const ERRORS = ['rate_limit', 'server_error', 'authentication_failed'];
const DENIALS = [undefined, 'user-rejected', 'permission-rule', 'interrupted'];
const SLASHES = ['/clear', '/compact', '/usage', '/permissions'];

function frameOf(kind: number): ScreenFacts {
  switch (kind) {
    case 0:
      return idleFrame();
    case 1:
      return busyFrame();
    case 2:
      return busyFrame({ status: { kind: 'retrying', attempt: 2, max: 10 } });
    case 3:
      return frame({
        surface: 'permissionDialog',
        dialog: { kind: 'permission', title: 'Bash', options: [{ n: 1, label: 'Yes', selected: true }] },
      });
    case 4:
      return busyFrame({ interruptedBanner: true });
    case 5:
      return composerFrame('hello');
    default:
      return frame({ surface: 'unknownModal' });
  }
}

/** Turns a list of acts into core inputs, threading time/seq and the last pending input intent (a fake executor). */
class Driver {
  seq = 0;
  now = 1000;
  wall = WALL0 + 1000;
  hookSeq = 0;
  cmdId = 0;
  sid = SESSION_ID;
  lastInput?: Extract<Intent, { kind: 'input' }> | undefined;

  meta(source: Source, o: Partial<ObsMeta> = {}): ObsMeta {
    this.seq += 1;
    this.now += 7;
    this.wall += 7;
    const m: ObsMeta = { seq: this.seq as ObsSeq, at: this.now as MonoMs, wallAt: this.wall as WallMs, source, ...o };
    if (source === 'hook' && m.claudeSessionId === undefined) m.claudeSessionId = this.sid;
    return m;
  }
  o(kind: Observation['kind'], p: unknown, source: Source = 'hook', m: Partial<ObsMeta> = {}): CoreInput {
    return { type: 'obs', obs: { kind, p, meta: this.meta(source, m) } as Observation };
  }
  c(cmd: Command): CoreInput {
    this.cmdId += 1;
    this.now += 3;
    this.wall += 3;
    return { type: 'cmd', cmdId: this.cmdId, cmd, at: this.now as MonoMs, wallAt: this.wall as WallMs };
  }

  toInput(a: Act): CoreInput | undefined {
    const agentRef = (n: number) => (n === 0 ? undefined : { agentId: `ag${n}`, agentType: n === 1 ? 'general-purpose' : '' });
    switch (a.a) {
      case 'ups':
        return this.o('prompt.submitted', { promptId: `p${a.promptId}`, text: TEXTS[a.text] ?? 'x' });
      case 'stop':
        return this.o('turn.stopped', { backgroundTasks: [], stopHookActive: a.active, lastAssistantMessage: 'ok' });
      case 'stopFailure':
        return this.o('turn.failed', { error: ERRORS[a.error] ?? 'x' });
      case 'pre': {
        const ag = agentRef(a.agent);
        return this.o('tool.pre', {
          toolUseId: `toolu_${a.tool}`,
          toolName: 'Bash',
          input: { command: `c${a.tool % 2}` },
          ...(ag !== undefined ? { agent: ag } : {}),
        });
      }
      case 'post':
        return this.o('tool.post', { toolUseId: `toolu_${a.tool}`, toolName: 'Bash', response: 'r' });
      case 'fail':
        return this.o('tool.failed', { toolUseId: `toolu_${a.tool}`, toolName: 'Bash', error: 'e' });
      case 'perm':
        this.hookSeq += 1;
        return this.o('permission.requested', {
          hookSeq: this.hookSeq as HookSeq,
          toolName: 'Bash',
          input: { command: `c${a.tool % 2}` },
          suggestions: [],
        });
      case 'answer':
        return this.c({
          type: 'permission.answer',
          permissionKey: `p${a.perm + 1}` as never,
          decision: a.allow ? { behavior: 'allow' } : { behavior: 'deny' },
          by: 'host',
        });
      case 'subStart':
        return this.o('agent.started', { agent: agentRef(a.agent + 1) });
      case 'subStop':
        return this.o('agent.stopped', { agent: agentRef(a.agent + 1), backgroundTasks: [] });
      case 'delta':
        return this.o('message.textDelta', { uiTurnId: 'ut', uiMessageId: `ui${a.msg}`, index: this.seq, final: a.final, delta: 'd' });
      case 'txResult':
        return this.o(
          'tool.result',
          {
            toolUseId: `toolu_${a.tool}`,
            isError: a.kind > 0,
            uuid: `r${this.seq}`,
            ...(DENIALS[a.kind] !== undefined ? { denialKind: DENIALS[a.kind] } : {}),
          },
          'transcript',
          { uuid: `r${this.seq + 1}` },
        );
      case 'txInterrupt':
        return this.o('turn.interrupted', { marker: 'request' }, 'transcript', { uuid: `i${this.seq + 1}` });
      case 'txDuration':
        return this.o('turn.durationRecorded', { durationMs: 10, pendingBackgroundAgentCount: 0 }, 'transcript', {
          uuid: `d${this.seq + 1}`,
        });
      case 'txRecorded':
        return this.o(
          'prompt.recorded',
          { uuid: `u${this.seq + 1}`, parentUuid: null, text: TEXTS[a.text] ?? 'x', isMeta: false, promptId: `p${a.promptId}` },
          'transcript',
          { uuid: `u${this.seq + 1}` },
        );
      case 'frame':
        return this.o('screen.frame', frameOf(a.kind), 'screen');
      case 'send':
        return this.c({ type: 'prompt.send', text: TEXTS[a.text] ?? 'x', whenBusy: 'wait' });
      case 'interrupt':
        return this.c({ type: 'interrupt' });
      case 'slash':
        return this.c({ type: 'slash.run', name: SLASHES[a.name] ?? '/help' });
      case 'done': {
        const i = this.lastInput;
        if (i === undefined) return undefined;
        this.lastInput = undefined;
        return this.o('input.done', { intentId: i.id, job: i.job, primitive: i.primitive.kind, ok: a.ok }, 'self');
      }
      case 'tick':
        this.now += a.ms;
        this.wall += a.ms;
        return this.o('clock.tick', {}, 'clock');
      case 'clear':
        this.sid = `s${this.seq}`;
        return this.o('session.started', { sessionId: this.sid, transcriptPath: `/t/${this.sid}.jsonl`, source: 'clear' });
      case 'exit':
        return this.o('process.exited', { exitStatus: 0, signal: null }, 'process');
      case 'garbage':
        return this.o('unknown', { channel: 'hook', raw: { weird: true } }, 'hook');
    }
  }
}

function bootInputs(d: Driver): CoreInput[] {
  return [
    d.o('process.launched', { pid: 1, paneId: '%1', claudeVersion: '2.1.316', startTime: 't' }, 'process'),
    d.o('session.started', { sessionId: SESSION_ID, transcriptPath: '/t.jsonl', source: 'startup', model: 'm' }),
    d.o('screen.frame', idleFrame(), 'screen'),
    (() => {
      d.now += 400;
      d.wall += 400;
      return d.o('clock.tick', {}, 'clock');
    })(),
    d.c({ type: 'selftest.run', nonce: 'ccd-selftest-00000000000000000000000000000000', cachedPass: true }),
  ];
}

interface RunOut {
  core: CoreState;
  trace: string[];
  coreEvents: CoreEvent[];
  inputs: CoreInput[];
}

function run(acts: readonly Act[], start?: { core: CoreState; driver: Driver }): RunOut {
  const d = start?.driver ?? new Driver();
  let core = start?.core ?? initialCore(testInit(testConfig({ permissions: { policy: 'ask' } })));
  const trace: string[] = [];
  const coreEvents: CoreEvent[] = [];
  const inputs: CoreInput[] = [];
  const feed = (inp: CoreInput): void => {
    inputs.push(inp);
    const r = stepDetailed(core, inp);
    expect(r.diagnostics.filter((x) => x.code === 'step_exception')).toEqual([]);
    core = r.core;
    coreEvents.push(...r.coreEvents);
    trace.push(JSON.stringify([r.events, r.intents, r.commandResult ?? null]));
    const last = [...r.intents].reverse().find((i): i is Extract<Intent, { kind: 'input' }> => i.kind === 'input');
    if (last !== undefined) d.lastInput = last;
  };
  if (start === undefined) for (const i of bootInputs(d)) feed(i);
  for (const a of acts) {
    const inp = d.toInput(a);
    if (inp !== undefined) feed(inp);
  }
  return { core, trace, coreEvents, inputs };
}

const NUM_RUNS = 120;
const acts = fc.array(actArb, { minLength: 1, maxLength: 60 });

/** Status is a cache recomputed every step; compare the rest. */
function withoutStatus(d: SessionState): unknown {
  return JSON.parse(JSON.stringify({ ...d, status: null }));
}

describe('invariants (§2.9)', () => {
  it('I1 fold(evolve, initialDomain, coreEvents) deep-equals core.domain', () => {
    expect(() => {
      fc.assert(
        fc.property(acts, (as) => {
          const r = run(as);
          const folded = foldEvents(initialDomain(testInit(testConfig({ permissions: { policy: 'ask' } }))), r.coreEvents);
          expect(JSON.parse(JSON.stringify(folded))).toEqual(JSON.parse(JSON.stringify(r.core.domain)));
        }),
        { numRuns: NUM_RUNS },
      );
    }).not.toThrow();
  });

  it('I2 step never throws and never reports step_exception, for any input including garbage', () => {
    expect(() => {
      fc.assert(
        fc.property(acts, fc.anything(), (as, junk) => {
          const r = run(as);
          const res = step(r.core, {
            type: 'obs',
            obs: {
              kind: 'unknown',
              meta: { seq: 99999 as ObsSeq, at: r.core.now, wallAt: r.core.wallNow, source: 'hook' },
              p: { channel: 'hook', raw: junk },
            },
          });
          expect(res.diagnostics.filter((x) => x.code === 'step_exception')).toEqual([]);
          const bad = step(r.core, {
            type: 'obs',
            obs: {
              kind: 'tool.pre',
              meta: { seq: 100000 as ObsSeq, at: Number.NaN as MonoMs, wallAt: r.core.wallNow, source: 'hook' },
              p: { toolUseId: '', toolName: '', input: junk },
            } as Observation,
          });
          expect(bad.core.now).toBe(r.core.now);
        }),
        { numRuns: NUM_RUNS },
      );
    }).not.toThrow();
  });

  it('I3 same inputs → byte-identical events, intents and keys', () => {
    expect(() => {
      fc.assert(
        fc.property(acts, (as) => {
          const a = run(as);
          const b = run(as);
          expect(b.trace).toEqual(a.trace);
          expect(JSON.stringify(b.core)).toBe(JSON.stringify(a.core));
        }),
        { numRuns: 60 },
      );
    }).not.toThrow();
  });

  it('I4 provenance only grows; I5 no confirmed terminal entity returns to non-terminal', () => {
    expect(() => {
      fc.assert(
        fc.property(acts, (as) => {
          const d = new Driver();
          let core = initialCore(testInit(testConfig({ permissions: { policy: 'ask' } })));
          const all = [...bootInputs(d), ...as.map((x) => d.toInput(x)).filter((x): x is CoreInput => x !== undefined)];
          for (const inp of all) {
            const before = core.domain;
            core = step(core, inp).core;
            const after = core.domain;
            for (const [k, t] of Object.entries(before.turns)) {
              const n = after.turns[k as never];
              expect(n).toBeDefined();
              if (n === undefined) continue;
              for (const s of t.provenance.sources) expect(n.provenance.sources).toContain(s);
              expect(n.provenance.lastSeq).toBeGreaterThanOrEqual(t.provenance.lastSeq);
              if (isTurnTerminal(t.state.value) && !t.state.provisional && t.state.value !== 'unknown')
                expect(isTurnTerminal(n.state.value)).toBe(true);
            }
            for (const [k, t] of Object.entries(before.tools)) {
              const n = after.tools[k as never];
              if (n === undefined) continue;
              for (const s of t.provenance.sources) expect(n.provenance.sources).toContain(s);
              if (isToolTerminal(t.state.value) && !t.state.provisional && t.state.value !== 'unknown')
                expect(isToolTerminal(n.state.value)).toBe(true);
            }
          }
        }),
        { numRuns: NUM_RUNS },
      );
    }).not.toThrow();
  });

  it('I6 while a permission is held, no Enter/digit/text input intent is emitted', () => {
    expect(() => {
      fc.assert(
        fc.property(acts, (as) => {
          const d = new Driver();
          let core = initialCore(testInit(testConfig({ permissions: { policy: 'ask' } })));
          const all = [...bootInputs(d), ...as.map((x) => d.toInput(x)).filter((x): x is CoreInput => x !== undefined)];
          for (const inp of all) {
            const heldBefore = permissionHeld(core.domain);
            const r = step(core, inp);
            core = r.core;
            if (!heldBefore || !permissionHeld(core.domain)) continue;
            for (const i of r.intents) {
              if (i.kind !== 'input') continue;
              const p = i.primitive;
              expect(p.kind === 'editorStage' || p.kind === 'pasteChunk' || p.kind === 'typeLiteral').toBe(false);
              if (p.kind === 'key') expect(p.key === 'Enter' || /^[1-9]$/.test(p.key)).toBe(false);
            }
          }
        }),
        { numRuns: NUM_RUNS },
      );
    }).not.toThrow();
  });

  it('I7 serializeCore/deserializeCore mid-stream then the remaining inputs → the same events as the uninterrupted run', () => {
    expect(() => {
      fc.assert(
        fc.property(acts, fc.nat(), (as, cutAt) => {
          const full = run(as);
          const cut = full.inputs.length === 0 ? 0 : cutAt % full.inputs.length;
          let core = initialCore(testInit(testConfig({ permissions: { policy: 'ask' } })));
          const trace: string[] = [];
          full.inputs.forEach((inp, i) => {
            if (i === cut) core = deserializeCore(serializeCore(core));
            const r = step(core, inp);
            core = r.core;
            trace.push(JSON.stringify([r.events, r.intents, r.commandResult ?? null]));
          });
          expect(trace).toEqual(full.trace);
        }),
        { numRuns: 60 },
      );
    }).not.toThrow();
  });
});

// ------------------------------------------------------------------ scenario-based robustness properties
function scenario(
  d: Driver,
  o: { dropScreen?: boolean; dropTranscript?: boolean; dropHook?: Observation['kind']; transcriptDelayMs?: number } = {},
): CoreInput[] {
  const out: CoreInput[] = [...bootInputs(d)];
  const push = (inp: CoreInput): void => {
    if (inp.type === 'obs') {
      if (o.dropScreen === true && inp.obs.meta.source === 'screen') return;
      if (o.dropTranscript === true && inp.obs.meta.source === 'transcript') return;
      if (o.dropHook !== undefined && inp.obs.meta.source === 'hook' && inp.obs.kind === o.dropHook) return;
    }
    out.push(inp);
  };
  push(d.o('prompt.submitted', { promptId: 'p1', text: 'human prompt' }));
  push(d.o('tool.pre', { toolUseId: 'toolu_1', toolName: 'Read', input: { file_path: '/work/a' } }));
  push(d.o('screen.frame', busyFrame(), 'screen'));
  push(d.o('tool.post', { toolUseId: 'toolu_1', toolName: 'Read', response: 'ok' }));
  push(d.o('tool.result', { toolUseId: 'toolu_1', isError: false, uuid: 'tr1' }, 'transcript', { uuid: 'tr1' }));
  push(d.o('turn.stopped', { backgroundTasks: [], stopHookActive: false, lastAssistantMessage: 'answer' }));
  push(d.o('turn.durationRecorded', { durationMs: 100, pendingBackgroundAgentCount: 0 }, 'transcript', { uuid: 'td1' }));
  d.now += 6000;
  d.wall += 6000;
  push(d.o('clock.tick', {}, 'clock'));
  return out;
}

function runInputs(inputs: readonly CoreInput[]): CoreState {
  let core = initialCore(testInit(testConfig({ permissions: { policy: 'ask' } })));
  for (const i of inputs) {
    const r = step(core, i);
    expect(r.diagnostics.filter((x) => x.code === 'step_exception')).toEqual([]);
    core = r.core;
  }
  return core;
}

function facts(c: CoreState): unknown {
  const d = c.domain;
  return {
    turns: Object.values(d.turns).map((t) => [t.key, t.state.value, t.endedBy ?? null]),
    tools: Object.values(d.tools).map((t) => [t.key, t.name, t.state.value]),
    perms: Object.values(d.permissions).map((p) => [p.key, p.state.value]),
    agents: Object.values(d.agents).map((a) => [a.key, a.state.value]),
  };
}

describe('robustness properties (§6.2)', () => {
  it('permutation: concurrent hooks within ±5 ms in either order converge (two parallel PostToolUse; SubagentStop vs async Post)', () => {
    const variants = (swap: boolean): CoreState => {
      const d = new Driver();
      const ins = [
        ...bootInputs(d),
        d.o('prompt.submitted', { promptId: 'p1', text: 'x' }),
        d.o('tool.pre', { toolUseId: 'toolu_a', toolName: 'Bash', input: {} }),
        d.o('tool.pre', { toolUseId: 'toolu_b', toolName: 'Bash', input: { c: 1 } }),
        d.o('tool.pre', { toolUseId: 'toolu_g', toolName: 'Agent', input: { subagent_type: 'general-purpose', run_in_background: true } }),
      ];
      const pair = [
        d.o('tool.post', { toolUseId: 'toolu_a', toolName: 'Bash', response: 1 }),
        d.o('tool.post', { toolUseId: 'toolu_b', toolName: 'Bash', response: 2 }),
      ];
      const pair2 = [
        d.o('agent.started', { agent: { agentId: 'bg', agentType: 'general-purpose' } }),
        d.o('tool.post', { toolUseId: 'toolu_g', toolName: 'Agent', response: { status: 'async_launched' }, asyncAgentId: 'bg' }),
      ];
      return runInputs([...ins, ...(swap ? [...pair].reverse() : pair), ...(swap ? [...pair2].reverse() : pair2)]);
    };
    expect(facts(variants(true))).toEqual(facts(variants(false)));
  });

  it('permutation: transcript tool_result before or after the hook PostToolUse gives the same terminal facts', () => {
    expect(() => {
      fc.assert(
        fc.property(fc.boolean(), fc.boolean(), (swap1, isError) => {
          const mk = (swap: boolean): CoreState => {
            const d = new Driver();
            const base = [
              ...bootInputs(d),
              d.o('prompt.submitted', { promptId: 'p1', text: 'x' }),
              d.o('tool.pre', { toolUseId: 'toolu_a', toolName: 'Bash', input: {} }),
            ];
            const hookPost = isError
              ? d.o('tool.failed', { toolUseId: 'toolu_a', toolName: 'Bash', error: 'e' })
              : d.o('tool.post', { toolUseId: 'toolu_a', toolName: 'Bash', response: 'ok' });
            const tx = d.o('tool.result', { toolUseId: 'toolu_a', isError, uuid: 'x' }, 'transcript', { uuid: 'x' });
            return runInputs([...base, ...(swap ? [tx, hookPost] : [hookPost, tx])]);
          };
          expect(facts(mk(swap1))).toEqual(facts(mk(!swap1)));
        }),
        { numRuns: 8 },
      );
    }).not.toThrow();
  });

  it('duplicate injection: an identical transcript line twice is idempotent', () => {
    expect(() => {
      fc.assert(
        fc.property(fc.nat(6), (which) => {
          const d = new Driver();
          const ins = scenario(d);
          const tIdx = ins.map((x, i) => [x, i] as const).filter(([x]) => x.type === 'obs' && x.obs.meta.source === 'transcript');
          const pick = tIdx[which % Math.max(1, tIdx.length)];
          if (pick === undefined) return;
          const dup = [...ins.slice(0, pick[1] + 1), pick[0], ...ins.slice(pick[1] + 1)];
          expect(withoutStatus(runInputs(dup).domain)).toEqual(withoutStatus(runInputs(ins).domain));
        }),
        { numRuns: 10 },
      );
    }).not.toThrow();
  });

  it('channel dropout: terminal facts stay correct or become unknown, never wrong; hook dropout degrades the hooks channel', () => {
    const ref = facts(runInputs(scenario(new Driver())));
    for (const o of [{ dropScreen: true }, { dropTranscript: true }]) {
      expect(facts(runInputs(scenario(new Driver(), o)))).toEqual(ref);
    }
    // the Stop hook dropped: the turn still completes by turn_duration (never "failed")
    const noStop = runInputs(scenario(new Driver(), { dropHook: 'turn.stopped' }));
    expect(noStop.domain.turns['t1' as never]?.state.value).toBe('completed');
    // the UPS hook dropped: the transcript-first prompt degrades the hooks channel
    const d = new Driver();
    const ins = [
      ...bootInputs(d),
      d.o('prompt.recorded', { uuid: 'u1', parentUuid: null, text: 'human', isMeta: false, promptId: 'p1' }, 'transcript', { uuid: 'u1' }),
    ];
    d.now += 2500;
    d.wall += 2500;
    ins.push(d.o('clock.tick', {}, 'clock'));
    expect(runInputs(ins).domain.channels.hooks.health).toBe('degraded');
  });

  it('delay injection: +2 s on all transcript observations → no premature unknown, no reopened turns', () => {
    const d = new Driver();
    const ins = scenario(d);
    const shifted: CoreInput[] = [];
    let extra = 0;
    for (const i of ins) {
      if (i.type === 'obs' && i.obs.meta.source === 'transcript') {
        extra = 2000;
        shifted.push({
          type: 'obs',
          obs: { ...i.obs, meta: { ...i.obs.meta, at: (i.obs.meta.at + extra) as MonoMs, wallAt: (i.obs.meta.wallAt + extra) as WallMs } },
        });
      } else shifted.push(i);
    }
    const c = runInputs(shifted);
    expect(Object.values(c.domain.turns).map((t) => t.state.value)).toEqual(['completed']);
    expect(Object.values(c.domain.tools).map((t) => t.state.value)).toEqual(['succeeded']);
  });

  it('deadline jitter: extra clock ticks between inputs → the same terminal facts', () => {
    expect(() => {
      fc.assert(
        fc.property(fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 8 }), (gaps) => {
          const d = new Driver();
          const ins = scenario(d);
          const jittered: CoreInput[] = [];
          ins.forEach((inp, i) => {
            jittered.push(inp);
            const g = gaps[i % gaps.length] ?? 1;
            if (inp.type === 'obs' && i < ins.length - 1) {
              const at = (inp.obs.meta.at + g) as MonoMs;
              jittered.push({
                type: 'obs',
                obs: {
                  kind: 'clock.tick',
                  p: {},
                  meta: { seq: (100000 + i) as ObsSeq, at, wallAt: (inp.obs.meta.wallAt + g) as WallMs, source: 'clock' },
                },
              });
            }
          });
          expect(facts(runInputs(jittered))).toEqual(facts(runInputs(ins)));
        }),
        { numRuns: 20 },
      );
    }).not.toThrow();
  });

  it('determinism: no clock or randomness reaches the core (P-REC-19): two cores fed the same inputs serialize identically', () => {
    const a = runInputs(scenario(new Driver()));
    const b = runInputs(scenario(new Driver()));
    expect(JSON.stringify(serializeCore(a))).toBe(JSON.stringify(serializeCore(b)));
  });
});
