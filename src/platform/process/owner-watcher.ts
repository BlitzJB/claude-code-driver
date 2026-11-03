// platform/process/owner-watcher.ts — OwnerWatchFactory (DESIGN.md §2.7.1, §3.8, D-28): spawns the owner-watch standalone
// detached (one per session) and stops it with SIGTERM on a normal close.
// The watcher's argv holds only the path of the 0600 watch.json (no secrets in argv, P-SEC-18). Its env is minimal and never
// contains NODE_OPTIONS (P-SEC-38); TMUX_TMPDIR is passed through so `-L <socketName>` finds the same socket dir.
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Clock } from '../../model/time.js';
import type { OwnerWatchFactory, ProcessPort } from '../ports.js';
import { OwnerWatchStartFailed } from './errors.js';
import { resolveStandaloneScript } from './standalone-path.js';
import { parseWatchConfig } from './standalone/owner-watch.js';

const STOP_GRACE_MS = 2_000;
const STOP_POLL_MS = 25;

export interface OwnerWatchFactoryOptions {
  process: ProcessPort;
  clock: Clock;
  /** Node binary (default process.execPath). */
  nodePath?: string;
  /** Script path (default: standalone/owner-watch.{js,ts} next to this module). */
  scriptPath?: string;
  /** Host env snapshot; only TMUX_TMPDIR, HOME and TMPDIR are forwarded. */
  hostEnv?: Readonly<Record<string, string>>;
}

export function createOwnerWatchFactory(o: OwnerWatchFactoryOptions): OwnerWatchFactory {
  const nodePath = o.nodePath ?? process.execPath;
  const scriptPath = o.scriptPath ?? resolveStandaloneScript(import.meta.url, './standalone/owner-watch');

  return {
    async start({ configPath, logPath }) {
      if (!isAbsolute(configPath) || !isAbsolute(logPath)) throw new OwnerWatchStartFailed('paths must be absolute');
      await assertPrivateFile(configPath);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(configPath, 'utf8'));
      } catch {
        throw new OwnerWatchStartFailed('watch.json unreadable');
      }
      const cfg = parseWatchConfig(raw);
      if (typeof cfg === 'string') throw new OwnerWatchStartFailed(`watch.json invalid: ${cfg}`);

      const env: Record<string, string> = { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' };
      for (const k of ['TMUX_TMPDIR', 'HOME', 'TMPDIR'] as const) {
        const v = o.hostEnv?.[k];
        if (v !== undefined && v !== '') env[k] = v;
      }
      const { pid } = await o.process.spawnDetached(nodePath, [scriptPath, configPath], { env, logPath });

      let stopped = false;
      return {
        pid,
        async stop() {
          if (stopped) return;
          stopped = true;
          if (!o.process.isAlive(pid)) return;
          // Never signal a recycled pid: the process must still be our node running this script on this config.
          const id = await o.process.identity(pid);
          if (id !== undefined && !(id.command.includes(scriptPath) && id.command.includes(configPath))) return;
          o.process.kill(pid, 'SIGTERM');
          const until = o.clock.now() + STOP_GRACE_MS;
          while (o.process.isAlive(pid) && o.clock.now() < until) await o.clock.sleep(STOP_POLL_MS);
          if (o.process.isAlive(pid)) o.process.kill(pid, 'SIGKILL');
        },
      };
    },
  };
}

async function assertPrivateFile(p: string): Promise<void> {
  let st;
  try {
    st = await lstat(p);
  } catch {
    throw new OwnerWatchStartFailed('watch.json missing');
  }
  if (!st.isFile() || st.isSymbolicLink()) throw new OwnerWatchStartFailed('watch.json is not a regular file');
  if ((st.mode & 0o077) !== 0) throw new OwnerWatchStartFailed('watch.json must be 0600');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new OwnerWatchStartFailed('watch.json not owned by us');
}
