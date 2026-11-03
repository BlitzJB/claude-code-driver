// model/errors.ts — internal error codes, the 18 public codes, CcdError (DESIGN.md §2.2, D-31, D-40).

import type { JsonValue } from './json.js';

// Internal, fine-grained codes. Never renamed; may grow. They appear publicly only as `details.reason`.
export const CCD_ERROR_CODES = [
  // config
  'E_CONFIG_INVALID',
  'E_FORBIDDEN_ENV',
  'E_FORBIDDEN_ARG',
  // environment
  'E_NODE_UNSUPPORTED',
  'E_TMUX_NOT_FOUND',
  'E_TMUX_UNSUPPORTED',
  'E_CLAUDE_NOT_FOUND',
  'E_CLAUDE_VERSION_MISMATCH',
  'E_UNSAFE_RUNTIME_DIR',
  'E_SOCKET_PATH_TOO_LONG',
  'E_KEYBINDING_CONFLICT',
  'E_NOT_ONBOARDED',
  'E_LOGIN_REQUIRED',
  'E_AUTH_METHOD_UNSUPPORTED',
  'E_API_PROVIDER_UNSUPPORTED',
  'E_CONFIG_CORRUPT',
  'E_HOOKS_DISABLED_BY_USER',
  'E_HOOKS_BLOCKED_BY_POLICY',
  // startup
  'E_STARTUP_TIMEOUT',
  'E_TRUST_REQUIRED',
  'E_WORKSPACE_RISK',
  'E_STARTUP_GATE',
  'E_SETTINGS_INVALID',
  'E_SESSION_ID_IN_USE',
  'E_RESUME_NOT_FOUND',
  'E_VERSION_POLICY',
  'E_SELFTEST_FAILED',
  'E_HOOKS_UNAVAILABLE',
  'E_STARTUP_EXITED',
  // input
  'E_BUSY',
  'E_NOT_READY',
  'E_SUBMIT_UNCONFIRMED',
  'E_INPUT_GATED',
  'E_INPUT_INVALID',
  'E_INPUT_REJECTED',
  'E_INPUT_TAMPERED',
  'E_COMMAND_FORBIDDEN',
  'E_PERMISSION_UNKNOWN',
  'E_PERMISSION_INVALID',
  'E_MODE_FORBIDDEN',
  'E_WAIT_TIMEOUT',
  'E_USAGE_UNAVAILABLE',
  // turn
  'E_TURN_INTERRUPTED',
  'E_TURN_API_ERROR',
  'E_TURN_STALLED',
  'E_USAGE_LIMIT',
  'E_AUTH_REQUIRED',
  'E_TURN_ABORTED',
  'E_TURN_BLOCKED_BY_HOOK',
  'E_CLAUDE_VERSION_TOO_OLD',
  'E_TURN_REFUSED',
  // session
  'E_SESSION_EXITED',
  'E_SESSION_CLOSED',
  'E_HOOK_PORT_LOST',
  'E_OWNER_GONE',
  // channel
  'E_CHANNEL_DOWN',
  'E_TRANSCRIPT_REWRITE',
  'E_SCREEN_UNKNOWN',
  'E_NETWORK_UNAVAILABLE',
  'E_HOST_LOOP_LAG',
  // security
  'E_SECURITY_UNEXPECTED_INPUT',
  'E_SECURITY_HOOK_FORGERY',
  'E_SECURITY_SETTINGS_TAMPERED',
  // feature
  'E_UNSUPPORTED_FEATURE',
  // internal
  'E_LISTENER_THREW',
  'E_INVARIANT',
] as const;
export type CcdErrorCode = (typeof CCD_ERROR_CODES)[number];

