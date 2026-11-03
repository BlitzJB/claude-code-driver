# Using claude-code-driver

This is the user guide for the stable API (`claude-code-driver`). The normative types are in `docs/DESIGN.md` §2.12, and
the behaviour behind them is in §3–§4.

- [Starting a session](#starting-a-session)
- [Options](#options)
- [Sending prompts and reading turns](#sending-prompts-and-reading-turns)
- [Events](#events)
- [Status](#status)
- [Permissions](#permissions)
- [Commands, modes and interrupts](#commands-modes-and-interrupts)
- [Usage limits](#usage-limits)
- [Closing, crashes and recovery](#closing-crashes-and-recovery)
- [Errors](#errors)
- [Debugging](#debugging)
- [Security notes](#security-notes)
- [Live tests](#live-tests)
- [Known limitations](#known-limitations)
- [The kernel subpath](#the-kernel-subpath)
- [API at a glance](#api-at-a-glance)

## Starting a session

```ts
import { ClaudeSession, isClaudeSessionError } from 'claude-code-driver';

try {
  const session = await ClaudeSession.start({ cwd: process.cwd(), permissions: 'allowRead' });
  console.log(session.key, session.claudeSessionId, session.status.kind); // 'idle'
} catch (e) {
  if (isClaudeSessionError(e, 'E_TRUST_REQUIRED')) console.error('accept the folder once in `claude`, or pass trust: "seed"');
  else throw e;
}
```

`start()` runs the checks of DESIGN §3.1 in this order: config, Node version, runtime and state dirs, child environment,
Claude binary and version, account (`claude auth status`), settings layers, trust and resume holder, the optional
network sidecar, the hook transport, the settings file, the registry entry, tmux, the pane, the owner-watch, the
transcript tail, readiness and the self-test. Each failure has its own error code (see [Errors](#errors)), and everything
created so far is torn down in reverse order. No key is ever pressed at a startup gate: trust dialogs, onboarding,
"Settings Error" and similar screens reject the start instead.

Startup takes about 3 s on a warm machine. The self-test (one blocked nonce prompt, no model call) runs once per process,
Claude version, trust state and hook transport, and is cached for 24 h in the state dir.

## Options

| Option | Default | Notes |
|---|---|---|
| `cwd` | required | Must exist; resolved with `realpath`. Must be trusted unless `trust: 'seed'`. |
| `permissions` | **required** | A policy name, a handler, or `{ policy, timeoutMs = 120000, onTimeout = 'deny' \| 'tui' }`. |
| `model`, `effort` | Claude's | Passed as `--model` / `--effort`. |
| `permissionMode` | `'default'` | `'default' \| 'acceptEdits' \| 'plan'`. Dangerous modes need `unstable_advanced.permissions.allowDangerousModes`. |
| `sessionId` / `resume` | fresh uuid | `resume` replays the transcript history (events marked `replayed`, hidden unless you ask for `fromSeq: 0`). |
| `extraArgs` | `[]` | Only flags on the allowlist (§3.3). `--resume`, `--session-id`, `--dangerously-skip-permissions`, `--settings`, `--print` and the `*-file` flags are refused. |
| `claude` | auto | `{ bin, expectVersion }`; `expectVersion: 'any'` disables the version pin. |
| `env` | `{ inherit: 'minimal' }` | `'all'` passes your environment minus the strip list. `set` adds variables; provider switches (`ANTHROPIC_BASE_URL`, Bedrock/Vertex/…) are refused. `TMUX`/`TMUX_PANE` are never passed. |
| `trust` | `'require'` | `'seed'` inspects the workspace for risky project settings (hooks, env, helpers, MCP), then writes only `projects[cwd].hasTrustDialogAccepted`. |
| `network` | `false` | Opt-in CONNECT sidecar for request timing. It switches itself off (`channel network off`) when you already use a proxy. |
| `usageLimit` | `{ autoResume: true, resumePrompt: 'continue' }` | See [Usage limits](#usage-limits). |
| `debug` | `{ raw: 'meta' }` | `{ trace: '/abs/path.ccd.jsonl', raw: 'none' \| 'meta' \| 'full' }`. |
| `logger` | silent | Structured metadata only, never prompt or tool content. `consoleLogger('warn')` prints to stderr. The default logger also honours `CCD_LOG=debug\|info\|warn\|error`. |
| `signal` | none | Aborting it closes the session with `mode: 'kill'`. |
| `unstable_advanced` | `{}` | Any other `SessionSpec` field (`tmux`, `hooks`, `input`, `lifecycle`, `timeouts`, …). Validated, but may change in any minor version. |

Useful advanced fields: `lifecycle.stateDir` (registry, self-test cache, limit captures; default
`$XDG_STATE_HOME|~/.local/state/claude-code-driver`), `lifecycle.runtimeRoot` (session dirs and sockets; default `$TMPDIR`
on macOS), `hooks.transport: 'http' | 'unix' | 'auto'`, `input.method: 'editor' | 'pasteChunks'`, `tmux.cols/rows`
(≥ 120 × 24).

## Sending prompts and reading turns

```ts
const turn = session.send('List the files in src/ and stop.', { whenBusy: 'wait' }); // 'reject' → E_BUSY when not idle
const { promptId } = await turn.accepted;   // Claude's UserPromptSubmit (or the transcript) acknowledged it
for await (const e of turn) {               // this turn's events only
  if (e.type === 'toolStarted') console.log('tool', e.data.name, e.data.input);
  if (e.type === 'text') process.stdout.write(e.data.delta);
}
const r = await turn.done;                  // always resolves
// r.outcome: 'completed' | 'interrupted' | 'failed' | 'aborted' | 'notSubmitted' | 'withdrawn' | 'unknown'
// r.text: the final assistant text (Stop's last_assistant_message); r.tools: ToolRunSnapshot[]; r.error on failure
const ok = await session.send('…').completed(); // resolves only on 'completed', otherwise throws r.error

const ac = new AbortController();
const t2 = session.send('…', { signal: ac.signal }); // abort = t2.interrupt(): withdraws a queued turn, interrupts a running one
```

`turn.accepted` rejects with `E_SUBMIT_UNCONFIRMED`, `E_BUSY`, `E_INPUT_REJECTED`, `E_SESSION_EXITED` or
`E_SESSION_CLOSED`, and is never left as an unhandled rejection. `turn.done` never rejects. `turn.key` is a provisional
`pending:<n>` reference until the core has queued the prompt (normally one event-loop turn); `session.turn(key)` accepts
both. `turn.snapshot()` returns the current `TurnSnapshot`, and `TurnResult.refused` is `true` when Claude refused.

Prompts are sanitised before they are staged: control characters, bidi and zero-width characters and lone surrogates are
removed or rejected. A leading `!`, `?`, `&` or `#` gets a protective space. A prompt whose trimmed text starts with `/`
is rejected with `E_INPUT_REJECTED{leadingSlash}`, and `mentions: 'reject'` (advanced) refuses `@file` mentions. Prompts
are queued and submitted one at a time. A submission that Claude does not acknowledge within `submitAckMs` gets one
Enter retry and then ends `notSubmitted` with `E_SUBMIT_UNCONFIRMED`.

Turns that Claude starts by itself (task notifications from background agents, scheduled prompts, a human typing in the
pane) appear as `externalTurn` events and in `session.turns()`.

## Events

Subscribe with `session.on(type, fn)`, `session.onAny(fn)` or the async iterator
`session.events({ fromSeq, types, highWaterMark })`. Events are numbered (`seq`) without gaps. A consumer that falls
behind the retention ring gets one `gap` event. Main event types:

| Event | When |
|---|---|
| `ready` | the session is usable |
| `status` | the derived status changed (see below) |
| `turnQueued`, `turnStarted`, `turnEnded` | a library turn's lifecycle (`turnEnded` carries the `TurnResult`) |
| `externalTurn` | a turn Claude started itself (`kind: 'taskNotification' \| 'scheduled' \| 'autoContinue' \| 'human' \| 'unknown'`) |
| `text`, `message`, `textRetracted` | streamed text (MessageDisplay), the final message, a refusal retraction |
| `toolStarted`, `toolEnded` | a tool run (`ToolRunSnapshot`; `state` `succeeded \| failed \| denied \| interrupted \| unknown`) |
| `permissionRequested`, `permissionResolved` | a permission decision is needed, or was made (`by: 'library' \| 'tui' \| 'policy' \| 'unknown'`) |
| `subagentStarted`, `subagentEnded` | Agent-tool subagents (internal agents are hidden) |
| `modelCall` | API request phases (`started`, `waiting`, `streaming`, `retrying` with `attempt`/`retryInMs`, `stalled`, `ended`) |
| `compaction` | context compaction `started` / `ended` |
| `usageLimited`, `authRequired`, `authRestored` | account conditions |
| `inputRequested` | an MCP elicitation or an unknown modal is blocking the turn |
| `claudeSessionChanged` | `/clear` (or a resume or fork) switched Claude's session id |
| `channel` | a channel's health changed (`up \| degraded \| down \| off`) |
| `warning`, `security` | non-fatal problems, and security alerts (forged hook requests, unexpected input, settings tampering) |
| `gap` | events `from…to` were dropped for this consumer (it fell behind) |
| `exited` | the session ended (`SessionExitInfo`) |

Every event has `type`, `seq`, `at` (wall-clock epoch ms), `provenance`, `data` and, for turn-scoped events, `turnKey`.
`session.on()` returns an `Unsubscribe`. A listener that throws is reported as a `warning` and does not stop delivery.
`redactEvent(e)` returns a copy with credential-looking strings masked, for hosts that log events (pattern-based, best
effort). `provenance.confirmed` is `true` only when a non-screen source backs the event. Screen-only observations (a retry
banner while the network channel is off, an interrupt banner before the transcript confirms it) are `confirmed: false`.

## Status

`session.status` is the first matching entry of: `exited`, `starting`, `awaitingPermission` (a permission waits for an
answer), `awaitingInput`, `interrupted` (for 1.5 s after an interrupt), `authRequired`, `usageLimited`, `compacting`,
`runningTools`, `writing`, `modelRequest{phase}`, `idle{backgroundAgents, queued, quiescent}`. An API error of the last
turn shows as `idle.lastError`, not as a status. `waitForIdle()` waits for `idle`, and `waitForQuiescence()` additionally
waits until no background agent or task notification is pending.

## Permissions

```ts
const session = await ClaudeSession.start({
  cwd,
  permissions: {
    policy: async (req) => {
      if (req.toolName === 'Bash' && /^git (status|diff)\b/.test(String((req.toolInput as { command?: string }).command)))
        return { behavior: 'allow' };
      if (req.needs === 'planApproval') return undefined;         // decide later (event + approvePlan)
      return { behavior: 'deny', message: 'not allowed here' };
    },
    timeoutMs: 60_000,
    onTimeout: 'tui', // after 60 s, hand the request to the native dialog (a human can answer in the pane)
  },
});
session.on('permissionRequested', (e) => {
  if (e.data.needs === 'planApproval') void session.approvePlan(e.data.key, { approve: true, mode: 'acceptEdits' });
});
```

- A handler gets a `PermissionRequest`: `key`, `toolName`, `toolInput` (`unknown`, narrow it yourself), `suggestions`,
  `needs` (`decision`, `answers` or `planApproval`), `turnKey`/`toolKey`/`subagentKey` when bound, `background`,
  `requestedAt`, `deadlineAt` (when `onTimeout` applies) and a `signal` that aborts when the request stops being
  answerable (Claude withdrew it, the TUI answered, the session closed). A decision is `{ behavior: 'allow',
  updatedInput? }` or `{ behavior: 'deny', message?, interrupt? }`.
- The `timeoutMs` deadline (default 120 s) is enforced by the core. On timeout, `onTimeout: 'deny'` denies and
  `'tui'` leaves the request to the native dialog.
- Named policies: `deny`, `ask` (always the event), `allowRead` (Read/Glob/Grep/LS only inside `cwd`, with symlinks and
  `..` resolved), `dangerouslyAllowAll`. Requests that cannot be bound to exactly one tool run (ambiguous parallel calls,
  internal agents, a dialog adopted from the screen) are never auto-answered.
- A handler that throws, or returns an invalid decision, denies.
- `AskUserQuestion` needs `answerQuestion(key, answers)`, and `ExitPlanMode` needs `approvePlan(key, …)`. A plain allow is
  `E_PERMISSION_INVALID`.
- `updatedPermissions` destinations are rewritten to `session`, so nothing is ever persisted to your settings.
- If a PermissionRequest never reaches the library (for example the forwarder failed), the native dialog is adopted
  from the screen as `dialogOnly`. A deny then presses Escape. An allow by keys needs
  `unstable_advanced.permissions.screenAllow`.

## Commands, modes and interrupts

```ts
await session.command('/clear');                           // allowlisted: /clear /compact /model /effort /rename /context /usage (/cost) /status /help
await session.command('/permissions', undefined, { unsafe: true }); // others need unsafe; /exit /quit /tui /restart /resume /rewind never
await session.setMode('plan');                             // Shift-Tab until the footer shows the mode
const { turnKey } = await session.interrupt();             // one Escape; never Ctrl-C
```

Aliases are resolved first (`/new`, `/reset` → `/clear`; `/quit` → `/exit`), and the rules apply to the canonical name.

## Usage limits

When Claude reports a usage limit (StopFailure `rate_limit`, then the transcript's reset time, then the screen banner),
the session becomes `usageLimited` and the interrupted turn ends `failed` with `E_USAGE_LIMIT`. With `autoResume` (the
default), the library schedules a wake at the reset time plus a deterministic per-session jitter of 30–90 s. When the
wake fires it sends `continue` as an `autoContinue` turn. If the limit is still there, it re-arms up to 3 times and then
gives up with a `warning E_USAGE_LIMIT`. `session.wakeNow()` runs the wake check immediately. The wake uses wall-clock
time, so it also fires correctly after the host was asleep. While limited, `send(…, { whenBusy: 'wait' })` queues and
`'reject'` throws `E_USAGE_LIMIT`.

## Querying subscription usage

```ts
const u = await session.usage(); // runs Claude's /usage dialog: no model call, dismissed afterwards
u.session?.usedPct;   // e.g. 0   (current session window)
u.week?.usedPct;      // e.g. 98  (current week, all models)
u.week?.resetsText;   // "Nov 3 at 7:30pm (Etc/UTC)"
u.meters;             // every meter shown, including per-model weekly meters
```

It waits until the dialog has finished loading (at least one meter shown, no `Refreshing…`), capped by `timeoutMs` (default 5000); that is typically 0.5–2 s. If the cap is hit, the result has `partial: true`. Like any other command it waits for the composer, so while a turn is running it is queued. Reset times are the text Claude shows. If the dialog shows no meters (for example API-key auth or a dialog that is still loading after retries), it rejects with `E_ENVIRONMENT` and `details.reason: 'noMeters'`.

## Suspending idle sessions

A live session keeps a Claude process, a tmux server and a hook worker running. With `idle.suspendAfterMs`, the library
stops them once the session has been idle that long and brings the same conversation back on the next call that needs
Claude:

```ts
const session = await ClaudeSession.start({ cwd, permissions: 'allowRead', idle: { suspendAfterMs: 10 * 60_000 } });

session.on('suspended', (e) => console.log('suspended', e.data.claudeSessionId));
session.on('resumed', (e) => console.log('resumed in', e.data.durationMs, 'ms'));

// …an hour later: resumes Claude with --resume, then sends. The turn sees the whole earlier conversation.
const turn = session.send('Continue where we left off.');
```

**When it suspends.** Only when nothing could be lost: the session is idle and quiescent, nothing is queued, and there
is no open permission request, question, plan approval or MCP elicitation, including ones raised by background agents.
Background agents, in-session scheduled tasks (`/loop`, cron), usage limits, a pending login and compaction also hold it
off. The timer counts how long the session has been continuously in that state, so any activity starts it again. **A
suspend never answers, denies or drops a prompt**; a pending prompt simply keeps the session live.

**While suspended**, `status.kind` is `'suspended'` and `waitForIdle()` / `waitForQuiescence()` resolve. `send()`,
`command()`, `usage()` and `setMode()` resume first; concurrent calls share one resume and run in call order.
`interrupt()` and `turn.interrupt()` are no-ops that do not wake Claude. `close()` ends the session without starting
Claude. `debug.viewCommand()` returns `''`.

**The resume** continues the latest Claude session (the new one after `/clear`) with the permission mode and model the
session had, and picks the transcript up where it stopped. It takes about as long as `start()`, so the first call after a
suspend is a few seconds slower. Library keys and event `seq` numbers continue across any number of cycles.

**If a resume fails** (the folder is no longer trusted, you were logged out, tmux is missing), the call that triggered it
rejects with the usual start error, the session stays suspended, and the next call tries again.

You can also do it by hand: `await session.suspend()` (rejects `E_BUSY` with `details.blocker` and `details.blockers`
when something is in progress) and `await session.resume()`.

## Closing, crashes and recovery

```ts
const info = await session.close({ mode: 'graceful', graceMs: 10_000, waitForBackgroundMs: 60_000 });
// info.reason: 'closed' | 'crashed' | 'killed' | 'hangup' | 'startupFailed' | 'exitedByItself' | 'ownerGone'
await ClaudeSession.closeAll();       // every live session of this process (all copies of the package)
installSignalHandlers();              // opt-in: SIGINT/SIGTERM/SIGHUP close all sessions first
```

A graceful close optionally waits for background work, denies held permissions, types `/exit` and waits for the pane to
die. If `/exit` opens a dialog (for example "Background work is running"), it falls back to SIGTERM and then SIGKILL. It
then stops the owner-watch, the hook worker and the sidecar, kills the private tmux server and removes the session dir
and any trust key it added. `close()` is idempotent.

If your process dies, the detached **owner-watch** kills Claude and the tmux server within 2 s. `ccd lifecheck` (run it
from a LaunchAgent, systemd timer or cron with `ccd lifecheck install`) reaps anything left over. Only sessions named in
the library's own registry are ever touched. To continue the conversation, start again with the Claude session id from
`ccd lifecheck --json` or the trace header:

```ts
const s = await ClaudeSession.start({ cwd, permissions: 'deny', resume: claudeSessionId });
```

## Errors

Every rejection is a `ClaudeSessionError` with a public `code`, the internal code in `details.reason`, and `retryable`.

| Public code | Internal reasons (`details.reason`) |
|---|---|
| `E_CONFIG` | `E_CONFIG_INVALID` (unknown key, missing `permissions`, bad value), `E_FORBIDDEN_ARG`, `E_FORBIDDEN_ENV`, `E_UNSUPPORTED_FEATURE` |
| `E_ENVIRONMENT` | `E_NODE_UNSUPPORTED`, `E_TMUX_NOT_FOUND`, `E_TMUX_UNSUPPORTED`, `E_CLAUDE_NOT_FOUND`, `E_UNSAFE_RUNTIME_DIR`, `E_SOCKET_PATH_TOO_LONG`, `E_KEYBINDING_CONFLICT`, `E_NOT_ONBOARDED`, `E_CONFIG_CORRUPT`, `E_CHANNEL_DOWN`, `E_NETWORK_UNAVAILABLE`, `E_HOST_LOOP_LAG` |
| `E_VERSION_MISMATCH` | `E_CLAUDE_VERSION_MISMATCH` (not 2.1.316), `E_VERSION_POLICY`, `E_CLAUDE_VERSION_TOO_OLD` |
| `E_AUTH` | `E_LOGIN_REQUIRED`, `E_AUTH_METHOD_UNSUPPORTED` (API key), `E_API_PROVIDER_UNSUPPORTED`, `E_AUTH_REQUIRED` |
| `E_TRUST_REQUIRED` | `E_TRUST_REQUIRED` (the cwd is not trusted: `trust: 'seed'` or accept it once in `claude`), `E_WORKSPACE_RISK` (`seed` found risky project settings) |
| `E_STARTUP` | `E_STARTUP_GATE`, `E_STARTUP_EXITED`, `E_SESSION_ID_IN_USE`, `E_RESUME_NOT_FOUND`, `E_SETTINGS_INVALID`, `E_SELFTEST_FAILED` |
| `E_HOOKS_UNAVAILABLE` | `E_HOOKS_DISABLED_BY_USER` (`disableAllHooks`), `E_HOOKS_BLOCKED_BY_POLICY`, `E_HOOKS_UNAVAILABLE` |
| `E_INPUT_REJECTED` | `E_INPUT_REJECTED` (`leadingSlash`, `mention`), `E_INPUT_INVALID`, `E_COMMAND_FORBIDDEN`, `E_MODE_FORBIDDEN` |
| `E_SUBMIT_UNCONFIRMED` | the submission was not acknowledged (retryable: it may have been typed) |
| `E_BUSY` | `E_BUSY` (not idle with `whenBusy: 'reject'`), `E_NOT_READY`, `E_INPUT_GATED` (all retryable) |
| `E_PERMISSION_INVALID` | `E_PERMISSION_UNKNOWN` (no such key), `E_PERMISSION_INVALID` (a decision that does not fit the request) |
| `E_TURN_FAILED` | `E_TURN_INTERRUPTED`, `E_TURN_API_ERROR`, `E_TURN_STALLED` (the turn's fate was lost while the session lives), `E_TURN_ABORTED`, `E_TURN_REFUSED`, `E_TURN_BLOCKED_BY_HOOK` (a user UserPromptSubmit hook) |
| `E_USAGE_LIMIT` | the account hit a usage limit |
| `E_SESSION_CLOSED` | after `close()`, or `start()` aborted by its signal (`detail: 'aborted'`) |
| `E_SESSION_EXITED` | `E_SESSION_EXITED` (Claude exited; also any turn ended by the process exit), `E_HOOK_PORT_LOST` (the hook worker died), `E_OWNER_GONE` |
| `E_SECURITY` | `E_SECURITY_HOOK_FORGERY`, `E_SECURITY_UNEXPECTED_INPUT`, `E_SECURITY_SETTINGS_TAMPERED`, `E_INPUT_TAMPERED` (the session is killed) |
| `E_TIMEOUT` | `E_WAIT_TIMEOUT` (`waitFor*`), `E_STARTUP_TIMEOUT` |
| `E_INTERNAL` | `E_INVARIANT`, `E_LISTENER_THREW`, `E_TRANSCRIPT_REWRITE`, `E_SCREEN_UNKNOWN` |

The 18 public codes are frozen (`PUBLIC_ERROR_CODES`). The internal reasons are documented but may grow. `retryable` is
`true` for `E_SUBMIT_UNCONFIRMED`, `E_BUSY`, `E_NOT_READY`, `E_INPUT_GATED`, `E_TURN_API_ERROR`, `E_TURN_STALLED`,
`E_USAGE_LIMIT`, `E_STARTUP_TIMEOUT` and `E_WAIT_TIMEOUT`. `isClaudeSessionError(e, code?)` is duck-typed, so it also
works across two installed copies of the package. `waitFor*` rejects with your own `signal.reason` when your signal
aborts, and passes through an exception your predicate throws.

## Debugging

- `session.debug.viewCommand()` (or `ccd view <sessionKey>`) prints `tmux -L <sock> attach -r -t =<session>:`, a
  read-only view of the live pane.
- `debug: { trace: '/abs/session.ccd.jsonl' }` writes a DebugRecord trace (0600). `raw: 'meta'` (the default) keeps
  lengths and hashes only. `raw: 'full'` keeps payload text, so redact it before sharing (`pnpm fixtures:scrub`).
  `ccd trace explain <file> --event <seq>` shows which input caused an event. `ccd trace replay` re-derives the events.
- `CCD_LOG=debug` turns on structured logs on stderr when you did not pass a `logger`.
- Every session keeps a small ring of the last 2 000 raw records, filtered to "narrow" content. On the first real usage
  limit it writes a scrubbed capture to `<stateDir>/limit-captures/` for replay.

## Security notes

- Hook endpoints listen on `127.0.0.1` only, require a 64-hex token, check Host, Origin and Content-Type, and answer from
  a worker thread, so a busy host never stalls Claude. The token is never written into argv, the transcript or a log.
- The child gets a minimal allowlisted environment. Your own proxy variables are passed through. `TMUX`/`TMUX_PANE` are
  removed. Provider switches are refused.
- The settings file is written `O_EXCL`, mode 0600, and its sha256 is verified. A changed file kills the session
  (`E_SECURITY_SETTINGS_TAMPERED`).
- Prompts are staged through a private editor shim. The library never types prompt text as keys and never sends
  `C-c`/`C-u`/`C-l`.
- `trust: 'seed'` only writes the trust key after `inspectWorkspace` finds no risky project settings (or you set
  `unstable_advanced.trust.acceptRisks`), and it removes the key again on close.

## Live tests

The gated live suite (`test/live`, L-01…L-13) drives the real Claude 2.1.316 with your subscription:

```sh
pnpm build                                                  # L-08 runs the built package in a child process
CCD_LIVE_MAX_PROMPTS=10 pnpm test:live                      # `test:live` sets CCD_LIVE=1
CCD_LIVE_NIGHTLY=1 CCD_LIVE_MAX_PROMPTS=15 pnpm test:live   # also L-06, L-10, L-11
```

Each test skips unless `node_modules/@anthropic-ai/claude-code/bin/claude.exe --version` prints `2.1.316`. Sessions run in
fresh directories under `/private/tmp/claude-<uid>/ccd-live/<pid>/`, so `/private/tmp` must be trusted in Claude. The
prompt budget `CCD_LIVE_MAX_PROMPTS` (default 10) is shared by all live files, and a test that would exceed it fails.
`CCD_LIVE_TRACE=1` writes a trace per session, and `CCD_LIVE_KEEP=1` keeps the run directory. Teardown kills only the
tmux servers named in this run's own registry. The real-client hook contract test sends no model prompt:
`CCD_LIVE=1 pnpm exec vitest run --project contract test/contract/claude-hook-client.test.ts`. Manual sleep and launchd tests are in `docs/MANUAL-TESTS.md`.

## Known limitations

The short version: Claude Code 2.1.316 only, subscription login only, macOS/Linux, no live Bash output, no attach, no
agent teams, MCP elicitations need a human, no in-pane `/resume` or `/rewind`, and usage-limit handling has not met a
real limit yet. Under a managed `allowManagedHooksOnly` policy the self-test nonce reaches the model once before
`start()` fails. `env.set` proxy variables are ignored. The full list, with every residual risk and every open live
probe, is in [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).

## The kernel subpath

`claude-code-driver/kernel` (`@experimental`) exposes `createKernel(spec: SessionSpec, { logger, signal })`, which
resolves to a `SessionKernel` (`dispatch(command)`, `subscribe(listener, { fromSeq })`, `getState()`, `waitFor`,
`setPermissionHandler`, `close`). It also exports the read-only selectors and the model types. Use it to build a
different facade. The stable API is a thin mapping over this port (DESIGN §2.10).

## API at a glance

Exports of `claude-code-driver`: `ClaudeSession`, `installSignalHandlers`, `ClaudeSessionError`, `isClaudeSessionError`,
`PUBLIC_ERROR_CODES`, `consoleLogger`, `redactEvent`, `SUPPORTED_CLAUDE_VERSION` and the types listed below. The
committed declaration report is `etc/claude-code-driver.api.d.ts` (`pnpm check:api` fails when it drifts).

| Member | Notes |
|---|---|
| `ClaudeSession.start(opts)` | resolves at ready |
| `ClaudeSession.closeAll()` | every live session of the process |
| `key`, `cwd`, `claudeSessionId` | identifiers (`claudeSessionId` changes on `/clear`) |
| `state`, `status` | `SessionSnapshot`, `AgentStatus` |
| `exited` | `Promise<SessionExitInfo>`, always resolves |
| `send(prompt, { whenBusy, signal })` | returns a `Turn` (`key`, `prompt`, `accepted`, `done`, `completed()`, `snapshot()`, `events()`, `interrupt()`, async-iterable) |
| `command(name, args?, { unsafe })` | slash commands; resolves `{ output? }` |
| `interrupt()` | one Escape, or deny+interrupt of a held permission; resolves `{ turnKey? }` |
| `respondToPermission(key, decision)`, `answerQuestion(key, answers)`, `approvePlan(key, { approve, mode?, feedback? })` | answer a `permissionRequested` |
| `setMode(mode)` | `'default' \| 'acceptEdits' \| 'plan'` |
| `usage({ timeoutMs, signal })` | current subscription usage from `/usage` (no model call); resolves `UsageInfo` |
| `suspend()`, `resume()` | stop Claude and keep the session; resume it (also automatic with the `idle` option) |
| `wakeNow()` | run the usage-limit wake check now |
| `on(type, fn)`, `onAny(fn)`, `events({ fromSeq, types, highWaterMark })` | events (default high-water mark 1000) |
| `waitFor(pred, { timeoutMs, signal })`, `waitForIdle()`, `waitForQuiescence()` | resolve with a `SessionSnapshot` |
| `turn(key)`, `turns()` | a `Turn` by key, and every `TurnSnapshot` |
| `close({ mode, graceMs, waitForBackgroundMs })` | idempotent; `kill` during a graceful close escalates it |
| `debug.viewCommand()`, `debug.captureScreen()`, `debug.tracePath` | read-only attach command, the current pane text, the trace file |
| `[Symbol.asyncDispose]` | `await using` closes the session |

Types: `ClaudeSessionOptions`, `AgentStatus`, `ChannelName`, `ClaudeSessionErrorData`, `Logger`, `PermissionDecision`,
`PermissionHandler`, `PermissionKey`, `PermissionMode`, `PermissionRequest`, `Provenance`, `PublicErrorCode`,
`SessionEvent`, `SessionEventOf`, `SessionEventType`, `SessionExitInfo`, `SessionKey`, `SessionSnapshot`, `SubagentKey`,
`SubagentSnapshot`, `ToolKey`, `ToolRunSnapshot`, `Turn`, `TurnKey`, `TurnOutcome`, `TurnResult`, `TurnSnapshot`,
`Unsubscribe`, `UsageInfo`, `UsageMeter`.
