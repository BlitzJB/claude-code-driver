// platform/settings/settings-file.ts — SettingsFilePort (DESIGN.md §2.7.2, §3.1 step 10, SEC §5.1/§5.2).
// O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600, fsync, sha256 of the exact bytes (P-HOOK-17, P-SEC-14). A pre-planted file or symlink
// makes the write fail (`SettingsFileExists`) instead of being followed. The parent must be a private 0700 dir we own (the
// session dir), so the file is never inside the project cwd. `matches` re-hashes for the post-SessionStart tamper check
// (P-SEC-31).
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { SettingsFilePort } from '../ports.js';
import { currentUid, privateDirProblem } from '../runtime-dir/dir-checks.js';
import { UnsafeRuntimeDir } from '../runtime-dir/errors.js';
import { SettingsFileExists } from './errors.js';

export interface SettingsFileOptions {
  uid?: number;
}

/** Canonical text of a settings/config JSON file written by the library. */
export function serializeJsonFile(json: unknown): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function createSettingsFilePort(o: SettingsFileOptions = {}): SettingsFilePort {
  const uid = o.uid ?? currentUid();
  return {
    async writeExclusive(path, json) {
      if (!isAbsolute(path)) throw new UnsafeRuntimeDir(path, 'notAbsolute');
      const problem = await privateDirProblem(dirname(path), uid);
      if (problem !== undefined) throw new UnsafeRuntimeDir(dirname(path), problem);
      const bytes = Buffer.from(serializeJsonFile(json), 'utf8');
      let fh;
      try {
        fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ELOOP') throw new SettingsFileExists(path);
        throw e;
      }
      try {
        await fh.chmod(0o600);
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return { sha256: sha256Hex(bytes), bytes: bytes.length };
    },

    async matches(path, sha256) {
      try {
        const st = await lstat(path);
        if (!st.isFile() || st.isSymbolicLink()) return false;
        const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          return sha256Hex(await fh.readFile()) === sha256.toLowerCase();
        } finally {
          await fh.close();
        }
      } catch {
        return false;
      }
    },
  };
}
