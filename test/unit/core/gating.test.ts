// core/input-policy/gating.ts — inputBlocked and the surface gate (§3.6 Gate; P-TUI-05, P-INPUT-32, P-REV-38).
import { describe, expect, it } from 'vitest';
import { computeInputBlocked, surfaceGate } from '../../../src/core/input-policy/gating.js';
import type { CoreState } from '../../../src/core/types.js';
import { busyFrame, frame, idleFrame, readyHarness } from './harness.js';

const withFrame = (c: CoreState, f: ReturnType<typeof frame>, since = c.now): CoreState => ({
  ...c,
  recon: { ...c.recon, lastFrame: f, surfaceSince: since, lastFrameTorn: f.torn },
});

describe('gating', () => {
  it('inputBlocked.dialog for dialog surfaces, copyMode from the frame, startup before ready', () => {
    const c = readyHarness().core;
    expect(computeInputBlocked(withFrame(c, frame({ surface: 'permissionDialog' }))).dialog).toBe(true);
    expect(computeInputBlocked(withFrame(c, frame({ surface: 'unknownModal' }))).dialog).toBe(true);
    expect(computeInputBlocked(withFrame(c, idleFrame())).dialog).toBe(false);
    expect(computeInputBlocked(withFrame(c, idleFrame({ inCopyMode: true }))).copyMode).toBe(true);
    expect(computeInputBlocked({ ...c, domain: { ...c.domain, lifecycle: 'launching' } }).startup).toBe(true);
  });

  it('surface gate: torn, copy mode (exitCopyMode first), dialogSettle 150 ms since the first frame of the surface, 1500 ms after C-c', () => {
    const c = readyHarness().core;
    expect(surfaceGate(withFrame(c, idleFrame({ torn: true })))).toMatchObject({ open: false, reason: 'torn' });
    expect(surfaceGate(withFrame(c, idleFrame({ inCopyMode: true })))).toMatchObject({ open: false, exitCopyMode: true });
    expect(surfaceGate(withFrame(c, busyFrame(), c.now))).toMatchObject({ open: false, reason: 'dialogSettle', retryAt: c.now + 150 });
    expect(surfaceGate(withFrame(c, busyFrame(), (c.now - 150) as never)).open).toBe(true);
    const cc = { ...withFrame(c, idleFrame(), (c.now - 1000) as never), input: { ...c.input, lastCtrlCAt: c.now } };
    expect(surfaceGate(cc)).toMatchObject({ open: false, reason: 'ctrlC', retryAt: c.now + 1500 });
  });

  it('a screen channel that is down does not gate on frames', () => {
    const c = readyHarness().core;
    const down = {
      ...withFrame(c, idleFrame({ torn: true })),
      recon: { ...withFrame(c, idleFrame({ torn: true })).recon, transport: { screen: 'down' as const } },
    };
    expect(surfaceGate(down).open).toBe(true);
  });
});
