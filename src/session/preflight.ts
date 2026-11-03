// session/preflight.ts — every pre-launch check of `start()` (DESIGN.md §3.1 steps 1–7 and the tmux probe of step 12).
//
// Each check either returns or throws the named CcdError. The launcher calls them in the §3.1 order; they are separate
// functions so each one is unit-testable against the fakes.
//
// Pitfalls handled here (§5):
//   P-TMUX-41  tmux searched on $PATH and /opt/homebrew/bin, /usr/local/bin, /usr/bin → E_TMUX_NOT_FOUND with a hint
//   P-TMUX-50  Linux: `infocmp tmux-256color` (missing terminfo → warning; the pane falls back to what tmux finds)
//   P-INPUT-37 keybindings.json rebinding enter/escape/ctrl+g/ctrl+j/shift+tab/ctrl+c → E_KEYBINDING_CONFLICT
//   P-HOOK-04, P-SEC-29  disableAllHooks:true in a readable layer and no override → E_HOOKS_DISABLED_BY_USER (D-14)
//   P-LIFE-02  hasCompletedOnboarding + `auth status`
//   P-LIFE-08, P-LIFE-38  `auth status` never killed early (port contract, 10 s)
//   P-LIFE-41  concurrent starts in one process staggered by 1.5 s (refresh lock)
//   P-LIFE-18, P-REV-37  resume id held by a live process → E_SESSION_ID_IN_USE (never touch a non-library holder)
//   P-SEC-15   trust:'require' default; 'seed' only after inspectWorkspace
//   P-REV-04   apiProvider !== 'firstParty' → E_API_PROVIDER_UNSUPPORTED
//   P-REV-12   settings `env` blocks: provider switch → E_FORBIDDEN_ENV{settingsEnv}; semantics vars → warning
//   (§3.1 step 5, K-03) version checked before any tmux call

import type { ResolvedConfig } from '../model/config.js';
import type { Clock } from '../model/time.js';
import type {
  ClaudeBinaryPort,
  ClaudeConfigPort,
  ClaudeRegistryReader,
  EnvPort,
  ProcessPort,
  SettingsLayers,
  TmuxServerFactory,
} from '../platform/ports.js';
import { CcdError, isCcdError, type CcdErrorCode } from '../model/errors.js';
import type { JsonValue } from '../model/json.js';
import { SUPPORTED_CLAUDE_VERSION } from '../model/version.js';
import { checkExtraArgFiles, validateExtraArgs } from './argv-builder.js';
import { checkSettingsEnv, type EnvWarning } from './env-builder.js';
import { toCcdError } from './errors-map.js';
import type { RegistryStore } from './registry-store.js';

const MIN_NODE_MAJOR = 20;
const AUTH_STAGGER_MS = 1_500;
export const TMUX_SEARCH_DIRS: readonly string[] = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
/** Keys the input protocols use (IN §2); a user rebinding any of them breaks the library. */
const GUARDED_KEYS: readonly string[] = Object.freeze(['enter', 'escape', 'ctrl+g', 'ctrl+j', 'shift+tab', 'ctrl+c']);

export interface PreflightWarning {
  code: CcdErrorCode;
  reason: string;
  details?: Record<string, string | number | boolean | string[]>;
}

// ------------------------------------------------------------------------------------------------- error mapping

/**
 * L0 errors are mapped by session/errors-map.ts (duck-typed by `name`, session imports platform types only); CcdErrors pass
 * through. An error errors-map cannot classify (E_INVARIANT) takes the step's `fallback` code instead.
 */
export function mapPortError(e: unknown, fallback: CcdErrorCode, message: string): CcdError {
  if (isCcdError(e)) return toCcdError(e);
  const m = toCcdError(e, { op: message });
  if (m.code !== 'E_INVARIANT' || fallback === 'E_INVARIANT') return m;
  const details: Record<string, JsonValue> = { ...(m.details ?? {}) };
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  if (typeof name === 'string') details['l0'] = name.slice(0, 64);
  return new CcdError(fallback, `${message}: ${m.message}`, { cause: e, details });
}

// ------------------------------------------------------------------------------------------------- step 1 / 2

/** §3.1 step 1 parts owned by L3 launch: extraArgs allowlist (pure) + the `*-file` checks (lstat). */
export async function checkExtraArgs(extraArgs: readonly string[], env: Pick<EnvPort, 'lstat'>): Promise<string[]> {
  const { argv, parsed } = validateExtraArgs(extraArgs);
  await checkExtraArgFiles(parsed, (p) => env.lstat(p));
  return argv;
}

