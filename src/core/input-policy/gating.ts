// core/input-policy/gating.ts — inputBlocked computation and the surface-level start gate (DESIGN.md §3.6 Gate, §4.13).

import type { SessionState } from '../../model/state.js';
import type { MonoMs } from '../../model/time.js';
import { permissionHeld } from '../ctx.js';
import type { CoreState } from '../types.js';

const BLOCKING_SURFACES = new Set([
  'permissionDialog',
  'trustDialog',
  'usageLimitMenu',
  'resumeDialog',
  'startupGate',
  'modal',
  'unknownModal',
  'exited',
  'unsupportedRenderer',
]);

/** inputBlocked (§2.6): permission = a hook-held request; dialog = a dialog surface on the last (non-torn) frame. */
export function computeInputBlocked(c: CoreState): SessionState['inputBlocked'] {
  const d = c.domain;
  const f = c.recon.lastFrame;
  const dialog = f !== undefined && !f.torn && (BLOCKING_SURFACES.has(f.surface) || (f.dialog !== undefined && f.surface !== 'main'));
  const startup = d.lifecycle === 'preflight' || d.lifecycle === 'launching' || d.lifecycle === 'awaitingReady' || d.lifecycle === 'gated';
  const r: SessionState['inputBlocked'] = {
    permission: permissionHeld(d),
    dialog,
    startup,
    copyMode: f?.inCopyMode === true,
    input: Object.keys(d.pendingInputs).length > 0,
  };
  if (
    c.recon.editorOpenSince !== undefined &&
    c.recon.editorOpenSince + c.config.timeouts.editorConsumeMs <= c.now &&
    c.input.current === undefined
  ) {
    r.editor = true;
  }
  return r;
}

export function sameBlocked(a: SessionState['inputBlocked'], b: SessionState['inputBlocked']): boolean {
  return (
    a.permission === b.permission &&
    a.dialog === b.dialog &&
    a.startup === b.startup &&
    a.copyMode === b.copyMode &&
    a.input === b.input &&
    (a.editor ?? false) === (b.editor ?? false)
  );
}

export interface SurfaceGate {
  open: boolean;
  reason?: 'copyMode' | 'torn' | 'dialogSettle' | 'ctrlC' | 'editorOpen';
  /** when the gate can be re-checked (deadline) */
  retryAt?: MonoMs;
  /** the machine should send `exitCopyMode` first */
  exitCopyMode?: boolean;
}

/**
 * The surface conditions every job honours, including the bypass kinds (§3.6 Gate): not in copy mode (executor exits it
 * first), the last frame not torn, ≥ dialogSettleMs since the first frame of the current surface (overlapping the claim
 * stability, rev 2 §10 G26), and ≥ 1500 ms since the last C-c.
 */
export function surfaceGate(c: CoreState): SurfaceGate {
  const f = c.recon.lastFrame;
  const screenUsable = (c.recon.transport.screen ?? 'up') !== 'down' && (c.recon.transport.screen ?? 'up') !== 'off';
  if (f !== undefined && screenUsable) {
    if (f.inCopyMode) return { open: false, reason: 'copyMode', exitCopyMode: true };
    if (c.recon.lastFrameTorn === true) return { open: false, reason: 'torn' };
    if (f.surface === 'editorOpen') return { open: false, reason: 'editorOpen' };
    const since = c.recon.surfaceSince;
    if (since !== undefined && c.now - since < c.config.timeouts.dialogSettleMs) {
      return { open: false, reason: 'dialogSettle', retryAt: (since + c.config.timeouts.dialogSettleMs) as MonoMs };
    }
  }
  const cc = c.input.lastCtrlCAt;
  if (cc !== undefined && c.now - cc < 1500) return { open: false, reason: 'ctrlC', retryAt: (cc + 1500) as MonoMs };
  return { open: true };
}
