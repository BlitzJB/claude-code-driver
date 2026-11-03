// WP-12 reaper contract against the real adapters (DESIGN.md §3.8, rev 2 §10 G21): a real private tmux server (`-L ccd-*`), a
// real stand-in "claude.exe" process, the real state store / runtime dir in a temp dir. Checks what the fakes cannot: the real
// `ps` identity read, `tmux -S <socket> kill-server`, the socket file gone, and that an unknown `ccd-*` server survives.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionKey } from '../../src/model/ids.js';
import type { ClaudeConfigPort } from '../../src/platform/ports.js';
import { createRealClock } from '../../src/platform/clock/real-clock.js';
import { createEnvPort } from '../../src/platform/env/env-port.js';
import { createProcessPort } from '../../src/platform/process/process-port.js';
import { createRuntimeDirPort } from '../../src/platform/runtime-dir/runtime-dir.js';
import { createStateStore } from '../../src/platform/runtime-dir/state-store.js';
import { reap } from '../../src/session/reaper.js';
import { RegistryStore, type SessionRecord } from '../../src/session/registry-store.js';
import { MemoryLogger } from '../../src/testing/fake-ports.js';
import { findRealTmux } from './tmux.contract.js';

const real = findRealTmux();
const TAG = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

function tmux(bin: string, ...args: string[]): string {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/' },
  });
}

function startServer(bin: string, name: string): string {
  tmux(bin, '-L', name, '-f', '/dev/null', 'new-session', '-d', '-s', 'x', '-x', '80', '-y', '24', 'sleep 300');
  return tmux(bin, '-L', name, 'display-message', '-p', '#{socket_path}').trim();
}

function serverAlive(bin: string, name: string): boolean {
  try {
    tmux(bin, '-L', name, 'list-sessions');
    return true;
  } catch {
    return false;
  }
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe.skipIf(real === undefined)(`reaper against real tmux ${real?.version ?? ''}`, () => {
  const bin = real?.path ?? '/usr/bin/tmux';
  const ours = `ccd-wp12-${TAG}`;
  const unknown = `ccd-wp12-unknown-${TAG}`;
  const dir = mkdtempSync(join(tmpdir(), 'ccd-wp12-'));
  const children: ChildProcess[] = [];

  const sockets: string[] = [];
  afterAll(() => {
    for (const n of [ours, unknown]) {
      try {
        tmux(bin, '-L', n, 'kill-server');
      } catch {
        // already gone
      }
    }
    // A killed server can leave its socket file behind (P-TMUX-39): remove ours.
    for (const s of sockets) rmSync(s, { force: true });
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reaps a dead owner session: verified Claude SIGTERM, kill-server, socket gone; unknown ccd-* untouched', async () => {
    const clock = createRealClock();
    const env = createEnvPort();
    const proc = createProcessPort({ clock });
    const state = createStateStore({ env, clock, root: join(dir, 'state') });
    const runtimeDir = createRuntimeDirPort({ env, root: join(dir, 'run') });
    const store = new RegistryStore(state, () => clock.wallNow());
    const claudeConfig: ClaudeConfigPort = {
      readGlobal: () => Promise.resolve({ ok: true, hasCompletedOnboarding: true }),
      globalConfigPath: () => join(dir, '.claude.json'),
      trustOf: () => Promise.resolve({ trusted: true }),
      seedTrust: () => Promise.resolve({ added: false }),
      unseedTrust: () => Promise.reject(new Error('must not be called')),
      readLayers: () => Promise.reject(new Error('unused')),
      inspectWorkspace: () => Promise.reject(new Error('unused')),
    };

    const socketPath = startServer(bin, ours);
    sockets.push(socketPath, startServer(bin, unknown));
    expect(serverAlive(bin, ours)).toBe(true);

    // A stand-in Claude whose command line carries `claude.exe` and the session id (identity rule, LC §6.3).
    const sid = '0000beef-0000-4000-8000-000000000001';
    const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'claude.exe', '--session-id', sid], {
      stdio: 'ignore',
      detached: true,
    });
    children.push(fake);
    const fakePid = fake.pid ?? 0;
    expect(await until(() => fakePid > 0, 2000)).toBe(true);
    let ident = await proc.identity(fakePid);
    for (let i = 0; i < 20 && ident?.command.includes(sid) !== true; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ident = await proc.identity(fakePid);
    }
    expect(ident?.command).toContain('claude.exe');

    // A dead owner: a process that already exited.
    const gone = spawn('/usr/bin/true', [], { stdio: 'ignore' });
    await new Promise((r) => gone.on('exit', r));
    const sessionDir = await runtimeDir.createSessionDir();
    const key = 's0000beef' as SessionKey;
    const now = clock.wallNow();
    const rec: SessionRecord = {
      v: 2,
      sessionKey: key,
      owner: { pid: gone.pid ?? 1, startTime: 'Thu Jan  1 00:00:00 1970' },
      tmux: { bin, socketName: ours, socketPath, sessionName: 'x' },
      claude: { pid: fakePid, startTime: ident?.startTime ?? '', exe: '/x/claude.exe', version: '2.1.316' },
      claudeSessionId: sid,
      initialSessionId: sid,
      cwdRealpath: dir,
      sessionDir,
      settingsFile: join(sessionDir, 'settings.json'),
      settingsSha256: '00'.repeat(32),
      hook: { transport: 'unix', socketPath: join(sessionDir, 'h.sock') },
      trustKeyAddedByLibrary: false,
      permissionMode: 'default',
      state: 'ready',
      lastEventSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    await store.writeSession(rec);

    const report = await reap(
      { process: proc, clock, env, runtimeDir, claudeConfig, logger: new MemoryLogger(), store },
      { selfPid: process.pid, socketProbeGapMs: 200, termGraceMs: 5000 },
    );

    expect(report.errors).toEqual([]);
    expect(report.reaped).toHaveLength(1);
    expect(report.reaped[0]).toMatchObject({ sessionKey: key, claude: 'terminated', server: 'killed', sessionDirRemoved: true });
    expect(await until(() => fake.exitCode !== null || fake.signalCode !== null, 3000)).toBe(true);
    expect(serverAlive(bin, ours)).toBe(false);
    expect(await until(() => !existsSync(socketPath), 3000)).toBe(true);
    expect(existsSync(sessionDir)).toBe(false);
    // P-REV-33 / P-LIFE-45: the unknown ccd-* server is never touched, only counted
    expect(serverAlive(bin, unknown)).toBe(true);
    expect(report.sockets.unknownCctSockets).toBeGreaterThanOrEqual(1);
    expect((await store.readArchive(key))?.state).toBe('reaped');
    expect(await store.readSession(key)).toBeUndefined();
    expect((await store.listOwners()).length).toBe(0);
  });
});
