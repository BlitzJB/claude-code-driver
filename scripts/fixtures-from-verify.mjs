#!/usr/bin/env node
// scripts/fixtures-from-verify.mjs — build the initial replay traces without new live runs (DESIGN.md §6.6, RC §11.4).
//
//   node scripts/fixtures-from-verify.mjs [--out fixtures/traces] [--verify fixtures/verify]
//        [--hookprobe <dir> --hookprobe-transcript <main.jsonl>] [--faultproxy <dir> --faultproxy-transcript <main.jsonl>]
//
// Sources: the live verification corpus in fixtures/verify (always) and, when given, the BRIEF probe dirs (hookprobe,
// faultproxy) with their transcripts. Every record becomes a `raw` DebugRecord on the channel it was captured from:
//   hook → RawHookEvent   (SessionStart/PermissionRequest from the command log = transport unix, holdable; every other event from
//                           the HTTP log = transport http; the hookprobe registered command hooks only → unix)
//   transcript → TailEvent{kind:'line'}  at the time the 20 ms poller first saw the line (transcript-seen.jsonl), or the entry
//                           timestamp for probe transcripts
//   screen → {capture}     one per `=== <epoch>` frame of the capture logs / hookprobe snaps
// The header carries CoreInit with fixtures/traces/core-config.default.json and `tz` (the machine that recorded the corpus ran in
// Asia/Kolkata, as the screen's `done 4:18 AM` at 22:48 UTC shows; P-REV-35). Each trace is scrubbed (fixtures-scrub.mjs) and
// linted (fixtures-lint.mjs) before it is written; a lint finding aborts the run.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createScrubber } from './fixtures-scrub.mjs';
import { lintText } from './fixtures-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
export const RECORDING_TZ = 'Asia/Kolkata';
const SESSION_KEY = 's0000c0de';

function args(argv) {
  const o = { out: join(ROOT, 'fixtures', 'traces'), verify: join(ROOT, 'fixtures', 'verify') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k?.startsWith('--') === true && v !== undefined) {
      o[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      i++;
    }
  }
  return o;
}

const readJsonl = (p) =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

/** `=== <epoch>[ extra]` separated capture log → [{t, lines}] */
export function readFrames(path) {
  const out = [];
  let cur;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const m = /^=== (\d{10,})/.exec(raw);
    if (m) {
      if (cur) out.push(cur);
      cur = { t: Number(m[1]), lines: [] };
    } else if (cur) cur.lines.push(raw);
  }
  if (cur) out.push(cur);
  for (const f of out) while (f.lines.length > 0 && f.lines.at(-1) === '') f.lines.pop();
  return out;
}

function capture(t, lines, at) {
  const cols = Math.max(80, ...lines.map((l) => [...l].length));
  return {
    capture: {
      lines,
      status: {
        exists: true,
        dead: false,
        exitStatus: null,
        exitSignal: null,
        inMode: false,
        alternateOn: false,
        cursorX: 0,
        cursorY: Math.max(0, lines.length - 1),
        cols,
        rows: Math.max(24, lines.length),
        historySize: 0,
      },
      at,
      hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16),
    },
  };
}

