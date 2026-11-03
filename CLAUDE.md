# claude-code-driver

A TypeScript library that drives the interactive Claude Code TUI (pinned to 2.1.316) inside a private tmux server.
Read `ARCHITECTURE.md` before changing code; `docs/DESIGN.md` is the normative spec and `docs/icr/` records every change
to it.

## Tooling

- Run every tool on Node 22: prefix shell commands with `export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH;`
  (dependency-cruiser refuses Node 23). Use pnpm.
- Before you say a change is done, run the gates and report any that fail:
  `pnpm typecheck && pnpm lint && pnpm test && pnpm test:contract && pnpm build && pnpm check:pkg && pnpm check:api`,
  plus `pnpm docs:build` when docs or the public API changed, and `pnpm exec knip`.

## Docs stay in sync with the code

Docs drifted once: a feature shipped with the guide updated but its events table, status list, type list, limitations
and live-test notes left stale. A change is not finished until every doc it affects is updated **in the same commit**.

`test/arch/docs-sync.test.ts` enforces the mechanical part. It fails `pnpm test` when a public `ClaudeSession` member,
`SessionEvent` type, `AgentStatus` kind, option key or package export is not named in `docs/USAGE.md`, or when a
TypeScript example in `README.md`, `docs/USAGE.md` or `site/guide/getting-started.md` does not compile. Do not weaken that
test to make it pass; fix the docs.

What the test cannot see is your job. For every change, walk this list:

| You changed | Update |
| --- | --- |
| a public method, option, event, status kind or export | `docs/USAGE.md` (its section, the events table, the status order, the "API at a glance" table and the type list), `README.md` "The essentials" if it is a headline feature, `etc/claude-code-driver.api.d.ts` (`node scripts/api-report.mjs --update`, after `pnpm build`) |
| behaviour users can observe | `docs/USAGE.md`, and `CHANGELOG.md` under *Unreleased* (Added / Changed / Fixed) |
| a limitation, an edge case you chose not to handle, or a risk | `docs/KNOWN-LIMITATIONS.md` |
| architecture: a layer, a channel, the core state machine, the lifecycle | `ARCHITECTURE.md` |
| the spec or a `src/model/**` interface | a new `docs/icr/NNNN-<slug>.md` (what, why, edge cases, out of scope) |
| live tests, or what they cover | `README.md` live coverage line and `docs/KNOWN-LIMITATIONS.md` "Live test coverage" |
| contributor workflow, scripts, tooling | `CONTRIBUTING.md` |
| a docs page, nav entry or site asset | `site/` (pages include the canonical files; never copy their text into `site/`) |

Before finishing, grep the docs for the old name or behaviour you replaced, and fix stale mentions.

## Privacy

- Never commit anything personal: home paths, user names, time zones, plan tiers, system prompts, MCP or tool lists,
  email addresses, tokens.
- Run `node scripts/fixtures-depersonalize.mjs` on every new recording before committing, then `pnpm fixtures:lint`.
- Internal research notes stay untracked (`PROGRESS.md`, `docs/BRIEF.md`, `docs/research/`, `docs/caveats/`,
  `docs/critique/` are in `.gitignore`). Public docs must not link to them.

## Code conventions

- Respect the layering in `ARCHITECTURE.md` §4 (`pnpm lint` checks it). `src/core/` is pure: no I/O, clocks, timers,
  randomness, `await` or `throw`. Version-specific strings live only in `src/channels/profiles/claude-<version>/`.
- A decision timer is a core deadline, not a `setTimeout`.
- Every bug fix gets a regression test that fails before the fix.
- Replay goldens change only on purpose: `CCD_UPDATE_GOLDENS=1 pnpm test:replay`, then review the diff.
- Live tests (`CCD_LIVE=1`) spend the user's subscription. Keep them tiny, budget them with `CCD_LIVE_MAX_PROMPTS`, and
  never run them in CI.

## Brand

Brand SVGs are generated from the OKLCH tokens in `scripts/brand-svgs.mjs`; edit the script, never the SVGs, then run
`pnpm brand:render`. Follow `docs/BRAND.md`. Brand copy uses plain sentences: no em dashes, no colon-joined clauses,
no gradient text or glows.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`). Commit or push only when asked.
