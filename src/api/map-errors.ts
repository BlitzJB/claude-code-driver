// api/map-errors.ts — the public error class and the internal → public error mapping (DESIGN.md §2.2, §2.12, D-31, D-40).
// Internal codes never leave the library as `code`; they travel as `details.reason`. Matching is by duck-typed `code`, never by
// `instanceof` alone, so two installed package copies agree (P-API-12).

import { ERROR_META, PUBLIC_CODE_OF, PUBLIC_ERROR_CODES, isCcdError, type CcdErrorCode, type CcdErrorData } from '../model/errors.js';
import type { PublicErrorCode } from '../model/errors.js';
import type { ClaudeSessionErrorData } from './public-types.js';

export { PUBLIC_ERROR_CODES } from '../model/errors.js';

const PUBLIC_SET: ReadonlySet<string> = new Set<string>(PUBLIC_ERROR_CODES);
/** Public codes a caller may retry without changing anything (for codes built without an internal reason). */
const PUBLIC_RETRYABLE: ReadonlySet<PublicErrorCode> = new Set<PublicErrorCode>([
  'E_BUSY',
  'E_SUBMIT_UNCONFIRMED',
  'E_TIMEOUT',
  'E_USAGE_LIMIT',
]);

export class ClaudeSessionError extends Error {
  readonly code: PublicErrorCode;
  readonly retryable: boolean;
  readonly details: ClaudeSessionErrorData['details'];
  constructor(
    code: PublicErrorCode,
    message: string,
    details: ClaudeSessionErrorData['details'],
    opts?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, opts !== undefined && 'cause' in opts ? { cause: opts.cause } : undefined);
    this.name = 'ClaudeSessionError';
    this.code = code;
    this.details = Object.freeze({ ...details });
    const internal = ERROR_META[details.reason as CcdErrorCode] as (typeof ERROR_META)[CcdErrorCode] | undefined;
    this.retryable = opts?.retryable ?? internal?.retryable ?? PUBLIC_RETRYABLE.has(code);
  }
  toJSON(): ClaudeSessionErrorData {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

/** True for any ClaudeSessionError-shaped value (any package copy); with `code`, only for that public code. */
export function isClaudeSessionError(e: unknown, code?: PublicErrorCode): e is ClaudeSessionError {
  if (typeof e !== 'object' || e === null) return false;
  const c = (e as { code?: unknown }).code;
  const details = (e as { details?: unknown }).details;
  if (typeof c !== 'string' || !PUBLIC_SET.has(c) || typeof (e as { message?: unknown }).message !== 'string') return false;
  if (typeof details !== 'object' || details === null || typeof (details as { reason?: unknown }).reason !== 'string') return false;
  return code === undefined || c === code;
}

/**
 * Internal details → public details. `reason` becomes the internal code (§2.2); an internal sub-reason that L3 recorded under
 * `details.reason` (`permissionsRequired`, `notAllowlisted`, `forbiddenName`, …) is kept as `detail` instead of being lost.
 */
function publicDetails(code: CcdErrorCode, details: Readonly<Record<string, unknown>> | undefined): ClaudeSessionErrorData['details'] {
  const { reason: sub, ...rest } = details ?? {};
  return { ...rest, ...(sub !== undefined && sub !== code && rest['detail'] === undefined ? { detail: sub } : {}), reason: code };
}

/** An internal error record (turn.ended.error, idle.lastTurn.error) as public data. */
export function toErrorData(d: CcdErrorData): ClaudeSessionErrorData {
  return { code: PUBLIC_CODE_OF[d.code], message: d.message, details: publicDetails(d.code, d.details) };
}

export function fromErrorData(d: CcdErrorData, cause?: unknown): ClaudeSessionError {
  const p = toErrorData(d);
  return new ClaudeSessionError(p.code, p.message, p.details, cause === undefined ? undefined : { cause });
}

/** A public error built from an internal code that L4 itself raises (config validation, closed session, …). */
export function publicError(reason: CcdErrorCode, message: string, details: Record<string, unknown> = {}): ClaudeSessionError {
  return new ClaudeSessionError(PUBLIC_CODE_OF[reason], message, { ...details, reason });
}

/**
 * Anything the kernel or a port threw → ClaudeSessionError. A CcdError keeps its code as `reason`; an already-public error is
 * returned as is; an AbortError (the caller's own signal) is passed through; anything else is `E_INTERNAL` with the original as
 * `cause` (never copied into details: it may carry a child-process command line, SEC §8.2).
 */
export function toPublicError(e: unknown): ClaudeSessionError | DOMException {
  // An internal CcdError whose code is also a public code (E_BUSY, E_USAGE_LIMIT, …) and whose details carry a `reason`
  // is shaped like a public error; it must still be mapped so `details.reason` is the internal code (D-40).
  if (isClaudeSessionError(e) && (e as { name?: unknown }).name !== 'CcdError') return e;
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) return e;
  if (isCcdError(e)) return new ClaudeSessionError(PUBLIC_CODE_OF[e.code], e.message, publicDetails(e.code, e.details), { cause: e });
  const message = e instanceof Error ? e.message : String(e);
  return new ClaudeSessionError('E_INTERNAL', `internal error: ${message}`, { reason: 'E_INVARIANT' }, { cause: e });
}

/** Same as toPublicError, for places that must hold a ClaudeSessionError (TurnResult.error). */
export function toSessionError(e: unknown): ClaudeSessionError {
  const p = toPublicError(e);
  return p instanceof ClaudeSessionError || isClaudeSessionError(p)
    ? p
    : new ClaudeSessionError('E_TURN_FAILED', p.message, { reason: 'E_TURN_ABORTED' }, { cause: p });
}
