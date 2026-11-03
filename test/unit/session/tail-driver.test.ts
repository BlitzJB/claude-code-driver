// WP-13 session/tail-driver.ts (DESIGN.md §2.6 tail.* intents, §2.7.4; P-TAIL-23 relocation via hook transcript_path).
import { describe, expect, it } from 'vitest';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';
import type { TranscriptNormalizer } from '../../../src/channels/transcript/normalize.js';
import type { HookSeq, IntentId } from '../../../src/model/ids.js';
import type { ObservationInput } from '../../../src/model/observation.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { FakeTranscriptTail } from '../../../src/platform/fs-tail/fake-tail-fs.js';
import type { RawHookEvent, TailEvent } from '../../../src/platform/ports.js';
import { createTailDriver, type TailDriver } from '../../../src/session/tail-driver.js';
import { MemoryLogger } from '../../../src/testing/fake-ports.js';

const SID = '3f1c2a4e-0000-4000-8000-000000000001';
const MAIN = `/home/u/.claude/projects/-work/${SID}.jsonl`;
let n = 0;
const id = (): IntentId => ++n as IntentId;

function world(o: { normalizer?: TranscriptNormalizer } = {}): {
  tail: FakeTranscriptTail;
  out: ObservationInput[];
  d: TailDriver;
  logger: MemoryLogger;
} {
  const tail = new FakeTranscriptTail();
  const out: ObservationInput[] = [];
  const logger = new MemoryLogger();
  const d = createTailDriver({
    clock: new FakeClock(),
    tail,
    emit: (x) => out.push(x),
    profile,
    logger,
    ...(o.normalizer !== undefined ? { normalizer: o.normalizer } : {}),
  });
  return { tail, out, d, logger };
}

function hook(event: string, payload: unknown): RawHookEvent {
  return {
    hookSeq: ++n as HookSeq,
    at: 0 as MonoMs,
    wallAt: 0 as WallMs,
    transport: 'http',
    event,
    bytes: 10,
    truncated: false,
    payload,
    holdable: false,
  };
}

describe('tail-driver: intents map 1:1 onto the TranscriptTail port', () => {
  it('followMain / observePath / expectSubagent / subagentStopped / poke', () => {
    const w = world();
    w.d.execute({ kind: 'tail.followMain', id: id(), sessionId: SID, path: MAIN, startAt: 'end' });
    w.d.execute({ kind: 'tail.observePath', id: id(), sessionId: SID, path: '/new/x.jsonl', source: 'cwd' });
    w.d.execute({ kind: 'tail.expectSubagent', id: id(), sessionId: SID, agentId: 'agent-1' });
    w.d.execute({ kind: 'tail.subagentStopped', id: id(), sessionId: SID, agentId: 'agent-1', path: '/a.jsonl' });
    w.d.execute({ kind: 'tail.subagentStopped', id: id(), sessionId: SID, agentId: 'agent-2' });
    w.d.execute({ kind: 'tail.poke', id: id(), reason: 'Stop' });
    expect(w.tail.calls).toEqual([
      { m: 'followMain', sessionId: SID, path: MAIN, startAt: 'end' },
      { m: 'observePath', sessionId: SID, path: '/new/x.jsonl', source: 'cwd' },
      { m: 'expectSubagent', sessionId: SID, agentId: 'agent-1' },
      { m: 'subagentStopped', sessionId: SID, agentId: 'agent-1', path: '/a.jsonl' },
      { m: 'subagentStopped', sessionId: SID, agentId: 'agent-2', path: undefined },
      { m: 'poke', reason: 'Stop' },
    ]);
    expect(w.d.knownPath(SID)).toBe('/new/x.jsonl');
  });
});

