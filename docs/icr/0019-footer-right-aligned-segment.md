# ICR 0019 — Footer row with a right-aligned segment (250-col panes)

Area: channels/profiles (2.1.316 `screenExtras`) + the minimal matching change in `channels/screen/classify.ts`.

## Problem

caveats/screen-parse.md §2 / §5 and input.md §5 put the effort indicator (`◐ medium · /effort`), the
`ctrl+g to edit in …` hint and the usage warning on the line above the top rule. That holds for the 111-col corpus. At the
default 250-col pane (session/config.ts) Claude draws them **on the footer row itself**, right-aligned after a run of
spaces: `⏸ manual mode on · esc to interrupt<~190 spaces>◐ medium · /effort` (P0 run-main/run-withtmux `cases.jsonl`,
live-smoke run-48997 / run-46445 traces). The footer regexes accepted only ` · ` or end-of-line as separators, so
`footer.busy` was false while Claude was working (78/201 busy footers in run-48997) and the mode label was lost
(`mode:null` → input-policy `footerMode()` fell back to `default`: `setMode('default')` returned `ok` with no key while in
auto/plan, `setMode('auto')` ran to `modeNotReached`).

## Change (spec deviation: the footer row grammar)

1. `ScreenExtras.footerRightGap` (2.1.316: `/ {2,}/u`, applied to the trimmed footer row). The footer row's **left
   segment** is the text before the first gap; the mode label, hint list and busy flag are parsed from it only. The right
   segment is split on ` · ` and appended to `footer.hints`. A right segment never sets `busy` or the mode.
2. `ScreenSnapshot.footer.raw` is the left segment of the first footer row (it was the whole trimmed row). to-facts'
   "hints-only footer means mode `default`" rule therefore also holds for `? for shortcuts · ← for agents<gap>◐ medium`.
3. `pasting`, `ctrlCExitArmed`, `editorHint` and the other line facts still scan the full footer rows (a right-aligned
   `ctrl+g to edit in …` on the footer row still sets `editorHint`).
4. Partial-frame detection (`isFooterLike`) tests the left segment too.
5. Defense in depth: `screenStrings.footer.escToInterrupt` also accepts a two-space gap after `to interrupt`.

Tests: `screen-classify.test.ts` "reads busy and mode from the left segment of a 250-col footer row …" and
`screen-to-facts.test.ts` "maps footer modes on a 250-col footer row …", built from the verbatim captured row texts
(`screen-frames.ts` `wideFooter`). The scrubbed 949-frame corpus (`fixtures/screens`) is unchanged; adding scrubbed
250-col captures to it is left to the corpus owner.