/** A trace under construction: events with absolute epoch ms, sorted and numbered at the end. */
class TraceBuilder {
  constructor(name, o) {
    this.name = name;
    this.o = o;
    this.items = [];
    this.hookSeq = 0;
    this.offsets = new Map();
  }
  hook(t, event, payload, transport) {
    this.items.push({
      t,
      ch: 'hook',
      make: (at) => ({
        hookSeq: ++this.hookSeq,
        at,
        wallAt: t,
        transport,
        event,
        bytes: Buffer.byteLength(JSON.stringify(payload)),
        truncated: false,
        payload,
        holdable: transport === 'unix' && event === 'PermissionRequest',
      }),
    });
  }
  line(t, file, json) {
    this.items.push({
      t,
      ch: 'transcript',
      make: (at) => {
        const text = JSON.stringify(json);
        const id = file.kind === 'main' ? file.sessionId : `${file.sessionId}/${file.agentId}`;
        const offset = this.offsets.get(id) ?? 0;
        this.offsets.set(id, offset + Buffer.byteLength(text) + 1);
        return {
          kind: 'line',
          line: {
            file,
            generation: 0,
            offset,
            bytes: Buffer.byteLength(text),
            type: typeof json.type === 'string' ? json.type : undefined,
            json,
            replay: false,
            afterRewrite: false,
            readAtMono: at,
            readAtWall: t,
          },
        };
      },
    });
  }
  screen(t, lines) {
    this.items.push({ t, ch: 'screen', make: (at) => capture(t, lines, at) });
  }
  build() {
    const items = [...this.items].sort((a, b) => a.t - b.t);
    const t0 = items[0]?.t ?? Date.UTC(2026, 10, 3);
    const config = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'traces', 'core-config.default.json'), 'utf8'));
    const records = [
      {
        r: 'header',
        format: 'ccd-trace',
        v: 1,
        lib: '0.0.0',
        claude: '2.1.316',
        tmux: '3.5a',
        node: 'v22.23.2',
        platform: 'darwin',
        startedWall: t0,
        tz: RECORDING_TZ,
        coreInit: {
          sessionKey: SESSION_KEY,
          config,
          claudeVersion: '2.1.316',
          initialClaudeSessionId: this.o.sessionId,
          resume: false,
          startedAt: 1000,
          wallAt: t0,
          cwdRealpath: this.o.cwd,
        },
        profile: '2.1.316',
        redaction: 'full',
        hookTransport: this.o.hookTransport,
      },
      {
        r: 'diag',
        at: 1000,
        code: 'fixture.source',
        detail: { builtBy: 'scripts/fixtures-from-verify.mjs', from: this.o.from, window: this.o.window ?? null },
      },
    ];
    items.forEach((it, i) => {
      const at = 1000 + (it.t - t0);
      records.push({ r: 'raw', i: i + 1, ch: it.ch, at, wallAt: it.t, data: it.make(at) });
    });
    return records;
  }
}

