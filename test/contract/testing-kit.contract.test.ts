// test/contract/testing-kit.contract.test.ts — WP-14's contracts (DESIGN.md §8 "WP-14 only aggregates", §6.1 contract project):
//   1. the aggregated hook-transport factory of createFakePorts() passes the shared HookTransport suite (it is the WP-03 fake,
//      constructed the way the kit constructs it);
//   2. the scripted world (FakeClaude) speaks 2.1.316: every hook payload and transcript entry it can produce is accepted by
//      the REAL L1 normalizers (no rejection, no `unknown`), with the observation kinds the real binary's evidence maps to.
//      If WP-06 tightens a guard, this suite tells which FakeClaude shape drifted from the corpus.
import { describe, expect, it } from 'vitest';
import { normalizeHook } from '../../src/channels/hooks/normalize.js';
import { selectProfile, type ClaudeProfile } from '../../src/channels/profiles/index.js';
import { createTranscriptNormalizer } from '../../src/channels/transcript/normalize.js';
import type { FakeHookTransport } from '../../src/platform/hook-server/fake-hooks.js';
import type { RawHookEvent, TailEvent, TmuxPane } from '../../src/platform/ports.js';
import { FakeClaude, type FakeTurn } from '../../src/testing/fake-claude.js';
import { createFakePorts, type FakePortSet } from '../../src/testing/fake-ports.js';
import { hookTransportContract, type HarnessFactory, type HookHarness } from './hooks.contract.js';
import type { ClientCall } from './hooks.contract.helpers.js';

const profile = selectProfile('2.1.316') as ClaudeProfile;

// ------------------------------------------------------------------------------------------------ 1. aggregated hooks factory

const aggregatedHooks: HarnessFactory = (o) => {
  const f = createFakePorts();
  const t: FakeHookTransport = f.hooks.create({
    runtimeDir: '/fake/run/ccd-000001',
    clock: f.clock,
    ids: f.ids,
    maxBodyBytes: o.maxBodyBytes ?? 32 * 1024 * 1024,
    maxHeld: o.maxHeld ?? 32,
    maxConnections: 64,
    logger: f.logger,
  });
  const wrap = (c: ReturnType<FakeHookTransport['deliver']>): ClientCall => ({
    reply: c.reply,
    abort: () => {
      c.abort('client_gone');
    },
    timeout: () => {
      c.abort('timeout');
    },
  });
  const h: HookHarness = {
    transport: t,
    call: (_ep, event, payload, co = {}) =>
      wrap(
        t.deliver(event, payload, {
          ...(co.via !== undefined ? { transport: co.via } : {}),
          ...(co.bytes !== undefined ? { bytes: co.bytes } : {}),
          ...(co.badJson === true ? { badJson: true } : {}),
        }),
      ),
    forge: () => Promise.resolve(t.forge('token')),
    crash: () => {
      t.crash();
      return Promise.resolve();
    },
    cleanup: () => t.close(null),
  };
  return Promise.resolve(h);
};

hookTransportContract('createFakePorts().hooks', aggregatedHooks);

// ------------------------------------------------------------------------------------------------ 2. world ↔ L1 contract

const SID = '33333333-4444-4555-8666-777777777777';

async function world(
  onPrompt: (t: FakeTurn) => Promise<void>,
): Promise<{ f: FakePortSet; w: FakeClaude; pane: TmuxPane; raw: RawHookEvent[] }> {
  const f = createFakePorts({ tail: 'scripted' });
  const w = new FakeClaude(f, { onPrompt, modalBodies: { '/usage': ['5% used'] } });
  const dir = await f.runtimeDir.createSessionDir();
  const hooks = f.hooks.create({
    runtimeDir: dir,
    clock: f.clock,
    ids: f.ids,
    maxBodyBytes: 1 << 25,
    maxHeld: 32,
    maxConnections: 64,
    logger: f.logger,
  });
  const raw: RawHookEvent[] = [];
  hooks.on((e) => raw.push(e));
  await hooks.start({ sessionShortId: 's1', transport: 'http' });
  const editor = f.editor.create({ clock: f.clock, ids: f.ids });
  const { visualPath } = await editor.setup(dir, '/fake/bin/node');
  // The scripted tail FakeClaude pushes transcript lines to (created the way L3's tail driver would).
  f.ports.tail.create({
    configDir: `${f.home}/.claude`,
    clock: f.clock,
    pollIdleMs: 250,
    pollFastMs: 50,
    fastBurstMs: 500,
    drainGraceMs: 1000,
    missingAgentTimeoutMs: 5000,
    maxLineBytes: 1 << 24,
    readChunkBytes: 1 << 16,
    maxActiveFollowers: 8,
    skipParseTypes: new Set(),
  });
  const server = await f.tmux.create({
    tmuxPath: '/opt/homebrew/bin/tmux',
    socketName: 'ccd-contract',
    clientEnv: { VISUAL: visualPath },
    historyLimit: 100,
    paneDiedLogPath: `${dir}/died.log`,
  });
  const pane = await server.spawnPane({
    sessionName: 'ccd-c',
    argv: ['/x/bin/claude.exe', '--session-id', SID],
    cwd: f.cwd,
    cols: 250,
    rows: 80,
    nonSecretEnv: {},
  });
  return { f, w, pane, raw };
}

async function run(f: FakePortSet, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 10) await f.clock.advanceAsync(10);
}

async function submit(x: { f: FakePortSet; pane: TmuxPane }, text: string): Promise<void> {
  await x.f.editor.last?.stage(text);
  await x.pane.sendKey('C-g');
  await x.pane.sendKey('Enter');
  await run(x.f, 50);
}

