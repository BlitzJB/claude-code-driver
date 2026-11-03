// cli/trace.ts — `ccd trace replay|explain <file>` over `.ccd.jsonl` traces (DebugRecord v1, DESIGN.md §6.6, D-32; AL §8.3).
//
// - `replay <file> [--golden G] [--kinds k,…] [--json]`: replays the recorded stream in order as a readable timeline (header,
//   commands, observations, steps, events, effects, diagnostics, drops) and, with `--golden`, compares the recorded `event`
//   records with a golden `*.events.jsonl` (wallAt normalised to 0, canonical JSON; exit 1 on the first mismatch).
// - `explain <file> --event <seq>`: prints the causal chain of one DomainEvent: raw records → observations (`causedBy`) →
//   the step that emitted it (with its intents) → the effects of those intents (AL §8.3, "why did it say stalled?").
//
// Re-executing a trace through L1/L2 is `testing/replay.ts` (the `replay` vitest project); the cli may not import core or
// testing (§1.3), so this command works on what the trace recorded.

import type { DebugRecord } from '../model/debug.js';
import type { DomainEvent } from '../model/events.js';
import { stableStringify } from '../model/json.js';

export class TraceError extends Error {
  override readonly name = 'TraceError';
}

const KINDS = ['header', 'raw', 'obs', 'cmd', 'step', 'event', 'effect', 'diag', 'drop'] as const;
export type RecordKind = (typeof KINDS)[number];

export interface ParsedTrace {
  records: DebugRecord[];
  /** 1-based line numbers of lines that were not a DebugRecord (kept going: a trace may be torn at the tail). */
  malformed: { line: number; reason: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validate(v: unknown): string | undefined {
  if (!isObj(v)) return 'not an object';
  const r = v['r'];
  if (typeof r !== 'string' || !(KINDS as readonly string[]).includes(r)) return `unknown record kind ${JSON.stringify(r)}`;
  switch (r as RecordKind) {
    case 'header':
      return v['format'] === 'ccd-trace' && v['v'] === 1 ? undefined : 'header is not ccd-trace v1';
    case 'raw':
      return isNum(v['i']) && typeof v['ch'] === 'string' && isNum(v['at']) ? undefined : 'raw needs i, ch, at';
    case 'obs':
      return isNum(v['seq']) && isObj(v['obs']) && typeof v['obs']['kind'] === 'string' ? undefined : 'obs needs seq, obs.kind';
    case 'cmd':
      return isNum(v['cmdId']) && isObj(v['cmd']) ? undefined : 'cmd needs cmdId, cmd';
    case 'step':
      return isNum(v['inSeq']) && Array.isArray(v['events']) && Array.isArray(v['intents'])
        ? undefined
        : 'step needs inSeq, events[], intents[]';
    case 'event':
      return isObj(v['e']) && isNum(v['e']['seq']) && typeof v['e']['type'] === 'string' ? undefined : 'event needs e.seq, e.type';
    case 'effect':
      return isNum(v['intentId']) && typeof v['ok'] === 'boolean' ? undefined : 'effect needs intentId, ok';
    case 'diag':
      return typeof v['code'] === 'string' ? undefined : 'diag needs code';
    case 'drop':
      return isNum(v['count']) ? undefined : 'drop needs count';
  }
}

export function parseTrace(text: string): ParsedTrace {
  const records: DebugRecord[] = [];
  const malformed: ParsedTrace['malformed'] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim();
    if (l === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      malformed.push({ line: i + 1, reason: 'invalid JSON' });
      continue;
    }
    const err = validate(v);
    if (err !== undefined) malformed.push({ line: i + 1, reason: err });
    else records.push(v as DebugRecord);
  }
  return { records, malformed };
}

const ellipsis = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const preview = (v: unknown, max = 160): string => ellipsis(stableStringify(v), max);

export interface TraceSummary {
  header?: {
    lib: string;
    claude: string;
    tmux: string;
    node: string;
    platform: string;
    tz: string;
    redaction: string;
    hookTransport: string;
  };
  counts: Partial<Record<RecordKind, number>>;
  rawByChannel: Record<string, number>;
  eventTypes: Record<string, number>;
  monoSpanMs?: number;
  dropped: number;
  malformed: number;
}

function atOf(r: DebugRecord): number | undefined {
  switch (r.r) {
    case 'raw':
    case 'cmd':
    case 'effect':
    case 'diag':
      return r.at;
    case 'obs':
      return r.obs.meta.at;
    case 'event':
      return r.e.at;
    case 'header':
    case 'step':
    case 'drop':
      return undefined;
  }
}

export function summarizeTrace(t: ParsedTrace): TraceSummary {
  const s: TraceSummary = { counts: {}, rawByChannel: {}, eventTypes: {}, dropped: 0, malformed: t.malformed.length };
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of t.records) {
    s.counts[r.r] = (s.counts[r.r] ?? 0) + 1;
    const at = atOf(r);
    if (at !== undefined && Number.isFinite(at)) {
      lo = Math.min(lo, at);
      hi = Math.max(hi, at);
    }
    if (r.r === 'header' && s.header === undefined)
      s.header = {
        lib: r.lib,
        claude: r.claude,
        tmux: r.tmux,
        node: r.node,
        platform: r.platform,
        tz: r.tz,
        redaction: r.redaction,
        hookTransport: r.hookTransport,
      };
    else if (r.r === 'raw') s.rawByChannel[r.ch] = (s.rawByChannel[r.ch] ?? 0) + 1;
    else if (r.r === 'event') s.eventTypes[r.e.type] = (s.eventTypes[r.e.type] ?? 0) + 1;
    else if (r.r === 'drop') s.dropped += r.count;
  }
  if (hi >= lo) s.monoSpanMs = hi - lo;
  return s;
}