/** Scrub + lint + write one trace. */
function emit(outDir, name, records, users) {
  const s = createScrubber({ users });
  const rawText = records.map((r) => JSON.stringify(r)).join('\n');
  s.learn(rawText);
  const text = `${records.map((r) => JSON.stringify(s.value(r))).join('\n')}\n`;
  const findings = lintText(text);
  if (findings.length > 0) {
    for (const f of findings.slice(0, 20)) process.stderr.write(`${name}:${f.line}: ${f.rule}: ${JSON.stringify(f.excerpt)}\n`);
    throw new Error(`fixtures-from-verify: ${name} still has ${findings.length} lint finding(s) after scrubbing`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.ccd.jsonl`), text);
  return { name, records: records.length };
}

// ------------------------------------------------------------------------------------------------ verify corpus (session A/C/D/B)

function verifySources(dir) {
  const http = readJsonl(join(dir, 'http-hooks.jsonl')).filter((r) => r.kind === 'req' && r.body && typeof r.body === 'object');
  const cmd = readJsonl(join(dir, 'cmd-hooks.jsonl'));
  const seen = readJsonl(join(dir, 'transcript-seen.jsonl')).filter((r) => r.raw && typeof r.raw === 'object');
  const timelines = {};
  for (const f of readdirSync(dir).filter((x) => /^timeline-[A-Z]\.txt$/.test(x))) {
    const ev = {};
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const m = /^(\S+) (\d{13})/.exec(line);
      if (m) ev[m[1]] = Number(m[2]);
    }
    timelines[f.slice(9, 10)] = ev;
  }
  return { http, cmd, seen, timelines };
}

/** All hook calls of `sid` (or any session when sid is null) in [from, to): unix for SessionStart/PermissionRequest. */
function hooksIn(src, sids, from, to) {
  const out = [];
  for (const r of src.cmd) {
    const ev = r.ev;
    if (
      (ev === 'SessionStart' || ev === 'PermissionRequest') &&
      r.t >= from &&
      r.t < to &&
      (sids === null || sids.includes(r.p.session_id))
    )
      out.push({ t: r.t, event: ev, payload: r.p, transport: 'unix' });
  }
  for (const r of src.http) {
    const ev = r.body.hook_event_name;
    if (ev === 'SessionStart' || ev === 'PermissionRequest') continue;
    if (r.t >= from && r.t < to && (sids === null || sids.includes(r.body.session_id)))
      out.push({ t: r.t, event: ev, payload: r.body, transport: 'http' });
  }
  return out;
}

function linesIn(src, sids, from, to) {
  return src.seen
    .filter((r) => r.seen >= from && r.seen < to && (sids === null || sids.includes(r.sessionId ?? r.raw.sessionId ?? '')))
    .map((r) => ({ t: r.seen, sessionId: r.sessionId ?? r.raw.sessionId, json: r.raw }));
}

function windowTrace(src, o) {
  const b = new TraceBuilder(o.name, { sessionId: o.sessionId, cwd: o.cwd, hookTransport: 'http', from: o.from, window: [o.start, o.end] });
  // Preamble: the session's SessionStart and the last frame before the window, so the replay starts from a ready session.
  for (const h of hooksIn(src, o.sids, o.sessionStart, o.start).filter((x) => x.event === 'SessionStart'))
    b.hook(h.t, h.event, h.payload, h.transport);
  const frames = o.frames ?? [];
  const pre = frames.filter((f) => f.t < o.start).at(-1);
  if (pre) b.screen(pre.t, pre.lines);
  for (const h of hooksIn(src, o.sids, o.start, o.end)) b.hook(h.t, h.event, h.payload, h.transport);
  for (const l of linesIn(src, o.sids, o.start, o.end)) b.line(l.t, { kind: 'main', sessionId: l.sessionId }, l.json);
  for (const f of frames.filter((x) => x.t >= o.start && x.t < o.end)) b.screen(f.t, f.lines);
  return b.build();
}

function fromVerify(dir) {
  const src = verifySources(dir);
  const A = src.timelines.A ?? {};
  const out = [];
  const framesA = readFrames(join(dir, 'screen-A.log'));
  const sidA = '59129e0d-0328-40d1-93bb-5312bc731f39';
  const cwdA = '/private/tmp/claude-501/ccd-verify/a';
  const steps = [
    ['hook-allow', 'P1-enter', 'P2-enter(hold35s)'],
    ['hook-held-35s', 'P2-enter(hold35s)', 'P3-enter(hold70s,timeout45)'],
    ['hook-timeout-then-keys', 'P3-enter(hold70s,timeout45)', 'P4-enter(deny)'],
    ['hook-deny', 'P4-enter(deny)', 'P5-enter(200words)'],
    ['message-display-3-chunks', 'P5-enter(200words)', 'CLEAR-enter'],
  ];
  for (const [name, a, z] of steps) {
    if (A[a] === undefined || A[z] === undefined) continue;
    out.push([
      name,
      windowTrace(src, {
        name,
        sids: [sidA],
        sessionId: sidA,
        cwd: cwdA,
        sessionStart: A['launch2'] ?? 0,
        start: A[a] - 50,
        end: A[z] - 50,
        frames: framesA,
        from: 'fixtures/verify session A',
      }),
    ]);
  }
  if (A['CLEAR-enter'] !== undefined && A['EXIT-enter'] !== undefined)
    out.push([
      'clear-generation-switch',
      windowTrace(src, {
        name: 'clear-generation-switch',
        sids: null,
        sessionId: sidA,
        cwd: cwdA,
        sessionStart: A['launch2'] ?? 0,
        start: A['CLEAR-enter'] - 50,
        end: A['EXIT-enter'] - 50,
        frames: framesA,
        from: 'fixtures/verify session A (/clear)',
      }),
    ]);
  const C = src.timelines.C ?? {};
  if (C['P6-enter(server-down)'] !== undefined) {
    const sidC = '700e2d5a-5dfa-4e2e-a921-ad1ca9916dbb';
    const start = C['readiness-start(launch)'] ?? C['P6-enter(server-down)'] - 30_000;
    out.push([
      'hook-endpoint-down',
      windowTrace(src, {
        name: 'hook-endpoint-down',
        sids: [sidC],
        sessionId: sidC,
        cwd: '/private/var/folders/yj/g_x6cnk53n7dsdr1bkv34x840000gn/T/ccd-verify-c',
        sessionStart: start,
        start,
        end: (C['P6-keypress-Enter(Yes)'] ?? C['P6-enter(server-down)']) + 20_000,
        frames: readFrames(join(dir, 'screen-C.log')),
        from: 'fixtures/verify session C (P6)',
      }),
    ]);
  }
  const D = src.timelines.D ?? {};
  if (D['P7-enter'] !== undefined) {
    const sidD = 'f92ef1c4-181d-4aa0-9208-dff5730b96f2';
    const start = D['launch'] ?? D['P7-enter'] - 15_000;
    out.push([
      'pre-hook-timeout',
      windowTrace(src, {
        name: 'pre-hook-timeout',
        sids: [sidD],
        sessionId: sidD,
        cwd: '/private/var/folders/yj/g_x6cnk53n7dsdr1bkv34x840000gn/T/ccd-verify-c',
        sessionStart: start,
        start,
        end: D['P7-enter'] + 60_000,
        frames: readFrames(join(dir, 'screen-D.log')),
        from: 'fixtures/verify session D (P7)',
      }),
    ]);
  }
  // Screen-only traces.
  const screenOnly = (name, file, sid, cwd, from) => {
    const b = new TraceBuilder(name, { sessionId: sid, cwd, hookTransport: 'http', from });
    for (const f of readFrames(join(dir, file))) b.screen(f.t, f.lines);
    for (const h of hooksIn(src, [sid], 0, Number.MAX_SAFE_INTEGER).filter((x) => x.event === 'SessionStart'))
      b.hook(h.t, h.event, h.payload, h.transport);
    return b.build();
  };
  if (existsSync(join(dir, 'screen-B.log')))
    out.push([
      'trust-dialog',
      screenOnly(
        'trust-dialog',
        'screen-B.log',
        'a0ced02a-76f4-4aa8-b509-6d0ca235aceb',
        '/private/var/folders/yj/g_x6cnk53n7dsdr1bkv34x840000gn/T/ccd-verify-b',
        'fixtures/verify session B (trust dialog)',
      ),
    ]);
  if (existsSync(join(dir, 'screen-A0-launch-automode.log')))
    out.push([
      'startup-automode',
      screenOnly(
        'startup-automode',
        'screen-A0-launch-automode.log',
        '1bdfed2c-dba1-4ebd-a4d2-8da91df886b0',
        cwdA,
        'fixtures/verify launch A0 (auto mode)',
      ),
    ]);
  return out;
}

// ------------------------------------------------------------------------------------------------ probe dirs (BRIEF)

function transcriptEntries(mainPath) {
  const sid = basename(mainPath, '.jsonl');
  const out = [];
  let last = 0;
  const push = (file, path) => {
    const rows = readJsonl(path);
    const tsOf = (json) => (typeof json.timestamp === 'string' ? Date.parse(json.timestamp) : NaN);
    // Untimestamped metadata entries (mode, permission-mode, atis-latch, …) take the time of the entry before them; the
    // leading ones take the file's first timestamp (never 0: a 0 would make the trace span the whole epoch). WP-INT, ICR 0016.
    const first = rows.map(tsOf).find((t) => !Number.isNaN(t));
    if (first !== undefined && last === 0) last = first;
    for (const json of rows) {
      const ts = tsOf(json);
      if (!Number.isNaN(ts)) last = ts;
      out.push({ t: Number.isNaN(ts) ? last : ts, file, json });
    }
  };
  push({ kind: 'main', sessionId: sid }, mainPath);
  const subDir = join(dirname(mainPath), sid, 'subagents');
  if (existsSync(subDir))
    for (const f of readdirSync(subDir)
      .filter((x) => /^agent-.+\.jsonl$/.test(x))
      .sort())
      push({ kind: 'subagent', sessionId: sid, agentId: f.slice(6, -6) }, join(subDir, f));
  return { sid, entries: out.sort((a, b) => a.t - b.t) };
}

function fromHookprobe(dir, transcript) {
  const hooks = readJsonl(join(dir, 'hooks.jsonl'));
  const { sid, entries } = transcriptEntries(transcript);
  const snaps = existsSync(join(dir, 'snaps'))
    ? readdirSync(join(dir, 'snaps'))
        .filter((f) => /^\d+N\.txt$/.test(f))
        .map((f) => ({
          t: Number(f.slice(0, -5)) * 100,
          lines: readFileSync(join(dir, 'snaps', f), 'utf8')
            .replace(/\n+$/, '')
            .split('\n'),
        }))
    : [];
  const cwd = hooks.find((h) => h.ev === 'SessionStart')?.p?.cwd ?? '/private/tmp/hookprobe/ws';
  const build = (name, from, to, what) => {
    const b = new TraceBuilder(name, { sessionId: sid, cwd, hookTransport: 'unix', from: what, window: [from, to] });
    for (const h of hooks) if ((h.t >= from && h.t < to) || (h.ev === 'SessionStart' && h.t < from)) b.hook(h.t, h.ev, h.p, 'unix');
    for (const e of entries) if (e.t >= from && e.t < to) b.line(e.t, e.file, e.json);
    for (const s of snaps) if (s.t >= from && s.t < to) b.screen(s.t, s.lines);
    return b.build();
  };
  const out = [
    [
      'bg-agents-task-notification',
      build('bg-agents-task-notification', 0, Number.MAX_SAFE_INTEGER, 'hookprobe session (two async Agents, task notifications)'),
    ],
  ];
  const ups = hooks.filter((h) => h.ev === 'UserPromptSubmit');
  const windowOf = (promptPrefix) => {
    const i = ups.findIndex((h) => String(h.p.prompt_id ?? '').startsWith(promptPrefix));
    if (i < 0) return undefined;
    return [ups[i].t - 50, (ups[i + 1]?.t ?? Number.MAX_SAFE_INTEGER) - 50];
  };
  for (const [name, prefix, what] of [
    ['esc-interrupt-after-tool', '0e9eea63', 'hookprobe prompt 0e9eea63 (Esc after a tool)'],
    ['esc-at-permission', '57289e99', 'hookprobe prompt 57289e99 (Esc at the permission dialog)'],
  ]) {
    const w = windowOf(prefix);
    if (w) out.push([name, build(name, w[0], w[1], what)]);
  }
  // Ghost (internal) agent after Stop: the first SubagentStop with agent_type '' that follows a Stop.
  const stops = hooks.filter((h) => h.ev === 'Stop');
  const ghost = hooks.find((h) => h.ev === 'SubagentStop' && h.p.agent_type === '' && stops.some((s) => s.t < h.t));
  if (ghost) {
    const stop = stops.filter((s) => s.t < ghost.t).at(-1);
    const prompt = ups.filter((u) => u.t <= stop.t).at(-1);
    out.push([
      'ghost-agent-after-stop',
      build('ghost-agent-after-stop', (prompt?.t ?? stop.t) - 50, ghost.t + 5000, 'hookprobe internal agent after Stop'),
    ]);
  }
  return out;
}

function fromFaultproxy(dir, transcript) {
  const frames = existsSync(join(dir, 'screens-refuse.log')) ? readFrames(join(dir, 'screens-refuse.log')) : [];
  const t =
    transcript && existsSync(transcript) ? transcriptEntries(transcript) : { sid: '00000000-0000-4000-8000-00000000fa17', entries: [] };
  const b = new TraceBuilder('retry-storm', {
    sessionId: t.sid,
    cwd: '/private/tmp/faultproxy/ws',
    hookTransport: 'http',
    from: 'faultproxy screens-refuse.log (refuse fault, attempt n/10)',
  });
  for (const f of frames) b.screen(f.t, f.lines);
  const from = frames[0]?.t ?? 0;
  const to = frames.at(-1)?.t ?? 0;
  for (const e of t.entries) if (e.t >= from - 60_000 && e.t <= to + 60_000) b.line(e.t, e.file, e.json);
  return [['retry-storm', b.build()]];
}

// ------------------------------------------------------------------------------------------------ main

export function buildAll(o) {
  const traces = [...fromVerify(o.verify)];
  if (o.hookprobe && o.hookprobeTranscript && existsSync(o.hookprobe) && existsSync(o.hookprobeTranscript))
    traces.push(...fromHookprobe(o.hookprobe, o.hookprobeTranscript));
  if (o.faultproxy && existsSync(o.faultproxy)) traces.push(...fromFaultproxy(o.faultproxy, o.faultproxyTranscript));
  return traces;
}

function main() {
  const o = args(process.argv.slice(2));
  const users = process.env.USER ? [process.env.USER] : [];
  const written = [];
  for (const [name, records] of buildAll(o)) written.push(emit(o.out, name, records, users));
  for (const w of written) process.stdout.write(`${w.name}: ${w.records} records\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
