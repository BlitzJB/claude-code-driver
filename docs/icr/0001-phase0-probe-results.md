# ICR 0001: Phase-0 probe results that change DESIGN.md (rev 2)

Source: `docs/research/phase0-probes.md`. Probes ran on 2026-11-03 against claude.exe 2.1.316 and tmux 3.5a, with 0 model prompts. This ICR does not edit DESIGN.md or `src/`. It lists exactly what the architect (WP-00 owner) must change, and which work package acts on each change.

Severity: **MUST** means DESIGN text or behaviour is wrong as written. **SHOULD** means a hardening suggested by the evidence.

---

## 1. D-16 / P-REV-01 / §3.6 step 1 / K-48: the leading-slash rule. Keep the rule, fix its rationale. **MUST (text), no behaviour change**

**DESIGN says:** a leading space does not stop a known command, because submit runs `value.trim().startsWith("/")` and then a command lookup, so `" /permissions"` would open the dialog (VERIFIED-BIN rev 2).

**Observed (LP-45):** on an **idle** composer, `" /cost"`, `" /permissions"`, `" /help"`, `" /model"`, `"  /cost"`, `"\t/cost"`, `"\n/cost"` and `" /cost now"` were all submitted as **prompts**. UPS fired with the leading whitespace intact, on both the editor path and the typed path. While Claude was **busy** (UPS hook held), a typed `" /cost"` + Enter **ran `/usage` at once**. The trimmed lookup lives only in the immediate-command branch (`local`/`local-jsx` while loading), not in the idle submit.

**Change:**
- D-16 and §3.6 step 1 keep `E_INPUT_REJECTED{reason:'leadingSlash'}` for `trim().startsWith('/')`. The idle-safe escape cannot protect against Claude becoming busy between the gate check and our Enter (the external-turn race D-17 accepts). Under that race `" /exit"`, `" /model x"`, `" /usage"` or any other immediate command would run.
- Replace the rationale with: "VERIFIED-LIVE (LP-45): idle submit keeps the leading space and sends a prompt, but the busy/immediate path trims and runs `local`/`local-jsx` immediate commands, so a leading space is not a safe escape."
- P-REV-01: same wording change.
- K-48 (WP-14): the scenario keeps asserting rejection. Its comment must cite the busy path.

## 2. D-16 / §3.6 step 1: the `! ? & #` prefix escape. Narrow it to `!`. **MUST**

**DESIGN says:** prefix one ASCII space if `/^[!?&#]/`, pending LP-45. If bash or memory mode also trims, reject.

**Observed (LP-45):**
- Editor-staged `#note`, `?` and `&note` without escape are plain prompts. `!x` staged through the editor is a plain prompt too (IN §3.1, re-confirmed).
- **Bracketed paste** (the D-15 fallback) of `!echo hi` into an empty box **enters shell mode** (`! for shell mode`). Pasted `?`, `#note` and `&note` do not change the mode.
- Pasted `" !echo hi"` stays a prompt, and its UPS is exact. The leading space is preserved in the ack, and nothing trims it.

**Change (WP-09 `core/input-policy` sanitizer):**
- Prefix-escape only `/^!/`, with one ASCII space, on every path (cheap, and it covers the paste fallback).
- Stop escaping `? & #`. Escaping them changes the user's prompt for no protection.
- Update D-16, the §3.6 step 1 regex (`/^[!?&#]/` → `/^!/`) and the SEC §3.4 cross-reference.
- The sanitize table tests must have rows for `?x`, `&x` and `#x` unchanged, and `!x` → `" !x"`.

## 3. D-10 / P-SCREEN-20 / §2.3 `ScreenFacts`: the alternate screen during the external editor. **MUST**

**DESIGN says:** every capture asserts `#{alternate_on}==0`, else `unsupportedRenderer` and screen `degraded`.

