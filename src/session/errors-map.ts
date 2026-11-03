// session/errors-map.ts — L0 error → CcdError (DESIGN.md §1.2, §2.2; SEC §7.1, §8.2; P-SEC-40).
//
// session may import platform only type-only (§1.3), so L0 errors are recognised by their stable `name` (and `kind` for the
// tmux family), never by `instanceof`. The produced CcdError is built from TYPED FIELDS ONLY: never from `err.message` of an
// unknown error, never from `err.cmd`/`err.spawnargs` (Node puts the full argv there, SEC §7.1) and never from a raw stderr
// (it can echo argv or paths). A known L0 error's message is rebuilt here from its typed fields.

import { CcdError, isCcdError } from '../model/errors.js';
import type { CcdErrorCode, CcdErrorData } from '../model/errors.js';
import type { JsonValue } from '../model/json.js';

type Details = Record<string, JsonValue>;
type Rec = Record<string, unknown>;

function rec(e: unknown): Rec | undefined {
  return typeof e === 'object' && e !== null ? (e as Rec) : undefined;
}
function str(r: Rec, k: string): string | undefined {
  const v = r[k];
  return typeof v === 'string' ? v : undefined;
}
function num(r: Rec, k: string): number | null | undefined {
  const v = r[k];
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function bool(r: Rec, k: string): boolean | undefined {
  const v = r[k];
  return typeof v === 'boolean' ? v : undefined;
}
function strList(r: Rec, k: string, max = 16): string[] | undefined {
  const v = r[k];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string').slice(0, max);
}
/** Bound a typed string field (paths, reasons) so an error never carries a huge blob. */
function clip(s: string, max = 256): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
function put(d: Details, k: string, v: JsonValue | undefined): void {
  if (v !== undefined) d[k] = typeof v === 'string' ? clip(v) : v;
}
function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export interface MapContext {
  /** What the library was doing (`'tmux.spawn'`, `'hooks.start'`, …); goes into details.op and the message. */
  op?: string;
}

function mk(code: CcdErrorCode, message: string, details: Details, cause: unknown, ctx: MapContext): CcdError {
  if (ctx.op !== undefined) details['op'] = clip(ctx.op, 64);
  // `cause` is kept for in-process debugging (it is not serialized by CcdError.toJSON, so it never reaches logs or events).
  return new CcdError(code, message, { cause, details });
}

/** Map any thrown value to a CcdError. A CcdError passes through unchanged. Total: never throws. */
export function toCcdError(e: unknown, ctx: MapContext = {}): CcdError {
  try {
    return mapUnsafe(e, ctx);
  } catch {
    return new CcdError('E_INVARIANT', 'error mapping failed', { details: { reason: 'mapFailed' } });
  }
}

function mapUnsafe(e: unknown, ctx: MapContext): CcdError {
  if (e instanceof CcdError) return e;
  if (isCcdError(e)) {
    // a CcdError from another package copy (duck-typed, P-API-12): rebuild from its typed fields
    const r = e as unknown as Rec;
    const details = rec(r['details']);
    return new CcdError(e.code, clip(e.message, 1024), details !== undefined ? { details: details as Details, cause: e } : { cause: e });
  }
  const r = rec(e);
  const name = r !== undefined ? (str(r, 'name') ?? str(r, 'kind')) : undefined;
  const d: Details = {};
  const op = ctx.op !== undefined ? `${ctx.op}: ` : '';
  if (r === undefined || name === undefined) {
    d['reason'] = 'nonError';
    d['type'] = typeof e;
    return mk('E_INVARIANT', `${op}unexpected non-error value thrown`, d, e, ctx);
  }
  const kind = str(r, 'kind') ?? name;
  switch (kind) {
    // ---- tmux (platform/tmux/errors.ts) ----
    case 'TmuxNotFound':
      put(d, 'searched', strList(r, 'searched'));
      return mk('E_TMUX_NOT_FOUND', `${op}tmux not found; install it (e.g. 'brew install tmux') or pass tmux.bin`, d, e, ctx);
    case 'TmuxVersionUnsupported':
      d['reason'] = 'version';
      put(d, 'found', str(r, 'found'));
      put(d, 'min', str(r, 'min'));
      return mk(
        'E_TMUX_UNSUPPORTED',
        `${op}tmux ${str(r, 'found') ?? '?'} is not supported (minimum ${str(r, 'min') ?? '3.2'})`,
        d,
        e,
        ctx,
      );
    case 'TmuxUnsupported':
      d['reason'] = str(r, 'reason') ?? 'unsupported';
      put(d, 'found', str(r, 'found'));
      return mk('E_TMUX_UNSUPPORTED', `${op}tmux build unsupported (${d['reason']})`, d, e, ctx);
    case 'TmuxServerGone':
    case 'TmuxCrashed':
    case 'TmuxTargetMissing':
      d['reason'] = kind;
      return mk('E_SESSION_EXITED', `${op}the tmux server or pane is gone (${kind})`, d, e, ctx);
    case 'TmuxPaneDead':
      d['reason'] = kind;
      put(d, 'paneId', str(r, 'paneId'));
      put(d, 'exitStatus', num(r, 'exitStatus'));
      put(d, 'exitSignal', str(r, 'exitSignal') ?? (r['exitSignal'] === null ? null : undefined));
      return mk('E_SESSION_EXITED', `${op}the Claude pane is dead`, d, e, ctx);
    case 'TmuxPaneInMode':
      d['reason'] = 'copyMode';
      put(d, 'paneId', str(r, 'paneId'));
      return mk('E_INPUT_GATED', `${op}the pane is in copy mode`, d, e, ctx);
    case 'TmuxArgTooLong':
      d['reason'] = 'argTooLong';
      put(d, 'bytes', num(r, 'bytes'));
      put(d, 'limit', num(r, 'limit'));
      return mk('E_INPUT_INVALID', `${op}tmux argument too long`, d, e, ctx);
    case 'TmuxInvalidInput':
      d['reason'] = str(r, 'reason') ?? 'invalidInput';
      return mk('E_INPUT_INVALID', `${op}tmux input rejected (${d['reason']})`, d, e, ctx);
    case 'TmuxSocketPathTooLong':
      put(d, 'bytes', num(r, 'bytes'));
      put(d, 'limit', num(r, 'limit'));
      return mk('E_SOCKET_PATH_TOO_LONG', `${op}tmux socket path too long`, d, e, ctx);
    case 'TmuxDuplicate':
    case 'TmuxSpawnFailed':
    case 'TmuxCommandFailed': {
      d['reason'] = kind;
      const sub = str(r, 'reason');
      if (kind === 'TmuxSpawnFailed' && sub !== undefined) d['detail'] = sub;
      const cmds = strList(r, 'commands');
      if (cmds !== undefined) d['commands'] = cmds.filter((c) => /^[a-z-]{1,32}$/.test(c));
      if (kind === 'TmuxCommandFailed') {
        put(d, 'exitCode', num(r, 'code'));
        put(d, 'timedOut', bool(r, 'timedOut'));
      }
      return mk('E_INVARIANT', `${op}tmux command failed (${kind})`, d, e, ctx);
    }
    // ---- process / claude binary (platform/process/errors.ts) ----
    case 'ProcessSpawnError': {
      const file = basename(str(r, 'file') ?? '');
      const errno = str(r, 'errno') ?? 'unknown';
      d['errno'] = clip(errno, 32);
      d['file'] = clip(file, 64);
      if (errno === 'ENOENT' && /^tmux$/.test(file)) return mk('E_TMUX_NOT_FOUND', `${op}tmux could not be started (ENOENT)`, d, e, ctx);
      if (errno === 'ENOENT' && /^claude(\.exe)?$/.test(file))
        return mk('E_CLAUDE_NOT_FOUND', `${op}claude could not be started (ENOENT)`, d, e, ctx);
      d['reason'] = 'spawn';
      return mk('E_INVARIANT', `${op}could not start ${file} (${errno})`, d, e, ctx);
    }
    case 'ClaudeNotFound':
      put(d, 'searched', strList(r, 'searched'));
      return mk('E_CLAUDE_NOT_FOUND', `${op}claude binary not found; install @anthropic-ai/claude-code or pass claude.bin`, d, e, ctx);
    case 'ClaudeVersionUnreadable':
      d['reason'] = 'unreadable';
      put(d, 'exitCode', num(r, 'exitCode'));
      put(d, 'timedOut', bool(r, 'timedOut'));
      return mk('E_CLAUDE_VERSION_MISMATCH', `${op}could not read the Claude version`, d, e, ctx);
    case 'ClaudeAuthStatusUnreadable': {
      const reason = str(r, 'reason') ?? 'unparseable';
      d['reason'] = reason === 'timeout' ? 'authStatusTimeout' : 'authStatusUnparseable';
      put(d, 'exitCode', num(r, 'exitCode'));
      if (reason === 'timeout') {
        d['phase'] = 'authStatus';
        return mk('E_STARTUP_TIMEOUT', `${op}'claude auth status' did not answer in time`, d, e, ctx);
      }
      return mk('E_LOGIN_REQUIRED', `${op}'claude auth status' gave no usable answer`, d, e, ctx);
    }
    case 'OwnerWatchStartFailed':
      d['reason'] = 'ownerWatch';
      put(d, 'detail', str(r, 'reason'));
      return mk('E_INVARIANT', `${op}the owner-watch process could not be started`, d, e, ctx);
    // ---- runtime dir / settings (platform/runtime-dir, platform/settings, hook-server) ----
    case 'UnsafeRuntimeDir':
      put(d, 'path', str(r, 'path'));
      d['reason'] = str(r, 'reason') ?? 'unsafe';
      return mk('E_UNSAFE_RUNTIME_DIR', `${op}unsafe runtime directory (${d['reason']})`, d, e, ctx);
    case 'SocketPathTooLong':
      put(d, 'bytes', num(r, 'bytes'));
      put(d, 'limit', num(r, 'limit') ?? num(r, 'max'));
      return mk('E_SOCKET_PATH_TOO_LONG', `${op}socket path too long; use a shorter TMPDIR or lifecycle.runtimeRoot`, d, e, ctx);
    case 'SettingsFileExists':
      d['reason'] = 'settingsFileExists';
      put(d, 'path', str(r, 'path'));
      return mk('E_UNSAFE_RUNTIME_DIR', `${op}the settings file already exists (O_EXCL refused)`, d, e, ctx);
    case 'ClaudeConfigUnreadable': {
      const reason = str(r, 'reason') ?? 'invalidJson';
      d['reason'] = reason;
      put(d, 'path', str(r, 'path'));
      if (reason === 'missing') return mk('E_NOT_ONBOARDED', `${op}~/.claude.json is missing; run 'claude' once to onboard`, d, e, ctx);
      return mk(
        'E_CONFIG_CORRUPT',
        `${op}~/.claude.json is unreadable (${reason}); fix it by hand (the library never resets it)`,
        d,
        e,
        ctx,
      );
    }
    case 'ClaudeConfigBusy':
      d['reason'] = 'claudeConfigBusy';
      put(d, 'attempts', num(r, 'attempts'));
      return mk('E_INVARIANT', `${op}~/.claude.json kept changing during a merge`, d, e, ctx);
    // ---- hooks / network ----
    case 'HookWorkerDied':
      d['channel'] = 'hooks';
      d['reason'] = 'workerDied';
      put(d, 'exitCode', num(r, 'exitCode'));
      return mk('E_CHANNEL_DOWN', `${op}the hook worker thread exited`, d, e, ctx);
    case 'HookTransportError':
      d['reason'] = str(r, 'reason') ?? 'transport';
      return mk('E_HOOKS_UNAVAILABLE', `${op}the hook transport could not start (${d['reason']})`, d, e, ctx);
    case 'NetSidecarError':
      d['reason'] = str(r, 'reason') ?? 'sidecar';
      return mk('E_NETWORK_UNAVAILABLE', `${op}the network sidecar failed (${d['reason']})`, d, e, ctx);
    case 'AbortError':
      d['reason'] = 'aborted';
      return mk('E_TURN_ABORTED', `${op}aborted`, d, e, ctx);
    default:
      break;
  }
  // Node system errors: keep errno/syscall only (the message and `path` can carry argv or user paths).
  const errno = str(r, 'code');
  if (errno !== undefined && /^E[A-Z0-9_]{1,24}$/.test(errno)) {
    d['reason'] = 'io';
    d['errno'] = errno;
    put(d, 'syscall', str(r, 'syscall'));
    return mk('E_INVARIANT', `${op}system error ${errno}`, d, e, ctx);
  }
  d['reason'] = 'unexpected';
  d['name'] = clip(/^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : 'Error', 64);
  return mk('E_INVARIANT', `${op}unexpected ${d['name']}`, d, e, ctx);
}

/** CcdErrorData (from a core commandResult or an event) → CcdError. */
export function fromErrorData(data: CcdErrorData): CcdError {
  return data.details === undefined
    ? new CcdError(data.code, data.message)
    : new CcdError(data.code, data.message, { details: data.details });
}

/** CcdError → plain data (for events, the trace and the registry). */
export function toErrorData(e: unknown, ctx?: MapContext): CcdErrorData {
  return toCcdError(e, ctx).toJSON();
}
