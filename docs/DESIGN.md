# DESIGN: claude-code-driver (definitive implementation spec)

Status: **revision 2** (2026-11-03, after `docs/critique/skeptic.md` and the critic gap list), normative for work packages W2 to W4. Every change made in revision 2 is listed with its reason in **§10 Critique log**; where §10 and an older paragraph disagree, §10 and the paragraphs it names win. Target: `@anthropic-ai/claude-code@2.1.316` (exact), tmux 3.5a (tested), macOS darwin arm64 (tested), Linux (code paths specified, untested). Written 2026-11-03 by the lead architect after reading in full: `docs/BRIEF.md`, `docs/research/{prior-art,official-docs,transcript-format,tui-known-issues,live-verification}.md` and `docs/caveats/{tmux-driver,input,transcript-tail,hooks-transport,screen-parse,network-proxy,lifecycle,reconciliation,security,api-layering}.md`.

How to read this file:
- **MUST / MUST NOT** are binding. Anything not specified here follows the cited caveat doc section.
- Evidence labels on factual claims: **VERIFIED** (with the cite: `LV` = live-verification.md, `TD` = tmux-driver.md, `IN` = input.md, `TT` = transcript-tail.md, `HT` = hooks-transport.md, `SP` = screen-parse.md, `NP` = network-proxy.md, `LC` = lifecycle.md, `RC` = reconciliation.md, `SEC` = security.md, `AL` = api-layering.md, `PA` = prior-art.md, `OD` = official-docs.md, `TF` = transcript-format.md, `TUI` = tui-known-issues.md, `ARCH` = checked by me for this doc). **UNVERIFIED** marks inference; each one is tied to a live probe `LP-nn` in §9.
- Where reports conflicted I preferred VERIFIED claims and above all `LV`. The resolutions are listed in §0.2.
- Revision 2 added these ARCH checks (all by `strings`/`perl` on `node_modules/@anthropic-ai/claude-code/bin/claude.exe` 2.1.316, or `claude --help`; no live session): the prompt-submit path tests `value.trim().startsWith("/")` and then looks the trimmed name up in the command table (so a leading space does **not** escape a known command, §10 A4); `/clear` has `aliases:["reset","new"]` and `/exit` has `aliases:["quit"]` with `immediate:!0`; `apiProvider` is an enum `["firstParty","bedrock","vertex","foundry","anthropicAws","anthropicGoogleCloud","mantle","gateway"]`; provider switches `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`, `_ANTHROPIC_GOOGLE_CLOUD`, `_MANTLE`, `_GATEWAY` exist; `CLAUDE_CODE_MAX_RETRIES`, `API_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_ENABLE_STREAM_WATCHDOG`, `CLAUDE_ENABLE_BYTE_WATCHDOG`, `BASH_MAX_OUTPUT_LENGTH`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` exist; hidden `--managed-settings <json>` ("Policy-tier settings JSON from a spawning parent process") exists; `mock-limits`, `simulate-usage`, `CLAUDE_MOCK_HEADERLESS_429`, `refusedMessageId`, `model_refusal_fallback`, `retractedMessageUuids`, `stopped by a safety classifier`, `elicitation_dialog`, `elicitation_url_dialog` all occur. `--help` lists `--allowedTools/--allowed-tools`, `--disallowedTools/--disallowed-tools`, `--add-dir`, `--tools`, `--mcp-config`, `--plugin-dir`, `--plugin-url`, `--agents`, `--agent`, `--verbose`, `-d/--debug [filter]`, `--effort`, `--fallback-model`, `--permission-prompts`, `--remote-control`, `--worktree`, `--tmux`, `--ide`, `--chrome`, `--file`, `--restricted`, `--disable-slash-commands`, `--system-prompt`, `--append-system-prompt`, `-n/--name`. `getconf DARWIN_USER_TEMP_DIR` = `/var/folders/yj/…/T/` = this shell's `$TMPDIR`.
- Two things I verified myself for this doc (ARCH): `claude --version` prints `2.1.316 (Claude Code)`; `claude --help` does not list `--teammate-mode` but the binary contains `teammate-mode <mode>` and the settings key `teammateMode` (hidden flag, VERIFIED-BIN by `strings`); the binary also contains the settings keys `emojiCompletionEnabled`, `feedbackSurveyRate`, `skillOverrides`, `timeFormat`, `prefersReducedMotion`, `"crossSessionInbound"`, `"idleCompaction"`, `"autoContinueAtUsageLimit"`, `"editorMode"`, `"promptSuggestionEnabled"`, `"showTurnDuration"`, `"spinnerTipsEnabled"`. `pnpm -v` = `11.21.0`; nvm has Node `18.20.5`, `22.23.2`, `23.6.0`; default `node` = `v23.6.0`; tmux = `/opt/homebrew/bin/tmux` `3.5a`; the native binary is `node_modules/@anthropic-ai/claude-code/bin/claude.exe` (310,114,176 bytes).

---

## 0. Decisions

### 0.1 Decision register (D-nn)

| ID | Decision | Why (cite) |
|---|---|---|
| D-01 | Five layers plus a shared kernel: `model` (types) → L0 `platform` (adapters) → L1 `channels` (normalizers) → L2 `core` (pure reducer) → L3 `session` (orchestrator) → L3.5 `runtime` (composition root) → L4 `api` / `facades/*` / `cli`. `testing` is outside the chain. | BRIEF layering; AL §0, §2 |
| D-02 | The only seam facades may use is the `SessionKernel` port (`dispatch`, `subscribe`, `getState`, `waitFor`, `close`, `subscribeDebug`). Public types are facade-owned and mapped from domain types by exhaustive `switch`. | AL §1, §4.5, §6.4 |
| D-03 | Core is one pure, synchronous, deterministic `step(core, input) → {core, events, intents, diagnostics}`. No clock reads, no random, no I/O, no throw. Time enters as `meta.at`/`meta.wallAt`. **Every decision timer** (watchdogs, input waits, permission policy timeout, usage wake) is a deadline in core state; L3 runs exactly one *decision* timer at `nextDeadline(core)` (mono or wall, §4.10). The only other timers are the closed list of L0/L3 *adapter* timers in §4.12, which never decide anything and only produce observations. | RC §0.1, AL §0.4, §4.3, L-3; rev 2 §10 G4 |
| D-04 | Observations are **semantic** kinds (`tool.pre`, `turn.stopped`, …) with the channel in `meta.source`. Screen is the exception: one `screen.frame` observation carrying profile-free `ScreenFacts`; claims are derived in core. | RC §2 (semantic kinds), AL §4.2 (ScreenFacts) |
| D-05 | Library keys are **session-scoped** deterministic counters (`t12`, `u40`, `a3`, `p5`, `c9`, `m14`, `j7`), never random and never re-keyed on `/clear`. The Claude generation is a field (`g1`, `g2`, …). Real ids are aliases. | RC §3.1 (adapted: session scope avoids re-keying queued turns across `/clear`) |
| D-06 | Priority is per fact with the authority table (§4.1). Status fields are monotone lattices. `AgentStatus` is derived, never stored as a primary field. Screen facts are provisional claims with TTL. Timeouts never invent concrete outcomes. | RC §0.4–§0.8, §12 |
| D-07 | **One tmux server per ClaudeSession** (`-L ccd-<ownerPid36>-<8hex>`, `-f /dev/null`, `-u`). **`execFile` only** (no control-mode client in v1, rev 2 §10 C1). Server prelude sets `set -s set-clipboard off` (OSC 52 from tool output never reaches the host clipboard, §10 G16). Never `set -g window-size manual`. | TD §1.1 (perSession default because of the 3.5a SIGSEGV), §5.3; SEC §7.1 (secrets via server-start env needs one server per session) |
| D-08 | Pane command is multi-arg argv `/usr/bin/env -u TMUX -u TMUX_PANE <abs claude.exe> …`. `env` execs, so `pane_pid` is Claude. Never the `node_modules/.bin/claude` shim. | SEC §4.7 (self-approval via TMUX), LC §5.2 (shim runs `uname`), TD §7.2 |
| D-09 | Pane size 250×80 fixed with per-window `window-size manual`, `status off`, `remain-on-exit on`, `pane-died` hook, all in the same invocation as `new-session`. Width < 120 is a config error. | TD R5–R7, SP §9 |
| D-10 | Classic inline renderer pinned with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`; every capture asserts `#{alternate_on}==0`, else `unsupportedRenderer`. | SP §12.6 (classifier and corpus are classic); TUI §8.1 (fullscreen alternative rejected: no corpus) |
| D-11 | Hooks: HTTP (`type:"http"`) to `http://127.0.0.1:<port>/h/<sid>/<Event>` with a literal `X-CCD-Token` header for all observation events; **command forwarder over a unix socket in a 0700 dir for `SessionStart` (HTTP unsupported) and `PermissionRequest` (anti-squatting)**. `hooks.transport:'auto'|'http'|'unix'` (advanced; `'unix'` = every event through the forwarder, §3.5). Both servers run in a **`worker_threads` worker** (node:* only) so host event-loop stalls never delay Claude's hook calls (§10 A7). Observation responses are a constant empty 200 written after the body has been fully received and before parsing (§10 G18). | LV Q1; HT §0; SEC §2.2, §2.4, §2.6 |
| D-12 | Token never in the URL, argv, or env. Hook token: literal header in a 0600 settings file. Forwarder token: 0600 `fwd.json` named in args. Proxy token: `HTTPS_PROXY` userinfo, delivered through the env of the tmux client that starts the per-session server (not `-e`). | SEC §2.2, §7.1 (VERIFIED-EXP), §6.1 |
| D-13 | `allowedHttpHookUrls` is written **only** when a readable user/project/local layer already defines it, and then as the exact origin `http://127.0.0.1:<port>` (empty path matches any path, HT §2.2 `Yne`). Writing it unconditionally would *create* an allowlist and block the user's other HTTP hooks. | OD §1.9 ("If undefined, all URLs are allowed"), HT §2.2, SEC §2.8 |
| D-14 | `disableAllHooks:false` is written only with `hooks.overrideDisableAllHooks:true`; if any readable layer sets `true` and no override, `start()` fails `E_HOOKS_DISABLED_BY_USER`. | SEC §2.8 overrides HT §1.2 |
| D-15 | Prompt injection primary path: **external editor** (`VISUAL=<runtime>/ccd-editor` + `C-g`), atomic and byte-exact. Fallback: bracketed paste of ≤400-byte chunks with ≤2 LF each through `load-buffer -` stdin, 30 ms gaps. `send-keys -l` is used only for the paste-less typing fallback of short slash commands. | IN §3.1 (VERIFIED-EXP 8016 chars byte-identical), IN §3.2, TD §3, SEC §3.2 |
| D-16 | Every text path goes through the pure sanitizer in core (strip C0 except `\n\t`, DEL, C1, standalone invisibles; **reject** any prompt whose `trim()` starts with `/` (`E_INPUT_REJECTED{reason:'leadingSlash'}`: Claude trims before the command lookup, VERIFIED-BIN rev 2, so a space escape does not work); prefix-escape leading `! ? & #` with one ASCII space pending LP-45; reject empty). Delivery is confirmed by the UserPromptSubmit ack with normalized text equality; a mismatch that is not a known external shape is a `security.alert` plus `provenance.confirmed:false`, and interrupts only with `security.onTamper:'interrupt'` (§10 A3). | SEC §3.4, IN §4, §7.2; rev 2 §10 A3/A4 |
| D-17 | `whenBusy:'wait'` is the default: the library queues and sends only when `canSubmit(core)` (§4.13) holds. `'reject'` fails `E_BUSY`. **`'native'` is not offered in v1** (§10 A13); the one remaining race (an external turn starting between our Enter and its ack) is handled by `mergedInto` (§4.4). | AL §14.3, IN §7.3 (queued UPS reuses prompt_id) |
| D-18 | Permission policy **fails closed**: handler throw/timeout/invalid → deny; close while held → deny. **`permissions` is a required `start()` option** (no default policy, §10 E2). Named policies: `'deny'`, `'ask'` (event + `respondToPermission`, deny on timeout), `'allowRead'`, `'dangerouslyAllowAll'`, or a handler. `AskUserQuestion` and `ExitPlanMode` are never auto-allowed by a named policy; they need `answerQuestion()`/`approvePlan()` or an explicit `updatedInput` (§3.7). Screen fallback may only press `Escape` unless `screenAllow:true`. `updatedPermissions.destination` forced to `session`. | SEC §4 (overrides AL `policy:'ask'` default); OD §1.7 |
| D-19 | Trust: default `trust:'require'` (fail `E_TRUST_REQUIRED` if neither cwd nor an ancestor is trusted). `trust:'seed'` runs `inspectWorkspace` first and atomically adds only `projects[realpath].hasTrustDialogAccepted=true`, removing it after the pane is dead if we added it. The library never presses keys on the trust dialog. | SEC §5.5 overrides LC rule 1; LV Q4 |
| D-20 | `autoContinueAtUsageLimit:false` in our settings; the library owns usage-limit wake-up as a core **wall-clock deadline** `usageWake` (§4.10) with deterministic jitter. The external `ccd lifecheck` LaunchAgent only reaps orphans and reports hung owners; it never wakes a session (§10 G1/C5). The **build-orchestrator** wake-up the user asked for is specified in §3.11 (WP-ORCH). | LC §3.3, §14; PA §0.6 (#91535); user request |
| D-21 | Network channel is opt-in and **narrow in v1** (§10 C2): detached dumb sidecar per session, lifetime bound to Claude's pid, CONNECT pass-through with a per-session Basic token in userinfo, liveness metering, faults. `HTTPS_PROXY`+`https_proxy` set, `HTTP_PROXY`/`http_proxy` unset for Claude, `NO_PROXY`/`no_proxy` merged with `127.0.0.1,localhost,::1`. **If the user already has any proxy variable, the channel is `off` with `warning E_NETWORK_UNAVAILABLE{reason:'userProxy'}`** (no upstream chaining, no TLS upstream, no plain-HTTP forwarding (405), no token B, no `$CLAUDE_ENV_FILE` restore, no same-port restart). Bash children inherit our proxy, which is a correct pass-through. Faults only on tunnels to `api.anthropic.com`, never `platform.claude.com`. | NP §0, §4, §7; SEC §6 |
| D-22 | `NO_PROXY`/`no_proxy` always get `127.0.0.1,localhost,::1` appended (both casings, same value) whenever **any** proxy variable is present in Claude's env (ours or the user's). | LV Q1 pitfall (VERIFIED-LIVE: hooks went through the proxy) |
| D-23 | **No statusLine channel and no registry channel in v1** (§10 C8). One read of Claude's registry (`~/.claude/sessions/<pid>.json`) after launch for the pid/version cross-check, and one scan of it in preflight for a live non-library holder of a resume id (§3.1 step 7). | OD §0.8 (conflict with CL 2.1.169, LP-05), PA §0.4 |
| D-24 | Always pass `--permission-mode` (default `default`) and `--teammate-mode in-process`; pass `--settings`, `--permission-mode`, `--model`, `--effort` again on every resume. Caller `extraArgs` go through an **allowlist** (§3.3), never a denylist. Agent teams are unsupported in v1: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is stripped; teammate evidence is attributed to `kind:'teammate'` agents and raises `warning` (§4.5.9). | LV Q4 (auto-mode default), LC §8.1, PA T8, ARCH (hidden flag exists); rev 2 §10 G6/G28 |
| D-25 | Child env built from an allowlist plus explicit caller env plus library-required vars, then the strip list (§3.2) is applied. `process.env` is never spread. | SEC §7.2 |
| D-26 | Interrupt = single `Escape` (then ≥250 ms quiet) when no permission is pending; with a held PermissionRequest it is `deny` + `interrupt:true` through the hook. Never SIGINT, never double `C-c`, never `C-z`. | LC rule 5, IN §6, HT §9.1 |
| D-27 | `close()` = (optional `waitForBackgroundMs`) → release held permissions (deny) → `/exit` when idle with clean composer else SIGTERM to the verified Claude pid → wait `pane_dead` ≤ 12 s → SIGTERM → +3 s SIGKILL → then stop hook server and proxy → `kill-server` → cleanup. Modes: `graceful` and `kill` only (no `detach` in v1). | LC §5.1, §7 |
| D-28 | Library death **fails closed**: a per-session `owner-watch` standalone process (node:* only) polls the owner pid every 1 s and, when the owner is gone, kills the verified Claude pid and the private tmux server within ≤ 2 s, so the hook port is never left unbound while Claude runs (§3.8). Registry in a 0700 state dir, tmux `pane-died` run-shell exit record, reap on next start and from lifecheck as the backstop. **No `attach()` and no `onOwnerDeath:'keep'` in v1**; recovery = `ClaudeSession.start({resume: <claudeSessionId>})` in a fresh pane (the registry archive keeps the id). | LC §6, SEC §2.4; rev 2 §10 G1/A6/G8 |
| D-29 | Zero runtime dependencies. Plain `tsc` (TypeScript 6.0.3), ESM only, `.d.ts`, subpath exports, no bundler. Standalone scripts (`forward`, `editor`, `sidecar`) import only `node:*`. | AL §0.7, §10 |
| D-30 | Engines `node >=20` (BRIEF hard decision). Develop on Node 22 (`.nvmrc` = `22`); CI tests 20.19, 22, 24. `@types/node@^20`, `lib: ES2023`. | AL §11.2 |
| D-31 | `Turn.done` and `session.exited` never reject. No `'error'` event. Errors are `CcdError` with a stable `code`, checked by `isCcdError`. | AL §0.10, §6.1 |
| D-32 | One trace format (`.ccd.jsonl`, DebugRecord v1) is both the debug trace and the replay fixture format. Raw content redacted by default (`raw:'meta'`). | AL §8.2 (merges RC §11.2 two-level fixtures into one file with `raw` and `obs` records) |
| D-33 | One public facade in v1: `api`. It maps the small public options onto the internal `SessionSpec` (`model/spec.ts`, §2.11) and talks to the core only through the `SessionKernel` port (§2.10). Changeability is enforced by arch tests (§1.4 item 3e/3f), not by a second shipped facade. `facades/*` (callbacks, rx, mcp, http) are reserved and out of scope for v1. | AL §6.2; rev 2 §10 C6/E1 |
| D-34 | PreToolUse is registered by default (needed for permission correlation) behind `hooks.preToolUse` (can be turned off if an org's managed settings make observation hooks fail closed, HT §1.4). PostToolBatch off by default. MessageDisplay on by default. | HT §1.4, §8, §10.3; AL §14.4 |
| D-35 | Startup runs a free **self-test**: our UserPromptSubmit endpoint returns `{"decision":"block","reason":"ccd self-test"}` only for the exact armed nonce prompt; this proves editor injection, Enter, trust and hook delivery with no model call. Default `selfTest:'once'`: once per (library process, Claude version, `cwdRealpath` trust state, hook transport), cached in memory and in `stateDir/selftest-cache.json` (24 h TTL). Nonce minted by L3, armed by core intent (§3.1 step 15). | IN testing trick (VERIFIED-EXP), TD §3.4 (2.1.119 regression); rev 2 §10 G10/A12 |
| D-36 | Defense in depth in our settings: `crossSessionInbound:"refuse"` (default). `permissions.deny: ["Bash(tmux:*)","Bash(*tmux *)"]` only with the advanced option `denyTmuxInBash:true` (default **false**: trivially bypassed and it blocks legitimate tmux use; `TMUX` is unset anyway, D-08). | SEC §4.7; PA §2.14.5; rev 2 §10 C10 |
| D-37 | `PermissionRequest` hook `timeout` = `ceil(permissions.timeoutMs/1000) + 30` seconds; Node servers set `requestTimeout=0`, `timeout=0`, `headersTimeout` default. | HT §9.4, SEC §4.1 (policy timeout < hook timeout) |
| D-38 | Runtime dir (sockets, settings, staged prompts, editor script) = `fs.mkdtemp(<root>/ccd-)` where root = `os.tmpdir()` on darwin (per-user 0700, 66-byte socket path VERIFIED SEC §2.5), `$XDG_RUNTIME_DIR` on Linux, else `/tmp/ccd-<uid>` after lstat checks. Every runtime path is recorded **absolute** in the registry, so nothing outside the owner process ever recomputes a runtime path (launchd's env may differ, §10 G20). State dir (registry, exits, lifecheck) = `${XDG_STATE_HOME:-~/.local/state}/claude-code-driver` (0700). | SEC §2.5, §5.1, §9; LC §6.3 |
| D-39 | **Internal `SessionSpec`** (`model/spec.ts`) is the only input of `session/config.ts resolveConfig(spec, env, defaults)`. Public option shapes live only in `api/options.ts`, which maps them with `toSessionSpec()`. Renaming or regrouping a public option touches only `src/api/**`. | AL §1; rev 2 §10 G5/E1 |
| D-40 | Public error surface = 18 stable codes (§2.2 `PUBLIC_ERROR_CODES`) with `details.reason` carrying the fine-grained internal code (documented, not frozen). | rev 2 §10 C7 |
| D-41 | Screen stability has **one owner**: the core claim machine (§4.6 Claims). L1 only drops consecutive identical captures and marks torn frames; it never waits for stability. | rev 2 §10 G26 |
| D-42 | No observation is de-duplicated by a time window. Screen: consecutive-identical drop in L1. Hooks: none (one transport per event). Transcript: `uuid` per generation in core. | rev 2 §10 A2 |

### 0.2 Conflicts between source docs and how they are resolved

| Topic | Doc A | Doc B | Resolution |
|---|---|---|---|
| Token in URL path | OD §5 "a path token is no worse" | SEC §2.2: URL persisted in `stop_hook_summary.hookInfos[].command` (VERIFIED-BIN+EXP) | Header only (D-12). The path segment `<sid>` is not secret. |
| `allowedHttpHookUrls` | HT §0/§1.2: always add `http://127.0.0.1:*` | SEC §2.8: union widens org policy | Write only if a readable layer defines it, exact origin (D-13). Also fixes a pitfall neither doc named (P-HOOK-63). |
| `disableAllHooks:false` | HT §1.2 always write | SEC §2.8 fail unless override | D-14. |
| EADDRINUSE on reattach | HT §5.3 continue degraded | SEC §2.4 kill the pane | Rev 2: there is no reattach; owner death and hook-worker death both kill the pane (D-28, §3.5). |
| Secrets via `tmux new-session -e` | TD rule 14, NP §8 | SEC §7.1 argv is world-readable (VERIFIED-EXP) | Secrets via server-start client env; `-e` only for non-secrets (D-12). With one server per session the global env equals the pane env. |
| `TMUX` in the pane | TD §7.3 keep it | SEC §4.7 unset (agent can approve its own dialog, VERIFIED-EXP) | Unset via `env -u` (D-08). Impact on Claude UI is UNVERIFIED → LP-12. |
| Trust pre-seed | LC rule 1 always | SEC §5.5 opt-in after inspection | D-19. |
| Permission default | AL `policy:'ask'`, `onTimeout:'deny'`, 600 s | SEC §4.1 fail closed, 120 s | D-18, `timeoutMs:120000`. |
| Proxy plain HTTP | NP §1.1 forward absolute-form | SEC §6.4 405 | Rev 2: **405** (no plain-HTTP forwarding; §10 C2). |
| proxyAuthHelper | NP §6 accept any loopback client | SEC §6.2 refuse the channel | Refuse (channel off, §3.10). |
| Renderer | TUI §11 fullscreen (`CLAUDE_CODE_NO_FLICKER=1`) | SP §12.6 classic, corpus is classic | Classic (D-10). |
| Input path | TD §3 paste-buffer; TUI §1.3 ≤500-byte typed chunks | IN §3.1 editor injection | Editor primary, paste chunks fallback (D-15). |
| Isolation | TD §1.1 recommends perInstance in text, default perSession | — | perSession only in v1 (D-07). |
| Trust dialog footer | TUI §4.1 `enter confirm · esc cancel` | SP §2.4 / LV Q4 `Enter to confirm · Esc to cancel` (VERIFIED-LIVE) | Match both (`ESC_FOOTER` regex). |
| Stall threshold | RC §12 20 s | NP §5.4 quiet 15 s, stalled 25 s | `stallMs = 25000` on network bytes; the screen `Waiting for API response` banner is an independent claim. |
| Spinner glyphs | BRIEF `✻ ✶ ✳ ✢ · *` | SP §4.1 adds `✽` (seen 1086×), `●` | `[·✢✳✶✻✽*●]`. |
| Slug rule | BRIEF `/` and `.` | TF §1, OD §0.10 every non-alphanumeric | Never compute paths when a hook gave `transcript_path`; slug only as a cross-check. |
| Transcript "written promptly" | BRIEF | TF §6, LV Q3: lags 110–220 ms, assistant blocks only after the response completes | Hooks lead; transcript confirms. |
| Keys namespace | RC §3.1 generation-scoped `g1/t3` | AL §4.4 session counters `t1` | Session-scoped (D-05). |
| Facade event names | AL `SessionEvent` | RC `DomainEvent` | Domain union in §2.5; facade union per AL §6.2 with deltas in §2.10. |
| Lifecheck scope | user asked for a cron that wakes the build if usage limits are reached | LC §14 splits library vs orchestration | **The user request wins.** Library ships `ccd lifecheck` (reap/report only, §3.9). The build-orchestration wake-up is in scope, owned by WP-ORCH and specified in §3.11 (rev 2; P-LIFE-60 is now M). |
| Leading-slash escape | SEC §3.4 / IN §4.1 EXP: `" /zzqq"` was not run as a command | VERIFIED-BIN rev 2: `value.trim().startsWith("/")` then command lookup | Reject leading-slash prompts (D-16); LP-45 confirms on `" /cost"`. |
| `onOwnerDeath:'keep'` + `attach()` | AL §13, LC §6 | SEC §2.4 squattable port | Both cut; owner-watch kills the pane (D-28). |

### 0.3 Explicitly out of scope (accepted)

Live Bash output streaming (BRIEF hard decision). Windows / psmux (PA I14). `--bg` sessions and the agent-view daemon (PA §2.14.8). Fullscreen renderer parsing (D-10). Facades rx/mcp/http in v1 (D-33). Two independent writers on one transcript (TT §7). Same-uid malware not descended from Claude (SEC §0). `/login`, `/logout`, `/tui`, `/restart`, in-pane `/resume` (LC §10.4). Shared single-uid CI runners as a security boundary (SEC §9, documented). Revision 2 adds: `attach()`/detach/`onOwnerDeath:'keep'`, `whenBusy:'native'`, tmux control mode, network upstream chaining/plain-HTTP/token B, statusLine and registry channels, `facades/callbacks`, programmatic answers to MCP elicitations (they are surfaced as `awaitingInput`, §4.7), agent teams (detected, warned, §4.5.9), `/rewind` (§3.6). (The orchestration-level wake-up is **in** scope, §3.11.)

---

## 1. Layered architecture

### 1.1 Layer map

```
  L4   api/ (ClaudeSession, Turn, options → SessionSpec)          cli/ (ccd lifecheck|view|trace)
         │ uses SessionKernel port only (+ model/spec.ts, core/selectors.ts, runtime/node.ts createKernel)
  L3.5 runtime/node.ts            composition root: builds real L0 ports, wires them into session
  L3   session/                   orchestrator: kernel, step loop, queue+dedup, scheduler, pollers,
         │                        launcher/preflight/env/argv/settings plan, input executor,
         │                        permission broker (+path resolver), lifecycle (close/reap), registry, trace
  L2   core/                      pure: step, decide/*, reconcile/*, status/derive, claims, deadlines,
         │                        input-policy/* (incl. sanitizer), evolve, selectors
  L1   channels/                  pure-ish normalizers: hooks, transcript, screen (classifier+debounce),
         │                        network (tunnel tracker), statusline, registry; profiles/claude-2.1.316/*
  L0   platform/                  I/O adapters: tmux (execFile), fs-tail (poll+pread), hook-server (worker + standalone
                                  forwarder), netproxy(+standalone sidecar), editor(+standalone), process (+standalone
                                  owner-watch), env, clock, ids, runtime-dir/state-store, settings/claude-config, registry reader
  shared model/                   types, branded ids, CcdError, tiny pure helpers; imports nothing
  testing/                        fake aggregator, replay, scenario DSL (imports anything; nothing in src imports it);
                                  each L0 fake lives next to its real adapter's WP (platform/<x>/fake-*.ts, §8)
```

### 1.2 Normative file list (`src/`)

Every file below is owned by exactly one work package (§8). Paths are final (revision 2 changes are marked `rev2`). No barrel `index.ts` below the subpath roots (`src/api/index.ts`, `src/testing/index.ts`, `src/cli/main.ts`, `src/runtime/kernel-entry.ts`, `src/channels/profiles/index.ts`, `src/channels/profiles/claude-2.1.316/index.ts` are the only aggregators).

```
src/model/
  ids.ts                 branded keys (SessionKey, GenKey, TurnKey, ToolKey, AgentKey, PermissionKey,
                         ModelCallKey, MsgKey, InputJobKey, ObsSeq, EventSeq, IntentId, HookSeq) + key regexes
  time.ts                MonoMs, WallMs, Clock, Cancel
  json.ts                JsonValue, stableStringify(v) (sorted keys; the only logic besides isCcdError)
  errors.ts              CCD_ERROR_CODES, CcdErrorCode, CcdError, CcdErrorData, isCcdError
  logger.ts              Logger, LogFields
  config.ts              ResolvedConfig, CoreConfig (types only; resolveConfig lives in session/config.ts)
  spec.ts                rev2: SessionSpec (internal option shape; the only input of resolveConfig) (§2.11)
  kernel.ts              rev2: SessionKernel port types (KernelListener, KernelCloseOptions, SessionExitInfo) (§2.10)
  screen-facts.ts        ScreenFacts and sub-types (profile-free)
  observation.ts         Observation union, ObsMeta, ObservationInput (pre-seq)
  commands.ts            Command union, CommandResult
  intents.ts             Intent union, InputPrimitive, TmuxKeyName
  events.ts              DomainEvent union, EventEnvelope, Provenance
  state.ts               SessionState and entity types, AgentStatus, Fact<T>, lattices' enums
  debug.ts               DebugRecord (trace v1), Diagnostic
  version.ts             GENERATED: SUPPORTED_CLAUDE_VERSION = '2.1.316', LIB_VERSION

src/platform/
  ports.ts               ALL L0 port interfaces (types only; §2.7)
  clock/real-clock.ts
  ids/crypto-ids.ts
  process/process-port.ts          execFile wrapper, isAlive, kill, identity (ps -o lstart=,command=), spawnDetached
  process/which.ts                 PATH + /opt/homebrew/bin, /usr/local/bin, /usr/bin
  process/claude-binary.ts         resolve claude.exe, `--version`, `auth status --json` (10 s, never killed early)
  process/owner-watcher.ts         rev2: spawn/stop the owner-watch standalone (§3.8)
  process/standalone/owner-watch.ts  rev2: node:* only; kills Claude + tmux server ≤ 2 s after the owner dies
  process/fake-process.ts          rev2: fake (moved from testing/), same WP as the real adapter
  env/env-port.ts
  runtime-dir/runtime-dir.ts       root checks (lstat, owner, 0700, no symlink), mkdtemp, socket path length guard
  runtime-dir/state-store.ts       atomic JSON (tmp+rename, 0600), O_EXCL lock with stale rule, append-line
  settings/settings-file.ts        O_CREAT|O_EXCL 0600 writer + fsync + sha256, verify
  settings/claude-config.ts        ~/.claude.json read, trust lookup (realpath, ancestors to git root), seed/unseed (atomic, mode-preserving, single key)
  settings/settings-layers.ts      lenient read of user/project/local settings + keybindings.json
  settings/workspace-inspector.ts  WorkspaceRisk report (hooks, permissions, env, helpers, MCP) cwd → git root
  tmux/args.ts                     TmuxArg, escapeArg, SEP, command-list builder
  tmux/errors.ts                   typed tmux errors + stderr mapper
  tmux/exec.ts                     run(args, {stdin}) with -u -L -f, env, timeout 5 s, maxBuffer 16 MiB
  tmux/server.ts                   TmuxServer: prelude (incl. set-clipboard off), spawnPane, kill, socket cleanup (rev2: no control.ts, no sentinel, no adopt)
  tmux/fake-tmux.ts                rev2: fake, same WP
  tmux/pane.ts                     TmuxPane: FIFO input queue, paste, typeLiteral, sendKey, capture, status
  tmux/version.ts                  parse `tmux -V`, feature gates
  fs-tail/line-splitter.ts         byte-level 0x0A splitter, pending Buffer list, maxLineBytes discard mode
  fs-tail/follower.ts              one follower (poll: stat → (dev,ino,size) check → pread → split → emit; shrink or inode change → full rescan, uuid dedup in core) (rev2: no fingerprint ring, no fs.watch)
  fs-tail/discovery.ts             subagent discovery (expect, readdir backstop, workflows/*), realpath dedupe
  fs-tail/node-fs.ts               real TailFs (open/stat/read/readdir)
  fs-tail/fake-tail-fs.ts          rev2: fake, same WP
  fs-tail/tail.ts                  TranscriptTail implementation (§2.7.4)
  hook-server/auth.ts              token check (timingSafeEqual), Host/Origin/Content-Type checks
  hook-server/body.ts              streamed body with 32 MiB cap, truncation flag
  hook-server/http-server.ts       loopback HTTP server: constant empty 200 after the body is received, before parse
  hook-server/unix-server.ts       unix socket server for the command forwarder; holds PermissionRequest
  hook-server/worker.ts            rev2: worker_threads entry (node:* only) hosting both servers; postMessage protocol (§3.5)
  hook-server/transport.ts         HookTransport (main-thread proxy to the worker: seq stamping, respond, arm, close)
  hook-server/fake-hooks.ts        rev2: fake, same WP
  hook-server/standalone/forward.ts   command-hook forwarder (node:* only)
  editor/injector.ts               EditorInjector: write ccd-editor wrapper, stage/arm/consume detection
  editor/standalone/editor.ts      VISUAL target (node:* only); unarmed → exec the user's original $VISUAL/$EDITOR if recorded, else exit 1
  editor/fake-editor.ts            rev2: fake, same WP
  netproxy/client.ts               NetProxyPort: spawn sidecar, control socket, TunnelRecord stream
  netproxy/standalone/sidecar.ts   CONNECT pass-through proxy (node:* only)
  netproxy/fake-net.ts             rev2: fake, same WP
  settings/fake-config.ts          rev2: fake ClaudeConfigPort/SettingsFilePort, same WP
  clock/fake-clock.ts              rev2: fake (mono + wall, jumpWall), same WP
  registry/claude-registry.ts      lenient read of ~/.claude/sessions/<pid>.json (never *.key)

src/channels/
  profiles/index.ts                selectProfile(version) → ClaudeProfile | {unsupported}
  profiles/claude-2.1.316/index.ts assembles the profile object (WP-00; imports the four files below by fixed export names; never edited after Phase 0)
  profiles/claude-2.1.316/hooks.ts hook event names, registration table, payload field names
  profiles/claude-2.1.316/transcript.ts  entry types, merge policies, marker strings, regexes
  profiles/claude-2.1.316/screen.ts      string tables + regex catalogue (SP §13, verbatim)
  profiles/claude-2.1.316/errors.ts      usage-limit, auth, version-too-old, startup-gate strings (TUI §5, §6; LC §1); rev2: parseResetText(text, wallAt, tz)
  profiles/claude-2.1.316/commands.ts    rev2: slash-command aliases (`/quit`→`/exit`, `/new`,`/reset`→`/clear`, VERIFIED-BIN) and the allow/deny tables
  hooks/payload-guards.ts          lenient per-event guards (unknown fields kept)
  hooks/task-notification.ts       parse <task-notification> (task-id, tool-use-id, status, output-file)
  hooks/normalize.ts               RawHookEvent → ObservationInput[]
  transcript/entry-guards.ts
  transcript/file-state.ts         per-file normalizer state (current promptId)
  transcript/normalize.ts          TailEvent → ObservationInput[]
  screen/normalize-text.ts         strip OSC/CSI/C0, NBSP/U+202F/U+2007 → space, right-trim (no NFKC)
  screen/regions.ts                rule–❯–rule finder, status walk-up, footer, agent panel, dialog body
  screen/classify.ts               lines → ScreenSnapshot (pure)
  screen/debounce.ts               rev2: consecutive-identical drop (hash short-circuit) + frozen detector only; no stability wait (D-41)
  screen/to-facts.ts               ScreenSnapshot → ScreenFacts
  network/tunnel-tracker.ts        per-tunnel phase machine (idle→sending→awaiting→receiving)
  network/normalize.ts             TunnelRecord → ObservationInput[]
  registry/normalize.ts            (rev2: statusline/ removed)

src/core/
  init.ts                initialCore(init: CoreInit): CoreState
  step.ts                step(core, input): StepResult  (the only entry point)
  keys.ts                deterministic counters → keys
  facts.ts               Fact<T>, mergeFact, RANK, authority floors
  lattice.ts             status orders per entity, applyStatus()
  claims.ts              screen claims: candidate/asserted/confirmed/retracted/expired
  deadlines.ts           Deadline table ops, nextDeadline(core), fireDue()
  closing.ts             closing rules (turn, agent, generation, process)
  evolve.ts              evolve(domain, coreEvent) → domain; the ONLY writer of `domain` (rev2: I1 holds by construction, §2.9)
  selectors.ts           read-only views (canSubmit, isQuiescent, currentTurn, pendingPermissions, displayToolState, …)
  decide/session.ts      lifecycle, generations, readiness, gates, auth, exit
  decide/turns.ts
  decide/tools.ts
  decide/permissions.ts
  decide/agents.ts       subagents, internal agents, background tasks
  decide/model-calls.ts
  decide/messages.ts     assistant blocks, MessageDisplay deltas, final text
  decide/usage.ts        usage limits, rate limits, wake scheduling (deterministic jitter, wall deadline)
  decide/inputs-requested.ts  rev2: MCP elicitation / unknown blocking modal → awaitingInput
  decide/channels.ts     channel health, hook gaps, degraded mode
  decide/commands.ts     Command → state/jobs (validation, policy)
  reconcile/canonical.ts canonical JSON equality for tool_input
  reconcile/permission-binding.ts  PermissionRequest ↔ ToolRun (RC §5.1)
  reconcile/spawn-link.ts          SubagentStart ↔ Agent ToolRun (RC §5.3)
  reconcile/text-match.ts          MessageDisplay ↔ transcript text (RC §5.7)
  reconcile/net-correlate.ts       api-request ↔ token-A tunnel bursts (NP §5.3)
  status/derive.ts       deriveStatus(state): AgentStatus (§4.7)
  input-policy/sanitize.ts         sanitizePrompt, sanitizeCommandArgs, stripStandaloneInvisibles
  input-policy/ack-match.ts        normalizeForAck, stripPastedContentWrappers
  input-policy/gating.ts           inputBlocked computation
  input-policy/jobs.ts             InputJob types and constructors (types are normative in §2.9)
  input-policy/machine.ts          input job state machine → Intents

src/session/
  config.ts              resolveConfig(opts, env, defaults) (pure), DEFAULTS table
  errors-map.ts          L0 error → CcdError
  queue.ts               observation queue: seq stamping (rev2: no dedup window, D-42)
  loop.ts                single serialized step loop, subscriber fan-out (microtask, bounded, gap)
  scheduler.ts           one decision timer at nextDeadline (mono, or wall via ≤ 30 s re-checks); host-sleep detector (Δmono vs Δwall); event-loop-lag monitor
  event-log.ts           ring buffer + optional JSONL sink, replay fromSeq
  redact.ts              exact-token masking + pattern redactor (SEC §8.2)
  debug-trace.ts         DebugRecord writer (0600, async, 8 MiB lag cap)
  preflight.ts           all pre-launch checks (§3.1)
  env-builder.ts         child env (§3.2)
  argv-builder.ts        claude argv (§3.3), extraArgs denylist
  settings-plan.ts       settings JSON (§3.4)
  launcher.ts            orchestrates preflight → servers → settings → tmux spawn → process.launched
  input-executor.ts      executes input intents against TmuxPane/EditorInjector, reports input.done
  permission-broker.ts   PermissionKey ↔ HookSeq, runs user handler (in L3 because user code); policy timeout is a core deadline
  path-resolver.ts       rev2: executes `permission.resolvePaths` intents (realpath, lstat) → `permission.pathsResolved` (§3.7)
  pollers.ts             screen poll cadence and auth poll from `poll.cadence`/`auth.poll` intents; captureNow
  tail-driver.ts         executes tail.* intents, feeds hook transcript_path to observePath, poke()
  lifecycle.ts           close(), process-exit sync cleanup registry (keyed on globalThis[Symbol.for('claude-code-driver.exit-registry.v1')]), installSignalHandlers
  registry-store.ts      sessions/, owners/, exits/ records (§3.8)
  reaper.ts              reap logic shared with cli lifecheck (registry-entry rule, pid identity)
  selftest-cache.ts      rev2: once-per-(process, version, trust, transport) cache (D-35)
  limit-recorder.ts      rev2: always-on narrow raw ring; dumps a fixture on the first real usage limit (§3.9)
  kernel.ts              createSessionKernel(ports, config) implementing model/kernel.ts (rev2: no attach, no owner-control, no wall-watch file; wall deadlines are in scheduler.ts)

src/runtime/
  node.ts                createNodePorts(config) → Ports; createKernel(spec: SessionSpec) (rev2: no attachKernel)
  kernel-entry.ts        "./kernel" subpath re-exports (experimental)

src/api/
  index.ts  claude-session.ts  turn.ts  options.ts (public options + toSessionSpec)  public-types.ts  map-events.ts  map-state.ts  map-errors.ts  iterators.ts
src/cli/
  main.ts  lifecheck.ts  launchd.ts (plist/systemd/cron text + shim)  view.ts (prints/execs the read-only tmux attach; no kernel)  trace.ts
src/testing/
  index.ts  fake-ports.ts (aggregates the per-WP fakes)  test-kernel.ts  replay.ts  scenario.ts  arbitraries.ts
scripts/
  gen-version.mjs  api-report.mjs  fixtures-from-verify.mjs  fixtures-scrub.mjs  fixtures-lint.mjs  check-no-global-window-size.mjs  check-table-coverage.mjs
scripts/orchestrator/   rev2, WP-ORCH (§3.11): not part of the published package
  wake-check.mjs  install-wake.mjs  build-state.schema.json  com.claude-code-driver.buildwake.plist.tmpl  README.md
.github/workflows/      rev2, WP-CI: ci.yml  nightly.yml  (§7)
```

Tests live outside `src/`: `test/unit/<layer>/<area>/*.test.ts`, `test/contract/*.test.ts`, `test/kernel/*.test.ts`, `test/replay/*.test.ts`, `test/live/*.test.ts`, `test/arch/*.test.ts`. Fakes in `src/platform/**/fake-*.ts` are excluded from the published build (`tsconfig.build.json` `exclude`) and re-exported only through `src/testing/index.ts`; the arch test forbids any non-testing import of `fake-*`.

### 1.3 Dependency rule (rows may import columns)

| from \ to | model | platform | channels | core | session | runtime | api | facades | cli | testing |
|---|---|---|---|---|---|---|---|---|---|---|
| model | self | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| platform | ✓ | self | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| platform/*/standalone | `node:*` only | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| channels | ✓ | **type-only** | self | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| core | ✓ | ✗ | ✗ | self | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| session | ✓ | **type-only** (`ports.ts`) | ✓ | ✓ | self | ✗ | ✗ | ✗ | ✗ | ✗ |
| runtime | ✓ | ✓ | ✓ | ✓ | ✓ | self | ✗ | ✗ | ✗ | ✗ |
| api | ✓ | ✗ | ✗ | `selectors.ts` only | ✗ | `node.ts` (`createKernel`) only | self | ✗ | ✗ | ✗ |
| facades/x (reserved) | ✓ | ✗ | ✗ | `selectors.ts` only | ✗ | `node.ts` only | ✗ | ✗ (incl. siblings) | ✗ | ✗ |
| cli | ✓ | ✗ | ✗ | ✗ | `reaper.ts`, `registry-store.ts` | ✓ | ✓ | ✗ | self | ✗ |
| testing | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | self |

Extra rules: core and model may not import `node:*` or any npm package; no cycles anywhere; no `src/**` outside `testing/` imports `testing/**` or any `fake-*.ts`; `api/**` imports no npm dependency; the kernel port types live in `model/kernel.ts` so `api` never imports `session/**` (rev2); no L0/L1/L2-internal type may appear in `dist/api/index.d.ts` (API report grep for `Tmux|TailLine|TailEvent|RawHookEvent|ScreenSnapshot|TunnelRecord|Capture\b|Fact<|SessionState|SessionSpec|ResolvedConfig|CoreConfig|Observation|DomainEvent|Intent\b|ReconState`).

### 1.4 Enforcement

1. **dependency-cruiser 17.4.3** (authoritative, CI, Node 22). Config `.dependency-cruiser.cjs` = AL §3.2 verbatim with two changes: `facades-isolated` is written as one rule per facade folder (the `$1` back-reference is UNVERIFIED, AL §14.6) and a rule `cli-no-low` (`^src/cli/` → `^src/(platform|channels)/`). VERIFIED (AL §3.2 [exp]): `tsPreCompilationDeps:true` makes `import type` visible; `dependencyTypesNot:['type-only']` allows type edges; `dependencyTypes:['core']` catches Node built-ins. The `standalone-builtins-only` rule is UNVERIFIED in AL; WP0 MUST add a fixture test that plants a violation and asserts the exit code.
2. **ESLint 10.14.0 + typescript-eslint 8.72.1** per-layer `@typescript-eslint/no-restricted-imports` (AL §3.3) plus core determinism rules: `no-restricted-globals` for `Date setTimeout setInterval setImmediate queueMicrotask performance process console crypto`, `no-restricted-properties` for `Math.random`, `no-restricted-syntax` for `AwaitExpression` and `ThrowStatement` in `src/core/**`; repo-wide ban on `emit('error')` and on top-level await. Do not name any subfolder after a layer (`core`, `session`, …): the glob matches the import string (AL §3.3 caveat).
3. **`test/arch/*.test.ts`**: (a) `scripts/check-no-global-window-size.mjs` greps `src/` for `-g window-size`, `set -g window-size`, `-gw window-size` (TD §5.3); (b) public `.d.ts` leak grep; (c) every `src/platform/*/standalone/*.ts` and `hook-server/worker.ts` imports only `node:*` (parse imports with the TS compiler API); (d) no `process.env` spread in `src/session/env-builder.ts` (AST check for `...process.env`); (e) rev2 **option-isolation**: no file outside `src/api/**` references a property name declared only in `api/options.ts` (TS compiler API walk), and `session/config.ts` imports `SessionSpec` from `model/spec.ts` and nothing from `api/**`; (f) rev2 **kernel-only facade**: `test/arch/kernel-only-facade.ts` (≈ 40 lines, test-only) drives K-01, K-09 and K-13 through `model/kernel.ts` types + `createKernel` alone, proving a different facade needs nothing else; (g) rev2 `scripts/check-table-coverage.mjs`: every row of the §4.3/§4.4/§4.10 tables, numbered by position (`§4.4#7`), is named in at least one test title (replaces the 95 % line-coverage pressure, §10 D7).
4. **API report** `scripts/api-report.mjs` (AL §10.4) → `etc/claude-code-driver.api.d.ts`; CI fails on diff.
5. **knip 6.44.1** for unused exports/files (dead layer code).

---

## 2. Module boundary interfaces (normative TypeScript)

All types are `readonly` in spirit; the snippets omit `readonly` where noise. Files are the ones named in §1.2.

### 2.1 `model/ids.ts`, `model/time.ts`, `model/json.ts`

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type SessionKey    = Brand<string, 'SessionKey'>;    // 's' + 8 hex, minted by L3 (random OK outside core)
export type GenKey        = Brand<string, 'GenKey'>;        // 'g1', 'g2' … one per Claude session_id seen in this pane
export type TurnKey       = Brand<string, 'TurnKey'>;       // 't1' …
export type ToolKey       = Brand<string, 'ToolKey'>;       // 'u1' …
export type AgentKey      = Brand<string, 'AgentKey'>;      // 'a1' …   (public alias SubagentKey)
export type PermissionKey = Brand<string, 'PermissionKey'>; // 'p1' …
export type ModelCallKey  = Brand<string, 'ModelCallKey'>;  // 'c1' …
export type MsgKey        = Brand<string, 'MsgKey'>;        // 'm1' …
export type InputJobKey   = Brand<string, 'InputJobKey'>;   // 'j1' …
export type ObsSeq   = Brand<number, 'ObsSeq'>;    // L3 queue, strictly increasing, gap-free per session
export type EventSeq = Brand<number, 'EventSeq'>;  // core, gap-free per session
export type IntentId = Brand<number, 'IntentId'>;  // core counter
export type HookSeq  = Brand<number, 'HookSeq'>;   // L0 hook transport counter
export const KEY_RE = { turn: /^t\d+$/, tool: /^u\d+$/, agent: /^a\d+$/, perm: /^p\d+$/, call: /^c\d+$/, msg: /^m\d+$/, job: /^j\d+$/, gen: /^g\d+$/ } as const;

// time.ts
export type MonoMs = Brand<number, 'MonoMs'>;   // performance.now() based; the ONLY time the core uses
export type WallMs = Brand<number, 'WallMs'>;   // Date.now(); joins with transcript timestamps + display only
export type Cancel = () => void;
export interface Clock {
  now(): MonoMs;
  wallNow(): WallMs;
  setTimer(atMono: MonoMs, fn: () => void): Cancel;   // absolute deadline (no drift accumulation)
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

// json.ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export function stableStringify(v: unknown): string;  // sorted keys, no whitespace; used for canonical tool_input equality and trace hashing
```

### 2.2 `model/errors.ts`

```ts
// Internal, fine-grained codes. Never renamed; may grow. They appear publicly only as `details.reason`.
export const CCD_ERROR_CODES = [
  // config
  'E_CONFIG_INVALID', 'E_FORBIDDEN_ENV', 'E_FORBIDDEN_ARG',
  // environment
  'E_NODE_UNSUPPORTED', 'E_TMUX_NOT_FOUND', 'E_TMUX_UNSUPPORTED', 'E_CLAUDE_NOT_FOUND', 'E_CLAUDE_VERSION_MISMATCH',
  'E_UNSAFE_RUNTIME_DIR', 'E_SOCKET_PATH_TOO_LONG', 'E_KEYBINDING_CONFLICT', 'E_NOT_ONBOARDED', 'E_LOGIN_REQUIRED',
  'E_AUTH_METHOD_UNSUPPORTED', 'E_API_PROVIDER_UNSUPPORTED', 'E_CONFIG_CORRUPT', 'E_HOOKS_DISABLED_BY_USER', 'E_HOOKS_BLOCKED_BY_POLICY',
  // startup
  'E_STARTUP_TIMEOUT', 'E_TRUST_REQUIRED', 'E_WORKSPACE_RISK', 'E_STARTUP_GATE', 'E_SETTINGS_INVALID',
  'E_SESSION_ID_IN_USE', 'E_RESUME_NOT_FOUND', 'E_VERSION_POLICY', 'E_SELFTEST_FAILED', 'E_HOOKS_UNAVAILABLE', 'E_STARTUP_EXITED',
  // input
  'E_BUSY', 'E_NOT_READY', 'E_SUBMIT_UNCONFIRMED', 'E_INPUT_GATED', 'E_INPUT_INVALID', 'E_INPUT_REJECTED',
  'E_INPUT_TAMPERED', 'E_COMMAND_FORBIDDEN', 'E_PERMISSION_UNKNOWN', 'E_PERMISSION_INVALID', 'E_MODE_FORBIDDEN', 'E_WAIT_TIMEOUT',
  // turn
  'E_TURN_INTERRUPTED', 'E_TURN_API_ERROR', 'E_TURN_STALLED', 'E_USAGE_LIMIT', 'E_AUTH_REQUIRED', 'E_TURN_ABORTED',
  'E_TURN_BLOCKED_BY_HOOK', 'E_CLAUDE_VERSION_TOO_OLD', 'E_TURN_REFUSED',
  // session
  'E_SESSION_EXITED', 'E_SESSION_CLOSED', 'E_HOOK_PORT_LOST', 'E_OWNER_GONE',
  // channel
  'E_CHANNEL_DOWN', 'E_TRANSCRIPT_REWRITE', 'E_SCREEN_UNKNOWN', 'E_NETWORK_UNAVAILABLE', 'E_HOST_LOOP_LAG',
  // security
  'E_SECURITY_UNEXPECTED_INPUT', 'E_SECURITY_HOOK_FORGERY', 'E_SECURITY_SETTINGS_TAMPERED',
  // feature
  'E_UNSUPPORTED_FEATURE',
  // internal
  'E_LISTENER_THREW', 'E_INVARIANT',
] as const;
export type CcdErrorCode = (typeof CCD_ERROR_CODES)[number];

// rev2 (D-40): the 18 codes a user can switch on. Frozen; the public CcdError.code is always one of these.
export const PUBLIC_ERROR_CODES = [
  'E_CONFIG', 'E_ENVIRONMENT', 'E_VERSION_MISMATCH', 'E_AUTH', 'E_TRUST_REQUIRED', 'E_STARTUP', 'E_HOOKS_UNAVAILABLE',
  'E_INPUT_REJECTED', 'E_SUBMIT_UNCONFIRMED', 'E_BUSY', 'E_PERMISSION_INVALID', 'E_TURN_FAILED', 'E_USAGE_LIMIT',
  'E_SESSION_CLOSED', 'E_SESSION_EXITED', 'E_SECURITY', 'E_TIMEOUT', 'E_INTERNAL',
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];
export const PUBLIC_CODE_OF: Readonly<Record<CcdErrorCode, PublicErrorCode>>;   // total map, unit-tested for totality
// e.g. E_FORBIDDEN_ARG → E_CONFIG; E_TMUX_NOT_FOUND → E_ENVIRONMENT; E_LOGIN_REQUIRED / E_AUTH_METHOD_UNSUPPORTED /
// E_API_PROVIDER_UNSUPPORTED / E_AUTH_REQUIRED → E_AUTH; E_TURN_API_ERROR / E_TURN_REFUSED / E_TURN_BLOCKED_BY_HOOK → E_TURN_FAILED;
// E_WAIT_TIMEOUT / E_STARTUP_TIMEOUT → E_TIMEOUT; E_SECURITY_* / E_INPUT_TAMPERED → E_SECURITY; E_OWNER_GONE → E_SESSION_EXITED.

export type CcdErrorCategory = 'config'|'environment'|'startup'|'input'|'turn'|'session'|'channel'|'security'|'feature'|'internal';
export interface CcdErrorData { code: CcdErrorCode; message: string; details?: Record<string, JsonValue> }
export class CcdError extends Error {      // internal error (L0–L3)
  readonly code: CcdErrorCode; readonly category: CcdErrorCategory; readonly retryable: boolean;
  readonly details?: Readonly<Record<string, JsonValue>>;
  constructor(code: CcdErrorCode, message: string, opts?: { cause?: unknown; details?: Record<string, JsonValue> });
  toJSON(): CcdErrorData;
}
export function isCcdError(e: unknown, code?: CcdErrorCode): e is CcdError;   // duck-typed on `code`, not instanceof
export const ERROR_META: Readonly<Record<CcdErrorCode, { category: CcdErrorCategory; retryable: boolean }>>;
```
Rule: thrown only from calls the user awaits (`start`, `command`, `completed`, `respondToPermission`, `answerQuestion`, `approvePlan`, `waitFor`); everything else is an event (AL §7). `details` never carries raw child-process errors (`err.cmd` holds argv, SEC §7.1). The public facade (`api/map-errors.ts`) throws `ClaudeSessionError { code: PublicErrorCode; details: { reason: CcdErrorCode; … } }` (§2.12).

### 2.3 `model/screen-facts.ts`

```ts
export type StartupGateKind = 'configError' | 'settingsError' | 'onboarding' | 'login' | 'trust' | 'apiKey'
  | 'bypass' | 'mcpApproval' | 'claudeMdImports' | 'rendererOffer' | 'sessionInUse' | 'resumeDialog' | 'other';
export interface ScreenOption { n?: number; label: string; selected: boolean }
export interface ScreenFacts {
  surface: 'main' | 'permissionDialog' | 'trustDialog' | 'usageLimitMenu' | 'resumeDialog' | 'startupGate'
         | 'modal' | 'unknownModal' | 'exited' | 'blank' | 'partialFrame' | 'unsupportedRenderer';
  torn: boolean; altScreen: boolean; inCopyMode: boolean; paneWidth: number; paneHeight: number;
  frameHash: string;                                  // hash of normalized bottom region
  status?: {
    kind: 'spinner' | 'retrying' | 'retryingUnparsed' | 'stalled' | 'noResponse' | 'lowPriority'
        | 'autoModeUnavailable' | 'done' | 'waitingBackground' | 'interrupted' | 'none';
    attempt?: number; max?: number; retryInMs?: number; truncatedMsg?: boolean;
    errorHint?: 'rateLimit' | 'proxy' | 'network' | 'api' | 'unknown';   // from the untruncated prefix only
    resetText?: string; resetsAtWall?: WallMs;                           // rev2: `(<reset>)` form of the rate-limit retry line (SP §16 Q7, LP-30)
    hookWait?: { event: string; done: number; total: number };           // `running PreToolUse hooks… 1/2`
    tokens?: { dir: 'up' | 'down'; count: number }; elapsedMs?: number; thinkingLabel?: string;
    doneDurationMs?: number; waitingBackground?: { agents?: number; workflows?: number };
  };
  interruptedBanner: boolean;                         // `⎿  Interrupted · …` in the last block, no newer prompt echo
  footer?: { busy: boolean; modeLabel: string | null; mode?: 'default'|'acceptEdits'|'plan'|'auto'|'bypassPermissions'|'dontAsk';
             pasting: boolean; ctrlCExitArmed: boolean; hints: string[] };
  composer?: { text: string; empty: boolean; placeholderLikely: boolean; pastedPlaceholder: boolean;
               notices: Array<'invisibleChars' | 'blockedByHook' | 'unknownCommand' | 'escAgainToClear' | 'stashed' | 'draftRestored'> };
  dialog?: { kind: 'permission' | 'trust' | 'usageLimitMenu' | 'resume' | 'survey' | 'rewind' | 'elicitation' | 'planApproval' | 'question' | 'gate' | 'other';
             gate?: StartupGateKind; title?: string; question?: string; options: ScreenOption[]; footer?: string };
  usageLimit?: { line: string; limitName?: string; resetsText?: string;
                 resetsAtWall?: WallMs;               // rev2: parsed in L1 by profile errors.ts parseResetText(text, meta.wallAt, tz) (§3.9)
                 autoContinue?: 'waiting' | 'resetContinuing' | 'stalePressEnter' | 'cancelled' | 'stopped' | 'none' };
  auth?: { kind: 'loginExpired' | 'notLoggedIn' | 'tokenRevoked' | 'refreshLock' | 'transient' | 'other'; line: string };
  apiErrorLine?: string;                              // `API Error: …` (classification hint only)
  versionTooOld?: boolean;                            // claude_code_version_too_old regex (LC §11)
  hookErrorLines: number;                             // `<Event>:<Tool> hook error` lines in the last block
  agentPanelRows: number;
  headerVersion?: string;                             // `Claude Code v2.1.316`
}
```
`dialog.kind 'elicitation'` (MCP elicitation form/URL dialog), `'planApproval'` (ExitPlanMode) and `'question'` (AskUserQuestion) are rev2 additions; their exact strings are UNVERIFIED (no corpus frames) → LP-46/LP-51, and until then they classify as `unknownModal`, which the core treats as `awaitingInput{kind:'unknownModal'}` (§4.7), never as idle.

### 2.4 `model/observation.ts`

```ts
export type Source = 'hook' | 'transcript' | 'network' | 'registry' | 'screen'
                   | 'self' | 'clock' | 'process' | 'channel';
export type ObsOrigin =
  | { kind: 'hook'; transport: 'http' | 'unix'; event: string; hookSeq: HookSeq }
  | { kind: 'transcript'; fileKey: string; generation: number; offset: number; entryUuid?: string; entryTs?: string; sidechain: boolean }
  | { kind: 'screen'; frameHash: string }
  | { kind: 'network'; tunnelId: number }
  | { kind: 'self'; intentId: IntentId };
export interface ObsMeta {
  seq: ObsSeq; at: MonoMs; wallAt: WallMs; source: Source;
  uuid?: string;                    // rev2: transcript entry uuid; the ONLY de-duplication key (core, per generation; D-42)
  claudeSessionId?: string;         // as reported by the record (generation join; never filtered in L1)
  agentId?: string;                 // present for subagent-scoped records
  replay?: boolean;                 // historical transcript catch-up (resume) → silent state rebuild
  origin?: ObsOrigin; rawRef?: number;
}
export interface Obs<K extends string, P> { kind: K; meta: ObsMeta; p: P }
export type ObservationInput = { [O in Observation as O['kind']]: { kind: O['kind']; meta: Omit<ObsMeta, 'seq'>; p: O['p'] } }[Observation['kind']];

export type PromptOrigin = 'human' | 'library' | 'selftest' | 'task_notification' | 'scheduled' | 'auto_continue' | 'peer_message' | 'bash_mode' | 'unknown';
export type PermissionDecider = 'hook' | 'user_keys' | 'config' | 'classifier' | 'unknown';
export interface AgentRef { agentId: string; agentType?: string; teammateName?: string }   // agentType '' = internal agent
export interface BgTaskInfo { id: string; type: string; status: string; description?: string; agentType?: string }
export interface RateLimitWindow { name: 'five_hour' | 'seven_day' | 'spend_limit' | string; usedPct?: number; resetsAtWall?: WallMs }
export interface ResolvedPath { arg: 'file_path' | 'path' | 'pattern' | 'glob' | 'notebook_path' | string; raw: string;
  real?: string; inside: boolean; reason?: 'outside' | 'symlinkOut' | 'absolutePattern' | 'parentSegment' | 'tilde' | 'enoent' | 'unknownArg' }

export type Observation =
  // ---- session / process ----
  | Obs<'session.started', { sessionId: string; transcriptPath: string; source: 'startup'|'resume'|'clear'|'compact'|'fork'|string; model?: string }>
  | Obs<'session.ended', { sessionId: string; reason: string }>
  | Obs<'process.launched', { pid: number; paneId: string; claudeVersion: string; startTime: string }>
  | Obs<'process.exited', { exitStatus: number | null; signal: string | null; byOwnerWatch?: boolean }>
  | Obs<'process.identityMismatch', { pid: number }>
  | Obs<'auth.status', { loggedIn: boolean; authMethod?: string; apiProvider?: string }>                    // rev2: result of an auth.poll intent
  // ---- prompts / turns ----
  | Obs<'prompt.submitted', { promptId: string; text: string; taskNotification?: { taskId: string; toolUseId?: string; status: string } }>   // UPS
  | Obs<'prompt.recorded', { promptId?: string; uuid: string; parentUuid: string | null; text?: string; origin?: string; promptSource?: string;
                              isMeta: boolean; bashInput?: boolean; localCommand?: { name: string; args?: string; stdout?: string } }>
  | Obs<'queue.op', { op: 'enqueue' | 'dequeue' | 'remove' | 'popAll' | string; content?: string; reason?: string }>
  | Obs<'prompt.absorbed', { text: string; deliveryId?: string }>      // queued_command attachment: evidence for TurnRecord.mergedInto only
  | Obs<'prompt.withdrawn', {}>
  | Obs<'turn.stopped', { promptId?: string; lastAssistantMessage?: string; backgroundTasks: BgTaskInfo[]; stopHookActive: boolean }>
  | Obs<'turn.failed', { promptId?: string; error: string; errorDetails?: string; message?: string }>          // StopFailure
  | Obs<'turn.durationRecorded', { durationMs: number; pendingBackgroundAgentCount: number }>
  | Obs<'turn.interrupted', { marker: 'request' | 'tool_use' | 'aborted_mid_stream'; interruptedMessageId?: string; promptId?: string }>
  // ---- model calls ----
  | Obs<'model.requestStarted', { requestRef: string; querySource?: string; requestDigest?: string; isRetry: boolean; txWall?: WallMs }>
  | Obs<'model.apiErrorRecorded', { error: string; apiError?: string; text: string; resetsAtWall?: WallMs; rateLimitType?: string }> // synthetic isApiErrorMessage
  | Obs<'model.refused', { refusedMessageId: string; text: string; uuid: string }>                         // rev2: TF §4.2 item 8 (isMeta + turnCompanion + refusedMessageId)
  | Obs<'model.refusalFallback', { retractedMessageUuids: string[]; refusedUserMessageUuid?: string; originalModel?: string; fallbackModel?: string;
                                   requestId?: string; trigger?: string; scope?: string; category?: string }>   // rev2: TF §4.4 system:model_refusal_fallback
  // ---- assistant output ----
  | Obs<'message.textDelta', { promptId?: string; uiTurnId: string; uiMessageId: string; index: number; final: boolean; delta: string }>
  | Obs<'message.block', { apiMessageId: string; requestId?: string; requestRef?: string; blockIndex: number; block: 'thinking' | 'text' | 'tool_use';
                            toolUseId?: string; toolName?: string; input?: unknown; text?: string; stopReason: string | null; synthetic: boolean;
                            abortedMidStream: boolean; uuid: string; parentUuid: string | null; usage?: TokenUsage }>
  // ---- tools ----
  | Obs<'tool.pre', { toolUseId: string; toolName: string; input: unknown; promptId?: string; agent?: AgentRef }>
  | Obs<'tool.post', { toolUseId: string; toolName: string; input?: unknown; response: unknown; responseTruncated?: boolean; durationMs?: number; agent?: AgentRef; asyncAgentId?: string }>
  | Obs<'tool.failed', { toolUseId: string; toolName: string; error: string; isInterrupt?: boolean; agent?: AgentRef }>
  | Obs<'tool.batchDone', { toolUseIds: string[]; agent?: AgentRef }>
  | Obs<'tool.result', { toolUseId: string; isError: boolean; denialKind?: string; interrupted?: boolean; asyncAgentId?: string; uuid: string; contentPreview?: string }>
  | Obs<'tool.validationError', { toolUseId: string }>
  // ---- permissions ----
  | Obs<'permission.requested', { hookSeq: HookSeq; toolName: string; input: unknown; promptId?: string; agent?: AgentRef; suggestions: unknown[]; permissionMode?: string }>
  | Obs<'permission.hookClosed', { hookSeq: HookSeq; reason: 'answered' | 'client_gone' | 'timeout' }>
  | Obs<'permission.decisionRecorded', { toolUseId: string; decision: 'accept' | 'reject'; decider: PermissionDecider; via: 'attachment' | 'tool_result'; reasonCode?: string }>
  | Obs<'permission.autoDenied', { toolUseId: string; toolName: string; reason: string }>
  | Obs<'permission.pathsResolved', { permissionKey: PermissionKey; cwdRealpath: string; paths: ResolvedPath[] }>  // rev2: result of permission.resolvePaths (§3.7)
  // ---- agents / background ----
  | Obs<'agent.started', { agent: AgentRef; promptId?: string }>
  | Obs<'agent.stopped', { agent: AgentRef; transcriptPath?: string; lastAssistantMessage?: string; backgroundTasks: BgTaskInfo[] }>
  | Obs<'agent.meta', { agentId: string; toolUseId?: string; agentType?: string; spawnDepth?: number; finished?: boolean }>
  | Obs<'agent.fileMissing', { agentId: string }>
  | Obs<'bgtask.status', { taskId: string; taskType: string; status: string; toolUseId?: string }>
  // ---- misc hook facts ----
  | Obs<'notification', { type: string; message?: string }>
  | Obs<'input.requested', { kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput'; message?: string; server?: string }>  // rev2: Notification elicitation_dialog / elicitation_url_dialog / agent_needs_input
  | Obs<'input.requestCleared', { kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput'; how: 'complete' | 'response' }>   // rev2: elicitation_complete / elicitation_response
  | Obs<'compact.phase', { phase: 'started' | 'finished'; trigger?: string }>
  | Obs<'mode.observed', { permissionMode: string }>
  | Obs<'model.switched', { fromModel?: string; toModel: string; source?: string }>       // PostModelSwitch
  | Obs<'config.changed', { source: string; filePath?: string }>                           // ConfigChange
  | Obs<'cwd.changed', { oldCwd: string; newCwd: string }>                                 // CwdChanged
  | Obs<'transcript.relocated', { sessionId: string; newPath: string }>
  | Obs<'transcript.continuedIn', { continuedInSessionId: string }>
  | Obs<'transcript.file', { event: 'waiting' | 'opened' | 'moved' | 'rewrite' | 'resynced' | 'malformed' | 'oversize' | 'missing'; fileKey: string; detail: unknown }>
  | Obs<'hookchannel.error', { hookEvent: string; toolUseId?: string; kind: 'non_blocking_error' | 'cancelled' | 'blocked_url' | 'untrusted'; detail?: string }>
  // ---- screen / network / registry ----
  | Obs<'screen.frame', ScreenFacts>
  | Obs<'net.tunnel', { tunnelId: number; host: string; token: 'A' | 'none' | 'bad'; phase: 'open' | 'sending' | 'awaiting' | 'receiving' | 'idle' | 'close' | 'error' | 'refused';
                         bytesUp: number; bytesDown: number; lastDownAtMono?: MonoMs; endedBy?: 'terminator' | 'close' | 'rst'; error?: string }>
  | Obs<'registry', { pid: number; sessionId?: string; status?: string; waitingFor?: string; version?: string }>   // single post-launch read
  // ---- self (facts about the library's own actions) ----
  | Obs<'input.done', { intentId: IntentId; job?: InputJobKey; primitive: InputPrimitive['kind']; ok: boolean; error?: CcdErrorCode; detail?: string; output?: string }>
  | Obs<'hook.responded', { hookSeq: HookSeq; ok: boolean; clientGone: boolean }>
  | Obs<'hook.selfTestArmed', { nonce: string; armed: boolean }>                            // rev2: ack of hook.armSelfTest / hook.disarmSelfTest
  | Obs<'host.loopLag', { p99Ms: number; maxMs: number; windowMs: number }>                 // rev2: L3 monitorEventLoopDelay, only when p99 > 500 ms
  // ---- time / channel health ----
  | Obs<'clock.tick', {}>
  | Obs<'clock.hostResumed', { monoGapMs: number; wallGapMs: number }>
  | Obs<'channel.health', { channel: ChannelName; health: 'up' | 'degraded' | 'down' | 'off'; reason?: string }>   // L0/L3 transport facts only (never auth)
  | Obs<'unknown', { channel: Source; raw: unknown }>;

export interface TokenUsage { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
export type ChannelName = 'hooks' | 'transcript' | 'screen' | 'network';
```
Removed in rev2: `host.permissionTimeout` (now the core deadline `permissionPolicy`), `statusline` (channel cut), `transcript.file{event:'retracted'}` (no fingerprint ring; a shrink is `rewrite` + full rescan), `ObsMeta.dedupKey`.

Normalizer mapping (L1, exhaustive): RC §2.3 table is normative, with these additions: `PostModelSwitch` → `model.switched`; `ConfigChange` → `config.changed`; `CwdChanged` → `cwd.changed` (and the L3 tail driver re-stats); transcript `relocated` → `transcript.relocated`; transcript `continued-in` → `transcript.continuedIn`; synthetic assistant with `isApiErrorMessage` → `model.apiErrorRecorded` (with `apiErrorParams.rate_limit_info.resetsAt` epoch-seconds → `resetsAtWall`, LC §3.1, VERIFIED-SRC, live UNVERIFIED LP-30); transcript user `<bash-input>` → `prompt.recorded{bashInput:true}` (IN §4.2); `system:local_command` → `prompt.recorded{localCommand}`; rev2: user entry with `isMeta:true` and `refusedMessageId` → `model.refused` (never `prompt.recorded`); `system` subtype `model_refusal_fallback` → `model.refusalFallback`; `Notification{elicitation_dialog|elicitation_url_dialog|agent_needs_input}` → `input.requested` **and** `notification`; `Notification{elicitation_complete|elicitation_response}` → `input.requestCleared`; `Notification{quota_auto_resume_*}` stays `notification` (core interprets); any payload with `teammate_name`, and `background_tasks[].type === 'teammate'`, set `AgentRef.teammateName` / a `bgtask.status{taskType:'teammate'}`. L1 **never** drops a hook because of its `session_id` (rev2 §10 A5): the token authenticates, the core decides generations.

Ordering keys (rev2, D-42): no time-window de-duplication anywhere. Transcript chain entries carry `meta.uuid` (core de-dups per generation, `recon.seenUuids`); `api-request` entries use `txreq:<id>` as their uuid; metadata entries fold last-wins in core; screen frames reach the queue only on change (L1 `debounce.ts` drops consecutive identical `frameHash`); network phases carry a per-tunnel sequence; hooks are never de-duplicated (exactly one transport per event).

### 2.5 `model/events.ts` (DomainEvent, L2 → L3/L4) and the internal `CoreEvent`

```ts
export interface Provenance { confirmed: boolean; sources: Source[] }
export interface EventEnvelope<T extends string, P> {
  v: 1; seq: EventSeq; type: T; at: MonoMs; wallAt: WallMs; sessionKey: SessionKey; gen?: GenKey; turnKey?: TurnKey;
  provenance: Provenance; causedBy: ObsSeq[]; replayed?: boolean; payload: P;
}
type E<T extends string, P> = EventEnvelope<T, P>;
export type DomainEvent =
  | E<'session.launching', { cwd: string; claudeVersion: string; claudeSessionId: string; resume: boolean }>
  | E<'session.gated', { gate: StartupGateKind; text: string }>
  | E<'session.ready', { permissionMode: PermissionMode; model?: string; selfTest: 'passed' | 'cached' | 'skipped'; resumed: boolean; hookTransport: 'http' | 'unix' }>
  | E<'session.generationChanged', { from?: string; to: string; gen: GenKey; reason: 'startup' | 'clear' | 'resume' | 'fork' | 'continuedIn' | 'implicit' | 'unknown' }>
  | E<'session.modeChanged', { mode: PermissionMode }>
  | E<'session.modelChanged', { model: string; source?: 'switch' | 'refusalFallback' | 'command' | string; savedAsDefault?: boolean }>
  | E<'session.authRequired', { message: string }>
  | E<'session.authRestored', {}>
  | E<'session.closing', { reason: string }>
  | E<'session.exited', { exitStatus: number | null; signal: string | null; reason: 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone'; finalScreen?: string }>
  | E<'status.changed', { from: AgentStatus; to: AgentStatus }>
  | E<'turn.queued', { prompt: string; origin: PromptOrigin; clientRef?: string }>
  | E<'turn.submitting', { attempt: number; method: 'editor' | 'pasteChunks' }>
  | E<'turn.accepted', { promptId: string; mergedInto?: TurnKey }>
  | E<'turn.ended', { outcome: TurnOutcome; endedBy: TurnEndedBy; error?: CcdErrorData; durationMs?: number; finalText?: string; truncated?: boolean; refused?: boolean }>
  | E<'turn.resolvedLate', { from: 'unknown'; to: TurnOutcome }>
  | E<'turn.textAppended', { msgKey: MsgKey }>                       // late MessageDisplay after Stop (stopGrace)
  | E<'assistant.textDelta', { msgKey: MsgKey; index: number; delta: string; final: boolean }>
  | E<'assistant.block', { msgKey: MsgKey; apiMessageId: string; blockIndex: number; block: 'thinking' | 'text' | 'tool_use'; text?: string; agentKey?: AgentKey }>
  | E<'assistant.retracted', { msgKeys: MsgKey[]; reason: 'refusalFallback' | 'refused' }>       // rev2: logical retraction (§4.5.10)
  | E<'tool.started', { toolKey: ToolKey; toolUseId?: string; name: string; input: unknown; agentKey?: AgentKey }>
  | E<'tool.updated', { toolKey: ToolKey; state: ToolState }>
  | E<'tool.ended', { toolKey: ToolKey; state: ToolState; outcomeFrom: ToolOutcomeFrom; durationMs?: number; responseRef?: ResponseRef }>
  | E<'tool.resolvedLate', { toolKey: ToolKey; to: ToolState }>
  | E<'permission.requested', { permissionKey: PermissionKey; toolKey?: ToolKey; toolName: string; input: unknown; suggestions: unknown[]; binding: PermissionBinding['kind'];
                                autoAnswerAllowed: boolean; agentKey?: AgentKey; needs: 'decision' | 'answers' | 'planApproval'; adopted?: boolean }>
  | E<'permission.bound' | 'permission.rebound', { permissionKey: PermissionKey; toolKey: ToolKey; confirmed: boolean }>
  | E<'permission.answered', { permissionKey: PermissionKey; decision: 'allow' | 'deny'; by: 'host' | 'handler' | 'policy' | 'timeout' | 'close'; via: 'hook' | 'keys' }>
  | E<'permission.resolved', { permissionKey: PermissionKey; decision: 'allow' | 'deny'; decider: PermissionDecider; overridden: boolean }>
  | E<'permission.needsKeys', { permissionKey: PermissionKey }>
  | E<'permission.abandoned', { permissionKey: PermissionKey; reason: string }>
  | E<'input.requested', { requestKey: string; kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput' | 'unknownModal'; message?: string }>   // rev2
  | E<'input.cleared', { requestKey: string; how: 'complete' | 'response' | 'screenGone' | 'interrupted' }>                                    // rev2
  | E<'subagent.started', { agentKey: AgentKey; agentId: string; agentType: string; background: boolean; internal: boolean; teammate: boolean; spawnToolKey?: ToolKey }>
  | E<'subagent.linked', { agentKey: AgentKey; spawnToolKey: ToolKey; confirmed: boolean }>
  | E<'subagent.stopped', { agentKey: AgentKey; lastAssistantMessage?: string; fileMissing: boolean }>
  | E<'bgtask.updated', { taskId: string; type: string; status: string }>
  | E<'modelCall.started', { callKey: ModelCallKey; requestRef?: string; attempt: number; agentKey?: AgentKey }>
  | E<'modelCall.progress', { callKey: ModelCallKey; phase: 'waiting' | 'streaming' | 'quiet' | 'stalled'; bytesDown?: number; sinceLastByteMs?: number }>
  | E<'modelCall.retrying', { callKey: ModelCallKey; attempt: number; maxAttempts?: number; retryInMs?: number; errorHint?: string }>
  | E<'modelCall.ended', { callKey: ModelCallKey; outcome: 'ok' | 'error' | 'aborted' | 'refused' | 'unknown'; usage?: TokenUsage }>
  | E<'usage.limited', { limitName?: string; resetsAtWall?: WallMs; source: Source; autoContinue: UsageLimitState['autoContinue'] }>
  | E<'usage.wakeScheduled', { atWall: WallMs; attempt: number; jitterMs: number }>
  | E<'usage.cleared', { reason: 'turnStarted' | 'autoResumeFired' | 'wokeByLibrary' }>
  | E<'usage.info', { contextUsedPct?: number; rateLimits?: RateLimitWindow[] }>
  | E<'compaction', { phase: 'started' | 'ended'; trigger?: string }>
  | E<'claim.asserted' | 'claim.confirmed' | 'claim.retracted' | 'claim.expired', { claim: string; value: JsonValue }>
  | E<'channel.health', { channel: ChannelName; health: 'up' | 'degraded' | 'down' | 'off'; reason?: string }>
  | E<'interrupt.ignored', { reason: 'noEvidence' | 'notBusy' }>
  | E<'input.rejected', { job: InputJobKey; code: CcdErrorCode; reason: string }>
  | E<'config.changed', { source: string; filePath?: string }>
  | E<'security.alert', { code: 'E_SECURITY_UNEXPECTED_INPUT' | 'E_SECURITY_HOOK_FORGERY' | 'E_SECURITY_SETTINGS_TAMPERED' | 'E_INPUT_TAMPERED'; detail: JsonValue }>
  | E<'warning', { code: CcdErrorCode; message: string; detail?: JsonValue }>;

export type TurnOutcome = 'completed' | 'interrupted' | 'failed' | 'aborted' | 'notSubmitted' | 'withdrawn' | 'unknown';
export type TurnEndedBy = 'stop' | 'stop_failure' | 'interrupt' | 'tool_use_interrupt' | 'withdrawn' | 'turn_duration'
                        | 'session_end' | 'process_exit' | 'submit_failed' | 'library_abort' | 'merged';
export type ToolOutcomeFrom = 'post' | 'post_failure' | 'batch' | 'transcript' | 'permission_deny' | 'closing_rule';
export interface ResponseRef { bytes: number; sha256_16: string; preview: string /* ≤ 4 KiB, redaction applied by facade */; truncated: boolean }

// ---- rev2 (§10 B2): internal events. They change `domain` but are never published. ----
export type InternalEvent =
  | { type: 'x.fact'; path: string; fact: Fact<JsonValue> }                 // corroboration, provisional→confirmed, conflict replacement
  | { type: 'x.provenance'; entity: string; provenance: EntityProvenance }  // sources/lastSeq growth
  | { type: 'x.inputBlocked'; value: SessionState['inputBlocked'] }
  | { type: 'x.lifecycle'; phase: LifecyclePhase }
  | { type: 'x.patch'; entity: string; patch: JsonValue };                  // any other field change not carried by a DomainEvent (must name its reason in a diagnostic code)
export type CoreEvent = DomainEvent | InternalEvent;
```

Rules: events are past-tense facts; additive only (breaking change = new `type`); `replayed:true` events from `meta.replay` observations are suppressed by the facade unless asked (`fromSeq:0`) (AL P22). `decide/*` returns `CoreEvent[]`; `step` applies them through `evolve` and publishes only the `DomainEvent` subset.

### 2.6 `model/state.ts` (internal, never public), `model/commands.ts`, `model/intents.ts`, `model/config.ts`

`SessionState` is **internal** (rev2 §10 E2): the public facade exposes its own `SessionSnapshot` (§2.12), and the `.d.ts` leak grep includes `Fact<` and `SessionState`.

```ts
// ---------- state.ts ----------
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export interface Fact<T> { value: T; src: Source; seq: ObsSeq; at: MonoMs; corroborated: Source[]; provisional: boolean; expiresAt?: MonoMs }
export interface EntityProvenance { sources: Source[]; confirmed: boolean; firstSeq: ObsSeq; lastSeq: ObsSeq }

export type LifecyclePhase = 'preflight' | 'launching' | 'awaitingReady' | 'gated' | 'selfTest' | 'ready' | 'closing' | 'exited';
export type TurnState = 'queued' | 'submitting' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted'
                      | 'withdrawn' | 'notSubmitted' | 'aborted' | 'unknown';           // rev2: no 'absorbed'
export type ToolState = 'proposed' | 'pending' | 'awaitingPermission' | 'running' | 'launched'
                      | 'succeeded' | 'failed' | 'denied' | 'interrupted' | 'unknown';  // rev2: no 'cancelled'
export type PermState = 'pending' | 'answered' | 'dialogOnly' | 'resolved' | 'abandoned';
export type AgentState = 'running' | 'stopped' | 'unknown';
export type CallState = 'started' | 'waiting' | 'streaming' | 'retrying' | 'stalled' | 'ended' | 'aborted' | 'failed' | 'refused' | 'unknown';

export interface Generation { key: GenKey; sessionId: string; transcriptPath?: string; status: 'implicit' | 'active' | 'ended';
  startedBy: 'SessionStart' | 'implicit' | 'launch'; source?: string; endReason?: string; startedAt: MonoMs }

export interface TurnRecord {
  key: TurnKey; gen?: GenKey; promptId?: string; prompt: string; origin: Fact<PromptOrigin>; clientRef?: string;
  state: Fact<TurnState>; endedBy?: TurnEndedBy; error?: CcdErrorData; job?: InputJobKey;
  causedBy?: { agent?: AgentKey; tool?: ToolKey; taskId?: string };
  mergedInto?: TurnKey;                       // rev2: Claude queued our prompt into this running turn (race only, §4.4)
  refused?: { refusedMessageId: string; fallbackModel?: string };
  finalText?: Fact<string>; truncated?: boolean; durationMs?: number;
  backgroundPending: string[]; tools: ToolKey[]; messages: MsgKey[]; calls: ModelCallKey[];
  queuedAt: MonoMs; acceptedAt?: MonoMs; endedAt?: MonoMs; provenance: EntityProvenance;
}
export interface ToolRun {
  key: ToolKey; toolUseId?: string; name: string; input: unknown; turn?: TurnKey; agent?: AgentKey;
  promptIdAtPre?: string; preSeq?: ObsSeq; preAt?: MonoMs; state: Fact<ToolState>; outcomeFrom?: ToolOutcomeFrom;
  responseRef?: ResponseRef; error?: string; durationMs?: number; permission?: PermissionKey; spawned?: AgentKey;
  apiMessageId?: string; blockIndex?: number; startedAt: MonoMs; endedAt?: MonoMs; provenance: EntityProvenance;
}
export interface PermissionBinding { kind: 'unique' | 'ambiguous-equivalent' | 'ambiguous-agents' | 'unbound' | 'screen-only'; confirmed: boolean }
export interface PermissionRecord {
  key: PermissionKey; hookSeq?: HookSeq; toolName: string; input: unknown; suggestions: unknown[]; tool?: ToolKey; agent?: AgentKey;
  binding: PermissionBinding; state: Fact<PermState>; autoAnswerAllowed: boolean;
  needs: 'decision' | 'answers' | 'planApproval';             // rev2: AskUserQuestion → answers, ExitPlanMode → planApproval
  paths?: { state: 'pending' | 'resolved'; allInside?: boolean; detail?: ResolvedPath[] };   // rev2: allowRead evidence from L3 (§3.7)
  ourAnswer?: { decision: 'allow' | 'deny'; by: 'host' | 'handler' | 'policy' | 'timeout' | 'close'; via: 'hook' | 'keys'; seq: ObsSeq };
  resolved?: { decision: 'allow' | 'deny'; decider: PermissionDecider; overridden: boolean };
  requestedAt: MonoMs; suspect: boolean;           // screen-only dialog with no matching hook/PreToolUse within 2 s (SEC §4.6)
  adopted: boolean;                                // rev2: created from a screen dialog with no hook record (§4.6)
  provenance: EntityProvenance;
}
export interface AgentRecord {
  key: AgentKey; agentId: string; agentType: string; kind: 'subagent' | 'internal' | 'teammate' | 'unknown'; background: boolean;
  gen?: GenKey;                                    // generation it was launched in; never closed by a generation end (closing rule 3)
  spawnTool?: ToolKey; spawnLinkConfirmed: boolean; parent?: AgentKey; depth: number; state: Fact<AgentState>; runs: number;
  transcriptPath?: string; fileMissing: boolean; lastAssistantMessage?: string; notifications: TurnKey[];
  startedAt: MonoMs; endedAt?: MonoMs; provenance: EntityProvenance;
}
export interface ModelCall { key: ModelCallKey; turn?: TurnKey; agent?: AgentKey; requestRefs: string[]; digest?: string; attempts: number;
  state: Fact<CallState>; tunnelId?: number; lastDownAt?: MonoMs; bytesDown: number;
  retry?: { attempt: number; max?: number; retryInMs?: number; errorHint?: string }; usage?: TokenUsage; startedAt: MonoMs; endedAt?: MonoMs }
export interface MessageRecord { key: MsgKey; turn?: TurnKey; agent?: AgentKey; apiMessageId?: string; uiMessageId?: string; uuids: string[];
  text: string; final: boolean; finalBy?: 'flag' | 'implicit'; confirmed: boolean; retracted: boolean; blocks: number; usageCounted: boolean }
export interface BackgroundTask { id: string; type: string; status: string; toolUseId?: string; agent?: AgentKey; gen?: GenKey; updatedAt: MonoMs }
export interface PendingInput { key: string; kind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput' | 'unknownModal'; message?: string; since: MonoMs; src: Source }
export interface UsageLimitState {
  state: 'limited' | 'waking' | 'cleared'; limitName?: string; rateLimitType?: string; resetsAtWall?: WallMs; source: Source;
  autoContinue: 'armed' | 'stale' | 'cancelled' | 'disabled' | 'none'; interruptedTurn?: TurnKey; rearms: number;
  nextWakeAtWall?: WallMs; jitterMs?: number;      // rev2: jitter = deterministic function of (sessionKey, resetsAtWall, rearms) (§3.9)
}
export type AgentStatus =
  | { kind: 'starting'; phase: 'launching' | 'gated' | 'waitingForSessionStart' | 'selfTest'; gate?: StartupGateKind; since: MonoMs }
  | { kind: 'idle'; since: MonoMs; backgroundAgents: number; queued: number; quiescent: boolean;
      lastTurn?: { outcome: TurnOutcome; error?: CcdErrorData } }                       // rev2: apiError is an attribute, not a status (§10 A8)
  | { kind: 'modelRequest'; phase: 'waiting' | 'streaming' | 'retrying' | 'stalled'; since: MonoMs; attempt?: number; maxAttempts?: number; retryInMs?: number; provenance: Provenance }
  | { kind: 'writing'; since: MonoMs; provenance: Provenance }
  | { kind: 'runningTools'; tools: ToolKey[]; since: MonoMs; provenance: Provenance }
  | { kind: 'awaitingPermission'; permission: PermissionKey; since: MonoMs }
  | { kind: 'awaitingInput'; request: string; inputKind: PendingInput['kind']; message?: string; since: MonoMs }   // rev2: MCP elicitation / unknown modal
  | { kind: 'interrupted'; since: MonoMs; provenance: Provenance }
  | { kind: 'compacting'; since: MonoMs }
  | { kind: 'usageLimited'; since: MonoMs; resetsAtWall?: WallMs; autoResume: boolean; nextWakeAtWall?: WallMs }
  | { kind: 'authRequired'; since: MonoMs; message: string }
  | { kind: 'exited'; since: MonoMs; exitStatus: number | null; signal: string | null };

export interface SessionState {
  v: 1; sessionKey: SessionKey; lifecycle: LifecyclePhase; gate?: { kind: StartupGateKind; text: string };
  claude: { version: string; pid?: number; paneId?: string; currentGen?: GenKey; sessionId?: string; transcriptPath?: string;
            model?: Fact<string>; permissionMode?: Fact<PermissionMode> };
  generations: Readonly<Record<GenKey, Generation>>;
  status: AgentStatus;                       // cache of deriveStatus(state); recomputed every step; never set by decide/*
  turns: Readonly<Record<TurnKey, TurnRecord>>; turnOrder: TurnKey[]; activeTurn?: TurnKey; libraryQueue: TurnKey[];
  tools: Readonly<Record<ToolKey, ToolRun>>; agents: Readonly<Record<AgentKey, AgentRecord>>;
  permissions: Readonly<Record<PermissionKey, PermissionRecord>>; calls: Readonly<Record<ModelCallKey, ModelCall>>;
  messages: Readonly<Record<MsgKey, MessageRecord>>; bgTasks: Readonly<Record<string, BackgroundTask>>;
  pendingInputs: Readonly<Record<string, PendingInput>>;                       // rev2
  usage: { limit?: UsageLimitState; contextUsedPct?: number; rateLimits?: RateLimitWindow[]; tokensTotal: TokenUsage };
  auth: { state: 'ok' | 'required'; message?: string; since?: MonoMs; polling: boolean };
  compacting?: { trigger?: string; since: MonoMs };
  channels: Readonly<Record<ChannelName, { health: 'up' | 'degraded' | 'down' | 'off'; reasons: string[] }>>;   // rev2: reasons are cleared individually (§10 A9)
  inputBlocked: { permission: boolean; dialog: boolean; startup: boolean; copyMode: boolean; input: boolean };   // input = pendingInputs non-empty
  selfTest: { state: 'idle' | 'armed' | 'passed' | 'failed' | 'cached' | 'skipped'; nonce?: string };
  exit?: { exitStatus: number | null; signal: string | null; reason: string };
  lastEventSeq: EventSeq;
}

// ---------- commands.ts ----------
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message?: string; interrupt?: boolean };
export type PermissionUpdate =
  | { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: { toolName: string; ruleContent?: string }[]; behavior: 'allow' | 'deny' | 'ask'; destination: 'session' }
  | { type: 'setMode'; mode: 'default' | 'acceptEdits' | 'plan'; destination: 'session' };   // dangerous modes only with allowDangerousModes
export type Command =
  | { type: 'prompt.send'; text: string; clientRef?: string; whenBusy: 'wait' | 'reject' }
  | { type: 'prompt.cancel'; turnKey: TurnKey }                       // only while still in libraryQueue
  | { type: 'slash.run'; name: string; args?: string; unsafe?: boolean }
  | { type: 'interrupt'; clientRef?: string }
  | { type: 'permission.answer'; permissionKey: PermissionKey; decision: PermissionDecision; by: 'host' | 'handler' | 'policy' }
  | { type: 'permission.answerQuestion'; permissionKey: PermissionKey; answers: Record<string, string> }                 // AskUserQuestion
  | { type: 'permission.approvePlan'; permissionKey: PermissionKey; approve: boolean; mode?: 'default' | 'acceptEdits'; feedback?: string }   // ExitPlanMode (rev2)
  | { type: 'mode.set'; mode: PermissionMode }
  | { type: 'usage.wakeNow' }                                         // rev2: host-requested immediate wake check (the timer path is a core deadline)
  | { type: 'selftest.run'; nonce: string; cachedPass: boolean }     // rev2: nonce minted by L3 (ids port); cachedPass → skip with selfTest 'cached'
  | { type: 'net.fault'; spec: FaultSpec | null }
  | { type: 'session.close'; mode: 'graceful' | 'kill'; graceMs: number; reason: string; waitForBackgroundMs?: number };
export type CommandResult<C extends Command> =
  C extends { type: 'prompt.send' } ? { turnKey: TurnKey } :
  C extends { type: 'interrupt' } ? { turnKey?: TurnKey } :
  C extends { type: 'slash.run' } ? { ok: true; effect: 'evidence' | 'modal' | 'none'; output?: string /* modal text, ≤ 16 KiB, normalized, redacted */ } :
  { ok: true };
export type FaultSpec = { mode: 'refuse' } | { mode: 'blackhole' } | { mode: 'reset'; afterDownBytes: number } | { mode: 'stall'; afterDownBytes: number } | { mode: 'slow'; bytesPerSec: number };

// ---------- intents.ts ----------
export type TmuxKeyName = 'Enter' | 'Escape' | 'BTab' | 'Up' | 'Down' | 'C-g'
                        | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
// Closed list. Up/Down only inside an allow-listed dialog job (resume dialog), digits only for screenAllow permission keys.
// NEVER: Tab, Right, Left, C-c, C-u, C-s, C-y, C-l, C-d, C-z, C-b, S-Enter, M-*, PageUp/Down (IN §12, PA I9, TUI §8.7, LC rule 5)
export type InputPrimitive =
  | { kind: 'editorStage'; text: string }            // write staged file + arm nonce (L0 EditorInjector)
  | { kind: 'key'; key: TmuxKeyName; gapAfterMs: number }
  | { kind: 'pasteChunk'; text: string; bracketed: true }   // ≤ 400 bytes, ≤ 2 LF, sanitized
  | { kind: 'typeLiteral'; text: string }            // ≤ 200 bytes, single line, slash command fallback only
  | { kind: 'awaitEditorConsumed'; timeoutMs: number }
  | { kind: 'captureText'; rows: 'modal' }           // rev2: returns normalized modal text in input.done.output (slash.run modal output)
  | { kind: 'exitCopyMode' };
export type Intent =
  | { kind: 'input'; id: IntentId; job: InputJobKey; step: number; primitive: InputPrimitive }
  | { kind: 'screen.captureNow'; id: IntentId; reason: string }
  | { kind: 'poll.cadence'; id: IntentId; channel: 'screen'; intervalMs: number | null }
  | { kind: 'auth.poll'; id: IntentId; intervalMs: number | null }                                  // rev2: L3 runs `claude auth status --json`, reports auth.status
  | { kind: 'hook.respond'; id: IntentId; hookSeq: HookSeq; body: PermissionResponseBody | null }   // null = empty reply (no decision → dialog)
  | { kind: 'hook.armSelfTest'; id: IntentId; nonce: string }                                       // rev2
  | { kind: 'hook.disarmSelfTest'; id: IntentId }                                                   // rev2
  | { kind: 'host.askPermission'; id: IntentId; permissionKey: PermissionKey; deadlineAt: MonoMs }  // broker runs handler / emits to host; the timeout itself is core deadline `permissionPolicy`
  | { kind: 'host.cancelAsk'; id: IntentId; permissionKey: PermissionKey; reason: string }          // rev2: aborts the handler's AbortSignal
  | { kind: 'permission.resolvePaths'; id: IntentId; permissionKey: PermissionKey; toolName: string; input: unknown }   // rev2 (§3.7)
  | { kind: 'tail.followMain'; id: IntentId; sessionId: string; path: string; startAt: 'beginning' | 'end' }
  | { kind: 'tail.observePath'; id: IntentId; sessionId: string; path: string; source: string }
  | { kind: 'tail.expectSubagent'; id: IntentId; sessionId: string; agentId: string }
  | { kind: 'tail.subagentStopped'; id: IntentId; sessionId: string; agentId: string; path?: string }
  | { kind: 'tail.poke'; id: IntentId; reason: string }
  | { kind: 'registry.persist'; id: IntentId; patch: RegistryPatch }
  | { kind: 'net.fault'; id: IntentId; spec: FaultSpec | null }
  | { kind: 'process.signal'; id: IntentId; signal: 'SIGTERM' | 'SIGKILL' }
  | { kind: 'lifecycle.finalize'; id: IntentId; reason: string };
export type PermissionResponseBody = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: PermissionDecision } };
export interface RegistryPatch { claudeSessionId?: string; transcriptPath?: string; state?: AgentStatus['kind']; usageLimit?: UsageLimitState | null; lastEventSeq?: number }

// ---------- config.ts ----------
export interface CoreConfig {   // part of CoreInit; recorded in the trace header so replay is exact
  timeouts: { submitAckMs: number; submitAckFirstExtraMs: number; submitRetries: number; settleMs: number; escGapMs: number; keyGapMs: number;
              dialogSettleMs: number /* 150 */; interruptConfirmMs: number; stopGraceMs: number; transcriptSettleMs: number; permBindLateMs: number;
              hookGapMs: number; stallMs: number; quietMs: number; genImplicitConfirmMs: number; interruptedHoldMs: number;
              drainMs: number; startupHookGraceMs: number /* 3000, the only startup grace */; startupMs: number; readyStableMs: number; lateTextMs: number; editorConsumeMs: number;
              claimTtlMs: number; claimMinStableMs: number /* 100 */; claimDialogStableMs: number /* 250 */; hostResumeGraceMs: number;
              adoptDialogMs: number /* 500 */; usageWakeCheckMs: number /* 30000: wall re-check interval */; authPollMs: number /* 60000 */ };
  permissions: { policy: 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll' | 'handler'; timeoutMs: number; onTimeout: 'deny' | 'tui';
                 screenAllow: boolean; allowDangerousModes: boolean; allowAddDirectories: boolean; backgroundTimeoutMs: number /* 10000 */ };
  input: { method: 'editor' | 'pasteChunks'; chunkBytes: number; chunkGapMs: number; maxPromptBytes: number; mentions: 'allow' | 'reject'; whenBusyDefault: 'wait' | 'reject' };
  security: { onTamper: 'alert' | 'interrupt' };
  usage: { autoResume: boolean; resumePrompt: string; jitterMinMs: number /* 30000 */; jitterMaxMs: number /* 90000 */; maxRearms: number; builtinAutoContinue: boolean };
  commands: { allow: string[]; deny: string[]; refuseAlways: string[]; aliases: Readonly<Record<string, string>> };   // aliases from the profile
  channels: { screen: { busyPollMs: number; idlePollMs: number; retryPollMs: number; startupPollMs: number }; network: boolean; messageDisplay: boolean; preToolUse: boolean };
  selfTest: 'once' | 'always' | 'off';
}
export interface ResolvedConfig {   // built by session/config.ts from SessionSpec (§2.11); internal
  sessionKey: SessionKey; cwd: string; cwdRealpath: string; claudeSessionId: string; resume?: string; model?: string; effort?: string;
  permissionMode: PermissionMode; extraArgs: string[];   // already allowlist-validated (§3.3)
  claude: { bin?: string; expectVersion: string | 'any'; configDir: string /* respects inherited CLAUDE_CONFIG_DIR, never introduces one */ };
  env: { inherit: 'minimal' | 'all' | string[]; set: Record<string, string>; scrubSubprocessEnv: boolean };
  tmux: { bin?: string; cols: number; rows: number; historyLimit: number };
  hooks: { transport: 'auto' | 'http' | 'unix'; overrideDisableAllHooks: boolean; postToolBatch: boolean; permissionHookTimeoutS: number; observationTimeoutS: number; messageDisplayTimeoutS: number };
  trust: { mode: 'require' | 'seed'; acceptRisks: boolean };
  network: false | { faults: boolean; allowPrivate: boolean; allowPorts: number[] };
  security: { denyTmuxInBash: boolean; crossSessionInbound: 'accept' | 'hold' | 'refuse'; mcp: 'inherit' | 'strict'; onTamper: 'alert' | 'interrupt' };
  lifecycle: { closeGraceMs: number; killAfterMs: number; heartbeatMs: number; stateDir: string; runtimeRoot: string; ownerWatchPollMs: number /* 1000 */ };
  debug: { tracePath?: string; raw: 'none' | 'meta' | 'full'; retainEvents: number; claudeDebugFile: boolean; keepClaudeDebugFile: boolean;
           dumpDir?: string /* screen dumps only here, 0700 (P-SEC-42) */; captureLimitFixtures: boolean /* true (§3.9) */ };
  core: CoreConfig;
}
```

### 2.7 L0 ports (`src/platform/ports.ts`, types only)

```ts
export interface Ports {
  clock: Clock; ids: IdPort; process: ProcessPort; env: EnvPort; claude: ClaudeBinaryPort;
  runtimeDir: RuntimeDirPort; state: StateStorePort; settingsFile: SettingsFilePort; claudeConfig: ClaudeConfigPort;
  tmux: TmuxServerFactory; tail: TranscriptTailFactory; hooks: HookTransportFactory; editor: EditorInjectorFactory;
  net?: NetProxyFactory; registry: ClaudeRegistryReader; ownerWatch: OwnerWatchFactory; logger: Logger;
}

// ---- 2.7.1 process / env / ids / claude binary ----
export interface IdPort { uuidV4(): string; tokenHex(bytes: number): string /* lowercase hex only (no '$', SEC §2.2) */; shortHex(n: number): string }
export interface ExecResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }
export interface ProcessPort {
  which(bin: string, extraDirs: readonly string[]): Promise<string | undefined>;
  exec(file: string, args: readonly string[], o: { env: Readonly<Record<string, string>>; cwd?: string; timeoutMs: number; stdin?: string | Uint8Array; killOnTimeout: boolean }): Promise<ExecResult>;
  execSyncBestEffort(file: string, args: readonly string[], env: Readonly<Record<string, string>>): void;  // process.on('exit') only
  spawnDetached(file: string, args: readonly string[], o: { env: Readonly<Record<string, string>>; logPath: string; cwd?: string }): Promise<{ pid: number }>;
  isAlive(pid: number): boolean;                    // kill(pid, 0)
  kill(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 'SIGHUP' | 'SIGUSR2'): boolean;
  identity(pid: number): Promise<{ startTime: string; command: string } | undefined>;   // ps -o lstart=,command= -p <pid>
}
export interface EnvPort { snapshot(): Readonly<Record<string, string>>; homeDir(): string; userName(): string; uid(): number;
  platform(): 'darwin' | 'linux' | 'other'; tmpDir(): string; execPath(): string; nodeVersion(): string; realpath(p: string): Promise<string>;
  lstat(p: string): Promise<{ isSymlink: boolean; isFile: boolean; isDir: boolean } | undefined>;   // rev2: path resolver (§3.7)
  timeZone(): string }                                                                                // rev2: Intl resolved zone, recorded in the trace header
export interface ClaudeBinaryPort {
  resolve(option?: string): Promise<{ exe: string; via: 'option' | 'consumer' | 'package' | 'path' } | undefined>;  // prefers .../bin/claude.exe over the sh shim
  version(exe: string, env: Readonly<Record<string, string>>): Promise<string>;                                     // parses '2.1.316 (Claude Code)'
  authStatus(exe: string, env: Readonly<Record<string, string>>): Promise<{ loggedIn: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string }>;  // 10 s, killOnTimeout:false; apiProvider VERIFIED-CMD LC §1.3
}
export interface OwnerWatchFactory {      // rev2 (D-28): node:* standalone, spawned detached, one per session
  start(o: { configPath: string /* 0600 watch.json: {ownerPid, ownerStart, claudePid, claudeStart, claudeExeSubstr, sessionIdSubstr, tmuxBin, socketName, pollMs, exitsLog} */;
             logPath: string }): Promise<{ pid: number; stop(): Promise<void> }>;   // stop = SIGTERM to the watcher (normal close)
}

// ---- 2.7.2 runtime dir / state / settings / claude config ----
export interface RuntimeDirPort {
  ensureRoot(): Promise<string>;                          // lstat: dir, !symlink, uid===getuid, (mode & 0o077)===0; else E_UNSAFE_RUNTIME_DIR
  createSessionDir(): Promise<string>;                    // mkdtemp(root/ccd-) → 0700; asserts Buffer.byteLength(sessionDir+'/net.sock') ≤ 100 (longest socket name used; macOS limit 104) else SocketPathTooLong
  removeSessionDir(path: string): Promise<void>;
  sweepStale(known: ReadonlyArray<{ path: string; ownerAlive: boolean }>): Promise<string[]>;   // rev2: only dirs named by a registry entry (live or archived) are ever removed
}
export interface StateStorePort {
  readonly root: string;                                  // 0700, same lstat checks
  writeJsonAtomic(rel: string, v: unknown): Promise<void>;// tmp in same dir, mode 0600, fsync, rename
  readJson<T>(rel: string): Promise<T | undefined>;
  list(relDir: string): Promise<string[]>;
  remove(rel: string): Promise<void>;
  appendLine(rel: string, line: string): Promise<void>;
  withLock<T>(name: string, fn: () => Promise<T>, o: { staleMs: number }): Promise<T>;   // O_EXCL lockfile with pid; stale if pid dead or older than staleMs
}
export interface SettingsFilePort { writeExclusive(path: string, json: unknown): Promise<{ sha256: string; bytes: number }>; matches(path: string, sha256: string): Promise<boolean> }
export interface SettingsLayers {
  user?: unknown; project?: unknown; local?: unknown; keybindings?: unknown;      // parsed leniently; managed is unreadable here
  disableAllHooksTrueIn: Array<'user' | 'project' | 'local'>; allowedHttpHookUrlsDefinedIn: Array<'user' | 'project' | 'local'>;
  editorMode?: string; statusLineDefined: boolean; parseErrors: string[];
}
export interface WorkspaceRisk { empty: boolean; items: Array<{ file: string; kind: 'hooks' | 'permissions.allow' | 'env' | 'apiKeyHelper' | 'statusLine' | 'otelHeadersHelper' | 'additionalDirectories' | 'mcpServers' | 'enableAllProjectMcpServers'; detail: string }> }
export interface ClaudeConfigPort {
  readGlobal(): Promise<{ ok: true; hasCompletedOnboarding: boolean } | { ok: false; reason: 'missing' | 'invalidJson' }>;
  trustOf(realCwd: string): Promise<{ trusted: boolean; viaPath?: string }>;     // cwd or any ancestor up to git root (rootOnly respected)
  seedTrust(realCwd: string): Promise<{ added: boolean }>;  // fresh read → set ONLY projects[realCwd].hasTrustDialogAccepted=true → tmp+rename, original mode preserved
  unseedTrust(realCwd: string): Promise<void>;              // removes only that key; never the project entry
  readLayers(realCwd: string): Promise<SettingsLayers>;
  inspectWorkspace(realCwd: string): Promise<WorkspaceRisk>;
}

// ---- 2.7.3 tmux ----
export type PaneId = `%${number}`;
export interface TmuxServerFactory {
  probe(tmuxPath?: string): Promise<{ path: string; version: string }>;           // ENOENT → TmuxNotFound; version < 3.2 → TmuxVersionUnsupported
  create(o: { tmuxPath: string; socketName: string; clientEnv: Readonly<Record<string, string>>; historyLimit: number; paneDiedLogPath: string }): Promise<TmuxServer>;
  // rev2: no attach(), no control mode (§10 C1/G1)
}
export interface PaneSpawnOptions { sessionName: string; argv: readonly [string, string, ...string[]]; cwd: string; cols: number; rows: number; nonSecretEnv: Readonly<Record<string, string>> }
export interface PaneInfo { paneId: PaneId; sessionId: string; windowId: string; pid: number; cols: number; rows: number }
export interface PaneStatus { exists: boolean; dead: boolean; exitStatus: number | null; exitSignal: string | null; inMode: boolean; alternateOn: boolean;
  cursorX: number; cursorY: number; cols: number; rows: number; historySize: number }
export interface Capture { lines: string[]; status: PaneStatus; at: MonoMs; hash: string }
export interface TmuxServer {
  readonly socketName: string; readonly socketPath: string; readonly version: string; readonly tmuxPath: string;
  spawnPane(o: PaneSpawnOptions): Promise<TmuxPane>;
  kill(): Promise<void>;                                   // kill-server, wait socket gone (≤1 s), unlink socket file
  killSync(): void;                                        // exit handler
  onGone(fn: () => void): Cancel;
}
export interface TmuxPane {
  readonly info: PaneInfo;
  paste(text: string): Promise<void>;                      // load-buffer -b ccd-<pane>-<n> - (stdin) ; paste-buffer -t %N -b … -d -p -r ; never Enter
  typeLiteral(text: string): Promise<void>;                // send-keys -t %N -l -- escapeArg(text); ≤ 8 KiB; no secrets
  sendKey(k: TmuxKeyName): Promise<void>;                  // one key per invocation; never batched
  capture(o?: { styles?: boolean; startRow?: number; endRow?: number }): Promise<Capture>;   // display + capture-pane -p -N in one batch; never -J; never -S -
  status(): Promise<PaneStatus>;                           // cached ≤ 100 ms (adapter timer A-2, §4.12); checked before every input
  exitCopyMode(): Promise<void>;                           // send-keys -X cancel (only if inMode)
  killPane(): Promise<void>;
  on(e: 'died', fn: (s: { exitStatus: number | null; exitSignal: string | null }) => void): Cancel;
  on(e: 'gone', fn: () => void): Cancel;
  viewCommand(): string;                                   // `tmux -L <sock> attach -r -t =<session>:` (read-only view for humans)
}

// ---- 2.7.4 transcript tail (TT §13, adopted verbatim with these types) ----
export type FileKey = { kind: 'main'; sessionId: string } | { kind: 'subagent'; sessionId: string; agentId: string };
export interface TailLine { file: FileKey; generation: number; offset: number; bytes: number; type: string | undefined; json: unknown | undefined;
  replay: boolean; afterRewrite: boolean; readAtMono: MonoMs; readAtWall: WallMs }
export type TailEvent =
  | { kind: 'line'; line: TailLine }
  | { kind: 'waiting'; file: FileKey; path: string; reason: 'ENOENT' | 'EACCES' | 'ENOTDIR' }
  | { kind: 'opened'; file: FileKey; path: string; dev: number; ino: number; size: number; startOffset: number }
  | { kind: 'moved'; file: FileKey; from: string; to: string; sameInode: boolean }
  | { kind: 'rewrite'; file: FileKey; reason: 'truncated' | 'replaced' | 'rewritten'; oldSize: number; newSize: number; generation: number }
  | { kind: 'resynced'; file: FileKey; fullRescan: boolean; generation: number }
  | { kind: 'malformed'; file: FileKey; offset: number; bytes: number; reason: 'json' | 'not-object'; preview: string }
  | { kind: 'oversize'; file: FileKey; offset: number; bytes: number }
  | { kind: 'torn-tail'; file: FileKey; offset: number; bytes: number }
  | { kind: 'missing'; file: FileKey; waitedMs: number }
  | { kind: 'state'; file: FileKey; state: 'waiting' | 'active' | 'draining' | 'dormant' | 'closed' }
  | { kind: 'error'; file?: FileKey; message: string; fatal: boolean };
export interface TailCheckpoint { files: Array<{ key: FileKey; path: string; dev: number; ino: number; offset: number; generation: number }> }   // diagnostic only in v1 (no attach)
export interface TranscriptTail {
  followMain(sessionId: string, path: string, o?: { startAt?: 'beginning' | 'end' | { checkpoint: TailCheckpoint } }): void;
  observePath(sessionId: string, path: string, source: string): void;
  expectSubagent(sessionId: string, agentId: string): void;
  subagentStopped(sessionId: string, agentId: string, path?: string): void;
  poke(reason?: string): void;
  on(l: (e: TailEvent) => void): Cancel;
  checkpoint(): TailCheckpoint;
  close(): Promise<void>;
}
export interface TranscriptTailFactory { create(o: { configDir: string; clock: Clock; pollIdleMs: number /* 250 */; pollFastMs: number /* 50 */; fastBurstMs: number; drainGraceMs: number;
  missingAgentTimeoutMs: number; maxLineBytes: number; readChunkBytes: number; maxActiveFollowers: number;
  skipParseTypes: ReadonlySet<string> }): TranscriptTail }
// rev2 (§10 C3): poll + pread only. Each poll: fstat; if (dev,ino) changed or size < offset → emit `rewrite` and re-read the file from 0
// with `replay:true, afterRewrite:true`; the core drops already-seen uuids (D-42). No fingerprint ring, no fs.watch, no EXDEV special case.

// ---- 2.7.5 hooks ----
export interface HookEndpoint {
  transport: 'http' | 'unix';                      // rev2: 'unix' = every event through the forwarder (§3.5)
  http?: { port: number; urlBase: string /* http://127.0.0.1:<port>/h/<sid>/ */; token: string /* 64 hex */ };
  unix: { socketPath: string; forwarderConfigPath: string /* fwd.json 0600: {socketPath, token} */ };
  forwarder: { nodePath: string /* process.execPath */; scriptPath: string /* dist/platform/hook-server/standalone/forward.js */ };
}
export interface RawHookEvent {
  hookSeq: HookSeq; at: MonoMs; wallAt: WallMs; transport: 'http' | 'unix'; event: string; bytes: number; truncated: boolean;
  payload: unknown;                                // parsed JSON (untrusted)
  holdable: boolean;                               // true only for PermissionRequest over unix
  closed?: Promise<'client_gone' | 'timeout'>;     // resolves when the forwarder connection closes before we answered
}
export interface HookTransport {
  start(o: { sessionShortId: string; transport: 'http' | 'unix' }): Promise<HookEndpoint>;   // spawns the worker (hook-server/worker.ts); rev2: no reuse/attach
  on(l: (e: RawHookEvent) => void): Cancel;
  respond(hookSeq: HookSeq, body: object | null): boolean;   // once; later calls no-op → false
  armSelfTestNonce(nonce: string | null): Promise<void>;      // resolves once the worker acked; UPS endpoint (HTTP or unix) returns the constant block body for exactly this prompt
  close(heldBody: object | null): Promise<void>;               // answers every held request with heldBody, stops listening, unlinks socket
  stats(): { received: number; dropped: number; truncated: number; authFailures: number; held: number; workerRestarts: number };
}
export interface HookTransportFactory { create(o: { runtimeDir: string; clock: Clock; ids: IdPort; maxBodyBytes: number /* 32 MiB */; maxHeld: number; maxConnections: number; logger: Logger }): HookTransport }

// ---- 2.7.6 editor injection ----
export interface EditorInjector {
  setup(sessionDir: string, nodePath: string): Promise<{ visualPath: string }>;  // writes 0700 sh wrapper: exec '<node>' '<editor.js>' '<arm.json>' "$@"
  stage(text: string): Promise<{ nonce: string }>;   // writes staged.txt 0600 + arm.json {nonce, stagedPath, expiresAtWall}
  consumed(nonce: string, timeoutMs: number): Promise<boolean>;   // editor.js writes done-<nonce> after copying
  disarm(): Promise<void>;
}
export interface EditorInjectorFactory { create(o: { clock: Clock; ids: IdPort }): EditorInjector }

// ---- 2.7.7 network proxy ----
export interface TunnelRecord { tunnelId: number; at: MonoMs; wallAt: WallMs; token: 'A' | 'none' | 'bad'; host: string; port: number;
  sni?: string; alpn?: string[]; kind: 'open' | 'established' | 'up' | 'down' | 'close' | 'error' | 'refused';
  bytes?: number; records?: number; lastRecordLen?: number; closeKind?: 'fin' | 'rst' | 'error'; error?: string }
export interface NetProxy {
  readonly port: number; readonly pid: number;
  bindClaudePid(pid: number): Promise<void>;
  on(l: (r: TunnelRecord) => void): Cancel;
  setFault(spec: FaultSpec | null): Promise<void>;   // in-process control over 0700 unix socket with a control token
  stop(): Promise<void>;
}
export interface NetProxyFactory {
  start(o: { tokenA: string; controlSocketPath: string; controlToken: string; logPath: string; allowPrivate: boolean; allowPorts: number[]; denyPorts: number[] }): Promise<NetProxy>;
  // rev2 (§10 C2): no tokenB, upstream, plainHttp (absolute-form → 405), fixed port or attach
}

// ---- 2.7.8 Claude's own registry (read-only) ----
export interface ClaudeRegistryRecord { pid: number; sessionId?: string; version?: string; status?: string; waitingFor?: string; tmux?: string; procStart?: string }
export interface ClaudeRegistryReader {
  read(pid: number): Promise<ClaudeRegistryRecord | undefined>;
  scan(): Promise<ClaudeRegistryRecord[]>;       // rev2: every ~/.claude/sessions/*.json whose pid is alive (preflight resume-holder check, §3.1 step 7)
}
// lenient: first complete JSON object (#96438); never opens *.key files (#100824)
```

L0 error types (thrown, mapped to CcdError by `session/errors-map.ts`): `TmuxNotFound`, `TmuxVersionUnsupported{found,min}`, `TmuxServerGone`, `TmuxCrashed{stderr}` (`server exited unexpectedly`), `TmuxTargetMissing{target}` (`can't find pane|session`), `TmuxDuplicate`, `TmuxArgTooLong`, `TmuxPaneDead`, `TmuxCommandFailed{code,stderr}` (argv redacted), `HookWorkerDied`, `UnsafeRuntimeDir{path,reason}`, `SocketPathTooLong{bytes}`, `ClaudeNotFound`, `SettingsFileExists`.

**Fakes** (rev2 §10 B3.2): every port above has a fake in the same folder (`fake-*.ts`), owned by the WP that owns the real adapter, and the WP runs the shared contract suite `test/contract/<port>.contract.ts` against **both** in its own test file. `src/testing/fake-ports.ts` only aggregates them.

### 2.8 L1 channel interfaces

```ts
// channels/profiles/index.ts  (WP-00; never edited after Phase 0)
export interface ScreenStrings {
  spinnerGlyphs: string;                    // '·✢✳✶✻✽*●'
  statusRegexes: Readonly<Record<'spinner' | 'retrying' | 'retryingReset' | 'stalled' | 'noResponse' | 'lowPriority' | 'autoModeUnavailable'
                                 | 'done' | 'waitingBackground' | 'interrupted' | 'hookWait', RegExp>>;   // SP §13 verbatim; order = statusOrder
  statusOrder: readonly string[];
  footer: { escToInterrupt: RegExp; modeLabels: Readonly<Record<string, PermissionMode>>; pasting: RegExp; ctrlCExit: RegExp };
  composer: { promptGlyph: string /* '❯' */; ruleChar: string /* '─' */; notices: Readonly<Record<NonNullable<ScreenFacts['composer']>['notices'][number], RegExp>>;
              pastedPlaceholder: RegExp /* /\[Pasted text #\d+/ */ };
  dialogs: { permissionQuestion: RegExp; optionLine: RegExp; escFooter: RegExp; trustTitle: RegExp; resumeTitle: RegExp; usageMenu: RegExp;
             survey: RegExp; rewind: RegExp; elicitation?: RegExp; planApproval?: RegExp; question?: RegExp };   // optional entries are UNVERIFIED (LP-46/51)
  exited: RegExp; headerVersion: RegExp; agentPanelRow: RegExp; hookErrorLine: RegExp; apiErrorLine: RegExp; tipLine: RegExp;
}
export interface ClaudeProfile {
  version: '2.1.316';
  hooks: { observationEvents: readonly string[]; commandEvents: readonly ['SessionStart', 'PermissionRequest']; neverRegister: readonly string[] };
  transcript: { mergePolicy: Readonly<Record<string, 'transcript' | 'boundary-cleared' | 'accumulate' | 'last-wins'>>; skipParsePrefixes: readonly string[];
                markers: { interrupted: string; interruptedForToolUse: string; userRejectedToolResultPrefix: string; noResponseRequested: string; syntheticModel: '<synthetic>';
                           safetyClassifierStop: string /* 'Your response above was stopped by a safety classifier' */ };
                notRealUserText: RegExp /* ZHe */ };
  screen: ScreenStrings;
  errors: { usageLimitPrefixes: readonly string[]; limitNames: Readonly<Record<string, string>>; authLines: readonly RegExp[]; versionTooOld: RegExp;
            startupGates: Readonly<Record<StartupGateKind, readonly RegExp[]>>;
            parseResetText(text: string, wallAt: WallMs, tz: string): WallMs | undefined };   // rev2 (§3.9); tz comes from L3 (recorded in the trace header)
  commands: { aliases: Readonly<Record<string, string>> /* {'/quit':'/exit','/new':'/clear','/reset':'/clear'} VERIFIED-BIN */ };
}
export function selectProfile(version: string): ClaudeProfile | { unsupported: string };

// channels/hooks/normalize.ts
export interface HookNormalizeCtx { profile: ClaudeProfile }       // rev2: no expectedSessionIds (§10 A5)
export function normalizeHook(raw: RawHookEvent, ctx: HookNormalizeCtx): { observations: ObservationInput[]; rejected?: 'eventMismatch' | 'malformed' };

// channels/transcript/normalize.ts
export interface TranscriptNormalizer { push(e: TailEvent): ObservationInput[]; resetFile(fileKey: string): void }
export function createTranscriptNormalizer(profile: ClaudeProfile): TranscriptNormalizer;   // per-file state: current promptId

// channels/screen/*
export type StatusLine =                       // SP §14 verbatim, plus `reset` parsed text
 | { kind: 'spinner'; glyph: string; msg: string; elapsed?: string; tokens?: string; dir?: 'up'|'down';
     thinking?: string; thoughtForS?: number; hooks?: {event: string; done: number; total: number};
     tool?: {state: 'running'|'ran'; dur: string}; recovering?: boolean; unknown?: string[] }
 | { kind: 'retrying'; msg: string; truncated: boolean; retryIn: string; attempt: number; max: number; reset?: string }
 | { kind: 'retryingUnparsed'; raw: string }
 | { kind: 'stalled'; retryIn: string }
 | { kind: 'noResponse'; waited: string; upTo: string; attempt?: number; max?: number; final: boolean }
 | { kind: 'lowPriority' | 'autoModeUnavailable'; msg: string; nextTryIn: string; attempt: number; max?: number }
 | { kind: 'done'; verb: string; dur: string; doneAt?: string; rest?: string }
 | { kind: 'waitingBackground'; what: string }
 | { kind: 'interrupted'; question: boolean }
 | { kind: 'none'; raw: string };
export interface ScreenSnapshot {              // SP §14, extended (rev2: fully specified here)
  at: MonoMs; wallAt: WallMs; paneWidth: number; paneHeight: number; altScreen: boolean; inCopyMode: boolean; version?: string;
  kind: ScreenFacts['surface'];
  torn: boolean;                               // rule mismatch / footer missing → do not act
  status?: StatusLine;                         // only for kind 'main'
  footer?: { raw: string; mode: string | null; busy: boolean; hints: string[]; pasting: boolean; ctrlCExitArmed: boolean };
  input?: { text: string; placeholderLikely: boolean; pastedPlaceholder: boolean; notices: NonNullable<ScreenFacts['composer']>['notices'] };   // never authoritative
  dialog?: { kind: NonNullable<ScreenFacts['dialog']>['kind']; gate?: StartupGateKind; title?: string; question?: string;
             options: ScreenOption[]; footer?: string; body: string[] };
  usageLimitLine?: string; authLine?: string; apiErrorLine?: string; versionTooOld: boolean; interruptedBanner: boolean;
  hookErrorLines: number; agentPanelRows: number;
  decorations: { tip?: string; effort?: string };
  unknown: string[];                           // raw lines that drove an 'unknown*'/'none'
  frameHash: string;
}
export function classifyFrame(lines: readonly string[], status: PaneStatus, profile: ClaudeProfile): ScreenSnapshot;   // pure, never throws
export interface ScreenDebouncer { push(c: Capture, snap: ScreenSnapshot, tz: string): ScreenFacts | undefined }   // emits iff frameHash differs from the last emitted (D-41)
export function createScreenDebouncer(o: { frozenAfterMs: 3000; profile: ClaudeProfile }): ScreenDebouncer;          // to-facts conversion incl. parseResetText

// channels/network/*
export interface TunnelTracker { push(r: TunnelRecord): ObservationInput[] }          // only api.anthropic.com tunnels produce model-relevant phases
export function createTunnelTracker(o: { quietMs: number }): TunnelTracker;

// channels/registry/normalize.ts
export function normalizeRegistry(rec: Awaited<ReturnType<ClaudeRegistryReader['read']>>, at: MonoMs, wallAt: WallMs): ObservationInput[];
```
L1 rules: never throw (unparseable → `unknown` observation or a counted drop); never do I/O or timers; never filter by `session_id`; keep all version-specific strings in `profiles/claude-2.1.316/*`; the screen classifier never presses keys (SP rule 7). `Intl`/time-zone use is allowed **only** in `profiles/*/errors.ts parseResetText`, with `tz` passed in by L3 (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and recorded in the trace header, so replay goldens do not depend on the machine (§10 G27).

### 2.9 L2 core contract (`core/step.ts`, `core/init.ts`, `core/input-policy/jobs.ts`)

```ts
export interface CoreInit { sessionKey: SessionKey; config: CoreConfig; claudeVersion: string; initialClaudeSessionId: string; resume: boolean;
  startedAt: MonoMs; wallAt: WallMs; cwdRealpath: string /* for display only; never used for a containment decision (§3.7) */ }
export interface ReconState {             // private; never part of SessionState
  aliases: { sessionId: Record<string, GenKey>; promptId: Record<string, TurnKey>; toolUseId: Record<string, ToolKey>; agentId: Record<string, AgentKey>;
             apiMsgId: Record<string, MsgKey>; uiMsgId: Record<string, MsgKey>; requestRef: Record<string, ModelCallKey>; hookSeq: Record<number, PermissionKey>;
             entryUuid: Record<string, MsgKey> };
  redirects: Record<string, string>; claims: Record<string, Claim>; deadlines: Record<string, Deadline>;
  tunnels: Record<number, { phase: string; callKey?: ModelCallKey; lastDownAt?: MonoMs }>;
  seenUuids: { ring: string[]; set: Record<string, true> };       // bounded (64k) per generation; full set only during a rescan
  usageCounted: Record<string, true>;                              // `${message.id}|${requestId}`
  conflicts: Record<string, number>; anomalies: Diagnostic[];     // bounded ring 256
  lastHostResumeAt?: MonoMs; lastFrame?: ScreenFacts; lastFrameAt?: MonoMs; surfaceSince?: MonoMs;
}

// ---- core/input-policy/jobs.ts (rev2: normative here, §3.6 describes behaviour) ----
export type SubmitPhase = 'waitGate' | 'staging' | 'editorOpen' | 'verifyStaged' | 'settle' | 'enterSent' | 'awaitAck' | 'retryEnter' | 'done' | 'failed';
export type CommandPhase = 'waitGate' | 'staging' | 'settle' | 'enterSent' | 'awaitEffect' | 'captureModal' | 'dismissModal' | 'done' | 'failed';
export type InputJob =
  | { key: InputJobKey; kind: 'submit'; turn: TurnKey; text: string /* sanitized */; method: 'editor' | 'pasteChunks'; attempt: number; phase: SubmitPhase }
  | { key: InputJobKey; kind: 'selftest'; nonce: string; method: 'editor' | 'pasteChunks'; phase: SubmitPhase | 'restoreCheck' | 'clearing' }   // rev2: no Turn
  | { key: InputJobKey; kind: 'command'; name: string /* canonical, aliases resolved */; args?: string; phase: CommandPhase; cmdId: number; output?: string }
  | { key: InputJobKey; kind: 'interrupt'; turn?: TurnKey; phase: 'escSent' | 'confirming' | 'done' }
  | { key: InputJobKey; kind: 'clearComposer'; phase: 'editorClear' | 'esc1' | 'awaitHint' | 'esc2' | 'verify' | 'done' }
  | { key: InputJobKey; kind: 'permissionKeys'; permission: PermissionKey; action: 'deny' | { digit: number }; phase: 'sent' | 'verify' | 'done' }
  | { key: InputJobKey; kind: 'setMode'; target: PermissionMode; presses: number; phase: 'pressed' | 'verify' | 'done' }
  | { key: InputJobKey; kind: 'wakeEnter'; phase: 'sent' | 'verify' | 'done' }
  | { key: InputJobKey; kind: 'dismissMenu'; phase: 'sent' | 'verify' | 'done' };   // rev2: one Escape on the usage-limit options menu
export interface InputPolicyState { jobs: Record<InputJobKey, InputJob>; order: InputJobKey[]; current?: InputJobKey; lastEscAt?: MonoMs; lastCtrlCAt?: MonoMs; firstPromptSentInGen: Record<GenKey, true> }

export interface Counters { gen: number; turn: number; tool: number; agent: number; perm: number; call: number; msg: number; job: number; intent: number; event: number; input: number }
export interface CoreState { domain: SessionState; recon: ReconState; input: InputPolicyState; counters: Counters; now: MonoMs; wallNow: WallMs; config: CoreConfig }
export type CoreInput =
  | { type: 'obs'; obs: Observation }
  | { type: 'cmd'; cmdId: number; cmd: Command; at: MonoMs; wallAt: WallMs };
export interface Diagnostic { code: string; at: MonoMs; detail: JsonValue }
export interface StepResult { core: CoreState; events: DomainEvent[]; intents: Intent[]; diagnostics: Diagnostic[];
  commandResult?: { cmdId: number; ok: true; value: unknown } | { cmdId: number; ok: false; error: CcdErrorData } }
export interface NextDeadline { atMono?: MonoMs; atWall?: WallMs }             // rev2: wall deadlines (usageWake) are separate (§4.10)
export function initialCore(init: CoreInit): CoreState;
export function step(core: CoreState, input: CoreInput): StepResult;     // total, synchronous, deterministic
export function nextDeadline(core: CoreState): NextDeadline;
export function evolve(domain: SessionState, e: CoreEvent): SessionState;   // the only writer of `domain`
export function serializeCore(c: CoreState): JsonValue; export function deserializeCore(j: JsonValue): CoreState;
```
Invariants (property-tested): **I1** (rev2, by construction) `decide/*` and `closing.ts` never assign to `domain`; they return `CoreEvent[]` and `step` folds them with `evolve`. Therefore `fold(evolve, initialDomain, allCoreEvents)` deep-equals `core.domain` (with `status` recomputed by `deriveStatus`); the published stream is the `DomainEvent` subset, and the ESLint rule `no-restricted-syntax` for `AssignmentExpression[left.object.name='domain']` outside `evolve.ts` enforces it. **I2** `step` never throws for any input (fast-check arbitraries); **I3** same inputs → byte-identical events/intents/keys; **I4** provenance only grows; **I5** no terminal entity returns to non-terminal except `unknown`→concrete (emits `*.resolvedLate`); **I6** `inputBlocked.permission` ⇒ no `input` intent with `key Enter|digit` or text primitive is emitted (only `Escape` for an explicit interrupt/deny-by-keys); **I7** `deserializeCore(serializeCore(c))` followed by the remaining inputs gives the same events as the uninterrupted run.

`step` order (RC §10.2): (1) set `now = max(now, input.at)`, `wallNow = max(wallNow, input.wallAt)`; (2) fire every mono deadline with `at ≤ now` and every wall deadline with `atWall ≤ wallNow` in `(at, id)` order; (3) apply the input via `decide/*`; (4) run closing rules; (5) run the input-policy machine (may emit intents); (6) recompute `status = deriveStatus(domain)` and emit `status.changed` if deep-unequal; (7) recompute `poll.cadence`/`auth.poll` intents when their class changes; (8) emit diagnostics. Malformed or impossible combinations produce a diagnostic and are otherwise ignored.

### 2.10 L3 kernel port (`model/kernel.ts` types; `session/kernel.ts` implementation)

Normative and complete (rev2 §10 B1/G5: this replaces "AL §4.5 verbatim"; AL §4.5's `permission.setPolicy`, `pane.resize` and `close({mode:'detach'})` are **not** in v1).

```ts
// model/kernel.ts
export type Unsubscribe = () => void;
export interface SessionExitInfo { exitStatus: number | null; signal: string | null; reason: 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone'; finalScreen?: string }
export type KernelListener = (batch: { events: readonly DomainEvent[]; state: Readonly<SessionState>; gap?: { from: EventSeq; to: EventSeq } }) => void;
export interface KernelCloseOptions { mode?: 'graceful' | 'kill'; graceMs?: number; reason?: string; waitForBackgroundMs?: number }
export interface PermissionAsk {                 // what the broker hands to a user handler (facade maps it to PermissionRequest)
  permissionKey: PermissionKey; toolName: string; input: unknown; suggestions: readonly unknown[]; needs: 'decision' | 'answers' | 'planApproval';
  turnKey?: TurnKey; toolKey?: ToolKey; agentKey?: AgentKey; background: boolean; deadlineAt: MonoMs; signal: AbortSignal;
}
export type KernelPermissionHandler = (ask: PermissionAsk) => PermissionDecision | Promise<PermissionDecision | undefined> | undefined;   // undefined = ask the host (event)
export interface SessionKernel {
  readonly sessionKey: SessionKey;
  getState(): Readonly<SessionState>;                       // immutable snapshot (structural sharing)
  dispatch<C extends Command>(cmd: C): Promise<CommandResult<C>>;   // resolves when the core accepted it (slash.run: when its job finished)
  subscribe(listener: KernelListener, opts?: { fromSeq?: EventSeq }): Unsubscribe;   // ring replay; first batch carries `gap` if retention lost events
  subscribeDebug(listener: (r: DebugRecord) => void): Unsubscribe;                  // no-op unless debug enabled
  setPermissionHandler(h: KernelPermissionHandler | null): void;                      // lives in L3 (user code); the core only sees permission.answer
  waitFor(pred: (s: SessionState) => boolean, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SessionState>;   // rejects E_WAIT_TIMEOUT / AbortError
  readonly diagnostics: { viewCommand(): string /* tmux -L <sock> attach -r -t =<session>: */; captureScreen(): Promise<string>; tracePath?: string };
  close(opts?: KernelCloseOptions): Promise<SessionExitInfo>;   // idempotent
}
// runtime/node.ts
export function createKernel(spec: SessionSpec, o?: { logger?: Logger; signal?: AbortSignal }): Promise<SessionKernel>;   // resolves at session.ready
```
L3 internals follow AL §4.6 rules L-1, L-2, L-4…L-8 with these rev2 changes: L-3 is replaced by §4.10/§4.12 (one decision timer plus the closed adapter-timer list); L-7's exit-cleanup registry is keyed on `globalThis[Symbol.for('claude-code-driver.exit-registry.v1')]` so two package copies share it; L-8's policy timeout is the core deadline `permissionPolicy`.

### 2.11 `model/spec.ts`: the internal `SessionSpec` (rev2, D-39)

`SessionSpec` is the stable internal contract between any facade and L3. It is plain data (JSON-serializable except `logger`/handler, which travel separately), grouped by concern, with every field optional except `cwd` and `permissions.policy`. `session/config.ts resolveConfig(spec, env, defaults): ResolvedConfig` validates it (unknown keys → `E_CONFIG_INVALID{reason:'unknownKey', path}`) and applies the DEFAULTS table.

```ts
export interface SessionSpec {
  cwd: string; sessionId?: string; resume?: string; model?: string; effort?: string; permissionMode?: PermissionMode;
  extraArgs?: readonly string[];
  claude?: { bin?: string; expectVersion?: string | 'any' };
  env?: { inherit?: 'minimal' | 'all' | readonly string[]; set?: Readonly<Record<string, string>>; scrubSubprocessEnv?: boolean };
  tmux?: { bin?: string; cols?: number; rows?: number; historyLimit?: number };
  permissions: { policy: 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll' | 'handler'; timeoutMs?: number; onTimeout?: 'deny' | 'tui';
                 screenAllow?: boolean; allowDangerousModes?: boolean; allowAddDirectories?: boolean };
  trust?: { mode?: 'require' | 'seed'; acceptRisks?: boolean };
  input?: { method?: 'editor' | 'pasteChunks'; mentions?: 'allow' | 'reject'; maxPromptBytes?: number; whenBusy?: 'wait' | 'reject' };
  hooks?: { transport?: 'auto' | 'http' | 'unix'; overrideDisableAllHooks?: boolean; preToolUse?: boolean; messageDisplay?: boolean; postToolBatch?: boolean };
  network?: false | { faults?: boolean; allowPrivate?: boolean };
  security?: { denyTmuxInBash?: boolean; crossSessionInbound?: 'accept' | 'hold' | 'refuse'; mcp?: 'inherit' | 'strict'; onTamper?: 'alert' | 'interrupt' };
  usageLimit?: { autoResume?: boolean; resumePrompt?: string; jitterMinMs?: number; jitterMaxMs?: number; maxRearms?: number; builtinAutoContinue?: boolean };
  lifecycle?: { closeGraceMs?: number; killAfterMs?: number; stateDir?: string; runtimeRoot?: string };
  selfTest?: 'once' | 'always' | 'off';
  debug?: { tracePath?: string; raw?: 'none' | 'meta' | 'full'; retainEvents?: number; claudeDebugFile?: boolean; keepClaudeDebugFile?: boolean; dumpDir?: string; captureLimitFixtures?: boolean };
  timeouts?: Partial<CoreConfig['timeouts']>;
}
```

### 2.12 L4 public API (`src/api/*`, entry `claude-code-driver`) — normative

Small on purpose (rev2 §10 E1). Everything not listed here is reachable only through `unstable_advanced` (shape = `Omit<SessionSpec, keyof the stable fields>`, documented as unstable, may change in any minor) or the `./kernel` subpath (`@experimental`).

```ts
export declare const SUPPORTED_CLAUDE_VERSION: '2.1.316';
export type SessionKey = string & { readonly __brand: 'SessionKey' };
export type TurnKey = string & { readonly __brand: 'TurnKey' };
export type ToolKey = string & { readonly __brand: 'ToolKey' };
export type SubagentKey = string & { readonly __brand: 'SubagentKey' };
export type PermissionKey = string & { readonly __brand: 'PermissionKey' };
export type ChannelName = 'hooks' | 'transcript' | 'network' | 'screen';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan';          // dangerous modes only via unstable_advanced.permissions.allowDangerousModes
export interface Provenance { readonly confirmed: boolean; readonly sources: readonly ChannelName[] }

export interface ClaudeSessionOptions {
  cwd: string;
  /** REQUIRED (rev2 §10 E2): 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll' | handler function. */
  permissions: 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll' | PermissionHandler
             | { policy: 'deny' | 'ask' | 'allowRead' | 'dangerouslyAllowAll' | PermissionHandler; timeoutMs?: number /* 120_000 */; onTimeout?: 'deny' | 'tui' };
  model?: string; effort?: string; permissionMode?: PermissionMode;
  sessionId?: string; resume?: string;
  extraArgs?: readonly string[];                             // allowlist §3.3
  claude?: { bin?: string; expectVersion?: string | 'any' };
  env?: { inherit?: 'minimal' | 'all'; set?: Readonly<Record<string, string>> };
  trust?: 'require' | 'seed';
  network?: boolean;                                         // opt-in CONNECT channel (faults only via unstable_advanced)
  usageLimit?: { autoResume?: boolean /* true */; resumePrompt?: string /* 'continue' */ };
  debug?: { trace?: string; raw?: 'none' | 'meta' | 'full' };
  logger?: Logger; signal?: AbortSignal;                     // abort = close({mode:'kill'})
  unstable_advanced?: Readonly<Record<string, unknown>>;     // validated against SessionSpec at runtime; typed as UnstableAdvanced in ./kernel
}
export interface PermissionRequest {
  readonly key: PermissionKey; readonly toolName: string; readonly toolInput: unknown; readonly suggestions: readonly unknown[];
  readonly needs: 'decision' | 'answers' | 'planApproval';
  readonly turnKey?: TurnKey; readonly toolKey?: ToolKey; readonly subagentKey?: SubagentKey; readonly background: boolean;
  readonly requestedAt: number; readonly deadlineAt: number; readonly signal: AbortSignal;
}
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message?: string; interrupt?: boolean };
export type PermissionHandler = (req: PermissionRequest) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>;   // undefined = ask (event)

export type AgentStatus =
  | { kind: 'starting'; since: number }
  | { kind: 'idle'; since: number; backgroundAgents: number; queued: number; quiescent: boolean; lastError?: ClaudeSessionErrorData }
  | { kind: 'modelRequest'; phase: 'waiting' | 'streaming' | 'retrying' | 'stalled'; since: number; attempt?: number; maxAttempts?: number; retryInMs?: number; provenance: Provenance }
  | { kind: 'writing'; since: number; provenance: Provenance }
  | { kind: 'runningTools'; tools: readonly ToolKey[]; since: number; provenance: Provenance }
  | { kind: 'awaitingPermission'; permission: PermissionKey; since: number }
  | { kind: 'awaitingInput'; inputKind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput' | 'unknownModal'; message?: string; since: number }
  | { kind: 'interrupted'; since: number }
  | { kind: 'compacting'; since: number }
  | { kind: 'usageLimited'; since: number; resetsAt?: number; nextWakeAt?: number; autoResume: boolean }
  | { kind: 'authRequired'; since: number; message: string }
  | { kind: 'exited'; since: number; exitStatus: number | null; signal: string | null };

export interface ToolRunSnapshot { readonly key: ToolKey; readonly toolUseId?: string; readonly name: string; readonly input: unknown;
  readonly state: 'pending' | 'awaitingPermission' | 'running' | 'launched' | 'succeeded' | 'failed' | 'denied' | 'interrupted' | 'unknown';   // 'running' also shown for pending > 150 ms without a permission (display rule, §4.6)
  readonly turnKey?: TurnKey; readonly subagentKey?: SubagentKey; readonly startedAt: number; readonly endedAt?: number; readonly provenance: Provenance }
export interface SubagentSnapshot { readonly key: SubagentKey; readonly agentId: string; readonly agentType: string; readonly background: boolean;
  readonly state: 'running' | 'stopped' | 'unknown'; readonly startedAt: number; readonly endedAt?: number }
export interface TurnSnapshot { readonly key: TurnKey; readonly prompt: string; readonly promptId?: string; readonly origin: 'library' | 'external';
  readonly state: 'queued' | 'submitting' | 'running' | 'completed' | 'interrupted' | 'failed' | 'aborted' | 'notSubmitted' | 'withdrawn' | 'unknown';
  readonly tools: readonly ToolKey[]; readonly subagents: readonly SubagentKey[]; readonly text: string;
  readonly startedAt?: number; readonly endedAt?: number; readonly error?: ClaudeSessionErrorData }
export interface SessionSnapshot { readonly key: SessionKey; readonly claudeSessionId: string; readonly cwd: string; readonly claudeVersion: string;
  readonly status: AgentStatus; readonly mode: PermissionMode | 'other'; readonly model?: string; readonly currentTurn?: TurnSnapshot;
  readonly queuedTurns: readonly TurnKey[]; readonly activeTools: readonly ToolRunSnapshot[]; readonly subagents: readonly SubagentSnapshot[];
  readonly pendingPermissions: readonly PermissionKey[]; readonly usage: { readonly contextUsedPct?: number; readonly limitedUntil?: number };
  readonly channels: Readonly<Record<ChannelName, 'up' | 'degraded' | 'down' | 'off'>>; readonly lastEventSeq: number }

interface Ev<T extends string, P> { readonly type: T; readonly seq: number; readonly at: number; readonly turnKey?: TurnKey; readonly provenance: Provenance; readonly data: P }
export type SessionEvent =
  | Ev<'ready', { mode: PermissionMode | 'other'; model?: string }>
  | Ev<'status', { from: AgentStatus; to: AgentStatus }>
  | Ev<'claudeSessionChanged', { from?: string; to: string; reason: string }>
  | Ev<'turnQueued', { prompt: string; origin: TurnSnapshot['origin'] }>
  | Ev<'turnStarted', { promptId: string }>
  | Ev<'externalTurn', { prompt: string; kind: 'taskNotification' | 'scheduled' | 'autoContinue' | 'human' | 'unknown' }>
  | Ev<'text', { delta: string; messageId: string; final: boolean }>
  | Ev<'textRetracted', { messageIds: readonly string[] }>
  | Ev<'message', { messageId: string; text: string }>
  | Ev<'toolStarted', ToolRunSnapshot> | Ev<'toolEnded', ToolRunSnapshot>
  | Ev<'permissionRequested', Omit<PermissionRequest, 'signal'>>
  | Ev<'permissionResolved', { key: PermissionKey; decision: 'allow' | 'deny'; by: 'library' | 'tui' | 'policy' | 'unknown' }>
  | Ev<'inputRequested', { inputKind: 'elicitation' | 'elicitationUrl' | 'agentNeedsInput' | 'unknownModal'; message?: string }>
  | Ev<'subagentStarted', SubagentSnapshot> | Ev<'subagentEnded', SubagentSnapshot>
  | Ev<'modelCall', { phase: 'started' | 'waiting' | 'streaming' | 'retrying' | 'stalled' | 'ended'; attempt?: number; retryInMs?: number }>
  | Ev<'usageLimited', { resetsAt?: number; nextWakeAt?: number }>
  | Ev<'compaction', { phase: 'started' | 'ended' }>
  | Ev<'turnEnded', TurnResult>
  | Ev<'channel', { channel: ChannelName; health: 'up' | 'degraded' | 'down' | 'off'; reason?: string }>
  | Ev<'authRequired', { message: string }> | Ev<'authRestored', {}>
  | Ev<'security', { code: 'E_SECURITY'; reason: string }>
  | Ev<'warning', { code: PublicErrorCode; reason: string; message: string }>
  | Ev<'gap', { from: number; to: number }>
  | Ev<'exited', SessionExitInfo>;
export type SessionEventType = SessionEvent['type'];
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;

export type TurnOutcome = 'completed' | 'interrupted' | 'failed' | 'aborted' | 'notSubmitted' | 'withdrawn' | 'unknown';
export interface TurnResult { readonly turnKey: TurnKey; readonly outcome: TurnOutcome; readonly text: string; readonly refused: boolean;
  readonly tools: readonly ToolRunSnapshot[]; readonly durationMs: number; readonly error?: ClaudeSessionError }
export interface Turn extends AsyncIterable<SessionEvent> {
  readonly key: TurnKey; readonly prompt: string;
  readonly accepted: Promise<{ promptId: string }>;   // rejects E_SUBMIT_UNCONFIRMED / E_BUSY / E_INPUT_REJECTED / E_SESSION_EXITED (a no-op catch is attached)
  readonly done: Promise<TurnResult>;                 // always resolves
  completed(): Promise<TurnResult>;                   // resolves on 'completed', else throws TurnResult.error
  snapshot(): TurnSnapshot; events(opts?: { highWaterMark?: number }): AsyncIterableIterator<SessionEvent>; interrupt(): Promise<void>;
}
export interface SessionExitInfo { readonly exitStatus: number | null; readonly signal: string | null; readonly reason: 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone' }
export type Unsubscribe = () => void;

export declare class ClaudeSession implements AsyncDisposable {
  static start(opts: ClaudeSessionOptions): Promise<ClaudeSession>;     // resolves at ready; rejects ClaudeSessionError
  static closeAll(): Promise<void>;                                      // every live session in this process (all package copies)
  readonly key: SessionKey; readonly cwd: string;
  get claudeSessionId(): string; get state(): SessionSnapshot; get status(): AgentStatus;
  readonly exited: Promise<SessionExitInfo>;                            // always resolves
  send(prompt: string, opts?: { whenBusy?: 'wait' | 'reject'; signal?: AbortSignal }): Turn;
  command(name: string, args?: string, opts?: { unsafe?: boolean }): Promise<{ output?: string }>;
  interrupt(): Promise<{ turnKey?: TurnKey }>;
  respondToPermission(key: PermissionKey, decision: PermissionDecision): Promise<void>;
  answerQuestion(key: PermissionKey, answers: Readonly<Record<string, string>>): Promise<void>;                  // AskUserQuestion
  approvePlan(key: PermissionKey, o: { approve: boolean; mode?: 'default' | 'acceptEdits'; feedback?: string }): Promise<void>;   // ExitPlanMode (rev2)
  setMode(mode: PermissionMode): Promise<void>;
  wakeNow(): Promise<void>;                                              // run the usage-limit wake check now
  on<T extends SessionEventType>(type: T, l: (e: SessionEventOf<T>) => void): Unsubscribe;
  onAny(l: (e: SessionEvent) => void): Unsubscribe;
  events(opts?: { fromSeq?: number; highWaterMark?: number; types?: readonly SessionEventType[] }): AsyncIterableIterator<SessionEvent>;
  waitFor(pred: (s: SessionSnapshot) => boolean, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SessionSnapshot>;
  waitForIdle(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SessionSnapshot>;
  waitForQuiescence(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SessionSnapshot>;
  turn(key: TurnKey): Turn | undefined; turns(): readonly TurnSnapshot[];
  readonly debug: { viewCommand(): string; captureScreen(): Promise<string>; readonly tracePath?: string };
  close(opts?: { mode?: 'graceful' | 'kill'; graceMs?: number; waitForBackgroundMs?: number }): Promise<SessionExitInfo>;
  [Symbol.asyncDispose](): Promise<void>;
}
export declare const PUBLIC_ERROR_CODES: readonly [/* §2.2 */]; export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];
export interface ClaudeSessionErrorData { code: PublicErrorCode; message: string; details: { reason: string } & Record<string, unknown> }
export declare class ClaudeSessionError extends Error { readonly code: PublicErrorCode; readonly retryable: boolean; readonly details: ClaudeSessionErrorData['details']; toJSON(): ClaudeSessionErrorData }
export declare function isClaudeSessionError(e: unknown, code?: PublicErrorCode): e is ClaudeSessionError;
export interface Logger { debug(m: string, f?: Record<string, unknown>): void; info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void; error(m: string, f?: Record<string, unknown>): void }
export declare const consoleLogger: (level?: 'debug' | 'info' | 'warn' | 'error') => Logger;
export declare function installSignalHandlers(o?: { graceMs?: number }): Unsubscribe;   // opt-in (LC §7)
export declare function redactEvent(e: SessionEvent): SessionEvent;                       // SEC §8.3
```
Mapping discipline: `api/map-events.ts`, `api/map-state.ts`, `api/map-errors.ts` use exhaustive `switch` with `assertNever` (AL §6.4). Internal-agent tools, teammates and `claim.*` events are not exposed. The `ClaudeSession.recover(sessionKey)` convenience is **not** in v1; the documented recovery is `ClaudeSession.start({ ..., resume: <claudeSessionId> })`, with the id from `ccd lifecheck --json` or the trace.

---

## 3. Behaviour specifications (L3 orchestration, with the L0/L1 duties they rely on)

### 3.1 `start()` sequence (`session/launcher.ts`, `session/preflight.ts`)

Each step either succeeds or throws the named `CcdError` (public code per §2.2); on failure everything created so far is torn down in reverse order. Rev 2 reorders the steps so that every check runs with the environment it needs and the version check precedes any tmux call (§10 G20).

1. **Config**: `api/options.ts toSessionSpec(opts)` → `session/config.ts resolveConfig(spec)` (pure). Unknown keys → `E_CONFIG_INVALID`. `permissions` missing → `E_CONFIG_INVALID{reason:'permissionsRequired'}`. `cwd` must exist; `cwdRealpath = realpath(cwd)` (macOS `/var` → `/private/var`, LV Q4). `tmux.cols < 120` → `E_CONFIG_INVALID`. `extraArgs` → allowlist (§3.3) else `E_FORBIDDEN_ARG{arg}`. Caller `env.set` containing `ANTHROPIC_BASE_URL` (BRIEF) or any provider switch (§3.2) → `E_FORBIDDEN_ENV`.
2. **Node**: `process.versions.node` ≥ 20.0 else `E_NODE_UNSUPPORTED`.
3. **Runtime and state dirs**: `runtimeDir.ensureRoot()`, `state.root` lstat checks (SEC §9) → `E_UNSAFE_RUNTIME_DIR`. `sessionDir = runtimeDir.createSessionDir()` (asserts `sessionDir + '/net.sock'` ≤ 100 bytes, the longest socket name we create, else `E_SOCKET_PATH_TOO_LONG`; macOS limit 104, HT §6 VERIFIED bench). Run the reaper (§3.8) and `sweepStale` over registry-known dirs only.
4. **Child env, phase 1** (§3.2) without any library proxy: base allowlist + caller env + library-required − strip list, with the user's proxy variables passed through exactly as §3.2 says for "network off". This env is used for steps 5 and 6.
5. **Claude binary and version** (before any tmux call, K-03): `claude.resolve()` order: option → `<consumer>/node_modules/@anthropic-ai/claude-code/bin/claude.exe` → `<this pkg>/node_modules/…/claude.exe` → `which claude` (then follow the shim's `exec` line). `version(exe, env₁)` must equal `SUPPORTED_CLAUDE_VERSION` unless `expectVersion:'any'` → `E_CLAUDE_VERSION_MISMATCH{expected,found}` (BRIEF: fail loudly).
6. **Account**: `claudeConfig.readGlobal()`: `invalidJson` → `E_CONFIG_CORRUPT` (never "Reset with default configuration", LC §1.1); `hasCompletedOnboarding !== true` → `E_NOT_ONBOARDED`. `claude.authStatus(exe, env₁)` (10 s, never killed early, LC §1.3): `loggedIn:false` → `E_LOGIN_REQUIRED`; `authMethod !== 'claude.ai'` → `E_AUTH_METHOD_UNSUPPORTED` (an API key would bill the API, BRIEF purpose); `apiProvider` present and `!== 'firstParty'` → `E_API_PROVIDER_UNSUPPORTED{apiProvider}` (enum VERIFIED-BIN rev 2; a Bedrock/Vertex/Foundry/gateway provider moves billing off the subscription and the model host off `api.anthropic.com`). Stagger concurrent starts in one process by 1.5 s (refresh lock, LC §2, UNVERIFIED rate).
7. **Settings layers, workspace, resume holder**: `readLayers(cwdRealpath)`:
   - `disableAllHooksTrueIn` non-empty and no `overrideDisableAllHooks` → `E_HOOKS_DISABLED_BY_USER` (D-14).
   - `keybindings.json` rebinds any of `enter`, `escape`, `ctrl+g`, `ctrl+j`, `shift+tab`, `ctrl+c` → `E_KEYBINDING_CONFLICT` (IN §2).
   - `editorMode` is anything but `normal` → we force `"editorMode":"normal"` in our settings (TUI §3.8) and warn.
   - **Hook transport** (`hooks.transport:'auto'`, rev 2 §10 G9): `'unix'` if any readable layer defines `allowedHttpHookUrls` *and* LP-10 has not confirmed that our exact-origin entry is honoured, or if any readable layer sets `sandbox.enabled:true` (P-HOOK-13), or if `selftest-cache.json` records an HTTP self-test failure for this (version, cwd) within 24 h; else `'http'`. Explicit `'http'`/`'unix'` is used as given.
   - Trust: `trustOf(cwdRealpath)`. Not trusted and `trust.mode==='require'` → `E_TRUST_REQUIRED`. `'seed'` → `inspectWorkspace()`; non-empty and not `acceptRisks` → `E_WORKSPACE_RISK{items}`; else `seedTrust()` and record `trustKeyAddedByLibrary`.
   - **Resume holder** (rev 2, LC §15 Q3): with `resume:<id>`, `registry.scan()`; a live pid whose record has `sessionId === id` → `E_SESSION_ID_IN_USE{pid, ours: boolean}` (ours = it is in our own registry; the reaper already ran, so it is a live library session). Never touch a non-library holder. Probe LP-55 confirms what Claude itself does in that case.
8. **Network channel** (§3.10) if enabled: the user already has any proxy variable, or `NO_PROXY` covers `api.anthropic.com`/`*`, or `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER` is set → channel `off` with `warning E_NETWORK_UNAVAILABLE{reason}`, start continues. Otherwise start the sidecar; **child env phase 2** = phase 1 plus the proxy variables of §3.10.
9. **Hook transport**: `hooks.start({transport})` → `HookEndpoint` (spawns the worker); `editor.setup()` → `VISUAL` path.
10. **Settings file** (§3.4): `settingsFile.writeExclusive(sessionDir/settings.json)` (0600, `wx`), keep `sha256`. Validate against the known key list (unknown keys are a bug: a Settings Error dialog would block startup, LC §1.1).
11. **Registry**: write `sessions/<sessionKey>.json` (§3.8) with `state:'launching'` **before** spawning, so a crash between spawn and the owner-watch start is still reapable.
12. **tmux probe and spawn**: `tmux.probe(opts.tmux.bin)` searching `$PATH` then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` (TD rule 19) → `E_TMUX_NOT_FOUND` / `E_TMUX_UNSUPPORTED` (min 3.2; tested 3.5a). `tmux.create({socketName: 'ccd-' + ownerPid.toString(36) + '-' + hex8, clientEnv: childEnv, …})` then `spawnPane({sessionName:'ccd-'+sessionKey, argv, cwd: cwdRealpath, cols:250, rows:80, nonSecretEnv:{}})` in one invocation (TD R5/R6, D-09). Read `#{pane_pid}`; `process.identity(pid)` must contain `claude.exe` and our `--session-id`/`--resume` id (LC §6.3); store `{pid, startTime}`. **Start the owner-watch** (§3.8) immediately. Emit `process.launched`.
13. **Tail**: `tail.followMain(claudeSessionId, expectedPath, {startAt:'beginning'})` (a fresh file is empty; on resume the history is replayed with `replay:true`) where `expectedPath = <configDir>/projects/<slug(cwdRealpath)>/<id>.jsonl` (cross-check only; the hook's `transcript_path` wins, TF §1).
14. **Readiness** (core decides, §4.3): SessionStart (`source` `startup`/`resume`) **and** a stable `main` surface with an empty composer for `readyStableMs` (300 ms). If no SessionStart within `startupHookGraceMs` (3000, the only startup grace) the screen is classified: a known gate → `session.gated` → `start()` rejects `E_STARTUP_GATE{gate,text}` (or `E_TRUST_REQUIRED` for `trust`, `E_SESSION_ID_IN_USE`, `E_CONFIG_CORRUPT`, `E_SETTINGS_INVALID`, `E_LOGIN_REQUIRED`, `E_VERSION_POLICY`), the pane is killed, nothing is pressed (LC rule 3). A stable idle `main` surface with no SessionStart at `startupHookGrace` → channel hooks `degraded{reason:'noSessionStart'}` (cleared by the first authenticated hook, §10 A9), readiness by screen, self-test decides. Pane dead before ready → `E_STARTUP_EXITED{exitStatus, finalScreen}` (maps `Session ID … is already in use.`, `No conversation found with session ID`, `Claude Code could not start`, org version policy, `--settings` errors; LC §1.5). Overall `startupMs` 60 000 → `E_STARTUP_TIMEOUT{phase, screenSummary}`.
15. **Self-test** (D-35): L3 looks up `selftest-cache` for (process, Claude version, `cwdRealpath` trust state, hook transport). L3 mints `nonce = 'ccd-selftest-' + ids.tokenHex(16)` and dispatches `selftest.run{nonce, cachedPass}`. Core: `cachedPass` → `selfTest.state='cached'`, ready. Otherwise core emits `hook.armSelfTest{nonce}`; on `hook.selfTestArmed{armed:true}` it starts a `selftest` input job (normal submit primitives). Expected: a `prompt.submitted` whose normalized text equals the armed nonce within `submitAckMs` — **the core consumes it as the self-test ack and creates no Turn**, and also ignores any `prompt.recorded`/`ai-title`/`last-prompt` entry carrying the nonce (UNVERIFIED whether a blocked UPS writes them, LP-47) — then the composer restored (blocked prompts return to the box, IN testing trick), then a `clearComposer` job, then `hook.disarmSelfTest`. Failure → `E_SELFTEST_FAILED{step}`; with `hooks.transport:'auto'` and transport `http`, a failure at step `ack` while the transcript shows the nonce prompt causes **one** automatic relaunch with `transport:'unix'` (fresh session id; recorded in the cache). Passing writes the cache. The nonce lands in `~/.claude/history.jsonl` once per cache period (P-INPUT-29); `fixtures:scrub` rewrites `ccd-selftest-[0-9a-f]{32}` → `ccd-selftest-NONCE`.
16. `session.ready` → `start()` resolves. Registry `state:'ready'`; heartbeat (adapter timer A-1, §4.12) writes `owners/<pid>.json` every 10 s.

### 3.2 Child environment (`session/env-builder.ts`)

Order: base allowlist → caller `env.set` → library-required → strip list → proxy handling. Logged at debug level by **name only** (SEC §7.2).

- **Base (`inherit:'minimal'`)**: `PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE LC_* TMPDIR TZ TERM_PROGRAM_VERSION? COLORTERM EDITOR? VISUAL? GIT_EDITOR?` plus the **user-privacy pass-through** list, kept exactly as the user set them (OD §4.2 "leave as the user set them"; rev 2 §10 G15): `DISABLE_TELEMETRY DISABLE_GROWTHBOOK DISABLE_ERROR_REPORTING DISABLE_BUG_COMMAND CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DO_NOT_TRACK`. `SSH_AUTH_SOCK` only when `env.inherit` lists it (SEC §7.2). `USER` and `HOME` are mandatory (keychain account = `$USER`, LC §1.3 VERIFIED-SRC). `LC_ALL=en_US.UTF-8` (darwin) / `C.UTF-8` (linux) if no UTF-8 locale is set (TD §9).
- **Library-required**: `DISABLE_AUTOUPDATER=1`, `DISABLE_UPDATES=1`, `DISABLE_INSTALLATION_CHECKS=1`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`, `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=5000`, `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` (TT §7), `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` only if `scrubSubprocessEnv`. Editor method (rev 2 §10 A11): `VISUAL=<sessionDir>/ccd-editor`; the user's original `VISUAL`/`EDITOR` (if any) are written to `<sessionDir>/editor-orig.json` (0600) so the unarmed `ccd-editor` **execs the user's editor** with the same argv instead of failing; `GIT_EDITOR` = the user's `GIT_EDITOR` if set, else the user's original `VISUAL`/`EDITOR` if set, else `true` (so an agent `git merge`/`rebase --continue` accepts the default message instead of failing on our wrapper; `git commit` without `-m` then aborts with git's own "empty message" error, the same as without a usable editor). All values VERIFIED-DOC as existing vars (OD §4, LC §11/§12); the combined effect is UNVERIFIED → LP-03.
- **Strip always** (even under `inherit:'all'`): `ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_UNIX_SOCKET CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_EFFORT_LEVEL CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_ENV_FILE CLAUDE_CODE_SAFE_MODE CLAUDE_CODE_SIMPLE CLAUDE_CODE_SANDBOXED CLAUDE_CODE_IGNORE_PERSISTED_TRUST CLAUDE_CODE_SKIP_PROMPT_HISTORY CLAUDE_CODE_TRANSCRIPT_LOCAL_GC CLAUDE_CODE_PROJECT_DIR_NAME CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDE_CODE_SUPERVISED CLAUDE_BG_BACKEND CLAUDE_JOB_DIR FORCE_AUTOUPDATE_PLUGINS CLAUDE_CODE_FORCE_FIRST_LAUNCH CLAUDE_CODE_RESTRICTED CLAUDE_CODE_RETRY_WATCHDOG CLAUDE_CODE_RETRY_WATCHDOG_* IS_DEMO TMUX TMUX_PANE NODE_OPTIONS NODE_PATH BUN_*` and (rev 2, all VERIFIED-BIN) the **model-call semantics** vars `CLAUDE_CODE_MAX_RETRIES API_TIMEOUT_MS CLAUDE_STREAM_IDLE_TIMEOUT_MS CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS CLAUDE_ENABLE_STREAM_WATCHDOG CLAUDE_ENABLE_BYTE_WATCHDOG BASH_MAX_OUTPUT_LENGTH` (they change `attempt n/10`, stall timing and hook payload sizes that the parsers and thresholds assume; OD §4.3–4.4, HT §8), the **provider switches** `CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_GATEWAY` (in caller `env.set` they are `E_FORBIDDEN_ENV`; inherited ones are stripped with a warning), and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (D-24). (`GIT_EDITOR` is no longer stripped, see above.) A user `settings.json` `env` block can still set any of these; preflight reads the layers and fails `E_FORBIDDEN_ENV{reason:'settingsEnv', name}` for a provider switch there, and warns for the semantics vars (P-REV-12). `CLAUDE_CONFIG_DIR` is **kept only if it is already in the host env** (respect the user's real setup), never introduced (a custom dir switches the keychain item → logged out, LC §1.3).
- **Proxy vars**: capture the user's `https_proxy HTTPS_PROXY http_proxy HTTP_PROXY NO_PROXY no_proxy ALL_PROXY` in Claude's precedence order (NP §6). Network off (or forced off by a user proxy): pass the user's effective `HTTPS_PROXY`/`HTTP_PROXY` through (both casings set to the effective value) and `NO_PROXY`/`no_proxy` = `merge(user's NO_PROXY ∪ no_proxy) + ',127.0.0.1,localhost,::1'` whenever any proxy var is present (D-22). Network on: §3.10.
- **Secrets**: the env above contains the proxy token (network on) and nothing else secret. It is passed as the env of the `tmux` client process that **starts** the per-session server (VERIFIED-EXP SEC §7.1: reaches the pane), never as `-e K=V` argv. Hook tokens are never in env.

### 3.3 Claude argv (`session/argv-builder.ts`)

```
/usr/bin/env -u TMUX -u TMUX_PANE <abs .../bin/claude.exe>
  (--session-id <fresh uuid v4>  |  --resume <current claudeSessionId>)     # never both (LC §8.1)
  --settings <sessionDir>/settings.json                                      # path, never inline JSON (SEC §5.1)
  --permission-mode <default|acceptEdits|plan>                               # always explicit (LV Q4); bypass/auto/dontAsk need allowDangerousModes
  --teammate-mode in-process                                                 # hidden flag, VERIFIED-BIN (ARCH); keeps 1 pane per session (PA T8)
  [--model <m>] [--effort <e>] [--strict-mcp-config] [--debug-file <sessionDir>/claude-debug.log] [...allowlisted extraArgs]
```
tmux receives this as separate argv elements after `--` (multi-arg form, exec'd without a shell, TD §7.2), each passed through `escapeArg` (trailing `;`, TD §2.2).

**`extraArgs` allowlist** (rev 2 §10 G6; replaces the denylist). Accepted forms: `--flag value` and `--flag=value`; values must be a single argv element with no C0/C1 control characters, ≤ 8 KiB; `*-file` values must be an existing regular file (lstat, no symlink) readable by the user. Allowed flags (VERIFIED in `claude --help` 2.1.316): `--append-system-prompt <text>`, `--append-system-prompt-file <path>`, `--system-prompt <text>`, `--system-prompt-file <path>` (UNVERIFIED in `--help`: accepted only if the binary lists it, checked by a unit test against the recorded `--help` text), `-n`/`--name <name>`, `--exclude-dynamic-system-prompt-sections`. **Everything else is `E_FORBIDDEN_ARG`**, including, with the reason recorded in `details.reason`: `--allowedTools/--allowed-tools`, `--disallowedTools/--disallowed-tools` (add allow/deny rules that bypass D-18), `--add-dir` (bypasses `allowAddDirectories`), `--tools` (changes the tool set), `--mcp-config`, `--plugin-dir`, `--plugin-url`, `--agents`, `--agent` (load hooks, MCP servers or agent frontmatter hooks), `--verbose` (changes the screen, OD §3), `-d/--debug` in any form and `--debug-file` (library-owned), `--model`, `--effort`, `--permission-mode`, `--fallback-model` (first-class or unsupported), `--settings`, `--setting-sources`, `--managed-settings`, `--session-id`, `-r/--resume`, `-c/--continue`, `--fork-session`, `--from-pr`, `--teleport`, `-p/--print`, `--output-format`, `--input-format`, `--bare`, `--safe-mode`, `--restricted`, `--disable-slash-commands`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-prompts`, `--teammate-mode`, `--bg/--background`, `--remote-control*`, `--cloud`, `--environment`, `--desktop`, `--worktree/-w`, `--tmux`, `--ide`, `--chrome/--no-chrome`, `--ax-screen-reader`, `--file`, `--betas`, `--brief`, `--autocompact`, `--max-budget-usd`, `--json-schema`, `--strict-mcp-config` (use `security.mcp:'strict'`), `--no-session-persistence`. A positional argument (initial prompt) is also forbidden (it would bypass the sanitizer and the ack).

### 3.4 Injected settings file (`session/settings-plan.ts`), exact shape

```jsonc
{
  "hooks": {
    "SessionStart":      [{"matcher":"*","hooks":[{"type":"command","command":"<execPath>","args":["<dist>/platform/hook-server/standalone/forward.js","<sessionDir>/fwd.json","SessionStart"],"timeout":5}]}],
    "PermissionRequest": [{"matcher":"*","hooks":[{"type":"command","command":"<execPath>","args":["<dist>/platform/hook-server/standalone/forward.js","<sessionDir>/fwd.json","PermissionRequest"],"timeout":<ceil(timeoutMs/1000)+30>}]}],
    "<Ev>":              [{"matcher":"*","hooks":[{"type":"http","url":"http://127.0.0.1:<port>/h/<sid>/<Ev>","headers":{"X-CCD-Token":"<64 hex>"},"timeout":5}]}]
    // transport 'unix' (rev 2): every <Ev> uses the SessionStart command form with "<Ev>" as the last arg, same timeouts
  },
  "spinnerTipsEnabled": false,
  "spinnerVerbs": {"mode": "replace", "verbs": ["Working"]},
  "showTurnDuration": true,
  "promptSuggestionEnabled": false,
  "feedbackSurveyRate": 0,
  "emojiCompletionEnabled": false,
  "editorMode": "normal",
  "autoContinueAtUsageLimit": false,
  "skillOverrides": {"auto-mode-setup": "off"},
  "crossSessionInbound": "refuse",
  // conditional (D-36, opt-in): "permissions": {"deny": ["Bash(tmux:*)", "Bash(*tmux *)"]},
  // conditional (D-13, transport http only): "allowedHttpHookUrls": ["http://127.0.0.1:<port>"]
  // conditional (D-14): "disableAllHooks": false
}
```
- `<Ev>` HTTP events (D-34): `UserPromptSubmit, PreToolUse*, PostToolUse, PostToolUseFailure, Stop, StopFailure, SubagentStart, SubagentStop, Notification, PreCompact, PostCompact, SessionEnd, PermissionDenied, MessageDisplay*` (timeout 3), `PostModelSwitch, ConfigChange, CwdChanged`, `PostToolBatch` (opt-in). Starred are switchable.
- **Never registered**: `WorktreeCreate`, `WorktreeRemove` (replace git behaviour), `PreModelSwitch` (timeout blocks the switch), `Setup`, `FileChanged`, `UserPromptExpansion`, `Elicitation`, `ElicitationResult` (blocking hooks whose empty answer semantics are UNVERIFIED; elicitation is observed through `Notification{elicitation_*}` instead, §4.6), `TaskCreated`, `TaskCompleted`, `TeammateIdle` (agent teams unsupported, D-24), `InstructionsLoaded`, `DirectoryAdded` (HT §10.3; observation value too low).
- No `onFailure`, no `statusMessage`, no `async` (HT §3.3, §4.3). No `statusLine` (rev 2: channel cut, D-23). The plan never writes an `env` block (a user's settings `env` is checked in preflight instead, §3.2).
- Each settings key above is VERIFIED to exist in the 2.1.316 binary (ARCH strings check, SP §12.6, TUI §11, OD §5). Whether `--settings` values beat user-level values for `spinnerVerbs`/`spinnerTipsEnabled` is UNVERIFIED → LP-07; the parsers accept any verb anyway.

### 3.5 Hook transport behaviour (L0 `hook-server/*`)

- **Worker** (rev 2 §10 A7): `transport.ts` spawns `new Worker(new URL('./worker.js', import.meta.url))` (`worker.ts` imports only `node:*`). The worker owns both servers, the 32 MiB body cap, `JSON.parse`, the self-test nonce check and the held PermissionRequest sockets. Main ↔ worker protocol (`postMessage`, structured clone): worker→main `{t:'event', hookSeq, at, wallAt, transport, event, bytes, truncated, payload}`, `{t:'closed', hookSeq, reason}`, `{t:'armed', nonce|null}`, `{t:'stats', …}`; main→worker `{t:'respond', hookSeq, body|null}`, `{t:'arm', nonce|null}`, `{t:'close', heldBody}`. A host event-loop stall therefore delays only our *permission answers* and our processing, never Claude's observation hook calls (their timeout is 5 s, after which Claude drops the hook: LV socket closed at 4965 ms). Worker exit → `HookWorkerDied` → `channel hooks down` and the pane is killed (fail closed like D-28; no restart, because re-listening on a released port races a squatter). `at`/`wallAt` are stamped in the worker with `performance.timeOrigin + performance.now()` translated to the main clock by a fixed offset measured at start.
- **HTTP server**: `listen(0,'127.0.0.1')`; `server.requestTimeout=0`, `server.timeout=0` (HT §9.4). Checks in order (SEC §2.3): method POST; path `^/h/<sid>/<Event>$` with Event in the registered set; `Host === '127.0.0.1:<port>'`; no `Origin`, no `Sec-Fetch-*`; `Content-Type` starts with `application/json`; `X-CCD-Token` equal by `timingSafeEqual` after a length check. Fail 1–5 → `403` empty body, count, burst → `security.alert E_SECURITY_HOOK_FORGERY`. Then **read the body to its end** (cap 32 MiB; over cap: drain, discard, `truncated:true`), then write `200` with `Content-Length: 0` (rev 2 §10 G18: we no longer answer before the upload finishes; whether Claude's HTTP hook client tolerates an early response is UNVERIFIED and unnecessary to rely on), then `JSON.parse`, then post the event. Bad JSON after a good token → already answered 200; emit nothing but a counter. Exception: the armed self-test nonce on `UserPromptSubmit` — the worker parses before answering and answers the constant `{"decision":"block","reason":"ccd self-test"}` iff `prompt === nonce`, else empty 200. A contract test runs the real `claude.exe` hook client against the server (free: SessionStart/UPS of the self-test) and LP-53 measures that the body-then-200 order produces no `hook error` notice and adds < 5 ms.
- **Unix server** (`<sessionDir>/h.sock`, dir 0700, then `chmod 0600`): protocol from the forwarder = one line `{"v":1,"token":"<hex>","event":"<Ev>","payload":<stdin JSON>}`; reply = one line JSON body or `{}`. `SessionStart` answered `{}` at once (empty stdout). `PermissionRequest` is held: `holdable:true`, `closed` resolves on connection close before we answered. With `transport:'unix'` every observation event uses the forwarder too and is answered `{}` at once, except the self-test UPS (constant block body for the nonce). Limits: 64 concurrent connections, 32 held (excess answered `{}` → dialog). Cost of `'unix'`: one `node forward.js` spawn per event (0.02–0.11 s measured cold/warm, skeptic A1), so MessageDisplay is registered with `timeout 3` and may lag; it is the fallback, not the default.
- **Forwarder** (`standalone/forward.ts`, `node:*` only, exec form, run by `process.execPath`): reads `fwd.json` (0600) for `{socketPath, token}`, ignores its env; reads stdin to EOF (avoid EPIPE, HT §2.3); connects; prints exactly the reply body (`{}` → prints nothing) and exits 0. Any error (ENOENT, ECONNREFUSED, parse) → print nothing, exit 0 (silent fail-open; dialog appears for PermissionRequest, HT §5.1; the core adopts it from the screen, §4.6). Never forks, never leaves stdio open. Total budget for SessionStart < 100 ms (it delays the first model call, LC §1.4). (Rev 2: no `$CLAUDE_ENV_FILE` writes; the network restore was cut, §10 C2.)
- **`close(heldBody)`**: answer every held request with `heldBody` (the core decides `deny` on close, SEC §4.1), stop listening, unlink the socket, terminate the worker. The hook server must stay up until the pane is dead (LC rule 13); the owner-watch guarantees the pane dies when the owner process does (§3.8).

### 3.6 Input protocols (core `input-policy/*`, executed by `session/input-executor.ts`)

An **InputJob** (types normative in §2.9) is the unit of input. Exactly one job runs at a time (single writer, IN §12), so at most one submit is ever in flight (rev 2: no ack FIFO). The executor runs primitives in order per pane (TD R8) and reports `input.done`. All waits are core deadlines.

**Gate** (`gating.ts` + `selectors.ts canSubmit`, §4.13): a `submit`/`command` job may start only if `canSubmit(core)` holds (the self-test job uses the same predicate with `lifecycle === 'selfTest'`); the surface-level conditions are `!inputBlocked.copyMode` (executor runs `exitCopyMode` first, TD §9), the last frame is not torn, ≥ `dialogSettleMs` (150, TUI §0.6: dialogs ignore keys for 150 ms) since the **first** frame of the current surface (`recon.surfaceSince`, so it overlaps claim stability instead of stacking on it, §10 G26), and ≥ 1500 ms since the last `C-c`. `permissionKeys`, `interrupt`, `wakeEnter` and `dismissMenu` jobs bypass the idle/limit conditions but not the copy-mode, torn or settle rules.

**Submit (editor method, default)**:
1. `sanitizePrompt(text)` at `prompt.send` time (D-16): `NFC`, `\r\n?`→`\n`, strip `[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]` (ESC included), strip standalone invisibles (tags U+E0000–E007F; bidi U+061C, U+200E, U+200F, U+202A–202E, U+2066–2069; zero-width U+200B–200D, U+2060, U+FEFF; selectors U+FE00–FE0F, U+E0100–E01EF, U+180B–180D, U+180F — keeping ZWJ/VS16 inside emoji sequences, IN §4.6), reject lone surrogates (`isWellFormed`), trailing `\` on any line → append one space (TUI §2), **`text.trim().startsWith('/')` → `E_INPUT_REJECTED{reason:'leadingSlash'}`** (rev 2 §10 A4: Claude's submit path runs `value.trim().startsWith("/")` and then looks the trimmed name up in the command table, VERIFIED-BIN, so a leading space would still run e.g. `/permissions`; use `command()` for commands), prefix one ASCII space if `/^[!?&#]/` (IN §4.2, SEC §3.4; whether bash/memory mode also trims is UNVERIFIED → LP-45; if it does, these are rejected the same way), `mentions:'reject'` and `/(^|\s)@\S/` → `E_INPUT_REJECTED('mention')`, empty after trim → `E_INPUT_INVALID`, bytes > `maxPromptBytes` (100 000) → `E_INPUT_INVALID`. Remove the `ultra(think|code|plan|review)` hazard? **No**: user intent; documented only (TUI §3.4).
2. `waitGate` → intent `editorStage{text}` → `input.done ok` → intent `key C-g` (gap 50) → `awaitEditorConsumed{editorConsumeMs:3000}` → `input.done ok` (else `E_SUBMIT_UNCONFIRMED{step:'editor'}`, and the job falls back once to `pasteChunks`).
3. `screen.captureNow` → `verifyStaged`: composer must be non-empty and (for texts ≤ 200 chars) its normalized text must end with the last 40 normalized chars of the prompt; editor injection never shows `[Pasted text` (IN §3.1 VERIFIED-EXP). Mismatch → treat as editor failure (fallback once).
4. `settle` deadline `settleMs` (100) → `key Enter` → `awaitAck` deadline `submitAckMs` (3000, +2000 on the first prompt of a generation because SessionStart hooks hold it, IN §11).
5. Ack (rev 2 §10 A3), evaluated in this order for every `prompt.submitted` that arrives while our submit is in `enterSent|awaitAck|retryEnter`:
   1. **Self-test nonce** (armed) → self-test ack (§3.1 step 15), no Turn.
   2. **Known external shape** → external turn, never compared with ours: starts with `<task-notification>` → `task_notification`; `<scheduled…`/`wakeupSource` → `scheduled`; `<peer-message`/cross-session inbound shape → `peer_message`; `<bash-input>` → `bash_mode`. Our submit keeps waiting (its deadline is extended once by `submitAckMs`); if Claude queued our prompt into that turn the later evidence (`prompt.absorbed`, or a UPS of our text with the external turn's `prompt_id`, IN §7.3) sets our `mergedInto` (§4.4).
   3. **Match** `normalizeForAck(prompt) === normalizeForAck(sent)` where `normalizeForAck` = NFC, `\r\n?`→`\n`, strip `<pasted_content id="…">` wrappers (`/\n*<pasted_content id="[^"]+">\n/`, `/\n<\/pasted_content id="[^"]+">\n*/`), trim trailing whitespace **per line and at the end** (IN §7.2; trailing-newline/NFC/@mention/image behaviour UNVERIFIED → LP-54) → `turn.accepted`, job done.
   4. **Mismatch** → still our ack (one submit in flight, so it is ours or a human's), `turn.accepted` with `provenance.confirmed:false`, `security.alert{code:'E_INPUT_TAMPERED', detail:{sentSha256_16, gotSha256_16, editDistanceBucket}}`. Only with `security.onTamper:'interrupt'` does the core also start an interrupt job. Never interrupts by default.
   A UPS with **no** in-flight submit → external turn with the origin from rule 2; else after a usage-limit reset with no library send → `auto_continue`; else `unknown`, and `security.alert E_SECURITY_UNEXPECTED_INPUT` if no human is attached (SEC §4.7.5).
6. Ack deadline: `screen.captureNow`; composer still holds the text and attempt < `submitRetries` (1) → `retryEnter` (`key Enter`) and re-arm the deadline; composer shows an `invisibleChars` notice → `E_INPUT_INVALID('invisible')`; `unknownCommand` notice → `E_INPUT_REJECTED('slash')` (cannot happen after the leading-slash rejection; a bug); `blockedByHook` notice → `E_TURN_BLOCKED_BY_HOOK` (a user UPS hook, HT §1.2); composer empty and transcript shows a `prompt.recorded` with matching text within `hookGapMs` → accept with `channel hooks degraded{event:'UserPromptSubmit'}`; otherwise `E_SUBMIT_UNCONFIRMED{attempts, screenSummary}` and the turn ends `notSubmitted`.

**Submit (pasteChunks fallback)**: `clearComposer` job first if the composer is non-empty; then for each chunk (≤ 400 bytes, ≤ 2 LF, split on code-point boundaries) `pasteChunk` with `chunkGapMs` (30) between invocations (never in one invocation with a key, TUI §1.1, #91205); `verifyStaged` must show no `[Pasted text #` placeholder (else clear and fail `E_SUBMIT_UNCONFIRMED{step:'collapse'}`); continue at step 4. Paste stays bracketed (Claude enables 2004, TUI §1.1 VERIFIED-GH); the chunk thresholds keep it inline (IN §3.2 VERIFIED-EXP for typed chunks; for bracketed chunks UNVERIFIED → LP-09).

**Commands** (`slash.run`): name must match `^/[a-z][a-z0-9:_-]*$`; it is first **canonicalised through the profile alias table** (`/quit`→`/exit`, `/new`→`/clear`, `/reset`→`/clear`; VERIFIED-BIN rev 2: `name:"clear",…,aliases:["reset","new"]`, `name:"exit",aliases:["quit"],immediate:!0`), and allow/deny/refuse rules and completion evidence apply to the canonical name only; then the allowlist `['/clear', '/compact', '/model', '/effort', '/rename', '/context', '/cost', '/status', '/help']` (rev 2: `/rewind` removed: it opens a picker with no driving flow) minus the denylist `['/permissions', '/hooks', '/config', '/settings', '/login', '/logout', '/add-dir', '/mcp', '/sandbox', '/terminal-setup', '/install-github-app', '/plugin', '/agents', '/bashes', '/vim', '/keybindings', '/doctor', '/upgrade', '/tui', '/restart', '/resume', '/exit', '/background', '/rate-limit-options', '/usage-credits']`; others need `unsafe:true` (SEC §3.6); `/tui`, `/restart`, in-pane `/resume`, `/exit` (and therefore `/quit`: it is `immediate` and runs even while busy, LC §4.1; `close()` is the only exit path) and `/rewind` are refused even with `unsafe` (LC §10.4). `args` go through `sanitizeCommandArgs` (single line, no prefix escape). Delivery = editor stage of the exact full command line (a staged leading `/` is parsed as a command on Enter, IN §3.1) → Enter. Fallback = `typeLiteral` of the full name (never partial: the popup runs the top match, IN §4.1) after verifying the popup's top line equals the name. Completion evidence per command: `/clear` → SessionEnd(clear)+SessionStart(clear); `/compact` → PostCompact or `compact_boundary`, timeout 5 min (LC §10.2); `/model` → `model.switched` + screen result line (`saved as your default` → `session.modelChanged{savedAsDefault:true}` warning, LC §10.3); others → transcript `system:local_command` with `<command-name>` equal (TF §4.4) → `CommandResult{effect:'evidence', output: localCommand.stdout?}`, or a modal surface → phase `captureModal` (primitive `captureText{rows:'modal'}`, normalized text ≤ 16 KiB, redacted) → `CommandResult{effect:'modal', output}`, then dismissed with one `Escape` (`dismissModal`); neither within 5 s → `{effect:'none'}`. `command()` resolves with `{output}`.

**Interrupt**: not busy → `interrupt.ignored{notBusy}`. Permission held → `permission.answer deny {interrupt:true}` through the hook (aborts the turn, HT §9.1) and no key is pressed. Otherwise `key Escape` (gap 250, IN §6.1) once, `interruptConfirm` deadline 5 s; evidence = transcript interrupt marker, screen `interruptedBanner`, or Stop. No evidence → `interrupt.ignored{noEvidence}`. Never a second Escape without evidence that the first landed (double Esc on an empty box opens Rewind; on a draft it clears it, IN §6.2). Never `C-c` (second press exits), never SIGINT (exits Claude, LC rule 5).

**clearComposer**: editor stage of `''` + `C-g` (atomic replace, IN §8). Fallback: `Escape`, 300 ms, capture must show `escAgainToClear` hint, `Escape`, 300 ms, capture must show an empty composer. Never `C-u` (current line only), never `C-l` (did not clear), never `C-s` (stash merges back), never `C-c` (IN §8).

**permissionKeys** (dialogOnly path only, §3.7): deny → `Escape` (equivalent to No, OD §6). Allow → only with `screenAllow:true` and SEC §4.3 conditions; it sends the option's digit **without Enter** (digits select immediately, IN §10), then verifies the dialog is gone.

**setMode**: refuse `bypassPermissions|auto|dontAsk` without `allowDangerousModes` (`E_MODE_FORBIDDEN`). Press `BTab` once, wait 500 ms, capture, compare the footer mode, repeat ≤ 6 (IN §9). A dialog appearing after a press (auto-mode entry warning) → fail and Escape. The hook `permission_mode` of the next event confirms (transcript writes nothing, IN §9).

**wakeEnter** (usage limit `stalePressEnter`): a single `Enter` with an empty composer, verified by a following UPS or `quota_auto_resume_fired`.

**dismissMenu** (usage limit options menu): one `Escape`, verified by the menu surface disappearing within 1 s; otherwise `warning` and the wake attempt counts as failed.

### 3.7 Permission flow (core `decide/permissions.ts` + `reconcile/permission-binding.ts`, L3 `permission-broker.ts` + `path-resolver.ts`)

1. `permission.requested` (hook over unix, held) → new `PermissionRecord{state:'pending', needs}` with `needs = 'answers'` for `AskUserQuestion`, `'planApproval'` for `ExitPlanMode`, else `'decision'`; bind per §4.5.1; `inputBlocked.permission = true`; deadline `permissionPolicy` at `now + timeoutMs` (`backgroundTimeoutMs` 10 000 for background-agent requests, step 9). Policy:
   - `deny` → answer deny synchronously.
   - `dangerouslyAllowAll` → allow synchronously, **except** `needs ≠ 'decision'` (→ treated as `ask`; a plain allow on these tools does nothing, OD §1.7) and `autoAnswerAllowed:false` (→ `ask`).
   - `allowRead` → only for `toolName ∈ {Read, Glob, Grep}` (and `NotebookRead` if present) with `autoAnswerAllowed`. Core cannot touch the filesystem (D-03), so it emits **`permission.resolvePaths{permissionKey, toolName, input}`**; L3 `path-resolver.ts` evaluates and returns `permission.pathsResolved` (typically < 2 ms). Rules (rev 2 §10 G3; SEC §4.1 "realpath and refuse symlinks out of the workspace"): every path-like argument must be known — `Read.file_path`, `Glob.path`, `Glob.pattern`, `Grep.path`, `Grep.glob` (any other key with a string value that contains `/` → `unknownArg` → not inside); absolute paths are realpath'd (ENOENT → realpath of the deepest existing ancestor + the rest, which must not contain `..`), must be `cwdRealpath` or below it, and every existing component must not be a symlink that resolves outside (`symlinkOut`); `Glob.pattern` and `Grep.glob` must be relative, must not start with `/` or `~` (`absolutePattern`/`tilde`) and must not contain a `..` segment (`parentSegment`); a missing `path` means `cwd`. All inside → allow; otherwise → `ask`. Lexical checks alone are never used.
   - `ask`/`handler` → intent `host.askPermission{deadlineAt}`.
2. `autoAnswerAllowed=false` when binding is `ambiguous-agents`, `unbound`, the only candidates belong to an internal agent or a teammate, or the permission is `suspect` or `adopted` → `allowRead`/`dangerouslyAllowAll` downgrade to `ask`; `deny` stays deny (RC §5.1, §5.4).
3. Broker: runs the handler (may be async; `undefined` = ask host via the `permissionRequested` event) with an `AbortSignal` aborted on `host.cancelAsk` (record left `pending|answered`, or the policy deadline fired); result → `permission.answer{by:'handler'}`; throws/invalid → `permission.answer deny{message:'Denied: handler error'}` (SEC §4.1). The **policy timeout is the core deadline `permissionPolicy`** (rev 2 §10 G4): on fire the core answers per `onTimeout` (`'deny'` → deny; `'tui'` → `hook.respond{body:null}` = empty reply, the native dialog stays for a human; state `dialogOnly`, `permission.needsKeys`) and emits `host.cancelAsk`.
4. Core validates every decision: `updatedPermissions[*].destination` forced to `'session'`; `setMode` to `bypassPermissions|auto|dontAsk` refused unless `allowDangerousModes`; `addDirectories` refused unless `allowAddDirectories`; `updatedInput` must keep the tool shape (unknown keys dropped by Claude anyway, OD §1.7 CL 2.1.300); `message` ≤ 2 KiB, control chars stripped; never echo `permission_suggestions` as `updatedPermissions` (default destination `localSettings`, SEC §4.4). **Structured tools** (rev 2 §10 G7): `needs:'answers'` accepts only `permission.answerQuestion{answers}` (→ `allow` + `updatedInput = {...input, answers}`; `questions` echoed unchanged) or a deny; `needs:'planApproval'` accepts only `permission.approvePlan{approve, mode?, feedback?}` → approve: `allow` + `updatedInput = input` (echo; exact required shape UNVERIFIED → LP-46) + optional `updatedPermissions:[{type:'setMode', mode, destination:'session'}]` validated by the same setMode rules; reject: `deny{message: feedback ?? 'Plan rejected'}`. A plain `{behavior:'allow'}` without `updatedInput` for these tools (from a handler or `respondToPermission`) → `E_PERMISSION_INVALID{reason:'structuredAnswerRequired'}` to the caller, the request stays pending (it is **not** denied, so the host can call the right method). Other invalid decisions → `E_PERMISSION_INVALID` to the caller and deny to Claude.
5. Intent `hook.respond{hookSeq, body:{hookSpecificOutput:{hookEventName:'PermissionRequest', decision}}}` → state `answered`. The body is built only by `JSON.stringify` of that typed object (SEC §2.6).
6. Resolution needs Claude-side evidence (RC §5.2): bound tool `tool.post`/`tool.failed` (allowed), `permission.decisionRecorded` (decider), `tool.result` with `toolDenialKind`. A decider other than ours while we answered or were pending → `permission.resolved{overridden:true}` (human or stray key won). After resolution by another route while our request is still held → `hook.respond{body:null}` (release; Claude does not abort it, HT §9.2).
7. `permission.hookClosed{client_gone|timeout}` before we answered → `dialogOnly` + `permission.needsKeys`; the host may still answer: deny via `permissionKeys` Escape; allow only with `screenAllow`.
8. **Dialog adoption** (rev 2 §10 G8, replaces "only when hooks degraded"): a `permissionDialog` (or `question`/`planApproval`) claim asserted while **no** PermissionRecord of the active turn is `pending|answered|dialogOnly` for `adoptDialogMs` (500) → new record `{state:'dialogOnly', binding:'screen-only', adopted:true, hookSeq: undefined}`, `suspect` unless a `tool.pre` with the same tool name arrived within 2 s (SEC §4.6), `permission.requested{adopted:true}` + `permission.needsKeys`. This covers the forwarder failing open (ECONNREFUSED, crash, 32-held overflow) with healthy hooks. Auto-answer is never allowed for adopted records.
9. Closing: turn closed, generation ended, process exit → `abandoned` + release if held. `close()` → deny all held.
10. Background-agent requests (`agent` present, or bound to an agent with `background:true`): may be blocking-before-dialog (HT §9.2 `kWn`, UNVERIFIED → LP-21) → policy deadline `backgroundTimeoutMs` (10 000). Named policies answer them with no screen dependency, so the stability latency of §4.6 Claims never applies to them.

### 3.8 close / crash / reap (`session/lifecycle.ts`, `session/registry-store.ts`, `session/reaper.ts`, `platform/process/standalone/owner-watch.ts`)

- **State dir layout** (0700): `owners/<ownerPid>.json` `{pid, startTime, argv0, nodeVersion, libVersion, createdAt, heartbeatAt}`; `sessions/<sessionKey>.json` `{v:2, owner:{pid,startTime}, tmux:{bin, socketName, socketPath, sessionName, paneId}, claude:{pid, startTime, exe, version}, claudeSessionId, initialSessionId, transcriptPath, cwdRealpath, sessionDir, settingsFile, settingsSha256, hook:{transport, port?, socketPath}, net?:{port, pid, controlSocket}, ownerWatch:{pid}, trustKeyAddedByLibrary, permissionMode, model?, state, usageLimit?, lastEventSeq, createdAt, updatedAt}` (all paths absolute, D-38); `archive/<sessionKey>.json` (kept 7 days, for `resume` lookups and the sweep rule); `exits/<sessionKey>.log` appended by tmux; `lock` (O_EXCL, stale if holder dead or > 60 s); `lifecheck.json`; `selftest-cache.json`; `limit-captures/` (§3.9).
- **pane-died record**: `set-hook -t ccd-<key> pane-died "run-shell 'echo died pane=#{pane_id} pid=#{pane_pid} status=#{pane_dead_status} signal=#{pane_dead_signal} >> <exitsLog>'"` built from library-controlled paths only, validated `^[A-Za-z0-9/._-]+$` (LC §4.2 VERIFIED-TMUX). Detection in the owner = the 2 s `pane_dead` status poll (adapter timer A-3, §4.12) plus the screen poll (rev 2: no control-mode `%message`).
- **Owner-watch** (rev 2, D-28; §10 G1/A6): spawned detached right after the pane (§3.1 step 12) with `watch.json` (0600). Every `pollMs` (1000) it checks `kill(ownerPid,0)` and the owner's start time (`ps -o lstart= -p`), and `kill(claudePid,0)`. Claude gone → write `exits/` line `watch=claude-gone` and exit. Owner gone → re-verify the Claude pid identity (start time + `claude.exe` + session id in `ps -o command=`), `SIGTERM` it, wait ≤ 1 s for death, `SIGKILL`, then `<tmuxBin> -L <socketName> kill-server`, append `watch=owner-gone` to the exits log, exit. Normal `close()` stops it first with SIGTERM (it then exits without action). Window during which Claude can run with no hook server: ≤ `pollMs` + 1 s ≈ 2 s, versus "until the next reap" before. Its own crash leaves the reaper as the backstop.
- **close({mode:'graceful'})**: (0) if `waitForBackgroundMs` and background agents/tasks are running: wait until quiescent or the timeout (P-LIFE-22: Claude kills background work ~1.5 s after exit); (1) `session.closing`, reject new sends (`E_SESSION_CLOSED`), cancel wakes; (2) deny all held permissions; (3) idle + clean composer + no dialog → editor stage `/exit` + Enter; else `process.signal SIGTERM` to the verified pid; (4) wait `pane_dead` ≤ `closeGraceMs` 12 000 (failsafe = max(5000, 5000+5000), LC §4.1); (5) SIGTERM again, +`killAfterMs` 3000 → SIGKILL after re-verifying pid identity; (6) read `pane_dead_status`/`signal`, capture the final screen; (7) stop the owner-watch; `hooks.close(deny)`, stop the proxy (they outlive Claude, LC rule 13); (8) `tmux.kill()` (+unlink socket); (9) `unseedTrust` if we added it, remove `sessionDir` (incl. `claude-debug.log` unless `keepClaudeDebugFile`), move the registry entry to `archive/`; (10) `session.exited`. `mode:'kill'` starts at (5) with SIGKILL. There is no `detach` mode in v1 (the `Command` union does not contain it).
- **Exit handling**: `process.once('exit')` → sync best effort per live kernel (registry on `globalThis[Symbol.for('claude-code-driver.exit-registry.v1')]`): `kill(claudePid,'SIGTERM')`, `execSyncBestEffort(tmux, ['-L', sock, 'kill-server'])`; the owner-watch does the same within ≤ 2 s if this did not run (SIGKILL of the owner). Registry entries are **not** deleted there (the next reap archives them). Signal handlers only through `installSignalHandlers` (opt-in; first signal graceful `closeAll`, second forces).
- **Reaper** (module init of `start()` and `ccd lifecheck`): under the lock, for each `sessions/*.json` whose owner is dead (pid gone or start time differs): verify Claude pid identity (`ps -o lstart=,command=` matches start time and contains `claude.exe` and the session id, LC §6.3; macOS reuses pids), SIGTERM, wait ≤ 12 s, SIGKILL, `tmux -L <sock> kill-server` (one SIGHUP, LC §6.2), unlink that socket, `unseedTrust` if recorded, remove `sessionDir`, archive. **Socket sweep** (rev 2 §10 G21): only sockets whose `socketPath` is named by a `sessions/` or `archive/` entry, whose server does not answer `tmux -L <name> list-sessions` within 2 s on **two** attempts 5 s apart, are unlinked. A `ccd-*` socket in `$TMUX_TMPDIR/tmux-$UID/` with no registry entry is never touched, only counted in `lifecheck.json` (`unknownCcdSockets`) — other agents and tests use `ccd-` names (`ccd-input`, `ccd-verify-*`, `ccd-live-*`).
- **Recovery after owner death**: the owner-watch has already killed the pane. The host restarts its process and calls `ClaudeSession.start({ ..., resume: <claudeSessionId> })` (the id is in `archive/<key>.json`, `ccd lifecheck --json`, and the trace header). The resumed session replays the transcript with `replay:true`; anything that was pending at death (a held permission, a dialog) died with the pane and is not resumed (Claude's own resume semantics apply, P-LIFE-18/49/50). This replaces `attach()` (§10 G8).

### 3.9 Usage limits and wake-up (`decide/usage.ts`, `session/scheduler.ts`, `session/limit-recorder.ts`)

- **Detection (authority order)**: hook `StopFailure{error:'rate_limit'}` and `Notification{quota_auto_resume_*}` > transcript `model.apiErrorRecorded{error:'rate_limit', apiError:'usage_limit_reached', resetsAtWall}` (LC §3.1 VERIFIED-SRC, live UNVERIFIED LP-30) > screen `LIMIT_HIT` line / auto-continue lines / options menu (TUI §5.1–§5.4; templates `You've hit your ${name} · resets ${time}`, names `5-hour limit, weekly limit, Opus limit, Sonnet limit, Fable limit, usage credit limit`, plus the legacy `session limit` form) and the rate-limit retry line's `(<reset>)` form (SP §16 Q7). (Rev 2: no statusLine source.)
- **Reset-time parsing** (rev 2 §10 G27): only in L1, `profiles/claude-2.1.316/errors.ts parseResetText(text, wallAt, tz)`: forms `3pm`, `3:45pm`, `Nov 9, 4pm`, `Nov 9, 4:30pm`, optional ` (Zone/City)` suffix (explicit zone wins over `tz`); a time-only form means the next occurrence at or after `wallAt − 60 s`; result → `ScreenFacts.usageLimit.resetsAtWall` / `status.resetsAtWall`. `tz` = `env.timeZone()` passed by L3 and recorded in the trace header. Core never parses dates (ESLint bans `Date`/`Intl` in `src/core/**`).
- **State**: `usage.limit = {state:'limited', resetsAtWall, source, autoContinue:'none' (we set autoContinueAtUsageLimit:false), rearms}`; status `usageLimited`; the interrupted turn ends `failed{E_USAGE_LIMIT, resetsAt}`; `send()` while limited → queued (`whenBusy:'wait'`) or `E_USAGE_LIMIT` (`reject`).
- **Wake deadline** (`usage.autoResume:true`; rev 2 §10 G4 removes the L3 jitter): on `limited` with a known `resetsAtWall`, core computes `jitterMs = jitterMinMs + (fnv1a32(sessionKey + ':' + resetsAtWall + ':' + rearms) mod (jitterMaxMs − jitterMinMs + 1))` (deterministic, replay-stable, different per session so many sessions do not wake together) and arms the **wall** deadline `usageWake` at `nextWakeAtWall = resetsAtWall + jitterMs`, emitting `usage.wakeScheduled{atWall, attempt, jitterMs}`. Unknown `resetsAtWall` → wall deadline at `wallNow + 15 min`, re-armed until a reset time is learnt or `maxRearms` is reached. The scheduler (L3, the single decision timer) arms its timer at `min(atMono, now + usageWakeCheckMs)` whenever a wall deadline exists, so the wall condition is re-checked at least every 30 s and immediately after `clock.hostResumed` (no long `setTimeout`, LC §3.3). `wakeNow()` → `usage.wakeNow` fires the same procedure at once.
- **Wake procedure** (core, LC §3.3), on `usageWake` fire: `limited → waking`; (1) a UPS or `quota_auto_resume_fired` after `resetsAt` → `cleared`; (2) screen `stalePressEnter` → `wakeEnter` job; (3) screen `usageLimitMenu` → `dismissMenu` job (one `Escape`), then (4); (4) `canSubmit` (ignoring the limit) with the limit banner past its time → submit `resumePrompt` (`continue`) through the normal submit job (origin `auto_continue`); (5) still limited with a later reset → `waking → limited`, re-arm, `rearms++`, give up after `maxRearms` (3) with `warning E_USAGE_LIMIT`. Our UPS hook never blocks (a block would drop the continuation, LC §3.1 `continuation_dropped`).
- **Host sleep**: `clock.hostResumed` (Δwall − Δmono > 5 s) → suppress `stalled` verdicts for `hostResumeGraceMs` (30 s) and re-check wall deadlines at once (AL L-4; whether `performance.now()` pauses in macOS sleep is UNVERIFIED → LP-27, manual test M-02; both outcomes are handled because the wake is a wall deadline).
- **Testability** (rev 2 §10 G23): (a) LP-30 first tries the hidden, model-free paths seen in the binary (VERIFIED-BIN they exist; behaviour UNVERIFIED): `/mock-limits`, `/simulate-usage` (run through `command(..., {unsafe:true})` in a probe session) and `CLAUDE_MOCK_HEADERLESS_429=1` in the probe env, recording every screen/hook/transcript artefact; (b) **`limit-recorder.ts`** is always on (`debug.captureLimitFixtures:true`): it keeps an in-memory ring of the last 2 000 raw records restricted to *narrow content* — screen captures of the bottom 12 rows only, hook payloads of `StopFailure`/`Notification`/`Stop` only, transcript entries with `isApiErrorMessage` or `type:'system'` only — and on the first `usage.limited` per session, or on any screen line matching `/limit|resets|usage/i` that classified as `none`/`retryingUnparsed`, dumps it (scrubbed with the `fixtures:scrub` rules) to `stateDir/limit-captures/<wall>-<sessionKey>.ccd.jsonl` (0600) and emits `warning{reason:'limitCaptured', path}`; (c) the build-orchestrator wake job (§3.11) saves the orchestrator pane's own limit screen the same way. Real captures become replay fixtures (K-19b) via `pnpm fixtures:lint`.

### 3.10 Network channel (opt-in, narrow v1; `platform/netproxy/*`, `channels/network/*`, `core/reconcile/net-correlate.ts`)

- Refused when the user already has a proxy (`HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy`/`ALL_PROXY` set), when `NO_PROXY` covers `api.anthropic.com` or `*`, or with `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER`: channel `off`, `warning E_NETWORK_UNAVAILABLE{reason:'userProxy'|'noProxyCovers'|'proxyAuthHelper'}` (rev 2 §10 C2).
- Sidecar: `node <dist>/platform/netproxy/standalone/sidecar.js <sessionDir>/net.json` spawned detached with `sh -c 'ulimit -n 8192 2>/dev/null; exec "$0" "$@"'` wrapper (NP §1.5), listening `127.0.0.1:<random high port>`; control + event stream over `<sessionDir>/net.sock` (0700 dir, control token); lifetime: polls `kill(claudePid,0)` every 1 s, exits 5 s after Claude; `uncaughtException` logs and keeps serving (NP §4).
- CONNECT correctness (NP §1, reference `refproxy.mjs`): accumulate head to `\r\n\r\n` (≤ 16 KiB, 10 s); `pause()` the client; forward leftover bytes; IPv6 literals; reply `HTTP/1.1 200 Connection Established` only after upstream `connect`; `502`/`504` (15 s connect timeout) with the real error code logged; `allowHalfOpen:true` both sides, `pipe` both ways, meter with separate `data` listeners (never a Transform), `setNoDelay(true)`, `setKeepAlive(true,30000)`; no idle timeout below 30 min; `destroy()` the peer on close/error; RST vs FIN logged.
- Auth: `Proxy-Authorization: Basic base64("ccd:<tokenA>")` (VERIFIED on the real binary, 53/53 CONNECTs, SEC §6.1); anything else → `407` with `Proxy-Authenticate: Basic realm="ccd"`; never log the header. Absolute-form `http://` requests → `405` (rev 2).
- Target policy after DNS (connect to the checked IP): refuse `127.0.0.0/8 ::1 0.0.0.0/8 169.254.0.0/16 fe80::/10 100.64.0.0/10`, our own hook/proxy ports, and (unless `allowPrivate`) `10/8 172.16/12 192.168/16 fc00::/7`; ports default `[443]` → `403` (SEC §6.3).
- Env for Claude: `HTTPS_PROXY=https_proxy=http://ccd:<A>@127.0.0.1:<P>` (scheme required, NP §8), `HTTP_PROXY`/`http_proxy` unset, `NO_PROXY=no_proxy=127.0.0.1,localhost,::1`. Bash children inherit it; their CONNECTs are counted as non-model tunnels.
- Faults (`faults:true` only; also refused unless `NODE_ENV==='test'` or `unstable_advanced.network.faults`): `refuse`→502, `blackhole`→200 then silence, `reset:N`, `stall:N`, `slow:R`; applied only to tunnels whose host is `api.anthropic.com`; switching kills only those tunnels (NP §8). Never `platform.claude.com` (OAuth refresh, NP §0.5).
- Correlation (core): tunnel phase machine → `model.requestStarted` (transcript `api-request`, written at request start) matched to the `api.anthropic.com` tunnel whose `sending` began within ±250 ms of the entry timestamp (wall), FIFO when several; telemetry bursts with no api-request are `non-model` (NP §5.3). Liveness: `quiet` > 15 s, `stalled` > `stallMs` 25 s without down bytes during `receiving`; `awaiting` (no first byte) shows `waiting` up to 20 s then `stalled` (NP §5.4; thresholds UNVERIFIED → LP-24 calibration).
- Failure: sidecar unreachable or dead → `channel network down`, never `stalled` because the proxy is silent (NP §4.7). Claude's API now has no route (connection refused → retry banners), so the owner kills the pane with `E_NETWORK_UNAVAILABLE{reason:'sidecarDied'}` rather than restarting on the same port (rev 2: no same-port restart; SEC §6.6 squatting).

### 3.11 Build-orchestrator wake-up (WP-ORCH; `scripts/orchestrator/*`; not part of the published package)

The user asked for "a lifecheck cron that ensures that in case usage limits are reached there is something to wake up" the background build agent (relayed request; it overrides LC §14.B and the old P-LIFE-60 "out of scope"). `ccd lifecheck` only reaps library sessions; this section is about the **orchestrator** (the Claude Code session that runs the build workflows).

- **Build state file** `docs/BUILD-STATE.json` (schema `scripts/orchestrator/build-state.schema.json`), written by the orchestrator after every work-package transition and at least every 15 min while working: `{v:1, updatedAtWall, phase, currentWp?, pendingWps[], doneWps[], orchestrator:{claudeSessionId?, cwd, tmux?:{socket?:string, target:string}}, lastProgressAtWall, limit?:{resetsAtWall?, seenAtWall, source:'screen'|'self'}, wake:{lastAttemptAtWall?, attempts, lastResult?}}`. `pendingWps` empty and `phase:'done'` → the wake job uninstalls itself.
- **Layer 1, in-session** (primary): in Phase 0 the orchestrator creates a recurring Claude Code scheduled job with the `CronCreate` tool (every 30 min, prompt: "lifecheck: read docs/BUILD-STATE.json; if pendingWps is non-empty and no work package is running, resume the next one; update lastProgressAtWall"). Whether a session-scoped scheduled prompt fires after a usage-limit reset without user input is **UNVERIFIED** (LP-57), which is why layer 2 exists. It is deleted with `CronDelete` when `phase:'done'`.
- **Layer 2, external** (backstop): `scripts/orchestrator/install-wake.mjs` writes `~/Library/LaunchAgents/com.claude-code-driver.buildwake.plist` (Linux: a `systemd --user` timer or a crontab line, printed) with `StartInterval 600`, `ProgramArguments ["/bin/sh", "<stateDir>/bin/ccd-buildwake"]` (shim, same pattern as §3.12 F1) and `StandardOut/ErrPath` → `<stateDir>/buildwake.log`. `wake-check.mjs` (node:* only, idempotent, < 10 s, own lock `buildwake.lock`) each run:
  1. Read `BUILD-STATE.json`; missing or `phase:'done'` → exit (and uninstall when done).
  2. If `now − lastProgressAtWall < 20 min` → healthy, exit.
  3. If `orchestrator.tmux` is set: `tmux [-L <socket>] capture-pane -p -t <target>` (bottom 15 rows). Classify with the library's own profile strings when `dist/` exists, else the fallback regexes `/You've hit your .* · resets (.+)/`, `/usage limit/i`, `/Retrying in/`. Limit banner seen → record `limit.resetsAtWall` (parse as §3.9) and save the capture to `<stateDir>/limit-captures/orchestrator-<wall>.txt` (fixture source, §3.9 (c)).
  4. Wake condition: a limit was seen and `now ≥ resetsAtWall + 120 s` (unknown reset: `now ≥ seenAtWall + 5 h 5 min`), or no limit seen but no progress for ≥ 60 min and the pane shows an idle empty composer. Also require `now − wake.lastAttemptAtWall ≥ 15 min` and `attempts < 6` per limit episode.
  5. Wake action, in order of preference: (a) orchestrator in tmux → `tmux send-keys -t <target> Escape`, 300 ms, then paste the fixed text `continue — lifecheck wake: read docs/BUILD-STATE.json and resume the next pending work package` via `load-buffer -` + `paste-buffer -p -d` and one `Enter` (the same rules as §3.6: never `C-c`, never send while a dialog is shown, re-capture after 3 s and check the composer emptied); (b) not in tmux → post a user notification (`osascript -e 'display notification "Build paused at usage limit; reset passed" with title "claude-code-driver"'`, Linux `notify-send`) and append to `buildwake.log`. It **never** runs `claude -p` or the Agent SDK (that bills API usage, BRIEF) and never touches a tmux session it was not given in `BUILD-STATE.json`.
  6. Write `wake.{lastAttemptAtWall, attempts, lastResult}` back atomically (tmp + rename).
- **Recommended operating mode**: run the orchestrator inside tmux (`tmux new -s ccd-orch-main`) and record the target in `BUILD-STATE.json`, so layer 2 can wake it. Once the library is built, the orchestrator may be dogfooded through `ClaudeSession` itself (then the library's own usage wake applies).
- Tests: `scripts/orchestrator/wake-check.test.mjs` with a fake `tmux` on `PATH` (records argv) and fixture captures: healthy, limit-before-reset, limit-after-reset, unknown reset, dialog visible (no send), attempts cap, done → uninstall. Manual test M-03: install, put a fake BUILD-STATE with an old `lastProgressAtWall` and a `ccd-orch-test` tmux pane running `cat`, wait one interval, assert the pasted text arrived; uninstall.

### 3.12 Library lifecheck (`cli/lifecheck.ts`, `cli/launchd.ts`)

- `ccd lifecheck [--state-dir D] [--json]` (idempotent, < 5 s): uses only `runtime/node.ts createNodePorts()` + `session/reaper.ts` + `session/registry-store.ts` (allowed by §1.3; no kernel, no keys, no hook port — rev 2 §10 G19). Takes the lock; classifies each session `owned-alive | owned-hung (heartbeat > 60 s) | orphan | dead`; `dead` → finalize from `exits/`; `orphan` → reap (normally the owner-watch already did; the reaper is the backstop); `owned-hung` → log, optional `SIGUSR2` to the owner (diagnostic dump), never kill the owner; `usageLimited` sessions past their reset with a hung owner → reported (`actions[].kind:'hungWhileLimited'`), not woken. Writes `lifecheck.json {ranAt, lastRunOk, libVersion, distPath, actions[], unknownCcdSockets}`.
- `ccd lifecheck install` (rev 2 §10 F1): writes a **shim** `<stateDir>/bin/ccd-lifecheck` (0700, `/bin/sh`) that resolves at run time: node = first executable of (`$CCD_NODE` recorded in `<stateDir>/lifecheck-target.json`, `command -v node` with `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, `~/.nvm/versions/node/*/bin/node` newest ≥ 20); script = `distPath` from `lifecheck-target.json`, which **every `start()` rewrites** with its own `dist/cli/main.js` (self-healing after reinstall/upgrade/nvm switch). The plist `~/Library/LaunchAgents/com.claude-code-driver.lifecheck.plist` (0644) has `Label com.claude-code-driver.lifecheck`, `ProgramArguments ["/bin/sh", "<stateDir>/bin/ccd-lifecheck"]`, `StartInterval 300`, `EnvironmentVariables {PATH, LC_ALL:"en_US.UTF-8"}`, `StandardOutPath/StandardErrorPath` → state dir (0600); then `launchctl bootstrap gui/$UID <plist>`; `uninstall` = `launchctl bootout gui/$UID/com.claude-code-driver.lifecheck` + remove. Linux: prints a `systemd --user` timer unit pair or the line `*/5 * * * * /bin/sh <stateDir>/bin/ccd-lifecheck`. No tokens in plist/crontab/shim (SEC §10). The shim never computes runtime paths (they are absolute in the registry, D-38), so launchd's different `TMPDIR` (UNVERIFIED) does not matter.
- `ccd lifecheck status`: reports installed?, `launchctl print gui/$UID/com.claude-code-driver.lifecheck` state, `lastRunOk`, age of `ranAt` (stale > 15 min → exit 2), whether `distPath` exists. Unit tests cover plist/shim text and status classification; launchd behaviour after sleep/wake is manual test M-01 (P-LIFE-57).
- `ccd view <sessionKey>` prints (or with `--exec` runs) the read-only `tmux -L … attach -r` command; `ccd trace replay|explain <file>` unchanged.


---

## 4. State machine and reconciliation (L2 `core/*`)

### 4.1 Authority table and fact merging (`core/facts.ts`)

```ts
export const RANK: Record<Source, number> = { self: 0, clock: 0, channel: 0, screen: 1, registry: 2, network: 3, transcript: 4, hook: 5, process: 6 };
export interface Claim { key: string; value: JsonValue; firstSeenSeq: ObsSeq; stableSince: MonoMs; frames: number; expiresAt: MonoMs;
                         status: 'candidate' | 'asserted' | 'confirmed' | 'retracted' | 'expired' }
export interface Deadline { id: string; clock: 'mono' | 'wall'; at: number /* MonoMs or WallMs per clock */; kind: DeadlineKind; ref: string }
export type DeadlineKind = 'startupHookGrace' | 'startup' | 'readyStable' | 'settle' | 'submitAck' | 'editorConsume' | 'escGap' | 'keyGap'
  | 'dialogSettle' | 'interruptConfirm' | 'stopGrace' | 'lateText' | 'transcriptSettle' | 'permBindLate' | 'hookGap'
  | 'stall' | 'quiet' | 'claimTtl' | 'genImplicitConfirm' | 'interruptedHold' | 'drain' | 'hostResumeGrace'
  | 'permissionPolicy' | 'adoptDialog' | 'modalEffect' | 'usageWake' /* the only wall-clock kind */;   // §4.10 (rev 2: no runningAfterPre)
// InputJob and its phases are defined in §2.9 (file core/input-policy/jobs.ts).
```

| Fact | Authoritative (in order) | Provisional only | Notes |
|---|---|---|---|
| Turn exists, prompt text, origin | hook UPS > transcript user entry | self (job) | `promptSource`/`turnOrigin`/`origin.kind` enrich origin (TF §4.2) |
| Turn ended normally | hook Stop (with `stop_hook_active:false`) > transcript `turn_duration` | screen done line | a Stop with `stop_hook_active:true` is not an end (HT §1.2) |
| Turn ended by API error | hook StopFailure > transcript synthetic `isApiErrorMessage` | screen `API Error…` | |
| Turn ended by interrupt | transcript `[Request interrupted by user]` / `isAbortedMidStream` / `toolDenialKind` + `[… for tool use]` | screen `interruptedBanner` | no hook exists (OD §0.5) |
| Tool exists, name, input | hook Pre > transcript tool_use | — | executed input = PostToolUse `tool_input` / transcript (user hooks may rewrite, HT §1.2) |
| Tool outcome | hook Post/PostFailure > PostToolBatch > transcript tool_result | — | |
| Tool denied / interrupted | transcript tool_result > our accepted hook deny | screen `Not run · permission denied` | no hook on deny (LV Q2) |
| Permission pending | hook PermissionRequest | screen dialog with no hook record for `adoptDialogMs` (adoption, §3.7 step 8) | |
| Input requested (MCP elicitation) | hook `Notification{elicitation_dialog|elicitation_url_dialog|agent_needs_input}` | screen `dialog.kind 'elicitation'` / `unknownModal` | cleared by `elicitation_complete|elicitation_response`, the surface leaving, or an interrupt |
| Assistant text retracted | transcript `model_refusal_fallback.retractedMessageUuids`, `refusedMessageId` | — | §4.5.10 |
| Who decided a permission | transcript `permissionDecision.source` / `hook_permission_decision` | timing | race (LV Q2) |
| Agent running/stopped | hook SubagentStart/Stop > transcript subagent activity / task-notification | screen `⏺ Agent "…" finished` | |
| Model call started / attempt | transcript `api-request` | screen `attempt n/m` | hooks silent |
| Model call liveness | network | screen `↓ N tokens` | thinking label is fake (BRIEF) |
| Retry / stall banners | screen (sole source) | — | advisory: never terminates an entity |
| Text streaming | hook MessageDisplay | screen | transcript has only final text |
| Usage limit | hook StopFailure `rate_limit`, Notification `quota_auto_resume_*` > transcript synthetic `rate_limit` | screen banner/menu (with L1-parsed `resetsAtWall`) | §3.9 |
| Auth required | hook StopFailure `authentication_failed`, transcript synthetic `authentication_failed`; restored by `auth.status{loggedIn:true}` | screen `Login expired` / `Not logged in` | |
| Model | hook `PostModelSwitch` > transcript `model_refusal_fallback.fallbackModel` > SessionStart `model` | screen `/model` result line | rev 2 |
| Permission mode | hook `permission_mode` > transcript `permission-mode` (last-wins) | screen footer | transcript does not record cycling (IN §9) |
| Session id / transcript path | hook (SessionStart command, any HTTP `session_id`) | dir scan | TT §6 |
| Process exited | process (pane-died / pane_dead) | screen `Resume this session with:` | |

`mergeFact(cur, next, meta, authorityFloor, eq)` is RC §4.1 verbatim: same value → corroborate (and upgrade provisional → confirmed when a higher source agrees); different value → replace only if `rank(next) > rank(cur.src)` or same rank and newer seq; a confirmed value replaced is a conflict (counted per `(fact, srcA, srcB)` in `recon.conflicts`; sustained conflicts are a parser-drift signal); a lower rank disagreeing is kept as the old value and counted.

### 4.2 Lattices (`core/lattice.ts`)

Order (higher = later): Turn `queued 0 < submitting 1 < running 2 < stopping 3 < terminal 4`; Tool `proposed 0 < pending 1 < awaitingPermission 2 < running 3 < launched 4 < terminal 5`; Permission `pending 0 < answered 1 < dialogOnly 1 < resolved 2 = abandoned 2`; Agent `running 0 < stopped 1` with **resume** `stopped → running` allowed only on SubagentStart for the same `agent_id` (runs++); Call `started 0 < waiting|streaming|retrying|stalled 1 (mutually updatable) < ended|aborted|failed 2`. `applyStatus(cur, next, src)`: apply iff `order(next) > order(cur)`, or `cur==='unknown'` and next is concrete terminal (emit `*.resolvedLate`), or both terminal and `next` is from a strictly higher-ranked source than `cur` and `cur` was provisional (emit `claim.retracted`). Everything else is ignored + counted.

### 4.3 Session, generation, readiness (`decide/session.ts`)

| From | Input | To | Effects |
|---|---|---|---|
| (init) | — | `preflight` | |
| `preflight` | `process.launched` | `launching` | `session.launching`; deadlines `startupHookGrace` (3000), `startup` (60000); `poll.cadence screen 150` |
| `launching` | `session.started{source:startup|resume}` | `awaitingReady` | gen `g1` active (`startedBy:'SessionStart'`); `tail.observePath`; a `sessionId` other than the one we launched with → `warning{reason:'unexpectedSessionId'}` and that id is used (the token authenticated it; L1 never filters, §10 A5) |
| `launching`/`awaitingReady` | screen `surface ∈ {trustDialog, startupGate, resumeDialog?}` asserted | `gated` | `session.gated{gate}`; L3 rejects `start()` with the mapped code and kills the pane |
| `launching` | `startupHookGrace` fired, stable `main` + empty composer | `awaitingReady` | `channel.health hooks degraded{reason:'noSessionStart'}` (HT §1.4) |
| any | channel hooks `degraded{reason:'noSessionStart'}` and any authenticated hook observation (any event, any generation) | unchanged | rev 2 §10 A9: remove that reason; channel `up` when no reason is left (`channel.health hooks up{reason:'restored'}`); a late SessionStart also starts/confirms its generation |
| `awaitingReady` | stable `main` surface, empty composer, `readyStableMs` elapsed | `selfTest` | wait for `cmd selftest.run{nonce, cachedPass}` from L3 (§3.1 step 15) |
| `selfTest` | `selftest.run{cachedPass:true}` or `selfTest:'off'` | `ready` | `session.ready{selfTest:'cached'|'skipped'}` |
| `selfTest` | `selftest.run{cachedPass:false}` | `selfTest` | `hook.armSelfTest{nonce}`; on `hook.selfTestArmed` start the `selftest` job |
| `selfTest` | nonce ack (a `prompt.submitted` whose normalized text equals the nonce; consumed, **no Turn**) + composer restored + cleared + `hook.disarmSelfTest` acked | `ready` | `session.ready{selfTest:'passed'}`; cadence idle |
| `selfTest` | nonce job failed | `exited` (L3 kills) | `start()` rejects `E_SELFTEST_FAILED` |
| any pre-ready | `process.exited` | `exited` | `start()` rejects `E_STARTUP_EXITED` with final screen |
| any pre-ready | `startup` deadline | `exited` | `E_STARTUP_TIMEOUT` |
| `ready` | `session.ended{reason:'clear'}` then `session.started{source:'clear', new id}` | `ready` | old gen `ended` (closing rule 3 except drain), new gen active, `session.generationChanged{reason:'clear'}`, `tail.observePath` new path (old drains 5 s) (LV Q5) |
| `ready` | any hook with an unseen `session_id` | `ready` | gen `implicit` + deadline `genImplicitConfirm` (3000); a later SessionStart confirms (RC §7.1: command hook lags HTTP by 25–114 ms). This is the **only** place session ids are judged (L1 never rejects one). |
| `ready` | `session.started{source:'compact'}` | `ready` | **no** new generation; compaction bookkeeping only (LC §10.2) |
| `ready` | `session.started{source:'resume'|'fork'}` different id | `ready` | new gen (`reason:'resume'|'fork'`), tail `startAt:'beginning'` with replay |
| `ready` | `transcript.continuedIn` | `ready` | `session.generationChanged{reason:'continuedIn'}` pending confirmation by hooks (PA §0.7) |
| `ready` | `turn.failed{error:'authentication_failed'}` or screen `auth.kind ∈ {loginExpired, notLoggedIn, tokenRevoked}` asserted | `ready` + `auth.state='required'` | `session.authRequired`; library queue paused; intent `auth.poll{intervalMs: authPollMs}` (60 000), `auth.polling=true` |
| `ready` (`auth required`) | `auth.status{loggedIn:true}` (rev 2: its own observation, never `channel.health`) or a successful turn | `auth.state='ok'` | `session.authRestored`; intent `auth.poll{intervalMs:null}` |
| `ready` | `auth.status{apiProvider ≠ 'firstParty'}` | `closing` | `warning E_API_PROVIDER_UNSUPPORTED`; kill (billing changed under us) |
| `ready` | screen `versionTooOld` or StopFailure text match | `ready` | `warning E_CLAUDE_VERSION_TOO_OLD` + the current turn fails with it (LC §11) |
| `ready` | `cmd session.close` | `closing` | §3.8 |
| any | `process.exited` | `exited` | closing rule 4; `session.exited{reason}` (`closed` if requested, `hangup` 129, `killed` signal kill, `crashed` other non-zero, `exitedByItself` 0 unrequested) |
| any | `process.identityMismatch` (pane pid changed: `/tui`, relaunch) | `exited` | `warning`, kill pane (LC §10.4) |

### 4.4 Turn (`decide/turns.ts`)

| From | Input / condition | To | Notes |
|---|---|---|---|
| — | `cmd prompt.send` | `queued` (origin `library`) | sanitize (§3.6); `whenBusy:'reject'` and not idle → `E_BUSY`; `turn.queued` |
| `queued` | input gate open and head of `libraryQueue` | `submitting` | creates a submit job; `turn.submitting` |
| — | `prompt.submitted` with no in-flight submit, or with a known external shape (§3.6 step 5.2) | `running` | external origin (task_notification / scheduled / auto_continue / peer_message / bash_mode / unknown); `turn.queued`+`turn.accepted` emitted together; `causedBy` from `<task-id>`/`<tool-use-id>` (RC §5.5), which may name an agent of an **earlier generation** (agents are session-scoped, §4.5.4) |
| — | `prompt.submitted` / `prompt.recorded` whose text is the armed or a recently used self-test nonce | — | consumed by the self-test (§4.3); never a Turn |
| — | `prompt.recorded{bashInput:true}` | `running` (origin `bash_mode`) | turn with no UPS (IN §4.2); can only come from a human in the pane |
| — | `prompt.recorded` (not `isMeta`, unknown promptId) with no UPS within `hookGap` | `running` provisional | `channel.health hooks degraded{event:'UserPromptSubmit'}` |
| `submitting` | matching ack (§3.6 step 5) | `running` | alias promptId; `turn.accepted` |
| `submitting` | ack whose `prompt_id` equals an external running turn's promptId (Claude queued ours into it, IN §7.3), or `prompt.absorbed` with our text | `running` with `mergedInto = that turn` | rev 2 (no `absorbed` state, no `'native'`): `turn.accepted{mergedInto}`; when the host turn ends, ours ends with the **same outcome** and `endedBy:'merged'`; its tools/messages are the host turn's (`Turn.done.text` = host final text) |
| `submitting` | submit job failed | `notSubmitted` | `turn.ended{outcome:'notSubmitted', error}` |
| `running` | `turn.stopped` with `stopHookActive:false` | `stopping` | `finalText` = `last_assistant_message`; `backgroundPending` = Stop `background_tasks` ids; deadline `stopGrace` (500) |
| `running` | `turn.stopped` with `stopHookActive:true` | `running` | a user Stop hook blocked; more Stops follow (≤ 8, HT §1.2) |
| `stopping` | `stopGrace` fired or final `message.textDelta` | `completed` | `turn.ended{completed, endedBy:'stop'}`; late deltas within `lateTextMs` → `turn.textAppended` |
| `running`/`stopping` | `turn.failed` | `failed` | `error` from the StopFailure enum: `rate_limit` → `E_USAGE_LIMIT` (+ usage state), `authentication_failed`/`oauth_org_not_allowed` → `E_AUTH_REQUIRED`, others → `E_TURN_API_ERROR` |
| `running` | `turn.interrupted` (transcript) | `interrupted` (confirmed) | `marker:'tool_use'` → `endedBy:'tool_use_interrupt'` |
| `running` | screen `interruptedBanner` claim asserted | `interrupted` (provisional) | confirm by transcript within `interruptConfirm`; retract on a later Stop/PostToolUse/MessageDisplay for this turn |
| `running` | `turn.durationRecorded` and no Stop within `stopGrace` | `completed` (`endedBy:'turn_duration'`) | covers Esc-at-permission (no Stop, RC §6) and hook gaps; if a tool_use interrupt marker came first the turn is already `interrupted` |
| `running` | interrupt job sent + no output yet + `prompt.withdrawn` or composer restored with the text | `withdrawn` | RC §6; `turn.ended{outcome:'withdrawn', endedBy:'withdrawn'}` (rev 2: `TurnOutcome` has `withdrawn`) |
| `running`/`stopping` | `model.refused` for a message of this turn | unchanged | `refused = {refusedMessageId}`; retraction per §4.5.10; the turn ends by its normal Stop with `turn.ended.refused:true` (error `E_TURN_REFUSED` only if it ends `failed`) |
| `running` | `model.apiErrorRecorded` synthetic with no StopFailure within `stopGrace` | `failed` | transcript-only API error |
| any open | generation ended / `process.exited` | `unknown` (`endedBy:'session_end'|'process_exit'`) | late transcript lines of a draining generation may upgrade it (`turn.resolvedLate`) |
| terminal | any later observation carrying its promptId | unchanged | **never reopen** (RC §3.2); attach late data as enrichment or a diagnostic |
| `interrupted` (provisional) | Stop for this turn | `completed` | `claim.retracted` |

Turn attribution: main-thread observations (no `agent`) → `activeTurn`; subagent observations → the agent's spawning tool's turn via the spawn chain (RC §5.3.5); `prompt_id` is used only to bind UPS acks and to filter permission candidates, never to reopen or to attribute subagent work (RC §3.2, VERIFIED: SubagentStop carries the *current* main prompt id).

### 4.5 Correlation algorithms (`core/reconcile/*`)

**4.5.1 PermissionRequest → ToolRun** (RC §5.1; hapi rule PA §2.7): candidates = open ToolRuns in the current generation with state `pending` (rev 2 §10 A1: there is no timer transition out of `pending`, so a PermissionRequest that arrives 113 ms+ after PreToolUse (LV line 72) plus a cold forwarder still finds its tool), same `toolName`, `canonicalEq(input, pr.input)` (stableStringify equality), same agent if the request carries `agent_id`, same `promptIdAtPre` if both known; sorted by `preSeq` descending. Exactly one → `unique`. Several, all equal → bind the **oldest** unbound (FIFO), `ambiguous-equivalent` (auto-answer still allowed: same decision). Candidates from different agents → bind the single main-thread one if exactly one, `ambiguous-agents`, auto-answer off. Zero → `unbound`; bind later on a matching `tool.pre` or transcript tool_use within `permBindLate` (2000) or on `permission.decisionRecorded{via:'attachment'}` naming the toolUseId; auto-answer off while unbound. Confirmation: attachment `hook_permission_decision.toolUseID`, tool_result `permissionDecision`, or bound tool Post after our answer. Evidence of a wrong guess → `permission.rebound`. The decision is always written to the request's own HTTP/unix response, so a wrong binding can mislabel but never misapply (SEC §4.2).

**4.5.2 SubagentStart → Agent ToolRun** (RC §5.3): candidates = open `Agent` ToolRuns with no linked child whose `input.subagent_type === agent_type` (or no `subagent_type` and `general-purpose`, UNVERIFIED default), most recent first, provisional link; confirm/re-bind with PostToolUse `tool_response.agentId`, transcript `toolUseResult.agentId`, meta.json `toolUseId`, or `<task-notification><tool-use-id>`. Known `agent_id` → resume. `agent_type===''` and no candidate → `internal`.

**4.5.3 Internal ("ghost") agents** (RC §5.4, LV extra 1): a `tool.pre` with an unknown `agent_id` and no spawn candidate creates an `internal` agent and its ToolRun; it never affects main-thread status, never reopens a turn, is hidden from the facade by default, its `agent.fileMissing` is expected, and PermissionRequests whose only candidates are internal are never auto-answered. `agent.stopped` closes its open tools as `unknown`.

**4.5.4 Background agents and task notifications** (RC §5.5): `tool.post{asyncAgentId}` ends the Agent ToolRun (`launched`→`succeeded`) but **not** the agent; `Stop.background_tasks` non-empty → turn `backgroundPending`, session not quiescent; each `<task-notification>` UPS is a new external turn with `causedBy`; repeated notifications for the same agent are allowed; `SubagentStop.background_tasks` entries whose `id` is the stopping agent are ignored; background count = max(Stop `background_tasks`, `turn_duration.pendingBackgroundAgentCount`, launched-not-stopped agents). `quiescent = no active turn ∧ libraryQueue empty ∧ no running background agents/tasks ∧ no pending task notifications (queue.op enqueue without dequeue)`. **Across generations** (rev 2 §10 G13): background agents and `bgTasks` are session-scoped; a generation end (`/clear`, resume, fork) never closes them (closing rule 3 exception). Their later `SubagentStop`/`<task-notification>` (which may arrive in the new generation) closes them and creates the external turn in the **current** generation with `causedBy.agent` pointing at the old agent key. If no evidence arrives within `drainMs` after the generation end **and** the new generation's first `Stop.background_tasks`/`turn_duration.pendingBackgroundAgentCount` does not list them, they become `unknown` (not `stopped`), and leave the background count. Whether Claude delivers them after `/clear` at all is UNVERIFIED → LP-48.

**4.5.9 Teammates** (rev 2 §10 G28; agent teams unsupported in v1): an observation carrying `teammate_name` or a `background_tasks` entry with `type:'teammate'` creates/updates an `AgentRecord{kind:'teammate', background:true}` keyed by its `agent_id` (or `teammate:<name>` when absent); its tools and messages attach to that agent, never to the main thread or an internal agent; it never auto-answers permissions; first sighting → `warning E_UNSUPPORTED_FEATURE{reason:'agentTeams'}` once per session. It counts as a background task for quiescence.

**4.5.10 Refusal and logical retraction** (rev 2 §10 G12; TF §4.2 item 8, §4.4, VERIFIED corpus 2.1.316): `model.refused{refusedMessageId}` → the MessageRecord(s) with that `apiMessageId` get `retracted:true`; `model.refusalFallback{retractedMessageUuids, fallbackModel}` → every MessageRecord one of whose `uuids` is listed (and any UiMessage matched to it, §4.5.6) gets `retracted:true`, its ModelCall `refused`, and `claude.model` ← `fallbackModel` (`session.modelChanged{source:'refusalFallback'}`). Retracted text is removed from `TurnRecord.finalText` unless `Stop.last_assistant_message` later states it; one `assistant.retracted{msgKeys}` event is emitted (facade `textRetracted`). This is independent of physical tombstone rewrites (K-27). Which flows also tombstone the file is UNVERIFIED (TT open question 3) → LP-49.

**4.5.5 Parallel tools and batches** (RC §5.6): set semantics, no Pre/Post adjacency assumptions; `tool.batchDone` closes listed still-running tools with `outcomeFrom:'batch'` and marks "model call next"; transcript-first ToolRuns (`proposed`) cover validation rejections and hook gaps (deadline `hookGap`); a `message.block{tool_use}` for an already-terminal ToolRun only enriches.

**4.5.6 MessageDisplay ↔ transcript text** (RC §5.7): UiMessage keyed by `uiMessageId`, concatenated by `index` (out-of-order accepted, empty final valid); a transcript text block is matched to the earliest unmatched UiMessage of the same turn whose normalized text equals it or is a prefix; on match alias `apiMsgId` and mark confirmed; no match after settle → keep both + `text.mismatch` diagnostic; `Stop.last_assistant_message` is the authoritative final text. Never join by `message_id` (UI uuid, VERIFIED not in the file, TF §5).

**4.5.7 api-request ↔ tunnel** (NP §5.3): §3.10. Usage counted once per `(message.id, requestId)` (TF §4.3).

**4.5.8 Turn ↔ promptId for UPS acks**: FIFO by normalized text among in-flight submits (§3.6 step 5).

### 4.6 ToolRun, Permission, Agent, ModelCall, Usage, Claim transitions

**ToolRun** (`decide/tools.ts`) — RC §10.3 table is normative; summary: `(none)+tool.pre → pending` (rev 2 §10 A1: **no timer transition**; `pending` stays until a permission binds, Post/PostFailure/result, or a positive running signal; the selector `displayToolState(tool, now)` shows `running` for a `pending` tool older than 150 ms with no permission, for facades only); `(none)+message.block{tool_use} → proposed` (+`hookGap` → channel degraded); `(none)+tool.post|failed|result → terminal` (+diagnostic `post_without_pre`); `pending+permission bound → awaitingPermission`; `awaitingPermission+allow (ours or resolved) → running`, `+deny → denied` (confirmed by transcript); `post` with `async_launched` → `launched` then `succeeded`; `post → succeeded`; `failed → failed|interrupted(is_interrupt)`; `batchDone → outcome from batch`; transcript `tool.result` → `succeeded|failed|denied (toolDenialKind user-rejected or permission-rule)|interrupted (toolDenialKind interrupted or interrupted:true)`; `validationError → failed`; closing rules → `unknown`; `unknown + later post/result → concrete` (`tool.resolvedLate`). **No elapsed-time timeout ever** (RC §12).

**Permission** (`decide/permissions.ts`): §3.7 and RC §10.3; `(none)+screen permissionDialog|question|planApproval claim asserted ∧ no PermissionRecord pending|answered|dialogOnly for adoptDialogMs (500) → dialogOnly (binding 'screen-only', adopted, suspect unless a PreToolUse with the same tool arrived within 2 s)` — regardless of hook health (rev 2 §10 G8).

**PendingInput** (`decide/inputs-requested.ts`, rev 2 §10 G14): `input.requested` (hook Notification) or an asserted `dialog.kind:'elicitation'`/`unknownModal` claim lasting > 2 s while a turn is active → `pendingInputs[k]`, `inputBlocked.input=true`, `input.requested` event, screen cadence 150 ms; cleared by `input.requestCleared`, the surface returning to `main` (claim retracted/expired), an interrupt, or the turn ending → `input.cleared`. v1 never answers an elicitation programmatically; the host is told (`awaitingInput`) and may `interrupt()` or a human may answer in the pane (`ccd view`).

**Message** (`decide/messages.ts`): UiMessage keyed by `uiMessageId`, concatenated by `index`; `final` by flag, or **implicitly** (rev 2 §10 A10, `finalBy:'implicit'`) when a later `tool.pre`, `model.requestStarted`, a newer `uiMessageId` of the same turn, `turn.stopped`, or the turn's end arrives, so a lost or reordered final MessageDisplay can never pin the status to `writing`.

**Agent** (`decide/agents.ts`): RC §10.3 table; plus `agent.meta` enriches (`toolUseId` confirms the link, `spawnDepth`), `agent.fileMissing` sets `fileMissing:true` (expected for internal).

**ModelCall** (`decide/model-calls.ts`): `model.requestStarted{isRetry:false}` → new call `started` (attempts=1) under the active turn or the agent of the file (`querySource` `agent:*` / sidechain); `isRetry:true` (same `requestDigest`, `tail:[]`) → same call, `attempts++`, `retrying`; network `receiving` → `streaming`; `quiet`/`stalled` per §3.10; screen `retrying{attempt,max,retryInMs}` claim → `retrying` (provisional), `stalled` banner → `stalled` (provisional); `message.block` with `requestRef` in the call → `ended ok` (usage once); turn interrupted → `aborted`; turn failed → `failed`; turn completed → open calls `ended`. Hook channels are silent for model calls (RC §4).

**UsageLimit** (`decide/usage.ts`): §3.9; `limited → waking` on `usage.wake`; `waking → cleared` on a UPS/`quota_auto_resume_fired` after `resetsAt`; `waking → limited` (rearms++) on a new limit; `cleared` resets on a new limit.

**Claims** (`core/claims.ts`, RC §8; the single owner of screen stability, D-41): key `(claimKind, scope)`; `candidate` until seen in 2 consecutive emitted frames at least `claimMinStableMs` (100) apart, or `claimDialogStableMs` (250) for dialog/gate surfaces → `asserted` (affects derived state). L1 emits a frame only when its `frameHash` changes, so "2 frames" means the value survived one further change of the bottom region or one frame-age check on the next poll; the scheduler requests a `screen.captureNow` at `claimMinStableMs` after a candidate appears so stability never waits for the slow idle cadence. Worst-case dialog-driven latency ≈ 250 ms (claim) overlapping the 150 ms `dialogSettle` gate, instead of the old stacked ≥ 850 ms; TTL `claimTtlMs` = 2 × current screen interval + 500 after last seen → `expired`; higher-rank same meaning → `confirmed`; higher-rank contradiction → `retracted`; scope limited to model sub-phase (retrying/stalled/hooks pending), interrupted banner, startup gates/dialog surfaces, permission dialog (when hooks degraded), usage-limit/auth/version lines, composer content for submit checks, queued prompt visibility. The screen never creates or ends a Turn/ToolRun/Agent except provisional `interrupted` (§4.4). Spinner glyph, verb, elapsed, tokens and countdown digits are metrics, not claim keys (SP §10). Thinking labels never set `stalled` (SP §4.3).

### 4.7 Derived status (`core/status/derive.ts`), first match wins

1 `exited` (process exited or lifecycle `exited`) · 2 `starting` (lifecycle before `ready`, with `phase`/`gate`) · 3 `awaitingPermission` (any permission of the active turn or a linked foreground subagent in `pending|answered|dialogOnly`, including adopted ones) · 4 `awaitingInput` (rev 2: any `pendingInputs` entry) · 5 `interrupted` (active/last turn ended `interrupted` < `interruptedHoldMs` 1500 ago and no new turn) · 6 `authRequired` · 7 `usageLimited` · 8 `compacting` (between `compact.phase started` and `finished`) · 9 `runningTools` (main-thread ToolRun in `pending|running|launched` of the active turn, or a foreground (sync) subagent with a running tool) · 10 `writing` (UiMessage of the active turn with deltas and not final, explicit or implicit §4.6) · 11 `modelRequest{phase}` (active turn open; `stalled` if network idle > `stallMs` or a stall claim; `retrying` if a retry claim or `attempts>1` with no bytes since; `streaming` if down bytes in the last 2 s or screen tokens rising; else `waiting`) · 12 `idle{backgroundAgents, queued, quiescent, lastTurn}` — an API error of the last turn is `idle.lastTurn.error`, **not a status** (rev 2 §10 A8: the old sticky `apiError` status would have blocked the queue). Background agents never make main status non-idle (RC §9). `status.changed` only on deep inequality.

### 4.8 Closing rules (`core/closing.ts`), applied in order

1. Turn terminal → its main-thread ToolRuns non-terminal → `unknown` (`turn_closed`); its pending Permissions → `abandoned` (+ release if held); its open ModelCalls → `aborted` (interrupt) or `ended` (stop). Background agents launched by it are **not** closed.
2. Agent stopped → its open ToolRuns → `unknown` (`agent_stopped`).
3. Generation ended → everything open in it → `unknown`/`abandoned`, **except background agents and background tasks** (session-scoped, §4.5.4, rule 1) and except that its transcript follower keeps draining for `drainMs` (5000) and late lines may upgrade `unknown` entities of that generation.
4. Process exited → as 3 for all generations; lifecycle `exited`; all deadlines cleared except none; intents `lifecycle.finalize`.

### 4.9 Ordering and de-duplication (RC §7)

- Entities are created by whichever observation arrives first; later ones enrich. Every reducer path must be order-insensitive for causally unordered pairs (permutation property test, §6.3).
- Rev 2 (D-42, §10 A2): **no time-window de-duplication**. The L3 queue only assigns `seq`. Screen: L1 drops only consecutive identical frames, so A→B→A transitions (an identical dialog reappearing, composer empty→text→empty) always reach the core. Hooks: never de-duplicated (exactly one transport is registered per hook event, so double delivery cannot happen by construction; two identical `Stop{stop_hook_active:true}` payloads are both real). Transcript chain entries are de-duplicated by `uuid` per generation (`recon.seenUuids`), which also absorbs the full rescan after a rewrite; copies into a new session (fork/continued-in) keep the earliest. Metadata entries fold last-wins (TF §3 merge-policy table).
- Never order across channels by transcript `timestamp` (it is creation time; −16…−57 ms before PreToolUse, LV Q3); within a file by offset; across files only approximately (TT §8.4).
- Replay observations (`meta.replay`) update state silently: their events are emitted with `replayed:true`.
- Permutation property (§6.2) is restricted to pairs that do not straddle a deadline (rev 2 §10 D2); with the `runningAfterPre` timer gone and implicit message finals, the remaining deadline-sensitive pairs are listed explicitly in `test/unit/core/properties.test.ts`.

### 4.10 Deadlines (`core/deadlines.ts`), all values in `CoreConfig.timeouts`

| Kind | Default | Armed by | On fire |
|---|---|---|---|
| `startupHookGrace` | 3000 | `process.launched` | classify the screen (gate or degraded readiness); the only startup grace (rev 2 removes the "5 s") |
| `startup` | 60000 | `process.launched` | `E_STARTUP_TIMEOUT` |
| `readyStable` | 300 | stable empty composer | ready / self-test |
| `settle` | 100 | submit staged | send Enter |
| `submitAck` | 3000 (+2000 first) | Enter sent | §3.6 step 6 |
| `editorConsume` | 3000 | `C-g` sent | editor failure → fallback |
| `escGap` / `keyGap` / `dialogSettle` | 250 / 15 / 150 | key sent / first frame of a new surface | next primitive allowed |
| `interruptConfirm` | 5000 | Escape sent | `interrupt.ignored{noEvidence}` |
| `stopGrace` | 500 | Stop | turn `completed` |
| `lateText` | 500 | turn completed | stop accepting MessageDisplay for it |
| `transcriptSettle` | 5000 | turn closed | stop waiting for `turn_duration` (never an error) |
| `permBindLate` | 2000 | unbound permission | stay unbound, auto-answer off |
| `permissionPolicy` | `permissions.timeoutMs` (120 000) / `backgroundTimeoutMs` (10 000) | `permission.requested` | rev 2: answer per `onTimeout`; `host.cancelAsk` (§3.7 step 3) |
| `adoptDialog` | 500 | permission-like dialog claim asserted with no record | adopt as `dialogOnly` (§3.7 step 8) |
| `modalEffect` | 5000 | command Enter sent | `CommandResult{effect:'none'}` |
| `hookGap` | 2000 | transcript-first entity | `channel.health hooks degraded{event}`; transcript primary for that event type until a hook of that type arrives (`restored`) |
| `stall` | 25000 | no down bytes while receiving | call `stalled` |
| `quiet` | 15000 | same | call `quiet` |
| `claimTtl` | 2×interval+500 | claim seen | `claim.expired` |
| `genImplicitConfirm` | 3000 | implicit generation | diagnostic `no_session_start` (forwarder broken?) + `channel hooks degraded` |
| `interruptedHold` | 1500 | turn interrupted | status leaves `interrupted` |
| `drain` | 5000 | generation end / agent stop | stop late upgrades |
| `hostResumeGrace` | 30000 | `clock.hostResumed` | re-enable stall verdicts |
| `usageWake` (**wall** clock) | `resetsAtWall + jitterMs` (deterministic, §3.9), or `wallNow + 15 min` when the reset is unknown | `usage.limited` | `limited → waking`, wake procedure (§3.9). The scheduler re-checks wall deadlines every `usageWakeCheckMs` (30 000) and on `clock.hostResumed` |
| none | — | running tool, background agent | never time out (RC §12); a held permission times out only through `permissionPolicy` |

### 4.11 Poll cadence policy (core emits `poll.cadence`; L3 `pollers.ts` executes)

Screen: 150 ms while `starting`, `awaitingPermission`, a job is running, or within 5 s after a send; 250 ms while `modelRequest`/`runningTools`/`writing`; 1000 ms during a known retry/stall countdown; 2000 ms when `idle`; 5000 ms when `idle` and quiescent for > 60 s; `null` when `exited`. Immediate capture (`screen.captureNow`) on PermissionRequest, Stop, StopFailure, Notification, SessionStart, network tunnel error or byte stall > 15 s, and every input job step that needs it. Capture = whole visible pane, plain text, `-N`, never `-J` or `-S -`; `-e` only for the composer rows when a job needs ghost/placeholder discrimination (SP §6). Unchanged hash → no parse (SP §10). Rev 2: no registry poll (one read after launch); the auth poll runs only while `auth.state==='required'` (`auth.poll` intent, 60 s).

### 4.12 Adapter timers (closed list; rev 2 §10 G4)

Only these timers may exist outside the core's deadline table. None of them decides anything; each only produces observations or housekeeping. Any other `setTimeout`/`setInterval` in `src/**` fails the arch test `test/arch/timers.test.ts` (grep with an allowlist of files).

| Id | Where | Period | Produces |
|---|---|---|---|
| A-0 | `session/scheduler.ts` | at `nextDeadline` (mono) or ≤ `usageWakeCheckMs` while a wall deadline exists | `clock.tick` (the single **decision** timer, D-03), `clock.hostResumed` |
| A-1 | `session/lifecycle.ts` heartbeat | 10 s | `owners/<pid>.json` `heartbeatAt` (housekeeping, read only by lifecheck) |
| A-2 | `platform/tmux/pane.ts` status cache | ≤ 100 ms TTL (not a timer, a timestamp check) | `TmuxPaneDead` before input (P-TMUX-21) |
| A-3 | `session/pollers.ts` pane_dead poll | 2 s | `process.exited` (P-TMUX-37) |
| A-4 | `session/pollers.ts` screen poll | per `poll.cadence` intent | `screen.frame` |
| A-5 | `session/pollers.ts` auth poll | per `auth.poll` intent | `auth.status` |
| A-6 | `platform/fs-tail/follower.ts` | 250 ms idle / 50 ms burst | `TailEvent` |
| A-7 | `session/scheduler.ts` loop-lag monitor (`perf_hooks.monitorEventLoopDelay`, resolution 20 ms) | 5 s window | `host.loopLag` when p99 > 500 ms (→ `warning E_HOST_LOOP_LAG`; permission answers may be late) |
| A-8 | `platform/process/standalone/owner-watch.ts`, `netproxy/standalone/sidecar.ts` | 1 s | separate processes (§3.8, §3.10) |
| A-9 | `session/debug-trace.ts` flush | 250 ms | trace I/O |

### 4.13 `canSubmit(core)` (`core/selectors.ts`, rev 2 §10 A8)

The only predicate that lets the input-policy machine start a `submit` or `command` job (D-17):

```ts
export function canSubmit(c: CoreState, o: { forWake?: boolean; forSelfTest?: boolean } = {}): boolean {
  const d = c.domain;
  return (o.forSelfTest ? d.lifecycle === 'selfTest' : d.lifecycle === 'ready')
    && d.activeTurn === undefined                       // no open main-thread turn (background agents do not count)
    && c.input.current === undefined                    // one job at a time
    && !d.inputBlocked.permission && !d.inputBlocked.dialog && !d.inputBlocked.startup && !d.inputBlocked.copyMode && !d.inputBlocked.input
    && d.compacting === undefined
    && d.auth.state === 'ok'
    && (o.forWake || d.usage.limit === undefined || d.usage.limit.state === 'cleared')
    && d.exit === undefined;
}
```
A failed last turn (`idle.lastTurn.error`) never blocks it. `whenBusy:'reject'` uses the same predicate at `prompt.send` time (`E_BUSY{reason}` names the first false clause).

---

## 5. PITFALL → MITIGATION matrix

Every pitfall in the ten caveat docs has an ID. The research docs' pitfall lists are cross-referenced in §5.13 (each either maps to an ID here or gets its own). Columns: **ID** · **Pitfall** (source) · **Mitigation** (where) · **Check** (test file under `test/` or live probe `LP-nn`) · **Status**: `M` mitigated by design, `M*` mitigated but depends on an UNVERIFIED behaviour (probe listed), `A` accepted / out of scope (with reason).

### 5.1 tmux transport (`docs/caveats/tmux-driver.md`)

| ID | Pitfall (source) | Mitigation | Check | St |
|---|---|---|---|---|
| P-TMUX-01 | Bare `tmux` talks to the caller's server via `$TMUX` (TD rule 1, §1.1) | `tmux/exec.ts` always prepends `-u -L <sock> -f /dev/null`; client env has no `TMUX`/`TMUX_PANE` | test/unit/platform/tmux-exec.test.ts | M |
| P-TMUX-02 | User `~/.tmux.conf` changes keys, escape-time, history, extended-keys (rule 2) | `-f /dev/null`; library sets options in the prelude | tmux-exec.test.ts | M |
| P-TMUX-03 | Shell interpolation of commands (rule 3) | `execFile` argv only; `TmuxArg` builder | tmux-args.test.ts | M |
| P-TMUX-04 | argv element ending in `;` is eaten even without a shell (§2.2) | `escapeArg` on every non-separator element (18 edge strings from TD §2.2) | tmux-args.test.ts (table) | M |
| P-TMUX-05 | Text starting with `-` → `unknown flag` (§2.4) | `--` before positional text/argv | tmux-args.test.ts | M |
| P-TMUX-06 | argv > ~16 KB → `command too long` (§2.3) | text only via `load-buffer -` stdin; `TmuxArgTooLong` above 12 KiB | tmux.contract.test.ts | M |
| P-TMUX-07 | `paste-buffer` turns LF into CR without `-r` (§3.1) | always `-p -r -d` | tmux.contract.test.ts (rawecho bytes) | M |
| P-TMUX-08 | `-p` brackets only if the app enabled 2004; no format exposes it (§3.1) | paste only when the composer is visible (Claude enables 2004, TUI §1.1); chunks ≤2 LF so an unbracketed paste is also safe | LP-09 | M* |
| P-TMUX-09 | Commands in one invocation reach the app as one read (paste+Enter merged) (§3.4) | separate invocations + `settleMs`; never Enter in a text invocation | tmux.contract.test.ts | M |
| P-TMUX-10 | `Escape` followed by bytes → Meta chord (rule 8) | one key per invocation; `escGapMs` 250 after Escape (IN §6.1) | input-policy.test.ts, LP-02 | M |
| P-TMUX-11 | `S-Tab` sends `\t` (rule 9) | only `BTab` in `TmuxKeyName` | tmux-keys.test.ts | M |
| P-TMUX-12 | `S-Enter`/`C-Enter` == Enter (§2.1) | not in the key list; newlines only inside staged/pasted text | tmux-keys.test.ts | M |
| P-TMUX-13 | Key names case-insensitive; text without `-l` becomes keys (§2.1) | `sendKey` takes the closed enum; text never via `send-keys` without `-l --` | tmux-keys.test.ts | M |
| P-TMUX-14 | Several keys in one call arrive in one read (§2.1) | one key per invocation | tmux-pane.test.ts | M |
| P-TMUX-15 | `-t name` prefix match; `=name` needs `:`; `display-message` on a missing target exits 0 (§6) | address by `%N` from `-P -F`; existence via `list-panes -t %N` | tmux.contract.test.ts | M |
| P-TMUX-16 | Session names map `.`/`:` to `_` (§6) | names `ccd-<sessionKey>` from `[a-z0-9-]` only | tmux-args.test.ts | M |
| P-TMUX-17 | `set -g window-size manual` SIGSEGV on 3.5a (§5.3) | per-window `set -w -t <s>: window-size manual` in the same invocation; arch grep test | test/arch/no-global-window-size.test.ts | M |
| P-TMUX-18 | Default `window-size latest`: an attached/control client shrinks the window permanently (§5.2) | per-window manual; never `refresh-client -C`; only the read-only `viewCommand` attaches (rev 2: no control client) | tmux.contract.test.ts | M |
| P-TMUX-19 | Detached default size 80x24; `status` steals a row on attach (§5.1) | `-x 250 -y 80`, `status off`, verify size after spawn (R7) | tmux.contract.test.ts | M |
| P-TMUX-20 | `remain-on-exit` set later races a fast exit (rule 12) | set in the `new-session` invocation and globally in the prelude | tmux.contract.test.ts (`exit 42`) | M |
| P-TMUX-21 | `send-keys` to a dead pane exits 0 and input is lost (§7.4) | pane status cached ≤100 ms checked before every input → `TmuxPaneDead` | tmux-pane.test.ts | M |
| P-TMUX-22 | `history-limit` applies only to new windows (rule 13) | set in the `start-server ; set -g …` prelude | tmux.contract.test.ts | M |
| P-TMUX-23 | Pane gets the server's global env, not a later client's (§7.1) | one server per session started with the full child env as the client env | tmux.contract.test.ts (env dump) | M |
| P-TMUX-24 | Single-string command runs through `default-shell -c`; single-arg argv is a shell string (§7.2) | argv always ≥ 2 elements (`/usr/bin/env -u …`) | argv-builder.test.ts | M |
| P-TMUX-25 | No `-c` → pane inherits the client cwd (§7.2) | `-c <cwdRealpath>` always | tmux.contract.test.ts | M |
| P-TMUX-26 | `TMUX`/`TERM_PROGRAM` visible to Claude (§7.3) | `env -u TMUX -u TMUX_PANE` (security wins, §0.2); `TERM` from tmux `default-terminal tmux-256color` | LP-12 | M* |
| P-TMUX-27 | capture-pane: trims trailing spaces, `-J` changes line counts, tabs→spaces, `-e` re-encodes SGR, `-a` errors (§4.1) | `-p -N`, never `-J` for row logic, never match `\t`, no raw-SGR matching, `-a` never used | tmux-capture.test.ts | M |
| P-TMUX-28 | tmux vs Ink width tables disagree on glyphs (§4.1) | no column logic; rules by run length ≥ 0.5×cols; wide pane | screen-classify.test.ts | M |
| P-TMUX-29 | Capture can catch a half-drawn frame (§4.1) | torn detection + 2-capture stability in `screen/debounce.ts` | screen-debounce.test.ts | M |
| P-TMUX-30 | `capture-pane -S -` costs 13 ms / 549 KB (rule 15) | never in a loop; only in debug dumps | tmux-capture.test.ts | M |
| P-TMUX-31 | execFile ≈ 3.4–4 ms spawn per call (§4.3) | rev 2: execFile only; adaptive cadence (§4.11), hash short-circuit, hook-triggered captures; budget ≈ 4 ms × (≤ 7 captures/s busy) | perf note in tmux.contract.test.ts | M |
| P-TMUX-32 | Control client counts as attached and its size applies (§8.1) | rev 2: no control client exists (§10 C1) | — | N/A |
| P-TMUX-33 | `%output` floods the control client (§8.1) | rev 2: no control client exists (§10 C1) | — | N/A |
| P-TMUX-34 | Control-mode lines use config syntax quoting (§8.1) | rev 2: no control client; all commands via execFile argv (escapeArg) | tmux-args.test.ts | M |
| P-TMUX-35 | Control client death (§8.1) | rev 2: no control client exists (§10 C1) | — | N/A |
| P-TMUX-36 | Control client attached to a Claude session disconnects when it exits (§8.1) | rev 2: no control client, no sentinel session (§10 C1) | — | N/A |
| P-TMUX-37 | `refresh-client -B` did not report pane death (§8.1) | `pane-died` run-shell record + 2 s `pane_dead` poll (rev 2: no control-mode `%message`) | tmux.contract.test.ts | M |
| P-TMUX-38 | Socket path > 104 bytes fails (rule 18) | `-L ccd-<pid36>-<8hex>` (short); `-S` never used | tmux-exec.test.ts | M |
| P-TMUX-39 | Socket file stays after the server exits (§1.2) | `kill()` unlinks; reaper sweeps `ccd-*` with no server | reaper.test.ts | M |
| P-TMUX-40 | A server crash kills every session on it (§1.1) | one server per session (D-07) | — (design) | M |
| P-TMUX-41 | tmux missing / PATH lacks `/opt/homebrew/bin` (rule 19) | `which` + known dirs; `E_TMUX_NOT_FOUND` with hint | preflight.test.ts | M |
| P-TMUX-42 | Old tmux lacks features (§1.3) | `tmux -V` ≥ 3.2 else `E_TMUX_UNSUPPORTED`; CI matrix 3.2a/3.4/3.5a/3.6a | ci matrix | M |
| P-TMUX-43 | Parent Node dies; server and Claude live on (§1.2) | owner-watch kills Claude + server ≤ 2 s (rev 2); registry + reaper + exit handler as backstops (P-LIFE-09) | K-22, L-08 | M |
| P-TMUX-44 | Parallel execFile calls race (§9) | per-pane FIFO input queue | tmux-pane.test.ts | M |
| P-TMUX-45 | Copy mode / human attach redirects keys and capture (§9, §4.2) | `#{pane_in_mode}` in every capture; `exitCopyMode` before input; snapshots in mode ignored | K-35 | M |
| P-TMUX-46 | Mouse mode (§9) | off (default with `-f /dev/null`) | tmux-exec.test.ts | M |
| P-TMUX-47 | Focus events inject `ESC[I`/`ESC[O` (§9) | `set -g focus-events off` in the prelude | tmux.contract.test.ts | M |
| P-TMUX-48 | Passthrough / OSC 52 clipboard (§9, SEC §3.5) | `set -g allow-passthrough off`, `set -s set-clipboard off` | tmux.contract.test.ts | M |
| P-TMUX-49 | Non-UTF-8 locale under launchd/cron → `_` glyphs (§9) | `-u` + `LC_ALL` UTF-8 in client and pane env | env-builder.test.ts | M |
| P-TMUX-50 | `tmux-256color` terminfo missing on some Linux (§9) | startup `infocmp tmux-256color`; fallback `screen-256color` | preflight.test.ts (linux branch) | M* (Linux untested) |
| P-TMUX-51 | 200 KB pastes stress Ink (§9) | `maxPromptBytes` 100 000 | sanitize.test.ts | M |
| P-TMUX-52 | Lone surrogates become U+FFFD (§9) | `isWellFormed()` → `E_INPUT_INVALID` | sanitize.test.ts | M |
| P-TMUX-53 | Tab/Right accept the ghost suggestion (§9) | keys not in the enum; suggestions disabled | tmux-keys.test.ts | M |
| P-TMUX-54 | Timing-dependent tests are flaky (§9) | every delay is a core deadline on an injected clock | properties.test.ts | M |
| P-TMUX-55 | 2.1.119 regression: no submit in tmux 3.6a (§3.4) | startup self-test (D-35) fails loudly | K-01, LP-02 | M |
| P-TMUX-56 | Max window width 10000 (§5.1) | cols validated 120…1000 | config.test.ts | M |
| P-TMUX-57 | Resize mid-turn re-renders/duplicates (§5.4) | no resize API in v1 (`pane.resize` command removed) | — | M |
| P-TMUX-58 | Buffer name collisions / leaked buffers (§3.1, IN §1) | unique `ccd-<pane>-<n>` + `-d`; `delete-buffer` on failure | tmux-pane.test.ts | M |
| P-TMUX-59 | `load-buffer -` in control mode reads the command stream (§3.2) | text always through a short-lived execFile with stdin (rev 2: the only transport) | tmux-pane.test.ts | M |
| P-TMUX-60 | Reusing a socket name while the server dies → `server exited unexpectedly` (R19) | fresh socket names; wait ≤1 s for socket close after kill | tmux.contract.test.ts | M |
| P-TMUX-61 | `kill-pane/session/server` send exactly one SIGHUP (§7.4, LC §6.2) | pid recorded first; verify gone; SIGTERM→SIGKILL escalation | lifecycle.test.ts | M |
| P-TMUX-62 | Typed errors needed for crash/target/duplicate/too-long (§1.2) | `tmux/errors.ts` stderr mapper | tmux-errors.test.ts | M |

### 5.2 Input (`docs/caveats/input.md`)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-INPUT-01 | Trimmed text starting with `/` is parsed as a command; the whole prompt is dropped silently (§4.1) | prefix one ASCII space (sanitizer); ack required | sanitize.test.ts, K-06 | M |
| P-INPUT-02 | Enter with the slash popup open runs the top completion (`/cos`→`/cost`) (§4.1) | commands staged in full via editor; typed fallback verifies popup top line | K-34, LP-33 | M* |
| P-INPUT-03 | Unknown slash command: no hook, box cleared (§4.1) | allowlist; screen notice `unknownCommand` → `E_INPUT_REJECTED` | K-34 | M |
| P-INPUT-04 | `!` on an empty box → bash mode; runs locally and starts a turn with no UPS (§4.2) | prefix escape; bash-mode turns accepted from transcript (`<bash-input>`) as external human turns | sanitize.test.ts, turns.test.ts | M |
| P-INPUT-05 | `#` had a memory mode in old versions (§4.3) | none needed on 2.1.316; still prefix-escaped (harmless) | sanitize.test.ts | M |
| P-INPUT-06 | `@` opens mentions and may attach files; no known escape (§4.4) | `input.mentions:'reject'` option; documented risk | sanitize.test.ts, LP-43 | M*/A |
| P-INPUT-07 | `?` toggles help; `&` (§4.5) | prefix escape | sanitize.test.ts | M |
| P-INPUT-08 | Invisible chars: Enter sends nothing (§4.6) | strip standalone invisibles; screen notice → `E_INPUT_INVALID` | sanitize.test.ts | M |
| P-INPUT-09 | Raw control chars in `send-keys -l` act as keys (§4.6) | strip C0 except `\n\t`, DEL, C1 on every path | sanitize.test.ts | M |
| P-INPUT-10 | A typed Tab accepts autocomplete (§4.6) | editor path preserves `\t`; typed fallback only for commands (no tabs) | sanitize.test.ts | M |
| P-INPUT-11 | Trailing whitespace trimmed, leading kept (§4.7) | `normalizeForAck` right-trims only | ack-match.test.ts | M |
| P-INPUT-12 | Bracketed paste > 800 chars or > 2 LF collapses (§3.2) | editor primary; paste chunks ≤ 400 B / ≤ 2 LF | K-07, LP-09 | M |
| P-INPUT-13 | Unbracketed chunks > 800 collapse too (§3.2) | never type long text; chunking | input-policy.test.ts | M |
| P-INPUT-14 | Collapsed content arrives wrapped in `<pasted_content>` (§3.2) | wrapper stripping in `normalizeForAck` | ack-match.test.ts | M |
| P-INPUT-15 | Paste counter persists; `paste again to expand` lingers (§3.2) | composer parser ignores footer hints; placeholder detection only fails a submit | screen-classify.test.ts | M |
| P-INPUT-16 | `VISUAL` inherited by tool children (`git commit`) (§3.1) | rev 2 §10 A11: unarmed `ccd-editor` execs the user's original `$VISUAL`/`$EDITOR` (recorded 0600) with the same argv, else exits 1; `GIT_EDITOR` = user's value, else original editor, else `true` | editor.test.ts, env-builder.test.ts | M |
| P-INPUT-17 | `Ctrl+G` while busy / with a popup (§3.1) | submits only when idle with no popup; fallback on consume timeout | LP-17 | M* |
| P-INPUT-18 | Ghost suggestion indistinguishable from text (§5) | suggestions disabled (env + setting); `-e` dim check only on composer rows; ack is the truth | LP-31 | M* |
| P-INPUT-19 | Overlays above the box (`Esc again to clear`, `Draft restored`, …) (§5) | composer = lines strictly between the two rules; notices parsed as notices | screen-classify.test.ts | M |
| P-INPUT-20 | Esc+key Meta merge (§6.1) | = P-TMUX-10 | — | M |
| P-INPUT-21 | Esc Esc on an empty box opens Rewind (§6.2) | never a second Esc without the `escAgainToClear` hint; Rewind dialog → one Esc | K-13 | M |
| P-INPUT-22 | Esc while busy delivers queued messages (§6.2) | library never uses Claude's queue by default (D-17) | K-25 | M |
| P-INPUT-23 | Esc while UPS hooks run cancels the prompt (§6.2) | our UPS answers in ms; no interrupt during `submitting` | input-policy.test.ts | M |
| P-INPUT-24 | Queued message UPS reuses the in-flight prompt_id (§7.3) | rev 2: one submit in flight; ack by normalized text; a UPS with an external turn's prompt_id or `prompt.absorbed` sets `mergedInto` (§4.4); no `'native'` | K-25 | M |
| P-INPUT-25 | `dequeue` has no content (§7.3) | FIFO matching | turns.test.ts | M |
| P-INPUT-26 | No ack for local commands, invisible-char refusal, empty prompt (§7.1) | per-command completion evidence (§3.6); sanitizer rejects empty | K-34 | M |
| P-INPUT-27 | `C-u` one line, `C-l` no clear, `C-c` arms exit, `C-s` stash merges back (§8) | clear = editor `''` or Esc-hint-Esc; those keys are not in the enum | input-policy.test.ts, LP-32 | M |
| P-INPUT-28 | `Up` on the first row replaces the draft with history (§8.3) | `Up` only allowed inside a dialog job | tmux-keys.test.ts | M |
| P-INPUT-29 | Every library prompt lands in global `~/.claude/history.jsonl` (§8.3) | documented; isolating would break auth | — | A (no safe isolation; LC §1.3) |
| P-INPUT-30 | Shift+Tab cycle miscounting; transcript records no mode change (§9) | one press, footer verify, ≤ 6; confirm by next hook `permission_mode` | K-33 | M |
| P-INPUT-31 | Auto-mode entry warning dialog after BTab (§9) | dialog surface after a press → fail + Esc; dangerous modes refused by default | K-33 | M |
| P-INPUT-32 | Shift+Tab inside a permission dialog answers it (§9) | setMode gated on no dialog | gating.test.ts | M |
| P-INPUT-33 | Digit selects immediately; digit+Enter leaks (§10) | permission keys = digit only (screenAllow) or Escape; never Enter after | K-10 | M |
| P-INPUT-34 | Manual reject ends the turn like an interrupt, no Stop (§10) | turn closes on `[…for tool use]` / `turn_duration` | K-14 | M |
| P-INPUT-35 | Dialog option labels vary; "No" is not always 3 (§10) | choose by label; deny is always Escape | screen-classify.test.ts, LP-34 | M |
| P-INPUT-36 | Typing while a dialog is up routes keys to it (§10) | `inputBlocked.dialog/permission` gate (I6 invariant) | K-11 | M |
| P-INPUT-37 | User `keybindings.json` rebinds used keys (§2) | preflight `E_KEYBINDING_CONFLICT` | preflight.test.ts, LP-44 | M |
| P-INPUT-38 | Detached session came up 111x18 (§1) | = P-TMUX-18/19 | — | M |
| P-INPUT-39 | `send-keys` flags after keys are typed literally (§1) | builder emits flags first; one kind per call | tmux-args.test.ts | M |
| P-INPUT-40 | Shift+Enter submits in tmux (§1) | = P-TMUX-12 | — | M |
| P-INPUT-41 | `meta+p/o/t/w` toggles model picker/fast/thinking/workflow (§2) | Escape gap; no Meta keys in the enum | input-policy.test.ts | M |
| P-INPUT-42 | Enter right after SessionStart acts as newline (#22936) (§11, TUI §1.3) | readiness needs a stable composer + 300 ms; self-test | K-01 | M |

### 5.3 Transcript tail (`docs/caveats/transcript-tail.md`)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-TAIL-01 | File is created at the first prompt, ~20 s after SessionStart (§1) | `waiting` state, 250 ms stat poll, ENOENT is not an error | tail.contract.test.ts #1 | M |
| P-TAIL-02 | `fs.watch` on a missing path throws ENOENT (§1) | rev 2: no fs.watch at all (poll + pread, §10 C3) | — | N/A |
| P-TAIL-03 | Parent dirs missing (§1) | poll; FSEvents recursive watch armed when the dir appears | tail.contract.test.ts | M |
| P-TAIL-04 | `CLAUDE_CODE_SKIP_PROMPT_HISTORY` disables transcripts (§1) | stripped; `transcript.file missing` after UPS + 10 s → degraded | env-builder.test.ts | M |
| P-TAIL-05 | Slug paths start with `-` (shell-outs) (§1) | no shell-outs on transcript paths | — | M |
| P-TAIL-06 | Partial last line / torn read (§2) | split on 0x0A, keep remainder, `torn-tail` only at close | tail.contract.test.ts #2 | M |
| P-TAIL-07 | Crash fragment sealed as its own malformed line (§2.1, LC rule 28) | `malformed` event and continue | tail.contract.test.ts #3 | M |
| P-TAIL-08 | Node `appendFile` > 512 KiB visible half-written (§2.2) | same splitter; tests use it to fake torn writes | tail-line-splitter.test.ts | M |
| P-TAIL-09 | String concatenation per chunk is O(n²) (§2.3) | pending `Buffer[]` list | tail-line-splitter.test.ts (2 MB line perf) | M |
| P-TAIL-10 | A JSON prefix can parse (§2.3) | parse only complete lines | tail-line-splitter.test.ts | M |
| P-TAIL-11 | Trailing `\r`, leading NUL (§2.3) | strip both | tail-line-splitter.test.ts | M |
| P-TAIL-12 | 2.3 MB lines; V8 string limit (§3) | `maxLineBytes` 64 MiB then discard mode + `oversize` | tail-line-splitter.test.ts | M |
| P-TAIL-13 | Decoding raw chunks splits code points (§3) | decode per complete line | tail-line-splitter.test.ts | M |
| P-TAIL-14 | JSON.parse cost of `api-request-blob` (§3) | prefix skip for `api-request-blob`, `api-request-shape`, `file-history-snapshot` | tail-follower.test.ts | M |
| P-TAIL-15 | 100 MB catch-up starves the event loop (§3) | 1 MiB reads, `await` per read, one read in flight | tail.contract.test.ts #15 | M |
| P-TAIL-16 | kqueue coalesces, dies after rename-replace, needs an fd per file; EMFILE at 256 (§4.1) | polling is truth; ≤ 32 active followers (LRU dormant) | tail.contract.test.ts #12 | M |
| P-TAIL-17 | FSEvents reports `rename` for everything + spurious first event (§4.1) | dir watch only pokes a poll | tail-follower.test.ts | M |
| P-TAIL-18 | `fs.watchFile` default interval 5007 ms (§4.1) | own `setTimeout`+`fh.stat()` poll loop (A-6, 250 ms / 50 ms burst) | tail-follower.test.ts | M |
| P-TAIL-19 | Linux inotify ENOSPC, JS recursive emulation races, network FS no events (§4.2) | `useFsWatch:'off'` on Linux (poll + readdir 2 s) | linux CI | M* (Linux untested) |
| P-TAIL-20 | Unhandled FSWatcher `'error'` crashes Node (§4.3) | rev 2: no FSWatcher exists | — | N/A |
| P-TAIL-21 | Tombstone truncate + rewrite; size > old offset returns garbage (§5.1) | rev 2: size < offset or (dev,ino) change → `rewrite` + full rescan from 0 with `replay:true`; core uuid dedup drops already-seen entries; logical retraction is §4.5.10 | tail.contract.test.ts #4, K-27 | M |
| P-TAIL-22 | Local-GC rename-replace (new inode) (§5.2) | strip `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`; `(dev,ino)` check handles it anyway | tail.contract.test.ts #6 | M |
| P-TAIL-23 | `/cd`, worktrees move the file and `<sid>/`; EXDEV copy; `.superseded-*` (§5.3) | hold the fd; `observePath` relocation; anchor check after reopen; `CwdChanged` re-stat | tail.contract.test.ts #7/#8 | M |
| P-TAIL-24 | `/clear` appends a withdrawal to the old file (§5.4) | old follower drains 5 s | tail.contract.test.ts #9, K-17 | M |
| P-TAIL-25 | `/resume`/fork switch to files with content (§6) | `startAt:'beginning'` + `replay:true`; uuid dedupe | K-22 (resume) | M |
| P-TAIL-26 | Unrelated names in the project dir (§6) | UUID `.jsonl` regex; skip `*.superseded-*`, `*.compact.tmp.*`, `memory/` | tail-discovery.test.ts | M |
| P-TAIL-27 | Hooks blocked → path only from statusLine or a dir scan, ambiguous with other sessions (§6) | rev 2: no statusLine; dir scan accepted only when our first prompt text matches | tail-discovery.test.ts | M |
| P-TAIL-28 | Two writers on one file interleave (§7) | never resume an id held elsewhere (reap first, LC §8.2) | — | A (cannot detect; documented unsupported) |
| P-TAIL-29 | Inherited `CLAUDE_CODE_CHILD_SESSION` disables persistence (§7) | stripped + `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` | env-builder.test.ts | M |
| P-TAIL-30 | Subagent file appears ~100 ms after SubagentStart (§8.1) | `expectSubagent` on SubagentStart / PreToolUse(agent_id) / Agent Post | tail.contract.test.ts #10 | M |
| P-TAIL-31 | `.meta.json` only at finish (§8.1) | read at stop only | tail-discovery.test.ts | M |
| P-TAIL-32 | Workflow agent path not computable (§8.2) | readdir `subagents/workflows/*/` backstop | tail.contract.test.ts #10 | M |
| P-TAIL-33 | `tasks/*.output` symlink double-follow (§8.2) | dedupe by realpath (rev 2: no `(dev,ino)` ring) | tail.contract.test.ts #11 | M |
| P-TAIL-34 | Subagent file may never appear (§8.3) | `missing` after 10 s; expected for internal agents | K-18 | M |
| P-TAIL-35 | Background agents resume (§8.3) | dormant followers reactivate on growth / SubagentStart | tail-discovery.test.ts | M |
| P-TAIL-36 | No cross-file ordering (§8.4) | per-file streams; join by ids only | — | M |
| P-TAIL-37 | Transcript lags hooks up to ~2 s; `timestamp` is creation time (§9) | hooks lead; never wait for the transcript to act; `settle` never throws | K-13, properties (+2 s delay) | M |
| P-TAIL-38 | Clock skew / NTP / sleep (§10) | mono for every timer; lag only as a diagnostic | tail.contract.test.ts #14 | M |
| P-TAIL-39 | Unbounded memory in prior art (happy) (§11) | offset + anchor + ring only | tail.contract.test.ts #15 | M |
| P-TAIL-40 | `Buffer.subarray` of the read buffer retains memory (§11) | `Buffer.from` copies for pending | tail-line-splitter.test.ts | M |
| P-TAIL-41 | libuv threadpool contention with DNS/fs (§11) | one read in flight per follower; serialized catch-up | — | M |
| P-TAIL-42 | Non-object JSON / missing `type` / unknown types (§12) | `malformed{not-object}`; unknown passthrough | transcript-normalize.test.ts | M |

### 5.4 Hook injection and transport (`docs/caveats/hooks-transport.md`)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-HOOK-01 | Hooks merge with user/project/plugin hooks; identical handlers dedupe (§1.1) | per-session URL/args never identical to a user's | — | M |
| P-HOOK-02 | `--settings` content pinned at launch (§1.1) | rev 2: no reattach; the pane never outlives the owner by more than ≈ 2 s (owner-watch, §3.8), so the pinned port is never re-bound | owner-watch.contract.test.ts | M |
| P-HOOK-03 | `--settings` must be a regular file ≤ 2 MiB (§1.1) | regular file, size asserted < 64 KiB | settings-plan.test.ts | M |
| P-HOOK-04 | `disableAllHooks` true in user/project/local or managed (§1.2) | D-14 preflight; managed → hooks never arrive → `E_HOOKS_UNAVAILABLE` / degraded | preflight.test.ts, LP-11 | M |
| P-HOOK-05 | `allowManagedHooksOnly` / `strictPluginOnlyCustomization` (§1.2) | no hook within grace → degraded transcript+screen; `E_HOOKS_UNAVAILABLE` if self-test cannot see UPS | K-05 | M |
| P-HOOK-06 | `allowedHttpHookUrls` blocks our URL; helper-managed lists may not union (§1.2) | D-13; `hooks.transport:'auto'` picks `unix` when a readable layer defines `allowedHttpHookUrls` (until LP-10 confirms) or `sandbox.enabled`; an HTTP self-test failure triggers one relaunch with `unix` and is cached 24 h (§3.1 steps 7, 15) | K-05, K-37, LP-10 | M* |
| P-HOOK-07 | User PreToolUse deny/allow/updatedInput changes the flow (§1.2) | no PermissionRequest expected after every Pre; executed input from Post/transcript | tools.test.ts | M |
| P-HOOK-08 | User PermissionRequest hook races ours (§1.2) | our verdict is a proposal; decider from transcript | K-10 | M |
| P-HOOK-09 | User UPS `block` → prompt never reaches the model, no Stop (§1.2) | screen `blockedByHook` notice → `E_TURN_BLOCKED_BY_HOOK` | K-06 | M |
| P-HOOK-10 | User Stop `block` → several Stops with `stop_hook_active` (§1.2) | only `stop_hook_active:false` ends a turn; `turn_duration` fallback | K-31 | M |
| P-HOOK-11 | `--setting-sources` would drop user settings (§1.2) | never passed (forbidden in extraArgs) | argv-builder.test.ts | M |
| P-HOOK-12 | `--safe-mode`, `--bare`, `CLAUDE_CODE_SAFE_MODE`, `CLAUDE_CODE_SIMPLE` disable hooks (§1.2) | forbidden args + strip list | env-builder.test.ts | M |
| P-HOOK-13 | Sandbox routes HTTP hooks through the sandbox proxy (§1.2) | observation over HTTP may fail → self-test → unix fallback; permissions already unix | LP-38 | M* |
| P-HOOK-14 | Workspace trust gates hooks (§1.3) | trust required/seeded before launch; self-test proves delivery | K-02, LP-04 | M |
| P-HOOK-15 | SessionStart can legitimately not fire (§1.4) | readiness never requires it (screen fallback) | K-05 | M |
| P-HOOK-16 | Org settings unreadable → hook-checked tool calls fail closed (§1.4) | `hooks.preToolUse:false` switch; documented | — | M* (condition UNVERIFIED) |
| P-HOOK-17 | Settings file squatting in `/tmp`; inside cwd it is visible to the agent (§1.5) | 0700 mkdtemp outside cwd, `wx` 0600 | settings-file.test.ts | M |
| P-HOOK-18 | SessionStart/Setup do not support HTTP (§2.1, LV Q1) | command forwarder for SessionStart; Setup never registered | settings-plan.test.ts | M |
| P-HOOK-19 | HTTP hooks follow env proxies; NO_PROXY exact-host only, no CIDR (§2.2, LV Q1) | literal `127.0.0.1,localhost,::1` appended to both casings whenever any proxy var is set (D-22) | env-builder.test.ts, live L-07 | M |
| P-HOOK-20 | SSRF guard rejects private addresses; `localhost` resolver ambiguity (§2.2) | bind and URL `127.0.0.1` only | hook-server.test.ts | M |
| P-HOOK-21 | `maxRedirects:0`, whole body buffered (§2.2) | never redirect; decision bodies small | hook-server.test.ts | M |
| P-HOOK-22 | Header `$VAR` interpolation blanks credential-looking vars (§2.2) | token written literally, hex only | settings-plan.test.ts | M |
| P-HOOK-23 | Non-2xx / bad body → visible `hook error` notice (§2.2) | always 200 (403 only for forgers); constant bodies | hook-server.test.ts | M |
| P-HOOK-24 | Forwarder exiting before reading stdin → EPIPE (§2.3) | read to EOF first | forwarder.test.ts | M |
| P-HOOK-25 | Forwarder stdout becomes model context on SessionStart/UPS (§2.3) | prints nothing for SessionStart; only decision JSON for PermissionRequest | forwarder.test.ts | M |
| P-HOOK-26 | Child holding stdout stalls 10 s / "suspect capture" blocks the call (§2.3) | forwarder never forks; stdio closed on exit | forwarder.test.ts | M |
| P-HOOK-27 | Dead endpoint + non-zero exit → notices (§2.3) | swallow errors, exit 0 | forwarder.test.ts | M |
| P-HOOK-28 | Forwarder inherits proxy env (§2.3) | raw unix socket, no HTTP client | forwarder.test.ts | M |
| P-HOOK-29 | `nc` portability (§2.3) | Node forwarder via `process.execPath` | — | M |
| P-HOOK-30 | Deleted cwd changes hook cwd (§2.3) | absolute paths only | forwarder.test.ts | M |
| P-HOOK-31 | Command hooks cost ~30 ms each, serially (§3) | HTTP for observation; command only for SessionStart + PermissionRequest (rare) | — | M |
| P-HOOK-32 | Async hooks reorder edges (§3.3) | no `async` hooks | settings-plan.test.ts | M |
| P-HOOK-33 | Default timeout 600 s → a wedged library stalls Claude (§4.1) | `timeout:5` on observation hooks, 3 on MessageDisplay | settings-plan.test.ts | M |
| P-HOOK-34 | MessageDisplay/UPS/SessionStart hold rendering or the model (§4.2, §10.1) | answer before parsing; forwarder < 100 ms | hook-server.test.ts (latency) | M |
| P-HOOK-35 | PreModelSwitch timeout blocks the switch (§4.2) | never registered | settings-plan.test.ts | M |
| P-HOOK-36 | WorktreeCreate/Remove replace git behaviour (§10.3) | never registered | settings-plan.test.ts | M |
| P-HOOK-37 | `onFailure:"block"` turns a crash into blocked tools (§4.3) | never set | settings-plan.test.ts | M |
| P-HOOK-38 | Library dead: HTTP noisy, command silent; accept-and-stall costs `timeout` per event (§5.1) | short timeouts; hook server answers before core; kill pane on owner death by default | K-22 | M |
| P-HOOK-39 | Hook server liveness must not depend on the core (§5.2) | reply first; bounded queue; drop+count on overflow | hook-server.test.ts | M |
| P-HOOK-40 | Stale unix socket → EADDRINUSE/ECONNREFUSED (§5.3) | unlink before listen (our 0700 dir) | hook-server.test.ts | M |
| P-HOOK-41 | DNS rebinding (§6) | Host check, no Origin, JSON content type, no CORS | hook-server.test.ts | M |
| P-HOOK-42 | Inline `--settings '<json>'` exposes the token via `ps` (§6) | file path only | argv-builder.test.ts | M |
| P-HOOK-43 | Unix socket created 0755; path ≤ 104 bytes (§6) | 0700 dir + chmod 0600; length assert | hook-server.test.ts | M |
| P-HOOK-44 | Payloads are untrusted; session_id/event mismatch (§6) | `normalizeHook` rejects mismatches (counted), still 200 | hooks-normalize.test.ts | M |
| P-HOOK-45 | Handlers run in parallel; arrival order ≠ fire order; no seq/timestamp (§7) | stamp `hookSeq`+mono on receipt; reconcile by ids | properties.test.ts (permutations) | M |
| P-HOOK-46 | Parallel PostToolUse concurrent; PreToolUse likely concurrent (§7) | set semantics | K-12, LP-23 | M |
| P-HOOK-47 | SubagentStart/Stop repeat; Stop repeats (§7) | idempotent reducer; resume semantics | agents.test.ts | M |
| P-HOOK-48 | Large payloads; PostToolBatch duplicates outputs; Read uncapped (§8) | 64 MiB streamed cap; `ResponseRef` (hash, size, 4 KiB preview); PostToolBatch off by default | hook-server.test.ts | M |
| P-HOOK-49 | Answering 413 shows a notice and loses decisions (§8) | never 413 | hook-server.test.ts | M |
| P-HOOK-50 | Giant JSON.parse stalls other replies (§8) | rev 2: parse runs in the hook worker (§3.5), body cap 32 MiB; no extra worker | hook-server.test.ts | M |
| P-HOOK-51 | `hookEventName` required; top-level `decision` is legacy (§9.1) | typed body builder only | permissions.test.ts | M |
| P-HOOK-52 | Plain allow ignored for person-only tools; AskUserQuestion needs `updatedInput.answers` (§9.1) | `answerQuestion()` builds `updatedInput{questions, answers}`; plain allow on those tools → warning | permissions.test.ts | M |
| P-HOOK-53 | `updatedInput` re-validated against deny/ask rules (§9.1) | expect possible override; outcome from transcript | K-09 | M |
| P-HOOK-54 | `updatedPermissions` destinations write user/repo files (§9.1) | forced `session` | permissions.test.ts | M |
| P-HOOK-55 | `deny`+`interrupt:true` aborts the turn (§9.1) | explicit option only; used by `interrupt()` while held | K-13 | M |
| P-HOOK-56 | Human answers first; our request is not aborted (§9.2) | release held request on any resolution evidence | K-10, LP-08 | M |
| P-HOOK-57 | Coordinator path awaits hooks before showing a dialog (bg agents) (§9.2) | short policy timeout for agent-scoped requests (≤10 s) | LP-21 | M* |
| P-HOOK-58 | `permission_prompt` Notification only after ~6 s (§9.2) | PermissionRequest is the open signal | — | M |
| P-HOOK-59 | Sandboxed network requests fire no PermissionRequest (§9.2) | screen dialog with no hook → `dialogOnly` suspect → Escape only | K-10 | M |
| P-HOOK-60 | Node `requestTimeout` 300 s cuts long holds (§9.4) | `requestTimeout=0`, `timeout=0`; unix server has no timeout | hook-server.test.ts | M |
| P-HOOK-61 | FileChanged needs `watchPaths` (§10.3) | not registered | — | M |
| P-HOOK-62 | Debug-log diagnostics are the only way to see blocked HTTP hooks (App. B) | `debug.claudeDebugFile` opt-in; L3 greps the App. B strings on hook silence | debug notes | M |
| P-HOOK-63 | (new) Writing `allowedHttpHookUrls` when no layer defines it creates an allowlist that blocks the user's other HTTP hooks (OD §1.9) | D-13 conditional write | settings-plan.test.ts | M |
| P-HOOK-64 | (new) Command-hook PermissionRequest forwarder process may be killed by Claude on timeout/abort; held state must follow | `closed` promise from socket close → `permission.hookClosed` | forwarder.test.ts, LP-08 | M* |

### 5.5 Screen parsing (`docs/caveats/screen-parse.md`; SP §15 list 1–25 plus extras)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-SCREEN-01 | Status line assumed directly above the rule (effort/tip lines between) | walk-up with skip rules (SP §3) | screen-classify.test.ts (corpus) | M |
| P-SCREEN-02 | `✽` missing from the glyph set | `[·✢✳✶✻✽*●]` | screen-classify.test.ts | M |
| P-SCREEN-03 | `✻` treated as "spinner" (also retry/stall/done/waiting) | ordered tests STALLED→NO_RESPONSE→LOW_PRIORITY→RETRY→RETRY_TAIL→SPINNER→DONE→WAITING_BG→INTERRUPTED | screen-classify.test.ts | M |
| P-SCREEN-04 | Retry error text truncated differently each second | match the suffix; error class from network/transcript | screen-classify.test.ts | M |
| P-SCREEN-05 | Busy inferred from the spinner (absent while streaming) | footer `\S+ to interrupt` | screen-classify.test.ts (22 frames) | M |
| P-SCREEN-06 | Stale done line from an earlier turn | candidate-slot rule + `sentAt` gating + Stop authority | K-16 | M |
| P-SCREEN-07 | Placeholder/ghost read as typed text | never trust plain composer text; `-e` dim rows; UPS ack | LP-31 | M* |
| P-SCREEN-08 | Footer taken as the last line (agent panel below) | footer = line after the bottom rule | screen-classify.test.ts | M |
| P-SCREEN-09 | Slash menu `❯` mistaken for the input box | rule–❯–rule structure, last pair from the bottom | screen-classify.test.ts | M |
| P-SCREEN-10 | Torn first frame | `torn` flag + 2-capture debounce | screen-debounce.test.ts | M |
| P-SCREEN-11 | NBSP in `⎿  ` / after `❯` (LV Q4) | normalize U+00A0, U+202F, U+2007 to space | screen-normalize.test.ts | M |
| P-SCREEN-12 | Time-based thinking labels read as progress | cosmetic only; stall from bytes/banner | status-derive.test.ts | M |
| P-SCREEN-13 | Elapsed timer is per turn, keeps counting across retries | never derive request latency from it | — | M |
| P-SCREEN-14 | Narrow pane wraps/drops segments | width ≥ 120 enforced (250 default); one-line join retry | LP-35 | M |
| P-SCREEN-15 | Ambiguous-width glyphs shift columns | no column logic; rules by run length | screen-classify.test.ts | M |
| P-SCREEN-16 | `-e` SGR state across soft-wrapped lines | plain capture by default; stateful SGR tracker for composer rows | screen-normalize.test.ts | M |
| P-SCREEN-17 | OSC 8 hyperlinks leak URLs with `-e` | strip OSC before CSI | screen-normalize.test.ts | M |
| P-SCREEN-18 | Reduced motion → static `●` (collides with Linux bullet, loses liveness) | never set `prefersReducedMotion`; regex still accepts `●` | — | M |
| P-SCREEN-19 | Custom keybindings/verbs change footer/spinner text | generic `\S+ to interrupt`, any verb; `spinnerVerbs` replace | screen-classify.test.ts | M |
| P-SCREEN-20 | Fullscreen/alternate renderer layout | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`; `alternate_on` → `unsupportedRenderer` + screen degraded | K-04 | M |
| P-SCREEN-21 | Copy mode / human attached shows scrollback | `pane_in_mode` checked per capture; frames in mode ignored | K-35 | M |
| P-SCREEN-22 | Unknown modal answered blindly | classifier never acts; only allow-listed dialogs, by label, verify-then-key | K-04 | M |
| P-SCREEN-23 | Polling cost with many sessions | rev 2: execFile only; hash short-circuit, adaptive cadence, hook-triggered captures | — | M |
| P-SCREEN-24 | Version drift of strings | versioned profile; tier-A fallbacks (`retryingUnparsed`, `modal`); unknown-line telemetry; header version check → degraded | screen-classify.test.ts (histogram) | M |
| P-SCREEN-25 | Interrupted banner only matched in the status slot | also scan last ≤ 6 non-blank lines above the rule, bounded by the newest prompt echo | LP-06 | M* |
| P-SCREEN-26 | (OD §0.8) custom statusLine hides `esc to interrupt` | rev 2: no statusLine is ever injected (D-23) | — | M |
| P-SCREEN-27 | UI frozen (SIGSTOP / hang) looks like a stall | unchanged hash ≥ 3 s while the last frame was a spinner → `frozen` diagnostic (not model stall) | screen-debounce.test.ts | M |
| P-SCREEN-28 | Trust-dialog footer wording differs between sources (SP §2.4 vs TUI §4.1) | ESC_FOOTER matches both | screen-classify.test.ts | M |
| P-SCREEN-29 | Exit screen has no rules (`Resume this session with:`) | `exited` surface is corroboration only; pane_dead is truth | screen-classify.test.ts | M |
| P-SCREEN-30 | Inline overlays keep the input box (slash menu, `@` picker, survey) | candidate-line rule ignores them; survey detected specifically and disabled by env | screen-classify.test.ts | M |
| P-SCREEN-31 | Hook-error UI lines (`PreToolUse:Bash hook error`, `Stop hook error occurred · ctrl+o to see`) (LV Q1) | counted as `hookErrorLines` → hooks channel health; ignored otherwise | screen-classify.test.ts | M |
| P-SCREEN-32 | Spinner suffix `running PreToolUse hooks… 1/2` (LV extra 4) | `P_HOOKS` → `hookWait`; a long hook wait on *our* hooks is a self-health signal | screen-classify.test.ts | M |
| P-SCREEN-33 | `Pasting…` footer stuck (TUI §1.2, #98959) | > 2 s with no job → diagnostic only (paste path is fallback; editor primary) | — | M |
| P-SCREEN-34 | `✻ Waiting for N background agents to finish` is not the end for the user | `waitingBackground` status kind; turn end from hooks | screen-classify.test.ts | M |
| P-SCREEN-35 | Rule-length vs `pane_width` relation unknown (SP §16.4) | rule = run ≥ 0.5×cols; record `pane_width` in traces | LP-35 | M* |

### 5.6 Network proxy (`docs/caveats/network-proxy.md`)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-NET-01 | CONNECT header split across packets → EPIPE (§0.1) | accumulate head to `\r\n\r\n` | sidecar.test.ts (t1 case B) | M |
| P-NET-02 | Bytes in the header packet dropped (§0.1) | forward leftover | sidecar.test.ts (case C) | M |
| P-NET-03 | Half-close not honoured (§1.3) | `allowHalfOpen:true`, pipe forwards FIN | sidecar.test.ts (case D) | M |
| P-NET-04 | Flowing socket with no listener drops early bytes (§0.1) | `pause()` until piped | sidecar.test.ts | M |
| P-NET-05 | Slowloris / garbage heads (§1.1) | 16 KiB / 10 s head bound | sidecar.test.ts | M |
| P-NET-06 | IPv6 literal targets (§1.1) | strip brackets | sidecar.test.ts | M |
| P-NET-07 | Absolute-form `http://` through the proxy (§1.1) | forward (option), §0.2 | sidecar.test.ts | M |
| P-NET-08 | 200 before upstream connect / wrong error mapping (§1.1) | 200 after `connect`; 502/504; log real errno | sidecar.test.ts | M |
| P-NET-09 | Black-holed SYN looks like a 3-min model stall (§1.2) | 15 s connect timeout → 504 | sidecar.test.ts | M |
| P-NET-10 | DNS happens in the proxy (§1.2) | errors surface as 502 with errno; `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` left to the user | — | M |
| P-NET-11 | Nagle skews last-byte timing (§1.2) | `setNoDelay(true)` both sides | sidecar.test.ts | M |
| P-NET-12 | Writes without backpressure (§1.3) | `pipe`, no manual `write` in the pass path | sidecar.test.ts | M |
| P-NET-13 | A meter bug stops bytes (§1.3) | meter in separate `data` listeners, try/catch | sidecar.test.ts | M |
| P-NET-14 | Idle tunnel cutoffs; upstream FIN on idle is normal (§1.4) | no idle timeout < 30 min; FIN not an error | sidecar.test.ts | M |
| P-NET-15 | Fault switching kills tool tunnels (§1.4, §8) | kill only token-A tunnels to `api.anthropic.com` | sidecar.test.ts | M |
| P-NET-16 | EMFILE at launchd soft limit 256 (§1.5) | `ulimit -n 8192` wrapper; per-token tunnel cap | sidecar.test.ts | M |
| P-NET-17 | TLS MITM breaks Claude (§2) | never terminate TLS | — | M |
| P-NET-18 | A future HTTP/2 ALPN multiplexes tunnels (§2) | log ALPN; if `h2` offered → correlation `confirmed:false` only, records-based | LP-24 | M* |
| P-NET-19 | Tunnel ≠ request (pooling) (§0.3) | bursts on tunnels + api-request join (§3.10) | net-correlate.test.ts | M |
| P-NET-20 | `api.anthropic.com` carries telemetry/flags/usage (§0.4) | bursts without api-request = `non-model`, never drive status | net-correlate.test.ts | M |
| P-NET-21 | OAuth refresh at `platform.claude.com` (§0.5) | never faulted | sidecar.test.ts | M |
| P-NET-22 | Loopback not bypassed except via NO_PROXY (§0.7) | D-22 | env-builder.test.ts | M |
| P-NET-23 | Proxy death = session outage; env read once (§0.8, §4) | detached sidecar bound to Claude pid; rev 2: sidecar death → pane killed with `E_NETWORK_UNAVAILABLE{sidecarDied}` (no same-port restart, squatting) | net.contract.test.ts, live L-11 | M |
| P-NET-24 | Restart RSTs streams; partial output not retried (§4) | no deliberate restart during a token-A burst | sidecar.test.ts | M |
| P-NET-25 | Port race on restart (§4.4) | random high port; port taken → kill pane (SEC §6.6) | lifecycle.test.ts | M |
| P-NET-26 | Bash children inherit our proxy (§7, LV Q7) | rev 2: accepted: Bash children use our pass-through proxy (counted non-model); no `$CLAUDE_ENV_FILE` restore (§10 C2) | sidecar.test.ts | A |
| P-NET-27 | MCP stdio, hooks, statusLine still inherit (§7) | proxy stays a correct pass-through; faults keyed on host `api.anthropic.com` | sidecar.test.ts | M |
| P-NET-28 | SSE ping cadence unknown (§5.4) | thresholds quiet 15 s / stalled 25 s, calibrated by LP-24 | LP-24 | M* |
| P-NET-29 | 22-byte terminator heuristic unverified on SSE (§2) | used only as `confirmed:false` hint | LP-24 | M* |
| P-NET-30 | Subagent api-request location unknown (§5.3.6) | unmatched bursts during subagent runs attributed to "some subagent" | LP-26 | M* |
| P-NET-31 | User proxy chaining, lowercase precedence, NO_PROXY semantics (§6) | rev 2: a user proxy turns the channel off (`warning E_NETWORK_UNAVAILABLE{reason:'userProxy'}`); no chaining | env-builder.test.ts | M |
| P-NET-32 | User NO_PROXY covers `api.anthropic.com` or `*` (§6) | channel `off` + warning | env-builder.test.ts | M |
| P-NET-33 | `proxyAuthHelper` collides with token-in-URL (§6, SEC §6.2) | refuse the channel unless `allowUnauthenticatedProxy` | env-builder.test.ts | M |
| P-NET-34 | SOCKS upstream unsupported (§6) | rev 2: any user proxy incl. `ALL_PROXY` → channel off; `ALL_PROXY` passed through for children | env-builder.test.ts | M |
| P-NET-35 | PAC / system proxy ignored by Claude (§6) | same as Claude: env only | — | A (matches Claude's behaviour) |
| P-NET-36 | Upstream 407/403 misattributed to our proxy (§6) | rev 2: no upstream exists | — | N/A |
| P-NET-37 | Proxy URL without scheme aborts launch (§8) | build with `new URL()`, assert `.host` | env-builder.test.ts | M |
| P-NET-38 | `/status` shows our proxy URL (§8) | documented | — | A (cosmetic) |
| P-NET-39 | `ANTHROPIC_UNIX_SOCKET` is not an option (§8) | stripped; never used | env-builder.test.ts | M |
| P-NET-40 | `--bg`/daemon inherits our proxy (§8, PA T5) | never `--bg`, never `claude agents` from a proxied session | argv-builder.test.ts | M |
| P-NET-41 | Proxy vars in the tmux server env leak to later panes (§8) | one server per session | — | M |
| P-NET-42 | Host sleep looks like a stall (§8) | `clock.hostResumed` grace | K-21 | M |
| P-NET-43 | Sandbox Bash uses its own proxy (§7) | documented; no faults expected there | LP-38 | A (sandbox users: channel is observation only) |
| P-NET-44 | curl ignores uppercase `HTTP_PROXY` (§7) | informational; restore sets both casings | — | M |
| P-NET-45 | Changing `HTTPS_PROXY` mid-session via `env` block (§4.6) | not relied on | — | A (unprobed escape hatch) |

### 5.7 Process and session lifecycle (`docs/caveats/lifecycle.md`)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-LIFE-01 | Trust dialog defaults to `No, exit`; no hooks/statusLine without trust (r1) | D-19; never press keys on it | K-02 | M |
| P-LIFE-02 | Onboarding/login screens (r2) | preflight `hasCompletedOnboarding`, `auth status` | preflight.test.ts | M |
| P-LIFE-03 | Readiness definition; missing SessionStart = gate (r3) | §3.1 step 14 | K-01, K-04, K-05 | M |
| P-LIFE-04 | Enter before readiness lands on a dialog (r4) | no input before `ready` (self-test is the first) | K-02 | M |
| P-LIFE-05 | SIGINT to Claude exits it (r5) | interrupt = Escape; SIGINT never sent | input-policy.test.ts | M |
| P-LIFE-06 | Exit codes 0/1/129/143/kill (r6) | mapped in `session.exited.reason` | lifecycle.test.ts | M |
| P-LIFE-07 | Close sequence vs Claude failsafe (r7) | §3.8 (12 s + 3 s) | K-29 | M |
| P-LIFE-08 | SIGKILL during OAuth refresh → sign-out risk (r8) | SIGTERM first, generous grace; preflight `auth status` never killed early | K-29 | M |
| P-LIFE-09 | Library death leaves Claude running; dialogs block forever; proxy gone (r9) | rev 2: owner-watch (≤ 2 s), exit handler, registry + reaper (reap is the only mode) | K-22, L-08 | M |
| P-LIFE-10 | Need a registry/pidfile (r10) | §3.8 layout | registry-store.test.ts | M |
| P-LIFE-11 | Single SIGHUP; survivor reparented to launchd (r11) | verify pid gone, escalate | lifecycle.test.ts | M |
| P-LIFE-12 | Exits while the library is down (r12) | `pane-died` run-shell → `exits/*.log` | tmux.contract.test.ts | M |
| P-LIFE-13 | Hook server/proxy must outlive the pane (r13) | close order (§3.8 step 7 after 4–6) | K-29 | M |
| P-LIFE-14 | Usage limit is a state with a reset time (r14) | §3.9 | K-19 | M |
| P-LIFE-15 | Own the wake-up; detached auto-continue fails; stale needs Enter; `setTimeout` drifts (r15) | core wall deadline `usageWake` with deterministic jitter, re-checked every 30 s and on host resume (§3.9); `wakeEnter`/`dismissMenu`; lifecheck only reaps | K-19, K-21 | M |
| P-LIFE-16 | Auth expiry (r16) | `authRequired`, 60 s `auth status` poll, auto-restore | K-28 | M |
| P-LIFE-17 | Resume does not restore `--settings`, mode, model (r17) | argv-builder passes them again | argv-builder.test.ts | M |
| P-LIFE-18 | Resume while the original lives forks a copy (r18) | reap our own holders first; preflight `registry.scan()` refuses a live non-library holder with `E_SESSION_ID_IN_USE` (§3.1 step 7); compare SessionStart id → `forkedFrom` warning | K-38, LP-55 | M |
| P-LIFE-19 | `Resume this conversation?` dialog, default may be "new" (r19) | `resumeDialog` surface → choose `Resume` by label with verify (allow-listed dialog) or fail `E_STARTUP_GATE` | LP-20 | M* |
| P-LIFE-20 | `/clear` new id; `/compact` SessionStart(compact) is not a new session (r20) | §4.3 table | K-17 | M |
| P-LIFE-21 | Idle is not stable: unsolicited turns (r21) | external turns with origin; quiescence separate from idle | K-18 | M |
| P-LIFE-22 | Stop ≠ nothing running; background killed 1.5 s after exit (r22) | `background_tasks` tracking; `close({waitForBackgroundMs})` (Command `session.close.waitForBackgroundMs`, §3.8 step 0) | K-18, K-29 | M |
| P-LIFE-23 | `/model` may save the user's default; PreModelSwitch (r23) | prefer `--model`; parse result line; never register PreModelSwitch | commands.test.ts | M |
| P-LIFE-24 | Update surfaces remain with DISABLE_AUTOUPDATER (r24) | `DISABLE_UPDATES=1`, `DISABLE_INSTALLATION_CHECKS=1`; What's-new / version-too-old classified | env-builder.test.ts | M |
| P-LIFE-25 | Keychain account = `$USER` (r25) | `USER`, `HOME` mandatory in env | env-builder.test.ts | M |
| P-LIFE-26 | Custom `CLAUDE_CONFIG_DIR` = different keychain item (r26) | never introduced; kept only if the user already has it | env-builder.test.ts | M |
| P-LIFE-27 | `~/.claude.json` concurrent writers, mode bits, never drop keys; invalid JSON blocks (r27) | single-key atomic merge from a fresh read, mode preserved | claude-config.test.ts | M |
| P-LIFE-28 | Crash-truncated last line then appended lines (r28) | = P-TAIL-07 | — | M |
| P-LIFE-29 | Signal handling must be opt-in (r29) | `installSignalHandlers()` | lifecycle.test.ts | M |
| P-LIFE-30 | Lifecheck must run outside Node (r30) | `ccd lifecheck` LaunchAgent | lifecheck.test.ts | M |
| P-LIFE-31 | Settings Error dialog: `Fix with Claude` first (costs usage) (§1.1) | our settings validated; gate → fail, never Enter | K-04, LP-03 | M |
| P-LIFE-32 | Custom API key dialog (§1.1) | `ANTHROPIC_API_KEY` stripped | env-builder.test.ts | M |
| P-LIFE-33 | Bypass warning dialog (§1.1) | bypass modes forbidden at launch | argv-builder.test.ts | M |
| P-LIFE-34 | Project MCP approval dialog (§1.1) | gate → `E_STARTUP_GATE{mcpApproval}`; `security.mcp:'strict'` passes `--strict-mcp-config` | LP-03 | M* |
| P-LIFE-35 | External CLAUDE.md imports dialog (§1.1) | gate → fail | K-04 | M |
| P-LIFE-36 | Fullscreen renderer offer relaunches (§1.1) | renderer pinned by env | LP-03 | M |
| P-LIFE-37 | `Session ID … is already in use.` (§1.1, §8.1) | fresh UUID; never `--session-id` with `--resume` | argv-builder.test.ts | M |
| P-LIFE-38 | `auth status` killed mid-refresh → sign-out (§1.3) | 10 s timeout, `killOnTimeout:false` | claude-binary.test.ts | M |
| P-LIFE-39 | Startup failures before any UI (§1.5) | `remain-on-exit` final screen mapped to codes | K-04 | M |
| P-LIFE-40 | Org min/max version policy (§1.5) | `E_VERSION_POLICY` with text | K-04 | M |
| P-LIFE-41 | Refresh-lock contention when several sessions start (§2) | 1.5 s stagger; transient `refreshLock` auth kind → 60 s backoff, not `authRequired` | K-28 | M |
| P-LIFE-42 | `CLAUDE_CODE_RETRY_WATCHDOG` makes a limit look like a long call (§3.2) | stripped by default | env-builder.test.ts | M |
| P-LIFE-43 | Auto-continue cancelled by manual submit/Esc/`/clear`/`/tui`/exit; a blocking UPS hook drops the continuation (§3.1) | builtin auto-continue off; our UPS never blocks (except the self-test nonce) | hook-server.test.ts | M |
| P-LIFE-44 | macOS pid reuse (§6.3) | identity = start time + command contains `claude.exe` and our id | lifecycle.test.ts | M |
| P-LIFE-45 | Never touch other tmux servers (§6.3) | `ccd-` prefix **and** registry entry required | reaper.test.ts | M |
| P-LIFE-46 | `/exit` inside a worktree prompts keep/remove (§5.1) | fallback to SIGTERM when a dialog appears after `/exit` | K-29 | M |
| P-LIFE-47 | `.bin/claude` shim runs `uname` and makes `pane_pid` sh (§5.2) | launch `claude.exe` | claude-binary.test.ts | M |
| P-LIFE-48 | `--resume` of a never-prompted session: not found (§8.1) | `E_RESUME_NOT_FOUND`; offer fresh start | K-04 | M |
| P-LIFE-49 | #91530 `--resume` exits in a fresh pane (§8.3) | pane dead < 3 s after a resume launch → one retry after 500 ms settle | LP-19 | M* |
| P-LIFE-50 | Resume cost (prompt cache expired) (§8.3) | rev 2: documented; `session.ready.resumed:true` tells the host; the first turn's usage shows the cost (no payload extension) | — | A |
| P-LIFE-51 | Background work dies with the process; resume shows only a note (§4.3) | documented; `close()` warns when `background_tasks` non-empty | — | M |
| P-LIFE-52 | `/tui`, `/restart` relaunch (new pid) (§10.4) | refused commands; pid change → `identityMismatch` | K-34 | M |
| P-LIFE-53 | In-pane `/resume` unsupported (§10.4) | refused; use close + `start({resume})` | K-34 | M |
| P-LIFE-54 | Compaction can take > 90 s and look like a stall (§10.2) | `compacting` status outranks `modelRequest` | status-derive.test.ts | M |
| P-LIFE-55 | `DISABLE_COMPACT` → `Prompt is too long` (§10.2) | not set by us; surfaced as an API error | — | M |
| P-LIFE-56 | Env hygiene list (§12) | §3.2 strip list | env-builder.test.ts | M |
| P-LIFE-57 | cron misses runs during sleep (§14) | LaunchAgent `StartInterval` + core wall deadline (§3.9) + shim/`lastRunOk`/`ccd lifecheck status` (§3.12) | manual M-01 | M* (launchd post-wake behaviour UNVERIFIED) |
| P-LIFE-58 | Owner alive but hung (§14) | `owned-hung` classification, never killed | lifecheck.test.ts | M |
| P-LIFE-59 | Server-side `claude_code_version_too_old` (§11) | `E_CLAUDE_VERSION_TOO_OLD` fatal and loud | K-04 | M |
| P-LIFE-60 | The *build orchestration* wake-up cron (§14.B) | rev 2: **in scope** (user request): WP-ORCH two-layer wake (CronCreate job + launchd `buildwake` that pastes `continue` into the orchestrator's tmux pane after `resetsAt`, or notifies) (§3.11) | wake-check.test.mjs, manual M-03 | M |
| P-LIFE-61 | `What's new` summary via shared `lastReleaseNotesSeen` (§11) | `startupGate{other}` if modal; documented | LP-03 | M* |

### 5.8 Reconciliation / state machine (`docs/caveats/reconciliation.md`, §13 checklist 1–20 plus body)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-REC-01 | `prompt_id` taken as the cause (SubagentStop, ghosts, SessionEnd) | attribution via the spawn graph; prompt_id never reopens | K-18 | M |
| P-REC-02 | Expecting Stop on every turn end | interrupt markers / `turn_duration` closers | K-13, K-14 | M |
| P-REC-03 | Expecting `turn_duration` on every end (plain Esc writes none) | transcript marker or provisional banner; `transcriptSettle` never errors | K-13 | M |
| P-REC-04 | PermissionRequest matched by time alone | §4.5.1 | K-12 | M |
| P-REC-05 | Hook answer assumed to decide | Claude-side evidence required | K-10 | M |
| P-REC-06 | Closing a background Agent with its tool call | `async_launched` ends the tool only | K-18 | M |
| P-REC-07 | Session "done" on Stop with `background_tasks` | quiescence separate | K-18 | M |
| P-REC-08 | SubagentStop `background_tasks` lists the stopping agent | ignore self entries | agents.test.ts | M |
| P-REC-09 | Joining MessageDisplay `message_id` to the transcript | text match only | K-26 | M |
| P-REC-10 | Ordering by transcript `timestamp` | offset/seq only | properties.test.ts | M |
| P-REC-11 | Late low-rank observation moves state backwards | lattices + fact ranks | properties.test.ts | M |
| P-REC-12 | Screen creates/ends entities | claim scope rules (§4.6) | claims.test.ts | M |
| P-REC-13 | Thinking label as liveness | never | status-derive.test.ts | M |
| P-REC-14 | Long tool timed out into `failed` | no tool timeouts | tools.test.ts | M |
| P-REC-15 | Reopening a stopped turn on a late prompt_id | never reopen | turns.test.ts | M |
| P-REC-16 | Command-hook SessionStart lags an HTTP hook of the new generation | implicit generation + confirm | K-17 | M |
| P-REC-17 | Double-counting a hook delivered by two transports | one transport per event (rev 2: no dedup window; double delivery is impossible by construction) | settings-plan.test.ts | M |
| P-REC-18 | Enter for a queued prompt while a permission dialog is up | invariant I6 + gate | K-11 | M |
| P-REC-19 | `Date.now`/`randomUUID` in core | ESLint ban + determinism property | properties.test.ts | M |
| P-REC-20 | Throwing on unknown events | `unknown` observation; `step` total (I2) | properties.test.ts | M |
| P-REC-21 | Ghost agent mis-correlated with a permission (§5.4) | internal-only candidates disable auto-answer | K-12 | M |
| P-REC-22 | Parallel identical calls (§5.1) | `ambiguous-equivalent` FIFO, rebind | K-12 | M |
| P-REC-23 | PermissionRequest before its PreToolUse arrives (§5.1) | `unbound` + `permBindLate` | permissions.test.ts | M |
| P-REC-24 | UPS from a human typing / `/loop` / peer message (§2.3) | external turn origins; `security.alert` heuristic | K-32 | M |
| P-REC-25 | Hook deny: no Post; turn continues (§6) | `denied` from our accepted answer + transcript | K-15 | M |
| P-REC-26 | Validation rejection fires no hooks (§6) | transcript-first ToolRun → `failed` | tools.test.ts | M |
| P-REC-27 | Tool cancel fires no PostToolUseFailure (§6) | transcript `toolDenialKind:'interrupted'` or closing rule `unknown` | tools.test.ts | M |
| P-REC-28 | Withdrawn prompt (§6) | `withdrawn` state | turns.test.ts | M |
| P-REC-29 | Hook endpoint down (§6, LV Q1) | `hookchannel.error` attachments → degraded, transcript primary | K-20 | M |
| P-REC-30 | Parallel tool DAG branching (TF §5) | pair by `tool_use_id` | transcript-normalize.test.ts | M |
| P-REC-31 | tool_use line lands after the tool finished (§5.6) | enrich-only for terminal tools | tools.test.ts | M |
| P-REC-32 | MessageDisplay final in the same ms as Stop (§7.1) | `stopGrace` + `textAppended` | K-26 | M |
| P-REC-33 | SubagentStart vs PostToolUse(Agent async) order (§7.1) | either creates the agent | agents.test.ts | M |
| P-REC-34 | PostToolBatch before the last PostToolUse (§7.1) | batch closes; later Post enriches | tools.test.ts, LP-41 | M |
| P-REC-35 | uuid duplicates across fork/copy files (§7.2) | uuid dedupe keeps earliest | transcript-normalize.test.ts | M |
| P-REC-36 | Usage duplicated on every block (§7.2) | `(message.id, requestId)` counted once | messages.test.ts | M |
| P-REC-37 | Two entities later found to be one (§3.1) | merge with redirect + `entity.merged` diagnostic | reconcile.test.ts | M |
| P-REC-38 | Attachment `toolUseID` is a uuid for UPS/Stop (§2.3) | only `toolu_` prefixes are tool ids | transcript-normalize.test.ts | M |
| P-REC-39 | `isMeta` companions share promptId (§2.3) | excluded from conversation, used for joins | transcript-normalize.test.ts | M |
| P-REC-40 | Same agent id starts/stops many times (§5.3) | `runs++` resume | agents.test.ts | M |
| P-REC-41 | Task notification repeats for one agent (§5.5) | each is a turn with the same `causedBy` | K-18 | M |
| P-REC-42 | "Forgot to transition out of X" status bugs (§9) | status is derived only | status-derive.test.ts | M |
| P-REC-43 | Restart/reattach needs exact state (§11.3) | `serializeCore`/`deserializeCore` property I7 (rev 2: no reattach consumer in v1) | properties.test.ts | M |
| P-REC-44 | Subagent PermissionRequest `agent_id` unknown (§14.1) | correlation requires agent equality only when present | LP-22 | M* |
| P-REC-45 | Background subagent hooks carry which prompt_id (§14.2) | attribution never uses prompt_id for subagents | LP-21 | M |
| P-REC-46 | UPS for absorbed queued prompts (§14.3) | rev 2: `mergedInto` path (§4.4) or plain external turn | LP-28 | M* |
| P-REC-47 | Stop for a withdrawn prompt (§14.8) | Stop for a withdrawn turn is accepted as completion evidence of the *active* turn only | LP-29 | M* |

### 5.9 Security (`docs/caveats/security.md`)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-SEC-01 | Hook URL persisted in the transcript (`hookInfos[].command`) (§2.2) | token header only; path segment non-secret | live L-12 (grep transcript for token) | M |
| P-SEC-02 | Loopback port reachable by every local user; CSRF/DNS rebinding (§2.1, §2.3) | 127.0.0.1, Host, no Origin, JSON CT, timingSafeEqual token | hook-server.test.ts | M |
| P-SEC-03 | Port squatting answers PermissionRequest `allow` (§2.4) | PermissionRequest over unix socket in 0700 dir; bind lifetime ≥ pane guaranteed by the owner-watch (rev 2) and hook-worker death → kill pane | K-22, L-13, LP-15 | M |
| P-SEC-04 | Echoed/templated observation bodies could inject `allow`/`additionalContext` (§2.6) | constant empty 200 (self-test nonce block is the sole exception, constant body) | hook-server.test.ts (snapshot) | M |
| P-SEC-05 | User text without `-l` becomes keys (§3.1) | text never via send-keys except `typeLiteral` with `-l --` for commands | tmux-keys.test.ts | M |
| P-SEC-06 | Embedded `ESC[201~` breaks out of bracketed paste; C0/C1/DEL/OSC 52 pass through tmux (§3.2) | sanitizer strips ESC, C0 (except `\n\t`), DEL, C1 on every path | sanitize.test.ts, LP-42 | M |
| P-SEC-07 | TUI prefixes: `!` shell mode runs commands with no permission and no UPS (§3.3) | prefix escape; `send()` can never reach shell mode | sanitize.test.ts | M |
| P-SEC-08 | Slash commands that change posture (§3.6) | allowlist/denylist; `unsafe` flag | K-34 | M |
| P-SEC-09 | Permission policy defaulting to allow (§4.1) | D-18 fail closed | K-09 | M |
| P-SEC-10 | Screen fallback pressing "Yes" (§4.3) | Escape only unless `screenAllow` + conditions | K-10 | M |
| P-SEC-11 | `updatedPermissions` writing files; dangerous `setMode`/`addDirectories` (§4.4) | forced `session`; refusals | permissions.test.ts | M |
| P-SEC-12 | Skip-permission flags; `CLAUDE_CODE_SANDBOXED` auto-trusts (§4.5) | forbidden args; stripped var | argv-builder.test.ts | M |
| P-SEC-13 | `TMUX`/`TMUX_PANE` let the agent drive its own pane (§4.7) | `env -u`; deny rules; unexpected-input detection | live L-10, K-32 | M |
| P-SEC-14 | Settings file perms/placement/inline JSON (§5.1) | 0700 mkdtemp, `wx` 0600, path argv, outside cwd | settings-file.test.ts | M |
| P-SEC-15 | Trust seeding enables repo hooks/permissions/env (§5.5) | `trust:'require'` default; `seed` after `inspectWorkspace` | preflight.test.ts | M |
| P-SEC-16 | Unauthenticated proxy usable by any local user (§6.1) | per-session Basic token; 407 otherwise | sidecar.test.ts | M |
| P-SEC-17 | Proxy as SSRF pivot; file-based fault control writable by the agent (§6.3, §6.5) | post-DNS target policy; control over 0700 unix socket with token | sidecar.test.ts | M |
| P-SEC-18 | Secrets in argv (incl. `tmux -e`) (§7.1) | secrets only via starting-client env / 0600 files | env-builder.test.ts (argv scan) | M |
| P-SEC-19 | Host secrets leak into Claude/tools (§7.2) | allowlist env; strip list | env-builder.test.ts | M |
| P-SEC-20 | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` scope misunderstood (§7.3) | opt-in `scrubSubprocessEnv`; documented coverage | — | M |
| P-SEC-21 | Shell injection via `$CLAUDE_ENV_FILE` values (§7.5) | rev 2: no `$CLAUDE_ENV_FILE` writes at all (§10 C2) | forwarder.test.ts (asserts no write) | N/A |
| P-SEC-22 | Payloads/tokens in logs (§8.2) | metadata-only logs; exact-token redaction first | redact.test.ts | M |
| P-SEC-23 | Fixtures leak email/home paths (§8.4) | `fixtures-scrub` + `fixtures-lint` in CI; `fixtures/raw/` gitignored | fixtures-lint (CI) | M |
| P-SEC-24 | Wrong file/dir modes; symlinked runtime dir (§9) | explicit modes; lstat checks | runtime-dir.test.ts | M |
| P-SEC-25 | Lifecheck job with tokens in plist/argv (§10) | paths only; tokens in 0600 files | launchd.test.ts | M |
| P-SEC-26 | Forged hook events trigger library actions (§2.7) | side effects (sending queued prompts, wakes) need transcript or screen corroboration (`turn_duration`/done line) of a hook turn end | K-32 | M |
| P-SEC-27 | Body/connection floods (§2.7) | 64 MiB body, 64 connections, 32 held | hook-server.test.ts | M |
| P-SEC-28 | `allowedHttpHookUrls` widening to all loopback ports (§2.8) | exact origin, conditional (D-13) | settings-plan.test.ts | M |
| P-SEC-29 | `disableAllHooks:false` re-enabling hooks the user disabled (§2.8) | D-14 | preflight.test.ts, LP-11 | M |
| P-SEC-30 | Agent edits project settings mid-session (hot reload) (§5.2) | `ConfigChange` hook → `config.changed` event to the host | hooks-normalize.test.ts | M |
| P-SEC-31 | Settings file tampered between write and read (§5.2) | sha256 recorded; re-check after SessionStart → `security.alert` + kill | lifecycle.test.ts | M |
| P-SEC-32 | `$` in a literal header value is blanked (§2.2, §5.3) | hex tokens; assert no `$` | settings-plan.test.ts | M |
| P-SEC-33 | Command strings concatenated from paths (§5.3) | exec form (`command`+`args`); wrappers quote with `'…'` and paths validated | settings-plan.test.ts | M |
| P-SEC-34 | Terminal escapes in output forge the screen / OSC 52 (§3.5, §4.6) | anchor on the live input box; screen-only dialogs `suspect`; clipboard/passthrough off | screen-classify.test.ts | M |
| P-SEC-35 | BTab mode cycling into dangerous modes (§3.7) | `setMode` refuses without `allowDangerousModes` | K-33 | M |
| P-SEC-36 | Decision applied to a mis-correlated tool (§4.2) | decision bound to the request's own response; handler sees PermissionRequest's own input | K-12 | M |
| P-SEC-37 | `@path` exfiltration (§3.3) | `mentions:'reject'` for untrusted hosts | sanitize.test.ts | M*/A |
| P-SEC-38 | `NODE_OPTIONS` `--require` hijacks the forwarder (§7.6) | stripped; forwarder ignores env | env-builder.test.ts | M |
| P-SEC-39 | `node` PATH lookup in hooks (§7.6) | absolute `process.execPath` | settings-plan.test.ts | M |
| P-SEC-40 | `err.cmd` argv lands in our error logs (§7.1) | errors built from typed fields only | errors-map.test.ts | M |
| P-SEC-41 | Events carry sensitive payloads into host logs (§8.3) | `redactEvent(e)` export; `ResponseRef` previews | redact.test.ts | M |
| P-SEC-42 | Screen dumps written to disk (§8.5) | bounded in-memory ring; disk only with `debug.dumpDir` (ResolvedConfig.debug.dumpDir, 0700) and the narrow limit recorder (§3.9) | debug-trace.test.ts | M |
| P-SEC-43 | Shared single-uid CI runners (§9) | documented: one runner user per session or containers | — | A (uid boundary absent) |
| P-SEC-44 | Plain HTTP through the proxy exposes cleartext (§6.4) | rev 2: absolute-form `http://` → 405 (no plain-HTTP forwarding) | sidecar.test.ts | M |
| P-SEC-45 | Ack text differs from what we sent (keystrokes injected) (§3.4) | rev 2: classify external shapes first; a mismatch → `security.alert E_INPUT_TAMPERED` + `provenance.confirmed:false`; interrupt only with `security.onTamper:'interrupt'` | K-08 | M |
| P-SEC-46 | Input the library did not send (§4.7.5) | unexpected UPS / mode change / foreign permission resolution → `security.alert` | K-32 | M |
| P-SEC-47 | Proxy auth probing / header logging (§6.2) | count 407 bursts; never log `Proxy-Authorization` | sidecar.test.ts | M |
| P-SEC-48 | Same-uid agent can read tokens and forge events (A4) | tokens grant only local capabilities; no side effects from hooks alone | K-32 | A (same uid; mitigations limit blast radius) |

### 5.10 Layering, API and tooling (`docs/caveats/api-layering.md` §11.3 P1–P22 and §0/§10/§11)

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-API-01 | Version strings leak into core/facade (P1) | strings only in `channels/profiles/claude-2.1.316/*`; `ScreenFacts` profile-free | API report grep | M |
| P-API-02 | Facade grows logic (P2) | line budget (< 600 lines excl. types); rev 2: option-isolation + kernel-only-facade arch tests (§1.4 3e/3f) replace the facade-swap test | test/arch/*.test.ts | M |
| P-API-03 | Mixed time sources (P3) | `Clock` port; mono in core | eslint core rules | M |
| P-API-04 | Non-determinism breaks goldens (P4) | I3 property | properties.test.ts | M |
| P-API-05 | Re-entrant dispatch from listeners (P5) | single loop, microtask fan-out | loop.test.ts | M |
| P-API-06 | Listener throws kills the loop (P6) | try/catch → `E_LISTENER_THREW` | K-23 | M |
| P-API-07 | Unhandled rejection kills the host (P7) | `done`/`exited` never reject; no-op catch on `accepted` | turn.test.ts | M |
| P-API-08 | `emit('error')` throws without a listener (P8) | no `'error'` event; ESLint rule | eslint | M |
| P-API-09 | Unbounded buffers / never-iterated iterators (P9) | bounded queues + `gap` | K-24 | M |
| P-API-10 | Hidden state changes outside events (P10) | I1 property | properties.test.ts | M |
| P-API-11 | Barrel cycles (P11) | no barrels; `no-circular` | depcruise | M |
| P-API-12 | Duplicate package copies break `instanceof` (P12) | `isCcdError` by code | errors.test.ts | M |
| P-API-13 | Bundler moves standalone scripts (P13) | no bundler; `import.meta.url` paths; builtins-only rule; contract test spawns `dist/...` | test/contract/standalone.test.ts | M |
| P-API-14 | TLA breaks `require(esm)` (P14) | ESLint ban on top-level await | eslint | M |
| P-API-15 | Module singletons break multi-session (P15) | only the exit-cleanup registry; K-30 | K-30 | M |
| P-API-16 | Fakes drift from real adapters (P16) | shared contract suites run on both | test/contract/* | M |
| P-API-17 | Async exit cleanup never runs (P17) | sync `execSyncBestEffort` in `process.once('exit')` | lifecycle.test.ts | M |
| P-API-18 | `unknown` payload later narrowed = breaking (P18) | `toolInput: unknown` permanently; typed helpers | API report | M |
| P-API-19 | Option sprawl (P19) | `resolveConfig()` single defaults table; unknown keys rejected | config.test.ts | M |
| P-API-20 | Trace leaks secrets/PII (P20) | redaction at write, `raw:'meta'` default, 0600 | redact.test.ts | M |
| P-API-21 | Host sleep false stalls (P21) | `clock.hostResumed` | K-21 | M |
| P-API-22 | Replayed history emitted as live events (P22) | `replayed:true`; facades suppress by default | K-22 | M |
| P-API-23 | TypeScript 7.0.2 has no compiler API in main; typescript-eslint needs < 6.1 (§0.7) | pin `typescript@6.0.3` | package.json | M |
| P-API-24 | tsup unmaintained / Node ^22.18 (§0.7) | plain `tsc` | — | M |
| P-API-25 | dependency-cruiser refuses Node 23.6 (§0.9) | `.nvmrc` 22; CI on 22 for lint | ci | M |
| P-API-26 | vitest 5 / dependency-cruiser 18 drop Node 20 (§0.8) | pin vitest 4.1.12, depcruise 17.4.3 | package.json | M |
| P-API-27 | Node-22-only APIs slip in (§10.2) | `@types/node@^20`, `lib: ES2023` | typecheck | M |
| P-API-28 | ESLint import-glob false positives on folders named like layers (§3.3) | no subfolder named `core`, `session`, … | eslint | M |
| P-API-29 | `Symbol.asyncDispose` untested on Node 20 (§6.1) | guarded: defined only if `Symbol.asyncDispose` exists | CI Node 20.19 | M* |
| P-API-30 | depcruise `$1` back-reference and builtins-only rule unverified (§14.6) | one rule per facade; planted-violation fixture test | test/arch/depcruise.test.ts | M |

### 5.11 TUI known issues (`docs/research/tui-known-issues.md`) not already covered

| ID | Pitfall | Mitigation | Check | St |
|---|---|---|---|---|
| P-TUI-01 | #91205 paste block + key in one chunk loses the paste (§0.1) | separate invocations + settle; editor primary | LP-02 | M |
| P-TUI-02 | #90910 head truncation at byte 1022 for long `send-keys` (§1.3) | never long send-keys; editor exact; ack equality check | K-06 | M |
| P-TUI-03 | Pastes marked untrusted for the model (§0.2) | editor path is not a paste | LP-01 | M |
| P-TUI-04 | 1022-byte tmux writes split long text into several pastes (§0.3) | chunks ≤ 400 B | input-policy.test.ts | M |
| P-TUI-05 | Dialogs ignore keys for 150 ms and extend on refused keys (§0.6) | `dialogSettleMs` 300 before any dialog key | gating.test.ts | M |
| P-TUI-06 | Trailing `\` turns Enter into a newline (§2) | sanitizer appends a space after a trailing backslash | sanitize.test.ts | M |
| P-TUI-07 | `:ab` emoji popup eats Enter (§3.3) | `emojiCompletionEnabled:false` | LP-03 | M |
| P-TUI-08 | Feedback survey eats a one-digit prompt (§3.6) | env + `feedbackSurveyRate:0`; survey surface detected → Escape | LP-03 | M |
| P-TUI-09 | Vim editor mode changes keys (§3.8) | `editorMode:"normal"` forced | LP-03 | M |
| P-TUI-10 | `Teach auto mode…` offer takes Enter (§3.11) | `skillOverrides:{"auto-mode-setup":"off"}`; we never run in auto by default | LP-03 | M |
| P-TUI-11 | `ultrathink`/`ultracode`… keywords change effort (§3.4) | documented; not rewritten (user intent) | — | A |
| P-TUI-12 | A pasted image path becomes an image attachment (§1.2) | editor path does not trigger paste handling; documented | LP-01 | M* |
| P-TUI-13 | `Pasting…` stuck (§1.2) | = P-SCREEN-33 | — | M |
| P-TUI-14 | Usage-limit options menu auto-opens and takes keys (§5.4) | `usageLimitMenu` surface → gate; wake step (3) Escape | K-19 | M |
| P-TUI-15 | Fable usage-credit consent prompt blocks (§5.6) | classified as `modal`; surfaced, never auto-answered | screen-classify.test.ts | M |
| P-TUI-16 | Feature flags (tengu_*) vary UI per account (§10) | tier-A fallbacks; unknown-line telemetry; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` not set (side effects untested) | — | M*/A |
| P-TUI-17 | Kitty APC / title churn (§8.4) | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`; never read `#{pane_title}` | — | M |
| P-TUI-18 | `C-z` suspends; SIGSTOP leaves the tty cooked (§8.7, #88249) | never sent; frozen-UI diagnostic suggests `stty raw -echo` repair (manual) | — | M |
| P-TUI-19 | Crash leaves the pane in paste/mouse mode (§8.7) | pane command is Claude itself; pane killed after exit | — | M |
| P-TUI-20 | Lower-priority / capacity banners (§5.6, §7) | `lowPriority` status kind; capacity errors via StopFailure | screen-classify.test.ts | M |
| P-TUI-21 | Usage-limit wording drift (`session limit` vs `5-hour limit`) (§5.1) | both templates + Claude's own detection prefixes (`Wio`) | screen-classify.test.ts | M |
| P-TUI-22 | Reset time formats and time zones (§5.1) | structured `resetsAt` preferred; text parser fallback with zone | usage.test.ts | M |
| P-TUI-23 | Concurrent sessions hit the refresh lock (§6) | = P-LIFE-41 | — | M |
| P-TUI-24 | Model-call health strings (`No response from API…`, `Connection lost…`) (§7) | `noResponse` status kind; StopFailure authority | screen-classify.test.ts | M |
| P-TUI-25 | Classic renderer resize/scrollback bugs (§8.1) | never resize; parse only around the live input box | — | M |
| P-TUI-26 | `CLAUDE_CODE_RETRY_WATCHDOG` changes limit semantics (§5.5) | stripped (P-LIFE-42) | — | M |

### 5.12 Other research findings with their own IDs

| ID | Pitfall (source) | Mitigation | Check | St |
|---|---|---|---|---|
| P-LIVE-01 | HTTP hooks go through HTTPS_PROXY unless NO_PROXY covers 127.0.0.1 (LV Q1) | D-22 | live L-07 | M |
| P-LIVE-02 | Dead hook endpoint: visible errors, PermissionRequest falls back to the dialog (LV Q1) | fail-open transport; health from `hook_non_blocking_error` | K-20 | M |
| P-LIVE-03 | Hung endpoint: Claude waits the full timeout, spinner `running … hooks` (LV Q1) | short timeouts; reply-first server | hook-server.test.ts | M |
| P-LIVE-04 | PermissionRequest hook does not suppress the dialog; race (LV Q2) | §3.7 + I6 | K-10, K-11 | M |
| P-LIVE-05 | Hook timeout leaves the dialog up, late answer ignored (LV Q2) | `permission.hookClosed` → `dialogOnly` | K-10 | M |
| P-LIVE-06 | Default permission mode can be auto (LV Q4) | explicit `--permission-mode` | argv-builder.test.ts | M |
| P-LIVE-07 | Input line uses NBSP after `❯` (LV Q4) | = P-SCREEN-11 | — | M |
| P-LIVE-08 | Keys before UI draw are buffered and go to a dialog if one is up (LV Q4) | no input before readiness | K-02 | M |
| P-LIVE-09 | `--session-id` names only the first session; `/clear` changes id+file (LV Q5) | generations | K-17 | M |
| P-LIVE-10 | Ghost agent runs tools after Stop under the finished prompt_id (LV extra 1) | §4.5.3 | K-18 | M |
| P-LIVE-11 | Turn-duration text excludes permission waits (LV extra 3) | durations from hooks/transcript, not the done line | — | M |
| P-LIVE-12 | `~/.claude.json` restore must be surgical (LV cleanup) | single-key seed/unseed; never whole-file restore | claude-config.test.ts | M |
| P-DOCS-01 | `defer` is ignored interactively (OD §1.7) | never used | — | M |
| P-DOCS-02 | CL 2.1.288: hook matching/serialization failure blocks PreToolUse/PermissionRequest (OD §1.7) | matcher `*`; no `if` | settings-plan.test.ts | M |
| P-DOCS-03 | `permission_mode` absent on some events; `manual` vs `default` naming (OD §1.6, PA §2.7) | mode fact only from events that carry it; `manual`→`default` | hooks-normalize.test.ts | M |
| P-DOCS-04 | `prompt_id` absent before first input (OD §1.6) | optional everywhere | hooks-normalize.test.ts | M |
| P-DOCS-05 | statusLine hidden during permission prompts, debounced 300 ms, cancels in-flight (OD §2) | rev 2: no statusLine channel | — | N/A |
| P-DOCS-06 | `--verbose` changes the screen (OD §3) | rev 2: enforced by the `extraArgs` allowlist (§3.3) | argv-builder.test.ts | M |
| P-DOCS-07 | Ctrl+B is the tmux prefix; two-key shortcuts wait 3 s in tmux (OD §6) | `C-b` never sent; `TMUX` unset | — | M |
| P-TX-01 | Thinking text is empty (`display:"updates"`) (TF §4.3) | no reasoning text promised in the API | — | M |
| P-TX-02 | Synthetic `<synthetic>` messages are not model output (TF §4.3) | `synthetic:true`; `No response requested.` ignored | messages.test.ts | M |
| P-TX-03 | Multiple roots; dangling preserved uuids (TF §5, §8.2) | no tree reconstruction needed by core; parser tolerant | transcript-normalize.test.ts | M |
| P-TX-04 | Dead branches from rewinds/withdrawn prompts (TF §8.4) | live leaf = latest `last-prompt.leafUuid` or file order; core follows hooks | transcript-normalize.test.ts | M |
| P-TX-05 | Files > 200-char slugs get a hash suffix (TF §1) | path from hooks; glob `projects/*/<uuid>.jsonl` fallback | tail-discovery.test.ts | M |
| P-TX-06 | Not-real-user texts (`[Request interrupted…`, `isMeta`, `isVisibleInTranscriptOnly`) (TF §9.17) | profile regex `ZHe` | transcript-normalize.test.ts | M |
| P-PRIOR-01 | ccmanager detector churn (~20 fixes in 8 months) (PA §2.2) | minimal screen scope; hooks primary | — | M |
| P-PRIOR-02 | `C-u` does nothing on a ghost composer (#67760) (PA I11) | never used for clearing; editor replace | — | M |
| P-PRIOR-03 | `send-keys -l` dead after Esc,Esc on multi-line input (#31739) (PA I7) | no double Esc on drafts except clear job; editor path unaffected | LP-32 | M* |
| P-PRIOR-04 | Registry file corrupt/stale; `*.key` credentials (PA O11) | lenient reader, `kill -0` + procStart, never read `*.key` | registry.test.ts | M |
| P-PRIOR-05 | Inbox socket peer messages start turns; cannot approve (PA §2.14.5) | `crossSessionInbound:"refuse"`; peer turns would be `peer_message` origin | — | M |
| P-PRIOR-06 | `Left` on an empty prompt backgrounds the session under a new id (#87984) (PA I9) | `Left` not in the key enum; `continued-in` handled | tmux-keys.test.ts | M |
| P-PRIOR-07 | IME composition flush when typing a launch command (#29478) (PA I12) | Claude is the pane argv | — | M |
| P-PRIOR-08 | tmux 3.3a mouse-mode crash on macOS (PA T10) | mouse off; min 3.2 but 3.3a with mouse off is fine | — | M |
| P-PRIOR-09 | `--bg` discards PermissionRequest decisions (#88698) (PA §2.14.8) | never `--bg` | argv-builder.test.ts | M |

### 5.13 Cross-reference of research pitfall lists (nothing dropped)

- **PA §3.1 I1–I14**: I1→P-TMUX-13/P-SEC-05; I2→P-TMUX-09; I3→K-06 (P-INPUT-42); I4→P-LIFE-04; I5→P-TUI-02; I6→P-INPUT-12/P-INPUT-02 (commands never pasted); I7→P-PRIOR-03; I8→P-INPUT-33; I9→P-PRIOR-06; I10→P-INPUT-18; I11→P-PRIOR-02; I12→P-PRIOR-07; I13→P-TUI-18; I14→§0.3 (Windows out of scope, A).
- **PA §3.2 P1–P7**: P1→P-REC-04; P2→P-REC-05/P-HOOK-56; P3→P-HOOK-52; P4→P-HOOK-57; P5→P-REC-02; P6 (new UPS supersedes pending requests) → handled: a new *main-thread* turn closes the previous turn, whose pending permissions become `abandoned` + released (closing rule 1); P7→P-PRIOR-05.
- **PA §3.3 O1–O12**: O1→P-HOOK-32/P-HOOK-45; O2→P-HOOK-31; O3→P-LIVE-01; O4 (bg supervisor env credits hooks to the wrong pane) → hooks are keyed on our known `session_id` chain (`normalizeHook` rejects foreign ids) and we never start the daemon (P-NET-40); O5→P-LIVE-09/P-TAIL-24; O6 (transcript lags an open AskUserQuestion) → permission state comes from the hook; O7→P-TUI-25 (no resize, window-size manual); O8→P-TMUX-29/P-SCREEN-10; O9→P-REC-35/P-REC-36; O10→P-TAIL-42; O11→P-PRIOR-04; O12 (TaskCreated not firing for bg Bash) → background tracking from Stop/turn_duration/`task_status`, TaskCreated not registered.
- **PA §3.4 T1–T12**: T1→P-TMUX-23; T2→P-TMUX-15; T3→P-LIFE-49; T4→P-LIFE-15; T5→P-NET-40; T6→P-HOOK-17/P-SEC-24; T7→version gate (§3.1 step 5) + registry version cross-check; T8→D-24; T9→P-TMUX-22; T10→P-PRIOR-08; T11→P-TMUX-21 + `can't find pane` → exited; T12 (O_NONBLOCK inherited stdin) → not applicable under tmux (A).
- **OD §9 items 1–19**: 1→P-LIVE-06/P-LIFE-17; 2→P-HOOK-14; 3→P-HOOK-18/24/25/26/28; 4→P-HOOK-34; 5→P-HOOK-37/P-HOOK-04; 6→P-HOOK-05; 7→P-HOOK-20/P-HOOK-63/P-LIVE-01; 8→§3.2; 9→P-LIVE-09; 10→P-HOOK-45/47; 11→P-REC-02/P-HOOK-58; 12→P-REC-07; 13→P-INPUT-21/22, P-TMUX-53; 14→P-LIFE-37; 15→P-SCREEN-26/P-DOCS-05; 16→§3.2/§3.4; 17→§3.9; 18→P-NET-17, §3.10 thresholds; 19→P-NET-26/27.
- **TF §9 items 1–19**: 1→P-TAIL-06/12; 2→P-TAIL-42; 3→P-REC-36; 4→P-TX-01; 5→P-TAIL-37; 6→P-REC-10; 7→P-REC-30; 8→P-TX-03; 9→P-TX-04; 10→P-LIVE-09; 11→P-REC-35; 12→P-TX-05; 13→P-TAIL-34; 14→P-REC-41; 15→§4.6 ModelCall; 16→P-TX-02; 17→P-TX-06; 18→TF §3 last-wins folding in `transcript/normalize.ts`; 19→P-TAIL-01.
- **TUI §1.3 table** (#91205, #90910, #78177, #67760, #22936, #52812, #15553, #31739, #88249, #104688, #74411): P-TUI-01, P-TUI-02, K-06, P-PRIOR-02, P-INPUT-42, P-TMUX-55, P-INPUT-40, P-PRIOR-03, P-TUI-18, §0.3 (A), P-TUI-25.
- **SEC §12 disagreements** and **AL §14 open questions**: resolved in §0.2 and §9.

### 5.14 Pitfalls added in revision 2 (critic gaps, skeptic review, ARCH binary checks)

Rows of §5.1–§5.12 whose mitigation relied on a cut feature were rewritten in place (marked "rev 2"; status `N/A` = the feature no longer exists). New rows:

| ID | Pitfall | Mitigation | Test | Status |
|---|---|---|---|---|
| P-REV-01 | Leading-space escape does not stop a **known** slash command: submit runs `value.trim().startsWith("/")` then a command lookup (VERIFIED-BIN rev 2); `" /permissions"` would open the dialog (SEC §3.4 vector) | reject `trim().startsWith('/')` with `E_INPUT_REJECTED{leadingSlash}` (D-16); commands only via `command()` | sanitize.test.ts, K-48, LP-45 | M |
| P-REV-02 | Slash aliases bypass allow/deny: `/quit`=`/exit` (immediate, runs while busy), `/new`,`/reset`=`/clear` (VERIFIED-BIN) | canonicalise through the profile alias table before every rule and completion check; `/exit` refused even with `unsafe` | K-34 | M |
| P-REV-03 | `extraArgs` denylist misses `--allowedTools`, `--add-dir`, `--tools`, `--mcp-config`, `--plugin-dir`, `--agents`, `--verbose`, `--debug`… | allowlist (§3.3) | argv-builder.test.ts (every `--help` flag classified) | M |
| P-REV-04 | Provider switches `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,ANTHROPIC_AWS,ANTHROPIC_GOOGLE_CLOUD,MANTLE,GATEWAY}` move billing and the model host | strip / `E_FORBIDDEN_ENV`; preflight `apiProvider === 'firstParty'`; runtime `auth.status` re-check | env-builder.test.ts, preflight.test.ts | M |
| P-REV-05 | `CLAUDE_CODE_MAX_RETRIES`, stream/byte watchdog and timeout vars, `BASH_MAX_OUTPUT_LENGTH` change `attempt n/10`, stall timing and hook sizes | strip always (§3.2) | env-builder.test.ts | M |
| P-REV-06 | `inherit:'minimal'` dropped the user's `DISABLE_TELEMETRY`, `DISABLE_GROWTHBOOK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` → different feature flags than the user's own sessions | privacy pass-through list (§3.2) | env-builder.test.ts | M |
| P-REV-07 | `ExitPlanMode` needs allow **plus** `updatedInput`; a plain allow silently does nothing (OD §1.7) | `needs:'planApproval'`, `approvePlan()`, plain allow → `E_PERMISSION_INVALID{structuredAnswerRequired}` with the request kept pending; mode change validated as setMode | K-36, LP-46 | M* (shape UNVERIFIED) |
| P-REV-08 | Named policies (`dangerouslyAllowAll`) would "allow" AskUserQuestion/ExitPlanMode uselessly | they downgrade to `ask` for `needs ≠ 'decision'` | K-36 | M |
| P-REV-09 | Owner death leaves Claude POSTing tool inputs to a released, squattable loopback port and PermissionRequests fail open | owner-watch kills Claude + tmux ≤ 2 s after the owner dies; `keep`/`attach`/`--wake-orphans` cut | owner-watch.contract.test.ts, L-08 | M |
| P-REV-10 | PermissionRequest arrives > 150 ms after PreToolUse (LV 113 ms + cold forwarder) and missed its `pending` tool | no `runningAfterPre` timer; display-only rule | K-44 | M |
| P-REV-11 | Windowed dedup drops legitimate A→B→A screen transitions and identical hook payloads; hashing 64 MiB bodies on the main loop | consecutive-only screen drop, no hook dedup, uuid-only transcript dedup (D-42) | K-43 | M |
| P-REV-12 | A user `settings.json` `env` block re-introduces a stripped variable (we cannot unset it through `--settings`) | preflight reads the layers: provider switch → `E_FORBIDDEN_ENV{settingsEnv}`; semantics vars → warning | preflight.test.ts | M* |
| P-REV-13 | Forwarder fails open (ECONNREFUSED, crash, > 32 held) while hooks are healthy → a native dialog nobody sees | dialog adoption after 500 ms regardless of hook health (§3.7 step 8) | K-39 | M |
| P-REV-14 | MCP elicitation (`elicitation_dialog`, `elicitation_url_dialog`) blocks the turn; status showed `runningTools`/`modelRequest` forever | `input.requested` + `awaitingInput`; screen `elicitation`/`unknownModal` fallback; host told | K-40, LP-51 | M* (strings UNVERIFIED) |
| P-REV-15 | Safety-classifier stop / refusal fallback retract already streamed text (TF §4.2 #8, §4.4) | logical retraction, `assistant.retracted`, finalText recomputed | K-41 | M |
| P-REV-16 | Refusal fallback switches the model (`fallbackModel`) without PostModelSwitch | model fact from `model_refusal_fallback` | K-41 | M |
| P-REV-17 | `/clear` closed background agents as `unknown`; their later task-notification pointed at a dead entity | background agents/tasks session-scoped; closing rule 3 exception | K-42, LP-48 | M* |
| P-REV-18 | In-process teammates (agent teams) attributed to the main thread | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` stripped; `kind:'teammate'` attribution + warning | K-42b | M |
| P-REV-19 | Lost/reordered final MessageDisplay pins status at `writing` | implicit final on the next tool/request/message/stop | K-45 | M |
| P-REV-20 | Sticky `apiError` status blocked the library queue forever | `canSubmit` predicate; API error is `idle.lastTurn.error` | K-46 | M |
| P-REV-21 | "hooks degraded" at startup was sticky after a late SessionStart (slow MCP) | reason-scoped degradation, restored by any authenticated hook | K-47 | M |
| P-REV-22 | Tamper verdict + auto-interrupt fired on a task-notification racing our ack, or on normalization differences | classify external shapes first; alert only; `onTamper:'interrupt'` opt-in | K-08, K-25 | M |
| P-REV-23 | Self-test on every start pollutes `~/.claude/history.jsonl` and adds startup flake | `selfTest:'once'` cache; scrub nonce in fixtures | K-50 | M |
| P-REV-24 | Self-test UPS could create a phantom Turn / transcript entries | core consumes the nonce UPS and ignores nonce-bearing transcript entries | K-50, LP-47 | M |
| P-REV-25 | Host event-loop stall > 5 s makes Claude drop observation hooks (LV 4965 ms) | hook servers in a worker thread; loop-lag monitor warning | hook-server.test.ts (busy-loop main thread), K-52 | M |
| P-REV-26 | Answering 200 before the upload finished is untested against Claude's client | read body fully, then 200, then parse; contract test vs real binary | LP-53 | M |
| P-REV-27 | `--debug-file` may record HTTP hook headers (X-CCD-Token) (SEC §13 Q5) | `claudeDebugFile` advanced opt-in only; file in the 0700 session dir, deleted at close unless `keepClaudeDebugFile`; LP-50 decides whether it is allowed at all | LP-50 | M* |
| P-REV-28 | Tool output containing OSC 52 sets the host clipboard through tmux (SEC §13 Q9) | `set -s set-clipboard off` in the server prelude | tmux.contract.test.ts | M |
| P-REV-29 | Raw ESC sequences in tool output could forge screen regions (SEC §13 Q9) | classifier reads only structural regions (rule–❯–rule, footer); a claim needs 2 frames; never acts on text above the composer except banners; LP-51 measures whether Claude strips ESC | screen-classify.test.ts (forged frames), LP-51 | M* |
| P-REV-30 | `allowRead` needed realpath in the pure core; glob patterns (`../**`, absolute) escape | L3 path resolver intent/observation; pattern rules (§3.7 step 1) | path-resolver.test.ts, K-49 | M |
| P-REV-31 | Stripping `GIT_EDITOR` + unarmed `ccd-editor` exit 1 broke agent `git merge`/`rebase --continue` | preserve the user's editor chain; `GIT_EDITOR` fallback `true` | editor.test.ts | M |
| P-REV-32 | LaunchAgent with absolute nvm/pnpm-store paths breaks silently after upgrade | state-dir shim, `lifecheck-target.json` rewritten by every start, `lastRunOk`, `ccd lifecheck status` | launchd.test.ts | M |
| P-REV-33 | Reaper swept unknown `ccd-*` sockets of other agents/tests | registry-named sockets only, two failed probes 5 s apart | reaper.test.ts | M |
| P-REV-34 | launchd jobs may get a different `TMPDIR` than the owner (UNVERIFIED) | every runtime path is absolute in the registry (D-38) | reaper.test.ts | M |
| P-REV-35 | Reset-time text parsed with the host time zone makes replay goldens machine-dependent | L1 `parseResetText(text, wallAt, tz)` with `tz` recorded in the trace header | errors-profile.test.ts | M |
| P-REV-36 | Usage-wake jitter was drawn in L3 at fire time (circular) | deterministic jitter in core from `(sessionKey, resetsAtWall, rearms)` | K-19, K-51 | M |
| P-REV-37 | Resuming an id held by a non-library interactive claude forks or fails | preflight `registry.scan()` → `E_SESSION_ID_IN_USE` | K-38, LP-55 | M* |
| P-REV-38 | Stacked screen stability (L1 + core + gate ≥ 850 ms) slowed dialog paths | single owner (core claims) + overlapping 150 ms settle | K-39 timing assertion | M |
| P-REV-39 | The build orchestrator itself stalls at a usage limit (user request) | §3.11 WP-ORCH two-layer wake | wake-check.test.mjs, M-03 | M* (CronCreate behaviour UNVERIFIED, LP-57) |
| P-REV-40 | The usage-limit pipeline was only testable with synthetic fixtures | LP-30 mock paths, always-on narrow limit recorder, orchestrator pane captures → K-19b | K-19b | M* |
| P-REV-41 | Public option rename forced an L3 change | `SessionSpec` + option-isolation arch test | test/arch/option-isolation.test.ts | M |
| P-REV-42 | Default `permissions:'deny'` made `send('fix the bug')` silently useless and frozen as API | `permissions` required | api/options.test.ts | M |
| P-REV-43 | Two installed package copies each kept their own exit registry → `closeAll()` misses sessions | `globalThis[Symbol.for('claude-code-driver.exit-registry.v1')]` | lifecycle.test.ts (two module instances) | M |
| P-REV-44 | 2.1.316 may enable extended keys / CSI u inside tmux so `send-keys Enter` stops submitting (TD §11 Q3) | the self-test detects it at startup (`E_SELFTEST_FAILED{step:'ack'}`); LP-52 | LP-52 | M* |
| P-REV-45 | Escape-disambiguation timeout: an `Escape` followed within the timeout by another key is read as Meta (TD §11 Q7) | `escGapMs` 250 after every Escape; LP-56 measures the real timeout | LP-56 | M* |
| P-REV-46 | Owner-watch itself dies (OOM/kill) → back to the reaper window | reaper on every `start()` and every 5 min lifecheck; owner heartbeat `owners/` | reaper.test.ts | A (residual window ≤ 5 min) |
| P-REV-47 | Hook worker crash | channel hooks down → pane killed (no same-port restart) | hook-server.test.ts | M |

---

## 6. Test plan

### 6.1 Projects (vitest 4.1.12 `test.projects`, VERIFIED working with a `CCD_LIVE` gate, AL §9.1)

| Project | Glob | What | Gate |
|---|---|---|---|
| `unit` | `test/unit/**/*.test.ts` | pure L1 normalizers/classifier on real fixtures; L2 decide/reconcile/input-policy/sanitize; L3 pure parts (config, env-builder, argv-builder, settings-plan, redact, queue, errors-map, path-resolver with a temp dir); L4 mappers and options | always |
| `arch` | `test/arch/*.test.ts` | layering, standalone/worker imports, window-size grep, `.d.ts` leak, `process.env` spread, option isolation, kernel-only facade, timer allowlist, table-row coverage | always |
| `contract` | `test/contract/*.test.ts` | each L0 port: shared suite run against the fake **and** the real adapter **by the owning WP** (real tmux on a private `-L ccd-test-<pid>-<n>` server; real fs; real loopback sockets + worker; real sidecar; real editor script; real owner-watch process); plus the real `claude.exe` HTTP-hook-client test (free, LP-53) | real tmux needed (CI installs tmux); claude-client test needs the pinned binary |
| `kernel` | `test/kernel/*.test.ts` | real `session`+`core`+`channels` with every port faked (`createTestKernel`); scenarios K-01…K-52 | always |
| `replay` | `test/replay/*.test.ts` | `.ccd.jsonl` traces → goldens | always |
| `orch` | `scripts/orchestrator/*.test.mjs` | WP-ORCH wake-check with a fake `tmux` on `PATH` | always |
| `live` | `test/live/*.test.ts` | real Claude 2.1.316 | `CCD_LIVE=1`, `fileParallelism:false`, `testTimeout 180000` |

Coverage thresholds (rev 2 §10 D7/G24): `src/core/**` lines 90 / branches 80, plus the table-row coverage check (§1.4 3g) — every §4.3/§4.4/§4.10 row is named by a test; `src/channels/**` lines 90; `src/session/**` lines 85; `src/platform/**` lines 80 (unit + contract merged); `src/api/**` lines 85; `src/cli/**` lines 70. Assertion-free tests are rejected in review (`vitest` `expect.hasAssertions()` is set globally in `unit` and `kernel`).

### 6.2 Unit tests that must exist (minimum)

- `channels/screen-classify.test.ts`: the 949-frame corpus (`fixtures/screens/*.log` = scrubbed copies of `fixtures/verify/screen-*.log` + faultproxy + hookprobe snaps) with **per-frame golden labels** `fixtures/screens/labels.jsonl` (`{file, frame, surface, statusKind}`; rev 2 §10 D1 replaces the exact histogram) and the assertion "zero frames classified `unknownModal` or with unknown paren segments"; a label change is an explicit `-u` update reviewed as a diff. Synthetic frames for BIN-only kinds (noResponse, lowPriority, autoModeUnavailable, interrupted, accept-edits/plan footers, usage-limit lines incl. the `(<reset>)` retry form, auth lines, version-too-old, every startup gate string of LC §1.1), and **forged frames** (tool output that prints a fake rule/❯/footer or a fake permission question above the composer → never `permissionDialog`, P-REV-29).
- `channels/hooks-normalize.test.ts`: every line of `fixtures/verify/http-hooks.jsonl` and `cmd-hooks.jsonl` normalizes without diagnostics; ghost agent PreToolUse; SubagentStop `agent_type:""`; SessionEnd with prompt_id; MessageDisplay 3 chunks; **an unexpected `session_id` is passed through** (rev 2); `elicitation_*` notifications → `input.requested`/`input.requestCleared`; `teammate_name` → `AgentRef.teammateName`.
- `channels/transcript-normalize.test.ts`: the 4 transcripts in `fixtures/verify/transcripts/` + hookprobe + faultproxy (scrubbed): per-file promptId stamping, interrupt markers (both kinds), `isAbortedMidStream`, `permissionDecision` sources, `hook_*` attachments (toolu vs uuid), `api-request` retries (same `requestDigest`, `tail:[]`), task notifications, `queue-operation` all four ops, metadata last-wins, unknown types passthrough, **refusal entries** (`refusedMessageId` meta user entry → `model.refused`; `model_refusal_fallback` → `model.refusalFallback`; from the 2.1.316 corpus cited in TF §4.2 #8/§4.4, or synthetic if not in our fixtures).
- `channels/profile-errors.test.ts`: `parseResetText` for `3pm`, `3:45pm`, `Nov 9, 4pm`, ` (Europe/Berlin)` suffix, DST edges, `tz` = `UTC` and `America/Los_Angeles` (same input → different outputs, deterministic).
- `core/input-policy.test.ts`, `core/sanitize.test.ts`: every SEC §3.4 vector (`"/permissions"` and `" /permissions"` → rejected, `"!rm -rf ~"`, `"\x1b[Z"`, `"\x1b\x1b"`, 100 KB with `ESC[201~` at the end, `"‮"`, `"👩‍💻"` survives, `"a\x03b"`, `"x\x1b]52;c;aGVsbG8=\x07y"`, NUL, DEL, U+009B), the IN §4.6 invisible classes, trailing `\`, `normalizeForAck` with `<pasted_content>` wrappers and per-line trailing whitespace; the ack decision order of §3.6 step 5 (nonce, external shapes, match, mismatch).
- `core/{turns,tools,permissions,agents,messages,claims,status-derive,usage,reconcile,session,inputs-requested,selectors}.test.ts`: every row of the §4 tables (named `§4.4#n`), given/when/then via `testing/scenario.ts`; `selectors.test.ts` covers every clause of `canSubmit`.
- `core/properties.test.ts` (fast-check 4.10.2): I1–I7; **permutation convergence** restricted to pairs that do not straddle a deadline (rev 2 §10 D2), from different sources within 250 ms, or concurrent hooks within ±5 ms → identical terminal facts; **duplicate injection**: an identical transcript line twice is idempotent (hooks are not de-duplicated by design; their duplicates are not generated); **channel dropout** (drop all screen / all network / all transcript / one hook event type → terminal facts correct or `unknown`, never wrong; hook dropout must produce `channel.health degraded`); **delay injection** (+2 s on all transcript observations → no premature `unknown`, no reopened turns); **deadline jitter** (random extra ticks → same result); **snapshot/restore** mid-stream → same result (I7).
- `session/*.test.ts`: env-builder (strip list under `inherit:'all'` incl. rev 2 vars, privacy pass-through, provider switch in `env.set` → `E_FORBIDDEN_ENV`, no secret in any argv, `NO_PROXY` merge, `CLAUDE_CONFIG_DIR` kept-not-introduced, editor chain), argv-builder (allowlist: **every flag in the recorded `claude --help` text is classified allowed or forbidden**, never `--session-id`+`--resume`, mode always present), settings-plan (exact JSON snapshot for `http` and `unix`; conditional keys; no `$` in token; never-registered events), preflight (each failure code incl. `E_API_PROVIDER_UNSUPPORTED`, resume holder), path-resolver (inside, outside, symlink out, ENOENT ancestor, `../**`, `/abs/**`, `~`, unknown arg), redact (every SEC §8.2 pattern + exact-token), queue (seq gap-free; no dedup), lifecycle (close ordering with fake ports; two module instances share the exit registry), reaper (registry-named sockets only, two-probe rule, pid identity), selftest-cache (key, TTL), limit-recorder (ring content filter, dump trigger, scrub), scheduler (wall deadline re-check ≤ 30 s, hostResumed, loop-lag warning).
- `api/*.test.ts`: `toSessionSpec` for every public option; `permissions` missing → error; `unstable_advanced` validated; event/state/error mappers exhaustive.
- `cli/*.test.ts`: plist and shim text (no absolute dist path inside the plist), `lifecheck status` classification, `lifecheck --json` shape.

### 6.3 Kernel scenarios (`test/kernel/`, fakes only, deterministic FakeClock)

Written in **Phase 1** by WP-14 as executable acceptance specs (initially `it.fails` until the owning WP lands; each names its acceptance WP in brackets).

K-01 [09/11] trusted startup: SessionStart + stable composer + self-test nonce block/restore → `ready`; no Turn created. K-02 [12] trust dialog surface → `E_TRUST_REQUIRED`, zero keys sent. K-03 [12] version `2.1.317` → `E_CLAUDE_VERSION_MISMATCH` before any tmux call (FakeTmux records zero invocations). K-04 [12] each startup gate / pre-UI exit string → mapped code, pane killed, zero keys. K-05 [09] no SessionStart, stable screen → degraded readiness, self-test decides. K-06 [09/13] lost Enter: no UPS in 3 s, composer still has text → one Enter retry → accepted; second loss → `E_SUBMIT_UNCONFIRMED`; ghost/placeholder never counts as submitted. K-07 [13] editor consume timeout → pasteChunks fallback → accepted. K-08 [09] ack text differs (not an external shape) → turn accepted with `confirmed:false` + `security.alert E_INPUT_TAMPERED`, **no** interrupt; with `onTamper:'interrupt'` → interrupt job. K-09 [09/13] permission: handler allow; `deny` policy → deny; handler throws → deny; invalid decision → deny; `updatedPermissions` destination rewritten to `session`. K-10 [09/13] policy deadline with `onTimeout:'tui'` → empty reply → human answers at the pane → transcript `user_temporary` → `resolved{decider:'user_keys'}`; human wins while held → we release. K-11 [09] permission pending + queued `send()` → no Enter/digit/text intent until resolved. K-12 [09] two identical parallel Bash calls → `ambiguous-equivalent` FIFO, rebind on evidence; ghost-agent candidate → auto-answer off. K-13 [09] Esc during a model call → `[Request interrupted by user]`, no Stop, no `turn_duration` → `interrupted`; screen banner alone → provisional, retracted by a later Stop. K-14 [09] Esc at a permission dialog → `turn_duration` only → turn `interrupted{tool_use}`, tool `denied`, permission `resolved{user_keys}`. K-15 [09] hook deny → no Post → turn continues → Stop → completed; tool `denied` confirmed by transcript. K-16 [09] retry banner `attempt 4/10` → `modelRequest.retrying`; stall banner → `stalled`; network off → provisional only; stale done line ignored. K-17 [09] `/clear`: HTTP UPS of the new generation before the command-hook SessionStart → implicit gen confirmed; old file drains its withdrawal line; `generationChanged`. K-18 [09] hookprobe replay: two async Agents, task-notification turns with foreign prompt_id SubagentStop, internal agent after Stop hidden, quiescence only at the end; `close({waitForBackgroundMs})` waits. K-19 [09/11] usage limit: StopFailure `rate_limit` + transcript resetsAt → `usageLimited`; `usage.wakeScheduled.jitterMs` equals the documented fnv1a formula; FakeClock wall passes reset + jitter → `continue` submitted → cleared; re-arm cap 3; unknown reset → 15 min re-arm. K-19b [14] replay of the first real captured limit fixture (once one exists; `it.skip` with a reason until then). K-20 [09] hook ECONNREFUSED attachments → `channel hooks degraded`, transcript primary. K-21 [11] `jumpWall(10 min)` with no mono advance → `hostResumed`, no false `stalled`, wall deadline fires at once. K-22 [12] owner death: FakeProcess kills the owner → FakeOwnerWatch reports Claude + server killed → registry archived; a new `start({resume})` replays the transcript with `replay:true`, no live duplicates. K-23 [11] listener throws → `warning E_LISTENER_THREW`, loop continues. K-24 [11] slow `events()` consumer → `gap`, memory bounded. K-25 [09] library send races a task-notification turn → the external turn is created, our submit keeps waiting, then either our own ack or `mergedInto` (both orders). K-26 [09] final MessageDisplay after Stop within 500 ms → `textAppended`; finalText from `last_assistant_message`. K-27 [02/09] tombstone rewrite (size shrink) → full rescan, uuid dedup, state consistent, no duplicate observations. K-28 [09/13] `Login expired` → `authRequired`, sends queued, `auth.poll` intent, `auth.status{loggedIn:true}` → restored, poll stopped. K-29 [12] graceful close order: (wait background) → deny held → `/exit` → pane dead → owner-watch stop → hooks/proxy stop → kill-server → cleanup; dialog after `/exit` → SIGTERM path. K-30 [11] two kernels in one process, no cross-talk. K-31 [09] user Stop hook blocks twice → turn ends only on `stop_hook_active:false` (both identical Stop payloads processed, no dedup). K-32 [03/09] forged events: bad token → 403 counted; valid-token forged Stop → no queued prompt is sent until `turn_duration`/done-line corroboration; unexpected UPS → `security.alert`. K-33 [09/13] `setMode('plan')` with footer verification; `bypassPermissions` refused. K-34 [09] commands: `/clear` ok, `/new` and `/reset` canonicalised to `/clear` (evidence = SessionEnd/Start clear), `/permissions` refused without `unsafe`, `/quit` and `/exit` refused even with `unsafe`, `/tui` always refused, unknown-command notice mapped, modal command returns `output`. K-35 [09/13] copy mode detected → `exitCopyMode` before any input; frames in mode ignored. K-36 [09] AskUserQuestion: `dangerouslyAllowAll` → asks; `answerQuestion` → allow + `updatedInput.answers`; ExitPlanMode: plain allow → `E_PERMISSION_INVALID` and still pending; `approvePlan({approve:true, mode:'acceptEdits'})` → allow + setMode update; `mode:'bypassPermissions'` impossible by type and refused at runtime. K-37 [12] `hooks.transport:'auto'`: user layer defines `allowedHttpHookUrls` → `unix` settings; HTTP self-test ack failure with transcript evidence → one relaunch with `unix`, cache written. K-38 [12] `resume` of an id held by a live non-library pid in Claude's registry → `E_SESSION_ID_IN_USE`, nothing spawned. K-39 [09] dialog adoption: hooks healthy, PermissionRequest never arrives (forwarder ECONNREFUSED), permission dialog stable → adopted `dialogOnly` within 500 ms (+ claim 250 ms), `needsKeys`, status `awaitingPermission`; deny via Escape works. K-40 [09] `Notification{elicitation_dialog}` during a turn → `awaitingInput`, queue blocked; `elicitation_complete` → cleared; screen-only unknown modal > 2 s → `awaitingInput{unknownModal}`. K-41 [09] refusal: streamed deltas, then `model.refused` + `model_refusal_fallback{retractedMessageUuids, fallbackModel}` → `assistant.retracted`, finalText without the retracted text, model = fallback, call `refused`. K-42 [09] background agent launched in g1, `/clear`, its task-notification UPS arrives in g2 → agent still `running` until then, external turn in g2 with `causedBy.agent` = the g1 agent, background count correct; K-42b teammate payload → `kind:'teammate'`, warning once, nothing on the main thread. K-43 [07/09] screen A→B→A within 2 s (same permission dialog twice; composer empty→text→empty) → both A frames reach the core and surfaces are correct. K-44 [09] PermissionRequest 400 ms after PreToolUse → binds `unique`, `allowRead` still auto-answers (after `pathsResolved`). K-45 [09] final MessageDisplay lost, then `tool.pre` → message implicit final, status `runningTools` (not `writing`). K-46 [09] turn fails with `E_TURN_API_ERROR`, a queued `send()` drains immediately; status `idle{lastTurn.error}`. K-47 [09] SessionStart arrives 6 s late (after degraded readiness) → hooks channel `up` again. K-48 [09] `send('/cost')` and `send(' /cost')` → `E_INPUT_REJECTED{leadingSlash}`, zero keys. K-49 [13] `allowRead`: `Read` of `cwd/link` where `link → /etc/passwd` → `ask`; `Glob{pattern:'../**'}` → `ask`; `Grep{path: cwd/src}` → allow. K-50 [11/12] second start in the same process with the same version/trust/transport → `selfTest:'cached'`, no nonce typed; a `prompt.recorded` carrying a nonce never makes a Turn. K-51 [09/11] two sessions limited with the same `resetsAt` get different deterministic `jitterMs` in [30 000, 90 000]; `wakeNow()` triggers immediately. K-52 [03/11] host main thread blocked 6 s (busy loop) → observation hooks still answered by the worker (no `hook error`), `host.loopLag` warning, permission answers delayed but delivered.

### 6.4 Fault injection

| Layer | Fault | Where |
|---|---|---|
| tmux | lost Enter (`FakeTmux.dropNextKey('Enter')`), dead pane, `vanish()` (server crash), copy mode, torn frames, A→B→A frames | fake + contract (WP-01) |
| tail | ENOENT→create, torn 5 MB line, crash fragment + seal, shrink (tombstone truncate+rewrite past offset) → full rescan, rename-replace (inode change), same-device mv of file + `<sid>/`, symlinked `tasks/*.output` (realpath dedupe), wall clock −1 h | `FakeTailFs` + contract (WP-02) |
| hooks | endpoint refuse, accept-and-hang, client abort mid-hold, forged token/Host/Origin, 40 MB body (over cap), main-thread stall 6 s, worker crash, > 32 held | `FakeHooks` + contract (WP-03) |
| owner-watch | owner SIGKILL → Claude + server gone ≤ 2 s; Claude pid reused by a non-Claude process → not killed; watcher SIGKILL → reaper backstop | contract with real processes (WP-05) |
| network | sidecar `refuse | blackhole | reset:N | stall:N | slow:R` on `api.anthropic.com` tunnels; sidecar kill → pane killed; split CONNECT head, pipelined bytes, half-close (NP t1 cases); absolute-form → 405 | contract (sidecar vs local fake upstream, WP-04) + live L-11 |
| clock | host sleep (`jumpWall`), tick jitter, wall deadline across sleep | FakeClock |
| process | version mismatch, `auth status` loggedIn:false / apiProvider:'bedrock', pid reuse (identity mismatch), SIGHUP survivor, resume holder in Claude's registry | `FakeProcess`, fake registry |

### 6.5 Gated live tests (`CCD_LIVE=1`)

Rules: skip unless `node_modules/@anthropic-ai/claude-code/bin/claude.exe --version` is `2.1.316`; sessions `ccd-live-<pid>-<n>` on private servers; `globalSetup` teardown kills every `ccd-live-<pid>-*` socket **that its own registry entries name**; budget `CCD_LIVE_MAX_PROMPTS` (default 10) enforced by a counter file; prompts tiny (`Reply with the word OK.`); cwd under a trusted throwaway dir (e.g. `/private/tmp/claude-<uid>/ccd-live/<n>`, inheriting `/private/tmp` trust as in LV Q4) or `trust:'seed'` on a fresh `mkdtemp` with cleanup; a test asserts the launched env lacks `ANTHROPIC_BASE_URL` and every provider switch; never touch other tmux sessions. Free tests use the self-test nonce block. Every wait polls a condition with a ceiling (`waitFor(pred, {timeoutMs})`), never a fixed sleep (rev 2 §10 D6).

| ID | Test | Prompts | Schedule |
|---|---|---|---|
| L-01 | start → ready (self-test passes) → close graceful; exit code and SessionEnd reason recorded; second start in-process → `selfTest:'cached'` | 0 | PR (manual trigger) |
| L-02 | send `Reply with OK` → `turn.ended completed`, finalText `OK` | 1 | PR |
| L-03 | permission allow via handler (Bash `touch`), deny via policy, `onTimeout:'tui'` + keyboard Escape | 2 | PR |
| L-04 | interrupt during an auto-allowed `sleep 20` Bash call (rev 2 §10 D3: deterministic window) → `interrupted` confirmed by transcript | 1 | PR |
| L-05 | `/clear` → new generation, tail switched | 0 | PR |
| L-06 | background Agent (`run_in_background`) → task-notification turn → quiescent | 1 | **nightly** |
| L-07 | user HTTPS_PROXY set (fake upstream) → hooks arrive direct (NO_PROXY works); network channel `off{userProxy}` | 0 | PR |
| L-08 | crash: SIGKILL the library process → owner-watch kills Claude and the server within 3 s (assert `pane_dead`/socket gone, port refuses); restart with `start({resume})` → history replayed | 0 | PR |
| L-09 | resume (`--resume <id>`) of L-02's session in a fresh pane (#91530) | 0 | PR |
| L-10 | Bash `echo "${TMUX:-none}"` prints `none` (permission auto-allowed by handler) | 1 | nightly |
| L-11 | network on: one prompt through the sidecar, all `api.anthropic.com` CONNECTs authenticated; then `refuse` fault → assert the **first** retry banner `attempt 1/10` → `modelRequest.retrying`, then clear the fault (rev 2 §10 D4) | 1 | nightly |
| L-12 | transcript after Stop contains no hook token (`hookInfos[].command` has only the URL) | 0 (reuse L-02) | PR |
| L-13 | kill the hook worker mid-session (test hook) → `channel hooks down` → pane killed, `E_HOOK_PORT_LOST`-class exit (SEC §11 live #12) | 0 | PR |

### 6.6 Fixture format (one format: `.ccd.jsonl`, DebugRecord v1)

```ts
export type DebugRecord =
  | { r: 'header'; format: 'ccd-trace'; v: 1; lib: string; claude: '2.1.316'; tmux: string; node: string; platform: string; startedWall: number; tz: string;
      coreInit: CoreInit /* incl. CoreConfig, so replay is exact */; profile: '2.1.316'; redaction: 'none' | 'meta' | 'full'; hookTransport: 'http' | 'unix' }
  | { r: 'raw'; i: number; ch: 'hook' | 'transcript' | 'screen' | 'network' | 'registry' | 'process' | 'input'; at: number; wallAt: number;
      data: RawHookEvent | TailEvent | { capture: Capture } | TunnelRecord | unknown }      // payload text per redaction policy
  | { r: 'obs'; seq: number; rawRef?: number; obs: Observation }
  | { r: 'cmd'; cmdId: number; at: number; wallAt: number; cmd: Command }
  | { r: 'step'; inSeq: number; events: number[]; intents: Intent[]; durUs: number }
  | { r: 'event'; e: DomainEvent }
  | { r: 'effect'; intentId: number; at: number; durMs: number; ok: boolean; error?: string }
  | { r: 'diag'; at: number; code: string; detail: JsonValue }
  | { r: 'drop'; count: number; reason: 'backpressure' };
```
- Files: `fixtures/traces/<name>.ccd.jsonl` (input), `fixtures/goldens/<name>.events.jsonl` (expected `event` records, `wallAt` normalized to 0), `fixtures/goldens/<name>.state.json` (final `SessionState`, keys sorted).
- Replay levels: with `raw` records (redaction `none`/`full` after scrub) `testing/replay.ts` drives L1+L2+L3 against fakes at recorded `at` on a FakeClock with `tz` from the header; with only `obs` records it drives L2(+L3). Goldens are pinned to profile `2.1.316`; a version bump re-records. Updating goldens is explicit: `pnpm test:replay -u`.
- Recording: `CCD_LIVE=1 CCD_RECORD=1 pnpm test:live -t <name>` writes `fixtures/raw/<name>.ccd.jsonl` (gitignored), then `pnpm fixtures:scrub fixtures/raw/<name>.ccd.jsonl fixtures/traces/<name>.ccd.jsonl` (home → `/HOME`, user → `user`, tmp prefixes → `/TMP`, emails → `user@example.com`, org/account uuids → fixed fakes consistently, library tokens → `TOKEN`, **self-test nonces → `ccd-selftest-NONCE`**, `api-request-blob.message.content` and `api-request-shape.shape.system` dropped, `tool_response` truncated > 8 KiB, SEC §8.2 redactor on every string) and `pnpm fixtures:lint` (fails on emails except `@example.com`, `/Users/[^/]+` or `/home/[^/]+`, `sk-ant-`, `gh[pousr]_`, `AKIA`, `BEGIN .*PRIVATE KEY`, `Proxy-Authorization`, `X-CCD-Token`, `ccd-selftest-[0-9a-f]{32}`, any 32+ hex/base64 not on the fake allowlist). The limit recorder (§3.9) and the orchestrator wake job write in the same format.
- **Initial fixtures built without new live runs** by `scripts/fixtures-from-verify.mjs` (RC §11.4): `bg-agents-task-notification` (hookprobe hooks + transcript), `esc-interrupt-after-tool` (prompt `0e9eea63`), `esc-at-permission` (prompt `57289e99`), `hook-allow`, `hook-held-35s`, `hook-timeout-then-keys`, `hook-deny` (LV P1–P4), `hook-endpoint-down` (P6), `pre-hook-timeout` (P7), `clear-generation-switch` (LV Q5), `ghost-agent-after-stop`, `retry-storm` (faultproxy), `message-display-3-chunks` (P5), `trust-dialog` (session B screens), `startup-automode` (screen-A0). Sources: `fixtures/verify/*` and the BRIEF probe dirs, scrubbed (the verify transcripts already have the email redacted but still hold home paths and system context — scrub before commit).

### 6.7 Manual tests (`docs/MANUAL-TESTS.md`, owned by WP-CI)

M-01 LaunchAgent after sleep/wake: install `ccd lifecheck`, close the lid ≥ 10 min, wake, check `lifecheck.json.ranAt` advanced within one interval (P-LIFE-57). M-02 Lid-close mono clock: a script logs `performance.now()` and `Date.now()` every 5 s across a ≥ 5 min sleep (answers LP-27, AL L-4). M-03 Build-orchestrator wake (§3.11). M-04 `ccd lifecheck install` on a machine with nvm, then `nvm alias default <other>` and a package reinstall → `ccd lifecheck status` stays OK (shim self-heal, P-REV-32).

---

## 7. Build and tooling

- **package.json** (target): `name "claude-code-driver"`, `type "module"`, `engines {"node": ">=20"}`, `packageManager "pnpm@11.21.0"` (VERIFIED `pnpm -v`), `claudeCodeVersion "2.1.316"`, `sideEffects false`, `files ["dist", "!dist/**/*.test.*", "!dist/**/fake-*"]`, `bin {"ccd": "./dist/cli/main.js"}`, `exports` = `.` (api), `./kernel` (`@experimental`: `createKernel`, `SessionKernel`, `SessionSpec`, `Command`, `DomainEvent`, `SessionState`, selectors), `./testing` (`@experimental`: fakes, `createTestKernel`, `replayTrace`), `./package.json`; `dependencies {}`; devDependencies pinned exactly: `@anthropic-ai/claude-code 2.1.316`, `typescript 6.0.3`, `typescript-eslint 8.72.1`, `eslint 10.14.0`, `prettier 3.9.10`, `vitest 4.1.12`, `@vitest/coverage-v8 4.1.12`, `fast-check 4.10.2`, `dependency-cruiser 17.4.3`, `publint 0.3.25`, `@arethetypeswrong/cli 0.18.5`, `knip 6.44.1`, `@types/node ^20` (all VERIFIED [npm] in AL §0.8/§11.1). `pnpm-workspace.yaml` keeps `allowBuilds: {"@anthropic-ai/claude-code": true}` (BRIEF). Consumer packaging of the Claude binary (peerDependency vs consumer-supplied `claude.bin`) stays as BRIEF: devDependency + resolution order §3.1 step 5 (open question for the user, AL §14.1, not blocking).
- **Scripts**: `gen-version` (writes `src/model/version.ts` from `package.json#claudeCodeVersion` and `version`, run before `tsc`), `build` (`rm -rf dist && node scripts/gen-version.mjs && tsc -p tsconfig.build.json && chmod +x dist/cli/main.js`), `typecheck` (`tsc -p tsconfig.json --noEmit`), `lint` (`eslint . && depcruise src --config .dependency-cruiser.cjs && prettier --check .`), `test` (`vitest run --project unit --project arch --project kernel --project replay --project orch`), `test:contract`, `test:live` (`CCD_LIVE=1 vitest run --project live`), `fixtures:scrub`, `fixtures:lint`, `check:pkg` (`publint && attw --pack . --profile esm-only`; flag name to be checked with `attw --help`, AL §10.3 UNVERIFIED), `check:api` (`node scripts/api-report.mjs`), `check:tables` (`node scripts/check-table-coverage.mjs`), `check` (all of the above + `knip`).
- **tsconfig.build.json** = AL §10.2 verbatim (`target/lib ES2023 + ESNext.Disposable`, `NodeNext`, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `declaration`+`declarationMap`+`sourceMap`, `rootDir src`, `outDir dist`, `types ["node"]`) plus `exclude ["src/**/fake-*.ts"]` except through `src/testing/**` (fakes are compiled only for `./testing`; WP-00 decides between a second `tsconfig.testing.json` and including fakes in `dist/` behind the `./testing` export — both satisfy the arch rule). `tsconfig.json` (no emit) includes `src`, `test`, `scripts`, config files (for `projectService`).
- **Node**: `.nvmrc` = `22` (22.23.2 installed). Do not run tooling on the default `v23.6.0` (dependency-cruiser refuses it, VERIFIED AL §0.9).
- **CI** (rev 2 §10 G24; owned by **WP-CI**, files `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`, `scripts/ci/build-tmux.sh`):
  - `ci.yml` on push/PR: job `linux` (`ubuntu-24.04`, `apt-get install tmux` = 3.4 on 24.04, UNVERIFIED exact patch; the job prints `tmux -V` and fails if < 3.2) × Node `20.19.x`, `22.x`, `24.x`: `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `test:contract`, `check:pkg`, `check:api`, `check:tables`, coverage gate. Job `linux-tmux-min` (Node 22): `scripts/ci/build-tmux.sh 3.2a` builds tmux 3.2a from the release tarball (`https://github.com/tmux/tmux/releases/download/3.2a/tmux-3.2a.tar.gz`, deps `libevent-dev ncurses-dev bison`), cached by version with `actions/cache`, then runs `test:contract` with `CCD_TMUX_BIN`. Job `macos` (`macos-14`, Node 22, `brew install tmux` = current): `test`, `test:contract`. The pinned Claude binary is installed by `pnpm install` (postinstall, `allowBuilds`); `test:contract`'s real-client hook test runs only when `claude.exe --version` succeeds on the runner.
  - `nightly.yml`: the same matrix plus `linux-tmux-min` with 3.5a and 3.6a built the same way; live tests are **never** run in CI (they need the user's subscription); a self-hosted runner may set `CCD_LIVE=1` manually (documented, not configured).
  - The 24-cell matrix of revision 1 is dropped (Homebrew has only the current tmux, §10 C9).
- **Standalone scripts** (`forward`, `editor`, `sidecar`, `owner-watch`) and the hook `worker` are plain ESM files in `dist/` spawned by absolute path (`new URL('../standalone/forward.js', import.meta.url)`), importing only `node:*`; a contract test spawns them from `dist/`.
- **Repo hygiene**: `.gitignore` adds `dist/`, `fixtures/raw/`, `*.ccd.jsonl` outside `fixtures/traces/`; `etc/claude-code-driver.api.d.ts` committed; `docs/BUILD-STATE.json` committed by the orchestrator (WP-ORCH).

---

## 8. Implementation plan (work packages)

Rules for every package (rev 2 §10 B3):
- Own exactly the listed files (and their tests); code only against the interfaces in §2, which WP-00 lands first **verbatim** (§2 is now self-contained: every boundary type is written out).
- **Interface changes**: an *additive* change to `src/model/**` (new optional field, new union member) may be made by any WP in a PR that touches only `src/model/**` plus its own files, passes `typecheck` for the whole repo, and is noted in `docs/icr/NNNN.md` (one paragraph). A *breaking* change (rename, removal, narrowing) needs the architect (WP-00 owner) and is batched daily. No other WP's files are ever edited.
- **Fakes live with their real adapter**: each L0 WP owns `src/platform/<x>/fake-*.ts` and runs the shared contract suite against both the fake and the real adapter in its own test files. WP-14 only aggregates (`src/testing/fake-ports.ts`).
- The profile assembly files (`profiles/index.ts`, `profiles/claude-2.1.316/index.ts`) are written once by WP-00 with stub exports of fixed names (`hooksProfile`, `transcriptProfile`, `screenStrings`, `errorsProfile`, `commandsProfile`); the owners fill their files without touching the assembly.
- The kernel scenarios (§6.3) are written in Phase 1 by WP-14 and are the acceptance tests of the WPs named in brackets.

| WP | Title | Owns (files) | Depends on (interfaces) |
|---|---|---|---|
| WP-00 | Foundation: tooling + shared model + port types + profile assembly | `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig*.json`, `eslint.config.js`, `.dependency-cruiser.cjs`, `vitest.config.ts`, `.prettierrc`, `.gitignore`, `knip.json`, `scripts/{gen-version,api-report,check-no-global-window-size,check-table-coverage}.mjs`, `src/model/**`, `src/platform/ports.ts`, `src/channels/profiles/index.ts`, `src/channels/profiles/claude-2.1.316/index.ts`, `test/arch/**`, `docs/icr/` | none |
| WP-01 | L0 tmux driver (execFile only) + fake | `src/platform/tmux/**` (incl. `fake-tmux.ts`), `test/unit/platform/tmux-*.test.ts`, `test/contract/tmux.contract.ts`, `test/contract/tmux.contract.test.ts` | §2.7.3 |
| WP-02 | L0 transcript tail (poll + pread) + fake | `src/platform/fs-tail/**` (incl. `fake-tail-fs.ts`), `test/unit/platform/tail-*.test.ts`, `test/contract/tail.contract.*` | §2.7.4 |
| WP-03 | L0 hook server (worker) + forwarder + fake | `src/platform/hook-server/**` (incl. `worker.ts`, `fake-hooks.ts`), `test/unit/platform/{hook-server,forwarder}.test.ts`, `test/contract/hooks.contract.*`, `test/contract/claude-hook-client.test.ts`, `test/contract/standalone.test.ts` (forwarder part) | §2.7.5, §3.5 |
| WP-04 | L0 network sidecar (narrow) + client + fake | `src/platform/netproxy/**` (incl. `fake-net.ts`), `test/unit/platform/sidecar.test.ts`, `test/contract/net.contract.*` | §2.7.7, §3.10 |
| WP-05 | L0 system adapters + owner-watch + fakes | `src/platform/{clock,ids,process,env,runtime-dir,settings,editor,registry}/**` (incl. `process/standalone/owner-watch.ts`, `process/owner-watcher.ts` and every `fake-*.ts` there), `test/unit/platform/{process,claude-binary,runtime-dir,state-store,settings-file,claude-config,settings-layers,workspace-inspector,editor,registry,owner-watch}.test.ts`, `test/contract/{fs,editor,owner-watch}.contract.*` | §2.7.1, §2.7.2, §2.7.6, §2.7.8, §3.8 owner-watch |
| WP-06 | L1 hooks + transcript normalizers + profile (hooks, transcript) | `src/channels/hooks/**`, `src/channels/transcript/**`, `src/channels/profiles/claude-2.1.316/{hooks,transcript}.ts`, `test/unit/channels/{hooks,transcript}-normalize.test.ts` | §2.4, §2.8, `TailEvent`, `RawHookEvent` |
| WP-07 | L1 screen classifier + profile (screen, errors, commands) | `src/channels/screen/**`, `src/channels/profiles/claude-2.1.316/{screen,errors,commands}.ts`, `fixtures/screens/**` (incl. `labels.jsonl`), `test/unit/channels/{screen-*,profile-errors}.test.ts` | §2.3, §2.8, `Capture`, `PaneStatus` |
| WP-08 | L1 network + registry normalizers | `src/channels/{network,registry}/**`, `test/unit/channels/{network,registry}.test.ts` | §2.4, `TunnelRecord` |
| WP-09 | L2 core (reducer **and** input policy, merged in rev 2) | `src/core/**` (all files incl. `input-policy/**`, `decide/inputs-requested.ts`), `test/unit/core/**` | §2.4–§2.6, §2.9, §3.6, §3.7 (core parts), §4 |
| WP-11 | L3 kernel loop, queue, scheduler (+wall deadlines, loop lag), logs, trace, config, self-test cache, limit recorder | `src/session/{kernel,config,errors-map,queue,loop,scheduler,event-log,redact,debug-trace,selftest-cache,limit-recorder}.ts`, `test/unit/session/{config,queue,loop,scheduler,redact,errors-map,selftest-cache,limit-recorder}.test.ts` | §2.9 (`step` stubbed in tests), §2.10, §2.11, §4.12 |
| WP-12 | L3 launch + lifecycle (preflight, env, argv allowlist, settings plan, launcher, close, reaper, registry) | `src/session/{preflight,env-builder,argv-builder,settings-plan,launcher,lifecycle,registry-store,reaper}.ts`, `test/unit/session/{preflight,env-builder,argv-builder,settings-plan,lifecycle,reaper,registry-store}.test.ts`, `fixtures/claude-help-2.1.316.txt` | §2.7 ports, §3.1–§3.4, §3.8 |
| WP-13 | L3 executors (input executor, permission broker, path resolver, pollers, tail driver) | `src/session/{input-executor,permission-broker,path-resolver,pollers,tail-driver}.ts`, `test/unit/session/{input-executor,permission-broker,path-resolver,pollers,tail-driver}.test.ts` | §2.6 intents, §2.7 ports, §3.6, §3.7, §4.11, §4.12 |
| WP-14 | Testing kit (fake aggregator, replay, scenario DSL, arbitraries) + fixture scripts + **kernel scenarios K-01…K-52** | `src/testing/**`, `scripts/fixtures-{from-verify,scrub,lint}.mjs`, `fixtures/traces/**`, `fixtures/goldens/**` (initial), `test/kernel/**` | §2 (all), §6.3, §6.6 |
| WP-15 | L4 public API (options → SessionSpec, mappers, Turn) | `src/api/**`, `etc/claude-code-driver.api.d.ts`, `test/unit/api/**` | §2.10, §2.11, §2.12 |
| WP-16 | L4 CLI (lifecheck reap/report/status, launchd + shim, view, trace) | `src/cli/**`, `test/unit/cli/**` | §3.8, §3.12, `reaper.ts`, `registry-store.ts`, `createNodePorts` |
| WP-ORCH | Build-orchestrator wake-up (user request) | `scripts/orchestrator/**` (`wake-check.mjs`, `install-wake.mjs`, `build-state.schema.json`, `com.claude-code-driver.buildwake.plist.tmpl`, `wake-check.test.mjs`, `README.md`), `docs/BUILD-STATE.json` (initial) | §3.11; nothing in `src/` (may import `dist/channels/profiles/**` when present) |
| WP-CI | CI and manual tests | `.github/workflows/{ci,nightly}.yml`, `scripts/ci/build-tmux.sh`, `docs/MANUAL-TESTS.md` | §6.1, §6.7, §7 |
| WP-INT | Integration: composition root, replay goldens, live tests, README | `src/runtime/**`, `test/replay/**`, `test/live/**`, `README.md`, `docs/USAGE.md` | everything |

(WP-10 no longer exists: it was merged into WP-09.)

Order: **Phase 0** (blocking, small): WP-00 (types copied from §2), **WP-ORCH layer 1 + layer 2 install** (so the build itself is protected by the wake job from the start; the orchestrator writes `docs/BUILD-STATE.json` from here on), WP-CI skeleton (lint/typecheck/test jobs), and the free probes LP-45 (slash/bang escape), LP-47, LP-50, LP-52, LP-53, LP-54 (they can change §3.5/§3.6 before code is written). **Phase 1** (parallel): WP-01…WP-09, WP-14 (scenarios as `it.fails`). **Phase 2** (parallel; may start in Phase 1 against stubs): WP-11, WP-12, WP-13, WP-15, WP-16. **Phase 3** WP-INT. **Phase 4** remaining live probes §9 (gated) feed back fixes; adversarial review (W4).

---

## 9. Live probe backlog (open questions; smallest first; "free" = no model call, uses the self-test block hook or no prompt)

| ID | Question (sources) | Cost | Affects |
|---|---|---|---|
| LP-01 | Editor injection (`VISUAL` + `C-g`) under the full launch bundle: byte-exact UPS, no collapse, no popup (IN §3.1) | free | D-15 |
| LP-02 | Minimal settle after `C-g`/paste before Enter; no 2.1.119-style tmux regression; #91205 (TD §3.4, TUI §12.1) | free | P-TMUX-09/55, P-TUI-01 |
| LP-03 | Full env + settings bundle (§3.2, §3.4) launches with no Settings Error, no renderer offer, no survey, no What's-new (LC §1.1, TUI §11) | free | P-LIFE-31/34/36/61, P-TUI-07…10 |
| LP-04 | Are `--settings` hooks gated by trust in a truly untrusted dir? (HT §1.3, OD §10.1) | free | P-HOOK-14 |
| LP-05 | (rev 2: obsolete, no statusLine channel) Does `statusLine` hide `esc to interrupt`? (OD §0.8) | — | — |
| LP-06 | Where does `⎿  Interrupted · …` render (thinking vs streaming)? (SP §16.1) | 2 | P-SCREEN-25 |
| LP-07 | Do `--settings` `spinnerVerbs`/`spinnerTipsEnabled`/`timeFormat` beat user values? Does `spinnerVerbs` `replace` also change the done line verb (OD §10 Q6)? (SP §16.5) | 1 | §3.4 |
| LP-08 | PermissionRequest via the unix forwarder: dialog visible while held; answer applies; human wins → forwarder still alive?; timeout kills the forwarder? Stop after a manual reject? (LV Q2.3, HT §12.5, IN open 7) | 2 | P-HOOK-56/64, P-REC-47 |
| LP-09 | Bracketed ≤ 400-byte chunks with ≤ 2 LF stay inline (IN §3.2) | free | P-INPUT-12, P-TMUX-08 |
| LP-10 | `allowedHttpHookUrls: ["http://127.0.0.1:<port>"]` matches `/h/<sid>/<Ev>` when a user list exists (SEC §13.4, HT §2.2); result feeds `hooks.transport:'auto'` | free | D-13, P-HOOK-06 |
| LP-11 | `disableAllHooks:false` in `--settings` vs a user `true` (SEC §13.3) | free | D-14 |
| LP-12 | Effect of unsetting `TMUX`/`TMUX_PANE` on Claude's UI/behaviour (TD §7.3) | free | D-08 |
| LP-13 | `--teammate-mode in-process` accepted silently (PA §6.2) | free | D-24 |
| LP-14 | `crossSessionInbound:"refuse"`, `skillOverrides` accepted without warnings (part of LP-03) | free | §3.4 |
| LP-15 | Dead PermissionRequest endpoint (forwarder exits 0, prints nothing) → dialog, not deny (#46193) (OD §10.3); the adoption path picks it up | 1 | P-SEC-03, P-REV-13 |
| LP-16 | `/clear` on disk: withdrawal timing, new id random, `--session-id` pin lost (TT §15.1, TF §10.1) | free | K-17 |
| LP-17 | `C-g` while busy / popup open (IN open 1) | 1 | P-INPUT-17 |
| LP-18 | `/exit` while busy: immediate? exit code? SessionEnd reason? (LC §15.2) | 1 | §3.8 |
| LP-19 | `--resume` in a fresh pane on a private server (#91530) (LC §8.3) | 0 (reuses L-02) | P-LIFE-49 |
| LP-20 | `Resume this conversation?` dialog shape (LC §8.3) | hard | P-LIFE-19 |
| LP-21 | Background-agent PermissionRequest: blocking-before-dialog? carries `agent_id`? subagent hooks' prompt_id after the turn ended? (HT §9.2, RC §14.1–2) | 2–3 | P-HOOK-57, P-REC-44/45 |
| LP-22 | (part of LP-21) PermissionRequest inside a foreground subagent carries `agent_id`? | — | P-REC-44 |
| LP-23 | Two parallel Bash calls: PreToolUse concurrency; PermissionRequest order and PreToolUse→PermissionRequest latency distribution with the forwarder (RC §14.4, HT §7) | 1–2 | P-HOOK-46, P-REV-10 |
| LP-24 | Network: real ALPN, no pipelining, SSE ping cadence and record sizes, 22-byte terminator (NP §9.1–3) | 1 long | P-NET-18/28/29 |
| LP-25 | (rev 2: obsolete, `$CLAUDE_ENV_FILE` restore cut) | — | — |
| LP-26 | Subagent `api-request` entries go to the subagent file? (NP §9.5) | (LP-21) | P-NET-30 |
| LP-27 | Does `performance.now()` advance across macOS sleep? (AL §14.7) — manual test M-02 | no Claude | §3.9 |
| LP-28 | UPS for a queued prompt merged into a running turn (RC §14.3) | 1–2 | P-REC-46, `mergedInto` |
| LP-29 | Stop for a withdrawn prompt (RC §14.8) | 1 | P-REC-47 |
| LP-30 | Usage-limit artifacts. Step 1 (free, try first): `/mock-limits`, `/simulate-usage` (hidden commands, VERIFIED-BIN present) and `CLAUDE_MOCK_HEADERLESS_429=1` in a probe session; record screen, hooks, transcript. Step 2 (opportunistic): the limit recorder (§3.9) and the orchestrator wake job capture the first real limit. Questions: transcript stand-in with `rate_limit_info.resetsAt`, StopFailure `rate_limit`, `quota_auto_resume_*` Notifications, options-menu strings, the `(<reset>)` form of the rate-limit retry line (SP §16 Q7) (LC §15.1, TUI §12.8) | free (step 1) / opportunistic | §3.9, K-19b |
| LP-31 | `capture-pane -e` dim SGR distinguishes placeholder/ghost from typed text (SP §16.2) | free | P-SCREEN-07 |
| LP-32 | Esc-hint-Esc clear on a multi-line draft; `send-keys` still works afterwards (#31739) | free | P-PRIOR-03 |
| LP-33 | Editor-staged `/compact` + Enter runs exactly that command (popup?) | free (`/cost`) | P-INPUT-02 |
| LP-34 | Permission dialog labels for Bash/WebFetch/MCP (IN open 4) | 2 | P-INPUT-35 |
| LP-35 | 120-column pane: what wraps; rule length vs `pane_width` (SP §16.3–4) | free | P-SCREEN-14/35 |
| LP-36 | Manual `/compact` shape (`trigger:"manual"`) (TF §10.2) | 1 + compaction | §4.3 |
| LP-37 | `kill-pane` with remain-on-exit keeps a final screen? (LC §15.7) | free | §3.8 |
| LP-38 | `sandbox.enabled`: HTTP hooks through the sandbox proxy; Bash access to `/tmp/tmux-<uid>` (HT §12.9, SEC §13.6) | 1 | P-HOOK-13, P-NET-43 |
| LP-39 | MessageDisplay `turn_id` stable across messages of one prompt (RC §14.5) | 1 | §4.5.6 |
| LP-40 | In-process HTTP hook latency from `--debug-file` timestamps (HT §12.8) | (any prompt) | P-HOOK-31 |
| LP-41 | PostToolBatch before the last PostToolUse? (RC §14.9) | (LP-23) | P-REC-34 |
| LP-42 | Does Ink end bracketed paste at an embedded `ESC[201~`? (sanitizer off, block hook) (SEC §13.1) | free | P-SEC-06 |
| LP-43 | `@nonexistent` mention behaviour; any literal-`@` escape (IN open 3) | free | P-INPUT-06 |
| LP-44 | Can keybindings be pinned via `--settings`? (IN open 5) | free | P-INPUT-37 |
| LP-45 | **Phase 0.** Stage `" /cost"`, `" !echo hi"`, `" #note"`, `" ?"` through the editor with the self-test block hook armed for each text: UPS (escape works) or the cost dialog / bash mode / memory prompt (escape fails)? Confirms the VERIFIED-BIN trim finding for `/` and decides `! # ? &` (skeptic A4, IN §4.1) | free | D-16, P-REV-01 |
| LP-46 | ExitPlanMode and AskUserQuestion: PermissionRequest payload, the `updatedInput` Claude requires (echo of `plan`? `answers` map shape), dialog strings for `planApproval`/`question` surfaces, and the mode after an approve with `setMode acceptEdits` (OD §1.7) | 2 (plan mode, tiny) | §3.7 step 4, K-36 |
| LP-47 | Does a hook-blocked UPS write a transcript `user` entry, `ai-title`, `last-prompt` or a `history.jsonl` line? (skeptic A12) | free | §3.1 step 15 |
| LP-48 | A running background agent's `<task-notification>` after `/clear`: delivered into the new session? SubagentStop still fires? Is the agent killed by `/clear`? (LC §15 Q8) | 1–2 | §4.5.4, K-42 |
| LP-49 | Which flows tombstone/rewrite the transcript (TT open question 3) and whether refusal fallback rewrites earlier lines; rewind dead branches (TF §10 Q3) are moot (`/rewind` refused) | free (inspect existing 2.1.316 corpus first) | §4.5.10, K-27 |
| LP-50 | Does `--debug-file` record HTTP hook request headers (`X-CCD-Token`) or URLs with secrets? Run the self-test with `--debug-file` and grep (SEC §13 Q5) | free | P-REV-27, `debug.claudeDebugFile` |
| LP-51 | Tool output with raw `ESC[`/OSC 52/`ESC]0;` (an auto-allowed `printf`) — stripped by Claude or rendered? Does it reach tmux? (SEC §13 Q9); plus MCP elicitation dialog strings with a local test MCP server (form + URL) | 1 + 1 | P-REV-28/29, P-REV-14 |
| LP-52 | Does 2.1.316 request extended keys / CSI u (`ESC[>4;…m`, kitty `ESC[>…u`) inside tmux 3.5a (`extended-keys` off by default), and does `send-keys Enter` still submit (TD §11 Q3)? | free | P-REV-44 |
| LP-53 | Body-then-200 hook response order with the real HTTP hook client: no `hook error` notice, latency added (critic G18) | free | §3.5 |
| LP-54 | UPS `prompt` normalization: trailing newline from the editor file, NFC vs NFD input, `@file` mention, pasted image placeholder text (skeptic A3) | free (image: 0 prompts, block hook) | `normalizeForAck` |
| LP-55 | Resume an id held by a running **non-library** interactive claude: what does Claude do (fork, refuse, `already in use`)? (LC §15 Q3) | free | §3.1 step 7, K-38 |
| LP-56 | Escape-disambiguation timeout in 2.1.316 inside tmux (`escape-time` and Ink's own timer) vs `escGapMs` 250 (TD §11 Q7) | free | P-REV-45 |
| LP-57 | Does a Claude Code `CronCreate` scheduled prompt fire in a session that hit a usage limit, after the reset, with no user input? (orchestrator layer 1) | opportunistic | §3.11 |
| LP-58 | After `/cd`, does the next hook carry the new `transcript_path`, and does `<sid>/subagents/` move while a background agent writes (TT §15 Q2)? | 1 | P-TAIL, `cwd.changed` |
| LP-59 | `/model <m>` "saved as your default" behaviour (LC §15 Q5) — back up and restore `~/.claude/settings.json` around it | free | §3.6 commands |
| LP-60 | Footer text and `esc to interrupt` placement in `acceptEdits` and `plan` modes, idle and busy (SP §16 Q6) | free (idle) + 1 (busy) | §2.8 ScreenStrings.footer |
| LP-61 | `--managed-settings '{"allowManagedHooksOnly":true}'` (hidden flag, VERIFIED-BIN) simulates org policy: self-test fails → `E_HOOKS_UNAVAILABLE`; also `strictPluginOnlyCustomization` (HT §12 #7) | free | P-HOOK-05/16 |
| LP-62 | PostToolUse for a 5 MB `Read`: payload size, truncation, delivery latency to the worker (HT §12 #10) | 1 | §3.5 body cap |

Probes LP-01…LP-04, LP-09…LP-16, LP-31…LP-33, LP-35, LP-37, LP-42…LP-45, LP-47, LP-49, LP-50, LP-52…LP-56, LP-59…LP-61 cost no model usage and should run first, in one `ccd-probe-*` tmux session batch, with `~/.claude.json` touched only through `seedTrust`/`unseedTrust`. LP-45, LP-47, LP-50, LP-52, LP-53 and LP-54 run in **Phase 0**, before WP-03/WP-09 code is written.

---

## 10. Critique log (revision 2)

Every gap from the critic list and `docs/critique/skeptic.md` is listed with its disposition. **Fixed** = the design was changed (sections named). **Rejected** = kept as is, with the reason. Labels: G = critic gap list (in its order), A–F = skeptic sections.

| # | Gap | Disposition | Where |
|---|---|---|---|
| G1 | `onOwnerDeath:'keep'` recreates the detached/squattable hook port; `--wake-orphans` submits into a pane with no hook server | **Fixed.** `keep`, `attach()`, `--wake-orphans`, owner control socket all cut; owner-watch kills Claude + server ≤ 2 s after owner death; recovery = `start({resume})` | D-28, §3.8, §3.12, P-REV-09 |
| G2 | User asked for a lifecheck cron that wakes the build agent; design marked it out of scope | **Fixed.** In scope; WP-ORCH owns a two-layer wake (CronCreate in-session + launchd `buildwake` that pastes `continue` into the orchestrator tmux pane after reset, or notifies); never `claude -p` | §0.2, §3.11, §8 WP-ORCH, P-LIFE-60, P-REV-39 |
| G3 | Pure core did realpath for `allowRead`; glob patterns unruled | **Fixed.** `permission.resolvePaths` intent → L3 `path-resolver.ts` → `permission.pathsResolved`; rules for Read/Glob/Grep path and pattern args | §3.7 step 1, §2.4, §2.6, K-49 |
| G4 | Timers outside the single scheduler; `usageWake` missing from DeadlineKind; circular jitter | **Fixed.** Decision timers are all core deadlines (`permissionPolicy`, `usageWake` as a wall deadline, …); closed adapter-timer list §4.12 with an arch test; deterministic jitter in core; auth poll via `auth.poll` intent | D-03, §4.10, §4.12, §3.9 |
| G5 | Public API not specified; kernel "AL §4.5 verbatim" conflicts; `resolveConfig` takes the public shape | **Fixed.** `SessionKernel` (§2.10), `SessionSpec` (§2.11) and the full public API (§2.12) written out; `resolveConfig(spec)`; option-isolation arch test | D-39, §2.10–§2.12, §1.3, §1.4 |
| G6 | `extraArgs` denylist misses policy-defeating flags | **Fixed.** Allowlist; every `--help` flag classified by a test | §3.3, P-REV-03 |
| G7 | ExitPlanMode needs allow + updatedInput; no API | **Fixed.** `needs:'planApproval'`, `approvePlan()`, plain allow → `E_PERMISSION_INVALID` (kept pending), policies never auto-allow; LP-46 for the exact shape | §3.7 step 4, §2.12, K-36 |
| G8 | attach() loses a held permission's dialog | **Fixed** by removal of `attach()` (G1) and by the general **dialog adoption** rule that applies with healthy hooks (also covers forwarder fail-open) | §3.7 step 8, §4.6, K-39 |
| G9 | `hooks.transport` dropped; no way to switch when HTTP is blocked | **Fixed.** `hooks.transport:'auto'|'http'|'unix'` with auto rules and one automatic unix relaunch on HTTP self-test failure | §3.1 steps 7/15, §3.5, K-37 |
| G10 | Self-test nonce: no intents, no minting owner, UPS would create a Turn | **Fixed.** L3 mints (ids port) → `selftest.run{nonce}`; `hook.armSelfTest/disarmSelfTest` intents + `hook.selfTestArmed` ack; core consumes the nonce UPS without a Turn | §3.1 step 15, §4.3, §2.6 |
| G11 | Mitigations name non-existent fields | **Fixed.** `slash.run` result `{effect, output}`; `waitForBackgroundMs` in Command and kernel close; P-LIFE-50 reduced to `session.ready.resumed` (rejected payload extension: no reliable cost fields); `debug.dumpDir`; `detach` removed from Command and exit reasons; `typed` removed; `withdrawn` added to TurnOutcome; ToolState `cancelled` removed | §2.5, §2.6, §2.10, P-LIFE-22/50, P-SEC-42 |
| G12 | Safety-classifier stop and `model_refusal_fallback` dropped | **Fixed.** `model.refused`, `model.refusalFallback` observations; logical retraction; model fact follows `fallbackModel`; LP-49 for tombstoning | §2.4, §4.5.10, K-41 |
| G13 | Background agents across `/clear` conflict with closing rule 3 | **Fixed.** Agents/bgTasks session-scoped, rule 3 exception, `causedBy` across generations, LP-48 | §4.5.4, §4.8, K-42 |
| G14 | MCP elicitation and other blocking prompts unhandled | **Fixed** (observe + surface, no programmatic answer in v1): `input.requested`, `awaitingInput` status, `elicitation`/`unknownModal` screen fallback | §2.4, §4.6, §4.7, K-40 |
| G15 | Env leaks: retry/watchdog/timeout vars, provider switches, `apiProvider`; minimal env drops privacy vars | **Fixed.** Strip list extended (all names VERIFIED-BIN), provider switches forbidden/stripped, `apiProvider === 'firstParty'` in preflight and on auth re-check, privacy pass-through list, settings-`env` check | §3.2, §3.1 step 6, P-REV-04/05/06/12 |
| G16 | Debug log may record hook headers; ESC/OSC 52 in tool output; `$CLAUDE_ENV_FILE` mode | **Fixed/Moot.** LP-50 + debug file opt-in, 0600 dir, deleted at close; `set-clipboard off`; LP-51 for ESC; `$CLAUDE_ENV_FILE` no longer written at all (C2), so SEC Q10 is moot | D-07, §3.3, §3.5, §9, P-REV-27/28/29 |
| G17 | Dropped probes | **Fixed.** LP-52 (TD Q3), LP-56 (TD Q7), LP-58 (TT Q2), LP-55 (LC Q3), LP-59 (LC Q5), LP-48 (LC Q8), LP-60 (SP Q6), LP-30 (SP Q7), LP-61 (HT #7), LP-62 (HT #10), L-13 (SEC live #12), LP-07 (OD Q6) | §9, §6.5 |
| G18 | Early 200 before body read unverified | **Fixed.** 200 written after the body is fully received, before parse; LP-53 + real-client contract test | §3.5 |
| G19 | `ccd lifecheck` wake path needs platform/input; violates cli rule | **Fixed** by cutting the wake path; lifecheck uses only `createNodePorts` + reaper + registry store (allowed edges updated in §1.3) | §3.12, §1.3 |
| G20 | Startup ordering inconsistencies | **Fixed.** Env phase 1 before version/auth; version before any tmux call; one startup grace (3000); socket assertion unified on `sessionDir+'/net.sock'`; no `owners/<pid>.sock`; absolute registry paths | §3.1, §2.7, D-38 |
| G21 | Reaper sweeps unknown `ccd-*` sockets | **Fixed.** Registry-named sockets only, two failed probes | §3.8, P-REV-33 |
| G22 | `auth status` fed as `channel.health`; poll outside core control | **Fixed.** `auth.status` observation, `auth.poll` intent | §2.4, §2.6, §4.3 |
| G23 | Usage-limit path only testable with synthetic fixtures | **Fixed.** LP-30 step 1 tries the hidden mock commands/env first; always-on narrow limit recorder; orchestrator captures; K-19b | §3.9, §9, P-REV-40 |
| G24 | CI files unowned; matrix infeasible; coverage gaps; launchd untested | **Fixed.** WP-CI; reduced matrix with tmux built from source for the minimum; thresholds for platform/api/cli; manual tests M-01…M-04 | §6.1, §6.7, §7, §8 |
| G25 | Slash aliases not normalised; `/rewind` has no flow | **Fixed.** Alias canonicalisation (VERIFIED-BIN); `/rewind` refused; TF §10 Q3 moot | §3.6, P-REV-02 |
| G26 | Double debouncing | **Fixed.** Core claims are the single owner (D-41); L1 drops consecutive identical frames only; `dialogSettle` 150 ms overlaps | §4.6 Claims, §3.6 gate |
| G27 | Reset-time parsing location | **Fixed.** L1 `parseResetText(text, wallAt, tz)`, `tz` in the trace header; `ScreenFacts.usageLimit.resetsAtWall` | §2.3, §2.8, §3.9 |
| G28 | Agent teams/teammates unmapped | **Fixed** (unsupported but safe): env var stripped, `kind:'teammate'` attribution, warning | D-24, §4.5.9 |
| A1 | `runningAfterPre` timer breaks permission binding | **Fixed.** Timer removed; display-only rule | §4.5.1, §4.6, K-44 |
| A2 | Windowed dedup drops A→B→A | **Fixed.** D-42 | §2.4, §4.9, K-43 |
| A3 | `E_INPUT_TAMPERED` auto-interrupt on legitimate turns | **Fixed.** Classification order; alert only; `onTamper` opt-in | §3.6 step 5, K-08/K-25 |
| A4 | Leading-space slash escape unverified for known commands | **Fixed.** VERIFIED-BIN that it does not work → reject; LP-45 in Phase 0 for `! # ? &` | D-16, §3.6, K-48 |
| A5 | `expectedSessionIds` vs implicit generations | **Fixed.** L1 never filters session ids | §2.8, §4.3 |
| A6 | `keep` + attach squattable port | **Fixed** (= G1) | §3.8 |
| A7 | Hooks on the host event loop | **Fixed.** Worker thread + loop-lag monitor | D-11, §3.5, §4.12 A-7, K-52 |
| A8 | Gate "idle" undefined; sticky `apiError` | **Fixed.** `canSubmit` predicate; `apiError` is an idle attribute | §4.13, §4.7, K-46 |
| A9 | Sticky startup degradation | **Fixed.** Reason-scoped health, restored by any authenticated hook | §4.3, K-47 |
| A10 | `writing` masks other states | **Fixed.** Implicit message final | §4.6 Message, K-45 |
| A11 | GIT_EDITOR stripping + VISUAL wrapper break git | **Fixed.** Editor chain preserved; `GIT_EDITOR` fallback `true`; unarmed wrapper execs the user's editor | §3.2, P-INPUT-16 |
| A12 | Self-test every start pollutes history, flaky | **Fixed.** `selfTest:'once'` cache; nonce scrubbed; LP-47 | D-35, §3.1 step 15 |
| A13 | `whenBusy:'native'`, ack FIFO, `absorbed` | **Fixed.** `native` cut; one in-flight submit; `absorbed` state replaced by `mergedInto` for the unavoidable race | D-17, §4.4 |
| B1 | §2 not self-contained | **Fixed.** Kernel, public API, `ScreenSnapshot`, `ScreenStrings`, `InputJob`, `DeadlineKind`, channel health `off` all inline | §2 |
| B2 | I1 unsatisfiable | **Fixed** by construction: `CoreEvent = DomainEvent | InternalEvent`, `evolve` is the only writer of `domain`, lint-enforced; I7 added. (Dropping I1 was rejected because BRIEF requires an event-sourced core.) | §2.5, §2.9 |
| B3 | WP split | **Fixed.** (1) WP-09 and WP-10 merged; (2) fakes owned by L0 WPs; (3) profile assembly written once by WP-00 with fixed export names; (4) kernel scenarios in Phase 1 (WP-14) as acceptance specs; (5) additive model changes allowed per WP with an ICR note | §8 |
| C1 | tmux control mode | **Fixed (cut).** execFile only | D-07, §2.7.3 |
| C2 | Network sidecar breadth | **Fixed (cut)** to pass-through + liveness + faults; user proxy → channel off | D-21, §3.10 |
| C3 | Tail fingerprint ring, fs.watch, EXDEV | **Fixed (cut).** Poll + pread, full rescan + uuid dedup | §2.7.4 |
| C4 | Worker parse for > 8 MiB | **Fixed (cut).** Cap 32 MiB; parsing happens in the hook worker anyway (A7) | §3.5 |
| C5 | Owner control socket + lifecheck wake | **Fixed (cut)** | §3.12 |
| C6 | facades/callbacks + facade-swap test | **Fixed (cut).** Replaced by option-isolation and kernel-only-facade arch tests | D-33, §1.4 |
| C7 | 63 frozen error codes | **Fixed.** 18 public codes + `details.reason` | D-40, §2.2 |
| C8 | statusLine/registry channels | **Fixed (cut)** except the single registry read and the preflight scan | D-23 |
| C9 | 24-cell CI matrix | **Fixed.** Reduced matrix | §7 |
| C10 | `denyTmuxInBash` default on | **Fixed.** Opt-in | D-36 |
| D1 | Exact screen histogram brittle | **Fixed.** Per-frame golden labels + zero-unknown assertion | §6.2 |
| D2 | Permutation property vs deadlines | **Fixed.** Restricted to deadline-free pairs; A1/A10 removed most deadline sensitivity | §4.9, §6.2 |
| D3 | L-04 interrupt during thinking flaky | **Fixed.** Interrupt during `sleep 20` | §6.5 |
| D4 | L-11 depends on backoff | **Fixed.** Assert the first banner, then clear | §6.5 |
| D5 | L-06 cost | **Fixed.** Nightly | §6.5 |
| D6 | Fixed sleeps in real-tmux tests | **Fixed.** Condition polling with ceilings (rule in §6.5, applies to contract tests too) | §6.5 |
| D7 | 95/90 coverage → assertion-free tests | **Fixed.** 90/80 + table-row coverage + `expect.hasAssertions()` | §6.1 |
| E1 | Public options mirror internal config | **Fixed.** Small public options, `unstable_advanced`, `SessionSpec` mapping | §2.11, §2.12 |
| E2 | Defaults are API; SessionState public?; `Fact<` leak; two package copies | **Fixed.** `permissions` required; `SessionState` internal + leak grep extended; globalThis-keyed exit registry | §2.12, §1.3, §3.8 |
| F1 | LaunchAgent bakes stale absolute paths; attach replays whole transcript | **Fixed.** State-dir shim + `lifecheck-target.json` rewritten by every start + `lastRunOk` + `ccd lifecheck status`. The attach replay item is **moot** (attach removed; resume replays by Claude's own design). | §3.12 |

Rejected or deferred items (explicit): programmatic answers to MCP elicitations (deferred to v2: the `Elicitation` hook is blocking and its empty-answer semantics are UNVERIFIED; v1 surfaces `awaitingInput`); detach and `attach()` (deferred until the hook server can live outside the owner process, SEC §2.4 option 3); a `ClaudeSession.recover()` helper (deferred; `start({resume})` covers it); P-LIFE-50's cost payload extension (rejected: no reliable SessionStart cost fields exist in any source doc).
