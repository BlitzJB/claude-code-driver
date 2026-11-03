// test/replay/obs-level.test.ts — obs-level replay is exact (DESIGN.md §6.6 "with only obs records it drives L2"; P-API-04
// determinism; the trace header carries CoreInit incl. CoreConfig). WP-INT.
//
// A session runs against the fakes with the debug trace on; its own DebugRecords (header + obs + cmd) are a trace. Replaying
// that trace through the core alone must reproduce every event the core published live and the same final SessionState.
import { describe, expect, it } from 'vitest';
import * as core from '../../src/core/step.js';
import type { DebugRecord } from '../../src/model/debug.js';
import type { DomainEvent } from '../../src/model/events.js';
import { stableStringify } from '../../src/model/json.js';
import { parseTrace, replayObservations, serializeTrace } from '../../src/testing/replay.js';
import type { CoreApi } from '../../src/testing/scenario.js';
import { createTestKernel } from '../../src/testing/test-kernel.js';

const coreApi = core as unknown as CoreApi<core.CoreState>;

/** Events the core published (the kernel adds L3-local warnings through its own path; they carry no `causedBy` input). */
function coreEvents(trace: readonly DebugRecord[], live: readonly DomainEvent[]): DomainEvent[] {
  const fromSteps = new Set(trace.flatMap((r) => (r.r === 'step' ? r.events : [])));
  return live.filter((e) => fromSteps.has(e.seq));
}

describe('obs-level replay', () => {
  it('a recorded session (prompt, tool, permission) replays to identical core events and final state', async () => {
    const tk = await createTestKernel({
      spec: { debug: { raw: 'full' } },
      claude: {
        onPrompt: async (t) => {
          await t.tool({ name: 'Bash', input: { command: 'touch x', description: 'Create x' } });
          await t.say('Done.');
          await t.stop({ lastMessage: 'Done.' });
        },
      },
      permissionHandler: () => ({ behavior: 'allow' }),
    });
    const { turnKey } = await tk.dispatch({ type: 'prompt.send', text: 'touch x', whenBusy: 'wait' });
    await tk.waitForEvent('turn.ended', { pred: (e) => e.turnKey === turnKey });
    await tk.advance(2000);
    // the file sink writes the header first and the records seen before launch after it (debug-trace.ts start()); an
    // in-process listener receives them in emission order, so order them the way the file is written
    const header = tk.debug.find((x) => x.r === 'header');
    expect(header).toBeDefined();
    const records = [...(header === undefined ? [] : [header]), ...tk.debug.filter((x) => x.r !== 'header')];
    // round-trip through the file format
    const trace = parseTrace(serializeTrace(records));
    const r = replayObservations(trace, coreApi);
    const live = coreEvents(records, tk.events);
    expect(live.length).toBeGreaterThan(10);
    expect(r.events.map((e) => stableStringify(e as never))).toEqual(live.map((e) => stableStringify(e as never)));
    expect(stableStringify(r.state as never)).toBe(stableStringify(tk.state() as never));
  });
});
