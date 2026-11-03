// cli/node-host.ts — real (node:*) hosts for the cli commands that do not touch the session registry's mutation paths:
// `lifecheck install|uninstall|status` (files + launchctl), `view` (registry read + an inherited-stdio tmux client) and
// `trace` (file read). Reaping goes through `lifecheck-host.ts` (reaper + registry store + createNodePorts, §3.12).

import { spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InstallHost, SessionRecord } from './host.js';
import { parseSessionRecord } from './host.js';
import type { ViewHost } from './view.js';

export const STATE_DIR_NAME = 'claude-code-driver';

/** `${XDG_STATE_HOME:-~/.local/state}/claude-code-driver` (D-38). A relative XDG_STATE_HOME is ignored (XDG spec). */
export function defaultStateDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const xdg = env['XDG_STATE_HOME'];
  const base = xdg?.startsWith('/') ? xdg : join(home, '.local', 'state');
  return join(base, STATE_DIR_NAME);
}

/** `dist/cli/main.js` of this installation (the file next to this module). */
export function ownDistPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'main.js');
}

export function processEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

function platformName(): InstallHost['platform'] {
  return process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'other';
}

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, mode);
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, mode); // umask may have narrowed the create mode; the plist must be exactly 0644
  await rename(tmp, path);
}

export function runCommand(file: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: processEnv() });
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      resolve({ code: null, stdout, stderr: stderr + e.message });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export function createInstallHost(stateDir: string): InstallHost {
  return {
    stateDir,
    homeDir: homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    platform: platformName(),
    nodePath: process.execPath,
    distPath: ownDistPath(),
    nowWall: () => Date.now(),
    exists: async (p) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    },
    readText: async (p) => {
      try {
        return await readFile(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: writeAtomic,
    touch: async (p, mode) => {
      await mkdir(dirname(p), { recursive: true, mode: 0o700 });
      const fh = await open(p, FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND, mode);
      await fh.close();
      await chmod(p, mode);
    },
    remove: async (p) => {
      await rm(p, { force: true });
    },
    run: runCommand,
    // A blocking wait, not an event-loop timer: `install` is a one-shot interactive command, and the adapter-timer list
    // (§4.12, test/arch/timers.test.ts) stays closed.
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return Promise.resolve();
    },
  };
}

const KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Reads `sessions/<key>.json` (live entries only; `archive/` sessions are dead, there is nothing to view). */
export async function readSessionRecord(stateDir: string, key: string): Promise<SessionRecord | 'missing' | { error: string }> {
  if (!KEY.test(key)) return { error: 'invalid key' };
  const p = join(stateDir, 'sessions', `${key}.json`);
  let text: string;
  try {
    const st = await stat(p);
    if (!st.isFile()) return { error: 'not a regular file' };
    text = await readFile(p, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : { error: (e as Error).message };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'invalid JSON' };
  }
  const r = parseSessionRecord(key, json);
  return 'record' in r ? r.record : { error: r.error };
}

export function createViewHost(stateDir: string): ViewHost {
  return {
    readSession: (key) => readSessionRecord(stateDir, key),
    env: processEnv,
    execInteractive: (file, args, env) =>
      new Promise((resolve) => {
        const child = spawn(file, args, { stdio: 'inherit', env: { ...env } });
        child.on('error', (e) => {
          process.stderr.write(`ccd view: ${e.message}\n`);
          resolve(127);
        });
        child.on('close', (code, signal) => {
          resolve(code ?? (signal === null ? 1 : 128));
        });
      }),
  };
}
