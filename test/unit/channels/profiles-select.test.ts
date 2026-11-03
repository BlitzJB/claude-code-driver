// channels/profiles/index.ts selectProfile + the 2.1.316 assembly (DESIGN.md §2.8, §8 fixed export names).
import { describe, expect, it } from 'vitest';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';
import { selectProfile } from '../../../src/channels/profiles/index.js';
import { SUPPORTED_CLAUDE_VERSION } from '../../../src/model/version.js';

describe('selectProfile', () => {
  it('returns the 2.1.316 profile for the supported version', () => {
    const p = selectProfile(SUPPORTED_CLAUDE_VERSION);
    expect(p).toBe(profile);
    expect('version' in p && p.version).toBe('2.1.316');
  });

  it.each(['2.1.317', '2.1.31', '2.1.316 ', 'v2.1.316', '', 'constructor', '__proto__', 'toString'])('reports %j as unsupported', (v) => {
    expect(selectProfile(v)).toEqual({ unsupported: v });
  });
});

describe('the 2.1.316 assembly', () => {
  it('wires all five leaf exports and is frozen', () => {
    expect(Object.keys(profile).sort()).toEqual(['commands', 'errors', 'hooks', 'screen', 'transcript', 'usage', 'version']);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(profile.hooks.commandEvents).toEqual(['SessionStart', 'PermissionRequest']);
  });

  it('carries the VERIFIED-BIN slash aliases (P-REV-02)', () => {
    // The §3.6 aliases the library depends on; ICR 0001 item 6 adds the rest of the VERIFIED-BIN table (/cost → /usage, …).
    expect(profile.commands.aliases).toMatchObject({ '/quit': '/exit', '/new': '/clear', '/reset': '/clear', '/cost': '/usage' });
    for (const [alias, canonical] of Object.entries(profile.commands.aliases)) {
      expect(alias).toMatch(/^\/[a-z][a-z0-9:_-]*$/);
      expect(canonical).toMatch(/^\/[a-z][a-z0-9:_-]*$/);
      expect(profile.commands.aliases[canonical]).toBeUndefined(); // canonical names are never aliases themselves
    }
  });

  it('transcript notRealUserText (ZHe) classifies interrupt markers and tag-led text', () => {
    const re = profile.transcript.notRealUserText;
    expect(re.test(profile.transcript.markers.interrupted)).toBe(true);
    expect(re.test(profile.transcript.markers.interruptedForToolUse)).toBe(true);
    expect(re.test('<task-notification>…')).toBe(true);
    expect(re.test('fix the bug')).toBe(false);
  });
});
