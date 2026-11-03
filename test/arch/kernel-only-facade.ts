// test/arch/kernel-only-facade.ts — DESIGN.md §1.4 3f (rev 2 §10 C6): a second, throw-away facade written against nothing but
// the SessionKernel port types (model/kernel.ts and the model types it names) plus an injected `createKernel`. If this compiles
// and drives K-01 / K-09 / K-13, a different public API needs nothing from session/**, core/** or platform/**.
import type { PermissionDecision } from '../../src/model/commands.js';
import type { TurnOutcome } from '../../src/model/events.js';
import type { TurnKey } from '../../src/model/ids.js';
import type { SessionExitInfo, SessionKernel } from '../../src/model/kernel.js';
import type { SessionSpec } from '../../src/model/spec.js';

/** The shape of runtime/node.ts `createKernel` (§2.10); injected so this facade imports no implementation. */
export type CreateKernel = (spec: SessionSpec) => Promise<SessionKernel>;
export type MiniPermissionHandler = (toolName: string, input: unknown) => PermissionDecision;
export interface MiniTurn {
  readonly key: TurnKey;
  readonly done: Promise<TurnOutcome>;
}

export class MiniFacade {
  private readonly ended = new Map<TurnKey, TurnOutcome>();
  private readonly waiters = new Map<TurnKey, (o: TurnOutcome) => void>();

  private constructor(private readonly kernel: SessionKernel) {
    kernel.subscribe(({ events }) => {
      for (const e of events) {
        if (e.type !== 'turn.ended' || e.turnKey === undefined) continue;
        this.ended.set(e.turnKey, e.payload.outcome);
        this.waiters.get(e.turnKey)?.(e.payload.outcome);
        this.waiters.delete(e.turnKey);
      }
    });
  }

  /** K-01: resolves once the kernel is ready (createKernel resolves at session.ready). */
  static async start(createKernel: CreateKernel, cwd: string, onPermission: MiniPermissionHandler): Promise<MiniFacade> {
    const kernel = await createKernel({ cwd, permissions: { policy: 'handler' } });
    kernel.setPermissionHandler((ask) => onPermission(ask.toolName, ask.input)); // K-09
    return new MiniFacade(kernel);
  }

  get ready(): boolean {
    return this.kernel.getState().lifecycle === 'ready';
  }

  async send(text: string): Promise<MiniTurn> {
    const { turnKey } = await this.kernel.dispatch({ type: 'prompt.send', text, whenBusy: 'wait' });
    return { key: turnKey, done: this.outcome(turnKey) };
  }

  /** K-13 */
  async interrupt(): Promise<TurnKey | undefined> {
    return (await this.kernel.dispatch({ type: 'interrupt' })).turnKey;
  }

  close(): Promise<SessionExitInfo> {
    return this.kernel.close({ mode: 'graceful' });
  }

  private outcome(key: TurnKey): Promise<TurnOutcome> {
    const known = this.ended.get(key);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => this.waiters.set(key, resolve));
  }
}
