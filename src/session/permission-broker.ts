// session/permission-broker.ts — PermissionKey ↔ HookSeq; runs the user's permission handler; executes the hook intents
// (DESIGN.md §1.2, §2.6 intents `host.askPermission`, `host.cancelAsk`, `hook.respond`, `hook.armSelfTest`,
// `hook.disarmSelfTest`; §2.10 PermissionAsk / KernelPermissionHandler; §3.7 steps 3, 5, 7; D-18 fail closed).
//
// The broker is in L3 because the handler is user code (it may be async, may throw, may never return). It never decides a
// policy and never times anything: the policy timeout is the core deadline `permissionPolicy` (rev 2 §10 G4), which answers
// per `onTimeout` and emits `host.cancelAsk`, and the broker then aborts the handler's AbortSignal and drops its late result.
//   - handler returns a decision → `permission.answer{by:'handler'}` (the core validates it, §3.7 step 4);
//   - handler returns undefined (or no handler) → nothing: the host answers through the `permission.requested` event;
//   - handler throws / rejects / returns something that is not a decision → `permission.answer deny{'Denied: handler error'}`
//     (SEC §4.1, D-18);
//   - `E_PERMISSION_INVALID{structuredAnswerRequired}` from the core keeps the request pending (§3.7 step 4), so the host can
//     still call answerQuestion()/approvePlan(); it is only logged here.
// Hook side: `hook.respond` → HookTransport.respond → `hook.responded{ok, clientGone}`; a held request whose forwarder goes
// away before we answered → `permission.hookClosed{client_gone|timeout}` (§3.7 step 7); one that goes away after we sent
// the answer but before it reached the forwarder → a second `hook.responded{ok:false, clientGone:true}` (ICR 0018). The
// response body is the typed object from the core; the transport JSON-stringifies it (SEC §2.6). A decision is bound to the
// request's own hookSeq, so it can never be applied to a mis-correlated tool (P-SEC-36).

import type { Command, PermissionDecision } from '../model/commands.js';
import { isCctError } from '../model/errors.js';
import type { PermissionKey } from '../model/ids.js';
import type { Intent } from '../model/intents.js';
import type { KernelPermissionHandler, PermissionAsk } from '../model/kernel.js';
import type { Logger } from '../model/logger.js';
import type { ObservationInput } from '../model/observation.js';
import type { SessionState } from '../model/state.js';
import type { Clock } from '../model/time.js';
import type { HookTransport, RawHookEvent } from '../platform/ports.js';
import type { ObservationSink } from './input-executor.js';

type BrokerIntent = Extract<
  Intent,
  { kind: 'host.askPermission' | 'host.cancelAsk' | 'hook.respond' | 'hook.armSelfTest' | 'hook.disarmSelfTest' }
>;

export const HANDLER_ERROR_MESSAGE = 'Denied: handler error';

export interface PermissionBrokerOptions {
  clock: Clock;
  hooks: HookTransport;
  emit: ObservationSink;
  /** Kernel dispatch (the core validates and answers). */
  dispatch: (cmd: Command) => Promise<unknown>;
  getState: () => Readonly<SessionState>;
  logger?: Logger;
}

export interface PermissionBroker {
  setHandler(h: KernelPermissionHandler | null): void;
  /** Feed every RawHookEvent (before or after normalization): held requests are watched for an early client close. */
  trackHookEvent(raw: RawHookEvent): void;
  /**
   * Release a held request that L1 did not turn into a `permission.requested` (rejected / malformed payload): no core record
   * carries its hookSeq, so no `hook.respond` would ever come. Answers `null` (Claude shows its native dialog, which the
   * screen adopts) and reports `hook.responded` (the core ignores a hookSeq without alias). No-op when not holdable (ICR 0026).
   */
  releaseUnclaimed(raw: RawHookEvent): void;
  /**
   * Execute one broker intent; never rejects. `host.askPermission` resolves as soon as the handler was *started* (user code
   * may never return, and a caller that executes intents in order must still be able to deliver the `host.cancelAsk` that
   * aborts it); use `idle()` to wait for running handlers. Every other intent resolves when its effect and observation are
   * done.
   */
  execute(intent: BrokerIntent): Promise<void>;
  /** Resolves when every handler run started so far has finished (and its answer, if any, was dispatched). */
  idle(): Promise<void>;
  /** Permission keys whose handler is still running. */
  activeAsks(): PermissionKey[];
  /** Abort every running handler and stop emitting. Held hooks are answered by HookTransport.close (lifecycle). */
  close(): void;
}

function isDecision(v: unknown): v is PermissionDecision {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const b = (v as { behavior?: unknown }).behavior;
  return b === 'allow' || b === 'deny';
}

