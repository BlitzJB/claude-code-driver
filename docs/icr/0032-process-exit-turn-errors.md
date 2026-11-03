# ICR 0032 — Turns ended by process exit report E_SESSION_EXITED; turn snapshots carry the implied error

Area: api (`src/api/map-errors.ts`, `src/api/map-events.ts`, `src/api/map-state.ts`). No model, core or session change.

## 1. Any turn ended by the process-exit closing rule reports `E_SESSION_EXITED`

`core/closing.ts` `closeProcess` ends a turn that is still `queued` (waiting in the library queue) or `submitting` as
`notSubmitted{endedBy: process_exit}` with no error. `outcomeError` treated `process_exit` specially only for `unknown`,
so such a turn ended with `E_SUBMIT_UNCONFIRMED` — retryable, and meaning "may have been typed" — although the prompt
never left the queue and the session is gone. A host retrying on `retryable` got `E_SESSION_EXITED` from `send()`. The
`ClaudeSession` exit backstop that sets `E_SESSION_EXITED` never ran, because the kernel's `turn.ended` arrives first.

Change (clarifies §4.4 rule 4 / ICR 0023 §3): when the core attaches no error, `endedBy === 'process_exit'` maps to
`E_SESSION_EXITED{reason E_SESSION_EXITED, outcome, endedBy}` for every unsuccessful outcome, not only `unknown`. The
`outcome` stays as the core reports it (`notSubmitted` for a never-typed turn). `E_SUBMIT_UNCONFIRMED` remains the
error of a failed submit job while the process is alive (§4.4 "submitting | submit job failed").

## 2. `TurnSnapshot.error` agrees with `TurnResult.error`

`toTurnSnapshot` read only `TurnRecord.error`, so a turn ended without a recorded error had `snapshot().error`
undefined while its `done` result carried one. It now falls back to the same `outcomeError(state, endedBy)` rule used by
`toTurnResult` for any terminal, non-completed turn. `outcomeError` moved to `map-errors.ts` (re-exported from
`map-events.ts`) so `map-state.ts` can use it without an import cycle.
