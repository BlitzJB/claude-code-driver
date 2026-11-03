# ICR 0035: fixes from the first full live run (interrupt race, notification quiescence, refused network channel, running-tool interrupt, wide-footer notices)

These are the live-test owner's changes. They fix library bugs that the gated live suite and the free probes found
against the real Claude Code 2.1.316 (evidence: `docs/research/live-results.md`). Each item has a regression test. Each
test was run with its fix disabled and failed there. There is no public API or event-schema change and no new config
key.

## Items

1. **F-1: an interrupt asked before the PermissionRequest denies it through the hook** (§3.6 Interrupt, D-26).
   - **Before.** `interrupt()` while a tool was still in PreToolUse queued one Escape. The PermissionRequest then arrived
     and went to the policy or handler as usual. When the handler allowed it, the Escape went out while Claude's native
     dialog was still mounted (I6 releases a deferred Escape the moment the request is answered; in the live smoke run the
     Escape was already in flight). Claude rejected the tool "as the user": tool `denied`, `permission.resolved{user_keys,
     overridden}`, and the handler's allow was silently undone.
   - **Fix.** `onPermissionRequested` checks for an interrupt job of the same main turn. If one exists, a held,
     main-scoped request is answered `deny{interrupt:true}` (`by:'host'`) instead of going to the policy or handler.
     `takeInterruptFor` (machine.ts) withdraws the interrupt's Escape when it has not been emitted yet (a queued job, or the
     current job deferred or still leaving copy mode). An Escape already sent stays and waits for its evidence as before.
     `INTERRUPT_DENY` is now one constant shared with `interrupt()`.
   - **Test.** `test/unit/core/live-fixes.test.ts` (F-1, three cases).

2. **F-2: a stopped background agent keeps the session non-quiescent until its task-notification** (§4.5.4).
   - **Before.** `SubagentStop` of a background agent dropped the background count to 0, and the session read
     `quiescent:true` at once. The `<task-notification>` UPS (and its transcript `queue-operation`) came 38 ms later
     (live L-06). A host closing on `waitForQuiescence()` sent `/exit` into the notification turn, which then ended
     `unknown{session_end}`.
   - **Fix.** The new `awaitedNotifications(d, now, graceMs)` (selectors.ts) counts background subagents that stopped
     less than `transcriptSettleMs` (5000) ago and have no notification turn yet. It is added to the step's
     `pendingNotifications`. `stopAgent` arms an `escGap` wake (`notify:<agent>`) at the end of the grace, so the status
     re-derives on its own when no notification comes.
   - **Test.** `test/unit/core/live-fixes.test.ts` (F-2, two cases).

3. **F-3: a refused network channel is reported `off`** (§3.10).
   - **Before.** The launcher refused the channel (user proxy, `NO_PROXY` covering the API, proxy auth helper, no net
     port, sidecar start failure) and warned `E_NETWORK_UNAVAILABLE`. Nothing told the core, which starts with
     `network: up` whenever the channel is configured. `LaunchResult.network` was computed but never read. The snapshot
     kept reporting `channels.network: 'up'` (live L-07).
   - **Fix.** `defaultKernelServices().launch` posts `channel.health{network, off, reason}` when the channel is
     configured and the launch result says `off`. The reason comes from the launcher's warning.
   - **Test.** `test/kernel/live-fixes.test.ts` (F-3, two cases).

4. **F-4: an Escape during a running, hook-allowed tool ends it `interrupted`** (§4.6 ToolRun, TF §8.5).
   - **Before.** 2.1.316 writes an interrupt of a *running* Bash exactly like a rejection at its dialog:
     `toolDenialKind:"user-rejected"`, `toolUseResult:"User rejected tool use"`, no `permissionDecision`, no
     `hook_permission_decision` attachment (live L-04: a marker file proved the command ran). `toolResultState` mapped
     this to `denied`, and `onToolOutcome` resolved the permission `deny{user_keys, overridden:true}`.
   - **Fix.** `onToolResult` reads a `user-rejected` result as `interrupted` when the tool is `running` and either needed no
     permission request or had its request answered `allow` through the hook and delivered (the record is still
     `answered`, not fallen back to `dialogOnly`). `onToolOutcome` resolves such a permission `allow{hook}`. A rejection at
     a dialog we never answered stays `denied{user_keys}` (K-14 unchanged).
   - **Residual.** A human Escape in the ~150 ms after our hook allow, while Claude still shows the dialog, is now read as
     `interrupted` rather than `denied`. The turn outcome (`interrupted`) is the same either way.
   - **Test.** `test/unit/core/live-fixes.test.ts` (F-4, two cases).

5. **F-5: composer notices in the right-aligned footer segment are read** (ICR 0019, IN §6).
   - **Before.** At the default 250-column pane, 2.1.316 draws `Esc again to clear` (and the other overlays) in the
     footer row's right-aligned segment. `scanLines` got the whole footer row, and the anchored notice patterns
     (`^Esc again to clear$`, `^› stashed$`, `^Draft restored`) never matched. `composer.notices` stayed empty, so the
     keys-mode composer clear (`clear:hint`) stopped after the first Escape and failed `clearFailed` (live LP-32 capture).
   - **Fix.** `classifyMain` also passes the right-aligned segments to `scanLines`.
   - **Test.** `test/unit/channels/screen-to-facts.test.ts` ("reads the right-aligned `Esc again to clear` overlay …").

## Live-suite changes (test code only)

- L-01: the cached self-test is keyed by `cwdRealpath` (D-35), so the second start reuses the first cwd.
- L-07: the user proxy is set in the host env. A caller `env.set` proxy variable is ignored by design (§3.2, env-builder
  test "caller proxy vars are ignored").
- smoke and L-04: `status === 'runningTools'` also covers a tool still in PreToolUse, so `waitBashRunning`
  (support.ts) waits for a `running` snapshot plus output on screen or 3 s. L-04's command writes a marker file, and the
  test asserts the tool ends `interrupted`.
- `CCD_LIVE_TRACE=1` writes a `.ccd.jsonl` trace per live session.
