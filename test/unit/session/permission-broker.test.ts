// WP-13 session/permission-broker.ts (DESIGN.md §3.7 steps 3, 5, 7; §2.10 PermissionAsk; D-18 fail closed; P-SEC-36).
import { describe, expect, it } from 'vitest';
import type { Command, PermissionDecision } from '../../../src/model/commands.js';
import { CcdError } from '../../../src/model/errors.js';
import type { HookSeq, IntentId, PermissionKey } from '../../../src/model/ids.js';
import type { PermissionAsk } from '../../../src/model/kernel.js';
import type { ObservationInput } from '../../../src/model/observation.js';
import type { SessionState } from '../../../src/model/state.js';
import type { MonoMs } from '../../../src/model/time.js';
import { FakeClock, flushMicrotasks } from '../../../src/platform/clock/fake-clock.js';
import { createFakeHookTransportFactory, type FakeHookTransport } from '../../../src/platform/hook-server/fake-hooks.js';
import { FakeIds } from '../../../src/platform/ids/fake-ids.js';
import type { RawHookEvent } from '../../../src/platform/ports.js';
import {
  askFromState,
  createPermissionBroker,
  HANDLER_ERROR_MESSAGE,
  type PermissionBroker,
} from '../../../src/session/permission-broker.js';
import { MemoryLogger } from '../../../src/testing/fake-ports.js';

const P1 = 'p1' as PermissionKey;
const P2 = 'p2' as PermissionKey;
let ids = 0;
const id = (): IntentId => ++ids as IntentId;

function stateWith(): SessionState {
  const prov = { sources: [], confirmed: true, firstSeq: 1, lastSeq: 1 };
  const fact = <T>(value: T) => ({ value, src: 'hook', seq: 1, at: 0, corroborated: [], provisional: false });
  return {
    permissions: {
      p1: {
        key: 'p1',
        hookSeq: 1,
        toolName: 'Bash',
        input: { command: 'ls' },
        suggestions: [{ type: 'addRules' }],
        tool: 'u1',
        binding: { kind: 'unique', confirmed: true },
        state: fact('pending'),
        autoAnswerAllowed: true,
        needs: 'decision',
        requestedAt: 0,
        suspect: false,
        adopted: false,
        provenance: prov,
      },
      p2: {
        key: 'p2',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        suggestions: [],
        agent: 'a1',
        binding: { kind: 'unbound', confirmed: false },
        state: fact('pending'),
        autoAnswerAllowed: false,
        needs: 'answers',
        requestedAt: 0,
        suspect: false,
        adopted: false,
        provenance: prov,
      },
    },
    tools: { u1: { key: 'u1', name: 'Bash', input: { command: 'ls' }, turn: 't4', state: fact('awaitingPermission') } },
    agents: { a1: { key: 'a1', agentId: 'x', agentType: 'Explore', kind: 'subagent', background: true } },
  } as unknown as SessionState;
}

interface World {
  clock: FakeClock;
  hooks: FakeHookTransport;
  out: ObservationInput[];
  cmds: Command[];
  broker: PermissionBroker;
  logger: MemoryLogger;
  dispatchImpl: { fn: (c: Command) => Promise<unknown> };
}

async function world(): Promise<World> {
  const clock = new FakeClock();
  const hooks = createFakeHookTransportFactory().create({
    runtimeDir: '/rt/ccd-1',
    clock,
    ids: new FakeIds(),
    maxBodyBytes: 32 * 1024 * 1024,
    maxHeld: 32,
    maxConnections: 64,
    logger: new MemoryLogger(),
  });
  await hooks.start({ sessionShortId: 's1', transport: 'http' });
  const out: ObservationInput[] = [];
  const cmds: Command[] = [];
  const dispatchImpl = { fn: (_c: Command): Promise<unknown> => Promise.resolve({ ok: true }) };
  const logger = new MemoryLogger();
  const broker = createPermissionBroker({
    clock,
    hooks,
    emit: (x) => out.push(x),
    dispatch: (c) => {
      cmds.push(c);
      return dispatchImpl.fn(c);
    },
    getState: stateWith,
    logger,
  });
  return { clock, hooks, out, cmds, broker, logger, dispatchImpl };
}