/** Build the PermissionAsk a handler sees from the record in state (its own input, never a bound tool's, P-SEC-36). */
export function askFromState(
  s: Readonly<SessionState>,
  k: PermissionKey,
  deadlineAt: PermissionAsk['deadlineAt'],
  signal: AbortSignal,
): PermissionAsk | undefined {
  const rec = s.permissions[k];
  if (rec === undefined) return undefined;
  const tool = rec.tool !== undefined ? s.tools[rec.tool] : undefined;
  const agentKey = rec.agent ?? tool?.agent;
  const agent = agentKey !== undefined ? s.agents[agentKey] : undefined;
  const ask: PermissionAsk = {
    permissionKey: k,
    toolName: rec.toolName,
    input: rec.input,
    suggestions: rec.suggestions,
    needs: rec.needs,
    // §3.7 step 10, same rule as core decide/permissions.ts isBackground(): the request itself carries an agent (any
    // subagent request may be blocking-before-dialog), or its bound tool belongs to a background agent. The handler then
    // sees the same 10 s `backgroundTimeoutMs` deadline the core armed.
    background: rec.agent !== undefined || agent?.background === true,
    deadlineAt,
    signal,
  };
  const turnKey = tool?.turn;
  if (turnKey !== undefined) ask.turnKey = turnKey;
  if (rec.tool !== undefined) ask.toolKey = rec.tool;
  if (agentKey !== undefined) ask.agentKey = agentKey;
  return ask;
}

