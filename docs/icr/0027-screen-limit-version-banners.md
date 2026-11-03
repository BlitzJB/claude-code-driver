# ICR 0027 — Legacy limit phrases and version-too-old read only as whole Claude banner rows

Area: channels/screen (`classify.ts`) + vocabulary in `channels/profiles/claude-2.1.316/errors.ts`. Amends ICR 0020 §Change 3–4.

## Problem

1. ICR 0020 kept every usage-limit prefix other than `You've hit/reached your` as a bare `startsWith` match ("whole
   Claude-only phrases"). Tool output (`⎿  Usage limit reached for key sk-xyz, retry later`) or prose
   (`⏺ 5-hour limit reached is what the docs say`) in the banner rows yielded `usageLimitLine` → `markLimited(source:'screen')`.
2. ICR 0020 left the version-too-old scan over the whole last block (≤ 40 rows) and unanchored. A grep result or assistant
   text quoting `Claude Code X does not support this model; version Y or newer is required` produced the `versionTooOld`
   claim, which publishes `E_CLAUDE_VERSION_TOO_OLD` and fails the running main turn (`stop_failure`) while Claude keeps
   working. This contradicts P-REV-29.

## Change

1. Every non-`You've …` limit prefix must cover the whole row: after the prefix (for a prefix ending in an
   argument-taking keyword such as `Limit reached · resets`, after its head `Limit reached`) only
   `ErrorsExtras.limitPrefixRest` may follow: nothing, an optional ` again`, a ` · ` / ` ∙ ` / ` - ` tail whose first segment
   is one of Claude's own (`resets`, `limit resets`, `reset at`, `contact`, `raise it`, `ask your admin`, `progress saved`,
   `add funds`, `continuing …`, `/upgrade`, `/usage-credits`, `/rate-limit-options`, `Run /…`, `try /…`), or the legacy
   `. Your limit will reset at …` sentence; an optional final `.`.
2. Version-too-old is read only in the banner rows (same set as limit/auth: `bannerScanLines` rows nearest the composer,
   decorations, footer) and the phrase must open the row after the bullet prefix, optionally after
   `ErrorsExtras.versionLead` (`API Error: [<status> …]`).

## Residual risk

As ICR 0020: an exact Claude template printed by a tool in the 6 rows above the composer still yields a screen claim.
A version-too-old error whose phrase wraps onto a row starting with JSON (`"message":"Claude Code …`) is not read from the
screen; the transcript / StopFailure evidence remains authoritative for it (LC §11).

Tests: `screen-classify.test.ts` "reads legacy / Wio limit phrases only as whole Claude rows …" and "reads version-too-old
only from an error banner above the composer …".
