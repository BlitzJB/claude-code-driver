// core/decide/permissions.ts + reconcile/permission-binding.ts — DESIGN.md §3.7, §4.5.1, D-18 (K-09…K-15, K-36, K-39, K-44).
import { describe, expect, it } from 'vitest';
import type { CoreConfig } from '../../../src/model/config.js';
import type { HookSeq, PermissionKey } from '../../../src/model/ids.js';
import type { Harness } from './harness.js';
import { busyFrame, readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

const P1 = 'p1' as PermissionKey;
function session(policy: CoreConfig['permissions']['policy'] = 'ask', extra: Partial<CoreConfig['permissions']> = {}): Harness {
  const h = readyHarness(testConfig({ permissions: { policy, ...extra } }));
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
const pre = (h: Harness, id: string, tool: string, input: unknown, agentId?: string): Harness =>
  h.hook(
    'tool.pre',
    { toolUseId: id, toolName: tool, input, promptId: 'p1', ...(agentId !== undefined ? { agent: { agentId } } : {}) },
    'PreToolUse',
  );
const request = (h: Harness, tool: string, input: unknown, seq = h.nextHookSeq(), agentId?: string): Harness =>
  h.hook(
    'permission.requested',
    {
      hookSeq: seq,
      toolName: tool,
      input,
      suggestions: [{ type: 'addRules' }],
      promptId: 'p1',
      ...(agentId !== undefined ? { agent: { agentId } } : {}),
    },
    'PermissionRequest',
  );
const responds = (h: Harness) => h.intentsOf('hook.respond');

describe('policies (§3.7 step 1, K-09)', () => {
  it("'deny' answers deny synchronously through the hook", () => {
    const h = session('deny');
    pre(h, 'toolu_1', 'Bash', { command: 'rm -rf /' });
    request(h, 'Bash', { command: 'rm -rf /' });
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Denied by policy' });
    expect(h.d.permissions[P1]?.state.value).toBe('answered');
    expect(h.d.tools['u1' as never]?.state).toMatchObject({ value: 'denied', provisional: true });
    expect(h.ev('permission.answered')[0]?.payload).toEqual({ permissionKey: 'p1', decision: 'deny', by: 'policy', via: 'hook' });
  });

  it("'dangerouslyAllowAll' allows a uniquely bound request", () => {
    const h = session('dangerouslyAllowAll');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' });
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
    expect(h.d.permissions[P1]?.binding).toEqual({ kind: 'unique', confirmed: false });
    expect(h.d.tools['u1' as never]?.state.value).toBe('running');
  });

  it("'ask' / 'handler' → host.askPermission with the policy deadline; the host answer goes through the hook", () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' });
    expect(h.intentsOf('host.askPermission')[0]).toMatchObject({ permissionKey: 'p1', deadlineAt: h.now + 120000 });
    expect(h.d.status).toMatchObject({ kind: 'awaitingPermission', permission: 'p1' });
    const r = h.cmd({
      type: 'permission.answer',
      permissionKey: P1,
      decision: {
        behavior: 'allow',
        updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' as never }],
      },
      by: 'handler',
    });
    expect(r?.ok).toBe(true);
    const body = responds(h)[0]?.body?.hookSpecificOutput;
    expect(body?.hookEventName).toBe('PermissionRequest');
    expect(body?.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
    });
  });

  it('an invalid decision → E_PERMISSION_INVALID to the caller and deny to Claude (fail closed, D-18)', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', {});
    request(h, 'Bash', {});
    const r = h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'maybe' } as never, by: 'handler' });
    expect(r).toMatchObject({ ok: false, error: { code: 'E_PERMISSION_INVALID' } });
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('setMode to a dangerous mode is refused unless allowDangerousModes; addDirectories unless allowAddDirectories', () => {
    const h = session('ask');
    request(h, 'Bash', {});
    const r = h.cmd({
      type: 'permission.answer',
      permissionKey: P1,
      decision: {
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' as never, destination: 'session' }],
      },
      by: 'host',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'E_PERMISSION_INVALID', details: { reason: 'dangerousMode' } } });
    const g = session('ask');
    request(g, 'Bash', {});
    const r2 = g.cmd({
      type: 'permission.answer',
      permissionKey: P1,
      decision: { behavior: 'allow', updatedPermissions: [{ type: 'addDirectories', directories: ['/'] } as never] },
      by: 'host',
    });
    expect(r2).toMatchObject({ ok: false, error: { details: { reason: 'addDirectories' } } });
  });

  it('deny messages are sanitized and capped at 2 KiB', () => {
    const h = session('ask');
    request(h, 'Bash', {});
    h.cmd({
      type: 'permission.answer',
      permissionKey: P1,
      decision: { behavior: 'deny', message: `no\x1b[2J${'x'.repeat(5000)}` },
      by: 'host',
    });
    const msg = (responds(h)[0]?.body?.hookSpecificOutput.decision as { message?: string }).message ?? '';
    expect(msg.startsWith('no[2J')).toBe(true);
    expect(msg.length).toBeLessThanOrEqual(2048);
  });

  it('answering twice → E_PERMISSION_INVALID{notPending}; unknown key → E_PERMISSION_UNKNOWN', () => {
    const h = session('deny');
    request(h, 'Bash', {});
    expect(h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'allow' }, by: 'host' })).toMatchObject({
      ok: false,
      error: { details: { reason: 'notPending' } },
    });
    expect(
      h.cmd({ type: 'permission.answer', permissionKey: 'p9' as PermissionKey, decision: { behavior: 'allow' }, by: 'host' }),
    ).toMatchObject({ ok: false, error: { code: 'E_PERMISSION_UNKNOWN' } });
  });
});

