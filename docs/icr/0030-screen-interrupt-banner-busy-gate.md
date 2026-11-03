# ICR 0030 — The interrupt banner is not read while Claude is still working

Area: channels/screen (`classify.ts`). Amends P-SCREEN-25 / DESIGN §4.6 (screen-only provisional interrupt).

## Problem

`interruptedBanner` was set whenever one of the `interruptScanLines` (6) non-decoration rows nearest the composer matched
`statusRegexes.interrupted`, whose ` · What should Claude do instead?` suffix is optional. A tool or hook output row reading
exactly `⎿  Interrupted` (e.g. a script whose SIGINT trap prints it) therefore claimed the banner while the spinner and the
busy footer (`esc to interrupt`) were up. The claim marks the turn interrupted (provisional, held); if no main-thread
activity revives it within `interruptConfirmMs`, `releaseHeldTurn` publishes `turn.ended` and frees the active slot while
Claude is still working. This contradicts P-REV-29 (tool output near the box is conversation text).

## Change

`interruptedBanner` is false when the frame shows Claude busy (`footer.busy`, or a status line of kind `spinner`,
`retrying`, `retryingUnparsed`, `stalled`, `noResponse`, `lowPriority` or `autoModeUnavailable`) or the turn completed
(status `done`, the `✻ Worked for …` line). After a real Esc interrupt Claude 2.1.316 draws no spinner, an idle footer and no
done line (screen-parse §4.6: the banner ends up as the candidate above the rule), so real banners are unaffected. The
`done` exclusion matters because the busy gate alone turns a long-lived tool-output row into a fresh claim edge when the
turn ends normally: the claim would first assert while the turn is `stopping` and mark it interrupted.

The bare `⎿  Interrupted` form stays accepted (screen-parse §4.6, VERIFIED-BIN), and the banner is not required to be the
closest row to the composer (assistant text drawn after it is legal), so neither of those alternative fixes is applied.

Test change: kernel K-13 drew the banner under a running spinner; it now draws it on a non-busy frame (as Claude does) and
resumes busy before the later `say`/Stop.

## Residual risk

A bare `⎿  Interrupted` tool-output row near the box on a non-busy frame with no done line (e.g. a turn that ends without
`Worked for`) still reads as a banner; if the turn is still `stopping` then, it is marked provisionally interrupted until
the transcript/Stop evidence resolves it.
