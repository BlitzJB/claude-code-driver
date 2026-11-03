// core/reconcile/* — canonical equality, network join (§4.5.7, NP §5.3), uuid de-dup (D-42, K-27), entity merge (P-REC-37).
import { describe, expect, it } from 'vitest';
import { canonicalEq } from '../../../src/core/reconcile/canonical.js';
import { normalizeText } from '../../../src/core/reconcile/text-match.js';
import { decodePath, encodePath, evolve } from '../../../src/core/evolve.js';
import type { Harness } from './harness.js';
import { readyHarness, sendUntilEnter, testConfig, ups } from './harness.js';

function running(cfg = testConfig()): Harness {
  const h = readyHarness(cfg);
  sendUntilEnter(h, 'work');
  ups(h, 'work', 'p1');
  return h;
}
const tunnel = (
  h: Harness,
  id: number,
  phase: 'sending' | 'receiving' | 'awaiting',
  host = 'api.anthropic.com',
  token: 'A' | 'none' = 'A',
): Harness =>
  h.obs(
    'net.tunnel',
    { tunnelId: id, host, token, phase, bytesUp: 10, bytesDown: phase === 'receiving' ? 100 : 0, lastDownAtMono: h.now as never },
    'network',
  );

describe('canonical / text helpers', () => {
  it('canonicalEq ignores key order', () => {
    expect(canonicalEq({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(canonicalEq({ a: 1 }, { a: 2 })).toBe(false);
    expect(canonicalEq(undefined, null)).toBe(true);
  });
  it('normalizeText collapses whitespace', () => {
    expect(normalizeText('  a \n\n b ')).toBe('a b');
  });
  it('evolve paths escape / and ~ (JSON pointer style)', () => {
    expect(decodePath(encodePath(['bgTasks', 'a/b~c']))).toEqual(['bgTasks', 'a/b~c']);
    const h = readyHarness();
    const d = evolve(h.d, {
      type: 'x.patch',
      entity: encodePath(['bgTasks', 'a/b']),
      patch: { op: 'set', value: { id: 'a/b', type: 't', status: 's', updatedAt: 0 } },
    });
    expect(d.bgTasks['a/b']?.id).toBe('a/b');
    expect(h.d.bgTasks['a/b']).toBeUndefined(); // copy-on-write: the old snapshot is unchanged
  });
});

describe('network correlation (§3.10, §4.5.7)', () => {
  it('binds the api-request to the api.anthropic.com token-A tunnel whose sending began within ±250 ms (FIFO)', () => {
    const h = running();
    tunnel(h, 1, 'sending');
    h.advance(100);
    tunnel(h, 2, 'sending');
    h.advance(50);
    h.tx('model.requestStarted', { requestRef: 'txreq:a', isRetry: false, txWall: (h.wall - 150) as never }, { uuid: 'txreq:a' });
    expect(h.d.calls['c1' as never]?.tunnelId).toBe(1);
    h.tx('model.requestStarted', { requestRef: 'txreq:b', isRetry: false, txWall: (h.wall - 50) as never }, { uuid: 'txreq:b' });
    expect(h.d.calls['c2' as never]?.tunnelId).toBe(2);
  });

  it('telemetry bursts (other hosts or no token) are never model calls; a silent proxy never yields stalled', () => {
    const h = running();
    tunnel(h, 3, 'sending', 'statsig.anthropic.com', 'none');
    h.tx('model.requestStarted', { requestRef: 'txreq:c', isRetry: false, txWall: h.wall as never }, { uuid: 'txreq:c' });
    expect(h.d.calls['c1' as never]?.tunnelId).toBeUndefined();
    h.run(30_000, 1000);
    expect(h.d.calls['c1' as never]?.state.value).toBe('started');
  });

  it('a retry (same requestDigest) is the same call with attempts++', () => {
    const h = running();
    h.tx('model.requestStarted', { requestRef: 'txreq:1', isRetry: false, requestDigest: 'dg' }, { uuid: 'txreq:1' });
    h.tx('model.requestStarted', { requestRef: 'txreq:2', isRetry: true, requestDigest: 'dg' }, { uuid: 'txreq:2' });
    expect(Object.keys(h.d.calls)).toEqual(['c1']);
    expect(h.d.calls['c1' as never]).toMatchObject({ attempts: 2, requestRefs: ['txreq:1', 'txreq:2'] });
    expect(h.ev('modelCall.retrying')[0]?.payload.attempt).toBe(2);
  });

  it('network off in config: tunnels are ignored', () => {
    const h = running(testConfig({ channels: { network: false } }));
    tunnel(h, 1, 'sending');
    expect(h.core.recon.tunnels).toEqual({});
  });
});

describe('de-duplication and merge', () => {
  it('K-27 an identical transcript line twice (full rescan after a rewrite) is idempotent (uuid per generation)', () => {
    const h = running();
    const line = () => h.tx('tool.result', { toolUseId: 'toolu_9', isError: false, uuid: 'tr9' }, { uuid: 'tr9' });
    line();
    const tools = JSON.stringify(h.d.tools);
    const n = h.events.length;
    h.tx('transcript.file', { event: 'rewrite', fileKey: 'main:x', detail: null });
    line();
    expect(JSON.stringify(h.d.tools)).toBe(tools);
    expect(h.events.length).toBe(n);
    expect(h.diag('dup_uuid')).toHaveLength(1);
  });

  it('hooks are never de-duplicated (D-42)', () => {
    const h = running();
    h.hook('notification', { type: 'idle_prompt' }, 'Notification');
    h.hook('notification', { type: 'idle_prompt' }, 'Notification');
    expect(h.diag('dup_uuid')).toEqual([]);
  });

  it('P-REC-37 a transcript placeholder turn and our acked submit with the same prompt_id merge (redirect + entity.merged)', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'mine');
    // the transcript shows a prompt (edited by a user hook) with no UPS: placeholder after hookGap
    h.tx('prompt.recorded', { uuid: 'pr1', parentUuid: null, text: 'mine, rewritten', isMeta: false, promptId: 'shared' }, { uuid: 'pr1' });
    h.run(2100);
    expect(h.d.turns['t2' as never]?.state.provisional).toBe(true);
    h.hook('tool.pre', { toolUseId: 'toolu_m', toolName: 'Read', input: {} }, 'PreToolUse');
    ups(h, 'mine', 'shared');
    expect(h.diag('entity.merged')).toHaveLength(1);
    expect(h.core.recon.redirects['t2']).toBe('t1');
    expect(h.d.turns['t1' as never]?.tools).toEqual(['u1']);
    expect(h.d.tools['u1' as never]?.turn).toBe('t1');
    expect(h.d.activeTurn).toBe('t1');
  });

  it('a transcript prompt matching our in-flight submit is accepted as ours when the UPS never comes', () => {
    const h = readyHarness();
    sendUntilEnter(h, 'mine');
    h.tx('prompt.recorded', { uuid: 'pr2', parentUuid: null, text: 'mine', isMeta: false, promptId: 'p7' }, { uuid: 'pr2' });
    h.run(2100);
    expect(h.d.turns['t1' as never]?.state.value).toBe('running');
    expect(h.d.turns['t1' as never]?.promptId).toBe('p7');
    expect(Object.keys(h.d.turns)).toEqual(['t1']);
  });
});
