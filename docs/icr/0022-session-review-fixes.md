# ICR 0022 — session review fixes (kernel start/close, trust ownership)

Fixes from the review of `src/session/**`. Each item names the regression test.

## 1. close() during start (DESIGN §3.1 step 15, §3.8, §2.10 "abort = close({mode:'kill'})")

- `close()` sets a `closeRequested` flag synchronously. `start()` checks it after every await of an attempt and before
  the one unix relaunch: it then rejects with `E_SESSION_CLOSED` and never launches again; the session that close() found
  is closed by close(). Any other exception out of an attempt aborts the launched session and tears the kernel down
  (no orphaned tmux server / Claude / timers).
  Tests: `kernel.test.ts` "close() while a failed attempt is being aborted → no relaunch after close".
- close() no longer waits for the whole `startPromise` while `launched` is unset. It waits only for the in-flight
  `services.launch` call (its result is attached in the same continuation), then kills it at once. The self-test is never
  started after a close. Test: "close({mode:'kill'}) while the launch call is in flight …".
- Deviation from the old wording "close waits for start": a start that is closed rejects with `E_SESSION_CLOSED`
  (createKernel still maps an abort to AbortError).

## 2. kill escalates a running graceful close (D-27, caveats/lifecycle.md "second signal forces")

`kernel.close({mode:'kill'})` while a graceful close runs returns the same promise but switches the close to kill: the
graceful wait (grace + waitForBackgroundMs) is cancelled and the launched session is closed with mode `kill` (SIGKILL,
§3.8 step 5). Residual gap: if the launched session's own close sequence (lifecycle step 5, `killAfterMs`) has already
started gracefully, that sequence finishes (≤ killAfterMs) — the 12 s grace is never waited out.
Test: "close({mode:'kill'}) during a running graceful close escalates it at once".

## 3. The K-37 transcript-evidence wait can see the tail (ICR 0011 item 5, P-TAIL-37)

A `lifecycle.finalize` intent that arrives before `session.ready` no longer stops the executors (tail driver, pollers)
or kills Claude. start() owns that teardown: it decides (the up-to-1.5 s evidence wait included) and then calls
`abort()`; a close() during start closes it. A deferred finalize that is followed by ready (never expected) runs then.
`FakeClaudeOptions.promptTranscriptLagMs` (testing) delays the prompt's transcript entry.
Test: `test/kernel/startup.test.ts` K-37 "nonce prompt reaches the transcript only after the failure → still one relaunch".

## 4. Trust seeding is crash-safe and shared between sessions (D-19, SEC P-SEC-15)

Spec gap: §3.1 seeds in step 7 and writes the registry record in step 11; a crash in between left the key forever, and
a close/reap of one session removed a key that a concurrent session in the same cwd relied on.

- Step 7 only checks (`assessTrust`: E_TRUST_REQUIRED / E_WORKSPACE_RISK fail fast). The key is seeded in step 11, under
  the registry lock, right after `sessions/<key>.json` is written with `trustKeyAddedByLibrary` = "about to seed"; the
  flag is corrected to false if the key was already there. If the cwd was trusted in step 7 but no longer is (another
  session released it before this record existed), the check is repeated and the key seeded again (or the start fails
  for `require`).
- New state file `trust-seeds.json` (`RegistryStore.readTrustSeeds/setTrustSeed`): workspaces the library seeded and
  must still unseed. `releaseTrustLocked` (reaper.ts), used by close step 9, the reaper and the launch undo, runs under
  the registry lock: the key is library-owned if this session's record/flag says so or the cwd is listed; if any other
  `sessions/*.json` record uses the same cwd the key stays and the cwd is listed; otherwise the key is removed and the
  listing cleared. Other owners' records are never written.
- Launch failure undo: the trust release and the registry archive run after every other undo step (archive last), so an
  owner death during the undo still leaves a reapable record.
- Known residual: a crash between the record write and the seed makes the reaper unseed a key that was not added (it was
  absent at the step-7 check moments before).
Tests: `launcher.test.ts` ICR 0022 cases, `lifecycle.test.ts` "close keeps a seeded trust key …", `reaper.test.ts`
ICR 0022 cases.

## 5. Tests only

- P-LIFE-46 / K-29: the dialog-after-/exit SIGTERM is asserted to come well before the grace period (unit and kernel).
- D-27 / K-29: the teardown order (owner-watch stop → hooks close → tail close → kill-server → session dir → archive) is
  asserted in the unit lifecycle test and in K-29.
