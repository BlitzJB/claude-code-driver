// Shared contract for EditorInjector (DESIGN.md §2.7.6): staged text replaces a Claude draft exactly once, unarmed runs use
// the user's original editor, consumed() is the only done signal and a timeout disarms (leaving the ICR 0018 tombstone). Run against the fake and the real
// wrapper + standalone.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorInjector } from '../../src/platform/ports.js';

export interface EditorRunResult {
  exitCode: number;
  /** The draft file content after the editor exited. */
  result: string;
}

export interface EditorHarness {
  injector: EditorInjector;
  sessionDir: string;
  nodePath: string;
  /** Simulate Claude running $VISUAL on a draft (`claudeDraft:false` = a non-Claude file such as COMMIT_EDITMSG). */
  runEditor(visualPath: string, draft: string, o?: { claudeDraft?: boolean }): Promise<EditorRunResult>;
  /** The suffix the user's original editor appends (the harness configures it). */
  origSuffix: string;
  cleanup(): Promise<void>;
}

export interface EditorHarnessOptions {
  /** Arm/tombstone lifetime passed to the injector factory (default: the production armTtlMs). */
  armTtlMs?: number;
}

export function editorContract(label: string, make: (o?: EditorHarnessOptions) => Promise<EditorHarness>): void {
  describe(`editor injector contract: ${label}`, () => {
    let h: EditorHarness;
    let visual: string;
    beforeEach(async () => {
      h = await make();
      visual = (await h.injector.setup(h.sessionDir, h.nodePath)).visualPath;
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it('stage → editor run → the draft holds exactly the staged text; consumed() is true once', async () => {
      const text = 'multi\nline\t"x" $HOME !bang /slash 🙂';
      const { nonce } = await h.injector.stage(text);
      const r = await h.runEditor(visual, 'leftover junk');
      expect(r).toEqual({ exitCode: 0, result: text });
      expect(await h.injector.consumed(nonce, 2_000)).toBe(true);
    });

    it('a second run after consumption is unarmed and uses the original editor', async () => {
      const { nonce } = await h.injector.stage('once');
      await h.runEditor(visual, 'd1');
      expect(await h.injector.consumed(nonce, 2_000)).toBe(true);
      expect(await h.runEditor(visual, 'd2')).toEqual({ exitCode: 0, result: `d2${h.origSuffix}` });
    });

    it('an armed prompt is never written into a non-Claude file (git commit inherits VISUAL)', async () => {
      const { nonce } = await h.injector.stage('PROMPT');
      expect(await h.runEditor(visual, 'commit msg', { claudeDraft: false })).toEqual({
        exitCode: 0,
        result: `commit msg${h.origSuffix}`,
      });
      expect((await h.runEditor(visual, 'draft')).result).toBe('PROMPT');
      expect(await h.injector.consumed(nonce, 2_000)).toBe(true);
    });

    // ICR 0018 §1: a timed-out consumed() (and a disarm() while an arm is outstanding) leaves a tombstone for armTtlMs. A
    // C-g on a Claude draft inside that window exits 1, leaves the draft alone and never opens the user's editor (the
    // library cannot tell its own late C-g from a human's); non-Claude files still get the original editor.
    it('consumed() times out when the editor never ran and disarms; a later Claude draft run exits 1 without an editor', async () => {
      const { nonce } = await h.injector.stage('never');
      expect(await h.injector.consumed(nonce, 150)).toBe(false);
      expect(await h.runEditor(visual, 'kept')).toEqual({ exitCode: 1, result: 'kept' });
      expect(await h.runEditor(visual, 'commit', { claudeDraft: false })).toEqual({
        exitCode: 0,
        result: `commit${h.origSuffix}`,
      });
    });

    it('disarm() of an outstanding stage prevents consumption and leaves the draft untouched', async () => {
      await h.injector.stage('also never');
      await h.injector.disarm();
      expect(await h.runEditor(visual, 'kept2')).toEqual({ exitCode: 1, result: 'kept2' });
      expect(await h.runEditor(visual, 'msg', { claudeDraft: false })).toEqual({ exitCode: 0, result: `msg${h.origSuffix}` });
    });

    it('disarm() after a consumed prompt leaves no tombstone: the next draft run uses the original editor', async () => {
      const { nonce } = await h.injector.stage('once');
      await h.runEditor(visual, 'd1');
      expect(await h.injector.consumed(nonce, 2_000)).toBe(true);
      await h.injector.disarm();
      expect(await h.runEditor(visual, 'd2')).toEqual({ exitCode: 0, result: `d2${h.origSuffix}` });
    });

    it('once the tombstone expires (armTtlMs) a Claude draft run uses the original editor again', async () => {
      const short = await make({ armTtlMs: 1_500 });
      try {
        const v = (await short.injector.setup(short.sessionDir, short.nodePath)).visualPath;
        const { nonce } = await short.injector.stage('never');
        expect(await short.injector.consumed(nonce, 50)).toBe(false);
        expect(await short.runEditor(v, 'k')).toEqual({ exitCode: 1, result: 'k' });
        await new Promise((r) => setTimeout(r, 1_700));
        expect(await short.runEditor(v, 'k')).toEqual({ exitCode: 0, result: `k${short.origSuffix}` });
      } finally {
        await short.cleanup();
      }
    });

    it('re-staging replaces the previous unconsumed prompt', async () => {
      await h.injector.stage('first');
      const { nonce } = await h.injector.stage('second');
      expect((await h.runEditor(visual, '')).result).toBe('second');
      expect(await h.injector.consumed(nonce, 2_000)).toBe(true);
    });
  });
}
