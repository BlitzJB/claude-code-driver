// core/input-policy/machine.ts — §3.6 input protocols: submit (editor, pasteChunks), commands, interrupt, clearComposer,
// setMode, copy mode (K-07, K-33, K-34, K-35), ICR 0001 items 3 and 6.
import { describe, expect, it } from 'vitest';
import type { InputPrimitive } from '../../../src/model/intents.js';
import { checkSlash, canonicalCommand } from '../../../src/core/decide/commands.js';
import { stagedOk } from '../../../src/core/input-policy/machine.js';
import type { Harness } from './harness.js';
import { busyFrame, composerFrame, frame, idleFrame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

const keys = (h: Harness): string[] =>
  h
    .primitives()
    .map((p) =>
      p.kind === 'key' ? p.key : p.kind === 'editorStage' ? `stage:${p.text}` : p.kind === 'typeLiteral' ? `type:${p.text}` : p.kind,
    );

describe('submit, editor method (§3.6 steps 1–4)', () => {
  it('editorStage → C-g (gap 50) → awaitEditorConsumed → verify → settle → Enter', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'hello');
    expect(h.primitives()).toEqual<InputPrimitive[]>([
      { kind: 'editorStage', text: 'hello' },
      { kind: 'key', key: 'C-g', gapAfterMs: 50 },
      { kind: 'awaitEditorConsumed', timeoutMs: 3000 },
      { kind: 'key', key: 'Enter', gapAfterMs: 15 },
    ]);
    expect(h.intentsOf('screen.captureNow').some((i) => i.reason === 'job:verifyStaged')).toBe(true);
  });

  it('a verify mismatch falls back once to pasteChunks (clearing the composer first)', () => {
    const h = readyHarness();
    h.onPrimitive = (p) =>
      p.kind === 'awaitEditorConsumed'
        ? { composer: { text: 'garbage', empty: false, placeholderLikely: false, pastedPlaceholder: false, notices: [] } }
        : undefined;
    h.cmd({ type: 'prompt.send', text: 'the real prompt', whenBusy: 'wait' });
    h.composer = 'garbage';
    h.onPrimitive = undefined;
    h.run(2000);
    const k = keys(h);
    expect(k.slice(0, 3)).toEqual(['stage:the real prompt', 'C-g', 'awaitEditorConsumed']);
    expect(k).toContain('pasteChunk');
    expect(h.diag('editor_fallback')).toHaveLength(1);
  });

  it('stagedOk: tail match for short texts, placeholder = collapsed, unknown without a composer', () => {
    expect(stagedOk('hello world', composerFrame('hello world'))).toBe('ok');
    expect(stagedOk('hello world', composerFrame('hello   wor\nld'))).toBe('ok');
    expect(stagedOk('hello world', composerFrame('nope'))).toBe('mismatch');
    expect(stagedOk('x', composerFrame(''))).toBe('mismatch');
    expect(
      stagedOk(
        'x',
        frame({ composer: { text: '[Pasted text #1]', empty: false, placeholderLikely: false, pastedPlaceholder: true, notices: [] } }),
      ),
    ).toBe('collapsed');
    expect(stagedOk('x', frame({ composer: undefined }))).toBe('unknown');
    expect(stagedOk('a'.repeat(300), composerFrame('anything'))).toBe('ok');
  });
});

describe('submit, pasteChunks method (§3.6, D-15)', () => {
  it('chunks ≤ 400 bytes, 30 ms apart, verify, Enter', () => {
    const h = readyHarness(testConfig({ input: { method: 'pasteChunks' } }));
    const text = 'x'.repeat(900);
    h.cmd({ type: 'prompt.send', text, whenBusy: 'wait' });
    h.run(1500, 10);
    const chunks = h.primitives().filter((p) => p.kind === 'pasteChunk');
    expect(chunks.map((c) => (c as { text: string }).text.length)).toEqual([400, 400, 100]);
    expect(chunks.every((c) => (c as { bracketed: boolean }).bracketed)).toBe(true);
    expect(keys(h).at(-1)).toBe('Enter');
  });

  it('a collapsed paste placeholder → clear and E_SUBMIT_UNCONFIRMED{step:"collapse"}', () => {
    const h = readyHarness(testConfig({ input: { method: 'pasteChunks' } }));
    h.onPrimitive = (p) =>
      p.kind === 'pasteChunk'
        ? { composer: { text: '[Pasted text #1 +40 lines]', empty: false, placeholderLikely: false, pastedPlaceholder: true, notices: [] } }
        : undefined;
    h.cmd({ type: 'prompt.send', text: 'short', whenBusy: 'wait' });
    h.run(1000);
    expect(h.d.turns['t1' as never]?.error).toMatchObject({ code: 'E_SUBMIT_UNCONFIRMED', details: { step: 'collapse' } });
    expect(keys(h)).toContain('Escape');
  });
});

