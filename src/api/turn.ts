// api/turn.ts — the `Turn` handle returned by `session.send()` (DESIGN.md §2.12, D-31, AL §6.1).
//
// `done` always resolves and `accepted` gets a no-op catch before it is exposed (P-API-07). A turn keeps a bounded history of
// its own events (from creation on), so `turn.events()` called after `await turn.accepted` still sees `turnQueued`; when the
// history overflowed, the iterator starts with a `gap` event (P-API-09).

import { EventQueue, DEFAULT_HIGH_WATER_MARK, gapEvent } from './iterators.js';
import type { ClaudeSessionError } from './map-errors.js';
import { outcomeError } from './map-events.js';
import type { SessionEvent, Turn, TurnKey, TurnResult, TurnSnapshot } from './public-types.js';

/** What a Turn needs from its session. */
export interface TurnHost {
  /** The turn's current snapshot, if the core knows it. */
  snapshotOf(key: TurnKey): TurnSnapshot | undefined;
  /** Interrupt (running) or cancel (still in the library queue) the turn with this key. */
  stopTurn(key: TurnKey): Promise<void>;
}

const HISTORY_CAP = 1_000;

export class TurnImpl implements Turn {
  readonly accepted: Promise<{ promptId: string }>;
  readonly done: Promise<TurnResult>;
  private bound: TurnKey | undefined;
  private result: TurnResult | undefined;
  private acceptedSettled = false;
  private resolveAccepted!: (v: { promptId: string }) => void;
  private rejectAccepted!: (e: unknown) => void;
  private resolveDone!: (r: TurnResult) => void;
  private readonly keyWaiters: ((k: TurnKey | undefined) => void)[] = [];
  private readonly history: SessionEvent[] = [];
  private historyGap: { from: number; to: number } | undefined;
  private readonly queues = new Set<EventQueue>();

  constructor(
    private readonly host: TurnHost,
    readonly prompt: string,
    /** The provisional `pending:<n>` reference (or the key itself for turns the session did not send). */
    readonly ref: TurnKey,
    private readonly origin: TurnSnapshot['origin'] = 'library',
  ) {
    this.accepted = new Promise((res, rej) => {
      this.resolveAccepted = res;
      this.rejectAccepted = rej;
    });
    this.accepted.catch(() => undefined); // P-API-07: an ignored `accepted` never becomes an unhandled rejection
    this.done = new Promise((res) => {
      this.resolveDone = res;
    });
  }

  get key(): TurnKey {
    return this.bound ?? this.ref;
  }

  get isBound(): boolean {
    return this.bound !== undefined;
  }

  get isFinished(): boolean {
    return this.result !== undefined;
  }

  bind(key: TurnKey): void {
    if (this.bound !== undefined) return;
    this.bound = key;
    for (const w of this.keyWaiters.splice(0)) w(key);
  }

  /** One public event of this turn (already filtered by turnKey). */
  deliver(e: SessionEvent): void {
    if (this.result !== undefined) return;
    if (this.history.length >= HISTORY_CAP) {
      const old = this.history.shift();
      if (old !== undefined) this.historyGap = { from: this.historyGap?.from ?? old.seq, to: old.seq };
    }
    this.history.push(e);
    for (const q of this.queues) q.push(e);
    if (e.type === 'turnStarted') this.accept(e.data.promptId);
    else if (e.type === 'turnEnded') this.finish(e.data);
  }

  /** The prompt never reached the core (dispatch rejected, session closed or exited first). */
  fail(error: ClaudeSessionError): void {
    if (this.result !== undefined) return;
    this.finish({ turnKey: this.key, outcome: 'notSubmitted', text: '', refused: false, tools: [], durationMs: 0, error });
  }

  /** The session ended without a `turnEnded` for this turn (backstop; closing rules normally end it first). */
  abandon(error: ClaudeSessionError): void {
    if (this.result !== undefined) return;
    const snap = this.snapshot();
    this.finish({ turnKey: this.key, outcome: 'unknown', text: snap.text, refused: false, tools: [], durationMs: 0, error });
  }

  async completed(): Promise<TurnResult> {
    const r = await this.done;
    if (r.outcome === 'completed') return r;
    throw r.error ?? outcomeError(r.outcome);
  }

  snapshot(): TurnSnapshot {
    const known = this.bound === undefined ? undefined : this.host.snapshotOf(this.bound);
    if (known !== undefined) return known;
    const r = this.result;
    return {
      key: this.key,
      prompt: this.prompt,
      origin: this.origin,
      state: r === undefined ? 'queued' : r.outcome,
      tools: r === undefined ? [] : r.tools.map((t) => t.key),
      subagents: [],
      text: r?.text ?? '',
      ...(r?.error === undefined ? {} : { error: r.error.toJSON() }),
    };
  }

  events(opts: { highWaterMark?: number } = {}): AsyncIterableIterator<SessionEvent> {
    const q: EventQueue = new EventQueue(opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK, () => this.queues.delete(q));
    if (this.historyGap !== undefined) q.push(gapEvent(this.historyGap.from, this.historyGap.to));
    for (const e of this.history) q.push(e);
    if (this.result !== undefined) q.end();
    else this.queues.add(q);
    return q;
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return this.events();
  }

  async interrupt(): Promise<void> {
    if (this.result !== undefined) return;
    const key = this.bound ?? (await new Promise<TurnKey | undefined>((res) => this.keyWaiters.push(res)));
    if (key === undefined || this.isFinished) return;
    await this.host.stopTurn(key);
  }

  private accept(promptId: string): void {
    if (this.acceptedSettled) return;
    this.acceptedSettled = true;
    this.resolveAccepted({ promptId });
  }

  private finish(r: TurnResult): void {
    if (this.result !== undefined) return;
    this.result = r;
    if (!this.acceptedSettled) {
      this.acceptedSettled = true;
      const promptId = this.bound === undefined ? undefined : this.host.snapshotOf(this.bound)?.promptId;
      if (r.outcome === 'completed') this.resolveAccepted({ promptId: promptId ?? '' });
      else if (promptId !== undefined) this.resolveAccepted({ promptId });
      else this.rejectAccepted(r.error ?? outcomeError(r.outcome));
    }
    this.resolveDone(r);
    for (const w of this.keyWaiters.splice(0)) w(this.bound);
    for (const q of this.queues) q.end();
    this.queues.clear();
  }
}
