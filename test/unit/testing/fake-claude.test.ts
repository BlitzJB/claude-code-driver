// FakeClaude (testing/fake-claude.ts) driven by hand through the aggregated fakes, playing the part of L3: it must produce
// hook payloads and transcript lines the REAL L1 normalizers accept, frames in the corpus shapes, and react to input like
// the 2.1.316 TUI (editor C-g, paste, Enter, Escape, BTab, dialogs). These are the contract tests of the scenario world.
import { describe, expect, it } from 'vitest';
import { normalizeHook } from '../../../src/channels/hooks/normalize.js';
import { selectProfile, type ClaudeProfile } from '../../../src/channels/profiles/index.js';
import { createTranscriptNormalizer } from '../../../src/channels/transcript/normalize.js';
import type { RawHookEvent, TailEvent, TmuxPane } from '../../../src/platform/ports.js';
import { SELF_TEST_BLOCK_BODY } from '../../../src/platform/hook-server/worker.js';
import { FakeClaude, projectSlug, type FakeClaudeOptions } from '../../../src/testing/fake-claude.js';
import { createFakePorts, type FakePortSet, type FakePortsOptions } from '../../../src/testing/fake-ports.js';
import { INTERRUPTED_BANNER } from '../../../src/testing/screens.js';

const profile = selectProfile('2.1.316') as ClaudeProfile;
const SID = '11111111-2222-4333-8444-555555555555';

interface World {
  f: FakePortSet;
  w: FakeClaude;
  pane: TmuxPane;
  raw: RawHookEvent[];
  settingsPath: string;
}

async function world(
  o: { claude?: FakeClaudeOptions; ports?: FakePortsOptions; transport?: 'http' | 'unix'; argv?: string[] } = {},
): Promise<World> {
  const f = createFakePorts({ tail: 'fs', ...(o.ports ?? {}) });
  const w = new FakeClaude(f, o.claude ?? {});
  const dir = await f.runtimeDir.createSessionDir();
  const hooks = f.hooks.create({
    runtimeDir: dir,
    clock: f.clock,
    ids: f.ids,
    maxBodyBytes: 32 << 20,
    maxHeld: 32,
    maxConnections: 64,
    logger: f.logger,
  });
  const raw: RawHookEvent[] = [];
  hooks.on((e) => raw.push(e));
  const transport = o.transport ?? 'http';
  await hooks.start({ sessionShortId: 's1', transport });
  const editor = f.editor.create({ clock: f.clock, ids: f.ids });
  const { visualPath } = await editor.setup(dir, '/fake/bin/node');
  const cmd = (ev: string): unknown => [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: '/fake/bin/node',
          args: ['fwd.js', `${dir}/fwd.json`, ev],
          timeout: ev === 'PermissionRequest' ? 150 : 5,
        },
      ],
    },
  ];
  const http = (ev: string): unknown =>
    transport === 'unix'
      ? cmd(ev)
      : [{ matcher: '*', hooks: [{ type: 'http', url: `http://127.0.0.1:1/h/s1/${ev}`, headers: { 'X-CCD-Token': 'x' }, timeout: 5 }] }];
  const events = [
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'Notification',
    'SessionEnd',
    'MessageDisplay',
    'PostModelSwitch',
    'PreCompact',
    'PostCompact',
  ];
  const settingsPath = `${dir}/settings.json`;
  await f.settingsFile.writeExclusive(settingsPath, {
    hooks: {
      SessionStart: cmd('SessionStart'),
      PermissionRequest: cmd('PermissionRequest'),
      ...Object.fromEntries(events.map((e) => [e, http(e)])),
    },
  });
  const server = await f.tmux.create({
    tmuxPath: '/opt/homebrew/bin/tmux',
    socketName: 'ccd-test-1',
    clientEnv: { VISUAL: visualPath },
    historyLimit: 1000,
    paneDiedLogPath: `${dir}/pane-died.log`,
  });
  const pane = await server.spawnPane({
    sessionName: 'ccd-s1',
    argv: [
      '/usr/bin/env',
      '/fake/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      '--session-id',
      SID,
      '--settings',
      settingsPath,
      '--permission-mode',
      'default',
      ...(o.argv ?? []),
    ],
    cwd: f.cwd,
    cols: 250,
    rows: 80,
    nonSecretEnv: {},
  });
  return { f, w, pane, raw, settingsPath };
}

