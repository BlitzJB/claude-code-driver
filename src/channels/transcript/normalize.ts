// channels/transcript/normalize.ts — TailEvent → ObservationInput[] (DESIGN.md §2.8, §2.4 normalizer mapping; RC §2.3;
// transcript-format.md §3–§8). Pure-ish: the only state is the per-file FileState (current promptId, last-wins folds,
// api-request digests); no I/O, no timers, never throws (any internal error becomes an `unknown` observation), never
// filters by session id.
//
// Ordering keys (D-42): chain entries (user/assistant/system/attachment) carry `meta.uuid` = the entry uuid; when one line
// yields several observations, the 2nd… get `<uuid>#<n>` so a per-generation uuid de-dup in the core never swallows a
// sibling observation of the same line (and a rescan after a rewrite re-derives the same keys). `api-request` lines use
// `txreq:<id>`. Metadata records have no uuid and are folded last-wins here: an observation is emitted only when the folded
// value changes (TF §3, §9 item 18).

import type { ClaudeProfile } from '../profiles/index.js';
import { transcriptExtras as transcriptExtras2_1_316 } from '../profiles/claude-2.1.316/transcript.js';
import type { TranscriptExtras } from '../profiles/claude-2.1.316/transcript.js';
import type { HookExtras } from '../profiles/claude-2.1.316/hooks.js';
import type { FileKey, TailEvent, TailLine } from '../../platform/ports.js';
import type { ObsMeta, Observation, ObservationInput, PermissionDecider } from '../../model/observation.js';
import type { MonoMs, WallMs } from '../../model/time.js';
import { hookExtrasFor } from '../hooks/normalize.js';
import { arr, bool, errorText, field, isRecord, nonEmpty, normalizePermissionMode, num, put, rec, str } from '../hooks/payload-guards.js';
import type { JsonRecord } from '../hooks/payload-guards.js';
import { assistantMessageOf, envelopeOf, startsWithTag, tagInner, textOf, toEpochMs, userContentOf } from './entry-guards.js';
import type { Envelope } from './entry-guards.js';
import { FileStates, fileKeyString, rememberDigest } from './file-state.js';
import type { FileState } from './file-state.js';

export interface TranscriptNormalizer {
  push(e: TailEvent): ObservationInput[];
  resetFile(fileKey: string): void;
}

interface TranscriptNormalizerStats {
  /** `line` events seen. */
  lines: number;
  /** Observations produced. */
  observations: number;
  /** Lines of known types that carry no fact the core needs (skip-parsed, bookkeeping, unmapped attachments). */
  ignored: number;
  /** `unknown` observations produced (open-world passthrough, P-TAIL-42 / P-REC-20). */
  unknown: number;
  /** Facts dropped because a required id was missing or not a tool id (P-REC-38). */
  dropped: number;
}

export interface TranscriptNormalizerOptions {
  /**
   * Time source for the meta of non-line tail events (`opened`, `rewrite`, `missing`, …), which carry no read time of
   * their own. L3 passes its Clock; without one the read time of the last line seen is used (0 before any line).
   */
  now?: () => { at: MonoMs; wallAt: WallMs };
}

export interface TranscriptNormalizerWithStats extends TranscriptNormalizer {
  stats(): TranscriptNormalizerStats;
}

/** The leading tag name, in the same shape `ZHe` matches (`<name` then whitespace or `>`). */
const LEAD_TAG = /^\s*<([a-z][\w-]*)[\s>]/;

const TRANSCRIPT_EXTRAS: Readonly<Record<ClaudeProfile['version'], TranscriptExtras>> = Object.freeze({
  '2.1.316': transcriptExtras2_1_316,
});

type Kind = Observation['kind'];
type PayloadOf<K extends Kind> = Extract<Observation, { kind: K }>['p'];
type Meta = Omit<ObsMeta, 'seq'>;

function mk<K extends Kind>(kind: K, meta: Meta, p: PayloadOf<K>): ObservationInput {
  // The mapped ObservationInput union cannot correlate a generic K with its payload; the signature above enforces it.
  return { kind, meta, p } as unknown as ObservationInput;
}

/** Collects the observations of one line, assigning `uuid`, `uuid#1`, `uuid#2`, … (see header). */
class LineOut {
  readonly list: ObservationInput[] = [];
  readonly #base: Meta;
  readonly #uuid: string | undefined;

