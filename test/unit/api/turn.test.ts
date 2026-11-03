// DESIGN.md §2.12 Turn, D-31, P-API-07: `done` never rejects, `accepted` is never an unhandled rejection.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publicError } from '../../../src/api/map-errors.js';
import type { SessionEvent, TurnKey, TurnResult, TurnSnapshot } from '../../../src/api/public-types.js';
import { TurnImpl, type TurnHost } from '../../../src/api/turn.js';

const K = (s: string) => s as TurnKey;
const base = { seq: 1, at: 1, provenance: { confirmed: true, sources: [] } } as const;
const started = (seq: number, key = 't1'): SessionEvent => ({
  ...base,
  seq,
  type: 'turnStarted',
  turnKey: K(key),
  data: { promptId: 'pid-1' },
});
const queued = (seq: number, key = 't1'): SessionEvent => ({
  ...base,
  seq,
  type: 'turnQueued',
  turnKey: K(key),
  data: { prompt: 'hi', origin: 'library' },
});
const ended = (seq: number, r: Partial<TurnResult> = {}): SessionEvent => ({
  ...base,
  seq,
  type: 'turnEnded',
  turnKey: K('t1'),
  data: { turnKey: K('t1'), outcome: 'completed', text: 'answer', refused: false, tools: [], durationMs: 5, ...r },
});

class Host implements TurnHost {
  snaps = new Map<TurnKey, TurnSnapshot>();
  stopped: TurnKey[] = [];
  snapshotOf(key: TurnKey): TurnSnapshot | undefined {
    return this.snaps.get(key);
  }
  stopTurn(key: TurnKey): Promise<void> {
    this.stopped.push(key);
    return Promise.resolve();
  }
}

