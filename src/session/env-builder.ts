// session/env-builder.ts — the child environment of Claude (DESIGN.md §3.2, D-22, D-25, §3.10 env).
//
// Order: base allowlist → caller `env.set` → library-required → strip list → proxy handling. The host env always comes from
// `EnvPort.snapshot()`; `process.env` is never read or spread here (arch test 3d). Names only are ever logged (SEC §7.2).
//
// Pitfalls handled here (§5):
//   P-TMUX-49  LC_ALL forced to a UTF-8 locale when none is set (launchd/cron)
//   P-INPUT-16, P-REV-31  VISUAL = our ccd-editor; GIT_EDITOR = user's GIT_EDITOR → user's VISUAL/EDITOR → `true`
//   P-TAIL-04, P-TAIL-29  CLAUDE_CODE_SKIP_PROMPT_HISTORY / CLAUDE_CODE_CHILD_SESSION stripped; FORCE_SESSION_PERSISTENCE=1
//   P-HOOK-12  CLAUDE_CODE_SAFE_MODE / CLAUDE_CODE_SIMPLE stripped
//   P-HOOK-19, P-NET-22, D-22  NO_PROXY/no_proxy get 127.0.0.1,localhost,::1 whenever any proxy variable is present
//   P-NET-31/32/33/34  a user proxy / NO_PROXY covering api.anthropic.com / proxy auth helper turns the channel off; ALL_PROXY passed
//   P-NET-37  proxy URL built with `new URL()` and its host asserted
//   P-NET-39  ANTHROPIC_UNIX_SOCKET stripped
//   P-LIFE-24  DISABLE_UPDATES=1, DISABLE_INSTALLATION_CHECKS=1
//   P-LIFE-25  USER and HOME mandatory
//   P-LIFE-26  CLAUDE_CONFIG_DIR kept only when the host already has it, never introduced
//   P-LIFE-32  ANTHROPIC_API_KEY stripped
//   P-LIFE-42  CLAUDE_CODE_RETRY_WATCHDOG(_*) stripped
//   P-LIFE-56, P-SEC-19  allowlist + strip list
//   P-SEC-18   secrets only in this env (the tmux starting-client env), never in argv
//   P-SEC-38   NODE_OPTIONS / NODE_PATH stripped
//   P-REV-04   provider switches stripped (inherited) or E_FORBIDDEN_ENV (caller env.set)
//   P-REV-05   model-call semantics vars stripped
//   P-REV-06   privacy pass-through list kept as the user set it
//   P-REV-18   CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS stripped (D-24)

import { CcdError } from '../model/errors.js';

export const BASE_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TZ',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'EDITOR',
  'VISUAL',
  'GIT_EDITOR',
]);
/** Every `LC_*` variable is part of the base allowlist. */
const BASE_PREFIXES: readonly string[] = Object.freeze(['LC_']);

/** Kept exactly as the user set them (OD §4.2, rev 2 §10 G15, P-REV-06). */
export const PRIVACY_PASSTHROUGH: readonly string[] = Object.freeze([
  'DISABLE_TELEMETRY',
  'DISABLE_GROWTHBOOK',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_BUG_COMMAND',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DO_NOT_TRACK',
]);

/** Provider switches move billing off the subscription (P-REV-04). Inherited → stripped + warning; caller → E_FORBIDDEN_ENV. */
export const PROVIDER_SWITCHES: readonly string[] = Object.freeze([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
]);

/** Model-call semantics: they change `attempt n/10`, stall timing and hook payload sizes (P-REV-05). */
export const SEMANTICS_VARS: readonly string[] = Object.freeze([
  'CLAUDE_CODE_MAX_RETRIES',
  'API_TIMEOUT_MS',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS',
  'CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_ENABLE_STREAM_WATCHDOG',
  'CLAUDE_ENABLE_BYTE_WATCHDOG',
  'BASH_MAX_OUTPUT_LENGTH',
]);

