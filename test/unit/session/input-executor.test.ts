// WP-13 session/input-executor.ts (DESIGN.md §3.6, §2.6 InputPrimitive; P-TMUX-45, P-INPUT-12, P-INPUT-27, P-TUI-01,
// P-TUI-02, P-REV-45, ICR 0001 item 3d / LP-01 / LP-02).
import { describe, expect, it } from 'vitest';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';
import type { InputJobKey, IntentId } from '../../../src/model/ids.js';
import type { InputPrimitive } from '../../../src/model/intents.js';
import type { ObservationInput } from '../../../src/model/observation.js';
import { FakeClock, flushMicrotasks } from '../../../src/platform/clock/fake-clock.js';
import { FakeEditorInjector } from '../../../src/platform/editor/fake-editor.js';
import { FakeIds } from '../../../src/platform/ids/fake-ids.js';
import { TmuxPaneDead, TmuxPaneInMode } from '../../../src/platform/tmux/errors.js';
import { FakeTmux, type FakeTmuxPane } from '../../../src/platform/tmux/fake-tmux.js';
import {
  createInputExecutor,
  errorOf,
  modalText,
  validatePrimitive,
  type InputExecutor,
  type InputIntent,
} from '../../../src/session/input-executor.js';
import { modalFrame, permissionDialog } from '../../../src/testing/screens.js';

interface World {
  clock: FakeClock;
  tmux: FakeTmux;
  pane: FakeTmuxPane;
  editor: FakeEditorInjector;
  received: string[];
  out: ObservationInput[];
  exec: InputExecutor;
  paneRef: { current: FakeTmuxPane | undefined };
}

let intentSeq = 0;
function intent(primitive: InputPrimitive, job = 'j1'): InputIntent {
  intentSeq += 1;
  return { kind: 'input', id: intentSeq as IntentId, job: job as InputJobKey, step: intentSeq, primitive };
}

async function world(o: { redact?: (s: string) => string; neverConsume?: boolean; chunkGapMs?: number } = {}): Promise<World> {
  const clock = new FakeClock();
  const received: string[] = [];
  const tmux = new FakeTmux({
    clock,
    program: () => ({
      start: (io) => {
        io.setBracketedPaste(true);
      },
      input: (b) => {
        received.push(b);
      },
    }),
  });
  const server = await tmux.create({
    tmuxPath: '/opt/homebrew/bin/tmux',
    socketName: 'ccd-ut-exec',
    clientEnv: {},
    historyLimit: 2000,
    paneDiedLogPath: '/tmp/ccd-ut-exec-exits.log',
  });
  const pane = (await server.spawnPane({
    sessionName: 'ccd-ut',
    argv: ['/usr/bin/env', '/fake/claude.exe'],
    cwd: '/work',
    cols: 250,
    rows: 80,
    nonSecretEnv: {},
  })) as FakeTmuxPane;
  const editor = new FakeEditorInjector(clock, new FakeIds(), o.neverConsume === true ? { neverConsume: true } : {});
  await editor.setup('/rt/ccd-1', '/usr/local/bin/node');
  const out: ObservationInput[] = [];
  const paneRef: { current: FakeTmuxPane | undefined } = { current: pane };
  const exec = createInputExecutor({
    clock,
    pane: () => paneRef.current,
    editor,
    emit: (x) => out.push(x),
    profile,
    ...(o.redact !== undefined ? { redact: o.redact } : {}),
    ...(o.chunkGapMs !== undefined ? { chunkGapMs: o.chunkGapMs } : {}),
  });
  return { clock, tmux, pane, editor, received, out, exec, paneRef };
}

function doneOf(out: ObservationInput[]): Extract<ObservationInput, { kind: 'input.done' }>['p'][] {
  return out.filter((x): x is Extract<ObservationInput, { kind: 'input.done' }> => x.kind === 'input.done').map((x) => x.p);
}

/** Run an intent to completion while pumping the fake clock (gaps and editor polls use clock.sleep). */
async function run(w: World, i: InputIntent, advanceMs = 5000): Promise<void> {
  const p = w.exec.execute(i);
  await w.clock.advanceAsync(advanceMs);
  await p;
}

