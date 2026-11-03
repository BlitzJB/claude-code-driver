# Live verification fixtures (Claude Code 2.1.316)

Raw artifacts from the live verifier run on 2026-11-03. See `docs/research/live-verification.md`.

- `http-hooks.jsonl`: every HTTP hook request/response seen by `harness/server.mjs` (`kind`: req / resp / sock-close).
- `cmd-hooks.jsonl`: the same events from `type:"command"` hooks (`harness/cmdlog.mjs`), t = hook process start.
- `transcript-seen.jsonl`: each transcript line with the time the 20 ms poller first saw it (`harness/tailer.mjs`).
- `proxy.jsonl`: CONNECT log of the pass-through proxy given as HTTPS_PROXY/HTTP_PROXY.
- `screen-*.log`: tmux capture-pane on every change (150 ms poll), `=== <epoch ms>` separators.
- `timeline-*.txt`: when the verifier pressed keys.
- `transcripts/`: copies of the session transcripts. The user's email was replaced with `<redacted-email>`; review before committing anything else from these files.
- `q3-latency.txt`: computed hook-to-transcript latencies.
