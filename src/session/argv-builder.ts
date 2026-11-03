// session/argv-builder.ts — Claude's argv and the `extraArgs` allowlist (DESIGN.md §3.3, D-08, D-24, rev 2 §10 G6).
//
//   /usr/bin/env -u TMUX -u TMUX_PANE <abs .../bin/claude.exe>
//     (--session-id <fresh uuid v4> | --resume <id>)   never both (LC §8.1)
//     --settings <sessionDir>/settings.json            path, never inline JSON (SEC §5.1)
//     --permission-mode <mode>                         always explicit (LV Q4)
//     --teammate-mode in-process                       hidden flag (keeps one pane per session)
//     [--model m] [--effort e] [--strict-mcp-config] [--debug-file <sessionDir>/claude-debug.log] [...allowlisted extraArgs]
//
// Pitfalls handled here (§5):
//   P-TMUX-24  argv always ≥ 2 elements, so tmux never runs it through `default-shell -c`
//   P-HOOK-11  --setting-sources never passed (forbidden in extraArgs)
//   P-HOOK-12  --safe-mode / --bare forbidden
//   P-HOOK-42  --settings is a file path, never inline JSON
//   P-NET-40, P-PRIOR-09  --bg / --background forbidden
//   P-LIFE-17  --settings, --permission-mode, --model, --effort passed again on every resume
//   P-LIFE-33  bypass/auto/dontAsk need allowDangerousModes (E_MODE_FORBIDDEN)
//   P-LIFE-37  fresh UUID; never --session-id together with --resume
//   P-SEC-12   skip-permission flags forbidden
//   P-LIVE-06  --permission-mode always explicit
//   P-DOCS-06  --verbose forbidden
//   P-REV-03   allowlist; every `claude --help` 2.1.316 flag is classified (fixtures/claude-help-2.1.316.txt)

import { CcdError } from '../model/errors.js';
import type { PermissionMode } from '../model/state.js';

/** Long flags `claude --help` 2.1.316 lists (fixtures/claude-help-2.1.316.txt; a unit test keeps this equal to the fixture). */
export const HELP_FLAGS_2_1_316: readonly string[] = Object.freeze([
  '--add-dir',
  '--agent',
  '--agents',
  '--allow-dangerously-skip-permissions',
  '--allowedTools',
  '--allowed-tools',
  '--append-system-prompt',
  '--autocompact',
  '--ax-screen-reader',
  '--bg',
  '--background',
  '--bare',
  '--betas',
  '--brief',
  '--chrome',
  '--cloud',
  '--continue',
  '--dangerously-skip-permissions',
  '--debug',
  '--debug-file',
  '--desktop',
  '--disable-slash-commands',
  '--disallowedTools',
  '--disallowed-tools',
  '--effort',
  '--environment',
  '--exclude-dynamic-system-prompt-sections',
  '--fallback-model',
  '--file',
  '--fork-session',
  '--forward-subagent-text',
  '--from-pr',
  '--help',
  '--ide',
  '--include-hook-events',
  '--include-partial-messages',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--mcp-config',
  '--model',
  '--name',
  '--no-chrome',
  '--no-session-persistence',
  '--output-format',
  '--permission-mode',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--print',
  '--prompt-suggestions',
  '--remote-control',
  '--remote-control-session-name-prefix',
  '--replay-user-messages',
  '--restricted',
  '--resume',
  '--safe-mode',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--strict-mcp-config',
  '--system-prompt',
  '--system-prompt-snapshot',
  '--teleport',
  '--tmux',
  '--tools',
  '--verbose',
  '--version',
  '--worktree',
]);

/** Short flags of the same `--help` text and their long names. */
export const SHORT_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  '-c': '--continue',
  '-d': '--debug',
  '-h': '--help',
  '-n': '--name',
  '-p': '--print',
  '-r': '--resume',
  '-v': '--version',
  '-w': '--worktree',
});

type ValueKind = 'text' | 'file' | 'none';

/**
 * The allowlist (§3.3). A flag is accepted only when it is listed here **and** the recorded `--help` lists it: the `*-file`
 * variants are UNVERIFIED in `--help` 2.1.316 and therefore rejected with reason `notInHelp` until a binary lists them.
 */
