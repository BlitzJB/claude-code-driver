// platform/fs-tail/node-fs.ts — the TailFs seam (open/stat/read/readdir/realpath) and its real node:fs implementation
// (DESIGN.md §1.2, §2.7.4; transcript-tail.md §13 "fs is injectable"). Rev 2 (§10 C3): no watch() member at all — polling
// with fstat + pread is the only mechanism (P-TAIL-02, P-TAIL-17, P-TAIL-20 are N/A by construction).
//
// No shell-outs anywhere: slug directories start with '-' (P-TAIL-05), so every path goes straight to node:fs.

import { open as fsOpen, readdir as fsReaddir, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import type { Stats } from 'node:fs';

export interface TailStat {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}
export interface TailDirEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
}
export interface TailFileHandle {
  /** fstat of the open descriptor (the inode we hold, not whatever the path points at now). */
  stat(): Promise<TailStat>;
  /** pread: never moves a file position; returns bytes read (0 at EOF). */
  read(buf: Buffer, offset: number, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}
/** Errors are thrown as Node-style errors carrying a string `code` (ENOENT, EACCES, ENOTDIR, EMFILE, …). */
export interface TailFs {
  open(path: string): Promise<TailFileHandle>;
  stat(path: string): Promise<TailStat>; // follows symlinks
  readdir(path: string): Promise<TailDirEntry[]>;
  realpath(path: string): Promise<string>;
}

/** The errno code of a thrown fs error, or undefined for anything else. */
export function errnoOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = e.code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/** Short, content-free description of an error for `error` events (never includes file content). */
export function describeError(e: unknown): string {
  const code = errnoOf(e);
  if (e instanceof Error) return code !== undefined && !e.message.startsWith(code) ? `${code}: ${e.message}` : e.message;
  return code ?? String(e);
}

function toTailStat(s: Stats): TailStat {
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
}

/** The real TailFs over node:fs/promises. Read-only: opens with 'r' and never writes, truncates or unlinks. */
export const nodeTailFs: TailFs = {
  async open(path) {
    const fh = await fsOpen(path, 'r');
    return {
      async stat() {
        return toTailStat(await fh.stat());
      },
      async read(buf, offset, length, position) {
        const r = await fh.read(buf, offset, length, position);
        return r.bytesRead;
      },
      async close() {
        await fh.close();
      },
    };
  },
  async stat(path) {
    return toTailStat(await fsStat(path));
  },
  async readdir(path) {
    const ents = await fsReaddir(path, { withFileTypes: true });
    return ents.map((d) => ({
      name: d.name,
      kind: d.isFile() ? 'file' : d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'other',
    }));
  },
  async realpath(path) {
    return fsRealpath(path);
  },
};
