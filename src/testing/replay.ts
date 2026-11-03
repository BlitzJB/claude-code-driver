// testing/replay.ts — `.ccd.jsonl` traces (DebugRecord v1, DESIGN.md §6.6) → events/state, compared with goldens.
//
// Two replay levels (§6.6):
//   - obs level: only `obs`/`cmd` records → L2 (the core API is passed in, like testing/scenario.ts), CoreInit from the header,
//     so the replay is exact (P-API-04 determinism; the header carries CoreConfig);
//   - raw level: `raw` records (redaction none/full after scrub) → L1+L2+L3 against the fakes on a FakeClock at the recorded
//     `at`, with `tz` from the header (P-REV-35: reset-time parsing never depends on the machine's zone).
// Goldens: `fixtures/goldens/<name>.events.jsonl` (`event` records, wallAt normalised to 0) and `<name>.state.json` (final
// SessionState, keys sorted). Updating is explicit: `pnpm test:replay -u` (or CCD_UPDATE_GOLDENS=1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DebugRecord } from '../model/debug.js';
import type { DomainEvent } from '../model/events.js';
import { stableStringify, type JsonValue } from '../model/json.js';
import type { SessionState } from '../model/state.js';
import type { MonoMs, WallMs } from '../model/time.js';
import type { RawHookEvent, TailEvent, TunnelRecord } from '../platform/ports.js';
import { createTestKernel, type TestKernelOptions } from './test-kernel.js';
import type { CoreApi, CoreInput } from './scenario.js';

export type TraceHeader = Extract<DebugRecord, { r: 'header' }>;
export interface Trace {
  header: TraceHeader;
  records: DebugRecord[];
}

export class TraceFormatError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`trace line ${line}: ${message}`);
    this.name = 'TraceFormatError';
  }
}

