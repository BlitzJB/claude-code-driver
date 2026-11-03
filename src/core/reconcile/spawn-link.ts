// core/reconcile/spawn-link.ts — SubagentStart ↔ spawning Agent ToolRun (DESIGN.md §4.5.2, RC §5.3).

import type { ToolKey } from '../../model/ids.js';
import type { SessionState, ToolRun } from '../../model/state.js';
import { isToolTerminal } from '../lattice.js';
import { strField } from './canonical.js';

/** Tool names that spawn subagents (`Task` is the pre-2.1 name). */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

function typeMatches(t: ToolRun, agentType: string): boolean {
  const st = strField(t.input, 'subagent_type');
  if (st === undefined || st === '') return agentType === 'general-purpose' || agentType === '';
  return st === agentType;
}

/** Open Agent ToolRuns with no linked child whose `input.subagent_type` matches, most recent first. */
function spawnCandidates(d: SessionState, agentType: string): ToolRun[] {
  return Object.values(d.tools)
    .filter((t) => SPAWN_TOOLS.has(t.name) && t.spawned === undefined && !isToolTerminal(t.state.value) && typeMatches(t, agentType))
    .sort((a, b) => (b.preSeq ?? 0) - (a.preSeq ?? 0) || b.startedAt - a.startedAt);
}

export function pickSpawnTool(d: SessionState, agentType: string): ToolKey | undefined {
  return spawnCandidates(d, agentType)[0]?.key;
}
