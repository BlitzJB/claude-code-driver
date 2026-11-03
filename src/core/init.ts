// core/init.ts — initialCore(init) (DESIGN.md §2.9). CoreInit lives in model/config.ts (ICR 0001 item 1).

import type { CoreInit } from '../model/config.js';
import type { EventSeq } from '../model/ids.js';
import type { SessionState } from '../model/state.js';
import { initialInputPolicy } from './input-policy/jobs.js';
import { initialCounters } from './keys.js';
import type { CoreState, ReconState } from './types.js';

export type { CoreInit } from '../model/config.js';

export function initialDomain(init: CoreInit): SessionState {
  return {
    v: 1,
    sessionKey: init.sessionKey,
    lifecycle: 'preflight',
    claude: { version: init.claudeVersion },
    generations: {},
    status: { kind: 'starting', phase: 'launching', since: init.startedAt },
    turns: {},
    turnOrder: [],
    libraryQueue: [],
    tools: {},
    agents: {},
    permissions: {},
    calls: {},
    messages: {},
    bgTasks: {},
    pendingInputs: {},
    usage: { tokensTotal: { inputTokens: 0, outputTokens: 0 } },
    auth: { state: 'ok', polling: false },
    channels: {
      hooks: { health: 'up', reasons: [] },
      transcript: { health: 'up', reasons: [] },
      screen: { health: 'up', reasons: [] },
      network: { health: init.config.channels.network ? 'up' : 'off', reasons: [] },
    },
    inputBlocked: { permission: false, dialog: false, startup: true, copyMode: false, input: false },
    selfTest: { state: 'idle' },
    lastEventSeq: 0 as EventSeq,
  };
}

function initialRecon(init: CoreInit): ReconState {
  return {
    aliases: {
      sessionId: {},
      promptId: {},
      toolUseId: {},
      agentId: {},
      apiMsgId: {},
      uiMsgId: {},
      requestRef: {},
      hookSeq: {},
      entryUuid: {},
    },
    redirects: {},
    claims: {},
    deadlines: {},
    tunnels: {},
    seenUuids: { ring: [], set: {} },
    usageCounted: {},
    conflicts: {},
    anomalies: [],
    launch: { sessionId: init.initialClaudeSessionId, resume: init.resume, cwdRealpath: init.cwdRealpath, startedAt: init.startedAt },
    recentNonces: [],
    transport: {},
    pendingRecorded: {},
    queuedOps: 0,
    permTurn: {},
    permAgentId: {},
    asks: {},
    uiChunks: {},
    drainPending: [],
    pendingInputSeq: 0,
    drained: {},
    stopSeenInGen: {},
    msgCall: {},
    txWalls: {},
  };
}

export function initialCore(init: CoreInit): CoreState {
  return {
    domain: initialDomain(init),
    recon: initialRecon(init),
    input: initialInputPolicy(),
    counters: initialCounters(),
    now: init.startedAt,
    wallNow: init.wallAt,
    config: init.config,
  };
}
