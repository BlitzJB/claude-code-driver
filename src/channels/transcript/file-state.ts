// channels/transcript/file-state.ts — per-file normalizer state (DESIGN.md §1.2; RC §2.3 "Normalizer rules").
// The transcript normalizer is stateless except for this: assistant entries carry no promptId (TF §4.1), so the current
// promptId of each file is remembered from its latest user entry; metadata entries are folded last-wins (TF §3, §5.13
// TF §9 item 18); `api-request` digests are remembered to recognise retries (TF §4.6). The state is keyed per file and reset
// when the file is re-read from the start (rewrite / full rescan / reopen at 0), so it is a pure function of one file's
// ordered line stream and therefore replayable.

import type { FileKey } from '../../platform/ports.js';

/** Stable string form of a FileKey (used as `ObsOrigin.transcript.fileKey` and by `TranscriptNormalizer.resetFile`). */
export function fileKeyString(k: FileKey): string {
  return k.kind === 'main' ? `main:${k.sessionId}` : `agent:${k.sessionId}:${k.agentId}`;
}

/** Bound on remembered `requestDigest`s per file (retries share the digest of the attempt just before them). */
const MAX_DIGESTS = 64;

export interface FileState {
  /** promptId of the latest user entry in this file (stamps assistant-derived observations). */
  promptId?: string;
  /** Last local command name seen (`<command-name>/x</command-name>`), for a following stdout-only entry. */
  lastCommandName?: string;
  /** Last-wins folds of metadata entries (an observation is emitted only on change). */
  permissionMode?: string;
  /** Whether the latest `last-prompt` was a withdrawal (zero/null leaf + explicit). */
  leafWithdrawn: boolean;
  relocatedCwd?: string;
  continuedIn?: string;
  /** Path of the file as last reported by the tail (`opened` / `moved`). */
  path?: string;
  /** Recently seen `api-request.requestDigest`s, oldest first. */
  digests: string[];
}

function newFileState(): FileState {
  return { leafWithdrawn: false, digests: [] };
}

export function rememberDigest(s: FileState, digest: string): void {
  if (s.digests.includes(digest)) return;
  s.digests.push(digest);
  if (s.digests.length > MAX_DIGESTS) s.digests.shift();
}

export class FileStates {
  readonly #files = new Map<string, FileState>();

  get(key: string): FileState {
    let s = this.#files.get(key);
    if (s === undefined) {
      s = newFileState();
      this.#files.set(key, s);
    }
    return s;
  }

  /** Forget everything about `key` except its last known path (the file is about to be re-read from offset 0). */
  reset(key: string): void {
    const path = this.#files.get(key)?.path;
    const fresh = newFileState();
    if (path !== undefined) fresh.path = path;
    this.#files.set(key, fresh);
  }

  delete(key: string): void {
    this.#files.delete(key);
  }

  get size(): number {
    return this.#files.size;
  }
}
