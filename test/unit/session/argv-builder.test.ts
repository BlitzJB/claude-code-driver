// WP-12 argv-builder (DESIGN.md §3.3, D-08, D-24, rev 2 §10 G6; P-REV-03 "every --help flag classified").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCctError } from '../../../src/model/errors.js';
import {
  ALLOWED_EXTRA_FLAGS,
  buildClaudeArgv,
  checkExtraArgFiles,
  FORBIDDEN_FLAG_REASONS,
  HELP_FLAGS_2_1_316,
  parseHelpFlags,
  SHORT_FLAGS,
  validateExtraArgs,
  type ClaudeArgvInput,
} from '../../../src/session/argv-builder.js';

const HELP = readFileSync(join(import.meta.dirname, '../../../fixtures/claude-help-2.1.316.txt'), 'utf8');
const EXE = '/n/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const SID = '0a1b2c3d-0000-4000-8000-000000000001';

function err(fn: () => unknown): { code: string; reason: unknown } | undefined {
  try {
    fn();
  } catch (e) {
    if (isCctError(e)) return { code: e.code, reason: e.details?.['reason'] };
    throw e;
  }
  return undefined;
}

function argv(over: Partial<ClaudeArgvInput> = {}): readonly string[] {
  return buildClaudeArgv({
    exe: EXE,
    sessionId: SID,
    settingsPath: '/run/ccd-x/settings.json',
    permissionMode: 'default',
    allowDangerousModes: false,
    strictMcp: false,
    extraArgs: [],
    ...over,
  });
}

describe('recorded --help 2.1.316 (fixtures/claude-help-2.1.316.txt)', () => {
  const parsed = parseHelpFlags(HELP);

  it('HELP_FLAGS_2_1_316 equals the flags the fixture lists', () => {
    expect([...parsed.long].sort()).toEqual([...HELP_FLAGS_2_1_316].sort());
    expect(parsed.short).toEqual(SHORT_FLAGS);
  });

  it('P-REV-03: every --help flag is classified (allowed or forbidden with a reason)', () => {
    for (const f of parsed.long) {
      const classified = ALLOWED_EXTRA_FLAGS[f] !== undefined || FORBIDDEN_FLAG_REASONS[f] !== undefined;
      expect(classified, f).toBe(true);
    }
  });

  it('every flag the binary lists is either accepted or rejected by validateExtraArgs (never a crash)', () => {
    for (const f of parsed.long) {
      const kind = ALLOWED_EXTRA_FLAGS[f];
      const args = kind === 'none' ? [f] : [f, 'value'];
      const r = err(() => validateExtraArgs(args));
      if (kind === undefined) expect(r?.code, f).toBe('E_FORBIDDEN_ARG');
      else if (kind === 'text' || kind === 'none') expect(r, f).toBeUndefined();
    }
  });

  it('UNVERIFIED *-file flags are not in --help 2.1.316 → rejected as notInHelp', () => {
    expect(HELP_FLAGS_2_1_316).not.toContain('--system-prompt-file');
    expect(err(() => validateExtraArgs(['--system-prompt-file', '/x']))).toEqual({ code: 'E_FORBIDDEN_ARG', reason: 'notInHelp' });
    expect(err(() => validateExtraArgs(['--append-system-prompt-file=/x']))).toEqual({ code: 'E_FORBIDDEN_ARG', reason: 'notInHelp' });
    // accepted once a binary lists it
    const withFile = new Set([...HELP_FLAGS_2_1_316, '--system-prompt-file']);
    expect(validateExtraArgs(['--system-prompt-file', '/x'], withFile).argv).toEqual(['--system-prompt-file', '/x']);
  });

  it('the fixture names the hidden flags only as absent (teammate-mode, managed-settings)', () => {
    expect(parsed.long).not.toContain('--teammate-mode');
    expect(FORBIDDEN_FLAG_REASONS['--teammate-mode']).toBe('libraryOwned');
  });
});

