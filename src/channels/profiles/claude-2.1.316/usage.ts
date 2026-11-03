// channels/profiles/claude-2.1.316/usage.ts — parser for the 2.1.316 `/usage` dialog text (ICR 0040).
// VERIFIED-LIVE 2026-11-03 (fixtures/screens/usage-dialog-2.1.316.txt):
//   Current session
//                                                      0% used
//   Resets 9:50pm (Etc/UTC)
//   Current week (all models)
//   █████████████████████████████████████████████████  98% used
//   Resets Nov 3 at 7:30pm (Etc/UTC)
//   Current week (Fable)
//   ████████████████████████████                       56% used
//   Resets Nov 3 at 7:29pm (Etc/UTC)
//   …
//   Usage credits are off · /usage-credits to turn them on

import type { UsageMeter, UsageReport } from '../../../model/usage.js';

const HEADING = /^\s*Current (session|week)(?: \(([^)]+)\))?\s*$/;
const USED = /(\d{1,3})% used\s*$/;
const RESETS = /^\s*Resets (.+?)\s*$/;
const CREDITS = /Usage credits are (on|off)\b/;
/** VERIFIED-LIVE: shown under the meters while per-model meters are still being fetched. */
const REFRESHING = /^\s*(Refreshing…|Loading usage)/m;
/** How many lines after a heading the "N% used" / "Resets …" lines may appear. */
const LOOKAHEAD = 3;

export interface UsageProfile {
  parse(text: string, readAt: number): UsageReport | undefined;
  /** Appearance criterion: at least one meter is shown and Claude is no longer refreshing the dialog. */
  ready(text: string): boolean;
}

/** Returns undefined when the text holds no usage meter (dialog still loading, wrong tab, or not a usage dialog). */
export function parseUsageDialog(text: string, readAt: number): UsageReport | undefined {
  const lines = text.split('\n');
  const meters: UsageMeter[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i] ?? '');
    if (h === null) continue;
    let usedPct: number | undefined;
    let resetsText: string | undefined;
    for (let j = i + 1; j <= i + LOOKAHEAD && j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (HEADING.test(l)) break;
      const u = usedPct === undefined ? USED.exec(l) : null;
      if (u !== null) usedPct = Number(u[1]);
      const r = resetsText === undefined ? RESETS.exec(l) : null;
      if (r !== null) resetsText = r[1];
    }
    if (usedPct === undefined || usedPct > 100) continue;
    const window = h[1] === 'session' ? 'session' : 'week';
    const label = (lines[i] ?? '').trim();
    meters.push({
      window,
      ...(h[2] !== undefined ? { scope: h[2] } : {}),
      label,
      usedPct,
      ...(resetsText !== undefined ? { resetsText } : {}),
    });
  }
  if (meters.length === 0) return undefined;
  const c = CREDITS.exec(text);
  return {
    meters,
    ...(c !== null ? { credits: c[1] === 'on' ? 'on' : 'off' } : {}),
    ...(REFRESHING.test(text) ? { partial: true as const } : {}),
    readAt,
  };
}

export function usageDialogReady(text: string): boolean {
  return !REFRESHING.test(text) && parseUsageDialog(text, 0) !== undefined;
}

export const usageProfile: UsageProfile = Object.freeze({ parse: parseUsageDialog, ready: usageDialogReady });
