// platform/env/env-port.ts — EnvPort (DESIGN.md §2.7.1). The only place that reads the host process environment for L0.
// `snapshot()` is a copy with string values only; callers build child envs from an allowlist and never spread it (D-25).
import { lstat, realpath } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import type { EnvPort } from '../ports.js';

export function createEnvPort(): EnvPort {
  return {
    snapshot(): Readonly<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
      return Object.freeze(out);
    },
    homeDir: () => homedir(),
    userName(): string {
      try {
        return userInfo().username;
      } catch {
        return process.env['USER'] ?? process.env['LOGNAME'] ?? '';
      }
    },
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    platform(): 'darwin' | 'linux' | 'other' {
      return process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'other';
    },
    tmpDir: () => tmpdir(),
    execPath: () => process.execPath,
    nodeVersion: () => process.versions.node,
    realpath: (p: string) => realpath(p),
    async lstat(p: string) {
      try {
        const st = await lstat(p);
        return { isSymlink: st.isSymbolicLink(), isFile: st.isFile(), isDir: st.isDirectory() };
      } catch (e) {
        if (isNoEnt(e)) return undefined;
        throw e;
      }
    },
    timeZone(): string {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return 'UTC';
      }
    },
  };
}

function isNoEnt(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
