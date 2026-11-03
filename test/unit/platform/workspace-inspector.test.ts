// WP-05 unit tests: WorkspaceRisk report for trust:'seed' (P-SEC-15, SEC §5.5): cwd → git root, names only, never values.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEnv } from '../../../src/platform/env/fake-env.js';
import { createClaudeConfigPort } from '../../../src/platform/settings/claude-config.js';
import { inspectWorkspaceDirs, settingsRisks } from '../../../src/platform/settings/workspace-inspector.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-ws-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (p: string, v: unknown) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
};

describe('settingsRisks', () => {
  it('lists every risky key by name and never copies env values', () => {
    const items = settingsRisks('/f', {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'curl evil' }] }], Stop: [] },
      permissions: { allow: ['Bash(rm:*)'], additionalDirectories: ['/etc'], deny: ['x'] },
      env: { AWS_SECRET_ACCESS_KEY: 'super-secret-value' },
      apiKeyHelper: '/bin/helper',
      statusLine: { type: 'command', command: 'x' },
      otelHeadersHelper: 'h',
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['db'],
    });
    expect(items.map((i) => i.kind)).toEqual([
      'hooks',
      'permissions.allow',
      'additionalDirectories',
      'env',
      'apiKeyHelper',
      'statusLine',
      'otelHeadersHelper',
      'enableAllProjectMcpServers',
      'mcpServers',
    ]);
    expect(items[0]?.detail).toBe('events: SessionStart');
    expect(JSON.stringify(items)).not.toContain('super-secret-value');
    expect(JSON.stringify(items)).not.toContain('curl evil');
    expect(items.find((i) => i.kind === 'env')?.detail).toBe('variables: AWS_SECRET_ACCESS_KEY');
    expect(settingsRisks('/f', { permissions: { allow: [] }, env: {}, hooks: {} })).toEqual([]);
  });
});

describe('inspectWorkspaceDirs', () => {
  it('walks cwd → git root, reads .claude/settings*.json and .mcp.json, skips dirs above the root', async () => {
    const above = root;
    const repo = join(root, 'repo');
    const cwd = join(repo, 'pkg');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    put(join(above, '.claude', 'settings.json'), { hooks: { Stop: [{}] } }); // above the git root: ignored
    put(join(repo, '.claude', 'settings.json'), { permissions: { allow: ['Read(**)'] } });
    put(join(cwd, '.claude', 'settings.local.json'), { hooks: { PreToolUse: [{}] } });
    put(join(repo, '.mcp.json'), { mcpServers: { db: {}, web: {} } });
    put(join(cwd, '.mcp.json'), '{ broken');
    const port = createClaudeConfigPort({ env: new FakeEnv({ home: join(root, 'home') }) });
    const r = await port.inspectWorkspace(cwd);
    expect(r.empty).toBe(false);
    expect(r.items).toEqual([
      { file: join(cwd, '.claude', 'settings.local.json'), kind: 'hooks', detail: 'events: PreToolUse' },
      { file: join(cwd, '.mcp.json'), kind: 'mcpServers', detail: 'file could not be parsed; contents unknown' },
      { file: join(repo, '.claude', 'settings.json'), kind: 'permissions.allow', detail: 'rules: Read(**)' },
      { file: join(repo, '.mcp.json'), kind: 'mcpServers', detail: 'servers: db, web' },
    ]);
  });

  it('outside git only the cwd counts; the user config dir is never treated as a project layer', async () => {
    const home = join(root, 'home');
    put(join(home, '.claude', 'settings.json'), { hooks: { Stop: [{}] } });
    expect(await inspectWorkspaceDirs({ realCwd: home, gitRoot: undefined, configDir: join(home, '.claude') })).toEqual({
      empty: true,
      items: [],
    });
    const cwd = join(root, 'plain', 'dir');
    mkdirSync(cwd, { recursive: true });
    put(join(root, 'plain', '.claude', 'settings.json'), { hooks: { Stop: [{}] } });
    expect((await inspectWorkspaceDirs({ realCwd: cwd, gitRoot: undefined, configDir: join(home, '.claude') })).empty).toBe(true);
  });

  it('an unparsable settings file is a risk item (contents unknown)', async () => {
    put(join(root, '.claude', 'settings.json'), '{"hooks":');
    const r = await inspectWorkspaceDirs({ realCwd: root, gitRoot: undefined, configDir: '/nonexistent' });
    expect(r.items).toEqual([
      {
        file: join(root, '.claude', 'settings.json'),
        kind: 'hooks',
        detail: 'file could not be parsed; contents unknown (may define hooks)',
      },
    ]);
  });
});
