# ICR 0018 — platform/editor: a late library C-g never opens an editor; the handoff ends on the main screen

Fixes two review defects (`late-cg-opens-user-editor`, `verify-capture-races-editor-exit`). No `src/model/**` change and
no port signature change.

## 1. Stale arms and late C-g on a Claude draft (DESIGN §2.7.6, §3.2/A11, P-INPUT-16, ICR 0001 item 3c)

Before, `ccd-editor` reported `'notArmed'` both for a human's C-g and for the library's own C-g that came after
`consumed()` timed out and disarmed (or found an expired arm). It then ran the user's `$VISUAL`/`$EDITOR` inside the
Claude pane (or a GUI window for `code --wait`). Nobody could type into it, so the session stayed `inputBlocked.editor`
until close().

Change:
- `EditorInjector.disarm()` writes `<sessionDir>/disarmed.json` `{v:1, expiresAtWall: now + armTtlMs}` (0600, tmp+rename)
  before removing arm.json/staged.txt, but only while an arm is still outstanding (staged and not yet confirmed by
  `consumed()`). A disarm after a consumed prompt (for example close()) writes nothing.
- `standalone/editor.ts` `tryConsume` on a `claude-prompt-*.md` target returns `'failed'` (exit 1, draft untouched, no
  editor) when (a) arm.json cannot be claimed and a live tombstone exists, or (b) the claimed arm is expired or malformed.
  Before, both returned `'notArmed'`.
- Unchanged: non-draft targets (git, crontab) always run the user's editor. A human's C-g on a draft with no arm and no
  live tombstone still runs the user's editor (P-INPUT-16, ICR 0001 item 3c).
- Deviation: a human's C-g within `armTtlMs` (30 s) of a library editor timeout exits 1 instead of opening the user's
  editor. The library cannot tell that C-g from its own late one.
- `FakeEditorInjector` follows the same rules.

## 2. `awaitEditorConsumed` ends only once the pane is back on the main screen (DESIGN §3.6 step 2, ICR 0001 item 3d, LP-01)

`done-<nonce>` is created just before the editor process exits. Claude leaves the alternate screen (ESC[?1049l) only after
it reaps the editor. Before, the executor reported `awaitEditorConsumed` done as soon as the file existed. The core's
immediate `verifyStaged` capture could then land on the blank alternate screen. That screen is classified `editorOpen`,
the core maps it to `mismatch`, and the job takes a spurious editorFailure → pasteChunks fallback.

Change (`src/session/input-executor.ts`): after `consumed()` returns true, the executor keeps `awaitingEditor()` true
(pollers keep holding captures, and no key is sent). It polls `pane.status().alternateOn` every 10 ms until the value is
false, the pane is gone or dead, or the primitive's `timeoutMs` budget (measured from the start of the wait) runs out.
It then reports `ok`. If the alternate screen outlives the budget, the core's existing rule applies: `editorOpen` at
`verifyStaged` means not staged.
