// platform/settings/fake-config.ts — in-memory ClaudeConfigPort and SettingsFilePort (DESIGN.md §2.7.2, §8 "fakes live with
// their real adapter"). Same single-key seed/unseed semantics and the same trust walk as the real adapter.
import type { ClaudeConfigPort, SettingsFilePort, SettingsLayers, WorkspaceRisk } from '../ports.js';
import { trustLookup, TRUST_KEY } from './claude-config.js';
import { ClaudeConfigUnreadable, SettingsFileExists } from './errors.js';
import { isPlainObject } from './lenient-json.js';
import { serializeJsonFile, sha256Hex } from './settings-file.js';

export interface FakeClaudeConfigOptions {
  /** The parsed global config; `'missing'` / `'invalidJson'` simulate a broken file. */
  global?: Record<string, unknown> | 'missing' | 'invalidJson';
  layers?: Partial<SettingsLayers>;
  risk?: WorkspaceRisk;
  /** Directories that are git roots (bounds the trust walk). */
  gitRoots?: readonly string[];
  /** What `globalConfigPath()` reports for `global` (default `/fake/home/.claude.json`). */
  globalPath?: string;
}

export const FAKE_GLOBAL_CONFIG_PATH = '/fake/home/.claude.json';

export class FakeClaudeConfig implements ClaudeConfigPort {
  global: Record<string, unknown> | 'missing' | 'invalidJson';
  layers: SettingsLayers;
  risk: WorkspaceRisk;
  gitRoots: string[];
  /** The path `global` stands for; a test switches it to simulate a process with another CLAUDE_CONFIG_DIR. */
  globalPath: string;
  /** Other global config files by absolute path (configs of other CLAUDE_CONFIG_DIRs), reached via `o.globalConfigPath`. */
  readonly others = new Map<string, Record<string, unknown>>();
  /** `path` is set only for a write to a file other than the current `globalPath`. */
  readonly writes: { op: 'seed' | 'unseed'; cwd: string; path?: string }[] = [];

  constructor(o: FakeClaudeConfigOptions = {}) {
    this.global = o.global ?? { hasCompletedOnboarding: true, projects: {} };
    this.layers = {
      disableAllHooksTrueIn: [],
      allowedHttpHookUrlsDefinedIn: [],
      statusLineDefined: false,
      parseErrors: [],
      ...(o.layers ?? {}),
    };
    this.risk = o.risk ?? { empty: true, items: [] };
    this.gitRoots = [...(o.gitRoots ?? [])];
    this.globalPath = o.globalPath ?? FAKE_GLOBAL_CONFIG_PATH;
  }

  globalConfigPath(): string {
    return this.globalPath;
  }

  /** The config a seed/unseed addresses: `global` for the current path, else `others` (created on seed). */
  private configAt(path: string | undefined, create: boolean): Record<string, unknown> | 'missing' | 'invalidJson' {
    if (path === undefined || path === this.globalPath) return this.global;
    let c = this.others.get(path);
    if (c === undefined) {
      if (!create) return 'missing';
      c = {};
      this.others.set(path, c);
    }
    return c;
  }

  private note(op: 'seed' | 'unseed', cwd: string, path: string | undefined): void {
    this.writes.push(path === undefined || path === this.globalPath ? { op, cwd } : { op, cwd, path });
  }

  readGlobal(): Promise<{ ok: true; hasCompletedOnboarding: boolean } | { ok: false; reason: 'missing' | 'invalidJson' }> {
    if (typeof this.global === 'string') return Promise.resolve({ ok: false, reason: this.global });
    return Promise.resolve({ ok: true, hasCompletedOnboarding: this.global['hasCompletedOnboarding'] === true });
  }

  trustOf(realCwd: string): Promise<{ trusted: boolean; viaPath?: string }> {
    if (typeof this.global === 'string') return Promise.resolve({ trusted: false });
    return Promise.resolve(trustLookup(this.global, realCwd, this.gitRootOf(realCwd)));
  }

  seedTrust(realCwd: string, o: { globalConfigPath?: string } = {}): Promise<{ added: boolean }> {
    const g = this.configAt(o.globalConfigPath, true);
    if (typeof g === 'string') return Promise.reject(new ClaudeConfigUnreadable('~/.claude.json', g));
    let projects = g['projects'];
    if (projects === undefined) {
      projects = {};
      g['projects'] = projects;
    }
    if (!isPlainObject(projects)) return Promise.reject(new ClaudeConfigUnreadable('~/.claude.json', 'projectsNotObject'));
    const entry = projects[realCwd];
    if (isPlainObject(entry) && entry[TRUST_KEY] === true) return Promise.resolve({ added: false });
    if (isPlainObject(entry)) entry[TRUST_KEY] = true;
    else projects[realCwd] = { [TRUST_KEY]: true };
    this.note('seed', realCwd, o.globalConfigPath);
    return Promise.resolve({ added: true });
  }

  unseedTrust(realCwd: string, o: { globalConfigPath?: string } = {}): Promise<void> {
    const g = this.configAt(o.globalConfigPath, false);
    if (typeof g === 'string') return Promise.reject(new ClaudeConfigUnreadable('~/.claude.json', g));
    const projects = g['projects'];
    if (isPlainObject(projects)) {
      const entry = projects[realCwd];
      if (isPlainObject(entry) && TRUST_KEY in entry) {
        Reflect.deleteProperty(entry, TRUST_KEY);
        this.note('unseed', realCwd, o.globalConfigPath);
      }
    }
    return Promise.resolve();
  }

  readLayers(_realCwd: string): Promise<SettingsLayers> {
    return Promise.resolve(structuredClone(this.layers));
  }

  inspectWorkspace(_realCwd: string): Promise<WorkspaceRisk> {
    return Promise.resolve(structuredClone(this.risk));
  }

  private gitRootOf(dir: string): string | undefined {
    return this.gitRoots.filter((r) => dir === r || dir.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  }
}

export class FakeSettingsFile implements SettingsFilePort {
  /** path → exact text written. */
  readonly files = new Map<string, string>();

  writeExclusive(path: string, json: unknown): Promise<{ sha256: string; bytes: number }> {
    if (this.files.has(path)) return Promise.reject(new SettingsFileExists(path));
    const text = serializeJsonFile(json);
    this.files.set(path, text);
    const bytes = Buffer.from(text, 'utf8');
    return Promise.resolve({ sha256: sha256Hex(bytes), bytes: bytes.length });
  }

  matches(path: string, sha256: string): Promise<boolean> {
    const t = this.files.get(path);
    return Promise.resolve(t !== undefined && sha256Hex(Buffer.from(t, 'utf8')) === sha256.toLowerCase());
  }

  /** Parsed content (e.g. for FakeOwnerWatch's readConfig). */
  read(path: string): unknown {
    const t = this.files.get(path);
    return t === undefined ? undefined : (JSON.parse(t) as unknown);
  }

  /** Simulate tampering between write and read (P-SEC-31). */
  tamper(path: string, text: string): void {
    this.files.set(path, text);
  }
}
