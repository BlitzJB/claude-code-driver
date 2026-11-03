// Kernel teardown when Claude exits on its own, and the hook-forgery security alert (DESIGN.md §3.5, §3.8; SEC §2.3;
// ICR 0033). Full stack: real kernel + launcher + lifecycle over the fake ports.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boot, codeOf } from './support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Claude exits on its own after ready', () => {
  it('the kernel tears itself down: waiters reject E_SESSION_CLOSED, the trace is flushed through session.exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccd-selfexit-'));
    dirs.push(dir);
    const tracePath = join(dir, 'trace.ndjson');
    const tk = await boot({ spec: { debug: { tracePath } } });
    // a waiter whose predicate can never hold once Claude is gone
    const never = tk.kernel.waitFor((s) => s.lifecycle === 'gated');
    const settled: { err?: unknown } = {};
    never.catch((e: unknown) => {
      settled.err = e;
    });
    tk.claude().terminate(1, null);
    await tk.waitForEvent('session.exited');
    await tk.until(() => settled.err !== undefined, 10_000, 'the waiter to reject');
    expect(codeOf(settled.err)).toBe('E_SESSION_CLOSED');
    await expect(tk.kernel.dispatch({ type: 'interrupt' })).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    // trace.close() ran: the buffered tail (including the exit event) reached the file (real fs: give it real time; the
    // flush timer is unref'd and fake-clocked, so only the teardown's close() can write it)
    const hasExit = (): boolean => {
      try {
        return readFileSync(tracePath, 'utf8').includes('"session.exited"');
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && !hasExit(); i++) await new Promise<void>((r) => setTimeout(r, 20));
    expect(hasExit()).toBe(true);
    // close() after the self-exit still settles (idempotent teardown)
    const info = await tk.close();
    expect(info.reason).toBeDefined();
  });
});

describe('hook forgery burst (SEC §2.3)', () => {
  it('five refused hook requests within 10 s → security.alert E_SECURITY_HOOK_FORGERY{count, windowMs, lastReason}', async () => {
    const tk = await boot();
    const t = tk.fakes.hooks.instances.at(-1);
    expect(t).toBeDefined();
    for (let i = 0; i < 5; i++) expect(t?.forge('token').status).toBe(403);
    const a = await tk.waitForEvent('security.alert');
    expect(a.payload).toEqual({ code: 'E_SECURITY_HOOK_FORGERY', detail: { count: 5, windowMs: 10_000, lastReason: 'token' } });
    await tk.close();
  });
});