// rev2 (D-40): the 18 codes a user can switch on. Frozen; the public CcdError.code is always one of these.
export const PUBLIC_ERROR_CODES = [
  'E_CONFIG',
  'E_ENVIRONMENT',
  'E_VERSION_MISMATCH',
  'E_AUTH',
  'E_TRUST_REQUIRED',
  'E_STARTUP',
  'E_HOOKS_UNAVAILABLE',
  'E_INPUT_REJECTED',
  'E_SUBMIT_UNCONFIRMED',
  'E_BUSY',
  'E_PERMISSION_INVALID',
  'E_TURN_FAILED',
  'E_USAGE_LIMIT',
  'E_SESSION_CLOSED',
  'E_SESSION_EXITED',
  'E_SECURITY',
  'E_TIMEOUT',
  'E_INTERNAL',
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

/**
 * Total map internal → public code (unit-tested for totality). The examples fixed by §2.2 are honoured:
 * E_FORBIDDEN_ARG → E_CONFIG; E_TMUX_NOT_FOUND → E_ENVIRONMENT; E_LOGIN_REQUIRED / E_AUTH_METHOD_UNSUPPORTED /
 * E_API_PROVIDER_UNSUPPORTED / E_AUTH_REQUIRED → E_AUTH; E_TURN_API_ERROR / E_TURN_REFUSED / E_TURN_BLOCKED_BY_HOOK → E_TURN_FAILED;
 * E_WAIT_TIMEOUT / E_STARTUP_TIMEOUT → E_TIMEOUT; E_SECURITY_* / E_INPUT_TAMPERED → E_SECURITY; E_OWNER_GONE → E_SESSION_EXITED.
 * The remaining assignments are WP-00 decisions (documented in docs/icr/0001-wp00-model-additions.md).
 */
export const PUBLIC_CODE_OF: Readonly<Record<CcdErrorCode, PublicErrorCode>> = Object.freeze({
  // config
  E_CONFIG_INVALID: 'E_CONFIG',
  E_FORBIDDEN_ENV: 'E_CONFIG',
  E_FORBIDDEN_ARG: 'E_CONFIG',
  // environment
  E_NODE_UNSUPPORTED: 'E_ENVIRONMENT',
  E_TMUX_NOT_FOUND: 'E_ENVIRONMENT',
  E_TMUX_UNSUPPORTED: 'E_ENVIRONMENT',
  E_CLAUDE_NOT_FOUND: 'E_ENVIRONMENT',
  E_CLAUDE_VERSION_MISMATCH: 'E_VERSION_MISMATCH',
  E_UNSAFE_RUNTIME_DIR: 'E_ENVIRONMENT',
  E_SOCKET_PATH_TOO_LONG: 'E_ENVIRONMENT',
  E_KEYBINDING_CONFLICT: 'E_ENVIRONMENT',
  E_NOT_ONBOARDED: 'E_ENVIRONMENT',
  E_LOGIN_REQUIRED: 'E_AUTH',
  E_AUTH_METHOD_UNSUPPORTED: 'E_AUTH',
  E_API_PROVIDER_UNSUPPORTED: 'E_AUTH',
  E_CONFIG_CORRUPT: 'E_ENVIRONMENT',
  E_HOOKS_DISABLED_BY_USER: 'E_HOOKS_UNAVAILABLE',
  E_HOOKS_BLOCKED_BY_POLICY: 'E_HOOKS_UNAVAILABLE',
  // startup
  E_STARTUP_TIMEOUT: 'E_TIMEOUT',
  E_TRUST_REQUIRED: 'E_TRUST_REQUIRED',
  E_WORKSPACE_RISK: 'E_TRUST_REQUIRED',
  E_STARTUP_GATE: 'E_STARTUP',
  E_SETTINGS_INVALID: 'E_STARTUP',
  E_SESSION_ID_IN_USE: 'E_STARTUP',
  E_RESUME_NOT_FOUND: 'E_STARTUP',
  E_VERSION_POLICY: 'E_VERSION_MISMATCH',
  E_SELFTEST_FAILED: 'E_STARTUP',
  E_HOOKS_UNAVAILABLE: 'E_HOOKS_UNAVAILABLE',
  E_STARTUP_EXITED: 'E_STARTUP',
  // input
  E_BUSY: 'E_BUSY',
  E_NOT_READY: 'E_BUSY',
  E_SUBMIT_UNCONFIRMED: 'E_SUBMIT_UNCONFIRMED',
  E_INPUT_GATED: 'E_BUSY',
  E_INPUT_INVALID: 'E_INPUT_REJECTED',
  E_INPUT_REJECTED: 'E_INPUT_REJECTED',
  E_INPUT_TAMPERED: 'E_SECURITY',
  E_COMMAND_FORBIDDEN: 'E_INPUT_REJECTED',
  E_PERMISSION_UNKNOWN: 'E_PERMISSION_INVALID',
  E_PERMISSION_INVALID: 'E_PERMISSION_INVALID',
  E_MODE_FORBIDDEN: 'E_INPUT_REJECTED',
  E_WAIT_TIMEOUT: 'E_TIMEOUT',
  E_USAGE_UNAVAILABLE: 'E_ENVIRONMENT',
  // turn
  E_TURN_INTERRUPTED: 'E_TURN_FAILED',
  E_TURN_API_ERROR: 'E_TURN_FAILED',
  E_TURN_STALLED: 'E_TURN_FAILED',
  E_USAGE_LIMIT: 'E_USAGE_LIMIT',
  E_AUTH_REQUIRED: 'E_AUTH',
  E_TURN_ABORTED: 'E_TURN_FAILED',
  E_TURN_BLOCKED_BY_HOOK: 'E_TURN_FAILED',
  E_CLAUDE_VERSION_TOO_OLD: 'E_VERSION_MISMATCH',
  E_TURN_REFUSED: 'E_TURN_FAILED',
  // session
  E_SESSION_EXITED: 'E_SESSION_EXITED',
  E_SESSION_CLOSED: 'E_SESSION_CLOSED',
  E_HOOK_PORT_LOST: 'E_SESSION_EXITED',
  E_OWNER_GONE: 'E_SESSION_EXITED',
  // channel
  E_CHANNEL_DOWN: 'E_ENVIRONMENT',
  E_TRANSCRIPT_REWRITE: 'E_INTERNAL',
  E_SCREEN_UNKNOWN: 'E_INTERNAL',
  E_NETWORK_UNAVAILABLE: 'E_ENVIRONMENT',
  E_HOST_LOOP_LAG: 'E_ENVIRONMENT',
  // security
  E_SECURITY_UNEXPECTED_INPUT: 'E_SECURITY',
  E_SECURITY_HOOK_FORGERY: 'E_SECURITY',
  E_SECURITY_SETTINGS_TAMPERED: 'E_SECURITY',
  // feature
  E_UNSUPPORTED_FEATURE: 'E_CONFIG',
  // internal
  E_LISTENER_THREW: 'E_INTERNAL',
  E_INVARIANT: 'E_INTERNAL',
});

export type CcdErrorCategory =
  'config' | 'environment' | 'startup' | 'input' | 'turn' | 'session' | 'channel' | 'security' | 'feature' | 'internal';
export interface CcdErrorData {
  code: CcdErrorCode;
  message: string;
  details?: Record<string, JsonValue>;
}

const m = (category: CcdErrorCategory, retryable = false): { category: CcdErrorCategory; retryable: boolean } => ({ category, retryable });

/** Category follows the grouping of CCD_ERROR_CODES; `retryable` follows api-layering.md §7. */
export const ERROR_META: Readonly<Record<CcdErrorCode, { category: CcdErrorCategory; retryable: boolean }>> = Object.freeze({
  // config
  E_CONFIG_INVALID: m('config'),
  E_FORBIDDEN_ENV: m('config'),
  E_FORBIDDEN_ARG: m('config'),
  // environment
  E_NODE_UNSUPPORTED: m('environment'),
  E_TMUX_NOT_FOUND: m('environment'),
  E_TMUX_UNSUPPORTED: m('environment'),
  E_CLAUDE_NOT_FOUND: m('environment'),
  E_CLAUDE_VERSION_MISMATCH: m('environment'),
  E_UNSAFE_RUNTIME_DIR: m('environment'),
  E_SOCKET_PATH_TOO_LONG: m('environment'),
  E_KEYBINDING_CONFLICT: m('environment'),
  E_NOT_ONBOARDED: m('environment'),
  E_LOGIN_REQUIRED: m('environment'),
  E_AUTH_METHOD_UNSUPPORTED: m('environment'),
  E_API_PROVIDER_UNSUPPORTED: m('environment'),
  E_CONFIG_CORRUPT: m('environment'),
  E_HOOKS_DISABLED_BY_USER: m('environment'),
  E_HOOKS_BLOCKED_BY_POLICY: m('environment'),
  // startup
  E_STARTUP_TIMEOUT: m('startup', true),
  E_TRUST_REQUIRED: m('startup'),
  E_WORKSPACE_RISK: m('startup'),
  E_STARTUP_GATE: m('startup'),
  E_SETTINGS_INVALID: m('startup'),
  E_SESSION_ID_IN_USE: m('startup'),
  E_RESUME_NOT_FOUND: m('startup'),
  E_VERSION_POLICY: m('startup'),
  E_SELFTEST_FAILED: m('startup'),
  E_HOOKS_UNAVAILABLE: m('startup'),
  E_STARTUP_EXITED: m('startup'),
  // input
  E_BUSY: m('input', true),
  E_NOT_READY: m('input', true),
  E_SUBMIT_UNCONFIRMED: m('input', true),
  E_INPUT_GATED: m('input', true),
  E_INPUT_INVALID: m('input'),
  E_INPUT_REJECTED: m('input'),
  E_INPUT_TAMPERED: m('input'),
  E_COMMAND_FORBIDDEN: m('input'),
  E_PERMISSION_UNKNOWN: m('input'),
  E_PERMISSION_INVALID: m('input'),
  E_MODE_FORBIDDEN: m('input'),
  E_WAIT_TIMEOUT: m('input', true),
  E_USAGE_UNAVAILABLE: m('input', true),
  // turn
  E_TURN_INTERRUPTED: m('turn'),
  E_TURN_API_ERROR: m('turn', true),
  E_TURN_STALLED: m('turn', true),
  E_USAGE_LIMIT: m('turn', true),
  E_AUTH_REQUIRED: m('turn'),
  E_TURN_ABORTED: m('turn'),
  E_TURN_BLOCKED_BY_HOOK: m('turn'),
  E_CLAUDE_VERSION_TOO_OLD: m('turn'),
  E_TURN_REFUSED: m('turn'),
  // session
  E_SESSION_EXITED: m('session'),
  E_SESSION_CLOSED: m('session'),
  E_HOOK_PORT_LOST: m('session'),
  E_OWNER_GONE: m('session'),
  // channel
  E_CHANNEL_DOWN: m('channel'),
  E_TRANSCRIPT_REWRITE: m('channel'),
  E_SCREEN_UNKNOWN: m('channel'),
  E_NETWORK_UNAVAILABLE: m('channel'),
  E_HOST_LOOP_LAG: m('channel'),
  // security
  E_SECURITY_UNEXPECTED_INPUT: m('security'),
  E_SECURITY_HOOK_FORGERY: m('security'),
  E_SECURITY_SETTINGS_TAMPERED: m('security'),
  // feature
  E_UNSUPPORTED_FEATURE: m('feature'),
  // internal
  E_LISTENER_THREW: m('internal'),
  E_INVARIANT: m('internal'),
});

const CODE_SET: ReadonlySet<string> = new Set<string>(CCD_ERROR_CODES);

export class CcdError extends Error {
  // internal error (L0–L3)
  readonly code: CcdErrorCode;
  readonly category: CcdErrorCategory;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, JsonValue>>;
  constructor(code: CcdErrorCode, message: string, opts?: { cause?: unknown; details?: Record<string, JsonValue> }) {
    super(message, opts !== undefined && 'cause' in opts ? { cause: opts.cause } : undefined);
    this.name = 'CcdError';
    this.code = code;
    const meta = ERROR_META[code];
    this.category = meta.category;
    this.retryable = meta.retryable;
    if (opts?.details !== undefined) this.details = Object.freeze({ ...opts.details });
  }
  toJSON(): CcdErrorData {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: { ...this.details } };
  }
}

/** Duck-typed on `code`, not instanceof, so two installed package copies agree (P-API-12). */
export function isCctError(e: unknown, code?: CcdErrorCode): e is CcdError {
  if (typeof e !== 'object' || e === null) return false;
  const c = (e as { code?: unknown }).code;
  if (typeof c !== 'string' || !CODE_SET.has(c)) return false;
  if (typeof (e as { message?: unknown }).message !== 'string') return false;
  return code === undefined || c === code;
}
