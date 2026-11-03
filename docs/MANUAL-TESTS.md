# Manual tests

These tests cover behaviour that CI cannot exercise: laptop sleep, launchd scheduling and a real nvm install. They are listed in
DESIGN.md §6.7 and owned by WP-CI. Run them on a macOS machine you control, before a release and after any change to
`src/cli/lifecheck.ts`, `src/cli/launchd.ts`, `src/session/scheduler.ts` or the clock adapter.

General rules:

- Use Node 22 for every command: `export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH` (or the Node 22 you have).
- Build first: `pnpm install --frozen-lockfile && pnpm build`. Run the CLI as `node dist/cli/main.js` (written `ccd` below).
- The state dir is `${XDG_STATE_HOME:-$HOME/.local/state}/claude-code-driver` (written `$STATE` below). Use `--state-dir` with a
  throwaway directory if you do not want to touch your real one.
- None of these tests sends a prompt to a model. None of them touches your own tmux sessions.
- Record each run in the results log at the end of this file: date, machine, macOS version, Node version, commit, outcome.

| ID   | What it checks                                                   | Pitfall / question         | Time   |
| ---- | ---------------------------------------------------------------- | -------------------------- | ------ |
| M-01 | The lifecheck LaunchAgent runs again after sleep and wake        | P-LIFE-57                  | 20 min |
| M-02 | Whether `performance.now()` advances while the Mac sleeps        | LP-27, AL L-4 (§3.9 sleep) | 10 min |
| M-03 | Build-orchestrator wake: **removed** (see below)                 | P-REV-39, P-LIFE-60        | —      |
| M-04 | The lifecheck shim survives an nvm default switch and a reinstall | P-REV-32 (rev 2 §10 F1)    | 15 min |

---

## M-01 LaunchAgent after sleep and wake (P-LIFE-57)

Purpose: `cron` misses runs while the machine sleeps. The library relies on a LaunchAgent with `StartInterval 300` instead
(§3.12). launchd's behaviour after wake is UNVERIFIED, so this test checks it.

Steps:

1. Install the agent: `ccd lifecheck install`. Expect exit 0 and the plist at
   `~/Library/LaunchAgents/com.claude-code-driver.lifecheck.plist`.
2. Check it is loaded: `ccd lifecheck status`. Expect `installed`, a launchctl state, and `lastRunOk: true` after at most one
   interval (5 min). Also run `launchctl print gui/$(id -u)/com.claude-code-driver.lifecheck | grep -E 'state|runs|last exit'`.
3. Note the last run time: `node -e "console.log(require(process.argv[1]).ranAt)" "$STATE/lifecheck.json"`. Write down the
   value (`T0`) and the wall time when you close the lid (`Tsleep`).
4. Close the lid (or `pmset sleepnow`) for **at least 10 minutes**. Do not keep the machine awake with an external display,
   `caffeinate` or a power assertion. Check afterwards with `pmset -g log | grep -E 'Sleep|Wake' | tail -4` that it really
   slept.
5. Wake the machine and write down the wake time (`Twake`).
6. Wait up to one interval (5 min), then read `ranAt` again (`T1`) and run `ccd lifecheck status`.

Pass:

- `T1 > Twake`, and `T1 - Twake <= 300 s + 60 s` slack.
- `ccd lifecheck status` exits 0 (not 2 = stale), and `lastRunOk` is `true`.
- The agent's stdout/stderr files (the `StandardOutPath` / `StandardErrorPath` named in the plist, inside `$STATE`) hold no
  stack trace.

Fail: `ranAt` does not advance within 6 minutes of wake, or status reports stale. Record the `launchctl print` output and
`log show --last 30m --predicate 'subsystem == "com.apple.xpc.launchd"' | grep claude-code-driver`.

Cleanup: `ccd lifecheck uninstall` if the machine should not keep the agent. Expect the plist removed and
`launchctl print gui/$(id -u)/com.claude-code-driver.lifecheck` to fail.

## M-02 Monotonic clock across sleep (LP-27, AL L-4)

Purpose: the scheduler detects host sleep by comparing the monotonic clock with the wall clock (`clock.hostResumed` when
Δwall − Δmono > 5 s, §3.9). libuv's `uv_hrtime` reportedly stops during macOS sleep, but that is UNVERIFIED. The usage wake is a
wall deadline, so both answers are handled. This test records which one is true.

Steps:

1. Save this script outside the repo, for example as `/tmp/ccd-m02.mjs`:

   ```js
   // Logs performance.now() and Date.now() every 5 s; prints the drift between them at every line.
   const m0 = performance.now();
   const w0 = Date.now();
   let lastM = m0;
   let lastW = w0;
   setInterval(() => {
     const m = performance.now();
     const w = Date.now();
     const gap = w - lastW - (m - lastM);
     console.log(
       JSON.stringify({
         wall: new Date(w).toISOString(),
         monoS: ((m - m0) / 1000).toFixed(1),
         wallS: ((w - w0) / 1000).toFixed(1),
         stepGapMs: Math.round(gap),
         totalDriftS: ((w - w0 - (m - m0)) / 1000).toFixed(1),
       }),
     );
     lastM = m;
     lastW = w;
   }, 5000);
   ```

2. Run it in a terminal that stays open: `node /tmp/ccd-m02.mjs | tee /tmp/ccd-m02.log`.
3. After a few lines, sleep the machine for **at least 5 minutes** (lid closed, as in M-01 step 4).
4. Wake it, let it log three more lines, stop it with Ctrl-C.

