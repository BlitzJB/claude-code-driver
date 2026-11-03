// Remaining observation kinds of §2.4 handled by the core: registry, config/cwd changes, transcript file events, loop lag,
// relocation, hook responses, auto-denies, model switches, agent meta, network awaiting, retries via querySource.
import { describe, expect, it } from 'vitest';
import { evolve, encodePath } from '../../../src/core/evolve.js';
import { matchUiMessage } from '../../../src/core/reconcile/text-match.js';
import { pickSpawnTool } from '../../../src/core/reconcile/spawn-link.js';
import type { HookSeq } from '../../../src/model/ids.js';
import { SESSION_ID, busyFrame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

function running() {
  const h = readyHarness();
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}

describe('misc observations', () => {
  it('registry with another version → warning; pid mismatch → diagnostic', () => {
    const h = readyHarness();
    h.obs('registry', { pid: 9, sessionId: SESSION_ID, version: '2.1.317' }, 'registry');
    expect(h.ev('warning')[0]?.payload.code).toBe('E_CLAUDE_VERSION_MISMATCH');
    expect(h.diag('registry_pid_mismatch')).toHaveLength(1);
  });

  it('config.changed is surfaced; cwd.changed pokes the tail; transcript.file events are diagnostics', () => {
    const h = readyHarness();
    h.hook('config.changed', { source: 'user_settings', filePath: '/h/.claude/settings.json' }, 'ConfigChange');
    expect(h.ev('config.changed')[0]?.payload).toEqual({ source: 'user_settings', filePath: '/h/.claude/settings.json' });
    h.hook('cwd.changed', { oldCwd: '/a', newCwd: '/b' }, 'CwdChanged');
    expect(h.intentsOf('tail.poke')[0]?.reason).toBe('cwdChanged');
    h.tx('transcript.file', { event: 'oversize', fileKey: 'main:x', detail: null });
    expect(h.diag('transcript_oversize')).toHaveLength(1);
    h.obs('unknown', { channel: 'transcript', raw: {} }, 'transcript');
    expect(h.diag('unknown_observation')).toHaveLength(1);
  });

  it('host.loopLag → warning E_HOST_LOOP_LAG (K-52 core part)', () => {
    const h = readyHarness();
    h.obs('host.loopLag', { p99Ms: 900, maxMs: 6000, windowMs: 5000 }, 'self');
    expect(h.ev('warning')[0]?.payload.code).toBe('E_HOST_LOOP_LAG');
  });

  it('transcript.relocated updates the generation path', () => {
    const h = readyHarness();
    h.tx('transcript.relocated', { sessionId: SESSION_ID, newPath: '/moved.jsonl' });
    expect(h.d.claude.transcriptPath).toBe('/moved.jsonl');
  });

  it('hook.responded with clientGone after our answer → dialogOnly + needsKeys', () => {
    const h = running();
    h.hook('permission.requested', { hookSeq: 4 as HookSeq, toolName: 'Bash', input: {}, suggestions: [] }, 'PermissionRequest');
    h.cmd({ type: 'permission.answer', permissionKey: 'p1' as never, decision: { behavior: 'allow' }, by: 'host' });
    h.obs('hook.responded', { hookSeq: 4 as HookSeq, ok: false, clientGone: true }, 'self');
    expect(h.d.permissions['p1' as never]?.state.value).toBe('dialogOnly');
  });

  it('PermissionDenied (classifier) denies the tool and resolves its permission', () => {
    const h = running();
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Bash', input: { c: 1 } }, 'PreToolUse');
    h.hook('permission.requested', { hookSeq: 1 as HookSeq, toolName: 'Bash', input: { c: 1 }, suggestions: [] }, 'PermissionRequest');
    h.hook('permission.autoDenied', { toolUseId: 'toolu_1', toolName: 'Bash', reason: 'classifier' }, 'PermissionDenied');
    expect(h.d.tools['u1' as never]?.state.value).toBe('denied');
    expect(h.d.permissions['p1' as never]?.resolved).toMatchObject({ decision: 'deny', decider: 'classifier' });
  });

  it('PostModelSwitch → model fact + session.modelChanged{switch}; SessionStart model never overrides it', () => {
    const h = readyHarness();
    h.hook('model.switched', { fromModel: 'claude-opus', toModel: 'claude-haiku' }, 'PostModelSwitch');
    expect(h.d.claude.model?.value).toBe('claude-haiku');
    h.hook(
      'session.started',
      { sessionId: SESSION_ID, transcriptPath: '/t.jsonl', source: 'compact', model: 'claude-opus' },
      'SessionStart',
    );
    expect(h.d.claude.model?.value).toBe('claude-haiku');
  });

  it('a screen footer mode is provisional and never overrides a hook mode', () => {
    const h = readyHarness();
    h.screen(busyFrame({ footer: { busy: true, modeLabel: 'plan', mode: 'plan', pasting: false, ctrlCExitArmed: false, hints: [] } }));
    expect(h.d.claude.permissionMode).toMatchObject({ value: 'plan', src: 'screen', provisional: true });
    h.hook('mode.observed', { permissionMode: 'acceptEdits' }, 'Notification');
    h.screen(
      busyFrame({ footer: { busy: true, modeLabel: 'default', mode: 'default', pasting: false, ctrlCExitArmed: false, hints: [] } }),
    );
    expect(h.d.claude.permissionMode?.value).toBe('acceptEdits');
  });

  it('agent.meta with finished → stopped; a meta naming another tool re-binds the spawn link', () => {
    const h = running();
    h.hook('tool.pre', { toolUseId: 'toolu_a', toolName: 'Agent', input: { subagent_type: 'x' } }, 'PreToolUse');
    h.hook('tool.pre', { toolUseId: 'toolu_b', toolName: 'Agent', input: { subagent_type: 'x' } }, 'PreToolUse');
    h.hook('agent.started', { agent: { agentId: 'ag', agentType: 'x' } }, 'SubagentStart');
    expect(h.d.agents['a1' as never]?.spawnTool).toBe('u2');
    h.tx('agent.meta', { agentId: 'ag', toolUseId: 'toolu_a' });
    expect(h.d.agents['a1' as never]).toMatchObject({ spawnTool: 'u1', spawnLinkConfirmed: true });
    expect(h.d.tools['u2' as never]?.spawned).toBeUndefined();
    h.tx('agent.meta', { agentId: 'ag', finished: true });
    expect(h.d.agents['a1' as never]?.state.value).toBe('stopped');
  });

  it('network awaiting → waiting; an api-request for a subagent (querySource agent:<id>) is the agent’s call', () => {
    const h = running();
    h.hook('agent.started', { agent: { agentId: 'sub', agentType: '' } }, 'SubagentStart');
    h.tx('model.requestStarted', { requestRef: 'txreq:s', isRetry: false, querySource: 'agent:sub' }, { uuid: 'txreq:s' });
    expect(h.d.calls['c1' as never]?.agent).toBe('a1');
    h.obs('net.tunnel', { tunnelId: 1, host: 'api.anthropic.com', token: 'A', phase: 'sending', bytesUp: 1, bytesDown: 0 }, 'network');
    h.tx('model.requestStarted', { requestRef: 'txreq:m', isRetry: false, txWall: h.wall as never }, { uuid: 'txreq:m' });
    h.obs('net.tunnel', { tunnelId: 1, host: 'api.anthropic.com', token: 'A', phase: 'awaiting', bytesUp: 1, bytesDown: 0 }, 'network');
    expect(h.d.calls['c2' as never]?.state.value).toBe('waiting');
    h.obs('net.tunnel', { tunnelId: 1, host: 'api.anthropic.com', token: 'A', phase: 'idle', bytesUp: 1, bytesDown: 0 }, 'network');
    expect(Object.keys(h.core.recon.deadlines).some((k) => k.startsWith('stall:c2'))).toBe(false);
  });

  it('a stall banner during hostResumeGrace is suppressed', () => {
    const h = running();
    h.tx('model.requestStarted', { requestRef: 'txreq:z', isRetry: false }, { uuid: 'txreq:z' });
    h.obs('clock.hostResumed', { monoGapMs: 0, wallGapMs: 60_000 }, 'clock');
    h.screen(busyFrame({ status: { kind: 'stalled' } }));
    h.run(300);
    expect(h.d.calls['c1' as never]?.state.value).toBe('started');
    expect(h.d.status).toMatchObject({ kind: 'modelRequest', phase: 'waiting' });
  });

  it('x.fact / x.provenance internal events write their path through evolve', () => {
    const h = readyHarness();
    const d = evolve(h.d, {
      type: 'x.fact',
      path: encodePath(['claude', 'model']),
      fact: { value: 'm2', src: 'hook', seq: 1 as never, at: 1 as never, corroborated: [], provisional: false },
    });
    expect(d.claude.model?.value).toBe('m2');
    const d2 = evolve(h.d, {
      type: 'x.provenance',
      entity: encodePath(['turns', 't9']),
      provenance: { sources: ['hook'], confirmed: true, firstSeq: 1 as never, lastSeq: 1 as never },
    });
    expect((d2.turns['t9' as never] as unknown as { provenance: unknown }).provenance).toBeDefined();
    expect(evolve(h.d, { type: 'x.patch', entity: '', patch: { op: 'set', value: 1 } })).toBe(h.d);
  });

  it('text matching and spawn candidates', () => {
    const h = running();
    h.hook(
      'message.textDelta',
      { uiTurnId: 'u', uiMessageId: 'ui', index: 0, final: true, delta: 'Hello there, friend' },
      'MessageDisplay',
    );
    expect(matchUiMessage(h.d, 't1' as never, 'Hello there, friend. More text follows')).toBe('m1');
    expect(matchUiMessage(h.d, 't1' as never, '')).toBeUndefined();
    expect(matchUiMessage(h.d, undefined, 'x')).toBeUndefined();
    h.hook('tool.pre', { toolUseId: 'toolu_g', toolName: 'Task', input: {} }, 'PreToolUse');
    expect(pickSpawnTool(h.d, 'general-purpose')).toBe('u1');
    expect(pickSpawnTool(h.d, 'Explore')).toBeUndefined();
  });

  it('net.fault command: emits the intent when the network channel is on, refuses otherwise', () => {
    const h = readyHarness();
    expect(h.cmd({ type: 'net.fault', spec: { mode: 'refuse' } })).toMatchObject({ ok: true });
    expect(h.intentsOf('net.fault')[0]?.spec).toEqual({ mode: 'refuse' });
    const off = readyHarness(testConfig({ channels: { network: false } }));
    expect(off.cmd({ type: 'net.fault', spec: null })).toMatchObject({ ok: false, error: { code: 'E_UNSUPPORTED_FEATURE' } });
  });
});
