// test/live/support.ts — helpers shared by the gated live tests (DESIGN.md §6.5; WP-INT).
//
// - `LIVE` / `liveReady()`: skip unless CCD_LIVE=1 and the pinned binary reports 2.1.316;
// - `liveOptions(name)`: a fresh cwd under this run's trusted root and the run's own state dir (the global teardown kills
//   only the tmux servers this registry names);
// - `takePrompt()`: the CCD_LIVE_MAX_PROMPTS budget (default 10), a counter file shared by every test file of the run;
// - `waitUntil(pred, {timeoutMs})`: every wait polls a condition with a ceiling, never a fixed sleep (rev 2 §10 D6);
// - `PROMPT_OK`: the tiny prompt of §6.5.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeSessionOptions, SessionEvent } from '../../src/api/index.js';

const LIVE = process.env['CCD_LIVE'] === '1';
const REPO = join(import.meta.dirname, '..', '..');
const CLAUDE_EXE = join(REPO, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
export const PROMPT_OK = 'Reply with the word OK.';

let versionChecked: boolean | undefined;
/** The live suite runs only against the pinned 2.1.316 binary. */
export function liveReady(): boolean {
  if (!LIVE) return false;
  if (versionChecked !== undefined) return versionChecked;
  try {
    versionChecked = /^2\.1\.316\b/.test(execFileSync(CLAUDE_EXE, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim());
  } catch {
    versionChecked = false;
  }
  return versionChecked;
}

export function liveRoot(): string {
  const r = process.env['CCD_LIVE_ROOT'];
  if (r === undefined || r === '') throw new Error('CCD_LIVE_ROOT is not set: run through `pnpm test:live` (global setup)');
  return r;
}

let seq = 0;
/** A fresh working directory under the trusted /private/tmp root, plus this run's state dir. */
export function liveOptions(name: string, over: Partial<ClaudeSessionOptions> = {}): ClaudeSessionOptions {
  const cwd = join(liveRoot(), 'work', `${name}-${++seq}`);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const advanced = (over.unstable_advanced ?? {}) as Record<string, unknown>;
  const lifecycle = (advanced['lifecycle'] ?? {}) as Record<string, unknown>;
  // CCD_LIVE_TRACE=1: every session writes `<live root>/<name>-<n>.ccd.jsonl` (keep it with CCD_LIVE_KEEP=1)
  const trace =
    process.env['CCD_LIVE_TRACE'] === '1' && over.debug === undefined ? { debug: { trace: `${cwd}.ccd.jsonl`, raw: 'meta' as const } } : {};
  return {
    cwd,
    permissions: 'deny',
    claude: { bin: CLAUDE_EXE },
    ...trace,
    ...over,
    unstable_advanced: { ...advanced, lifecycle: { ...lifecycle, stateDir: join(liveRoot(), 'state') } },
  };
}

/** Count one model prompt against the run's budget; throws (failing the test) once the budget is spent. */
export function takePrompt(n = 1): void {
  const file = join(liveRoot(), 'prompts.count');
  const max = Number(process.env['CCD_LIVE_MAX_PROMPTS'] ?? '10');
  const used = Number(readFileSync(file, 'utf8').trim() || '0');
  if (used + n > max) throw new Error(`live prompt budget exhausted (${used}/${max}); raise CCD_LIVE_MAX_PROMPTS to run more`);
  writeFileSync(file, `${used + n}\n`);
}

export async function waitUntil(pred: () => boolean, o: { timeoutMs: number; what: string; pollMs?: number }): Promise<void> {
  const until = Date.now() + o.timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out after ${o.timeoutMs} ms waiting for ${o.what}`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 100));
  }
}

/** Every event of a session, in order (for assertions and for the report). */
export function recorder(s: { onAny(l: (e: SessionEvent) => void): () => void }): { events: SessionEvent[]; stop(): void } {
  const events: SessionEvent[] = [];
  const stop = s.onAny((e) => events.push(e));
  return { events, stop };
}

/** Is a tmux server with this socket name still running? (used after close: the library must have killed it) */
export function tmuxServerAlive(socketName: string): boolean {
  try {
    execFileSync('tmux', ['-L', socketName, 'list-sessions'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** The socket name of a session's private tmux server, from its read-only view command (`tmux -L <sock> attach -r …`). */
export function socketOf(viewCommand: string): string {
  const m = /-L\s+(\S+)/.exec(viewCommand);
  if (m?.[1] === undefined) throw new Error(`no -L socket in ${viewCommand}`);
  return m[1].replace(/^'|'$/g, '');
}

/**
 * Wait until a foreground Bash tool is really executing: its snapshot is `running` (the permission was answered and
 * Claude started it) and the pane shows its output (`tick <n>`), or — if the TUI does not render the output — 3 s passed
 * since it turned `running`. `status === 'runningTools'` alone is not enough: it also covers a tool still in PreToolUse,
 * before its PermissionRequest (live smoke 2026-11-03, docs/research/live-results.md F-1).
 */
export async function waitBashRunning(
  s: {
    readonly state: { readonly activeTools: readonly { name: string; state: string }[] };
    readonly debug: { captureScreen(): Promise<string> };
  },
  o: { timeoutMs: number; outputRe?: RegExp },
): Promise<'output' | 'elapsed'> {
  await waitUntil(() => s.state.activeTools.some((t) => t.name === 'Bash' && t.state === 'running'), {
    timeoutMs: o.timeoutMs,
    what: 'the Bash tool to run',
    pollMs: 50,
  });
  const since = Date.now();
  const re = o.outputRe ?? /tick [2-9]/;
  for (;;) {
    if (re.test(await s.debug.captureScreen().catch(() => ''))) return 'output';
    if (Date.now() - since > 3000) return 'elapsed';
    await new Promise((r) => setTimeout(r, 200));
  }
}
