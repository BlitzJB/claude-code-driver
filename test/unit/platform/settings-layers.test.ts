// WP-05 unit tests: SettingsLayers (D-13 allowedHttpHookUrls, D-14 disableAllHooks, keybindings, editorMode, lenient parse).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEnv } from '../../../src/platform/env/fake-env.js';
import { createClaudeConfigPort } from '../../../src/platform/settings/claude-config.js';
import { firstJsonObject, parseLenientJson, stripCommentsAndTrailingCommas } from '../../../src/platform/settings/lenient-json.js';
import { layerFiles, readSettingsLayers } from '../../../src/platform/settings/settings-layers.js';

let root: string;
let home: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-lay-')));
  home = join(root, 'home');
  cwd = join(root, 'proj');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (p: string, v: unknown) => {
  writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
};

describe('readSettingsLayers', () => {
  it('empty when no file exists', async () => {
    rmSync(join(cwd, '.claude'), { recursive: true });
    expect(await readSettingsLayers({ configDir: join(home, '.claude'), realCwd: cwd })).toEqual({
      disableAllHooksTrueIn: [],
      allowedHttpHookUrlsDefinedIn: [],
      statusLineDefined: false,
      parseErrors: [],
    });
  });

  it('collects the security flags per layer and the effective editorMode (local > project > user)', async () => {
    const f = layerFiles(join(home, '.claude'), cwd);
    put(f.user, { disableAllHooks: true, editorMode: 'vim', allowedHttpHookUrls: [] });
    put(f.project, { editorMode: 'normal', statusLine: { type: 'command', command: 'x' } });
    put(f.local, { disableAllHooks: true, allowedHttpHookUrls: ['http://x'], editorMode: 'vim' });
    put(f.keybindings, [{ context: 'Chat', bindings: { enter: 'chat:newline' } }]);
    const l = await readSettingsLayers({ configDir: join(home, '.claude'), realCwd: cwd });
    expect(l.disableAllHooksTrueIn).toEqual(['user', 'local']);
    expect(l.allowedHttpHookUrlsDefinedIn).toEqual(['user', 'local']);
    expect(l.editorMode).toBe('vim');
    expect(l.statusLineDefined).toBe(true);
    expect(l.keybindings).toEqual([{ context: 'Chat', bindings: { enter: 'chat:newline' } }]);
    expect(l.user).toMatchObject({ disableAllHooks: true });
    expect(l.parseErrors).toEqual([]);
  });

  it('tolerates comments and trailing commas; records broken / non-object files without throwing', async () => {
    const f = layerFiles(join(home, '.claude'), cwd);
    put(f.user, '{\n  // comment\n  "disableAllHooks": false, /* x */\n  "editorMode": "normal",\n}\n');
    put(f.project, '{"hooks": ');
    put(f.local, '[1,2]');
    const l = await readSettingsLayers({ configDir: join(home, '.claude'), realCwd: cwd });
    expect(l.user).toEqual({ disableAllHooks: false, editorMode: 'normal' });
    expect(l.project).toBeUndefined();
    expect(l.parseErrors).toEqual([`${f.project}: invalid JSON`, `${f.local}: not a JSON object`]);
  });

  it('cwd = home does not read the user file twice as a project layer', async () => {
    put(join(home, '.claude', 'settings.json'), { disableAllHooks: true });
    const l = await readSettingsLayers({ configDir: join(home, '.claude'), realCwd: home });
    expect(l.disableAllHooksTrueIn).toEqual(['user']);
    expect(l.project).toBeUndefined();
  });

  it('ClaudeConfigPort.readLayers uses $CLAUDE_CONFIG_DIR when the user has one', async () => {
    const custom = join(root, 'custom');
    mkdirSync(custom);
    put(join(custom, 'settings.json'), { allowedHttpHookUrls: ['http://127.0.0.1:1'] });
    const port = createClaudeConfigPort({ env: new FakeEnv({ home, vars: { CLAUDE_CONFIG_DIR: custom } }) });
    expect((await port.readLayers(cwd)).allowedHttpHookUrlsDefinedIn).toEqual(['user']);
  });
});

describe('lenient JSON helpers', () => {
  it('parseLenientJson / stripCommentsAndTrailingCommas keep strings intact', () => {
    expect(parseLenientJson('﻿{"a":"//not a comment, ]"}')).toEqual({ ok: true, value: { a: '//not a comment, ]' } });
    expect(stripCommentsAndTrailingCommas('{"a":"x\\"//y",}')).toBe('{"a":"x\\"//y"}');
    expect(parseLenientJson('{').ok).toBe(false);
  });

  it('firstJsonObject takes the first complete object (torn / concatenated files)', () => {
    expect(firstJsonObject('{"pid":1,"s":"}{"}{"pid":2}')).toEqual({ pid: 1, s: '}{' });
    expect(firstJsonObject('{"pid":1,"sess')).toBeUndefined();
    expect(firstJsonObject('garbage')).toBeUndefined();
  });
});
