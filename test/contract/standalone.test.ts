// test/contract/standalone.test.ts — standalone scripts spawned from a dist build exactly as production does (P-API-13).
// Forwarder part: WP-03 (DESIGN.md §3.5, HT §2.3). Other WPs add their own describe blocks for their standalone scripts.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeHookTransportFactory } from '../../src/platform/hook-server/transport.js';
import type { NodeHookTransport } from '../../src/platform/hook-server/transport.js';
import type { HookEndpoint, RawHookEvent } from '../../src/platform/ports.js';
import { buildHookServerDist, memLogger, privateDir, realClock, realIds } from './hooks.contract.helpers.js';

// ---- forwarder (WP-03) -----------------------------------------------------------------------------------------------
describe('forwarder (dist/platform/hook-server/standalone/forward.js) against the real worker', () => {
  const dist = buildHookServerDist();
  afterAll(() => {
    dist.remove();
  });
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function open(transport: 'http' | 'unix' = 'http'): Promise<{ t: NodeHookTransport; ep: HookEndpoint; events: RawHookEvent[] }> {
    const d = privateDir();
    const t = createNodeHookTransportFactory({ workerUrl: dist.workerUrl, forwarderScriptPath: dist.forwarderPath }).create({
      runtimeDir: d.dir,
      clock: realClock(),
      ids: realIds(),
      maxBodyBytes: 32 * 1024 * 1024,
      maxHeld: 32,
      maxConnections: 64,
      logger: memLogger(),
    }) as NodeHookTransport;
    const events: RawHookEvent[] = [];
    t.on((e) => events.push(e));
    cleanups.push(async () => {
      await t.close(null);
      d.remove();
    });
    const ep = await t.start({ sessionShortId: 'sF', transport });
    return { t, ep, events };
  }

  interface Run {
    child: ChildProcess;
    done: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; ms: number }>;
  }
  /** Exactly the settings' exec form: `<nodePath> <scriptPath> <fwd.json> <Event>`, Claude-like env (no NODE_OPTIONS). */
  function forward(ep: HookEndpoint, event: string, stdin: string, env: Record<string, string> = {}): Run {
    const t0 = performance.now();
    const child = spawn(ep.forwarder.nodePath, [ep.forwarder.scriptPath, ep.unix.forwarderConfigPath, event], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; ms: number }>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        resolve({ code, signal, out, ms: performance.now() - t0 });
      });
    });
    return { child, done };
  }

  it('the endpoint names an absolute node and an absolute dist script (exec form, P-HOOK-29/30)', async () => {
    const { ep } = await open();
    expect(ep.forwarder.nodePath).toBe(process.execPath);
    expect(ep.forwarder.scriptPath).toBe(dist.forwarderPath);
    expect(ep.forwarder.scriptPath.endsWith('/dist/platform/hook-server/standalone/forward.js')).toBe(true);
  });

  it('SessionStart: event delivered, nothing printed, exit 0 (P-HOOK-25); warm runs are quick', async () => {
    const { ep, events } = await open();
    const r = await forward(ep, 'SessionStart', '{"hook_event_name":"SessionStart","source":"startup"}').done;
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(events[0]).toMatchObject({ event: 'SessionStart', transport: 'unix', holdable: false, payload: { source: 'startup' } });
    const warm = await forward(ep, 'SessionStart', '{"source":"clear"}').done;
    expect(warm.code).toBe(0);
    expect(warm.ms).toBeLessThan(2000); // budget < 100 ms on a warm machine (LC §1.4); generous for CI
  });

  it('PermissionRequest is held while the forwarder waits; respond() prints exactly the decision and exits 0', async () => {
    const { t, ep, events } = await open();
    const run = forward(ep, 'PermissionRequest', '{"tool_name":"Bash","tool_input":{"command":"ls"}}');
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events[0]?.holdable).toBe(true);
    const decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    expect(t.respond(events[0]?.hookSeq ?? (0 as never), decision)).toBe(true);
    const r = await run.done;
    expect(r).toMatchObject({ code: 0, out: JSON.stringify(decision) });
  });

  it('respond(null) → the forwarder prints nothing (the native dialog appears)', async () => {
    const { t, ep, events } = await open();
    const run = forward(ep, 'PermissionRequest', '{}');
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    t.respond(events[0]?.hookSeq ?? (0 as never), null);
    expect(await run.done).toMatchObject({ code: 0, out: '' });
  });

  it('Claude terminates the held forwarder (SIGTERM, its hook timeout) → closed "timeout", exit 0, nothing printed (P-HOOK-64)', async () => {
    const { ep, events } = await open();
    const run = forward(ep, 'PermissionRequest', '{}');
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    run.child.kill('SIGTERM');
    await expect(events[0]?.closed).resolves.toBe('timeout');
    expect(await run.done).toMatchObject({ code: 0, out: '' });
  });

  it('a SIGKILLed forwarder → closed "client_gone"', async () => {
    const { ep, events } = await open();
    const run = forward(ep, 'PermissionRequest', '{}');
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    run.child.kill('SIGKILL');
    await expect(events[0]?.closed).resolves.toBe('client_gone');
    expect((await run.done).signal).toBe('SIGKILL');
  });

  it('self-test over the forwarder (transport unix): the nonce UPS prints the constant block body', async () => {
    const { t, ep } = await open('unix');
    await t.armSelfTestNonce('ccd-selftest-0123');
    const r = await forward(ep, 'UserPromptSubmit', '{"prompt":"ccd-selftest-0123"}').done;
    expect(r).toMatchObject({ code: 0, out: '{"decision":"block","reason":"ccd self-test"}' });
    const other = await forward(ep, 'UserPromptSubmit', '{"prompt":"hi"}').done;
    expect(other).toMatchObject({ code: 0, out: '' });
  });

  it('dead endpoint (transport closed, socket gone): exit 0, nothing printed (P-HOOK-27, HT §5.1)', async () => {
    const { t, ep } = await open();
    const fwd = ep.unix.forwarderConfigPath;
    await t.close(null);
    expect(existsSync(ep.unix.socketPath)).toBe(false);
    expect(await forward(ep, 'PermissionRequest', '{}').done).toMatchObject({ code: 0, out: '' });
    expect(existsSync(fwd)).toBe(false); // even the config is gone: still silent
  });

  it('ignores its environment: proxy vars and CLAUDE_ENV_FILE change nothing, no file is written (P-HOOK-28, P-SEC-21/38)', async () => {
    const { ep, events } = await open();
    const envFile = join(ep.unix.socketPath, '..', 'env-file');
    const r = await forward(ep, 'Stop', '{"ok":true}', {
      HTTPS_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      CLAUDE_ENV_FILE: envFile,
    }).done;
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(events[0]?.payload).toEqual({ ok: true });
    expect(existsSync(envFile)).toBe(false);
    rmSync(envFile, { force: true });
  });

  it('a large stdin (8 MB) is read to EOF and forwarded intact (P-HOOK-24)', { timeout: 20_000 }, async () => {
    const { ep, events } = await open();
    const payload = JSON.stringify({ tool_response: 'q'.repeat(8 * 1000 * 1000) });
    const r = await forward(ep, 'PostToolUse', payload).done;
    expect(r).toMatchObject({ code: 0, out: '' });
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events[0]?.bytes).toBe(payload.length);
    expect((events[0]?.payload as { tool_response: string }).tool_response).toHaveLength(8 * 1000 * 1000);
  });
});
