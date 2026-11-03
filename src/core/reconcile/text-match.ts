// core/reconcile/text-match.ts — MessageDisplay (UiMessage) ↔ transcript text block (DESIGN.md §4.5.6, RC §5.7).
// Never joined by MessageDisplay `message_id` (a UI id that is not in the file, TF §5, P-REC-09): text only.

import type { MsgKey, TurnKey } from '../../model/ids.js';
import type { SessionState } from '../../model/state.js';

export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

/** The earliest unmatched UiMessage of the turn whose normalized text equals the block text or is a prefix of it. */
export function matchUiMessage(d: SessionState, turn: TurnKey | undefined, text: string): MsgKey | undefined {
  const want = normalizeText(text);
  if (want === '') return undefined;
  const t = turn === undefined ? undefined : d.turns[turn];
  const keys = t?.messages ?? [];
  for (const k of keys) {
    const m = d.messages[k];
    if (m?.uiMessageId === undefined || m.apiMessageId !== undefined) continue;
    const have = normalizeText(m.text);
    if (have === '') continue;
    if (have === want || want.startsWith(have) || have.startsWith(want)) return k;
  }
  return undefined;
}
