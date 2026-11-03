# ICR 0021 — core review fixes (turn-line binding, session-scoped background agents, idle inputs, wake re-arm)

The core fixer's changes for the confirmed review defects of area "core". Each item has a regression test in
`test/unit/core/icr0021-core-fixes.test.ts`. Every one of those tests failed with its fix reverted. The exception is the
"count 0 → unknown" companion test, which is a positive control.

## Model change (`src/model/observation.ts`, additive)

`turn.durationRecorded` and `model.apiErrorRecorded` gained an optional `promptId?: string`. The transcript normalizer
(`src/channels/transcript/normalize.ts`) sets it to the entry's own `promptId`, or else the file's current prompt chain
(`FileState.promptId`, the last user entry). Absent means unbound, and every existing producer still type-checks.

## Items

1. **turn_duration / API-error line binding** (`turn-duration-misattributed`, §4.4#15/#16/#20). These lines were given
   to whatever turn was `activeTurn`. A late `turn_duration` of turn A could therefore end turn B, which supersede had
   just started (K-25, Stop and a task-notification UPS in the same ms), 500 ms later while B was still working. The new
   `turnOfTurnLine` resolves the line's turn in this order:
   - by `promptId`;
   - else the active turn if it is `stopping`;
   - else the most recent turn that ended within `transcriptSettleMs` through its Stop (`completed`, `endedBy:'stop'`,
     no `durationMs` yet) or, for an API-error line, through its StopFailure (`failed`, `endedBy:'stop_failure'`);
   - else the active or most recent turn.

   A turn whose own promptId differs from the line's is never chosen. The `dur:` grace is armed only when the resolved
   turn is the active one and is `running`. An API-error line for a terminal turn is ignored. Defence in depth:
   main-thread `tool.pre`, `message.textDelta`, `message.block` and `model.requestStarted` (no `meta.agentId`) disarm a
   pending `stopGrace:dur:<active>` (`noteMainActivity`). Spec reading: §4.5 "main-thread observations go to activeTurn"
   does not apply to turn-level lines that name another turn's chain. This is consistent with §4.4 row 1695, where
   turn_duration ends the turn that had no Stop.
2. **Closing rule 1 and background agents** (`bg-agent-permission-abandoned-on-turn-end`, §4.8 rule 1). `closeTurn`
   abandons only permissions for which `isMainScoped` holds. That means the main thread, or a foreground `subagent` that
   is not background. It does not mean a background, teammate or internal agent, or a carried agent id that does not
   resolve. Such requests outlive the turn and keep their `backgroundTimeoutMs` policy deadline. For an unbound request
   that carries an agent id, `permTurn` now comes from the agent's spawn chain (`turnOfAgent`), never from `mainTurn()`.
3. **interrupt() target** (`interrupt-denies-wrong-permission`, §3.6 Interrupt). The held request that gets
   `deny{interrupt:true}` must be the active turn's (`permTurn`) and main-scoped (`heldPermissionOfTurn`, the oldest one
   first). Otherwise the Escape path runs.
4. **Idle / background pending inputs** (`agent-needs-input-stuck`, §4.6 PendingInput, §4.7).
   - `agent_needs_input` becomes a pending input only while a turn is active, and only from the main thread or a
     foreground subagent (`meta.agentId`). Otherwise there is only a diag `input_request_not_pending`.
   - An elicitation still counts while idle, because it is a real modal on main. A hook-sourced request that is left
     over with no turn is cleared `screenGone` on an idle main frame (`isIdleMain`) once it is older than the 2 s modal
     hold and while no modal claim is active (`onFrameForInputs`).

   Deviation: §4.6 says a request counts "while a turn is active". For hook elicitations this ICR keeps the existing
   idle acceptance and adds the screen-based clearing, because ignoring a visible MCP dialog would open canSubmit over
   it.
5. **Wake re-arm on an undelivered resume turn** (`usage-waking-stuck-after-submit-fail`, §3.9 step 5). When the
   auto_continue turn ends `notSubmitted` (submitFailed) or is cancelled while the limit is `waking`, `rearm()` runs
   (`onWakeTurnUndelivered`), as `onWakeDone(false)` and `onMenuDismissed(false)` already did. If the reset time is
   already past, the re-armed wake fires on the next tick. After `maxRearms` the existing give-up warning
   (`E_USAGE_LIMIT{maxRearms}`) tells the host.
6. **Status rule 9** (`status-running-tools-from-background-agent`, §4.7). `openMainTools` requires
   `t.agent === undefined`. Foreground subagent tools still count through `fgAgentTools`. Goldens
   `bg-agents-task-notification` and `ghost-agent-after-stop` were re-recorded (`-u`, reviewed). The only change is that
   the background agent's Bash (u4) is no longer in `runningTools`, so four `status.changed` events are gone and the
   later `since` values move. Their `permission.requested` lines also carry the `background`/`deadlineAt` payload fields
   that another fixer has in flight.
7. **Command args trailing backslash** (`command-args-trailing-backslash`, P-TUI-06). After `trim()`,
   `sanitizeCommandArgs` appends one space to args ending in `\`, as `sanitizePrompt` does per line.
8. **Attachment binding** (`attachment-bind-ignores-input`, §4.5.1). An unbound, non-adopted record is bound by a
   `hookPermissionDecision` attachment only if `lateBindMatches` holds: same name, canonical-equal input, and the agent
   rule. Adopted records are always candidates. With several candidates, those whose `ourAnswer` matches the decision
   are preferred. If it is still ambiguous, nothing is bound (diag `attachment_bind_ambiguous`), and the code falls back
   to `rebindWrongGuess`. No other request's hook is released or resolved.
9. **Coverage only**: `checkDrainPending`'s `pendingCount > 0` branch (`mut-drain-pendingcount-untested`, §4.5.4) and
   `closeProcess` clearing inputs that are open outside any turn (`mut-closeprocess-inputs-untested`, §4.8 rule 4) now
   have tests. Code is unchanged.
