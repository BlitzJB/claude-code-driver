// platform/tmux/errors.ts — typed tmux errors and the stderr mapper (DESIGN.md §2.7.3 L0 error list, P-TMUX-62; TD §1.2).
//
// Every class carries `suggestedCode`, the internal CcdErrorCode that `session/errors-map.ts` should use by default.
// `TmuxCommandFailed` never carries user text: only command names (argv is redacted) and a bounded stderr excerpt.

import type { CcdErrorCode } from '../../model/errors.js';

export type TmuxErrorKind =
  | 'TmuxNotFound'
  | 'TmuxVersionUnsupported'
  | 'TmuxUnsupported'
  | 'TmuxServerGone'
  | 'TmuxCrashed'
  | 'TmuxTargetMissing'
  | 'TmuxDuplicate'
  | 'TmuxArgTooLong'
  | 'TmuxPaneDead'
  | 'TmuxPaneInMode'
  | 'TmuxInvalidInput'
  | 'TmuxSocketPathTooLong'
  | 'TmuxSpawnFailed'
  | 'TmuxCommandFailed';

const STDERR_MAX = 500;

export abstract class TmuxError extends Error {
  abstract readonly kind: TmuxErrorKind;
  abstract readonly suggestedCode: CcdErrorCode;
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name; // class names equal the `kind` values
  }
}

export class TmuxNotFound extends TmuxError {
  readonly kind = 'TmuxNotFound';
  readonly suggestedCode = 'E_TMUX_NOT_FOUND';
  constructor(readonly searched: readonly string[]) {
    super(`tmux not found (searched: ${searched.join(', ') || 'nothing'}); install it (e.g. 'brew install tmux') or pass tmux.bin`);
  }
}

export class TmuxVersionUnsupported extends TmuxError {
  readonly kind = 'TmuxVersionUnsupported';
  readonly suggestedCode = 'E_TMUX_UNSUPPORTED';
  readonly reason = 'version';
  constructor(
    readonly found: string,
    readonly min: string,
  ) {
    super(`tmux ${found} is not supported (minimum ${min})`);
  }
}

/** A tmux build whose behaviour breaks an input-safety assumption (LP-52: `#{pane_key_mode}` must be `VT10x`). */
export class TmuxUnsupported extends TmuxError {
  readonly kind = 'TmuxUnsupported';
  readonly suggestedCode = 'E_TMUX_UNSUPPORTED';
  constructor(
    readonly reason: 'extendedKeys',
    readonly found: string,
  ) {
    super(`tmux pane key mode is '${found}', expected 'VT10x' (extended keys would change what Enter sends)`);
  }
}

export class TmuxServerGone extends TmuxError {
  readonly kind = 'TmuxServerGone';
  readonly suggestedCode = 'E_SESSION_EXITED';
  constructor(readonly stderr: string) {
    super(`tmux server is gone: ${stderr.slice(0, STDERR_MAX)}`);
  }
}

export class TmuxCrashed extends TmuxError {
  readonly kind = 'TmuxCrashed';
  readonly suggestedCode = 'E_SESSION_EXITED';
  constructor(readonly stderr: string) {
    super(`tmux server exited unexpectedly: ${stderr.slice(0, STDERR_MAX)}`);
  }
}

export class TmuxTargetMissing extends TmuxError {
  readonly kind = 'TmuxTargetMissing';
  readonly suggestedCode = 'E_SESSION_EXITED';
  constructor(readonly target: string) {
    super(`tmux target not found: ${target}`);
  }
}

export class TmuxDuplicate extends TmuxError {
  readonly kind = 'TmuxDuplicate';
  readonly suggestedCode = 'E_INVARIANT';
  constructor(readonly what: string) {
    super(`tmux duplicate: ${what}`);
  }
}

export class TmuxArgTooLong extends TmuxError {
  readonly kind = 'TmuxArgTooLong';
  readonly suggestedCode = 'E_INPUT_INVALID';
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`tmux argv too long: ${bytes} bytes > ${limit} (text must go through load-buffer stdin)`);
  }
}

export class TmuxPaneDead extends TmuxError {
  readonly kind = 'TmuxPaneDead';
  readonly suggestedCode = 'E_SESSION_EXITED';
  constructor(
    readonly paneId: string,
    readonly exitStatus: number | null,
    readonly exitSignal: string | null,
  ) {
    super(`tmux pane ${paneId} is dead (status ${exitStatus ?? '-'}, signal ${exitSignal ?? '-'}); input refused`);
  }
}

