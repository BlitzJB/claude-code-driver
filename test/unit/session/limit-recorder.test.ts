// session/limit-recorder.ts — always-on narrow raw ring; scrubbed fixture dump on the first usage limit (§3.9 (b); P-REV-40,
// P-SEC-42). The dump must pass `pnpm fixtures:lint` as written (ICR 0014 item 5).
import { describe, expect, it } from 'vitest';
import type { DebugRecord } from '../../../src/model/debug.js';
import type { DomainEvent } from '../../../src/model/events.js';
import type { HookSeq } from '../../../src/model/ids.js';
import type { ScreenFacts } from '../../../src/model/screen-facts.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import type { Capture, FileKey, PaneStatus, RawHookEvent, TailEvent } from '../../../src/platform/ports.js';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { FakeStateStore } from '../../../src/platform/runtime-dir/fake-state-store.js';
import { LIMIT_CAPTURE_DIR, LIMIT_SCREEN_ROWS, createLimitRecorder } from '../../../src/session/limit-recorder.js';
import type { LimitRecorderOptions } from '../../../src/session/limit-recorder.js';
import { createFixtureScrubber } from '../../../src/session/redact.js';
import * as lint from '../../../scripts/fixtures-lint.mjs';

const lintText = lint.lintText as (text: string) => { line: number; rule: string; excerpt: string }[];

const status: PaneStatus = {
  exists: true,
  dead: false,
  exitStatus: null,
  exitSignal: null,
  inMode: false,
  alternateOn: false,
  cursorX: 0,
  cursorY: 0,
  cols: 120,
  rows: 40,
  historySize: 0,
};
const cap = (lines: string[], hash: string, at = 10): Capture => ({ lines, status, at: at as MonoMs, hash });
const hook = (event: string, payload: unknown): RawHookEvent => ({
  hookSeq: 1 as HookSeq,
  at: 5 as MonoMs,
  wallAt: 6 as WallMs,
  transport: 'http',
  event,
  bytes: 10,
  truncated: false,
  payload,
  holdable: false,
});
const file: FileKey = { kind: 'main', sessionId: 's' };
const line = (json: unknown): TailEvent => ({
  kind: 'line',
  line: {
    file,
    generation: 0,
    offset: 0,
    bytes: 1,
    type: undefined,
    json,
    replay: false,
    afterRewrite: false,
    readAtMono: 7 as MonoMs,
    readAtWall: 8 as WallMs,
  },
});
const limited = { type: 'usage.limited', seq: 1, payload: {} } as unknown as DomainEvent;
const header = (): Extract<DebugRecord, { r: 'header' }> =>
  ({
    r: 'header',
    format: 'ccd-trace',
    v: 1,
    lib: '0.0.0',
    claude: '2.1.316',
    tmux: '3.5a',
    node: '22',
    platform: 'darwin',
    startedWall: 1,
    tz: 'UTC',
    coreInit: { cwdRealpath: '/Users/alice/proj' },
    profile: '2.1.316',
    redaction: 'meta',
    hookTransport: 'http',
  }) as unknown as Extract<DebugRecord, { r: 'header' }>;

function mk(over: Partial<LimitRecorderOptions> = {}) {
  const state = new FakeStateStore({ clock: new FakeClock() });
  const captured: { path: string; trigger: string }[] = [];
  const rec = createLimitRecorder({
    enabled: true,
    sessionKey: 's00c0ffee',
    state,
    scrubber: () => createFixtureScrubber({ home: '/Users/alice', user: 'alice', tokens: ['f'.repeat(64)] }),
    header,
    onCaptured: (path, trigger) => captured.push({ path, trigger }),
    ...over,
  });
  return { rec, state, captured };
}

describe('limit recorder: narrow content only', () => {
  it('keeps only the bottom 12 rows of changed captures', () => {
    const { rec } = mk();
    const lines = Array.from({ length: 40 }, (_, i) => `row ${i}`);
    rec.recordCapture(cap(lines, 'h1'), 1);
    rec.recordCapture(cap(lines, 'h1'), 2); // unchanged frame: not kept twice
    expect(rec.size).toBe(1);
  });

  it('keeps StopFailure / Notification / Stop hooks only, without the closed promise', () => {
    const { rec } = mk();
    rec.recordHook(hook('PreToolUse', { tool_input: { command: 'cat .env' } }));
    rec.recordHook(hook('UserPromptSubmit', { prompt: 'secret' }));
    rec.recordHook({ ...hook('StopFailure', { error: 'rate_limit' }), closed: Promise.resolve('client_gone') });
    rec.recordHook(hook('Notification', { message: 'm' }));
    rec.recordHook(hook('Stop', {}));
    expect(rec.size).toBe(3);
  });

  it('keeps transcript entries with isApiErrorMessage or type:system only', () => {
    const { rec } = mk();
    rec.recordTail(line({ type: 'user', message: { content: 'private prompt' } }), 7, 8);
    rec.recordTail(line({ type: 'assistant', isApiErrorMessage: true }), 7, 8);
    rec.recordTail(line({ type: 'system', subtype: 'informational' }), 7, 8);
    rec.recordTail(line('not an object'), 7, 8);
    rec.recordTail({ kind: 'waiting', file, path: '/x', reason: 'ENOENT' }, 7, 8);
    expect(rec.size).toBe(2);
  });

  it('the ring is bounded', () => {
    const { rec } = mk({ capacity: 5 });
    for (let i = 0; i < 20; i++) rec.recordCapture(cap([`l${i}`], `h${i}`), i);
    expect(rec.size).toBe(5);
  });

  it('disabled → records nothing, never dumps', async () => {
    const { rec, state } = mk({ enabled: false });
    rec.recordHook(hook('Stop', {}));
    rec.onEvents([limited], 1000);
    await rec.idle();
    expect(rec.size).toBe(0);
    expect(state.files.size).toBe(0);
  });
});

