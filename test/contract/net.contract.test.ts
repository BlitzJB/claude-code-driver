// Runs the NetProxy contract against the fake and against the real client + sidecar process (DESIGN.md §6.1 contract project,
// §6.4 network row). The real sidecar is spawned from src/ (Node 22 strips the types of the node:*-only standalone file) with
// NODE_ENV=test so that `resolveOverrides` routes api.anthropic.com / example.com / platform.claude.com to a local upstream.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/model/logger.js';
import type { Cancel, Clock, MonoMs, WallMs } from '../../src/model/time.js';
import { createNetProxyFactory, NetSidecarError, type NetProxyFactoryDeps } from '../../src/platform/netproxy/client.js';
import type { FakeNetProxy } from '../../src/platform/netproxy/fake-net.js';
import { FakeNetProxyFactory } from '../../src/platform/netproxy/fake-net.js';
import type { NetProxy, ProcessPort, TunnelRecord } from '../../src/platform/ports.js';
import { netProxyContract, type NetContractContext, type StartOptions } from './net.contract.js';

const SIDECAR_TS = fileURLToPath(new URL('../../src/platform/netproxy/standalone/sidecar.ts', import.meta.url));
const TOKEN = '0123456789abcdef'.repeat(4);
const CTL = 'fedcba9876543210'.repeat(4);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

// ---- minimal real ports for the test (WP-05 owns the production ones) ----
const realClock: Clock = {
  now: () => performance.now() as MonoMs,
  wallNow: () => Date.now() as WallMs,
  setTimer(atMono, fn): Cancel {
    const t = setTimeout(fn, Math.max(0, atMono - performance.now()));
    return () => {
      clearTimeout(t);
    };
  },
  sleep: (ms) => sleep(ms),
};
const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
function testProcessPort(spawned: number[]): ProcessPort {
  const no = (): never => {
    throw new Error('not used by the netproxy client');
  };
  return {
    which: no,
    exec: no,
    execSyncBestEffort: no,
    identity: no,
    spawnDetached(file, args, o) {
      const fd = openSync(o.logPath, 'a', 0o600);
      try {
        const child = spawn(file, [...args], { detached: true, stdio: ['ignore', fd, fd], env: { ...o.env } });
        child.unref();
        if (child.pid === undefined) return Promise.reject(new Error('spawn failed'));
        spawned.push(child.pid);
        return Promise.resolve({ pid: child.pid });
      } finally {
        closeSync(fd);
      }
    },
    isAlive,
    kill(pid, sig) {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---- local upstream: echoes ECHO:<data>, ends on FIN ----
let upstream: net.Server;
let upPort = 0;
beforeAll(async () => {
  upstream = net.createServer({ allowHalfOpen: true }, (s) => {
    s.on('data', (d: Buffer) => s.write(Buffer.concat([Buffer.from('ECHO:'), d])));
    s.on('end', () => s.end());
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upPort = (upstream.address() as net.AddressInfo).port;
});
afterAll(() => {
  upstream.close();
});

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'ccd-'));
}
function startOptions(dir: string): StartOptions {
  return {
    tokenA: TOKEN,
    controlSocketPath: join(dir, 'net.sock'),
    controlToken: CTL,
    logPath: join(dir, 'net.log'),
    allowPrivate: false,
    allowPorts: [443],
    denyPorts: [],
  };
}
function realDeps(spawned: number[], over: Partial<NetProxyFactoryDeps> = {}): NetProxyFactoryDeps {
  const target = { host: '127.0.0.1', port: upPort };
  return {
    process: testProcessPort(spawned),
    clock: realClock,
    logger: silent,
    nodePath: process.execPath,
    ownerPid: process.pid,
    scriptPath: SIDECAR_TS,
    sidecarEnv: { NODE_ENV: 'test' },
    sidecarConfig: {
      pollMs: 50,
      exitGraceMs: 200,
      resolveOverrides: { 'api.anthropic.com:443': target, 'example.com:443': target, 'platform.claude.com:443': target },
    },
    ...over,
  };
}

/** One CONNECT through the real sidecar; bytes both ways; then FIN and wait for close. */
function connectThrough(port: number, host: string, token = TOKEN): Promise<'established' | 'refused'> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let buf = '';
    let ok = false;
    s.setEncoding('latin1');
    s.on('connect', () =>
      s.write(
        `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${Buffer.from(`ccd:${token}`).toString('base64')}\r\n\r\n`,
      ),
    );
    s.on('data', (d: string) => {
      buf += d;
      if (!ok && buf.startsWith('HTTP/1.1 200 ')) {
        ok = true;
        s.write('ping');
      }
      if (ok && buf.endsWith('ECHO:ping')) s.end();
    });
    s.on('error', (e) => {
      if (ok) resolve('established');
      else reject(e);
    });
    s.on('close', () => {
      resolve(ok && buf.endsWith('ECHO:ping') ? 'established' : 'refused');
    });
  });
}

