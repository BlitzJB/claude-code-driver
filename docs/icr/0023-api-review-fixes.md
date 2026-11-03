# ICR 0023 — API review fixes (permission event deadline, replay iterators, unknown outcome, turn.stop, start abort)

Area: api (`src/api/*`), with the minimal model/core changes the fixes need (`model/events.ts`, `model/commands.ts`,
`core/decide/permissions.ts`, `core/decide/commands.ts`, `core/input-policy/machine.ts`).

## 1. `permission.requested` carries `background` and `deadlineAt` (spec deviation: event payload)

The facade computed `permissionRequested.background` as "the agent record is a background agent" and `deadlineAt` as
`requestedAt + permissions.timeoutMs` (a copy of the config default). The core's rule (§3.7 step 10,
`isBackground()`) treats any request carrying an agent as background and arms `permissionPolicy` at
`backgroundTimeoutMs` (10 s). A foreground Task subagent's request was therefore published as `background:false` with a
120 s deadline while the core answered on timeout after 10 s, and the handler path (`askFromState`, `host.askPermission`)
reported the true values for the same request (the agreement ICR 0013 item 8 requires).

Change: the domain event `permission.requested` gains `background: boolean` (the core's `isBackground`) and
`deadlineAt: MonoMs` (the armed `permissionPolicy` deadline; for an adopted dialog the deadline is now armed before the
event is published). `api/map-events.ts` maps both straight through (wall time via the ICR 0015 mono → wall offset, as for
the handler's `deadlineAt`). `EventCtx.permissionTimeoutMs`, `MappedOptions.permissionTimeoutMs` and
`DEFAULT_PERMISSION_TIMEOUT_MS` are removed: the facade no longer duplicates the core's deadline policy.

## 2. Replaying iterators end after `close()` without a published `session.exited`

`events({ fromSeq })` iterators ended only on a domain `session.exited`. When `close()` resolved before the kernel published
it (kernel close gives up after `CLOSE_EXIT_WAIT_MS`), no such event ever came and those iterators hung, as did one opened
after such a close with `fromSeq <= exitSeq`. Replay iterators are now tracked; once the session exited, an iterator ends as
soon as it has been handed everything up to `exitSeq` (events or a `gap`), after the stand-in `exited` event `close()`
emitted (so every iterator sees exactly one `exited`, ICR 0015 item 8).

## 3. Turn outcome `unknown` maps to `E_SESSION_EXITED` only for `endedBy: 'process_exit'`

The core ends turns `unknown` without an error while the process is alive (superseded after a hook gap, a placeholder
merge, a generation switch such as `/clear` or resume). The facade mapped every such outcome to `E_SESSION_EXITED`, telling
hosts to restart a healthy session. Now: `unknown` + `endedBy: 'process_exit'` → `E_SESSION_EXITED`; any other `unknown` →
reason `E_TURN_STALLED` (public `E_TURN_FAILED`) with `details.detail: 'outcomeUnknown'` and `details.endedBy`.
`Turn.abandon()` (session ended without a `turnEnded`) keeps its own `E_SESSION_EXITED`.

## 4. New core command `turn.stop` (spec deviation: Command union)

`Turn.interrupt()` / an aborted `send({ signal })` read `getState()` and dispatched `prompt.cancel` (queued) or `interrupt`.
The command runs in a later step: if the input machine made the turn's submit job current in between (or during the
copy-mode exit window, where the turn stays `queued` while its job is current), `prompt.cancel` failed `notQueued`, the
signal path swallowed it, and the prompt ran to completion. Also a turn `submitting` before Enter was not the main turn, so
`interrupt` was ignored (`notBusy`).

`{ type: 'turn.stop'; turnKey }` → `{ ok: true; effect: 'cancelled' | 'interrupted' | 'none' }`, decided on the state of
its own step: ended → `none`; queued with its job not current → cancelled (as `prompt.cancel`); queued with its submit job
current but not begun (copy-mode exit pending, nothing typed) → that job is dropped (`abortUnbegunSubmit`) and the turn
cancelled; the main turn → the session interrupt (§3.6, held permission → deny{interrupt}); its submit in progress → an
interrupt job queued at the front, so the Escape is sent once the submit job finished (accepted → interrupts the turn; a
failed submit → the job starts with no active turn and is ignored, existing rule); running but not main (merged) → the
session interrupt. `prompt.cancel` is unchanged. The facade's `stopTurn` dispatches only `turn.stop`.

## 5. Aborting `start()` always rejects `E_SESSION_CLOSED{ detail: 'aborted' }`

An abort during preflight/launch surfaced as a raw `DOMException` (no reason), or as `E_INTERNAL{E_INVARIANT}` (a string or
Error reason, via runtime/node.ts `abortError`). `ClaudeSession.start` now rejects, whenever its signal is aborted after a
failure, with the same `ClaudeSessionError` as an abort before launch: `E_SESSION_CLOSED`, `details.detail: 'aborted'`,
the original as `cause`. (`createKernel`'s own AbortError contract, ICR 0016, is unchanged.)

Tests: `test/unit/core/permissions.test.ts` (foreground subagent background/deadline; adopted dialog deadline),
`test/unit/core/turns.test.ts` (`turn.stop` cases, incl. the copy-mode window where `prompt.cancel` fails),
`test/unit/api/map-events.test.ts` (payload mapping; `unknown` by `endedBy`), `test/unit/api/claude-session.test.ts`
(replay iterators after a close without `session.exited`; `turn.stop` dispatch; start abort shapes),
`test/unit/api/options.test.ts`.
