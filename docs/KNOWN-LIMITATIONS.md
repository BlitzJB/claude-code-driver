# Known limitations (v1, Claude Code 2.1.316)

This file lists every limitation the project has accepted and every live-probe question that is still open. Sources:
`docs/DESIGN.md` §0.3 and §9 (rev 2, with the §10 overrides), the ICRs in `docs/icr/`, the maintainers' live-probe
results and `docs/MANUAL-TESTS.md`. If you change one of these, update this file in the same change.

Status as of the release gate (2026-11-03): `pnpm typecheck`, `pnpm lint`, `pnpm test` (3 consecutive runs, 2661 passed,
3 skipped), `pnpm test:contract`, `pnpm build`, `pnpm check:pkg`, `pnpm check:api` and `pnpm check:tables` pass.
`knip`, which is part of `pnpm check`, still reports unused exports (see [Tooling](#tooling)).

## 1. Scope: not supported in v1 (accepted, DESIGN §0.3)

- **Only Claude Code 2.1.316.** Screen strings, transcript shapes, aliases and command tables are pinned in
  `src/channels/profiles/claude-2.1.316/`. Any other version is refused (`E_VERSION_MISMATCH`) unless
  `claude.expectVersion: 'any'`, which runs with no guarantee. A new Claude version needs a new profile.
- **Subscription login only.** API keys, Bedrock, Vertex, `ANTHROPIC_BASE_URL` and other gateway providers are refused
  on purpose (`E_AUTH`, `E_FORBIDDEN_ENV`).
- **macOS and Linux only.** Windows and psmux are not supported.
- **No live Bash output streaming.** The TUI shows `⎿  Running…` and no output for a running Bash (VERIFIED-LIVE). You
  get the tool result when the tool ends (`toolEnded`).
- **No attach, detach or `onOwnerDeath: 'keep'`.** A session belongs to the process that started it. When that process
  dies, the owner-watch kills Claude and the private tmux server.
- **No agent teams.** They are detected and reported with a warning, not driven.
- **MCP elicitations cannot be answered programmatically.** They surface as `awaitingInput` / `inputRequested`. A human
  has to answer them in the pane (`ccd view <key>`).
- **No `/rewind`, in-pane `/resume`, `/tui`, `/restart`, `/exit`, `/login`, `/logout`.** `session.command()` refuses
  `/exit`, `/tui`, `/restart`, `/resume` and `/rewind` even with `unsafe: true`. `/login` and `/logout` are on the
  denylist. Use `ClaudeSession.start({ resume })` to continue a conversation and `close()` to end one.
- **Not implemented:** `whenBusy: 'native'`, tmux control mode, network upstream chaining, plain-HTTP or token-B network
  modes, a statusLine or registry channel, the rx/mcp/http facades, `--bg` sessions and the agent-view daemon,
  fullscreen-renderer parsing.
- **Two independent writers on one transcript** are not handled. The library refuses to resume an id that another
  Claude still holds (`E_SESSION_ID_IN_USE`), because Claude itself does not refuse it (LP-55).
- **Not a security boundary against same-uid code.** Malware running as your user and not descended from Claude, and
  shared single-uid CI runners, are out of scope. Give every self-hosted runner its own user.

## 2. Accepted behaviour limits and residual risks

### Platform

- On **tmux 3.2a** a pane killed by a signal reports no signal name (the `pane_dead_signal` format only exists from
  tmux 3.3), so `SessionExitInfo.signal` is `null` there. tmux 3.3/3.4 report the number and 3.5+ the name; both are
  normalized to `SIGTERM`-style names. On tmux 3.4 a pane can read as dead a moment before its signal is filled in, so a very early
  status read may show no signal; the exit record written by the `pane-died` hook always has it.
- Network fault injection on Linux: after a `reset` fault the sidecar records the RST, but the faulted client's close
  event does not always arrive promptly (seen once in CI). It affects only the test-time fault tool, not normal traffic.
- macOS is the primary, live-verified platform. Linux runs the full unit, kernel, replay and contract suites in CI;
  the gated live suite has only been run on macOS.

### Input and commands

- Prompts whose trimmed text starts with `/` are rejected (`E_INPUT_REJECTED{leadingSlash}`). A leading space does not
  protect a slash command while Claude is busy (LP-45), so there is no escape. Use `session.command()`.
- Slash commands other than `/clear /compact /model /effort /rename /context /usage (/cost) /status /help` need
  `{ unsafe: true }`.
- Keybindings can only be checked at startup (`E_KEYBINDING_CONFLICT`). Claude ignores `keybindings` in `--settings`
  and watches `~/.claude/keybindings.json` during the session (LP-44). A user who rebinds `ctrl+g` or Enter mid-session
  breaks input. Not fixed.
- `env.set` proxy variables (`HTTPS_PROXY` and similar) are dropped silently. Only the host environment's own proxy
  variables are passed through. There is no warning yet (live finding N-2).

### Permissions

- Requests that cannot be bound to exactly one tool run (ambiguous parallel calls, internal or "ghost" agents, a dialog
  adopted from the screen) are never auto-answered by a policy. They reach the host or the native dialog.
- A permission dialog adopted from the screen (`dialogOnly`, when the PermissionRequest hook never reached the library)
  can be denied with Escape. An allow by keys needs `unstable_advanced.permissions.screenAllow`.
- A human Escape in the ~150 ms after a library allow, while Claude still shows the dialog, is reported as
  `interrupted` rather than `denied`. The turn outcome is the same (ICR 0035, F-4 residual).
- `ExitPlanMode` and `AskUserQuestion` need `approvePlan` / `answerQuestion`. Their dialog strings were never captured
  live (LP-46), so on screen they classify as `unknownModal` (`awaitingInput`) until a hook delivers the request.

### Screen evidence

- Screen-only evidence is never `confirmed`. An exact Claude banner template printed by a tool in the 6 rows above the
  composer (for example a usage-limit or `API Error: 401` line) still produces a screen claim (ICR 0020, ICR 0027).
- A bare `⎿  Interrupted` tool-output row near the composer, on a frame that is not busy and has no done line, still reads
  as an interrupt banner. A turn that is stopping is then marked provisionally interrupted until the transcript or Stop
  resolves it (ICR 0030).
- A version-too-old error whose wording wraps onto a JSON row is not read from the screen. Transcript and StopFailure
  evidence decide it (ICR 0027).
- The permission mode read from the footer is unreliable while the slash popup is open (LP-31).

### Lifecycle

- Under a managed policy with `allowManagedHooksOnly` or `strictPluginOnlyCustomization`, no hook of ours runs. The
  self-test nonce prompt is then sent to the model (one wasted model call) before `start()` fails with
  `E_HOOKS_UNAVAILABLE` (live finding N-1). MDM- or server-delivered policy cannot be detected before launch.
- `close({ mode: 'kill' })` during a graceful close escalates at once, but if the launched session's own graceful
  sequence has already started, that sequence still finishes (at most `killAfterMs`) (ICR 0022).
- A crash between writing the registry record and seeding trust can make the reaper remove a trust key that the library
  did not add (ICR 0022).
- `ccd lifecheck` lists a session whose tmux server could not be killed as a `reaped` action, even though the record is
  kept for a retry. The run is still marked failed (ICR 0033).
- After `kill-pane` or `kill-server` no final screen can be captured, and the socket file stays (LP-37). The library
  captures first and unlinks the socket itself.
- Usage-limit handling has never seen a real limit: `/mock-limits` and `/simulate-usage` do not exist for external
  accounts (LP-30 step 1). The transcript and StopFailure shapes come from source reading. The limit recorder writes a
  scrubbed capture to `<stateDir>/limit-captures/` on the first real limit.
- The usage-limit wake uses wall-clock deadlines. Whether the monotonic clock advances across macOS sleep (LP-27, manual
  test M-02) and whether launchd re-runs the lifecheck LaunchAgent after wake (M-01) are manual tests that have no
  recorded run yet.

### Live test coverage

- L-01 to L-11 passed live on 2026-11-03. The smoke test passed before the F-1 fix and
  was not re-run afterwards (L-04 covers the same flow).
- L-11 does not yet test the `refuse` network fault and the `attempt 1/10` retry banner (live finding N-4).
- L-13 (kill the hook worker mid-session) is skipped: v1 has no hook to kill the worker from a test.
- The live traces were recorded with `debug.raw: 'meta'`, so they cannot be replayed at observation level. The F-1 to
  F-4 regression tests rebuild the sequences by hand. Record with `raw: 'full'` and scrub when replay fixtures are needed.

### Tooling

- `pnpm check` (including `knip`) passes. The docs site's dev tooling carries pnpm overrides for dev-only advisories
  (`vite` 6.4.4 under VitePress 1.x, `esbuild` 0.25, `minimatch` 11.0.1); one moderate Vite dev-server advisory has no
  patched release yet. None of these packages ship at runtime: the library has zero runtime dependencies.

## 3. Open live-probe questions (DESIGN §9)

Answered so far: LP-01, LP-02, LP-03, LP-09, LP-12, LP-13, LP-14, LP-45, LP-47, LP-50, LP-52, LP-53, LP-54 (Phase 0,
ICR 0001); LP-04, LP-10, LP-11, LP-16, LP-31, LP-32, LP-35, LP-37, LP-42, LP-44,
LP-55, LP-56, LP-61 (live run of 2026-11-03); LP-19 through live test L-09. LP-05 and LP-25 are obsolete
(their features were cut in rev 2).

Partly answered:

| ID | What is known | What is still open |
|---|---|---|
| LP-17 | During a held UPS hook, typed text goes into the composer, and a trimmed-slash command runs at once | `C-g` while busy or with a popup open |
| LP-30 | Simulation commands are unavailable on an external account; the near-limit footer segment was captured | Every real-limit artifact: transcript stand-in with `rate_limit_info.resetsAt`, StopFailure `rate_limit`, `quota_auto_resume_*` notifications, the options-menu strings, the `(<reset>)` retry-line form |
| LP-33 | An editor-staged `/cost` runs exactly that command, with no popup interference | The same for `/compact` |
| LP-60 | All four footers parse correctly when idle | Footer and `esc to interrupt` placement while busy in `acceptEdits` and `plan` |

Not run:

| ID | Question | Cost | Affects |
|---|---|---|---|
| LP-06 | Where `⎿  Interrupted · …` renders (thinking vs streaming) | 2 prompts | P-SCREEN-25 |
| LP-07 | Whether `--settings` `spinnerVerbs` / `spinnerTipsEnabled` / `timeFormat` beat user values | 1 | §3.4 |
| LP-08 | PermissionRequest through the unix forwarder: dialog while held, human wins, forwarder timeout | 2 | P-HOOK-56/64, P-REC-47 |
| LP-15 | A dead PermissionRequest endpoint falls back to the dialog (not deny), and adoption picks it up | 1 | P-SEC-03, P-REV-13 |
| LP-18 | `/exit` while busy: immediate? exit code? SessionEnd reason? | 1 | §3.8 |
| LP-20 | Shape of the `Resume this conversation?` dialog | hard | P-LIFE-19 |
| LP-21, LP-22 | Background- and foreground-subagent PermissionRequest: blocking order, `agent_id`, prompt_id after the turn ended | 2–3 | P-HOOK-57, P-REC-44/45 |
| LP-23 | Two parallel Bash calls: PreToolUse concurrency, PermissionRequest order and latency | 1–2 | P-HOOK-46, P-REV-10 |
| LP-24 | Network: real ALPN, pipelining, SSE ping cadence, record sizes | 1 long | P-NET-18/28/29 |
| LP-26 | Do subagent `api-request` entries go to the subagent file? | (with LP-21) | P-NET-30 |
| LP-27 | Does `performance.now()` advance across macOS sleep? (manual test M-02) | no Claude | §3.9 |
| LP-28 | UPS for a queued prompt merged into a running turn | 1–2 | P-REC-46 |
| LP-29 | Stop for a withdrawn prompt | 1 | P-REC-47 |
| LP-34 | Permission dialog labels for Bash, WebFetch and MCP tools | 2 | P-INPUT-35 |
| LP-36 | Shape of a manual `/compact` (`trigger: "manual"`) | 1 + compaction | §4.3 |
| LP-38 | `sandbox.enabled`: HTTP hooks through the sandbox proxy, Bash access to `/tmp/tmux-<uid>` | 1 | P-HOOK-13, P-NET-43 |
| LP-39 | Is MessageDisplay `turn_id` stable across the messages of one prompt? | 1 | §4.5.6 |
| LP-40 | In-process HTTP hook latency from `--debug-file` timestamps | (any prompt) | P-HOOK-31 |
| LP-41 | Can PostToolBatch arrive before the last PostToolUse? | (with LP-23) | P-REC-34 |
| LP-43 | `@nonexistent` mention behaviour; any literal-`@` escape | free | P-INPUT-06 |
| LP-46 | ExitPlanMode and AskUserQuestion: payloads, required `updatedInput`, dialog strings, mode after approve | 2 | §3.7, K-36 |
| LP-48 | A running background agent's `<task-notification>` after `/clear` | 1–2 | §4.5.4, K-42 |
| LP-49 | Which flows tombstone or rewrite the transcript | free | §4.5.10, K-27 |
| LP-51 | Raw `ESC[` / OSC 52 in tool output; MCP elicitation dialog strings | 1 + 1 | P-REV-28/29, P-REV-14 |
| LP-57 | Does a `CronCreate` scheduled prompt fire after a usage-limit reset with no input? | opportunistic | §3.11 |
| LP-58 | After `/cd`: new `transcript_path` in the next hook; does `subagents/` move? | 1 | P-TAIL |
| LP-59 | Does `/model <m>` save the model as your default? | free | §3.6 |
| LP-62 | PostToolUse for a 5 MB `Read`: payload size, truncation, latency | 1 | §3.5 body cap |

Other unverified points from the initial live verification:

- PostToolUseFailure, PermissionDenied, StopFailure and SubagentStart over HTTP hooks were configured but never
  triggered live.
- The PermissionRequest `updatedPermissions` and `interrupt` response fields, and `updatedInput` outside the
  question/plan flows, were not tested live.
- What happens to an in-flight hook socket when a human answers the dialog first.
- Whether ghost (internal) agents can raise a PermissionRequest. Their PreToolUse is handled; their PermissionRequest
  carries no `agent_id` in the samples, which is why such requests are never auto-answered.
- The default hook timeout when unset (600 s, read from the binary, not waited out live).
