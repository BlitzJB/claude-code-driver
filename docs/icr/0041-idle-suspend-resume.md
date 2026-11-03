# ICR 0041: idle suspend and transparent resume

Additive. User request (2026-11-04): after a configurable idle time, stop Claude to free the machine. The next call that
needs Claude resumes the same conversation and then runs. Active permission, question and plan-approval prompts must be
handled safely.

## Public surface

- Option `idle: { suspendAfterMs: number }` (≥ 1000). Off when absent.
- `session.suspend()`: suspend now. It rejects `E_BUSY` (`details.blocker` names the first blocker, `details.blockers` all of them) when the session is not
  suspendable.
- `session.resume()`: resume now. It resolves at ready and is a no-op when the session is live.
- Status `{ kind: 'suspended', since, claudeSessionId }`.
- Events `suspended { claudeSessionId, reason: 'idle' | 'manual', interrupted }` and
  `resumed { claudeSessionId, durationMs }`.
- `waitForIdle()` and `waitForQuiescence()` treat a suspended session as idle and quiescent.

## When a session may be suspended

`suspendBlockers(core)` (core/selectors.ts, pure) returns the reasons it may not be. Suspension needs **none** of them:

| Blocker | Why |
| --- | --- |
| lifecycle is not `ready` | starting, gated, closing, exited |
| a turn is active or queued | work in progress |
| background agents or tasks are running, or a task notification is still expected | they die with the process |
| any open permission request (pending, answered, adopted from the screen), including background agents' requests and `AskUserQuestion` / `ExitPlanMode` | **a suspend must never deny, drop or answer a prompt**; it waits until the prompt is resolved |
| a pending input request (MCP elicitation, unknown modal) | a human may be answering it |
| an input job is running, or the composer is not clean (dialog, editor, copy mode) | keystrokes in flight |
| an open model call or tool run | work in progress |
| usage-limited, auth required, compacting | the core owns those wake-ups |
| in-session scheduled tasks (`session_crons` from the Stop hook) | `/loop` and cron jobs live inside the Claude process |

The idle timer measures how long the session has been **continuously** suspendable. Any state change that adds a blocker
cancels it; screen noise that changes nothing does not reset it.

## The suspend sequence (session/kernel.ts)

1. **Decide.** The kernel checks the blockers on the current state. Any blocker means it does not suspend
   (`session.suspend()` rejects `E_BUSY`).
2. **Commit.** It sets the phase to `suspending`. From now on, a command that needs Claude waits for the resume that
   follows the suspend instead of racing it.
3. **Checkpoint.** It records the transcript tail checkpoint, the latest Claude session id (after `/clear` this is the new
   id), the current permission mode and the current model.
4. **Detach, then stop.** Observations from the old launch are no longer stepped into the core. Claude gets SIGTERM
   (verified pid, then SIGKILL after the grace period) and the private tmux server, hook worker, proxy sidecar and
   owner-watch are torn down. The registry record is archived with reason `suspended`.
5. **Record.** A `session.suspended` observation moves the core to lifecycle `suspended`. The core clears deadlines,
   sets channel health to `off`, publishes `status.changed` and `session.suspended`.

If a hook that starts work (UserPromptSubmit, PreToolUse, PermissionRequest) arrives between commit and stop, the work is
cut off. That needs a human typing into the pane in the same few milliseconds. The `suspended` event then carries
`interrupted: true`, and a `warning` names it. Held permission requests in that window are released unanswered, never
allowed or denied by policy.

## The resume sequence

Triggered by `prompt.send`, `slash.run` (`command`, `usage`), `mode.set`, or `session.resume()`.

1. Phase `resuming`. Concurrent triggers share one resume. Commands queue behind it in call order.
2. A fresh core from `resumeCore(prev, init)` (core/resume.ts, pure). It keeps every key counter, so new keys and event
   sequence numbers continue without collisions. It keeps the conversation history (turns, tools, agents, permissions,
   messages, model calls, generations, token totals). It resets everything per process (lifecycle, channels, claims,
   deadlines, input jobs, gates, auth, exit).
3. Launch with `--resume <latest id>`, the current permission mode and model, and the tail starting at the checkpoint, so
   no history is replayed. A stale checkpoint (the file was replaced) falls back to replaying from the beginning, marked
   as history.
4. The usual start protocol: SessionStart, a stable main screen, self-test (normally cached). On ready the kernel
   publishes `session.resumed` and dispatches the queued commands.
5. **Failure** (trust revoked, logged out, tmux or Claude missing, startup timeout, gate): the launch is aborted, the core
   returns to `suspended`, the command that triggered the resume rejects with the start error (its usual public code),
   and a `warning` is published. Commands queued behind it reject with the same error. The next call tries again; the
   kernel never retries on its own.

## Commands while suspended

| Command | Behaviour |
| --- | --- |
| `send`, `command`, `usage`, `setMode` | resume, then run |
| `interrupt`, `turn.interrupt`, `turn.stop`, `prompt.cancel` | no-op, no resume |
| `respondToPermission`, `answerQuestion`, `approvePlan` | `E_PERMISSION_INVALID` (nothing is pending), no resume |
| `wakeNow` | no-op |
| `close()` | ends the session without starting Claude; `session.exited { reason: 'closed' }` |
| `close()` during suspending | waits for the suspend, then ends |
| `close()` during resuming | aborts the launch (the existing closed-during-start path), then ends |
| `debug.viewCommand()` | `''`; `debug.captureScreen()` rejects `E_SESSION_EXITED { reason: 'suspended' }` |

## Out of scope

- Resuming after a crash. A crashed session stays exited.
- `effort` changed through `/effort` mid-session is not tracked; a resume uses the configured `effort`.
- A human attached read-only to the pane sees the pane disappear on suspend.
