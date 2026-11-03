// test/contract/hooks.contract.test.ts — runs the shared HookTransport contract against the fake and the real worker-backed
// transport (DESIGN.md §2.7 "Fakes": the owning WP runs the suite against both). The real one is exercised twice: from the
// "dist" build (plain .js, as production spawns it) and, where Node strips types, straight from src (default URL resolution).
import { afterAll } from 'vitest';
import { createFakeHookTransportFactory } from '../../src/platform/hook-server/fake-hooks.js';
import type { FakeHookTransport } from '../../src/platform/hook-server/fake-hooks.js';
import { createNodeHookTransportFactory } from '../../src/platform/hook-server/transport.js';
import type { NodeHookTransport, NodeHookTransportOptions } from '../../src/platform/hook-server/transport.js';
import { hookTransportContract } from './hooks.contract.js';
import type { HarnessFactory, HookHarness } from './hooks.contract.js';
import {
  buildHookServerDist,
  CAN_STRIP_TYPES,
  httpHook,
  memLogger,
  privateDir,
  realClock,
  realIds,
  unixHook,
} from './hooks.contract.helpers.js';
import type { ClientCall } from './hooks.contract.helpers.js';

const dist = buildHookServerDist();
afterAll(() => {
  dist.remove();
});

const base = (o: { maxHeld?: number; maxBodyBytes?: number }, runtimeDir: string) => ({
  runtimeDir,
  clock: realClock(),
  ids: realIds(),
  maxBodyBytes: o.maxBodyBytes ?? 32 * 1024 * 1024,
  maxHeld: o.maxHeld ?? 32,
  maxConnections: 64,
  logger: memLogger(),
});

const fakeHarness: HarnessFactory = (o) => {
  const t: FakeHookTransport = createFakeHookTransportFactory().create(base(o, '/fake/runtime/ccd-x'));
  const wrap = (c: ReturnType<FakeHookTransport['deliver']>): ClientCall => ({
    reply: c.reply,
    abort: () => {
      c.abort('client_gone');
    },
    timeout: () => {
      c.abort('timeout');
    },
  });
  const h: HookHarness = {
    transport: t,
    call: (_ep, event, payload, co = {}) =>
      wrap(
        t.deliver(event, payload, {
          ...(co.via !== undefined ? { transport: co.via } : {}),
          ...(co.bytes !== undefined ? { bytes: co.bytes } : {}),
          ...(co.badJson === true ? { badJson: true } : {}),
        }),
      ),
    forge: () => Promise.resolve(t.forge('token')),
    crash: () => {
      t.crash();
      return Promise.resolve();
    },
    cleanup: () => t.close(null),
  };
  return Promise.resolve(h);
};

function realHarness(opts: NodeHookTransportOptions): HarnessFactory {
  return (o) => {
    const d = privateDir();
    const t = createNodeHookTransportFactory(opts).create(base(o, d.dir)) as NodeHookTransport;
    const h: HookHarness = {
      transport: t,
      call: (ep, event, payload, co = {}) => {
        const via = co.via ?? (ep.transport === 'unix' || event === 'SessionStart' || event === 'PermissionRequest' ? 'unix' : 'http');
        let json = co.badJson === true ? '{"not json' : JSON.stringify(payload);
        if (co.bytes !== undefined) json = JSON.stringify({ pad: 'x'.repeat(co.bytes) });
        return via === 'http' ? httpHook(ep, event, json) : unixHook(ep, event, json);
      },
      forge: (ep, event) => httpHook(ep, event, '{}', { headers: { 'x-ccd-token': '0'.repeat(64) } }).reply,
      crash: () => t.killWorkerForTest(),
      cleanup: async () => {
        await t.close(null);
        d.remove();
      },
    };
    return Promise.resolve(h);
  };
}

hookTransportContract('FakeHookTransport', fakeHarness);
hookTransportContract(
  'NodeHookTransport (dist build)',
  realHarness({ workerUrl: dist.workerUrl, forwarderScriptPath: dist.forwarderPath }),
);
if (CAN_STRIP_TYPES) hookTransportContract('NodeHookTransport (src, default worker URL)', realHarness({}));
