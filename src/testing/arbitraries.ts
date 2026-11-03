// testing/arbitraries.ts — fast-check arbitraries for the core property tests (DESIGN.md §6.2 `core/properties.test.ts`:
// I1–I7, permutation convergence, duplicate injection, channel dropout, delay injection, deadline jitter, snapshot/restore)
// and for the sanitizer (SEC §3.4 vectors).
//
// fast-check is a devDependency and the package has zero runtime dependencies, so this module imports it as a TYPE only;
// callers pass the library in: `const arb = createArbitraries(fc)`.
import type * as FastCheck from 'fast-check';
import type { Command, PermissionDecision } from '../model/commands.js';
import type { HookSeq, IntentId, ObsSeq, PermissionKey, TurnKey } from '../model/ids.js';
import type { Observation, ObsMeta, Source } from '../model/observation.js';
import type { ScreenFacts } from '../model/screen-facts.js';
import type { MonoMs, WallMs } from '../model/time.js';
import { defaultSource, screenFacts } from './scenario.js';

/** The fast-check API (either its default export or the namespace import). */
type FC = Omit<typeof FastCheck, 'default'>;
type Arb<T> = FastCheck.Arbitrary<T>;

/** SEC §3.4 / §6.2 input vectors every sanitizer test must cover (LP-45: `!` is the only prefix escape, ICR 0001 item 2). */
export const SEC_INPUT_VECTORS: readonly string[] = Object.freeze([
  '/permissions',
  ' /permissions',
  '/cost',
  ' /cost',
  '!rm -rf ~',
  '?x',
  '&x',
  '#x',
  '\u001b[Z',
  '\u001b\u001b',
  `${'a'.repeat(100 * 1024 - 6)}\u001b[201~`,
  '‮',
  '👩‍💻',
  'a\u0003b',
  'x\u001b]52;c;aGVsbG8=\u0007y',
  'a\u0000b',
  'a\u007fb',
  'a\u009bb',
  'line\\',
  'tag\u{E0041}s',
  'zero​width',
]);

export interface Arbitraries {
  sessionId: Arb<string>;
  promptId: Arb<string>;
  toolUseId: Arb<string>;
  /** Free prompt text, biased towards hazards (control chars, invisibles, slash/bang prefixes, emoji). */
  prompt: Arb<string>;
  permissionDecision: Arb<PermissionDecision>;
  command: Arb<Command>;
  screenFacts: Arb<ScreenFacts>;
  /** One observation of a model-relevant kind (seq/at are placeholders; `sequence` renumbers). */
  observation: Arb<Observation>;
  /** A sequence of observations with strictly increasing seq and non-decreasing at, starting at `startAt`. */
  sequence(o?: { minLength?: number; maxLength?: number; startAt?: number; maxGapMs?: number }): Arb<Observation[]>;
  /** Extra mono delays to add to deadlines/ticks (deadline-jitter property). */
  jitterMs: Arb<number>;
}

const SOURCES_BY_DROPOUT: readonly Source[] = ['screen', 'network', 'transcript', 'hook'];

