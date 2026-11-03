// Kernel scenarios: the permission flow (DESIGN.md §6.3 K-09, K-10, K-12, K-14, K-15, K-36, K-39, K-44, K-49; §3.7, §4.5.1).
import { describe, expect } from 'vitest';
import type { PermissionDecision } from '../../src/model/commands.js';
import type { PermissionKey } from '../../src/model/ids.js';
import type { KernelPermissionHandler } from '../../src/model/kernel.js';
import type { FakeTurn, ToolSpec } from '../../src/testing/fake-claude.js';
import type { TestKernel } from '../../src/testing/test-kernel.js';
import { boot, codeOf, ended, keys, kscenario, mark, send, since } from './support.js';

const BASH: ToolSpec = { name: 'Bash', input: { command: 'touch x', description: 'Create x' } };

/** A turn that runs one tool, says what happened, and stops. */
const oneTool =
  (spec: ToolSpec = BASH) =>
  async (t: FakeTurn): Promise<void> => {
    const r = await t.tool(spec);
    if (r.decision === 'interrupted') return;
    await t.say(`tool ${r.decision}`);
    await t.stop();
  };

/** The hook replies our transport sent (hookSeq → parsed body). */
function replies(tk: TestKernel): { hookSeq: number; body: unknown }[] {
  return (tk.fakes.hooks.instances.at(-1)?.responses ?? []).map((r) => ({ hookSeq: r.hookSeq, body: r.body }));
}

function decisionOf(body: unknown): Record<string, unknown> | undefined {
  const d = (body as { hookSpecificOutput?: { decision?: unknown } } | null)?.hookSpecificOutput?.decision;
  return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : undefined;
}

async function runWith(
  handler: KernelPermissionHandler | undefined,
  o: { policy?: 'deny' | 'handler' | 'allowRead' | 'dangerouslyAllowAll' | 'ask' } = {},
) {
  const tk = await boot({
    spec: { permissions: { policy: o.policy ?? 'handler' } },
    claude: { onPrompt: oneTool() },
    ...(handler === undefined ? {} : { permissionHandler: handler }),
  });
  const k = await send(tk, 'touch x');
  const e = await ended(tk, k);
  return { tk, e };
}

