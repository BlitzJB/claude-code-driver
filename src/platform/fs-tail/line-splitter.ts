// platform/fs-tail/line-splitter.ts — byte-level 0x0A splitter with a pending Buffer list and maxLineBytes discard mode,
// plus per-line classification (lazy parse). DESIGN.md §1.2, §5.3; transcript-tail.md §2.3, §3, §12.
//
// Mitigations implemented here:
// - P-TAIL-06/P-TAIL-08 split on byte 0x0A, keep the remainder; the remainder is reported by the follower only at close.
// - P-TAIL-09 pending is a Buffer[] list joined once with Buffer.concat (O(n) per line, never string concatenation).
// - P-TAIL-10 only complete lines are ever parsed; a prefix that happens to be valid JSON is never looked at.
// - P-TAIL-11 a trailing '\r' and leading NUL bytes are stripped before decoding.
// - P-TAIL-12 a line longer than maxLineBytes switches to discard mode (bytes counted, not kept) → `oversize`.
// - P-TAIL-13 decoding happens per complete line (0x0A never occurs inside a UTF-8 multibyte sequence).
// - P-TAIL-14 `{"type":"<skipped>"` prefix lines are reported without decoding or JSON.parse.
// - P-TAIL-40 pending slices are copied (Buffer.from) so the reusable read buffer is never retained.
// - P-TAIL-42 non-object JSON → `malformed{not-object}`; missing `type` → undefined; unknown types pass through.

export interface LineSink {
  /** A complete line `buf[start, end)` (without the '\n') starting at absolute file offset `offset`. `buf` is only valid
   *  during the call (it may be the caller's reusable read buffer). */
  line(buf: Buffer, start: number, end: number, offset: number): void;
  /** A line longer than maxLineBytes was dropped; `bytes` excludes the '\n'. */
  oversize(offset: number, bytes: number): void;
}

const NL = 0x0a;

export class LineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private lineStart = 0; // absolute offset where the current (incomplete) line starts
  private pos = 0; // absolute offset of the next byte to be pushed
  private discarding = false;
  private skipping = false;

  constructor(private readonly maxLineBytes: number) {
    if (!(maxLineBytes > 0)) throw new RangeError('maxLineBytes must be > 0');
  }

  /** Restart at absolute `pos` (a line boundary). `skipPartial` drops bytes up to the first '\n' silently, for a start
   *  position that is known to be inside a line (startAt:'end' on a file whose last line is still being written). */
  reset(pos: number, o: { skipPartial?: boolean } = {}): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.discarding = false;
    this.skipping = o.skipPartial === true;
    this.pos = pos;
    this.lineStart = pos;
  }

  /** Offset just past the last consumed '\n' (complete lines only). */
  get consumed(): number {
    return this.lineStart;
  }
  /** Offset of the next byte expected by push(). */
  get position(): number {
    return this.pos;
  }
  /** The incomplete last line held (or being discarded), if any. */
  remainder(): { offset: number; bytes: number } | undefined {
    if (this.skipping) return undefined;
    const bytes = this.pos - this.lineStart;
    return bytes > 0 ? { offset: this.lineStart, bytes } : undefined;
  }

  /** Feed `chunk[start, end)`, which must be the bytes at absolute offset `position`. Emits synchronously. */
  push(chunk: Buffer, start: number, end: number, sink: LineSink): void {
    let i = start;
    while (i < end) {
      const rel = chunk.subarray(i, end).indexOf(NL);
      if (rel === -1) {
        const n = end - i;
        if (this.skipping) {
          // dropped: before the first line boundary
        } else if (this.discarding) {
          this.pendingBytes += n;
        } else if (this.pendingBytes + n > this.maxLineBytes) {
          this.pending = [];
          this.discarding = true;
          this.pendingBytes += n;
        } else {
          this.pending.push(Buffer.from(chunk.subarray(i, end))); // copy: the read buffer is reused (P-TAIL-40)
          this.pendingBytes += n;
        }
        this.pos += n;
        if (this.skipping) this.lineStart = this.pos;
        return;
      }
      const nl = i + rel;
      const seg = nl - i;
      const lineOffset = this.lineStart;
      if (this.skipping) {
        this.skipping = false;
      } else if (this.discarding || this.pendingBytes + seg > this.maxLineBytes) {
        sink.oversize(lineOffset, this.pendingBytes + seg);
      } else if (this.pendingBytes === 0) {
        sink.line(chunk, i, nl, lineOffset);
      } else {
        this.pending.push(chunk.subarray(i, nl)); // concat below copies it
        const whole = Buffer.concat(this.pending, this.pendingBytes + seg);
        this.pending = [];
        sink.line(whole, 0, whole.length, lineOffset);
      }
      this.pending = [];
      this.pendingBytes = 0;
      this.discarding = false;
      this.pos += seg + 1;
      this.lineStart = this.pos;
      i = nl + 1;
    }
  }
}

export type ClassifiedLine =
  | { kind: 'empty' }
  | { kind: 'parsed'; type: string | undefined; json: object }
  | { kind: 'skipped'; type: string }
  | { kind: 'malformed'; reason: 'json' | 'not-object'; preview: string };

const TYPE_PREFIX = Buffer.from('{"type":"', 'latin1');
const MAX_TYPE_LEN = 64;
const PREVIEW_BYTES = 200;

/** `{"type":"x"` at the very start of the line → 'x' (no escapes), else undefined. Correctness never depends on it: a
 *  miss simply falls back to a full parse. */
function prefixType(buf: Buffer, s: number, e: number): string | undefined {
  const p = TYPE_PREFIX.length;
  if (e - s <= p || buf.compare(TYPE_PREFIX, 0, p, s, s + p) !== 0) return undefined;
  const limit = Math.min(e, s + p + MAX_TYPE_LEN + 1);
  for (let j = s + p; j < limit; j++) {
    const c = buf[j];
    if (c === 0x22) return j > s + p ? buf.toString('utf8', s + p, j) : undefined;
    if (c === 0x5c) return undefined; // escape: let JSON.parse decide
  }
  return undefined;
}

/** Classify one complete line `buf[start, end)`. */
export function classifyLine(buf: Buffer, start: number, end: number, skipParseTypes: ReadonlySet<string>): ClassifiedLine {
  let s = start;
  while (s < end && buf[s] === 0) s++; // leading NULs (Claude's own reader skips them)
  let e = end;
  if (e > s && buf[e - 1] === 0x0d) e--; // trailing CR
  if (s >= e) return { kind: 'empty' };
  if (skipParseTypes.size > 0) {
    const t = prefixType(buf, s, e);
    if (t !== undefined && skipParseTypes.has(t)) return { kind: 'skipped', type: t };
  }
  let json: unknown;
  try {
    json = JSON.parse(buf.toString('utf8', s, e));
  } catch {
    return { kind: 'malformed', reason: 'json', preview: buf.toString('utf8', s, Math.min(e, s + PREVIEW_BYTES)) };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json))
    return { kind: 'malformed', reason: 'not-object', preview: buf.toString('utf8', s, Math.min(e, s + PREVIEW_BYTES)) };
  const t = (json as Record<string, unknown>)['type'];
  return { kind: 'parsed', type: typeof t === 'string' ? t : undefined, json };
}