export function formatRecord(r: DebugRecord): string {
  switch (r.r) {
    case 'header':
      return `header lib=${r.lib} claude=${r.claude} tmux=${r.tmux} node=${r.node} ${r.platform} tz=${r.tz} redaction=${r.redaction} hooks=${r.hookTransport}`;
    case 'raw':
      return `@${r.at} raw#${r.i} ${r.ch} ${preview(r.data, 120)}`;
    case 'obs':
      return `@${r.obs.meta.at} obs#${r.seq} ${r.obs.kind} [${r.obs.meta.source}]${r.rawRef === undefined ? '' : ` ←raw#${r.rawRef}`} ${preview(r.obs.p, 120)}`;
    case 'cmd':
      return `@${r.at} cmd#${r.cmdId} ${preview(r.cmd, 140)}`;
    case 'step':
      return `step in ${stepInputLabel(r.inSeq)} → events [${r.events.join(',')}] intents [${r.intents.map((i) => `${i.kind}#${i.id}`).join(', ')}] ${r.durUs}µs`;
    case 'event':
      return `@${r.e.at} event#${r.e.seq} ${r.e.type}${r.e.turnKey ? ` ${r.e.turnKey}` : ''}${r.e.provenance.confirmed ? '' : ' (unconfirmed)'} ← obs[${r.e.causedBy.join(',')}] ${preview(r.e.payload, 120)}`;
    case 'effect':
      return `@${r.at} effect intent#${r.intentId} ${r.ok ? 'ok' : `FAILED ${r.error ?? ''}`} ${r.durMs}ms`;
    case 'diag':
      return `@${r.at} diag ${r.code} ${preview(r.detail, 120)}`;
    case 'drop':
      return `drop ${r.count} (${r.reason})`;
  }
}

export interface ReplayOptions {
  kinds?: ReadonlySet<RecordKind>;
  golden?: string;
}

export interface ReplayResult {
  lines: string[];
  summary: TraceSummary;
  golden?: { ok: boolean; compared: number; firstMismatch?: { index: number; expected?: string; actual?: string } };
  exitCode: number;
}

/** Golden lines may be `{r:'event', e}` (testing/replay.ts goldenEventsText) or bare events. */
export function parseGolden(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim();
    if (l === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new TraceError(`golden line ${i + 1}: invalid JSON`);
    }
    const e = isObj(v) && v['r'] === 'event' ? v['e'] : v;
    if (!isObj(e)) throw new TraceError(`golden line ${i + 1}: not an event`);
    out.push(stableStringify({ ...e, wallAt: 0 }));
  }
  return out;
}