/** Stripped even under `inherit:'all'` (§3.2). Provider switches and semantics vars are appended below. */
export const STRIP_ALWAYS: readonly string[] = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_ENV_FILE',
  'CLAUDE_CODE_SAFE_MODE',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_SANDBOXED',
  'CLAUDE_CODE_IGNORE_PERSISTED_TRUST',
  'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
  'CLAUDE_CODE_TRANSCRIPT_LOCAL_GC',
  'CLAUDE_CODE_PROJECT_DIR_NAME',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_SUPERVISED',
  'CLAUDE_BG_BACKEND',
  'CLAUDE_JOB_DIR',
  'FORCE_AUTOUPDATE_PLUGINS',
  'CLAUDE_CODE_FORCE_FIRST_LAUNCH',
  'CLAUDE_CODE_RESTRICTED',
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'IS_DEMO',
  'TMUX',
  'TMUX_PANE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  ...SEMANTICS_VARS,
  ...PROVIDER_SWITCHES,
]);
/** Prefix entries of the strip list (`CLAUDE_CODE_RETRY_WATCHDOG_*`, `BUN_*`). */
const STRIP_PREFIXES: readonly string[] = Object.freeze(['CLAUDE_CODE_RETRY_WATCHDOG_', 'BUN_']);

/** Caller `env.set` names that fail the start (BRIEF: never redirect the API; P-REV-04). */
const CALLER_FORBIDDEN: readonly string[] = Object.freeze(['ANTHROPIC_BASE_URL', ...PROVIDER_SWITCHES]);

/** Proxy variables, in Claude's precedence order (lowercase first, NP §6). */
const PROXY_VARS: readonly string[] = Object.freeze([
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
]);

/** Always appended to NO_PROXY/no_proxy when any proxy variable is present (D-22). Exact hosts only: no CIDR (P-HOOK-19). */
const LOOPBACK_NO_PROXY: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '::1']);

export const LIBRARY_REQUIRED: Readonly<Record<string, string>> = Object.freeze({
  DISABLE_AUTOUPDATER: '1',
  DISABLE_UPDATES: '1',
  DISABLE_INSTALLATION_CHECKS: '1',
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '5000',
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
});

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_BYTES = 128 * 1024;

const STRIP_SET: ReadonlySet<string> = new Set(STRIP_ALWAYS);
const PROVIDER_SET: ReadonlySet<string> = new Set(PROVIDER_SWITCHES);
const SEMANTICS_SET: ReadonlySet<string> = new Set(SEMANTICS_VARS);
const PROXY_SET: ReadonlySet<string> = new Set(PROXY_VARS);

export function isStripped(name: string): boolean {
  return STRIP_SET.has(name) || STRIP_PREFIXES.some((p) => name.startsWith(p));
}

export interface EnvWarning {
  code: 'E_FORBIDDEN_ENV' | 'E_NETWORK_UNAVAILABLE';
  reason: string;
  /** Variable names only, never values. */
  names: string[];
}

/**
 * Validates the caller's `env.set` (§3.1 step 1). Throws `E_FORBIDDEN_ENV{name}` for `ANTHROPIC_BASE_URL` or a provider switch,
 * `E_CONFIG_INVALID` for a malformed name or value. Other strip-list names are accepted here and removed by the strip step.
 */
export function checkCallerEnv(set: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(set)) {
    if (!NAME_RE.test(name))
      throw new CcdError('E_CONFIG_INVALID', 'env.set: invalid variable name', { details: { reason: 'envName', name } });
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > MAX_VALUE_BYTES)
      throw new CcdError('E_CONFIG_INVALID', `env.set.${name}: value must be a string without NUL, ≤ 128 KiB`, {
        details: { reason: 'envValue', name },
      });
    if (CALLER_FORBIDDEN.includes(name))
      throw new CcdError('E_FORBIDDEN_ENV', `env.set may not set ${name}`, {
        details: { reason: PROVIDER_SET.has(name) ? 'providerSwitch' : 'baseUrl', name },
      });
  }
}