describe('allowRead (§3.7 step 1, rev 2 §10 G3, K-44, K-49 core part)', () => {
  it('emits permission.resolvePaths; all inside → allow; outside → ask', () => {
    const h = session('allowRead');
    pre(h, 'toolu_1', 'Read', { file_path: '/work/a.ts' });
    h.advance(400); // PermissionRequest 400 ms after PreToolUse still binds (K-44, rev 2 §10 A1)
    request(h, 'Read', { file_path: '/work/a.ts' });
    expect(h.d.permissions[P1]?.binding.kind).toBe('unique');
    expect(h.intentsOf('permission.resolvePaths')[0]).toMatchObject({ permissionKey: 'p1', toolName: 'Read' });
    h.obs(
      'permission.pathsResolved',
      { permissionKey: P1, cwdRealpath: '/work', paths: [{ arg: 'file_path', raw: '/work/a.ts', real: '/work/a.ts', inside: true }] },
      'self',
    );
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
    const g = session('allowRead');
    pre(g, 'toolu_2', 'Read', { file_path: '/work/link' });
    request(g, 'Read', { file_path: '/work/link' });
    g.obs(
      'permission.pathsResolved',
      {
        permissionKey: P1,
        cwdRealpath: '/work',
        paths: [{ arg: 'file_path', raw: '/work/link', real: '/etc/passwd', inside: false, reason: 'symlinkOut' }],
      },
      'self',
    );
    expect(responds(g)).toEqual([]);
    expect(g.intentsOf('host.askPermission')).toHaveLength(1);
  });

  it('non-read tools are asked', () => {
    const h = session('allowRead');
    pre(h, 'toolu_1', 'Bash', {});
    request(h, 'Bash', {});
    expect(h.intentsOf('permission.resolvePaths')).toEqual([]);
    expect(h.intentsOf('host.askPermission')).toHaveLength(1);
  });
});

