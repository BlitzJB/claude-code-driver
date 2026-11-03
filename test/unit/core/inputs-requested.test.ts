// core/decide/inputs-requested.ts — MCP elicitation / unknown modal → awaitingInput (§4.6 PendingInput, K-40, P-REV-14).
import { describe, expect, it } from 'vitest';
import type { Harness } from './harness.js';
import { busyFrame, frame, readyHarness, sendUntilEnter, ups } from './harness.js';

function running(): Harness {
  const h = readyHarness();
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}

describe('pending inputs', () => {
  it('K-40 Notification{elicitation_dialog} → awaitingInput, queue blocked; elicitation_complete → cleared', () => {
    const h = running();
    h.hook('input.requested', { kind: 'elicitation', message: 'Pick a repo', server: 'gh' }, 'Notification');
    expect(h.d.status).toMatchObject({ kind: 'awaitingInput', inputKind: 'elicitation', message: 'Pick a repo' });
    expect(h.d.inputBlocked.input).toBe(true);
    expect(h.ev('input.requested')[0]?.payload).toMatchObject({ requestKey: 'r1', kind: 'elicitation' });
    h.hook('input.requestCleared', { kind: 'elicitation', how: 'complete' }, 'Notification');
    expect(h.d.pendingInputs).toEqual({});
    expect(h.ev('input.cleared')[0]?.payload).toEqual({ requestKey: 'r1', how: 'complete' });
    expect(h.d.status.kind).toBe('modelRequest');
  });

  it('K-40 a screen-only unknown modal lasting > 2 s while a turn is active → awaitingInput{unknownModal}; leaving clears it', () => {
    const h = running();
    h.screen(busyFrame({ surface: 'unknownModal', composer: undefined }));
    h.run(1500);
    expect(h.d.pendingInputs).toEqual({});
    h.run(1000);
    expect(h.d.status).toMatchObject({ kind: 'awaitingInput', inputKind: 'unknownModal' });
    h.screen(busyFrame());
    expect(h.d.pendingInputs).toEqual({});
    expect(h.ev('input.cleared')[0]?.payload.how).toBe('screenGone');
  });

  it('an unknown modal with no active turn is not a pending input', () => {
    const h = readyHarness();
    h.screen(frame({ surface: 'unknownModal', composer: undefined }));
    h.run(3000);
    expect(h.d.pendingInputs).toEqual({});
  });

  it('the turn ending (interrupt) clears pending inputs', () => {
    const h = running();
    h.hook('input.requested', { kind: 'agentNeedsInput' }, 'Notification');
    h.tx('turn.interrupted', { marker: 'request' }, { uuid: 'i' });
    expect(h.d.pendingInputs).toEqual({});
    expect(h.ev('input.cleared')[0]?.payload.how).toBe('interrupted');
  });
});
