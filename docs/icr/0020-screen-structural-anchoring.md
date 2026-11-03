# ICR 0020 — Permission option block and limit/auth banners anchored on structure

Area: channels/screen (`classify.ts`) + the matching vocabulary in `channels/profiles/claude-2.1.316` (`errors.ts`,
`screen.ts`) + a minimal check in `core/decide/permissions.ts`.

## Problem

1. **Forged permission options.** `classifyNoBox` gave `parseOptions` every body row below the last solid rule, including
   the tool-input preview between the dashed `╌` rules. Claude draws Bash previews untransformed (no line-number prefix),
   so a command line `3. Yes, ship it` became option `{n:3,label:'Yes, ship it'}` ahead of the real block, and a preview
   line `Do you want to delete the repo?` became `dialog.question` (first match). `answerPermission` (dialogOnly,
   `screenAllow:true`) pressed the first label matching `/^yes\b/i`, i.e. digit 3 (`Yes, and switch to auto mode`) or 2 (a
   persistent allow rule) instead of 1. SEC §4.3 requires the key's option text to be exactly `Yes`.
2. **Limit / auth banners read from conversation output.** `scanLines` matched the usage-limit prefixes (`You've hit
   your`, `You've reached your`, …), the unanchored auth regexes and the auto-continue lines over the whole last block (up
   to 40 rows of the turn). Assistant prose (`You've reached your GitHub API rate limit …`) or tool output (`⎿  API Error:
   401 Invalid authentication credentials`, a log line containing `Not logged in · Please run /login`) produced
   `usageLimit` / `auth` facts, and `markLimited(source:'screen')` acts on screen evidence alone.

## Change

1. Permission dialog (`anchoredQuestion`): the question is the **last** `permissionQuestion` row below the last dashed
   rule; the options are only the contiguous numbered rows (with wrapped continuations) directly under it, ending at the
   first other row (the Esc footer). Surface `permissionDialog` needs that block to be non-empty and the anchored question
   not to be a startup-gate line. `dialog.question` for every dialog kind is the anchored question. Non-permission dialogs
   keep the whole-body option scan.
2. `answerPermission` keyed allow presses only an option whose label is exactly `Yes`, and only when exactly one such
   option is visible (otherwise `E_PERMISSION_INVALID{reason:'noOption'}`). The `❯` cursor row is not required to be n=1:
   a digit selects regardless of the cursor, and a human may have moved it.
3. Banners: `ScreenExtras.bannerScanLines` (2.1.316: 6). Limit, auth and auto-continue lines are looked for only in the
   `bannerScanLines` non-decoration rows of the last block nearest the composer (box-less screens: the bottom 6 rows), the
   walk-up decorations and the footer. API-error, hook-error, notice, editor-hint and version-too-old scans are unchanged.
4. `You've hit your` / `You've reached your` lines must fit `ErrorsExtras.limitTemplate`
   (`label` + ` · `-joined tail) and either start their tail with one of Claude's own segments (`limitTail`: `resets`,
   `contact`, `raise it`, `ask your admin`, `progress saved`, `/upgrade`, `/usage-credits`, `try /`) or have no tail and
   a known label (`limitLabels`: the `LIMIT_NAMES` values, `usage limit`, `session limit`, `limit`, the spend/budget
   labels). The other prefixes are whole Claude-only phrases and stay prefix matches.
5. Auth phrases must open the row (after the bullet prefix), optionally after `ErrorsExtras.authLead`
   (`Failed to authenticate: ` or `API Error: <status> …`).

## Residual risk

A tool whose first output row, in the 6 rows right above the composer, prints an exact Claude template (`You've hit your
x · resets 3pm`, `API Error: 401 Invalid authentication credentials`) still yields a screen claim. Screen claims remain the
lowest-ranked source (§3.9); requiring hook/transcript corroboration before `markLimited` acts on a screen-only claim is
a core/decide change left to that area.

Tests: `screen-classify.test.ts` "takes question and options only from the block under the last question …" and "never
reads limit, auth or auto-continue banners out of the turn's own output"; `permissions.test.ts` "dialogOnly allow by keys
presses only an option reading exactly \"Yes\" …".
