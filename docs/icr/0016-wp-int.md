# ICR 0016 — WP-INT (integration): composition root, cross-package fixes, goldens, live smoke

WP-INT owns `src/runtime/**`, `test/replay/**`, `test/live/**`, `README.md` and `docs/USAGE.md` (DESIGN §8). As the
integration owner it may fix other packages' files to make the whole repo green. Every such fix is recorded here. No file
under `src/model/**` was changed, so there is no model ICR. All core changes are internal (ReconState fields live in
`core/types.ts`).

## A. New files (WP-INT)

1. `src/runtime/node.ts`: `createNodePorts(config)` builds every §2.7 port from the real adapters, with one shared clock
   and one env snapshot. The state root is exactly the requested `stateDir` (the cli lifecheck asserts it). The runtime
   root is passed only when the caller set it explicitly, so the runtime-dir port keeps its `$TMPDIR` → `/tmp/ccd-<uid>`
   fallback (P-SEC-15, the socket length guard). `createKernel(spec, {logger, signal})` resolves the config, builds the
   ports, and creates and starts the session kernel. An already-aborted signal → AbortError; an abort during start → kill.
   `defaultLogger` is silent unless `CCD_LOG` is set. Additive exports beyond §2.10: `NodePortsConfig`,
   `CreateKernelOptions`, `silentLogger`, `defaultLogger`.
2. `src/runtime/kernel-entry.ts`: the `./kernel` subpath (`createKernel`, selectors, model types, version constants).
3. `test/unit/runtime/node.test.ts`, `test/replay/{goldens,fixtures-build,obs-level}.test.ts`,
   `test/live/{global-setup,support,smoke.test,suite.test}.ts`, `fixtures/goldens/*` (30 files, recorded with
   `pnpm test:replay -u` and reviewed).

## B. Cross-package fixes (why, and which scenario proves it)

