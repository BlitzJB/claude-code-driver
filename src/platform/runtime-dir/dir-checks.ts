// platform/runtime-dir/dir-checks.ts — the SEC §9 directory rule shared by the runtime dir, the state store, the settings
// file writer and the editor injector: lstat → directory, not a symlink, owned by our uid, (mode & 0o077) === 0 (P-SEC-24).
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { UnsafeDirReason } from './errors.js';

export function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

/** `undefined` when the directory is safe, else the first failing reason. */
export async function privateDirProblem(path: string, uid: number = currentUid()): Promise<UnsafeDirReason | undefined> {
  if (!isAbsolute(path)) return 'notAbsolute';
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'notDirectory';
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isDirectory()) return 'notDirectory';
  if (uid >= 0 && st.uid !== uid) return 'owner';
  if ((st.mode & 0o077) !== 0) return 'mode';
  return undefined;
}

/** True for the ENOENT family. */
export function isNoEnt(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