describe('input-executor: primitives and input.done', () => {
  it('key → one sendKey, input.done ok with intent id, job and primitive; meta source self', async () => {
    const w = await world();
    const i = intent({ kind: 'key', key: 'Enter', gapAfterMs: 15 });
    await run(w, i);
    expect(w.received).toEqual(['\r']);
    expect(doneOf(w.out)).toEqual([{ intentId: i.id, job: 'j1', primitive: 'key', ok: true }]);
    const meta = w.out[0]!.meta;
    expect(meta.source).toBe('self');
    expect(meta.origin).toEqual({ kind: 'self', intentId: i.id });
  });

  it('pasteChunk → bracketed paste of the exact text; typeLiteral → literal', async () => {
    const w = await world();
    await run(w, intent({ kind: 'pasteChunk', text: 'hello\nworld', bracketed: true }));
    await run(w, intent({ kind: 'typeLiteral', text: '/usage' }));
    expect(w.received).toEqual(['\u001b[200~hello\nworld\u001b[201~', '/usage']);
    expect(doneOf(w.out).map((d) => d.ok)).toEqual([true, true]);
  });

  it('runs intents strictly in arrival order, one at a time (single writer)', async () => {
    const w = await world();
    const ps = [
      w.exec.execute(intent({ kind: 'pasteChunk', text: 'a', bracketed: true })),
      w.exec.execute(intent({ kind: 'key', key: 'Escape', gapAfterMs: 0 })),
      w.exec.execute(intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 })),
    ];
    expect(w.exec.pending()).toBe(3);
    await w.clock.advanceAsync(1000);
    await Promise.all(ps);
    expect(w.pane.inputs.map((x) => x.kind + (x.key ?? ''))).toEqual(['paste', 'keyEscape', 'keyEnter']);
    expect(w.exec.pending()).toBe(0);
  });

  it('holds gapAfterMs before the next primitive, but reports input.done right away', async () => {
    const w = await world();
    const a = intent({ kind: 'key', key: 'BTab', gapAfterMs: 500 });
    const b = intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 });
    const pa = w.exec.execute(a);
    const pb = w.exec.execute(b);
    await w.clock.advanceAsync(0);
    expect(doneOf(w.out).map((d) => d.intentId)).toEqual([a.id]);
    expect(w.received).toEqual(['\u001b[Z']);
    await w.clock.advanceAsync(499);
    expect(w.received).toEqual(['\u001b[Z']);
    await w.clock.advanceAsync(2);
    await Promise.all([pa, pb]);
    expect(w.received).toEqual(['\u001b[Z', '\r']);
  });

  it('P-REV-45: at least escGapMs (250) after every Escape even if the intent asks for less', async () => {
    const w = await world();
    const pa = w.exec.execute(intent({ kind: 'key', key: 'Escape', gapAfterMs: 10 }));
    const pb = w.exec.execute(intent({ kind: 'key', key: '1', gapAfterMs: 0 }));
    await w.clock.advanceAsync(100);
    expect(w.received).toEqual(['\u001b']);
    await w.clock.advanceAsync(200);
    await Promise.all([pa, pb]);
    expect(w.received).toEqual(['\u001b', '1']);
    const [esc, one] = w.pane.inputs;
    expect(one!.at - esc!.at).toBeGreaterThanOrEqual(250);
  });

  it('P-TUI-01: a paste and the following key are separate invocations spaced by chunkGapMs', async () => {
    const w = await world({ chunkGapMs: 30 });
    const ps = [
      w.exec.execute(intent({ kind: 'pasteChunk', text: 'x', bracketed: true })),
      w.exec.execute(intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 })),
    ];
    await w.clock.advanceAsync(100);
    await Promise.all(ps);
    const [paste, enter] = w.pane.inputs;
    expect(paste!.kind).toBe('paste');
    expect(enter!.kind).toBe('key');
    expect(enter!.at - paste!.at).toBeGreaterThanOrEqual(30);
  });
});

