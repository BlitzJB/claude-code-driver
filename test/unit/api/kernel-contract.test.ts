// Contract: the facade over the REAL kernel (session L3 + core + channels, L0 faked; testing/test-kernel.ts). The scripted
// FakeKernel of the other api tests encodes our reading of the SessionKernel port (§2.10); this file checks that reading against
// the implementation once it lands (WP-06/07/09/11/12/13). Until then it is skipped (ICR 0014 item 1: L3 is loaded at run time).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wrapKernel } from '../../../src/api/claude-session.js';
import type { SessionEvent } from '../../../src/api/public-types.js';
import { createTestKernel, type TestKernel, type TestKernelOptions } from '../../../src/testing/test-kernel.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const L3 = [
  'src/session/kernel.ts',
  'src/session/config.ts',
  'src/session/loop.ts',
  'src/session/launcher.ts',
  'src/session/lifecycle.ts',
  'src/session/input-executor.ts',
  'src/session/permission-broker.ts',
  'src/session/pollers.ts',
  'src/session/tail-driver.ts',
  'src/core/step.ts',
  'src/channels/hooks/normalize.ts',
  'src/channels/screen/classify.ts',
];
const landed = L3.every((f) => existsSync(join(ROOT, f)));

/**
 * A ready test kernel, or a skip when the kernel itself cannot start (an L3 defect, covered by the K-scenarios in test/kernel;
 * the facade is not involved before `wrapKernel`). Every failure after that point is the facade's and fails the test.
 */
async function readyKernel(skip: (note?: string) => never, o?: TestKernelOptions): Promise<TestKernel> {
  try {
    return await createTestKernel(o);
  } catch (e) {
    return skip(`test kernel did not reach ready: ${e instanceof Error ? e.message : String(e)}`);
  }
}