/** CONNECT, send `ping` after the 200, collect what comes back for up to `ms` (or until `done`), then hang up. */
function rawTunnel(port: number, host: string, ms: number, done?: (data: string) => boolean): Promise<{ data: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    let data = '';
    let closed = false;
    let sentPing = false;
    s.setEncoding('latin1');
    const finish = (): void => {
      clearTimeout(timer);
      s.destroy();
      resolve({ data, closed });
    };
    const timer = setTimeout(finish, ms);
    s.on('connect', () =>
      s.write(
        `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${Buffer.from(`ccd:${TOKEN}`).toString('base64')}\r\n\r\n`,
      ),
    );
    s.on('data', (d: string) => {
      data += d;
      if (!sentPing && data.startsWith('HTTP/1.1 200 ')) {
        sentPing = true;
        s.write('ping');
      }
      if (done?.(data) === true) finish();
    });
    s.on('error', () => undefined);
    s.on('close', () => {
      closed = true;
      clearTimeout(timer);
      resolve({ data, closed });
    });
  });
}

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
});
function sleeper(): ChildProcess {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' });
  children.push(c);
  return c;
}

// ---- the two harnesses ----
netProxyContract({
  name: 'fake',
  create(): Promise<NetContractContext> {
    const factory = new FakeNetProxyFactory({ clock: realClock });
    return Promise.resolve({
      factory,
      clock: realClock,
      startOptions: startOptions('/nonexistent/ccd-fake'),
      driveTunnel(p: NetProxy, host: string) {
        const fake = p as FakeNetProxy;
        const id = fake.simulateTunnel({ host });
        return Promise.resolve(fake.emitted.some((r) => r.tunnelId === id && r.kind === 'refused') ? 'refused' : 'established');
      },
      killSidecar(p: NetProxy) {
        (p as FakeNetProxy).die();
        return Promise.resolve();
      },
      claudePid: 4242,
      dispose: () => Promise.resolve(),
    });
  },
});

netProxyContract({
  name: 'real sidecar process',
  create(): Promise<NetContractContext> {
    const dir = newDir();
    const spawned: number[] = [];
    const claude = sleeper();
    return Promise.resolve({
      factory: createNetProxyFactory(realDeps(spawned)),
      clock: realClock,
      startOptions: startOptions(dir),
      driveTunnel: (p: NetProxy, host: string) => connectThrough(p.port, host),
      async killSidecar(p: NetProxy) {
        process.kill(p.pid, 'SIGKILL');
        await waitFor(() => !isAlive(p.pid));
      },
      claudePid: claude.pid ?? 0,
      dispose() {
        claude.kill('SIGKILL');
        for (const pid of spawned) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        rmSync(dir, { recursive: true, force: true });
        return Promise.resolve();
      },
    });
  },
});

