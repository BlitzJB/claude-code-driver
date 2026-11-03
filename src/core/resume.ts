// core/resume.ts — the core a suspended session resumes into (ICR 0041). Pure.
//
// The resumed core is a fresh one (initialCore) for everything that belongs to a Claude process: lifecycle, channels,
// claims, deadlines, input jobs, gates, auth, self-test, exit, reconciliation state. It keeps what belongs to the session:
//   - every counter, so new library keys (t13, u41, p6, …) and event sequence numbers continue without collisions;
//   - the conversation history (turns, tools, agents, permissions, model calls, messages, generations, token totals);
//   - the Claude identity the resume continues (session id, generation, transcript path, model, permission mode).
// The transcript tail restarts at the checkpoint taken at suspend, so no history is replayed into the new reconciliation
// state; a stale checkpoint falls back to a replay from the beginning, which the core marks as history.

import type { SessionState } from '../model/state.js';
import { initialCore } from './init.js';
import type { CoreInit } from './init.js';
import type { CoreState } from './types.js';

export function resumeCore(prev: CoreState, init: CoreInit): CoreState {
  const fresh = initialCore(init);
  const p = prev.domain;
  const claude: SessionState['claude'] = { ...fresh.domain.claude };
  if (p.claude.sessionId !== undefined) claude.sessionId = p.claude.sessionId;
  if (p.claude.currentGen !== undefined) claude.currentGen = p.claude.currentGen;
  if (p.claude.transcriptPath !== undefined) claude.transcriptPath = p.claude.transcriptPath;
  if (p.claude.model !== undefined) claude.model = p.claude.model;
  if (p.claude.permissionMode !== undefined) claude.permissionMode = p.claude.permissionMode;
  const usage: SessionState['usage'] = { tokensTotal: p.usage.tokensTotal };
  if (p.usage.contextUsedPct !== undefined) usage.contextUsedPct = p.usage.contextUsedPct;
  const domain: SessionState = {
    ...fresh.domain,
    claude,
    generations: p.generations,
    turns: p.turns,
    turnOrder: p.turnOrder,
    tools: p.tools,
    agents: p.agents,
    permissions: p.permissions,
    calls: p.calls,
    messages: p.messages,
    usage,
    lastEventSeq: p.lastEventSeq,
  };
  return { ...fresh, domain, counters: { ...prev.counters } };
}
