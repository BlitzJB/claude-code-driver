## What and why

<!-- What does this change, and why? Link the issue: Fixes #123 -->

## How it was tested

<!-- Unit / kernel scenario / replay / contract / live. Live runs: how many prompts? -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass locally
- [ ] Every behaviour change has a test; every bug fix has a regression test
- [ ] Layering rules respected (core stays pure; version strings only in `channels/profiles/`)
- [ ] Public API changes: `etc/claude-code-driver.api.d.ts` updated and described below
- [ ] Spec deviations or `src/model/**` interface changes have a `docs/icr/` record
- [ ] New fixtures were run through `scripts/fixtures-depersonalize.mjs`; no personal data or secrets
- [ ] `CHANGELOG.md` updated under *Unreleased* (if user-visible)
- [ ] Every affected doc updated in this PR (checklist in `CLAUDE.md`: USAGE, README, CHANGELOG, KNOWN-LIMITATIONS, ARCHITECTURE, ICR)
