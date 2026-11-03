// api/iterators.ts — event delivery for the facade: the bounded async iterator behind `session.events()` / `turn.events()`,
// and `redactEvent` for hosts that log events (DESIGN.md §2.12; AL §6.1; P-API-09; SEC §8.2–§8.3, P-SEC-41).
//
// An iterator holds at most `highWaterMark` undelivered events. Past that it drops new events and, once the consumer catches
// up, yields one `gap{from,to}` event naming the dropped sequence range, so a created-but-never-iterated iterator cannot hold
// memory forever. `return()` (a `for await … break`) unsubscribes and drops the buffer.

import type { SessionEvent, SessionEventOf } from './public-types.js';

export const DEFAULT_HIGH_WATER_MARK = 1_000;

export function gapEvent(from: number, to: number, at: number = Date.now()): SessionEventOf<'gap'> {
  return { type: 'gap', seq: to, at, provenance: { confirmed: true, sources: [] }, data: { from, to } };
}

export class EventQueue implements AsyncIterableIterator<SessionEvent> {
  private readonly buf: SessionEvent[] = [];
  private readonly waiters: ((r: IteratorResult<SessionEvent>) => void)[] = [];
  private gap: { from: number; to: number } | undefined;
  private ending = false;
  private closed = false;

  constructor(
    private readonly highWaterMark: number = DEFAULT_HIGH_WATER_MARK,
    private readonly onClose: () => void = () => undefined,
  ) {
    if (!Number.isInteger(highWaterMark) || highWaterMark < 1) throw new RangeError('highWaterMark must be a positive integer');
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Delivers `e`, or drops it into the pending gap when the buffer is full. */
  push(e: SessionEvent): void {
    if (this.closed || this.ending) return;
    const w = this.waiters.shift();
    if (w !== undefined) {
      w({ value: e, done: false });
      return;
    }
    if (this.buf.length >= this.highWaterMark) {
      this.gap = this.gap === undefined ? { from: e.seq, to: e.seq } : { from: this.gap.from, to: e.seq };
      return;
    }
    this.flushGap();
    this.buf.push(e);
  }

  /** Ends the stream after the buffered events (and a pending gap) were read. */
  end(): void {
    if (this.closed || this.ending) return;
    this.ending = true;
    if (this.buf.length === 0 && this.gap === undefined) this.finish();
  }

  next(): Promise<IteratorResult<SessionEvent>> {
    const e = this.buf.shift();
    if (e !== undefined) {
      if (this.buf.length === 0 && this.gap === undefined && this.ending) this.finish(false);
      return Promise.resolve({ value: e, done: false });
    }
    if (this.gap !== undefined) {
      const g = this.gap;
      this.gap = undefined;
      if (this.ending) this.finish(false);
      return Promise.resolve({ value: gapEvent(g.from, g.to), done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<SessionEvent>> {
    this.buf.length = 0;
    this.gap = undefined;
    this.finish();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  private flushGap(): void {
    if (this.gap === undefined) return;
    this.buf.push(gapEvent(this.gap.from, this.gap.to));
    this.gap = undefined;
  }

  private finish(resolveWaiters = true): void {
    if (this.closed) return;
    this.closed = true;
    if (resolveWaiters) for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
    try {
      this.onClose();
    } catch {
      // an unsubscribe must never break the consumer's loop
    }
  }
}

// ---------------------------------------------------------------------------------------------------------- redaction

/** SEC §8.2 layer 2: credential shapes that may appear in prompts, tool input/output and assistant text. */
const PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***'],
  [/github_pat_[A-Za-z0-9_]{50,}/g, 'github_pat_***'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, 'gh*_***'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS_KEY_***'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT_***'],
  [/\b(authorization|proxy-authorization|cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+/gi, '$1$2***'], // whole value: "Bearer <token>"
  [/\b(x-api-key)(\s*[:=]\s*)\S+/gi, '$1$2***'],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1***'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)\S+/gi, '$1***'],
];
/** SEC §8.2 layer 3: env-style names whose values are masked whole. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SENSITIVE_NAME = /(TOKEN|SECRET|KEY|PASS|AUTH|COOKIE|CREDENTIAL|SESSION|PROXY)/i;

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function redactValue(v: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof v === 'string') return redactString(v);
  if (typeof v !== 'object' || v === null) return v;
  const prior = seen.get(v);
  if (prior !== undefined) return prior;
  if (Array.isArray(v)) {
    const arr: unknown[] = [];
    seen.set(v, arr);
    for (const x of v) arr.push(redactValue(x, seen));
    return arr;
  }
  const out: Record<string, unknown> = {};
  seen.set(v, out);
  for (const [k, x] of Object.entries(v)) {
    out[k] = typeof x === 'string' && ENV_NAME.test(k) && SENSITIVE_NAME.test(k) ? '***' : redactValue(x, seen);
  }
  return out;
}

/**
 * A copy of `e` with credential-looking strings masked anywhere in its data (prompts, tool input, text, messages), for hosts
 * that log events. Pattern-based, so best effort: it cannot know a secret that has no recognisable shape (SEC §8.2).
 */
export function redactEvent<E extends SessionEvent>(e: E): E {
  return { ...e, data: redactValue(e.data, new WeakMap()) };
}
