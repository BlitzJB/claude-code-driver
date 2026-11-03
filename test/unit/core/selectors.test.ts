// core/selectors.ts — every clause of canSubmit (§4.13), quiescence, background count, displayToolState.
import { describe, expect, it } from 'vitest';
import { backgroundCount, canSubmit, isQuiescent, pendingPermissions, whyNotSubmit } from '../../../src/core/selectors.js';
import type { CoreState } from '../../../src/core/types.js';
import { readyHarness } from './harness.js';

function base(): CoreState {
  return readyHarness().core;
}
function withDomain(c: CoreState, f: (d: CoreState['domain']) => CoreState['domain']): CoreState {
  return { ...c, domain: f(c.domain) };
}
const ib = (c: CoreState, k: keyof CoreState['domain']['inputBlocked']): CoreState =>
  withDomain(c, (d) => ({ ...d, inputBlocked: { ...d.inputBlocked, [k]: true } }));

describe('canSubmit (§4.13)', () => {
  it('holds for a ready, idle, unblocked session', () => {
    expect(canSubmit(base())).toBe(true);
    expect(whyNotSubmit(base())).toBeUndefined();
  });
  it.each<[string, (c: CoreState) => CoreState]>([
    ['notReady', (c) => withDomain(c, (d) => ({ ...d, lifecycle: 'awaitingReady' }))],
    ['turnActive', (c) => withDomain(c, (d) => ({ ...d, activeTurn: 't9' as never }))],
    ['jobRunning', (c) => ({ ...c, input: { ...c.input, current: 'j9' as never } })],
    ['permission', (c) => ib(c, 'permission')],
    ['dialog', (c) => ib(c, 'dialog')],
    ['startup', (c) => ib(c, 'startup')],
    ['copyMode', (c) => ib(c, 'copyMode')],
    ['awaitingInput', (c) => ib(c, 'input')],
    ['editorOpen', (c) => ib(c, 'editor')],
    ['compacting', (c) => withDomain(c, (d) => ({ ...d, compacting: { since: 0 as never } }))],
    ['authRequired', (c) => withDomain(c, (d) => ({ ...d, auth: { state: 'required', polling: true } }))],
    [
      'usageLimited',
      (c) =>
        withDomain(c, (d) => ({
          ...d,
          usage: { ...d.usage, limit: { state: 'limited', source: 'hook', autoContinue: 'none', rearms: 0 } },
        })),
    ],
    ['exited', (c) => withDomain(c, (d) => ({ ...d, exit: { exitStatus: 0, signal: null, reason: 'closed' } }))],
  ])('clause %s blocks and is named by whyNotSubmit', (name, f) => {
    const c = f(base());
    expect(canSubmit(c)).toBe(false);
    expect(whyNotSubmit(c)).toBe(name);
  });
  it('forWake ignores the usage limit; forSelfTest requires lifecycle selfTest', () => {
    const lim = withDomain(base(), (d) => ({
      ...d,
      usage: { ...d.usage, limit: { state: 'waking', source: 'hook', autoContinue: 'none', rearms: 0 } },
    }));
    expect(canSubmit(lim, { forWake: true })).toBe(true);
    expect(canSubmit(base(), { forSelfTest: true })).toBe(false);
    expect(
      canSubmit(
        withDomain(base(), (d) => ({ ...d, lifecycle: 'selfTest' })),
        { forSelfTest: true },
      ),
    ).toBe(true);
  });
  it('a failed last turn never blocks it (rev 2 §10 A8)', () => {
    const c = withDomain(base(), (d) => ({
      ...d,
      status: {
        kind: 'idle',
        since: 0 as never,
        backgroundAgents: 0,
        queued: 0,
        quiescent: true,
        lastTurn: { outcome: 'failed', error: { code: 'E_TURN_API_ERROR', message: 'x' } },
      },
    }));
    expect(canSubmit(c)).toBe(true);
  });
});

describe('other selectors', () => {
  it('quiescence and background count', () => {
    const c = base();
    expect(isQuiescent(c.domain)).toBe(true);
    expect(isQuiescent(c.domain, 1)).toBe(false);
    expect(backgroundCount(c.domain)).toBe(0);
    const d = { ...c.domain, bgTasks: { b1: { id: 'b1', type: 'local_bash', status: 'running', updatedAt: 0 as never } } };
    expect(backgroundCount(d)).toBe(1);
    expect(isQuiescent(d)).toBe(false);
    expect(pendingPermissions(c.domain)).toEqual([]);
  });
});