export const ALLOWED_EXTRA_FLAGS: Readonly<Record<string, ValueKind>> = Object.freeze({
  '--append-system-prompt': 'text',
  '--append-system-prompt-file': 'file',
  '--system-prompt': 'text',
  '--system-prompt-file': 'file',
  '--name': 'text',
  '--exclude-dynamic-system-prompt-sections': 'none',
});

/** Every other flag is forbidden; the reason is recorded in `details.reason` (rev 2 §10 G6). Unlisted flags → `notAllowlisted`. */
export const FORBIDDEN_FLAG_REASONS: Readonly<Record<string, string>> = Object.freeze({
  '--allowedTools': 'addsPermissionRules',
  '--allowed-tools': 'addsPermissionRules',
  '--disallowedTools': 'addsPermissionRules',
  '--disallowed-tools': 'addsPermissionRules',
  '--add-dir': 'bypassesAllowAddDirectories',
  '--tools': 'changesToolSet',
  '--mcp-config': 'loadsHooksOrServers',
  '--plugin-dir': 'loadsHooksOrServers',
  '--plugin-url': 'loadsHooksOrServers',
  '--agents': 'loadsHooksOrServers',
  '--agent': 'loadsHooksOrServers',
  '--verbose': 'changesScreen',
  '--prompt-suggestions': 'changesScreen',
  '--ax-screen-reader': 'changesScreen',
  '--debug': 'libraryOwned',
  '--debug-file': 'libraryOwned',
  '--model': 'firstClassOption',
  '--effort': 'firstClassOption',
  '--permission-mode': 'firstClassOption',
  '--fallback-model': 'unsupported',
  '--settings': 'libraryOwned',
  '--setting-sources': 'dropsUserSettings',
  '--managed-settings': 'libraryOwned',
  '--session-id': 'libraryOwned',
  '--resume': 'useResumeOption',
  '--continue': 'useResumeOption',
  '--fork-session': 'unsupported',
  '--from-pr': 'unsupported',
  '--teleport': 'unsupported',
  '--print': 'notInteractive',
  '--output-format': 'notInteractive',
  '--input-format': 'notInteractive',
  '--json-schema': 'notInteractive',
  '--max-budget-usd': 'notInteractive',
  '--permission-prompts': 'notInteractive',
  '--include-hook-events': 'notInteractive',
  '--include-partial-messages': 'notInteractive',
  '--forward-subagent-text': 'notInteractive',
  '--replay-user-messages': 'notInteractive',
  '--no-session-persistence': 'notInteractive',
  '--help': 'notInteractive',
  '--version': 'notInteractive',
  '--bare': 'disablesHooks',
  '--safe-mode': 'disablesHooks',
  '--restricted': 'unsupported',
  '--disable-slash-commands': 'unsupported',
  '--dangerously-skip-permissions': 'skipsPermissions',
  '--allow-dangerously-skip-permissions': 'skipsPermissions',
  '--teammate-mode': 'libraryOwned',
  '--bg': 'background',
  '--background': 'background',
  '--remote-control': 'remoteControl',
  '--remote-control-session-name-prefix': 'remoteControl',
  '--cloud': 'unsupported',
  '--environment': 'unsupported',
  '--desktop': 'unsupported',
  '--worktree': 'unsupported',
  '--tmux': 'unsupported',
  '--ide': 'unsupported',
  '--chrome': 'unsupported',
  '--no-chrome': 'unsupported',
  '--file': 'unsupported',
  '--betas': 'unsupported',
  '--brief': 'unsupported',
  '--autocompact': 'unsupported',
  '--system-prompt-snapshot': 'notAllowlisted',
  '--strict-mcp-config': 'useSecurityMcpStrict',
});

const HELP_SET: ReadonlySet<string> = new Set(HELP_FLAGS_2_1_316);
const MAX_VALUE_BYTES = 8 * 1024;
// C0 (incl. TAB/LF/CR), DEL and C1 controls.

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function forbidden(arg: string, reason: string): CcdError {
  return new CcdError('E_FORBIDDEN_ARG', `extraArgs: ${arg} is not allowed (${reason})`, { details: { arg, reason } });
}

/** Lone UTF-16 surrogates would reach Claude as U+FFFD (String.prototype.isWellFormed is ES2024, not in our lib). */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function checkValue(flag: string, value: string): void {
  if (value === '') throw forbidden(flag, 'emptyValue');
  if (CONTROL_RE.test(value)) throw forbidden(flag, 'controlCharacter');
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw forbidden(flag, 'valueTooLong');
  if (hasLoneSurrogate(value)) throw forbidden(flag, 'loneSurrogate');
}