describe('limit recorder: dumps', () => {
  it('first usage.limited → one scrubbed, lint-clean .ccd.jsonl under limit-captures/ (and only once)', async () => {
    const { rec, state, captured } = mk();
    rec.recordCapture(cap(['/Users/alice/proj $ x', "You've hit your 5-hour limit · resets 3pm", 'mail alice@corp.io'], 'h1'), 1);
    rec.recordHook(
      hook('StopFailure', {
        error: 'rate_limit',
        transcript_path: '/Users/alice/.claude/projects/-Users-alice-proj/x.jsonl',
        token: 'f'.repeat(64),
      }),
    );
    rec.recordTail(line({ type: 'assistant', isApiErrorMessage: true, accountUuid: '12345678-1234-4123-8123-123456789abc' }), 7, 8);
    rec.onEvents([limited], 1_793_707_204_820);
    rec.onEvents([limited], 1_793_707_204_821);
    await rec.idle();
    const rel = `${LIMIT_CAPTURE_DIR}/1793707204820-s00c0ffee.ccd.jsonl`;
    expect(rec.dumps).toEqual([rel]);
    const text = state.files.get(rel) ?? '';
    const recs = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { r: string; redaction?: string; ch?: string });
    expect(recs[0]).toMatchObject({ r: 'header', redaction: 'full' });
    expect(recs.slice(1).map((r) => r.ch)).toEqual(['screen', 'hook', 'transcript']);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('f'.repeat(64));
    expect(lintText(text)).toEqual([]);
    expect(captured).toEqual([{ path: `${state.root}/${rel}`, trigger: 'usageLimited' }]);
  });

  it('replayed usage.limited (resume catch-up) does not dump', async () => {
    const { rec, state } = mk();
    rec.recordHook(hook('Stop', {}));
    rec.onEvents([{ ...limited, replayed: true }], 1);
    await rec.idle();
    expect(state.files.size).toBe(0);
  });

  it('an unclassified limit-looking bottom line dumps once (string drift); a classified one does not', async () => {
    const { rec, captured } = mk();
    const c = cap(['…', 'Usage limit reached for today'], 'h2');
    rec.recordCapture(c, 1);
    rec.onFrame({ usageLimit: { line: 'x' } } as unknown as ScreenFacts, c, 10); // classified: no dump
    rec.onFrame({ status: { kind: 'spinner' } } as unknown as ScreenFacts, c, 11); // a known status: no dump
    expect(rec.dumps).toEqual([]);
    rec.onFrame({ status: { kind: 'retryingUnparsed' } } as unknown as ScreenFacts, c, 12);
    rec.onFrame(undefined, c, 13);
    await rec.idle();
    expect(rec.dumps).toHaveLength(1);
    expect(captured[0]?.trigger).toBe('screenUnparsed');
    const above = cap([...Array.from({ length: LIMIT_SCREEN_ROWS }, () => 'plain'), 'limit'], 'h3');
    rec.onFrame(undefined, above, 14);
    expect(rec.dumps).toHaveLength(1);
  });

  it('an empty ring never dumps; maxDumps bounds the files per session', async () => {
    const empty = mk();
    empty.rec.onEvents([limited], 1);
    expect(empty.rec.dumps).toEqual([]);
    const { rec } = mk({ maxDumps: 1 });
    const c = cap(['resets soon'], 'h');
    rec.recordCapture(c, 1);
    rec.onEvents([limited], 1);
    rec.onFrame(undefined, c, 2);
    await rec.idle();
    expect(rec.dumps).toHaveLength(1);
  });

  it('a write failure is reported, not thrown', async () => {
    const errors: unknown[] = [];
    const state = new FakeStateStore({ clock: new FakeClock() });
    state.appendLine = () => Promise.reject(new Error('disk full'));
    const { rec } = mk({ state, onError: (e) => errors.push(e) });
    rec.recordHook(hook('Stop', {}));
    rec.onEvents([limited], 1);
    await rec.idle();
    expect(errors).toHaveLength(1);
  });
});
