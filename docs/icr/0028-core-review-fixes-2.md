# ICR 0028 — core review fixes, round 2 (held interrupts, key answers, I6 deadlines, close, adoption)

These are the core fixer's changes for the second round of confirmed review defects in area "core". Each item has a
regression test in `test/unit/core/icr0028-core-fixes.test.ts`, and each of those tests failed with its fix reverted.
There is no model change. One internal job phase was added: `permissionKeys.phase` gained `'check'`.

## Items

1. **A held provisional interrupt that loses the active slot** (`held-interrupt-superseded-never-ends`, §4.4#15).
   - **Before.** The screen banner holds turn t1 as `interrupted{provisional}` while it is still `activeTurn`. If a new
     UPS arrived in that window (a queued task notification, or a human prompt), t2 became active. t1 then never got
     `turn.ended`: the transcript confirmation was a same-value upgrade with `wasHeld=false`, and `releaseHeldTurn`
     returned early because t1 was no longer active.
   - **Fix.** `setActiveTurn` now releases a held turn before it hands the slot to another turn. The released turn gets
     `turn.ended{confirmed:false}`, is pushed to `closedTurns` (closing rule 1), has its `interruptConfirm` disarmed, and
     ends its merged turns. A later transcript confirmation upgrades the fact but publishes no second `turn.ended`.
   - **`continueTurn`.** It no longer revives a provisional interrupt while another turn holds the active slot. Before,
     a late PostToolUse for a t1 tool set t1 back to `running` while t2 was active, and t1 could then never end.
   - **Internal change.** `setTurnState` clears the active slot with `unset` instead of `setActiveTurn`, so ending a turn
     never re-enters the release path.

2. **dialogOnly key answers are idempotent** (`dialogonly-keys-answer-not-idempotent`, §3.7 step 7, SEC §4.3).
   - **One answer per record.** `answerPermission` refuses a record that already has a queued or running
     `permissionKeys` job, with `notPending`. This is derived from the job table, so no new state is kept. Queuing a
     keys answer also emits `host.cancelAsk`, so the handler and the host cannot both press a key. A failed keys job
     leaves the record answerable again.
   - **Check before the key.** `begin('permissionKeys')` re-checks right before sending:
     - the record is still `dialogOnly` with no answer of ours;
     - the frame still shows a permission dialog. If it does not, the job requests one fresh frame (phase `check`) and
       checks again;
     - for an allow, the digit is still the dialog's one exact `Yes`.

     If any check fails, the job ends without a key, emitting the `permission_keys_skipped` diagnostic and
     `permissionKeysDone{ok:false}`. With the screen channel down, an allow is never pressed blind. A deny is still
     sent, as before.

3. **Releasing a held host ends its merged turns** (`release-held-skips-merged-turns`, §4.4#8). The merged-turn loop is
   now the helper `endMergedTurns`. `setTurnState` calls it on every terminal path, including the same-value upgrade.
   `releaseHeldTurn` calls it too.

4. **An Enter withheld by I6 arms no deadline** (`i6-deferred-enter-arms-ack-deadline`, ICR 0009 item 3).
   - **Arming on send.** `sendEnter` and the `ackCheck` retry arm `submitAck` / `modalEffect`, and set `enterAt` and
     `blockNoticeAtEnter`, only once `send()` actually emitted the Enter (`enterSent`). When `runMachine` re-sends a
     withheld Enter after the hold, it arms the deadline at that point.
   - **Withheld jobs.** While `j.deferred` is set, `submitAck` / `modalEffect` deadlines for the job are ignored. The
     command modal detection in `onFrameForJobs` is skipped too.
   - **Composer clears.** A `clearComposer` job does not start while a request is held. Its Escape would deny the
     visible dialog, and I6 allows Escape only for an explicit interrupt or deny.

5. **A second interrupt during a held provisional interrupt presses nothing** (`second-interrupt-double-esc-rewind`,
   §3.6 Interrupt, IN §6.2). `commands.interrupt()` treats a held turn (terminal state, still `activeTurn`) as not busy,
   and so does `begin('interrupt')`. In both cases `interrupt.ignored{notBusy}` is published and no Escape is sent.
   - **Deviation from the fix hint.** No extra `lastEscAt` time window was added. The not-busy rule removes the only path
     that pressed an Escape on the idle composer. A time window would also drop a legitimate interrupt of a new turn
     that starts within 1 s of an unrelated Escape.

6. **The resume prompt is sanitized** (`resume-prompt-unsanitized`, D-16, P-SEC-07). `resumeSubmit` passes
   `usageLimit.resumePrompt` through `sanitizePrompt`, with the same options as `prompt.send`.
   - **Effect.** A leading `!` is escaped and a trailing `\` gets its space. Controls and invisible characters are
     removed.
   - **Rejected values.** The wake does not type a value the sanitizer rejects (a leading `/`, empty, too large).
     Instead it publishes `warning{code:'E_CONFIG_INVALID'}` and submits the default `continue`, so the wake still
     submits and the limit does not stay `waking`.
   - **Not done here.** Rejecting the value at config resolution (`src/session/config.ts`) belongs to the session area
     and was left out.

7. **Requests after close() began are denied** (`permission-requests-during-closing-use-normal-policy`, D-18, SEC §1
   rule 9). In `onPermissionRequested`, while `lifecycle === 'closing'`:
   - a held request is answered `deny 'Denied: session closing'` with `by:'close'`, through the hook;
   - a not-held (dialogOnly) request is denied by keys.

   No policy is applied and nobody is asked. The `closePending` wait (`waitForBackgroundMs`, before `proceedClose`)
   keeps the normal policy on purpose: it exists so that background agents can finish.

8. **Dialog adoption is scoped and retried** (`adoption-blocked-by-any-open-record`, §3.7 step 8).
   - **New rule.** `adoptionBlocked` replaces the session-wide check, both in `applyClaimEffects` and in the adopt
     deadline. Adoption is blocked by:
     - a `pending` or `answered` record that is main-scoped (`isMainScoped`) and whose `permTurn` is the active turn;
     - a `dialogOnly` record of any scope.
   - **Clarification of §3.7 step 8.** A dialogOnly record is by definition the native dialog on screen. If it did not
     block, a background agent's visible dialog would be adopted a second time. Such a record is abandoned once its
     dialog leaves.
   - **Retry.** The new `retryDialogAdoption` runs at the end of each step. It arms `adoptDialog` when a permission
     dialog claim is still asserted, nothing blocks it, and no adoption deadline is armed. This covers the case where
     the blocking record closed while the dialog stayed on screen, since a claim that stays asserted never asserts
     again.
   - **Retry window.** The retry waits `adoptDialogMs + channels.screen.idlePollMs`, not `adoptDialogMs`. When the
     record closes, the last frame may still be that record's own dialog. If the dialog leaves, the next poll brings a
     new frame and the claim expires, so nothing is adopted. If the dialog stays, the screen is unchanged and gives no
     new frame (L1 drops it), so the claim stays asserted and the dialog is adopted. With the plain 500 ms window, the
     goldens `ghost-agent-after-stop` and `hook-held-35s` adopted a dialog that had already gone. An extra capture
     request was also tried and dropped, because in the raw replays it changed which recorded frame a capture resolved
     to.
