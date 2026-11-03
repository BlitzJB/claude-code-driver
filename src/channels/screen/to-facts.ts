// channels/screen/to-facts.ts — ScreenSnapshot → profile-free ScreenFacts (DESIGN.md §2.3, §2.8, §3.9; rev 2 §10 G27).
// Pure. Durations become milliseconds, token counts numbers, the footer mode label a PermissionMode, the usage-limit line a
// limit name + reset instant (`parseResetText(text, wallAt, tz)` of the profile; `tz` is passed in by L3, P-REV-35). The error
// class of a retry banner is a hint taken from the untruncated message prefix only (P-SCREEN-04): the authoritative class comes
// from the network channel, the transcript or StopFailure.

import type { ScreenFacts } from '../../model/screen-facts.js';
import type { WallMs } from '../../model/time.js';
import type { ClaudeProfile } from '../profiles/index.js';
import type { ScreenExtras } from '../profiles/claude-2.1.316/screen.js';
import { errorsExtrasFor, screenExtrasFor } from './classify.js';
import type { ScreenSnapshot, StatusLine } from './classify.js';

const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({ d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 });

/** `1m 26s` → 86000, `0.5s` → 500, `2h` → 7200000; undefined when unparseable. */
export function durationToMs(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const parts = text.trim().split(/\s+/u);
  let total = 0;
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)([dhms])$/u.exec(p);
    if (m === null) return undefined;
    total += Number(m[1]) * (UNIT_MS[m[2] ?? ''] ?? NaN);
  }
  return Number.isFinite(total) && parts.length > 0 ? Math.round(total) : undefined;
}

/** `88` → 88, `1.2k` → 1200. */
export function tokenCount(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(k?)$/u.exec(text);
  if (m === null) return undefined;
  return Math.round(Number(m[1]) * (m[2] === 'k' ? 1000 : 1));
}

type ErrorHint = NonNullable<NonNullable<ScreenFacts['status']>['errorHint']>;

/** Error-class hint from the untruncated prefix of a retry message (the last, possibly cut, word is dropped). */
export function errorHintOf(msg: string, truncated: boolean, x: ScreenExtras): ErrorHint {
  const prefix = truncated ? msg.replace(/\S*…$/u, '') : msg;
  return x.errorHints.find((h) => h.re.test(prefix))?.hint ?? 'unknown';
}

/** Drops `undefined` and `NaN` members, so optional fields are absent rather than undefined (exactOptionalPropertyTypes). */
const compact = <T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, val]) => val !== undefined && !(typeof val === 'number' && Number.isNaN(val)))) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

function statusFacts(st: StatusLine, wallAt: WallMs, tz: string, profile: ClaudeProfile): NonNullable<ScreenFacts['status']> {
  const x = screenExtrasFor(profile);
  switch (st.kind) {
    case 'spinner': {
      const count = st.tokens !== undefined ? tokenCount(st.tokens) : undefined;
      return {
        kind: 'spinner',
        ...compact({
          elapsedMs: durationToMs(st.elapsed),
          tokens: count !== undefined ? { dir: st.dir ?? 'down', count } : undefined,
          thinkingLabel: st.thinking,
          hookWait: st.hooks !== undefined ? { ...st.hooks } : undefined,
        }),
      };
    }
    case 'retrying': {
      const resetsAtWall = st.reset !== undefined ? profile.errors.parseResetText(st.reset, wallAt, tz) : undefined;
      return {
        kind: 'retrying',
        ...compact({
          attempt: st.attempt,
          max: st.max,
          retryInMs: durationToMs(st.retryIn),
          truncatedMsg: st.truncated,
          errorHint: st.reset !== undefined ? ('rateLimit' as const) : errorHintOf(st.msg, st.truncated, x),
          resetText: st.reset,
          resetsAtWall,
        }),
      };
    }
    case 'retryingUnparsed': {
      const g = x.attemptSuffix.exec(st.raw)?.groups;
      return {
        kind: 'retryingUnparsed',
        ...compact({ attempt: g ? Number(g['n']) : undefined, max: g ? Number(g['max']) : undefined }),
      };
    }
    case 'stalled':
      return { kind: 'stalled', ...compact({ retryInMs: durationToMs(st.retryIn) }) };
    case 'noResponse':
      return { kind: 'noResponse', ...compact({ attempt: st.attempt, max: st.max, retryInMs: durationToMs(st.upTo) }) };
    case 'lowPriority':
    case 'autoModeUnavailable':
      return { kind: st.kind, ...compact({ attempt: st.attempt, max: st.max, retryInMs: durationToMs(st.nextTryIn) }) };
    case 'done':
      return { kind: 'done', ...compact({ doneDurationMs: durationToMs(st.dur) }) };
    case 'waitingBackground': {
      const agents = x.waitingAgents.exec(st.what)?.groups?.['n'];
      const workflows = x.waitingWorkflows.exec(st.what)?.groups?.['n'];
      return {
        kind: 'waitingBackground',
        waitingBackground: compact({
          agents: agents !== undefined ? Number(agents) : undefined,
          workflows: workflows !== undefined ? Number(workflows) : undefined,
        }),
      };
    }
    case 'interrupted':
      return { kind: 'interrupted' };
    case 'none':
      return { kind: 'none' };
    default: {
      const never: never = st;
      return never;
    }
  }
}