/** `cwd` must exist and be a directory; returns its realpath (macOS `/var` → `/private/var`, LV Q4). */
export async function checkCwd(env: Pick<EnvPort, 'lstat' | 'realpath'>, cwd: string): Promise<string> {
  if (!cwd.startsWith('/')) throw new CcdError('E_CONFIG_INVALID', 'cwd must be absolute', { details: { reason: 'cwdNotAbsolute' } });
  let real: string;
  try {
    real = await env.realpath(cwd);
  } catch (e) {
    throw new CcdError('E_CONFIG_INVALID', 'cwd does not exist', { cause: e, details: { reason: 'cwdMissing' } });
  }
  const st = await env.lstat(real);
  if (st === undefined) throw new CcdError('E_CONFIG_INVALID', 'cwd does not exist', { details: { reason: 'cwdMissing' } });
  if (!st.isDir) throw new CcdError('E_CONFIG_INVALID', 'cwd is not a directory', { details: { reason: 'cwdNotDirectory' } });
  return real;
}

export function checkNode(version: string): void {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1] ?? NaN);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR)
    throw new CcdError('E_NODE_UNSUPPORTED', `Node ${version} is not supported (need ≥ ${MIN_NODE_MAJOR}.0)`, {
      details: { found: version, min: `${MIN_NODE_MAJOR}.0` },
    });
}

// ------------------------------------------------------------------------------------------------- step 3

/** `state.root` must not be a symlink or a non-directory (SEC §9). A missing root is created lazily by the store. */
export async function checkStateRoot(env: Pick<EnvPort, 'lstat'>, root: string): Promise<void> {
  if (!root.startsWith('/'))
    throw new CcdError('E_UNSAFE_RUNTIME_DIR', 'state dir must be absolute', { details: { reason: 'notAbsolute' } });
  const st = await env.lstat(root);
  if (st === undefined) return;
  if (st.isSymlink) throw new CcdError('E_UNSAFE_RUNTIME_DIR', 'state dir is a symlink', { details: { reason: 'symlink', path: root } });
  if (!st.isDir)
    throw new CcdError('E_UNSAFE_RUNTIME_DIR', 'state dir is not a directory', { details: { reason: 'notDirectory', path: root } });
}

// ------------------------------------------------------------------------------------------------- step 5

export interface ClaudeBinaryInfo {
  exe: string;
  via: 'option' | 'consumer' | 'package' | 'path';
  version: string;
}

/** §3.1 step 5 (before any tmux call, K-03). */
export async function checkClaudeBinary(
  claude: ClaudeBinaryPort,
  o: { bin?: string; /** a version, or 'any' */ expectVersion: string },
  env1: Readonly<Record<string, string>>,
): Promise<ClaudeBinaryInfo> {
  const r = await claude.resolve(o.bin);
  if (r === undefined)
    throw new CcdError('E_CLAUDE_NOT_FOUND', 'Claude Code binary not found (install @anthropic-ai/claude-code or pass claude.bin)', {
      details: o.bin === undefined ? {} : { bin: o.bin },
    });
  let found: string;
  try {
    found = await claude.version(r.exe, env1);
  } catch (e) {
    throw mapPortError(e, 'E_CLAUDE_NOT_FOUND', 'could not read the Claude Code version');
  }
  const expected = o.expectVersion === 'any' ? undefined : o.expectVersion === '' ? SUPPORTED_CLAUDE_VERSION : o.expectVersion;
  if (expected !== undefined && found !== expected)
    throw new CcdError('E_CLAUDE_VERSION_MISMATCH', `Claude Code ${found} found, ${expected} required`, { details: { expected, found } });
  return { exe: r.exe, via: r.via, version: found };
}

// ------------------------------------------------------------------------------------------------- step 6

const staggerChains = new WeakMap<Clock, { last: number | undefined; chain: Promise<void> }>();

/** P-LIFE-41: serialise `auth status` calls of concurrent starts in this process, ≥ 1.5 s apart (refresh lock). */
export function staggerAuth<T>(clock: Clock, fn: () => Promise<T>, gapMs = AUTH_STAGGER_MS): Promise<T> {
  let s = staggerChains.get(clock);
  if (s === undefined) {
    s = { last: undefined, chain: Promise.resolve() };
    staggerChains.set(clock, s);
  }
  const state = s;
  const run = state.chain.then(async () => {
    if (state.last !== undefined) {
      const wait = state.last + gapMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
    }
    state.last = clock.now();
  });
  state.chain = run.catch(() => undefined);
  return run.then(fn);
}

export interface AccountInfo {
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
}

