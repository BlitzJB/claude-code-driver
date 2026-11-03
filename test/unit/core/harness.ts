// test/unit/core/harness.ts — a deterministic driver for the pure core (WP-09 unit tests; no L3, no fakes).
// It stamps ObsSeq/time, feeds observations and commands through step(), collects events/intents, and can simulate the
// input executor (auto-acking primitives and echoing the editor-staged text into the next frame).

import { expect } from 'vitest';
import type { Command } from '../../../src/model/commands.js';
import type { CoreConfig, CoreInit } from '../../../src/model/config.js';
import type { Diagnostic } from '../../../src/model/debug.js';
import type { CoreEvent, DomainEvent } from '../../../src/model/events.js';
import type { HookSeq, ObsSeq, SessionKey } from '../../../src/model/ids.js';
import type { InputPrimitive, Intent } from '../../../src/model/intents.js';
import type { Observation, ObsMeta, Source } from '../../../src/model/observation.js';
import type { ScreenFacts } from '../../../src/model/screen-facts.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import type { EventOf } from '../../../src/core/ctx.js';
import { initialCore } from '../../../src/core/init.js';
import { stepDetailed } from '../../../src/core/step.js';
import type { CoreState, StepResult } from '../../../src/core/types.js';

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const WALL0 = 1_800_000_000_000;

