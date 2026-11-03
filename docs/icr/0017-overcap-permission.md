# ICR 0017 — PermissionRequest not held by the transport (over maxHeld) becomes a dialogOnly record

Defect `overcap-permission-treated-as-held` (channels/hooks fixer). When `held.size >= maxHeld`, the unix hook server
answers the PermissionRequest `{}` at once and emits it with `holdable:false` (SEC §2.7, DESIGN.md:1485). The core
treated it as held: a `pending` record with a `hookSeq` that was never held, policy or host answers went to
`hook.respond` (which failed), the record stayed `answered` (open), and adoption of the visible native dialog was blocked
by `anyOpenRecord`. Claude waited at a dialog no automation answered, and the host got a `permission.answered{via:'hook'}`
for an answer Claude never got. This contradicts §3.7 step 8 and P-REV-13.

## Model change (`src/model/observation.ts`, additive)

`permission.requested` gained an optional `holdable?: false`. Absent means held (all existing producers are unchanged).
`normalizeHook` (`src/channels/hooks/normalize.ts`) sets it when `raw.holdable` is false.

## Core behaviour (`src/core/decide/permissions.ts`)

1. `onPermissionRequested` with `holdable:false`: the record is born `dialogOnly` with **no** `hookSeq` and no hookSeq
   alias. It keeps the hook data (tool name, input, suggestions, binding, agent), which is richer than a screen-only
   adoption, and it stands for the visible dialog (so no second, adopted record is minted). The core publishes
   `permission.requested` and then `permission.needsKeys`, arms the policy deadline, and records the diag
   `permission_not_held`. Policy is applied as for an adopted dialog: `deny` denies by keys (Escape). Every other policy
   asks the host, because an allow cannot be written to a hook and an allow by keys needs `screenAllow` and a visible
   "Yes".
2. `onHookResponded`: an `answered` record whose `hook.respond` failed (`ok:false`, not only `clientGone`) moves to
   `dialogOnly` and gets `permission.needsKeys` (now with its turnKey). The undelivered hook `ourAnswer` is dropped, so the
   host can answer the remaining native dialog by keys (`answerPermission` refuses a record that has `ourAnswer`). Later
   tool evidence then credits the decision to `user_keys`, not `hook`. This also applies to the existing `clientGone`
   path.

Tests: `test/unit/core/permissions.test.ts` ("over the held cap ...", "hook.responded{ok:false} ...") and
`test/unit/channels/hooks-normalize.test.ts` ("... carries holdable:false").