/**
 * P-REV-12: a user's settings.json `env` block can re-introduce a stripped variable (we cannot unset it through `--settings`).
 * Provider switch → `E_FORBIDDEN_ENV{reason:'settingsEnv', name}`; semantics vars / other stripped names → warnings.
 */
export function checkSettingsEnv(layers: readonly { layer: string; value: unknown }[]): EnvWarning[] {
  const warnings: EnvWarning[] = [];
  for (const { layer, value } of layers) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const env = (value as { env?: unknown }).env;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) continue;
    const names = Object.keys(env);
    for (const name of names) {
      if (PROVIDER_SET.has(name) || name === 'ANTHROPIC_BASE_URL')
        throw new CcdError('E_FORBIDDEN_ENV', `the ${layer} settings env block sets ${name}`, {
          details: { reason: 'settingsEnv', name, layer },
        });
    }
    const semantics = names.filter((n) => SEMANTICS_SET.has(n));
    if (semantics.length > 0) warnings.push({ code: 'E_FORBIDDEN_ENV', reason: `settingsEnvSemantics:${layer}`, names: semantics });
    const other = names.filter((n) => !SEMANTICS_SET.has(n) && isStripped(n));
    if (other.length > 0) warnings.push({ code: 'E_FORBIDDEN_ENV', reason: `settingsEnvStripped:${layer}`, names: other });
  }
  return warnings;
}

// ------------------------------------------------------------------------------------------------------------- proxies

export interface UserProxy {
  /** Effective HTTPS proxy (lowercase wins, NP §6). */
  https?: string;
  http?: string;
  all?: string;
  /** Merged NO_PROXY ∪ no_proxy entries, de-duplicated, order kept. */
  noProxy: string[];
  /** Any proxy variable present at all (D-22 trigger). */
  present: boolean;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== '' ? v : undefined;
}

