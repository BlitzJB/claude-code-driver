// testing/scenario.ts — given/when/then DSL over the pure core (DESIGN.md §6.2: "every row of the §4 tables (named `§4.4#n`),
// given/when/then via testing/scenario.ts"). It drives `step` with observations and commands on a deterministic clock and
// keeps every StepResult, so a core test reads like the table row it covers:
//
//   const s = coreScenario(core, { config: { permissions: { policy: 'deny' } } });
//   s.obs('session.started', { sessionId, transcriptPath, source: 'startup' });
//   s.at(300).obs('screen.frame', idleFrame());
//   expect(s.lastEvent('session.ready')).toBeDefined();
//
// The core is passed in (structural `CoreApi`), so this file compiles before core/** exists and never couples the kit to
// core internals; WP-09 passes `{ initialCore, step, nextDeadline }` from its own modules.
import type { Command } from '../model/commands.js';
import type { CoreInit } from '../model/config.js';
import type { Diagnostic } from '../model/debug.js';
import type { DomainEvent } from '../model/events.js';
import type { IntentId, ObsSeq } from '../model/ids.js';
import type { Intent, InputPrimitive } from '../model/intents.js';
import type { JsonValue } from '../model/json.js';
import type { Observation, ObsMeta, Source } from '../model/observation.js';
import type { ScreenFacts } from '../model/screen-facts.js';
import type { SessionState } from '../model/state.js';
import type { MonoMs, WallMs } from '../model/time.js';
import { testCoreInit, type CoreConfigOverrides } from './core-config.js';

/** §2.9 CoreInput, restated structurally (core/step.ts owns the nominal type). */
export type CoreInput = { type: 'obs'; obs: Observation } | { type: 'cmd'; cmdId: number; cmd: Command; at: MonoMs; wallAt: WallMs };

/** §2.9 StepResult, generic in the core state type. */
export interface CoreStepResult<S> {
  core: S;
  events: DomainEvent[];
  intents: Intent[];
  diagnostics: Diagnostic[];
  commandResult?: { cmdId: number; ok: true; value: unknown } | { cmdId: number; ok: false; error: { code: string; message: string } };
}

/** The part of the core contract (§2.9) the DSL needs. */
export interface CoreApi<S extends { domain: SessionState }> {
  initialCore(init: CoreInit): S;
  step(core: S, input: CoreInput): CoreStepResult<S>;
  nextDeadline?(core: S): { atMono?: MonoMs; atWall?: WallMs };
  serializeCore?(c: S): JsonValue;
  deserializeCore?(j: JsonValue): S;
}

type ObsKind = Observation['kind'];
type PayloadOf<K extends ObsKind> = Extract<Observation, { kind: K }>['p'];
export type MetaOverrides = Partial<Omit<ObsMeta, 'seq'>> & { seq?: number };

const HOOK_KINDS = new Set<string>([
  'session.started',
  'session.ended',
  'prompt.submitted',
  'turn.stopped',
  'turn.failed',
  'message.textDelta',
  'tool.pre',
  'tool.post',
  'tool.failed',
  'tool.batchDone',
  'permission.requested',
  'permission.hookClosed',
  'agent.started',
  'agent.stopped',
  'notification',
  'input.requested',
  'input.requestCleared',
  'compact.phase',
  'mode.observed',
  'model.switched',
  'config.changed',
  'cwd.changed',
]);
const SELF_KINDS = new Set<string>([
  'input.done',
  'hook.responded',
  'hook.selfTestArmed',
  'host.loopLag',
  'permission.pathsResolved',
  'auth.status',
]);

/** The channel an observation of `kind` normally comes from (L1 mapping, §2.4). */
export function defaultSource(kind: string): Source {
  if (HOOK_KINDS.has(kind)) return 'hook';
  if (SELF_KINDS.has(kind)) return 'self';
  if (kind === 'screen.frame') return 'screen';
  if (kind === 'net.tunnel') return 'network';
  if (kind === 'registry') return 'registry';
  if (kind.startsWith('process.')) return 'process';
  if (kind.startsWith('clock.')) return 'clock';
  if (kind === 'channel.health') return 'channel';
  return 'transcript';
}