1. **testing/test-kernel.ts (WP-14)**: the L3 modules are loaded *before* fake time is pumped. Before, the 70 s fake start
   budget was spent while `import()` ran in real time (the WP-11 verifier's finding; K-01 failed alone). The fake id port
   is passed to `resolveConfig`, so the session key and Claude session id are deterministic. Without this, replay goldens
   could not be stable. `SessionModules.resolveConfig` gained an optional `ids` parameter.
2. **testing/fake-claude.ts (WP-14)**: (a) each assistant entry is preceded by an `api-request` entry and carries its
   `requestRef`, as the 2.1.316 transcripts in fixtures/verify do. Without them no ModelCall existed in any scenario
   (K-41 "call refused"). (b) The idle Escape hint reads `Esc again to clear`, the real overlay text (input.md §6); the
   fake printed `Press Esc again to clear`, which the profile regex rightly does not match (K-07 clearComposer fallback).
3. **testing/screens.ts (WP-14)**: `stalledLine` is now the VERIFIED-LOG banner
   `✻ Waiting for API response · will retry in … · check your network` (SP §13) instead of an invented string (K-16).
4. **testing/replay.ts (WP-14)**: raw replay of mid-session windows.
   - A window whose leading SessionStart is followed by a gap longer than `startupHookGrace` is shifted to start 1.5 s
     after it, over FakeClaude's idle `ready` screen. Replayed as recorded, the kernel hit `startupMs` inside the gap.
   - A trace with no hook records (the fault-proxy run) boots FakeClaude normally and starts after ready.
   - Each recorded frame is shown at the geometry it was captured at (`FakePane.setGeometry`). The classifier's rules
     span the full pane width (P-SCREEN-14), so 111-column frames inside a 250-column fake pane were classified `modal`.
   - The replay home is `/HOME` (the scrub convention), so goldens never carry a fake real-looking home path.
5. **platform/tmux/fake-tmux.ts (WP-01)**: an additive test control `FakePane.setGeometry(cols, rows)`.
6. **scripts/fixtures-from-verify.mjs (WP-14)**: untimestamped leading transcript entries take the file's first
   timestamp, not 0. With 0, `bg-agents-task-notification` spanned 1.79e9 s and K-18 ran into the 60 s real-time
   timeout. The three probe-derived traces (`bg-agents-task-notification`, `ghost-agent-after-stop`, `retry-storm`) were
   regenerated from the BRIEF probe dirs. The verify-derived traces are unchanged byte for byte (asserted by
   `test/replay/fixtures-build.test.ts`).
7. **cli/lifecheck-host.ts (WP-16)**: the lazy `import('../runtime/node.js')` became a static import, as WP-16 asked
   once WP-INT landed. `test/unit/cli/lifecheck-host.test.ts` now asserts that the real host is rooted at `--state-dir`
   without touching the disk (it used to assert that the module was missing).
8. **core (WP-09)**: behaviour fixes found by the kernel scenarios, the golden replays and the live smoke:
   1. `status/derive.ts`: a retry or stall phase taken from a screen claim alone is provisional (`confirmed:false`,
      sources `['screen']`), K-16. An `allow` we delivered through the hook no longer counts as `awaitingPermission`:
      Claude runs the tool at once, so the status is `runningTools`. **Live smoke finding**: a 30 s Bash call showed
      `awaitingPermission` for its whole run. A failed delivery still moves the record to `dialogOnly`, which counts.
      The new kernel scenario "K-09 after a hook allow … runningTools" covers it.
   2. `decide/messages.ts`: a MessageDisplay that arrives while the turn is `stopping` publishes `turn.textAppended`
      (§2.5 line 603, P-REC-32, K-26) before it completes the turn.
   3. `lattice.ts`: for calls, `ended → refused` is allowed (verdict `retract`). A refusal retracts a call whose stream
      had ended normally (§4.5.10, K-41).
   4. `decide/usage.ts`, plus ReconState `limitAwaitingReset`, `wakeChainRearms`, `wakeGaveUp`:
      - A hook-only limit (StopFailure without a reset time) waits up to `transcriptSettle` for the transcript's
        `resetsAt` before publishing `usage.limited` and the first wake (K-19, K-51). The deadline reuses the
        `transcriptSettle` kind with ref `usage`, so the §4.10 table is unchanged.
      - A `continue` that is accepted and then hits the limit again re-arms the same wake chain instead of starting
        a fresh limit, so `maxRearms` caps it (K-19 "re-arm, cap 3").
      - After giving up, no later evidence re-schedules a wake.
      - Once a hook or transcript reset time has passed, a banner showing a later reset is stale scrollback (its
        time-only form is parsed as the next occurrence) and no longer re-arms (§3.9 authority order).
   5. `input-policy/machine.ts` + `jobs.ts`:
      - A `blockedByHook` notice that was already on screen when Enter went out (the self-test's own block) is not read
        as a new block (K-06: a lost Enter now gets its retry).
      - The editor → pasteChunks fallback publishes `turn.submitting{attempt:2, method:'pasteChunks'}` (K-07).
      - With a UserPromptSubmit hook failure already reported (ECONNREFUSED attachment), a matching `prompt.recorded`
        accepts the submit at once instead of waiting for the ack deadline, which dropped the turn's early
        `turn_duration` (K-20).
   6. `decide/turns.ts`: a new turn that supersedes a `stopping` turn completes it (`endedBy:'stop'`) instead of making
      it `unknown`; Stop and the next UPS can land in the same millisecond (K-25). A `turn_duration` completion is
      stamped with source `transcript`. `isNonce` is exported for the history module.
   7. `decide/entities.ts`: the provenance of `turn.ended` is the source of the fact that ended the turn, not the
      observation that triggered it (a clock tick firing stopGrace after a transcript `turn_duration`, K-20).
   8. `decide/permissions.ts`:
      - A tool that ran after a PermissionRequest we did not allow (released, empty reply, Claude's own hook timeout)
        was allowed at the dialog, so the decider is `user_keys` (K-10).
      - `approvePlan{mode}` refuses dangerous modes with `E_MODE_FORBIDDEN`, like `mode.set` (K-36).
   9. `decide/tools.ts`: an error `tool_result` for a tool whose permission was denied confirms `denied` instead of
      retracting it to `failed`; a hook deny writes no `toolDenialKind` (K-15).
   10. `reconcile/permission-binding.ts`: the last free candidate is `ambiguous-equivalent` while an equivalent sibling
       holds an unconfirmed FIFO guess (K-12).
   11. `decide/inputs-requested.ts`: a modal of unrecognised kind (`dialog:other`) counts like `surface:unknownModal`.
       Neither counts while one of our own command or mode jobs drives the screen. The "only while a turn is active"
       rule of §4.6 is kept; the K-40 test was corrected instead.
   12. `step.ts` + new `decide/history.ts` (ReconState `replayTurn`): replayed (resumed) prompts rebuild the history's
       turns. They are never active, never matched against a submit, and end on their replayed `turn_duration` or
       interrupt marker; their events carry `replayed:true` (§4.9 line 1761, K-22, L-08). WP-09's
       "replay = facts only" is narrowed to "facts + history turns".
   13. `step.ts` `queue.op`: Claude's prompt queue is mirrored as a FIFO (ReconState `queueFifo`), because 2.1.316
       writes `content` on `enqueue` only. A content-less `dequeue` never decremented the task-notification count,
       which kept sessions non-quiescent forever (hookprobe replay, K-18).
9. **Test corrections (WP-14 / WP-00 / WP-09 / WP-16 tests)**, each to match the spec rather than to fit the code:
   - K-13b: only interrupt claims must be retracted (idle/done claims are legitimately still live).
   - K-12: parallel tool_use blocks are modelled as both PreToolUse calls before either PermissionRequest.
   - K-25: the race skips the self-test nonce.
   - K-39: the mark is taken when the dialog shows (the handler denies at once).
   - K-40: the modal opens during a turn (§4.6).
   - K-18 replay: internal agents are published flagged `internal:true` and hidden by the facade (§2.5 line 620,
     map-events.ts).
   - usage scenarios: `attempt` is 1-based; the unknown-reset scenario shows no reset on screen.
   - `profiles-select`: the alias table is checked with `toMatchObject` plus shape rules (ICR 0001 item 6).
   - core `deadlines`/`usage` units: the hook-only limit's settle wait.
   - fake-claude unit: the hint text.

## C. Live smoke (CCD_LIVE=1, 3 tiny prompts in total)

The full report is in the integration phase result. In short: start → ready in about 3 s with every channel `up`
except network (off). A Bash tool turn completed with `toolStarted`/`toolEnded`/`turnEnded`. A handler-allowed Bash
permission worked. A graceful close gave exit 0 and the private server was gone. `/exit` with a background task left
running opened "Background work is running", and the library took the specified SIGTERM path (exit 143, reason
`closed`). The live interrupt was not exercised: in the second run the `awaitingPermission` status bug (B.8.1) kept the
`runningTools` window from being observed. It is fixed and covered by a kernel scenario, but there was no prompt budget
left to re-run it live.