/** §3.1 step 6: onboarding, login, auth method, API provider. */
export async function checkAccount(
  d: { claudeConfig: ClaudeConfigPort; claude: ClaudeBinaryPort; clock: Clock },
  exe: string,
  env1: Readonly<Record<string, string>>,
): Promise<AccountInfo> {
  const g = await d.claudeConfig.readGlobal();
  if (!g.ok) {
    if (g.reason === 'invalidJson')
      throw new CcdError(
        'E_CONFIG_CORRUPT',
        '~/.claude.json is not valid JSON; fix it by hand (never "Reset with default configuration")',
        {
          details: { reason: 'invalidJson' },
        },
      );
    throw new CcdError('E_NOT_ONBOARDED', 'Claude Code has never been set up for this user (run `claude` once)', {
      details: { reason: 'missing' },
    });
  }
  if (!g.hasCompletedOnboarding) throw new CcdError('E_NOT_ONBOARDED', 'Claude Code onboarding is not complete (run `claude` once)');
  let st: Awaited<ReturnType<ClaudeBinaryPort['authStatus']>>;
  try {
    st = await staggerAuth(d.clock, () => d.claude.authStatus(exe, env1));
  } catch (e) {
    throw mapPortError(e, 'E_LOGIN_REQUIRED', 'claude auth status gave no usable answer');
  }
  if (!st.loggedIn) throw new CcdError('E_LOGIN_REQUIRED', 'Claude Code is not logged in (run `claude` and /login)');
  if (st.authMethod !== 'claude.ai')
    throw new CcdError('E_AUTH_METHOD_UNSUPPORTED', 'only a claude.ai subscription login is supported (an API key would bill the API)', {
      details: { authMethod: st.authMethod ?? 'unknown' },
    });
  if (st.apiProvider !== undefined && st.apiProvider !== 'firstParty')
    throw new CcdError('E_API_PROVIDER_UNSUPPORTED', `API provider ${st.apiProvider} is not supported`, {
      details: { apiProvider: st.apiProvider },
    });
  const out: AccountInfo = { authMethod: st.authMethod };
  if (st.apiProvider !== undefined) out.apiProvider = st.apiProvider;
  if (st.subscriptionType !== undefined) out.subscriptionType = st.subscriptionType;
  return out;
}

// ------------------------------------------------------------------------------------------------- step 7

/** Normalise a key name: lowercase, `ctrl-g` → `ctrl+g`, `return` → `enter`, `esc` → `escape`, `s-tab` → `shift+tab`. */
function normaliseKeyName(k: string): string {
  let s = k.trim().toLowerCase().replace(/\s+/g, ' ');
  // A chord: only its first element matters (a rebind of `ctrl+g ...` still captures ctrl+g as a prefix).
  s = s.split(' ')[0] ?? s;
  s = s
    .replace(/-/g, '+')
    .replace(/^control\+/, 'ctrl+')
    .replace(/^c\+/, 'ctrl+')
    .replace(/^s\+/, 'shift+');
  if (s === 'return') s = 'enter';
  if (s === 'esc') s = 'escape';
  if (s === 'btab' || s === 'backtab') s = 'shift+tab';
  return s;
}

/** Every key of a keybindings.json that rebinds a guarded key (lenient: any nesting, objects or `{key: …}` entries). */
export function keybindingConflicts(kb: unknown): string[] {
  const hits = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) {
      const nk = normaliseKeyName(k);
      if (GUARDED_KEYS.includes(nk) && (typeof x === 'string' || x === null)) hits.add(nk);
      if ((k === 'key' || k === 'keys' || k === 'chord') && typeof x === 'string' && GUARDED_KEYS.includes(normaliseKeyName(x)))
        hits.add(normaliseKeyName(x));
      visit(x, depth + 1);
    }
  };
  visit(kb, 0);
  return [...hits].sort();
}

export interface LayersVerdict {
  layers: SettingsLayers;
  /** D-14: write `disableAllHooks:false` (only with the override). */
  writeDisableAllHooksFalse: boolean;
  /** D-13: some readable layer defines `allowedHttpHookUrls`. */
  allowedHttpHookUrlsDefined: boolean;
  warnings: PreflightWarning[];
  envWarnings: EnvWarning[];
}