function usageLimitFacts(snap: ScreenSnapshot, tz: string, profile: ClaudeProfile): ScreenFacts['usageLimit'] {
  const ex = errorsExtrasFor(profile);
  const line = snap.usageLimitLine ?? snap.autoContinueLine;
  if (line === undefined) return undefined;
  const label = snap.usageLimitLine !== undefined ? ex.limitLine.exec(snap.usageLimitLine)?.groups?.['label'] : undefined;
  let limitName: string | undefined;
  if (label !== undefined) {
    const byLabel = Object.entries(profile.errors.limitNames).find(([, l]) => l === label)?.[0];
    limitName = byLabel ?? ex.legacyLimitNames[label] ?? label;
  }
  const resetsText =
    ex.resetIn.exec(snap.usageLimitLine ?? '')?.groups?.['reset'] ?? ex.resetIn.exec(snap.autoContinueLine ?? '')?.groups?.['reset'];
  const resetsAtWall = resetsText !== undefined ? profile.errors.parseResetText(resetsText, snap.wallAt, tz) : undefined;
  const ac = snap.autoContinueLine !== undefined ? ex.autoContinue.find((a) => a.re.test(snap.autoContinueLine ?? ''))?.state : undefined;
  return {
    line,
    ...compact({ limitName, resetsText: resetsText?.trim(), resetsAtWall }),
    autoContinue: ac ?? 'none',
  };
}

/** Snapshot → facts. `tz` is the IANA zone L3 recorded in the trace header (`env.timeZone()`). */
export function toFacts(snap: ScreenSnapshot, profile: ClaudeProfile, tz: string): ScreenFacts {
  const ex = errorsExtrasFor(profile);
  const x = screenExtrasFor(profile);
  const facts: ScreenFacts = {
    surface: snap.kind,
    torn: snap.torn,
    altScreen: snap.altScreen,
    inCopyMode: snap.inCopyMode,
    paneWidth: snap.paneWidth,
    paneHeight: snap.paneHeight,
    frameHash: snap.frameHash,
    interruptedBanner: snap.interruptedBanner,
    hookErrorLines: snap.hookErrorLines,
    agentPanelRows: snap.agentPanelRows,
  };
  if (snap.status !== undefined && snap.kind === 'main') facts.status = statusFacts(snap.status, snap.wallAt, tz, profile);
  if (snap.footer !== undefined) {
    const mode = snap.footer.mode !== null ? profile.screen.footer.modeLabels[snap.footer.mode] : undefined;
    // A footer with no mode label is the `default` mode when it is a plain hint list (`? for shortcuts`, …), SP §5.
    const hintsOnly =
      snap.footer.mode === null &&
      snap.footer.raw !== '' &&
      snap.footer.raw.split(x.footerHintSeparator).every((h) => x.footerHints.some((re) => re.test(h)));
    facts.footer = {
      busy: snap.footer.busy,
      modeLabel: snap.footer.mode,
      ...(mode !== undefined ? { mode } : hintsOnly ? { mode: 'default' as const } : {}),
      pasting: snap.footer.pasting,
      ctrlCExitArmed: snap.footer.ctrlCExitArmed,
      hints: [...snap.footer.hints],
    };
  }
  if (snap.input !== undefined) {
    const { text, placeholderLikely, pastedPlaceholder, notices } = snap.input;
    facts.composer = {
      text,
      // "empty" = no typed text is believed present: nothing at all, or only a placeholder/ghost (P-SCREEN-07, P-INPUT-15).
      empty: text.trim() === '' || (placeholderLikely && !pastedPlaceholder),
      placeholderLikely,
      pastedPlaceholder,
      notices: [...notices],
    };
  }
  if (snap.dialog !== undefined) {
    const d = snap.dialog;
    facts.dialog = {
      kind: d.kind,
      ...(d.gate !== undefined ? { gate: d.gate } : {}),
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.question !== undefined ? { question: d.question } : {}),
      options: d.options.map((o) => ({ ...o })),
      ...(d.footer !== undefined ? { footer: d.footer } : {}),
    };
  }
  const ul = usageLimitFacts(snap, tz, profile);
  if (ul !== undefined) facts.usageLimit = ul;
  if (snap.authLine !== undefined) {
    const kind = ex.authKinds.find((a) => a.re.test(snap.authLine ?? ''))?.kind ?? 'other';
    facts.auth = { kind, line: snap.authLine };
  }
  if (snap.apiErrorLine !== undefined) facts.apiErrorLine = snap.apiErrorLine;
  if (snap.versionTooOld) facts.versionTooOld = true;
  if (snap.version !== undefined) facts.headerVersion = snap.version;
  return facts;
}
