// platform/settings/claude-config.ts — ClaudeConfigPort (DESIGN.md §2.7.2, D-19, §3.1 steps 6–7).
// Global config (`~/.claude.json`) rules (P-LIFE-27, P-LIVE-12, lifecycle.md §1.2):
//   - every change starts from a FRESH read and touches exactly one key: projects[<realCwd>].hasTrustDialogAccepted;
//     no other key is ever added, dropped or rewritten (Claude's config guard treats a dropped oauthAccount or a flipped
//     hasCompletedOnboarding as corruption);
//   - write = tmp file in the same (real) directory with the original mode (never widened) → fsync → rename onto the real
//     path (a symlinked ~/.claude.json keeps its link); indentation and trailing newline are preserved;
//   - Claude rewrites the file often: before the rename the file is read again and the merge is redone if it changed
//     (optimistic concurrency, bounded attempts). A tiny window between that check and the rename remains (documented);
//   - unseed removes only `hasTrustDialogAccepted`, never the project entry (Claude writes lastSessionId etc. there).
// Trust lookup mirrors the binary (VERIFIED-BIN zh()/jh()): cwd and each ancestor up to the git root (or `/` outside git)
// with `hasTrustDialogAccepted === true`. The binary's "rootOnly" repo kind is not detectable from the file system here, so
// a rootOnly repo may be reported trusted where Claude still shows the dialog; that case is caught at startup by the
// trust-dialog gate (E_TRUST_REQUIRED, K-02), never answered with keys.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ClaudeConfigPort, EnvPort } from '../ports.js';
import { isNoEnt } from '../runtime-dir/dir-checks.js';
import { ClaudeConfigBusy, ClaudeConfigUnreadable } from './errors.js';
import { isPlainObject } from './lenient-json.js';
import { ancestorsUpTo, claudePaths, findGitRoot } from './paths.js';
import { readSettingsLayers } from './settings-layers.js';
import { inspectWorkspaceDirs } from './workspace-inspector.js';

const MERGE_ATTEMPTS = 5;
export const TRUST_KEY = 'hasTrustDialogAccepted';

export interface ClaudeConfigOptions {
  env: Pick<EnvPort, 'snapshot' | 'homeDir'>;
  /** Override the global config path (tests). */
  globalConfigPath?: string;
  /** Override the Claude config dir (tests). */
  configDir?: string;
  /** Test seam: runs after the tmp file is written and before the unchanged-check (simulates a concurrent writer). */
  beforeCommit?: (attempt: number) => Promise<void>;
}

