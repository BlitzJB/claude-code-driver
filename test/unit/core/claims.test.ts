// core/claims.ts — candidate → asserted → confirmed | retracted | expired (§4.6 Claims, D-41, P-REC-12, P-REV-38, K-43).
import { describe, expect, it } from 'vitest';
import { claimsOfFrame, isIdleMain } from '../../../src/core/claims.js';
import { busyFrame, composerFrame, frame, idleFrame, readyHarness, sendUntilEnter, ups } from './harness.js';

describe('claims', () => {
  it('claim keys: surfaces, dialogs, status kinds (not spinner metrics), banners, idleMain', () => {
    const keys = claimsOfFrame(
      busyFrame({ status: { kind: 'retrying', attempt: 4, max: 10, retryInMs: 2000 }, interruptedBanner: true }),
    ).map((c) => c.key);
    expect(keys).toEqual(['status:retrying', 'interruptedBanner']);
    expect(claimsOfFrame(frame({ surface: 'permissionDialog', dialog: { kind: 'permission', options: [] } })).map((c) => c.key)).toEqual([
      'surface:permissionDialog',
      'dialog:permission',
    ]);
    expect(claimsOfFrame(idleFrame()).map((c) => c.key)).toEqual(['idleMain']);
    expect(claimsOfFrame(frame({ surface: 'editorOpen' }))).toEqual([]);
    expect(isIdleMain(composerFrame('x'))).toBe(false);
    expect(isIdleMain(busyFrame())).toBe(false);
  });

  it('a candidate is asserted after claimMinStableMs (100) while still shown; a dialog after claimDialogStableMs (250)', () => {
    const h = readyHarness();
    h.screen(busyFrame({ status: { kind: 'stalled' } }));
    h.advance(90);
    expect(h.ev('claim.asserted').filter((e) => e.payload.claim === 'status:stalled')).toEqual([]);
    h.advance(20);
    expect(h.ev('claim.asserted').filter((e) => e.payload.claim === 'status:stalled')).toHaveLength(1);
    h.screen(frame({ surface: 'modal', composer: undefined }));
    h.advance(200);
    expect(h.ev('claim.asserted').filter((e) => e.payload.claim === 'surface:modal')).toEqual([]);
    h.advance(60);
    expect(h.ev('claim.asserted').filter((e) => e.payload.claim === 'surface:modal')).toHaveLength(1);
  });

  it('a candidate that disappears before it is stable is dropped silently; an asserted one expires', () => {
    const h = readyHarness();
    h.screen(busyFrame({ status: { kind: 'stalled' } }));
    h.advance(50).screen(busyFrame());
    h.run(300);
    expect(h.ev('claim.asserted').filter((e) => e.payload.claim === 'status:stalled')).toEqual([]);
    expect(h.ev('claim.expired').filter((e) => e.payload.claim === 'status:stalled')).toEqual([]);
    h.screen(busyFrame({ status: { kind: 'stalled' } }));
    h.run(200);
    h.screen(busyFrame());
    expect(h.ev('claim.expired').filter((e) => e.payload.claim === 'status:stalled')).toHaveLength(1);
  });

  it('the screen never creates or ends a Turn/ToolRun (P-REC-12): a done line with no turn does nothing', () => {
    const h = readyHarness();
    h.screen(idleFrame({ status: { kind: 'done', doneDurationMs: 1000 } }));
    h.screen(busyFrame({ status: { kind: 'spinner' } }));
    h.run(500);
    expect(Object.keys(h.d.turns)).toEqual([]);
    expect(Object.keys(h.d.tools)).toEqual([]);
  });

  it('K-43 A→B→A: the same dialog twice reaches the core both times (no windowed dedup, D-42)', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'x');
    ups(h, 'x', 'p1');
    const dlg = () => busyFrame({ surface: 'permissionDialog', dialog: { kind: 'permission', options: [] }, composer: undefined });
    h.screen(dlg());
    h.run(300);
    h.screen(busyFrame());
    h.run(100);
    h.screen(dlg());
    h.run(300);
    expect(h.ev('claim.asserted').filter((e) => e.payload.claim === 'surface:permissionDialog')).toHaveLength(2);
    expect(h.ev('claim.expired').filter((e) => e.payload.claim === 'surface:permissionDialog')).toHaveLength(1);
  });

  it('a hook PermissionRequest confirms the dialog claim (higher-rank same meaning)', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'x');
    ups(h, 'x', 'p1');
    h.hook('permission.requested', { hookSeq: 1 as never, toolName: 'Bash', input: {}, suggestions: [] }, 'PermissionRequest');
    h.screen(busyFrame({ surface: 'permissionDialog', dialog: { kind: 'permission', options: [] }, composer: undefined }));
    h.run(300);
    expect(h.ev('claim.confirmed').some((e) => e.payload.claim === 'surface:permissionDialog')).toBe(true);
    expect(Object.keys(h.d.permissions)).toEqual(['p1']);
  });

  it('torn frames are ignored and block the input gate', () => {
    const h = readyHarness();
    h.screen(busyFrame({ torn: true, status: { kind: 'stalled' } }));
    h.run(300);
    expect(h.ev('claim.asserted').filter((e) => e.payload.claim === 'status:stalled')).toEqual([]);
    h.cmd({ type: 'prompt.send', text: 'x', whenBusy: 'wait' });
    expect(h.intentsOf('input')).toEqual([]);
    h.screen(idleFrame());
    h.run(200);
    expect(h.intentsOf('input').length).toBeGreaterThan(0);
  });
});