/** §3.1 step 7 (settings layers): D-14, keybindings, editorMode, settings `env` blocks (P-REV-12). */
export async function checkSettingsLayers(
  claudeConfig: ClaudeConfigPort,
  cwdRealpath: string,
  o: { overrideDisableAllHooks: boolean },
): Promise<LayersVerdict> {
  const layers = await claudeConfig.readLayers(cwdRealpath);
  const warnings: PreflightWarning[] = [];
  if (layers.disableAllHooksTrueIn.length > 0 && !o.overrideDisableAllHooks)
    throw new CcdError('E_HOOKS_DISABLED_BY_USER', `disableAllHooks is true in your ${layers.disableAllHooksTrueIn.join(', ')} settings`, {
      details: { layers: [...layers.disableAllHooksTrueIn] },
    });
  const conflicts = keybindingConflicts(layers.keybindings);
  if (conflicts.length > 0)
    throw new CcdError('E_KEYBINDING_CONFLICT', `keybindings.json rebinds ${conflicts.join(', ')}, which the library needs`, {
      details: { keys: conflicts },
    });
  if (layers.editorMode !== undefined && layers.editorMode !== 'normal')
    warnings.push({ code: 'E_CONFIG_INVALID', reason: 'editorModeForcedNormal', details: { editorMode: layers.editorMode } });
  if (layers.parseErrors.length > 0)
    warnings.push({ code: 'E_SETTINGS_INVALID', reason: 'layerParseErrors', details: { count: layers.parseErrors.length } });
  const envWarnings = checkSettingsEnv([
    { layer: 'user', value: layers.user },
    { layer: 'project', value: layers.project },
    { layer: 'local', value: layers.local },
  ]);
  return {
    layers,
    writeDisableAllHooksFalse: o.overrideDisableAllHooks && layers.disableAllHooksTrueIn.length > 0,
    allowedHttpHookUrlsDefined: layers.allowedHttpHookUrlsDefinedIn.length > 0,
    warnings,
    envWarnings,
  };
}

/** Readable layers that set `sandbox.enabled: true` (P-HOOK-13: HTTP hooks to loopback may be blocked by the sandbox). */
export function sandboxEnabledIn(layers: SettingsLayers): string[] {
  const out: string[] = [];
  for (const name of ['user', 'project', 'local'] as const) {
    const v = layers[name];
    if (typeof v !== 'object' || v === null) continue;
    const sb = (v as { sandbox?: unknown }).sandbox;
    if (typeof sb === 'object' && sb !== null && (sb as { enabled?: unknown }).enabled === true) out.push(name);
  }
  return out;
}

/** §3.1 step 7 hook transport (`'auto'`, rev 2 §10 G9). LP-10 has not confirmed exact-origin honouring, so a defined allowlist → unix. */
export function chooseHookTransport(
  requested: 'auto' | 'http' | 'unix',
  verdict: Pick<LayersVerdict, 'allowedHttpHookUrlsDefined' | 'layers'>,
  httpSelfTestFailedRecently: boolean,
): { transport: 'http' | 'unix'; reason: string } {
  if (requested !== 'auto') return { transport: requested, reason: 'explicit' };
  if (verdict.allowedHttpHookUrlsDefined) return { transport: 'unix', reason: 'allowedHttpHookUrls' };
  if (sandboxEnabledIn(verdict.layers).length > 0) return { transport: 'unix', reason: 'sandbox' };
  if (httpSelfTestFailedRecently) return { transport: 'unix', reason: 'selfTestCache' };
  return { transport: 'http', reason: 'default' };
}

export interface TrustVerdict {
  trusted: boolean;
  viaPath?: string;
  trustKeyAddedByLibrary: boolean;
}

/** §3.1 step 7 trust (D-19). `seed` inspects the workspace first and adds only the one key. */
export async function checkTrust(
  claudeConfig: ClaudeConfigPort,
  cwdRealpath: string,
  o: { mode: 'require' | 'seed'; acceptRisks: boolean },
): Promise<TrustVerdict> {
  const a = await assessTrust(claudeConfig, cwdRealpath, o);
  if (!a.seedNeeded) return a.verdict;
  return { trusted: true, trustKeyAddedByLibrary: await seedTrustKey(claudeConfig, cwdRealpath) };
}

/**
 * The checking half of `checkTrust`, without writing anything: trusted already (verdict), or untrusted and seedable
 * (`seedNeeded`; the workspace inspection passed). Throws E_TRUST_REQUIRED / E_WORKSPACE_RISK like `checkTrust`. The launcher
 * seeds later, right before the spawn and after its registry record exists (ICR 0022).
 */
