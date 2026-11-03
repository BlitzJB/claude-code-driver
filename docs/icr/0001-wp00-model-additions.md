# ICR 0001: WP-00 additions and readings of §2 while landing `src/model/**`

- **Status:** accepted (2026-11-03, WP-00, additive only)
- **Files:** `src/model/config.ts`, `src/model/debug.ts`, `src/model/logger.ts`, `src/model/errors.ts`, `src/model/json.ts`

`src/model/**` and `src/platform/ports.ts` are §2 copied verbatim (re-flowed by Prettier; no type changed). Four places in §2
name a type the model may not import or do not spell out a value; this note records how they were resolved.

1. **`CoreInit` lives in `model/config.ts`** (additive). §6.6 puts `coreInit: CoreInit` in the trace header (`model/debug.ts`),
   but §2.9 declares `CoreInit` in `core/`, and model may import nothing outside model. The interface is copied verbatim from
   §2.9 into `model/config.ts`. **WP-09:** `core/init.ts` / `core/step.ts` must `import type { CoreInit } from '../model/config.js'`
   (re-export it if convenient) instead of declaring a second copy.
2. **`DebugRecord` `raw.data` is `unknown`.** §6.6 writes `RawHookEvent | TailEvent | { capture: Capture } | TunnelRecord | unknown`;
   the first four are L0 types from `platform/ports.ts`, and a union with `unknown` is `unknown`, so the field is typed `unknown`
   with the intended shapes in a comment. Writers (L3 `debug-trace.ts`) and readers (`testing/replay.ts`) narrow by `ch`.
3. **`Diagnostic`** (§2.9) is declared in `model/debug.ts` (as §1.2 says); `core` imports it from there.
4. **`Logger` / `LogFields`** (`model/logger.ts`) take the method shape of the public `Logger` in §2.12 with
   `LogFields = Record<string, unknown>`.
5. **`PUBLIC_CODE_OF`** keeps every example fixed in §2.2. The remaining assignments are: `E_NOT_ONBOARDED`, `E_CONFIG_CORRUPT`,
   `E_UNSAFE_RUNTIME_DIR`, `E_SOCKET_PATH_TOO_LONG`, `E_KEYBINDING_CONFLICT`, `E_CHANNEL_DOWN`, `E_NETWORK_UNAVAILABLE`,
   `E_HOST_LOOP_LAG` → `E_ENVIRONMENT`; `E_HOOKS_DISABLED_BY_USER`, `E_HOOKS_BLOCKED_BY_POLICY` → `E_HOOKS_UNAVAILABLE`;
   `E_WORKSPACE_RISK` → `E_TRUST_REQUIRED`; `E_VERSION_POLICY`, `E_CLAUDE_VERSION_TOO_OLD` → `E_VERSION_MISMATCH`;
   `E_STARTUP_GATE`, `E_SETTINGS_INVALID`, `E_SESSION_ID_IN_USE`, `E_RESUME_NOT_FOUND`, `E_SELFTEST_FAILED`, `E_STARTUP_EXITED`
   → `E_STARTUP`; `E_NOT_READY`, `E_INPUT_GATED` → `E_BUSY`; `E_INPUT_INVALID`, `E_COMMAND_FORBIDDEN`, `E_MODE_FORBIDDEN` →
   `E_INPUT_REJECTED`; `E_PERMISSION_UNKNOWN` → `E_PERMISSION_INVALID`; `E_TURN_INTERRUPTED`, `E_TURN_STALLED`, `E_TURN_ABORTED`
   → `E_TURN_FAILED`; `E_HOOK_PORT_LOST` → `E_SESSION_EXITED`; `E_UNSUPPORTED_FEATURE` → `E_CONFIG`; `E_TRANSCRIPT_REWRITE`,
   `E_SCREEN_UNKNOWN` → `E_INTERNAL`. `ERROR_META.category` follows the comment groups of `CCD_ERROR_CODES`; `retryable` is true
   exactly for the codes api-layering.md §7 marks retryable. WP-15 may propose a different public mapping through the
   architect (it is a breaking change to the public surface once published).
6. **`stableStringify`** is total (never throws; cycles → `"[Circular]"`, bigint → digits, Map/Set by content) so the pure core
   can call it inside `step` without breaking invariant I2.

Profile assembly (§8): `channels/profiles/claude-2.1.316/{hooks,transcript,screen,errors,commands}.ts` were created by WP-00 as
**seed files** with the fixed export names `hooksProfile`, `transcriptProfile`, `screenStrings`, `errorsProfile`,
`commandsProfile` and their types (`ClaudeProfile['hooks']`, …, `ScreenStrings`), so the assembly type-checks in Phase 0. They
are owned by WP-06 (hooks, transcript) and WP-07 (screen, errors, commands), who replace the values; the seeds contain only
VERIFIED strings (slash aliases, transcript markers, the `ZHe` regex) and never-matching regexes elsewhere.