Read the result from the first line after wake:

- `stepGapMs` about equal to the sleep length (for example 300 000 for 5 min) → the monotonic clock **pauses** in sleep. The
  `hostResumed` detection of §3.9 works as designed.
- `stepGapMs` near 0 and `monoS` jumped together with `wallS` → the monotonic clock **keeps running** in sleep. Then sleep is
  not detectable from Δwall − Δmono. Wall deadlines still fire (the usage wake is safe), but stall suppression after wake
  does not trigger. File the result against LP-27 so §3.9 can be changed.

Record the answer (pauses / keeps running), the macOS version, the chip, and the Node version in the results log. Update
DESIGN.md §9 LP-27 with the outcome.

Cleanup: `rm /tmp/ccd-m02.mjs /tmp/ccd-m02.log`.

## M-03 Build-orchestrator wake — removed

M-03 tested the WP-ORCH build-orchestrator wake job of DESIGN.md §3.11. WP-ORCH was dropped
(`docs/icr/0000-drop-wp-orch.md`): the build is woken by a Claude Code session cron instead, and nothing in this repository
implements or installs a wake job. So M-03 and the P-REV-39 / P-LIFE-60 mitigation moved out of this repository. The library's
own usage-limit wake (D-20, §3.9) is covered by the kernel scenarios K-19 and K-51, and `ccd lifecheck` is covered by M-01 and
M-04.

## M-04 lifecheck shim after an nvm switch and a reinstall (P-REV-32)

Purpose: a LaunchAgent that bakes absolute nvm or pnpm-store paths breaks silently after an upgrade. The library installs a
`/bin/sh` shim in `$STATE/bin/ccd-lifecheck` that resolves Node and the CLI path at run time, and every `start()` rewrites
`$STATE/lifecheck-target.json` (§3.12, rev 2 §10 F1). This test changes both under the agent.

Needs: nvm with at least two Node versions ≥ 20 installed (for example 22 and 24; `nvm install 24` if needed).

Steps:

1. `nvm alias default 22 && nvm use 22`, then `pnpm install --frozen-lockfile && pnpm build`.
2. `ccd lifecheck install`, then wait for one run and check `ccd lifecheck status` is OK (as M-01 step 2).
3. Check the plist holds no nvm or pnpm-store path:
   `grep -E '\.nvm|\.pnpm|node_modules' ~/Library/LaunchAgents/com.claude-code-driver.lifecheck.plist`. Expect no match.
4. Read `$STATE/lifecheck-target.json` and note `distPath` and the recorded Node path (`CCD_NODE`).
5. Switch the default Node: `nvm alias default 24`. Then **uninstall the old one** if you can spare it
   (`nvm uninstall 22.x.y` for the exact version noted in step 4), or rename its directory for the duration of the test, so the
   recorded `CCD_NODE` no longer exists.
6. Reinstall the package in a new place: copy the repo to a new directory (or `rm -rf node_modules dist` and reinstall), then
   `pnpm install --frozen-lockfile && pnpm build` with Node 24.
7. Run one library start from the new place so it rewrites `lifecheck-target.json`. The cheapest is a `start()` that stops at
   preflight; any start that reaches the registry write is enough. If you cannot start a session, edit `distPath` in
   `lifecheck-target.json` by hand to the new `dist/cli/main.js`, and note that you did so in the results log.
8. Wait one interval (5 min), then `ccd lifecheck status` (run with the new Node).

Pass:

- `ccd lifecheck status` exits 0, `lastRunOk: true`, `ranAt` is after step 8 started, and the reported `distPath` exists.
- The agent's stderr file (`StandardErrorPath` in the plist) shows no "node: not found" or "Cannot find module".
- The shim picked a Node ≥ 20: run `/bin/sh $STATE/bin/ccd-lifecheck --json` by hand with `env -i HOME=$HOME` and check it works.

Cleanup: restore your nvm default (`nvm alias default <yours>`), reinstall the Node you removed if you need it, put back any
renamed directory, and `ccd lifecheck uninstall` if you do not want the agent.

---

## Self-hosted live runs (not CI)

CI never runs the live tests (DESIGN.md §6.5, §7): they need your own Claude subscription. To run them on a self-hosted machine:

- Use a runner user (or container) that belongs to that runner only. All sessions of one uid share the hook token's trust
  boundary and the tmux socket directory, so never share one uid between runners (P-SEC-43).
- Check the binary: `node_modules/@anthropic-ai/claude-code/bin/claude.exe --version` must print `2.1.316`.
- Run `pnpm build`, then `CCD_LIVE_MAX_PROMPTS=10 pnpm test:live` (the script sets `CCD_LIVE=1`). The suite runs its sessions
  under `/private/tmp/claude-<uid>/ccd-live/<pid>/` on private `ccd-<pid>-<hex>` servers and kills only the servers its own
  registry names.
- Do not add `CCD_LIVE=1` to a hosted GitHub workflow.

The real-client hook test (`test/contract/claude-hook-client.test.ts`, LP-53) is gated by `CCD_LIVE=1` too, because Claude must
start and be logged in. It sends no model prompt (only the self-test nonce, which our hook blocks). Run it the same way:
`CCD_LIVE=1 pnpm exec vitest run --project contract test/contract/claude-hook-client.test.ts`.

## Results log

Append one row per run. Keep failed runs; add the follow-up issue in "Notes".

| Date | Test | Machine / macOS | Node | Commit | Result | Notes |
| ---- | ---- | --------------- | ---- | ------ | ------ | ----- |
