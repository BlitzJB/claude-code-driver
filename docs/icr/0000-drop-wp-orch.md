# ICR 0000: WP-ORCH is dropped

- **Status:** accepted (2026-11-03, recorded by WP-00)
- **Affects:** DESIGN.md §3.11, §6.1 (`orch` test project), §6.7 M-03, §8 (WP-ORCH row and the Phase 0 order), D-20, P-REV-39, P-LIFE-60

The build-orchestrator wake-up of §3.11 (the `scripts/orchestrator/**` files: `wake-check.mjs`, `install-wake.mjs`,
`build-state.schema.json`, the `com.claude-code-driver.buildwake` LaunchAgent template, `wake-check.test.mjs`, the README, and the
initial `docs/BUILD-STATE.json`) is **not built**. The wake-up of the build is handled by a Claude Code session cron
(a recurring scheduled job of the orchestrating session) instead, so nothing in this repository implements or installs it.

Consequences in the WP-00 files:

- `vitest.config.ts` has no `orch` project, and `package.json#scripts.test` runs `unit`, `arch`, `kernel` and `replay` only.
- `knip.json` and `.dependency-cruiser.cjs` do not reference `scripts/orchestrator/**`.
- `.gitignore` has no `docs/BUILD-STATE.json` rule (the file is not produced).

Nothing in `src/` ever depended on WP-ORCH (§8: "nothing in `src/`"), so no interface changes. The library's own usage-limit
wake (D-20, §3.9 `usageWake` deadline) and `ccd lifecheck` (§3.12, reap/report only) are unaffected. Manual test M-03 and the
P-REV-39 mitigation move out of this repository with the orchestrator.
