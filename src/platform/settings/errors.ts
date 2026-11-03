// platform/settings/errors.ts — typed L0 errors for the settings file and Claude's global config (DESIGN.md §2.7).
// Duck-typed by `name` in `session/errors-map.ts`.

/** §2.7 `SettingsFileExists`: the O_EXCL create found a file (or a planted symlink) at the path (P-HOOK-17, P-SEC-14). */
export class SettingsFileExists extends Error {
  override readonly name = 'SettingsFileExists';
  constructor(readonly path: string) {
    super(`settings file already exists: ${path}`);
  }
}

/** `~/.claude.json` is missing or is not a JSON object, so a single-key merge is impossible (→ E_CONFIG_CORRUPT). */
export class ClaudeConfigUnreadable extends Error {
  override readonly name = 'ClaudeConfigUnreadable';
  constructor(
    readonly path: string,
    readonly reason: 'missing' | 'invalidJson' | 'notObject' | 'projectsNotObject',
  ) {
    super(`claude config ${path}: ${reason}`);
  }
}

/** Another writer changed `~/.claude.json` on every merge attempt (optimistic concurrency gave up). */
export class ClaudeConfigBusy extends Error {
  override readonly name = 'ClaudeConfigBusy';
  constructor(
    readonly path: string,
    readonly attempts: number,
  ) {
    super(`claude config ${path} kept changing during ${attempts} merge attempts`);
  }
}
