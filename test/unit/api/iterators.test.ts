// AL §6.1, P-API-09 (bounded iterators + gap), SEC §8.2–§8.3 / P-SEC-41 (redactEvent).
import { describe, expect, it } from 'vitest';
import { EventQueue, gapEvent, redactEvent, redactString } from '../../../src/api/iterators.js';
import type { SessionEvent } from '../../../src/api/public-types.js';

const evt = (seq: number): SessionEvent => ({
  type: 'compaction',
  seq,
  at: seq,
  provenance: { confirmed: true, sources: [] },
  data: { phase: 'started' },
});

async function drain(q: AsyncIterableIterator<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of q) out.push(e);
  return out;
}

describe('EventQueue', () => {
  it('delivers in order to a waiting consumer and to a late one, then ends', async () => {
    const q = new EventQueue(10);
    const first = q.next();
    q.push(evt(1));
    expect(await first).toEqual({ value: evt(1), done: false });
    q.push(evt(2));
    q.push(evt(3));
    q.end();
    q.push(evt(4)); // ignored after end
    expect((await drain(q)).map((e) => e.seq)).toEqual([2, 3]);
    expect(await q.next()).toEqual({ value: undefined, done: true });
  });

  it('P-API-09: a never-read iterator holds at most highWaterMark events, then yields one gap with the dropped range', async () => {
    const q = new EventQueue(2);
    for (let i = 1; i <= 6; i++) q.push(evt(i));
    const a = await q.next();
    const b = await q.next();
    q.push(evt(7));
    q.end();
    const rest = await drain(q);
    expect([a, b].map((r) => (r.done === true ? undefined : r.value.seq))).toEqual([1, 2]);
    expect(rest.map((e) => e.type)).toEqual(['gap', 'compaction']);
    expect(rest[0]?.data).toEqual({ from: 3, to: 6 });
    expect(rest[1]?.seq).toBe(7);
  });

  it('a gap pending at end() is still delivered', async () => {
    const q = new EventQueue(1);
    q.push(evt(1));
    q.push(evt(2));
    q.end();
    expect((await drain(q)).map((e) => e.type)).toEqual(['compaction', 'gap']);
  });

  it('return() (for await … break) unsubscribes once and drops the buffer; end() of an empty queue closes at once', async () => {
    let closed = 0;
    const q = new EventQueue(5, () => {
      closed++;
      throw new Error('ignored');
    });
    q.push(evt(1));
    q.push(evt(2));
    for await (const e of q) {
      expect(e.seq).toBe(1);
      break;
    }
    expect(closed).toBe(1);
    expect(q.isClosed).toBe(true);
    q.push(evt(3));
    expect(await q.next()).toEqual({ value: undefined, done: true });
    await q.return();
    expect(closed).toBe(1);

    let closed2 = 0;
    const q2 = new EventQueue(5, () => {
      closed2++;
    });
    const pending = q2.next();
    q2.end();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(closed2).toBe(1);
  });

  it('rejects a bad highWaterMark; gapEvent shape', () => {
    expect(() => new EventQueue(0)).toThrow(RangeError);
    expect(() => new EventQueue(1.5)).toThrow(RangeError);
    expect(gapEvent(3, 9, 42)).toEqual({
      type: 'gap',
      seq: 9,
      at: 42,
      provenance: { confirmed: true, sources: [] },
      data: { from: 3, to: 9 },
    });
  });
});

describe('redactEvent', () => {
  it.each([
    ['sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX', 'sk-ant-***'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', 'token gh*_***'],
    ['AKIAABCDEFGHIJKLMNOP', 'AWS_KEY_***'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'Authorization: ***'],
    ['use bearer abcdefghijklmnopqrstuvwxyz now', 'use bearer *** now'],
    ['https://user:pa55@proxy.example.com:8080/', 'https://***:***@proxy.example.com:8080/'],
    ['export GITHUB_TOKEN=abc123', 'export GITHUB_TOKEN=***'],
    ['eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'JWT_***'],
    ['xoxb-1234567890-abc', 'xox*-***'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '[PRIVATE KEY REDACTED]'],
    ['plain text stays', 'plain text stays'],
  ])('redactString(%j)', (input, out) => {
    expect(redactString(input)).toBe(out);
  });

  it('walks the event data (tool input, nested arrays, env-style names) without touching the original', () => {
    const input = {
      command: 'curl -H "x-api-key: secret-value-123"',
      env: { AWS_SECRET_ACCESS_KEY: 'abc', HOME: '/h' },
      list: ['sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX', 3, null],
    };
    const e: SessionEvent = {
      type: 'toolStarted',
      seq: 1,
      at: 1,
      provenance: { confirmed: true, sources: ['hooks'] },
      data: {
        key: 'u1' as never,
        name: 'Bash',
        input,
        state: 'running',
        startedAt: 1,
        provenance: { confirmed: true, sources: ['hooks'] },
      },
    };
    const r = redactEvent(e);
    expect(r).not.toBe(e);
    expect(r.type).toBe('toolStarted');
    expect((r.data as { input: unknown }).input).toEqual({
      command: 'curl -H "x-api-key: ***',
      env: { AWS_SECRET_ACCESS_KEY: '***', HOME: '/h' },
      list: ['sk-ant-***', 3, null],
    });
    expect(input.env.AWS_SECRET_ACCESS_KEY).toBe('abc');
  });

  it('handles cycles', () => {
    const a: Record<string, unknown> = { prompt: 'p' };
    a['self'] = a;
    const e = { type: 'turnQueued', seq: 1, at: 1, provenance: { confirmed: true, sources: [] }, data: a } as unknown as SessionEvent;
    const r = redactEvent(e).data as Record<string, unknown>;
    expect(r['self']).toBe(r);
  });
});