/** A complete idle `main` ScreenFacts (empty composer, default mode); override any field. */
export function screenFacts(over: Partial<ScreenFacts> = {}): ScreenFacts {
  return {
    surface: 'main',
    torn: false,
    altScreen: false,
    inCopyMode: false,
    paneWidth: 250,
    paneHeight: 80,
    frameHash: over.frameHash ?? 'idle',
    status: { kind: 'none' },
    interruptedBanner: false,
    footer: {
      busy: false,
      modeLabel: 'manual mode on',
      mode: 'default',
      pasting: false,
      ctrlCExitArmed: false,
      hints: ['? for shortcuts'],
    },
    composer: { text: '', empty: true, placeholderLikely: false, pastedPlaceholder: false, notices: [] },
    hookErrorLines: 0,
    agentPanelRows: 0,
    ...over,
  };
}

export interface CoreScenarioOptions {
  init?: Partial<Omit<CoreInit, 'config'>>;
  config?: CoreConfigOverrides;
}

export class CoreScenario<S extends { domain: SessionState }> {
  core: S;
  readonly steps: { input: CoreInput; result: CoreStepResult<S> }[] = [];
  readonly events: DomainEvent[] = [];
  readonly intents: Intent[] = [];
  readonly diagnostics: Diagnostic[] = [];
  now: number;
  wall: number;
  private seq = 0;
  private cmdId = 0;
  private hookSeq = 0;

  constructor(
    readonly api: CoreApi<S>,
    readonly init: CoreInit,
  ) {
    this.core = api.initialCore(init);
    this.now = init.startedAt;
    this.wall = init.wallAt;
  }

  get domain(): SessionState {
    return this.core.domain;
  }

  get last(): CoreStepResult<S> | undefined {
    return this.steps.at(-1)?.result;
  }

  /** Move the clock forward by `ms` (no input is sent; the next input fires due deadlines, §2.9 step order). */
  at(ms: number): this {
    this.now += ms;
    this.wall += ms;
    return this;
  }

  /** Host sleep: wall jumps, mono does not. */
  jumpWall(ms: number): this {
    this.wall += ms;
    return this;
  }