describe('ack handling (§3.6 steps 5–6)', () => {
  it('an external-shape UPS while ours is in flight creates an external turn and extends our ack once (K-25)', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'mine');
    const before = Object.values(h.core.recon.deadlines).find((d) => d.kind === 'submitAck')?.at ?? 0;
    h.advance(1000);
    h.hook(
      'prompt.submitted',
      { promptId: 'pt', text: '<task-notification>t</task-notification>', taskNotification: { taskId: 'x', status: 'completed' } },
      'UserPromptSubmit',
    );
    const after = Object.values(h.core.recon.deadlines).find((d) => d.kind === 'submitAck')?.at ?? 0;
    expect(after).toBe(h.now + 3000);
    expect(after).toBeGreaterThan(before - 2000);
    expect(h.d.turns['t2' as never]?.origin.value).toBe('task_notification');
    // the external turn ends; our ack then arrives normally
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false }, 'Stop');
    ups(h, 'mine', 'p-mine');
    expect(h.d.turns['t1' as never]?.state.value).toBe('running');
    expect(h.d.turns['t1' as never]?.mergedInto).toBeUndefined();
  });

  it.each<['invisibleChars' | 'unknownCommand' | 'blockedByHook', string]>([
    ['invisibleChars', 'E_INPUT_INVALID'],
    ['unknownCommand', 'E_INPUT_REJECTED'],
    ['blockedByHook', 'E_TURN_BLOCKED_BY_HOOK'],
  ])('ack deadline with composer notice %s → %s', (notice, code) => {
    const h = readyHarness();
    sendUntilEnter(h, 'hi');
    h.onPrimitive = undefined;
    h.run(4000);
    h.screen(frame({ composer: { text: 'hi', empty: false, placeholderLikely: false, pastedPlaceholder: false, notices: [notice] } }));
    h.run(2000);
    expect(h.d.turns['t1' as never]?.error?.code).toBe(code);
  });

  it('transcript prompt.blocked for our text (ICR 0002) → E_TURN_BLOCKED_BY_HOOK and a composer clear', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'blocked one');
    h.composer = 'blocked one';
    h.tx('prompt.blocked', { reason: 'policy', text: 'blocked one' }, { uuid: 'pb' });
    expect(h.d.turns['t1' as never]?.error).toMatchObject({ code: 'E_TURN_BLOCKED_BY_HOOK', details: { source: 'transcript' } });
    h.run(1000);
    expect(keys(h)).toContain('Escape');
  });

  it('composer empty at the ack deadline + a matching transcript prompt.recorded within hookGap → accepted, hooks degraded', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'silent hooks');
    h.composer = '';
    h.screen(composerFrame(''));
    h.run(5800);
    expect(h.d.turns['t1' as never]?.state.value).toBe('submitting');
    h.tx('prompt.recorded', { uuid: 'ur', parentUuid: null, text: 'silent hooks', isMeta: false, promptId: 'pr' }, { uuid: 'ur' });
    expect(h.d.turns['t1' as never]?.state.value).toBe('running');
    expect(h.d.channels.hooks.reasons).toContain('hookGap:UserPromptSubmit');
  });

  it('composer empty and no evidence → E_SUBMIT_UNCONFIRMED after hookGap', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'void');
    h.composer = '';
    h.screen(composerFrame(''));
    h.run(5800 + 2600);
    expect(h.d.turns['t1' as never]?.state.value).toBe('notSubmitted');
  });
});

