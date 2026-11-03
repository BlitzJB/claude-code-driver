// model/errors.ts (DESIGN.md §2.2, D-31, D-40, P-API-12).
import { describe, expect, it } from 'vitest';
import {
  CCD_ERROR_CODES,
  CcdError,
  ERROR_META,
  isCcdError,
  PUBLIC_CODE_OF,
  PUBLIC_ERROR_CODES,
  type CcdErrorCode,
} from '../../../src/model/errors.js';

describe('error codes', () => {
  it('internal codes are unique', () => {
    expect(new Set(CCD_ERROR_CODES).size).toBe(CCD_ERROR_CODES.length);
  });

  it('there are exactly 18 unique public codes (D-40)', () => {
    expect(PUBLIC_ERROR_CODES).toHaveLength(18);
    expect(new Set(PUBLIC_ERROR_CODES).size).toBe(18);
  });

  it('PUBLIC_CODE_OF is total over CCD_ERROR_CODES, has no extra keys, and maps into PUBLIC_ERROR_CODES', () => {
    expect(Object.keys(PUBLIC_CODE_OF).sort()).toEqual([...CCD_ERROR_CODES].sort());
    const pub = new Set<string>(PUBLIC_ERROR_CODES);
    for (const c of CCD_ERROR_CODES) expect(pub.has(PUBLIC_CODE_OF[c])).toBe(true);
  });

  it('every public code is reachable from some internal code', () => {
    const reached = new Set(Object.values(PUBLIC_CODE_OF));
    expect(PUBLIC_ERROR_CODES.filter((p) => !reached.has(p))).toEqual([]);
  });

  it.each<[CcdErrorCode, string]>([
    ['E_FORBIDDEN_ARG', 'E_CONFIG'],
    ['E_TMUX_NOT_FOUND', 'E_ENVIRONMENT'],
    ['E_LOGIN_REQUIRED', 'E_AUTH'],
    ['E_AUTH_METHOD_UNSUPPORTED', 'E_AUTH'],
    ['E_API_PROVIDER_UNSUPPORTED', 'E_AUTH'],
    ['E_AUTH_REQUIRED', 'E_AUTH'],
    ['E_TURN_API_ERROR', 'E_TURN_FAILED'],
    ['E_TURN_REFUSED', 'E_TURN_FAILED'],
    ['E_TURN_BLOCKED_BY_HOOK', 'E_TURN_FAILED'],
    ['E_WAIT_TIMEOUT', 'E_TIMEOUT'],
    ['E_STARTUP_TIMEOUT', 'E_TIMEOUT'],
    ['E_SECURITY_UNEXPECTED_INPUT', 'E_SECURITY'],
    ['E_SECURITY_HOOK_FORGERY', 'E_SECURITY'],
    ['E_SECURITY_SETTINGS_TAMPERED', 'E_SECURITY'],
    ['E_INPUT_TAMPERED', 'E_SECURITY'],
    ['E_OWNER_GONE', 'E_SESSION_EXITED'],
    ['E_CLAUDE_VERSION_MISMATCH', 'E_VERSION_MISMATCH'],
    ['E_TRUST_REQUIRED', 'E_TRUST_REQUIRED'],
    ['E_USAGE_LIMIT', 'E_USAGE_LIMIT'],
  ])('§2.2 example: %s → %s', (code, pub) => {
    expect(PUBLIC_CODE_OF[code]).toBe(pub);
  });

  it('ERROR_META is total and its category follows the grouping of CCD_ERROR_CODES', () => {
    expect(Object.keys(ERROR_META).sort()).toEqual([...CCD_ERROR_CODES].sort());
    expect(ERROR_META.E_FORBIDDEN_ENV.category).toBe('config');
    expect(ERROR_META.E_KEYBINDING_CONFLICT.category).toBe('environment');
    expect(ERROR_META.E_STARTUP_EXITED.category).toBe('startup');
    expect(ERROR_META.E_WAIT_TIMEOUT.category).toBe('input');
    expect(ERROR_META.E_TURN_REFUSED.category).toBe('turn');
    expect(ERROR_META.E_OWNER_GONE.category).toBe('session');
    expect(ERROR_META.E_HOST_LOOP_LAG.category).toBe('channel');
    expect(ERROR_META.E_SECURITY_HOOK_FORGERY.category).toBe('security');
    expect(ERROR_META.E_UNSUPPORTED_FEATURE.category).toBe('feature');
    expect(ERROR_META.E_INVARIANT.category).toBe('internal');
  });

  it('retryable follows api-layering.md §7', () => {
    const retryable = CCD_ERROR_CODES.filter((c) => ERROR_META[c].retryable).sort();
    expect(retryable).toEqual(
      [
        'E_STARTUP_TIMEOUT',
        'E_BUSY',
        'E_NOT_READY',
        'E_SUBMIT_UNCONFIRMED',
        'E_INPUT_GATED',
        'E_WAIT_TIMEOUT',
        'E_USAGE_UNAVAILABLE', // ICR 0040
        'E_TURN_API_ERROR',
        'E_TURN_STALLED',
        'E_USAGE_LIMIT',
      ].sort(),
    );
  });

  it('the maps are frozen', () => {
    expect(Object.isFrozen(PUBLIC_CODE_OF)).toBe(true);
    expect(Object.isFrozen(ERROR_META)).toBe(true);
  });
});

