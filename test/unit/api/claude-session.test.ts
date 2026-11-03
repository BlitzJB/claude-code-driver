// DESIGN.md §2.12 ClaudeSession over a scripted SessionKernel: start, send/Turn routing, events, permissions, close/exit,
// closeAll across package copies, signal handlers. Pitfalls: P-API-06/07/09/22/29, P-REV-42/43, P-LIFE-29, D-31.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeSession,
  installSignalHandlersOn,
  setKernelFactory,
  wrapKernel,
  type SignalProcess,
} from '../../../src/api/claude-session.js';
import { ClaudeSessionError, isClaudeSessionError } from '../../../src/api/map-errors.js';
import type { ClaudeSessionOptions } from '../../../src/api/options.js';
import type { PermissionRequest, SessionEvent } from '../../../src/api/public-types.js';
import { CcdError } from '../../../src/model/errors.js';
import type { AgentKey, EventSeq, PermissionKey, ToolKey, TurnKey } from '../../../src/model/ids.js';
import type { PermissionAsk } from '../../../src/model/kernel.js';
import type { SessionSpec } from '../../../src/model/spec.js';
import type { SessionState } from '../../../src/model/state.js';
import type { MonoMs } from '../../../src/model/time.js';
import { fact, FakeKernel, permissionRecord, readyState, turnRecord, WALL_OFFSET } from './fake-kernel.js';

const OPTS: ClaudeSessionOptions = { cwd: '/w', permissions: 'ask' };
const noop = (): void => undefined;
const tick = () => new Promise((r) => setTimeout(r, 0));
const K = (s: string) => s as TurnKey;
const REGISTRY = Symbol.for('claude-code-driver.api-sessions.v1');
const registry = () => (globalThis as unknown as Record<symbol, Set<{ close(o?: unknown): Promise<unknown> }>>)[REGISTRY];

function setup(opts: Partial<ClaudeSessionOptions> = {}, state?: SessionState) {
  const k = new FakeKernel(state);
  const s = wrapKernel(k, { ...OPTS, ...opts });
  const seen: SessionEvent[] = [];
  s.onAny((e) => void seen.push(e));
  return { k, s, seen };
}

function withTurn(key: string, over: Parameters<typeof turnRecord>[1] = {}) {
  return (st: SessionState): SessionState => ({
    ...st,
    turns: { ...st.turns, [key]: turnRecord(key, over) },
    turnOrder: [...st.turnOrder, K(key)],
  });
}

afterEach(async () => {
  setKernelFactory(undefined);
  await ClaudeSession.closeAll();
});

