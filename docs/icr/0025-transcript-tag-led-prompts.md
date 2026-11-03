# ICR 0025 — Tag-led user prompts are real prompts (P-TX-06 narrowed)

Area: channels/transcript (`src/channels/transcript/normalize.ts`, `src/channels/profiles/claude-2.1.316/transcript.ts`).

## Change (spec deviation: P-TX-06, TF §4.2 item 6 / §9.17)

DESIGN P-TX-06 classifies not-real-user text with the binary regex `ZHe`
(`/^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/`). That regex is Claude's title / last-prompt
heuristic, not its turn logic: it matches any leading `<tag`, so a typed prompt such as `<b>bold</b> is not rendering` or
`<div> wrapper breaks layout` was recorded `prompt.recorded{isMeta:true}` although the entry carries no `isMeta`. The
2.1.316 corpus also has real typed/queued prompts (`origin.kind:"human"`, `promptSource:"typed"`) that start with
`<pasted_content id=…>`. The core drops isMeta prompts before `transcriptAck()`, `pendingRecorded` and the hookGap
timer, so with the UserPromptSubmit hook down such a submit failed `E_SUBMIT_UNCONFIRMED` while the turn ran, and
`history` dropped the turn on resume.

Now `ZHe` stays the VERIFIED profile constant, but a tag-led match counts as not-real only when the leading tag is in
`transcriptExtras.generatedLeadTags`: `system-reminder`, `local-command-caveat`, `local-command-stdout/stderr`,
`command-message`, `command-args`, `bash-stdout/stderr`, `tool_use_error`, `user-prompt-submit-hook`,
`tools-used-before-summary`. `task-notification` is deliberately not listed (it is a turn; previously a special case).
The `[Request interrupted by user…]` branch is unchanged. The entry's own `isMeta`, `isVisibleInTranscriptOnly`,
`isCompactSummary` and the safety-classifier marker still force isMeta, so Claude-generated entries with other tags (e.g.
`<artifact-attached …>`, which Claude writes with `isMeta:true`) remain meta.

Risk: a future Claude-generated user text with a new leading tag and no `isMeta` flag would surface as a prompt; add the
tag to `generatedLeadTags` in that profile.

Test: `test/unit/channels/transcript-normalize.test.ts` "a typed prompt that starts with an HTML/XML tag stays a real
prompt".
