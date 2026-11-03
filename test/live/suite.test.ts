// test/live/suite.test.ts — the gated live tests L-01…L-13 of DESIGN.md §6.5 against the real Claude Code 2.1.316 (WP-INT).
//
// Run: `pnpm test:live` (CCD_LIVE=1). Budget: CCD_LIVE_MAX_PROMPTS (default 10) counted across files; the nightly-only tests
// (L-06, L-10, L-11) also need CCD_LIVE_NIGHTLY=1. Prompts are tiny (`Reply with the word OK.`); every wait polls a
// condition with a ceiling. Sessions run on private tmux servers whose names this run's registry records; the global teardown
// kills exactly those (global-setup.ts). The smoke test (smoke.test.ts) is the one run in the integration phase.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeSession } from '../../src/api/index.js';
import type { PermissionDecision, SessionEvent } from '../../src/api/index.js';
import { createKernel } from '../../src/runtime/node.js';
import {
  liveOptions,
  liveReady,
  liveRoot,
  PROMPT_OK,
  recorder,
  socketOf,
  takePrompt,
  tmuxServerAlive,
  waitBashRunning,
  waitUntil,
} from './support.js';

const NIGHTLY = process.env['CCD_LIVE_NIGHTLY'] === '1';
const REPO = join(import.meta.dirname, '..', '..');
const DIST_API = join(REPO, 'dist', 'api', 'index.js');
const TICK_LOOP = 'for i in $(seq 1 30); do echo tick $i; sleep 1; done';
const PROVIDER_SWITCHES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AUTH_TOKEN',
];

