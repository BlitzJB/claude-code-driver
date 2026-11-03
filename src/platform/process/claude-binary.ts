// platform/process/claude-binary.ts — ClaudeBinaryPort (DESIGN.md §2.7.1, §3.1 step 5/6).
// resolve order: option → <consumer>/node_modules/@anthropic-ai/claude-code/bin/claude.exe (walking up from the consumer
// dir) → the same below this package → `which claude` (PATH + known dirs). A `/bin/sh` shim (node_modules/.bin/claude) is
// followed to the `claude.exe` it execs (P-LIFE-47: the shim runs `uname` and would make `pane_pid` a shell).
// authStatus runs with a 10 s timeout and is NEVER killed (P-LIFE-38).
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeBinaryPort, ProcessPort } from '../ports.js';
import { ClaudeAuthStatusUnreadable, ClaudeVersionUnreadable } from './errors.js';
import { isExecutableFile, KNOWN_BIN_DIRS } from './which.js';

export const CLAUDE_EXE_REL = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
export const VERSION_TIMEOUT_MS = 10_000;
export const AUTH_STATUS_TIMEOUT_MS = 10_000;
const SHIM_MAX_BYTES = 64 * 1024;

export interface ClaudeBinaryOptions {
  process: ProcessPort;
  /** Consumer project dir searched (and its ancestors) for node_modules/@anthropic-ai/claude-code (default process.cwd()). */
  consumerDir?: string;
  /** This package's dir (default: derived from this module's location). */
  packageDir?: string;
  extraDirs?: readonly string[];
}

export function createClaudeBinaryPort(o: ClaudeBinaryOptions): ClaudeBinaryPort {
  const consumerDir = o.consumerDir ?? process.cwd();
  const packageDir = o.packageDir ?? dirname(fileURLToPath(import.meta.url));
  const extraDirs = o.extraDirs ?? KNOWN_BIN_DIRS;

  return {
    async resolve(option) {
      if (option !== undefined && option !== '') {
        const p = isAbsolute(option) ? option : resolve(consumerDir, option);
        const exe = await followToBinary(p);
        return exe === undefined ? undefined : { exe, via: 'option' };
      }
      const fromConsumer = await findUpwards(consumerDir, CLAUDE_EXE_REL);
      if (fromConsumer !== undefined) return { exe: fromConsumer, via: 'consumer' };
      const fromPackage = await findUpwards(packageDir, CLAUDE_EXE_REL);
      if (fromPackage !== undefined) return { exe: fromPackage, via: 'package' };
      const onPath = await o.process.which('claude', extraDirs);
      if (onPath !== undefined) {
        const exe = await followToBinary(onPath);
        if (exe !== undefined) return { exe, via: 'path' };
      }
      return undefined;
    },

    async version(exe, env) {
      const r = await o.process.exec(exe, ['--version'], { env, timeoutMs: VERSION_TIMEOUT_MS, killOnTimeout: true });
      const v = parseClaudeVersion(r.stdout);
      if (v === undefined) throw new ClaudeVersionUnreadable(exe, r.code, r.timedOut);
      return v;
    },

    async authStatus(exe, env) {
      const r = await o.process.exec(exe, ['auth', 'status', '--json'], {
        env,
        timeoutMs: AUTH_STATUS_TIMEOUT_MS,
        killOnTimeout: false,
      });
      if (r.timedOut) throw new ClaudeAuthStatusUnreadable('timeout', r.code);
      const parsed = parseAuthStatus(r.stdout);
      if (parsed === undefined) throw new ClaudeAuthStatusUnreadable('unparseable', r.code);
      return parsed;
    },
  };
}

/** `2.1.316 (Claude Code)` → `2.1.316`. */
export function parseClaudeVersion(stdout: string): string | undefined {
  const m = /^\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s+\(Claude Code\)/m.exec(stdout);
  return m?.[1];
}

/**
 * The fields the preflight needs from `auth status --json`; email/org are dropped here so they never travel further.
 * `loggedIn` must be a boolean, otherwise the output is not an auth status.
 */
export function parseAuthStatus(
  stdout: string,
): { loggedIn: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string } | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r['loggedIn'] !== 'boolean') return undefined;
  const out: { loggedIn: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string } = {
    loggedIn: r['loggedIn'],
  };
  if (typeof r['authMethod'] === 'string') out.authMethod = r['authMethod'];
  if (typeof r['apiProvider'] === 'string') out.apiProvider = r['apiProvider'];
  if (typeof r['subscriptionType'] === 'string') out.subscriptionType = r['subscriptionType'];
  return out;
}

async function findUpwards(start: string, rel: string): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    const p = join(dir, rel);
    if (await isExecutableFile(p)) return realpath(p).catch(() => p);
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Resolve symlinks; if the target is a `#!` script (the npm/pnpm `.bin` shim), follow its `exec "<…>/claude.exe"` line or its
 * `# cmd-shim-target=` comment to the real binary. A native binary is returned as its realpath. `undefined` when the result is
 * not an executable regular file.
 */
export async function followToBinary(p: string): Promise<string | undefined> {
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    return undefined;
  }
  if (!(await isExecutableFile(real))) return undefined;
  const head = await readHead(real, SHIM_MAX_BYTES);
  if (!head?.startsWith('#!')) return real;
  const target = shimTarget(head, dirname(real));
  if (target === undefined) return undefined;
  try {
    const t = await realpath(target);
    return (await isExecutableFile(t)) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the shim text for the binary it execs; `$basedir` is the shim's own (symlink-resolved) directory. */
export function shimTarget(text: string, basedir: string): string | undefined {
  const cmdShim = /^# cmd-shim-target=(.+)$/m.exec(text);
  if (cmdShim?.[1] !== undefined && isAbsolute(cmdShim[1].trim())) return cmdShim[1].trim();
  const m = /^\s*exec\s+"\$basedir\/([^"$`]+)"/m.exec(text) ?? /^\s*exec\s+"([^"$`]*claude(?:\.exe)?)"/m.exec(text);
  if (m?.[1] === undefined) return undefined;
  return isAbsolute(m[1]) ? m[1] : resolve(basedir, m[1]);
}

async function readHead(p: string, max: number): Promise<string | undefined> {
  try {
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(max);
      const { bytesRead } = await fh.read(buf, 0, max, 0);
      const b = buf.subarray(0, bytesRead);
      // Native binaries contain NUL bytes early; only treat UTF-8 text as a script.
      if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return b.toString('utf8');
      return '';
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}