  /** Build an observation with a fresh seq and the current clock. */
  build<K extends ObsKind>(kind: K, p: PayloadOf<K>, meta: MetaOverrides = {}): Extract<Observation, { kind: K }> {
    const source = meta.source ?? defaultSource(kind);
    const m: ObsMeta = {
      seq: (meta.seq ?? ++this.seq) as ObsSeq,
      at: (meta.at ?? this.now) as MonoMs,
      wallAt: (meta.wallAt ?? this.wall) as WallMs,
      source,
    };
    if (meta.seq !== undefined) this.seq = Math.max(this.seq, meta.seq);
    for (const k of ['uuid', 'claudeSessionId', 'agentId', 'replay', 'origin', 'rawRef'] as const)
      if (meta[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = meta[k];
    if (m.origin === undefined && source === 'hook' && meta.origin === undefined)
      m.origin = { kind: 'hook', transport: 'http', event: kind, hookSeq: ++this.hookSeq as never };
    return { kind, meta: m, p } as unknown as Extract<Observation, { kind: K }>;
  }

  /** Step one observation. */
  obs<K extends ObsKind>(kind: K, p: PayloadOf<K>, meta: MetaOverrides = {}): CoreStepResult<S> {
    return this.input({ type: 'obs', obs: this.build(kind, p, meta) });
  }

  /** Step one prebuilt observation (keeps its meta). */
  feed(o: Observation): CoreStepResult<S> {
    this.seq = Math.max(this.seq, o.meta.seq);
    return this.input({ type: 'obs', obs: o });
  }

  /** Step one command. */
  cmd(cmd: Command): CoreStepResult<S> {
    return this.input({ type: 'cmd', cmdId: ++this.cmdId, cmd, at: this.now as MonoMs, wallAt: this.wall as WallMs });
  }

  /** A `clock.tick` now (fires due deadlines). */
  tick(ms = 0): CoreStepResult<S> {
    this.at(ms);
    return this.obs('clock.tick', {}, { source: 'clock' });
  }

  /** Jump to the core's next mono deadline and tick; returns undefined if none is armed. */
  nextDeadlineTick(): CoreStepResult<S> | undefined {
    const nd = this.api.nextDeadline?.(this.core);
    if (nd?.atMono === undefined) return undefined;
    if (nd.atMono > this.now) this.at(nd.atMono - this.now);
    return this.tick();
  }

  /** Tick through every mono deadline due within `ms`. */
  runFor(ms: number): this {
    const end = this.now + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      const nd = this.api.nextDeadline?.(this.core);
      if (nd?.atMono === undefined || nd.atMono > end) break;
      if (nd.atMono > this.now) this.at(nd.atMono - this.now);
      this.tick();
    }
    if (end > this.now) this.at(end - this.now);
    return this;
  }

  /** Report an input intent as executed (`input.done`). */
  done(
    intent: Extract<Intent, { kind: 'input' }>,
    o: { ok?: boolean; error?: string; output?: string; detail?: string } = {},
  ): CoreStepResult<S> {
    const p: PayloadOf<'input.done'> = { intentId: intent.id, job: intent.job, primitive: intent.primitive.kind, ok: o.ok ?? true };
    if (o.error !== undefined) (p as { error?: unknown }).error = o.error;
    if (o.output !== undefined) p.output = o.output;
    if (o.detail !== undefined) p.detail = o.detail;
    return this.obs('input.done', p, { source: 'self', origin: { kind: 'self', intentId: intent.id } });
  }

  /** Execute every pending input intent of the last step successfully, in order (a perfect executor). */
  ackInputs(filter: (p: InputPrimitive) => boolean = () => true): CoreStepResult<S>[] {
    const out: CoreStepResult<S>[] = [];
    const pending = (this.last?.intents ?? []).filter(
      (i): i is Extract<Intent, { kind: 'input' }> => i.kind === 'input' && filter(i.primitive),
    );
    for (const i of pending) out.push(this.done(i));
    return out;
  }

  eventsOf<T extends DomainEvent['type']>(type: T): Extract<DomainEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);
  }

  lastEvent<T extends DomainEvent['type']>(type: T): Extract<DomainEvent, { type: T }> | undefined {
    return this.eventsOf(type).at(-1);
  }

  intentsOf<K extends Intent['kind']>(kind: K): Extract<Intent, { kind: K }>[] {
    return this.intents.filter((i): i is Extract<Intent, { kind: K }> => i.kind === kind);
  }

  /** Input primitives emitted so far, in order (for "zero keys" / "no Enter while blocked" assertions). */
  primitives(): InputPrimitive[] {
    return this.intentsOf('input').map((i) => i.primitive);
  }

  /** Round-trip the core through serialize/deserialize (I7); no-op if the core lacks them. */
  snapshotRestore(): this {
    const api = this.api;
    if (api.serializeCore !== undefined && api.deserializeCore !== undefined)
      this.core = api.deserializeCore(JSON.parse(JSON.stringify(api.serializeCore(this.core))) as JsonValue);
    return this;
  }

  private input(input: CoreInput): CoreStepResult<S> {
    const result = this.api.step(this.core, input);
    this.core = result.core;
    this.steps.push({ input, result });
    this.events.push(...result.events);
    this.intents.push(...result.intents);
    this.diagnostics.push(...result.diagnostics);
    return result;
  }
}

export function coreScenario<S extends { domain: SessionState }>(api: CoreApi<S>, o: CoreScenarioOptions = {}): CoreScenario<S> {
  const initOpts: Parameters<typeof testCoreInit>[0] = { ...(o.init ?? {}) };
  if (o.config !== undefined) initOpts.config = o.config;
  return new CoreScenario(api, testCoreInit(initOpts));
}

/** Test title for a §4 table row (`§4.4#7 …`), the form scripts/check-table-coverage.mjs looks for. */
export function row(section: string, n: number, text: string): string {
  return `§${section}#${n} ${text}`;
}

/** Last intent id seen (helper for asserting "no new intents"). */
export function lastIntentId(intents: readonly Intent[]): IntentId | undefined {
  return intents.at(-1)?.id;
}
