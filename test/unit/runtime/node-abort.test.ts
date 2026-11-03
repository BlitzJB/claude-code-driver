// runtime/node.ts createKernel — abort during start (ICR 0024): the rejection settles only after the kill-close finished.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernel } from '../../../src/runtime/node.js';

interface FakeKernel {
  start: () => Promise<void>;
  close: (o?: unknown) => Promise<unknown>;
}
// vi.mock is hoisted above the imports; the factory reads `fake` lazily, at createSessionKernel time
const fake: { make?: () => FakeKernel } = {};

vi.mock('../../../src/session/kernel.js', () => ({
  createSessionKernel: (): FakeKernel => {
    if (fake.make === undefined) throw new Error('fake kernel not configured');
    return fake.make();
  },
}));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete fake.make;
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccd-rt-abort-'));
  dirs.push(d);
  return d;
}

/** A kernel whose close() takes a while to tear down and whose start() rejects as soon as close() was requested. */
function slowCloseKernel(events: string[], onStart: () => void): FakeKernel {
  let closePromise: Promise<unknown> | undefined;
  let rejectStart: ((e: Error) => void) | undefined;
  return {
    start: () =>
      new Promise<void>((_resolve, reject) => {
        rejectStart = reject;
        onStart();
      }),
    close: () => {
      closePromise ??= (async () => {
        events.push('close:begin');
        // start() observes closeRequested at its next check and rejects E_SESSION_CLOSED before the teardown ran
        queueMicrotask(() => rejectStart?.(Object.assign(new Error('closed during start'), { code: 'E_SESSION_CLOSED' })));
        await new Promise((r) => setTimeout(r, 30));
        events.push('close:teardown-done');
        return { reason: 'aborted' };
      })();
      return closePromise;
    },
  };
}

describe('createKernel abort during start', () => {
  it('rejects with AbortError only after the kill-close started by the abort listener finished its teardown', async () => {
    const events: string[] = [];
    let started!: () => void;
    const startBegan = new Promise<void>((r) => {
      started = r;
    });
    fake.make = () => slowCloseKernel(events, started);
    const ac = new AbortController();
    const p = createKernel({ cwd: tmp(), permissions: { policy: 'deny' } }, { signal: ac.signal });
    const settled = p.then(
      () => events.push('start:resolved'),
      (e: unknown) => events.push(`start:rejected:${(e as Error).name}`),
    );
    await startBegan;
    ac.abort();
    await settled;
    expect(events).toEqual(['close:begin', 'close:teardown-done', 'start:rejected:AbortError']);
  });

  it('a start failure that is not an abort is rethrown unchanged without a kill-close', async () => {
    const events: string[] = [];
    fake.make = () => ({
      start: () => Promise.reject(Object.assign(new Error('boom'), { code: 'E_LAUNCH' })),
      close: () => {
        events.push('close');
        return Promise.resolve({});
      },
    });
    await expect(
      createKernel({ cwd: tmp(), permissions: { policy: 'deny' } }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'E_LAUNCH',
    });
    expect(events).toEqual([]);
  });
});
