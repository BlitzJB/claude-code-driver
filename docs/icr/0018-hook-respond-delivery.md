# ICR 0018 — a hook answer lost to a closing forwarder is reported (fix `worker-respond-result-dropped`)

Area: platform/hook-server (plus the minimal broker change it needs in `src/session/permission-broker.ts`).

## Problem

A held PermissionRequest's forwarder can close (hook timeout, turn abort, Claude exit) while our answer is in flight
between threads: the worker posts `{t:'closed'}`, but the main thread calls `respond()` before handling it. The transport
had already dropped the resolver, the worker ignored `unix.respond() === false`, the broker ignored any `closed` after
respond, and so `hook.responded{ok:true, clientGone:false}` stood. The record stayed `answered`, no `permission.needsKeys`
was published and dialog adoption stayed blocked (§3.7 steps 7–8). A second path: `unix.respond()` on a socket already
destroyed but whose `'close'` had not run yet deleted the entry, so no `closed` was ever posted.

## Change

1. Worker protocol (worker.ts): every `{t:'respond'}` is answered by `{t:'responded', hookSeq, delivered}`.
   `delivered:false` = the held request was already gone; its `{t:'closed'}` was posted before it.
2. unix-server.ts: `respond()` on a destroyed-but-not-yet-closed socket calls `sink.closed(seq, timeout|client_gone)`
   itself (the later `'close'` no longer finds the entry).
3. transport.ts: after `respond()` the `closed` resolver moves to a `#responding` map until the worker confirms. A
   `closed` arriving there, or `responded{delivered:false}` (→ `client_gone`), resolves `RawHookEvent.closed`;
   `delivered:true` drops it. Worker death releases these too. `RawHookEvent.closed` (ports.ts, comment only) therefore
   means "the forwarder closed before our answer reached it", a superset of "before we answered".
4. permission-broker.ts: a `closed` that resolves after we responded emits a second
   `hook.responded{hookSeq, ok:false, clientGone:true}`. The core's existing `onHookResponded` then moves an `answered`
   record to `dialogOnly` + `permission.needsKeys` (and only logs `hook_respond_failed` for a resolved or dialogOnly one).
   No model or core change.

Deviation from DESIGN §2.6/§3.7 text: `hook.responded` may now appear twice for one hookSeq (first `ok:true`, then the
correction). A successfully written answer is still not proof of delivery (unchanged); only a forwarder gone before the
write is detected.

## Tests

`test/unit/platform/hook-server.test.ts` (unix-server destroyed-socket gap; worker `responded{delivered}`; real
transport with the main thread stalled across the close; no late `closed` after a delivered answer) and
`test/unit/session/permission-broker.test.ts` (late close → `hook.responded{ok:false, clientGone:true}`).
