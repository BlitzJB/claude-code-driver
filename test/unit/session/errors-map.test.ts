// session/errors-map.ts — L0 error → CcdError from typed fields only (P-SEC-40: never err.cmd / argv / raw stderr).
import { describe, expect, it } from 'vitest';
import { CcdError, PUBLIC_CODE_OF } from '../../../src/model/errors.js';
import {
  ClaudeAuthStatusUnreadable,
  ClaudeNotFound,
  ClaudeVersionUnreadable,
  OwnerWatchStartFailed,
  ProcessSpawnError,
} from '../../../src/platform/process/errors.js';
import { SocketPathTooLong as DirSocketTooLong, UnsafeRuntimeDir } from '../../../src/platform/runtime-dir/errors.js';
import { ClaudeConfigBusy, ClaudeConfigUnreadable, SettingsFileExists } from '../../../src/platform/settings/errors.js';
import { HookTransportError, HookWorkerDied, SocketPathTooLong as HookSocketTooLong } from '../../../src/platform/hook-server/errors.js';
import { NetSidecarError } from '../../../src/platform/netproxy/client.js';
import {
  TmuxArgTooLong,
  TmuxCommandFailed,
  TmuxCrashed,
  TmuxDuplicate,
  TmuxInvalidInput,
  TmuxNotFound,
  TmuxPaneDead,
  TmuxPaneInMode,
  TmuxServerGone,
  TmuxSocketPathTooLong,
  TmuxSpawnFailed,
  TmuxTargetMissing,
  TmuxUnsupported,
  TmuxVersionUnsupported,
} from '../../../src/platform/tmux/errors.js';
import { fromErrorData, toCcdError, toErrorData } from '../../../src/session/errors-map.js';

const SECRET = 'HTTPS_PROXY=http://ccd:deadbeefdeadbeef@127.0.0.1:9';

