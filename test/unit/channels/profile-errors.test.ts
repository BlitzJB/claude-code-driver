// channels/profiles/claude-2.1.316/{errors,commands}.ts (WP-07; DESIGN.md §2.8, §3.6, §3.9, §6.2; ICR 0001 item 6).
// parseResetText for `3pm`, `3:45pm`, `Nov 9, 4pm`, ` (Europe/Berlin)` suffix, DST edges, `tz` = `UTC` and
// `America/Los_Angeles` (same input → different outputs, deterministic), plus the error tables and the slash-command tables.
// Pitfalls: P-REV-35, P-TUI-21, P-LIFE-24, P-REV-02.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commandsExtras, commandsProfile } from '../../../src/channels/profiles/claude-2.1.316/commands.js';
import { errorsExtras, errorsProfile } from '../../../src/channels/profiles/claude-2.1.316/errors.js';
import type { StartupGateKind } from '../../../src/model/screen-facts.js';
import type { WallMs } from '../../../src/model/time.js';

const parse = (text: string, wallAt: WallMs, tz: string): WallMs | undefined => errorsProfile.parseResetText(text, wallAt, tz);
const w = (iso: string): WallMs => Date.parse(iso) as WallMs;
const iso = (t: WallMs | undefined): string | undefined => (t === undefined ? undefined : new Date(t).toISOString());

