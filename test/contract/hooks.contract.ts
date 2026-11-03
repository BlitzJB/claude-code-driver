// test/contract/hooks.contract.ts — the shared HookTransport contract (DESIGN.md §2.7 "Fakes", §2.7.5, §3.5). WP-03 runs it
// against FakeHookTransport and the real worker-backed transport (hooks.contract.test.ts); both must behave identically as
// seen by L3 (events, hookSeq, holdable, respond-once, closed, nonce, close(heldBody), caps, 403, stats, worker death).
import { describe, expect, it, vi } from 'vitest';
import type { HookSeq } from '../../src/model/ids.js';
import type { HookTransportExtras } from '../../src/platform/hook-server/transport.js';
import type { HookEndpoint, HookTransport, RawHookEvent } from '../../src/platform/ports.js';
import type { ClientCall, ClientReply } from './hooks.contract.helpers.js';

interface CallOptions {
  via?: 'http' | 'unix';
  /** Make the body about this large (to cross the cap). */
  bytes?: number;
  /** Send a body that is not JSON (with valid credentials). */
  badJson?: boolean;
}

export interface HookHarness {
  transport: HookTransport & HookTransportExtras;
  call(ep: HookEndpoint, event: string, payload: unknown, o?: CallOptions): ClientCall;
  /** A request with a wrong token (HTTP) → expected 403. */
  forge(ep: HookEndpoint, event: string): Promise<ClientReply>;
  /** The worker dies unexpectedly. */
  crash(): Promise<void>;
  cleanup(): Promise<void>;
}

export type HarnessFactory = (o: { maxHeld?: number; maxBodyBytes?: number }) => Promise<HookHarness>;

const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
const DENY = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'closed' } } };
const BLOCK = '{"decision":"block","reason":"ccd self-test"}';
const PR = { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } };

function collect(t: HookTransport): RawHookEvent[] {
  const events: RawHookEvent[] = [];
  t.on((e) => events.push(e));
  return events;
}

async function nth(events: RawHookEvent[], n: number): Promise<RawHookEvent> {
  await vi.waitFor(
    () => {
      expect(events.length).toBeGreaterThanOrEqual(n);
    },
    { timeout: 5000, interval: 5 },
  );
  const e = events[n - 1];
  if (e === undefined) throw new Error('unreachable');
  return e;
}