describe('toCcdError: every L0 error family maps to a typed code', () => {
  it.each([
    [new TmuxNotFound(['/usr/bin']), 'E_TMUX_NOT_FOUND', { searched: ['/usr/bin'] }],
    [new TmuxVersionUnsupported('3.1', '3.2'), 'E_TMUX_UNSUPPORTED', { reason: 'version', found: '3.1', min: '3.2' }],
    [new TmuxUnsupported('extendedKeys', 'emacs'), 'E_TMUX_UNSUPPORTED', { reason: 'extendedKeys', found: 'emacs' }],
    [new TmuxServerGone(`no server running ${SECRET}`), 'E_SESSION_EXITED', { reason: 'TmuxServerGone' }],
    [new TmuxCrashed('server exited unexpectedly'), 'E_SESSION_EXITED', { reason: 'TmuxCrashed' }],
    [new TmuxTargetMissing('%9'), 'E_SESSION_EXITED', { reason: 'TmuxTargetMissing' }],
    [new TmuxPaneDead('%1', 1, null), 'E_SESSION_EXITED', { reason: 'TmuxPaneDead', paneId: '%1', exitStatus: 1, exitSignal: null }],
    [new TmuxPaneInMode('%1'), 'E_INPUT_GATED', { reason: 'copyMode' }],
    [new TmuxArgTooLong(20000, 12288), 'E_INPUT_INVALID', { reason: 'argTooLong', bytes: 20000, limit: 12288 }],
    [new TmuxInvalidInput('controlChar', 'x'), 'E_INPUT_INVALID', { reason: 'controlChar' }],
    [new TmuxSocketPathTooLong(120, 104), 'E_SOCKET_PATH_TOO_LONG', { bytes: 120, limit: 104 }],
    [new TmuxDuplicate('session x'), 'E_INVARIANT', { reason: 'TmuxDuplicate' }],
    [new TmuxSpawnFailed('sizeMismatch', 'x'), 'E_INVARIANT', { reason: 'TmuxSpawnFailed', detail: 'sizeMismatch' }],
    [
      new TmuxCommandFailed(1, SECRET, ['load-buffer', 'paste-buffer'], true),
      'E_INVARIANT',
      { reason: 'TmuxCommandFailed', commands: ['load-buffer', 'paste-buffer'], exitCode: 1, timedOut: true },
    ],
    [new ProcessSpawnError('/usr/local/bin/tmux', 'ENOENT'), 'E_TMUX_NOT_FOUND', { errno: 'ENOENT', file: 'tmux' }],
    [new ProcessSpawnError('/x/claude.exe', 'ENOENT'), 'E_CLAUDE_NOT_FOUND', { errno: 'ENOENT', file: 'claude.exe' }],
    [new ProcessSpawnError('/bin/ps', 'EACCES'), 'E_INVARIANT', { reason: 'spawn', errno: 'EACCES', file: 'ps' }],
    [new ClaudeNotFound(['/a']), 'E_CLAUDE_NOT_FOUND', { searched: ['/a'] }],
    [
      new ClaudeVersionUnreadable('/x/claude.exe', 2, false),
      'E_CLAUDE_VERSION_MISMATCH',
      { reason: 'unreadable', exitCode: 2, timedOut: false },
    ],
    [new ClaudeAuthStatusUnreadable('timeout', null), 'E_STARTUP_TIMEOUT', { reason: 'authStatusTimeout', phase: 'authStatus' }],
    [new ClaudeAuthStatusUnreadable('unparseable', 1), 'E_LOGIN_REQUIRED', { reason: 'authStatusUnparseable', exitCode: 1 }],
    [new OwnerWatchStartFailed('spawn'), 'E_INVARIANT', { reason: 'ownerWatch', detail: 'spawn' }],
    [new UnsafeRuntimeDir('/tmp/x', 'mode'), 'E_UNSAFE_RUNTIME_DIR', { path: '/tmp/x', reason: 'mode' }],
    [new DirSocketTooLong(110, 100), 'E_SOCKET_PATH_TOO_LONG', { bytes: 110, limit: 100 }],
    [new HookSocketTooLong(110, 104), 'E_SOCKET_PATH_TOO_LONG', { bytes: 110, limit: 104 }],
    [new SettingsFileExists('/s/settings.json'), 'E_UNSAFE_RUNTIME_DIR', { reason: 'settingsFileExists' }],
    [new ClaudeConfigUnreadable('/h/.claude.json', 'invalidJson'), 'E_CONFIG_CORRUPT', { reason: 'invalidJson' }],
    [new ClaudeConfigUnreadable('/h/.claude.json', 'missing'), 'E_NOT_ONBOARDED', { reason: 'missing' }],
    [new ClaudeConfigBusy('/h/.claude.json', 5), 'E_INVARIANT', { reason: 'claudeConfigBusy', attempts: 5 }],
    [new HookWorkerDied(3), 'E_CHANNEL_DOWN', { channel: 'hooks', reason: 'workerDied', exitCode: 3 }],
    [new HookTransportError('EADDRINUSE', 'x'), 'E_HOOKS_UNAVAILABLE', { reason: 'EADDRINUSE' }],
    [new NetSidecarError('exited', 'x'), 'E_NETWORK_UNAVAILABLE', { reason: 'exited' }],
  ])('%s → %s', (err, code, details) => {
    const c = toCcdError(err);
    expect(c).toBeInstanceOf(CcdError);
    expect(c.code).toBe(code);
    expect(c.details).toMatchObject(details);
    expect(PUBLIC_CODE_OF[c.code]).toBeDefined();
  });

  it('never copies err.cmd / spawnargs / stderr / unknown messages (P-SEC-40)', () => {
    const nodeErr = Object.assign(new Error(`Command failed: tmux -L x new-session -e ${SECRET}`), {
      code: 'ENOENT',
      syscall: 'spawn tmux',
      cmd: `tmux -e ${SECRET}`,
      spawnargs: ['-e', SECRET],
      path: '/Users/someone/secret',
    });
    const all = [
      toCcdError(nodeErr),
      toCcdError(new TmuxCommandFailed(1, SECRET, ['x'])),
      toCcdError(new TmuxServerGone(SECRET)),
      toCcdError(new TypeError(SECRET)),
    ];
    for (const c of all) {
      const text = JSON.stringify(c.toJSON()) + c.message;
      expect(text).not.toContain('deadbeef');
      expect(text).not.toContain('/Users/someone');
    }
    expect(all[0]?.details).toEqual({ reason: 'io', errno: 'ENOENT', syscall: 'spawn tmux' });
    expect(all[3]?.details).toEqual({ reason: 'unexpected', name: 'TypeError' });
  });

  it('CcdError passes through; a foreign-copy CcdError is rebuilt from its typed fields', () => {
    const own = new CcdError('E_BUSY', 'busy', { details: { reason: 'activeTurn' } });
    expect(toCcdError(own)).toBe(own);
    const foreign = { name: 'CcdError', code: 'E_TRUST_REQUIRED', message: 'trust it', details: { gate: 'trust' }, cmd: SECRET };
    const c = toCcdError(foreign);
    expect(c).toBeInstanceOf(CcdError);
    expect(c.code).toBe('E_TRUST_REQUIRED');
    expect(c.details).toEqual({ gate: 'trust' });
  });

  it('non-errors, AbortError, odd names and the op context', () => {
    expect(toCcdError('boom').details).toEqual({ reason: 'nonError', type: 'string' });
    expect(toCcdError(null).code).toBe('E_INVARIANT');
    expect(toCcdError(new DOMException('aborted', 'AbortError')).code).toBe('E_TURN_ABORTED');
    expect(toCcdError({ name: 'weird name with spaces' }).details).toEqual({ reason: 'unexpected', name: 'Error' });
    const c = toCcdError(new TmuxNotFound([]), { op: 'tmux.probe' });
    expect(c.details).toMatchObject({ op: 'tmux.probe' });
    expect(c.message).toMatch(/^tmux\.probe: /);
  });

  it('long typed fields are clipped', () => {
    const c = toCcdError(new UnsafeRuntimeDir(`/${'x'.repeat(1000)}`, 'owner'));
    expect((c.details?.['path'] as string).length).toBeLessThanOrEqual(257);
  });

  it('a throwing getter never escapes (total)', () => {
    const evil = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    expect(toCcdError(evil).code).toBe('E_INVARIANT');
  });

  it('fromErrorData / toErrorData round-trip', () => {
    const c = fromErrorData({ code: 'E_USAGE_LIMIT', message: 'limited', details: { resetsAt: 1 } });
    expect(c).toBeInstanceOf(CcdError);
    expect(toErrorData(c)).toEqual({ code: 'E_USAGE_LIMIT', message: 'limited', details: { resetsAt: 1 } });
    expect(fromErrorData({ code: 'E_BUSY', message: 'b' }).details).toBeUndefined();
  });
});
