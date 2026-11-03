// platform/hook-server/fake-hooks.ts — in-memory HookTransport (DESIGN.md §2.7 "Fakes", §6.4 hooks faults). Same observable
// contract as the real transport (test/contract/hooks.contract.ts runs against both): hookSeq per transport, holdable only for
// PermissionRequest over unix, `respond` once, `closed` on client abort, the self-test nonce block body, `close(heldBody)`,
// held/connection caps, body cap with `truncated`, 403 for forged requests. No sockets, no worker, no files.
//
// Fault hooks (§6.4): `failNextStart` (endpoint refuse), `setHang` (accept-and-hang), `deliver(...).abort()` (client abort
// mid-hold), `forge` (bad token/Host/Origin), `deliver(..., {bytes})` over the cap, `crash()` (worker crash), more than
// `maxHeld` held requests.
import type { HookSeq } from '../../model/ids.js';
import type { Cancel } from '../../model/time.js';
import type { HookEndpoint, HookTransport, HookTransportFactory, RawHookEvent } from '../ports.js';
import { HookTransportError, HookWorkerDied } from './errors.js';
import { DEFAULT_MAX_BODY_BYTES } from './body.js';
import { DEFAULT_MAX_HELD, FWD_CONFIG_NAME, HOLD_HOOK_EVENTS, HTTP_HOOK_EVENTS, SOCKET_NAME, UNIX_HOOK_EVENTS } from './transport.js';
import type { DetailedHookStats, ForgeryBurst, HookTransportExtras } from './transport.js';
import { SELF_TEST_BLOCK_BODY } from './worker.js';

type CreateOptions = Parameters<HookTransportFactory['create']>[0];

/** What "Claude" received for one hook call. */
export interface FakeHookReply {
  status: 200 | 403;
  /** '' = empty body (HTTP 200 with Content-Length 0, or the forwarder printing nothing). */
  body: string;
}

export interface FakeHookCall {
  /** Undefined when the call never produced an event (403, unknown unix event, bad JSON). */
  readonly hookSeq: HookSeq | undefined;
  readonly transport: 'http' | 'unix';
  /** Resolves when the call is answered (never, while held or with `setHang(true)`). */
  readonly reply: Promise<FakeHookReply>;
  /** The reply if already answered. */
  settled(): FakeHookReply | undefined;
  /** The client (forwarder) goes away; a held request resolves `closed` with `reason`. */
  abort(reason?: 'client_gone' | 'timeout'): void;
}

export interface FakeDeliverOptions {
  transport?: 'http' | 'unix';
  /** Body size to pretend (default: the JSON length of the payload). Over `maxBodyBytes` → truncated, payload null. */
  bytes?: number;
  /** Simulate a body that is not JSON (authenticated): answered, counted, no event. */
  badJson?: boolean;
}

interface PendingCall {
  resolve: (r: FakeHookReply) => void;
  reply: FakeHookReply | undefined;
}

export class FakeHookTransport implements HookTransport, HookTransportExtras {
  readonly options: CreateOptions;
  #endpoint: HookEndpoint | undefined;
  #state: 'new' | 'open' | 'closed' | 'dead' = 'new';
  #seq = 0;
  #nonce: string | null = null;
  #hang = false;
  #failNext: Error | undefined;
  readonly #listeners = new Set<(e: RawHookEvent) => void>();
  readonly #died = new Set<(e: HookWorkerDied) => void>();
  readonly #forgery = new Set<(b: ForgeryBurst) => void>();
  readonly #held = new Map<number, { call: PendingCall; closed: (r: 'client_gone' | 'timeout') => void }>();
  #received = 0;
  #dropped = 0;
  #truncated = 0;
  #authFailures = 0;
  #badJson = 0;
  #heldOverflow = 0;
  /** Same burst rule as the real transport: `count` failures within `windowMs` (injected clock) → one `onForgery` per window. */
  readonly #burst: { count: number; windowMs: number };
  #authWindow = { startedAt: 0, count: 0, fired: false };
  /** Every `respond` that reached a held request, in order. */
  readonly responses: { hookSeq: HookSeq; body: object | null }[] = [];
  /** Every self-test arm/disarm, in order. */
  readonly armHistory: (string | null)[] = [];
  /** The heldBody passed to `close`, once closed. */
  closedWith: object | null | undefined;

  constructor(o: CreateOptions, burst: { count: number; windowMs: number } = { count: 5, windowMs: 10_000 }) {
    this.options = o;
    this.#burst = burst;
  }

  // ---- fault configuration ----
  /** The next `start()` rejects (endpoint refuse / EADDRINUSE / worker start failure). */
  failNextStart(err: Error = new HookTransportError('EADDRINUSE', 'hook worker failed to start: listen EADDRINUSE')): void {
    this.#failNext = err;
  }

  /** Accept-and-hang: observation calls are received but never answered (Claude would wait for its hook timeout). */
  setHang(on: boolean): void {
    this.#hang = on;
  }

