// core/decide/messages.ts + reconcile/text-match.ts — §4.5.6, §4.5.10, §4.6 Message (K-26, K-41, K-45, P-REC-09, P-REC-36).
import { describe, expect, it } from 'vitest';
import type { Harness } from './harness.js';
import { readyHarness, sendUntilEnter, ups } from './harness.js';

function running(): Harness {
  const h = readyHarness();
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
const delta = (h: Harness, ui: string, index: number, d: string, final = false): Harness =>
  h.hook('message.textDelta', { promptId: 'p1', uiTurnId: 'ut', uiMessageId: ui, index, final, delta: d }, 'MessageDisplay');
const block = (h: Harness, id: string, text: string, uuid: string, o: Record<string, unknown> = {}): Harness =>
  h.tx(
    'message.block',
    {
      apiMessageId: id,
      blockIndex: 0,
      block: 'text',
      text,
      stopReason: 'end_turn',
      synthetic: false,
      abortedMidStream: false,
      uuid,
      parentUuid: null,
      ...o,
    },
    { uuid },
  );

describe('messages', () => {
  it('MessageDisplay chunks concatenate by index (out of order accepted); status writing until final', () => {
    const h = running();
    delta(h, 'ui1', 1, 'world');
    delta(h, 'ui1', 0, 'hello ');
    const m = h.d.messages['m1' as never];
    expect(m?.text).toBe('hello world');
    expect(h.d.status.kind).toBe('writing');
    delta(h, 'ui1', 2, '', true);
    expect(h.d.messages['m1' as never]).toMatchObject({ final: true, finalBy: 'flag' });
    expect(h.d.status.kind).toBe('modelRequest');
  });

  it('K-45 a lost final MessageDisplay: the next tool.pre finals it implicitly, status runningTools', () => {
    const h = running();
    delta(h, 'ui1', 0, 'Let me check');
    h.hook('tool.pre', { toolUseId: 'toolu_1', toolName: 'Read', input: {} }, 'PreToolUse');
    expect(h.d.messages['m1' as never]).toMatchObject({ final: true, finalBy: 'implicit' });
    expect(h.d.status.kind).toBe('runningTools');
  });

  it('a newer uiMessageId finals the previous one implicitly', () => {
    const h = running();
    delta(h, 'ui1', 0, 'a');
    delta(h, 'ui2', 0, 'b');
    expect(h.d.messages['m1' as never]?.finalBy).toBe('implicit');
  });

  it('a transcript text block is matched to the UiMessage by text, never by message_id (P-REC-09)', () => {
    const h = running();
    delta(h, 'ui-123', 0, 'The answer is 42.', true);
    block(h, 'msg_api_1', 'The answer is 42.', 'b1');
    expect(Object.keys(h.d.messages)).toEqual(['m1']);
    expect(h.d.messages['m1' as never]).toMatchObject({ apiMessageId: 'msg_api_1', uiMessageId: 'ui-123', confirmed: true });
  });

  it('usage is counted once per (message.id, requestId) (P-REC-36)', () => {
    const h = running();
    const usage = { inputTokens: 10, outputTokens: 5 };
    block(h, 'msg_1', 'a', 'b1', { requestId: 'req_1', usage });
    block(h, 'msg_1', 'b', 'b2', { requestId: 'req_1', usage, blockIndex: 1 });
    expect(h.d.usage.tokensTotal).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('K-26 a final MessageDisplay within stopGrace completes the turn; finalText from last_assistant_message', () => {
    const h = running();
    delta(h, 'ui1', 0, 'par');
    h.hook('turn.stopped', { backgroundTasks: [], stopHookActive: false, lastAssistantMessage: 'partial answer' }, 'Stop');
    h.advance(100);
    delta(h, 'ui1', 1, 'tial answer', true);
    expect(h.d.turns['t1' as never]?.state.value).toBe('completed');
    expect(h.d.turns['t1' as never]?.finalText?.value).toBe('partial answer');
  });

  it('K-41 refusal: model.refused + model_refusal_fallback → assistant.retracted, model = fallback, call refused', () => {
    const h = running();
    h.tx('model.requestStarted', { requestRef: 'txreq:1', isRetry: false, requestDigest: 'd' }, { uuid: 'txreq:1' });
    block(h, 'msg_r', 'unsafe text', 'bu1', { requestRef: 'txreq:1', stopReason: null });
    h.tx('model.refused', { refusedMessageId: 'msg_r', text: 'refused', uuid: 'rf' }, { uuid: 'rf' });
    expect(h.ev('assistant.retracted')[0]?.payload).toEqual({ msgKeys: ['m1'], reason: 'refused' });
    expect(h.d.calls['c1' as never]?.state.value).toBe('refused');
    h.tx('model.refusalFallback', { retractedMessageUuids: ['bu1'], fallbackModel: 'claude-sonnet' }, { uuid: 'fb' });
    expect(h.d.claude.model?.value).toBe('claude-sonnet');
    expect(h.ev('session.modelChanged').at(-1)?.payload).toEqual({ model: 'claude-sonnet', source: 'refusalFallback' });
    expect(h.d.turns['t1' as never]?.refused).toMatchObject({ refusedMessageId: 'msg_r', fallbackModel: 'claude-sonnet' });
    expect(h.d.messages['m1' as never]?.retracted).toBe(true);
  });
});
