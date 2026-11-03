// test/replay/goldens.test.ts — golden replays of every `.ccd.jsonl` trace (DESIGN.md §6.1 `replay` project, §6.6; WP-INT).
//
// Every trace in fixtures/traces (built without live runs from fixtures/verify and the BRIEF probe dirs by
// scripts/fixtures-from-verify.mjs) is replayed at raw level: L1 + L2 + L3 against the fakes on a FakeClock at the recorded
// `at`, with `tz` from the header. The published events (wallAt normalised to 0) and the final SessionState are compared
// with fixtures/goldens/<name>.{events.jsonl,state.json}. A golden change is explicit: `pnpm test:replay -u` (or
// CCD_UPDATE_GOLDENS=1) rewrites them, and the diff is reviewed like code. Missing goldens never pass silently.
//
// On top of the byte comparison each trace states what it was captured to show (the behaviour the golden must keep), so a
// golden re-recorded with a regression in it still fails here.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/model/events.js';
import type { SessionState } from '../../src/model/state.js';
import {
  compareGolden,
  goldenEventsText,
  goldenStateText,
  readTrace,
  replayRaw,
  updateRequested,
  type ReplayResult,
} from '../../src/testing/replay.js';

const ROOT = join(import.meta.dirname, '..', '..');
const TRACES = join(ROOT, 'fixtures', 'traces');
const GOLDENS = join(ROOT, 'fixtures', 'goldens');
const names = readdirSync(TRACES)
  .filter((f) => f.endsWith('.ccd.jsonl'))
  .map((f) => f.slice(0, -'.ccd.jsonl'.length))
  .sort();

const cache = new Map<string, Promise<ReplayResult>>();
function replay(name: string): Promise<ReplayResult> {
  let p = cache.get(name);
  if (p === undefined) {
    p = replayRaw(readTrace(join(TRACES, `${name}.ccd.jsonl`)));
    cache.set(name, p);
  }
  return p;
}

type Ev<T extends DomainEvent['type']> = Extract<DomainEvent, { type: T }>;
function of<T extends DomainEvent['type']>(r: ReplayResult, type: T): Ev<T>[] {
  return r.events.filter((e): e is Ev<T> => e.type === type);
}
const outcomes = (r: ReplayResult): string[] => of(r, 'turn.ended').map((e) => e.payload.outcome);
const toolStates = (r: ReplayResult): string[] => of(r, 'tool.ended').map((e) => e.payload.state);
const startCode = (r: ReplayResult): string | undefined => (r.startError as { code?: string } | undefined)?.code;

/** What each trace was captured to show (RC §11.4, LV P1–P7, Q5; hookprobe; faultproxy; sessions B and A0). */
const EXPECT: Record<string, (r: ReplayResult, s: SessionState) => void> = {
  'bg-agents-task-notification': (r, s) => {
    // two async Agents, their task-notification turns, internal agent hidden from the background count, quiescent at the end
    expect(of(r, 'turn.queued').filter((q) => q.payload.origin === 'task_notification').length).toBeGreaterThanOrEqual(1);
    expect(of(r, 'subagent.started').filter((a) => !a.payload.internal).length).toBeGreaterThanOrEqual(2);
    expect(s.status.kind === 'idle' ? s.status.quiescent : false).toBe(true);
  },
  'clear-generation-switch': (r) => {
    // LV Q5: /clear → SessionEnd(clear) + SessionStart(clear) → a second generation
    const g = of(r, 'session.generationChanged');
    expect(g.length).toBe(2);
    expect(g[1]?.payload.to).not.toBe(g[0]?.payload.to);
  },
  'esc-at-permission': (r) => {
    // RC §6: Esc at a permission dialog → turn_duration only → interrupted{tool_use}, tool denied, permission user_keys
    expect(of(r, 'turn.ended').at(-1)?.payload).toMatchObject({ outcome: 'interrupted', endedBy: 'tool_use_interrupt' });
    expect(toolStates(r)).toEqual(['denied']);
    expect(of(r, 'permission.resolved').at(-1)?.payload).toMatchObject({ decision: 'deny', decider: 'user_keys' });
  },
  'esc-interrupt-after-tool': (r) => {
    // Esc after a tool ran: the turn is interrupted (transcript marker), the tool already succeeded
    expect(outcomes(r)).toEqual(['interrupted']);
    expect(toolStates(r)).toEqual(['succeeded']);
  },
  'ghost-agent-after-stop': (r) => {
    // an internal agent that runs after the turn's Stop never reopens the turn
    expect(outcomes(r)).toEqual(['completed', 'completed']);
    expect(of(r, 'subagent.started').some((a) => a.payload.internal)).toBe(true);
  },
  'hook-allow': (r) => {
    // LV P1: the human allowed at the native dialog; the turn completes
    expect(outcomes(r)).toEqual(['completed']);
    expect(of(r, 'permission.resolved')[0]?.payload.decision).toBe('allow');
  },
  'hook-deny': (r) => {
    // LV P4 / K-15: hook deny → no PostToolUse → the turn continues and completes, tool denied (confirmed by transcript)
    expect(outcomes(r)).toEqual(['completed']);
    expect(toolStates(r)).toEqual(['denied']);
    expect(of(r, 'permission.resolved')[0]?.payload).toMatchObject({ decision: 'deny', decider: 'hook' });
    expect(of(r, 'tool.ended')[0]?.provenance.sources).toContain('transcript');
  },
  'hook-endpoint-down': (r) => {
    // LV P6 / K-20: the HTTP endpoint refused → hooks degraded, the transcript carries the turn
    expect(of(r, 'channel.health').some((h) => h.payload.channel === 'hooks' && h.payload.health === 'degraded')).toBe(true);
    expect(of(r, 'turn.ended')[0]?.payload).toMatchObject({ outcome: 'completed', endedBy: 'turn_duration' });
    expect(of(r, 'turn.ended')[0]?.provenance.sources).toContain('transcript');
  },
  'hook-held-35s': (r) => {
    // LV P2: a PermissionRequest held 35 s, then allowed; the tool runs once
    expect(outcomes(r)).toEqual(['completed']);
    expect(toolStates(r)).toEqual(['succeeded']);
  },
  'hook-timeout-then-keys': (r) => {
    // LV P3: Claude's own hook timeout → native dialog → the human answers with keys
    expect(outcomes(r)).toEqual(['completed']);
    expect(of(r, 'permission.resolved')[0]?.payload).toMatchObject({ decision: 'allow', decider: 'user_keys' });
  },
  'message-display-3-chunks': (r) => {
    // LV P5: one message streamed as three MessageDisplay chunks
    expect(of(r, 'assistant.textDelta').length).toBeGreaterThanOrEqual(3);
    expect(outcomes(r)).toEqual(['completed']);
  },
  'pre-hook-timeout': (r) => {
    // LV P7: a slow PreToolUse; the tool still runs and succeeds (the window ends mid-turn)
    expect(toolStates(r)).toEqual(['succeeded']);
  },
  'retry-storm': (r) => {
    // faultproxy refuse: the screen's `attempt n/10` retry banners are provisional modelCall.retrying (never confirmed by
    // the screen alone); the transcript's repeated api-request records (same requestDigest, tail:[]) are confirmed retries
    const retries = of(r, 'modelCall.retrying');
    const screenOnly = retries.filter((x) => x.provenance.sources.every((src) => src === 'screen'));
    expect(screenOnly.length).toBeGreaterThan(0);
    expect(screenOnly.every((x) => !x.provenance.confirmed)).toBe(true);
    expect(retries.filter((x) => x.provenance.sources.includes('transcript')).every((x) => x.provenance.confirmed)).toBe(true);
  },
  'startup-automode': (r, s) => {
    // session A0: the auto-mode launch screen reaches ready
    expect(of(r, 'session.ready')).toHaveLength(1);
    expect(s.lifecycle).toBe('ready');
  },
  'trust-dialog': (r) => {
    // session B / K-02: the trust dialog is a startup gate → E_TRUST_REQUIRED, nothing pressed
    expect(startCode(r)).toBe('E_TRUST_REQUIRED');
    expect(of(r, 'session.gated')).toHaveLength(1);
  },
};

