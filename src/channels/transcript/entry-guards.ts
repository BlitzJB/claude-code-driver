// channels/transcript/entry-guards.ts — lenient readers for transcript JSONL entries (DESIGN.md §1.2; TF §3–§4).
// Entries are untrusted, open-union JSON (TF §3: unknown types/subtypes are passthrough, P-TAIL-42). Every reader
// returns `undefined`/empty for a missing or mistyped field and never throws.

import type { TokenUsage } from '../../model/observation.js';
import { arr, bool, field, isRecord, nonEmpty, num, put, rec, str } from '../hooks/payload-guards.js';
import type { JsonRecord } from '../hooks/payload-guards.js';

/** Envelope fields of conversation-chain entries (TF §4.1). `uuid` is absent on metadata/side records. */
export interface Envelope {
  type: string;
  uuid?: string;
  parentUuid: string | null;
  sessionId?: string;
  agentId?: string;
  isSidechain?: boolean;
  timestamp?: string;
  promptId?: string;
  isMeta: boolean;
}

export function envelopeOf(e: JsonRecord, type: string): Envelope {
  const env: Envelope = { type, parentUuid: nonEmpty(e, 'parentUuid') ?? null, isMeta: bool(e, 'isMeta') === true };
  put(env, 'uuid', nonEmpty(e, 'uuid'));
  // `sessionId` (camel) is the session of the FILE; `session_id` (snake) is the authored-in session of copied entries
  // (TF §4.1). The file's session is what generations join on.
  put(env, 'sessionId', nonEmpty(e, 'sessionId'));
  put(env, 'agentId', nonEmpty(e, 'agentId'));
  put(env, 'isSidechain', bool(e, 'isSidechain'));
  put(env, 'timestamp', nonEmpty(e, 'timestamp'));
  put(env, 'promptId', nonEmpty(e, 'promptId'));
  return env;
}

/** Text of a content value: a string, or the concatenation of `text` blocks of a block array. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (str(b, 'type') === 'text') {
      const t = str(b, 'text');
      if (t !== undefined) parts.push(t);
    }
  }
  return parts.join('\n');
}

interface ToolResultBlock {
  toolUseId: string;
  isError: boolean;
  text: string;
}

export interface UserContent {
  /** Concatenated `text` blocks (or the string content). */
  text: string;
  /** True when content was a plain string or had at least one text block. */
  hasText: boolean;
  toolResults: ToolResultBlock[];
}

export function userContentOf(e: JsonRecord): UserContent {
  const message = rec(e, 'message');
  const content = message === undefined ? undefined : field(message, 'content');
  if (typeof content === 'string') return { text: content, hasText: true, toolResults: [] };
  const out: UserContent = { text: '', hasText: false, toolResults: [] };
  if (!Array.isArray(content)) return out;
  const texts: string[] = [];
  for (const b of content) {
    if (!isRecord(b)) continue;
    const t = str(b, 'type');
    if (t === 'text') {
      const s = str(b, 'text');
      if (s !== undefined) {
        texts.push(s);
        out.hasText = true;
      }
    } else if (t === 'tool_result') {
      const toolUseId = nonEmpty(b, 'tool_use_id');
      if (toolUseId === undefined) continue;
      out.toolResults.push({ toolUseId, isError: bool(b, 'is_error') === true, text: textOf(field(b, 'content')) });
    }
  }
  out.text = texts.join('\n');
  return out;
}

export interface AssistantMessage {
  id?: string;
  model?: string;
  stopReason: string | null;
  usage?: TokenUsage;
  blocks: JsonRecord[];
}

function usageOf(u: JsonRecord | undefined): TokenUsage | undefined {
  if (u === undefined) return undefined;
  const inputTokens = num(u, 'input_tokens');
  const outputTokens = num(u, 'output_tokens');
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const usage: TokenUsage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
  put(usage, 'cacheCreationInputTokens', num(u, 'cache_creation_input_tokens'));
  put(usage, 'cacheReadInputTokens', num(u, 'cache_read_input_tokens'));
  return usage;
}

export function assistantMessageOf(e: JsonRecord): AssistantMessage | undefined {
  const m = rec(e, 'message');
  if (m === undefined) return undefined;
  const blocks = (arr(m, 'content') ?? []).filter(isRecord);
  const am: AssistantMessage = { stopReason: str(m, 'stop_reason') ?? null, blocks };
  put(am, 'id', nonEmpty(m, 'id'));
  put(am, 'model', nonEmpty(m, 'model'));
  put(am, 'usage', usageOf(rec(m, 'usage')));
  return am;
}

/**
 * The inner text of the first `<tag>…</tag>` in `text` (not trimmed: command args and stdout keep their bytes), or
 * `undefined` when the tag is absent.
 */
export function tagInner(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const from = start + open.length;
  const end = text.indexOf(`</${tag}>`, from);
  return end < 0 ? undefined : text.slice(from, end);
}

/** True when `text` (after leading whitespace) starts with `<tag>`. */
export function startsWithTag(text: string, tag: string): boolean {
  return text.trimStart().startsWith(`<${tag}>`);
}

/** Epoch seconds or milliseconds (heuristic: < 1e12 is seconds) → ms; ISO strings parsed. `undefined` when not a time. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '') return toEpochMs(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}
