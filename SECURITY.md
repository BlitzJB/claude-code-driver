# Security policy

## Supported versions

`claude-code-driver` is pre-1.0. Security fixes land on `main` and in the next release. Each release supports exactly
one pinned Claude Code version (currently **2.1.316**).

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: **[Report a vulnerability](https://github.com/BlitzJB/claude-code-driver/security/advisories/new)**
(the repository's *Security → Advisories* tab). Include:

- what an attacker can do, and under which conditions (local user, another process, a malicious prompt or tool output, …);
- the smallest reproduction you have (a trace from `debug.tracePath` helps; it is redacted by default, but check it);
- the library version, Claude Code version, tmux version and OS.

You can expect an acknowledgement within 7 days and a fix or mitigation plan within 30 days for confirmed issues. We
will credit you in the advisory unless you prefer otherwise.

## Scope

In scope, for example:

- anything that lets another local process answer permission requests, read hook traffic or inject input;
- secrets leaking into argv, the environment of tool subprocesses, logs, events or traces;
- input that escapes the sanitizer and is interpreted as keys, commands or terminal escape sequences;
- the permission flow failing open (an allow without an explicit decision);
- files created with unsafe permissions, or cleanup that removes files the library did not create.

Out of scope (see [ARCHITECTURE.md §9](ARCHITECTURE.md#9-security-model)):

- malware already running as the same OS user and not descended from Claude Code;
- shared single-user CI runners used as a security boundary;
- what Claude Code itself does with the permissions you grant it.
