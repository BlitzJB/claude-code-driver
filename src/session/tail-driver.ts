// session/tail-driver.ts — executes `tail.*` intents against the TranscriptTail, feeds tail events through the L1
// transcript normalizer, and feeds hook `transcript_path`s to `observePath` + `poke()` (DESIGN.md §1.2, §2.6 intents,
// §2.7.4 TranscriptTail; TT §13).
//
//   - `tail.followMain` / `observePath` / `expectSubagent` / `subagentStopped` / `poke` map 1:1 onto the port.
//   - Every TailEvent → `createTranscriptNormalizer(profile).push(e)` → observations to the sink (the core de-duplicates by
//     entry uuid per generation, D-42; nothing is filtered here, L1/L3 never filter by session id, §2.8).
//   - Hooks lead, the transcript confirms (§0.2 "Transcript written promptly"): every hook event pokes the tail so the
//     follower switches to its fast burst instead of waiting for the idle poll, and a hook `transcript_path` that differs from
//     the last one known for that session is handed to `observePath` (P-TAIL-23: `/cd`, worktrees move the file; the hook
//     path is authoritative, paths are never recomputed from a slug when a hook gave one, §0.2 "Slug rule").
//   - A fatal tail error becomes `channel.health transcript down{reason}`; the next healthy line restores `up`.

import type { Intent } from '../model/intents.js';
import type { Logger } from '../model/logger.js';
import type { Cancel, Clock } from '../model/time.js';
import type { RawHookEvent, TailEvent, TranscriptTail } from '../platform/ports.js';
import type { ClaudeProfile } from '../channels/profiles/index.js';
import { createTranscriptNormalizer } from '../channels/transcript/normalize.js';
import type { TranscriptNormalizer } from '../channels/transcript/normalize.js';
import type { ObservationSink } from './input-executor.js';

type TailIntent = Extract<
  Intent,
  { kind: 'tail.followMain' | 'tail.observePath' | 'tail.expectSubagent' | 'tail.subagentStopped' | 'tail.poke' }
>;

export interface TailDriverOptions {
  clock: Clock;
  tail: TranscriptTail;
  emit: ObservationSink;
  profile: ClaudeProfile;
  /** Override the normalizer (tests); default `createTranscriptNormalizer(profile, {now: clock})`. */
  normalizer?: TranscriptNormalizer;
  logger?: Logger;
}

export interface TailDriver {
  execute(intent: TailIntent): void;
  /** Feed every RawHookEvent: pokes the tail and relocates on a new main `transcript_path`. */
  noteHookEvent(raw: RawHookEvent): void;
  /** Last transcript path seen for a Claude session id (hook or followMain). */
  knownPath(sessionId: string): string | undefined;
  /** Unsubscribe and close the tail. Idempotent. */
  close(): Promise<void>;
}

/** Hook events after which the transcript most likely grew (everything but the pre-execution ones). */
const NO_POKE: ReadonlySet<string> = new Set(['PreToolUse', 'PermissionRequest']);

function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function createTailDriver(o: TailDriverOptions): TailDriver {
  const clock = o.clock;
  const normalizer = o.normalizer ?? createTranscriptNormalizer(o.profile, { now: () => ({ at: clock.now(), wallAt: clock.wallNow() }) });
  const paths = new Map<string, string>();
  let closed = false;
  let down = false;

  const health = (h: 'up' | 'down', reason: string): void => {
    o.emit({
      kind: 'channel.health',
      meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'channel' },
      p: { channel: 'transcript', health: h, reason },
    });
  };

  const onEvent = (e: TailEvent): void => {
    if (closed) return;
    if (e.kind === 'error' && e.fatal && !down) {
      down = true;
      o.logger?.warn('tail-driver: fatal tail error', { file: e.file?.kind ?? 'none' });
      health('down', 'tailError');
    } else if (e.kind === 'line' && down) {
      down = false;
      health('up', 'tailError');
    }
    if (e.kind === 'opened' || e.kind === 'moved') {
      const path = e.kind === 'opened' ? e.path : e.to;
      if (e.file.kind === 'main') paths.set(e.file.sessionId, path);
    }
    let obs;
    try {
      obs = normalizer.push(e);
    } catch (err) {
      // L1 never throws by contract; a bug there must not kill the tail listener.
      o.logger?.error('tail-driver: normalizer threw', { kind: e.kind, error: err instanceof Error ? err.name : typeof err });
      return;
    }
    for (const x of obs) o.emit(x);
  };

  const cancel: Cancel = o.tail.on(onEvent);

  const observe = (sessionId: string, path: string, source: string): void => {
    if (paths.get(sessionId) === path) return;
    paths.set(sessionId, path);
    o.tail.observePath(sessionId, path, source);
  };

  return {
    execute(intent: TailIntent): void {
      if (closed) return;
      switch (intent.kind) {
        case 'tail.followMain':
          paths.set(intent.sessionId, intent.path);
          o.tail.followMain(intent.sessionId, intent.path, { startAt: intent.startAt });
          return;
        case 'tail.observePath':
          paths.set(intent.sessionId, intent.path);
          o.tail.observePath(intent.sessionId, intent.path, intent.source);
          return;
        case 'tail.expectSubagent':
          o.tail.expectSubagent(intent.sessionId, intent.agentId);
          return;
        case 'tail.subagentStopped':
          if (intent.path !== undefined) o.tail.subagentStopped(intent.sessionId, intent.agentId, intent.path);
          else o.tail.subagentStopped(intent.sessionId, intent.agentId);
          return;
        case 'tail.poke':
          o.tail.poke(intent.reason);
          return;
      }
    },

    noteHookEvent(raw: RawHookEvent): void {
      if (closed) return;
      const p = raw.payload;
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
        const rec = p as Record<string, unknown>;
        const sid = str(rec, 'session_id');
        const tp = str(rec, 'transcript_path');
        // Only absolute paths are trusted as file locations (a relative one would resolve against our cwd, not Claude's).
        if (sid !== undefined && tp?.startsWith('/') === true) {
          // SessionStart for a new generation is followed by the core's tail.followMain; any other hook only relocates a
          // session the tail already knows (P-TAIL-23).
          if (paths.has(sid) && raw.event !== 'SessionStart') observe(sid, tp, `hook:${raw.event}`);
        }
      }
      if (!NO_POKE.has(raw.event)) o.tail.poke(`hook:${raw.event}`);
    },

    knownPath(sessionId: string): string | undefined {
      return paths.get(sessionId);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      cancel();
      try {
        await o.tail.close();
      } catch (e) {
        o.logger?.debug('tail-driver: tail close failed', { error: e instanceof Error ? e.name : typeof e });
      }
    },
  };
}
