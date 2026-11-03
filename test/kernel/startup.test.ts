// Kernel scenarios: startup, readiness, self-test, preflight gates (DESIGN.md §6.3 K-01…K-05, K-37, K-38, K-47, K-50;
// §3.1, §4.3). Real session+core+channels, every port faked (testing/test-kernel.ts), Claude scripted (testing/fake-claude.ts).
import { describe, expect } from 'vitest';
import { expectStartFailure } from '../../src/testing/test-kernel.js';
import { createFakePorts } from '../../src/testing/fake-ports.js';
import { FakeClaude } from '../../src/testing/fake-claude.js';
import { createTestKernel } from '../../src/testing/test-kernel.js';
import { boot, codeOf, detailsOf, inputOps, kscenario, roundTrip } from './support.js';

const NONCE_RE = /^ccd-selftest-[0-9a-f]{32}$/;

describe('startup', () => {
  kscenario(
    'K-01',
    ['09', '11'],
    'trusted startup: SessionStart + stable composer + self-test nonce block/restore → ready; no Turn',
    async () => {
      const tk = await boot();
      expect(tk.state().lifecycle).toBe('ready');
      const ready = tk.eventsOf('session.ready');
      expect(ready).toHaveLength(1);
      expect(ready[0]?.payload).toMatchObject({ selfTest: 'passed', resumed: false, hookTransport: 'http' });
      // The nonce went through the normal submit path, was blocked by our UPS hook, came back to the box and was cleared.
      const c = tk.claude();
      expect(c.prompts).toHaveLength(1);
      expect(c.prompts[0]?.blocked).toBe(true);
      expect(c.prompts[0]?.text).toMatch(NONCE_RE);
      expect(c.composer).toBe('');
      expect(tk.fakes.hooks.instances[0]?.armedNonce).toBeNull();
      // No Turn of any kind for the self-test.
      expect(tk.eventsOf('turn.queued')).toEqual([]);
      expect(tk.state().turnOrder).toEqual([]);
      expect(tk.state().selfTest.state).toBe('passed');
    },
  );

  kscenario('K-02', ['12'], 'trust dialog surface → E_TRUST_REQUIRED, zero keys sent, pane killed', async () => {
    const { tk, error } = await expectStartFailure({ claude: { startup: { kind: 'trustDialog' } } });
    expect(codeOf(error)).toBe('E_TRUST_REQUIRED');
    expect(inputOps(tk)).toEqual([]);
    const pane = tk.fakes.tmux.lastPane();
    expect(pane === undefined || pane.removed || !tk.fakes.process.isAlive(tk.claude().pid)).toBe(true);
  });

  kscenario('K-03', ['12'], 'Claude 2.1.317 → E_CLAUDE_VERSION_MISMATCH before any tmux call', async () => {
    const { tk, error } = await expectStartFailure({ ports: { claude: { version: '2.1.317' } } });
    expect(codeOf(error)).toBe('E_CLAUDE_VERSION_MISMATCH');
    expect(detailsOf(error)).toMatchObject({ expected: '2.1.316', found: '2.1.317' });
    expect(tk.fakes.tmux.invocationCount()).toBe(0);
  });

  const gates: { name: string; lines: string[]; exit?: number; code: string }[] = [
    { name: 'onboarding', lines: ["Let's get started."], code: 'E_STARTUP_GATE' },
    { name: 'login', lines: ['Select login method:'], code: 'E_STARTUP_GATE' },
    {
      name: 'settings error',
      lines: ['Settings Error', 'Files with errors are skipped entirely, not just the invalid settings.'],
      code: 'E_SETTINGS_INVALID',
    },
    { name: 'config error', lines: ['Configuration error'], code: 'E_CONFIG_CORRUPT' },
    { name: 'api key', lines: ['Detected a custom API key in your environment'], code: 'E_STARTUP_GATE' },
    { name: 'mcp approval', lines: ['New MCP server found in this project: x'], code: 'E_STARTUP_GATE' },
    {
      name: 'session in use (exit)',
      lines: ['Error: Session ID 00000000-0000-4000-8000-000000000001 is already in use.'],
      exit: 1,
      code: 'E_SESSION_ID_IN_USE',
    },
    {
      name: 'no conversation (exit)',
      lines: ['No conversation found with session ID: 00000000-0000-4000-8000-000000000001'],
      exit: 1,
      code: 'E_STARTUP_EXITED',
    },
    { name: 'could not start (exit)', lines: ['Claude Code could not start: something'], exit: 1, code: 'E_STARTUP_EXITED' },
  ];
  for (const g of gates)
    kscenario('K-04', ['12'], `startup gate / pre-UI exit "${g.name}" → ${g.code}, pane killed, zero keys`, async () => {
      const startup =
        g.exit === undefined ? { kind: 'gate' as const, lines: g.lines } : { kind: 'exit' as const, status: g.exit, lines: g.lines };
      const { tk, error } = await expectStartFailure({ claude: { startup } });
      expect(codeOf(error)).toBe(g.code);
      expect(inputOps(tk)).toEqual([]);
      expect(tk.fakes.process.isAlive(tk.claude().pid)).toBe(false);
    });

  kscenario('K-05', ['09'], 'no SessionStart, stable screen → degraded readiness, the self-test decides', async () => {
    const tk = await boot({ claude: { sessionStart: 'none' } });
    expect(tk.state().lifecycle).toBe('ready');
    const degraded = tk.eventsOf('channel.health').find((e) => e.payload.channel === 'hooks' && e.payload.health === 'degraded');
    expect(degraded?.payload.reason).toBe('noSessionStart');
    // Ready was not declared before the 3 s startup grace, and only after the self-test passed.
    const ready = tk.eventsOf('session.ready')[0];
    expect(ready?.payload.selfTest).toBe('passed');
    expect(tk.claude().prompts.some((p) => p.blocked && NONCE_RE.test(p.text))).toBe(true);
  });

  kscenario('K-47', ['09'], 'SessionStart arrives 6 s late (after degraded readiness) → hooks channel up again', async () => {
    const tk = await boot({ claude: { sessionStart: { delayMs: 6000 } } });
    expect(tk.eventsOf('channel.health').some((e) => e.payload.channel === 'hooks' && e.payload.health === 'degraded')).toBe(true);
    await tk.waitForEvent('channel.health', { pred: (e) => e.payload.channel === 'hooks' && e.payload.health === 'up', maxMs: 8000 });
    expect(tk.state().channels.hooks.health).toBe('up');
    expect(tk.state().channels.hooks.reasons).not.toContain('noSessionStart');
  });

  kscenario('K-37', ['12'], "hooks.transport 'auto': allowedHttpHookUrls in a user layer → unix settings", async () => {
    const tk = await boot({ spec: { hooks: { transport: 'auto' } }, ports: { layers: { allowedHttpHookUrlsDefinedIn: ['user'] } } });
    const settings = [...tk.fakes.settingsFile.files.values()].map((t) => JSON.parse(t) as { hooks?: Record<string, unknown> });
    const ours = settings.find((s) => s.hooks !== undefined);
    expect(ours).toBeDefined();
    expect(JSON.stringify(ours?.hooks)).not.toContain('"type":"http"');
    expect(Object.keys(ours?.hooks ?? {})).toEqual(
      expect.arrayContaining(['SessionStart', 'PermissionRequest', 'UserPromptSubmit', 'Stop']),
    );
    expect(tk.eventsOf('session.ready')[0]?.payload.hookTransport).toBe('unix');
  });

  kscenario('K-37', ['12'], 'HTTP self-test ack failure with transcript evidence → one relaunch with unix, cache written', async () => {
    const tk = await boot({ spec: { hooks: { transport: 'auto' } }, claude: { dropHttpHooks: true } });
    // The first pane's nonce prompt reached the transcript (the UPS hook never blocked it), so the kernel relaunched once.
    const spawns = tk.fakes.tmux.invocations.filter((i) => i.op === 'spawn');
    expect(spawns).toHaveLength(2);
    const first = tk.world.sessions[0];
    expect(first?.prompts.some((p) => !p.blocked && NONCE_RE.test(p.text))).toBe(true);
    expect(tk.world.sessions[1]?.sessionId).not.toBe(first?.sessionId);
    expect(tk.eventsOf('session.ready')[0]?.payload.hookTransport).toBe('unix');
    const cacheFiles = [...tk.fakes.state.files.keys()].filter((k) => k.includes('selftest'));
    expect(cacheFiles.length).toBeGreaterThan(0);
    expect(tk.fakes.state.files.get(cacheFiles[0] ?? '')).toContain('unix');
  });

  kscenario(
    'K-37',
    ['12'],
    'HTTP ack failure, nonce prompt reaches the transcript only after the failure → still one relaunch',
    async () => {
      // P-TAIL-37: the transcript lags the hooks; the kernel's 1.5 s evidence wait must still see the tail (the startup failure
      // does not stop the executors or kill Claude before start() decided).
      const tk = await boot({ spec: { hooks: { transport: 'auto' } }, claude: { dropHttpHooks: true, promptTranscriptLagMs: 6_200 } });
      expect(tk.fakes.tmux.invocations.filter((i) => i.op === 'spawn')).toHaveLength(2);
      expect(tk.eventsOf('session.ready')[0]?.payload.hookTransport).toBe('unix');
    },
  );

  kscenario(
    'K-38',
    ['12'],
    'resume of an id held by a live non-library pid in Claude’s registry → E_SESSION_ID_IN_USE, nothing spawned',
    async () => {
      const fakes = createFakePorts();
      const held = '22222222-3333-4444-8555-666666666666';
      const pid = fakes.process.addProcess({ command: `/opt/claude/claude.exe --resume ${held}` });
      fakes.registry.put({ pid, sessionId: held, version: '2.1.316', status: 'idle' });
      const { tk, error } = await expectStartFailure({ fakes, spec: { resume: held } });
      expect(codeOf(error)).toBe('E_SESSION_ID_IN_USE');
      expect(detailsOf(error)).toMatchObject({ pid, ours: false });
      expect(tk.fakes.tmux.invocations.filter((i) => i.op === 'spawn')).toEqual([]);
      expect(fakes.process.isAlive(pid)).toBe(true);
    },
  );

  kscenario(
    'K-50',
    ['11', '12'],
    'second start in the same process (same version/trust/transport) → selfTest cached, no nonce typed',
    async () => {
      const fakes = createFakePorts();
      const world = new FakeClaude(fakes);
      const first = await createTestKernel({ fakes, world });
      expect(first.eventsOf('session.ready')[0]?.payload.selfTest).toBe('passed');
      await first.close({ mode: 'graceful' });
      const second = await createTestKernel({ fakes, world });
      expect(second.eventsOf('session.ready')[0]?.payload.selfTest).toBe('cached');
      expect(world.current().prompts).toEqual([]);
      expect(second.state().selfTest.state).toBe('cached');
    },
  );

  kscenario('K-50', ['09'], 'a prompt.recorded carrying a nonce never makes a Turn', async () => {
    const tk = await boot();
    const c = tk.claude();
    const before = tk.state().turnOrder.length;
    c.entry({
      type: 'user',
      promptId: c.newId(),
      message: { role: 'user', content: `ccd-selftest-${'0'.repeat(32)}` },
      permissionMode: 'default',
      origin: { kind: 'human' },
    });
    await tk.advance(1000);
    expect(tk.state().turnOrder.length).toBe(before);
    // The session still works normally afterwards.
    const e = await roundTrip(tk, 'Reply with OK');
    expect(e.payload.outcome).toBe('completed');
  });
});