describe('ClaudeSession.start', () => {
  it('maps the options, passes logger and signal beside the spec, installs the handler, resolves with a session', async () => {
    const k = new FakeKernel();
    const calls: unknown[][] = [];
    setKernelFactory((...a: never[]) => {
      calls.push(a);
      return Promise.resolve(k);
    });
    const logger = { debug: noop, info: noop, warn: noop, error: noop };
    const ac = new AbortController();
    const handler = (): undefined => undefined;
    const s = await ClaudeSession.start({ cwd: '/w', permissions: handler, model: 'opus', logger, signal: ac.signal });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({ cwd: '/w', permissions: { policy: 'handler' }, model: 'opus' } satisfies SessionSpec);
    expect(calls[0]?.[1]).toEqual({ logger, signal: ac.signal });
    expect(k.handler).toBeTypeOf('function');
    expect(s.key).toBe(k.sessionKey);
    expect(s.cwd).toBe('/w');
    expect(s.claudeSessionId).toBe('claude-session-1');
  });

  it('P-REV-42: rejects E_CONFIG before any kernel is created', async () => {
    const factory = vi.fn();
    setKernelFactory(factory);
    await expect(ClaudeSession.start({ cwd: '/w' } as ClaudeSessionOptions)).rejects.toMatchObject({
      code: 'E_CONFIG',
      details: { path: 'permissions' },
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('maps a startup CcdError to its public code and keeps the internal code as reason', async () => {
    setKernelFactory(() => Promise.reject(new CcdError('E_CLAUDE_VERSION_MISMATCH', 'found 2.1.300', { details: { found: '2.1.300' } })));
    const e: unknown = await ClaudeSession.start(OPTS).catch((x: unknown) => x);
    expect(isClaudeSessionError(e, 'E_VERSION_MISMATCH')).toBe(true);
    expect((e as { details: unknown }).details).toEqual({ found: '2.1.300', reason: 'E_CLAUDE_VERSION_MISMATCH' });
  });

  it('an already-aborted signal rejects without launching', async () => {
    const factory = vi.fn();
    setKernelFactory(factory);
    const ac = new AbortController();
    ac.abort();
    await expect(ClaudeSession.start({ ...OPTS, signal: ac.signal })).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    ['no reason (DOMException)', undefined],
    ['a string reason', 'user cancelled'],
    ['an Error reason', new Error('x')],
  ] as const)('an abort during launch with %s rejects one ClaudeSessionError shape: E_SESSION_CLOSED{aborted}', async (_, reason) => {
    const ac = new AbortController();
    // as runtime/node.ts abortError(): the reason if it is an Error, else an Error named AbortError (or the DOMException)
    setKernelFactory(
      () =>
        new Promise((_res, rej) => {
          ac.signal.addEventListener('abort', () => {
            const r: unknown = ac.signal.reason;
            if (r instanceof Error) rej(r);
            else rej(Object.assign(new Error(String(r)), { name: 'AbortError' }));
          });
        }),
    );
    const p = ClaudeSession.start({ ...OPTS, signal: ac.signal });
    await tick();
    ac.abort(reason);
    const e: unknown = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ClaudeSessionError);
    expect(e).toMatchObject({ code: 'E_SESSION_CLOSED', details: { reason: 'E_SESSION_CLOSED', detail: 'aborted' } });
    expect((e as Error).cause).toBeDefined();
  });

  it.skipIf(existsSync(join(import.meta.dirname, '../../../src/runtime/node.ts')))(
    'without runtime/node.ts (not landed) start rejects E_INTERNAL instead of throwing a raw import error',
    async () => {
      await expect(ClaudeSession.start(OPTS)).rejects.toMatchObject({ code: 'E_INTERNAL' });
    },
  );

  it('a factory whose module lacks createKernel is reported as E_INTERNAL', async () => {
    setKernelFactory(() => Promise.reject(new TypeError('createKernel is not a function')));
    await expect(ClaudeSession.start(OPTS)).rejects.toMatchObject({ code: 'E_INTERNAL', details: { reason: 'E_INVARIANT' } });
  });
});

describe('send() and Turn', () => {
  it('binds the provisional key through turn.queued.clientRef, routes turn events, resolves accepted and done', async () => {
    const { k, s, seen } = setup();
    k.respond = () => new Promise(() => undefined); // the dispatch result never arrives: binding must come from the event
    const turn = s.send('hello');
    expect(turn.key).toBe('pending:1');
    expect(s.turn(K('pending:1'))).toBe(turn);
    expect(k.dispatched[0]).toEqual({ type: 'prompt.send', text: 'hello', clientRef: 'pending:1', whenBusy: 'wait' });
    k.ev(
      'turn.queued',
      { prompt: 'hello', origin: 'library', clientRef: 'pending:1' },
      { turnKey: K('t1') },
      withTurn('t1', { state: fact('queued') }),
    );
    expect(turn.key).toBe('t1');
    expect(s.turn(K('t1'))).toBe(turn);
    k.ev('turn.accepted', { promptId: 'pid-1' }, { turnKey: K('t1') }, withTurn('t1', { promptId: 'pid-1', acceptedAt: 2000 as MonoMs }));
    expect(await turn.accepted).toEqual({ promptId: 'pid-1' });
    k.ev('assistant.textDelta', { msgKey: 'm1' as never, index: 0, delta: 'hi', final: true }, { turnKey: K('t1') });
    k.ev(
      'turn.ended',
      { outcome: 'completed', endedBy: 'stop', finalText: 'hi there', durationMs: 42 },
      { turnKey: K('t1') },
      withTurn('t1', { state: fact('completed') }),
    );
    const r = await turn.done;
    expect(r).toMatchObject({ turnKey: 't1', outcome: 'completed', text: 'hi there', durationMs: 42 });
    expect(await turn.completed()).toBe(r);
    const types: string[] = [];
    for await (const e of turn) types.push(e.type);
    expect(types).toEqual(['turnQueued', 'turnStarted', 'text', 'turnEnded']);
    expect(seen.map((e) => e.type)).toEqual(types);
    expect(turn.snapshot()).toMatchObject({ key: 't1', state: 'completed' });
    expect(seen.every((e) => e.at > WALL_OFFSET)).toBe(true);
  });

  it('binds from the dispatch result when it arrives first', async () => {
    const { k, s } = setup();
    const turn = s.send('x', { whenBusy: 'reject' });
    expect(k.dispatched[0]).toMatchObject({ whenBusy: 'reject' });
    await tick();
    expect(turn.key).toBe('t1');
    expect(s.turn(K('t1'))).toBe(turn);
  });

  it('a rejected dispatch (E_BUSY) resolves done as notSubmitted and rejects accepted, without unhandled rejections', async () => {
    const { k, s } = setup();
    k.reject('E_BUSY', 'busy');
    const turn = s.send('x', { whenBusy: 'reject' });
    const r = await turn.done;
    expect(r.outcome).toBe('notSubmitted');
    expect(r.error?.code).toBe('E_BUSY');
    await expect(turn.accepted).rejects.toMatchObject({ code: 'E_BUSY', details: { reason: 'E_BUSY' } });
    expect(s.turn(K('pending:1'))).toBeUndefined();
  });

  it('send() after close or exit returns a failed turn without dispatching', async () => {
    const { k, s } = setup();
    await s.close();
    const t = s.send('late');
    expect((await t.done).error?.code).toBe('E_SESSION_CLOSED');
    expect(k.dispatched).toEqual([]);
    const b = setup();
    b.k.exit({ exitStatus: 1, signal: null, reason: 'crashed' });
    expect((await b.s.send('x').done).error?.code).toBe('E_SESSION_EXITED');
  });

  it('turn.interrupt(): one atomic turn.stop whatever state the facade last read (no read-then-dispatch race); a send signal stops', async () => {
    const { k, s } = setup();
    const t = s.send('a');
    await tick();
    // the facade read 'queued', but by the time the command runs the core may have made the submit current: the core decides
    k.emit([], withTurn('t1', { state: fact('queued') }));
    await t.interrupt();
    expect(k.dispatched.at(-1)).toEqual({ type: 'turn.stop', turnKey: 't1' });
    expect(k.dispatched.some((c) => c.type === 'prompt.cancel')).toBe(false);
    k.emit([], withTurn('t1', { state: fact('running') }));
    await t.interrupt();
    expect(k.dispatched.at(-1)).toEqual({ type: 'turn.stop', turnKey: 't1' });

    const ac = new AbortController();
    const t2 = s.send('b', { signal: ac.signal });
    await tick();
    k.emit([], withTurn('t2', { state: fact('running') }));
    ac.abort();
    await tick();
    expect(k.dispatched.at(-1)).toEqual({ type: 'turn.stop', turnKey: 't2' });
    expect(t2.key).toBe('t2');
    const pre = new AbortController();
    pre.abort();
    expect((await s.send('c', { signal: pre.signal }).done).error?.details.reason).toBe('E_TURN_ABORTED');
  });

  it('external turns get a handle; self-test turns get none and are not listed', () => {
    const { k, s, seen } = setup();
    k.ev('turn.queued', { prompt: 'cron', origin: 'scheduled' }, { turnKey: K('t3') }, withTurn('t3', { origin: fact('scheduled') }));
    k.ev(
      'turn.queued',
      { prompt: 'ccd-selftest-x', origin: 'selftest' },
      { turnKey: K('t4') },
      withTurn('t4', { origin: fact('selftest') }),
    );
    expect(s.turn(K('t3'))?.prompt).toBe('cron');
    expect(s.turn(K('t4'))).toBeUndefined();
    expect(seen.map((e) => e.type)).toEqual(['externalTurn']);
    expect(s.turns().map((t) => [t.key, t.origin])).toEqual([['t3', 'external']]);
  });
});

describe('events', () => {
  it('pre-start history is not delivered; P-API-22 replayed events are suppressed', () => {
    const { k, seen } = setup();
    k.ev('compaction', { phase: 'started' }, { replayed: true });
    k.ev('compaction', { phase: 'ended' });
    expect(seen.map((e) => [e.type, (e.data as { phase: string }).phase])).toEqual([['compaction', 'ended']]);
  });

  it('on(type) only gets its type; unsubscribe stops delivery', () => {
    const { k, s } = setup();
    const got: string[] = [];
    const off = s.on('channel', (e) => void got.push(e.data.health));
    k.ev('channel.health', { channel: 'screen', health: 'degraded' });
    k.ev('compaction', { phase: 'started' });
    off();
    k.ev('channel.health', { channel: 'screen', health: 'up' });
    expect(got).toEqual(['degraded']);
  });

  it('P-API-06: a throwing listener is logged and reported as a warning; other listeners still get the event', () => {
    const errors: unknown[] = [];
    const logger = { debug: noop, info: noop, warn: noop, error: (m: string, f?: unknown) => void errors.push([m, f]) };
    const { k, s, seen } = setup({ logger });
    s.on('compaction', () => {
      throw new Error('user bug');
    });
    s.on('warning', () => {
      throw new Error('second bug');
    });
    k.ev('compaction', { phase: 'started' });
    expect(seen.map((e) => e.type)).toEqual(['warning', 'compaction']);
    expect(seen[0]?.data).toMatchObject({ code: 'E_INTERNAL', reason: 'E_LISTENER_THREW' });
    expect(errors).toHaveLength(2);
  });

  it('events(): filtered by type, ends after exited; a kernel gap becomes a gap event', async () => {
    const { k, s } = setup();
    const it1 = s.events({ types: ['compaction', 'gap', 'exited'] });
    k.ev('compaction', { phase: 'started' });
    k.ev('channel.health', { channel: 'screen', health: 'up' });
    k.emit([], undefined, { from: 3 as EventSeq, to: 9 as EventSeq });
    k.exit({ exitStatus: 0, signal: null, reason: 'exitedByItself' });
    const got: string[] = [];
    for await (const e of it1) got.push(e.type);
    expect(got).toEqual(['compaction', 'gap', 'exited']);
    const after = s.events();
    expect(await after.next()).toEqual({ value: undefined, done: true });
  });

  it('events({fromSeq}) replays from the kernel ring; fromSeq 0 includes replayed events; break unsubscribes', async () => {
    const { k, s } = setup();
    k.ev('compaction', { phase: 'started' }, { replayed: true });
    k.ev('compaction', { phase: 'ended' });
    const before = k.subscriberCount;
    const all = s.events({ fromSeq: 0, types: ['compaction'] });
    const fresh = s.events({ fromSeq: 1, types: ['compaction'] });
    expect(k.subscriberCount).toBe(before + 2);
    const phase = (r: IteratorResult<SessionEvent, unknown>): string | undefined =>
      r.done === true ? undefined : (r.value.data as { phase: string }).phase;
    const a = [await all.next(), await all.next()].map(phase);
    expect(a).toEqual(['started', 'ended']);
    const f = await fresh.next();
    expect(phase(f)).toBe('ended');
    await all.return?.();
    await fresh.return?.();
    expect(k.subscriberCount).toBe(before);
  });

  it('P-API-09: a never-read session iterator holds highWaterMark events, then one gap; break unsubscribes it', async () => {
    const { k, s } = setup();
    const q = s.events({ highWaterMark: 2, types: ['compaction', 'gap'] });
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) seqs.push(k.ev('compaction', { phase: 'started' }).seq);
    const got: SessionEvent[] = [];
    for await (const e of q) {
      got.push(e);
      if (got.length === 3) break;
    }
    expect(got.map((e) => e.type)).toEqual(['compaction', 'compaction', 'gap']);
    expect(got[2]?.data).toEqual({ from: seqs[2], to: seqs[4] });
    k.ev('compaction', { phase: 'ended' });
    expect(await q.next()).toEqual({ value: undefined, done: true });
  });

  it('events({fromSeq}) after exit: replays up to exited and ends; a fromSeq past the exit ends at once', async () => {
    const { k, s } = setup();
    const c = k.ev('compaction', { phase: 'started' });
    k.exit({ exitStatus: 0, signal: null, reason: 'exitedByItself' });
    await s.exited;
    const subs = k.subscriberCount;
    const replay: string[] = [];
    for await (const e of s.events({ fromSeq: c.seq })) replay.push(e.type);
    expect(replay).toEqual(['compaction', 'exited']);
    const past = s.events({ fromSeq: k.state.lastEventSeq + 5 });
    expect(await past.next()).toEqual({ value: undefined, done: true });
    expect(k.subscriberCount).toBe(subs);
  });

  it('state is a cached mapping of the kernel snapshot; status follows', () => {
    const { k, s } = setup();
    const a = s.state;
    expect(s.state).toBe(a);
    expect(s.status.kind).toBe('idle');
    k.emit([], (st) => ({ ...st, status: { kind: 'compacting', since: 3000 as MonoMs } }));
    expect(s.state).not.toBe(a);
    expect(s.status).toEqual({ kind: 'compacting', since: expect.any(Number) as number });
  });
});

describe('commands', () => {
  it('maps every method onto its kernel command', async () => {
    const { k, s } = setup();
    expect(await s.command('/compact', 'focus', { unsafe: true })).toEqual({ output: 'ran /compact' });
    expect(await s.command('/usage')).toEqual({ output: 'ran /usage' });
    expect(await s.interrupt()).toEqual({});
    const P = 'p1' as PermissionKey;
    await s.respondToPermission(P, { behavior: 'deny', message: 'no' });
    await s.answerQuestion(P, { q1: 'a' });
    await s.approvePlan(P, { approve: true, mode: 'acceptEdits', feedback: 'ok' });
    await s.approvePlan(P, { approve: false });
    await s.setMode('plan');
    await s.wakeNow();
    expect(k.dispatched).toEqual([
      { type: 'slash.run', name: '/compact', args: 'focus', unsafe: true },
      { type: 'slash.run', name: '/usage' },
      { type: 'interrupt' },
      { type: 'permission.answer', permissionKey: 'p1', decision: { behavior: 'deny', message: 'no' }, by: 'host' },
      { type: 'permission.answerQuestion', permissionKey: 'p1', answers: { q1: 'a' } },
      { type: 'permission.approvePlan', permissionKey: 'p1', approve: true, mode: 'acceptEdits', feedback: 'ok' },
      { type: 'permission.approvePlan', permissionKey: 'p1', approve: false },
      { type: 'mode.set', mode: 'plan' },
      { type: 'usage.wakeNow' },
    ]);
    k.respond = () => ({ turnKey: 't7' });
    expect(await s.interrupt()).toEqual({ turnKey: 't7' });
    k.respond = () => ({ ok: true, effect: 'none' });
    expect(await s.command('/clear')).toEqual({});
  });

  it('kernel rejections become public errors', async () => {
    const { k, s } = setup();
    k.reject('E_PERMISSION_UNKNOWN');
    await expect(s.respondToPermission('p9' as PermissionKey, { behavior: 'allow' })).rejects.toMatchObject({
      code: 'E_PERMISSION_INVALID',
      details: { reason: 'E_PERMISSION_UNKNOWN' },
    });
    k.reject('E_COMMAND_FORBIDDEN');
    await expect(s.command('/exit', undefined, { unsafe: true })).rejects.toMatchObject({ code: 'E_INPUT_REJECTED' });
  });

  it('debug passes through the kernel diagnostics', async () => {
    const { k, s } = setup();
    expect(s.debug.viewCommand()).toContain('attach -r');
    expect(await s.debug.captureScreen()).toBe('screen text');
    expect(s.debug.tracePath).toBe('/tmp/trace.ccd.jsonl');
    k.diagnostics.captureScreen = () => Promise.reject(new CcdError('E_SESSION_EXITED', 'gone'));
    await expect(s.debug.captureScreen()).rejects.toMatchObject({ code: 'E_SESSION_EXITED' });
  });
});

describe('waits', () => {
  it('waitFor maps snapshots; E_WAIT_TIMEOUT becomes E_TIMEOUT', async () => {
    const { k, s } = setup();
    const p = s.waitFor((x) => x.status.kind === 'compacting');
    k.emit([], (st) => ({ ...st, status: { kind: 'compacting', since: 1 as MonoMs } }));
    expect((await p).status.kind).toBe('compacting');
    await expect(s.waitFor(() => false, { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'E_TIMEOUT',
      details: { reason: 'E_WAIT_TIMEOUT' },
    });
  });

  it('waitForIdle needs an empty queue; waitForQuiescence needs quiescent; both reject E_SESSION_EXITED on exit', async () => {
    const { k, s } = setup(
      {},
      readyState({
        status: { kind: 'idle', since: 1 as MonoMs, backgroundAgents: 1, queued: 0, quiescent: false },
        libraryQueue: [K('t1')],
      }),
    );
    const idle = s.waitForIdle();
    const quiet = s.waitForQuiescence();
    let idleDone = false;
    void idle.then(() => (idleDone = true));
    await tick();
    expect(idleDone).toBe(false);
    k.emit([], (st) => ({ ...st, libraryQueue: [] }));
    expect((await idle).queuedTurns).toEqual([]);
    k.exit({ exitStatus: 0, signal: null, reason: 'exitedByItself' });
    await expect(quiet).rejects.toMatchObject({ code: 'E_SESSION_EXITED' });
  });
});

describe('permission handler', () => {
  const ask = (k: FakeKernel, over: Partial<PermissionAsk> = {}): PermissionAsk => ({
    permissionKey: 'p1' as PermissionKey,
    toolName: 'Bash',
    input: { command: 'ls' },
    suggestions: [],
    needs: 'decision',
    background: true,
    deadlineAt: 9000 as MonoMs,
    signal: new AbortController().signal,
    turnKey: K('t1'),
    toolKey: 'u1' as ToolKey,
    agentKey: 'a1' as AgentKey,
    ...over,
    ...(k.state.permissions['p1' as PermissionKey] === undefined ? {} : {}),
  });

  it('maps the ask to a PermissionRequest with wall-clock times and returns the decision', () => {
    const reqs: PermissionRequest[] = [];
    const { k } = setup(
      { permissions: (r) => (reqs.push(r), { behavior: 'allow' }) },
      readyState({ permissions: { ['p1' as PermissionKey]: permissionRecord('p1') } }),
    );
    k.ev('compaction', { phase: 'started' }); // anchors the mono→wall offset
    const a = ask(k);
    expect(k.handler?.(a)).toEqual({ behavior: 'allow' });
    expect(reqs[0]).toEqual({
      key: 'p1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      suggestions: [],
      needs: 'decision',
      background: true,
      requestedAt: WALL_OFFSET + 1500,
      deadlineAt: WALL_OFFSET + 9000,
      signal: a.signal,
      turnKey: 't1',
      toolKey: 'u1',
      subagentKey: 'a1',
    });
  });

  it('fails closed: a throwing or rejecting handler denies; undefined asks the host', async () => {
    const errors: unknown[] = [];
    const logger = { debug: noop, info: noop, warn: noop, error: (m: string) => void errors.push(m) };
    const { k: k1 } = setup({
      logger,
      permissions: () => {
        throw new Error('bug');
      },
    });
    expect(k1.handler?.(ask(k1, { turnKey: undefined as never, toolKey: undefined as never, agentKey: undefined as never }))).toEqual({
      behavior: 'deny',
      message: 'permission handler failed',
    });
    const { k: k2 } = setup({ logger, permissions: { policy: async () => Promise.reject(new Error('async bug')) } });
    expect(await k2.handler?.(ask(k2))).toEqual({ behavior: 'deny', message: 'permission handler failed' });
    const { k: k3 } = setup({ permissions: () => undefined });
    expect(k3.handler?.(ask(k3))).toBeUndefined();
    expect(errors).toHaveLength(2);
    const { k: k4 } = setup({ permissions: 'deny' });
    expect(k4.handler).toBeNull();
  });

  it('P-REV-08: an async decision passes through unchanged; a rejecting non-native thenable also fails closed', async () => {
    const decision = { behavior: 'allow', updatedInput: { answers: { q: 'a' } } } as const;
    const { k: k1 } = setup({ permissions: async () => Promise.resolve(decision) });
    expect(await k1.handler?.(ask(k1, { needs: 'answers' }))).toBe(decision);
    const thenable = {
      then: (_ok: unknown, fail: (e: unknown) => void): void => {
        fail(new Error('foreign realm'));
      },
    };
    const { k: k2 } = setup({ permissions: () => thenable as unknown as Promise<undefined> });
    expect(await k2.handler?.(ask(k2))).toEqual({ behavior: 'deny', message: 'permission handler failed' });
  });
});

describe('close and exit (D-31: exited always resolves)', () => {
  it('close() maps options, resolves exited, is idempotent, abandons open turns and rejects later calls', async () => {
    const { k, s, seen } = setup();
    const t = s.send('long');
    await tick();
    const a = s.close({ mode: 'kill', graceMs: 10, waitForBackgroundMs: 5 });
    const b = s.close();
    expect(await a).toEqual({ exitStatus: 0, signal: null, reason: 'killed' });
    expect(await b).toEqual(await a);
    expect(k.closeCalls).toEqual([{ mode: 'kill', reason: 'host', graceMs: 10, waitForBackgroundMs: 5 }]);
    expect(await s.exited).toEqual({ exitStatus: 0, signal: null, reason: 'killed' });
    expect((await t.done).outcome).toBe('unknown');
    expect(seen.at(-1)?.type).toBe('exited');
    await expect(s.command('/x')).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
    expect(registry()?.has(s as never)).toBe(false);
  });

  it('close() resolving before the kernel published session.exited still delivers exactly one exited event', async () => {
    const { k, s, seen } = setup();
    const it1 = s.events({ types: ['exited'] });
    k.closeImpl = () => Promise.resolve({ exitStatus: 0, signal: null, reason: 'closed' });
    const info = await s.close();
    expect(seen.filter((e) => e.type === 'exited').map((e) => e.data)).toEqual([info]);
    const got: string[] = [];
    for await (const e of it1) got.push(e.type);
    expect(got).toEqual(['exited']);
    expect(k.subscriberCount).toBe(0);
  });

  it('close() resolving before session.exited also ends replaying iterators (opened before and after the close), with one exited', async () => {
    const { k, s } = setup();
    const c = k.ev('compaction', { phase: 'started' });
    const before = s.events({ fromSeq: 0, types: ['compaction', 'exited'] });
    k.closeImpl = () => Promise.resolve({ exitStatus: 0, signal: null, reason: 'closed' });
    await s.close();
    const drain = async (it: AsyncIterableIterator<SessionEvent>): Promise<string[]> => {
      const got: string[] = [];
      const timeout = new Promise<'hang'>((r) =>
        setTimeout(() => {
          r('hang');
        }, 200),
      );
      const run = (async () => {
        for await (const e of it) got.push(e.type);
        return 'ended' as const;
      })();
      expect(await Promise.race([run, timeout])).toBe('ended');
      return got;
    };
    expect(await drain(before)).toEqual(['compaction', 'exited']);
    const after = s.events({ fromSeq: c.seq, types: ['compaction', 'exited'] });
    expect(await drain(after)).toEqual(['compaction', 'exited']);
    expect(k.subscriberCount).toBe(0);
  });

  it('a failed close rejects with a public error and may be retried', async () => {
    const { k, s } = setup();
    k.closeImpl = () => Promise.reject(new CcdError('E_INVARIANT', 'boom'));
    await expect(s.close()).rejects.toMatchObject({ code: 'E_INTERNAL' });
    k.closeImpl = undefined;
    expect((await s.close()).reason).toBe('closed');
  });

  it('Claude exiting by itself resolves exited and ends unbound turns as notSubmitted', async () => {
    const { k, s } = setup();
    k.respond = () => new Promise(() => undefined);
    const t = s.send('x');
    k.exit({ exitStatus: 1, signal: 'SIGSEGV', reason: 'crashed' });
    expect(await s.exited).toEqual({ exitStatus: 1, signal: 'SIGSEGV', reason: 'crashed' });
    expect((await t.done).error?.code).toBe('E_SESSION_EXITED');
    expect(k.subscriberCount).toBe(0);
  });

  it('a kernel that is already exited at wrap time yields an exited session', async () => {
    const st = readyState({ exit: { exitStatus: 0, signal: null, reason: 'closed' }, lifecycle: 'exited' });
    const { s } = setup({}, st);
    expect((await s.exited).reason).toBe('exitedByItself');
  });

  it('aborting the start signal closes with mode kill', async () => {
    const ac = new AbortController();
    const { k, s } = setup({ signal: ac.signal });
    ac.abort();
    expect((await s.exited).reason).toBe('killed');
    expect(k.closeCalls[0]).toMatchObject({ mode: 'kill' });
  });

  it('a start signal that is already aborted when the session is wrapped closes it with mode kill', async () => {
    const ac = new AbortController();
    ac.abort();
    const { k, s } = setup({ signal: ac.signal });
    expect((await s.exited).reason).toBe('killed');
    expect(k.closeCalls).toEqual([{ mode: 'kill', reason: 'host' }]);
  });

  it('the abort listener is removed once the session exited (no close after exit, no listener leak)', async () => {
    const ac = new AbortController();
    const removed = vi.spyOn(ac.signal, 'removeEventListener');
    const { k, s } = setup({ signal: ac.signal });
    k.exit({ exitStatus: 0, signal: null, reason: 'exitedByItself' });
    await s.exited;
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    ac.abort();
    expect(k.closeCalls).toEqual([]);
  });

  it('P-API-29: Symbol.asyncDispose closes the session', async () => {
    const { k, s } = setup();
    expect(typeof Symbol.asyncDispose).toBe('symbol');
    await s[Symbol.asyncDispose]();
    expect(k.closeCalls).toHaveLength(1);
  });
});

describe('closeAll (P-REV-43: shared by every package copy)', () => {
  it('closes this copy’s sessions and closables registered by another copy under the same global symbol', async () => {
    const { k, s } = setup();
    const foreign = { close: vi.fn(() => Promise.resolve({})) };
    registry()?.add(foreign);
    await ClaudeSession.closeAll();
    expect(k.closeCalls).toHaveLength(1);
    expect(foreign.close).toHaveBeenCalledWith({});
    registry()?.delete(foreign);
    expect((await s.exited).reason).toBe('closed');
  });
});

describe('two installed package copies (P-REV-43, P-API-12)', () => {
  it('closeAll() of one module instance closes sessions of another; errors of one copy are recognised by the other', async () => {
    vi.resetModules();
    const other = await import('../../../src/api/claude-session.js');
    const otherErrors = await import('../../../src/api/map-errors.js');
    vi.resetModules();
    expect(other.ClaudeSession).not.toBe(ClaudeSession);
    const kA = new FakeKernel();
    const kB = new FakeKernel();
    const a = wrapKernel(kA, OPTS);
    const b = other.wrapKernel(kB, OPTS);
    expect(registry()?.has(b as never)).toBe(true);
    await ClaudeSession.closeAll();
    expect((await b.exited).reason).toBe('closed');
    expect((await a.exited).reason).toBe('closed');
    expect(kB.closeCalls).toHaveLength(1);
    const foreign = otherErrors.publicError('E_BUSY', 'busy');
    expect(foreign).not.toBeInstanceOf(ClaudeSessionError);
    expect(isClaudeSessionError(foreign, 'E_BUSY')).toBe(true);
  });
});

describe('installSignalHandlersOn (P-LIFE-29, LC §7)', () => {
  class FakeProc implements SignalProcess {
    readonly pid = 4242;
    handlers = new Map<string, Set<() => void>>();
    kills: [number, string][] = [];
    exits: number[] = [];
    on(sig: NodeJS.Signals, fn: () => void): void {
      (this.handlers.get(sig) ?? this.handlers.set(sig, new Set()).get(sig))?.add(fn);
    }
    off(sig: NodeJS.Signals, fn: () => void): void {
      this.handlers.get(sig)?.delete(fn);
    }
    kill(pid: number, sig: NodeJS.Signals): void {
      this.kills.push([pid, sig]);
    }
    exit(code: number): void {
      this.exits.push(code);
    }
    fire(sig: string): void {
      for (const fn of [...(this.handlers.get(sig) ?? [])]) fn();
    }
    count(): number {
      return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
    }
  }
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('first signal: graceful closeAll, then handlers removed and the signal re-raised', async () => {
    const proc = new FakeProc();
    const { k, s } = setup();
    installSignalHandlersOn(proc, { graceMs: 7 });
    expect(proc.count()).toBe(3);
    proc.fire('SIGTERM');
    await s.exited;
    await tick();
    expect(k.closeCalls[0]).toMatchObject({ mode: 'graceful', graceMs: 7 });
    expect(proc.count()).toBe(0);
    expect(proc.kills).toEqual([[4242, 'SIGTERM']]);
    expect(proc.exits).toEqual([]);
  });

  it('a second signal of the same kind escalates to kill and exits 128+n; uninstall removes everything', async () => {
    const proc = new FakeProc();
    const { k } = setup();
    k.closeImpl = (o) =>
      o.mode === 'kill' ? Promise.resolve({ exitStatus: null, signal: 'SIGKILL', reason: 'killed' }) : new Promise(() => undefined);
    installSignalHandlersOn(proc);
    proc.fire('SIGINT');
    proc.fire('SIGHUP'); // a different signal during shutdown is ignored
    proc.fire('SIGINT');
    await tick();
    await tick();
    expect(k.closeCalls.map((c) => c.mode)).toEqual(['graceful', 'kill']);
    expect(proc.exits).toEqual([130]);
    expect(proc.kills).toEqual([]);
    const proc2 = new FakeProc();
    const off = installSignalHandlersOn(proc2);
    off();
    expect(proc2.count()).toBe(0);
  });
});

describe('ClaudeSession.usage (ICR 0040)', () => {
  it('maps the kernel usage report and picks the session and all-models meters', async () => {
    const { k, s } = setup();
    k.usageReport = {
      meters: [
        { window: 'session', label: 'Current session', usedPct: 3, resetsText: '9:50pm (Etc/UTC)' },
        { window: 'week', scope: 'Fable', label: 'Current week (Fable)', usedPct: 56 },
        {
          window: 'week',
          scope: 'all models',
          label: 'Current week (all models)',
          usedPct: 98,
          resetsText: 'Nov 3 at 7:30pm (Etc/UTC)',
        },
      ],
      credits: 'off',
      readAt: 777,
    };
    const u = await s.usage();
    expect(u.session?.usedPct).toBe(3);
    expect(u.week).toEqual({
      window: 'week',
      scope: 'all models',
      label: 'Current week (all models)',
      usedPct: 98,
      resetsText: 'Nov 3 at 7:30pm (Etc/UTC)',
    });
    expect(u.meters).toHaveLength(3);
    expect(u.credits).toBe('off');
    expect(u.readAt).toBe(777);
  });

  it('maps an unreadable dialog to the public E_ENVIRONMENT error', async () => {
    const { k, s } = setup();
    k.usageReport = new CcdError('E_USAGE_UNAVAILABLE', 'no meters', { details: { reason: 'noMeters' } });
    const e: unknown = await s.usage().catch((x: unknown) => x);
    expect(isClaudeSessionError(e)).toBe(true);
    expect(e).toMatchObject({ code: 'E_ENVIRONMENT' });
  });

  it('refuses after close', async () => {
    const { s } = setup();
    await s.close();
    await expect(s.usage()).rejects.toMatchObject({ code: 'E_SESSION_CLOSED' });
  });
});
