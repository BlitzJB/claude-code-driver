// channels/transcript/normalize.ts (WP-06; DESIGN.md §2.4, §2.8, §6.2): TailEvent → ObservationInput[] on the four live
// 2.1.316 transcripts (fixtures/verify/transcripts) plus synthetic lines modelled on the hookprobe/faultproxy/phase-0
// corpus (transcript-format.md §4). Pitfalls: P-TAIL-42, P-REC-30/35/38/39, P-TX-03/04/06, TF §9 item 18 (last-wins),
// P-REV-15/16 (refusals), LP-47 / ICR 0002 (prompt.blocked).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';
import { transcriptExtras, transcriptProfile } from '../../../src/channels/profiles/claude-2.1.316/transcript.js';
import { FileStates, fileKeyString } from '../../../src/channels/transcript/file-state.js';
import { createTranscriptNormalizer } from '../../../src/channels/transcript/normalize.js';
import type { TranscriptNormalizerWithStats } from '../../../src/channels/transcript/normalize.js';
import type { Observation, ObservationInput } from '../../../src/model/observation.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import type { FileKey, TailEvent, TailLine } from '../../../src/platform/ports.js';

const DIR = fileURLToPath(new URL('../../../fixtures/verify/transcripts/', import.meta.url));
const SID = '11111111-2222-4333-8444-555555555555';
const MAIN: FileKey = { kind: 'main', sessionId: SID };
const SUB: FileKey = { kind: 'subagent', sessionId: SID, agentId: 'a1028a887bdb3ce93' };

type Payload<K extends Observation['kind']> = Extract<Observation, { kind: K }>['p'];
function only<K extends Observation['kind']>(obs: readonly ObservationInput[], kind: K): Payload<K>[] {
  return obs.filter((o) => o.kind === kind).map((o) => o.p as Payload<K>);
}
function one<K extends Observation['kind']>(obs: readonly ObservationInput[], kind: K): Payload<K> {
  const list = only(obs, kind);
  expect(list).toHaveLength(1);
  const [first] = list;
  if (first === undefined) throw new Error(`no ${kind} observation`);
  return first;
}

let offset = 0;
type LineEv = Extract<TailEvent, { kind: 'line' }>;
function lineEvent(json: unknown, file: FileKey = MAIN, o: Partial<TailLine> = {}): LineEv {
  offset += 100;
  const type = typeof json === 'object' && json !== null && 'type' in json && typeof json.type === 'string' ? json.type : undefined;
  return {
    kind: 'line',
    line: {
      file,
      generation: 0,
      offset,
      bytes: 100,
      type,
      json,
      replay: false,
      afterRewrite: false,
      readAtMono: (5000 + offset) as MonoMs,
      readAtWall: (1_793_000_000_000 + offset) as WallMs,
      ...o,
    },
  };
}

function fresh(): TranscriptNormalizerWithStats {
  return createTranscriptNormalizer(profile);
}
function feed(n: TranscriptNormalizerWithStats, entries: unknown[], file: FileKey = MAIN): ObservationInput[] {
  return entries.flatMap((e) => n.push(lineEvent(e, file)));
}

