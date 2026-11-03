// session/limit-recorder.ts — always-on narrow raw ring; dumps a fixture on the first real usage limit (DESIGN.md §3.9 (b),
// rev 2 §10 G23; P-REV-40, P-SEC-42).
//
// The usage-limit pipeline was only testable with synthetic fixtures. This recorder keeps the last 2 000 raw records of
// NARROW content only, so it can stay on in every session without holding prompts or tool output:
//   - screen: the bottom 12 rows of each changed capture;
//   - hooks: `StopFailure`, `Notification`, `Stop` payloads only;
//   - transcript: entries with `isApiErrorMessage` or `type:'system'` only.
// It dumps the ring (scrubbed with the `fixtures:scrub` forms, redact.ts `createFixtureScrubber`) to
// `stateDir/limit-captures/<wall>-<sessionKey>.ccd.jsonl` (StateStorePort, 0600) on the first `usage.limited` of the session,
// or when a bottom-row line matches /limit|resets|usage/i while the frame classified no limit (status `none` /
// `retryingUnparsed` / absent): the string tables may have drifted. Each trigger kind dumps at most once per session, and
// at most `maxDumps` files are written per session. The caller turns `onCaptured(path)` into `warning{reason:'limitCaptured'}`.

import type { DebugRecord } from '../model/debug.js';
import type { DomainEvent } from '../model/events.js';
import type { ScreenFacts } from '../model/screen-facts.js';
import type { Capture, RawHookEvent, StateStorePort, TailEvent } from '../platform/ports.js';
import type { FixtureScrubber } from './redact.js';

export const LIMIT_RING_CAPACITY = 2000;
export const LIMIT_SCREEN_ROWS = 12;
export const LIMIT_CAPTURE_DIR = 'limit-captures';
const NARROW_HOOKS: ReadonlySet<string> = new Set(['StopFailure', 'Notification', 'Stop']);
const SCREEN_TRIGGER_RE = /limit|resets|usage/i;

type RawRec = Extract<DebugRecord, { r: 'raw' }>;
type Header = Extract<DebugRecord, { r: 'header' }>;

export interface LimitRecorderOptions {
  enabled: boolean;
  sessionKey: string;
  state: StateStorePort;
  /** A fresh scrubber per dump (consistent fakes within one file). */
  scrubber: () => FixtureScrubber;
  /** The trace header for the dump (redaction is recorded as 'full': the content is scrubbed, not hashed). */
  header: () => Header | undefined;
  onCaptured?: (path: string, trigger: 'usageLimited' | 'screenUnparsed') => void;
  onError?: (e: unknown) => void;
  capacity?: number;
  maxDumps?: number;
}

export interface LimitRecorder {
  recordCapture(c: Capture, wallAt: number): void;
  recordHook(e: RawHookEvent): void;
  recordTail(e: TailEvent, at: number, wallAt: number): void;
  /** Feed published events; the first `usage.limited` dumps. */
  onEvents(events: readonly DomainEvent[], wallNow: number): void;
  /** Feed a classified frame with its capture; an unclassified limit-looking line dumps. */
  onFrame(facts: ScreenFacts | undefined, c: Capture, wallNow: number): void;
  /** Number of records currently held. */
  readonly size: number;
  readonly dumps: readonly string[];
  /** Pending dump writes (tests and close). */
  idle(): Promise<void>;
}

export function createLimitRecorder(o: LimitRecorderOptions): LimitRecorder {
  const cap = Math.max(1, o.capacity ?? LIMIT_RING_CAPACITY);
  const maxDumps = o.maxDumps ?? 3;
  const ring: RawRec[] = [];
  let i = 0;
  let lastScreenHash: string | undefined;
  const fired = new Set<string>();
  const dumps: string[] = [];
  let writing: Promise<void> = Promise.resolve();

  const push = (r: RawRec): void => {
    ring.push(r);
    if (ring.length > cap) ring.shift();
  };

  const dump = (trigger: 'usageLimited' | 'screenUnparsed', wallNow: number): void => {
    if (!o.enabled || fired.has(trigger) || dumps.length >= maxDumps || ring.length === 0) return;
    fired.add(trigger);
    const records = ring.slice();
    const header = o.header();
    const rel = `${LIMIT_CAPTURE_DIR}/${Math.floor(wallNow)}-${o.sessionKey.replace(/[^A-Za-z0-9]/g, '')}.ccd.jsonl`;
    dumps.push(rel);
    writing = writing
      .then(async () => {
        const s = o.scrubber();
        const lines: string[] = [];
        if (header !== undefined) lines.push(JSON.stringify(s.value({ ...header, redaction: 'full' })));
        for (const r of records) lines.push(JSON.stringify(s.value(r)));
        // appendLine creates the file 0600 inside the 0700 state dir (StateStorePort contract)
        for (const l of lines) await o.state.appendLine(rel, l);
        o.onCaptured?.(`${o.state.root}/${rel}`, trigger);
      })
      .catch((e: unknown) => {
        try {
          o.onError?.(e);
        } catch {
          // ignore
        }
      });
  };

  return {
    recordCapture(c: Capture, wallAt: number): void {
      if (!o.enabled || c.hash === lastScreenHash) return;
      lastScreenHash = c.hash;
      const lines = c.lines.slice(-LIMIT_SCREEN_ROWS);
      push({ r: 'raw', i: i++, ch: 'screen', at: c.at, wallAt, data: { capture: { lines, status: c.status, at: c.at, hash: c.hash } } });
    },
    recordHook(e: RawHookEvent): void {
      if (!o.enabled || !NARROW_HOOKS.has(e.event)) return;
      const { closed: _closed, ...data } = e;
      push({ r: 'raw', i: i++, ch: 'hook', at: e.at, wallAt: e.wallAt, data });
    },
    recordTail(e: TailEvent, at: number, wallAt: number): void {
      if (!o.enabled || e.kind !== 'line') return;
      const j = e.line.json;
      if (typeof j !== 'object' || j === null) return;
      const rec = j as Record<string, unknown>;
      if (rec['isApiErrorMessage'] !== true && rec['type'] !== 'system') return;
      push({ r: 'raw', i: i++, ch: 'transcript', at: at, wallAt, data: e });
    },
    onEvents(events: readonly DomainEvent[], wallNow: number): void {
      if (!o.enabled) return;
      if (events.some((e) => e.type === 'usage.limited' && e.replayed !== true)) dump('usageLimited', wallNow);
    },
    onFrame(facts: ScreenFacts | undefined, c: Capture, wallNow: number): void {
      if (!o.enabled || fired.has('screenUnparsed')) return;
      if (facts?.usageLimit !== undefined) return;
      const kind = facts?.status?.kind;
      if (kind !== undefined && kind !== 'none' && kind !== 'retryingUnparsed') return;
      const bottom = c.lines.slice(-LIMIT_SCREEN_ROWS);
      if (bottom.some((l) => SCREEN_TRIGGER_RE.test(l))) dump('screenUnparsed', wallNow);
    },
    get size(): number {
      return ring.length;
    },
    dumps,
    idle: () => writing,
  };
}
