// channels/screen/debounce.ts — consecutive-identical drop + frozen-UI detector (DESIGN.md §2.8, D-41, D-42; rev 2 §10 G26).
// L1 never waits for stability (the core claim machine is the single owner of screen stability): a frame is emitted iff its
// `frameHash` differs from the LAST EMITTED one, so A→B→A reaches the core as three frames (K-43). Torn frames are emitted
// with `torn:true`, never held back (P-SCREEN-10, P-TMUX-29: the core's 2-frame claim rule does the debouncing).
// Extras (additive to §2.8): the editor-phase fallback of ICR 0001 item 3b, the frozen detector (P-SCREEN-27), a capture-level
// hash short-circuit (`createScreenChannel`, P-SCREEN-23) and bounded unknown-line telemetry (P-SCREEN-24).
// No timers, no I/O: time comes from `Capture.at`.

import type { ScreenFacts } from '../../model/screen-facts.js';
import type { MonoMs, WallMs } from '../../model/time.js';
import type { Capture } from '../../platform/ports.js';
import type { ClaudeProfile } from '../profiles/index.js';
import { classifyFrame } from './classify.js';
import type { ScreenSnapshot } from './classify.js';
import { hashText } from './normalize-text.js';
import { toFacts } from './to-facts.js';

export interface FrozenInfo {
  /** Mono time of the first capture of the unchanged frame. */
  since: MonoMs;
  /** How long the spinner frame has been unchanged, as of the last pushed capture. */
  forMs: number;
  frameHash: string;
}

export interface ScreenTelemetry {
  pushed: number;
  emitted: number;
  dropped: number;
  /** Distinct status candidates classified `none` while the footer was busy (drift signal), with counts; ≤ 64 entries. */
  unknownStatus: readonly (readonly [string, number])[];
  /** Distinct `unknownModal` bodies (first line … last line), with counts; ≤ 64 entries. */
  unknownModal: readonly (readonly [string, number])[];
}

export interface ScreenDebouncer {
  /** Emits iff frameHash differs from the last emitted (D-41). `tz` is the IANA zone for reset-time parsing. */
  push(c: Capture, snap: ScreenSnapshot, tz: string): ScreenFacts | undefined;
  /** Frozen-UI diagnostic (P-SCREEN-27): the last emitted frame is a spinner and nothing changed for ≥ frozenAfterMs. */
  frozen(): FrozenInfo | undefined;
  /** Last emitted facts (undefined before the first frame). */
  last(): ScreenFacts | undefined;
  telemetry(): ScreenTelemetry;
}

const TELEMETRY_CAP = 64;

function bump(map: Map<string, number>, key: string): void {
  const n = map.get(key);
  if (n !== undefined) map.set(key, n + 1);
  else if (map.size < TELEMETRY_CAP) map.set(key, 1);
}

/**
 * ICR 0001 item 3b: an alternate screen that directly follows a `main` frame (blank, or with the `ctrl+g to edit` hint) is the
 * editor, and stays the editor while the alternate screen lasts. An alternate screen that draws Claude's own input box is the
 * fullscreen renderer and is never rescued (P-SCREEN-20); once a frame was `unsupportedRenderer` the chain is broken.
 */
function editorFallback(snap: ScreenSnapshot, prev: ScreenSnapshot | undefined): ScreenSnapshot {
  if (snap.kind !== 'unsupportedRenderer' || !snap.altScreen || snap.rendererUi === true || prev === undefined) return snap;
  const blank = snap.unknown.length === 0;
  const fromMain = prev.kind === 'main' && (blank || prev.editorHint);
  const stillEditor = prev.kind === 'editorOpen';
  if (!fromMain && !stillEditor) return snap;
  return { ...snap, kind: 'editorOpen', frameHash: hashText(`${snap.frameHash}\u0001editorOpen`) };
}