// ---- real-only behaviour: spawn, config file, lifetime, failure paths ----
describe('real client + sidecar specifics', () => {
  it('spawns through the ulimit wrapper with the given env and the 0600 config path (P-NET-16)', async () => {
    const dir = newDir();
    try {
      const calls: { file: string; args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
      const proc: ProcessPort = {
        ...testProcessPort([]),
        spawnDetached(file, args, o) {
          calls.push({ file, args, env: o.env });
          const cfg = args[4] ?? '';
          expect(statSync(cfg).mode & 0o777).toBe(0o600);
          return Promise.resolve({ pid: 999_999 });
        },
        isAlive: () => false,
      };
      const f = createNetProxyFactory({ ...realDeps([]), process: proc, sidecarEnv: { NODE_ENV: 'test' } });
      await expect(f.start(startOptions(dir))).rejects.toMatchObject({ reason: 'exited' });
      expect(calls).toEqual([
        {
          file: '/bin/sh',
          args: ['-c', 'ulimit -n 8192 2>/dev/null; exec "$0" "$@"', process.execPath, SIDECAR_TS, join(dir, 'net.json')],
          env: { NODE_ENV: 'test' },
        },
      ]);
      expect(existsSync(join(dir, 'net.json'))).toBe(false); // cleaned up on failure
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the sidecar deletes net.json once read; the pid is the sidecar itself (exec); stop kills it and unlinks the socket', async () => {
    const dir = newDir();
    const spawned: number[] = [];
    try {
      const p = await createNetProxyFactory(realDeps(spawned)).start(startOptions(dir));
      expect(existsSync(join(dir, 'net.json'))).toBe(false);
      expect(p.pid).toBe(spawned[0]);
      expect(statSync(join(dir, 'net.sock')).mode & 0o777).toBe(0o600);
      await p.stop();
      expect(isAlive(p.pid)).toBe(false);
      expect(existsSync(join(dir, 'net.sock'))).toBe(false);
    } finally {
      for (const pid of spawned) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stale net.json is never overwritten', async () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, 'net.json'), '{}', { mode: 0o600 });
      await expect(createNetProxyFactory(realDeps([])).start(startOptions(dir))).rejects.toMatchObject({ reason: 'configExists' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wrong credentials through the real process → 407, counted, never logged', async () => {
    const dir = newDir();
    const spawned: number[] = [];
    try {
      const p = await createNetProxyFactory(realDeps(spawned)).start(startOptions(dir));
      const recs: TunnelRecord[] = [];
      p.on((r) => recs.push(r));
      expect(await connectThrough(p.port, 'api.anthropic.com', 'f'.repeat(64))).toBe('refused');
      await waitFor(() => recs.some((r) => r.kind === 'refused'));
      expect(recs.find((r) => r.kind === 'open')?.token).toBe('bad');
      await p.stop();
      const { readFileSync } = await import('node:fs');
      const log = readFileSync(join(dir, 'net.log'), 'utf8');
      expect(log).toContain('"status":407');
      expect(log).not.toContain(TOKEN);
      expect(log).not.toContain(CTL);
    } finally {
      for (const pid of spawned) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lifetime is bound to Claude: the sidecar exits after the bound pid dies, and the client reports sidecarDied (P-NET-23)', async () => {
    const dir = newDir();
    const spawned: number[] = [];
    const claude = sleeper();
    try {
      const p = await createNetProxyFactory(realDeps(spawned)).start(startOptions(dir));
      const recs: TunnelRecord[] = [];
      p.on((r) => recs.push(r));
      await p.bindClaudePid(claude.pid ?? 0);
      await sleep(150);
      expect(isAlive(p.pid)).toBe(true);
      claude.kill('SIGKILL');
      await waitFor(() => !isAlive(p.pid), 5000);
      await waitFor(() => recs.some((r) => r.error === 'sidecarDied'));
      await p.stop();
    } finally {
      for (const pid of spawned) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sidecar that exits during start → NetSidecarError(exited) with its log tail', async () => {
    const dir = newDir();
    try {
      const bad = join(dir, 'bad.mjs');
      writeFileSync(bad, "process.stderr.write('boom-from-sidecar\\n'); process.exit(1);\n");
      const err = await createNetProxyFactory(realDeps([], { scriptPath: bad }))
        .start(startOptions(dir))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetSidecarError);
      expect(err).toMatchObject({ reason: 'exited' });
      expect((err as Error).message).toContain('boom-from-sidecar');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sidecar that never listens → startTimeout and the process is killed', async () => {
    const dir = newDir();
    const spawned: number[] = [];
    try {
      const hang = join(dir, 'hang.mjs');
      writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
      const err = await createNetProxyFactory(realDeps(spawned, { scriptPath: hang, startTimeoutMs: 300 }))
        .start(startOptions(dir))
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: 'startTimeout' });
      await waitFor(() => spawned.every((pid) => !isAlive(pid)));
      expect(spawned.every((pid) => !isAlive(pid))).toBe(true);
    } finally {
      for (const pid of spawned) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('faults through the real process: reset:N, stall:N, blackhole, slow:R on api.anthropic.com; example.com untouched', async () => {
    const dir = newDir();
    const spawned: number[] = [];
    try {
      const p = await createNetProxyFactory(realDeps(spawned)).start(startOptions(dir));
      const recs: TunnelRecord[] = [];
      p.on((r) => recs.push(r));
      const OK = 'HTTP/1.1 200 Connection Established\r\n\r\n';

      await p.setFault({ mode: 'reset', afterDownBytes: 3 });
      const reset = await rawTunnel(p.port, 'api.anthropic.com', 400);
      expect(reset.data).toBe(`${OK}ECH`);
      expect(reset.closed).toBe(true);
      await waitFor(() => recs.some((r) => r.kind === 'close' && r.closeKind === 'rst'));
      expect(recs.find((r) => r.kind === 'close' && r.closeKind === 'rst')?.error).toContain('fault:reset');
      expect(await connectThrough(p.port, 'example.com')).toBe('established'); // tools are never faulted

      await p.setFault({ mode: 'stall', afterDownBytes: 3 });
      const stall = await rawTunnel(p.port, 'api.anthropic.com', 400);
      expect(stall.data).toBe(`${OK}ECH`);
      expect(stall.closed).toBe(false); // silent and open: the stall the core must detect

      await p.setFault({ mode: 'blackhole' });
      const hole = await rawTunnel(p.port, 'api.anthropic.com', 300);
      expect(hole.data).toBe(OK);
      expect(hole.closed).toBe(false);

      await p.setFault({ mode: 'slow', bytesPerSec: 20 });
      const t0 = Date.now();
      const slow = await rawTunnel(p.port, 'api.anthropic.com', 1500, (d) => d.endsWith('ECHO:ping'));
      expect(slow.data).toBe(`${OK}ECHO:ping`);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // 9 bytes at 2 bytes per 100 ms tick

      await p.setFault(null);
      expect(await connectThrough(p.port, 'api.anthropic.com')).toBe('established');
      await p.stop();
    } finally {
      for (const pid of spawned) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without NODE_ENV=test the sidecar ignores resolveOverrides (test routing can never redirect a real session)', async () => {
    const dir = newDir();
    const spawned: number[] = [];
    try {
      const deps = realDeps(spawned, { sidecarEnv: {} });
      deps.sidecarConfig = { resolveOverrides: { 'ccd-override.invalid:443': { host: '127.0.0.1', port: upPort } } };
      const p = await createNetProxyFactory(deps).start(startOptions(dir));
      const recs: TunnelRecord[] = [];
      p.on((r) => recs.push(r));
      const r = await rawTunnel(p.port, 'ccd-override.invalid', 3000, (d) => d.startsWith('HTTP/1.1 '));
      expect(r.data).toMatch(/^HTTP\/1\.1 502 /); // real DNS for .invalid fails; never routed to the local upstream
      await waitFor(() => recs.some((x) => x.kind === 'refused'));
      expect(recs.some((x) => x.kind === 'established')).toBe(false);
      await p.stop();
    } finally {
      for (const pid of spawned) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the fake factory can be told to fail its next start', async () => {
    const f = new FakeNetProxyFactory();
    f.failNextStart = new NetSidecarError('spawnFailed', 'nope');
    await expect(f.start(startOptions('/x'))).rejects.toMatchObject({ reason: 'spawnFailed' });
    await expect(f.start(startOptions('/x'))).resolves.toBe(f.last);
    expect(f.starts).toHaveLength(2);
  });
});
