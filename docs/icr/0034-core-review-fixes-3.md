# ICR 0034 — core review fixes, round 3 (sticky screen call states, agent closing, input safety, sidechain lines)

These are the core fixer's changes for the third round of confirmed review defects in area "core". Each item has a
regression test in `test/unit/core/icr0034-core-fixes.test.ts`. Each test was checked against its fix reverted (mutation
run in a scratch copy) and failed there. There is no model or event-schema change. One new diagnostic code was added
(`agent_turn_line_ignored`) and one new skip diagnostic (`clear_skipped`).

## Items

1. **Stall and retry banners leave no sticky call state** (`screen-stall-retry-sticky`, §4.6 Claims, §4.7 rule 11).
   - **Before.** `onStallClaim` and `onRetryClaim` set the open call to a provisional `stalled` or `retrying`. Nothing
     moved it back once the banner's claim ended. With the network channel off, status kept reporting
     `modelRequest.stalled` (or `retrying`) with the turn's confirmed provenance until the call ended.
   - **Fix.** The new `settleScreenCallStates` (model-calls.ts) returns every open call whose state is a provisional
     `stalled` or `retrying` to `waiting` when no matching claim is still asserted. `stalled` checks both
     `status:stalled` and `status:noResponse`. A screen-only `retry` detail is cleared with it. It runs when one of
     those claims ends (newer frame or TTL, in `applyClaimEffects`) and after `expireAllClaims` (screen down/off).
   - **Scope.** Only screen claims write provisional call states. Network and transcript states (`stalled` from the
     stall deadline, `retrying` from a transcript retry) are not provisional and are left alone. The fact's `src` is
     not checked, because a claim asserted by its stability deadline writes `src: 'clock'`.

2. **Closing rule 1 keeps a background agent's calls open** (`bg-agent-calls-closed-by-turn`, §4.8 rule 1).
   - **Fix.** `closeTurnCalls` skips calls whose agent is background, a teammate or not a `subagent`. This is the same
     scope rule as `isMainScoped` for permissions (ICR 0021). Those calls end by their own evidence, or by rule 2
     (item 3) or rule 4.
   - **Rule 4.** `closeProcess` now calls the new `closeAllCalls`, which ends every open call `unknown`. Before, it
     closed calls by turn, so a call with no turn was never closed.
   - **Goldens.** `bg-agents-task-notification` and `ghost-agent-after-stop` were regenerated. Call c8 belongs to the
     background agent. It no longer gets a synthetic `modelCall.ended{ok}` when t1 closes at 50899. It now ends at
     52055, from the agent's own transcript block, with its token usage.

3. **Every agent stop runs closing rule 2** (`agent-stop-without-rule2`, §4.8 rule 2, §4.5.4).
   - **Fix.** The new `stopAgent(ctx, k, 'stopped' | 'unknown')` in agents.ts is now the only way an agent stops. It is
     used by SubagentStop, a finished `<task-notification>`, `meta.json` `finished`, rule 3 and the drain check
     (`checkDrainPending` → `unknown`). On the first stop of a run it applies rule 2:
     - the agent's open ToolRuns → `unknown` (`agent_stopped`);
     - their open permissions → abandoned;
     - the agent's open model calls → `unknown`.

     For `stopped` it then publishes `subagent.stopped` and emits `tail.subagentStopped`. For `unknown` it publishes
     neither, as rule 3 did before. A later stop of the same run is ignored by the lattice, so the record is only
     enriched (for example with `lastAssistantMessage`).
   - **Clarification of rule 2.** Rule 2 names only ToolRuns. Abandoning their open permissions was already what
     rule 3 did through `closeAgentEntities` (now removed). Ending the agent's open calls is new: with item 2 they are no
     longer closed by the spawning turn, so without this they could outlive their agent. A late transcript end still
     upgrades them, because `unknown → ended` is `resolvedLate`. The abandon reason is `agentStopped`, or
     `generationEnded` for rule 3 and the drain check.
   - **`tail.subagentStopped.path`** now comes from the agent record's `transcriptPath`. SubagentStop writes that field
     first, so the value is unchanged for that path.