export function createScreenDebouncer(o: { frozenAfterMs: number; profile: ClaudeProfile }): ScreenDebouncer {
  let lastEmitted: ScreenFacts | undefined;
  let lastSnap: ScreenSnapshot | undefined; // last snapshot seen (emitted or not, after the fallback), for the editor fallback
  let changedAt: MonoMs | undefined;
  let lastAt: MonoMs | undefined;
  let pushed = 0;
  let emitted = 0;
  const unknownStatus = new Map<string, number>();
  const unknownModal = new Map<string, number>();

  return {
    push(c: Capture, snap: ScreenSnapshot, tz: string): ScreenFacts | undefined {
      pushed++;
      lastAt = c.at;
      const s = editorFallback(snap, lastSnap);
      lastSnap = s;
      if (s.frameHash === lastEmitted?.frameHash) return undefined;
      // telemetry only for frames that changed (one count per distinct appearance)
      if (s.kind === 'main' && s.status?.kind === 'none' && s.footer?.busy === true && s.status.raw !== '')
        bump(unknownStatus, s.status.raw);
      if (s.kind === 'unknownModal' && s.unknown.length > 0)
        bump(
          unknownModal,
          s.unknown.length === 1 ? (s.unknown[0] ?? '') : `${s.unknown[0] ?? ''} … ${s.unknown[s.unknown.length - 1] ?? ''}`,
        );
      const facts = toFacts(s, o.profile, tz);
      lastEmitted = facts;
      changedAt = c.at;
      emitted++;
      return facts;
    },
    frozen(): FrozenInfo | undefined {
      if (lastEmitted?.surface !== 'main' || lastEmitted.status?.kind !== 'spinner') return undefined;
      if (changedAt === undefined || lastAt === undefined) return undefined;
      const forMs = lastAt - changedAt;
      return forMs >= o.frozenAfterMs ? { since: changedAt, forMs, frameHash: lastEmitted.frameHash } : undefined;
    },
    last(): ScreenFacts | undefined {
      return lastEmitted;
    },
    telemetry(): ScreenTelemetry {
      return { pushed, emitted, dropped: pushed - emitted, unknownStatus: [...unknownStatus], unknownModal: [...unknownModal] };
    },
  };
}

/** Per-capture context for the channel helper (all from L3: the poller knows the wall time, the zone and the job phase). */
export interface ScreenChannelContext {
  wallAt: WallMs;
  tz: string;
  /** An `editorStage`/`awaitEditorConsumed` phase is active (ICR 0001 item 3b). */
  editorPhase?: boolean;
}

export interface ScreenChannel extends Omit<ScreenDebouncer, 'push'> {
  /**
   * Classify + debounce one capture. An identical raw capture (same `Capture.hash`, pane status and editor phase) skips the
   * classifier entirely (hash short-circuit, P-SCREEN-23) but still advances the frozen detector.
   */
  push(c: Capture, ctx: ScreenChannelContext): ScreenFacts | undefined;
}

export function createScreenChannel(o: { frozenAfterMs: number; profile: ClaudeProfile }): ScreenChannel {
  const d = createScreenDebouncer(o);
  let lastKey: string | undefined;
  let lastSnap: ScreenSnapshot | undefined;
  return {
    push(c: Capture, ctx: ScreenChannelContext): ScreenFacts | undefined {
      const st = c.status;
      const key = [c.hash, st.alternateOn, st.inMode, st.dead, st.cols, st.rows, ctx.editorPhase === true].join('|');
      const snap =
        key === lastKey && lastSnap !== undefined
          ? { ...lastSnap, at: c.at, wallAt: ctx.wallAt }
          : classifyFrame(c.lines, st, o.profile, {
              at: c.at,
              wallAt: ctx.wallAt,
              ...(ctx.editorPhase !== undefined ? { editorPhase: ctx.editorPhase } : {}),
            });
      lastKey = key;
      lastSnap = snap;
      return d.push(c, snap, ctx.tz);
    },
    frozen: () => d.frozen(),
    last: () => d.last(),
    telemetry: () => d.telemetry(),
  };
}
