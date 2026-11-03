// platform/runtime-dir/fake-state-store.ts — in-memory StateStorePort (same path rules and lock semantics as the real one).
import type { Clock } from '../../model/time.js';
import type { StateStorePort } from '../ports.js';

interface LockInfo {
  pid: number;
  token: string;
  at: number;
}

export interface FakeStateStoreOptions {
  root?: string;
  clock: Clock;
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

/** Run synchronously, but report a throw as a rejection (the real adapter is async throughout). */
function settle<T>(f: () => T): Promise<T> {
  try {
    return Promise.resolve(f());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

export class FakeStateStore implements StateStorePort {
  readonly root: string;
  /** rel path → file text. */
  readonly files = new Map<string, string>();
  private readonly locks = new Map<string, LockInfo>();
  private seq = 0;

  constructor(private readonly o: FakeStateStoreOptions) {
    this.root = o.root ?? '/fake/state/claude-code-driver';
  }

  writeJsonAtomic(rel: string, v: unknown): Promise<void> {
    return settle(() => {
      this.files.set(this.norm(rel), `${JSON.stringify(v, null, 2)}\n`);
    });
  }

  readJson<T>(rel: string): Promise<T | undefined> {
    return settle(() => {
      const t = this.files.get(this.norm(rel));
      if (t === undefined) return undefined;
      try {
        return JSON.parse(t) as T;
      } catch {
        return undefined;
      }
    });
  }

  list(relDir: string): Promise<string[]> {
    return settle(() => {
      const d = this.norm(relDir);
      const prefix = d === '' ? '' : `${d}/`;
      const names = new Set<string>();
      for (const k of this.files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const first = k.slice(prefix.length).split('/')[0];
        if (first !== undefined && first !== '' && !first.startsWith('.')) names.add(first);
      }
      return [...names].sort();
    });
  }

  remove(rel: string): Promise<void> {
    return settle(() => {
      const p = this.norm(rel);
      if (p === '') throw new RangeError('refusing to remove the state root');
      this.files.delete(p);
      for (const k of [...this.files.keys()]) if (k.startsWith(`${p}/`)) this.files.delete(k);
    });
  }

  appendLine(rel: string, line: string): Promise<void> {
    return settle(() => {
      const text = line.endsWith('\n') ? line.slice(0, -1) : line;
      if (text.includes('\n')) throw new RangeError('appendLine: embedded newline');
      const p = this.norm(rel);
      this.files.set(p, `${this.files.get(p) ?? ''}${text}\n`);
    });
  }

  async withLock<T>(name: string, fn: () => Promise<T>, lo: { staleMs: number }): Promise<T> {
    const p = await settle(() => this.norm(name));
    const me = this.o.pid ?? 1_000_000;
    const token = `tok${++this.seq}`;
    for (;;) {
      const cur = this.locks.get(p);
      if (cur === undefined) break;
      const stale = (cur.pid !== me && this.o.isAlive?.(cur.pid) === false) || this.o.clock.wallNow() - cur.at > lo.staleMs;
      if (stale) {
        this.locks.delete(p);
        continue;
      }
      await this.o.clock.sleep(20);
    }
    this.locks.set(p, { pid: me, token, at: this.o.clock.wallNow() });
    try {
      return await fn();
    } finally {
      if (this.locks.get(p)?.token === token) this.locks.delete(p);
    }
  }

  /** Plant a lock as another process would (contract test: stale holder). */
  plantLock(name: string, info: { pid: number; at: number }): void {
    this.locks.set(this.norm(name), { ...info, token: `planted${++this.seq}` });
  }

  isLocked(name: string): boolean {
    return this.locks.has(this.norm(name));
  }

  private norm(rel: string): string {
    if (rel.includes('\0') || rel.startsWith('/')) throw new RangeError(`state path must be relative: ${rel}`);
    const parts: string[] = [];
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) throw new RangeError(`state path escapes the root: ${rel}`);
        parts.pop();
      } else parts.push(seg);
    }
    return parts.join('/');
  }
}