4. **Long texts sanitize without a stack overflow** (`sanitize-spread-rangeerror`, §3.6 step 1).
   - **Prompts.** `stripStandaloneInvisibles` built its result with `String.fromCodePoint(...out)`, which threw
     `RangeError` above about 125k code points. It now converts in chunks of 4096 code points. A prompt over
     `maxPromptBytes` is therefore rejected as `E_INPUT_INVALID{tooLarge}` at any size.
   - **Messages.** `sanitizeMessage` cuts its input to `4 × maxBytes` code units before cleaning, since only `maxBytes`
     survive anyway. It also removes every lone surrogate first and then cleans as usual. Before, a message with a lone
     surrogate skipped the control and invisible stripping altogether.

5. **A command never takes another actor's dialog as its modal** (`command-modal-grabs-foreign-dialogs`, §3.6
   Commands, P-SCREEN-22, P-TUI-15).
   - **Fix.** The new `selfOpenedModal` accepts only a generic `modal` or `unknownModal` surface, with no dialog or
     dialog kind `other`, and only while no permission request is held or shown as dialogOnly. The usage-limit menu,
     question, plan approval, elicitation, survey, rewind, permission, trust, resume and gate dialogs are not the
     command's effect. The job keeps waiting for its own evidence or its `modalEffect` deadline, and presses nothing.
   - **Deviation from the fix hint.** No per-command expected-modal pattern was added, because the profile has no such
     data. The kind filter is enough to remove every reported case.

6. **setMode presses no Escape on another actor's dialog** (`setmode-escape-on-permission-dialog`, §3.6 setMode, I6).
   - **Fix.** In `modeVerify`, a non-main surface, or a permission request that is held or shown as dialogOnly, still
     fails the job with `E_MODE_FORBIDDEN{dialog}`. The Escape is sent only when `selfOpenedModal` holds, which covers
     the mode-entry warning a BTab opens. No further BTab is pressed while a request is open.
   - **Known limit.** If the auto-mode entry warning were ever classified as a `permissionDialog`, it would now be left
     on screen and the job would fail without an Escape. That is the safe side: a wrong Escape would deny a real request.

7. **A keys-mode composer clear presses Escape only on a visible, idle composer**
   (`clear-escape-without-visible-composer`, §3.6, ICR 0028 item 4, IN §6.2).
   - **Start gate.** `runMachine` starts a `clearComposer` job only when all of these hold (`clearMayStart`):
     - the last frame is `main` and shows a composer;
     - no request is held or dialogOnly;
     - no turn is `running` and the footer is not busy.

     Before, the job waited only while a request was held. Until the conditions hold the job stays queued, and other
     jobs are not blocked.
   - **Step guard.** `clearStep` (keys) ends the clear as not done, with no key and with the `clear_skipped`
     diagnostic, in these cases: the composer is not visible, the surface is not `main`, a request is open, or Claude
     is busy. An empty composer still ends the clear as done.
   - **Deviation from DESIGN §3.6 Gate.** `clearComposer` stays in `BYPASS_KINDS`, so it does not wait for the FIFO or
     for `canSubmit`. Its own gate above is the narrower condition that keeps its Escapes safe.

8. **A host answer on the hook path aborts the handler's ask** (`host-answer-no-cancelask`, §3.7 step 3). In
   `answerPermission`'s hook branch, `by: 'host'` now emits `host.cancelAsk{answered}`, as the keys path already did
   (ICR 0028 item 2). `by: 'handler'` still only removes the ask silently, because the handler's own run removes its
   controller.

9. **A subagent file's turn lines never end the main turn** (`subagent-api-error-fails-main-turn`, §4.5,
   reconciliation.md "prompt_id never assigns subagent work to a turn").
   - **Fix.** `onApiErrorRecorded`, `onTurnInterrupted` and `onTurnDuration` ignore an observation that has
     `meta.agentId` set or a transcript origin with `sidechain: true`, and emit `agent_turn_line_ignored`.
   - **What still runs.** The account-wide effects of an API-error line still apply: `markLimited` and `authRequired`
     in step.ts, and `onDurationForDrain`.

10. **Claim TTL while the screen is degraded** (`claims-ttl-degraded-untested`; test only, ICR 0009 item 11). A
    `degraded` screen does not expire claims at once, but an asserted claim expires at its TTL. An `up` screen extends it.
    The test fails when `&& screenUp` is removed.

11. **`usageLimit.autoResume: false` never wakes Claude** (`autoresume-false-untested`; test only, §3.9). With a known
    reset time and the wall clock past reset plus jitter: no `usage.wakeScheduled`, no `usageWake` deadline, no new turn
    and no input primitive. The test fails without the `autoResume` guard in `schedule()`.