describe('input-executor: validation before tmux (defense in depth)', () => {
  const cases: [string, InputPrimitive, string][] = [
    ['key outside the closed list', { kind: 'key', key: 'C-c' as 'Enter', gapAfterMs: 0 }, 'keyNotAllowed'],
    ['Tab is never sent', { kind: 'key', key: 'Tab' as 'Enter', gapAfterMs: 0 }, 'keyNotAllowed'],
    ['negative gap', { kind: 'key', key: 'Enter', gapAfterMs: -1 }, 'bad:gapAfterMs'],
    ['paste > 400 bytes', { kind: 'pasteChunk', text: 'é'.repeat(201), bracketed: true }, 'pasteTooLong'],
    ['paste with 3 LF', { kind: 'pasteChunk', text: 'a\nb\nc\nd', bracketed: true }, 'pasteTooManyLines'],
    ['paste with ESC', { kind: 'pasteChunk', text: 'a\u001b[31m', bracketed: true }, 'controlChar'],
    ['paste with CR', { kind: 'pasteChunk', text: 'a\rb', bracketed: true }, 'controlChar'],
    ['unbracketed paste', { kind: 'pasteChunk', text: 'a', bracketed: false as true }, 'pasteNotBracketed'],
    ['lone surrogate', { kind: 'pasteChunk', text: 'a\ud800', bracketed: true }, 'notWellFormed'],
    ['literal > 200 bytes', { kind: 'typeLiteral', text: 'x'.repeat(201) }, 'literalTooLong'],
    ['literal with LF', { kind: 'typeLiteral', text: '/clear\n' }, 'controlChar'],
    ['literal with TAB', { kind: 'typeLiteral', text: '/cl\t' }, 'controlChar'],
    ['bad rows', { kind: 'captureText', rows: 'all' as 'modal' }, 'badRows'],
    ['unknown primitive', { kind: 'sendRaw' } as unknown as InputPrimitive, 'unknownPrimitive'],
  ];
  for (const [name, prim, detail] of cases)
    it(`refuses ${name} with E_INPUT_INVALID and sends nothing`, async () => {
      const w = await world();
      await run(w, intent(prim));
      expect(w.received).toEqual([]);
      expect(w.tmux.invocations.filter((x) => x.op === 'sendKey' || x.op === 'paste' || x.op === 'typeLiteral')).toEqual([]);
      expect(doneOf(w.out)).toEqual([expect.objectContaining({ ok: false, error: 'E_INPUT_INVALID', detail })]);
    });

  it('accepts the exact limits (400 bytes, 2 LF, 200-byte literal, every allowed key)', () => {
    expect(() => {
      validatePrimitive({ kind: 'pasteChunk', text: `${'a'.repeat(398)}\n\n`, bracketed: true });
      validatePrimitive({ kind: 'typeLiteral', text: 'x'.repeat(200) });
      for (const k of ['Enter', 'Escape', 'BTab', 'Up', 'Down', 'C-g', '1', '9'] as const)
        validatePrimitive({ kind: 'key', key: k, gapAfterMs: 0 });
      validatePrimitive({ kind: 'pasteChunk', text: 'tab\there', bracketed: true });
    }).not.toThrow();
  });
});

