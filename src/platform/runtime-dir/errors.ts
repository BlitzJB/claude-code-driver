// platform/runtime-dir/errors.ts — typed L0 errors for runtime/state directories (DESIGN.md §2.7, SEC §9).
// Duck-typed by `name` in `session/errors-map.ts` (→ E_UNSAFE_RUNTIME_DIR / E_SOCKET_PATH_TOO_LONG).

export type UnsafeDirReason = 'missing' | 'notDirectory' | 'symlink' | 'owner' | 'mode' | 'notAbsolute' | 'notOurs';

/** P-SEC-24: a runtime/state dir that is not a real 0700 directory owned by us. */
export class UnsafeRuntimeDir extends Error {
  override readonly name = 'UnsafeRuntimeDir';
  constructor(
    readonly path: string,
    readonly reason: UnsafeDirReason,
  ) {
    super(`unsafe runtime dir ${path}: ${reason}`);
  }
}

/** The longest socket path we create (`<sessionDir>/net.sock`) exceeds 100 bytes (macOS sun_path limit is 104). */
export class SocketPathTooLong extends Error {
  override readonly name = 'SocketPathTooLong';
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`socket path too long: ${bytes} bytes > ${limit}`);
  }
}