export function compareWithGolden(events: readonly DomainEvent[], goldenText: string): NonNullable<ReplayResult['golden']> {
  const expected = parseGolden(goldenText);
  const actual = events.map((e) => stableStringify({ ...e, wallAt: 0 }));
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const exp = expected[i];
    const act = actual[i];
    if (exp !== act) {
      const m: { index: number; expected?: string; actual?: string } = { index: i };
      if (exp !== undefined) m.expected = exp;
      if (act !== undefined) m.actual = act;
      return { ok: false, compared: n, firstMismatch: m };
    }
  }
  return { ok: true, compared: n };
}

export function replayTrace(t: ParsedTrace, o: ReplayOptions = {}): ReplayResult {
  const summary = summarizeTrace(t);
  const lines: string[] = [];
  for (const r of t.records) if (o.kinds === undefined || o.kinds.has(r.r)) lines.push(formatRecord(r));
  for (const m of t.malformed) lines.push(`malformed line ${m.line}: ${m.reason}`);
  const result: ReplayResult = { lines, summary, exitCode: 0 };
  if (o.golden !== undefined) {
    const events = t.records.flatMap((r) => (r.r === 'event' ? [r.e] : []));
    result.golden = compareWithGolden(events, o.golden);
    if (result.golden.ok) lines.push(`golden: ${result.golden.compared} events match`);
    else {
      const m = result.golden.firstMismatch;
      lines.push(`golden MISMATCH at event index ${m?.index ?? '?'}`);
      lines.push(`  expected: ${m?.expected === undefined ? '(none)' : ellipsis(m.expected, 400)}`);
      lines.push(`  actual:   ${m?.actual === undefined ? '(none)' : ellipsis(m.actual, 400)}`);
      result.exitCode = 1;
    }
  }
  lines.push(formatSummary(summary));
  return result;
}

