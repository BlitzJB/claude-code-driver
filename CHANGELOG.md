# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/)
(pre-1.0: minor versions may contain breaking changes).

## [Unreleased]

### Fixed

- Internal errors whose code is also a public code (`E_BUSY`, `E_USAGE_LIMIT`, …) are now mapped to `ClaudeSessionError`,
  so `details.reason` is always the internal code.

### Added

- Idle suspend and transparent resume: `idle: { suspendAfterMs }`, `session.suspend()`, `session.resume()`, status
  `suspended`, events `suspended` and `resumed`. A suspend never answers or drops a prompt (ICR 0041).
- First public version of `claude-code-driver`: drive the interactive Claude Code TUI (pinned to **2.1.316**) inside a
  private tmux server from Node.js, on a Claude subscription.
- `ClaudeSession` API: `start`, `send` (returns a `Turn` with events and a `done` result), `command`, `interrupt`,
  permission answering (`respondToPermission`, `answerQuestion`, `approvePlan`, or a `permissions` policy/handler),
  `setMode`, `usage()`, state snapshots and typed events, `waitFor*`, `close`, `closeAll`.
- Observation from hooks (HTTP + unix forwarder in a worker thread), the transcript, the screen, an optional network
  liveness sidecar, and process exit, reconciled by a pure, replayable core.
- Fail-closed permissions, sanitized and acknowledged input delivery, owner-death watchdog, orphan reaping, usage-limit
  wake-up.
- `ccd` CLI: `lifecheck`, `view`, `trace replay|explain`.
- Subpaths `claude-code-driver/kernel` and `claude-code-driver/testing` (experimental).
- Documentation site, architecture guide, contribution guide and security policy.
- Brand identity (terminal-tile mark, wordmark, favicons, Open Graph and GitHub social cards) and SVG diagrams of the
  layers, observation channels and step cycle, used across the README, `ARCHITECTURE.md` and the site
  ([docs/BRAND.md](docs/BRAND.md)).

[Unreleased]: https://github.com/BlitzJB/claude-code-driver/commits/main
