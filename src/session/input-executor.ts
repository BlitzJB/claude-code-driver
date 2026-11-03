// session/input-executor.ts — executes `input` intents against the TmuxPane / EditorInjector and reports `input.done`
// (DESIGN.md §1.2, §2.6 InputPrimitive, §3.6; IN §12 single writer; TD R8 one FIFO per pane).
//
// The core decides *what* to send and every wait that decides anything is a core deadline (D-03). This executor only:
//   - runs one primitive per `input` intent, strictly in arrival order (one serial queue: at most one primitive in flight);
//   - checks the pane before every pane-affecting primitive: dead / gone → refuse; copy mode → `exitCopyMode` first
//     (P-TMUX-45, P-SCREEN-21, §3.6 gate "executor runs exitCopyMode first");
//   - re-validates every primitive against the §2.6 limits (closed key list, paste ≤ 400 B / ≤ 2 LF, literal ≤ 200 B single
//     line) so a core bug can never put an arbitrary key or an oversized paste on the wire (P-INPUT-12, P-INPUT-27, P-TUI-02);
//   - holds the queue for the primitive's gap before the next primitive (key `gapAfterMs`, ≥ `escGapMs` after every Escape
//     P-REV-45; `chunkGapMs` after every paste/literal so a paste and a key never share an invocation window, P-TUI-01) — the
//     gap only spaces tmux invocations, it decides nothing;
//   - tracks the external-editor handoff: while `awaitEditorConsumed` is pending nobody may capture (ICR 0001 item 3d, LP-01:
//     the pane is on the alternate screen) and no key is sent (LP-02: an Enter before the editor exits is lost). Pollers read
//     `EditorGate` for that.
// `input.done` never carries prompt text; `detail` is an error kind / short reason only (SEC §8).

import { isCcdError, CCD_ERROR_CODES } from '../model/errors.js';
import type { CcdErrorCode } from '../model/errors.js';
import type { CaptureUntil, InputPrimitive, Intent, TmuxKeyName } from '../model/intents.js';
import type { Logger } from '../model/logger.js';
import type { ObservationInput } from '../model/observation.js';
import type { Clock } from '../model/time.js';
import type { EditorInjector, TmuxPane } from '../platform/ports.js';
import type { ClaudeProfile } from '../channels/profiles/index.js';
import { classifyFrame } from '../channels/screen/classify.js';
import { normalizeLine } from '../channels/screen/normalize-text.js';

/** Where L3 executors hand their observations (the kernel queue stamps `seq`). */
export type ObservationSink = (o: ObservationInput) => void;

/** What pollers need to know about the editor handoff (ICR 0001 item 3). */
export interface EditorGate {
  /** An `editorStage` succeeded and its handoff has not finished yet (captures are tagged `editorPhase`). */
  editorPhase(): boolean;
  /** `awaitEditorConsumed` is pending: the pane shows the external editor; do not capture (ICR 0001 item 3d). */
  awaitingEditor(): boolean;
  /** Resolves when no `awaitEditorConsumed` is pending (immediately if none). */
  whenEditorIdle(): Promise<void>;
}

export type InputIntent = Extract<Intent, { kind: 'input' }>;

export interface InputExecutorOptions {
  clock: Clock;
  /** The Claude pane; undefined before launch or after it is gone. */
  pane: () => TmuxPane | undefined;
  editor: EditorInjector;
  emit: ObservationSink;
  /** Used by `captureText` to find the modal region. */
  profile: ClaudeProfile;
  /** Applied to `captureText` output (session/redact.ts in production). Default: identity. */
  redact?: (text: string) => string;
  logger?: Logger;
  /** Gap after each paste chunk / literal (CoreConfig.input.chunkGapMs, default 30). */
  chunkGapMs?: number;
  /** Minimum gap after every Escape (CoreConfig.timeouts.escGapMs, default 250; P-REV-45). */
  escGapMs?: number;
}