export async function assessTrust(
  claudeConfig: ClaudeConfigPort,
  cwdRealpath: string,
  o: { mode: 'require' | 'seed'; acceptRisks: boolean },
): Promise<{ seedNeeded: false; verdict: TrustVerdict } | { seedNeeded: true }> {
  const t = await claudeConfig.trustOf(cwdRealpath);
  if (t.trusted)
    return {
      seedNeeded: false,
      verdict:
        t.viaPath === undefined
          ? { trusted: true, trustKeyAddedByLibrary: false }
          : { trusted: true, viaPath: t.viaPath, trustKeyAddedByLibrary: false },
    };
  if (o.mode === 'require')
    throw new CcdError('E_TRUST_REQUIRED', `the workspace ${cwdRealpath} is not trusted (open it once in claude, or use trust:'seed')`, {
      details: { cwd: cwdRealpath },
    });
  const risk = await claudeConfig.inspectWorkspace(cwdRealpath);
  if (!risk.empty && !o.acceptRisks)
    throw new CcdError(
      'E_WORKSPACE_RISK',
      'the workspace defines settings that would run with trust; pass trust.acceptRisks to seed anyway',
      {
        details: { items: risk.items.map((i) => `${i.file}:${i.kind}`) },
      },
    );
  return { seedNeeded: true };
}

/** Add the one trust key (D-19); true when the library added it (false: it was already there). */
export async function seedTrustKey(claudeConfig: ClaudeConfigPort, cwdRealpath: string, globalConfigPath?: string): Promise<boolean> {
  try {
    return (await claudeConfig.seedTrust(cwdRealpath, globalConfigPath === undefined ? {} : { globalConfigPath })).added;
  } catch (e) {
    throw mapPortError(e, 'E_CONFIG_CORRUPT', 'could not seed workspace trust');
  }
}

/**
 * §3.1 step 7 resume holder (LC §15 Q3): a live pid whose Claude registry record has `sessionId === id` →
 * `E_SESSION_ID_IN_USE{pid, ours}`. The reaper already ran, so `ours` is a live library session of this or another owner.
 */
export async function checkResumeHolder(registry: ClaudeRegistryReader, store: RegistryStore, resumeId: string): Promise<void> {
  const holders = (await registry.scan()).filter((r) => r.sessionId === resumeId);
  if (holders.length === 0) return;
  const ours = new Set<number>();
  for (const s of await store.listSessions()) if (s.claude.pid !== undefined) ours.add(s.claude.pid);
  const h = holders[0];
  if (h === undefined) return;
  throw new CcdError('E_SESSION_ID_IN_USE', `session ${resumeId} is open in another Claude process (pid ${h.pid})`, {
    details: { pid: h.pid, ours: ours.has(h.pid) },
  });
}

// ------------------------------------------------------------------------------------------------- step 12 (probe)

export async function probeTmux(
  tmux: TmuxServerFactory,
  proc: ProcessPort,
  bin: string | undefined,
): Promise<{ path: string; version: string }> {
  let candidate = bin;
  candidate ??= await proc.which('tmux', TMUX_SEARCH_DIRS);
  try {
    return await tmux.probe(candidate);
  } catch (e) {
    const err = mapPortError(e, 'E_TMUX_NOT_FOUND', 'tmux probe failed');
    if (err.code === 'E_TMUX_NOT_FOUND')
      throw new CcdError(
        'E_TMUX_NOT_FOUND',
        `tmux not found on $PATH or ${TMUX_SEARCH_DIRS.join(', ')}; install it (brew install tmux) or pass tmux.bin`,
        {
          cause: e,
          details: { searched: [...TMUX_SEARCH_DIRS] },
        },
      );
    throw err;
  }
}

/** P-TMUX-50 (Linux only): `infocmp tmux-256color`; missing → warning (the server's default-terminal is owned by L0). */
export async function checkTerminfo(
  proc: ProcessPort,
  env: Pick<EnvPort, 'platform'>,
  toolEnv: Readonly<Record<string, string>>,
): Promise<PreflightWarning | undefined> {
  if (env.platform() !== 'linux') return undefined;
  try {
    const r = await proc.exec('infocmp', ['tmux-256color'], { env: toolEnv, timeoutMs: 3_000, killOnTimeout: true });
    if (r.code === 0) return undefined;
  } catch {
    // infocmp itself missing: same verdict
  }
  return { code: 'E_TMUX_UNSUPPORTED', reason: 'terminfoMissing', details: { term: 'tmux-256color', fallback: 'screen-256color' } };
}

// ------------------------------------------------------------------------------------------------- composite

/** The step-1 subset that must already hold for a ResolvedConfig (re-checked defensively by the launcher). */
export function checkConfigShape(c: ResolvedConfig): void {
  if (c.tmux.cols < 120)
    throw new CcdError('E_CONFIG_INVALID', 'tmux.cols must be ≥ 120', { details: { reason: 'cols', cols: c.tmux.cols } });
  if (c.resume !== undefined && c.resume !== c.claudeSessionId)
    throw new CcdError('E_CONFIG_INVALID', 'resume id and claudeSessionId differ', { details: { reason: 'resumeId' } });
}