export interface ExtraArg {
  flag: string;
  kind: ValueKind;
  value?: string;
}

/** Parse + validate `extraArgs` against the allowlist (pure). Returns the canonical argv (`--flag`, `value` pairs). */
export function validateExtraArgs(
  args: readonly string[],
  helpFlags: ReadonlySet<string> = HELP_SET,
): { argv: string[]; parsed: ExtraArg[] } {
  const parsed: ExtraArg[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') throw forbidden(String(a), 'notAString');
    if (a === '--') throw forbidden(a, 'endOfOptions');
    if (!a.startsWith('-') || a === '-') throw forbidden(a.slice(0, 40), 'positional');
    let flag: string;
    let inline: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      flag = eq < 0 ? a : a.slice(0, eq);
      if (eq >= 0) inline = a.slice(eq + 1);
    } else {
      // Short flags: `-n name`, `-n=name`, `-nname` and bundles like `-dp` are all recognised; only `-n` is ever allowed.
      const letter = a.slice(0, 2);
      const long = SHORT_FLAGS[letter];
      if (long === undefined) throw forbidden(a.slice(0, 40), 'unknownFlag');
      flag = long;
      const rest = a.slice(2);
      if (rest !== '') {
        if (long !== '--name') throw forbidden(a.slice(0, 40), FORBIDDEN_FLAG_REASONS[long] ?? 'notAllowlisted');
        inline = rest.startsWith('=') ? rest.slice(1) : rest;
      }
    }
    if (!/^--[A-Za-z][A-Za-z0-9-]*$/.test(flag)) throw forbidden(flag.slice(0, 40), 'malformedFlag');
    const kind = ALLOWED_EXTRA_FLAGS[flag];
    if (kind === undefined) {
      const reason = FORBIDDEN_FLAG_REASONS[flag] ?? (flag.startsWith('--remote-control') ? 'remoteControl' : 'notAllowlisted');
      throw forbidden(flag, reason);
    }
    if (!helpFlags.has(flag)) throw forbidden(flag, 'notInHelp');
    if (kind === 'none') {
      if (inline !== undefined) throw forbidden(flag, 'unexpectedValue');
      parsed.push({ flag, kind });
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = args[i + 1];
      if (typeof next !== 'string') throw forbidden(flag, 'missingValue');
      // A value that looks like a flag would be parsed as one by Claude; the `--flag=value` form is required for it.
      if (next.startsWith('-')) throw forbidden(flag, 'valueLooksLikeFlag');
      value = next;
      i++;
    }
    checkValue(flag, value);
    parsed.push({ flag, kind, value });
  }
  const argv: string[] = [];
  for (const p of parsed) {
    argv.push(p.flag);
    if (p.value !== undefined) argv.push(p.value);
  }
  return { argv, parsed };
}

/** `*-file` values must be an existing regular file, not a symlink (lstat), at an absolute path (§3.3). */
export async function checkExtraArgFiles(
  parsed: readonly ExtraArg[],
  lstat: (p: string) => Promise<{ isSymlink: boolean; isFile: boolean; isDir: boolean } | undefined>,
): Promise<void> {
  for (const p of parsed) {
    if (p.kind !== 'file' || p.value === undefined) continue;
    if (!p.value.startsWith('/')) throw forbidden(p.flag, 'fileNotAbsolute');
    const st = await lstat(p.value);
    if (st === undefined) throw forbidden(p.flag, 'fileMissing');
    if (st.isSymlink) throw forbidden(p.flag, 'fileIsSymlink');
    if (!st.isFile) throw forbidden(p.flag, 'fileNotRegular');
  }
}

export const DANGEROUS_MODES: readonly PermissionMode[] = Object.freeze(['bypassPermissions', 'auto', 'dontAsk']);
const MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
const SAFE_PATH_RE = /^\/[^\0\n\r]*$/;

export interface ClaudeArgvInput {
  exe: string;
  /** Exactly one of them. */
  sessionId?: string;
  resume?: string;
  settingsPath: string;
  permissionMode: PermissionMode;
  allowDangerousModes: boolean;
  model?: string;
  effort?: string;
  strictMcp: boolean;
  debugFile?: string;
  /** Already validated with `validateExtraArgs`. */
  extraArgs: readonly string[];
}

