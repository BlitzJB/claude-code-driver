# ICR 0026 — Release a held PermissionRequest that L1 does not accept

Area: channels/hooks (`src/channels/hooks/normalize.ts`), with the minimal L3 wiring the fix needs
(`src/session/kernel.ts`, `src/session/permission-broker.ts`).

## Problem

The unix transport holds every PermissionRequest that parses as JSON (under `maxHeld`) and forwards it with
`holdable: true`, without looking at the payload. When `normalizeHook` rejects it (`eventMismatch` → no observation;
`malformed`: not an object, truncated, missing/empty `tool_name`, or a normalizer failure → one `unknown`), no
`permission.requested` reaches the core, so no PermissionRecord carries that hookSeq and nothing ever emits `hook.respond`
for it. The forwarder stayed blocked — and used a `maxHeld` slot — until Claude's own hook timeout
(`ceil(timeoutMs/1000)+30` s), stalling background-agent requests (hook awaited before any dialog, §9.2) and leaking the
slot even when the dialog was adopted from the screen. ICR 0002 items 4/5 define the rejection results but say nothing about
the held socket; caveats/hooks-transport.md rule 4 (fail open, release every held request) and §9.2 ("the library must
release held requests itself") require the release.

## Change

- `normalize.ts` exports `heldUnclaimed(raw, res)`: true when `raw.holdable` and `res` (undefined = the normalizer failed)
  contains no `permission.requested`.
- `KernelHost.ingestHook` now returns that boolean (was `void`; spec deviation: L3-internal interface).
- The launch hook sink passes it on: after `trackHookEvent`, an unclaimed event goes to the new
  `PermissionBroker.releaseUnclaimed(raw)`, which answers `respond(hookSeq, null)` (empty reply → Claude shows its native
  dialog at once, adopted under §3.7 step 8) and emits `hook.responded` (the core ignores a hookSeq without alias; the trace
  shows the release). Events buffered before the broker exists keep their flag, and a held event is never dropped by the
  1024-entry early buffer cap (held events are themselves capped by `maxHeld`).

The decision stays out of the core: a rejected hook never becomes an observation the core could key a release on
(`eventMismatch` has none by ICR 0002), and the transport layer must not parse payload semantics.

Tests: `test/unit/channels/hooks-normalize.test.ts` (heldUnclaimed truth table), `test/unit/session/permission-broker.test.ts`
(releaseUnclaimed), `test/kernel/permissions.test.ts` (end to end: malformed / mismatched held requests are answered at once,
`held` back to 0, no `permission.requested`).