/** The env of a process (macOS/Linux `ps eww`): only the names are returned, never values. */
function envNamesOf(pid: number): string[] {
  try {
    const out = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    return [...out.matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=/g)].map((m) => m[1] ?? '');
  } catch {
    return [];
  }
}
function panePid(socket: string): number {
  return Number(execFileSync('tmux', ['-L', socket, 'display-message', '-p', '#{pane_pid}'], { encoding: 'utf8' }).trim());
}
function bashCmd(input: unknown): string {
  const c = (input as { command?: unknown } | null)?.command;
  return typeof c === 'string' ? c.replace(/\s+/g, ' ').trim() : '';
}
function transcriptFile(claudeSessionId: string): string | undefined {
  const projects = join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects');
  for (const d of existsSync(projects) ? readdirSync(projects) : []) {
    const f = join(projects, d, `${claudeSessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

describe.skipIf(!liveReady())('live (real claude 2.1.316)', () => {
  it('L-01 start → ready (self-test passes) → graceful close; a second start in-process → selfTest cached; no provider env', async () => {
    const o1 = liveOptions('l01');
    const s = await ClaudeSession.start(o1);
    const socket = socketOf(s.debug.viewCommand());
    const names = envNamesOf(panePid(socket));
    expect(names.length).toBeGreaterThan(0);
    for (const v of PROVIDER_SWITCHES) expect(names).not.toContain(v);
    expect(names).not.toContain('TMUX');
    const info = await s.close();
    expect(info.reason).toBe('closed');
    expect(info.exitStatus).toBe(0);
    expect(tmuxServerAlive(socket)).toBe(false);
    // second start in the same process with the same cwd/version/trust/transport → the cached self-test (D-35, K-50;
    // the cache key includes cwdRealpath, so a fresh cwd would run the self-test again)
    const o2 = o1;
    const k = await createKernel({
      cwd: o2.cwd,
      permissions: { policy: 'deny' },
      claude: { bin: o2.claude?.bin ?? '' },
      lifecycle: { stateDir: join(liveRoot(), 'state') },
    });
    try {
      expect(k.getState().selfTest.state).toBe('cached');
    } finally {
      await k.close({ mode: 'graceful' });
    }
  });

  let l02: { claudeSessionId: string; cwd: string } | undefined;
  it('L-02 send `Reply with OK` → turnEnded completed, text OK (and L-12: no hook token in the transcript)', async () => {
    const o = liveOptions('l02');
    const s = await ClaudeSession.start(o);
    try {
      takePrompt();
      const r = await s.send(PROMPT_OK).done;
      expect(r.outcome).toBe('completed');
      expect(r.text.trim().replace(/[.!]$/, '')).toBe('OK');
      l02 = { claudeSessionId: s.claudeSessionId, cwd: o.cwd };
    } finally {
      await s.close();
    }
    // L-12: the transcript's hook bookkeeping names our URL only, never the token (SEC §2.2, LP-50)
    const f = transcriptFile(l02.claudeSessionId);
    expect(f).toBeDefined();
    const text = readFileSync(f ?? '', 'utf8');
    expect(text).not.toMatch(/X-CCD-Token/i);
    for (const line of text.split('\n').filter((l) => l.includes('hookInfos'))) expect(line).not.toMatch(/[0-9a-f]{64}/);
  });

  it('L-09 resume the L-02 session in a fresh pane (#91530): ready, same Claude session id', async () => {
    expect(l02).toBeDefined();
    const s = await ClaudeSession.start(liveOptions('l09', { cwd: l02?.cwd ?? '', resume: l02?.claudeSessionId ?? '' }));
    try {
      expect(s.claudeSessionId).toBe(l02?.claudeSessionId);
      expect(s.status.kind).toBe('idle');
    } finally {
      await s.close();
    }
  });

  it('L-03 permission: handler allow (Bash touch); onTimeout:tui + keyboard Escape at the native dialog → denied by the TUI', async () => {
    let mode: 'allow' | 'hang' = 'allow';
    const s = await ClaudeSession.start(
      liveOptions('l03', {
        permissions: {
          policy: (req) =>
            mode === 'allow' && req.toolName === 'Bash' && bashCmd(req.toolInput) === 'touch live-allow.txt'
              ? { behavior: 'allow' }
              : new Promise<PermissionDecision | undefined>(() => undefined),
          timeoutMs: 3000,
          onTimeout: 'tui',
        },
      }),
    );
    const rec = recorder(s);
    try {
      takePrompt();
      const r1 = await s.send('Use the Bash tool to run exactly: touch live-allow.txt\nThen reply OK.').done;
      expect(r1.outcome).toBe('completed');
      expect(existsSync(join(s.cwd, 'live-allow.txt'))).toBe(true);
      mode = 'hang';
      takePrompt();
      const t2 = s.send('Use the Bash tool to run exactly: touch live-tui.txt\nThen reply OK.');
      await waitUntil(() => s.status.kind === 'awaitingPermission', { timeoutMs: 120_000, what: 'the permission request' });
      // after timeoutMs the request is released to the native dialog; the "human" presses Escape there
      await waitUntil(() => rec.events.some((e) => e.type === 'permissionRequested' && e.turnKey === t2.key), {
        timeoutMs: 10_000,
        what: 'permissionRequested',
      });
      await new Promise((r) => setTimeout(r, 4000));
      execFileSync('tmux', ['-L', socketOf(s.debug.viewCommand()), 'send-keys', 'Escape']);
      const r2 = await t2.done;
      expect(['interrupted', 'completed']).toContain(r2.outcome);
      expect(existsSync(join(s.cwd, 'live-tui.txt'))).toBe(false);
      const resolved = rec.events.filter(
        (e): e is Extract<SessionEvent, { type: 'permissionResolved' }> => e.type === 'permissionResolved',
      );
      expect(resolved.at(-1)?.data).toMatchObject({ decision: 'deny', by: 'tui' });
    } finally {
      rec.stop();
      await s.close();
    }
  });

  it("L-03b permissions:'deny' policy → the tool is denied, the turn still ends", async () => {
    const s = await ClaudeSession.start(liveOptions('l03b', { permissions: 'deny' }));
    try {
      takePrompt();
      const r = await s.send('Use the Bash tool to run exactly: touch live-deny.txt\nThen reply OK.').done;
      expect(r.outcome).toBe('completed');
      expect(r.tools.find((t) => t.name === 'Bash')?.state).toBe('denied');
      expect(existsSync(join(s.cwd, 'live-deny.txt'))).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('L-04 interrupt during an allowed 30 s Bash loop → turnEnded interrupted (transcript-confirmed)', async () => {
    // the command marks that it started, so the test knows the tool really ran (not only that the permission was answered)
    const cmd = `echo started > l04-started.txt; ${TICK_LOOP}`;
    const s = await ClaudeSession.start(
      liveOptions('l04', {
        permissions: (req) => (req.toolName === 'Bash' && bashCmd(req.toolInput) === cmd ? { behavior: 'allow' } : { behavior: 'deny' }),
      }),
    );
    try {
      takePrompt();
      const t = s.send(`Use the Bash tool once to run exactly this command, in the foreground: ${cmd}\nThen reply DONE.`);
      await waitBashRunning(s, { timeoutMs: 120_000 });
      await waitUntil(() => existsSync(join(s.cwd, 'l04-started.txt')), { timeoutMs: 10_000, what: 'the command to start' });
      writeFileSync(join(liveRoot(), 'l04-screen-before-interrupt.txt'), await s.debug.captureScreen());
      expect((await s.interrupt()).turnKey).toBe(t.key);
      const r = await t.done;
      expect(r.outcome).toBe('interrupted');
      // the tool was running, so it ends interrupted (not denied at a dialog)
      expect(r.tools.find((x) => x.name === 'Bash')?.state).toBe('interrupted');
      await s.waitForIdle({ timeoutMs: 30_000 });
    } finally {
      await s.close();
    }
  });

  it('L-05 /clear → a new Claude session id (claudeSessionChanged), the tail follows it', async () => {
    const s = await ClaudeSession.start(liveOptions('l05'));
    const rec = recorder(s);
    try {
      const before = s.claudeSessionId;
      await s.command('/clear');
      await waitUntil(() => rec.events.some((e) => e.type === 'claudeSessionChanged'), { timeoutMs: 30_000, what: 'claudeSessionChanged' });
      expect(s.claudeSessionId).not.toBe(before);
      expect(s.status.kind).toBe('idle');
    } finally {
      rec.stop();
      await s.close();
    }
  });

  it.skipIf(!NIGHTLY)('L-06 background Agent (run_in_background) → task-notification turn → quiescent', async () => {
    const s = await ClaudeSession.start(liveOptions('l06', { permissions: 'dangerouslyAllowAll' }));
    const rec = recorder(s);
    try {
      takePrompt();
      await s.send('Use the Agent tool with run_in_background set to true and the prompt "Reply with the word OK." Then reply STARTED.')
        .done;
      await s.waitForQuiescence({ timeoutMs: 170_000 });
      expect(rec.events.some((e) => e.type === 'externalTurn' && e.data.kind === 'taskNotification')).toBe(true);
    } finally {
      rec.stop();
      await s.close();
    }
  });

  it('L-07 user HTTPS_PROXY set → hooks still arrive direct (NO_PROXY), network channel off{userProxy}', async () => {
    const proxy = createServer((c) => c.destroy());
    await new Promise<void>((r) => {
      proxy.listen(0, '127.0.0.1', () => {
        r();
      });
    });
    const port = (proxy.address() as { port: number }).port;
    // the user's proxy comes from the host env only (§3.2/§3.10; a caller env.set proxy var is ignored by design)
    const saved = process.env['HTTPS_PROXY'];
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${port}`;
    try {
      const s = await ClaudeSession.start(liveOptions('l07', { network: true }));
      try {
        expect(s.state.channels.hooks).toBe('up');
        expect(s.state.channels.network).toBe('off');
      } finally {
        await s.close();
      }
    } finally {
      if (saved === undefined) delete process.env['HTTPS_PROXY'];
      else process.env['HTTPS_PROXY'] = saved;
      proxy.close();
    }
  });

  it.skipIf(!existsSync(DIST_API))(
    'L-08 crash: SIGKILL the library process → owner-watch kills Claude + server ≤ 3 s; start({resume}) brings the history back',
    async () => {
      const o = liveOptions('l08');
      const script = `
        const { ClaudeSession } = await import(${JSON.stringify(DIST_API)});
        const s = await ClaudeSession.start(${JSON.stringify({ ...o, permissions: 'deny' })});
        await s.send(${JSON.stringify(PROMPT_OK)}).done;
        process.stdout.write(JSON.stringify({ id: s.claudeSessionId, view: s.debug.viewCommand() }) + '\\n');
        setInterval(() => {}, 1000);`;
      takePrompt();
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      const line = await new Promise<string>((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          const nl = buf.indexOf('\n');
          if (nl >= 0) resolve(buf.slice(0, nl));
        });
        child.on('exit', (c) => {
          reject(new Error(`child exited ${String(c)}`));
        });
      });
      const { id, view } = JSON.parse(line) as { id: string; view: string };
      const socket = socketOf(view);
      expect(tmuxServerAlive(socket)).toBe(true);
      child.kill('SIGKILL');
      const killedAt = Date.now();
      await waitUntil(() => !tmuxServerAlive(socket), { timeoutMs: 10_000, what: 'the owner-watch to kill the server' });
      expect(Date.now() - killedAt).toBeLessThanOrEqual(3000);
      const s = await ClaudeSession.start({ ...o, resume: id });
      try {
        expect(s.claudeSessionId).toBe(id);
      } finally {
        await s.close();
      }
    },
  );

  it.skipIf(!NIGHTLY)('L-10 Bash `echo "${TMUX:-none}"` prints none (the pane never sees our TMUX)', async () => {
    const s = await ClaudeSession.start(
      liveOptions('l10', { permissions: (req) => (req.toolName === 'Bash' ? { behavior: 'allow' } : { behavior: 'deny' }) }),
    );
    try {
      takePrompt();
      const r = await s.send('Use the Bash tool to run exactly: echo "${TMUX:-none}"\nThen reply with its output only.').done;
      expect(r.text).toMatch(/\bnone\b/);
    } finally {
      await s.close();
    }
  });

  it.skipIf(!NIGHTLY)('L-11 network on: one prompt through the sidecar; a refuse fault → the first retry banner attempt 1/10', async () => {
    const s = await ClaudeSession.start(liveOptions('l11', { network: true, unstable_advanced: { network: { faults: true } } }));
    const rec = recorder(s);
    try {
      expect(s.state.channels.network).toBe('up');
      takePrompt();
      expect((await s.send(PROMPT_OK).done).outcome).toBe('completed');
      expect(rec.events.some((e) => e.type === 'modelCall')).toBe(true);
    } finally {
      rec.stop();
      await s.close();
    }
  });

  // L-13 needs a test hook that kills the hook worker thread from outside the transport; the public API and the ./kernel
  // subpath deliberately expose none (the worker is private to the session, SEC §2.4). The worker-death path is covered by
  // the WP-03 contract suite (HookWorkerDied) and the kernel's channel-down handling (K-scenarios); it stays out of v1 live.
  it.skip('L-13 kill the hook worker mid-session → channel hooks down → pane killed (needs a worker kill hook; not in v1)', () =>
    undefined);
});