const KINDS = new Set(['header', 'raw', 'obs', 'cmd', 'step', 'event', 'effect', 'diag', 'drop']);
const REDACTIONS = new Set(['none', 'meta', 'full']);
const HOOK_TRANSPORTS = new Set(['http', 'unix']);
const RAW_CHANNELS = new Set(['hook', 'transcript', 'screen', 'network', 'registry', 'process', 'input']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse and validate a trace (header first, known record kinds, raw `i` and obs `seq` strictly increasing). */
export function parseTrace(text: string): Trace {
  const records: DebugRecord[] = [];
  let header: TraceHeader | undefined;
  let lastRaw = -1;
  let lastSeq = 0;
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? '';
    if (line.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch (e) {
      throw new TraceFormatError(n + 1, `not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!isObj(v) || typeof v['r'] !== 'string' || !KINDS.has(v['r'])) throw new TraceFormatError(n + 1, 'not a DebugRecord');
    const r = v['r'];
    if (header === undefined) {
      if (r !== 'header') throw new TraceFormatError(n + 1, 'the first record must be the header');
      if (v['format'] !== 'ccd-trace' || v['v'] !== 1) throw new TraceFormatError(n + 1, 'unknown trace format/version');
      if (v['claude'] !== '2.1.316' || v['profile'] !== '2.1.316')
        throw new TraceFormatError(n + 1, 'goldens are pinned to profile 2.1.316');
      if (typeof v['tz'] !== 'string' || v['tz'] === '') throw new TraceFormatError(n + 1, 'header.tz missing (P-REV-35)');
      if (!isObj(v['coreInit']) || !isObj(v['coreInit']['config'])) throw new TraceFormatError(n + 1, 'header.coreInit.config missing');
      if (!REDACTIONS.has(v['redaction'] as string)) throw new TraceFormatError(n + 1, 'header.redaction must be none|meta|full');
      if (!HOOK_TRANSPORTS.has(v['hookTransport'] as string)) throw new TraceFormatError(n + 1, 'header.hookTransport must be http|unix');
      if (typeof v['startedWall'] !== 'number') throw new TraceFormatError(n + 1, 'header.startedWall missing');
      header = v as unknown as TraceHeader;
    } else if (r === 'header') throw new TraceFormatError(n + 1, 'second header');
    if (r === 'raw') {
      if (typeof v['i'] !== 'number' || v['i'] <= lastRaw) throw new TraceFormatError(n + 1, 'raw.i must increase');
      if (typeof v['ch'] !== 'string' || !RAW_CHANNELS.has(v['ch'])) throw new TraceFormatError(n + 1, 'raw.ch unknown');
      if (typeof v['at'] !== 'number' || typeof v['wallAt'] !== 'number') throw new TraceFormatError(n + 1, 'raw.at/wallAt missing');
      lastRaw = v['i'];
    }
    if (r === 'obs') {
      if (typeof v['seq'] !== 'number' || v['seq'] <= lastSeq) throw new TraceFormatError(n + 1, 'obs.seq must increase');
      if (!isObj(v['obs']) || typeof v['obs']['kind'] !== 'string') throw new TraceFormatError(n + 1, 'obs.obs missing');
      lastSeq = v['seq'];
    }
    if (r === 'cmd' && (!isObj(v['cmd']) || typeof v['cmdId'] !== 'number')) throw new TraceFormatError(n + 1, 'cmd malformed');
    records.push(v as unknown as DebugRecord);
  }
  if (header === undefined) throw new TraceFormatError(1, 'empty trace');
  return { header, records };
}

export function readTrace(path: string): Trace {
  return parseTrace(readFileSync(path, 'utf8'));
}

export function serializeTrace(records: readonly DebugRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** The core inputs of a trace in file order (obs and cmd records). */
export function traceInputs(trace: Trace): CoreInput[] {
  const out: CoreInput[] = [];
  for (const r of trace.records) {
    if (r.r === 'obs') out.push({ type: 'obs', obs: r.obs });
    else if (r.r === 'cmd') out.push({ type: 'cmd', cmdId: r.cmdId, cmd: r.cmd, at: r.at as MonoMs, wallAt: r.wallAt as WallMs });
  }
  return out;
}

export interface ReplayResult {
  events: DomainEvent[];
  state: SessionState;
  diagnostics: unknown[];
  /** Raw replay only: the start failure of a kernel that was created but never became ready (a recorded startup gate). */
  startError?: unknown;
}

/** Obs-level replay: L2 only. `drainMs` keeps ticking the core's deadlines that far past the last input. */
export function replayObservations<S extends { domain: SessionState }>(
  trace: Trace,
  core: CoreApi<S>,
  o: { drainMs?: number } = {},
): ReplayResult {
  const init = trace.header.coreInit;
  let c = core.initialCore(init);
  const events: DomainEvent[] = [];
  const diagnostics: unknown[] = [];
  let lastAt = init.startedAt as number;
  let lastWall = init.wallAt as number;
  let seq = 0;
  for (const input of traceInputs(trace)) {
    const res = core.step(c, input);
    c = res.core;
    events.push(...res.events);
    diagnostics.push(...res.diagnostics);
    lastAt = Math.max(lastAt, input.type === 'obs' ? input.obs.meta.at : input.at);
    lastWall = Math.max(lastWall, input.type === 'obs' ? input.obs.meta.wallAt : input.wallAt);
    if (input.type === 'obs') seq = Math.max(seq, input.obs.meta.seq);
  }
  const end = lastAt + (o.drainMs ?? 0);
  for (let guard = 0; guard < 10_000 && core.nextDeadline !== undefined; guard++) {
    const nd = core.nextDeadline(c);
    if (nd.atMono === undefined || nd.atMono > end) break;
    const at = Math.max(lastAt, nd.atMono);
    lastWall += at - lastAt;
    lastAt = at;
    const res = core.step(c, {
      type: 'obs',
      obs: { kind: 'clock.tick', meta: { seq: ++seq, at, wallAt: lastWall, source: 'clock' }, p: {} } as never,
    });
    c = res.core;
    events.push(...res.events);
    diagnostics.push(...res.diagnostics);
  }
  return { events, state: c.domain, diagnostics };
}

export interface RawReplayOptions {
  /** Extra kernel options (modules override, spec additions). */
  kernel?: Omit<TestKernelOptions, 'ports' | 'claude' | 'awaitReady'>;
  /** Fake time after the last raw record (default 6000: lets stop/settle deadlines fire). */
  drainMs?: number;
}

type RawRecord = Extract<DebugRecord, { r: 'raw' }>;
/** Where a mid-session window starts after its leading SessionStart (≥ readyStableMs of idle screen before it). */
const WINDOW_LEAD_MS = 1500;
/** Where a headless window (no hook records) starts: after the fake session's own startup reached ready. */
const HEADLESS_LEAD_MS = 3000;
type ReplayKernel = Awaited<ReturnType<typeof createTestKernel>>;

/**
 * Raw-level replay: L1+L2+L3 against fakes. The pane runs a silent program (no FakeClaude behaviour), the self-test is off
 * (the recorded session already passed or skipped it), the hook transport is the recorded one (`header.hookTransport`), and
 * each raw record is injected through the fake port it was captured from at its recorded mono time.
 *
 * A record whose port does not exist yet (the kernel has not created its pane / hook transport / tail / proxy at that fake
 * time) is held and delivered as soon as the port appears, in order within its channel; nothing is dropped silently. Records still undeliverable
 * at the end are reported as `replay.undelivered` diagnostics. If the kernel cannot even be created (an L3 module missing,
 * config rejected) the replay rejects at once with that error instead of pumping fake time over the whole trace. A kernel that
 * was created but failed to start (e.g. the trust-dialog trace → E_TRUST_REQUIRED) is a legitimate replay outcome: the result
 * carries `startError` and the events published up to then.
 */
export async function replayRaw(trace: Trace, o: RawReplayOptions = {}): Promise<ReplayResult> {
  const h = trace.header;
  if (h.redaction === 'meta')
    throw new TraceFormatError(1, "raw replay needs payload text; a redaction:'meta' trace can only be replayed at obs level");
  const raws = trace.records.filter((r): r is RawRecord => r.r === 'raw');
  const t0 = raws[0]?.at ?? 0;
  // A trace that recorded its startup screens (trust dialog, gates, the first idle composer) replays them over a blank
  // pane. A trace whose first frame comes only after its first prompt (sparse probe snapshots) never shows the idle
  // composer readiness needs, so the pane starts at FakeClaude's idle `ready` screen instead; the recorded frames still
  // replace it as they come (WP-INT, docs/icr/0016-wp-int.md).
  const firstPromptAt = raws.find((r) => r.ch === 'hook' && (r.data as Partial<RawHookEvent>).event === 'UserPromptSubmit')?.at;
  const firstScreenAt = raws.find((r) => r.ch === 'screen')?.at;
  // A window cut from a long session keeps that session's SessionStart and then jumps (minutes) to the window: replayed
  // as recorded, the kernel would hit startupMs inside the gap. Such a gap (> startupHookGrace after a leading SessionStart)
  // is closed: the window starts WINDOW_LEAD_MS after the SessionStart, over the idle `ready` screen (the session was
  // already running when the window began).
  const lead = raws[0];
  const second = raws[1];
  const graceMs = h.coreInit.config.timeouts.startupHookGraceMs;
  const gapShift =
    lead !== undefined &&
    second !== undefined &&
    lead.ch === 'hook' &&
    (lead.data as Partial<RawHookEvent>).event === 'SessionStart' &&
    second.at - lead.at > graceMs
      ? second.at - lead.at - WINDOW_LEAD_MS
      : 0;
  // A window with no hook records at all (a probe session without our hooks, e.g. the fault-proxy run) can never deliver
  // a SessionStart: FakeClaude boots normally (its own SessionStart over the idle screen) and the window starts after the
  // session became ready.
  const headless = !raws.some((r) => r.ch === 'hook');
  const startupRecorded =
    !headless && gapShift === 0 && firstScreenAt !== undefined && (firstPromptAt === undefined || firstScreenAt <= firstPromptAt);
  const dueOf = (r: RawRecord): number => (headless ? HEADLESS_LEAD_MS : 0) + r.at - t0 - (r === lead ? 0 : gapShift);
  const userSpec = o.kernel?.spec ?? {};
  const spec = { ...userSpec, selfTest: 'off' as const, hooks: { ...(userSpec.hooks ?? {}), transport: h.hookTransport } };
  const tk = await createTestKernel({
    ...(o.kernel ?? {}),
    spec,
    awaitReady: false,
    // `/HOME` = the scrubbed home of every fixture (§6.6), so nothing the fakes derive from it looks like a real home
    ports: { tail: 'scripted', timeZone: h.tz, wall: h.startedWall, cwd: h.coreInit.cwdRealpath, home: '/HOME' },
    claude: { startup: startupRecorded ? { kind: 'blank' } : { kind: 'ready' }, sessionStart: headless ? 'immediate' : 'none' },
  });
  const f = tk.fakes;
  const created = (): boolean => {
    try {
      return typeof tk.kernel.getState === 'function';
    } catch {
      return false;
    }
  };
  /** Rethrow when start failed before the kernel object existed (nothing can be replayed). */
  const assertCreatable = (): void => {
    const e = tk.startError;
    if (e === undefined || created()) return;
    throw e instanceof Error ? e : new Error(`testing/replay: kernel could not be created (${JSON.stringify(e)})`);
  };
  const stopped = (): boolean => tk.startError !== undefined;

  // Held records, in file order. Order is kept per channel (a held screen frame never overtakes an older one), but a channel
  // whose port is missing does not hold back the others (no head-of-line blocking across channels).
  const pending: RawRecord[] = [];
  const flush = (): void => {
    const blocked = new Set<string>();
    for (let j = 0; j < pending.length;) {
      const next = pending[j];
      if (next === undefined) break;
      if (blocked.has(next.ch) || !injectRaw(f, next)) {
        blocked.add(next.ch);
        j++;
        continue;
      }
      pending.splice(j, 1);
    }
  };

  const base = f.clock.now();
  for (const r of raws) {
    const due = base + dueOf(r);
    while (f.clock.now() < due) {
      await tk.advance(Math.min(due - f.clock.now(), 250));
      assertCreatable();
      flush();
    }
    assertCreatable();
    if (stopped()) break;
    f.clock.setWall(Math.max(f.clock.wallNow(), r.wallAt));
    pending.push(r);
    flush();
  }
  const drainEnd = f.clock.now() + (o.drainMs ?? 6000);
  while (f.clock.now() < drainEnd) {
    await tk.advance(Math.min(drainEnd - f.clock.now(), 250));
    assertCreatable();
    flush();
  }
  assertCreatable();
  const state = tk.kernel.getState() as SessionState;
  const diagnostics: unknown[] = tk.debug.filter((d) => d.r === 'diag');
  for (const r of pending) diagnostics.push({ r: 'diag', at: r.at, code: 'replay.undelivered', detail: { i: r.i, ch: r.ch } });
  const out: ReplayResult = { events: [...tk.events], state, diagnostics };
  if (tk.startError !== undefined) out.startError = tk.startError;
  return out;
}

/** Deliver one raw record through its fake port; false when that port does not exist yet (the caller retries later). */
function injectRaw(f: ReplayKernel['fakes'], r: RawRecord): boolean {
  switch (r.ch) {
    case 'hook': {
      const e = r.data as Partial<RawHookEvent>;
      if (typeof e.event !== 'string') return true; // not a hook event: nothing to deliver
      const t = f.hooks.instances.at(-1);
      if (t?.state !== 'open') return false;
      t.deliver(e.event, e.payload, e.transport === undefined ? {} : { transport: e.transport });
      return true;
    }
    case 'transcript': {
      const tail = f.scriptedTail?.last;
      if (tail === undefined || tail.listenerCount === 0) return false;
      tail.emit(r.data as TailEvent);
      return true;
    }
    case 'screen': {
      const c = (r.data as { capture?: { lines?: unknown; status?: { cols?: unknown; rows?: unknown } } }).capture;
      if (!Array.isArray(c?.lines)) return true;
      const pane = f.tmux.lastPane();
      if (pane === undefined) return false;
      // show the frame at the geometry it was captured at (full-width rules, P-SCREEN-14)
      const cols = c.status?.cols;
      const rows = c.status?.rows;
      if (typeof cols === 'number' && typeof rows === 'number') pane.setGeometry(cols, rows);
      pane.setScreen(c.lines.map(String));
      return true;
    }
    case 'network': {
      const p = f.net.last;
      if (p === undefined) return false;
      const { at: _a, wallAt: _w, ...rest } = r.data as TunnelRecord;
      p.emit(rest);
      return true;
    }
    case 'registry':
      if (isObj(r.data) && typeof r.data['pid'] === 'number') f.registry.put(r.data as never);
      return true;
    case 'process': {
      const d = r.data as { exitStatus?: number | null; signal?: string | null };
      if (!('exitStatus' in d)) return true;
      const pane = f.tmux.lastPane();
      if (pane === undefined) return false;
      pane.exitPane({ status: d.exitStatus ?? null, signal: d.signal ?? null });
      return true;
    }
    case 'input':
      return true; // our own actions are re-derived by the replayed kernel
  }
}

// ------------------------------------------------------------------------------------------------------------- goldens

/** Events as stored in goldens: wallAt normalised to 0 (§6.6), nothing else changed. */
export function normalizeEvents(events: readonly DomainEvent[]): DomainEvent[] {
  return events.map((e) => ({ ...e, wallAt: 0 as WallMs }));
}

export function goldenPaths(name: string, root = join(process.cwd(), 'fixtures', 'goldens')): { events: string; state: string } {
  return { events: join(root, `${name}.events.jsonl`), state: join(root, `${name}.state.json`) };
}

export function goldenEventsText(events: readonly DomainEvent[]): string {
  return normalizeEvents(events)
    .map((e) => stableStringify({ r: 'event', e }))
    .join('\n')
    .concat(events.length > 0 ? '\n' : '');
}

export function goldenStateText(state: SessionState): string {
  return `${JSON.stringify(JSON.parse(stableStringify(state)) as JsonValue, null, 2)}\n`;
}

/** True when goldens should be (re)written: `-u` / `--update` on the command line or CCD_UPDATE_GOLDENS=1. */
export function updateRequested(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CCD_UPDATE_GOLDENS'] === '1' || argv.includes('-u') || argv.includes('--update');
}

export interface GoldenComparison {
  ok: boolean;
  written: boolean;
  /** First differing line (1-based) per file, when not ok. */
  diff?: { file: string; line: number; expected: string; actual: string }[];
}

/** Compare a replay with its goldens; write them when `update` (missing goldens never pass silently). */
export function compareGolden(
  name: string,
  r: Pick<ReplayResult, 'events' | 'state'>,
  o: { update?: boolean; root?: string } = {},
): GoldenComparison {
  const p = goldenPaths(name, o.root);
  const actual = { [p.events]: goldenEventsText(r.events), [p.state]: goldenStateText(r.state) };
  if (o.update ?? updateRequested()) {
    for (const [file, text] of Object.entries(actual)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return { ok: true, written: true };
  }
  const diff: NonNullable<GoldenComparison['diff']> = [];
  for (const [file, text] of Object.entries(actual)) {
    if (!existsSync(file)) {
      diff.push({ file, line: 0, expected: '<missing golden: run with -u>', actual: text.split('\n')[0] ?? '' });
      continue;
    }
    const exp = readFileSync(file, 'utf8').split('\n');
    const act = text.split('\n');
    const n = Math.max(exp.length, act.length);
    for (let i = 0; i < n; i++) {
      if (exp[i] !== act[i]) {
        diff.push({ file, line: i + 1, expected: exp[i] ?? '<eof>', actual: act[i] ?? '<eof>' });
        break;
      }
    }
  }
  return diff.length === 0 ? { ok: true, written: false } : { ok: false, written: false, diff };
}

/** Replay a trace by name from fixtures/traces at the level its records allow (raw if present, else obs). */
export async function replayTrace<S extends { domain: SessionState }>(
  pathOrTrace: string | Trace,
  o: { core?: CoreApi<S>; raw?: RawReplayOptions; level?: 'obs' | 'raw' } = {},
): Promise<ReplayResult> {
  const trace = typeof pathOrTrace === 'string' ? readTrace(pathOrTrace) : pathOrTrace;
  const hasRaw = trace.records.some((r) => r.r === 'raw');
  const level = o.level ?? (hasRaw ? 'raw' : 'obs');
  if (level === 'raw') return replayRaw(trace, o.raw ?? {});
  if (o.core === undefined) throw new Error('replayTrace: an obs-level replay needs the core API (`core`)');
  return replayObservations(trace, o.core);
}