/** Input attempted while the pane is in copy/view mode: keys would go to copy mode, not to the app (P-TMUX-45). */
export class TmuxPaneInMode extends TmuxError {
  readonly kind = 'TmuxPaneInMode';
  readonly suggestedCode = 'E_INPUT_GATED';
  constructor(readonly paneId: string) {
    super(`tmux pane ${paneId} is in copy mode; call exitCopyMode() before input`);
  }
}

export class TmuxInvalidInput extends TmuxError {
  readonly kind = 'TmuxInvalidInput';
  readonly suggestedCode = 'E_INPUT_INVALID';
  constructor(
    readonly reason: 'notWellFormed' | 'controlChar' | 'unknownKey' | 'badOption',
    detail: string,
  ) {
    super(`tmux input rejected (${reason}): ${detail}`);
  }
}

export class TmuxSocketPathTooLong extends TmuxError {
  readonly kind = 'TmuxSocketPathTooLong';
  readonly suggestedCode = 'E_SOCKET_PATH_TOO_LONG';
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`tmux socket path is ${bytes} bytes (> ${limit}); use a shorter TMUX_TMPDIR or socket name`);
  }
}

/** Post-spawn verification failed (unparsable -P output, size could not be pinned). */
export class TmuxSpawnFailed extends TmuxError {
  readonly kind = 'TmuxSpawnFailed';
  readonly suggestedCode = 'E_INVARIANT';
  constructor(
    readonly reason: 'unparsableOutput' | 'sizeMismatch' | 'paneMissing',
    detail: string,
  ) {
    super(`tmux spawn verification failed (${reason}): ${detail}`);
  }
}

export class TmuxCommandFailed extends TmuxError {
  readonly kind = 'TmuxCommandFailed';
  readonly suggestedCode = 'E_INVARIANT';
  constructor(
    readonly code: number | null,
    readonly stderr: string,
    /** Command names only (`['load-buffer','paste-buffer']`); never argument values. */
    readonly commands: readonly string[],
    readonly timedOut = false,
  ) {
    super(`tmux ${commands.join(' ; ')} failed (${timedOut ? 'timeout' : `exit ${code ?? 'signal'}`}): ${stderr.slice(0, STDERR_MAX)}`);
  }
}

export function isTmuxError(e: unknown): e is TmuxError {
  return e instanceof TmuxError;
}

/** True for errors that mean the server (and therefore every pane on it) no longer exists. */
export function isServerGoneError(e: unknown): e is TmuxServerGone | TmuxCrashed {
  return e instanceof TmuxServerGone || e instanceof TmuxCrashed;
}

/**
 * Map a failed tmux invocation to a typed error (TD §1.2 strings, VERIFIED on 3.5a):
 * `server exited unexpectedly`, `no server running on <path>`, `error connecting to <path> (…)`,
 * `can't find pane: %9`, `can't find session: X`, `can't find window: X`, `no such session: X`,
 * `duplicate session: X`, `command too long`.
 */
export function mapTmuxFailure(f: {
  code: number | null;
  stderr: string;
  commands: readonly string[];
  timedOut: boolean;
  argvBytes: number;
}): TmuxError {
  const s = f.stderr;
  if (f.timedOut) return new TmuxCommandFailed(f.code, s, f.commands, true);
  if (s.includes('server exited unexpectedly')) return new TmuxCrashed(s);
  if (/no server running on|error connecting to|lost server/.test(s)) return new TmuxServerGone(s);
  const missing = /can't find (?:pane|session|window|client): ?(\S*)|no such (?:session|window|pane): ?(\S*)/.exec(s);
  if (missing !== null) return new TmuxTargetMissing(missing[1] ?? missing[2] ?? '');
  const dup = /duplicate session: ?(\S*)/.exec(s);
  if (dup !== null) return new TmuxDuplicate(`session ${dup[1] ?? ''}`);
  if (s.includes('command too long')) return new TmuxArgTooLong(f.argvBytes, ARG_LIMIT_BYTES);
  return new TmuxCommandFailed(f.code, s, f.commands, false);
}

/** P-TMUX-06: the tmux client→server message is ≈ 16 KiB; the driver refuses argv above 12 KiB. */
export const ARG_LIMIT_BYTES = 12 * 1024;
/** `typeLiteral` cap (TD §2.3 rule: argv text ≤ 8 KiB). */
export const LITERAL_LIMIT_BYTES = 8 * 1024;