export function createPermissionBroker(o: PermissionBrokerOptions): PermissionBroker {
  const clock = o.clock;
  let handler: KernelPermissionHandler | null = null;
  let closed = false;
  const asks = new Map<PermissionKey, AbortController>();
  /** Handler runs not finished yet (for idle()). */
  const runs = new Set<Promise<void>>();
  /** hookSeq → transport/event of a held request still open on our side. */
  const held = new Map<number, { transport: 'http' | 'unix'; event: string; gone?: 'client_gone' | 'timeout' }>();
  const responded = new Set<number>();

  let lastNonce: string | undefined;

  const meta = (intentId?: BrokerIntent['id']): ObservationInput['meta'] =>
    intentId === undefined
      ? { at: clock.now(), wallAt: clock.wallNow(), source: 'self' }
      : { at: clock.now(), wallAt: clock.wallNow(), source: 'self', origin: { kind: 'self', intentId } };

  const answer = async (k: PermissionKey, decision: PermissionDecision): Promise<void> => {
    try {
      await o.dispatch({ type: 'permission.answer', permissionKey: k, decision, by: 'handler' });
    } catch (e) {
      if (isCctError(e, 'E_PERMISSION_INVALID') && e.details?.['reason'] === 'structuredAnswerRequired') {
        o.logger?.warn('permission-broker: handler gave a plain allow for a structured tool; request stays pending', { permissionKey: k });
        return;
      }
      o.logger?.warn('permission-broker: core refused the handler decision', {
        permissionKey: k,
        code: isCctError(e) ? e.code : 'unknown',
      });
    }
  };

  const runHandler = async (k: PermissionKey, deadlineAt: PermissionAsk['deadlineAt']): Promise<void> => {
    const h = handler;
    if (h === null) return; // the host answers via the permission.requested event
    asks.get(k)?.abort();
    const ctl = new AbortController();
    asks.set(k, ctl);
    const ask = askFromState(o.getState(), k, deadlineAt, ctl.signal);
    if (ask === undefined) {
      asks.delete(k);
      o.logger?.warn('permission-broker: askPermission for an unknown permission', { permissionKey: k });
      return;
    }
    let result: unknown;
    let failed = false;
    try {
      result = await h(ask);
    } catch (e) {
      failed = true;
      o.logger?.warn('permission-broker: handler threw', { permissionKey: k, error: e instanceof Error ? e.name : typeof e });
    }
    if (asks.get(k) === ctl) asks.delete(k);
    if (ctl.signal.aborted || closed) return; // cancelled (policy deadline, resolved elsewhere, close): drop the late result
    if (failed) return answer(k, { behavior: 'deny', message: HANDLER_ERROR_MESSAGE });
    if (result === undefined) return; // ask the host
    if (!isDecision(result)) {
      o.logger?.warn('permission-broker: handler returned an invalid decision', { permissionKey: k });
      return answer(k, { behavior: 'deny', message: HANDLER_ERROR_MESSAGE });
    }
    return answer(k, result);
  };

  const respond = (
    intent: Pick<Extract<BrokerIntent, { kind: 'hook.respond' }>, 'hookSeq' | 'body'> & { id?: BrokerIntent['id'] },
  ): void => {
    const seq = intent.hookSeq;
    const h = held.get(seq);
    let ok = false;
    try {
      ok = o.hooks.respond(seq, intent.body);
    } catch (e) {
      o.logger?.warn('permission-broker: hook respond threw', { hookSeq: seq, error: e instanceof Error ? e.name : typeof e });
    }
    responded.add(seq);
    held.delete(seq);
    o.emit({ kind: 'hook.responded', meta: meta(intent.id), p: { hookSeq: seq, ok, clientGone: h?.gone !== undefined } });
  };

  const arm = async (intentId: BrokerIntent['id'], nonce: string | null): Promise<void> => {
    try {
      await o.hooks.armSelfTestNonce(nonce);
    } catch (e) {
      o.logger?.warn('permission-broker: self-test arm/disarm failed', {
        armed: nonce !== null,
        error: e instanceof Error ? e.name : typeof e,
      });
      if (!closed)
        o.emit({
          kind: 'channel.health',
          meta: { at: clock.now(), wallAt: clock.wallNow(), source: 'channel', origin: { kind: 'self', intentId } },
          p: { channel: 'hooks', health: 'degraded', reason: nonce === null ? 'selfTestDisarmFailed' : 'selfTestArmFailed' },
        });
      return;
    }
    if (closed) return;
    o.emit({ kind: 'hook.selfTestArmed', meta: meta(intentId), p: { nonce: nonce ?? lastNonce ?? '', armed: nonce !== null } });
  };

  return {
    setHandler(h: KernelPermissionHandler | null): void {
      handler = h;
    },

    trackHookEvent(raw: RawHookEvent): void {
      if (!raw.holdable || raw.closed === undefined || closed) return;
      const seq = raw.hookSeq as number;
      const entry: { transport: 'http' | 'unix'; event: string; gone?: 'client_gone' | 'timeout' } = {
        transport: raw.transport,
        event: raw.event,
      };
      held.set(seq, entry);
      raw.closed.then(
        (reason) => {
          if (closed) return;
          if (responded.has(seq)) {
            // The forwarder went away before our answer reached it (its close crossed our respond): the answer was lost,
            // so correct the earlier `hook.responded{ok:true}`; the core moves an 'answered' record to dialogOnly + needsKeys.
            o.emit({ kind: 'hook.responded', meta: meta(), p: { hookSeq: raw.hookSeq, ok: false, clientGone: true } });
            return;
          }
          if (held.get(seq) !== entry) return;
          entry.gone = reason;
          o.emit({
            kind: 'permission.hookClosed',
            meta: {
              at: clock.now(),
              wallAt: clock.wallNow(),
              source: 'hook',
              origin: { kind: 'hook', transport: raw.transport, event: raw.event, hookSeq: raw.hookSeq },
            },
            p: { hookSeq: raw.hookSeq, reason },
          });
        },
        () => undefined,
      );
    },

    releaseUnclaimed(raw: RawHookEvent): void {
      if (!raw.holdable || closed || responded.has(raw.hookSeq)) return;
      o.logger?.warn('permission-broker: releasing a held hook request L1 did not accept', { hookSeq: raw.hookSeq, event: raw.event });
      respond({ hookSeq: raw.hookSeq, body: null });
    },

    async execute(intent: BrokerIntent): Promise<void> {
      if (closed) return;
      switch (intent.kind) {
        case 'host.askPermission': {
          const run = runHandler(intent.permissionKey, intent.deadlineAt).catch((e: unknown) => {
            o.logger?.error('permission-broker: handler run failed', { error: e instanceof Error ? e.name : typeof e });
          });
          runs.add(run);
          void run.finally(() => runs.delete(run));
          return;
        }
        case 'host.cancelAsk': {
          const ctl = asks.get(intent.permissionKey);
          if (ctl !== undefined) {
            asks.delete(intent.permissionKey);
            ctl.abort(new Error(`permission ask cancelled: ${intent.reason}`));
          }
          return;
        }
        case 'hook.respond':
          respond(intent);
          return;
        case 'hook.armSelfTest':
          lastNonce = intent.nonce;
          await arm(intent.id, intent.nonce);
          return;
        case 'hook.disarmSelfTest':
          await arm(intent.id, null);
          return;
      }
    },

    async idle(): Promise<void> {
      while (runs.size > 0) await Promise.all([...runs]);
    },

    activeAsks(): PermissionKey[] {
      return [...asks.keys()];
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const [, ctl] of asks) ctl.abort(new Error('session closed'));
      asks.clear();
      held.clear();
    },
  };
}
