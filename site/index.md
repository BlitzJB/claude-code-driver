---
layout: home
hero:
  name: claude-code-driver
  text: Drive interactive Claude Code from Node.js
  tagline: Typed events, live state, permissions and interrupts for the real Claude Code TUI, on your Claude subscription.
  image:
    src: /hero.svg
    alt: A tmux pane running Claude Code beside the typed event stream it produces
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /architecture
    - theme: alt
      text: GitHub
      link: https://github.com/BlitzJB/claude-code-driver
features:
  - title: The real TUI, not headless mode
    details: Runs the interactive Claude Code inside a private tmux server, so it uses your subscription login. No API key, no -p mode, and a human can still watch the pane.
  - title: One typed event stream
    details: Prompt acks, tool calls with real ids, subagents, permission requests, streamed text, retries, stalls, usage limits and exits, reconciled into one stream and a live state snapshot.
  - title: Truth from several sources
    details: Hooks, the transcript, the screen and an optional network probe each see part of the picture. A pure, replayable core decides what is true, with an explicit trust order.
  - title: Permissions from code
    details: Answer permission requests with a policy or your own handler. Requests fail closed on errors, timeouts and close. Plan approval and questions are first class.
  - title: Safe by construction
    details: Loopback-only hook endpoints with per-session tokens, a sanitized and acknowledged input path, allowlisted environments, 0700 runtime dirs, and an owner-death watchdog.
  - title: Layered and replaceable
    details: The public API is a thin facade over a kernel port. Recorded traces replay deterministically, so every race is a test. Zero runtime dependencies.
---