describe('parseResetText (rev 2 §10 G27)', () => {
  const NOW = w('2026-11-03T12:00:00Z'); // 04:00 in Los Angeles (PST), 13:00 in Berlin (CET)

  it('parses time-only forms as the next occurrence at or after wallAt − 60 s', () => {
    expect(iso(parse('3pm', NOW, 'UTC'))).toBe('2026-11-03T15:00:00.000Z');
    expect(iso(parse('3:45pm', NOW, 'UTC'))).toBe('2026-11-03T15:45:00.000Z');
    expect(iso(parse('11am', NOW, 'UTC'))).toBe('2026-11-04T11:00:00.000Z'); // already past today → tomorrow
    expect(iso(parse('11:59am', NOW, 'UTC'))).toBe('2026-11-03T11:59:00.000Z'); // within the 60 s grace
    expect(iso(parse('12am', NOW, 'UTC'))).toBe('2026-11-04T00:00:00.000Z');
    expect(iso(parse('12pm', NOW, 'UTC'))).toBe('2026-11-03T12:00:00.000Z');
  });

  it('same input, different tz → different, deterministic outputs (P-REV-35)', () => {
    expect(iso(parse('3pm', NOW, 'America/Los_Angeles'))).toBe('2026-11-03T23:00:00.000Z');
    expect(iso(parse('3pm', NOW, 'UTC'))).toBe('2026-11-03T15:00:00.000Z');
    expect(parse('3pm', NOW, 'America/Los_Angeles')).toBe(parse('3pm', NOW, 'America/Los_Angeles'));
  });

  it('lets an explicit (Zone/City) suffix win over tz', () => {
    expect(iso(parse('3pm (Europe/Berlin)', NOW, 'America/Los_Angeles'))).toBe('2026-11-03T14:00:00.000Z');
    expect(iso(parse('4am (Asia/Tokyo)', NOW, 'UTC'))).toBe('2026-11-03T19:00:00.000Z'); // 21:00 JST now → next 04:00 JST
    expect(iso(parse('3pm (Not/AZone)', NOW, 'UTC'))).toBe('2026-11-03T15:00:00.000Z'); // unknown zone → tz
  });

  it('parses dated forms, with and without a year', () => {
    expect(iso(parse('Nov 9, 4pm', NOW, 'UTC'))).toBe('2026-11-09T16:00:00.000Z');
    expect(iso(parse('Nov 9, 4:30pm (Asia/Kolkata)', NOW, 'UTC'))).toBe('2026-11-09T11:00:00.000Z');
    expect(iso(parse('Jan 2, 9am', w('2026-12-30T10:00:00Z'), 'UTC'))).toBe('2027-01-02T09:00:00.000Z'); // across New Year
    expect(iso(parse('Nov 9, 2027, 4pm', NOW, 'UTC'))).toBe('2027-11-09T16:00:00.000Z');
    expect(iso(parse('Feb 29, 1pm', w('2028-02-20T00:00:00Z'), 'UTC'))).toBe('2028-02-29T13:00:00.000Z');
  });

  it('accepts the tolerated variants: resets/at prefix, AM/PM with space, 24-hour, GMT', () => {
    expect(iso(parse('resets 3pm', NOW, 'UTC'))).toBe('2026-11-03T15:00:00.000Z');
    expect(iso(parse('at 3:45 PM', NOW, 'UTC'))).toBe('2026-11-03T15:45:00.000Z');
    expect(iso(parse('15:45', NOW, 'UTC'))).toBe('2026-11-03T15:45:00.000Z');
    expect(iso(parse('15:45 UTC', NOW, 'America/Los_Angeles'))).toBe('2026-11-03T15:45:00.000Z');
    expect(iso(parse('3pm (GMT)', NOW, 'America/Los_Angeles'))).toBe('2026-11-03T15:00:00.000Z');
  });

  it('handles DST edges deterministically (gap → later instant, fold → earlier instant)', () => {
    // US spring forward 2027-03-14: 02:30 does not exist in Los Angeles
    expect(iso(parse('Mar 14, 2:30am', w('2027-03-13T12:00:00Z'), 'America/Los_Angeles'))).toBe('2027-03-14T10:30:00.000Z');
    // US fall back 2026-11-01: 01:30 happens twice; the earlier (PDT) instant is chosen
    expect(iso(parse('Nov 1, 1:30am', w('2026-10-31T12:00:00Z'), 'America/Los_Angeles'))).toBe('2026-11-01T08:30:00.000Z');
    // ordinary days either side of the change use the right offsets
    expect(iso(parse('Mar 13, 3pm', w('2027-03-13T00:00:00Z'), 'America/Los_Angeles'))).toBe('2027-03-13T23:00:00.000Z');
    expect(iso(parse('Mar 15, 3pm', w('2027-03-13T00:00:00Z'), 'America/Los_Angeles'))).toBe('2027-03-15T22:00:00.000Z');
  });

  it('returns undefined for unparseable or invalid input and never throws', () => {
    for (const bad of ['', 'soon', 'when it resets', '13pm', '3:75pm', 'Feb 30, 4pm', 'Xyz 3, 4pm', '25:00'])
      expect([bad, parse(bad, NOW, 'UTC')]).toEqual([bad, undefined]);
    expect(parse('3pm', NOW, 'Not/AZone')).toBeUndefined();
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        fc.constantFrom('UTC', 'Europe/Berlin', 'bogus'),
        (s, t, tz) => {
          const r = parse(s, t as WallMs, tz);
          expect(r === undefined || Number.isFinite(r)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('errors tables', () => {
  it('detects the usage-limit prefixes incl. legacy forms (P-TUI-21)', () => {
    const isLimit = (l: string) => errorsProfile.usageLimitPrefixes.some((p) => l.startsWith(p));
    for (const l of [
      "You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)",
      "You've hit your session limit · resets 12:30pm",
      "You've reached your weekly limit",
      "You're out of usage credits",
      'Usage limit reached · limit resets 3:45pm',
      'Limit reached · resets 3:50pm (Asia/Baghdad) · contact an admin to increase limits',
    ])
      expect([l, isLimit(l)]).toEqual([l, true]);
    expect(isLimit('All good')).toBe(false);
    expect(errorsProfile.limitNames['five_hour']).toBe('5-hour limit');
    expect(errorsExtras.limitLine.exec("You've hit your weekly limit · resets Nov 9, 4pm")?.groups?.['label']).toBe('weekly limit');
    expect(
      errorsExtras.resetIn.exec("You've hit your weekly limit · resets Nov 9, 4pm (Asia/Kolkata) · progress saved")?.groups?.['reset'],
    ).toBe('Nov 9, 4pm (Asia/Kolkata)');
  });

  it('matches the version-too-old message (P-LIFE-24)', () => {
    expect(errorsProfile.versionTooOld.test('Claude Code 2.1.316 does not support this model; version 2.2.0 or newer is required')).toBe(
      true,
    );
    expect(
      errorsProfile.versionTooOld.test("Claude Code 2.1.316 is older than the minimum version required by your organization's policy"),
    ).toBe(true);
    expect(errorsProfile.versionTooOld.test('Claude Code v2.1.316')).toBe(false);
  });

  it('has a non-empty regex list for every StartupGateKind', () => {
    const kinds: StartupGateKind[] = [
      'configError',
      'settingsError',
      'onboarding',
      'login',
      'trust',
      'apiKey',
      'bypass',
      'mcpApproval',
      'claudeMdImports',
      'rendererOffer',
      'sessionInUse',
      'resumeDialog',
      'other',
    ];
    for (const k of kinds) expect([k, errorsProfile.startupGates[k].length > 0]).toEqual([k, true]);
  });

  it('keeps authLines and authKinds in step', () => {
    expect(errorsProfile.authLines).toEqual(errorsExtras.authKinds.map((a) => a.re));
  });
});

describe('commands profile (§3.6, P-REV-02, ICR 0001 item 6)', () => {
  it('canonicalises the VERIFIED-BIN aliases', () => {
    const c = commandsExtras.canonical;
    expect([c('/quit'), c('/new'), c('/reset'), c('/cost'), c('/stats'), c('/continue'), c('/undo'), c('/settings'), c('/bashes')]).toEqual(
      ['/exit', '/clear', '/clear', '/usage', '/usage', '/resume', '/rewind', '/config', '/tasks'],
    );
    expect(c('/compact')).toBe('/compact');
    expect(c('/QUIT')).toBe('/QUIT');
    expect(commandsProfile.aliases['/cost']).toBe('/usage');
    for (const target of Object.values(commandsProfile.aliases)) expect(commandsProfile.aliases[target]).toBeUndefined(); // no chains
  });

  it('applies allow/deny/refuse to the canonical name only (K-34)', () => {
    const k = commandsExtras.classify;
    expect(k('/clear')).toBe('allowed');
    expect(k('/new')).toBe('allowed');
    expect(k('/reset')).toBe('allowed');
    expect(k('/usage')).toBe('allowed');
    expect(k('/cost')).toBe('allowed'); // reaches /usage through the alias
    expect(k('/permissions')).toBe('unsafe');
    expect(k('/allowed-tools')).toBe('unsafe');
    expect(k('/settings')).toBe('unsafe');
    expect(k('/some-skill')).toBe('unsafe');
    for (const r of ['/exit', '/quit', '/tui', '/restart', '/update', '/resume', '/continue', '/rewind', '/undo', '/checkpoint'])
      expect([r, k(r)]).toEqual([r, 'refused']);
    for (const bad of ['clear', '/Clear', '/', '/a b', ' /clear']) expect([bad, k(bad)]).toEqual([bad, 'invalid']);
  });

  it('keeps the tables canonical and consistent', () => {
    const aliasKeys = Object.keys(commandsProfile.aliases);
    for (const list of [commandsExtras.allowed, commandsExtras.denied, commandsExtras.refusedAlways, commandsExtras.immediate])
      for (const n of list) {
        expect(aliasKeys).not.toContain(n);
        expect(commandsExtras.namePattern.test(n)).toBe(true);
      }
    for (const n of commandsExtras.allowed) expect(commandsExtras.denied).not.toContain(n);
    expect(commandsExtras.allowed).toContain('/usage');
    expect(commandsExtras.allowed).not.toContain('/cost');
    expect(commandsExtras.immediate).toEqual(expect.arrayContaining(['/exit', '/usage', '/model', '/effort']));
  });
});
