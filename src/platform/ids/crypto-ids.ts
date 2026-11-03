// platform/ids/crypto-ids.ts — IdPort backed by node:crypto (DESIGN.md §2.7.1).
// Tokens are lowercase hex only, so they can never contain `$` (header values with `$` are blanked, SEC §2.2, P-SEC-32).
import { randomBytes, randomUUID } from 'node:crypto';
import type { IdPort } from '../ports.js';

const MAX_TOKEN_BYTES = 1024;

function assertCount(what: string, n: number, max: number): void {
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`${what} must be an integer in 1..${max}, got ${n}`);
}

export function createCryptoIds(): IdPort {
  return {
    uuidV4: () => randomUUID(),
    tokenHex(bytes: number): string {
      assertCount('tokenHex bytes', bytes, MAX_TOKEN_BYTES);
      return randomBytes(bytes).toString('hex');
    },
    shortHex(n: number): string {
      assertCount('shortHex length', n, MAX_TOKEN_BYTES * 2);
      return randomBytes(Math.ceil(n / 2))
        .toString('hex')
        .slice(0, n);
    },
  };
}
