import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsageDialog, usageDialogReady } from '../../../src/channels/profiles/claude-2.1.316/usage.js';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';

const FIXTURE = readFileSync(join(import.meta.dirname, '../../../fixtures/screens/usage-dialog-2.1.316.txt'), 'utf8');

describe('parseUsageDialog (2.1.316, ICR 0040)', () => {
  it('parses every meter of the live-captured dialog', () => {
    const r = parseUsageDialog(FIXTURE, 42);
    expect(r).toEqual({
      meters: [
        { window: 'session', label: 'Current session', usedPct: 0, resetsText: '9:50pm (Etc/UTC)' },
        {
          window: 'week',
          scope: 'all models',
          label: 'Current week (all models)',
          usedPct: 98,
          resetsText: 'Nov 3 at 7:30pm (Etc/UTC)',
        },
        { window: 'week', scope: 'Fable', label: 'Current week (Fable)', usedPct: 56, resetsText: 'Nov 3 at 7:29pm (Etc/UTC)' },
      ],
      credits: 'off',
      readAt: 42,
    });
  });

  it('is wired into the 2.1.316 profile', () => {
    expect(profile.usage.parse(FIXTURE, 1)?.meters).toHaveLength(3);
  });

  it('returns undefined when no meter is shown (loading, other tab, not the usage dialog)', () => {
    expect(parseUsageDialog('', 0)).toBeUndefined();
    expect(parseUsageDialog('Settings  Status   Config   Usage   Stats\nLoading usage…\nEsc to cancel', 0)).toBeUndefined();
    expect(parseUsageDialog('Current session\nResets 9:50pm', 0)).toBeUndefined(); // heading without a percentage
  });

  it('does not take a percentage from the next meter', () => {
    const r = parseUsageDialog('Current session\nCurrent week (all models)\n███ 12% used\nResets Mon at 1am', 0);
    expect(r?.meters).toEqual([
      { window: 'week', scope: 'all models', label: 'Current week (all models)', usedPct: 12, resetsText: 'Mon at 1am' },
    ]);
  });

  it('ignores out-of-range percentages and tolerates a missing reset line', () => {
    const r = parseUsageDialog('Current session\n 140% used\nCurrent week (Fable)\n 100% used\n', 0);
    expect(r?.meters).toEqual([{ window: 'week', scope: 'Fable', label: 'Current week (Fable)', usedPct: 100 }]);
    expect(r?.credits).toBeUndefined();
  });

  it('flags a dialog that is still refreshing as partial', () => {
    const r = parseUsageDialog(
      'Current session\n 0% used\nCurrent week (all models)\n 98% used\nScanning local sessions…\nRefreshing…\nEsc to cancel',
      0,
    );
    expect(r?.partial).toBe(true);
    expect(r?.meters).toHaveLength(2);
    expect(parseUsageDialog(FIXTURE, 0)?.partial).toBeUndefined();
  });

  it('ready(): meters shown and not refreshing', () => {
    expect(usageDialogReady(FIXTURE)).toBe(true);
    expect(usageDialogReady('Current session\n 0% used\nRefreshing…')).toBe(false);
    expect(usageDialogReady('Settings  Status   Config   Usage   Stats\nLoading usage…')).toBe(false);
    expect(usageDialogReady('')).toBe(false);
  });

  it('reads credits on', () => {
    expect(parseUsageDialog('Current session\n 5% used\nUsage credits are on', 0)?.credits).toBe('on');
  });
});
