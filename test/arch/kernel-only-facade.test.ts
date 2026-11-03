// DESIGN.md §1.4 3f: the kernel-only facade (./kernel-only-facade.ts) depends on model/** types alone and drives K-01, K-09 and
// K-13 through the SessionKernel port. Here it runs against a scripted in-memory SessionKernel; the scripted kernel stands in
// for `createKernel` until runtime/node.ts and the WP-14 fakes exist (then WP-INT points the same facade at createKernel).
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command, CommandResult, PermissionDecision } from '../../src/model/commands.js';
import type { DomainEvent, TurnOutcome } from '../../src/model/events.js';
import type { EventSeq, PermissionKey, SessionKey, TurnKey } from '../../src/model/ids.js';
import type { KernelListener, KernelPermissionHandler, SessionExitInfo, SessionKernel } from '../../src/model/kernel.js';
import type { UsageReport } from '../../src/model/usage.js';
import type { SessionSpec } from '../../src/model/spec.js';
import type { SessionState } from '../../src/model/state.js';
import type { MonoMs, WallMs } from '../../src/model/time.js';
import { MiniFacade } from './kernel-only-facade.js';
import { importsOf, parse, ROOT } from './helpers.js';

type Script = 'completes' | 'asksPermission' | 'waitsForInterrupt';

class ScriptedKernel implements SessionKernel {
  readonly sessionKey = 's0000abcd' as SessionKey;
  readonly diagnostics = {
    viewCommand: (): string => 'tmux -L ccd-test attach -r -t =s:',
    captureScreen: (): Promise<string> => Promise.resolve(''),
  };
  readonly commands: Command[] = [];
  readonly specs: SessionSpec[] = [];
  private readonly listeners = new Set<KernelListener>();
  private handler: KernelPermissionHandler | null = null;
  private seq = 0;
  private turns = 0;
  private running: TurnKey | undefined;
  private readonly state = { v: 1, lifecycle: 'ready' } as unknown as SessionState;

  constructor(private readonly script: Script) {}

  getState(): Readonly<SessionState> {
    return this.state;
  }
  subscribe(l: KernelListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  subscribeDebug(): () => void {
    return () => undefined;
  }
  queryUsage(): Promise<UsageReport> {
    return Promise.resolve({ meters: [], readAt: 0 });
  }
  setPermissionHandler(h: KernelPermissionHandler | null): void {
    this.handler = h;
  }
  waitFor(pred: (s: SessionState) => boolean): Promise<SessionState> {
    return pred(this.state) ? Promise.resolve(this.state) : Promise.reject(new Error('E_WAIT_TIMEOUT'));
  }
  close(): Promise<SessionExitInfo> {
    return Promise.resolve({ exitStatus: 0, signal: null, reason: 'closed' });
  }

  dispatch<C extends Command>(cmd: C): Promise<CommandResult<C>> {
    this.commands.push(cmd);
    if (cmd.type === 'prompt.send') {
      const turnKey = `t${++this.turns}` as TurnKey;
      this.running = turnKey;
      if (this.script === 'completes')
        queueMicrotask(() => {
          this.end(turnKey, 'completed');
        });
      if (this.script === 'asksPermission') queueMicrotask(() => void this.askThenEnd(turnKey));
      return Promise.resolve({ turnKey } as CommandResult<C>);
    }
    if (cmd.type === 'interrupt') {
      const turnKey = this.running;
      if (turnKey !== undefined)
        queueMicrotask(() => {
          this.end(turnKey, 'interrupted');
        });
      return Promise.resolve({ turnKey } as CommandResult<C>);
    }
    return Promise.resolve({ ok: true } as CommandResult<C>);
  }

  /** What L3's permission broker does: run the handler, turn its answer into a `permission.answer` command (deny on failure). */
  private async askThenEnd(turnKey: TurnKey): Promise<void> {
    const permissionKey = 'p1' as PermissionKey;
    const ac = new AbortController();
    let decision: PermissionDecision = { behavior: 'deny', message: 'no handler' };
    try {
      decision = (await this.handler?.({
        permissionKey,
        toolName: 'Bash',
        input: { command: 'touch x' },
        suggestions: [],
        needs: 'decision',
        turnKey,
        background: false,
        deadlineAt: 120_000 as MonoMs,
        signal: ac.signal,
      })) ?? { behavior: 'deny', message: 'asked host' };
    } catch {
      decision = { behavior: 'deny', message: 'handler threw' };
    }
    await this.dispatch({ type: 'permission.answer', permissionKey, decision, by: 'handler' });
    this.end(turnKey, decision.behavior === 'allow' ? 'completed' : 'failed');
  }

  private end(turnKey: TurnKey, outcome: TurnOutcome): void {
    this.running = undefined;
    const e: DomainEvent = {
      v: 1,
      seq: ++this.seq as EventSeq,
      type: 'turn.ended',
      at: 0 as MonoMs,
      wallAt: 0 as WallMs,
      sessionKey: this.sessionKey,
      turnKey,
      provenance: { confirmed: true, sources: ['hook'] },
      causedBy: [],
      payload: { outcome, endedBy: outcome === 'interrupted' ? 'interrupt' : 'stop' },
    };
    for (const l of this.listeners) l({ events: [e], state: this.state });
  }
}

const start = async (script: Script, onPermission = (): PermissionDecision => ({ behavior: 'allow' })) => {
  const kernel = new ScriptedKernel(script);
  const facade = await MiniFacade.start(
    (spec) => {
      kernel.specs.push(spec);
      return Promise.resolve(kernel);
    },
    '/tmp/cwd',
    onPermission,
  );
  return { kernel, facade };
};

describe('kernel-only facade (§1.4 3f)', () => {
  it('imports nothing but type-only model/** modules', () => {
    const imports = importsOf(parse(join(ROOT, 'test', 'arch', 'kernel-only-facade.ts')));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => !i.typeOnly || !/^\.\.\/\.\.\/src\/model\/[a-z-]+\.js$/.test(i.specifier))).toEqual([]);
  });

  it('K-01 start → ready, and the spec it passes is a minimal SessionSpec', async () => {
    const { kernel, facade } = await start('completes');
    expect(facade.ready).toBe(true);
    expect(kernel.specs).toEqual([{ cwd: '/tmp/cwd', permissions: { policy: 'handler' } }]);
    const turn = await facade.send('Reply with OK');
    expect(await turn.done).toBe('completed');
    expect(await facade.close()).toEqual({ exitStatus: 0, signal: null, reason: 'closed' });
  });

  it('K-09 a handler allow reaches the kernel as permission.answer; a throwing handler denies', async () => {
    const allow = await start('asksPermission');
    expect(await (await allow.facade.send('touch x')).done).toBe('completed');
    expect(allow.kernel.commands.find((c) => c.type === 'permission.answer')).toMatchObject({
      decision: { behavior: 'allow' },
      by: 'handler',
    });

    const throwing = await start('asksPermission', () => {
      throw new Error('handler bug');
    });
    expect(await (await throwing.facade.send('touch x')).done).toBe('failed');
    expect(throwing.kernel.commands.find((c) => c.type === 'permission.answer')).toMatchObject({ decision: { behavior: 'deny' } });
  });

  it('K-13 interrupt during a running turn ends it as interrupted', async () => {
    const { facade } = await start('waitsForInterrupt');
    const turn = await facade.send('think for a while');
    expect(await facade.interrupt()).toBe(turn.key);
    expect(await turn.done).toBe('interrupted');
  });
});