describe('commands (§3.6 Commands, P-REV-02, ICR 0001 item 6, K-34)', () => {
  const c = testConfig().commands;
  it('canonicalises aliases: /quit→/exit, /new,/reset→/clear, /cost,/stats→/usage', () => {
    expect(canonicalCommand('/quit', c.aliases)).toBe('/exit');
    expect(canonicalCommand('/new', c.aliases)).toBe('/clear');
    expect(canonicalCommand('/reset', c.aliases)).toBe('/clear');
    expect(canonicalCommand('/cost', c.aliases)).toBe('/usage');
    expect(canonicalCommand('/stats', c.aliases)).toBe('/usage');
  });
  it('refuses /exit, /quit, /tui, /restart, /resume, /rewind even with unsafe; /permissions needs unsafe; /cost is allowed as /usage', () => {
    for (const n of ['/exit', '/quit', '/tui', '/restart', '/resume', '/rewind']) {
      expect(checkSlash(n, true, c)).toMatchObject({ ok: false, error: { code: 'E_COMMAND_FORBIDDEN', details: { reason: 'refused' } } });
    }
    expect(checkSlash('/permissions', false, c)).toMatchObject({ ok: false, error: { details: { reason: 'denied' } } });
    expect(checkSlash('/permissions', true, c)).toMatchObject({ ok: true, canonical: '/permissions' });
    expect(checkSlash('/frobnicate', false, c)).toMatchObject({ ok: false, error: { details: { reason: 'notAllowed' } } });
    expect(checkSlash('/cost', false, c)).toEqual({ ok: true, canonical: '/usage' });
    expect(checkSlash('/Bad', false, c)).toMatchObject({ ok: false, error: { code: 'E_INPUT_INVALID' } });
    // even an empty alias table cannot let /quit through
    expect(checkSlash('/quit', true, { ...c, aliases: {}, refuseAlways: [] })).toMatchObject({ ok: false });
  });

  it('/new is staged as the canonical /clear; evidence = SessionEnd(clear) + SessionStart(clear) → {effect:"evidence"}', () => {
    const h = readyHarness();
    h.cmd({ type: 'slash.run', name: '/new' });
    const id = h.lastCmdId();
    h.run(300);
    expect(keys(h)[0]).toBe('stage:/clear');
    expect(h.resultFor(id)).toBeUndefined();
    h.hook('session.ended', { sessionId: h.d.claude.sessionId ?? '', reason: 'clear' }, 'SessionEnd');
    h.hook('session.started', { sessionId: 'n2', transcriptPath: '/n2.jsonl', source: 'clear' }, 'SessionStart', { claudeSessionId: 'n2' });
    expect(h.resultFor(id)).toMatchObject({ ok: true, value: { ok: true, effect: 'evidence' } });
  });

  it('a local command returns its stdout as output (transcript system:local_command)', () => {
    const h = readyHarness();
    h.cmd({ type: 'slash.run', name: '/cost' });
    const id = h.lastCmdId();
    h.run(300);
    expect(keys(h)[0]).toBe('stage:/usage');
    h.tx(
      'prompt.recorded',
      { uuid: 'lc', parentUuid: null, isMeta: false, localCommand: { name: '/usage', stdout: 'Total cost: $0' } },
      { uuid: 'lc' },
    );
    expect(h.resultFor(id)).toMatchObject({ ok: true, value: { effect: 'evidence', output: 'Total cost: $0' } });
  });

  it('a modal command: captureText then one Escape → {effect:"modal", output}', () => {
    const h = readyHarness();
    h.cmd({ type: 'slash.run', name: '/status' });
    const id = h.lastCmdId();
    h.run(300);
    h.screen(frame({ surface: 'modal', composer: undefined }));
    h.run(500);
    expect(keys(h).slice(-2)).toEqual(['captureText', 'Escape']);
    expect(h.resultFor(id)).toMatchObject({ ok: true, value: { effect: 'modal', output: 'modal text' } });
  });

  it('an unknown-command notice → E_INPUT_REJECTED{unknownCommand}', () => {
    const h = readyHarness();
    h.cmd({ type: 'slash.run', name: '/frob', unsafe: true });
    const id = h.lastCmdId();
    h.run(300);
    h.screen(
      frame({ composer: { text: '', empty: true, placeholderLikely: false, pastedPlaceholder: false, notices: ['unknownCommand'] } }),
    );
    expect(h.resultFor(id)).toMatchObject({ ok: false, error: { code: 'E_INPUT_REJECTED', details: { reason: 'unknownCommand' } } });
  });

  it('refused commands resolve at once with E_COMMAND_FORBIDDEN and press nothing', () => {
    const h = readyHarness();
    expect(h.cmd({ type: 'slash.run', name: '/quit', unsafe: true })).toMatchObject({ ok: false, error: { code: 'E_COMMAND_FORBIDDEN' } });
    expect(h.cmd({ type: 'slash.run', name: '/tui', unsafe: true })).toMatchObject({ ok: false });
    expect(h.cmd({ type: 'slash.run', name: '/permissions' })).toMatchObject({ ok: false });
    h.run(500);
    expect(h.intentsOf('input')).toEqual([]);
  });

  it('a command editor failure falls back to typeLiteral of the full line', () => {
    const h = readyHarness();
    h.onPrimitive = (p) =>
      p.kind === 'awaitEditorConsumed'
        ? { composer: { text: '', empty: true, placeholderLikely: false, pastedPlaceholder: false, notices: [] } }
        : undefined;
    h.cmd({ type: 'slash.run', name: '/model', args: 'opus' });
    h.composer = '';
    h.run(1500);
    expect(keys(h)).toContain('type:/model opus');
  });
});

