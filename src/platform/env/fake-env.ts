// platform/env/fake-env.ts — configurable EnvPort for tests.
import type { EnvPort } from '../ports.js';

export interface FakeEnvOptions {
  vars?: Record<string, string>;
  home?: string;
  user?: string;
  uid?: number;
  platform?: 'darwin' | 'linux' | 'other';
  tmpDir?: string;
  execPath?: string;
  nodeVersion?: string;
  timeZone?: string;
  /** path → realpath; paths not listed resolve to themselves. */
  realpaths?: Record<string, string>;
  /** path → lstat result; paths not listed do not exist. */
  entries?: Record<string, { isSymlink: boolean; isFile: boolean; isDir: boolean }>;
}

export class FakeEnv implements EnvPort {
  vars: Record<string, string>;
  realpaths: Record<string, string>;
  entries: Record<string, { isSymlink: boolean; isFile: boolean; isDir: boolean }>;

  constructor(private readonly o: FakeEnvOptions = {}) {
    this.vars = { HOME: o.home ?? '/home/tester', USER: o.user ?? 'tester', PATH: '/usr/bin:/bin', ...(o.vars ?? {}) };
    this.realpaths = { ...(o.realpaths ?? {}) };
    this.entries = { ...(o.entries ?? {}) };
  }

  snapshot(): Readonly<Record<string, string>> {
    return Object.freeze({ ...this.vars });
  }
  homeDir(): string {
    return this.o.home ?? '/home/tester';
  }
  userName(): string {
    return this.o.user ?? 'tester';
  }
  uid(): number {
    return this.o.uid ?? 501;
  }
  platform(): 'darwin' | 'linux' | 'other' {
    return this.o.platform ?? 'darwin';
  }
  tmpDir(): string {
    return this.o.tmpDir ?? '/fake/tmp';
  }
  execPath(): string {
    return this.o.execPath ?? '/usr/local/bin/node';
  }
  nodeVersion(): string {
    return this.o.nodeVersion ?? '22.23.2';
  }
  realpath(p: string): Promise<string> {
    return Promise.resolve(this.realpaths[p] ?? p);
  }
  lstat(p: string): Promise<{ isSymlink: boolean; isFile: boolean; isDir: boolean } | undefined> {
    return Promise.resolve(this.entries[p]);
  }
  timeZone(): string {
    return this.o.timeZone ?? 'UTC';
  }
}