export function testConfig(over: DeepPartial<CoreConfig> = {}): CoreConfig {
  const base: CoreConfig = {
    timeouts: {
      submitAckMs: 3000,
      submitAckFirstExtraMs: 2000,
      submitRetries: 1,
      settleMs: 100,
      escGapMs: 250,
      keyGapMs: 15,
      dialogSettleMs: 150,
      interruptConfirmMs: 5000,
      stopGraceMs: 500,
      transcriptSettleMs: 5000,
      permBindLateMs: 2000,
      hookGapMs: 2000,
      stallMs: 25000,
      quietMs: 15000,
      genImplicitConfirmMs: 3000,
      interruptedHoldMs: 1500,
      drainMs: 5000,
      startupHookGraceMs: 3000,
      startupMs: 60000,
      readyStableMs: 300,
      lateTextMs: 500,
      editorConsumeMs: 3000,
      claimTtlMs: 500,
      claimMinStableMs: 100,
      claimDialogStableMs: 250,
      hostResumeGraceMs: 30000,
      adoptDialogMs: 500,
      usageWakeCheckMs: 30000,
      authPollMs: 60000,
    },
    permissions: {
      policy: 'ask',
      timeoutMs: 120000,
      onTimeout: 'deny',
      screenAllow: false,
      allowDangerousModes: false,
      allowAddDirectories: false,
      backgroundTimeoutMs: 10000,
    },
    input: { method: 'editor', chunkBytes: 400, chunkGapMs: 30, maxPromptBytes: 100000, mentions: 'allow', whenBusyDefault: 'wait' },
    security: { onTamper: 'alert' },
    usage: { autoResume: true, resumePrompt: 'continue', jitterMinMs: 30000, jitterMaxMs: 90000, maxRearms: 3, builtinAutoContinue: false },
    commands: {
      allow: ['/clear', '/compact', '/model', '/effort', '/rename', '/context', '/usage', '/status', '/help'],
      deny: [
        '/permissions',
        '/hooks',
        '/config',
        '/settings',
        '/login',
        '/logout',
        '/add-dir',
        '/mcp',
        '/sandbox',
        '/terminal-setup',
        '/install-github-app',
        '/plugin',
        '/agents',
        '/bashes',
        '/vim',
        '/keybindings',
        '/doctor',
        '/upgrade',
        '/tui',
        '/restart',
        '/resume',
        '/exit',
        '/background',
        '/rate-limit-options',
        '/usage-credits',
      ],
      refuseAlways: ['/tui', '/restart', '/resume', '/exit', '/rewind'],
      aliases: { '/quit': '/exit', '/new': '/clear', '/reset': '/clear', '/cost': '/usage', '/stats': '/usage' },
    },
    channels: {
      screen: { busyPollMs: 250, idlePollMs: 2000, retryPollMs: 1000, startupPollMs: 150 },
      network: true,
      messageDisplay: true,
      preToolUse: true,
    },
    selfTest: 'once',
  };
  return merge(base, over);
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
function merge<T>(a: T, b: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    const cur = out[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object' && !Array.isArray(cur))
      out[k] = merge(cur, v as never);
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export function testInit(config: CoreConfig = testConfig(), o: Partial<CoreInit> = {}): CoreInit {
  return {
    sessionKey: 'sdeadbeef' as SessionKey,
    config,
    claudeVersion: '2.1.316',
    initialClaudeSessionId: SESSION_ID,
    resume: false,
    startedAt: 0 as MonoMs,
    wallAt: WALL0 as WallMs,
    cwdRealpath: '/work',
    ...o,
  };
}

/** Frame overrides; `undefined` removes the field (e.g. `composer: undefined` for a dialog frame). */
export type FrameOver = { [K in keyof ScreenFacts]?: ScreenFacts[K] | undefined };
export function frame(o: FrameOver = {}): ScreenFacts {
  const f: Record<string, unknown> = {
    surface: 'main',
    torn: false,
    altScreen: false,
    inCopyMode: false,
    paneWidth: 250,
    paneHeight: 80,
    frameHash: `h${JSON.stringify(o).length.toString(16)}:${JSON.stringify(o).slice(0, 32)}`,
    interruptedBanner: false,
    hookErrorLines: 0,
    agentPanelRows: 0,
    composer: { text: '', empty: true, placeholderLikely: false, pastedPlaceholder: false, notices: [] },
    footer: { busy: false, modeLabel: null, pasting: false, ctrlCExitArmed: false, hints: [] },
    ...o,
  };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `undefined` overrides remove the field
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f as unknown as ScreenFacts;
}
export const idleFrame = (o: FrameOver = {}): ScreenFacts => frame(o);
export const composerFrame = (text: string, o: FrameOver = {}): ScreenFacts =>
  frame({ composer: { text, empty: text === '', placeholderLikely: false, pastedPlaceholder: false, notices: [] }, ...o });
export const busyFrame = (o: FrameOver = {}): ScreenFacts =>
  frame({ footer: { busy: true, modeLabel: null, pasting: false, ctrlCExitArmed: false, hints: [] }, status: { kind: 'spinner' }, ...o });

type ObsKind = Observation['kind'];
type PayloadOf<K extends ObsKind> = Extract<Observation, { kind: K }>['p'];

export interface ExecOptions {
  /** answer every input intent with ok and simulate the editor echo (default true) */
  auto: boolean;
  /** frames returned when the core asks for a capture after an editor/paste step */
  echo: boolean;
}

export class Harness {
  core: CoreState;
  seq = 0;
  now = 0;
  wall = WALL0;
  hookSeq = 0;
  readonly events: DomainEvent[] = [];
  readonly coreEvents: CoreEvent[] = [];
  readonly intents: Intent[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly results: NonNullable<StepResult['commandResult']>[] = [];
  readonly init: CoreInit;
  exec: ExecOptions = { auto: false, echo: true };
  /** composer content as the simulated executor sees it */
  composer = '';
  /** extra frame overrides used by the simulated executor (e.g. footer mode after BTab) */
  onPrimitive?: ((p: InputPrimitive, h: Harness) => FrameOver | undefined) | undefined;
  /** primitives the executor ran, in order */
  readonly ran: InputPrimitive[] = [];
  private cmdId = 0;
  private pendingInputs: Intent[] = [];
  private inStep = false;

  constructor(config: CoreConfig = testConfig(), init: Partial<CoreInit> = {}) {
    this.init = testInit(config, init);
    this.core = initialCore(this.init);
  }

  private record(r: ReturnType<typeof stepDetailed>): void {
    this.core = r.core;
    this.events.push(...r.events);
    this.coreEvents.push(...r.coreEvents);
    this.intents.push(...r.intents);
    this.diagnostics.push(...r.diagnostics);
    if (r.commandResult !== undefined) this.results.push(r.commandResult);
    const bad = r.diagnostics.filter((d) => d.code === 'step_exception');
    expect(bad, JSON.stringify(bad)).toEqual([]);
    this.pendingInputs.push(...r.intents.filter((i) => i.kind === 'input'));
  }

  meta(source: Source, o: Partial<ObsMeta> = {}): ObsMeta {
    this.seq += 1;
    return { seq: this.seq as ObsSeq, at: this.now as MonoMs, wallAt: this.wall as WallMs, source, ...o };
  }

  obs<K extends ObsKind>(kind: K, p: PayloadOf<K>, source: Source = 'hook', meta: Partial<ObsMeta> = {}): this {
    const m = this.meta(source, meta);
    if (source === 'hook' && m.claudeSessionId === undefined && kind !== 'unknown')
      m.claudeSessionId = this.core.domain.claude.sessionId ?? SESSION_ID;
    if (source === 'hook' && m.origin === undefined) m.origin = { kind: 'hook', transport: 'http', event: kind, hookSeq: 0 as HookSeq };
    const o = { kind, meta: m, p } as unknown as Observation;
    this.record(stepDetailed(this.core, { type: 'obs', obs: o }));
    this.drainExec();
    return this;
  }

  hook<K extends ObsKind>(kind: K, p: PayloadOf<K>, event: string, meta: Partial<ObsMeta> = {}): this {
    return this.obs(kind, p, 'hook', {
      origin: {
        kind: 'hook',
        transport: event === 'SessionStart' || event === 'PermissionRequest' ? 'unix' : 'http',
        event,
        hookSeq: 0 as HookSeq,
      },
      ...meta,
    });
  }

  tx<K extends ObsKind>(kind: K, p: PayloadOf<K>, meta: Partial<ObsMeta> = {}): this {
    return this.obs(kind, p, 'transcript', meta);
  }

  screen(f: ScreenFacts): this {
    return this.obs('screen.frame', f, 'screen');
  }

  cmd(cmd: Command): NonNullable<StepResult['commandResult']> | undefined {
    this.cmdId += 1;
    const id = this.cmdId;
    const before = this.results.length;
    this.record(stepDetailed(this.core, { type: 'cmd', cmdId: id, cmd, at: this.now as MonoMs, wallAt: this.wall as WallMs }));
    this.drainExec();
    return this.results.slice(before).find((r) => r.cmdId === id);
  }
  lastCmdId(): number {
    return this.cmdId;
  }
  resultFor(id: number): NonNullable<StepResult['commandResult']> | undefined {
    return this.results.find((r) => r.cmdId === id);
  }

  /** Advance mono (and wall) time and deliver a clock.tick. */
  advance(ms: number, wallMs = ms): this {
    this.now += ms;
    this.wall += wallMs;
    return this.obs('clock.tick', {}, 'clock');
  }
  /** Advance in small ticks so every deadline fires at its own time. */
  run(ms: number, stepMs = 50): this {
    let left = ms;
    while (left > 0) {
      const d = Math.min(stepMs, left);
      this.advance(d);
      left -= d;
    }
    return this;
  }

  /** Report input.done for one input intent. */
  done(i: Intent, ok = true, extra: { output?: string; error?: never } = {}): this {
    if (i.kind !== 'input') return this;
    this.pendingInputs = this.pendingInputs.filter((x) => x !== i);
    const p: PayloadOf<'input.done'> = { intentId: i.id, job: i.job, primitive: i.primitive.kind, ok };
    if (extra.output !== undefined) p.output = extra.output;
    return this.obs('input.done', p, 'self', { origin: { kind: 'self', intentId: i.id } });
  }

  inputIntents(): Extract<Intent, { kind: 'input' }>[] {
    return this.intents.filter((i): i is Extract<Intent, { kind: 'input' }> => i.kind === 'input');
  }
  primitives(): InputPrimitive[] {
    return this.inputIntents().map((i) => i.primitive);
  }
  lastInput(): Extract<Intent, { kind: 'input' }> | undefined {
    const all = this.inputIntents();
    return all[all.length - 1];
  }

  private drainExec(): void {
    if (!this.exec.auto || this.inStep) return;
    this.inStep = true;
    try {
      for (let guard = 0; guard < 200 && this.pendingInputs.length > 0; guard++) {
        const i = this.pendingInputs.shift();
        if (i?.kind !== 'input') continue;
        const p = i.primitive;
        this.ran.push(p);
        let extra: FrameOver | undefined;
        if (p.kind === 'editorStage') this.composer = p.text;
        if (p.kind === 'pasteChunk') this.composer += p.text;
        if (p.kind === 'typeLiteral') this.composer = p.text;
        if (p.kind === 'key' && p.key === 'Escape') this.composer = '';
        if (this.onPrimitive !== undefined) extra = this.onPrimitive(p, this);
        const pd: PayloadOf<'input.done'> = { intentId: i.id, job: i.job, primitive: p.kind, ok: true };
        if (p.kind === 'captureText') pd.output = 'modal text';
        this.inStep = false;
        this.obs('input.done', pd, 'self', { origin: { kind: 'self', intentId: i.id } });
        this.inStep = true;
        if (
          this.exec.echo &&
          (p.kind === 'awaitEditorConsumed' ||
            p.kind === 'pasteChunk' ||
            p.kind === 'typeLiteral' ||
            (p.kind === 'key' && p.key === 'Escape') ||
            extra !== undefined)
        ) {
          this.inStep = false;
          this.advance(1);
          this.screen(composerFrame(this.composer, extra ?? {}));
          this.inStep = true;
        }
      }
    } finally {
      this.inStep = false;
    }
  }

  // ------------------------------------------------------------------ queries
  ev<T extends DomainEvent['type']>(type: T): EventOf<T>[] {
    return this.events.filter((e) => e.type === type) as EventOf<T>[];
  }
  intentsOf<K extends Intent['kind']>(kind: K): Extract<Intent, { kind: K }>[] {
    return this.intents.filter((i) => i.kind === kind) as Extract<Intent, { kind: K }>[];
  }
  get d(): CoreState['domain'] {
    return this.core.domain;
  }
  diag(code: string): Diagnostic[] {
    return this.diagnostics.filter((d) => d.code === code);
  }
  nextHookSeq(): HookSeq {
    this.hookSeq += 1;
    return this.hookSeq as HookSeq;
  }
}

/** Drive a fresh core to `ready` (SessionStart + stable idle composer + cached self-test). */
export function readyHarness(config: CoreConfig = testConfig(), init: Partial<CoreInit> = {}, o: { auto?: boolean } = {}): Harness {
  const h = new Harness(config, init);
  h.obs('process.launched', { pid: 4242, paneId: '%1', claudeVersion: '2.1.316', startTime: 'Mon Nov  3 10:00:00 2026' }, 'process');
  h.hook(
    'session.started',
    { sessionId: SESSION_ID, transcriptPath: '/cfg/projects/-work/s.jsonl', source: 'startup', model: 'claude-opus' },
    'SessionStart',
  );
  h.advance(10);
  h.screen(idleFrame());
  h.run(400);
  h.cmd({ type: 'selftest.run', nonce: 'ccd-selftest-0123456789abcdef0123456789abcdef', cachedPass: true });
  expect(h.d.lifecycle).toBe('ready');
  h.exec.auto = o.auto ?? true;
  return h;
}

/** A library prompt through the simulated executor up to the Enter (waiting for the UPS ack). */
export function sendUntilEnter(h: Harness, text: string): string {
  const r = h.cmd({ type: 'prompt.send', text, whenBusy: 'wait' });
  expect(r?.ok).toBe(true);
  const turnKey = (r as { value: { turnKey: string } }).value.turnKey;
  h.run(300);
  expect(h.primitives().some((p) => p.kind === 'key' && p.key === 'Enter')).toBe(true);
  return turnKey;
}

/** UPS for the prompt (ack). */
export function ups(h: Harness, text: string, promptId = 'p-1'): Harness {
  return h.hook('prompt.submitted', { promptId, text }, 'UserPromptSubmit');
}
