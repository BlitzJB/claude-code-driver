// core/reconcile/permission-binding.ts — PermissionRequest ↔ ToolRun binding (DESIGN.md §4.5.1, RC §5.1, PA §2.7).
// PermissionRequest carries no tool_use_id. Candidates are open `pending` ToolRuns (no timer ever moves a tool out of
// `pending`, rev 2 §10 A1) with the same tool name and canonical-equal input.

import type { AgentKey, ToolKey } from '../../model/ids.js';
import type { PermissionBinding, SessionState, ToolRun } from '../../model/state.js';
import { canonicalEq } from './canonical.js';

export interface BindRequest {
  toolName: string;
  input: unknown;
  /** agent of the request (only when the payload carried agent_id, P-REC-44) */
  agent?: AgentKey | undefined;
  agentCarried: boolean;
  /** the carried raw agent_id (the agent may not be known yet: then no main-thread tool may match) */
  agentId?: string | undefined;
  promptId?: string | undefined;
}

export interface BindResult {
  binding: PermissionBinding['kind'];
  tool?: ToolKey;
  /** auto-answer allowed by the binding alone (suspect/adopted are checked by the caller) */
  autoOk: boolean;
}

function candidates(d: SessionState, r: BindRequest): ToolRun[] {
  const out: ToolRun[] = [];
  for (const t of Object.values(d.tools)) {
    if (t.state.value !== 'pending' || t.permission !== undefined) continue;
    if (t.name !== r.toolName || !canonicalEq(t.input, r.input)) continue;
    if (!agentMatches(d, t, r)) continue;
    if (
      r.promptId !== undefined &&
      r.promptId !== '' &&
      t.promptIdAtPre !== undefined &&
      t.promptIdAtPre !== '' &&
      t.promptIdAtPre !== r.promptId
    )
      continue;
    if (t.turn !== undefined) {
      const turn = d.turns[t.turn];
      if (turn?.gen !== undefined && d.claude.currentGen !== undefined && turn.gen !== d.claude.currentGen) continue;
    }
    out.push(t);
  }
  return out.sort((a, b) => (b.preSeq ?? 0) - (a.preSeq ?? 0));
}

/**
 * Agent equality is required only when the request carries `agent_id` (P-REC-44). A carried id names the tool's agent
 * by its raw id, so a request from a not-yet-known (ghost) agent never matches a main-thread tool.
 */
function agentMatches(
  d: SessionState,
  t: ToolRun,
  r: { agent?: AgentKey | undefined; agentCarried: boolean; agentId?: string | undefined },
): boolean {
  if (!r.agentCarried) return true;
  if (t.agent === undefined) return false;
  if (r.agent !== undefined && t.agent === r.agent) return true;
  return r.agentId !== undefined && d.agents[t.agent]?.agentId === r.agentId;
}

function agentIsAutoSafe(d: SessionState, k: AgentKey | undefined): boolean {
  if (k === undefined) return true;
  const a = d.agents[k];
  return a !== undefined && a.kind !== 'internal' && a.kind !== 'teammate';
}

export function bindPermission(d: SessionState, r: BindRequest): BindResult {
  const cs = candidates(d, r);
  if (cs.length === 0) return { binding: 'unbound', autoOk: false };
  const agents = new Set(cs.map((c) => c.agent ?? ''));
  if (agents.size === 1) {
    const first = cs[0];
    if (cs.length === 1 && first !== undefined) {
      // The last free candidate is not "unique" while an equivalent sibling holds only an unconfirmed FIFO guess: the guess
      // may have been wrong, so this binding is just as uncertain (K-12; the decision is the same either way). ICR 0016.
      const guessedSibling = Object.values(d.tools).some((t) => {
        if (t.key === first.key || t.permission === undefined || t.name !== first.name) return false;
        const p = d.permissions[t.permission];
        return p?.binding.kind === 'ambiguous-equivalent' && !p.binding.confirmed && canonicalEq(t.input, first.input);
      });
      return { binding: guessedSibling ? 'ambiguous-equivalent' : 'unique', tool: first.key, autoOk: agentIsAutoSafe(d, first.agent) };
    }
    // Several, all equivalent: bind the oldest unbound (FIFO); the decision is the same for each (§4.5.1).
    const oldest = cs[cs.length - 1];
    if (oldest === undefined) return { binding: 'unbound', autoOk: false };
    return { binding: 'ambiguous-equivalent', tool: oldest.key, autoOk: agentIsAutoSafe(d, oldest.agent) };
  }
  const main = cs.filter((c) => c.agent === undefined);
  const only = main.length === 1 ? main[0] : undefined;
  if (only !== undefined) return { binding: 'ambiguous-agents', tool: only.key, autoOk: false };
  return { binding: 'ambiguous-agents', autoOk: false };
}

/** A late `tool.pre`/transcript tool_use that matches an unbound permission (§4.5.1 permBindLate). */
export function lateBindMatches(
  d: SessionState,
  tool: ToolRun,
  req: { toolName: string; input: unknown; agent?: AgentKey | undefined; agentCarried: boolean; agentId?: string | undefined },
): boolean {
  if (tool.name !== req.toolName || !canonicalEq(tool.input, req.input)) return false;
  return agentMatches(d, tool, req);
}