const unhandled: unknown[] = [];
const onUnhandled = (r: unknown): void => void unhandled.push(r);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('TurnImpl', () => {
  it('starts with a provisional key and binds once', () => {
    const t = new TurnImpl(new Host(), 'hi', K('pending:1'));
    expect(t.key).toBe('pending:1');
    expect(t.isBound).toBe(false);
    t.bind(K('t1'));
    t.bind(K('t9'));
    expect(t.key).toBe('t1');
    expect(t.ref).toBe('pending:1');
  });

  it('accepted resolves on turnStarted; done resolves on turnEnded; completed() returns the result', async () => {
    const t = new TurnImpl(new Host(), 'hi', K('pending:1'));
    t.bind(K('t1'));
    t.deliver(queued(1));
    t.deliver(started(2));
    expect(await t.accepted).toEqual({ promptId: 'pid-1' });
    t.deliver(ended(3));
    t.deliver(started(4)); // after the end: ignored
    const r = await t.done;
    expect(r).toMatchObject({ outcome: 'completed', text: 'answer' });
    expect(await t.completed()).toBe(r);
    expect(t.isFinished).toBe(true);
  });

  it('P-API-07: a rejected accepted that nobody awaits is not an unhandled rejection; done still resolves', async () => {
    const t = new TurnImpl(new Host(), 'hi', K('pending:1'));
    t.fail(publicError('E_BUSY', 'busy'));
    await settle();
    expect(unhandled).toEqual([]);
    const r = await t.done;
    expect(r).toMatchObject({ turnKey: 'pending:1', outcome: 'notSubmitted', text: '', tools: [], durationMs: 0 });
    expect(r.error?.code).toBe('E_BUSY');
    await expect(t.accepted).rejects.toMatchObject({ code: 'E_BUSY' });
    await expect(t.completed()).rejects.toMatchObject({ code: 'E_BUSY' });
    t.fail(publicError('E_CONFIG_INVALID', 'second')); // idempotent
    expect((await t.done).error?.code).toBe('E_BUSY');
  });

  it('a turn that ended before it was accepted rejects accepted with the result error', async () => {
    const t = new TurnImpl(new Host(), 'hi', K('t1'));
    t.bind(K('t1'));
    t.deliver(ended(1, { outcome: 'notSubmitted', error: publicError('E_SUBMIT_UNCONFIRMED', 'no ack') }));
    await expect(t.accepted).rejects.toMatchObject({ code: 'E_SUBMIT_UNCONFIRMED' });
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('completed without a turnStarted still resolves accepted (promptId from the snapshot); a non-completed turn with a known promptId too', async () => {
    const h = new Host();
    h.snaps.set(K('t1'), {
      key: K('t1'),
      prompt: 'hi',
      origin: 'library',
      state: 'completed',
      tools: [],
      subagents: [],
      text: '',
      promptId: 'p-snap',
    });
    const t = new TurnImpl(h, 'hi', K('pending:1'));
    t.bind(K('t1'));
    t.deliver(ended(1));
    expect(await t.accepted).toEqual({ promptId: 'p-snap' });

    const t2 = new TurnImpl(h, 'hi', K('pending:2'));
    t2.bind(K('t1'));
    t2.deliver(ended(1, { outcome: 'interrupted' }));
    expect(await t2.accepted).toEqual({ promptId: 'p-snap' });
    await expect(t2.completed()).rejects.toMatchObject({ code: 'E_TURN_FAILED', details: { reason: 'E_TURN_INTERRUPTED' } });

    const t3 = new TurnImpl(new Host(), 'hi', K('pending:3'));
    t3.deliver(ended(1));
    expect(await t3.accepted).toEqual({ promptId: '' });
  });

  it('abandon (session exited) resolves done with outcome unknown', async () => {
    const t = new TurnImpl(new Host(), 'hi', K('t1'));
    t.bind(K('t1'));
    t.abandon(publicError('E_SESSION_EXITED', 'gone'));
    expect(await t.done).toMatchObject({ outcome: 'unknown', error: { code: 'E_SESSION_EXITED' } });
    await expect(t.accepted).rejects.toMatchObject({ code: 'E_SESSION_EXITED' });
  });

  it('events() replays the history from creation and ends after turnEnded; for-await over the turn works', async () => {
    const t = new TurnImpl(new Host(), 'hi', K('pending:1'));
    t.bind(K('t1'));
    t.deliver(queued(1));
    const it1 = t.events();
    t.deliver(started(2));
    const live: SessionEvent[] = [];
    const reading = (async () => {
      for await (const e of t) live.push(e);
    })();
    t.deliver(ended(3));
    const all: SessionEvent[] = [];
    for await (const e of it1) all.push(e);
    await reading;
    expect(all.map((e) => e.type)).toEqual(['turnQueued', 'turnStarted', 'turnEnded']);
    expect(live.map((e) => e.type)).toEqual(['turnQueued', 'turnStarted', 'turnEnded']);
    const after: SessionEvent[] = [];
    for await (const e of t.events()) after.push(e);
    expect(after).toHaveLength(3);
  });

  it('a history longer than its cap starts the iterator with a gap', async () => {
    const t = new TurnImpl(new Host(), 'hi', K('t1'));
    for (let i = 1; i <= 1003; i++)
      t.deliver({ ...base, seq: i, type: 'text', turnKey: K('t1'), data: { delta: 'x', messageId: 'm1', final: false } });
    t.deliver(ended(1004));
    const got: SessionEvent[] = [];
    for await (const e of t.events({ highWaterMark: 5000 })) got.push(e);
    expect(got[0]).toMatchObject({ type: 'gap', data: { from: 1, to: 4 } });
    expect(got).toHaveLength(1001);
  });

  it('interrupt waits for the key, then asks the host; a finished turn is a no-op', async () => {
    const h = new Host();
    const t = new TurnImpl(h, 'hi', K('pending:1'));
    const p = t.interrupt();
    t.bind(K('t1'));
    await p;
    expect(h.stopped).toEqual(['t1']);
    t.deliver(ended(2));
    await t.interrupt();
    expect(h.stopped).toEqual(['t1']);

    const t2 = new TurnImpl(h, 'hi', K('pending:2'));
    const p2 = t2.interrupt();
    t2.fail(publicError('E_BUSY', 'b'));
    await p2;
    expect(h.stopped).toEqual(['t1']);
  });

  it('snapshot: host snapshot when bound, synthetic before and after a failed submit', () => {
    const h = new Host();
    const t = new TurnImpl(h, 'hi', K('pending:1'), 'external');
    expect(t.snapshot()).toEqual({
      key: 'pending:1',
      prompt: 'hi',
      origin: 'external',
      state: 'queued',
      tools: [],
      subagents: [],
      text: '',
    });
    t.fail(publicError('E_BUSY', 'busy'));
    expect(t.snapshot()).toMatchObject({ state: 'notSubmitted', error: { code: 'E_BUSY', details: { reason: 'E_BUSY' } } });
    const snap: TurnSnapshot = { key: K('t2'), prompt: 'hi', origin: 'library', state: 'running', tools: [], subagents: [], text: 'x' };
    h.snaps.set(K('t2'), snap);
    const t2 = new TurnImpl(h, 'hi', K('pending:2'));
    t2.bind(K('t2'));
    expect(t2.snapshot()).toBe(snap);
  });
});