async function run(f: FakePortSet, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 10) await f.clock.advanceAsync(10);
}

function screen(pane: TmuxPane): Promise<string[]> {
  return pane.capture().then((c) => c.lines);
}

/** Stage text through the editor injector and press C-g (what L3's editor submit does). */
async function stageAndCg(wd: World, text: string): Promise<void> {
  const inj = wd.f.editor.last;
  if (inj === undefined) throw new Error('no editor');
  await inj.stage(text);
  await wd.pane.sendKey('C-g');
}

describe('FakeClaude world', () => {
  it('boots: registers its process, shows the startup frame, sends SessionStart over the command (unix) transport', async () => {
    const wd = await world();
    await run(wd.f, 300);
    const s = wd.w.current();
    expect(wd.f.process.isAlive(s.pid)).toBe(true);
    expect((await wd.f.process.identity(s.pid))?.command).toContain('claude.exe');
    expect((await wd.f.process.identity(s.pid))?.command).toContain(SID);
    const lines = await screen(wd.pane);
    expect(lines.some((l) => l.includes('Claude Code v2.1.316'))).toBe(true);
    expect(lines.some((l) => l.startsWith('❯ Try "'))).toBe(true);
    expect(wd.raw.map((e) => [e.event, e.transport])).toEqual([['SessionStart', 'unix']]);
    const n = normalizeHook(wd.raw[0]!, { profile });
    expect(n.rejected).toBeUndefined();
    expect(n.observations.map((o) => o.kind)).toContain('session.started');
    expect(await wd.f.registry.read(s.pid)).toMatchObject({ sessionId: SID });
  });

  it('a prompt staged by the editor and submitted produces UPS/MessageDisplay/Stop and transcript lines the normalizers accept', async () => {
    const wd = await world();
    await run(wd.f, 300);
    await stageAndCg(wd, 'Reply with OK');
    expect(wd.w.current().composer).toBe('Reply with OK');
    expect((await screen(wd.pane)).some((l) => l === '❯ Reply with OK')).toBe(true);
    await wd.pane.sendKey('Enter');
    await run(wd.f, 1000);
    expect(wd.raw.map((e) => e.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'MessageDisplay', 'Stop']);
    for (const e of wd.raw) expect(normalizeHook(e, { profile }).rejected).toBeUndefined();
    const ups = wd.raw[1]?.payload as Record<string, unknown>;
    expect(ups['prompt']).toBe('Reply with OK');
    expect(ups['permission_mode']).toBe('default');
    expect(typeof ups['prompt_id']).toBe('string');
    const path = `${wd.f.home}/.claude/projects/${projectSlug(wd.f.cwd)}/${SID}.jsonl`;
    const lines = wd.f.tailFs.read(path).toString('utf8').trim().split('\n');
    const norm = createTranscriptNormalizer(profile);
    const kinds: string[] = [];
    lines.forEach((l, i) => {
      const json = JSON.parse(l) as unknown;
      const ev: TailEvent = {
        kind: 'line',
        line: {
          file: { kind: 'main', sessionId: SID },
          generation: 0,
          offset: i,
          bytes: l.length,
          type: (json as { type: string }).type,
          json,
          replay: false,
          afterRewrite: false,
          readAtMono: 0 as never,
          readAtWall: 0 as never,
        },
      };
      kinds.push(...norm.push(ev).map((o) => o.kind));
    });
    expect(kinds).toEqual(expect.arrayContaining(['prompt.recorded', 'message.block', 'turn.durationRecorded']));
    expect(kinds).not.toContain('unknown');
    expect((await screen(wd.pane)).some((l) => l.startsWith('✻ Worked for'))).toBe(true);
    expect(wd.w.errors).toEqual([]);
  });

  it('the armed self-test nonce is blocked: no user entry, one LP-47 informational entry, prompt restored', async () => {
    const wd = await world();
    await run(wd.f, 300);
    const nonce = `ccd-selftest-${'a'.repeat(32)}`;
    await wd.f.hooks.instances[0]?.armSelfTestNonce(nonce);
    await stageAndCg(wd, nonce);
    await wd.pane.sendKey('Enter');
    await run(wd.f, 100);
    const s = wd.w.current();
    expect(s.hookCalls.find((h) => h.event === 'UserPromptSubmit')?.call?.settled()?.body).toBe(SELF_TEST_BLOCK_BODY);
    expect(s.prompts).toEqual([{ text: nonce, promptId: expect.any(String) as string, blocked: true }]);
    expect(s.composer).toBe(nonce);
    expect(s.entries.map((e) => e.json['type'])).toEqual(['system']);
    expect(s.entries[0]?.json['promptSubmitEnding']).toEqual({
      ending: { kind: 'blocked_by_hook', reason: 'ccd self-test' },
      promptKept: false,
    });
    const norm = createTranscriptNormalizer(profile);
    const out = norm.push({
      kind: 'line',
      line: {
        file: { kind: 'main', sessionId: SID },
        generation: 0,
        offset: 0,
        bytes: 1,
        type: 'system',
        json: s.entries[0]?.json,
        replay: false,
        afterRewrite: false,
        readAtMono: 0 as never,
        readAtWall: 0 as never,
      },
    });
    expect(out.map((o) => o.kind)).toEqual(['prompt.blocked']);
  });

  it('LP-01: the pane is on the alternate screen while the external editor runs', async () => {
    const wd = await world({ claude: { editorMs: 500 } });
    await run(wd.f, 300);
    await stageAndCg(wd, 'hello');
    expect((await wd.pane.status()).alternateOn).toBe(true);
    await run(wd.f, 600);
    expect((await wd.pane.status()).alternateOn).toBe(false);
    expect(wd.w.current().composer).toBe('hello');
  });

  it('bracketed paste fills the composer; Escape twice clears a draft; BTab cycles the footer mode', async () => {
    const wd = await world();
    await run(wd.f, 300);
    await wd.pane.paste('draft text');
    expect(wd.w.current().composer).toBe('draft text');
    await wd.pane.sendKey('Escape');
    expect((await screen(wd.pane)).some((l) => l.includes('Esc again to clear'))).toBe(true);
    await wd.pane.sendKey('Escape');
    expect(wd.w.current().composer).toBe('');
    await wd.pane.sendKey('BTab');
    expect((await screen(wd.pane)).some((l) => l.includes('⏵⏵ accept edits on'))).toBe(true);
    await wd.pane.sendKey('BTab');
    expect(wd.w.current().mode).toBe('plan');
  });

  it('a lost Enter leaves the text in the composer (K-06 world)', async () => {
    const wd = await world();
    await run(wd.f, 300);
    await stageAndCg(wd, 'hello');
    wd.f.tmux.dropNextKey('Enter');
    await wd.pane.sendKey('Enter');
    await run(wd.f, 100);
    expect(wd.w.current().composer).toBe('hello');
    expect(wd.raw.filter((e) => e.event === 'UserPromptSubmit')).toHaveLength(0);
  });

  it('a permission ask holds PermissionRequest; an allow body runs the tool, an empty body falls back to the dialog', async () => {
    const wd = await world({
      claude: {
        onPrompt: async (t) => {
          await t.tool({ name: 'Bash', input: { command: 'touch x', description: 'Create x' } });
          await t.stop();
        },
      },
    });
    await run(wd.f, 300);
    await stageAndCg(wd, 'touch x');
    await wd.pane.sendKey('Enter');
    await run(wd.f, 100);
    const held = wd.raw.find((e) => e.event === 'PermissionRequest');
    expect(held?.holdable).toBe(true);
    expect(held?.transport).toBe('unix');
    wd.f.hooks.instances[0]?.respond(held?.hookSeq as never, {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    await run(wd.f, 500);
    expect(wd.raw.map((e) => e.event)).toEqual(expect.arrayContaining(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']));

    const wd2 = await world({
      claude: {
        onPrompt: async (t) => {
          const r = await t.tool({ name: 'Bash', input: { command: 'touch y', description: 'Create y' } });
          await t.say(r.decision);
          await t.stop();
        },
      },
    });
    await run(wd2.f, 300);
    await stageAndCg(wd2, 'touch y');
    await wd2.pane.sendKey('Enter');
    await run(wd2.f, 100);
    const held2 = wd2.raw.find((e) => e.event === 'PermissionRequest');
    wd2.f.hooks.instances[0]?.respond(held2?.hookSeq as never, null);
    await run(wd2.f, 100);
    expect((await screen(wd2.pane)).some((l) => l.includes('Do you want to proceed?'))).toBe(true);
    expect(wd2.raw.map((e) => e.event)).toContain('Notification');
    await wd2.pane.sendKey('1');
    await run(wd2.f, 500);
    expect(wd2.w.current().history).toContain('⏺ allow');
  });

  it('Escape during a model call writes the interrupt marker, no Stop, no turn_duration (K-13 world)', async () => {
    const wd = await world({
      claude: {
        onPrompt: async (t) => {
          if (!(await t.sleep(5000))) return;
          await t.stop();
        },
      },
    });
    await run(wd.f, 300);
    await stageAndCg(wd, 'think');
    await wd.pane.sendKey('Enter');
    await run(wd.f, 500);
    await wd.pane.sendKey('Escape');
    await run(wd.f, 6000);
    const s = wd.w.current();
    expect(s.hookCalls.map((h) => h.event)).not.toContain('Stop');
    const types = s.entries.map((e) => (e.json['subtype'] as string | undefined) ?? (e.json['type'] as string));
    expect(types).not.toContain('turn_duration');
    expect(JSON.stringify(s.entries.at(-1)?.json)).toContain('[Request interrupted by user]');
    expect(s.history).toContain(INTERRUPTED_BANNER);
    expect(s.busy).toBe(false);
  });

  it('/clear ends the session and starts a new one with source clear; /usage opens a modal dismissed by Escape', async () => {
    const wd = await world();
    await run(wd.f, 300);
    await stageAndCg(wd, '/clear');
    await wd.pane.sendKey('Enter');
    await run(wd.f, 50);
    const starts = wd.raw.filter((e) => e.event === 'SessionStart').map((e) => e.payload as { source: string; session_id: string });
    expect(starts.map((p) => p.source)).toEqual(['startup', 'clear']);
    expect(starts[1]?.session_id).not.toBe(SID);
    expect(wd.raw.find((e) => e.event === 'SessionEnd')?.payload).toMatchObject({ reason: 'clear', session_id: SID });
    await stageAndCg(wd, '/cost');
    await wd.pane.sendKey('Enter');
    expect((await screen(wd.pane)).some((l) => l.includes('Esc to cancel'))).toBe(true);
    await wd.pane.sendKey('Escape');
    const s = wd.w.current();
    expect(JSON.stringify(s.entries.slice(-2))).toContain('<command-name>/usage</command-name>');
    expect(JSON.stringify(s.entries.slice(-1))).toContain('Settings dialog dismissed');
  });

  it('a startup gate / trust dialog draws full screen; an exit startup kills the process with the final screen', async () => {
    const t = await world({ claude: { startup: { kind: 'trustDialog' } } });
    await run(t.f, 300);
    expect((await screen(t.pane)).some((l) => l.includes('Accessing workspace:'))).toBe(true);
    expect(t.raw).toHaveLength(0);
    const x = await world({ claude: { startup: { kind: 'exit', status: 1, lines: ['Error: Session ID 1 is already in use.'] } } });
    await run(x.f, 300);
    const st = await x.pane.status();
    expect(st.dead).toBe(true);
    expect(st.exitStatus).toBe(1);
    expect(x.f.process.isAlive(x.w.current().pid)).toBe(false);
  });

  it('a SIGTERM from the process port exits the pane; HTTP hooks down write hook error attachments (K-20 world)', async () => {
    const wd = await world({ claude: { dropHttpHooks: true } });
    await run(wd.f, 300);
    await stageAndCg(wd, 'hi');
    await wd.pane.sendKey('Enter');
    await run(wd.f, 1000);
    const s = wd.w.current();
    expect(wd.raw.map((e) => e.event)).toEqual(['SessionStart']);
    expect(
      s.entries.filter((e) => (e.json['attachment'] as { type?: string } | undefined)?.type === 'hook_non_blocking_error').length,
    ).toBeGreaterThan(0);
    wd.f.process.kill(s.pid, 'SIGTERM');
    expect((await wd.pane.status()).dead).toBe(true);
    expect(s.exited).toBe(true);
  });
});
