// Kernel scenarios for library bugs found by the live runs against the real Claude Code 2.1.316
// (docs/research/live-results.md). Each failed before its fix.
import { describe, expect } from 'vitest';
import { boot, kscenario } from './support.js';

describe('live fixes', () => {
  kscenario('F-3', ['11', '12'], 'network on + a user HTTPS_PROXY in the host env → channel network off{userProxy}, not up', async () => {
    const tk = await boot({ spec: { network: {} }, ports: { envVars: { HTTPS_PROXY: 'http://127.0.0.1:3128' } } });
    expect(tk.eventsOf('warning').some((e) => e.payload.code === 'E_NETWORK_UNAVAILABLE')).toBe(true);
    expect(tk.state().channels.network.health).toBe('off');
    expect(tk.eventsOf('channel.health').find((e) => e.payload.channel === 'network')?.payload).toMatchObject({
      health: 'off',
      reason: 'userProxy',
    });
  });

  kscenario('F-3', ['11', '12'], 'network on with no user proxy → the channel stays up', async () => {
    const tk = await boot({ spec: { network: {} } });
    expect(tk.state().channels.network.health).toBe('up');
  });
});
