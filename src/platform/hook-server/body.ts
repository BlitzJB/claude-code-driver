// platform/hook-server/body.ts — streamed request bodies with a hard byte cap and a truncation flag (DESIGN.md §3.5;
// HT §8, P-HOOK-48/49/50). Over the cap the rest is drained and discarded (constant memory) and the caller still answers
// 200: never 413, which would show a `hook error` notice and lose a decision path.
//
// Loaded inside the hook worker by a computed `import()`: node:* imports and erasable syntax only (see auth.ts).
import type { Readable } from 'node:stream';

/** Default cap: 32 MiB (§3.5; rev 2 §10 C4). The factory option `maxBodyBytes` overrides it. */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Collects chunks up to `maxBytes`; past the cap it only counts. */
export class CappedAccumulator {
  readonly maxBytes: number;
  #chunks: Buffer[] = [];
  #kept = 0;
  #bytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
  }

  push(chunk: Buffer): void {
    this.#bytes += chunk.length;
    if (this.#truncated) return;
    if (this.#kept + chunk.length > this.maxBytes) {
      this.#truncated = true;
      this.#chunks = []; // release what we had: a truncated body is never parsed
      this.#kept = 0;
      return;
    }
    this.#chunks.push(chunk);
    this.#kept += chunk.length;
  }

  /** Total bytes seen, including the discarded tail. */
  get bytes(): number {
    return this.#bytes;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  /** The kept bytes, or undefined when truncated. */
  concat(): Buffer | undefined {
    if (this.#truncated) return undefined;
    return this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#kept);
  }
}

export interface BodyResult {
  bytes: number;
  truncated: boolean;
  /** Undefined when truncated. */
  data: Buffer | undefined;
}

/**
 * Reads `stream` to its end. Resolves with the body (or the truncation flag) once the upload is complete, so the caller
 * answers only after the whole body was received (rev 2 §10 G18). Rejects when the client aborts mid-upload.
 */
export function readBody(stream: Readable, maxBytes: number): Promise<BodyResult> {
  return new Promise<BodyResult>((resolve, reject) => {
    const acc = new CappedAccumulator(maxBytes);
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    stream.on('data', (chunk: Buffer | string) => {
      acc.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ bytes: acc.bytes, truncated: acc.truncated, data: acc.concat() });
    });
    stream.on('error', (err: Error) => {
      fail(err);
    });
    stream.on('aborted', () => {
      fail(new Error('request aborted'));
    });
    stream.on('close', () => {
      fail(new Error('stream closed before end'));
    });
  });
}

/** `JSON.parse` that reports failure instead of throwing. */
export function tryParseJson(data: Buffer | string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}
