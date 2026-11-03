// platform/settings/workspace-inspector.ts — WorkspaceRisk report for `trust:'seed'` (DESIGN.md §2.7.2, D-19, SEC §5.5,
// P-SEC-15). Trust turns on the repo's own `.claude/settings*.json` (hooks, permissions.allow, env, apiKeyHelper, statusLine,
// otelHeadersHelper, additionalDirectories) and project `.mcp.json` servers, and seeding is inherited by every subfolder up
// to the git root, so every dir from cwd up to the git root (cwd only outside git) is inspected.
// Details carry names only (hook events, env var names, server names, rules), never values (env values may be secrets).
// A file that exists but cannot be parsed is reported as a `hooks` item: its contents are unknown and could define hooks.
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceRisk } from '../ports.js';
import { isPlainObject } from './lenient-json.js';
import { ancestorsUpTo } from './paths.js';
import { readJsonFileLenient } from './settings-layers.js';

type Item = WorkspaceRisk['items'][number];
const MAX_LISTED = 20;

function list(xs: readonly string[]): string {
  const shown = xs.slice(0, MAX_LISTED).join(', ');
  return xs.length > MAX_LISTED ? `${shown}, … (+${xs.length - MAX_LISTED})` : shown;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Risk items of one parsed settings object. */
export function settingsRisks(file: string, v: Record<string, unknown>): Item[] {
  const items: Item[] = [];
  const hooks = v['hooks'];
  if (isPlainObject(hooks)) {
    const events = Object.keys(hooks).filter((k) => {
      const h = hooks[k];
      return Array.isArray(h) ? h.length > 0 : h !== undefined && h !== null;
    });
    if (events.length > 0) items.push({ file, kind: 'hooks', detail: `events: ${list(events)}` });
  } else if (hooks !== undefined && hooks !== null) items.push({ file, kind: 'hooks', detail: 'hooks defined (unrecognised shape)' });

  const perms = v['permissions'];
  if (isPlainObject(perms)) {
    const allow = strings(perms['allow']);
    if (allow.length > 0) items.push({ file, kind: 'permissions.allow', detail: `rules: ${list(allow)}` });
    const dirs = strings(perms['additionalDirectories']);
    if (dirs.length > 0) items.push({ file, kind: 'additionalDirectories', detail: `dirs: ${list(dirs)}` });
  }
  const env = v['env'];
  if (isPlainObject(env) && Object.keys(env).length > 0) items.push({ file, kind: 'env', detail: `variables: ${list(Object.keys(env))}` });
  for (const k of ['apiKeyHelper', 'statusLine', 'otelHeadersHelper'] as const)
    if (v[k] !== undefined && v[k] !== null && v[k] !== '') items.push({ file, kind: k, detail: `${k} defined` });
  if (v['enableAllProjectMcpServers'] === true)
    items.push({ file, kind: 'enableAllProjectMcpServers', detail: 'enableAllProjectMcpServers: true' });
  const enabled = strings(v['enabledMcpjsonServers']);
  if (enabled.length > 0) items.push({ file, kind: 'mcpServers', detail: `enabledMcpjsonServers: ${list(enabled)}` });
  return items;
}

export async function inspectWorkspaceDirs(o: { realCwd: string; gitRoot: string | undefined; configDir: string }): Promise<WorkspaceRisk> {
  const dirs =
    o.gitRoot !== undefined && (o.realCwd === o.gitRoot || o.realCwd.startsWith(`${o.gitRoot}/`))
      ? ancestorsUpTo(o.realCwd, o.gitRoot)
      : [o.realCwd];
  const configReal = await realpath(o.configDir).catch(() => o.configDir);
  const items: Item[] = [];
  for (const dir of dirs) {
    const dotClaude = join(dir, '.claude');
    const isUserConfigDir = (await realpath(dotClaude).catch(() => dotClaude)) === configReal;
    if (!isUserConfigDir) {
      for (const name of ['settings.json', 'settings.local.json']) {
        const file = join(dotClaude, name);
        const errors: string[] = [];
        const v = await readJsonFileLenient(file, errors);
        if (errors.length > 0) items.push({ file, kind: 'hooks', detail: 'file could not be parsed; contents unknown (may define hooks)' });
        else if (isPlainObject(v)) items.push(...settingsRisks(file, v));
      }
    }
    const mcpFile = join(dir, '.mcp.json');
    const errors: string[] = [];
    const mcp = await readJsonFileLenient(mcpFile, errors);
    if (errors.length > 0) items.push({ file: mcpFile, kind: 'mcpServers', detail: 'file could not be parsed; contents unknown' });
    else if (isPlainObject(mcp)) {
      const servers = mcp['mcpServers'];
      const names = isPlainObject(servers) ? Object.keys(servers) : [];
      if (names.length > 0) items.push({ file: mcpFile, kind: 'mcpServers', detail: `servers: ${list(names)}` });
    }
  }
  return { empty: items.length === 0, items };
}
