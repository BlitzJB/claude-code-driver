// DESIGN.md §2.2, D-31, D-40, P-API-12: public error class and mapping.
import { describe, expect, it } from 'vitest';
import {
  ClaudeSessionError,
  fromErrorData,
  isClaudeSessionError,
  publicError,
  toErrorData,
  toPublicError,
  toSessionError,
} from '../../../src/api/map-errors.js';
import { CCD_ERROR_CODES, CcdError, PUBLIC_CODE_OF, PUBLIC_ERROR_CODES } from '../../../src/model/errors.js';

describe('ClaudeSessionError', () => {
  it('carries the public code, the internal code as details.reason, and retryable from the internal meta', () => {
    const e = publicError('E_BUSY', 'busy', { status: 'writing' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ClaudeSessionError');
    expect(e.code).toBe('E_BUSY');
    expect(e.retryable).toBe(true);
    expect(e.details).toEqual({ status: 'writing', reason: 'E_BUSY' });
    expect(Object.isFrozen(e.details)).toBe(true);
    expect(e.toJSON()).toEqual({ code: 'E_BUSY', message: 'busy', details: { status: 'writing', reason: 'E_BUSY' } });
    expect(JSON.parse(JSON.stringify(e))).toEqual(e.toJSON());
  });

  it('falls back to the public retryable set when the reason is not an internal code', () => {
    expect(new ClaudeSessionError('E_TIMEOUT', 't', { reason: 'custom' }).retryable).toBe(true);
    expect(new ClaudeSessionError('E_CONFIG', 'c', { reason: 'custom' }).retryable).toBe(false);
    expect(new ClaudeSessionError('E_CONFIG', 'c', { reason: 'x' }, { retryable: true }).retryable).toBe(true);
  });

  it('every internal code maps to one of the 18 public codes', () => {
    for (const c of CCD_ERROR_CODES) {
      const e = publicError(c, c);
      expect(PUBLIC_ERROR_CODES).toContain(e.code);
      expect(e.code).toBe(PUBLIC_CODE_OF[c]);
      expect(e.details.reason).toBe(c);
    }
  });
});

describe('isClaudeSessionError (P-API-12: duck-typed, works across package copies)', () => {
  it('accepts a structurally equal object from another copy', () => {
    const foreign = { name: 'ClaudeSessionError', code: 'E_AUTH', message: 'm', details: { reason: 'E_LOGIN_REQUIRED' } };
    expect(isClaudeSessionError(foreign)).toBe(true);
    expect(isClaudeSessionError(foreign, 'E_AUTH')).toBe(true);
    expect(isClaudeSessionError(foreign, 'E_CONFIG')).toBe(false);
  });

  it.each([
    null,
    undefined,
    'E_AUTH',
    { code: 'E_LOGIN_REQUIRED', message: 'm', details: { reason: 'x' } },
    { code: 'E_AUTH', details: { reason: 'x' } },
    { code: 'E_AUTH', message: 'm' },
    { code: 'E_AUTH', message: 'm', details: { reason: 1 } },
  ])('rejects %j', (v) => {
    expect(isClaudeSessionError(v)).toBe(false);
  });
});

describe('mapping', () => {
  it('toErrorData / fromErrorData keep internal details and add the reason', () => {
    const d = { code: 'E_TURN_API_ERROR' as const, message: 'overloaded', details: { attempts: 10 } };
    expect(toErrorData(d)).toEqual({ code: 'E_TURN_FAILED', message: 'overloaded', details: { attempts: 10, reason: 'E_TURN_API_ERROR' } });
    const e = fromErrorData({ code: 'E_USAGE_LIMIT', message: 'limited' }, 'cause');
    expect(e.code).toBe('E_USAGE_LIMIT');
    expect(e.cause).toBe('cause');
    expect(e.retryable).toBe(true);
  });

  it('toPublicError: CcdError → public code with cause; public error and AbortError pass through; anything else → E_INTERNAL', () => {
    const internal = new CcdError('E_FORBIDDEN_ARG', 'no --settings', { details: { arg: '--settings' } });
    const p = toPublicError(internal);
    expect(p).toBeInstanceOf(ClaudeSessionError);
    expect(isClaudeSessionError(p, 'E_CONFIG')).toBe(true);
    expect((p as ClaudeSessionError).details).toEqual({ arg: '--settings', reason: 'E_FORBIDDEN_ARG' });
    expect((p as ClaudeSessionError).cause).toBe(internal);

    const already = publicError('E_BUSY', 'b');
    expect(toPublicError(already)).toBe(already);

    const abort = new DOMException('aborted', 'AbortError');
    expect(toPublicError(abort)).toBe(abort);

    const boom = Object.assign(new Error('spawn failed'), { cmd: 'secret command line' });
    const i = toPublicError(boom) as ClaudeSessionError;
    expect(i.code).toBe('E_INTERNAL');
    expect(i.details).toEqual({ reason: 'E_INVARIANT' });
    expect(JSON.stringify(i)).not.toContain('secret');
    expect((toPublicError('str') as ClaudeSessionError).message).toBe('internal error: str');
  });

  it('an internal sub-reason recorded as details.reason survives as details.detail (reason is the internal code)', () => {
    const forbidden = new CcdError('E_FORBIDDEN_ARG', 'no', { details: { reason: 'notAllowlisted', path: 'extraArgs', arg: '--x' } });
    expect((toPublicError(forbidden) as ClaudeSessionError).details).toEqual({
      reason: 'E_FORBIDDEN_ARG',
      detail: 'notAllowlisted',
      path: 'extraArgs',
      arg: '--x',
    });
    const required = new CcdError('E_CONFIG_INVALID', 'x', { details: { reason: 'permissionsRequired', path: 'permissions' } });
    expect(toPublicError(required)).toMatchObject({
      code: 'E_CONFIG',
      details: { reason: 'E_CONFIG_INVALID', detail: 'permissionsRequired' },
    });
    expect(toErrorData({ code: 'E_TURN_API_ERROR', message: 'm', details: { reason: 'overloaded' } }).details).toEqual({
      reason: 'E_TURN_API_ERROR',
      detail: 'overloaded',
    });
    // an explicit detail is never overwritten; a reason equal to the code adds nothing
    expect(toErrorData({ code: 'E_BUSY', message: 'm', details: { reason: 'x', detail: 'y' } }).details).toEqual({
      reason: 'E_BUSY',
      detail: 'y',
    });
    expect(toErrorData({ code: 'E_BUSY', message: 'm', details: { reason: 'E_BUSY' } }).details).toEqual({ reason: 'E_BUSY' });
  });

  it('toSessionError always yields a ClaudeSessionError (an AbortError becomes E_TURN_FAILED)', () => {
    const e = toSessionError(new DOMException('aborted', 'AbortError'));
    expect(e.code).toBe('E_TURN_FAILED');
    expect(e.details.reason).toBe('E_TURN_ABORTED');
    const b = publicError('E_BUSY', 'b');
    expect(toSessionError(b)).toBe(b);
  });
});
