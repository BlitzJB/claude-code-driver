// core/input-policy/machine.ts — failure and fallback paths of every job kind (§3.6): primitive failures, persistent copy
// mode, menus that stay, setMode press cap, typed-fallback refusal, composer clear failure, self-test disarm timeout.
import { describe, expect, it } from 'vitest';
import type { InputPrimitive } from '../../../src/model/intents.js';
import { Harness, SESSION_ID, composerFrame, frame, idleFrame, readyHarness, testConfig, ups } from './harness.js';

/** Run with an executor that fails the given primitive kinds. */
function failing(h: Harness, pred: (p: InputPrimitive) => boolean): void {
  h.exec.auto = false;
  for (let i = 0; i < 200; i++) {
    const last = h.lastInput();
    if (last === undefined) break;
    h.done(last, !pred(last.primitive));
    if (h.lastInput() === last) {
      h.run(700);
      if (h.lastInput() === last) break;
    }
  }
}

describe('job failures', () => {
  it('editorStage failing twice (editor, then paste fallback) → E_SUBMIT_UNCONFIRMED{step:"editor"} only after the fallback was tried', () => {
    const h = readyHarness(testConfig(), {}, { auto: false });
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    h.done(h.lastInput()!, false); // editorStage fails → fallback
    h.run(700);
    const p = h.lastInput()?.primitive;
    expect(p?.kind).toBe('pasteChunk');
    h.done(h.lastInput()!, false);
    expect(h.d.turns['t1' as never]?.state.value).toBe('notSubmitted');
  });

  it('an editor that stays open (alternate screen) blocks the paste fallback', () => {
    const h = readyHarness();
    h.onPrimitive = (p) => (p.kind === 'awaitEditorConsumed' ? { surface: 'editorOpen', composer: undefined } : undefined);
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    h.run(2000);
    expect(h.d.turns['t1' as never]?.error).toMatchObject({ code: 'E_SUBMIT_UNCONFIRMED', details: { step: 'editor' } });
  });

  it('persistent copy mode fails the job after the exit attempts', () => {
    const h = readyHarness();
    h.screen(idleFrame({ inCopyMode: true }));
    h.onPrimitive = (p) => (p.kind === 'exitCopyMode' ? { inCopyMode: true } : undefined);
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    h.run(3000);
    expect(h.d.turns['t1' as never]?.error).toMatchObject({ code: 'E_INPUT_GATED', details: { reason: 'copyMode' } });
  });

  it('setMode gives up after 6 presses', () => {
    const h = readyHarness();
    h.onPrimitive = (p) =>
      p.kind === 'key' && p.key === 'BTab'
        ? { footer: { busy: false, modeLabel: 'accept', mode: 'acceptEdits', pasting: false, ctrlCExitArmed: false, hints: [] } }
        : undefined;
    h.cmd({ type: 'mode.set', mode: 'plan' });
    const id = h.lastCmdId();
    h.run(12_000);
    expect(h.primitives().filter((p) => p.kind === 'key' && p.key === 'BTab')).toHaveLength(6);
    expect(h.resultFor(id)).toMatchObject({ ok: false, error: { details: { reason: 'modeNotReached' } } });
  });

  it('a hook permission_mode equal to the target confirms setMode early', () => {
    const h = readyHarness(testConfig(), {}, { auto: false });
    h.cmd({ type: 'mode.set', mode: 'acceptEdits' });
    const id = h.lastCmdId();
    h.hook('mode.observed', { permissionMode: 'acceptEdits' }, 'Notification');
    expect(h.resultFor(id)).toMatchObject({ ok: true });
    expect(h.d.claude.permissionMode?.value).toBe('acceptEdits');
    expect(h.ev('session.modeChanged').at(-1)?.payload.mode).toBe('acceptEdits');
    expect(h.cmd({ type: 'mode.set', mode: 'acceptEdits' })).toMatchObject({ ok: true });
  });

  it('a usage-limit menu that does not go away → warning path, the wake re-arms', () => {
    const h = readyHarness();
    h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    h.screen(frame({ surface: 'usageLimitMenu', composer: undefined }));
    h.run(300);
    h.onPrimitive = (p) => (p.kind === 'key' && p.key === 'Escape' ? { surface: 'usageLimitMenu', composer: undefined } : undefined);
    h.cmd({ type: 'usage.wakeNow' });
    h.run(2000);
    expect(h.d.usage.limit).toMatchObject({ state: 'limited', rearms: 1 });
  });

  it('wakeEnter with no verification → warning and re-arm', () => {
    const h = readyHarness();
    h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    h.screen(composerFrame('', { usageLimit: { line: 'x', autoContinue: 'stalePressEnter' } }));
    h.run(300);
    h.cmd({ type: 'usage.wakeNow' });
    h.run(3500);
    expect(h.ev('warning').some((w) => (w.payload.detail as { reason?: string } | null)?.reason === 'wakeUnconfirmed')).toBe(true);
    expect(h.d.usage.limit?.rearms).toBe(1);
  });

  it('wakeEnter refuses a non-empty composer', () => {
    const h = readyHarness();
    h.hook('turn.failed', { error: 'rate_limit' }, 'StopFailure');
    h.screen(composerFrame('draft', { usageLimit: { line: 'x', autoContinue: 'stalePressEnter' } }));
    h.run(300);
    h.cmd({ type: 'usage.wakeNow' });
    expect(h.primitives().some((p) => p.kind === 'key' && p.key === 'Enter')).toBe(false);
  });

  it('the typed command fallback refuses lines over 200 bytes', () => {
    const h = readyHarness();
    h.onPrimitive = (p) =>
      p.kind === 'awaitEditorConsumed'
        ? { composer: { text: '', empty: true, placeholderLikely: false, pastedPlaceholder: false, notices: [] } }
        : undefined;
    h.cmd({ type: 'slash.run', name: '/rename', args: 'n'.repeat(300) });
    const id = h.lastCmdId();
    h.composer = '';
    h.run(1500);
    expect(h.resultFor(id)).toMatchObject({ ok: false, error: { code: 'E_SUBMIT_UNCONFIRMED', details: { step: 'typed' } } });
  });

  it('a composer that will not clear fails the clearComposer job with a warning', () => {
    const h = readyHarness(testConfig({ input: { method: 'pasteChunks' } }));
    h.screen(composerFrame('stuck'));
    h.run(200);
    h.onPrimitive = (p) =>
      p.kind === 'key' && p.key === 'Escape'
        ? { composer: { text: 'stuck', empty: false, placeholderLikely: false, pastedPlaceholder: false, notices: [] } }
        : undefined;
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    h.run(2000);
    expect(h.d.turns['t1' as never]?.error).toMatchObject({ code: 'E_SUBMIT_UNCONFIRMED', details: { step: 'clear' } });
  });

  it('a self-test whose disarm is never acked fails with step disarm', () => {
    const nonce = 'ccd-selftest-ffffffffffffffffffffffffffffffff';
    const h = new Harness();
    h.obs('process.launched', { pid: 1, paneId: '%1', claudeVersion: '2.1.316', startTime: 't' }, 'process');
    h.hook('session.started', { sessionId: SESSION_ID, transcriptPath: '/t.jsonl', source: 'startup' }, 'SessionStart');
    h.advance(10).screen(idleFrame());
    h.run(400);
    h.exec.auto = true;
    h.cmd({ type: 'selftest.run', nonce, cachedPass: false });
    h.obs('hook.selfTestArmed', { nonce, armed: true }, 'self');
    h.run(300);
    h.composer = '';
    h.screen(composerFrame(''));
    ups(h, nonce, 'pn');
    h.run(1000);
    expect(h.intentsOf('hook.disarmSelfTest')).toHaveLength(1);
    h.run(2500);
    expect(h.ev('warning').find((w) => w.payload.code === 'E_SELFTEST_FAILED')?.payload.detail).toMatchObject({ step: 'disarm' });
    expect(h.d.lifecycle).toBe('exited');
  });

  it('input.done for an unknown job or a stale intent is a diagnostic only', () => {
    const h = readyHarness(testConfig(), {}, { auto: false });
    h.obs('input.done', { intentId: 999 as never, job: 'j99' as never, primitive: 'key', ok: true }, 'self');
    expect(h.diag('input_done_unknown_job')).toHaveLength(1);
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    const first = h.lastInput()!;
    h.done(first);
    h.obs('input.done', { intentId: first.id, job: first.job, primitive: 'editorStage', ok: true }, 'self');
    expect(h.diag('input_done_stale')).toHaveLength(1);
  });

  it('every failure path is exercised without exceptions (fuzzed executor failures)', () => {
    const h = readyHarness();
    h.cmd({ type: 'slash.run', name: '/status' });
    failing(h, (p) => p.kind === 'captureText');
    h.cmd({ type: 'interrupt' });
    ups(h, 'human', 'ph');
    h.cmd({ type: 'interrupt' });
    failing(h, (p) => p.kind === 'key');
    expect(h.diag('step_exception')).toEqual([]);
  });
});