describe('permissions', () => {
  kscenario('K-09', ['09', '13'], 'handler allow → allow through the hook; tool succeeds', async () => {
    const { tk, e } = await runWith(() => ({ behavior: 'allow' }));
    expect(e.payload.outcome).toBe('completed');
    expect(decisionOf(replies(tk)[0]?.body)).toMatchObject({ behavior: 'allow' });
    expect(tk.eventsOf('permission.answered')[0]?.payload).toMatchObject({ decision: 'allow', by: 'handler', via: 'hook' });
    expect(tk.eventsOf('tool.ended').at(-1)?.payload.state).toBe('succeeded');
  });

  kscenario('K-09', ['09'], "policy 'deny' → deny", async () => {
    const { tk } = await runWith(undefined, { policy: 'deny' });
    expect(decisionOf(replies(tk)[0]?.body)).toMatchObject({ behavior: 'deny' });
    expect(tk.eventsOf('permission.answered')[0]?.payload.by).toBe('policy');
  });

  kscenario('K-09', ['13'], 'handler throws → deny', async () => {
    const { tk } = await runWith(() => {
      throw new Error('handler bug');
    });
    expect(decisionOf(replies(tk)[0]?.body)).toMatchObject({ behavior: 'deny' });
  });

  kscenario('K-09', ['13'], 'invalid decision → deny', async () => {
    const { tk } = await runWith(() => ({ behavior: 'maybe' }) as unknown as PermissionDecision);
    expect(decisionOf(replies(tk)[0]?.body)).toMatchObject({ behavior: 'deny' });
  });

  kscenario('K-09', ['09'], 'updatedPermissions destination rewritten to session', async () => {
    const { tk } = await runWith(() => ({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }],
          behavior: 'allow',
          destination: 'userSettings' as 'session',
        },
      ],
    }));
    const d = decisionOf(replies(tk)[0]?.body);
    expect(d?.['behavior']).toBe('allow');
    const ups = d?.['updatedPermissions'] as { destination: string }[] | undefined;
    expect(ups?.map((u) => u.destination)).toEqual(['session']);
  });

  kscenario('K-09', ['09', '13'], 'after a hook allow the long-running tool shows runningTools, not awaitingPermission', async () => {
    // live smoke finding (ICR 0016): an allow delivered through the hook is acted on at once, so the 30 s tool is running
    const tk = await boot({
      claude: { onPrompt: oneTool({ ...BASH, runMs: 10_000 }) },
      permissionHandler: () => ({ behavior: 'allow' }),
    });
    const k = await send(tk, 'touch x slowly');
    await tk.waitForEvent('permission.answered');
    await tk.advance(2000);
    expect(tk.state().status.kind).toBe('runningTools');
    expect((await ended(tk, k)).payload.outcome).toBe('completed');
    expect(since(tk, { ev: 0 }, 'status.changed').some((x) => x.payload.to.kind === 'awaitingPermission')).toBe(true);
  });

  kscenario(
    'K-10',
    ['09', '13'],
    "policy deadline with onTimeout:'tui' → empty reply → human answers at the pane → resolved{user_keys}",
    async () => {
      const tk = await boot({
        spec: { permissions: { policy: 'handler', timeoutMs: 2000, onTimeout: 'tui' } },
        claude: { onPrompt: oneTool() },
        permissionHandler: () => new Promise<PermissionDecision>(() => undefined),
      });
      const k = await send(tk, 'touch x');
      await tk.waitForEvent('permission.requested');
      await tk.until(() => replies(tk).length === 1, 5000, 'empty reply');
      expect(replies(tk)[0]?.body).toBeNull();
      await tk.until(() => tk.claude().dialog?.kind === 'permission', 5000, 'dialog');
      tk.claude().input('1'); // the human at the pane
      const e = await ended(tk, k);
      expect(e.payload.outcome).toBe('completed');
      const resolved = tk.eventsOf('permission.resolved')[0];
      expect(resolved?.payload).toMatchObject({ decision: 'allow', decider: 'user_keys' });
    },
  );

  kscenario('K-10', ['09', '13'], 'human wins while the request is still held → we release (handler signal aborted)', async () => {
    let signal: AbortSignal | undefined;
    const tk = await boot({
      spec: { permissions: { policy: 'handler', timeoutMs: 120_000, onTimeout: 'tui' } },
      claude: { onPrompt: oneTool() },
      permissionHandler: (ask) => {
        signal = ask.signal;
        return new Promise<PermissionDecision>(() => undefined);
      },
    });
    const k = await send(tk, 'touch x');
    await tk.waitForEvent('permission.requested');
    // Claude's own hook timeout (registered as ceil(timeoutMs/1000)+30 s) expires first: the forwarder closes, the dialog
    // appears, and the human answers it while our policy deadline has not fired yet.
    await tk.until(() => tk.claude().dialog?.kind === 'permission', 160_000, 'dialog after the hook timeout');
    tk.claude().input('1');
    expect((await ended(tk, k)).payload.outcome).toBe('completed');
    expect(tk.eventsOf('permission.resolved').at(-1)?.payload).toMatchObject({ decision: 'allow', decider: 'user_keys' });
    expect(signal?.aborted).toBe(true);
    expect(tk.fakes.hooks.instances.at(-1)?.stats().held).toBe(0);
  });

  kscenario(
    'K-39',
    ['06', '13'],
    'a held PermissionRequest L1 rejects is released at once, not held until the hook timeout (ICR 0026)',
    async () => {
      const tk = await boot({ spec: { permissions: { policy: 'handler' } } });
      const hooks = tk.fakes.hooks.instances.at(-1);
      if (hooks === undefined) throw new Error('no hook transport');
      const bad: [string, unknown][] = [
        ['missing tool_name', { hook_event_name: 'PermissionRequest', tool_input: {} }],
        ['empty tool_name', { hook_event_name: 'PermissionRequest', tool_name: '', tool_input: {} }],
        ['eventMismatch', { hook_event_name: 'Stop', tool_name: 'Bash', tool_input: {} }],
        ['not an object', [1, 2, 3]],
      ];
      for (const [why, payload] of bad) {
        const call = hooks.deliver('PermissionRequest', payload, { transport: 'unix' });
        expect(call.hookSeq, why).toBeDefined();
        await tk.until(() => call.settled() !== undefined, 1_000, `released: ${why}`);
        expect(call.settled(), why).toEqual({ status: 200, body: '' });
      }
      expect(hooks.stats().held).toBe(0);
      expect(tk.eventsOf('permission.requested')).toHaveLength(0);
    },
  );

  kscenario('K-12', ['09'], 'two identical parallel Bash calls → ambiguous-equivalent FIFO, rebind on evidence', async () => {
    const tk = await boot({
      claude: {
        onPrompt: async (t) => {
          // parallel tool_use blocks: both PreToolUse hooks fire before either PermissionRequest (permissionDelayMs)
          const par = { ...BASH, permissionDelayMs: 20 };
          const [a, b] = await Promise.all([t.tool(par), t.tool(par)]);
          await t.say(`${a.decision} ${b.decision}`);
          await t.stop();
        },
      },
      permissionHandler: () => ({ behavior: 'allow' }),
    });
    const k = await send(tk, 'two touches');
    expect((await ended(tk, k)).payload.outcome).toBe('completed');
    const reqs = tk.eventsOf('permission.requested');
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.payload.binding === 'ambiguous-equivalent')).toBe(true);
    const tools = tk.eventsOf('tool.ended').map((t) => t.payload.state);
    expect(tools).toEqual(['succeeded', 'succeeded']);
    expect(tk.eventsOf('permission.bound').length + tk.eventsOf('permission.rebound').length).toBeGreaterThanOrEqual(2);
  });

  kscenario('K-12', ['09'], 'ghost-agent candidate → auto-answer off', async () => {
    const tk = await boot({
      spec: { permissions: { policy: 'dangerouslyAllowAll' } },
      claude: { onPrompt: oneTool({ ...BASH, agent: { id: 'a0ghost000000001', type: '' } }) },
    });
    await send(tk, 'ghost');
    const req = await tk.waitForEvent('permission.requested');
    expect(req.payload.autoAnswerAllowed).toBe(false);
    expect(replies(tk).filter((r) => decisionOf(r.body)?.['behavior'] === 'allow')).toEqual([]);
  });

  kscenario(
    'K-14',
    ['09'],
    'Esc at a permission dialog → turn_duration only → turn interrupted{tool_use}, tool denied, permission resolved{user_keys}',
    async () => {
      const tk = await boot({
        spec: { permissions: { policy: 'handler', timeoutMs: 1000, onTimeout: 'tui' } },
        claude: { onPrompt: oneTool() },
        permissionHandler: () => new Promise<PermissionDecision>(() => undefined),
      });
      const k = await send(tk, 'touch x');
      await tk.until(() => tk.claude().dialog?.kind === 'permission', 10_000, 'dialog');
      tk.claude().input('\u001b'); // the human presses Esc at the dialog
      const e = await ended(tk, k);
      expect(e.payload.outcome).toBe('interrupted');
      expect(e.payload.endedBy).toBe('tool_use_interrupt');
      expect(tk.eventsOf('tool.ended').at(-1)?.payload.state).toBe('denied');
      expect(tk.eventsOf('permission.resolved').at(-1)?.payload).toMatchObject({ decision: 'deny', decider: 'user_keys' });
      expect(tk.claude().hookCalls.map((h) => h.event)).not.toContain('Stop');
    },
  );

  kscenario('K-15', ['09'], 'hook deny → no Post → turn continues → Stop → completed; tool denied confirmed by transcript', async () => {
    const { tk, e } = await runWith(undefined, { policy: 'deny' });
    expect(e.payload.outcome).toBe('completed');
    expect(tk.claude().hookCalls.map((h) => h.event)).not.toContain('PostToolUse');
    const te = tk.eventsOf('tool.ended').at(-1);
    expect(te?.payload.state).toBe('denied');
    expect(te?.provenance.sources).toContain('transcript');
    expect(te?.provenance.confirmed).toBe(true);
  });

  kscenario(
    'K-36',
    ['09', '13'],
    'AskUserQuestion: dangerouslyAllowAll still asks; answerQuestion → allow + updatedInput.answers',
    async () => {
      const tk = await boot({
        spec: { permissions: { policy: 'dangerouslyAllowAll' } },
        claude: {
          onPrompt: oneTool({
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which colour?', options: [{ label: 'red' }, { label: 'blue' }] }] },
          }),
        },
      });
      const k = await send(tk, 'ask me');
      const req = await tk.waitForEvent('permission.requested');
      expect(req.payload.needs).toBe('answers');
      expect(replies(tk)).toEqual([]);
      await tk.dispatch({
        type: 'permission.answerQuestion',
        permissionKey: req.payload.permissionKey,
        answers: { 'Which colour?': 'blue' },
      });
      await tk.until(() => replies(tk).length === 1, 5000, 'reply');
      const d = decisionOf(replies(tk)[0]?.body);
      expect(d?.['behavior']).toBe('allow');
      expect((d?.['updatedInput'] as { answers?: unknown } | undefined)?.answers).toEqual({ 'Which colour?': 'blue' });
      expect((await ended(tk, k)).payload.outcome).toBe('completed');
    },
  );

  kscenario(
    'K-36',
    ['09', '13'],
    'ExitPlanMode: plain allow → E_PERMISSION_INVALID and still pending; approvePlan(acceptEdits) → allow + setMode',
    async () => {
      const tk = await boot({
        spec: { permissionMode: 'plan' },
        claude: { onPrompt: oneTool({ name: 'ExitPlanMode', input: { plan: '1. do it' } }) },
        permissionHandler: () => undefined,
      });
      const k = await send(tk, 'plan it');
      const req = await tk.waitForEvent('permission.requested');
      expect(req.payload.needs).toBe('planApproval');
      const pk: PermissionKey = req.payload.permissionKey;
      let err: unknown;
      try {
        await tk.dispatch({ type: 'permission.answer', permissionKey: pk, decision: { behavior: 'allow' }, by: 'host' });
      } catch (x) {
        err = x;
      }
      expect(codeOf(err)).toBe('E_PERMISSION_INVALID');
      expect(tk.state().permissions[pk]?.state.value).toBe('pending');
      let bypassErr: unknown;
      try {
        await tk.dispatch({ type: 'permission.approvePlan', permissionKey: pk, approve: true, mode: 'bypassPermissions' as 'acceptEdits' });
      } catch (x) {
        bypassErr = x;
      }
      expect(codeOf(bypassErr)).toBe('E_MODE_FORBIDDEN');
      await tk.dispatch({ type: 'permission.approvePlan', permissionKey: pk, approve: true, mode: 'acceptEdits' });
      await tk.until(() => replies(tk).length === 1, 5000, 'reply');
      const d = decisionOf(replies(tk)[0]?.body);
      expect(d?.['behavior']).toBe('allow');
      expect(d?.['updatedPermissions']).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
      expect((await ended(tk, k)).payload.outcome).toBe('completed');
    },
  );

  kscenario(
    'K-39',
    ['09', '13'],
    'dialog adoption: PermissionRequest never arrives, dialog stable → dialogOnly within 500 ms, needsKeys; deny via Escape',
    async () => {
      const tk = await boot({
        claude: { onPrompt: oneTool({ ...BASH, noPermissionHook: true }) },
        permissionHandler: () => ({ behavior: 'deny', message: 'no' }),
      });
      const k = await send(tk, 'touch x');
      await tk.until(() => tk.claude().dialog?.kind === 'permission', 10_000, 'dialog');
      const shownAt = tk.fakes.clock.now();
      // mark when the dialog shows: the handler denies at once, so the Escape can precede `permission.requested` returning
      const m = mark(tk);
      const req = await tk.waitForEvent('permission.requested', { maxMs: 2000 });
      expect(tk.fakes.clock.now() - shownAt).toBeLessThanOrEqual(500 + 250 + 300);
      expect(req.payload.adopted).toBe(true);
      expect(tk.eventsOf('permission.needsKeys')).toHaveLength(1);
      const e = await ended(tk, k);
      expect(keys(tk, m.inv)).toContain('Escape');
      expect(['completed', 'interrupted']).toContain(e.payload.outcome);
      expect(tk.eventsOf('tool.ended').at(-1)?.payload.state).toBe('denied');
      expect(since(tk, { ev: 0 }, 'status.changed').some((s) => s.payload.to.kind === 'awaitingPermission')).toBe(true);
    },
  );

  kscenario(
    'K-44',
    ['09', '13'],
    'PermissionRequest 400 ms after PreToolUse → binds unique; allowRead auto-answers after pathsResolved',
    async () => {
      const file = '/work/project/src/a.ts';
      const tk = await boot({
        spec: { permissions: { policy: 'allowRead' } },
        ports: {
          entries: {
            [file]: { isSymlink: false, isFile: true, isDir: false },
            '/work/project/src': { isSymlink: false, isFile: false, isDir: true },
          },
        },
        claude: { onPrompt: oneTool({ name: 'Read', input: { file_path: file }, permissionDelayMs: 400 }) },
      });
      const k = await send(tk, 'read a');
      expect((await ended(tk, k)).payload.outcome).toBe('completed');
      expect(tk.eventsOf('permission.requested')[0]?.payload.binding).toBe('unique');
      const ans = tk.eventsOf('permission.answered')[0];
      expect(ans?.payload).toMatchObject({ decision: 'allow', by: 'policy' });
      expect(ans).toBeDefined();
      const p = ans === undefined ? undefined : tk.state().permissions[ans.payload.permissionKey];
      expect(p?.paths?.state).toBe('resolved');
      expect(p?.paths?.allInside).toBe(true);
    },
  );

  kscenario('K-49', ['13'], "allowRead: Read of cwd/link → /etc/passwd asks; Glob '../**' asks; Grep cwd/src allows", async () => {
    const cases: { spec: ToolSpec; expect: 'ask' | 'allow' }[] = [
      { spec: { name: 'Read', input: { file_path: '/work/project/link' } }, expect: 'ask' },
      { spec: { name: 'Glob', input: { pattern: '../**' } }, expect: 'ask' },
      { spec: { name: 'Grep', input: { pattern: 'x', path: '/work/project/src' } }, expect: 'allow' },
    ];
    for (const c of cases) {
      const asked: string[] = [];
      const tk = await boot({
        spec: { permissions: { policy: 'allowRead' } },
        ports: {
          realpaths: { '/work/project/link': '/etc/passwd' },
          entries: {
            '/work/project/link': { isSymlink: true, isFile: false, isDir: false },
            '/etc/passwd': { isSymlink: false, isFile: true, isDir: false },
            '/work/project/src': { isSymlink: false, isFile: false, isDir: true },
          },
        },
        claude: { onPrompt: oneTool(c.spec) },
        permissionHandler: (a) => {
          asked.push(a.toolName);
          return { behavior: 'deny' };
        },
      });
      const k = await send(tk, c.spec.name);
      await ended(tk, k);
      const by = tk.eventsOf('permission.answered')[0]?.payload.by;
      if (c.expect === 'allow') {
        expect(by, c.spec.name).toBe('policy');
        expect(asked, c.spec.name).toEqual([]);
      } else {
        expect(asked, c.spec.name).toEqual([c.spec.name]);
      }
    }
  });
});
