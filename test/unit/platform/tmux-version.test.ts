// WP-01 tmux/version.ts: P-TMUX-42 (`tmux -V` ≥ 3.2, feature gates).
import { describe, expect, it } from 'vitest';
import { featuresOf, isSupportedVersion, parseTmuxVersion, versionAtLeast } from '../../../src/platform/tmux/version.js';

describe('parseTmuxVersion', () => {
  it.each([
    ['tmux 3.5a', 3, 5, 'a', false],
    ['tmux 3.2', 3, 2, '', false],
    ['tmux 3.2a\n', 3, 2, 'a', false],
    ['tmux next-3.6', 3, 6, '', true],
    ['tmux 3.6-rc', 3, 6, '', true],
    ['tmux 2.9', 2, 9, '', false],
  ] as const)('%j', (text, major, minor, patch, dev) => {
    expect(parseTmuxVersion(text)).toMatchObject({ major, minor, patch, dev });
  });

  it('master is a development build newer than anything', () => {
    const v = parseTmuxVersion('tmux master');
    expect(v?.dev).toBe(true);
    expect(v !== undefined && isSupportedVersion(v)).toBe(true);
  });

  it('openbsd builds are treated conservatively', () => {
    expect(parseTmuxVersion('tmux openbsd-7.4')).toMatchObject({ major: 3, minor: 2 });
    expect(parseTmuxVersion('tmux openbsd-6.5')).toMatchObject({ major: 3, minor: 1 });
  });

  it('garbage is undefined', () => {
    expect(parseTmuxVersion('')).toBeUndefined();
    expect(parseTmuxVersion('screen 4.0')).toBeUndefined();
    expect(parseTmuxVersion('tmux x.y')).toBeUndefined();
  });
});

describe('support and features', () => {
  it('minimum is 3.2', () => {
    expect(isSupportedVersion(parseTmuxVersion('tmux 3.1c')!)).toBe(false);
    expect(isSupportedVersion(parseTmuxVersion('tmux 3.2')!)).toBe(true);
    expect(versionAtLeast({ major: 4, minor: 0 }, 3, 9)).toBe(true);
  });

  it('feature gates', () => {
    expect(featuresOf(parseTmuxVersion('tmux 3.2a')!)).toEqual({ allowPassthrough: false, paneKeyMode: false, extendedKeys: true });
    expect(featuresOf(parseTmuxVersion('tmux 3.4')!)).toEqual({ allowPassthrough: true, paneKeyMode: false, extendedKeys: true });
    expect(featuresOf(parseTmuxVersion('tmux 3.5a')!)).toEqual({ allowPassthrough: true, paneKeyMode: true, extendedKeys: true });
  });
});