describe('CcdError', () => {
  it('carries code, category, retryable, details and cause', () => {
    const cause = new Error('spawn tmux ENOENT');
    const e = new CcdError('E_TMUX_NOT_FOUND', 'tmux not found', { cause, details: { searched: ['/opt/homebrew/bin'] } });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CcdError');
    expect(e.code).toBe('E_TMUX_NOT_FOUND');
    expect(e.category).toBe('environment');
    expect(e.retryable).toBe(false);
    expect(e.details).toEqual({ searched: ['/opt/homebrew/bin'] });
    expect(e.cause).toBe(cause);
    expect(Object.isFrozen(e.details)).toBe(true);
  });

  it('toJSON is the CcdErrorData shape and omits absent details', () => {
    expect(new CcdError('E_BUSY', 'busy').toJSON()).toEqual({ code: 'E_BUSY', message: 'busy' });
    expect(JSON.parse(JSON.stringify(new CcdError('E_BUSY', 'busy', { details: { status: 'writing' } })))).toEqual({
      code: 'E_BUSY',
      message: 'busy',
      details: { status: 'writing' },
    });
  });

  it('details are copied, so later mutation of the input does not leak in', () => {
    const d = { a: 1 };
    const e = new CcdError('E_INVARIANT', 'x', { details: d });
    d.a = 2;
    expect(e.details).toEqual({ a: 1 });
  });

  it('no cause option → no cause property', () => {
    expect('cause' in new CcdError('E_BUSY', 'busy')).toBe(false);
  });
});

describe('isCcdError (duck-typed, P-API-12)', () => {
  it('accepts a CcdError and filters by code', () => {
    const e = new CcdError('E_BUSY', 'busy');
    expect(isCcdError(e)).toBe(true);
    expect(isCcdError(e, 'E_BUSY')).toBe(true);
    expect(isCcdError(e, 'E_INVARIANT')).toBe(false);
  });

  it('accepts an error from another package copy (same shape, different class)', () => {
    class OtherCopyCcdError extends Error {
      readonly code = 'E_USAGE_LIMIT';
    }
    expect(isCcdError(new OtherCopyCcdError('limited'), 'E_USAGE_LIMIT')).toBe(true);
    expect(isCcdError({ code: 'E_USAGE_LIMIT', message: 'plain object from a worker' })).toBe(true);
  });

  it.each([
    null,
    undefined,
    'E_BUSY',
    42,
    {},
    { code: 'E_NOPE', message: 'x' },
    { code: 'E_BUSY' },
    Object.assign(new Error('x'), { code: 'ENOENT' }),
  ])('rejects %o', (v) => {
    expect(isCcdError(v)).toBe(false);
  });
});
