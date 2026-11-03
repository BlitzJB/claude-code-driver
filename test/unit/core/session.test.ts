// core/decide/session.ts — every row of DESIGN.md §4.3 (lifecycle, generations, readiness, gates, auth, exit).
import { describe, expect, it } from 'vitest';
import { Harness, SESSION_ID, busyFrame, frame, idleFrame, readyHarness, testConfig, ups } from './harness.js';

const NONCE = 'ccd-selftest-0123456789abcdef0123456789abcdef';
const launch = (h: Harness): Harness =>
  h.obs('process.launched', { pid: 4242, paneId: '%1', claudeVersion: '2.1.316', startTime: 't0' }, 'process');
const sessionStart = (
  h: Harness,
  source = 'startup',
  sessionId = SESSION_ID,
  transcriptPath = `/cfg/projects/-work/${sessionId}.jsonl`,
): Harness => h.hook('session.started', { sessionId, transcriptPath, source }, 'SessionStart', { claudeSessionId: sessionId });

describe('§4.3 lifecycle and readiness', () => {
  it('§4.3#1 a fresh core starts in preflight', () => {
    const h = new Harness();
    expect(h.d.lifecycle).toBe('preflight');
    expect(h.d.status.kind).toBe('starting');
  });

  it('§4.3#2 process.launched → launching, session.launching, startupHookGrace/startup deadlines, screen cadence 150', () => {
    const h = launch(new Harness());
    expect(h.d.lifecycle).toBe('launching');
    expect(h.ev('session.launching')[0]?.payload).toMatchObject({ claudeSessionId: SESSION_ID, resume: false, cwd: '/work' });
    expect(Object.keys(h.core.recon.deadlines).sort()).toEqual(['startup:startup', 'startupHookGrace:startup']);
    expect(h.intentsOf('poll.cadence').at(-1)?.intervalMs).toBe(150);
  });

  it('§4.3#3 SessionStart{startup} → awaitingReady, generation g1 active, tail.observePath', () => {
    const h = sessionStart(launch(new Harness()));
    expect(h.d.lifecycle).toBe('awaitingReady');
    expect(h.d.claude.currentGen).toBe('g1');
    expect(h.d.generations['g1' as never]).toMatchObject({ status: 'active', startedBy: 'SessionStart', sessionId: SESSION_ID });
    expect(h.intentsOf('tail.observePath')[0]).toMatchObject({ sessionId: SESSION_ID, source: 'startup' });
    expect(h.ev('session.generationChanged')[0]?.payload).toMatchObject({ reason: 'startup', gen: 'g1' });
  });

  it('§4.3#3 an unexpected session id is used and warned about (L1 never filters, rev 2 §10 A5)', () => {
    const h = sessionStart(launch(new Harness()), 'startup', 'other-id');
    expect(h.d.claude.sessionId).toBe('other-id');
    expect(h.ev('warning').some((w) => (w.payload.detail as { reason?: string } | undefined)?.reason === 'unexpectedSessionId')).toBe(true);
  });

  it.each(['trustDialog', 'startupGate', 'resumeDialog'] as const)(
    '§4.3#4 a stable %s surface → gated, session.gated, nothing pressed',
    (surface) => {
      const h = launch(new Harness());
      h.advance(10).screen(
        frame({
          surface,
          dialog: {
            kind: surface === 'trustDialog' ? 'trust' : surface === 'resumeDialog' ? 'resume' : 'gate',
            gate: surface === 'startupGate' ? 'onboarding' : undefined,
            title: 'Do you trust the files in this folder?',
            options: [],
          } as never,
          composer: undefined,
        }),
      );
      h.run(400);
      expect(h.d.lifecycle).toBe('gated');
      const g = h.ev('session.gated')[0]?.payload;
      expect(g?.gate).toBe(surface === 'trustDialog' ? 'trust' : surface === 'resumeDialog' ? 'resumeDialog' : 'onboarding');
      expect(g?.text).toContain('trust');
      expect(h.intentsOf('input')).toEqual([]);
    },
  );

  it('§4.3#5 startupHookGrace with a stable idle screen and no SessionStart → awaitingReady, hooks degraded{noSessionStart}', () => {
    const h = launch(new Harness());
    h.advance(100).screen(idleFrame());
    h.run(3000);
    expect(h.d.lifecycle).not.toBe('launching');
    expect(h.d.channels.hooks).toEqual({ health: 'degraded', reasons: ['noSessionStart'] });
    expect(h.ev('channel.health').at(-1)?.payload).toMatchObject({ channel: 'hooks', health: 'degraded', reason: 'noSessionStart' });
  });

  it('§4.3#6 a late authenticated hook clears noSessionStart (K-47)', () => {
    const h = launch(new Harness());
    h.advance(100).screen(idleFrame());
    h.run(3500);
    expect(h.d.channels.hooks.health).toBe('degraded');
    h.run(2500);
    sessionStart(h);
    expect(h.d.channels.hooks).toEqual({ health: 'up', reasons: [] });
    expect(h.ev('channel.health').at(-1)?.payload).toMatchObject({ health: 'up', reason: 'restored' });
  });

  it('§4.3#7 a stable idle main surface for readyStableMs → selfTest (waits for selftest.run)', () => {
    const h = sessionStart(launch(new Harness()));
    h.advance(10).screen(idleFrame());
    h.run(250);
    expect(h.d.lifecycle).toBe('awaitingReady');
    h.run(100);
    expect(h.d.lifecycle).toBe('selfTest');
    expect(h.d.status).toMatchObject({ kind: 'starting', phase: 'selfTest' });
  });

  it('§4.3#7 a busy screen does not become ready', () => {
    const h = sessionStart(launch(new Harness()));
    h.advance(10).screen(busyFrame());
    h.run(1000);
    expect(h.d.lifecycle).toBe('awaitingReady');
  });

  it("§4.3#8 selftest.run{cachedPass:true} → ready{selfTest:'cached'}; selfTest:'off' → ready{'skipped'}", () => {
    const h = readyHarness();
    expect(h.ev('session.ready')[0]?.payload).toMatchObject({
      selfTest: 'cached',
      resumed: false,
      model: 'claude-opus',
      permissionMode: 'default',
    });
    expect(h.d.selfTest.state).toBe('cached');
    const off = sessionStart(launch(new Harness(testConfig({ selfTest: 'off' }))));
    off.advance(10).screen(idleFrame());
    off.run(400);
    expect(off.d.lifecycle).toBe('ready');
    expect(off.ev('session.ready')[0]?.payload.selfTest).toBe('skipped');
  });

  it('§4.3#8 a selftest.run that arrives before selfTest is applied when the phase is reached', () => {
    const h = sessionStart(launch(new Harness()));
    h.cmd({ type: 'selftest.run', nonce: NONCE, cachedPass: true });
    expect(h.d.lifecycle).toBe('awaitingReady');
    h.advance(10).screen(idleFrame());
    h.run(400);
    expect(h.d.lifecycle).toBe('ready');
  });

  function toSelfTest(): Harness {
    const h = sessionStart(launch(new Harness()));
    h.advance(10).screen(idleFrame());
    h.run(400);
    return h;
  }

  it('§4.3#9 selftest.run{cachedPass:false} → hook.armSelfTest; hook.selfTestArmed starts the selftest job', () => {
    const h = toSelfTest();
    h.cmd({ type: 'selftest.run', nonce: NONCE, cachedPass: false });
    expect(h.intentsOf('hook.armSelfTest')[0]?.nonce).toBe(NONCE);
    expect(h.intentsOf('input')).toEqual([]);
    h.obs('hook.selfTestArmed', { nonce: NONCE, armed: true }, 'self');
    expect(h.d.selfTest.state).toBe('armed');
    expect(h.lastInput()?.primitive).toEqual({ kind: 'editorStage', text: NONCE });
  });

  it('§4.3#10 nonce ack (no Turn) + composer restored + cleared + disarm acked → ready{passed} (K-01)', () => {
    const h = toSelfTest();
    h.exec.auto = true;
    h.cmd({ type: 'selftest.run', nonce: NONCE, cachedPass: false });
    h.obs('hook.selfTestArmed', { nonce: NONCE, armed: true }, 'self');
    h.run(300);
    expect(h.primitives().some((p) => p.kind === 'key' && p.key === 'Enter')).toBe(true);
    // the hook blocks the nonce: UPS arrives, the prompt returns to the composer
    h.composer = NONCE;
    ups(h, NONCE, 'p-self');
    h.tx('prompt.blocked', { reason: 'ccd self-test', text: NONCE }, { uuid: 'blk1' });
    h.run(1000);
    expect(h.intentsOf('hook.disarmSelfTest')).toHaveLength(1);
    h.obs('hook.selfTestArmed', { nonce: NONCE, armed: false }, 'self');
    expect(h.d.lifecycle).toBe('ready');
    expect(h.ev('session.ready')[0]?.payload.selfTest).toBe('passed');
    expect(Object.keys(h.d.turns)).toEqual([]);
    expect(
      h
        .primitives()
        .filter((p) => p.kind === 'editorStage')
        .map((p) => (p as { text: string }).text),
    ).toEqual([NONCE, '']);
    // a later transcript entry carrying the nonce never creates a Turn (§4.4#4, K-50)
    h.tx('prompt.recorded', { uuid: 'u-n', parentUuid: null, text: NONCE, isMeta: false }, { uuid: 'u-n' });
    h.run(2500);
    expect(Object.keys(h.d.turns)).toEqual([]);
  });

  it('§4.3#11 a failed self-test job → exited, warning E_SELFTEST_FAILED{step:"ack", transcriptEvidence}', () => {
    const h = toSelfTest();
    h.exec.auto = true;
    h.cmd({ type: 'selftest.run', nonce: NONCE, cachedPass: false });
    h.obs('hook.selfTestArmed', { nonce: NONCE, armed: true }, 'self');
    h.run(300);
    h.tx('prompt.blocked', { reason: 'ccd self-test', text: NONCE }, { uuid: 'blk2' });
    h.composer = NONCE;
    h.run(12000);
    expect(h.d.lifecycle).toBe('exited');
    expect(h.d.selfTest.state).toBe('failed');
    const w = h.ev('warning').find((e) => e.payload.code === 'E_SELFTEST_FAILED');
    expect(w?.payload.detail).toMatchObject({ step: 'ack', transcriptEvidence: true });
    expect(h.intentsOf('lifecycle.finalize')).toHaveLength(1);
    expect(h.ev('session.exited')[0]?.payload.reason).toBe('startupFailed');
  });

  it('§4.3#12 process.exited before ready → exited{startupFailed}', () => {
    const h = sessionStart(launch(new Harness()));
    h.obs('process.exited', { exitStatus: 1, signal: null }, 'process');
    expect(h.d.lifecycle).toBe('exited');
    expect(h.ev('session.exited')[0]?.payload).toMatchObject({ reason: 'startupFailed', exitStatus: 1 });
    expect(h.d.status.kind).toBe('exited');
  });

  it('§4.3#13 the startup deadline → exited with warning E_STARTUP_TIMEOUT', () => {
    const h = launch(new Harness());
    h.advance(60_001);
    expect(h.d.lifecycle).toBe('exited');
    expect(h.ev('warning').find((w) => w.payload.code === 'E_STARTUP_TIMEOUT')?.payload.detail).toMatchObject({ phase: 'launching' });
    expect(h.intentsOf('poll.cadence').at(-1)?.intervalMs).toBeNull();
  });
});