**Observed (LP-01):** Claude switches the pane to the alternate screen for the whole external-editor handoff, even with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`. `alternate_on=1` held throughout a 1.5 s editor run. There was one `ESC[?1049h`/`l` pair per `C-g` (45/45). Any capture taken between `C-g` and the editor exit would, as specified, report `unsupportedRenderer` and degrade the screen channel on every prompt.

**Change:**
- (a) **Additive model change** (`src/model/screen-facts.ts`, any WP under the §8 ICR rule): add the `ScreenFacts.surface` union member `'editorOpen'`.
- (b) **WP-07 classifier:** `alternate_on==1` maps to `'editorOpen'` when the capture request is tagged as taken during an editor phase. Otherwise, a blank alternate screen whose last known surface was `main` with the footer hint `ctrl+g to edit in …` also maps to `'editorOpen'`. Any other `alternate_on==1` stays `unsupportedRenderer`.
- (c) **WP-09 core:** `editorOpen` is a transient surface. It never degrades the screen channel and never starts a claim. It is expected only while an `editorStage`/`awaitEditorConsumed` job phase is active. If it lasts longer than `editorConsumeMs` (3000) **with no library job active** (a human pressed `C-g`, and the unarmed `ccd-editor` exec'd the user's real editor, per P-INPUT-16), core sets `inputBlocked.editor` and `canSubmit` is false (§4.13). Then emit `warning`, not `unsupportedRenderer`.
- (d) **WP-13 executor:** do not capture during an `awaitEditorConsumed` wait. Wait for the editor-done signal.
- D-10 text: "…every capture asserts `#{alternate_on}==0` **except while the external editor is open (`editorOpen`, LP-01)**".

## 4. §3.1 step 15, D-35, P-INPUT-29, rev 2 §10 A12: what a blocked self-test leaves behind. **MUST**

**DESIGN says:** whether a blocked UPS writes `prompt.recorded`, `ai-title` or `last-prompt` is UNVERIFIED (LP-47). "The nonce lands in `~/.claude/history.jsonl` once per cache period (P-INPUT-29)."

**Observed (LP-47), 42 blocked prompts:**
- **No `history.jsonl` line**, checked again after `/exit`.
- **No transcript `user` entry and no `ai-title`.**
- One `last-prompt` entry per session, holding only `leafUuid` and no text.
- Per block, one `system` entry: `subtype:"informational"`, `level:"warning"`, `preventContinuation:true`, `content:"UserPromptSubmit operation blocked by hook:\n<reason>\n\nOriginal prompt: <text>"`, and `promptSubmitEnding:{ending:{kind:"blocked_by_hook",reason},promptKept:false}`. `promptKept:false` is written even though the text is restored into the composer.
- The prompt text **does** appear in `--debug-file` output.

**Change:**
- §3.1 step 15: replace the `prompt.recorded`/`ai-title`/`last-prompt` sentence with: "a blocked UPS writes only a `system/informational` entry with `promptSubmitEnding.ending.kind:'blocked_by_hook'` whose `content` contains the nonce; core ignores that entry for the armed nonce."
- Delete "The nonce lands in `~/.claude/history.jsonl` once per cache period". `fixtures:scrub` still rewrites `ccd-selftest-[0-9a-f]{32}` (transcript and debug log).
- P-INPUT-29: the self-test nonce does not reach history. The row stays for real prompts.
- Rev 2 §10 A12: `selfTest:'once'` caching stays for latency and flakiness reasons. Drop history pollution from its rationale.
- **WP-06 (transcript normalizer), additive model change:** map a `system` entry with `promptSubmitEnding.ending.kind==='blocked_by_hook'` to a new observation `prompt.blocked{reason, text}` (a new `Observation` union member in `src/model/observation.ts`). Do not map it to a generic informational. Then:
  - **WP-09 §3.6 step 6** gets transcript evidence for `E_TURN_BLOCKED_BY_HOOK` (a user's own UPS hook), in addition to the screen notice.
  - The self-test ack can be cross-checked by `prompt.blocked{reason:'ccd self-test'}`.
  - `promptKept` must not be used to infer composer state.

## 5. D-07 / P-REV-44 / §2.7.3 tmux prelude: pin `extended-keys off`. **SHOULD**

**Observed (LP-52):**
- Claude 2.1.316 sends `ESC[>4;2m` (modifyOtherKeys 2) and kitty `ESC[>5u` push / `ESC[<u` pop. It concludes `extendedKeys=yes (env: terminal=tmux)`.
- tmux 3.5a with `-f /dev/null` keeps `extended-keys off`, so `#{pane_key_mode}` stayed `VT10x` and `send-keys Enter` submitted every time.
- Our input safety therefore depends on a tmux default.

**Change:**
- **WP-01:** add `set -s extended-keys off` to the server prelude, next to `set-clipboard off` (D-07).
- **WP-12/WP-01:** after spawn, read `#{pane_key_mode}`. A value other than `VT10x` fails as `E_TMUX_UNSUPPORTED{reason:'extendedKeys'}`. This guards newer tmux versions whose defaults may change.
- P-REV-44's mitigation column: add the prelude line and the check, ahead of the self-test.

## 6. §3.6 Commands / P-REV-02: `/cost` is an alias of `/usage`. **MUST**

**Observed (LP-33 partial, LP-45 baseline):**
- VERIFIED-BIN: `{type:"local-jsx", name:"usage", aliases:["cost","stats"], immediate:!0}`.
- VERIFIED-LIVE: an editor-staged `/cost` is recorded as `<command-name>/usage</command-name>`.
- `Escape` writes `<local-command-stdout>Settings dialog dismissed</local-command-stdout>`.

**Change (WP-07 `profiles/claude-2.1.316/commands.ts`, WP-09):**
- Add `/cost`→`/usage` and `/stats`→`/usage` to the alias table.
- Change the allowlist entry `/cost` to `/usage` (it still accepts `/cost` through canonicalisation).
- Completion evidence compares the canonical `/usage`.
- `/usage` is `immediate` (it runs while busy, like `/exit`). Add it to the documented list of immediate commands in P-REV-02. It may stay allowed, since it is read-only.

---

## Confirmed as designed (no change)

- **LP-01:** editor injection is byte-exact under the full bundle.
- **LP-02:** settle after a confirmed editor exit can be 0–100 ms. An Enter before the editor exits is lost or becomes a draft LF. This backs §3.6 step 2's `awaitEditorConsumed` and argues against any Enter while it is pending.
- **LP-03/LP-14:** no startup gate with the bundle.
- **LP-09:** 400 B / ≤ 2 LF chunks stay inline.
- **LP-12:** D-08 is right. With `TMUX` set, Claude runs `tmux` subcommands against our server.
- **LP-13:** silent.
- **LP-50:** no token in `--debug-file`. It does contain prompts and is created 0644, so P-REV-27's "0700 dir, deleted at close" is required, and `claudeDebugFile` may stay an advanced opt-in.
- **LP-53:** body-then-200 with an empty body gives `treating as empty JSON object`, no `hook error`, and < 4 ms server side.
- **LP-54:** `normalizeForAck` matches. Claude trims only trailing whitespace at the end; it keeps leading whitespace, per-line trailing spaces, CR, NFD and `@mentions`; an image paste shows as `[Image #N]`.

## Notes for owners (not contradictions)

- **WP-11/WP-09:** a cold first launch took 3,845 ms from `exec` to SessionStart, about 2.7 s of it binary load. Warm launches took 740 ms. `startupHookGraceMs` 3000 is safe only because nothing is drawn before SessionStart. Consider measuring the grace from the first non-blank frame.
- **WP-06:** hook payloads in 2.1.316 carry `scratchpad_dir` and `prompt_id` on UPS, Notification and SessionEnd. Accept unknown fields. `SessionEnd.reason` after `/exit` = `prompt_input_exit`.
- **WP-12:** the user's plugin hooks and MCP servers load inside library sessions (debug log: `okf` plugin hooks, `claude-artifacts`/`figma` MCP). This is relevant to `security.mcp`.
- **WP-12:** `~/.claude/sessions/<pid>.json` did not exist at the first `updatePidFile` (ENOENT logged) and appeared later. The single D-23 registry read must retry.
- **WP-03:** when a user's UPS hook blocks, Claude does not wait for our parallel UPS HTTP hook. The self-test then sees the user's reason on screen and in `prompt.blocked`, never our ack. That maps to `E_TURN_BLOCKED_BY_HOOK`, which is correct.
