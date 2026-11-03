// platform/process/errors.ts — typed L0 errors of the process adapters (DESIGN.md §2.7 "L0 error types").
// They are duck-typed by `name` in `session/errors-map.ts` (session may import platform types only). Messages are built from
// typed fields only: never argv, env values or child output (P-SEC-40).

/** The child could not be started at all (ENOENT, EACCES, …). `args` are deliberately not kept. */
export class ProcessSpawnError extends Error {
  override readonly name = 'ProcessSpawnError';
  constructor(
    readonly file: string,
    readonly errno: string,
  ) {
    super(`could not start ${file}: ${errno}`);
  }
}

/** §2.7: `ClaudeNotFound`. Thrown by callers that need a binary; `ClaudeBinaryPort.resolve` itself returns `undefined`. */
export class ClaudeNotFound extends Error {
  override readonly name = 'ClaudeNotFound';
  constructor(readonly searched: readonly string[]) {
    super(`claude binary not found (searched: ${searched.join(', ')})`);
  }
}

/** `claude --version` produced no parsable `<x.y.z> (Claude Code)` line. */
export class ClaudeVersionUnreadable extends Error {
  override readonly name = 'ClaudeVersionUnreadable';
  constructor(
    readonly exe: string,
    readonly exitCode: number | null,
    readonly timedOut: boolean,
  ) {
    super(`could not read the version of ${exe} (exit ${String(exitCode)}${timedOut ? ', timed out' : ''})`);
  }
}

/** `claude auth status --json` gave no usable answer. `timeout` means it is still running (never killed early, P-LIFE-38). */
export class ClaudeAuthStatusUnreadable extends Error {
  override readonly name = 'ClaudeAuthStatusUnreadable';
  constructor(
    readonly reason: 'timeout' | 'unparseable',
    readonly exitCode: number | null,
  ) {
    super(`claude auth status: ${reason} (exit ${String(exitCode)})`);
  }
}

/** The owner-watch could not be started (bad config, missing script, spawn failure). */
export class OwnerWatchStartFailed extends Error {
  override readonly name = 'OwnerWatchStartFailed';
  constructor(readonly reason: string) {
    super(`owner-watch start failed: ${reason}`);
  }
}
