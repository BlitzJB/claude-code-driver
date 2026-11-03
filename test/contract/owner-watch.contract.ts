// Shared contract for the owner-watch (DESIGN.md §3.8, D-28, §6.4 owner-watch row):
//   owner SIGKILL → Claude + private tmux server gone ≤ 2 s; Claude pid reused by a non-Claude process → not killed;
//   Claude exits first → `watch=claude-gone`, nothing killed; normal stop() → no action later;
//   watcher SIGKILL → no side effect (the reaper is the backstop, P-REV-46).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerWatchFactory } from '../../src/platform/ports.js';

interface WatchedProc {
  pid: number;
  start: string;
}

export interface OwnerWatchHarness {
  factory: OwnerWatchFactory;
  spawnOwner(): Promise<WatchedProc>;
  /** A process whose command line contains `claude.exe` and the session id. */
  spawnClaude(sessionId: string): Promise<WatchedProc>;
  /** A process that is NOT Claude (pid reuse stand-in). */
  spawnImpostor(): Promise<WatchedProc>;
  startServer(): Promise<{ socketName: string; tmuxBin: string }>;
  serverAlive(socketName: string): Promise<boolean>;
  kill(pid: number, sig: 'SIGKILL' | 'SIGTERM'): void;
  isAlive(pid: number): boolean;
  /** Writes watch.json (0600) and returns its path plus log/exit paths. */
  writeConfig(cfg: Record<string, unknown>): Promise<{ configPath: string; logPath: string }>;
  exitsLogPath(): string;
  readExits(): Promise<string>;
  cleanup(): Promise<void>;
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 20): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return -1;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function ownerWatchContract(label: string, make: () => Promise<OwnerWatchHarness>): void {
  describe(`owner-watch contract: ${label}`, () => {
    let h: OwnerWatchHarness;
    const sid = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    async function arm(o: { claude?: WatchedProc; pollMs?: number } = {}) {
      const owner = await h.spawnOwner();
      const claude = o.claude ?? (await h.spawnClaude(sid));
      const server = await h.startServer();
      const { configPath, logPath } = await h.writeConfig({
        ownerPid: owner.pid,
        ownerStart: owner.start,
        claudePid: claude.pid,
        claudeStart: claude.start,
        claudeExeSubstr: 'claude.exe',
        sessionIdSubstr: sid,
        tmuxBin: server.tmuxBin,
        socketName: server.socketName,
        pollMs: o.pollMs ?? 200,
        exitsLog: h.exitsLogPath(),
      });
      const watch = await h.factory.start({ configPath, logPath });
      return { owner, claude, server, watch };
    }

    it('owner SIGKILL → Claude and the tmux server are gone within 2 s (pollMs 1000)', async () => {
      const { owner, claude, server, watch } = await arm({ pollMs: 1000 });
      await new Promise((r) => setTimeout(r, 50));
      h.kill(owner.pid, 'SIGKILL');
      const claudeMs = await waitUntil(() => !h.isAlive(claude.pid), 2_500);
      const serverMs = await waitUntil(async () => !(await h.serverAlive(server.socketName)), 2_500);
      expect(claudeMs).toBeGreaterThanOrEqual(0);
      expect(claudeMs).toBeLessThanOrEqual(2_000);
      expect(serverMs).toBeGreaterThanOrEqual(0);
      expect(serverMs).toBeLessThanOrEqual(2_000);
      expect(await waitUntil(async () => (await h.readExits()).includes('watch=owner-gone'), 2_000)).toBeGreaterThanOrEqual(0);
      expect(await h.readExits()).toMatch(/claude=(terminated|killed)/);
      expect(await waitUntil(() => !h.isAlive(watch.pid), 2_000)).toBeGreaterThanOrEqual(0);
    });

    it('a Claude pid that now belongs to a non-Claude process is never signalled; the server is still killed', async () => {
      const impostor = await h.spawnImpostor();
      const { owner, server } = await arm({ claude: impostor });
      h.kill(owner.pid, 'SIGKILL');
      expect(await waitUntil(async () => (await h.readExits()).includes('watch=owner-gone'), 3_000)).toBeGreaterThanOrEqual(0);
      expect(await h.readExits()).toContain('claude=identity-mismatch');
      expect(h.isAlive(impostor.pid)).toBe(true);
      expect(await waitUntil(async () => !(await h.serverAlive(server.socketName)), 2_000)).toBeGreaterThanOrEqual(0);
    });

    it('Claude exits first → watch=claude-gone, the watcher exits, nothing else is touched', async () => {
      const { owner, claude, server, watch } = await arm();
      h.kill(claude.pid, 'SIGKILL');
      expect(await waitUntil(async () => (await h.readExits()).includes('watch=claude-gone'), 3_000)).toBeGreaterThanOrEqual(0);
      expect(await waitUntil(() => !h.isAlive(watch.pid), 2_000)).toBeGreaterThanOrEqual(0);
      expect(h.isAlive(owner.pid)).toBe(true);
      expect(await h.serverAlive(server.socketName)).toBe(true);
    });

    it('stop() (normal close) → a later owner death triggers no action', async () => {
      const { owner, claude, server, watch } = await arm();
      await watch.stop();
      expect(await waitUntil(() => !h.isAlive(watch.pid), 2_000)).toBeGreaterThanOrEqual(0);
      h.kill(owner.pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 600));
      expect(h.isAlive(claude.pid)).toBe(true);
      expect(await h.serverAlive(server.socketName)).toBe(true);
      expect(await h.readExits()).not.toContain('watch=');
    });

    it('watcher SIGKILL → no side effect; Claude survives the owner (reaper backstop, P-REV-46)', async () => {
      const { owner, claude, server, watch } = await arm();
      h.kill(watch.pid, 'SIGKILL');
      expect(await waitUntil(() => !h.isAlive(watch.pid), 2_000)).toBeGreaterThanOrEqual(0);
      h.kill(owner.pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 600));
      expect(h.isAlive(claude.pid)).toBe(true);
      expect(await h.serverAlive(server.socketName)).toBe(true);
    });
  });
}