function splitNoProxy(v: string | undefined): string[] {
  if (v === undefined) return [];
  return v
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function readUserProxy(host: Readonly<Record<string, string>>): UserProxy {
  const https = nonEmpty(host['https_proxy']) ?? nonEmpty(host['HTTPS_PROXY']);
  const http = nonEmpty(host['http_proxy']) ?? nonEmpty(host['HTTP_PROXY']);
  const all = nonEmpty(host['all_proxy']) ?? nonEmpty(host['ALL_PROXY']);
  const noProxy: string[] = [];
  for (const e of [...splitNoProxy(host['NO_PROXY']), ...splitNoProxy(host['no_proxy'])]) if (!noProxy.includes(e)) noProxy.push(e);
  const present = PROXY_VARS.some((n) => nonEmpty(host[n]) !== undefined);
  const out: UserProxy = { noProxy, present };
  if (https !== undefined) out.https = https;
  if (http !== undefined) out.http = http;
  if (all !== undefined) out.all = all;
  return out;
}

/** True when a NO_PROXY entry exempts `host` (exact, `.suffix`, `suffix`, `*`; an optional `:port` is ignored). */
export function noProxyCovers(entries: readonly string[], host: string): boolean {
  const h = host.toLowerCase();
  for (const raw of entries) {
    let e = raw.toLowerCase();
    if (e === '*') return true;
    const colon = e.lastIndexOf(':');
    if (colon > 0 && !e.includes(']') && /^\d+$/.test(e.slice(colon + 1))) e = e.slice(0, colon);
    if (e.startsWith('*.')) e = e.slice(1);
    if (e === '') continue;
    if (e.startsWith('.')) {
      if (h.endsWith(e) || h === e.slice(1)) return true;
    } else if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

export type NetworkEligibility = { ok: true } | { ok: false; reason: 'userProxy' | 'noProxyCovers' | 'proxyAuthHelper' };

/** §3.10: the network channel is refused (channel off + warning) when the user's env already routes or exempts the API. */
export function networkEligibility(host: Readonly<Record<string, string>>): NetworkEligibility {
  const p = readUserProxy(host);
  if (p.https !== undefined || p.http !== undefined || p.all !== undefined) return { ok: false, reason: 'userProxy' };
  if (noProxyCovers(p.noProxy, 'api.anthropic.com')) return { ok: false, reason: 'noProxyCovers' };
  if (nonEmpty(host['CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER']) !== undefined) return { ok: false, reason: 'proxyAuthHelper' };
  return { ok: true };
}

/** P-NET-37: `http://ccd:<tokenA>@127.0.0.1:<port>` built with `new URL()`; the host is asserted. */
export function libraryProxyUrl(tokenA: string, port: number): string {
  if (!/^[0-9a-f]{16,256}$/.test(tokenA)) throw new CcdError('E_INVARIANT', 'proxy token must be lowercase hex');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new CcdError('E_INVARIANT', `proxy port out of range: ${port}`);
  const text = `http://ccd:${tokenA}@127.0.0.1:${port}`;
  const u = new URL(text);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.port !== String(port) || u.username !== 'ccd' || u.password !== tokenA)
    throw new CcdError('E_INVARIANT', 'proxy URL did not round-trip');
  return text;
}

// ------------------------------------------------------------------------------------------------------------- builder

export interface ChildEnvInput {
  /** `EnvPort.snapshot()`. */
  host: Readonly<Record<string, string>>;
  homeDir: string;
  userName: string;
  platform: 'darwin' | 'linux' | 'other';
  inherit: 'minimal' | 'all' | readonly string[];
  set: Readonly<Record<string, string>>;
  scrubSubprocessEnv: boolean;
  /** `<sessionDir>/ccd-editor` (EditorInjector.setup). */
  visualPath: string;
  /** Network channel on: the library proxy (phase 2). Absent = network off (phase 1, or the channel was refused). */
  libraryProxy?: { tokenA: string; port: number };
}

export interface ChildEnv {
  env: Readonly<Record<string, string>>;
  warnings: EnvWarning[];
  /** Sorted variable names (for the debug log; never values, SEC §7.2). */
  names: string[];
  /** True when the env carries a secret (the proxy token), so it may only reach tmux as the starting-client env. */
  carriesSecret: boolean;
}

function inBase(name: string): boolean {
  return BASE_ALLOWLIST.includes(name) || BASE_PREFIXES.some((p) => name.startsWith(p)) || PRIVACY_PASSTHROUGH.includes(name);
}

function hasUtf8Locale(env: Readonly<Record<string, string>>): boolean {
  const eff = nonEmpty(env['LC_ALL']) ?? nonEmpty(env['LC_CTYPE']) ?? nonEmpty(env['LANG']);
  return eff !== undefined && /utf-?8/i.test(eff);
}

/** Build the child env (§3.2). Pure: everything it needs is in `input`. */
export function buildChildEnv(input: ChildEnvInput): ChildEnv {
  checkCallerEnv(input.set);
  const host = input.host;
  const out: Record<string, string> = {};
  const warnings: EnvWarning[] = [];

  // 1. Base allowlist (or everything for inherit:'all'; or the base plus the listed names).
  const extra: ReadonlySet<string> = new Set(Array.isArray(input.inherit) ? input.inherit : []);
  for (const name of Object.keys(host).sort()) {
    const v = host[name];
    if (v === undefined || PROXY_SET.has(name)) continue; // proxies are handled in step 5 only
    const take = input.inherit === 'all' || inBase(name) || extra.has(name) || name === 'CLAUDE_CONFIG_DIR';
    if (take) out[name] = v;
  }
  // SSH_AUTH_SOCK only when explicitly listed (SEC §7.2); `inherit:'all'` takes it like any other variable.
  if (input.inherit !== 'all' && !extra.has('SSH_AUTH_SOCK')) Reflect.deleteProperty(out, 'SSH_AUTH_SOCK');

  // Inherited stripped names that matter enough to warn about (names only).
  const inheritedProviders = Object.keys(host).filter((n) => PROVIDER_SET.has(n));
  if (inheritedProviders.length > 0)
    warnings.push({ code: 'E_FORBIDDEN_ENV', reason: 'providerSwitchStripped', names: inheritedProviders });

  // 2. Caller env.set (validated above).
  for (const [k, v] of Object.entries(input.set)) {
    if (PROXY_SET.has(k)) continue; // the user's proxy is taken from the host env only (§3.2, §3.10)
    out[k] = v;
  }

  // Mandatory identity (keychain account = $USER, LC §1.3; P-LIFE-25).
  if (nonEmpty(out['HOME']) === undefined) out['HOME'] = input.homeDir;
  if (nonEmpty(out['USER']) === undefined) out['USER'] = input.userName;
  if (nonEmpty(out['LOGNAME']) === undefined) out['LOGNAME'] = out['USER'] ?? input.userName;
  // CLAUDE_CONFIG_DIR: kept only if the host already has it (never introduced, P-LIFE-26).
  const hostConfigDir = host['CLAUDE_CONFIG_DIR'];
  if (hostConfigDir === undefined) Reflect.deleteProperty(out, 'CLAUDE_CONFIG_DIR');
  else out['CLAUDE_CONFIG_DIR'] = hostConfigDir;
  // UTF-8 locale (P-TMUX-49).
  if (!hasUtf8Locale(out)) out['LC_ALL'] = input.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';

  // 3. Library-required.
  for (const [k, v] of Object.entries(LIBRARY_REQUIRED)) out[k] = v;
  if (input.scrubSubprocessEnv) out['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'] = '1';
  else Reflect.deleteProperty(out, 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
  // Editor chain (rev 2 §10 A11): VISUAL is ours; the user's editor is preserved for git.
  const userVisual = nonEmpty(host['VISUAL']);
  const userEditor = nonEmpty(host['EDITOR']);
  out['VISUAL'] = input.visualPath;
  out['GIT_EDITOR'] = nonEmpty(host['GIT_EDITOR']) ?? userVisual ?? userEditor ?? 'true';

  // 4. Strip list (always, even under inherit:'all').
  for (const name of Object.keys(out)) if (isStripped(name)) Reflect.deleteProperty(out, name);

  // 5. Proxies.
  for (const name of PROXY_VARS) Reflect.deleteProperty(out, name);
  const user = readUserProxy(host);
  if (input.libraryProxy !== undefined) {
    const url = libraryProxyUrl(input.libraryProxy.tokenA, input.libraryProxy.port);
    out['HTTPS_PROXY'] = url;
    out['https_proxy'] = url;
    const np = LOOPBACK_NO_PROXY.join(',');
    out['NO_PROXY'] = np;
    out['no_proxy'] = np;
  } else if (user.present) {
    if (user.https !== undefined) {
      out['HTTPS_PROXY'] = user.https;
      out['https_proxy'] = user.https;
    }
    if (user.http !== undefined) {
      out['HTTP_PROXY'] = user.http;
      out['http_proxy'] = user.http;
    }
    if (user.all !== undefined) {
      out['ALL_PROXY'] = user.all;
      out['all_proxy'] = user.all;
    }
    const merged = [...user.noProxy];
    for (const l of LOOPBACK_NO_PROXY) if (!merged.includes(l)) merged.push(l);
    const np = merged.join(',');
    out['NO_PROXY'] = np;
    out['no_proxy'] = np;
  }

  const frozen = Object.freeze({ ...out });
  return { env: frozen, warnings, names: Object.keys(frozen).sort(), carriesSecret: input.libraryProxy !== undefined };
}

/** P-SEC-18: true when any secret-looking env value (the proxy token) appears inside an argv element. */
export function argvLeaksEnvSecret(argv: readonly string[], env: Readonly<Record<string, string>>): boolean {
  const secrets: string[] = [];
  for (const name of ['HTTPS_PROXY', 'https_proxy']) {
    const v = env[name];
    if (v === undefined) continue;
    try {
      const pw = new URL(v).password;
      if (pw !== '') secrets.push(pw);
    } catch {
      // not a URL: nothing to compare
    }
  }
  return secrets.some((s) => argv.some((a) => a.includes(s)));
}
