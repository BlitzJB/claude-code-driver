# Screen corpus (Claude Code 2.1.316, classic renderer)

This is the regression corpus for `src/channels/screen/*` (DESIGN.md §6.2; WP-07). `test/unit/channels/screen-classify.test.ts` uses it.

| File | Source | Frames |
|---|---|---|
| `screen-A.log`, `screen-A0-launch-automode.log`, `screen-B.log`, `screen-C.log`, `screen-D.log` | `fixtures/verify/` (live verifier, full `capture-pane -p` every 150 ms) | 747 |
| `faultproxy-refuse.log`, `faultproxy-stall.log` | faultproxy probe, the bottom 12 non-blank rows every 300 ms (retry, stall, streaming) | 528 |
| `hookprobe-snaps.log` | hookprobe snapshots, concatenated (background agents, agent panel, Write dialog) | 60 |

Format: each `=== <stamp>` line starts a frame. The corpus does not record the pane width. The test loader therefore uses the longest solid rule in each file as that file's width (111 columns).

Scrubbing was applied when the corpus was copied:
- `/private/var/folders/<a>/<b>/T/` → `/private/var/folders/XX/YYYY/T/`
- `/…/<session-uuid>/scratchpad/` → `/…/SESSION/scratchpad/`
- `/Users/<name>` → `/Users/USER`
- `ccd-selftest-<hex>` → `ccd-selftest-SCRUBBED`

No row that the classifier parses was changed by this.

`labels.jsonl` holds the per-frame golden labels `{file, frame, surface, statusKind}`. The test writes it with `toMatchFileSnapshot`. A change to a label must be an explicit `vitest run -u` update, and the diff must be reviewed (rev 2 §10 D1).
