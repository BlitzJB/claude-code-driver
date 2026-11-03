# ICR 0026 — session review fixes (reaper self-pid, registry update/archive race)

Fixes from the second review of `src/session/**`. Each item names its regression test.

## 1. The reaper's "caller's own records" shortcut requires the start time too (§3.8, D-28, P-LIFE-44)

`ReapOptions.selfPid` alone used to mark every `sessions/*.json` / `owners/*.json` entry with that pid as live. When an
earlier process had the same pid, for example node as pid 7 on every run of a container with `--init` and a persistent
state dir, or a reused pid on macOS, its stale record was never reaped. A trust key it had seeded was never released
(D-19 / ICR 0022), and its session dir counted as live for `sweepStale`.

- New `ReapOptions.selfStartTime`. An entry is skipped as "self" only when both its pid and its start time match;
  otherwise it goes through `isOwnerAlive` like any other owner. With `selfStartTime` absent the shortcut never applies.
  The caller's own records still survive a failed identity read, because `isOwnerAlive` then falls back to `isAlive`.
- The launcher now reads the owner identity (§3.1 step 3) before the reap and passes `selfStartTime`. `ccd lifecheck`
  passes only `selfPid`, so its pass relies on `isOwnerAlive` (no change needed there).

Test: `reaper.test.ts` "P-LIFE-44: a record (and owners/ file) of an earlier process with the caller's pid but another
start time is reaped". Fixtures that wrote the caller's records with a made-up start time now use the real one.

## 2. `updateSession` can no longer bring back an archived record

The kernel runs `registry.persist` fire-and-forget, and executors stop only after `lifecycle.close()` returns. A persist
could read `sessions/<key>.json` before teardown's `archive()` removed it and then rename it back afterwards. The record
then looked like another session using the same cwd (so the trust key was kept) and blocked `removeOwnerIfLast`.

- `RegistryStore.updateSession` and `RegistryStore.archive` are now serialised per record by an in-process mutex keyed by
  `<state root>\0<sessionKey>`, which every `RegistryStore` over the same state dir shares. Inside the mutex,
  `updateSession` re-reads the record, so once the record is archived it does nothing and returns `undefined`.
- Cross-process writers are unchanged. The reaper archives only records whose owner is dead, and only the owner updates
  its own records.

Test: `registry-store.test.ts` "a persist whose read happened before archive never writes the archived record back".

## 3. Tests only: identity is re-checked before SIGKILL

`terminateVerified` already re-verifies the identity after the SIGTERM grace, but no test covered that check. New case:
the pid is reused by a live stranger during the grace, the result is `identity-mismatch`, and only the SIGTERM was sent.
Test: `reaper.test.ts` "terminateVerified: the pid is reused by a stranger during the SIGTERM grace → no SIGKILL".