describe('input-executor: pane state before input (P-TMUX-21, P-TMUX-45)', () => {
  it('copy mode → exitCopyMode first, then the key is delivered', async () => {
    const w = await world();
    w.pane.enterCopyMode();
    await run(w, intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
    const ops = w.tmux.invocations.map((x) => x.op).filter((x) => x !== 'status');
    expect(ops.slice(-2)).toEqual(['exitCopyMode', 'sendKey']);
    expect(w.received).toEqual(['\r']);
    expect(doneOf(w.out)[0]!.ok).toBe(true);
  });

  it('dead pane → E_SESSION_EXITED{paneDead}, nothing sent', async () => {
    const w = await world();
    w.pane.exitPane({ status: 1 });
    await run(w, intent({ kind: 'pasteChunk', text: 'x', bracketed: true }));
    expect(w.received).toEqual([]);
    expect(doneOf(w.out)[0]).toMatchObject({ ok: false, error: 'E_SESSION_EXITED', detail: 'paneDead' });
  });

  it('gone pane → E_SESSION_EXITED{paneGone}; no pane yet → E_SESSION_EXITED{noPane}', async () => {
    const w = await world();
    w.pane.vanishPane();
    await run(w, intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
    w.paneRef.current = undefined;
    await run(w, intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
    expect(doneOf(w.out).map((d) => d.detail)).toEqual(['paneGone', 'noPane']);
  });

  it('an adapter error maps through its suggestedCode; detail is the error kind, never message text', async () => {
    const w = await world();
    w.tmux.failNext('sendKey', new TmuxPaneDead('%1', 0, null));
    await run(w, intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
    expect(doneOf(w.out)[0]).toMatchObject({ ok: false, error: 'E_SESSION_EXITED', detail: 'TmuxPaneDead' });
    expect(errorOf(new Error('secret prompt text'))).toEqual({ code: 'E_INPUT_GATED', detail: 'Error' });
    expect(errorOf('x')).toEqual({ code: 'E_INPUT_GATED', detail: 'unknownError' });
  });

  it('extended-keys pane (LP-52) refuses input with E_TMUX_UNSUPPORTED', async () => {
    const w = await world();
    w.tmux.lastServer()!.setKeyMode('VT10x+ext');
    await run(w, intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
    expect(doneOf(w.out)[0]).toMatchObject({ ok: false, error: 'E_TMUX_UNSUPPORTED' });
    expect(w.received).toEqual([]);
  });

  it('copy mode entered between the status check and the send (TmuxPaneInMode race) → leave it and retry once', async () => {
    const w = await world();
    w.tmux.failNext('sendKey', new TmuxPaneInMode('%1'));
    await run(w, intent({ kind: 'key', key: 'Escape', gapAfterMs: 0 }));
    expect(w.received).toEqual(['\u001b']);
    expect(doneOf(w.out)[0]).toMatchObject({ ok: true });
  });

  it('the race twice in a row fails with E_INPUT_GATED (one retry only), nothing sent', async () => {
    const w = await world();
    w.tmux.failNext('paste', new TmuxPaneInMode('%1'));
    w.tmux.failNext('paste', new TmuxPaneInMode('%1'));
    await run(w, intent({ kind: 'pasteChunk', text: 'x', bracketed: true }));
    expect(w.received).toEqual([]);
    expect(doneOf(w.out)[0]).toMatchObject({ ok: false, error: 'E_INPUT_GATED', detail: 'TmuxPaneInMode' });
  });

  it('exitCopyMode primitive leaves copy mode only when in it', async () => {
    const w = await world();
    await run(w, intent({ kind: 'exitCopyMode' }));
    expect(w.tmux.invocations.some((x) => x.op === 'exitCopyMode')).toBe(false);
    w.pane.enterCopyMode();
    await run(w, intent({ kind: 'exitCopyMode' }));
    expect(w.tmux.invocations.filter((x) => x.op === 'exitCopyMode')).toHaveLength(1);
    expect(doneOf(w.out).every((d) => d.ok)).toBe(true);
  });
});

describe('input-executor: editor handoff (D-15, LP-01, LP-02)', () => {
  it('editorStage stages the text; awaitEditorConsumed resolves ok once the editor consumed the nonce', async () => {
    const w = await world();
    await run(w, intent({ kind: 'editorStage', text: 'fix the bug\nplease' }));
    expect(w.editor.staged).toEqual(['fix the bug\nplease']);
    expect(w.exec.editorPhase()).toBe(true);
    await run(w, intent({ kind: 'key', key: 'C-g', gapAfterMs: 50 }));
    expect(w.exec.editorPhase()).toBe(true);
    const p = w.exec.execute(intent({ kind: 'awaitEditorConsumed', timeoutMs: 3000 }));
    await w.clock.advanceAsync(20);
    expect(w.exec.awaitingEditor()).toBe(true);
    w.editor.runEditor('');
    await w.clock.advanceAsync(50);
    await p;
    expect(w.exec.awaitingEditor()).toBe(false);
    expect(w.exec.editorPhase()).toBe(false);
    expect(doneOf(w.out).map((d) => [d.primitive, d.ok])).toEqual([
      ['editorStage', true],
      ['key', true],
      ['awaitEditorConsumed', true],
    ]);
  });

  it('editor never consumes → E_SUBMIT_UNCONFIRMED{editorTimeout} and the injector is disarmed', async () => {
    const w = await world({ neverConsume: true });
    await run(w, intent({ kind: 'editorStage', text: 'x' }));
    await run(w, intent({ kind: 'awaitEditorConsumed', timeoutMs: 3000 }), 4000);
    expect(doneOf(w.out)[1]).toMatchObject({ ok: false, error: 'E_SUBMIT_UNCONFIRMED', detail: 'editorTimeout' });
    expect(w.editor.disarms).toBeGreaterThan(0);
    expect(w.exec.awaitingEditor()).toBe(false);
  });

  it('ICR 0018: awaitEditorConsumed holds the handoff until Claude left the editor’s alternate screen (LP-01)', async () => {
    const w = await world();
    await run(w, intent({ kind: 'editorStage', text: 'x' }));
    w.pane.setAlternate(true); // C-g: Claude is on the alternate screen while the editor runs
    const p = w.exec.execute(intent({ kind: 'awaitEditorConsumed', timeoutMs: 3000 }));
    let settled = false;
    void p.then(() => (settled = true));
    await w.clock.advanceAsync(20);
    w.editor.runEditor(''); // done-<nonce> exists, but Claude has not reaped the editor / sent ESC[?1049l yet
    await w.clock.advanceAsync(200);
    expect(settled).toBe(false);
    expect(w.exec.awaitingEditor()).toBe(true); // pollers still must not capture
    expect(doneOf(w.out).map((d) => d.primitive)).toEqual(['editorStage']);
    w.pane.setAlternate(false);
    await w.clock.advanceAsync(20);
    await p;
    expect(w.exec.awaitingEditor()).toBe(false);
    expect(doneOf(w.out)[1]).toMatchObject({ primitive: 'awaitEditorConsumed', ok: true });
  });

  it('ICR 0018: the alternate-screen wait is bounded by the awaitEditorConsumed budget', async () => {
    const w = await world();
    await run(w, intent({ kind: 'editorStage', text: 'x' }));
    w.pane.setAlternate(true);
    const p = w.exec.execute(intent({ kind: 'awaitEditorConsumed', timeoutMs: 1000 }));
    let settled = false;
    void p.then(() => (settled = true));
    await w.clock.advanceAsync(20);
    w.editor.runEditor('');
    await w.clock.advanceAsync(900);
    expect(settled).toBe(false);
    await w.clock.advanceAsync(200);
    await p;
    // ok: the text was consumed; the core's verifyStaged frame decides (editorOpen → not staged → fallback)
    expect(doneOf(w.out)[1]).toMatchObject({ primitive: 'awaitEditorConsumed', ok: true });
    expect(w.exec.awaitingEditor()).toBe(false);
  });

  it('awaitEditorConsumed without a staged text fails without waiting', async () => {
    const w = await world();
    await run(w, intent({ kind: 'awaitEditorConsumed', timeoutMs: 3000 }), 0);
    expect(doneOf(w.out)[0]).toMatchObject({ ok: false, error: 'E_SUBMIT_UNCONFIRMED', detail: 'editorNotStaged' });
  });

  it('LP-02: an Enter queued behind awaitEditorConsumed is sent only after the editor finished', async () => {
    const w = await world();
    await run(w, intent({ kind: 'editorStage', text: 'x' }));
    const pa = w.exec.execute(intent({ kind: 'awaitEditorConsumed', timeoutMs: 3000 }));
    const pb = w.exec.execute(intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
    await w.clock.advanceAsync(500);
    expect(w.received).toEqual([]);
    let idle = false;
    void w.exec.whenEditorIdle().then(() => {
      idle = true;
    });
    w.editor.runEditor('');
    await w.clock.advanceAsync(50);
    await Promise.all([pa, pb]);
    expect(idle).toBe(true);
    expect(w.received).toEqual(['\r']);
  });

  it('a non-editor primitive ends a stale editor phase (fallback paths)', async () => {
    const w = await world();
    await run(w, intent({ kind: 'editorStage', text: 'x' }));
    expect(w.exec.editorPhase()).toBe(true);
    await run(w, intent({ kind: 'pasteChunk', text: 'x', bracketed: true }));
    expect(w.exec.editorPhase()).toBe(false);
  });

  it('whenEditorIdle resolves immediately when nothing is pending', async () => {
    const w = await world();
    await expect(w.exec.whenEditorIdle()).resolves.toBeUndefined();
  });
});

describe('input-executor: captureText (slash.run modal output)', () => {
  it('returns the modal text, redacted, ≤ 16 KiB', async () => {
    const w = await world({ redact: (s) => s.replace(/sk-ant-\S+/gu, '[REDACTED]') });
    w.pane.setScreen(modalFrame({ title: 'Usage', body: ['Current session: 12%', 'token sk-ant-api03-abc'] }));
    await run(w, intent({ kind: 'captureText', rows: 'modal' }));
    const d = doneOf(w.out)[0]!;
    expect(d.ok).toBe(true);
    expect(d.output).toContain('Current session: 12%');
    expect(d.output).toContain('[REDACTED]');
    expect(d.output).not.toContain('sk-ant');
    expect(d.output!.startsWith('\n')).toBe(false);
  });

  it('ICR 0040: until usageReady re-captures the open modal until the criterion holds, not a fixed delay', async () => {
    const w = await world();
    const loading = ['Current session', '0% used', 'Current week (all models)', '98% used', 'Refreshing…'];
    const ready = ['Current session', '0% used', 'Current week (all models)', '98% used', 'Current week (Fable)', '56% used'];
    w.pane.setScreen(modalFrame({ title: 'Usage', body: loading }));
    const p = w.exec.execute(intent({ kind: 'captureText', rows: 'modal', until: 'usageReady', timeoutMs: 5000 }));
    await w.clock.advanceAsync(400); // still refreshing: no result yet
    expect(doneOf(w.out)).toHaveLength(0);
    w.pane.setScreen(modalFrame({ title: 'Usage', body: ready }));
    await w.clock.advanceAsync(200); // next poll sees the criterion met
    await p;
    const d = doneOf(w.out)[0]!;
    expect(d.ok).toBe(true);
    expect(d.output).toContain('Current week (Fable)');
    expect(d.output).not.toContain('Refreshing');
  });

  it('ICR 0040: until usageReady returns the last capture when the timeout passes first', async () => {
    const w = await world();
    w.pane.setScreen(modalFrame({ title: 'Usage', body: ['Current session', '0% used', 'Refreshing…'] }));
    const p = w.exec.execute(intent({ kind: 'captureText', rows: 'modal', until: 'usageReady', timeoutMs: 1000 }));
    await w.clock.advanceAsync(1200);
    await p;
    const d = doneOf(w.out)[0]!;
    expect(d.ok).toBe(true);
    expect(d.output).toContain('Refreshing…');
  });

  it('ICR 0040: a modal that is already ready returns from the first capture', async () => {
    const w = await world();
    w.pane.setScreen(modalFrame({ title: 'Usage', body: ['Current session', '3% used'] }));
    const before = w.tmux.invocations.filter((x) => x.op === 'capture').length;
    await run(w, intent({ kind: 'captureText', rows: 'modal', until: 'usageReady', timeoutMs: 5000 }));
    expect(w.tmux.invocations.filter((x) => x.op === 'capture').length - before).toBe(1);
    expect(doneOf(w.out)[0]!.output).toContain('3% used');
  });

  it('P-TMUX-45: captureText in copy mode leaves copy mode first and reports the live modal, not scrollback', async () => {
    const w = await world();
    w.pane.setScreen(modalFrame({ title: 'Usage', body: ['Current session: 12%'] }));
    w.pane.enterCopyMode();
    await run(w, intent({ kind: 'captureText', rows: 'modal' }));
    expect(w.tmux.invocations.filter((x) => x.op === 'exitCopyMode')).toHaveLength(1);
    const d = doneOf(w.out)[0]!;
    expect(d).toMatchObject({ ok: true });
    expect(d.output).toContain('Current session: 12%');
  });

  it('captureText on a dead pane → E_SESSION_EXITED{paneDead}, no output', async () => {
    const w = await world();
    w.pane.exitPane({ status: 0 });
    await run(w, intent({ kind: 'captureText', rows: 'modal' }));
    const d = doneOf(w.out)[0]!;
    expect(d).toMatchObject({ ok: false, error: 'E_SESSION_EXITED', detail: 'paneDead' });
    expect(d.output).toBeUndefined();
  });

  it('caps the output at 16 KiB', async () => {
    const w = await world({ redact: () => 'y'.repeat(20_000) });
    await run(w, intent({ kind: 'captureText', rows: 'modal' }));
    expect(doneOf(w.out)[0]!.output).toHaveLength(16 * 1024);
  });

  it('modalText uses the classified dialog when there is one', () => {
    const lines = permissionDialog({ description: 'List files', command: 'ls -la', cwd: '/work' });
    const st = {
      exists: true,
      dead: false,
      exitStatus: null,
      exitSignal: null,
      inMode: false,
      alternateOn: false,
      cursorX: 0,
      cursorY: 0,
      cols: 250,
      rows: 80,
      historySize: 0,
    };
    const t = modalText([...lines, ...Array.from({ length: 80 - lines.length }, () => '')], st, profile);
    expect(t).toContain('Do you want to proceed?');
    expect(t.split('\n').some((l) => l.startsWith('1. Yes') || l.includes('Yes'))).toBe(true);
  });
});

describe('input-executor: close', () => {
  it('drops queued intents, aborts gaps, disarms the editor, emits nothing afterwards', async () => {
    const w = await world();
    const pa = w.exec.execute(intent({ kind: 'key', key: 'Escape', gapAfterMs: 250 }));
    const pb = w.exec.execute(intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
    await flushMicrotasks();
    await w.exec.close();
    await w.clock.advanceAsync(1000);
    await Promise.all([pa, pb]);
    expect(w.received).toEqual(['\u001b']);
    expect(doneOf(w.out)).toHaveLength(1);
    expect(w.editor.disarms).toBe(1);
    await w.exec.execute(intent({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
    expect(doneOf(w.out)).toHaveLength(1);
    await w.exec.close();
    expect(w.editor.disarms).toBe(1);
  });
});