  get endpoint(): HookEndpoint | undefined {
    return this.#endpoint;
  }

  get armedNonce(): string | null {
    return this.#nonce;
  }

  get state(): 'new' | 'open' | 'closed' | 'dead' {
    return this.#state;
  }

  // ---- HookTransport ----
  start(so: { sessionShortId: string; transport: 'http' | 'unix' }): Promise<HookEndpoint> {
    if (this.#state !== 'new') return Promise.reject(new HookTransportError('alreadyStarted', 'HookTransport.start() may be called once'));
    if (this.#failNext !== undefined) {
      const err = this.#failNext;
      this.#failNext = undefined;
      this.#state = 'closed';
      return Promise.reject(err);
    }
    const dir = this.options.runtimeDir;
    const port = 40000 + (Number.parseInt(this.options.ids.shortHex(4), 16) % 20000);
    this.#endpoint = {
      transport: so.transport,
      ...(so.transport === 'http'
        ? { http: { port, urlBase: `http://127.0.0.1:${port}/h/${so.sessionShortId}/`, token: this.options.ids.tokenHex(32) } }
        : {}),
      unix: { socketPath: `${dir}/${SOCKET_NAME}`, forwarderConfigPath: `${dir}/${FWD_CONFIG_NAME}` },
      forwarder: { nodePath: '/usr/local/bin/node', scriptPath: '/fake/dist/platform/hook-server/standalone/forward.js' },
    };
    this.#state = 'open';
    return Promise.resolve(this.#endpoint);
  }

  on(l: (e: RawHookEvent) => void): Cancel {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }

  onDied(fn: (err: HookWorkerDied) => void): Cancel {
    this.#died.add(fn);
    return () => {
      this.#died.delete(fn);
    };
  }

  onForgery(fn: (b: ForgeryBurst) => void): Cancel {
    this.#forgery.add(fn);
    return () => {
      this.#forgery.delete(fn);
    };
  }

  respond(hookSeq: HookSeq, body: object | null): boolean {
    if (this.#state !== 'open') return false;
    const h = this.#held.get(hookSeq);
    if (h === undefined) return false;
    this.#held.delete(hookSeq);
    this.responses.push({ hookSeq, body });
    let text = '';
    if (body !== null) {
      try {
        const s = JSON.stringify(body);
        text = s === '{}' ? '' : s;
      } catch {
        text = '';
      }
    }
    settle(h.call, { status: 200, body: text });
    return true;
  }

  armSelfTestNonce(nonce: string | null): Promise<void> {
    if (nonce !== null && (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 256))
      return Promise.reject(new HookTransportError('badNonce', 'nonce must be a non-empty string of at most 256 characters'));
    if (this.#state === 'dead') return Promise.reject(new HookWorkerDied(null));
    if (this.#state !== 'open') return Promise.reject(new HookTransportError('notOpen', 'hook transport is not open'));
    this.#nonce = nonce;
    this.armHistory.push(nonce);
    return Promise.resolve();
  }

  close(heldBody: object | null): Promise<void> {
    if (this.#state === 'closed') return Promise.resolve();
    let text = '';
    if (heldBody !== null) {
      try {
        const s = JSON.stringify(heldBody);
        text = s === '{}' ? '' : s;
      } catch {
        text = '';
      }
    }
    for (const [, h] of this.#held) settle(h.call, { status: 200, body: text });
    this.#held.clear();
    this.closedWith = heldBody;
    this.#state = 'closed';
    return Promise.resolve();
  }

  stats(): { received: number; dropped: number; truncated: number; authFailures: number; held: number; workerRestarts: number } {
    return {
      received: this.#received,
      dropped: this.#dropped,
      truncated: this.#truncated,
      authFailures: this.#authFailures,
      held: this.#held.size,
      workerRestarts: 0,
    };
  }

  detailedStats(): DetailedHookStats {
    return {
      authFailures: this.#authFailures,
      dropped: this.#dropped,
      truncated: this.#truncated,
      badJson: this.#badJson,
      heldOverflow: this.#heldOverflow,
      connectionOverflow: 0,
      queueOverflow: 0,
      held: this.#held.size,
      received: this.#received,
    };
  }

  // ---- drivers (what Claude would do) ----
  /** One hook call from "Claude". SessionStart/PermissionRequest default to the forwarder (unix), others to the endpoint transport. */
  deliver(event: string, payload: unknown, o: FakeDeliverOptions = {}): FakeHookCall {
    const ep = this.#endpoint;
    const transport =
      o.transport ?? (ep?.transport === 'unix' || event === 'SessionStart' || event === 'PermissionRequest' ? 'unix' : 'http');
    const call: PendingCall = { resolve: () => undefined, reply: undefined };
    const reply = new Promise<FakeHookReply>((resolve) => {
      call.resolve = resolve;
    });
    const ref: { seq: HookSeq | undefined } = { seq: undefined };
    const handle = (): FakeHookCall => ({
      hookSeq: ref.seq,
      transport,
      reply,
      settled: () => call.reply,
      abort: (reason: 'client_gone' | 'timeout' = 'client_gone') => {
        if (ref.seq === undefined) return;
        const h = this.#held.get(ref.seq);
        if (h === undefined) return;
        this.#held.delete(ref.seq);
        h.closed(reason);
      },
    });

    if (this.#state !== 'open' || ep === undefined) {
      // Endpoint refuses: Claude sees a connection error (HTTP) or the forwarder prints nothing (unix).
      return handle();
    }
    const known = transport === 'http' ? (ep.transport === 'http' ? HTTP_HOOK_EVENTS : []) : UNIX_HOOK_EVENTS;
    if (!known.includes(event)) {
      if (transport === 'http') {
        this.#authFailure('event');
        settle(call, { status: 403, body: '' });
      } else {
        this.#dropped += 1;
        settle(call, { status: 200, body: '' });
      }
      return handle();
    }
    if (o.badJson === true) {
      this.#badJson += 1;
      settle(call, { status: 200, body: '' });
      return handle();
    }
    const bytes = o.bytes ?? Buffer.byteLength(payload === undefined ? 'null' : JSON.stringify(payload));
    const max = this.options.maxBodyBytes > 0 ? this.options.maxBodyBytes : DEFAULT_MAX_BODY_BYTES;
    const truncated = bytes > max;
    const holdEvent = transport === 'unix' && HOLD_HOOK_EVENTS.includes(event) && !truncated;
    const maxHeld = this.options.maxHeld >= 0 ? this.options.maxHeld : DEFAULT_MAX_HELD;
    const overHeld = holdEvent && this.#held.size >= maxHeld;
    const holdable = holdEvent && !overHeld;
    if (overHeld) {
      this.#dropped += 1;
      this.#heldOverflow += 1;
    }
    if (truncated) this.#truncated += 1;

    this.#seq += 1;
    const hookSeq = this.#seq as HookSeq;
    ref.seq = hookSeq;
    const e: RawHookEvent = {
      hookSeq,
      at: this.options.clock.now(),
      wallAt: this.options.clock.wallNow(),
      transport,
      event,
      bytes,
      truncated,
      payload: truncated ? null : payload,
      holdable,
    };
    if (holdable) {
      const seq = hookSeq;
      e.closed = new Promise<'client_gone' | 'timeout'>((resolve) => {
        this.#held.set(seq, { call, closed: resolve });
      });
    } else if (!this.#hang) {
      const isNonce =
        !truncated &&
        this.#nonce !== null &&
        event === 'UserPromptSubmit' &&
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { prompt?: unknown }).prompt === this.#nonce;
      settle(call, { status: 200, body: isNonce ? SELF_TEST_BLOCK_BODY : '' });
    }
    this.#received += 1;
    for (const l of [...this.#listeners]) {
      try {
        l(e);
      } catch {
        // like the real transport: a throwing listener never breaks delivery
      }
    }
    return handle();
  }

  /** A forged request (bad token / Host / Origin / Content-Type): 403, counted, no event. */
  forge(reason = 'token'): FakeHookReply {
    this.#authFailure(reason);
    return { status: 403, body: '' };
  }

  /** The worker crashed: held requests close (`client_gone`), `onDied` fires, the transport is dead. */
  crash(exitCode = 1): void {
    if (this.#state !== 'open') return;
    this.#state = 'dead';
    for (const [, h] of this.#held) h.closed('client_gone');
    this.#held.clear();
    const err = new HookWorkerDied(exitCode);
    for (const l of [...this.#died]) {
      try {
        l(err);
      } catch {
        // like the real transport: listener bugs never break the transport
      }
    }
  }

  #authFailure(reason: string): void {
    this.#authFailures += 1;
    const now = this.options.clock.now();
    const w = this.#authWindow;
    if (now - w.startedAt > this.#burst.windowMs) {
      w.startedAt = now;
      w.count = 0;
      w.fired = false;
    }
    w.count += 1;
    if (w.fired || w.count < this.#burst.count) return;
    w.fired = true;
    const b: ForgeryBurst = { count: w.count, windowMs: this.#burst.windowMs, lastReason: reason };
    for (const l of [...this.#forgery]) {
      try {
        l(b);
      } catch {
        // like the real transport: listener bugs never break the transport
      }
    }
  }
}

function settle(call: PendingCall, r: FakeHookReply): void {
  if (call.reply !== undefined) return;
  call.reply = r;
  call.resolve(r);
}

export interface FakeHookTransportFactory extends HookTransportFactory {
  create(o: CreateOptions): FakeHookTransport;
  /** Every transport created, in order. */
  readonly instances: FakeHookTransport[];
}

export function createFakeHookTransportFactory(): FakeHookTransportFactory {
  const instances: FakeHookTransport[] = [];
  return {
    instances,
    create(o: CreateOptions): FakeHookTransport {
      const t = new FakeHookTransport(o);
      instances.push(t);
      return t;
    },
  };
}
