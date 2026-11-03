// platform/runtime-dir/state-store.ts — StateStorePort (DESIGN.md §2.7.2, §3.8 layout, D-38).
// Root `${XDG_STATE_HOME:-~/.local/state}/claude-code-driver`, 0700 with the private-dir rule (P-SEC-24), checked lazily before
// the first operation. Writes are atomic (tmp in the same dir, 0600, fsync, rename, dir fsync). Paths are root-relative and
// may not escape it. `withLock` is an O_EXCL lockfile holding {pid, token, at}; it is stale when the holder pid is dead or
// it is older than `staleMs` (wall clock, because the holder may be another process).
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { Clock } from '../../model/time.js';
import type { EnvPort, StateStorePort } from '../ports.js';
import { isPidAlive } from '../process/process-port.js';
import { currentUid, isNoEnt, privateDirProblem } from './dir-checks.js';
import { UnsafeRuntimeDir } from './errors.js';

const STATE_DIR_NAME = 'claude-code-driver';
const LOCK_POLL_MIN_MS = 20;
const LOCK_POLL_MAX_MS = 250;

export interface StateStoreOptions {
  env: Pick<EnvPort, 'snapshot' | 'homeDir' | 'uid'>;
  clock: Clock;
  /** Explicit root (tests). */
  root?: string;
  /** Liveness check for lock holders (default kill(pid, 0)). */
  isAlive?: (pid: number) => boolean;
}

export function defaultStateRoot(env: Pick<EnvPort, 'snapshot' | 'homeDir'>): string {
  const xdg = env.snapshot()['XDG_STATE_HOME'];
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(env.homeDir(), '.local', 'state');
  return join(base, STATE_DIR_NAME);
}

interface LockInfo {
  pid: number;
  token: string;
  at: number;
}

export function createStateStore(o: StateStoreOptions): StateStorePort {
  const root = normalize(o.root ?? defaultStateRoot(o.env));
  const uid = o.env.uid() >= 0 ? o.env.uid() : currentUid();
  const isAlive = o.isAlive ?? isPidAlive;
  let ready: Promise<void> | undefined;

  const ensure = (): Promise<void> => {
    ready ??= (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const problem = await privateDirProblem(root, uid);
      if (problem !== undefined) throw new UnsafeRuntimeDir(root, problem);
    })().catch((e: unknown) => {
      ready = undefined;
      throw e;
    });
    return ready;
  };

  const abs = (rel: string): string => {
    if (rel.includes('\0') || isAbsolute(rel)) throw new RangeError(`state path must be relative: ${rel}`);
    const n = normalize(rel === '' ? '.' : rel);
    if (n === '..' || n.startsWith(`..${sep}`)) throw new RangeError(`state path escapes the root: ${rel}`);
    return n === '.' ? root : join(root, n);
  };

  const ensureParent = async (p: string): Promise<void> => {
    const d = dirname(p);
    if (d !== root) await mkdir(d, { recursive: true, mode: 0o700 });
  };

  const fsyncDir = async (d: string): Promise<void> => {
    try {
      const fh = await open(d, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // some filesystems refuse fsync on dirs
    }
  };

  const writeAtomic = async (p: string, data: string): Promise<void> => {
    await ensureParent(p);
    const tmp = join(dirname(p), `.${p.slice(dirname(p).length + 1)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await fh.chmod(0o600);
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, p);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    await fsyncDir(dirname(p));
  };

  const readText = async (p: string): Promise<string | undefined> => {
    try {
      const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return await fh.readFile('utf8');
      } finally {
        await fh.close();
      }
    } catch (e) {
      if (isNoEnt(e) || (e as NodeJS.ErrnoException).code === 'ELOOP') return undefined;
      throw e;
    }
  };

  const parseLock = (text: string | undefined): LockInfo | undefined => {
    if (text === undefined) return undefined;
    try {
      const v = JSON.parse(text) as Partial<LockInfo>;
      if (typeof v.pid === 'number' && typeof v.token === 'string' && typeof v.at === 'number')
        return { pid: v.pid, token: v.token, at: v.at };
    } catch {
      // partially written lock: judged by mtime below
    }
    return undefined;
  };

  return {
    root,

    async writeJsonAtomic(rel, v) {
      await ensure();
      await writeAtomic(abs(rel), `${JSON.stringify(v, null, 2)}\n`);
    },

    async readJson<T>(rel: string): Promise<T | undefined> {
      await ensure();
      const text = await readText(abs(rel));
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as T;
      } catch {
        return undefined;
      }
    },

    async list(relDir) {
      await ensure();
      try {
        const names = await readdir(abs(relDir));
        return names.filter((n) => !n.startsWith('.')).sort();
      } catch (e) {
        if (isNoEnt(e)) return [];
        throw e;
      }
    },

    async remove(rel) {
      await ensure();
      const p = abs(rel);
      if (p === root) throw new RangeError('refusing to remove the state root');
      try {
        const st = await lstat(p);
        if (st.isDirectory()) await rm(p, { recursive: true, force: true });
        else await unlink(p);
      } catch (e) {
        if (!isNoEnt(e)) throw e;
      }
    },

    async appendLine(rel, line) {
      await ensure();
      const text = line.endsWith('\n') ? line.slice(0, -1) : line;
      if (text.includes('\n')) throw new RangeError('appendLine: embedded newline');
      const p = abs(rel);
      await ensureParent(p);
      const fh = await open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        await fh.write(`${text}\n`);
      } finally {
        await fh.close();
      }
    },

    async withLock<T>(name: string, fn: () => Promise<T>, lo: { staleMs: number }): Promise<T> {
      await ensure();
      const p = abs(name);
      await ensureParent(p);
      const token = randomBytes(8).toString('hex');
      let wait = LOCK_POLL_MIN_MS;
      for (;;) {
        try {
          const fh = await open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try {
            await fh.writeFile(JSON.stringify({ pid: process.pid, token, at: o.clock.wallNow() } satisfies LockInfo));
            await fh.sync();
          } finally {
            await fh.close();
          }
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        const isStale = async (path: string, info: LockInfo | undefined): Promise<boolean | undefined> => {
          let at = info?.at;
          if (at === undefined) {
            try {
              at = (await stat(path)).mtimeMs;
            } catch {
              return undefined; // released meanwhile
            }
          }
          return (info !== undefined && info.pid !== process.pid && !isAlive(info.pid)) || o.clock.wallNow() - at > lo.staleMs;
        };
        const info = parseLock(await readText(p));
        const stale = await isStale(p, info);
        if (stale === undefined) continue;
        if (stale) {
          const aside = `${p}.stale-${token}`;
          try {
            await rename(p, aside);
          } catch (e) {
            if (isNoEnt(e)) continue;
            throw e;
          }
          // Between our read and the rename the stale holder may have released and someone else taken a fresh lock
          // (also when our read saw a torn file). Re-judge what we actually moved; a live lock goes back unless the slot
          // was taken again meanwhile.
          const moved = parseLock(await readText(aside));
          const movedSame = info !== undefined && moved?.token === info.token;
          if (!movedSame && (await isStale(aside, moved)) === false) await link(aside, p).catch(() => undefined);
          await unlink(aside).catch(() => undefined);
          continue;
        }
        await o.clock.sleep(wait);
        wait = Math.min(wait * 2, LOCK_POLL_MAX_MS);
      }
      try {
        return await fn();
      } finally {
        const current = parseLock(await readText(p).catch(() => undefined));
        if (current?.token === token) await unlink(p).catch(() => undefined);
      }
    },
  };
}
