# ICR 0029 — API review fixes 2 (per-event tool/subagent snapshots, waitFor abort and predicate errors)

Area: api (`src/api/map-events.ts`, `src/api/claude-session.ts`). No model, core or session change.

## 1. `toolStarted` / `toolEnded` / `subagentStarted` / `subagentEnded` describe their own event

The kernel port hands every listener one `SessionState` per batch (`session/loop.ts` flush: the state at flush time), and a
ring replay (`subscribe({fromSeq})`, `events({fromSeq})`) pairs old events with the current state. `toPublicEvents` built
these four events from `d.tools[...]` / `d.agents[...]`, so a live `toolStarted` could already say `awaitingPermission`,
and a replayed one `succeeded` with an `endedAt`.

Change (clarifies §2.12; no type change): the record in `d` now supplies only what does not change after creation
(visibility, `key`, `turnKey`, `subagentKey`, `startedAt`); the rest comes from the event:

- `toolStarted`: `name`, `input`, `toolUseId` from the `tool.started` payload, `state: 'pending'` (a ToolRun is always
  created `pending` or `proposed`, shown as `pending`, §10.3), no `endedAt`, `provenance` of the event.
- `toolEnded`: `state` from the `tool.ended` payload, `endedAt` = the event time, `provenance` of the event.
- `subagentStarted`: `agentId`, `agentType`, `background` from the payload, `state: 'running'`, no `endedAt`.
- `subagentEnded`: `state: 'stopped'`, `endedAt` = the event time.

`turnEnded`'s `TurnResult.tools` is still read from the batch state (documented on `toTurnResult`): a tool resolved after
its turn ended may already show the later state there.

Tests: `test/unit/api/map-events.test.ts` ("per-event snapshots"), `test/unit/api/kernel-contract.test.ts` (live and
`events({fromSeq:0})` replay over the real kernel).

## 2. `waitFor` / `waitForIdle` / `waitForQuiescence`: the caller's abort and predicate errors are passed through

`toPublicError` passes only a DOMException AbortError/TimeoutError through, so `abort(new Error(...))`, `abort('stop')`
and an exception from the host's own predicate surfaced as `E_INTERNAL{E_INVARIANT}` (the class of defect ICR 0023 #5
fixed for `start()`).

Change (refines DESIGN §2.10 "rejects E_WAIT_TIMEOUT / AbortError" for the public facade):

- the signal aborted and the rejection is not a library error → reject with `signal.reason` as is (a DOMException
  AbortError/TimeoutError when the host gave none, else exactly what it passed to `abort(reason)`, also a string; the
  kernel's `asError` wrap is not exposed), as `AbortSignal.throwIfAborted()` and `fetch` do;
- the host predicate threw → reject with that exact value.

Kernel failures keep their mapping (`E_TIMEOUT{E_WAIT_TIMEOUT}`, `E_SESSION_CLOSED`, …). Unlike `start()` (ICR 0023 #5) no
`ClaudeSessionError` is made for an abort: a wait has no side effect to report, and the caller recognises its own reason.

Tests: `test/unit/api/kernel-contract.test.ts` ("waitFor/waitForIdle reject with the caller abort reason …").
