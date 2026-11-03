# ICR 0024 — createKernel awaits the abort kill-close before rejecting

Area: runtime (`src/runtime/node.ts`).

## Change (clarification of §2.10 / §3.1 / ICR 0016 / ICR 0022)

When `createKernel({signal})` is aborted while `kernel.start()` is pending, the abort listener starts
`kernel.close({mode:'kill', reason:'aborted'})`. `start()` then rejects `E_SESSION_CLOSED` at its next `closing()` check and
leaves the teardown to that close (ICR 0022). createKernel used to rethrow the AbortError at once and drop the close
promise, so the rejection could reach the host while SIGKILL escalation, hooks/tmux shutdown, trust unseed, the registry
archive and kernel teardown were still running. No ClaudeSession existed yet, so `closeAll()` and the signal handlers
could not wait for it either.

createKernel now keeps the kill-close promise (one per kernel, shared by the listener, the catch branch and the
"aborted in the same tick as ready" branch) and awaits it before it rejects with the AbortError. This matches the existing
contract "rejects ... after the kernel tore everything down". The rejection shape stays as before (AbortError, which
ClaudeSession.start maps to `E_SESSION_CLOSED{aborted}`, ICR 0023 §5). Only the timing changes: the rejection now comes
after the kill-close finished.

Regression test: `test/unit/runtime/node-abort.test.ts`.