const askIntent = (k: PermissionKey) =>
  ({ kind: 'host.askPermission', id: id(), permissionKey: k, deadlineAt: 121_000 as MonoMs }) as const;

function deliverHeld(w: World): { raw: RawHookEvent; call: ReturnType<FakeHookTransport['deliver']> } {
  let raw: RawHookEvent | undefined;
  const off = w.hooks.on((e) => {
    raw = e;
  });
  const call = w.hooks.deliver('PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
  off();
  if (raw === undefined) throw new Error('no raw event');
  return { raw, call };
}

describe('permission-broker: PermissionAsk from state', () => {
  it('carries the request’s own input, suggestions, needs, turn/tool/agent keys and background flag', () => {
    const ctl = new AbortController();
    const a = askFromState(stateWith(), P1, 5 as MonoMs, ctl.signal)!;
    expect(a).toMatchObject({
      permissionKey: 'p1',
      toolName: 'Bash',
      input: { command: 'ls' },
      suggestions: [{ type: 'addRules' }],
      needs: 'decision',
      turnKey: 't4',
      toolKey: 'u1',
      background: false,
      deadlineAt: 5,
    });
    expect(a.signal).toBe(ctl.signal);
    const b = askFromState(stateWith(), P2, 5 as MonoMs, ctl.signal)!;
    expect(b).toMatchObject({ needs: 'answers', agentKey: 'a1', background: true });
    expect(b.turnKey).toBeUndefined();
    expect(askFromState(stateWith(), 'p9' as PermissionKey, 5 as MonoMs, ctl.signal)).toBeUndefined();
  });
});

describe('permission-broker: background flag (§3.7 step 10, same rule as the core)', () => {
  it('a request that carries an agent is background even when that agent record is not', () => {
    const s = stateWith() as unknown as { agents: Record<string, { background: boolean }> };
    s.agents['a1']!.background = false;
    const a = askFromState(s as unknown as SessionState, P2, 5 as MonoMs, new AbortController().signal)!;
    expect(a.background).toBe(true);
  });

  it('a request bound to a tool of a background agent is background; a main-thread tool is not', () => {
    const s = stateWith() as unknown as { tools: Record<string, { agent?: string }> };
    expect(askFromState(s as unknown as SessionState, P1, 5 as MonoMs, new AbortController().signal)!.background).toBe(false);
    s.tools['u1']!.agent = 'a1';
    const a = askFromState(s as unknown as SessionState, P1, 5 as MonoMs, new AbortController().signal)!;
    expect(a).toMatchObject({ background: true, agentKey: 'a1' });
  });
});

describe('permission-broker: handler', () => {
  it('a decision → permission.answer{by:handler}', async () => {
    const w = await world();
    let seen: PermissionAsk | undefined;
    w.broker.setHandler((a) => {
      seen = a;
      return { behavior: 'allow' };
    });
    await w.broker.execute(askIntent(P1));
    await w.broker.idle();
    expect(seen?.toolName).toBe('Bash');
    expect(w.cmds).toEqual([{ type: 'permission.answer', permissionKey: 'p1', decision: { behavior: 'allow' }, by: 'handler' }]);
  });

  it('async handler; undefined → nothing (the host answers via the event)', async () => {
    const w = await world();
    w.broker.setHandler(() => Promise.resolve(undefined));
    await w.broker.execute(askIntent(P1));
    await w.broker.idle();
    expect(w.cmds).toEqual([]);
  });

  it('no handler → nothing', async () => {
    const w = await world();
    await w.broker.execute(askIntent(P1));
    await w.broker.idle();
    expect(w.cmds).toEqual([]);
  });

  it('D-18: throw, reject and invalid shapes all deny with the handler-error message', async () => {
    const bad: (() => PermissionDecision | Promise<PermissionDecision | undefined> | undefined)[] = [
      () => {
        throw new Error('boom');
      },
      () => Promise.reject(new Error('boom')),
      () => ({ behavior: 'maybe' }) as unknown as PermissionDecision,
      () => 'allow' as unknown as PermissionDecision,
      () => null as unknown as PermissionDecision,
    ];
    for (const h of bad) {
      const w = await world();
      w.broker.setHandler(h);
      await w.broker.execute(askIntent(P1));
      await w.broker.idle();
      expect(w.cmds).toEqual([
        { type: 'permission.answer', permissionKey: 'p1', decision: { behavior: 'deny', message: HANDLER_ERROR_MESSAGE }, by: 'handler' },
      ]);
    }
  });

  it('host.cancelAsk aborts the signal and the late result is dropped', async () => {
    const w = await world();
    let signal: AbortSignal | undefined;
    let resolve: (d: PermissionDecision) => void = () => undefined;
    w.broker.setHandler(
      (a) =>
        new Promise<PermissionDecision>((r) => {
          signal = a.signal;
          resolve = r;
        }),
    );
    const p = w.broker.execute(askIntent(P1));
    await flushMicrotasks();
    expect(w.broker.activeAsks()).toEqual(['p1']);
    await w.broker.execute({ kind: 'host.cancelAsk', id: id(), permissionKey: P1, reason: 'policyTimeout' });
    expect(signal?.aborted).toBe(true);
    expect(w.broker.activeAsks()).toEqual([]);
    resolve({ behavior: 'allow' });
    await p;
    await w.broker.idle();
    expect(w.cmds).toEqual([]);
  });

  it('host.askPermission never blocks on user code: a hung handler can still be cancelled by the next intent', async () => {
    const w = await world();
    let signal: AbortSignal | undefined;
    w.broker.setHandler((a) => {
      signal = a.signal;
      return new Promise<PermissionDecision | undefined>(() => undefined); // never settles
    });
    // A caller that awaits every intent in order must reach the cancel.
    await w.broker.execute(askIntent(P1));
    expect(w.broker.activeAsks()).toEqual(['p1']);
    await w.broker.execute({ kind: 'host.cancelAsk', id: id(), permissionKey: P1, reason: 'policyTimeout' });
    expect(signal?.aborted).toBe(true);
    expect(w.broker.activeAsks()).toEqual([]);
    expect(w.cmds).toEqual([]);
  });

  it('idle() waits for a slow handler and its dispatched answer', async () => {
    const w = await world();
    w.broker.setHandler(async () => {
      await w.clock.sleep(1000);
      return { behavior: 'deny', message: 'no' };
    });
    await w.broker.execute(askIntent(P1));
    expect(w.cmds).toEqual([]);
    const idle = w.broker.idle();
    await w.clock.advanceAsync(1000);
    await idle;
    expect(w.cmds).toEqual([
      { type: 'permission.answer', permissionKey: 'p1', decision: { behavior: 'deny', message: 'no' }, by: 'handler' },
    ]);
  });

  it('a core refusal other than structuredAnswerRequired is logged; the broker sends nothing else', async () => {
    const w = await world();
    w.dispatchImpl.fn = () => Promise.reject(new CcdError('E_PERMISSION_INVALID', 'bad', { details: { reason: 'dangerousMode' } }));
    w.broker.setHandler(() => ({ behavior: 'allow' }));
    await w.broker.execute(askIntent(P1));
    await w.broker.idle();
    expect(w.cmds).toHaveLength(1);
    expect(w.logger.records.some((r) => r.level === 'warn' && r.msg.includes('core refused'))).toBe(true);
  });

  it('a second ask for the same key aborts the first handler run', async () => {
    const w = await world();
    const signals: AbortSignal[] = [];
    w.broker.setHandler((a) => {
      signals.push(a.signal);
      return new Promise<PermissionDecision | undefined>(() => undefined);
    });
    void w.broker.execute(askIntent(P1));
    await flushMicrotasks();
    void w.broker.execute(askIntent(P1));
    await flushMicrotasks();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it('E_PERMISSION_INVALID{structuredAnswerRequired} keeps the request pending (logged, no deny)', async () => {
    const w = await world();
    w.dispatchImpl.fn = () =>
      Promise.reject(new CcdError('E_PERMISSION_INVALID', 'needs answers', { details: { reason: 'structuredAnswerRequired' } }));
    w.broker.setHandler(() => ({ behavior: 'allow' }));
    await w.broker.execute(askIntent(P2));
    await w.broker.idle();
    expect(w.cmds).toHaveLength(1);
    expect(w.logger.records.some((r) => r.level === 'warn' && r.msg.includes('stays pending'))).toBe(true);
  });

  it('an unknown permission key is logged and the handler is not called', async () => {
    const w = await world();
    let called = false;
    w.broker.setHandler(() => {
      called = true;
      return { behavior: 'allow' };
    });
    await w.broker.execute(askIntent('p9' as PermissionKey));
    await w.broker.idle();
    expect(called).toBe(false);
    expect(w.cmds).toEqual([]);
  });

  it('close aborts every running handler and drops its result', async () => {
    const w = await world();
    let signal: AbortSignal | undefined;
    let resolve: (d: PermissionDecision) => void = () => undefined;
    w.broker.setHandler(
      (a) =>
        new Promise<PermissionDecision>((r) => {
          signal = a.signal;
          resolve = r;
        }),
    );
    const p = w.broker.execute(askIntent(P1));
    await flushMicrotasks();
    w.broker.close();
    expect(signal?.aborted).toBe(true);
    resolve({ behavior: 'allow' });
    await p;
    await w.broker.idle();
    expect(w.cmds).toEqual([]);
    await w.broker.execute(askIntent(P1));
    await w.broker.idle();
    expect(w.cmds).toEqual([]);
  });
});

describe('permission-broker: hook intents', () => {
  it('hook.respond answers the held request with the typed body and reports hook.responded', async () => {
    const w = await world();
    const { raw, call } = deliverHeld(w);
    w.broker.trackHookEvent(raw);
    const body = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest' as const, decision: { behavior: 'deny' as const, message: 'no' } },
    };
    const i = { kind: 'hook.respond' as const, id: id(), hookSeq: raw.hookSeq, body };
    await w.broker.execute(i);
    expect(w.hooks.responses).toEqual([{ hookSeq: raw.hookSeq, body }]);
    expect(JSON.parse((await call.reply).body)).toEqual(body);
    expect(w.out).toEqual([
      {
        kind: 'hook.responded',
        meta: expect.objectContaining({ source: 'self', origin: { kind: 'self', intentId: i.id } }) as unknown,
        p: { hookSeq: raw.hookSeq, ok: true, clientGone: false },
      },
    ]);
  });

  it('a null body is the empty reply (dialog stays for a human)', async () => {
    const w = await world();
    const { raw, call } = deliverHeld(w);
    await w.broker.execute({ kind: 'hook.respond', id: id(), hookSeq: raw.hookSeq, body: null });
    expect((await call.reply).body).toBe('');
  });

  it('§3.7 step 7: the forwarder leaves before we answered → permission.hookClosed; a later respond reports clientGone', async () => {
    const w = await world();
    const { raw, call } = deliverHeld(w);
    w.broker.trackHookEvent(raw);
    call.abort('client_gone');
    await flushMicrotasks();
    expect(w.out).toEqual([
      {
        kind: 'permission.hookClosed',
        meta: expect.objectContaining({
          source: 'hook',
          origin: { kind: 'hook', transport: 'unix', event: 'PermissionRequest', hookSeq: raw.hookSeq },
        }) as unknown,
        p: { hookSeq: raw.hookSeq, reason: 'client_gone' },
      },
    ]);
    await w.broker.execute({ kind: 'hook.respond', id: id(), hookSeq: raw.hookSeq, body: null });
    expect(w.out[1]).toMatchObject({ kind: 'hook.responded', p: { ok: false, clientGone: true } });
  });

  it('releaseUnclaimed answers a held request L1 rejected with an empty reply, once; non-holdable ignored (ICR 0026)', async () => {
    const w = await world();
    const { raw, call } = deliverHeld(w);
    w.broker.trackHookEvent(raw);
    expect(call.settled()).toBeUndefined();
    w.broker.releaseUnclaimed(raw);
    expect(await call.reply).toEqual({ status: 200, body: '' });
    expect(w.hooks.responses).toEqual([{ hookSeq: raw.hookSeq, body: null }]);
    expect(w.hooks.stats().held).toBe(0);
    expect(w.out).toEqual([
      expect.objectContaining({ kind: 'hook.responded', p: { hookSeq: raw.hookSeq, ok: true, clientGone: false } }) as unknown,
    ]);
    w.broker.releaseUnclaimed(raw);
    w.broker.releaseUnclaimed({ ...raw, hookSeq: 98 as HookSeq, holdable: false });
    expect(w.hooks.responses).toHaveLength(1);
    expect(w.out).toHaveLength(1);
  });

  it('a close that crossed our answer (answer lost) is reported as hook.responded{ok:false, clientGone}; non-holdable ignored', async () => {
    const w = await world();
    const { raw } = deliverHeld(w);
    let close: (r: 'client_gone' | 'timeout') => void = () => undefined;
    const fakeRaw: RawHookEvent = { ...raw, closed: new Promise((r) => (close = r)) };
    w.broker.trackHookEvent(fakeRaw);
    await w.broker.execute({ kind: 'hook.respond', id: id(), hookSeq: raw.hookSeq, body: null });
    expect(w.out[0]).toMatchObject({ kind: 'hook.responded', p: { ok: true, clientGone: false } });
    // The transport resolves `closed` after respond only when the worker reports the forwarder gone before the answer
    // reached it (worker-respond-result-dropped): the core must learn the answer was lost.
    close('timeout');
    await flushMicrotasks();
    expect(w.out.map((x) => x.kind)).toEqual(['hook.responded', 'hook.responded']);
    expect(w.out[1]).toMatchObject({ kind: 'hook.responded', p: { hookSeq: raw.hookSeq, ok: false, clientGone: true } });
    w.out.splice(0);
    w.broker.trackHookEvent({ ...raw, hookSeq: 99 as HookSeq, holdable: false, closed: Promise.resolve('timeout') });
    await flushMicrotasks();
    expect(w.out).toEqual([]);
  });

  it('hook.armSelfTest / disarmSelfTest → transport arm + hook.selfTestArmed acks', async () => {
    const w = await world();
    await w.broker.execute({ kind: 'hook.armSelfTest', id: id(), nonce: 'ccd-selftest-abc' });
    await w.broker.execute({ kind: 'hook.disarmSelfTest', id: id() });
    expect(w.hooks.armHistory).toEqual(['ccd-selftest-abc', null]);
    expect(w.out.map((x) => x.p)).toEqual([
      { nonce: 'ccd-selftest-abc', armed: true },
      { nonce: 'ccd-selftest-abc', armed: false },
    ]);
  });

  it('an arm failure emits channel.health hooks degraded, never a false ack', async () => {
    const w = await world();
    await w.hooks.close(null);
    await w.broker.execute({ kind: 'hook.armSelfTest', id: id(), nonce: 'n1' });
    expect(w.out).toEqual([
      expect.objectContaining({ kind: 'channel.health', p: { channel: 'hooks', health: 'degraded', reason: 'selfTestArmFailed' } }),
    ]);
  });
});