/** Detect the indentation unit of a JSON text (first indented line); default two spaces. */
export function detectIndent(text: string): string | number {
  const m = /^\{\s*\n([ \t]+)\S/.exec(text);
  return m?.[1] ?? 2;
}

/** Trust lookup on an already parsed config object (shared with the fake). */
export function trustLookup(config: unknown, realCwd: string, gitRoot: string | undefined): { trusted: boolean; viaPath?: string } {
  if (!isPlainObject(config)) return { trusted: false };
  const projects = config['projects'];
  if (!isPlainObject(projects)) return { trusted: false };
  const stop = gitRoot !== undefined && (realCwd === gitRoot || realCwd.startsWith(`${gitRoot}/`)) ? gitRoot : undefined;
  for (const dir of ancestorsUpTo(realCwd, stop)) {
    const entry = projects[dir];
    if (isPlainObject(entry) && entry[TRUST_KEY] === true) return { trusted: true, viaPath: dir };
  }
  return { trusted: false };
}

export function createClaudeConfigPort(o: ClaudeConfigOptions): ClaudeConfigPort {
  const paths = (): { configDir: string; globalConfig: string } => {
    const p = claudePaths(o.env.snapshot(), o.env.homeDir());
    return { configDir: o.configDir ?? p.configDir, globalConfig: o.globalConfigPath ?? p.globalConfig };
  };

  const readConfigText = async (): Promise<{ path: string; text: string } | { error: 'missing' }> => {
    const { globalConfig } = paths();
    try {
      return { path: globalConfig, text: await readFile(globalConfig, 'utf8') };
    } catch (e) {
      if (isNoEnt(e)) return { error: 'missing' };
      throw e;
    }
  };

  /** Fresh-read → mutate → verify-unchanged → atomic replace. `fn` returns false when nothing needs writing. */
  const mutate = async (fn: (cfg: Record<string, unknown>) => boolean, at?: string): Promise<boolean> => {
    const globalConfig = at ?? paths().globalConfig;
    let real: string;
    try {
      real = await realpath(globalConfig);
    } catch (e) {
      if (isNoEnt(e)) throw new ClaudeConfigUnreadable(globalConfig, 'missing');
      throw e;
    }
    for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt++) {
      const st = await stat(real);
      const text = await readFile(real, 'utf8');
      let cfg: unknown;
      try {
        cfg = JSON.parse(text);
      } catch {
        throw new ClaudeConfigUnreadable(globalConfig, 'invalidJson');
      }
      if (!isPlainObject(cfg)) throw new ClaudeConfigUnreadable(globalConfig, 'notObject');
      if (!fn(cfg)) return false;
      const out = `${JSON.stringify(cfg, null, detectIndent(text))}${text.endsWith('\n') ? '\n' : ''}`;
      const tmp = join(dirname(real), `.${basename(real)}.ccd-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
      const mode = st.mode & 0o777; // the original permission bits, exactly (never widened)
      const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await fh.chmod(mode);
        await fh.writeFile(out, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await o.beforeCommit?.(attempt);
      const now = await readFile(real, 'utf8').catch(() => undefined);
      if (now !== text) {
        await unlink(tmp).catch(() => undefined);
        continue; // another writer (usually Claude) got in between: redo the merge on its version
      }
      try {
        await rename(tmp, real);
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        throw e;
      }
      return true;
    }
    throw new ClaudeConfigBusy(globalConfig, MERGE_ATTEMPTS);
  };

  return {
    async readGlobal() {
      const r = await readConfigText();
      if ('error' in r) return { ok: false, reason: 'missing' };
      let cfg: unknown;
      try {
        cfg = JSON.parse(r.text);
      } catch {
        return { ok: false, reason: 'invalidJson' };
      }
      if (!isPlainObject(cfg)) return { ok: false, reason: 'invalidJson' };
      return { ok: true, hasCompletedOnboarding: cfg['hasCompletedOnboarding'] === true };
    },

    async trustOf(realCwd) {
      const r = await readConfigText();
      if ('error' in r) return { trusted: false };
      let cfg: unknown;
      try {
        cfg = JSON.parse(r.text);
      } catch {
        return { trusted: false };
      }
      return trustLookup(cfg, realCwd, findGitRoot(realCwd));
    },

    globalConfigPath() {
      return paths().globalConfig;
    },

    async seedTrust(realCwd, so = {}) {
      const file = so.globalConfigPath ?? paths().globalConfig;
      // The key is an absolute realpath, so it can never be `__proto__`/`constructor`; refuse anything else outright.
      if (!realCwd.startsWith('/')) throw new ClaudeConfigUnreadable(file, 'cwdNotAbsolute');
      const added = await mutate((cfg) => {
        let projects = cfg['projects'];
        if (projects === undefined) {
          projects = {};
          cfg['projects'] = projects;
        }
        if (!isPlainObject(projects)) throw new ClaudeConfigUnreadable(file, 'projectsNotObject');
        const entry = projects[realCwd];
        if (isPlainObject(entry)) {
          if (entry[TRUST_KEY] === true) return false;
          entry[TRUST_KEY] = true;
        } else if (entry === undefined) projects[realCwd] = { [TRUST_KEY]: true };
        else throw new ClaudeConfigUnreadable(file, 'projectsNotObject');
        return true;
      }, file);
      return { added };
    },

    async unseedTrust(realCwd, uo = {}) {
      if (!realCwd.startsWith('/')) return;
      await mutate((cfg) => {
        const projects = cfg['projects'];
        if (!isPlainObject(projects)) return false;
        const entry = projects[realCwd];
        if (!isPlainObject(entry) || !(TRUST_KEY in entry)) return false;
        Reflect.deleteProperty(entry, TRUST_KEY);
        return true;
      }, uo.globalConfigPath);
    },

    readLayers(realCwd) {
      return readSettingsLayers({ configDir: paths().configDir, realCwd });
    },

    inspectWorkspace(realCwd) {
      return inspectWorkspaceDirs({ realCwd, gitRoot: findGitRoot(realCwd), configDir: paths().configDir });
    },
  };
}