  constructor(base: Meta, uuid: string | undefined) {
    this.#base = base;
    this.#uuid = uuid;
  }

  add<K extends Kind>(kind: K, p: PayloadOf<K>, metaPatch?: Partial<Meta>): void {
    const meta: Meta = { ...this.#base, ...metaPatch };
    if (this.#uuid !== undefined) meta.uuid = this.list.length === 0 ? this.#uuid : `${this.#uuid}#${this.list.length}`;
    this.list.push(mk(kind, meta, p));
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

export function createTranscriptNormalizer(profile: ClaudeProfile, opts: TranscriptNormalizerOptions = {}): TranscriptNormalizerWithStats {
  const T = profile.transcript;
  const X: TranscriptExtras = TRANSCRIPT_EXTRAS[profile.version];
  const H: HookExtras = hookExtrasFor(profile);
  const states = new FileStates();
  const stats: TranscriptNormalizerStats = { lines: 0, observations: 0, ignored: 0, unknown: 0, dropped: 0 };
  const skipTypes = new Set(X.skipParseTypes);
  const ignoredTypes = new Set(X.ignoredTypes);
  const ignoredSubtypes = new Set(X.ignoredSystemSubtypes);
  let lastTimes: { at: MonoMs; wallAt: WallMs } = { at: 0 as MonoMs, wallAt: 0 as WallMs };

  const isToolId = (id: string | undefined): id is string => id?.startsWith(X.toolUseIdPrefix) === true;
  const own = <V>(table: Readonly<Record<string, V>>, key: string | undefined): V | undefined =>
    key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

  function fileMeta(file: FileKey): Meta {
    const t = opts.now?.() ?? lastTimes;
    const m: Meta = { at: t.at, wallAt: t.wallAt, source: 'transcript', claudeSessionId: file.sessionId };
    if (file.kind === 'subagent') m.agentId = file.agentId;
    return m;
  }

  function lineMeta(line: TailLine, key: string, env: Envelope | undefined, extraAgentId?: string): Meta {
    const sidechain = env?.isSidechain ?? line.file.kind === 'subagent';
    const origin: NonNullable<Meta['origin']> = {
      kind: 'transcript',
      fileKey: key,
      generation: line.generation,
      offset: line.offset,
      sidechain,
    };
    if (env?.uuid !== undefined) origin.entryUuid = env.uuid;
    if (env?.timestamp !== undefined) origin.entryTs = env.timestamp;
    const m: Meta = {
      at: line.readAtMono,
      wallAt: line.readAtWall,
      source: 'transcript',
      claudeSessionId: env?.sessionId ?? line.file.sessionId,
      origin,
    };
    const agentId = env?.agentId ?? extraAgentId ?? (line.file.kind === 'subagent' ? line.file.agentId : undefined);
    put(m, 'agentId', agentId);
    if (line.replay) m.replay = true;
    return m;
  }

  // ---- chain entries ---------------------------------------------------------------------------------------------

  function userEntry(e: JsonRecord, env: Envelope, s: FileState, out: LineOut): void {
    if (env.promptId !== undefined) s.promptId = env.promptId;
    const content = userContentOf(e);
    const uuid = env.uuid ?? '';

    // Safety-classifier stop: isMeta + turnCompanion + refusedMessageId → model.refused, never prompt.recorded (TF §4.2 #8).
    const refusedMessageId = nonEmpty(e, 'refusedMessageId');
    if (refusedMessageId !== undefined) {
      out.add('model.refused', { refusedMessageId, text: content.text, uuid });
      return;
    }

    if (content.toolResults.length > 0) {
      const single = content.toolResults.length === 1;
      const tur = field(e, 'toolUseResult');
      const denialKind = nonEmpty(e, 'toolDenialKind');
      content.toolResults.forEach((tr, i) => {
        const p: PayloadOf<'tool.result'> = { toolUseId: tr.toolUseId, isError: tr.isError, uuid };
        if (single) {
          // `toolDenialKind` is entry-level: only attributable when the entry holds exactly one result. Without it, the
          // profile's rejection text still identifies a user rejection at a permission prompt (TF §4.2 item 6).
          const rejectedByText =
            tr.isError && tr.text.startsWith(T.markers.userRejectedToolResultPrefix) ? X.userRejectedDenialKind : undefined;
          put(p, 'denialKind', denialKind ?? rejectedByText);
          const interrupted =
            denialKind === X.interruptedDenialKind || (isRecord(tur) && bool(tur, 'interrupted') === true) ? true : undefined;
          put(p, 'interrupted', interrupted);
          if (isRecord(tur) && str(tur, 'status') === X.asyncLaunchedStatus) put(p, 'asyncAgentId', nonEmpty(tur, 'agentId'));
        }
        if (tr.text.length > 0) p.contentPreview = truncate(tr.text, X.previewChars);
        out.add('tool.result', p);
        // Validation rejection: no hook fires at all (OD §1.7); the core makes the tool `failed` (P-REC-26).
        if (tr.isError && tr.text.includes(`<${X.tags.toolUseError}>`)) out.add('tool.validationError', { toolUseId: tr.toolUseId });
        // permissionDecision is entry-level too: never guessed onto one of several parallel results (P-REC-30).
        if (single && i === 0) permissionDecision(e, tr.toolUseId, out);
        else if (i === 0 && rec(e, 'permissionDecision') !== undefined) stats.dropped++;
      });
      return;
    }

    const text = content.text;
    const trimmed = text.trim();
    const promptId = env.promptId ?? s.promptId;

    // Interrupt markers (TF §8.5): the only durable record of an interrupt, no hook fires (P-REC-02/03).
    if (trimmed.startsWith(T.markers.interruptedForToolUse) || trimmed.startsWith(T.markers.interrupted)) {
      const marker = trimmed.startsWith(T.markers.interruptedForToolUse) ? 'tool_use' : 'request';
      const p: PayloadOf<'turn.interrupted'> = { marker };
      put(p, 'interruptedMessageId', nonEmpty(e, 'interruptedMessageId'));
      put(p, 'promptId', promptId);
      out.add('turn.interrupted', p);
      return;
    }

    const rp: PayloadOf<'prompt.recorded'> = { uuid, parentUuid: env.parentUuid, isMeta: env.isMeta };
    put(rp, 'promptId', env.promptId);
    const origin = rec(e, 'origin');
    put(rp, 'origin', (origin === undefined ? undefined : nonEmpty(origin, 'kind')) ?? nonEmpty(e, 'turnOrigin'));
    put(rp, 'promptSource', nonEmpty(e, 'promptSource'));

    if (startsWithTag(text, X.tags.bashInput)) {
      // `!cmd` in bash mode: a human turn with no UPS (IN §4.2).
      rp.bashInput = true;
      rp.text = tagInner(text, X.tags.bashInput) ?? text;
    } else if (startsWithTag(text, X.tags.commandName)) {
      const name = (tagInner(text, X.tags.commandName) ?? '').trim();
      const lc: NonNullable<PayloadOf<'prompt.recorded'>['localCommand']> = { name };
      put(lc, 'args', tagInner(text, X.tags.commandArgs)?.trim());
      if (name.length > 0) s.lastCommandName = name;
      rp.localCommand = lc;
      rp.text = text;
    } else if (startsWithTag(text, X.tags.localCommandStdout) || startsWithTag(text, X.tags.localCommandStderr)) {
      const lc: NonNullable<PayloadOf<'prompt.recorded'>['localCommand']> = { name: s.lastCommandName ?? '' };
      put(lc, 'stdout', tagInner(text, X.tags.localCommandStdout) ?? tagInner(text, X.tags.localCommandStderr));
      rp.localCommand = lc;
      rp.isMeta = true; // output, not a prompt
    } else {
      rp.text = text;
      // A safety-classifier companion whose refusedMessageId is missing cannot become model.refused, but it is never a
      // user prompt either (TF §4.2 item 8).
      const flagged =
        bool(e, 'isVisibleInTranscriptOnly') === true ||
        bool(e, 'isCompactSummary') === true ||
        trimmed.startsWith(T.markers.safetyClassifierStop);
      // Not-real-user text (ZHe, P-TX-06): system reminders, bash output, caveats… ZHe matches any leading `<tag`, so a
      // tag-led text counts only when the tag is one Claude generates (ICR 0025): a typed `<div> breaks layout` is a real
      // prompt. A task notification is not listed: it IS a turn (origin task-notification) and keeps isMeta from the entry.
      const lead = LEAD_TAG.exec(text)?.[1];
      const notReal = T.notRealUserText.test(text) && (lead === undefined || X.generatedLeadTags.includes(lead));
      if (flagged || notReal) rp.isMeta = true;
    }
    out.add('prompt.recorded', rp);
  }

  /** `permissionDecision` on a tool_result → decider (RC §2.3; LV §Q2). */
  function permissionDecision(e: JsonRecord, toolUseId: string, out: LineOut): void {
    const pd = rec(e, 'permissionDecision');
    if (pd === undefined) return;
    const d = str(pd, 'decision');
    if (d !== 'accept' && d !== 'reject') {
      stats.dropped++;
      return;
    }
    const source = str(pd, 'source');
    const reasonType = str(pd, 'reasonType');
    let decider: PermissionDecider = own(X.deciderBySource, source) ?? 'unknown';
    if (decider === 'config' && reasonType === X.classifierReasonType) decider = 'classifier';
    const p: PayloadOf<'permission.decisionRecorded'> = { toolUseId, decision: d, decider, via: 'tool_result' };
    put(p, 'reasonCode', nonEmpty(pd, 'reasonCode'));
    out.add('permission.decisionRecorded', p);
  }

  function assistantEntry(e: JsonRecord, env: Envelope, s: FileState, out: LineOut): void {
    const am = assistantMessageOf(e);
    if (am === undefined) {
      stats.unknown++;
      out.add('unknown', { channel: 'transcript', raw: { type: 'assistant', reason: 'noMessage', uuid: env.uuid ?? null } });
      return;
    }
    const synthetic = am.model === T.markers.syntheticModel;

    // API-error stand-in (synthetic, isApiErrorMessage): not model output; the transcript-level "turn failed" signal.
    if (bool(e, 'isApiErrorMessage') === true) {
      const params = rec(e, 'apiErrorParams');
      const rli = params === undefined ? undefined : rec(params, 'rate_limit_info');
      const p: PayloadOf<'model.apiErrorRecorded'> = {
        error: nonEmpty(e, 'error') ?? 'unknown',
        text: am.blocks.map((b) => (str(b, 'type') === 'text' ? (str(b, 'text') ?? '') : '')).join(''),
      };
      const apiError = field(e, 'apiError');
      put(p, 'apiError', typeof apiError === 'string' ? apiError : undefined);
      put(p, 'promptId', env.promptId ?? s.promptId); // binds the line to its own turn in the core (ICR 0021)
      if (rli !== undefined) {
        // resetsAt is epoch seconds (LC §3.1, VERIFIED-SRC; live UNVERIFIED LP-30).
        const reset = toEpochMs(field(rli, 'resetsAt'));
        if (reset !== undefined) p.resetsAtWall = reset as WallMs;
        put(p, 'rateLimitType', nonEmpty(rli, 'rateLimitType') ?? nonEmpty(rli, 'rate_limit_type') ?? nonEmpty(rli, 'type'));
      }
      out.add('model.apiErrorRecorded', p);
      return;
    }

    const aborted = bool(e, 'isAbortedMidStream') === true;
    am.blocks.forEach((b, i) => {
      const bt = own(X.blockTypes, str(b, 'type'));
      if (bt === undefined) {
        // Server-side tool blocks and future block types: passthrough, never a guess (TF §3).
        stats.unknown++;
        out.add('unknown', {
          channel: 'transcript',
          raw: { type: 'assistant', blockType: str(b, 'type') ?? null, uuid: env.uuid ?? null },
        });
        return;
      }
      const p: PayloadOf<'message.block'> = {
        apiMessageId: am.id ?? env.uuid ?? '',
        blockIndex: num(e, 'apiBlockIndex') ?? i,
        block: bt,
        stopReason: am.stopReason,
        synthetic,
        abortedMidStream: aborted,
        uuid: env.uuid ?? '',
        parentUuid: env.parentUuid,
      };
      put(p, 'requestId', nonEmpty(e, 'requestId'));
      put(p, 'requestRef', nonEmpty(e, 'requestRef'));
      put(p, 'usage', am.usage); // identical on every block of a message: the core counts it once (P-REC-36)
      if (bt === 'tool_use') {
        put(p, 'toolUseId', nonEmpty(b, 'id'));
        put(p, 'toolName', nonEmpty(b, 'name'));
        put(p, 'input', field(b, 'input'));
      } else if (bt === 'text') {
        put(p, 'text', str(b, 'text'));
      } else {
        put(p, 'text', str(b, 'thinking')); // empty with display:"updates" (P-TX-01)
      }
      out.add('message.block', p);
    });
    if (aborted) {
      // Esc during text streaming: partial text persisted with isAbortedMidStream (TF §4.3, §8.5).
      const p: PayloadOf<'turn.interrupted'> = { marker: 'aborted_mid_stream' };
      put(p, 'interruptedMessageId', am.id);
      put(p, 'promptId', s.promptId);
      out.add('turn.interrupted', p);
    }
  }

  function systemEntry(e: JsonRecord, env: Envelope, s: FileState, out: LineOut): void {
    const subtype = nonEmpty(e, 'subtype') ?? '';
    switch (subtype) {
      case 'turn_duration': {
        const p: PayloadOf<'turn.durationRecorded'> = {
          durationMs: num(e, 'durationMs') ?? 0,
          pendingBackgroundAgentCount: num(e, 'pendingBackgroundAgentCount') ?? 0, // absent when 0 (TF §4.4)
        };
        put(p, 'promptId', env.promptId ?? s.promptId); // binds the line to its own turn in the core (ICR 0021)
        out.add('turn.durationRecorded', p);
        return;
      }
      case 'local_command': {
        const content = textOf(field(e, 'content'));
        const run = rec(e, 'commandRun');
        const runName = run === undefined ? undefined : nonEmpty(run, 'command');
        const tagged = tagInner(content, X.tags.commandName)?.trim();
        let name = tagged !== undefined && tagged.length > 0 ? tagged : undefined;
        if (name === undefined && runName !== undefined) name = runName.startsWith('/') ? runName : `/${runName}`;
        if (name !== undefined) s.lastCommandName = name;
        const lc: NonNullable<PayloadOf<'prompt.recorded'>['localCommand']> = { name: name ?? s.lastCommandName ?? '' };
        put(lc, 'args', tagInner(content, X.tags.commandArgs)?.trim() ?? (run === undefined ? undefined : str(run, 'args')));
        put(lc, 'stdout', tagInner(content, X.tags.localCommandStdout) ?? tagInner(content, X.tags.localCommandStderr));
        out.add('prompt.recorded', { uuid: env.uuid ?? '', parentUuid: env.parentUuid, isMeta: env.isMeta, localCommand: lc });
        return;
      }
      case 'model_refusal_fallback': {
        const p: PayloadOf<'model.refusalFallback'> = { retractedMessageUuids: stringsOf(field(e, 'retractedMessageUuids')) };
        put(p, 'refusedUserMessageUuid', nonEmpty(e, 'refusedUserMessageUuid'));
        put(p, 'originalModel', nonEmpty(e, 'originalModel'));
        put(p, 'fallbackModel', nonEmpty(e, 'fallbackModel'));
        put(p, 'requestId', nonEmpty(e, 'requestId'));
        put(p, 'trigger', nonEmpty(e, 'trigger'));
        put(p, 'scope', nonEmpty(e, 'scope'));
        put(p, 'category', nonEmpty(e, 'apiRefusalCategory') ?? nonEmpty(e, 'category'));
        out.add('model.refusalFallback', p);
        return;
      }
      case 'informational': {
        const ending = rec(rec(e, 'promptSubmitEnding') ?? {}, 'ending');
        if (ending !== undefined && str(ending, 'kind') === X.blockedByHook.endingKind) {
          // LP-47 (ICR 0002): transcript evidence of a UPS blocked by a hook (ours: the self-test; a user's: E_TURN_BLOCKED_BY_HOOK).
          // `promptKept` is written false even though the text returns to the composer: never used (ICR 0001 item 4).
          const content = textOf(field(e, 'content'));
          const B = X.blockedByHook;
          const markerAt = content.indexOf(B.originalPromptMarker);
          const text = markerAt >= 0 ? content.slice(markerAt + B.originalPromptMarker.length) : '';
          let reason = str(ending, 'reason');
          if (reason === undefined && content.startsWith(B.contentPrefix)) {
            reason = content.slice(B.contentPrefix.length, markerAt >= 0 ? markerAt : undefined);
          }
          out.add('prompt.blocked', { reason: reason ?? '', text });
          return;
        }
        stats.ignored++; // other notices ("Compacted while idle…", "Unknown command: …")
        return;
      }
      case 'compact_boundary': {
        const cm = rec(e, 'compactMetadata');
        const p: PayloadOf<'compact.phase'> = { phase: 'finished' };
        put(p, 'trigger', cm === undefined ? undefined : nonEmpty(cm, 'trigger'));
        out.add('compact.phase', p);
        return;
      }
      default:
        if (ignoredSubtypes.has(subtype)) {
          stats.ignored++;
          return;
        }
        stats.unknown++;
        out.add('unknown', {
          channel: 'transcript',
          raw: { type: 'system', subtype: subtype.length > 0 ? subtype : null, uuid: env.uuid ?? null },
        });
    }
  }

  function attachmentEntry(e: JsonRecord, out: LineOut): void {
    const a = rec(e, 'attachment');
    const t = a === undefined ? undefined : str(a, 'type');
    if (a === undefined || t === undefined) {
      stats.ignored++;
      return;
    }
    const A = X.attachments;
    if (t === A.hookPermissionDecision) {
      // The only hook-side link from a PermissionRequest to its toolUseID (LV §Q2).
      const toolUseId = nonEmpty(a, 'toolUseID');
      const decision = own(X.attachmentDecision, str(a, 'decision'));
      if (!isToolId(toolUseId) || decision === undefined) {
        stats.dropped++;
        return;
      }
      out.add('permission.decisionRecorded', { toolUseId, decision, decider: 'hook', via: 'attachment' });
      return;
    }
    const errKind = own(X.hookErrorAttachments, t);
    if (errKind !== undefined) {
      // Hook endpoint down / hung (P-REC-29, P-LIVE-02). toolUseID is a plain uuid for UPS/Stop hooks (P-REC-38).
      const p: PayloadOf<'hookchannel.error'> = {
        hookEvent: nonEmpty(a, 'hookEvent') ?? nonEmpty(a, 'hookName') ?? 'unknown',
        kind: errKind,
      };
      const toolUseId = nonEmpty(a, 'toolUseID');
      if (isToolId(toolUseId)) p.toolUseId = toolUseId;
      const stderr = nonEmpty(a, 'stderr');
      if (stderr !== undefined) p.detail = truncate(stderr, 512);
      else if (bool(a, 'timedOut') === true) p.detail = `timedOut ${num(a, 'timeoutMs') ?? '?'}ms`;
      out.add('hookchannel.error', p);
      return;
    }
    if (t === A.queuedCommand) {
      // A prompt typed mid-turn absorbed into the running turn: evidence for mergedInto only (§4.4).
      const p: PayloadOf<'prompt.absorbed'> = { text: textOf(field(a, 'prompt')) };
      put(p, 'deliveryId', nonEmpty(a, 'delivery_id'));
      out.add('prompt.absorbed', p);
      return;
    }
    if (t === A.taskStatus) {
      const taskId = nonEmpty(a, 'taskId');
      if (taskId === undefined) {
        stats.dropped++;
        return;
      }
      const p: PayloadOf<'bgtask.status'> = {
        taskId,
        taskType: nonEmpty(a, 'taskType') ?? 'unknown',
        status: nonEmpty(a, 'status') ?? 'unknown',
      };
      const shell = rec(a, 'shell');
      put(p, 'toolUseId', shell === undefined ? undefined : nonEmpty(shell, 'toolUseId'));
      out.add('bgtask.status', p);
      return;
    }
    stats.ignored++; // environment, date, prompt_snapshot, … are never conversation (TF §4.5)
  }

  // ---- metadata / side records -----------------------------------------------------------------------------------

  function metadataEntry(type: string, e: JsonRecord, line: TailLine, s: FileState, out: LineOut): boolean {
    switch (type) {
      case 'api-request': {
        const id = nonEmpty(e, 'id');
        if (id === undefined) {
          stats.dropped++;
          return true;
        }
        const digest = nonEmpty(e, 'requestDigest');
        const tail = arr(e, 'tail');
        // One record per attempt; same requestDigest + `tail:[]` → retry of the same payload (TF §4.6).
        const isRetry = digest !== undefined && tail?.length === 0 && s.digests.includes(digest);
        if (digest !== undefined) rememberDigest(s, digest);
        const p: PayloadOf<'model.requestStarted'> = { requestRef: id, isRetry };
        put(p, 'querySource', nonEmpty(e, 'querySource'));
        put(p, 'requestDigest', digest);
        const tx = toEpochMs(field(e, 'timestamp'));
        if (tx !== undefined) p.txWall = tx as WallMs;
        out.add('model.requestStarted', p);
        return true;
      }
      case 'last-prompt': {
        const leaf = field(e, 'leafUuid');
        const withdrawn = bool(e, 'explicit') === true && (leaf === null || leaf === X.zeroLeafUuid);
        // Folded last-wins: the metadata flush re-appends last-prompt after every turn (TF §4.7).
        if (withdrawn && !s.leafWithdrawn) out.add('prompt.withdrawn', {});
        s.leafWithdrawn = withdrawn;
        return true;
      }
      case 'queue-operation': {
        // Every operation is a distinct event (enqueue/dequeue/remove/popAll), never folded.
        const p: PayloadOf<'queue.op'> = { op: nonEmpty(e, 'operation') ?? 'unknown' };
        const content = field(e, 'content');
        if (content !== undefined) p.content = textOf(content);
        put(p, 'reason', nonEmpty(e, 'reason'));
        out.add('queue.op', p);
        return true;
      }
      case 'permission-mode': {
        // Persisted mode, re-emitted at every flush: not a live change event; folded (authority: hook > transcript).
        const mode = normalizePermissionMode(nonEmpty(e, 'permissionMode'), H);
        if (mode !== undefined && mode !== s.permissionMode) out.add('mode.observed', { permissionMode: mode });
        if (mode !== undefined) s.permissionMode = mode;
        return true;
      }
      case 'continued-in': {
        const to = nonEmpty(e, 'continuedInSessionId');
        if (to !== undefined && to !== s.continuedIn) out.add('transcript.continuedIn', { continuedInSessionId: to });
        if (to !== undefined) s.continuedIn = to;
        return true;
      }
      case 'relocated': {
        // `/cd` / worktree move (TT §5.3): the new path is the one the tail reported (`moved`/`opened`); the stamp itself
        // carries only the new cwd, which stands in until the tail reports a path.
        const cwd = nonEmpty(e, 'relocatedCwd');
        if (cwd !== undefined && cwd !== s.relocatedCwd) {
          out.add('transcript.relocated', {
            sessionId: nonEmpty(e, 'sessionId') ?? line.file.sessionId,
            newPath: s.path ?? cwd,
          });
        }
        if (cwd !== undefined) s.relocatedCwd = cwd;
        else stats.dropped++;
        return true;
      }
      default:
        return false;
    }
  }

  function lineEvent(line: TailLine): ObservationInput[] {
    stats.lines++;
    lastTimes = { at: line.readAtMono, wallAt: line.readAtWall };
    const key = fileKeyString(line.file);
    const s = states.get(key);
    const json = line.json;

    if (json === undefined) {
      // Skip-parsed by the tail (P-TAIL-14) or unparsed: known bulk types carry nothing for the core.
      stats.ignored++;
      return [];
    }
    if (!isRecord(json)) {
      // The tail reports non-objects as `malformed{not-object}`; a stray one is passthrough (P-TAIL-42).
      stats.unknown++;
      return [
        mk('unknown', lineMeta(line, key, undefined), { channel: 'transcript', raw: { offset: line.offset, nonObject: typeof json } }),
      ];
    }
    const type = nonEmpty(json, 'type') ?? line.type;
    if (type === undefined) {
      stats.unknown++;
      return [mk('unknown', lineMeta(line, key, undefined), { channel: 'transcript', raw: { offset: line.offset, missingType: true } })];
    }

    const chain = type === 'user' || type === 'assistant' || type === 'system' || type === 'attachment';
    if (chain) {
      const env = envelopeOf(json, type);
      const out = new LineOut(lineMeta(line, key, env), env.uuid);
      if (type === 'user') userEntry(json, env, s, out);
      else if (type === 'assistant') assistantEntry(json, env, s, out);
      else if (type === 'system') systemEntry(json, env, s, out);
      else attachmentEntry(json, out);
      return out.list;
    }

    if (type === 'api-request') {
      const id = nonEmpty(json, 'id');
      const out = new LineOut(
        lineMeta(line, key, undefined, nonEmpty(json, 'agentId')),
        id === undefined ? undefined : X.apiRequestUuidPrefix + id,
      );
      metadataEntry(type, json, line, s, out);
      return out.list;
    }
    const out = new LineOut(lineMeta(line, key, undefined, nonEmpty(json, 'agentId')), undefined);
    if (metadataEntry(type, json, line, s, out)) return out.list;
    if (skipTypes.has(type) || ignoredTypes.has(type)) {
      stats.ignored++;
      return [];
    }
    // Open union: a type this profile does not know (merge policy `accumulate` by default) → passthrough (TF §3).
    stats.unknown++;
    out.add('unknown', { channel: 'transcript', raw: { type, mergePolicy: own(T.mergePolicy, type) ?? 'accumulate', entry: json } });
    return out.list;
  }

  function fileEvent(e: Exclude<TailEvent, { kind: 'line' | 'error' }>): ObservationInput[] {
    const key = fileKeyString(e.file);
    const meta = fileMeta(e.file);
    const tf = (event: PayloadOf<'transcript.file'>['event'], detail: unknown): ObservationInput =>
      mk('transcript.file', meta, { event, fileKey: key, detail });
    switch (e.kind) {
      case 'waiting':
        return [tf('waiting', { path: e.path, reason: e.reason })];
      case 'opened':
        // A fresh read from offset 0 re-derives everything: drop the folds so the stream is a pure function of the file.
        if (e.startOffset === 0) states.reset(key);
        states.get(key).path = e.path;
        return [tf('opened', { path: e.path, dev: e.dev, ino: e.ino, size: e.size, startOffset: e.startOffset })];
      case 'moved':
        states.get(key).path = e.to;
        return [tf('moved', { from: e.from, to: e.to, sameInode: e.sameInode })];
      case 'rewrite':
        // P-TAIL-21: the tail re-reads from 0 with replay:true; core uuid de-dup drops what it has already seen.
        states.reset(key);
        return [tf('rewrite', { reason: e.reason, oldSize: e.oldSize, newSize: e.newSize, generation: e.generation })];
      case 'resynced':
        return [tf('resynced', { fullRescan: e.fullRescan, generation: e.generation })];
      case 'malformed':
        // Crash fragment or bad JSON (P-TAIL-07/42): reported, never thrown.
        return [tf('malformed', { offset: e.offset, bytes: e.bytes, reason: e.reason, preview: e.preview })];
      case 'oversize':
        return [tf('oversize', { offset: e.offset, bytes: e.bytes })];
      case 'torn-tail':
        return [tf('malformed', { offset: e.offset, bytes: e.bytes, reason: 'torn-tail' })];
      case 'missing': {
        // Subagent file never appeared (internal agents, P-TAIL-34).
        const out = [tf('missing', { waitedMs: e.waitedMs })];
        if (e.file.kind === 'subagent') out.unshift(mk('agent.fileMissing', meta, { agentId: e.file.agentId }));
        return out;
      }
      case 'state':
        if (e.state === 'closed') states.delete(key);
        return [];
      default: {
        const never: never = e;
        return never;
      }
    }
  }

  function pushUnsafe(e: TailEvent): ObservationInput[] {
    if (e.kind === 'line') return lineEvent(e.line);
    if (e.kind === 'error') {
      // Tail failures are L0 transport facts; L3 owns channel health. Passthrough for the trace.
      const t = opts.now?.() ?? lastTimes;
      const meta: Meta = e.file === undefined ? { at: t.at, wallAt: t.wallAt, source: 'transcript' } : fileMeta(e.file);
      stats.unknown++;
      return [
        mk('unknown', meta, {
          channel: 'transcript',
          raw: { kind: 'error', message: e.message, fatal: e.fatal, fileKey: e.file === undefined ? null : fileKeyString(e.file) },
        }),
      ];
    }
    return fileEvent(e);
  }

  return {
    push(e: TailEvent): ObservationInput[] {
      let out: ObservationInput[];
      try {
        out = pushUnsafe(e);
      } catch (err) {
        // L1 never throws (§2.8): an internal failure becomes an unknown observation the trace can show.
        stats.unknown++;
        out = [
          mk(
            'unknown',
            { at: lastTimes.at, wallAt: lastTimes.wallAt, source: 'transcript' },
            {
              channel: 'transcript',
              raw: { kind: 'normalizerError', event: e.kind, message: errorText(err) },
            },
          ),
        ];
      }
      stats.observations += out.length;
      return out;
    },
    resetFile(fileKey: string): void {
      states.reset(fileKey);
    },
    stats(): TranscriptNormalizerStats {
      return { ...stats };
    },
  };
}
