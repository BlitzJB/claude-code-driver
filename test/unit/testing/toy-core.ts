// A deliberately tiny, deterministic stand-in for the core (structural CoreApi), used only to test the testing kit's DSL and
// replay plumbing. It counts prompts, arms one mono deadline 1 s after each prompt and publishes events for both.
import type { CoreInit } from '../../../src/model/config.js';
import type { DomainEvent } from '../../../src/model/events.js';
import type { EventSeq, IntentId, InputJobKey, TurnKey } from '../../../src/model/ids.js';
import type { Intent } from '../../../src/model/intents.js';
import type { JsonValue } from '../../../src/model/json.js';
import type { SessionState } from '../../../src/model/state.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import type { CoreApi, CoreInput, CoreStepResult } from '../../../src/testing/scenario.js';

export interface ToyState {
  domain: SessionState;
  now: number;
  wall: number;
  prompts: number;
  deadline?: number;
  seq: number;
  intent: number;
}

const ev = (s: ToyState, type: 'turn.queued' | 'warning', at: number, wall: number): DomainEvent =>
  type === 'turn.queued'
    ? {
        v: 1,
        seq: ++s.seq as EventSeq,
        type,
        at: at as MonoMs,
        wallAt: wall as WallMs,
        sessionKey: s.domain.sessionKey,
        turnKey: `t${s.prompts}` as TurnKey,
        provenance: { confirmed: true, sources: ['hook'] },
        causedBy: [],
        payload: { prompt: 'x', origin: 'library' },
      }
    : {
        v: 1,
        seq: ++s.seq as EventSeq,
        type,
        at: at as MonoMs,
        wallAt: wall as WallMs,
        sessionKey: s.domain.sessionKey,
        provenance: { confirmed: true, sources: ['clock'] },
        causedBy: [],
        payload: { code: 'E_WAIT_TIMEOUT', message: 'deadline' },
      };

export const toyCore: Required<CoreApi<ToyState>> = {
  initialCore(init: CoreInit): ToyState {
    return {
      domain: { v: 1, sessionKey: init.sessionKey, lifecycle: 'ready' } as unknown as SessionState,
      now: init.startedAt,
      wall: init.wallAt,
      prompts: 0,
      seq: 0,
      intent: 0,
    };
  },
  step(core: ToyState, input: CoreInput): CoreStepResult<ToyState> {
    const s: ToyState = structuredClone(core);
    const at = input.type === 'obs' ? input.obs.meta.at : input.at;
    const wall = input.type === 'obs' ? input.obs.meta.wallAt : input.wallAt;
    s.now = Math.max(s.now, at);
    s.wall = Math.max(s.wall, wall);
    const events: DomainEvent[] = [];
    const intents: Intent[] = [];
    if (s.deadline !== undefined && s.deadline <= s.now) {
      delete s.deadline;
      events.push(ev(s, 'warning', s.now, s.wall));
    }
    if (input.type === 'obs' && input.obs.kind === 'prompt.submitted') {
      s.prompts++;
      s.deadline = s.now + 1000;
      events.push(ev(s, 'turn.queued', s.now, s.wall));
      intents.push({
        kind: 'input',
        id: ++s.intent as IntentId,
        job: 'j1' as InputJobKey,
        step: 0,
        primitive: { kind: 'key', key: 'Enter', gapAfterMs: 0 },
      });
    }
    return { core: s, events, intents, diagnostics: [] };
  },
  nextDeadline(core: ToyState) {
    return core.deadline === undefined ? {} : { atMono: core.deadline as MonoMs };
  },
  serializeCore(c: ToyState): JsonValue {
    return JSON.parse(JSON.stringify(c)) as JsonValue;
  },
  deserializeCore(j: JsonValue): ToyState {
    return j as unknown as ToyState;
  },
};
