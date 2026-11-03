// platform/settings/settings-layers.ts — lenient read of the user/project/local settings layers and keybindings.json
// (DESIGN.md §2.7.2 SettingsLayers, §3.1 step 7: D-13, D-14, keybinding conflicts, editorMode, hook transport choice).
//   user        <configDir>/settings.json
//   project     <cwd>/.claude/settings.json          (Claude reads project/local settings from its original cwd)
//   local       <cwd>/.claude/settings.local.json
//   keybindings <configDir>/keybindings.json
// Managed settings are not readable here. A missing file is simply absent; an unreadable or unparsable one is recorded in
// `parseErrors` (never thrown) so preflight can warn and decide.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SettingsLayers } from '../ports.js';
import { isNoEnt } from '../runtime-dir/dir-checks.js';
import { isPlainObject, parseLenientJson } from './lenient-json.js';

export type LayerName = 'user' | 'project' | 'local';
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

export interface LayerFiles {
  user: string;
  project: string;
  local: string;
  keybindings: string;
}

export function layerFiles(configDir: string, realCwd: string): LayerFiles {
  return {
    user: join(configDir, 'settings.json'),
    project: join(realCwd, '.claude', 'settings.json'),
    local: join(realCwd, '.claude', 'settings.local.json'),
    keybindings: join(configDir, 'keybindings.json'),
  };
}

/** Read and leniently parse one JSON file. `undefined` value = absent. */
export async function readJsonFileLenient(
  path: string,
  errors: string[],
  o: { requireObject: boolean } = { requireObject: true },
): Promise<unknown> {
  let text: string;
  try {
    const buf = await readFile(path);
    if (buf.length > MAX_SETTINGS_BYTES) {
      errors.push(`${path}: larger than ${MAX_SETTINGS_BYTES} bytes`);
      return undefined;
    }
    text = buf.toString('utf8');
  } catch (e) {
    if (isNoEnt(e)) return undefined;
    errors.push(`${path}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
    return undefined;
  }
  if (text.trim() === '') return undefined;
  const r = parseLenientJson(text);
  if (!r.ok) {
    errors.push(`${path}: invalid JSON`);
    return undefined;
  }
  if (o.requireObject && !isPlainObject(r.value)) {
    errors.push(`${path}: not a JSON object`);
    return undefined;
  }
  return r.value;
}

export async function readSettingsLayers(o: { configDir: string; realCwd: string }): Promise<SettingsLayers> {
  const files = layerFiles(o.configDir, o.realCwd);
  const parseErrors: string[] = [];
  const user = await readJsonFileLenient(files.user, parseErrors);
  // When cwd is the home dir, <cwd>/.claude is the user config dir: the project layer is the user file, not a second one.
  const sameAsUser = files.project === files.user;
  const project = sameAsUser ? undefined : await readJsonFileLenient(files.project, parseErrors);
  const local = await readJsonFileLenient(files.local, parseErrors);
  const keybindings = await readJsonFileLenient(files.keybindings, parseErrors, { requireObject: false });

  const layers: [LayerName, unknown][] = [
    ['user', user],
    ['project', project],
    ['local', local],
  ];
  const disableAllHooksTrueIn: LayerName[] = [];
  const allowedHttpHookUrlsDefinedIn: LayerName[] = [];
  let editorMode: string | undefined;
  let statusLineDefined = false;
  for (const [name, v] of layers) {
    if (!isPlainObject(v)) continue;
    if (v['disableAllHooks'] === true) disableAllHooksTrueIn.push(name);
    if (v['allowedHttpHookUrls'] !== undefined) allowedHttpHookUrlsDefinedIn.push(name);
    if (typeof v['editorMode'] === 'string') editorMode = v['editorMode']; // later layers win: user < project < local
    if (v['statusLine'] !== undefined && v['statusLine'] !== null) statusLineDefined = true;
  }

  const out: SettingsLayers = { disableAllHooksTrueIn, allowedHttpHookUrlsDefinedIn, statusLineDefined, parseErrors };
  if (user !== undefined) out.user = user;
  if (project !== undefined) out.project = project;
  if (local !== undefined) out.local = local;
  if (keybindings !== undefined) out.keybindings = keybindings;
  if (editorMode !== undefined) out.editorMode = editorMode;
  return out;
}
