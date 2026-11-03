// WP-01 tmux/errors.ts: P-TMUX-62 typed errors + the stderr mapper (TD §1.2 strings, VERIFIED on tmux 3.5a).
import { describe, expect, it } from 'vitest';
import { CCD_ERROR_CODES } from '../../../src/model/errors.js';
import {
  isServerGoneError,
  isTmuxError,
  mapTmuxFailure,
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

const map = (stderr: string, o: { code?: number | null; timedOut?: boolean } = {}) =>
  mapTmuxFailure({ code: o.code ?? 1, stderr, commands: ['send-keys'], timedOut: o.timedOut ?? false, argvBytes: 20_000 });

describe('mapTmuxFailure', () => {
  it.each([
    ['server exited unexpectedly\n', TmuxCrashed],
    ['no server running on /private/tmp/tmux-501/ccd-x\n', TmuxServerGone],
    ['error connecting to /private/tmp/tmux-501/ccd-x (No such file or directory)\n', TmuxServerGone],
    ['error connecting to /private/tmp/tmux-501/ccd-x (Connection refused)\n', TmuxServerGone],
    ["can't find pane: %9\n", TmuxTargetMissing],
    ["can't find session: ccd-ab\n", TmuxTargetMissing],
    ["can't find window: 3\n", TmuxTargetMissing],
    ['no such session: =ccd-x\n', TmuxTargetMissing],
    ['duplicate session: ccd-abc\n', TmuxDuplicate],
    ['command too long\n', TmuxArgTooLong],
    ['unknown flag -x\n', TmuxCommandFailed],
  ] as const)('%j → %s', (stderr, cls) => {
    expect(map(stderr)).toBeInstanceOf(cls);
  });

  it('extracts the missing target', () => {
    const e = map("can't find pane: %9\n");
    expect(e).toBeInstanceOf(TmuxTargetMissing);
    expect((e as TmuxTargetMissing).target).toBe('%9');
  });

  it('a timeout is a TmuxCommandFailed with timedOut, whatever stderr says', () => {
    const e = map('no server running on x', { code: null, timedOut: true });
    expect(e).toBeInstanceOf(TmuxCommandFailed);
    expect((e as TmuxCommandFailed).timedOut).toBe(true);
  });

  it('TmuxCommandFailed carries command names only and a bounded stderr (argv redacted)', () => {
    const e = new TmuxCommandFailed(1, 'x'.repeat(5000), ['load-buffer', 'paste-buffer']);
    expect(e.message).toContain('load-buffer ; paste-buffer');
    expect(e.message.length).toBeLessThan(700);
    expect(e.commands).toEqual(['load-buffer', 'paste-buffer']);
  });

  it('server-gone classification', () => {
    expect(isServerGoneError(new TmuxCrashed('x'))).toBe(true);
    expect(isServerGoneError(new TmuxServerGone('x'))).toBe(true);
    expect(isServerGoneError(new TmuxTargetMissing('%1'))).toBe(false);
  });
});

describe('typed error classes', () => {
  const all = [
    new TmuxNotFound(['/usr/bin/tmux']),
    new TmuxVersionUnsupported('3.1', '3.2'),
    new TmuxUnsupported('extendedKeys', 'VT10x+'),
    new TmuxServerGone('x'),
    new TmuxCrashed('x'),
    new TmuxTargetMissing('%1'),
    new TmuxDuplicate('session x'),
    new TmuxArgTooLong(20000, 12288),
    new TmuxPaneDead('%1', 42, null),
    new TmuxPaneInMode('%1'),
    new TmuxInvalidInput('controlChar', 'x'),
    new TmuxSocketPathTooLong(120, 100),
    new TmuxSpawnFailed('sizeMismatch', 'x'),
    new TmuxCommandFailed(1, 'x', ['a']),
  ];

  it('every class has a matching name/kind and a valid suggested CcdErrorCode', () => {
    for (const e of all) {
      expect(isTmuxError(e)).toBe(true);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(e.kind);
      expect(CCD_ERROR_CODES).toContain(e.suggestedCode);
    }
  });

  it('install/version/extended-keys errors map to the environment codes (§3.1 step 12, LP-52)', () => {
    expect(new TmuxNotFound([]).suggestedCode).toBe('E_TMUX_NOT_FOUND');
    expect(new TmuxVersionUnsupported('3.1', '3.2').suggestedCode).toBe('E_TMUX_UNSUPPORTED');
    const ek = new TmuxUnsupported('extendedKeys', 'VT10x+');
    expect(ek.suggestedCode).toBe('E_TMUX_UNSUPPORTED');
    expect(ek.reason).toBe('extendedKeys');
  });
});