describe('binding (§4.5.1, K-12, P-REC-21/22/23)', () => {
  it('two identical parallel calls → ambiguous-equivalent, FIFO (oldest first), auto-answer still allowed', () => {
    const h = session('dangerouslyAllowAll');
    pre(h, 'toolu_a', 'Bash', { command: 'ls' });
    pre(h, 'toolu_b', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' });
    expect(h.d.permissions[P1]).toMatchObject({ binding: { kind: 'ambiguous-equivalent' }, tool: 'u1', autoAnswerAllowed: true });
    request(h, 'Bash', { command: 'ls' });
    expect(h.d.permissions['p2' as PermissionKey]).toMatchObject({ tool: 'u2' });
  });

  it('a ghost (internal) agent candidate disables auto-answer', () => {
    const h = session('dangerouslyAllowAll');
    pre(h, 'toolu_g', 'Bash', { command: 'ls' }, 'ghost');
    expect(h.d.agents['a1' as never]?.kind).toBe('internal');
    request(h, 'Bash', { command: 'ls' }, h.nextHookSeq(), 'ghost');
    expect(h.d.permissions[P1]?.autoAnswerAllowed).toBe(false);
    expect(responds(h)).toEqual([]);
    expect(h.intentsOf('host.askPermission')).toHaveLength(1);
  });

  it('candidates from different agents → ambiguous-agents bound to the single main-thread one, auto-answer off', () => {
    const h = session('dangerouslyAllowAll');
    h.hook('agent.started', { agent: { agentId: 'sub', agentType: 'general-purpose' } }, 'SubagentStart');
    pre(h, 'toolu_m', 'Bash', { command: 'ls' });
    pre(h, 'toolu_s', 'Bash', { command: 'ls' }, 'sub');
    request(h, 'Bash', { command: 'ls' });
    expect(h.d.permissions[P1]).toMatchObject({ binding: { kind: 'ambiguous-agents' }, tool: 'u1', autoAnswerAllowed: false });
  });

  it('a request before its PreToolUse is unbound and binds on the late Pre (permBindLate)', () => {
    const h = session('ask');
    request(h, 'Bash', { command: 'ls' });
    expect(h.d.permissions[P1]?.binding.kind).toBe('unbound');
    h.advance(300);
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    expect(h.d.permissions[P1]?.tool).toBe('u1');
    expect(h.d.tools['u1' as never]?.state.value).toBe('awaitingPermission');
    expect(h.ev('permission.bound')[0]?.payload).toMatchObject({ permissionKey: 'p1', toolKey: 'u1' });
  });
});

describe('permission.requested carries the core-computed background flag and deadline (ICR 0023)', () => {
  it('a foreground subagent request: background true and the 10 s backgroundTimeoutMs deadline, same as host.askPermission', () => {
    const h = session('ask');
    h.hook('agent.started', { agent: { agentId: 'sub', agentType: 'general-purpose' } }, 'SubagentStart');
    expect(Object.values(h.d.agents)[0]?.background).toBe(false);
    pre(h, 'toolu_s', 'Bash', { command: 'ls' }, 'sub');
    request(h, 'Bash', { command: 'ls' }, h.nextHookSeq(), 'sub');
    const p = h.ev('permission.requested')[0]?.payload;
    expect(p).toMatchObject({ background: true, deadlineAt: h.now + 10000 });
    expect(h.intentsOf('host.askPermission')[0]?.deadlineAt).toBe(p?.deadlineAt);
  });

  it('a main-thread request: background false and the timeoutMs deadline', () => {
    const h = session('ask', { timeoutMs: 5000 });
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' });
    expect(h.ev('permission.requested')[0]?.payload).toMatchObject({ background: false, deadlineAt: h.now + 5000 });
  });
});

describe('resolution and dialogs (§3.7 steps 3, 6–8)', () => {
  it("K-10 policy deadline with onTimeout:'tui' → empty reply, dialogOnly, needsKeys; a human answers → resolved{user_keys}", () => {
    const h = session('ask', { onTimeout: 'tui', timeoutMs: 1000 });
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    request(h, 'Bash', { command: 'ls' });
    h.run(1100);
    expect(responds(h)[0]?.body).toBeNull();
    expect(h.d.permissions[P1]?.state.value).toBe('dialogOnly');
    expect(h.ev('permission.needsKeys')).toHaveLength(1);
    expect(h.intentsOf('host.cancelAsk')[0]?.permissionKey).toBe('p1');
    h.tx(
      'permission.decisionRecorded',
      { toolUseId: 'toolu_1', decision: 'accept', decider: 'user_keys', via: 'attachment' },
      { uuid: 'dr' },
    );
    expect(h.d.permissions[P1]?.resolved).toEqual({ decision: 'allow', decider: 'user_keys', overridden: false });
    expect(h.d.tools['u1' as never]?.state.value).toBe('running');
  });

  it('K-10 a human wins while the request is held → resolved overridden and our hold released', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', {});
    request(h, 'Bash', {});
    h.tx(
      'permission.decisionRecorded',
      { toolUseId: 'toolu_1', decision: 'reject', decider: 'user_keys', via: 'attachment' },
      { uuid: 'dr' },
    );
    expect(h.d.permissions[P1]?.resolved).toEqual({ decision: 'deny', decider: 'user_keys', overridden: true });
    expect(responds(h)[0]?.body).toBeNull();
    expect(h.d.tools['u1' as never]?.state.value).toBe('denied');
  });

  it('K-11 a pending permission blocks every Enter/digit/text intent of a queued send (invariant I6)', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', {});
    request(h, 'Bash', {});
    expect(h.d.inputBlocked.permission).toBe(true);
    const before = h.intentsOf('input').length;
    h.cmd({ type: 'prompt.send', text: 'queued', whenBusy: 'wait' });
    h.run(2000);
    expect(h.intentsOf('input').length).toBe(before);
  });

  it('K-15 hook deny: no Post; the turn continues; tool denied confirmed by the transcript', () => {
    const h = session('deny');
    pre(h, 'toolu_1', 'Bash', {});
    request(h, 'Bash', {});
    h.tx('tool.result', { toolUseId: 'toolu_1', isError: true, denialKind: 'permission-rule', uuid: 'tr' }, { uuid: 'tr' });
    expect(h.d.tools['u1' as never]?.state).toMatchObject({ value: 'denied', provisional: false });
    expect(h.d.permissions[P1]?.state.value).toBe('resolved');
    expect(h.d.turns['t1' as never]?.state.value).toBe('running');
  });

  it('K-14 Esc at a permission dialog: tool_result interrupted + decision record + tool_use marker + turn_duration', () => {
    const h = session('ask', { onTimeout: 'tui', timeoutMs: 500 });
    pre(h, 'toolu_1', 'Bash', {});
    request(h, 'Bash', {});
    h.run(600);
    h.tx(
      'permission.decisionRecorded',
      { toolUseId: 'toolu_1', decision: 'reject', decider: 'user_keys', via: 'tool_result' },
      { uuid: 'x1' },
    );
    h.tx('tool.result', { toolUseId: 'toolu_1', isError: true, denialKind: 'user-rejected', uuid: 'x2' }, { uuid: 'x2' });
    h.tx('turn.interrupted', { marker: 'tool_use' }, { uuid: 'x3' });
    h.tx('turn.durationRecorded', { durationMs: 10, pendingBackgroundAgentCount: 0 }, { uuid: 'x4' });
    expect(h.d.turns['t1' as never]).toMatchObject({ endedBy: 'tool_use_interrupt' });
    expect(h.d.turns['t1' as never]?.state.value).toBe('interrupted');
    expect(h.d.tools['u1' as never]?.state.value).toBe('denied');
    expect(h.d.permissions[P1]?.resolved?.decider).toBe('user_keys');
  });

  it('permission.hookClosed{client_gone} before an answer → dialogOnly + needsKeys; deny then goes by Escape', () => {
    const h = session('ask');
    request(h, 'Bash', {}, 5 as HookSeq);
    h.obs('permission.hookClosed', { hookSeq: 5 as HookSeq, reason: 'client_gone' }, 'self');
    expect(h.d.permissions[P1]?.state.value).toBe('dialogOnly');
    h.screen(
      busyFrame({
        surface: 'permissionDialog',
        dialog: { kind: 'permission', options: [{ n: 1, label: 'Yes', selected: true }] },
        composer: undefined,
      }),
    );
    h.run(300);
    h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'deny' }, by: 'host' });
    h.run(300);
    expect(h.primitives().at(-1)).toEqual({ kind: 'key', key: 'Escape', gapAfterMs: 250 });
  });

  it('over the held cap (holdable:false): born dialogOnly with no hookSeq, needsKeys, no hook.respond; a policy deny goes by Escape (ICR 0018)', () => {
    const h = session('deny');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    h.hook(
      'permission.requested',
      { hookSeq: 33 as HookSeq, holdable: false, toolName: 'Bash', input: { command: 'ls' }, suggestions: [], promptId: 'p1' },
      'PermissionRequest',
    );
    const p = h.d.permissions[P1];
    expect(p?.state.value).toBe('dialogOnly');
    expect(p?.hookSeq).toBeUndefined();
    expect(p?.tool).toBe('u1');
    expect(responds(h)).toHaveLength(0);
    expect(h.ev('permission.needsKeys')).toHaveLength(1);
    // nothing claims a hook answer Claude never received
    expect(h.ev('permission.answered').filter((e) => (e.payload as { via: string }).via === 'hook')).toHaveLength(0);
    h.screen(
      busyFrame({
        surface: 'permissionDialog',
        dialog: { kind: 'permission', options: [{ n: 1, label: 'Yes', selected: true }] },
        composer: undefined,
      }),
    );
    h.run(300);
    expect(h.primitives().at(-1)).toEqual({ kind: 'key', key: 'Escape', gapAfterMs: 250 });
    expect(Object.keys(h.d.permissions)).toEqual(['p1']); // the visible dialog is this record, not a second adoption
  });

  it("over the held cap with policy 'ask': the host is asked and can answer by keys", () => {
    const h = session('ask');
    h.hook(
      'permission.requested',
      { hookSeq: 33 as HookSeq, holdable: false, toolName: 'Bash', input: {}, suggestions: [], promptId: 'p1' },
      'PermissionRequest',
    );
    expect(h.intentsOf('host.askPermission')[0]).toMatchObject({ permissionKey: 'p1' });
    expect(h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'deny' }, by: 'host' })?.ok).toBe(true);
    expect(responds(h)).toHaveLength(0);
  });

  it('hook.responded{ok:false} on an answered record → dialogOnly + needsKeys, and the host can still answer by keys', () => {
    const h = session('ask');
    request(h, 'Bash', {}, 7 as HookSeq);
    h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'allow' }, by: 'host' });
    expect(h.d.permissions[P1]?.state.value).toBe('answered');
    h.obs('hook.responded', { hookSeq: 7 as HookSeq, ok: false, clientGone: false }, 'self');
    expect(h.d.permissions[P1]?.state.value).toBe('dialogOnly');
    expect(h.d.permissions[P1]?.ourAnswer).toBeUndefined();
    expect(h.ev('permission.needsKeys')).toHaveLength(1);
    expect(h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'deny' }, by: 'host' })?.ok).toBe(true);
  });

  it('dialogOnly allow by keys needs screenAllow and a visible "Yes" option (digit, no Enter)', () => {
    const h = session('ask');
    request(h, 'Bash', {}, 6 as HookSeq);
    h.obs('permission.hookClosed', { hookSeq: 6 as HookSeq, reason: 'timeout' }, 'self');
    expect(h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'allow' }, by: 'host' })).toMatchObject({
      ok: false,
      error: { details: { reason: 'screenAllowDisabled' } },
    });
    const g = session('ask', { screenAllow: true });
    request(g, 'Bash', {}, 6 as HookSeq);
    g.obs('permission.hookClosed', { hookSeq: 6 as HookSeq, reason: 'timeout' }, 'self');
    g.screen(
      busyFrame({
        surface: 'permissionDialog',
        dialog: {
          kind: 'permission',
          options: [
            { n: 1, label: 'Yes', selected: true },
            { n: 3, label: 'No', selected: false },
          ],
        },
        composer: undefined,
      }),
    );
    g.run(300);
    expect(g.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'allow' }, by: 'host' })?.ok).toBe(true);
    g.composer = '';
    g.run(300);
    expect(g.primitives().at(-1)).toEqual({ kind: 'key', key: '1', gapAfterMs: 15 });
    expect(g.primitives().some((p) => p.kind === 'key' && p.key === 'Enter' && g.primitives().indexOf(p) > 3)).toBe(false);
  });

  it('dialogOnly allow by keys presses only an option reading exactly "Yes", and only when it is unique (SEC §4.3)', () => {
    const allowWith = (options: { n: number; label: string; selected: boolean }[]) => {
      const g = session('ask', { screenAllow: true });
      request(g, 'Bash', {}, 6 as HookSeq);
      g.obs('permission.hookClosed', { hookSeq: 6 as HookSeq, reason: 'timeout' }, 'self');
      g.screen(busyFrame({ surface: 'permissionDialog', dialog: { kind: 'permission', options }, composer: undefined }));
      g.run(300);
      return g.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'allow' }, by: 'host' });
    };
    const noOption = { ok: false, error: { details: { reason: 'noOption' } } };
    // only `Yes, and …` options: a mode switch or a persistent rule is never pressed for a one-time allow
    expect(
      allowWith([
        { n: 2, label: "Yes, and don't ask again", selected: false },
        { n: 3, label: 'Yes, and switch to auto mode', selected: false },
        { n: 4, label: 'No', selected: false },
      ]),
    ).toMatchObject(noOption);
    // two `Yes` options: the parse is not the dialog's own block
    expect(
      allowWith([
        { n: 3, label: 'Yes', selected: false },
        { n: 1, label: 'Yes', selected: true },
        { n: 4, label: 'No', selected: false },
      ]),
    ).toMatchObject(noOption);
  });

  it('K-39 dialog adoption with healthy hooks; deny via Escape works; the dialog leaving closes the record', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', { command: 'ls' });
    const dlg = busyFrame({
      surface: 'permissionDialog',
      dialog: { kind: 'permission', title: 'Bash command', options: [{ n: 1, label: 'Yes', selected: true }] },
      composer: undefined,
    });
    h.screen(dlg);
    h.run(800);
    const p = h.d.permissions[P1];
    expect(p).toMatchObject({ adopted: true, suspect: false, tool: 'u1', toolName: 'Bash', state: { value: 'dialogOnly' } });
    expect(h.d.status).toMatchObject({ kind: 'awaitingPermission', permission: 'p1' });
    expect(h.ev('permission.requested')[0]?.payload).toMatchObject({ adopted: true, binding: 'screen-only', autoAnswerAllowed: false });
    // armed before publishing, so the event carries the adopted record's real deadline (ICR 0023)
    const armed = h.core.recon.deadlines['permissionPolicy:p1']?.at;
    expect(armed).toBeDefined();
    expect(h.ev('permission.requested')[0]?.payload.deadlineAt).toBe(armed);
    h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'deny' }, by: 'host' });
    h.onPrimitive = (prim) => (prim.kind === 'key' && prim.key === 'Escape' ? { surface: 'main' } : undefined);
    h.run(500);
    expect(h.primitives().some((x) => x.kind === 'key' && x.key === 'Escape')).toBe(true);
    expect(h.d.permissions[P1]?.ourAnswer).toMatchObject({ decision: 'deny', via: 'keys' });
    h.run(2100);
    expect(h.d.permissions[P1]?.state.value).toBe('abandoned');
  });

  it('an adopted dialog with no recent PreToolUse is suspect and never auto-answered', () => {
    const h = session('dangerouslyAllowAll');
    h.screen(
      busyFrame({ surface: 'permissionDialog', dialog: { kind: 'permission', title: 'Edit file', options: [] }, composer: undefined }),
    );
    h.run(800);
    expect(h.d.permissions[P1]).toMatchObject({ adopted: true, suspect: true });
    expect(h.intentsOf('input').filter((i) => i.primitive.kind === 'key' && /^[1-9]$/.test((i.primitive as { key: string }).key))).toEqual(
      [],
    );
  });

  it('turn end abandons its open permissions and releases a held request (§3.7 step 9)', () => {
    const h = session('ask');
    pre(h, 'toolu_1', 'Bash', {});
    request(h, 'Bash', {});
    h.hook('turn.failed', { error: 'server_error' }, 'StopFailure');
    expect(h.d.permissions[P1]?.state.value).toBe('abandoned');
    expect(responds(h)[0]?.body).toBeNull();
    expect(h.ev('permission.abandoned')[0]?.payload.reason).toBe('turnClosed');
  });

  it('close() denies every held request (D-18)', () => {
    const h = session('ask');
    request(h, 'Bash', {});
    h.cmd({ type: 'session.close', mode: 'graceful', graceMs: 1000, reason: 'bye' });
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Denied: session closing' });
    expect(h.ev('permission.answered')[0]?.payload.by).toBe('close');
  });

  it('interrupt with a held permission → deny{interrupt:true} through the hook, no key pressed (§3.6 Interrupt)', () => {
    const h = session('ask');
    request(h, 'Bash', {});
    const before = h.intentsOf('input').length;
    h.cmd({ type: 'interrupt' });
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'Interrupted by the host',
      interrupt: true,
    });
    expect(h.intentsOf('input').length).toBe(before);
  });
});

