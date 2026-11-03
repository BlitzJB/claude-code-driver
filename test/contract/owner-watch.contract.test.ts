// Runs the owner-watch contract against FakeOwnerWatchFactory and the real standalone with real processes and a private
// tmux server (`-L ccd-ctest-<pid>-<hex>`, killed in cleanup). No Claude binary is involved: "Claude" is a node process
// whose command line contains `claude.exe --session-id <id>`.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealClock } from '../../src/platform/clock/real-clock.js';
import { FakeOwnerWatchFactory } from '../../src/platform/process/fake-owner-watch.js';
import { FakeProcess } from '../../src/platform/process/fake-process.js';
import { createOwnerWatchFactory } from '../../src/platform/process/owner-watcher.js';
import { createProcessPort } from '../../src/platform/process/process-port.js';
import { KNOWN_BIN_DIRS, which } from '../../src/platform/process/which.js';
import { ownerWatchContract, type OwnerWatchHarness } from './owner-watch.contract.js';

ownerWatchContract('fake', () => {
  const fp = new FakeProcess();
  const configs = new Map<string, unknown>();
  const servers = new Set<string>();
  let exits = '';
  let n = 0;
  const h: OwnerWatchHarness = {
    factory: new FakeOwnerWatchFactory({
      process: fp,
      readConfig: (p) => configs.get(p),
      onKillServer: (c) => servers.delete(c.socketName),
      appendExit: (_p, line) => (exits += `${line}\n`),
    }),
    spawnOwner: () => Promise.resolve(proc(fp.addProcess({ command: 'node host.js' }))),
    spawnClaude: (sid) => Promise.resolve(proc(fp.addProcess({ command: `/x/bin/claude.exe --session-id ${sid}` }))),
    spawnImpostor: () => Promise.resolve(proc(fp.addProcess({ command: '/usr/bin/vim notes.txt' }))),
    startServer: () => {
      const socketName = `ccd-fake-${++n}`;
      servers.add(socketName);
      return Promise.resolve({ socketName, tmuxBin: '/usr/bin/tmux' });
    },
    serverAlive: (s) => Promise.resolve(servers.has(s)),
    kill: (pid, sig) => {
      fp.kill(pid, sig);
    },
    isAlive: (pid) => fp.isAlive(pid),
    writeConfig: (cfg) => {
      const configPath = `/fake/run/ccd-00000${++n}/watch.json`;
      configs.set(configPath, cfg);
      return Promise.resolve({ configPath, logPath: `${configPath}.log` });
    },
    exitsLogPath: () => '/fake/state/exits/s.log',
    readExits: () => Promise.resolve(exits),
    cleanup: () => Promise.resolve(),
  };
  function proc(pid: number) {
    return { pid, start: fp.procs.get(pid)?.startTime ?? '' };
  }
  return Promise.resolve(h);
});

ownerWatchContract('real standalone + tmux', async () => {
  const tmuxBin = await which('tmux', { pathEnv: process.env['PATH'], extraDirs: KNOWN_BIN_DIRS });
  if (tmuxBin === undefined) throw new Error('tmux is required for the owner-watch contract test');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-owc-')));
  chmodSync(dir, 0o700);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const fakeClaude = join(binDir, 'claude.exe');
  writeFileSync(fakeClaude, 'process.on("SIGHUP",()=>{});setInterval(()=>{},1e6);\n');
  const clock = createRealClock();
  const port = createProcessPort({ clock });
  const children: ChildProcess[] = [];
  const sockets: string[] = [];
  const watchers: number[] = [];
  let n = 0;

  const start = async (args: string[]) => {
    const c = spawn(process.execPath, args, { stdio: 'ignore' });
    children.push(c);
    await new Promise((r) => c.once('spawn', r));
    const pid = c.pid ?? 0;
    let id = await port.identity(pid);
    for (let i = 0; i < 20 && id === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
      id = await port.identity(pid);
    }
    return { pid, start: id?.startTime ?? '' };
  };
  const tmux = (args: string[]) =>
    new Promise<number>((res) => {
      execFile(tmuxBin, args, { env: { ...process.env, TMUX: '' }, timeout: 5_000 }, (err) => {
        res(err === null ? 0 : typeof err.code === 'number' ? err.code : 1);
      });
    });

  const real = createOwnerWatchFactory({ process: port, clock, hostEnv: { ...(process.env as Record<string, string>) } });
  const h: OwnerWatchHarness = {
    factory: {
      start: async (o) => {
        const w = await real.start(o);
        watchers.push(w.pid);
        return w;
      },
    },
    spawnOwner: () => start(['-e', 'setInterval(()=>{},1e6)', 'ccd-test-owner']),
    spawnClaude: (sid) => start([fakeClaude, '--session-id', sid]),
    spawnImpostor: () => start(['-e', 'setInterval(()=>{},1e6)', 'not-the-agent']),
    startServer: async () => {
      const socketName = `ccd-ctest-${process.pid}-${randomBytes(4).toString('hex')}`;
      sockets.push(socketName);
      const code = await tmux(['-L', socketName, '-f', '/dev/null', 'new-session', '-d', '-s', 'w', 'sleep 600']);
      if (code !== 0) throw new Error(`tmux new-session failed (${code})`);
      return { socketName, tmuxBin };
    },
    serverAlive: async (s) => (await tmux(['-L', s, 'list-sessions'])) === 0,
    kill: (pid, sig) => {
      try {
        process.kill(pid, sig);
      } catch {
        // gone
      }
    },
    isAlive: (pid) => {
      // Our own children are judged by their exit event (a not-yet-reaped zombie still answers kill(pid, 0)).
      const c = children.find((x) => x.pid === pid);
      return c !== undefined ? c.exitCode === null && c.signalCode === null : port.isAlive(pid);
    },
    writeConfig: (cfg) => {
      const configPath = join(dir, `watch-${++n}.json`);
      writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
      chmodSync(configPath, 0o600);
      return Promise.resolve({ configPath, logPath: join(dir, `watch-${n}.log`) });
    },
    exitsLogPath: () => join(dir, 'exits.log'),
    readExits: () => Promise.resolve(existsSync(join(dir, 'exits.log')) ? readFileSync(join(dir, 'exits.log'), 'utf8') : ''),
    cleanup: async () => {
      for (const pid of watchers) port.kill(pid, 'SIGKILL');
      for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      const sockDir = join(process.env['TMUX_TMPDIR'] ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`);
      for (const s of sockets) {
        await tmux(['-L', s, 'kill-server']);
        try {
          unlinkSync(join(sockDir, s));
        } catch {
          // already removed by tmux
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
});
