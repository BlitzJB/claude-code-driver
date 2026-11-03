// platform/ids/fake-ids.ts — deterministic IdPort for tests and replays (same shapes as crypto-ids.ts).
import type { IdPort } from '../ports.js';

/** fnv1a-32 → 8 lowercase hex chars. */
function fnv8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export class FakeIds implements IdPort {
  private n = 0;
  readonly issued: string[] = [];

  constructor(private readonly seed = 'ccd') {}

  uuidV4(): string {
    const c = (++this.n).toString(16).padStart(12, '0');
    const id = `${fnv8(`${this.seed}:u:${this.n}`)}-0000-4000-8000-${c}`;
    this.issued.push(id);
    return id;
  }

  tokenHex(bytes: number): string {
    const out = this.stream(`t:${++this.n}`, bytes * 2);
    this.issued.push(out);
    return out;
  }

  shortHex(n: number): string {
    const out = this.stream(`s:${++this.n}`, n);
    this.issued.push(out);
    return out;
  }

  private stream(tag: string, len: number): string {
    let out = '';
    for (let i = 0; out.length < len; i++) out += fnv8(`${this.seed}:${tag}:${i}`);
    return out.slice(0, len);
  }
}