describe('extraArgs allowlist (§3.3)', () => {
  it('accepts the allowed flags in both forms and canonicalises them', () => {
    expect(
      validateExtraArgs([
        '--append-system-prompt',
        'be brief',
        '--name=job 1',
        '-n',
        'x',
        '--exclude-dynamic-system-prompt-sections',
        '--system-prompt=S',
      ]).argv,
    ).toEqual([
      '--append-system-prompt',
      'be brief',
      '--name',
      'job 1',
      '--name',
      'x',
      '--exclude-dynamic-system-prompt-sections',
      '--system-prompt',
      'S',
    ]);
    expect(validateExtraArgs(['-nfoo']).argv).toEqual(['--name', 'foo']);
  });

  it.each([
    [['--allowedTools', 'Bash'], 'addsPermissionRules'],
    [['--allowed-tools=Bash'], 'addsPermissionRules'],
    [['--disallowed-tools', 'X'], 'addsPermissionRules'],
    [['--add-dir', '/'], 'bypassesAllowAddDirectories'],
    [['--tools', 'Bash'], 'changesToolSet'],
    [['--mcp-config', 'x.json'], 'loadsHooksOrServers'],
    [['--plugin-dir', '/p'], 'loadsHooksOrServers'],
    [['--agents', '{}'], 'loadsHooksOrServers'],
    [['--verbose'], 'changesScreen'],
    [['-d'], 'libraryOwned'],
    [['--debug=hooks'], 'libraryOwned'],
    [['-dp'], 'libraryOwned'],
    [['--debug-file', '/x'], 'libraryOwned'],
    [['--model', 'opus'], 'firstClassOption'],
    [['--effort', 'max'], 'firstClassOption'],
    [['--permission-mode', 'plan'], 'firstClassOption'],
    [['--settings', '{}'], 'libraryOwned'],
    [['--setting-sources', 'user'], 'dropsUserSettings'],
    [['--session-id', SID], 'libraryOwned'],
    [['-r', SID], 'useResumeOption'],
    [['-c'], 'useResumeOption'],
    [['-p'], 'notInteractive'],
    [['--bare'], 'disablesHooks'],
    [['--safe-mode'], 'disablesHooks'],
    [['--dangerously-skip-permissions'], 'skipsPermissions'],
    [['--allow-dangerously-skip-permissions'], 'skipsPermissions'],
    [['--teammate-mode', 'tmux'], 'libraryOwned'],
    [['--bg'], 'background'],
    [['--background'], 'background'],
    [['--remote-control'], 'remoteControl'],
    [['--remote-control-anything'], 'remoteControl'],
    [['-w'], 'unsupported'],
    [['--tmux'], 'unsupported'],
    [['--strict-mcp-config'], 'useSecurityMcpStrict'],
    [['--no-session-persistence'], 'notInteractive'],
    [['--managed-settings', '/x'], 'libraryOwned'],
    [['--made-up-flag'], 'notAllowlisted'],
    [['-x'], 'unknownFlag'],
    [['fix the bug'], 'positional'],
    [['--'], 'endOfOptions'],
  ])('%j → E_FORBIDDEN_ARG{%s}', (args, reason) => {
    expect(err(() => validateExtraArgs(args))).toEqual({ code: 'E_FORBIDDEN_ARG', reason });
  });

  it('value rules: single element, no control characters, ≤ 8 KiB, flag-looking values need =', () => {
    expect(err(() => validateExtraArgs(['--name']))?.reason).toBe('missingValue');
    expect(err(() => validateExtraArgs(['--name', 'a\nb']))?.reason).toBe('controlCharacter');
    expect(err(() => validateExtraArgs(['--name', 'a\u009bb']))?.reason).toBe('controlCharacter');
    expect(err(() => validateExtraArgs(['--name', 'x'.repeat(8 * 1024 + 1)]))?.reason).toBe('valueTooLong');
    expect(err(() => validateExtraArgs(['--name', '--verbose']))?.reason).toBe('valueLooksLikeFlag');
    expect(validateExtraArgs(['--name=--odd']).argv).toEqual(['--name', '--odd']);
    expect(err(() => validateExtraArgs(['--name', '\ud800']))?.reason).toBe('loneSurrogate');
    expect(err(() => validateExtraArgs(['--exclude-dynamic-system-prompt-sections=1']))?.reason).toBe('unexpectedValue');
    expect(err(() => validateExtraArgs(['--name=']))?.reason).toBe('emptyValue');
  });

  it('*-file values must be an absolute regular file, not a symlink', async () => {
    const files: Record<string, { isSymlink: boolean; isFile: boolean; isDir: boolean }> = {
      '/ok.txt': { isSymlink: false, isFile: true, isDir: false },
      '/link': { isSymlink: true, isFile: false, isDir: false },
      '/dir': { isSymlink: false, isFile: false, isDir: true },
    };
    const lstat = (p: string): Promise<{ isSymlink: boolean; isFile: boolean; isDir: boolean } | undefined> => Promise.resolve(files[p]);
    const check = async (v: string): Promise<unknown> => {
      try {
        await checkExtraArgFiles([{ flag: '--system-prompt-file', kind: 'file', value: v }], lstat);
        return 'ok';
      } catch (e) {
        return isCctError(e) ? e.details?.['reason'] : e;
      }
    };
    expect(await check('/ok.txt')).toBe('ok');
    expect(await check('/link')).toBe('fileIsSymlink');
    expect(await check('/dir')).toBe('fileNotRegular');
    expect(await check('/missing')).toBe('fileMissing');
    expect(await check('rel.txt')).toBe('fileNotAbsolute');
  });
});

