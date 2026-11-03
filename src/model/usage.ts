// model/usage.ts — subscription usage report read from Claude's `/usage` dialog (ICR 0040). Types only.

/** One usage meter from the `/usage` dialog ("Current session", "Current week (all models)", …). */
export interface UsageMeter {
  /** 'session' = the rolling session window; 'week' = a weekly window (optionally per model family). */
  readonly window: 'session' | 'week';
  /** Model scope for weekly meters as Claude prints it ("all models", "Fable", …); absent for the session meter. */
  readonly scope?: string;
  /** The heading exactly as shown, e.g. "Current week (all models)". */
  readonly label: string;
  /** 0–100 as shown ("98% used"). */
  readonly usedPct: number;
  /** The reset text exactly as shown after "Resets ", e.g. "Nov 3 at 7:30pm (Etc/UTC)". */
  readonly resetsText?: string;
}

export interface UsageReport {
  readonly meters: readonly UsageMeter[];
  /** "Usage credits are off/on" when the dialog shows it. */
  readonly credits?: 'on' | 'off';
  /** true when Claude was still refreshing the dialog ("Refreshing…"): some meters may be missing or stale. */
  readonly partial?: true;
  /** Wall-clock ms when the dialog was read. */
  readonly readAt: number;
}