describe('interrupt (§3.6 Interrupt, K-13)', () => {
  it('not busy → interrupt.ignored{notBusy}, nothing pressed', () => {
    const h = readyHarness();
    h.cmd({ type: 'interrupt' });
    expect(h.ev('interrupt.ignored')[0]?.payload.reason).toBe('notBusy');
    expect(h.intentsOf('input')).toEqual([]);
  });

  it('one Escape; evidence (transcript marker) ends the job; a second interrupt never sends a second Escape', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'long');
    ups(h, 'long', 'p1');
    h.cmd({ type: 'interrupt' });
    h.cmd({ type: 'interrupt' });
    expect(keys(h).filter((k) => k === 'Escape')).toHaveLength(1);
    h.tx('turn.interrupted', { marker: 'request' }, { uuid: 'im' });
    expect(h.core.input.current).toBeUndefined();
    expect(h.ev('interrupt.ignored')).toEqual([]);
  });
});

describe('clearComposer (§3.6)', () => {
  it('never presses Escape on an empty composer (double Esc opens Rewind, IN §6.2)', () => {
    const h = readyHarness();
    h.screen(composerFrame(''));
    sendUntilEnter(h, 'z');
    h.composer = '';
    h.screen(composerFrame(''));
    h.tx('prompt.blocked', { reason: 'x', text: 'z' }, { uuid: 'pb' });
    h.run(1000);
    expect(keys(h).filter((k) => k === 'Escape')).toEqual([]);
  });

  it('keys mode: Escape, the escAgainToClear hint, Escape, verify empty', () => {
    const h = readyHarness(testConfig({ input: { method: 'pasteChunks' } }));
    h.screen(composerFrame('leftover draft'));
    h.run(200);
    let n = 0;
    h.onPrimitive = (p) => {
      if (p.kind !== 'key' || p.key !== 'Escape') return undefined;
      n += 1;
      return n === 1
        ? {
            composer: {
              text: 'leftover draft',
              empty: false,
              placeholderLikely: false,
              pastedPlaceholder: false,
              notices: ['escAgainToClear'],
            },
          }
        : { composer: { text: '', empty: true, placeholderLikely: false, pastedPlaceholder: false, notices: [] } };
    };
    h.cmd({ type: 'prompt.send', text: 'new', whenBusy: 'wait' });
    h.run(1500, 10);
    expect(keys(h).slice(0, 3)).toEqual(['Escape', 'Escape', 'pasteChunk']);
  });
});

describe('setMode (§3.6 setMode, K-33, P-INPUT-32)', () => {
  it('bypassPermissions without allowDangerousModes → E_MODE_FORBIDDEN, nothing pressed', () => {
    const h = readyHarness();
    expect(h.cmd({ type: 'mode.set', mode: 'bypassPermissions' })).toMatchObject({ ok: false, error: { code: 'E_MODE_FORBIDDEN' } });
    expect(h.intentsOf('input')).toEqual([]);
  });

  it('plan: BTab presses until the footer shows plan; the result resolves at job end', () => {
    const h = readyHarness();
    let presses = 0;
    const modes = ['acceptEdits', 'plan'] as const;
    h.onPrimitive = (p) => {
      if (p.kind !== 'key' || p.key !== 'BTab') return undefined;
      const mode = modes[Math.min(presses, 1)] ?? 'plan';
      presses += 1;
      return { footer: { busy: false, modeLabel: mode, mode, pasting: false, ctrlCExitArmed: false, hints: [] } };
    };
    h.cmd({ type: 'mode.set', mode: 'plan' });
    const id = h.lastCmdId();
    h.run(3000);
    expect(keys(h).filter((k) => k === 'BTab')).toHaveLength(2);
    expect(h.resultFor(id)).toMatchObject({ ok: true });
  });

  it('a dialog appearing after a press → Escape and fail', () => {
    const h = readyHarness();
    h.onPrimitive = (p) => (p.kind === 'key' && p.key === 'BTab' ? { surface: 'modal' } : undefined);
    h.cmd({ type: 'mode.set', mode: 'acceptEdits' });
    const id = h.lastCmdId();
    h.run(1500);
    expect(h.resultFor(id)).toMatchObject({ ok: false, error: { code: 'E_MODE_FORBIDDEN', details: { reason: 'dialog' } } });
    expect(keys(h)).toContain('Escape');
  });

  it('setMode does not start while a dialog is shown (P-INPUT-32)', () => {
    const h = readyHarness();
    h.screen(frame({ surface: 'permissionDialog', dialog: { kind: 'permission', options: [] }, composer: undefined }));
    h.cmd({ type: 'mode.set', mode: 'acceptEdits' });
    h.run(500);
    expect(keys(h)).not.toContain('BTab');
  });
});