describe('§4.3 generations', () => {
  it('§4.3#14 /clear: SessionEnd{clear} then SessionStart{clear, new id} → old gen ended, new gen active, generationChanged{clear}', () => {
    const h = readyHarness();
    h.hook('session.ended', { sessionId: SESSION_ID, reason: 'clear' }, 'SessionEnd');
    sessionStart(h, 'clear', 'new-id');
    expect(h.d.generations['g1' as never]?.status).toBe('ended');
    expect(h.d.generations['g2' as never]).toMatchObject({ status: 'active', sessionId: 'new-id' });
    expect(h.d.claude.currentGen).toBe('g2');
    expect(h.ev('session.generationChanged').at(-1)?.payload).toMatchObject({ from: SESSION_ID, to: 'new-id', reason: 'clear' });
    expect(h.intentsOf('tail.observePath').at(-1)).toMatchObject({ sessionId: 'new-id' });
    expect(h.d.lifecycle).toBe('ready');
  });

  it('§4.3#15 a hook with an unseen session_id → implicit generation, confirmed by a later SessionStart (K-17)', () => {
    const h = readyHarness();
    h.hook('session.ended', { sessionId: SESSION_ID, reason: 'clear' }, 'SessionEnd');
    h.hook('prompt.submitted', { promptId: 'p9', text: 'after clear' }, 'UserPromptSubmit', { claudeSessionId: 'new-id' });
    expect(h.d.generations['g2' as never]).toMatchObject({ status: 'implicit', startedBy: 'implicit' });
    expect(h.d.claude.currentGen).toBe('g2');
    expect(h.ev('session.generationChanged').at(-1)?.payload.reason).toBe('implicit');
    h.advance(80);
    sessionStart(h, 'clear', 'new-id');
    expect(h.d.generations['g2' as never]?.status).toBe('active');
    expect(h.core.recon.deadlines['genImplicitConfirm:g2']).toBeUndefined();
  });

  it('§4.3#16 SessionStart{compact} creates no generation', () => {
    const h = readyHarness();
    sessionStart(h, 'compact', SESSION_ID);
    expect(Object.keys(h.d.generations)).toEqual(['g1']);
  });

  it.each(['resume', 'fork'])('§4.3#17 SessionStart{%s} with a different id → new generation, tail from the beginning', (source) => {
    const h = readyHarness();
    sessionStart(h, source, 'other');
    expect(h.d.claude.currentGen).toBe('g2');
    expect(h.ev('session.generationChanged').at(-1)?.payload.reason).toBe(source);
    expect(h.intentsOf('tail.followMain').at(-1)).toMatchObject({ sessionId: 'other', startAt: 'beginning' });
  });

  it('§4.3#18 transcript.continuedIn → generationChanged{continuedIn}, pending hook confirmation', () => {
    const h = readyHarness();
    h.tx('transcript.continuedIn', { continuedInSessionId: 'cont' });
    expect(h.ev('session.generationChanged').at(-1)?.payload).toMatchObject({ reason: 'continuedIn', to: 'cont' });
    expect(h.d.generations['g2' as never]?.status).toBe('implicit');
    h.run(3100);
    expect(h.diag('no_session_start')).toHaveLength(1);
    expect(h.d.channels.hooks.reasons).toContain('noSessionStart:g2');
  });
});

