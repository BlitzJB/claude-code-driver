// platform/registry/fake-registry.ts — ClaudeRegistryReader fake (K-38: a live non-library holder of a resume id).
import type { ClaudeRegistryReader, ClaudeRegistryRecord } from '../ports.js';

export class FakeClaudeRegistry implements ClaudeRegistryReader {
  readonly records = new Map<number, ClaudeRegistryRecord>();
  readonly reads: number[] = [];

  constructor(private readonly isAlive: (pid: number) => boolean = () => true) {}

  put(rec: ClaudeRegistryRecord): void {
    this.records.set(rec.pid, { ...rec });
  }

  delete(pid: number): void {
    this.records.delete(pid);
  }

  read(pid: number): Promise<ClaudeRegistryRecord | undefined> {
    this.reads.push(pid);
    const r = this.records.get(pid);
    return Promise.resolve(r === undefined ? undefined : { ...r });
  }

  scan(): Promise<ClaudeRegistryRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((r) => this.isAlive(r.pid))
        .sort((a, b) => a.pid - b.pid)
        .map((r) => ({ ...r })),
    );
  }
}