describe('copy mode and editor surface (K-35, ICR 0001 item 3)', () => {
  it('copy mode → exitCopyMode before any input; frames in copy mode never start typing', () => {
    const h = readyHarness();
    h.screen(idleFrame({ inCopyMode: true }));
    h.onPrimitive = (p) => (p.kind === 'exitCopyMode' ? { inCopyMode: false } : undefined);
    h.cmd({ type: 'prompt.send', text: 'after copy', whenBusy: 'wait' });
    h.run(1200);
    expect(keys(h)[0]).toBe('exitCopyMode');
    expect(keys(h)[1]).toBe('stage:after copy');
  });

  it('an editorOpen frame during our job is transient: no claim, no screen degradation', () => {
    const h = readyHarness();
    h.onPrimitive = (p) =>
      p.kind === 'key' && p.key === 'C-g' ? { surface: 'editorOpen', altScreen: true, composer: undefined } : undefined;
    sendUntilEnter(h, 'with editor');
    expect(h.ev('claim.asserted').filter((e) => e.payload.claim.includes('editorOpen'))).toEqual([]);
    expect(h.d.channels.screen.health).toBe('up');
  });

  it('a human-opened editor (no library job) for editorConsumeMs blocks input with a warning, not unsupportedRenderer', () => {
    const h = readyHarness();
    h.screen(frame({ surface: 'editorOpen', altScreen: true, composer: undefined }));
    h.run(3100);
    expect(h.d.inputBlocked.editor).toBe(true);
    expect(h.ev('warning').some((w) => (w.payload.detail as { reason?: string } | null)?.reason === 'editorOpen')).toBe(true);
    h.cmd({ type: 'prompt.send', text: 'wait for it', whenBusy: 'wait' });
    h.run(500);
    expect(h.intentsOf('input')).toEqual([]);
    h.screen(idleFrame());
    h.run(300);
    expect(h.d.inputBlocked.editor).toBeUndefined();
    expect(keys(h)[0]).toBe('stage:wait for it');
    expect(h.d.channels.screen.reasons).toEqual([]);
  });

  it('an unsupportedRenderer surface degrades the screen channel until a main frame', () => {
    const h = readyHarness();
    h.screen(frame({ surface: 'unsupportedRenderer', altScreen: true, composer: undefined }));
    expect(h.d.channels.screen).toEqual({ health: 'degraded', reasons: ['unsupportedRenderer'] });
    h.screen(busyFrame());
    expect(h.d.channels.screen.health).toBe('up');
  });
});

describe('I6 deferral', () => {
  it('a primitive held back while a permission is held is re-sent once it clears', () => {
    const h = readyHarness(testConfig(), {}, { auto: false });
    h.cmd({ type: 'prompt.send', text: 'q', whenBusy: 'wait' });
    h.done(h.lastInput()!); // editorStage
    h.done(h.lastInput()!); // C-g
    // a PermissionRequest of a human turn appears while our job is mid-flight
    h.hook('permission.requested', { hookSeq: 1 as never, toolName: 'Bash', input: {}, suggestions: [] }, 'PermissionRequest');
    h.done(h.lastInput()!); // awaitEditorConsumed
    h.screen(composerFrame('q'));
    h.run(200);
    expect(h.primitives().some((p) => p.kind === 'key' && p.key === 'Enter')).toBe(false);
    expect(h.diag('I6_guard').length).toBeGreaterThan(0);
    h.cmd({ type: 'permission.answer', permissionKey: 'p1' as never, decision: { behavior: 'deny' }, by: 'host' });
    expect(h.d.inputBlocked.permission).toBe(false);
    h.run(200);
    expect(h.primitives().at(-1)).toEqual({ kind: 'key', key: 'Enter', gapAfterMs: 15 });
  });
});