describe('buildClaudeArgv (D-08, D-24)', () => {
  it('P-TMUX-24 / D-08: env -u TMUX -u TMUX_PANE <abs claude.exe> with ≥ 2 elements', () => {
    const a = argv();
    expect(a.slice(0, 6)).toEqual(['/usr/bin/env', '-u', 'TMUX', '-u', 'TMUX_PANE', EXE]);
    expect(a.length).toBeGreaterThanOrEqual(2);
  });

  it('P-LIVE-06 / P-LIFE-37 / P-HOOK-42: explicit mode, fresh id, settings as a path, teammate in-process', () => {
    const a = argv();
    expect(a).toEqual([
      '/usr/bin/env',
      '-u',
      'TMUX',
      '-u',
      'TMUX_PANE',
      EXE,
      '--session-id',
      SID,
      '--settings',
      '/run/ccd-x/settings.json',
      '--permission-mode',
      'default',
      '--teammate-mode',
      'in-process',
    ]);
    expect(a.join(' ')).not.toContain('{');
  });

  it('P-LIFE-17: a resume passes --settings, --permission-mode, --model and --effort again, never --session-id', () => {
    const a = buildClaudeArgv({
      exe: EXE,
      resume: SID,
      settingsPath: '/run/ccd-y/settings.json',
      permissionMode: 'acceptEdits',
      allowDangerousModes: false,
      model: 'opus',
      effort: 'high',
      strictMcp: true,
      debugFile: '/run/ccd-y/claude-debug.log',
      extraArgs: ['--name', 'n'],
    });
    expect(a).toContain('--resume');
    expect(a).not.toContain('--session-id');
    expect(a.slice(6)).toEqual([
      '--resume',
      SID,
      '--settings',
      '/run/ccd-y/settings.json',
      '--permission-mode',
      'acceptEdits',
      '--teammate-mode',
      'in-process',
      '--model',
      'opus',
      '--effort',
      'high',
      '--strict-mcp-config',
      '--debug-file',
      '/run/ccd-y/claude-debug.log',
      '--name',
      'n',
    ]);
  });

  it('never both --session-id and --resume (and never neither)', () => {
    expect(err(() => argv({ resume: SID }))?.code).toBe('E_INVARIANT');
    expect(
      err(() =>
        buildClaudeArgv({
          exe: EXE,
          settingsPath: '/s',
          permissionMode: 'default',
          allowDangerousModes: false,
          strictMcp: false,
          extraArgs: [],
        }),
      )?.code,
    ).toBe('E_INVARIANT');
  });

  it('P-LIFE-33 / P-SEC-12: bypassPermissions, auto and dontAsk need allowDangerousModes', () => {
    for (const m of ['bypassPermissions', 'auto', 'dontAsk'] as const) {
      expect(err(() => argv({ permissionMode: m }))?.code).toBe('E_MODE_FORBIDDEN');
      expect(argv({ permissionMode: m, allowDangerousModes: true })).toContain(m);
    }
    expect(argv({ permissionMode: 'plan' })).toContain('plan');
  });

  it('rejects malformed ids, models, efforts, relative paths and unvalidated extraArgs', () => {
    expect(err(() => argv({ sessionId: 'not-a-uuid' }))?.reason).toBe('sessionId');
    expect(err(() => argv({ model: 'op us;rm' }))?.reason).toBe('model');
    expect(err(() => argv({ effort: 'ultra' }))?.reason).toBe('effort');
    expect(err(() => argv({ exe: 'claude' }))?.code).toBe('E_INVARIANT');
    expect(err(() => argv({ extraArgs: ['--bg'] }))?.code).toBe('E_FORBIDDEN_ARG');
  });

  it('P-NET-40 / P-PRIOR-09 / P-DOCS-06 / P-HOOK-11: the built argv never carries a forbidden flag', () => {
    const a = argv({ extraArgs: ['--append-system-prompt', 'x'] });
    for (const f of ['--bg', '--background', '--verbose', '--setting-sources', '--dangerously-skip-permissions', '--bare', '--safe-mode'])
      expect(a).not.toContain(f);
  });
});