export function createArbitraries(fc: FC): Arbitraries {
  const hexN = (n: number): Arb<string> => fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`));
  const uuid = fc.uuid({ version: 4 });
  const sessionId = uuid;
  const promptId = uuid;
  const toolUseId = hexN(24).map((h) => `toolu_01${h}`);

  const hazards = fc.constantFrom(...SEC_INPUT_VECTORS.filter((v) => v.length < 1024));
  const prompt = fc.oneof(
    { weight: 4, arbitrary: fc.string({ minLength: 1, maxLength: 200 }) },
    { weight: 2, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 80 }) },
    { weight: 2, arbitrary: hazards },
    { weight: 1, arbitrary: fc.tuple(hazards, fc.string({ maxLength: 40 })).map(([a, b]) => `${a}${b}`) },
  );

  const permissionDecision: Arb<PermissionDecision> = fc.oneof(
    fc.constant<PermissionDecision>({ behavior: 'allow' }),
    fc.record({ behavior: fc.constant<'deny'>('deny'), message: fc.string({ maxLength: 40 }) }),
    fc.record({ behavior: fc.constant<'deny'>('deny'), interrupt: fc.boolean() }),
  );

  const permKey = fc.integer({ min: 1, max: 5 }).map((n) => `p${n}` as PermissionKey);
  const command: Arb<Command> = fc.oneof(
    fc.record({
      type: fc.constant<'prompt.send'>('prompt.send'),
      text: prompt,
      whenBusy: fc.constantFrom<'wait' | 'reject'>('wait', 'reject'),
    }),
    fc.record({
      type: fc.constant<'prompt.cancel'>('prompt.cancel'),
      turnKey: fc.integer({ min: 1, max: 5 }).map((n) => `t${n}` as TurnKey),
    }),
    fc.record({
      type: fc.constant<'slash.run'>('slash.run'),
      name: fc.constantFrom('/clear', '/new', '/usage', '/cost', '/permissions', '/exit', '/quit', '/tui', '/model', '/nope'),
      unsafe: fc.boolean(),
    }),
    fc.constant<Command>({ type: 'interrupt' }),
    fc.record({
      type: fc.constant<'permission.answer'>('permission.answer'),
      permissionKey: permKey,
      decision: permissionDecision,
      by: fc.constantFrom<'host' | 'handler' | 'policy'>('host', 'handler', 'policy'),
    }),
    fc.record({
      type: fc.constant<'mode.set'>('mode.set'),
      mode: fc.constantFrom('default', 'acceptEdits', 'plan', 'bypassPermissions'),
    }) as Arb<Command>,
    fc.constant<Command>({ type: 'usage.wakeNow' }),
  );

  const status = fc.oneof(
    fc.constant<NonNullable<ScreenFacts['status']>>({ kind: 'none' }),
    fc.record({ kind: fc.constant<'spinner'>('spinner'), elapsedMs: fc.nat(60_000) }),
    fc.record({
      kind: fc.constant<'retrying'>('retrying'),
      attempt: fc.integer({ min: 1, max: 10 }),
      max: fc.constant(10),
      retryInMs: fc.nat(30_000),
    }),
    fc.constant<NonNullable<ScreenFacts['status']>>({ kind: 'stalled' }),
    fc.record({ kind: fc.constant<'done'>('done'), doneDurationMs: fc.nat(600_000) }),
  );
  const sf: Arb<ScreenFacts> = fc
    .record({
      surface: fc.constantFrom<ScreenFacts['surface']>('main', 'main', 'main', 'permissionDialog', 'modal', 'unknownModal', 'blank'),
      busy: fc.boolean(),
      text: fc.oneof(fc.constant(''), fc.string({ maxLength: 30 })),
      status,
      interruptedBanner: fc.boolean(),
      torn: fc.boolean(),
    })
    .map((r) => {
      const over: Partial<ScreenFacts> = {
        surface: r.surface,
        torn: r.torn,
        frameHash: `${r.surface}:${r.busy ? 'b' : 'i'}:${r.text}:${r.status.kind}:${r.interruptedBanner ? 1 : 0}`,
        status: r.status,
        interruptedBanner: r.interruptedBanner,
        footer: { busy: r.busy, modeLabel: 'manual mode on', mode: 'default', pasting: false, ctrlCExitArmed: false, hints: [] },
        composer: { text: r.text, empty: r.text === '', placeholderLikely: false, pastedPlaceholder: false, notices: [] },
      };
      return screenFacts(over);
    });

  const meta = (source: Source, extra: Partial<ObsMeta> = {}): ObsMeta => ({
    seq: 0 as ObsSeq,
    at: 0 as MonoMs,
    wallAt: 0 as WallMs,
    source,
    ...extra,
  });
  const mk = <K extends Observation['kind']>(
    kind: K,
    p: Extract<Observation, { kind: K }>['p'],
    extra: Partial<ObsMeta> = {},
  ): Observation => ({ kind, meta: meta(defaultSource(kind), extra), p }) as unknown as Observation;

  const tool = fc.record({
    toolUseId,
    toolName: fc.constantFrom('Bash', 'Read', 'Write', 'Agent'),
    command: fc.constantFrom('ls', 'echo hi', 'touch x'),
  });
  const observation: Arb<Observation> = fc.oneof(
    fc.record({ sessionId, source: fc.constantFrom('startup', 'resume', 'clear') }).map((r) =>
      mk('session.started', {
        sessionId: r.sessionId,
        transcriptPath: `/HOME/.claude/projects/-w/${r.sessionId}.jsonl`,
        source: r.source,
      }),
    ),
    fc.record({ promptId, text: prompt }).map((r) => mk('prompt.submitted', { promptId: r.promptId, text: r.text })),
    fc
      .record({ promptId, uuid, text: prompt })
      .map((r) =>
        mk('prompt.recorded', { promptId: r.promptId, uuid: r.uuid, parentUuid: null, text: r.text, isMeta: false }, { uuid: r.uuid }),
      ),
    tool.map((t) => mk('tool.pre', { toolUseId: t.toolUseId, toolName: t.toolName, input: { command: t.command } })),
    tool.map((t) => mk('tool.post', { toolUseId: t.toolUseId, toolName: t.toolName, response: { stdout: 'ok' } })),
    fc
      .record({ t: tool, uuid })
      .map((r) => mk('tool.result', { toolUseId: r.t.toolUseId, isError: false, uuid: r.uuid }, { uuid: r.uuid })),
    fc.record({ hookSeq: fc.integer({ min: 1, max: 50 }), t: tool }).map((r) =>
      mk('permission.requested', {
        hookSeq: r.hookSeq as HookSeq,
        toolName: r.t.toolName,
        input: { command: r.t.command },
        suggestions: [],
      }),
    ),
    fc
      .record({ text: fc.string({ maxLength: 40 }) })
      .map((r) => mk('turn.stopped', { lastAssistantMessage: r.text, backgroundTasks: [], stopHookActive: false })),
    fc.nat(60_000).map((d) => mk('turn.durationRecorded', { durationMs: d, pendingBackgroundAgentCount: 0 })),
    fc.constantFrom<'request' | 'tool_use'>('request', 'tool_use').map((m) => mk('turn.interrupted', { marker: m })),
    fc
      .record({ delta: fc.string({ maxLength: 20 }), final: fc.boolean(), index: fc.nat(3) })
      .map((r) => mk('message.textDelta', { uiTurnId: 'ut1', uiMessageId: 'um1', index: r.index, final: r.final, delta: r.delta })),
    sf.map((f) => mk('screen.frame', f)),
    fc.constant(mk('clock.tick', {})),
    fc
      .record({ ok: fc.boolean(), id: fc.integer({ min: 1, max: 40 }) })
      .map((r) =>
        mk(
          'input.done',
          { intentId: r.id as IntentId, primitive: 'key', ok: r.ok },
          { origin: { kind: 'self', intentId: r.id as IntentId } },
        ),
      ),
    fc.constantFrom(...SOURCES_BY_DROPOUT).map((s) =>
      mk('channel.health', {
        channel: s === 'hook' ? 'hooks' : s === 'transcript' ? 'transcript' : s === 'network' ? 'network' : 'screen',
        health: 'degraded',
      }),
    ),
  );

  const sequence = (o: { minLength?: number; maxLength?: number; startAt?: number; maxGapMs?: number } = {}): Arb<Observation[]> =>
    fc
      .array(fc.tuple(observation, fc.nat(o.maxGapMs ?? 2000)), { minLength: o.minLength ?? 1, maxLength: o.maxLength ?? 40 })
      .map((pairs) => {
        let at = o.startAt ?? 1000;
        return pairs.map(([obs, gap], i) => {
          at += gap;
          return { ...obs, meta: { ...obs.meta, seq: (i + 1) as ObsSeq, at: at as MonoMs, wallAt: (1_793_000_000_000 + at) as WallMs } };
        });
      });

  return {
    sessionId,
    promptId,
    toolUseId,
    prompt,
    permissionDecision,
    command,
    screenFacts: sf,
    observation,
    sequence,
    jitterMs: fc.integer({ min: 0, max: 50 }),
  };
}

/**
 * Drop every observation from one channel (channel-dropout property, §6.2). `hook:<event>` drops one hook event type,
 * identified by `meta.origin.event` (or the kind when no origin is set).
 */
export function dropChannel(obs: readonly Observation[], what: Source | `hook:${string}`): Observation[] {
  if (what.startsWith('hook:')) {
    const ev = what.slice(5);
    return obs.filter((o) => !(o.meta.source === 'hook' && (o.meta.origin?.kind === 'hook' ? o.meta.origin.event : o.kind) === ev));
  }
  return obs.filter((o) => o.meta.source !== what);
}

/**
 * Add `ms` to every observation of `source` (delay-injection property: the channel is read later, so both its mono `at` and
 * its `wallAt` move); re-sorts by at, keeps the original order for equal at, renumbers seq.
 */
export function delayChannel(obs: readonly Observation[], source: Source, ms: number): Observation[] {
  const moved = obs.map((o) =>
    o.meta.source === source ? { ...o, meta: { ...o.meta, at: (o.meta.at + ms) as MonoMs, wallAt: (o.meta.wallAt + ms) as WallMs } } : o,
  );
  return moved
    .map((o, i) => ({ o, i }))
    .sort((a, b) => a.o.meta.at - b.o.meta.at || a.i - b.i)
    .map(({ o }, i) => ({ ...o, meta: { ...o.meta, seq: (i + 1) as ObsSeq } }));
}

/**
 * Inject an exact duplicate of observation `index` right after it (duplicate-injection property). Only transcript lines are
 * duplicated: hooks are not de-duplicated by design and their duplicates are never generated (§6.2), so for any other source
 * (or an out-of-range index) the sequence is returned unchanged apart from seq renumbering.
 */
export function duplicateAt(obs: readonly Observation[], index: number): Observation[] {
  const dup = obs[index]?.meta.source === 'transcript' ? index : -1;
  const out: Observation[] = [];
  obs.forEach((o, i) => {
    out.push(o);
    if (i === dup) out.push(o);
  });
  return out.map((o, i) => ({ ...o, meta: { ...o.meta, seq: (i + 1) as ObsSeq } }));
}

/**
 * The §6.2 permutation-convergence restriction on a pair, as far as it can be decided without the core: from different
 * sources within 250 ms, or two concurrent hooks within ±5 ms. (The third condition, "does not straddle a deadline", needs
 * `nextDeadline` and is checked by the property test with the core.)
 */
export function isConvergencePair(a: Observation, b: Observation): boolean {
  const dt = Math.abs(a.meta.at - b.meta.at);
  if (a.meta.source === 'hook' && b.meta.source === 'hook') return dt <= 5;
  return a.meta.source !== b.meta.source && dt <= 250;
}

/** Swap two adjacent observations (permutation-convergence property); seq is renumbered, at is kept non-decreasing. */
export function swapAdjacent(obs: readonly Observation[], index: number): Observation[] {
  const out = [...obs];
  const a = out[index];
  const b = out[index + 1];
  if (a === undefined || b === undefined) return out;
  out[index] = b;
  out[index + 1] = a;
  let at = 0;
  return out.map((o, i) => {
    at = Math.max(at, o.meta.at);
    return { ...o, meta: { ...o.meta, seq: (i + 1) as ObsSeq, at: at as MonoMs } };
  });
}

/**
 * Insert extra `clock.tick` observations at the given mono times (deadline-jitter property, §6.2: random extra ticks must not
 * change the result). Each tick takes the wall time of the observation before it plus the mono gap; seq is renumbered.
 */
export function insertTicks(obs: readonly Observation[], atTimes: readonly number[]): Observation[] {
  const ticks = [...atTimes].sort((x, y) => x - y);
  const out: Observation[] = [];
  let t = 0;
  let prevAt = obs[0]?.meta.at ?? 0;
  let prevWall = obs[0]?.meta.wallAt ?? 0;
  const tick = (at: number): Observation =>
    ({
      kind: 'clock.tick',
      meta: { seq: 0 as ObsSeq, at: at as MonoMs, wallAt: (prevWall + Math.max(0, at - prevAt)) as WallMs, source: 'clock' },
      p: {},
    }) as unknown as Observation;
  for (const o of obs) {
    while (t < ticks.length && (ticks[t] ?? Infinity) <= o.meta.at) out.push(tick(Math.max(prevAt, ticks[t++] ?? 0)));
    out.push(o);
    prevAt = o.meta.at;
    prevWall = o.meta.wallAt;
  }
  while (t < ticks.length) out.push(tick(Math.max(prevAt, ticks[t++] ?? 0)));
  return out.map((o, i) => ({ ...o, meta: { ...o.meta, seq: (i + 1) as ObsSeq } }));
}
