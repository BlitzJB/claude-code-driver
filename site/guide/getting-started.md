# Getting started

This page takes you from nothing to a running session in a few minutes. For the full API see [Usage](./usage); for how
it works inside see [Architecture](../architecture).

## 1. Requirements

| | |
|---|---|
| **Node.js** | ≥ 20 at runtime (Node 22 to build from source) |
| **tmux** | ≥ 3.2 on `PATH` (`brew install tmux`, `apt install tmux`) |
| **Claude Code** | exactly **2.1.316**, installed as a dependency of your project |
| **Account** | logged in with a **claude.ai subscription** (`claude auth status` shows `authMethod: claude.ai`). API keys and Bedrock/Vertex/gateway providers are refused on purpose. |
| **OS** | macOS or Linux |

## 2. Install

The package is not on npm yet, so build it from source:

```sh
git clone https://github.com/BlitzJB/claude-code-driver.git
cd claude-code-driver
nvm use && pnpm install && pnpm build
```

Then add it, together with the pinned Claude Code, to your project:

```sh
cd /path/to/your/project
pnpm add /path/to/claude-code-driver @anthropic-ai/claude-code@2.1.316
```

## 3. Trust your working directory once

Claude Code asks whether you trust a folder the first time it runs there. The library never clicks through that
dialog for you. Either open `claude` in the folder once and accept, or pass `trust: 'seed'`, which inspects the
workspace for risky settings first and then writes only that one trust key.

## 4. Your first session

```ts
import { ClaudeSession, isClaudeSessionError } from 'claude-code-driver';

try {
  await using session = await ClaudeSession.start({
    cwd: process.cwd(),
    permissions: 'allowRead', // or 'deny', 'ask', or your own handler
  });

  const turn = session.send('List the files in this folder and stop.');
  for await (const e of turn) {
    if (e.type === 'toolStarted') console.log('tool:', e.data.name);
    if (e.type === 'text') process.stdout.write(e.data.delta);
  }
  const result = await turn.done; // never rejects
  console.log('\noutcome:', result.outcome);

  const usage = await session.usage(); // no model call
  console.log(`week: ${usage.week?.usedPct}% (resets ${usage.week?.resetsText})`);
} catch (e) {
  if (isClaudeSessionError(e, 'E_TRUST_REQUIRED')) console.error('Trust the folder once in `claude`, or pass trust: "seed".');
  else throw e;
}
```

`await using` closes the session (and the private tmux server) when the block ends. `start()` takes about 3 seconds.

## 5. Watch it work

The TUI keeps running in a private tmux server, so you can look at it any time, read-only:

```ts
console.log(session.debug.viewCommand()); // tmux -L ccd-… attach -r -t …
```

## Next steps

- [Usage](./usage): options, events, status, permissions, commands, usage limits, errors, debugging.
- [Known limitations](./limitations): what v1 does not do.
- [API reference](../api/): every exported type and member.