export interface InputExecutor extends EditorGate {
  /** Enqueue one `input` intent. Resolves once its `input.done` was emitted (or the executor closed). Never rejects. */
  execute(intent: InputIntent): Promise<void>;
  /** Resolves when the queue is empty and the last gap elapsed. */
  idle(): Promise<void>;
  /** Number of intents queued or running. */
  pending(): number;
  /** Stop: queued intents are dropped (no `input.done`), sleeps are aborted, the editor is disarmed. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Limits (§2.6 InputPrimitive comments; IN §3.2; TD §3)
// ---------------------------------------------------------------------------------------------------------------------------

const PASTE_CHUNK_MAX_BYTES = 400;
const PASTE_CHUNK_MAX_LF = 2;
const TYPE_LITERAL_MAX_BYTES = 200;
const MODAL_OUTPUT_MAX_CHARS = 16 * 1024;
const DEFAULT_CHUNK_GAP_MS = 30;
const DEFAULT_ESC_GAP_MS = 250;
/** Poll interval while waiting for Claude to leave the editor's alternate screen after done-<nonce> (LP-01). */
const EDITOR_EXIT_POLL_MS = 10;

/** The closed key list of §2.6 (`TmuxKeyName`). Anything else is refused before tmux sees it. */
const KEYS: ReadonlySet<string> = new Set<TmuxKeyName>([
  'Enter',
  'Escape',
  'BTab',
  'Up',
  'Down',
  'C-g',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

/** C0 except LF/TAB, DEL, C1: never inside a paste (D-16 sanitizer output). */
const PASTE_FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
/** A literal is a single line without any control character. */
const LITERAL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f]/u;

const CODES: ReadonlySet<string> = new Set<string>(CCD_ERROR_CODES);

class PrimitiveError extends Error {
  constructor(
    readonly code: CcdErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PrimitiveError';
  }
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function isWellFormed(s: string): boolean {
  // String.prototype.isWellFormed is ES2024; @types/node@20 / lib ES2023 do not declare it.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/**
 * Validate a primitive against §2.6 before anything reaches tmux. Throws PrimitiveError(E_INPUT_INVALID). The intent is
 * typed, but it is re-checked field by field as untyped data (defense in depth against a core bug or a forged intent).
 */
export function validatePrimitive(p: InputPrimitive): void {
  const bad = (detail: string): never => {
    throw new PrimitiveError('E_INPUT_INVALID', detail);
  };
  const u = p as unknown as Record<string, unknown>;
  const text = (): string => {
    const t = u['text'];
    if (typeof t !== 'string' || !isWellFormed(t)) return bad('notWellFormed');
    return t;
  };
  const num = (k: string): void => {
    const v = u[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad(`bad:${k}`);
  };
  switch (u['kind']) {
    case 'key': {
      const k = u['key'];
      if (typeof k !== 'string' || !KEYS.has(k)) bad('keyNotAllowed');
      num('gapAfterMs');
      return;
    }
    case 'pasteChunk': {
      if (u['bracketed'] !== true) bad('pasteNotBracketed');
      const t = text();
      if (utf8Bytes(t) > PASTE_CHUNK_MAX_BYTES) bad('pasteTooLong');
      if ((t.match(/\n/gu)?.length ?? 0) > PASTE_CHUNK_MAX_LF) bad('pasteTooManyLines');
      if (t.includes('\r') || PASTE_FORBIDDEN.test(t)) bad('controlChar');
      return;
    }
    case 'typeLiteral': {
      const t = text();
      if (utf8Bytes(t) > TYPE_LITERAL_MAX_BYTES) bad('literalTooLong');
      if (LITERAL_FORBIDDEN.test(t)) bad('controlChar');
      return;
    }
    case 'editorStage':
      text();
      return;
    case 'awaitEditorConsumed':
      num('timeoutMs');
      return;
    case 'captureText':
      if (u['rows'] !== 'modal') bad('badRows');
      if (u['until'] !== undefined && u['until'] !== 'usageReady') bad('badUntil');
      if (u['timeoutMs'] !== undefined) num('timeoutMs');
      return;
    case 'exitCopyMode':
      return;
    default:
      bad('unknownPrimitive');
  }
}

/** Map a thrown adapter error to an internal code + a text-free detail (never the message: it may echo input). */
export function errorOf(e: unknown): { code: CcdErrorCode; detail: string } {
  if (e instanceof PrimitiveError) return { code: e.code, detail: e.detail };
  if (isCcdError(e)) {
    const reason = e.details?.['reason'];
    return { code: e.code, detail: typeof reason === 'string' ? reason : e.code };
  }
  if (typeof e === 'object' && e !== null) {
    const o = e as { suggestedCode?: unknown; kind?: unknown; name?: unknown; reason?: unknown };
    const kind = typeof o.kind === 'string' ? o.kind : typeof o.name === 'string' ? o.name : 'Error';
    const reason = typeof o.reason === 'string' ? `:${o.reason}` : '';
    if (typeof o.suggestedCode === 'string' && CODES.has(o.suggestedCode))
      return { code: o.suggestedCode as CcdErrorCode, detail: `${kind}${reason}`.slice(0, 80) };
    return { code: 'E_INPUT_GATED', detail: `${kind}${reason}`.slice(0, 80) };
  }
  return { code: 'E_INPUT_GATED', detail: 'unknownError' };
}

function errKind(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const k = (e as { kind?: unknown }).kind;
  return typeof k === 'string' ? k : undefined;
}

/**
 * The modal region of a capture as normalized text (§3.6 Commands `captureModal`): the classifier's dialog (title, question,
 * body, options, footer) when it found one, else every visible line with blank edges trimmed.
 */
export function modalText(lines: readonly string[], status: Parameters<typeof classifyFrame>[1], profile: ClaudeProfile): string {
  const out: string[] = [];
  const snap = classifyFrame(lines, status, profile);
  const d = snap.dialog;
  if (d !== undefined) {
    if (d.title !== undefined && d.title !== '') out.push(d.title);
    if (d.question !== undefined && d.question !== '' && d.question !== d.title) out.push(d.question);
    for (const b of d.body) out.push(normalizeLine(b));
    for (const o of d.options) out.push(o.n !== undefined ? `${o.n}. ${o.label}` : o.label);
    if (d.footer !== undefined && d.footer !== '') out.push(d.footer);
  }
  if (out.every((l) => l.trim() === '')) {
    out.length = 0;
    for (const l of lines) out.push(normalizeLine(l));
  }
  let a = 0;
  let b = out.length;
  while (a < b && (out[a] ?? '').trim() === '') a++;
  while (b > a && (out[b - 1] ?? '').trim() === '') b--;
  return out.slice(a, b).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------------------------------------

const CAPTURE_UNTIL_POLL_MS = 150;
const CAPTURE_UNTIL_DEFAULT_MS = 5_000;

export function createInputExecutor(o: InputExecutorOptions): InputExecutor {
  // ICR 0040: every named criterion maps to a profile predicate (Record keeps the mapping total for CaptureUntil).
  const READY: Readonly<Record<CaptureUntil, (text: string) => boolean>> = { usageReady: (t) => o.profile.usage.ready(t) };
  const readyCheck = (until: CaptureUntil): ((text: string) => boolean) => READY[until];

  const clock = o.clock;
  const chunkGapMs = Math.max(0, o.chunkGapMs ?? DEFAULT_CHUNK_GAP_MS);
  const escGapMs = Math.max(0, o.escGapMs ?? DEFAULT_ESC_GAP_MS);
  const redact = o.redact ?? ((s: string) => s);
  const abort = new AbortController();
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let closed = false;
  /** Nonce of the staged editor text that has not been awaited yet. */
  let stagedNonce: string | undefined;
  let phase = false;
  let awaiting = false;
  let editorWaiters: (() => void)[] = [];

  const setAwaiting = (v: boolean): void => {
    awaiting = v;
    if (!v) {
      const w = editorWaiters;
      editorWaiters = [];
      for (const f of w) f();
    }
  };

  const done = (intent: InputIntent, r: { ok: true; output?: string } | { ok: false; code: CcdErrorCode; detail: string }): void => {
    if (closed) return;
    const p: Extract<ObservationInput, { kind: 'input.done' }>['p'] = {
      intentId: intent.id,
      job: intent.job,
      primitive: intent.primitive.kind,
      ok: r.ok,
    };
    if (r.ok) {
      if (r.output !== undefined) p.output = r.output;
    } else {
      p.error = r.code;
      p.detail = r.detail;
    }
    o.emit({
      kind: 'input.done',
      meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'self', origin: { kind: 'self', intentId: intent.id } },
      p,
    });
  };

  const sleep = async (ms: number): Promise<void> => {
    if (ms <= 0 || closed) return;
    try {
      await clock.sleep(ms, abort.signal);
    } catch {
      /* aborted by close() */
    }
  };

  const paneOrThrow = (): TmuxPane => {
    const pane = o.pane();
    if (pane === undefined) throw new PrimitiveError('E_SESSION_EXITED', 'noPane');
    return pane;
  };

  /** P-TMUX-21/P-TMUX-45: dead/gone → refuse; copy mode → leave it first. */
  const ensureWritable = async (pane: TmuxPane): Promise<void> => {
    let st = await pane.status();
    if (!st.exists) throw new PrimitiveError('E_SESSION_EXITED', 'paneGone');
    if (st.dead) throw new PrimitiveError('E_SESSION_EXITED', 'paneDead');
    if (st.inMode) {
      o.logger?.debug('input-executor: leaving copy mode before input', { paneId: pane.info.paneId });
      await pane.exitCopyMode();
      st = await pane.status();
      if (st.inMode) throw new PrimitiveError('E_INPUT_GATED', 'copyMode');
    }
  };

  /** One write; a copy-mode race (entered between status and send) is retried once after leaving copy mode. */
  const write = async (pane: TmuxPane, fn: () => Promise<void>): Promise<void> => {
    await ensureWritable(pane);
    try {
      await fn();
    } catch (e) {
      if (errKind(e) !== 'TmuxPaneInMode') throw e;
      await pane.exitCopyMode();
      await ensureWritable(pane);
      await fn();
    }
  };

  /** Polls the pane until `alternate_on` is 0 or `deadline` passes; a missing/failing pane ends the wait. */
  const untilMainScreen = async (deadline: number): Promise<void> => {
    for (;;) {
      if (closed) return;
      const pane = o.pane();
      if (pane === undefined) return;
      try {
        const st = await pane.status();
        if (!st.exists || st.dead || !st.alternateOn) return;
      } catch {
        return;
      }
      const left = deadline - clock.now();
      if (left <= 0) {
        o.logger?.warn('input-executor: pane still on the alternate screen after the editor consumed the prompt', {
          paneId: pane.info.paneId,
        });
        return;
      }
      await sleep(Math.min(EDITOR_EXIT_POLL_MS, left));
    }
  };

  /** Runs the primitive; returns the gap to hold after it and an optional output. */
  const run = async (p: InputPrimitive): Promise<{ gapMs: number; output?: string }> => {
    validatePrimitive(p);
    // Anything but the C-g that opens the editor and its await ends a stale editor phase (fallback paths, keys path).
    if (p.kind !== 'awaitEditorConsumed' && !(p.kind === 'key' && p.key === 'C-g') && p.kind !== 'editorStage') phase = false;
    switch (p.kind) {
      case 'editorStage': {
        phase = false;
        stagedNonce = undefined;
        const { nonce } = await o.editor.stage(p.text);
        stagedNonce = nonce;
        phase = true;
        return { gapMs: 0 };
      }
      case 'awaitEditorConsumed': {
        const nonce = stagedNonce;
        if (nonce === undefined) throw new PrimitiveError('E_SUBMIT_UNCONFIRMED', 'editorNotStaged');
        stagedNonce = undefined;
        setAwaiting(true);
        let ok: boolean;
        try {
          const deadline = clock.now() + Math.max(0, p.timeoutMs);
          ok = await o.editor.consumed(nonce, p.timeoutMs);
          // done-<nonce> appears just before the editor exits; Claude leaves the alternate screen only after reaping it
          // (LP-01). Hold the handoff (no capture, no key) until the pane is back on the main screen, bounded by the same
          // budget, so the core's verifyStaged frame never lands on the editor screen (ICR 0018).
          if (ok) await untilMainScreen(deadline);
        } finally {
          setAwaiting(false);
          phase = false;
        }
        if (!ok) {
          await o.editor.disarm().catch(() => undefined);
          throw new PrimitiveError('E_SUBMIT_UNCONFIRMED', 'editorTimeout');
        }
        return { gapMs: 0 };
      }
      case 'key': {
        const pane = paneOrThrow();
        await write(pane, () => pane.sendKey(p.key));
        const gap = p.key === 'Escape' ? Math.max(p.gapAfterMs, escGapMs) : p.gapAfterMs;
        return { gapMs: gap };
      }
      case 'pasteChunk': {
        const pane = paneOrThrow();
        await write(pane, () => pane.paste(p.text));
        return { gapMs: chunkGapMs };
      }
      case 'typeLiteral': {
        const pane = paneOrThrow();
        await write(pane, () => pane.typeLiteral(p.text));
        return { gapMs: chunkGapMs };
      }
      case 'captureText': {
        const pane = paneOrThrow();
        let c = await pane.capture();
        // P-TMUX-45 / P-SCREEN-21: a capture in copy mode shows scrollback, not the modal. Leave copy mode and capture
        // again; a pane that is dead or gone has no modal to report.
        if (c.status.inMode) {
          await pane.exitCopyMode();
          c = await pane.capture();
          if (c.status.inMode) throw new PrimitiveError('E_INPUT_GATED', 'copyMode');
        }
        if (!c.status.exists) throw new PrimitiveError('E_SESSION_EXITED', 'paneGone');
        if (c.status.dead) throw new PrimitiveError('E_SESSION_EXITED', 'paneDead');
        let raw = modalText(c.lines, c.status, o.profile);
        // ICR 0040: appearance-based wait. Re-capture the still-open modal until the profile says it is ready, bounded by
        // timeoutMs; on timeout the last capture is returned and the caller's parser decides (e.g. usage `partial`).
        if (p.until !== undefined) {
          const ready = readyCheck(p.until);
          const deadline = clock.now() + Math.max(0, p.timeoutMs ?? CAPTURE_UNTIL_DEFAULT_MS);
          while (!ready(raw) && clock.now() < deadline && !closed) {
            await sleep(Math.min(CAPTURE_UNTIL_POLL_MS, deadline - clock.now()));
            const n = await pane.capture();
            if (!n.status.exists || n.status.dead) throw new PrimitiveError('E_SESSION_EXITED', 'paneGone');
            raw = modalText(n.lines, n.status, o.profile);
          }
        }
        let text = redact(raw);
        if (text.length > MODAL_OUTPUT_MAX_CHARS) text = text.slice(0, MODAL_OUTPUT_MAX_CHARS);
        return { gapMs: 0, output: text };
      }
      case 'exitCopyMode': {
        const pane = paneOrThrow();
        const st = await pane.status();
        if (st.inMode) await pane.exitCopyMode();
        return { gapMs: 0 };
      }
    }
  };

  const step = async (intent: InputIntent): Promise<void> => {
    if (closed) return;
    let gapMs = 0;
    try {
      const r = await run(intent.primitive);
      gapMs = r.gapMs;
      done(intent, r.output !== undefined ? { ok: true, output: r.output } : { ok: true });
    } catch (e) {
      const { code, detail } = errorOf(e);
      if (intent.primitive.kind === 'editorStage') phase = false;
      o.logger?.warn('input-executor: primitive failed', { primitive: intent.primitive.kind, code, detail, job: intent.job });
      done(intent, { ok: false, code, detail });
    }
    await sleep(gapMs);
  };

  return {
    execute(intent: InputIntent): Promise<void> {
      if (closed) return Promise.resolve();
      queued++;
      const next = chain
        .then(() => step(intent))
        .finally(() => {
          queued--;
        });
      chain = next.catch(() => undefined);
      return chain;
    },
    idle(): Promise<void> {
      return chain;
    },
    pending(): number {
      return queued;
    },
    editorPhase(): boolean {
      return phase;
    },
    awaitingEditor(): boolean {
      return awaiting;
    },
    whenEditorIdle(): Promise<void> {
      if (!awaiting || closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        editorWaiters.push(resolve);
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      abort.abort();
      setAwaiting(false);
      phase = false;
      stagedNonce = undefined;
      await o.editor.disarm().catch(() => undefined);
    },
  };
}
