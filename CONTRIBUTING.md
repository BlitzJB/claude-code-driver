# Contributing to claude-code-driver

Thanks for helping. This guide covers setup, the checks every change must pass, and the conventions that keep the
layered design intact. Read [ARCHITECTURE.md](ARCHITECTURE.md) first; it explains where things live and why.

## Ground rules

- Be kind; the [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere.
- Report security problems privately, see [SECURITY.md](SECURITY.md).
- Open an issue before a large change, so the design can be agreed first.
- Every behaviour change needs a test. Every bug fix needs a regression test that fails before the fix.

## Setup

Requirements: **Node 22** for tooling (the library itself runs on Node ≥ 20; dependency-cruiser refuses Node 23),
**pnpm 11**, **tmux ≥ 3.2** on `PATH`, macOS or Linux.

```sh
git clone https://github.com/BlitzJB/claude-code-driver.git
cd claude-code-driver
nvm use            # reads .nvmrc (22)
corepack enable    # or install pnpm 11 yourself
pnpm install       # also installs the pinned Claude Code binary (postinstall allowed in pnpm-workspace.yaml)
```

## The checks

```sh
pnpm typecheck        # tsc, strict
pnpm lint             # eslint + dependency-cruiser (layering) + prettier --check
pnpm test             # unit, arch, kernel and replay suites
pnpm test:contract    # real tmux on private sockets, real loopback servers, standalone scripts
pnpm build            # tsc → dist/
pnpm check:pkg        # publint + are-the-types-wrong
pnpm check:api        # public API report must match etc/claude-code-driver.api.d.ts
pnpm check            # everything, including knip and table coverage
```

`pnpm format` fixes formatting. CI runs the same commands on Linux (Node 20, 22, 24, several tmux versions) and macOS.

### Live tests (optional, uses your subscription)

```sh
pnpm build
CCD_LIVE_MAX_PROMPTS=10 pnpm test:live
```

They drive the real pinned Claude Code with your own claude.ai login and spend a small amount of real usage. They
never run in CI. Details and prerequisites: [docs/USAGE.md § Live tests](docs/USAGE.md#live-tests).

## Conventions

### Layering

The dependency rule in [ARCHITECTURE.md §4](ARCHITECTURE.md#4-layering) is enforced by `pnpm lint` and the `arch`
suite. In short:

- `src/core/` is **pure**: no I/O, no `Date`, no timers, no `Math.random`, no `await`, no `throw`. Time arrives as
  observation data; timeouts are core deadlines.
- Version-specific strings (screen text, regexes, transcript markers, command tables) live only in
  `src/channels/profiles/claude-<version>/`.
- `src/api/` talks to the rest only through the `SessionKernel` port. Public types live in `api/public-types.ts`.
- New timers are almost always wrong; add a core deadline instead. The allowed adapter timers are listed in
  `test/arch/timers.test.ts`.
- Zero runtime dependencies. Dev dependencies are pinned to exact versions.

### Changing the spec

[docs/DESIGN.md](docs/DESIGN.md) is normative. A change that alters an interface in `src/model/**` or deviates from
the spec gets a short change record in `docs/icr/NNNN-<slug>.md`: what changed, why, and what it affects.

### Public API changes

Run `node scripts/api-report.mjs --update`, review the diff in `etc/claude-code-driver.api.d.ts`, and describe it in
the PR and in `CHANGELOG.md` under *Unreleased*.

### Fixtures and goldens

- Recorded traces live in `fixtures/traces/` and their expected output in `fixtures/goldens/`. After an intended
  behaviour change run `pnpm test:replay -u` and review the golden diff like code.
- **Never commit personal data.** Run `node scripts/fixtures-depersonalize.mjs` on any new recording (it strips home
  paths, user names, time zones, system prompts and tool lists) and `pnpm fixtures:lint` before committing.

### Code style

- TypeScript strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; Prettier formats everything.
- Comments explain *why*, cite `DESIGN.md` sections (`§4.4`) or ICRs where relevant, and never describe the obvious.
- Tests name the behaviour they prove; rows of the design's transition tables are referenced as `§4.4#7` in test
  titles (`pnpm check:tables` enforces coverage).

## Docs stay in sync

A change is not finished until every doc it affects is updated in the same pull request. `CLAUDE.md` has the
checklist of which doc covers what. `test/arch/docs-sync.test.ts` fails `pnpm test` when a public member, event, status
kind, option or export is missing from `docs/USAGE.md`, or when a code example in the docs no longer compiles.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`, `ci:`. Mark breaking changes with `!` and a `BREAKING CHANGE:` footer.
- Keep PRs focused. Fill in the PR template; link the issue.
- Add a line to `CHANGELOG.md` under *Unreleased* for anything user-visible.
- All checks must be green. A maintainer reviews every PR.

## Supporting a new Claude Code version

See [ARCHITECTURE.md §8](ARCHITECTURE.md#8-version-profiles). In short: bump the pin, add a new profile directory,
record fresh traces and screens, depersonalize them, make replay and classifier tests pass, run the live suite.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