describe('golden replays (fixtures/traces → fixtures/goldens)', () => {
  it('every trace has a behaviour expectation (a new trace needs one)', () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(names.filter((n) => EXPECT[n] === undefined)).toEqual([]);
  });

  for (const name of names) {
    it(`${name}: replay matches its golden events and final state`, async () => {
      const r = await replay(name);
      // nothing in the trace was left undelivered: every record reached the port it was captured from
      expect(r.diagnostics.filter((d) => (d as { code?: string }).code === 'replay.undelivered')).toEqual([]);
      const cmp = compareGolden(name, r, { update: updateRequested(), root: GOLDENS });
      if (!cmp.ok)
        throw new Error(`golden mismatch for ${name} (run pnpm test:replay -u and review the diff): ${JSON.stringify(cmp.diff)}`);
      expect(cmp.ok).toBe(true);
    });

    it(`${name}: the replay shows what the trace was captured for`, async () => {
      const r = await replay(name);
      const check = EXPECT[name];
      expect(check).toBeDefined();
      check?.(r, r.state);
    });
  }

  // One `it` per trace (it used to replay all of them twice in a single `it` under vitest's 5 s default, which timed out
  // under full-suite load); the replay project also carries an explicit testTimeout (see the config test below).
  for (const name of names) {
    it(`raw replay is deterministic: a second replay of ${name} yields byte-identical goldens`, async () => {
      const a = await replay(name);
      const b = await replayRaw(readTrace(join(TRACES, `${name}.ccd.jsonl`)));
      expect(goldenEventsText(b.events)).toBe(goldenEventsText(a.events));
      expect(goldenStateText(b.state)).toBe(goldenStateText(a.state));
    });
  }

  it('the replay project has an explicit testTimeout well above the 5 s default (whole-corpus tests run under load)', async () => {
    const cfg = (await import('../../vitest.config.js')).default as {
      test?: { projects?: { test?: { name?: string; testTimeout?: number } }[] };
    };
    const proj = cfg.test?.projects?.find((p) => p.test?.name === 'replay');
    expect(proj?.test?.testTimeout ?? 0).toBeGreaterThanOrEqual(30_000);
  });

  it('no golden carries a host path, a token or a self-test nonce (they are scrubbed fixtures, §6.6)', async () => {
    for (const name of names) {
      const text = goldenEventsText((await replay(name)).events);
      expect(text).not.toMatch(/\/Users\/[^/]+|\/home\/[^/]+/);
      expect(text).not.toMatch(/ccd-selftest-[0-9a-f]{32}/);
      expect(text).not.toMatch(/sk-ant-|X-CCD-Token/i);
    }
  });
});
