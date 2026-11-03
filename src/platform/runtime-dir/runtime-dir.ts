// platform/runtime-dir/runtime-dir.ts — RuntimeDirPort (DESIGN.md §2.7.2, D-38, SEC §2.5/§5.1/§9).
// Root: explicit option → darwin `os.tmpdir()` (per-user 0700) / linux `$XDG_RUNTIME_DIR` → `/tmp/ccd-<uid>` (created 0700).
// Every candidate passes the private-dir rule (P-SEC-24); a preferred root that fails falls through to `/tmp/ccd-<uid>`,
// which must pass or `UnsafeRuntimeDir` is thrown. Session dirs are `mkdtemp(<root>/ccd-)` → 0700, outside the project cwd
// (P-HOOK-17, P-SEC-14), and are returned absolute (D-38, P-REV-34). The longest socket we create, `<sessionDir>/net.sock`,
// must fit in 100 bytes (macOS sun_path is 104) else `SocketPathTooLong`.
// Removal only ever touches `ccd-XXXXXX` dirs we own; `sweepStale` only touches dirs named by a registry entry.
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { EnvPort, RuntimeDirPort } from '../ports.js';
import { currentUid, isNoEnt, privateDirProblem } from './dir-checks.js';
import { SocketPathTooLong, UnsafeRuntimeDir } from './errors.js';

export const SESSION_DIR_PREFIX = 'ccd-';
export const MAX_SOCKET_PATH_BYTES = 100;
export const LONGEST_SOCKET_NAME = 'net.sock';
const SESSION_DIR_RE = /^ccd-[A-Za-z0-9]{6}$/;

export interface RuntimeDirOptions {
  env: Pick<EnvPort, 'platform' | 'tmpDir' | 'uid' | 'snapshot'>;
  /** Explicit root (tests, advanced config). Created 0700 if missing; must pass the private-dir rule. */
  root?: string;
}

export function createRuntimeDirPort(o: RuntimeDirOptions): RuntimeDirPort {
  const uid = o.env.uid() >= 0 ? o.env.uid() : currentUid();
  let root: string | undefined;

  const candidates = (): string[] => {
    if (o.root !== undefined) return [o.root];
    const out: string[] = [];
    const p = o.env.platform();
    if (p === 'darwin') out.push(o.env.tmpDir());
    if (p === 'linux') {
      const xdg = o.env.snapshot()['XDG_RUNTIME_DIR'];
      if (xdg !== undefined && isAbsolute(xdg)) out.push(xdg);
    }
    out.push(`/tmp/ccd-${uid}`);
    return out;
  };

  const ensureRoot = async (): Promise<string> => {
    if (root !== undefined) return root;
    const list = candidates();
    let last: { path: string; reason: NonNullable<Awaited<ReturnType<typeof privateDirProblem>>> } | undefined;
    for (let i = 0; i < list.length; i++) {
      const cand = resolve(list[i] ?? '');
      const isFallback = i === list.length - 1;
      if (isFallback || o.root !== undefined) {
        try {
          await mkdir(cand, { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new UnsafeRuntimeDir(cand, 'missing');
        }
      }
      const problem = await privateDirProblem(cand, uid);
      if (problem === undefined) {
        root = cand;
        return cand;
      }
      last = { path: cand, reason: problem };
    }
    throw new UnsafeRuntimeDir(last?.path ?? '(none)', last?.reason ?? 'missing');
  };

  const assertRemovable = async (path: string): Promise<'gone' | 'ok'> => {
    if (!isAbsolute(path) || resolve(path) !== path) throw new UnsafeRuntimeDir(path, 'notAbsolute');
    if (!SESSION_DIR_RE.test(basename(path))) throw new UnsafeRuntimeDir(path, 'notOurs');
    let st;
    try {
      st = await lstat(path);
    } catch (e) {
      if (isNoEnt(e)) return 'gone';
      throw e;
    }
    if (st.isSymbolicLink()) throw new UnsafeRuntimeDir(path, 'symlink');
    if (!st.isDirectory()) throw new UnsafeRuntimeDir(path, 'notDirectory');
    if (uid >= 0 && st.uid !== uid) throw new UnsafeRuntimeDir(path, 'owner');
    return 'ok';
  };

  return {
    ensureRoot,

    async createSessionDir() {
      const r = await ensureRoot();
      const dir = await mkdtemp(join(r, SESSION_DIR_PREFIX));
      await chmod(dir, 0o700);
      const bytes = Buffer.byteLength(`${dir}/${LONGEST_SOCKET_NAME}`);
      if (bytes > MAX_SOCKET_PATH_BYTES) {
        await rm(dir, { recursive: true, force: true });
        throw new SocketPathTooLong(bytes, MAX_SOCKET_PATH_BYTES);
      }
      const problem = await privateDirProblem(dir, uid);
      if (problem !== undefined) {
        await rm(dir, { recursive: true, force: true });
        throw new UnsafeRuntimeDir(dir, problem);
      }
      return dir;
    },

    async removeSessionDir(path) {
      if ((await assertRemovable(path)) === 'gone') return;
      await rm(path, { recursive: true, force: true });
    },

    async sweepStale(known) {
      const removed: string[] = [];
      for (const k of known) {
        if (k.ownerAlive) continue;
        try {
          if ((await assertRemovable(k.path)) === 'gone') continue;
          await rm(k.path, { recursive: true, force: true });
          removed.push(k.path);
        } catch {
          // not ours / not safe: leave it (never touch what we cannot prove is ours)
        }
      }
      return removed;
    },
  };
}