export function hookTransportContract(name: string, make: HarnessFactory): void {
  describe(`HookTransport contract: ${name}`, () => {
    const withHarness = async (o: { maxHeld?: number; maxBodyBytes?: number }, fn: (h: HookHarness) => Promise<void>): Promise<void> => {
      const h = await make(o);
      try {
        await fn(h);
      } finally {
        await h.cleanup();
      }
    };

    it('start(http) returns an http + unix endpoint with absolute forwarder paths and a 64-hex token', async () => {
      await withHarness({}, async (h) => {
        const ep = await h.transport.start({ sessionShortId: 'sA1', transport: 'http' });
        expect(ep.transport).toBe('http');
        expect(ep.http?.urlBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/h\/sA1\/$/);
        expect(ep.http?.token).toMatch(/^[0-9a-f]{64}$/);
        expect(ep.unix.socketPath.endsWith('/h.sock')).toBe(true);
        expect(ep.unix.forwarderConfigPath.endsWith('/fwd.json')).toBe(true);
        expect(ep.forwarder.nodePath.startsWith('/')).toBe(true);
        expect(ep.forwarder.scriptPath.startsWith('/')).toBe(true);
        await expect(h.transport.start({ sessionShortId: 'sA1', transport: 'http' })).rejects.toThrow();
      });
    });

    it('start(unix) has no http part (no port is opened)', async () => {
      await withHarness({}, async (h) => {
        const ep = await h.transport.start({ sessionShortId: 'sB2', transport: 'unix' });
        expect(ep.transport).toBe('unix');
        expect(ep.http).toBeUndefined();
      });
    });

    it('observation events: empty 200, non-holdable RawHookEvent, hookSeq strictly increasing across transports', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        const a = await h.call(ep, 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Read' }).reply;
        expect(a).toEqual({ status: 200, body: '' });
        const b = await h.call(ep, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup' }).reply;
        expect(b).toEqual({ status: 200, body: '' }); // P-HOOK-25: the forwarder prints nothing
        const e1 = await nth(events, 1);
        const e2 = await nth(events, 2);
        expect(e1).toMatchObject({ event: 'PreToolUse', transport: 'http', holdable: false, truncated: false });
        expect(e1.payload).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
        expect(e1.bytes).toBeGreaterThan(0);
        expect(e1.closed).toBeUndefined();
        expect(e2).toMatchObject({ event: 'SessionStart', transport: 'unix', holdable: false });
        expect(e2.hookSeq).toBeGreaterThan(e1.hookSeq);
        expect(typeof e1.at).toBe('number');
        expect(typeof e1.wallAt).toBe('number');
        expect(h.transport.stats().received).toBe(2);
      });
    });

    it('PermissionRequest over the forwarder is held; respond() answers it exactly once', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        const c = h.call(ep, 'PermissionRequest', PR);
        const e = await nth(events, 1);
        expect(e).toMatchObject({ event: 'PermissionRequest', transport: 'unix', holdable: true });
        expect(e.closed).toBeInstanceOf(Promise);
        expect(h.transport.stats().held).toBe(1);
        expect(h.transport.respond(e.hookSeq, ALLOW)).toBe(true);
        expect(await c.reply).toEqual({ status: 200, body: JSON.stringify(ALLOW) });
        expect(h.transport.respond(e.hookSeq, DENY)).toBe(false);
        expect(h.transport.respond(9999 as HookSeq, ALLOW)).toBe(false);
        expect(h.transport.stats().held).toBe(0);
      });
    });

    it('respond(null) answers with an empty reply (the native dialog appears)', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        const c = h.call(ep, 'PermissionRequest', PR);
        const e = await nth(events, 1);
        expect(h.transport.respond(e.hookSeq, null)).toBe(true);
        expect(await c.reply).toEqual({ status: 200, body: '' });
      });
    });

    it('non-held events cannot be answered by respond()', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        await h.call(ep, 'Stop', { hook_event_name: 'Stop' }).reply;
        const e = await nth(events, 1);
        expect(h.transport.respond(e.hookSeq, ALLOW)).toBe(false);
      });
    });

    it('client abort mid-hold resolves closed with client_gone; the forwarder abort line gives timeout (P-HOOK-64)', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        const c1 = h.call(ep, 'PermissionRequest', PR);
        const e1 = await nth(events, 1);
        c1.abort();
        await expect(e1.closed).resolves.toBe('client_gone');
        expect(h.transport.respond(e1.hookSeq, ALLOW)).toBe(false);
        const c2 = h.call(ep, 'PermissionRequest', PR);
        const e2 = await nth(events, 2);
        c2.timeout();
        await expect(e2.closed).resolves.toBe('timeout');
        expect(h.transport.stats().held).toBe(0);
      });
    });

    it('self-test nonce: armed UPS with exactly the nonce gets the constant block body, nothing else does (D-35, P-LIFE-43)', async () => {
      for (const transport of ['http', 'unix'] as const) {
        await withHarness({}, async (h) => {
          const events = collect(h.transport);
          const ep = await h.transport.start({ sessionShortId: 's1', transport });
          const nonce = `ccd-selftest-${'ab'.repeat(16)}`;
          const ups = (prompt: string): Promise<ClientReply> =>
            h.call(ep, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt }).reply;
          expect(await ups(nonce)).toEqual({ status: 200, body: '' }); // not armed yet
          await h.transport.armSelfTestNonce(nonce);
          expect(await ups(nonce)).toEqual({ status: 200, body: BLOCK });
          expect(await ups(`${nonce} `)).toEqual({ status: 200, body: '' });
          expect(await ups('hello')).toEqual({ status: 200, body: '' });
          await h.transport.armSelfTestNonce(null);
          expect(await ups(nonce)).toEqual({ status: 200, body: '' });
          const all = await nth(events, 5);
          expect(all.event).toBe('UserPromptSubmit');
          expect(events.every((e) => e.transport === transport && !e.holdable)).toBe(true);
        });
      }
    });

    it('close(heldBody) answers every held request with heldBody; afterwards respond() is false', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        const c1 = h.call(ep, 'PermissionRequest', PR);
        const c2 = h.call(ep, 'PermissionRequest', { ...PR, tool_input: { command: 'pwd' } });
        const e2 = await nth(events, 2);
        await h.transport.close(DENY);
        expect(await c1.reply).toEqual({ status: 200, body: JSON.stringify(DENY) });
        expect(await c2.reply).toEqual({ status: 200, body: JSON.stringify(DENY) });
        expect(h.transport.respond(e2.hookSeq, ALLOW)).toBe(false);
        await h.transport.close(DENY); // idempotent
      });
    });

    it('more than maxHeld PermissionRequests: the excess is answered empty at once and is not holdable (SEC §2.7)', async () => {
      await withHarness({ maxHeld: 2 }, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        h.call(ep, 'PermissionRequest', PR);
        h.call(ep, 'PermissionRequest', PR);
        await nth(events, 2);
        const third = h.call(ep, 'PermissionRequest', PR);
        expect(await third.reply).toEqual({ status: 200, body: '' });
        const e3 = await nth(events, 3);
        expect(e3.holdable).toBe(false);
        expect(e3.closed).toBeUndefined();
        expect(h.transport.stats().held).toBe(2);
      });
    });

    it('a body over the cap is answered 200 empty and reported truncated with a null payload (never 413, P-HOOK-49)', async () => {
      for (const via of ['http', 'unix'] as const) {
        await withHarness({ maxBodyBytes: 4096 }, async (h) => {
          const events = collect(h.transport);
          const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
          const r = await h.call(ep, 'PostToolUse', { hook_event_name: 'PostToolUse' }, { via, bytes: 20_000 }).reply;
          expect(r).toEqual({ status: 200, body: '' });
          const e = await nth(events, 1);
          expect(e).toMatchObject({ event: 'PostToolUse', truncated: true, payload: null, transport: via });
          expect(e.bytes).toBeGreaterThan(4096);
          await vi.waitFor(() => {
            expect(h.transport.stats().truncated).toBe(1);
          });
        });
      }
    });

    it('authenticated bad JSON is answered 200 empty and produces no event', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        expect(await h.call(ep, 'Stop', null, { badJson: true }).reply).toEqual({ status: 200, body: '' });
        expect(await h.call(ep, 'Notification', null, { badJson: true, via: 'unix' }).reply).toEqual({ status: 200, body: '' });
        await h.call(ep, 'Stop', { ok: 1 }).reply;
        const e = await nth(events, 1);
        expect(e.payload).toEqual({ ok: 1 });
        expect(events).toHaveLength(1);
      });
    });

    it('a forged request gets 403, is counted and produces no event (SEC §2.3)', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        expect((await h.forge(ep, 'Stop')).status).toBe(403);
        await vi.waitFor(() => {
          expect(h.transport.stats().authFailures).toBe(1);
        });
        await h.call(ep, 'Stop', { a: 1 }).reply;
        await nth(events, 1);
        expect(events).toHaveLength(1);
      });
    });

    it('a burst of forged requests fires onForgery exactly once per window (→ E_SECURITY_HOOK_FORGERY, SEC §2.3)', async () => {
      await withHarness({}, async (h) => {
        const bursts: { count: number; lastReason: string | undefined }[] = [];
        h.transport.onForgery((b) => bursts.push({ count: b.count, lastReason: b.lastReason }));
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        for (let i = 0; i < 4; i += 1) expect((await h.forge(ep, 'Stop')).status).toBe(403);
        await vi.waitFor(() => {
          expect(h.transport.stats().authFailures).toBe(4);
        });
        expect(bursts).toEqual([]); // below the burst threshold: counted only
        for (let i = 0; i < 6; i += 1) expect((await h.forge(ep, 'Stop')).status).toBe(403);
        await vi.waitFor(() => {
          expect(h.transport.stats().authFailures).toBe(10);
        });
        expect(bursts).toHaveLength(1);
        expect(bursts[0]?.count).toBeGreaterThanOrEqual(5);
        expect(bursts[0]?.lastReason).toBe('token');
      });
    });

    it('PermissionRequest and SessionStart are never accepted over HTTP (anti-squatting, P-HOOK-18)', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        expect((await h.call(ep, 'PermissionRequest', PR, { via: 'http' }).reply).status).toBe(403);
        expect((await h.call(ep, 'SessionStart', {}, { via: 'http' }).reply).status).toBe(403);
        expect(events).toHaveLength(0);
      });
    });

    it("transport 'unix': observation events go through the forwarder and are answered at once", async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'unix' });
        expect(await h.call(ep, 'MessageDisplay', { text: 'x' }).reply).toEqual({ status: 200, body: '' });
        const e = await nth(events, 1);
        expect(e).toMatchObject({ event: 'MessageDisplay', transport: 'unix', holdable: false });
      });
    });

    it('worker death: onDied fires once, held requests close client_gone, respond() is false, arm rejects (P-REV-47)', async () => {
      await withHarness({}, async (h) => {
        const events = collect(h.transport);
        const died: Error[] = [];
        h.transport.onDied((e) => died.push(e));
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        h.call(ep, 'PermissionRequest', PR);
        const e = await nth(events, 1);
        await h.crash();
        await vi.waitFor(() => {
          expect(died).toHaveLength(1);
        });
        expect(died[0]?.name).toBe('HookWorkerDied');
        await expect(e.closed).resolves.toBe('client_gone');
        expect(h.transport.respond(e.hookSeq, ALLOW)).toBe(false);
        await expect(h.transport.armSelfTestNonce('ccd-selftest-x')).rejects.toThrow();
        expect(h.transport.stats().workerRestarts).toBe(0);
        await h.transport.close(null);
      });
    });

    it('a throwing listener does not stop delivery to the others', async () => {
      await withHarness({}, async (h) => {
        h.transport.on(() => {
          throw new Error('listener bug');
        });
        const events = collect(h.transport);
        const ep = await h.transport.start({ sessionShortId: 's1', transport: 'http' });
        await h.call(ep, 'Stop', {}).reply;
        await nth(events, 1);
        expect(events[0]?.event).toBe('Stop');
      });
    });
  });
}