describe('tail-driver: tail events → transcript normalizer → observations', () => {
  it('a user prompt line becomes a prompt.recorded observation with transcript meta', () => {
    const w = world();
    w.tail.emitLine(
      { kind: 'main', sessionId: SID },
      {
        type: 'user',
        uuid: 'u-1',
        parentUuid: null,
        sessionId: SID,
        promptId: 'pr-1',
        timestamp: '2026-11-03T12:00:00.000Z',
        isSidechain: false,
        message: { role: 'user', content: 'hello there' },
      },
    );
    const rec = w.out.find((x) => x.kind === 'prompt.recorded');
    expect(rec).toBeDefined();
    expect(rec!.meta).toMatchObject({ source: 'transcript', uuid: 'u-1', claudeSessionId: SID });
    expect(rec!.p).toMatchObject({ text: 'hello there', uuid: 'u-1' });
  });

  it('every observation the normalizer returns is forwarded in order', () => {
    const fake: TranscriptNormalizer = {
      push: (e: TailEvent) => [
        { kind: 'clock.tick', meta: { at: 1 as MonoMs, wallAt: 1 as WallMs, source: 'transcript' }, p: {} },
        {
          kind: 'unknown',
          meta: { at: 1 as MonoMs, wallAt: 1 as WallMs, source: 'transcript' },
          p: { channel: 'transcript', raw: e.kind },
        },
      ],
      resetFile: () => undefined,
    };
    const w = world({ normalizer: fake });
    w.tail.emit({ kind: 'state', file: { kind: 'main', sessionId: SID }, state: 'active' });
    expect(w.out.map((x) => x.kind)).toEqual(['clock.tick', 'unknown']);
  });

  it('a throwing normalizer is logged and does not break the listener', () => {
    let calls = 0;
    const fake: TranscriptNormalizer = {
      push: () => {
        calls++;
        throw new Error('bug');
      },
      resetFile: () => undefined,
    };
    const w = world({ normalizer: fake });
    w.tail.emit({ kind: 'state', file: { kind: 'main', sessionId: SID }, state: 'active' });
    w.tail.emit({ kind: 'state', file: { kind: 'main', sessionId: SID }, state: 'active' });
    expect(calls).toBe(2);
    expect(w.logger.at('error')).toHaveLength(2);
  });

  it('a fatal tail error → channel.health transcript down; the next line → up', () => {
    const w = world();
    w.tail.emit({ kind: 'error', message: 'EMFILE', fatal: true });
    w.tail.emit({ kind: 'error', message: 'EMFILE', fatal: true });
    w.tail.emitLine({ kind: 'main', sessionId: SID }, { type: 'summary', summary: 'x', leafUuid: 'l' });
    const h = w.out.filter((x) => x.kind === 'channel.health').map((x) => x.p);
    expect(h).toEqual([
      { channel: 'transcript', health: 'down', reason: 'tailError' },
      { channel: 'transcript', health: 'up', reason: 'tailError' },
    ]);
  });

  it('opened/moved events update the known path', () => {
    const w = world();
    w.tail.emit({ kind: 'opened', file: { kind: 'main', sessionId: SID }, path: MAIN, dev: 1, ino: 2, size: 0, startOffset: 0 });
    expect(w.d.knownPath(SID)).toBe(MAIN);
    w.tail.emit({ kind: 'moved', file: { kind: 'main', sessionId: SID }, from: MAIN, to: '/moved.jsonl', sameInode: true });
    expect(w.d.knownPath(SID)).toBe('/moved.jsonl');
  });
});

describe('tail-driver: hooks lead (poke + relocation, P-TAIL-23)', () => {
  it('every post-execution hook pokes the tail; PreToolUse/PermissionRequest do not', () => {
    const w = world();
    w.d.noteHookEvent(hook('Stop', { session_id: SID }));
    w.d.noteHookEvent(hook('PreToolUse', { session_id: SID }));
    w.d.noteHookEvent(hook('PermissionRequest', { session_id: SID }));
    w.d.noteHookEvent(hook('PostToolUse', { session_id: SID }));
    expect(w.tail.calls).toEqual([
      { m: 'poke', reason: 'hook:Stop' },
      { m: 'poke', reason: 'hook:PostToolUse' },
    ]);
  });

  it('a new transcript_path for a followed session → observePath once (deduplicated)', () => {
    const w = world();
    w.d.execute({ kind: 'tail.followMain', id: id(), sessionId: SID, path: MAIN, startAt: 'beginning' });
    w.d.noteHookEvent(hook('PostToolUse', { session_id: SID, transcript_path: MAIN }));
    w.d.noteHookEvent(hook('CwdChanged', { session_id: SID, transcript_path: '/home/u/.claude/projects/-other/x.jsonl' }));
    w.d.noteHookEvent(hook('Stop', { session_id: SID, transcript_path: '/home/u/.claude/projects/-other/x.jsonl' }));
    expect(w.tail.calls.filter((c) => c.m === 'observePath')).toEqual([
      { m: 'observePath', sessionId: SID, path: '/home/u/.claude/projects/-other/x.jsonl', source: 'hook:CwdChanged' },
    ]);
  });

  it('ignores relative paths, unknown sessions, SessionStart (the core follows it) and non-object payloads', () => {
    const w = world();
    w.d.execute({ kind: 'tail.followMain', id: id(), sessionId: SID, path: MAIN, startAt: 'beginning' });
    w.d.noteHookEvent(hook('Stop', { session_id: SID, transcript_path: 'relative.jsonl' }));
    w.d.noteHookEvent(hook('Stop', { session_id: 'other', transcript_path: '/x.jsonl' }));
    w.d.noteHookEvent(hook('SessionStart', { session_id: SID, transcript_path: '/y.jsonl' }));
    w.d.noteHookEvent(hook('Stop', null));
    w.d.noteHookEvent(hook('Stop', [1, 2]));
    expect(w.tail.calls.filter((c) => c.m === 'observePath')).toEqual([]);
  });
});

describe('tail-driver: close', () => {
  it('closes the tail, unsubscribes, and ignores later intents and hooks', async () => {
    const w = world();
    await w.d.close();
    await w.d.close();
    expect(w.tail.closed).toBe(true);
    expect(w.tail.listenerCount).toBe(0);
    w.d.execute({ kind: 'tail.poke', id: id(), reason: 'x' });
    w.d.noteHookEvent(hook('Stop', {}));
    expect(w.tail.calls).toEqual([{ m: 'close' }]);
  });
});
