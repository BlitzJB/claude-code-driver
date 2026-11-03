# ICR 0040: query current subscription usage

Additive. A user request (2026-11-03): "the ability to query current usage alone".

- `ClaudeSession.usage({signal?}) → UsageInfo` (public). `UsageInfo { meters, session?, week?, credits?, readAt }`; `UsageMeter { window: 'session'|'week', scope?, label, usedPct, resetsText? }`.
- Port: `SessionKernel.queryUsage({signal?, timeoutMs?})` (model/kernel.ts). L3 (session/kernel.ts) dispatches `slash.run /usage` once, with `capture: {until: 'usageReady', timeoutMs}` (default 5000). `/usage` is allow-listed, `immediate` and makes no model call.
- **Appearance-based wait, not a fixed delay.** A first open briefly shows `Refreshing…` while the per-model meters load. The core passes the named criterion through the `captureText` primitive (`until`, `timeoutMs`). The L3 input executor captures, then re-captures the still-open modal every 150 ms until `profile.usage.ready(text)` holds (at least one meter is shown and there is no `Refreshing…`/`Loading usage` line) or the timeout passes. slash.run then dismisses the dialog with Escape. Measured live: 1.6 s on a cold open, 0.7 s warm. A timed-out read is parsed anyway and comes back `partial: true`. No meters at all → `E_USAGE_UNAVAILABLE` (public `E_ENVIRONMENT`, `details.reason:'noMeters'`).
- Criteria are a closed union (`CaptureUntil = 'usageReady'`) so the core stays pure. Each name maps to a profile predicate in L3 through a total `Record`, so adding a criterion is a type error until it is mapped.
- Profile: `ClaudeProfile.usage` (new field) → `channels/profiles/claude-2.1.316/usage.ts`. Its regexes come from the live capture `fixtures/screens/usage-dialog-2.1.316.txt`.
- Reset times are returned as the text Claude shows (`"Nov 3 at 7:30pm (Etc/UTC)"`), not as epoch ms: the format mixes relative dates and IANA zones, and a wrong conversion is worse than the raw text.
- Layering: the parser stays in L1 profiles; api/ only maps model types (no channel import).