const env = (o: Record<string, unknown>): Record<string, unknown> => ({
  parentUuid: 'p-0',
  isSidechain: false,
  timestamp: '2026-11-02T20:06:18.510Z',
  sessionId: SID,
  version: '2.1.316',
  cwd: '/TMP/ws',
  userType: 'external',
  ...o,
});
let u = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`;
const userText = (text: string, o: Record<string, unknown> = {}): Record<string, unknown> =>
  env({ type: 'user', uuid: uuid(), message: { role: 'user', content: text }, ...o });
const assistant = (block: Record<string, unknown>, o: Record<string, unknown> = {}): Record<string, unknown> =>
  env({
    type: 'assistant',
    uuid: uuid(),
    requestId: 'req_1',
    requestRef: 'rr-1',
    apiBlockIndex: 0,
    message: {
      model: 'claude-opus-5-5',
      id: 'msg_A',
      type: 'message',
      role: 'assistant',
      content: [block],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 94, cache_creation_input_tokens: 30202, cache_read_input_tokens: 28472 },
    },
    ...o,
  });

// ---------------------------------------------------------------------------------------------------------------------

describe('live 2.1.316 transcripts (fixtures/verify/transcripts)', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.jsonl'));
  const all = files.map((f) => {
    const sessionId = f.replace(/\.jsonl$/, '');
    const n = fresh();
    const file: FileKey = { kind: 'main', sessionId };
    const obs = readFileSync(DIR + f, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .flatMap((l) => {
        // Mimic the tail's skip-parse (P-TAIL-14): those lines arrive with json undefined.
        const skip = transcriptProfile.skipParsePrefixes.some((p) => l.startsWith(p));
        const json: unknown = skip ? undefined : JSON.parse(l);
        const type = skip ? /^\{"type":"([^"]+)"/.exec(l)?.[1] : (json as { type?: string }).type;
        return n.push(lineEvent(json, file, { type }));
      });
    return { sessionId, obs, stats: n.stats() };
  });
  const obs = all.flatMap((a) => a.obs);

  it('has the four transcripts', () => {
    expect(files).toHaveLength(4);
  });

  it('produces no unknown observation and no dropped fact', () => {
    expect(only(obs, 'unknown')).toEqual([]);
    for (const a of all) expect(a.stats.dropped).toBe(0);
  });

  it('maps every chain fact family that occurs in the corpus', () => {
    const kinds = new Set(obs.map((o) => o.kind));
    for (const k of [
      'prompt.recorded',
      'message.block',
      'tool.result',
      'permission.decisionRecorded',
      'hookchannel.error',
      'turn.durationRecorded',
      'model.requestStarted',
      'mode.observed',
    ] as const) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it('every chain observation carries a unique meta.uuid; api-request uses txreq:<id> (D-42)', () => {
    const uuids = obs.filter((o) => o.meta.uuid !== undefined).flatMap((o) => (o.meta.uuid === undefined ? [] : [o.meta.uuid]));
    expect(new Set(uuids).size).toBe(uuids.length);
    for (const r of obs.filter((o) => o.kind === 'model.requestStarted')) expect(r.meta.uuid).toMatch(/^txreq:[0-9a-f-]{36}$/);
    for (const o of obs.filter((x) => x.kind === 'message.block' || x.kind === 'prompt.recorded')) expect(o.meta.uuid).toBeDefined();
  });

  it('meta: transcript source, file session, origin with offset and sidechain:false', () => {
    for (const a of all) {
      for (const o of a.obs) {
        expect(o.meta.source).toBe('transcript');
        expect(o.meta.claudeSessionId).toBe(a.sessionId);
        expect(o.meta.origin).toMatchObject({ kind: 'transcript', fileKey: `main:${a.sessionId}`, sidechain: false });
      }
    }
  });

  it('permissionDecision sources: hook → hook, user_temporary → user_keys (LV §Q2)', () => {
    const deciders = only(obs, 'permission.decisionRecorded').map((d) => `${d.via}:${d.decider}:${d.decision}`);
    expect(deciders).toContain('tool_result:hook:accept');
    expect(deciders).toContain('tool_result:hook:reject');
    expect(deciders).toContain('tool_result:user_keys:accept');
    expect(deciders).toContain('attachment:hook:accept');
    expect(deciders).toContain('attachment:hook:reject');
  });

  it('hook_* attachments: toolu_ ids kept, plain uuids for UPS/Stop dropped (P-REC-38)', () => {
    const errs = only(obs, 'hookchannel.error');
    const ups = errs.find((e) => e.hookEvent === 'UserPromptSubmit');
    const stop = errs.find((e) => e.hookEvent === 'Stop');
    const pre = errs.find((e) => e.hookEvent === 'PreToolUse' && e.kind === 'non_blocking_error');
    expect(ups).toBeDefined();
    expect(ups && 'toolUseId' in ups).toBe(false);
    expect(stop && 'toolUseId' in stop).toBe(false);
    expect(pre?.toolUseId).toMatch(/^toolu_/);
    expect(pre?.detail).toContain('ECONNREFUSED');
    const cancelled = errs.find((e) => e.kind === 'cancelled');
    expect(cancelled).toMatchObject({ hookEvent: 'PreToolUse', detail: 'timedOut 5000ms' });
    expect(cancelled?.toolUseId).toMatch(/^toolu_/);
  });

  it('system:local_command /clear → prompt.recorded{localCommand:/clear}; caveat user entry is meta (P-REC-39)', () => {
    const recs = only(obs, 'prompt.recorded');
    const clear = recs.filter((r) => r.localCommand?.name === '/clear');
    expect(clear.map((c) => c.localCommand)).toContainEqual({ name: '/clear', args: '', stdout: '' });
    const caveat = recs.find((r) => r.text?.startsWith('<local-command-caveat>') === true);
    expect(caveat?.isMeta).toBe(true);
  });

  it('assistant blocks: one per entry, usage and stop_reason on each, tool_use carries id/name/input', () => {
    const blocks = only(obs, 'message.block');
    expect(blocks.length).toBe(16);
    const tool = blocks.find((b) => b.block === 'tool_use');
    expect(tool?.toolUseId).toMatch(/^toolu_/);
    expect(tool?.toolName).toBe('Bash');
    expect(tool?.input).toBeDefined();
    expect(blocks.every((b) => b.usage !== undefined && !b.synthetic && b.apiMessageId.startsWith('msg_'))).toBe(true);
  });

  it('metadata flush folded last-wins: one mode.observed per file (TF §9 item 18)', () => {
    for (const a of all) expect(only(a.obs, 'mode.observed').length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('user entries', () => {
  it('safety-classifier text without refusedMessageId is meta, never a user prompt (TF §4.2 #8)', () => {
    const out = feed(fresh(), [userText(`${transcriptProfile.markers.safetyClassifierStop} — this is not a tool or API error.`)]);
    expect(only(out, 'model.refused')).toHaveLength(0);
    expect(one(out, 'prompt.recorded').isMeta).toBe(true);
  });

  it('typed prompt → prompt.recorded with promptId, origin, promptSource', () => {
    const n = fresh();
    const e = userText('Do these steps', {
      promptId: 'cbb1902c',
      origin: { kind: 'human' },
      promptSource: 'typed',
      turnOrigin: 'human',
      parentUuid: null,
    });
    const p = one(feed(n, [e]), 'prompt.recorded');
    expect(p).toEqual({
      promptId: 'cbb1902c',
      uuid: e['uuid'],
      parentUuid: null,
      text: 'Do these steps',
      origin: 'human',
      promptSource: 'typed',
      isMeta: false,
    });
  });

  it('task-notification user entry keeps isMeta:false and origin task-notification', () => {
    const n = fresh();
    const text = '<task-notification>\n<task-id>a573b9447668a3ed7</task-id>\n<status>completed</status>\n</task-notification>';
    const p = one(
      feed(n, [userText(text, { promptId: 'ab6278e5', origin: { kind: 'task-notification' }, promptSource: 'system' })]),
      'prompt.recorded',
    );
    expect(p.isMeta).toBe(false);
    expect(p.origin).toBe('task-notification');
  });

  it('not-real-user texts become isMeta (P-TX-06): ZHe, isVisibleInTranscriptOnly, isCompactSummary, isMeta', () => {
    const n = fresh();
    const out = feed(n, [
      userText('<system-reminder>x</system-reminder>'),
      userText('This session is being continued…', { isVisibleInTranscriptOnly: true, isCompactSummary: true }),
      userText('hidden', { isMeta: true, turnCompanion: true }),
      userText('<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>'),
    ]);
    expect(only(out, 'prompt.recorded').map((p) => p.isMeta)).toEqual([true, true, true, true]);
  });

  it('a typed prompt that starts with an HTML/XML tag stays a real prompt (ICR 0025): only Claude-generated tags are meta', () => {
    const n = fresh();
    const out = feed(n, [
      userText('<b>bold</b> is not rendering, fix it'),
      userText('<div> wrapper breaks layout'),
      userText('\n\n<pasted_content id="d7a9">\nlog\n</pasted_content>\nwhy?', { origin: { kind: 'human' }, promptSource: 'typed' }),
      userText('<local-command-caveat>Caveat: …</local-command-caveat>'),
      userText('  <system-reminder>\nx\n</system-reminder>'),
      userText('<tool_use_error>boom</tool_use_error>'),
      userText('<b>styled</b>', { isMeta: true }), // the entry's own flag still wins
    ]);
    expect(only(out, 'prompt.recorded').map((p) => p.isMeta)).toEqual([false, false, false, true, true, true, true]);
  });

  it('interrupt markers → turn.interrupted (request with interruptedMessageId / tool_use), not prompt.recorded', () => {
    const n = fresh();
    const out = feed(n, [
      userText('go', { promptId: 'p-int' }),
      userText('x', {
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        interruptedMessageId: 'msg_011CgehvhjaCBLpJkpys7nJH',
      }),
      userText('[Request interrupted by user for tool use]'),
    ]);
    expect(only(out, 'turn.interrupted')).toEqual([
      { marker: 'request', interruptedMessageId: 'msg_011CgehvhjaCBLpJkpys7nJH', promptId: 'p-int' },
      { marker: 'tool_use', promptId: 'p-int' },
    ]);
    expect(only(out, 'prompt.recorded')).toHaveLength(1);
  });

  it('bash mode input → prompt.recorded{bashInput:true} (IN §4.2)', () => {
    const p = one(feed(fresh(), [userText('<bash-input>ls -la</bash-input>', { promptId: 'pb' })]), 'prompt.recorded');
    expect(p).toMatchObject({ bashInput: true, text: 'ls -la', isMeta: false });
  });

  it('<command-name> user entry and the following stdout entry (LP-33 corpus shape)', () => {
    const n = fresh();
    const out = feed(n, [
      userText(
        '<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>',
        { promptId: 'pe' },
      ),
      userText('<local-command-stdout>Settings dialog dismissed</local-command-stdout>', { promptId: 'pe' }),
    ]);
    const [cmd, stdout] = only(out, 'prompt.recorded');
    expect(cmd?.localCommand).toEqual({ name: '/exit', args: '' });
    expect(cmd?.isMeta).toBe(false);
    expect(stdout?.localCommand).toEqual({ name: '/exit', stdout: 'Settings dialog dismissed' });
    expect(stdout?.isMeta).toBe(true);
  });

  it('safety-classifier stop → model.refused, never prompt.recorded (TF §4.2 #8, P-REV-15)', () => {
    const e = userText('Your response above was stopped by a safety classifier — this is not a tool or API error.', {
      isMeta: true,
      turnCompanion: true,
      refusedMessageId: 'msg_REF',
    });
    const out = feed(fresh(), [e]);
    expect(out.map((o) => o.kind)).toEqual(['model.refused']);
    expect(one(out, 'model.refused')).toEqual({
      refusedMessageId: 'msg_REF',
      text: e['message'] && (e['message'] as { content: string }).content,
      uuid: e['uuid'],
    });
  });
});

describe('tool results (P-REC-30: paired by tool_use_id)', () => {
  it('tool_result + permissionDecision → tool.result and permission.decisionRecorded with distinct uuids', () => {
    const e = env({
      type: 'user',
      uuid: 'tr-1',
      promptId: 'p1',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_0141', type: 'tool_result', content: 'bashdone', is_error: false }] },
      toolUseResult: { stdout: 'bashdone', stderr: '', interrupted: false },
      permissionDecision: { decision: 'accept', source: 'config', reasonType: 'subcommandResults' },
    });
    const out = feed(fresh(), [e]);
    expect(out.map((o) => o.kind)).toEqual(['tool.result', 'permission.decisionRecorded']);
    expect(out.map((o) => o.meta.uuid)).toEqual(['tr-1', 'tr-1#1']);
    expect(one(out, 'tool.result')).toEqual({ toolUseId: 'toolu_0141', isError: false, uuid: 'tr-1', contentPreview: 'bashdone' });
    expect(one(out, 'permission.decisionRecorded')).toEqual({
      toolUseId: 'toolu_0141',
      decision: 'accept',
      decider: 'config',
      via: 'tool_result',
    });
  });

  it.each([
    [{ decision: 'accept', source: 'config', reasonType: 'classifier' }, 'classifier'],
    [{ decision: 'accept', source: 'config', reasonType: 'mode' }, 'config'],
    [{ decision: 'reject', source: 'user_reject', reasonCode: 'unknown' }, 'user_keys'],
    [{ decision: 'accept', source: 'user_temporary', grantScope: 'once' }, 'user_keys'],
    [{ decision: 'accept', source: 'hook', reasonType: 'hook' }, 'hook'],
    [{ decision: 'accept', source: 'martian' }, 'unknown'],
  ] as const)('permissionDecision %j → decider %s', (pd, decider) => {
    const e = env({
      type: 'user',
      uuid: uuid(),
      message: { content: [{ tool_use_id: 'toolu_X', type: 'tool_result', content: 'ok' }] },
      permissionDecision: pd,
    });
    expect(one(feed(fresh(), [e]), 'permission.decisionRecorded').decider).toBe(decider);
  });

  it('user-rejected at a permission prompt: denialKind, then the tool_use interrupt marker (TF §8.5)', () => {
    const out = feed(fresh(), [
      env({
        type: 'user',
        uuid: uuid(),
        promptId: 'p9',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_R',
              is_error: true,
              content: "The user doesn't want to proceed with this tool use. …",
            },
          ],
        },
        toolUseResult: 'User rejected tool use',
        toolDenialKind: 'user-rejected',
      }),
      userText('[Request interrupted by user for tool use]'),
    ]);
    expect(one(out, 'tool.result')).toMatchObject({ toolUseId: 'toolu_R', isError: true, denialKind: 'user-rejected' });
    expect(one(out, 'turn.interrupted')).toEqual({ marker: 'tool_use', promptId: 'p9' });
  });

  it('interrupted tool and async Agent launch', () => {
    const out = feed(fresh(), [
      env({
        type: 'user',
        uuid: uuid(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_I', content: 'x' }] },
        toolDenialKind: 'interrupted',
      }),
      env({
        type: 'user',
        uuid: uuid(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'y' }] },
        toolUseResult: { stdout: '', interrupted: true },
      }),
      env({
        type: 'user',
        uuid: uuid(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: 'Async agent launched' }] }] },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1028a887bdb3ce93' },
      }),
    ]);
    const [i, b, a] = only(out, 'tool.result');
    expect(i).toMatchObject({ interrupted: true, denialKind: 'interrupted' });
    expect(b).toMatchObject({ interrupted: true });
    expect(a).toMatchObject({ asyncAgentId: 'a1028a887bdb3ce93', contentPreview: 'Async agent launched' });
  });

  it('validation rejection (<tool_use_error>) → tool.result + tool.validationError (P-REC-26)', () => {
    const out = feed(fresh(), [
      env({
        type: 'user',
        uuid: 'v-1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_V',
              is_error: true,
              content: '<tool_use_error>InputValidationError: x</tool_use_error>',
            },
          ],
        },
      }),
    ]);
    expect(out.map((o) => o.kind)).toEqual(['tool.result', 'tool.validationError']);
    expect(out[1]?.meta.uuid).toBe('v-1#1');
  });

  it('parallel results in one entry: each paired by its own id; entry-level fields not guessed', () => {
    const out = feed(fresh(), [
      env({
        type: 'user',
        uuid: 'par',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'b', is_error: true },
          ],
        },
        toolDenialKind: 'interrupted',
      }),
    ]);
    expect(only(out, 'tool.result')).toEqual([
      { toolUseId: 'toolu_1', isError: false, uuid: 'par', contentPreview: 'a' },
      { toolUseId: 'toolu_2', isError: true, uuid: 'par', contentPreview: 'b' },
    ]);
  });

  it('parallel results: an entry-level permissionDecision is never guessed onto one of them (dropped, counted)', () => {
    const n = fresh();
    const out = feed(n, [
      env({
        type: 'user',
        uuid: 'par-pd',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_p1', content: 'a' },
            { type: 'tool_result', tool_use_id: 'toolu_p2', content: 'b' },
          ],
        },
        permissionDecision: { decision: 'accept', source: 'config' },
      }),
    ]);
    expect(out.map((o) => o.kind)).toEqual(['tool.result', 'tool.result']);
    expect(only(out, 'permission.decisionRecorded')).toHaveLength(0);
    expect(n.stats().dropped).toBe(1);
  });

  it('user rejection recognised from the profile text when toolDenialKind is absent (only on an error result)', () => {
    const rejectText = `${transcriptProfile.markers.userRejectedToolResultPrefix} The tool use was rejected …`;
    const out = feed(fresh(), [
      env({
        type: 'user',
        uuid: uuid(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_RJ', is_error: true, content: rejectText }] },
      }),
      env({
        type: 'user',
        uuid: uuid(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_OK', is_error: false, content: rejectText }] },
      }),
      env({
        type: 'user',
        uuid: uuid(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_PR', is_error: true, content: rejectText }] },
        toolDenialKind: 'permission-rule',
      }),
    ]);
    const [rj, ok, pr] = only(out, 'tool.result');
    expect(rj).toMatchObject({ toolUseId: 'toolu_RJ', denialKind: 'user-rejected' });
    expect(ok?.denialKind).toBeUndefined();
    expect(pr?.denialKind).toBe('permission-rule'); // the explicit field wins
  });

  it('contentPreview is bounded', () => {
    const big = 'z'.repeat(10_000);
    const p = one(
      feed(fresh(), [
        env({ type: 'user', uuid: uuid(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_Z', content: big }] } }),
      ]),
      'tool.result',
    );
    expect(p.contentPreview?.length).toBe(transcriptExtras.previewChars + 1);
  });
});

describe('assistant entries', () => {
  it('text block → message.block with usage, requestRef, blockIndex', () => {
    const e = assistant({ type: 'text', text: 'PONG' }, { apiBlockIndex: 1 });
    const p = one(feed(fresh(), [e]), 'message.block');
    expect(p).toEqual({
      apiMessageId: 'msg_A',
      requestId: 'req_1',
      requestRef: 'rr-1',
      blockIndex: 1,
      block: 'text',
      text: 'PONG',
      stopReason: 'end_turn',
      synthetic: false,
      abortedMidStream: false,
      uuid: e['uuid'],
      parentUuid: 'p-0',
      usage: { inputTokens: 2, outputTokens: 94, cacheCreationInputTokens: 30202, cacheReadInputTokens: 28472 },
    });
  });

  it('thinking (empty text, display:updates) and redacted_thinking map to thinking', () => {
    const out = feed(fresh(), [
      assistant({ type: 'thinking', thinking: '', signature: 's' }),
      assistant({ type: 'redacted_thinking', data: 'x' }),
    ]);
    expect(only(out, 'message.block').map((b) => [b.block, b.text])).toEqual([
      ['thinking', ''],
      ['thinking', undefined],
    ]);
  });

  it('isAbortedMidStream: partial block + turn.interrupted{aborted_mid_stream} stamped with the file promptId', () => {
    const n = fresh();
    const out = feed(n, [
      userText('write a poem', { promptId: 'p-abort' }),
      assistant(
        { type: 'text', text: 'Roses are' },
        {
          isAbortedMidStream: true,
          message: { model: 'claude-opus-5-5', id: 'msg_P', content: [{ type: 'text', text: 'Roses are' }], stop_reason: null },
        },
      ),
    ]);
    const b = one(out, 'message.block');
    expect(b).toMatchObject({ abortedMidStream: true, stopReason: null, apiMessageId: 'msg_P' });
    expect(one(out, 'turn.interrupted')).toEqual({ marker: 'aborted_mid_stream', interruptedMessageId: 'msg_P', promptId: 'p-abort' });
  });

  it('per-file promptId stamping: a subagent file does not leak into the main file', () => {
    const n = fresh();
    n.push(lineEvent(userText('main prompt', { promptId: 'MAIN-P' }), MAIN));
    n.push(lineEvent(userText('sub prompt', { promptId: 'SUB-P', isSidechain: true, agentId: 'a1028a887bdb3ce93' }), SUB));
    const abort = (id: string, isSidechain: boolean): Record<string, unknown> =>
      assistant(
        { type: 'text', text: 'x' },
        { isSidechain, isAbortedMidStream: true, message: { id, content: [{ type: 'text', text: 'x' }] } },
      );
    const main = n.push(lineEvent(abort('msg_M', false), MAIN));
    const sub = n.push(lineEvent(abort('msg_S', true), SUB));
    expect(one(main, 'turn.interrupted').promptId).toBe('MAIN-P');
    expect(one(sub, 'turn.interrupted').promptId).toBe('SUB-P');
    expect(sub[0]?.meta.agentId).toBe('a1028a887bdb3ce93');
    expect(sub[0]?.meta.origin).toMatchObject({ fileKey: `agent:${SID}:a1028a887bdb3ce93`, sidechain: true });
  });

  it('synthetic "No response requested." → message.block{synthetic:true} (P-TX-02)', () => {
    const e = assistant(
      { type: 'text', text: 'No response requested.' },
      {
        message: {
          model: '<synthetic>',
          id: '7f0c…uuid',
          content: [{ type: 'text', text: 'No response requested.' }],
          stop_reason: 'stop_sequence',
        },
      },
    );
    expect(one(feed(fresh(), [e]), 'message.block')).toMatchObject({ synthetic: true, text: 'No response requested.' });
  });

  it('API-error stand-in → model.apiErrorRecorded only, resetsAt seconds → wall ms', () => {
    const e = assistant(
      { type: 'text', text: "You've hit your limit · resets 3pm" },
      {
        isApiErrorMessage: true,
        error: 'rate_limit',
        apiError: 'rate_limit_error',
        apiErrorParams: { rate_limit_info: { resetsAt: 1_793_660_000, rateLimitType: 'five_hour' } },
        message: { model: '<synthetic>', id: 'u-1', content: [{ type: 'text', text: "You've hit your limit · resets 3pm" }] },
      },
    );
    const out = feed(fresh(), [e]);
    expect(out.map((o) => o.kind)).toEqual(['model.apiErrorRecorded']);
    expect(one(out, 'model.apiErrorRecorded')).toEqual({
      error: 'rate_limit',
      apiError: 'rate_limit_error',
      text: "You've hit your limit · resets 3pm",
      resetsAtWall: 1_793_660_000_000,
      rateLimitType: 'five_hour',
    });
  });

  it('server-side block types → unknown passthrough', () => {
    const out = feed(fresh(), [assistant({ type: 'server_tool_use', id: 'srvtoolu_1' })]);
    expect(one(out, 'unknown')).toMatchObject({ channel: 'transcript', raw: { type: 'assistant', blockType: 'server_tool_use' } });
  });
});

describe('system entries', () => {
  it('turn_duration → turn.durationRecorded (pendingBackgroundAgentCount absent → 0)', () => {
    const out = feed(fresh(), [
      env({ type: 'system', subtype: 'turn_duration', uuid: uuid(), durationMs: 4321, messageCount: 7 }),
      env({ type: 'system', subtype: 'turn_duration', uuid: uuid(), durationMs: 10, pendingBackgroundAgentCount: 2 }),
    ]);
    expect(only(out, 'turn.durationRecorded')).toEqual([
      { durationMs: 4321, pendingBackgroundAgentCount: 0 },
      { durationMs: 10, pendingBackgroundAgentCount: 2 },
    ]);
  });

  it('turn_duration carries the prompt chain it was written in (promptId), so the core binds it to its own turn (ICR 0021)', () => {
    const out = feed(fresh(), [
      userText('hello', { promptId: 'prm-A' }),
      env({ type: 'system', subtype: 'turn_duration', uuid: uuid(), durationMs: 7 }),
    ]);
    expect(only(out, 'turn.durationRecorded')).toEqual([{ durationMs: 7, pendingBackgroundAgentCount: 0, promptId: 'prm-A' }]);
  });

  it('LP-47 blocked UPS → prompt.blocked{reason,text} (ICR 0002); promptKept ignored', () => {
    const e = {
      parentUuid: '947e1224-4245-4faf-b97d-caa40627f9e4',
      isSidechain: false,
      type: 'system',
      subtype: 'informational',
      content: 'UserPromptSubmit operation blocked by hook:\nccd-probe http block\n\nOriginal prompt: lp02 settle 0 31007',
      isMeta: false,
      timestamp: '2026-11-03T00:40:29.308Z',
      uuid: 'a64e8a27-2a15-4050-af0b-e6624c0726f8',
      level: 'warning',
      preventContinuation: true,
      promptSubmitEnding: { ending: { kind: 'blocked_by_hook', reason: 'ccd-probe http block' }, promptKept: false },
      sessionId: 'c97063ea-3757-48f9-9fb6-1f542b8a1ada',
      version: '2.1.316',
    };
    const out = feed(fresh(), [e]);
    expect(out.map((o) => o.kind)).toEqual(['prompt.blocked']);
    expect(one(out, 'prompt.blocked')).toEqual({ reason: 'ccd-probe http block', text: 'lp02 settle 0 31007' });
    expect(out[0]?.meta.uuid).toBe('a64e8a27-2a15-4050-af0b-e6624c0726f8');
  });

  it('prompt.blocked: multi-line prompt text; reason parsed from content when ending.reason is absent', () => {
    const content = 'UserPromptSubmit operation blocked by hook:\nccd self-test\n\nOriginal prompt: ccd-selftest-NONCE\nline 2';
    const p = one(
      feed(fresh(), [
        env({
          type: 'system',
          subtype: 'informational',
          uuid: uuid(),
          content,
          promptSubmitEnding: { ending: { kind: 'blocked_by_hook' } },
        }),
      ]),
      'prompt.blocked',
    );
    expect(p).toEqual({ reason: 'ccd self-test', text: 'ccd-selftest-NONCE\nline 2' });
  });

  it('other informational notices are ignored; stop_hook_summary ignored', () => {
    const n = fresh();
    const out = feed(n, [
      env({ type: 'system', subtype: 'informational', uuid: uuid(), content: 'Unknown command: /dream', level: 'notice' }),
      env({ type: 'system', subtype: 'stop_hook_summary', uuid: uuid(), hookCount: 1, toolUseID: 'uuid-not-tool' }),
    ]);
    expect(out).toEqual([]);
    expect(n.stats().ignored).toBe(2);
  });

  it('local_command with <command-name> content (/cost recorded as /usage, LP-33)', () => {
    const e = env({
      type: 'system',
      subtype: 'local_command',
      uuid: uuid(),
      content:
        '<command-name>/usage</command-name>\n            <command-message>usage</command-message>\n            <command-args></command-args>',
      level: 'info',
      isMeta: false,
    });
    const p = one(feed(fresh(), [e]), 'prompt.recorded');
    expect(p.localCommand).toEqual({ name: '/usage', args: '' });
    expect(p.isMeta).toBe(false);
  });

  it('model_refusal_fallback → model.refusalFallback (TF §4.4, P-REV-16)', () => {
    const p = one(
      feed(fresh(), [
        env({
          type: 'system',
          subtype: 'model_refusal_fallback',
          uuid: uuid(),
          trigger: 'refusal',
          direction: 'retry',
          scope: 'turn',
          originalModel: 'claude-opus-5-5',
          fallbackModel: 'claude-sonnet-5',
          requestId: 'req_9',
          apiRefusalCategory: 'cyber',
          retractedMessageUuids: ['m-1', 'm-2', 7],
          refusedUserMessageUuid: 'u-9',
        }),
      ]),
      'model.refusalFallback',
    );
    expect(p).toEqual({
      retractedMessageUuids: ['m-1', 'm-2'],
      refusedUserMessageUuid: 'u-9',
      originalModel: 'claude-opus-5-5',
      fallbackModel: 'claude-sonnet-5',
      requestId: 'req_9',
      trigger: 'refusal',
      scope: 'turn',
      category: 'cyber',
    });
  });

  it('compact_boundary → compact.phase finished with the trigger', () => {
    const p = one(
      feed(fresh(), [
        env({
          type: 'system',
          subtype: 'compact_boundary',
          parentUuid: null,
          uuid: uuid(),
          compactMetadata: { trigger: 'auto', preTokens: 1 },
        }),
      ]),
      'compact.phase',
    );
    expect(p).toEqual({ phase: 'finished', trigger: 'auto' });
  });

  it('unknown subtype → unknown passthrough (TF §4.4)', () => {
    expect(one(feed(fresh(), [env({ type: 'system', subtype: 'rewind_stand_in', uuid: uuid() })]), 'unknown').raw).toMatchObject({
      subtype: 'rewind_stand_in',
    });
  });
});

describe('attachments', () => {
  it('queued_command → prompt.absorbed; task_status → bgtask.status', () => {
    const out = feed(fresh(), [
      env({
        type: 'attachment',
        uuid: uuid(),
        attachment: { type: 'queued_command', prompt: 'also do X', delivery_id: 'd-1', commandMode: 'prompt' },
      }),
      env({
        type: 'attachment',
        uuid: uuid(),
        attachment: {
          type: 'task_status',
          taskId: 'b1',
          taskType: 'local_bash',
          status: 'running',
          shell: { command: 'sleep', toolUseId: 'toolu_S' },
        },
      }),
    ]);
    expect(one(out, 'prompt.absorbed')).toEqual({ text: 'also do X', deliveryId: 'd-1' });
    expect(one(out, 'bgtask.status')).toEqual({ taskId: 'b1', taskType: 'local_bash', status: 'running', toolUseId: 'toolu_S' });
  });

  it('hook_permission_decision with a non-tool id is dropped and counted', () => {
    const n = fresh();
    expect(
      feed(n, [
        env({
          type: 'attachment',
          uuid: uuid(),
          attachment: { type: 'hook_permission_decision', decision: 'allow', toolUseID: 'not-a-tool' },
        }),
      ]),
    ).toEqual([]);
    expect(n.stats().dropped).toBe(1);
  });

  it('noise attachments are never conversation', () => {
    const n = fresh();
    expect(feed(n, [env({ type: 'attachment', uuid: uuid(), attachment: { type: 'prompt_snapshot', systemPrompt: [] } })])).toEqual([]);
    expect(n.stats().ignored).toBe(1);
  });
});

describe('metadata / side records', () => {
  it('api-request: first attempt, retries with same digest + tail:[] (TF §4.6), then a new request', () => {
    const req = (id: string, digest: string, tail: string[]): Record<string, unknown> => ({
      type: 'api-request',
      sessionId: SID,
      id,
      timestamp: '2026-11-02T20:06:41.582Z',
      querySource: 'repl_main_thread',
      requestDigest: digest,
      keep: tail.length === 0 ? 2 : 0,
      tail,
    });
    const out = feed(fresh(), [
      req('r1', 'D1', ['h1', 'h2']),
      req('r2', 'D1', []),
      req('r3', 'D1', []),
      req('r4', 'D2', ['h3']),
      req('r5', 'D3', []),
    ]);
    const rs = only(out, 'model.requestStarted');
    expect(rs.map((r) => [r.requestRef, r.isRetry])).toEqual([
      ['r1', false],
      ['r2', true],
      ['r3', true],
      ['r4', false],
      ['r5', false],
    ]);
    expect(rs[0]).toMatchObject({ querySource: 'repl_main_thread', requestDigest: 'D1', txWall: Date.parse('2026-11-02T20:06:41.582Z') });
    expect(out.map((o) => o.meta.uuid)).toEqual(['txreq:r1', 'txreq:r2', 'txreq:r3', 'txreq:r4', 'txreq:r5']);
  });

  it('api-request in a subagent file carries agentId', () => {
    const n = fresh();
    const out = n.push(
      lineEvent(
        {
          type: 'api-request',
          sessionId: SID,
          agentId: 'a1028a887bdb3ce93',
          id: 'r9',
          querySource: 'agent:builtin:general-purpose',
          tail: ['x'],
        },
        SUB,
      ),
    );
    expect(out[0]?.meta.agentId).toBe('a1028a887bdb3ce93');
  });

  it('queue-operation: all four ops, never folded', () => {
    const q = (o: Record<string, unknown>): Record<string, unknown> => ({ type: 'queue-operation', sessionId: SID, timestamp: 't', ...o });
    const out = feed(fresh(), [
      q({ operation: 'enqueue', content: '<task-notification>…' }),
      q({ operation: 'dequeue' }),
      q({ operation: 'dequeue' }),
      q({ operation: 'remove', reason: 'absorbed_mid_turn', commandUuid: 'c', deliveryId: 'd', content: 'x' }),
      q({ operation: 'popAll', content: 'y' }),
    ]);
    expect(only(out, 'queue.op')).toEqual([
      { op: 'enqueue', content: '<task-notification>…' },
      { op: 'dequeue' },
      { op: 'dequeue' },
      { op: 'remove', content: 'x', reason: 'absorbed_mid_turn' },
      { op: 'popAll', content: 'y' },
    ]);
  });

  it('permission-mode folded last-wins: repeats suppressed, a change emitted (authority hook > transcript)', () => {
    const pm = (m: string): Record<string, unknown> => ({ type: 'permission-mode', permissionMode: m, sessionId: SID });
    const out = feed(fresh(), [pm('default'), pm('default'), pm('acceptEdits'), pm('acceptEdits'), pm('default')]);
    expect(only(out, 'mode.observed').map((m) => m.permissionMode)).toEqual(['default', 'acceptEdits', 'default']);
  });

  it('last-prompt withdrawal (zero leaf or null + explicit) → one prompt.withdrawn per transition (P-TX-04)', () => {
    const lp = (leafUuid: string | null, explicit?: boolean): Record<string, unknown> => ({
      type: 'last-prompt',
      leafUuid,
      sessionId: SID,
      ...(explicit === undefined ? {} : { explicit }),
    });
    const out = feed(fresh(), [
      lp('b7e33602-ac93-434f-bd10-9311b3c5b443'),
      lp('00000000-0000-0000-0000-000000000000', true),
      lp('00000000-0000-0000-0000-000000000000', true),
      lp('f0f0d5b9-15cf-4678-a54c-1b932142f1fc'),
      lp(null, true),
      lp('00000000-0000-0000-0000-000000000000'),
    ]);
    expect(only(out, 'prompt.withdrawn')).toHaveLength(2);
  });

  it('continued-in and relocated (with the tail-reported path)', () => {
    const n = fresh();
    n.push({
      kind: 'moved',
      file: MAIN,
      from: '/HOME/.claude/projects/-a/x.jsonl',
      to: '/HOME/.claude/projects/-b/x.jsonl',
      sameInode: true,
    });
    const out = feed(n, [
      { type: 'continued-in', sessionId: SID, continuedInSessionId: 'new-sid' },
      { type: 'continued-in', sessionId: SID, continuedInSessionId: 'new-sid' },
      { type: 'relocated', sessionId: SID, relocatedCwd: '/repo/b' },
      { type: 'relocated', sessionId: SID, relocatedCwd: '/repo/b' },
    ]);
    expect(only(out, 'transcript.continuedIn')).toEqual([{ continuedInSessionId: 'new-sid' }]);
    expect(only(out, 'transcript.relocated')).toEqual([{ sessionId: SID, newPath: '/HOME/.claude/projects/-b/x.jsonl' }]);
  });

  it('relocated without relocatedCwd emits nothing and is counted as dropped', () => {
    const n = fresh();
    const first = feed(n, [{ type: 'relocated', sessionId: SID, relocatedCwd: '/repo/a' }]);
    expect(one(first, 'transcript.relocated')).toEqual({ sessionId: SID, newPath: '/repo/a' });
    const out = feed(n, [{ type: 'relocated', sessionId: SID }]);
    expect(out).toEqual([]);
    expect(n.stats().dropped).toBe(1);
  });

  it('known bookkeeping types are ignored; unknown types pass through (P-TAIL-42)', () => {
    const n = fresh();
    const out = feed(n, [
      { type: 'ai-title', aiTitle: 'x', sessionId: SID },
      { type: 'cost-state', totalCostUSD: 1 },
      { type: 'tools-used', tools: ['Bash'] },
      { type: 'brand-new-type', x: 1 },
    ]);
    expect(out.map((o) => o.kind)).toEqual(['unknown']);
    expect(one(out, 'unknown').raw).toMatchObject({ type: 'brand-new-type', mergePolicy: 'accumulate' });
    expect(n.stats()).toMatchObject({ ignored: 3, unknown: 1 });
  });

  it('skip-parsed lines (json undefined) yield nothing (P-TAIL-14)', () => {
    const n = fresh();
    const e = lineEvent(undefined);
    expect(e.line.type).toBeUndefined();
    expect(n.push({ ...e, line: { ...e.line, type: 'api-request-blob' } })).toEqual([]);
    expect(n.stats().ignored).toBe(1);
  });

  it('non-object JSON and a missing type → unknown passthrough', () => {
    const n = fresh();
    expect(n.push(lineEvent([1, 2]))[0]?.kind).toBe('unknown');
    expect(n.push(lineEvent({ no: 'type' }))[0]?.kind).toBe('unknown');
  });
});

describe('replay, rewrite and file events', () => {
  it('replay:true is carried into meta (silent rebuild on resume)', () => {
    const n = fresh();
    const out = n.push(lineEvent(userText('old', { promptId: 'po' }), MAIN, { replay: true, afterRewrite: true }));
    expect(out[0]?.meta.replay).toBe(true);
    expect('replay' in (feed(fresh(), [userText('new')])[0]?.meta ?? {})).toBe(false);
  });

  it('a rewrite resets the per-file folds so the rescan re-derives them (P-TAIL-21); uuids stay stable', () => {
    const n = fresh();
    const pm = { type: 'permission-mode', permissionMode: 'default', sessionId: SID };
    const prompt = userText('hi', { uuid: 'stable-uuid', promptId: 'p' });
    const first = feed(n, [pm, prompt]);
    expect(feed(n, [pm])).toEqual([]);
    const rw = n.push({ kind: 'rewrite', file: MAIN, reason: 'rewritten', oldSize: 500, newSize: 400, generation: 1 });
    expect(one(rw, 'transcript.file')).toMatchObject({
      event: 'rewrite',
      fileKey: `main:${SID}`,
      detail: { reason: 'rewritten', generation: 1 },
    });
    const again = [pm, prompt].flatMap((e) => n.push(lineEvent(e, MAIN, { replay: true, afterRewrite: true, generation: 1 })));
    expect(again.map((o) => o.kind)).toEqual(first.map((o) => o.kind));
    expect(again.find((o) => o.kind === 'prompt.recorded')?.meta.uuid).toBe('stable-uuid');
  });

  it('resetFile(fileKey) clears the promptId stamp', () => {
    const n = fresh();
    feed(n, [userText('x', { promptId: 'P1' })]);
    n.resetFile(fileKeyString(MAIN));
    const out = feed(n, [assistant({ type: 'text', text: 'x' }, { isAbortedMidStream: true })]);
    expect('promptId' in one(out, 'turn.interrupted')).toBe(false);
  });

  it('tail file events → transcript.file; subagent missing → agent.fileMissing first (P-TAIL-34)', () => {
    const times = { at: 77 as MonoMs, wallAt: 88 as WallMs };
    const n = createTranscriptNormalizer(profile, { now: () => times });
    const events: TailEvent[] = [
      { kind: 'waiting', file: MAIN, path: '/p', reason: 'ENOENT' },
      { kind: 'opened', file: MAIN, path: '/p', dev: 1, ino: 2, size: 0, startOffset: 0 },
      { kind: 'resynced', file: MAIN, fullRescan: true, generation: 1 },
      { kind: 'malformed', file: MAIN, offset: 10, bytes: 5, reason: 'json', preview: '{"ty' },
      { kind: 'oversize', file: MAIN, offset: 20, bytes: 70_000_000 },
      { kind: 'torn-tail', file: MAIN, offset: 30, bytes: 3 },
      { kind: 'missing', file: SUB, waitedMs: 10_000 },
      { kind: 'state', file: MAIN, state: 'active' },
    ];
    const out = events.flatMap((e) => n.push(e));
    expect(out.map((o) => (o.kind === 'transcript.file' ? `file:${o.p.event}` : o.kind))).toEqual([
      'file:waiting',
      'file:opened',
      'file:resynced',
      'file:malformed',
      'file:oversize',
      'file:malformed',
      'agent.fileMissing',
      'file:missing',
    ]);
    expect(only(out, 'agent.fileMissing')).toEqual([{ agentId: 'a1028a887bdb3ce93' }]);
    for (const o of out) {
      expect(o.meta.at).toBe(77);
      expect(o.meta.wallAt).toBe(88);
    }
    expect(only(out, 'transcript.file')[5]?.detail).toEqual({ offset: 30, bytes: 3, reason: 'torn-tail' });
  });

  it('without a clock, file events use the last line read time', () => {
    const n = fresh();
    const le = lineEvent({ type: 'ai-title', aiTitle: 't' });
    n.push(le);
    const out = n.push({ kind: 'waiting', file: MAIN, path: '/p', reason: 'ENOENT' });
    expect(out[0]?.meta.at).toBe(le.line.readAtMono);
  });

  it('tail errors → unknown passthrough (L3 owns channel health)', () => {
    const out = fresh().push({ kind: 'error', file: MAIN, message: 'EIO', fatal: true });
    expect(one(out, 'unknown')).toEqual({
      channel: 'transcript',
      raw: { kind: 'error', message: 'EIO', fatal: true, fileKey: `main:${SID}` },
    });
    expect(fresh().push({ kind: 'error', message: 'x', fatal: false })[0]?.kind).toBe('unknown');
  });

  it('state closed forgets the file', () => {
    const n = fresh();
    feed(n, [{ type: 'permission-mode', permissionMode: 'plan' }]);
    n.push({ kind: 'state', file: MAIN, state: 'closed' });
    expect(feed(n, [{ type: 'permission-mode', permissionMode: 'plan' }]).map((o) => o.kind)).toEqual(['mode.observed']);
  });

  it('an internal failure (hostile getter) → unknown{normalizerError}, never a throw; the next line still maps', () => {
    const n = fresh();
    const hostile: Record<string, unknown> = { type: 'user', uuid: 'h-1' };
    Object.defineProperty(hostile, 'message', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    let out: ObservationInput[] = [];
    expect(() => {
      out = n.push(lineEvent(hostile));
    }).not.toThrow();
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('unknown');
    expect(out[0]?.p).toMatchObject({ channel: 'transcript', raw: { kind: 'normalizerError', event: 'line', message: 'boom' } });
    expect(n.stats().unknown).toBe(1);
    expect(one(feed(n, [userText('still alive', { promptId: 'p-alive' })]), 'prompt.recorded').promptId).toBe('p-alive');
  });

  it('never throws on arbitrary JSON lines (P-REC-20)', () => {
    const n = fresh();
    const entry = fc.oneof(
      fc.jsonValue(),
      fc.record({
        type: fc.constantFrom(
          'user',
          'assistant',
          'system',
          'attachment',
          'api-request',
          'last-prompt',
          'queue-operation',
          'permission-mode',
          'relocated',
          'x',
        ),
        subtype: fc.option(
          fc.constantFrom('turn_duration', 'local_command', 'informational', 'model_refusal_fallback', 'compact_boundary'),
          { nil: undefined },
        ),
        message: fc.option(fc.jsonValue(), { nil: undefined }),
        attachment: fc.option(fc.jsonValue(), { nil: undefined }),
        promptSubmitEnding: fc.option(fc.jsonValue(), { nil: undefined }),
        uuid: fc.option(fc.string(), { nil: undefined }),
      }),
    );
    fc.assert(
      fc.property(entry, (e) => {
        expect(Array.isArray(n.push(lineEvent(e)))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('transcript profile', () => {
  it('skip-parse prefixes cover exactly the bulk types and not api-request', () => {
    expect(transcriptProfile.skipParsePrefixes.some((p) => '{"type":"api-request","id":"x"}'.startsWith(p))).toBe(false);
    expect(transcriptProfile.skipParsePrefixes.some((p) => '{"type":"api-request-blob","x":1}'.startsWith(p))).toBe(true);
    expect(transcriptExtras.skipParseTypes).toEqual(['api-request-blob', 'api-request-shape', 'file-history-snapshot']);
  });

  it('merge policy table covers every type seen in the corpus (binary jco)', () => {
    for (const t of [
      'user',
      'assistant',
      'system',
      'attachment',
      'api-request',
      'api-request-blob',
      'ai-title',
      'mode',
      'permission-mode',
      'last-prompt',
      'atis-latch',
      'cost-state',
      'tools-used',
      'queue-operation',
    ]) {
      expect(transcriptProfile.mergePolicy[t], t).toBeDefined();
    }
    expect(transcriptProfile.mergePolicy['queue-operation']).toBe('last-wins');
  });

  it('FileStates.reset keeps the path, delete forgets it', () => {
    const s = new FileStates();
    s.get('k').path = '/x';
    s.get('k').promptId = 'p';
    s.reset('k');
    expect(s.get('k')).toEqual({ leafWithdrawn: false, digests: [], path: '/x' });
    s.delete('k');
    expect(s.get('k').path).toBeUndefined();
    expect(s.size).toBe(1);
  });
});
