// platform/hook-server/errors.ts — typed L0 errors of the hook transport (DESIGN.md §2.7 "L0 error types").
// They are thrown (never emitted) and mapped to CcdError by `session/errors-map.ts` through their stable `name`
// (session may import platform only type-only, so the mapper must match on `name`, not on `instanceof`).

/** The hook worker thread exited while the session was open (§3.5: channel hooks down, the pane is killed; no restart). */
export class HookWorkerDied extends Error {
  override readonly name = 'HookWorkerDied';
  readonly exitCode: number | null;
  constructor(exitCode: number | null, detail?: string) {
    super(`hook worker exited${exitCode === null ? '' : ` with code ${exitCode}`}${detail === undefined ? '' : `: ${detail}`}`);
    this.exitCode = exitCode;
  }
}

/** The unix socket path does not fit `sun_path` (macOS 104 bytes incl. NUL, Linux 108; HT §6, P-HOOK-43). */
export class SocketPathTooLong extends Error {
  override readonly name = 'SocketPathTooLong';
  readonly bytes: number;
  readonly max: number;
  constructor(bytes: number, max: number) {
    super(`unix socket path is ${bytes} bytes, the limit is ${max}`);
    this.bytes = bytes;
    this.max = max;
  }
}

/** The session dir given to the hook transport is not a private (0700, own uid, no symlink) directory (SEC §2.5, P-HOOK-17). */
export class UnsafeRuntimeDir extends Error {
  override readonly name = 'UnsafeRuntimeDir';
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`unsafe runtime dir ${path}: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

/** Misuse or an unexpected start failure (EADDRINUSE, bad session id, start twice, fwd.json already present, …). */
export class HookTransportError extends Error {
  override readonly name = 'HookTransportError';
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}