/** Everything FakeClaude can say, in one session. */
async function everything(): Promise<{ raw: RawHookEvent[]; lines: TailEvent[]; f: FakePortSet }> {
  const lines: TailEvent[] = [];
  const x = await world(async (t) => {
    switch (t.text) {
      case 'tools': {
        await t.say('Working on it.', { chunks: 3 });
        const a = await t.tool({ name: 'Bash', input: { command: 'touch x', description: 'Create x' } });
        await t.tool({ name: 'Bash', input: { command: 'false', description: 'Fail' }, permission: 'none', fail: 'exit 1' });
        await t.say(`done ${a.decision}`);
        await t.stop();
        return;
      }
      case 'agent': {
        await t.tool({
          name: 'Agent',
          input: { description: 'r', prompt: 'p', subagent_type: 'general-purpose', run_in_background: true },
          permission: 'none',
          response: { status: 'async_launched', agentId: 'a0aaaaaaaaaaaaaaa' },
        });
        t.session.hook('SubagentStart', { agent_id: 'a0aaaaaaaaaaaaaaa', agent_type: 'general-purpose' });
        await t.tool({
          name: 'Read',
          input: { file_path: '/work/project/a' },
          permission: 'none',
          agent: { id: 'a0aaaaaaaaaaaaaaa', type: 'general-purpose' },
        });
        t.session.hook('SubagentStop', {
          agent_id: 'a0aaaaaaaaaaaaaaa',
          agent_type: 'general-purpose',
          stop_hook_active: false,
          last_assistant_message: 'x',
          background_tasks: [],
        });
        await t.stop({ backgroundTasks: [] });
        return;
      }
      case 'fail':
        await t.fail({
          error: 'rate_limit',
          message: "You've hit your 5-hour limit · resets 3pm",
          resetsAtEpochS: 1_793_700_000,
          rateLimitType: 'five_hour',
        });
        return;
      default:
        await t.sleep(5000);
    }
  });
  const tail = x.f.scriptedTail?.created.at(-1);
  tail?.on((e) => lines.push(e));
  await run(x.f, 300);
  await x.f.hooks.instances.at(-1)?.armSelfTestNonce(`ccd-selftest-${'b'.repeat(32)}`);
  await submit(x, `ccd-selftest-${'b'.repeat(32)}`);
  await x.f.hooks.instances.at(-1)?.armSelfTestNonce(null);
  await x.pane.sendKey('Escape');
  await x.pane.sendKey('Escape');
  await submit(x, 'tools');
  await run(x.f, 200);
  const held = x.raw.find((e) => e.event === 'PermissionRequest');
  x.f.hooks.instances
    .at(-1)
    ?.respond(held?.hookSeq as never, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  await run(x.f, 1000);
  await submit(x, 'agent');
  await run(x.f, 1000);
  await submit(x, 'fail');
  await run(x.f, 200);
  await submit(x, 'think');
  await run(x.f, 500);
  await x.pane.sendKey('Escape');
  await run(x.f, 200);
  await submit(x, '/model claude-sonnet-5-5');
  await submit(x, '/compact');
  await submit(x, '/cost');
  await x.pane.sendKey('Escape');
  await submit(x, '/clear');
  x.w.current().hook('Notification', { notification_type: 'elicitation_dialog', message: 'm' });
  return { raw: x.raw, lines, f: x.f };
}

describe('FakeClaude ↔ L1 normalizers (2.1.316 shapes)', () => {
  it('every hook payload normalizes without rejection, with the expected observation kinds', async () => {
    const { raw } = await everything();
    const kinds = new Set<string>();
    for (const e of raw) {
      const n = normalizeHook(e, { profile });
      expect(n.rejected, `${e.event} ${JSON.stringify(e.payload).slice(0, 120)}`).toBeUndefined();
      for (const o of n.observations) kinds.add(o.kind);
    }
    expect([...new Set(raw.map((e) => e.event))].sort()).toEqual(
      [
        'MessageDisplay',
        'Notification',
        'PermissionRequest',
        'PostCompact',
        'PostModelSwitch',
        'PostToolUse',
        'PostToolUseFailure',
        'PreCompact',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'StopFailure',
        'SubagentStart',
        'SubagentStop',
        'UserPromptSubmit',
      ].sort(),
    );
    for (const k of [
      'session.started',
      'session.ended',
      'prompt.submitted',
      'tool.pre',
      'tool.post',
      'tool.failed',
      'permission.requested',
      'turn.stopped',
      'turn.failed',
      'message.textDelta',
      'agent.started',
      'agent.stopped',
      'model.switched',
      'compact.phase',
      'input.requested',
    ])
      expect(kinds.has(k), k).toBe(true);
    expect(kinds.has('unknown')).toBe(false);
  });

  it('every transcript entry normalizes without `unknown`, covering the kinds the core relies on', async () => {
    const { lines } = await everything();
    expect(lines.length).toBeGreaterThan(20);
    const norm = createTranscriptNormalizer(profile);
    const kinds = new Set<string>();
    for (const e of lines) for (const o of norm.push(e)) kinds.add(o.kind);
    expect(kinds.has('unknown'), [...kinds].join(',')).toBe(false);
    for (const k of [
      'prompt.recorded',
      'prompt.blocked',
      'message.block',
      'tool.result',
      'permission.decisionRecorded',
      'turn.durationRecorded',
      'turn.interrupted',
      'model.apiErrorRecorded',
    ])
      expect(kinds.has(k), k).toBe(true);
    expect(norm.stats().dropped).toBe(0);
  });
});
