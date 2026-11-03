// test/live/smoke.test.ts — the integration smoke test against the real Claude Code 2.1.316 (DESIGN.md §6.5; WP-INT).
// Gated: CCD_LIVE=1 (`pnpm test:live -t smoke`). ONE tiny prompt:
//   1. start → ready (self-test passes, or is cached) — no prompt;
//   2. a prompt that runs exactly one Bash tool: a 30 s tick loop (`for i in $(seq 1 30); do echo tick $i; sleep 1; done`),
//      allowed by the permission handler → permissionRequested, toolStarted (Bash), status runningTools;
//   3. interrupt() while the tool runs (a deterministic window, rev 2 §10 D3) → turnEnded(interrupted);
//   4. close() → exit reason 'closed'; this session's private tmux server is gone.
// (A bare `sleep 30` is not used: 2.1.316's Bash tool refuses long leading sleeps and the model then moves the work to a
// background task, which turns /exit into the "Background work is running" dialog.)
// Every observation is written to `<live root>/smoke-report.json` (kept with CCD_LIVE_KEEP=1) for the integration report.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeSession } from '../../src/api/index.js';
import type { PermissionRequest, SessionEvent } from '../../src/api/index.js';
import {
  liveOptions,
  liveReady,
  liveRoot,
  recorder,
  socketOf,
  takePrompt,
  tmuxServerAlive,
  waitBashRunning,
  waitUntil,
} from './support.js';

const LOOP = 'for i in $(seq 1 30); do echo tick $i; sleep 1; done';

function bashCommand(req: PermissionRequest): string | undefined {
  const input = req.toolInput as { command?: unknown } | null;
  return typeof input?.command === 'string' ? input.command.trim() : undefined;
}
/** The handler allows the tick loop only (whitespace-insensitive); everything else is denied. */
const isLoop = (cmd: string | undefined): boolean => cmd?.replace(/\s+/g, ' ') === LOOP;

function brief(e: SessionEvent): string {
  const d = e.data as Record<string, unknown>;
  const extra =
    e.type === 'toolStarted' || e.type === 'toolEnded'
      ? ` ${String(d['name'])} ${String(d['state'])}`
      : e.type === 'turnEnded'
        ? ` ${String(d['outcome'])}`
        : e.type === 'status'
          ? ` ${String((d['to'] as { kind?: unknown } | undefined)?.kind)}`
          : e.type === 'permissionRequested'
            ? ` ${String(d['toolName'])}`
            : e.type === 'permissionResolved'
              ? ` ${String(d['decision'])}/${String(d['by'])}`
              : '';
  return `${e.seq} ${e.type}${extra}`;
}

describe.skipIf(!liveReady())('live smoke (real claude 2.1.316)', () => {
  it('start → one Bash tool turn (allowed) → interrupt it → close', async () => {
    const asked: { tool: string; command?: string; decision: string }[] = [];
    const opts = liveOptions('smoke', {
      permissions: {
        policy: (req) => {
          const cmd = req.toolName === 'Bash' ? bashCommand(req) : undefined;
          const allow = isLoop(cmd);
          asked.push({ tool: req.toolName, ...(cmd === undefined ? {} : { command: cmd }), decision: allow ? 'allow' : 'deny' });
          return allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'only the smoke-test command is allowed' };
        },
      },
      debug: { trace: join(liveRoot(), 'smoke.ccd.jsonl'), raw: 'meta' },
    });
    const t0 = Date.now();
    const s = await ClaudeSession.start(opts);
    const report: Record<string, unknown> = { startMs: Date.now() - t0, sessionKey: s.key, claudeSessionId: s.claudeSessionId };
    const rec = recorder(s);
    const socket = socketOf(s.debug.viewCommand());
    report['socket'] = socket;
    report['readyStatus'] = s.status.kind;
    report['channels'] = s.state.channels;
    try {
      expect(s.status.kind).toBe('idle');
      takePrompt();
      const turn = s.send(
        `Use the Bash tool once to run exactly this command, in the foreground: ${LOOP}\nThen reply with the single word DONE.`,
      );
      const accepted = await turn.accepted;
      report['accepted'] = { promptId: accepted.promptId };
      await waitUntil(() => rec.events.some((e) => e.turnKey === turn.key && e.type === 'toolStarted'), {
        timeoutMs: 120_000,
        what: 'the Bash tool to start',
      });
      // the loop runs ~30 s: wait until it is actually running (permission answered, command started), then interrupt.
      // `status runningTools` alone also covers the PreToolUse window before the PermissionRequest (live-results F-1).
      report['runningEvidence'] = await waitBashRunning(s, { timeoutMs: 60_000 });
      report['statusBeforeInterrupt'] = s.status.kind;
      const tInt = Date.now();
      const intr = await s.interrupt();
      report['interrupt'] = { turnKey: intr.turnKey ?? null, ours: intr.turnKey === turn.key };
      const r = await turn.done;
      report['turn'] = {
        outcome: r.outcome,
        text: r.text,
        tools: r.tools.map((t) => ({ name: t.name, state: t.state })),
        durationMs: r.durationMs,
        interruptToEndMs: Date.now() - tInt,
      };
      expect(intr.turnKey).toBe(turn.key);
      expect(r.outcome).toBe('interrupted');
      expect(r.tools.filter((t) => t.name === 'Bash')).toHaveLength(1);
      // interrupted while running, never rejected at the permission dialog (live-results F-1)
      expect(r.tools.find((t) => t.name === 'Bash')?.state).not.toBe('denied');
      const evs = rec.events.filter((e) => e.turnKey === turn.key);
      expect(evs.some((e) => e.type === 'toolStarted')).toBe(true);
      expect(evs.some((e) => e.type === 'turnEnded')).toBe(true);
      expect(asked.filter((a) => a.decision === 'allow')).toHaveLength(1);
      await s.waitForIdle({ timeoutMs: 30_000 });
      report['afterInterruptStatus'] = s.status.kind;
    } finally {
      const tc = Date.now();
      const info = await s.close();
      report['close'] = {
        reason: info.reason,
        exitStatus: info.exitStatus,
        signal: info.signal,
        closeMs: Date.now() - tc,
        tmuxServerAlive: tmuxServerAlive(socket),
      };
      report['permissions'] = asked;
      report['events'] = rec.events.map(brief);
      rec.stop();
      writeFileSync(join(liveRoot(), 'smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
    expect((report['close'] as { reason: string }).reason).toBe('closed');
    expect((report['close'] as { tmuxServerAlive: boolean }).tmuxServerAlive).toBe(false);
  });
});
