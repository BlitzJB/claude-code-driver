// platform/process/which.ts — executable lookup on $PATH plus the well-known dirs (TD rule 19, P-TMUX-41).
// launchd/cron and some IDE hosts start Node with a PATH that lacks /opt/homebrew/bin; callers pass KNOWN_BIN_DIRS.
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const KNOWN_BIN_DIRS: readonly string[] = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);

/** True when `p` is a regular file the current user may execute (symlinks are followed). */
export async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    if (!st.isFile()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The ordered, de-duplicated list of absolute directories searched for `bin`. Relative PATH entries are ignored. */
export function searchDirs(pathEnv: string | undefined, extraDirs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of [...(pathEnv ?? '').split(delimiter), ...extraDirs]) {
    if (d === '' || !isAbsolute(d)) continue;
    const r = resolve(d);
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

/**
 * Resolve `bin` to an absolute executable path. A `bin` containing `/` is checked as given (made absolute against `cwd`).
 * Returns `undefined` when nothing matches.
 */
export async function which(
  bin: string,
  o: { pathEnv: string | undefined; extraDirs: readonly string[]; cwd?: string },
): Promise<string | undefined> {
  if (bin === '' || bin.includes('\0')) return undefined;
  if (bin.includes('/')) {
    const p = isAbsolute(bin) ? bin : resolve(o.cwd ?? process.cwd(), bin);
    return (await isExecutableFile(p)) ? p : undefined;
  }
  for (const dir of searchDirs(o.pathEnv, o.extraDirs)) {
    const p = join(dir, bin);
    if (await isExecutableFile(p)) return p;
  }
  return undefined;
}
