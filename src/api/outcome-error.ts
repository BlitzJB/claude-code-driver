// api/outcome-error.ts — the public error of a turn that ended without one (DESIGN.md §2.12, ICR 0023, ICR 0032).
// Kept out of map-errors.ts: its signature names model/events types, and map-errors.d.ts is part of the public declaration
// graph (scripts/api-report.mjs), so importing them there would leak DomainEvent and friends into the public API (§1.3).

import type { CcdErrorCode } from '../model/errors.js';
import type { TurnEndedBy, TurnOutcome as InternalOutcome } from '../model/events.js';
import { publicError, type ClaudeSessionError } from './map-errors.js';

/**
 * Why a turn that did not complete failed, when the core attached no error (details.reason = an internal code). 'unknown'
 * means the process is gone only when the turn was ended by the process-exit closing rule; otherwise (a superseded turn
 * after a hook gap, a placeholder merge, a generation switch such as /clear or resume) the session is alive and the turn's
 * fate was lost: E_TURN_STALLED (public E_TURN_FAILED), never E_SESSION_EXITED (ICR 0023).
 */
const OUTCOME_REASON: Readonly<Record<Exclude<InternalOutcome, 'completed'>, CcdErrorCode>> = {
  interrupted: 'E_TURN_INTERRUPTED',
  failed: 'E_TURN_API_ERROR',
  aborted: 'E_TURN_ABORTED',
  withdrawn: 'E_TURN_ABORTED',
  notSubmitted: 'E_SUBMIT_UNCONFIRMED',
  unknown: 'E_TURN_STALLED',
};

/**
 * The error of a turn that ended without one. Any turn ended by the process-exit closing rule (§4.4 rule 4: 'unknown' for a
 * running turn, 'notSubmitted' for one still queued or submitting) reports E_SESSION_EXITED: the session is gone, so the
 * retryable E_SUBMIT_UNCONFIRMED ("may have been typed") would invite a retry that can only fail (ICR 0032).
 */
export function outcomeError(outcome: Exclude<InternalOutcome, 'completed'>, endedBy?: TurnEndedBy): ClaudeSessionError {
  const reason = endedBy === 'process_exit' ? 'E_SESSION_EXITED' : OUTCOME_REASON[outcome];
  const details = outcome === 'unknown' && reason !== 'E_SESSION_EXITED' ? { outcome, detail: 'outcomeUnknown' } : { outcome };
  return publicError(reason, `turn ended: ${outcome}`, endedBy === undefined ? details : { ...details, endedBy });
}
