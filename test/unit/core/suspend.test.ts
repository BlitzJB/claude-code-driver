// ICR 0041: the pure parts of suspend/resume: suspendBlockers, the core's `suspended` lifecycle, close while suspended,
// session_crons, and resumeCore.
import { describe, expect, it } from 'vitest';
import { initialCore } from '../../../src/core/init.js';
import { resumeCore } from '../../../src/core/resume.js';
import { suspendBlockers } from '../../../src/core/selectors.js';
import type { CoreState } from '../../../src/core/types.js';
import { readyHarness, testInit } from './harness.js';

const withDomain = (c: CoreState, f: (d: CoreState['domain']) => CoreState['domain']): CoreState => ({ ...c, domain: f(c.domain) });

describe('suspendBlockers', () => {
  it('is empty for a ready, idle, quiescent session', () => {
    expect(suspendBlockers(readyHarness().core)).toEqual([]);
  });

  it.each<[string, (c: CoreState) => CoreState]>([
    ['notReady', (c) => withDomain(c, (d) => ({ ...d, lifecycle: 'selfTest' }))],
    ['turn', (c) => withDomain(c, (d) => ({ ...d, libraryQueue: ['t9' as never] }))],
    ['inputJob', (c) => ({ ...c, input: { ...c.input, current: 'j9' as never } })],
    ['composerBlocked', (c) => withDomain(c, (d) => ({ ...d, inputBlocked: { ...d.inputBlocked, dialog: true } }))],
    [
      'awaitingInput',
      (c) => withDomain(c, (d) => ({ ...d, pendingInputs: { i1: { key: 'i1', kind: 'elicitation', since: 0 } as never } })),
    ],
    ['scheduledTasks', (c) => withDomain(c, (d) => ({ ...d, scheduledTasks: 2 }))],
    ['authRequired', (c) => withDomain(c, (d) => ({ ...d, auth: { state: 'required', polling: true } }))],
    ['compacting', (c) => withDomain(c, (d) => ({ ...d, compacting: { since: 0 as never } }))],
    [
      'usageLimited',
      (c) =>
        withDomain(c, (d) => ({
          ...d,
          usage: { ...d.usage, limit: { state: 'limited', source: 'hook', autoContinue: 'none', rearms: 0 } },
        })),
    ],
  ])('names %s', (reason, mut) => {
    expect(suspendBlockers(mut(readyHarness().core))).toContain(reason);
  });

  it('counts a background agent permission request even though the derived status skips it', () => {
    const c = withDomain(readyHarness().core, (d) => ({
      ...d,
      permissions: {
        p1: {
          key: 'p1',
          state: { value: 'pending', src: 'hook', provisional: false },
          requestedAt: 0,
          toolName: 'Bash',
          input: {},
        } as never,
      },
    }));
    expect(c.domain.status.kind).toBe('idle');
    expect(suspendBlockers(c)).toContain('permission');
  });
});

describe('the core while suspended', () => {
  it('session.suspended → lifecycle and status suspended, channels off, deadlines cleared, one event', () => {
    const h = readyHarness();
    h.obs('session.suspended', { claudeSessionId: 'c-1', reason: 'idle', interrupted: false }, 'self');
    expect(h.d.lifecycle).toBe('suspended');
    expect(h.d.status).toMatchObject({ kind: 'suspended', claudeSessionId: 'c-1' });
    expect(Object.values(h.d.channels).every((x) => x.health === 'off')).toBe(true);
    expect(Object.keys(h.core.recon.deadlines)).toEqual([]);
    expect(h.ev('session.suspended')).toHaveLength(1);
    expect(h.ev('session.suspended')[0]?.payload).toEqual({ claudeSessionId: 'c-1', reason: 'idle', interrupted: false });
    expect(h.ev('session.exited')).toHaveLength(0);
    // a second report is a no-op
    h.obs('session.suspended', { claudeSessionId: 'c-1', reason: 'idle', interrupted: false }, 'self');
    expect(h.ev('session.suspended')).toHaveLength(1);
  });

  it('session.close while suspended ends the session at once (reason closed, nothing to stop)', () => {
    const h = readyHarness();
    h.obs('session.suspended', { claudeSessionId: 'c-1', reason: 'manual', interrupted: false }, 'self');
    h.cmd({ type: 'session.close', mode: 'graceful', graceMs: 1000, reason: 'closed' });
    expect(h.d.lifecycle).toBe('exited');
    expect(h.ev('session.exited')[0]?.payload).toMatchObject({ reason: 'closed' });
    expect(h.inputIntents()).toHaveLength(0);
  });

  it('a Stop hook with session_crons records the scheduled task count', () => {
    const h = readyHarness();
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false, sessionCrons: 3 }, 'Stop');
    expect(h.d.scheduledTasks).toBe(3);
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false, sessionCrons: 0 }, 'Stop');
    expect(h.d.scheduledTasks).toBe(0);
  });
});

describe('resumeCore', () => {
  it('keeps every counter and the history, resets everything that belonged to the process', () => {
    const h = readyHarness();
    h.obs('session.suspended', { claudeSessionId: 'c-1', reason: 'idle', interrupted: false }, 'self');
    const prev: CoreState = {
      ...h.core,
      counters: { ...h.core.counters, turn: 7, tool: 12, perm: 3, event: 99 },
      domain: { ...h.core.domain, turns: { t7: { key: 't7' } } as never, turnOrder: ['t7' as never] },
    };
    const init = testInit(undefined, { initialClaudeSessionId: 'c-1', resume: true });
    const r = resumeCore(prev, init);
    expect(r.counters).toEqual(prev.counters);
    expect(r.domain.turns).toBe(prev.domain.turns);
    expect(r.domain.turnOrder).toEqual(['t7']);
    expect(r.domain.lastEventSeq).toBe(prev.domain.lastEventSeq);
    expect(r.domain.claude.sessionId).toBe(prev.domain.claude.sessionId);
    const fresh = initialCore(init);
    expect(r.domain.lifecycle).toBe(fresh.domain.lifecycle);
    expect(r.domain.channels).toEqual(fresh.domain.channels);
    expect(r.domain.suspended).toBeUndefined();
    expect(r.domain.scheduledTasks).toBeUndefined();
    expect(r.recon).toEqual(fresh.recon);
    expect(r.input).toEqual(fresh.input);
  });
});
