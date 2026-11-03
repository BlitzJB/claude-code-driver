// model/debug.ts — DebugRecord (trace v1 = replay fixture format) and Diagnostic (DESIGN.md §6.6, §2.9, D-32).

import type { Command } from './commands.js';
import type { CoreInit } from './config.js';
import type { DomainEvent } from './events.js';
import type { Intent } from './intents.js';
import type { JsonValue } from './json.js';
import type { Observation } from './observation.js';
import type { MonoMs } from './time.js';

export interface Diagnostic {
  code: string;
  at: MonoMs;
  detail: JsonValue;
}

export type DebugRecord =
  | {
      r: 'header';
      format: 'ccd-trace';
      v: 1;
      lib: string;
      claude: '2.1.316';
      tmux: string;
      node: string;
      platform: string;
      startedWall: number;
      tz: string;
      coreInit: CoreInit /* incl. CoreConfig, so replay is exact */;
      profile: '2.1.316';
      redaction: 'none' | 'meta' | 'full';
      hookTransport: 'http' | 'unix';
    }
  | {
      r: 'raw';
      i: number;
      ch: 'hook' | 'transcript' | 'screen' | 'network' | 'registry' | 'process' | 'input';
      at: number;
      wallAt: number;
      // §6.6: RawHookEvent | TailEvent | { capture: Capture } | TunnelRecord | unknown. Those are L0 types (platform/ports.ts) and model
      // imports nothing outside model, so the union is spelled as its value (`X | unknown` is `unknown`). Payload text per redaction policy.
      data: unknown;
    }
  | { r: 'obs'; seq: number; rawRef?: number; obs: Observation }
  | { r: 'cmd'; cmdId: number; at: number; wallAt: number; cmd: Command }
  | { r: 'step'; inSeq: number; events: number[]; intents: Intent[]; durUs: number }
  | { r: 'event'; e: DomainEvent }
  | { r: 'effect'; intentId: number; at: number; durMs: number; ok: boolean; error?: string }
  | { r: 'diag'; at: number; code: string; detail: JsonValue }
  | { r: 'drop'; count: number; reason: 'backpressure' };