export function formatSummary(s: TraceSummary): string {
  const counts = KINDS.filter((k) => s.counts[k] !== undefined)
    .map((k) => `${k}=${s.counts[k] ?? 0}`)
    .join(' ');
  const ch = Object.entries(s.rawByChannel)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return [
    `summary: ${counts || 'empty'}${s.monoSpanMs === undefined ? '' : `, span ${s.monoSpanMs} ms`}`,
    ch ? `  raw by channel: ${ch}` : '',
    s.dropped > 0 ? `  dropped records: ${s.dropped}` : '',
    s.malformed > 0 ? `  malformed lines: ${s.malformed}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface Explanation {
  event: DomainEvent;
  observations: { seq: number; record?: Extract<DebugRecord, { r: 'obs' }>; raw?: Extract<DebugRecord, { r: 'raw' }> }[];
  step?: Extract<DebugRecord, { r: 'step' }>;
  stepInput?: Extract<DebugRecord, { r: 'obs' }> | Extract<DebugRecord, { r: 'cmd' }>;
  effects: Extract<DebugRecord, { r: 'effect' }>[];
  siblings: number[];
}

/**
 * The record a step consumed. `session/kernel.ts` writes `inSeq = obs.meta.seq` for an observation and `inSeq = -cmdId` for
 * a command (the two numberings are independent, so the sign is what tells them apart).
 */
export function stepInputOf(
  step: Extract<DebugRecord, { r: 'step' }>,
  obsBySeq: ReadonlyMap<number, Extract<DebugRecord, { r: 'obs' }>>,
  cmdById: ReadonlyMap<number, Extract<DebugRecord, { r: 'cmd' }>>,
): Extract<DebugRecord, { r: 'obs' }> | Extract<DebugRecord, { r: 'cmd' }> | undefined {
  return step.inSeq < 0 ? cmdById.get(-step.inSeq) : obsBySeq.get(step.inSeq);
}

const stepInputLabel = (inSeq: number): string => (inSeq < 0 ? `cmd#${-inSeq}` : `obs#${inSeq}`);

export function explainEvent(t: ParsedTrace, seq: number): Explanation {
  const ev = t.records.find((r): r is Extract<DebugRecord, { r: 'event' }> => r.r === 'event' && r.e.seq === seq);
  if (ev === undefined) throw new TraceError(`no event with seq ${seq} in the trace`);
  const obsBySeq = new Map<number, Extract<DebugRecord, { r: 'obs' }>>();
  const rawByI = new Map<number, Extract<DebugRecord, { r: 'raw' }>>();
  const cmdById = new Map<number, Extract<DebugRecord, { r: 'cmd' }>>();
  for (const r of t.records) {
    if (r.r === 'obs') obsBySeq.set(r.seq, r);
    else if (r.r === 'raw') rawByI.set(r.i, r);
    else if (r.r === 'cmd') cmdById.set(r.cmdId, r);
  }
  const observations: Explanation['observations'] = ev.e.causedBy.map((s) => {
    const o: Explanation['observations'][number] = { seq: s };
    const rec = obsBySeq.get(s);
    if (rec !== undefined) {
      o.record = rec;
      if (rec.rawRef !== undefined) {
        const raw = rawByI.get(rec.rawRef);
        if (raw !== undefined) o.raw = raw;
      }
    }
    return o;
  });
  const step = t.records.find((r): r is Extract<DebugRecord, { r: 'step' }> => r.r === 'step' && r.events.includes(seq));
  const x: Explanation = { event: ev.e, observations, effects: [], siblings: [] };
  if (step !== undefined) {
    x.step = step;
    x.siblings = step.events.filter((s) => s !== seq);
    const input = stepInputOf(step, obsBySeq, cmdById);
    if (input !== undefined) x.stepInput = input;
    const ids = new Set(step.intents.map((i) => i.id as number));
    x.effects = t.records.filter((r): r is Extract<DebugRecord, { r: 'effect' }> => r.r === 'effect' && ids.has(r.intentId));
  }
  return x;
}

export function formatExplanation(x: Explanation): string {
  const out: string[] = [];
  out.push(`event #${x.event.seq} ${x.event.type} at ${x.event.at}${x.event.turnKey ? ` turn ${x.event.turnKey}` : ''}`);
  out.push(
    `  provenance: ${x.event.provenance.confirmed ? 'confirmed' : 'unconfirmed'} via ${x.event.provenance.sources.join(', ') || '(none)'}`,
  );
  out.push(`  payload: ${preview(x.event.payload, 400)}`);
  if (x.observations.length === 0) out.push('  caused by: (no observations; a deadline or command)');
  for (const o of x.observations) {
    if (o.record === undefined) {
      out.push(`  ← obs#${o.seq} (not in the trace)`);
      continue;
    }
    out.push(`  ← ${formatRecord(o.record)}`);
    if (o.raw !== undefined) out.push(`      ← ${formatRecord(o.raw)}`);
    else if (o.record.rawRef !== undefined) out.push(`      ← raw#${o.record.rawRef} (not in the trace; raw:'meta' redaction?)`);
  }
  if (x.step === undefined) out.push('  step: (no step record emitted this event)');
  else {
    out.push(`  emitted by ${formatRecord(x.step)}`);
    if (x.stepInput !== undefined) out.push(`    input: ${formatRecord(x.stepInput)}`);
    if (x.siblings.length > 0) out.push(`    same step also emitted events [${x.siblings.join(',')}]`);
    for (const i of x.step.intents) out.push(`    intent ${i.kind}#${i.id} ${preview(i, 160)}`);
    for (const e of x.effects) out.push(`    ${formatRecord(e)}`);
  }
  return out.join('\n') + '\n';
}

export function parseKinds(s: string): Set<RecordKind> {
  const out = new Set<RecordKind>();
  for (const k of s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    if (!(KINDS as readonly string[]).includes(k))
      throw new TraceError(`unknown record kind ${JSON.stringify(k)} (one of ${KINDS.join(', ')})`);
    out.add(k as RecordKind);
  }
  return out;
}