/** Build the pane argv (D-08). Throws `E_MODE_FORBIDDEN`, `E_CONFIG_INVALID` or `E_INVARIANT` on a bad input. */
export function buildClaudeArgv(o: ClaudeArgvInput): readonly [string, string, ...string[]] {
  if (!o.exe.startsWith('/') || !SAFE_PATH_RE.test(o.exe)) throw new CcdError('E_INVARIANT', 'claude exe must be an absolute path');
  if (!SAFE_PATH_RE.test(o.settingsPath)) throw new CcdError('E_INVARIANT', 'settings path must be absolute');
  if ((o.sessionId === undefined) === (o.resume === undefined))
    throw new CcdError('E_INVARIANT', 'exactly one of sessionId / resume is required (never both, LC §8.1)');
  const id = o.sessionId ?? o.resume ?? '';
  if (o.sessionId !== undefined && !UUID_RE.test(id))
    throw new CcdError('E_CONFIG_INVALID', 'sessionId must be a UUID', { details: { reason: 'sessionId' } });
  if (o.resume !== undefined && !/^[A-Za-z0-9-]{1,128}$/.test(id))
    throw new CcdError('E_CONFIG_INVALID', 'resume must be a session id', { details: { reason: 'resume' } });
  if (!MODES.has(o.permissionMode))
    throw new CcdError('E_CONFIG_INVALID', `unknown permission mode ${o.permissionMode as string}`, {
      details: { reason: 'permissionMode' },
    });
  if (DANGEROUS_MODES.includes(o.permissionMode) && !o.allowDangerousModes)
    throw new CcdError('E_MODE_FORBIDDEN', `permission mode ${o.permissionMode} needs permissions.allowDangerousModes`, {
      details: { mode: o.permissionMode },
    });
  if (o.model !== undefined && !MODEL_RE.test(o.model))
    throw new CcdError('E_CONFIG_INVALID', 'model contains unsupported characters', { details: { reason: 'model' } });
  if (o.effort !== undefined && !EFFORTS.has(o.effort))
    throw new CcdError('E_CONFIG_INVALID', `effort must be one of ${[...EFFORTS].join(', ')}`, { details: { reason: 'effort' } });
  if (o.debugFile !== undefined && !SAFE_PATH_RE.test(o.debugFile)) throw new CcdError('E_INVARIANT', 'debug file must be absolute');

  const argv: string[] = ['/usr/bin/env', '-u', 'TMUX', '-u', 'TMUX_PANE', o.exe];
  if (o.sessionId !== undefined) argv.push('--session-id', o.sessionId);
  else argv.push('--resume', id);
  argv.push('--settings', o.settingsPath);
  argv.push('--permission-mode', o.permissionMode);
  argv.push('--teammate-mode', 'in-process');
  if (o.model !== undefined) argv.push('--model', o.model);
  if (o.effort !== undefined) argv.push('--effort', o.effort);
  if (o.strictMcp) argv.push('--strict-mcp-config');
  if (o.debugFile !== undefined) argv.push('--debug-file', o.debugFile);
  // Re-validate (defence in depth: config.extraArgs must already be canonical).
  argv.push(...validateExtraArgs(o.extraArgs).argv);
  const [first, second, ...rest] = argv;
  if (first === undefined || second === undefined) throw new CcdError('E_INVARIANT', 'argv must have ≥ 2 elements (P-TMUX-24)');
  return [first, second, ...rest];
}

/** Parse long and short flag names out of a `claude --help` text (used by the fixture test and the allowlist gate). */
export function parseHelpFlags(helpText: string): { long: string[]; short: Record<string, string> } {
  const long: string[] = [];
  const short: Record<string, string> = {};
  const section = helpText.split(/\n(?=Commands:)/)[0] ?? helpText;
  for (const line of section.split('\n')) {
    const m = /^ {2}((?:-[A-Za-z], )?--[A-Za-z][A-Za-z0-9-]*(?:, --[A-Za-z][A-Za-z0-9-]*)?)/.exec(line);
    if (m?.[1] === undefined) continue;
    const parts = m[1].split(', ');
    let shortName: string | undefined;
    for (const p of parts) {
      if (/^-[A-Za-z]$/.test(p)) shortName = p;
      else if (!long.includes(p)) long.push(p);
    }
    const lastLong = parts.filter((p) => p.startsWith('--')).at(-1);
    if (shortName !== undefined && lastLong !== undefined) short[shortName] = lastLong;
  }
  return { long, short };
}