describe('§4.3 auth, provider, version, close, exit', () => {
  it('§4.3#19 StopFailure authentication_failed → auth required, queue paused, auth.poll 60 s (K-28)', () => {
    const h = readyHarness();
    h.cmd({ type: 'prompt.send', text: 'one', whenBusy: 'wait' });
    h.run(300);
    ups(h, 'one');
    h.hook('turn.failed', { error: 'authentication_failed', errorDetails: 'Login expired' }, 'StopFailure');
    expect(h.d.auth.state).toBe('required');
    expect(h.ev('session.authRequired')).toHaveLength(1);
    expect(h.intentsOf('auth.poll').at(-1)?.intervalMs).toBe(60000);
    expect(h.d.status.kind).toBe('authRequired');
    const before = h.primitives().length;
    h.cmd({ type: 'prompt.send', text: 'two', whenBusy: 'wait' });
    h.run(500);
    expect(h.primitives().length).toBe(before);
  });

  it('§4.3#19 the screen Login expired line → auth required', () => {
    const h = readyHarness();
    h.screen(idleFrame({ auth: { kind: 'loginExpired', line: 'Login expired · Run /login' } }));
    h.run(300);
    expect(h.d.auth).toMatchObject({ state: 'required', polling: true });
  });

  it('§4.3#20 auth.status{loggedIn:true} → authRestored, auth.poll null', () => {
    const h = readyHarness();
    h.screen(idleFrame({ auth: { kind: 'notLoggedIn', line: 'Not logged in' } }));
    h.run(300);
    h.obs('auth.status', { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }, 'self');
    expect(h.d.auth.state).toBe('ok');
    expect(h.ev('session.authRestored')).toHaveLength(1);
    expect(h.intentsOf('auth.poll').at(-1)?.intervalMs).toBeNull();
  });

  it('§4.3#21 auth.status with apiProvider ≠ firstParty → closing + warning E_API_PROVIDER_UNSUPPORTED + SIGTERM', () => {
    const h = readyHarness();
    h.obs('auth.status', { loggedIn: true, apiProvider: 'bedrock' }, 'self');
    expect(h.d.lifecycle).toBe('closing');
    expect(h.ev('warning').some((w) => w.payload.code === 'E_API_PROVIDER_UNSUPPORTED')).toBe(true);
    expect(h.intentsOf('process.signal')[0]?.signal).toBe('SIGTERM');
  });

  it('§4.3#22 screen versionTooOld → warning E_CLAUDE_VERSION_TOO_OLD and the current turn fails with it', () => {
    const h = readyHarness();
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    h.run(300);
    ups(h, 'x');
    h.screen(busyFrame({ versionTooOld: true }));
    h.run(300);
    expect(h.ev('warning').some((w) => w.payload.code === 'E_CLAUDE_VERSION_TOO_OLD')).toBe(true);
    expect(h.d.turns['t1' as never]?.state.value).toBe('failed');
    expect(h.d.turns['t1' as never]?.error?.code).toBe('E_CLAUDE_VERSION_TOO_OLD');
  });

  it('§4.3#23 session.close (graceful, idle, clean composer) → closing, /exit via the editor', () => {
    const h = readyHarness();
    h.cmd({ type: 'session.close', mode: 'graceful', graceMs: 12000, reason: 'user' });
    expect(h.d.lifecycle).toBe('closing');
    expect(h.ev('session.closing')[0]?.payload.reason).toBe('user');
    expect(h.primitives()[0]).toEqual({ kind: 'editorStage', text: '/exit' });
    expect(h.cmd({ type: 'prompt.send', text: 'late', whenBusy: 'wait' })).toMatchObject({
      ok: false,
      error: { code: 'E_SESSION_CLOSED' },
    });
  });

  it('§4.3#23 session.close while busy → SIGTERM; kill mode → SIGKILL', () => {
    const h = readyHarness();
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    h.run(300);
    ups(h, 'x');
    h.cmd({ type: 'session.close', mode: 'graceful', graceMs: 12000, reason: 'user' });
    expect(h.intentsOf('process.signal')[0]?.signal).toBe('SIGTERM');
    const k = readyHarness();
    k.cmd({ type: 'session.close', mode: 'kill', graceMs: 0, reason: 'kill' });
    expect(k.intentsOf('process.signal')[0]?.signal).toBe('SIGKILL');
  });

  it('§4.3#23 close with waitForBackgroundMs waits for background agents (K-18)', () => {
    const h = readyHarness();
    h.hook('agent.started', { agent: { agentId: 'bg1', agentType: 'general-purpose' } }, 'SubagentStart');
    h.hook(
      'tool.post',
      { toolUseId: 'toolu_x', toolName: 'Agent', response: { status: 'async_launched', agentId: 'bg1' }, asyncAgentId: 'bg1' },
      'PostToolUse',
    );
    h.cmd({ type: 'session.close', mode: 'graceful', graceMs: 12000, reason: 'user', waitForBackgroundMs: 10000 });
    expect(h.d.lifecycle).toBe('ready');
    h.hook('agent.stopped', { agent: { agentId: 'bg1', agentType: 'general-purpose' }, backgroundTasks: [] }, 'SubagentStop');
    expect(h.d.lifecycle).toBe('closing');
  });

  it.each<[number | null, string | null, boolean, string]>([
    [0, null, true, 'closed'],
    [0, null, false, 'exitedByItself'],
    [129, null, false, 'hangup'],
    [null, 'SIGKILL', false, 'killed'],
    [1, null, false, 'crashed'],
  ])('§4.3#24 process.exited{%s,%s} (requested=%s) → session.exited{%s}, closing rule 4', (exitStatus, signal, requested, reason) => {
    const h = readyHarness();
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    h.run(300);
    ups(h, 'x');
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Bash', input: { command: 'sleep 20' } }, 'PreToolUse');
    if (requested) h.cmd({ type: 'session.close', mode: 'graceful', graceMs: 12000, reason: 'user' });
    h.obs('process.exited', { exitStatus, signal }, 'process');
    expect(h.d.lifecycle).toBe('exited');
    expect(h.ev('session.exited')[0]?.payload.reason).toBe(reason);
    expect(h.d.turns['t1' as never]?.state.value).toBe('unknown');
    expect(h.d.turns['t1' as never]?.endedBy).toBe('process_exit');
    expect(h.d.tools['u1' as never]?.state.value).toBe('unknown');
    expect(h.intentsOf('lifecycle.finalize')).toHaveLength(1);
    expect(Object.keys(h.core.recon.deadlines)).toEqual([]);
  });

  it('§4.3#24 process.exited{byOwnerWatch} → ownerGone', () => {
    const h = readyHarness();
    h.obs('process.exited', { exitStatus: null, signal: 'SIGTERM', byOwnerWatch: true }, 'process');
    expect(h.ev('session.exited')[0]?.payload.reason).toBe('ownerGone');
  });

  it('§4.3#25 process.identityMismatch → warning, SIGKILL, exited', () => {
    const h = readyHarness();
    h.obs('process.identityMismatch', { pid: 999 }, 'process');
    expect(h.d.lifecycle).toBe('exited');
    expect(h.intentsOf('process.signal')[0]?.signal).toBe('SIGKILL');
    expect(h.ev('warning')[0]?.payload.detail).toMatchObject({ reason: 'identityMismatch' });
  });

  it('a successful turn after an auth failure restores auth (§4.3#20 second clause)', () => {
    const h = readyHarness();
    h.screen(idleFrame({ auth: { kind: 'loginExpired', line: 'Login expired' } }));
    h.run(300);
    expect(h.d.auth.state).toBe('required');
    // the human logs in inside the pane and runs a turn
    ups(h, 'typed by a human', 'ph');
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false }, 'Stop');
    h.run(600);
    expect(h.d.auth.state).toBe('ok');
    expect(h.ev('session.authRestored')).toHaveLength(1);
  });
});