describe('structured tools (K-36, P-REV-07/08)', () => {
  it('AskUserQuestion: dangerouslyAllowAll asks; answerQuestion → allow + updatedInput.answers', () => {
    const h = session('dangerouslyAllowAll');
    const input = { questions: [{ question: 'Which?', options: ['a', 'b'] }] };
    pre(h, 'toolu_q', 'AskUserQuestion', input);
    request(h, 'AskUserQuestion', input);
    expect(h.d.permissions[P1]?.needs).toBe('answers');
    expect(responds(h)).toEqual([]);
    expect(h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'allow' }, by: 'host' })).toMatchObject({
      ok: false,
      error: { details: { reason: 'structuredAnswerRequired' } },
    });
    expect(h.d.permissions[P1]?.state.value).toBe('pending');
    h.cmd({ type: 'permission.answerQuestion', permissionKey: P1, answers: { 'Which?': 'a' } });
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which?': 'a' } },
    });
  });

  it("ExitPlanMode: plain allow → E_PERMISSION_INVALID and still pending; approvePlan{approve, mode:'acceptEdits'} → allow + setMode", () => {
    const h = session('ask');
    const input = { plan: '1. do it' };
    pre(h, 'toolu_p', 'ExitPlanMode', input);
    request(h, 'ExitPlanMode', input);
    expect(h.cmd({ type: 'permission.answer', permissionKey: P1, decision: { behavior: 'allow' }, by: 'handler' })?.ok).toBe(false);
    expect(h.d.permissions[P1]?.state.value).toBe('pending');
    h.cmd({ type: 'permission.approvePlan', permissionKey: P1, approve: true, mode: 'acceptEdits' });
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  it('approvePlan{approve:false} → deny with feedback; approvePlan on a non-plan request → invalid', () => {
    const h = session('ask');
    request(h, 'ExitPlanMode', { plan: 'x' });
    h.cmd({ type: 'permission.approvePlan', permissionKey: P1, approve: false, feedback: 'not yet' });
    expect(responds(h)[0]?.body?.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'not yet' });
    const g = session('ask');
    request(g, 'Bash', {});
    expect(g.cmd({ type: 'permission.approvePlan', permissionKey: P1, approve: true })).toMatchObject({
      ok: false,
      error: { details: { reason: 'notAPlan' } },
    });
  });

  it("mode 'bypassPermissions' via approvePlan is refused at runtime", () => {
    const h = session('ask');
    request(h, 'ExitPlanMode', { plan: 'x' });
    const r = h.cmd({ type: 'permission.approvePlan', permissionKey: P1, approve: true, mode: 'bypassPermissions' as never });
    expect(r).toMatchObject({ ok: false, error: { details: { reason: 'dangerousMode' } } });
  });
});
