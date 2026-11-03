// platform/settings/paths.ts — where Claude 2.1.316 keeps its user-level files, and the git-root walk used by the trust
// lookup and the workspace inspector (VERIFIED-BIN `UI()`/`zh()`/`jh()`, tui-known-issues §4.1).
//   config dir   = $CLAUDE_CONFIG_DIR, else ~/.claude        (settings.json, keybindings.json, sessions/)
//   global file  = <config dir>/.config.json if it exists (legacy), else ($CLAUDE_CONFIG_DIR or ~)/.claude.json
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ClaudePaths {
  configDir: string;
  globalConfig: string;
}

export function claudePaths(env: Readonly<Record<string, string>>, home: string): ClaudePaths {
  const custom = env['CLAUDE_CONFIG_DIR'];
  const configDir = custom !== undefined && custom !== '' ? resolve(custom) : join(home, '.claude');
  const legacy = join(configDir, '.config.json');
  const globalConfig = existsSync(legacy) ? legacy : join(custom !== undefined && custom !== '' ? resolve(custom) : home, '.claude.json');
  return { configDir, globalConfig };
}

/** Nearest ancestor (inclusive) holding a `.git` entry (dir, or file for worktrees/submodules); `undefined` outside git. */
export function findGitRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** `start` and its ancestors up to and including `stop` (or the filesystem root when `stop` is undefined). */
export function ancestorsUpTo(start: string, stop: string | undefined): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (;;) {
    out.push(dir);
    if (stop !== undefined && dir === stop) return out;
    const up = dirname(dir);
    if (up === dir) return out;
    dir = up;
  }
}
