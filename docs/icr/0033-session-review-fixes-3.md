# ICR 0033 — session review fixes (self-exit teardown, forgery alert, trust config dir, failed kill-server)

Fixes from the third review of `src/session/**`. Each item names its regression test.

## 1. The kernel tears itself down when Claude exits on its own (§3.8)

Before this fix, the kernel's `teardown()` ran only from a failed `start()` and from `close()`. When Claude exited after
ready without a close (a crash, `/exit` typed in the pane, a fail-closed kill), `finalize()` stopped the executors and
ran `lifecycle.finalizeAfterExit()`, but the kernel kept running:

- the trace FileHandle stayed open, and up to 250 ms of buffered records (including `session.exited`) were never written;
- the `monitorEventLoopDelay` lag monitor and its interval kept running, and kept the kernel reachable;
- the step loop stayed open, so a kernel-level `waitFor()` never got `E_SESSION_CLOSED`.

Change: a new `KernelHost.exitFinalized()`. `defaultKernelServices` calls it once `finalizeAfterExit` settles (whether
it succeeded or failed). When no `close()` or failing `start()` owns the session, the kernel then runs
`teardown('exited')`. A later `close()` takes the existing `closedForGood` path and awaits the same teardown.

Test: `test/kernel/self-exit.test.ts` "the kernel tears itself down …".

## 2. A hook forgery burst raises `security.alert E_SECURITY_HOOK_FORGERY` (§3.5, SEC §2.3, ICR 0003 item 1)

Before this fix, nothing subscribed to `HookTransportExtras.onForgery`.

Change: `launchSession` now subscribes next to `onDied`, logs a warning, and calls the new sink
`LaunchSinks.securityAlert({code:'E_SECURITY_HOOK_FORGERY', detail:{count, windowMs, lastReason}})`. The kernel
publishes the alert through the new `KernelHost.alert`, using `loop.publishLocal('security.alert', …)`. `publishLocal`
now accepts `security.alert` as well as `warning`. Like other L3 events, the alert takes the core's next event seq and
`evolve` folds it in. It is not a core-step event, so it is left out of the obs-level replay comparison (as L3 warnings
already are).

Test: `test/kernel/self-exit.test.ts` "five refused hook requests within 10 s → security.alert …".

## 3. Trust is released in the config file it was seeded in (D-19, ICR 0022)

`ClaudeConfigPort` resolves `.claude.json` from the current process env (`CLAUDE_CONFIG_DIR`). The registry and
`trust-seeds.json` do not depend on that env. Before this fix, a key seeded under `CLAUDE_CONFIG_DIR=/work/acct2` could
be removed by a reaper, lifecheck or `start()` running in a default-env process. That process deleted the user's own key
in `~/.claude.json` and left the seeded key in place for good.

Port change (§2.7.2):

- New `globalConfigPath(): string`.
- `seedTrust` and `unseedTrust` take an optional `{ globalConfigPath }`.

Session changes:

- `SessionRecord.claudeConfigPath`: optional, written by the launcher at step 11. Records from older writers do not have
  it and count as the reader's own config.
- The launcher seeds that exact file.
- `trust-seeds.json` is now `{v:2, seeds:[{cwd, configPath?, by, at}]}`. A v:1 `{cwds:{…}}` file is still read; its
  entries have no `configPath`, which means the reader's own config.
- `releaseTrustLocked` treats (cwd, config file) as the workspace key, both for "another session uses it" and for the
  seeds list. It unseeds with `{ globalConfigPath }` set to the recorded file. A recorded path is used only when it is
  absolute, contains no `..`, and is named `.claude.json` or `.config.json`; otherwise the reader's own config is used.

Tests (`reaper.test.ts`):

- "ICR 0033: a key seeded under another CLAUDE_CONFIG_DIR is unseeded in that file …"
- "… a live session of the same cwd under ANOTHER config dir does not keep the key …"
- "… a v:1 trust-seeds.json entry …"

## 4. A failed kill-server no longer unlinks the socket or archives the record (§3.8 / rev 2 §10 G21)

Before this fix, `reapOne` unlinked the socket and archived the record whatever `killServer` returned. A server that
was still running (for example, it refused the kill or answered too late) was left with no name, and nothing ever
retried it.

Change: when `killServer` returns `'failed'`, the reaper probes `list-sessions` twice, `socketProbeGapMs` apart, as the
G21 sweep does. Then:

- If both probes ran and got no answer, or the record has no valid tmux target, the reap goes on as before.
- If the server answers, or tmux cannot even be run (binary gone), the record is kept. Its socket, session dir, trust
  key and `sessions/` record all stay. The result is `ReapedSession.retained: true`, and `ReapReport.errors` gets
  "`<key>`: tmux server could not be killed; record kept for a retry". The next reaper or lifecheck pass retries.

Known gap (cli area, not changed here): `ccd lifecheck` still lists a retained session as a `reaped` action. The run is
still marked failed, through `pass.errors`.

Tests (`reaper.test.ts`):

- "kill-server fails while the server still answers …"
- "kill-server cannot run (tmux binary gone) …"
- "kill-server fails but two list-sessions probes 5 s apart get no answer …"