describe.skipIf(!landed)('ClaudeSession over the real kernel (contract)', () => {
  it('K-01 via the facade: send → turnQueued, turnStarted, text, turnEnded; done completes; idle snapshot; close resolves exited', async ({
    skip,
  }) => {
    const tk = await readyKernel(skip);
    const session = wrapKernel(tk.kernel, { cwd: tk.fakes.cwd, permissions: 'deny' });
    const seen: SessionEvent[] = [];
    session.onAny((e) => void seen.push(e));
    expect(session.state.status.kind).toBe('idle');
    expect(session.claudeSessionId).not.toBe('');

    const turn = session.send('say OK');
    const result = await tk.pump(turn.done, 30_000);
    expect(result.outcome).toBe('completed');
    expect(result.text).toContain('OK');
    expect(turn.key).toMatch(/^t\d+$/);
    expect((await turn.accepted).promptId).not.toBe('');

    const own = seen.filter((e) => e.turnKey === turn.key).map((e) => e.type);
    expect(own[0]).toBe('turnQueued');
    expect(own).toContain('turnStarted');
    expect(own.at(-1)).toBe('turnEnded');
    expect(seen.every((e) => Number.isFinite(e.at) && e.at > 1_000_000_000_000)).toBe(true);

    await tk.pump(session.waitForIdle({ timeoutMs: 10_000 }), 15_000);
    expect(session.turns().map((t) => t.key)).toContain(turn.key);

    const info = await tk.pump(session.close(), 30_000);
    expect(['closed', 'killed']).toContain(info.reason);
    expect(await session.exited).toEqual(info);
  }, 60_000);

  it('a busy session with whenBusy:reject rejects accepted with E_BUSY and resolves done as notSubmitted', async ({ skip }) => {
    const tk = await readyKernel(skip, { claude: { onPrompt: () => new Promise(() => undefined) } });
    const session = wrapKernel(tk.kernel, { cwd: tk.fakes.cwd, permissions: 'deny' });
    const first = session.send('hang');
    await tk.pump(first.accepted, 30_000);
    const second = session.send('nope', { whenBusy: 'reject' });
    const r = await tk.pump(second.done, 10_000);
    expect(r.outcome).toBe('notSubmitted');
    expect(r.error?.code).toBe('E_BUSY');
    await tk.pump(session.close({ mode: 'kill' }), 30_000);
  }, 60_000);

  // ICR 0029 #1: the kernel hands one state per batch (and the current state on a ring replay); toolStarted must still carry
  // the tool as it started, never its later or final state.
  it('toolStarted is pending with no endedAt, live and on a replay from seq 0; toolEnded carries the end', async ({ skip }) => {
    const tk = await readyKernel(skip, {
      claude: {
        onPrompt: async (t) => {
          await t.tool({ name: 'Bash', input: { command: 'touch x', description: 'x' } });
          await t.say('done');
          await t.stop();
        },
      },
    });
    const session = wrapKernel(tk.kernel, { cwd: tk.fakes.cwd, permissions: () => ({ behavior: 'allow' }) });
    const live: SessionEvent[] = [];
    session.onAny((e) => void live.push(e));
    const r = await tk.pump(session.send('touch x').done, 30_000);
    expect(r.outcome).toBe('completed');

    const replay: SessionEvent[] = [];
    const it2 = session.events({ fromSeq: 0 });
    const lastSeq = live.at(-1)?.seq ?? 0;
    for (;;) {
      const n = await it2.next();
      if (n.done === true) break;
      replay.push(n.value);
      if (n.value.seq >= lastSeq) break;
    }
    void it2.return?.();
    for (const seen of [live, replay]) {
      const started = seen.filter((e) => e.type === 'toolStarted');
      const ended = seen.filter((e) => e.type === 'toolEnded');
      expect(started).toHaveLength(1);
      expect(started[0]?.data).toMatchObject({ name: 'Bash', state: 'pending' });
      expect(started[0]?.data.endedAt).toBeUndefined();
      expect(ended).toHaveLength(1);
      expect(ended[0]?.data.state).toBe('succeeded');
      expect(ended[0]?.data.endedAt).toBe(ended[0]?.at);
    }
    await tk.pump(session.close({ mode: 'kill' }), 30_000);
  }, 60_000);

  // ICR 0029 #2: the caller's own abort reason and its own predicate's exception come back as they are, not E_INTERNAL.
  it('waitFor/waitForIdle reject with the caller abort reason or the predicate exception as is', async ({ skip }) => {
    const tk = await readyKernel(skip, { claude: { onPrompt: () => new Promise(() => undefined) } });
    const session = wrapKernel(tk.kernel, { cwd: tk.fakes.cwd, permissions: 'deny' });
    await tk.pump(session.send('hang').accepted, 30_000); // busy: waitForIdle / waitForQuiescence keep waiting
    const reason = new Error('user cancelled');
    const ac = new AbortController();
    const p1 = session.waitFor(() => false, { signal: ac.signal });
    ac.abort(reason);
    await expect(p1).rejects.toBe(reason);
    const ac2 = new AbortController();
    const p2 = session.waitFor(() => false, { signal: ac2.signal });
    ac2.abort('stop');
    await expect(p2).rejects.toBe('stop');
    // waitForIdle/waitForQuiescence share the path (waitSettled)
    await expect(session.waitForIdle({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const ac3 = new AbortController();
    const p3 = session.waitForQuiescence({ signal: ac3.signal });
    ac3.abort('stop');
    await expect(p3).rejects.toBe('stop');
    await expect(session.waitForIdle({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    const bug = new TypeError('my bug');
    await expect(
      session.waitFor(() => {
        throw bug;
      }),
    ).rejects.toBe(bug);
    await tk.pump(session.close({ mode: 'kill' }), 30_000);
  }, 60_000);
});

describe.runIf(!landed)('ClaudeSession over the real kernel (pending)', () => {
  it('is skipped until session/** and its dependencies land', () => {
    expect(landed).toBe(false);
  });
});
