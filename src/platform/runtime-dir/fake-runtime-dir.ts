// platform/runtime-dir/fake-runtime-dir.ts — in-memory RuntimeDirPort with the same rules as the real one
// (ccd-XXXXXX names, socket path guard, only registry-named dirs swept).
import type { RuntimeDirPort } from '../ports.js';
import { SocketPathTooLong, UnsafeRuntimeDir, type UnsafeDirReason } from './errors.js';
import { LONGEST_SOCKET_NAME, MAX_SOCKET_PATH_BYTES } from './runtime-dir.js';

export interface FakeRuntimeDirOptions {
  root?: string;
  /** Make ensureRoot fail with this reason (P-SEC-24 scenarios). */
  unsafe?: UnsafeDirReason;
}

export class FakeRuntimeDir implements RuntimeDirPort {
  readonly root: string;
  readonly dirs = new Set<string>();
  readonly removed: string[] = [];
  unsafe: UnsafeDirReason | undefined;
  private n = 0;

  constructor(o: FakeRuntimeDirOptions = {}) {
    this.root = o.root ?? '/fake/run';
    this.unsafe = o.unsafe;
  }

  ensureRoot(): Promise<string> {
    if (this.unsafe !== undefined) return Promise.reject(new UnsafeRuntimeDir(this.root, this.unsafe));
    return Promise.resolve(this.root);
  }

  async createSessionDir(): Promise<string> {
    const r = await this.ensureRoot();
    const dir = `${r}/ccd-${(++this.n).toString(36).padStart(6, '0')}`;
    const bytes = Buffer.byteLength(`${dir}/${LONGEST_SOCKET_NAME}`);
    if (bytes > MAX_SOCKET_PATH_BYTES) throw new SocketPathTooLong(bytes, MAX_SOCKET_PATH_BYTES);
    this.dirs.add(dir);
    return dir;
  }

  removeSessionDir(path: string): Promise<void> {
    if (!/\/ccd-[A-Za-z0-9]{6}$/.test(path)) return Promise.reject(new UnsafeRuntimeDir(path, 'notOurs'));
    if (this.dirs.delete(path)) this.removed.push(path);
    return Promise.resolve();
  }

  async sweepStale(known: readonly { path: string; ownerAlive: boolean }[]): Promise<string[]> {
    const out: string[] = [];
    for (const k of known) {
      if (k.ownerAlive || !this.dirs.has(k.path)) continue;
      try {
        await this.removeSessionDir(k.path);
        out.push(k.path);
      } catch {
        // not ours
      }
    }
    return out;
  }

  /** Plant a dir as if a crashed earlier owner had created it. */
  plant(path: string): void {
    this.dirs.add(path);
  }
}
