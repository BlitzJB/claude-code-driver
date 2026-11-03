// channels/screen/to-facts.ts (WP-07; DESIGN.md §2.3, §2.8, §3.9). ScreenSnapshot → profile-free ScreenFacts: durations,
// tokens, mode labels, composer emptiness, usage-limit facts with the L1 reset parse (rev 2 §10 G27), auth kinds.
// Pitfalls: P-SCREEN-04 (error hint from the untruncated prefix only), P-SCREEN-07, P-TUI-21, P-REV-35, P-API-01.
import { describe, expect, it } from 'vitest';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';
import { classifyFrame, screenExtrasFor } from '../../../src/channels/screen/classify.js';
import { durationToMs, errorHintOf, toFacts, tokenCount } from '../../../src/channels/screen/to-facts.js';
import type { ScreenFacts } from '../../../src/model/screen-facts.js';
import type { WallMs } from '../../../src/model/time.js';
import { BUSY_FOOTER, RULE, WIDE_COLS, dialogFrame, mainFrame, st, wideFooter } from './screen-frames.js';

const WALL = Date.UTC(2026, 10, 3, 12, 0) as WallMs; // 2026-11-03 12:00 UTC
const facts = (lines: string[], tz = 'UTC', o: Parameters<typeof st>[0] = {}): ScreenFacts =>
  toFacts(classifyFrame(lines, st(o), profile, { wallAt: WALL }), profile, tz);
const x = screenExtrasFor(profile);

describe('helpers', () => {
  it('converts durations and token counts', () => {
    expect(durationToMs('1m 26s')).toBe(86_000);
    expect(durationToMs('0.5s')).toBe(500);
    expect(durationToMs('2h')).toBe(7_200_000);
    expect(durationToMs('1d 2h 3m')).toBe(93_780_000);
    expect(durationToMs('soon')).toBeUndefined();
    expect(durationToMs(undefined)).toBeUndefined();
    expect(tokenCount('88')).toBe(88);
    expect(tokenCount('1.2k')).toBe(1200);
    expect(tokenCount('x')).toBeUndefined();
  });

  it('takes the error hint from the untruncated prefix only (P-SCREEN-04)', () => {
    expect(errorHintOf("Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused…", true, x)).toBe('proxy');
    expect(errorHintOf('API error', false, x)).toBe('api');
    expect(errorHintOf("Can't reach the API server — check your internet or DNS", false, x)).toBe('network');
    expect(errorHintOf('5-hour limit reached', false, x)).toBe('rateLimit');
    expect(errorHintOf('Something prox…', true, x)).toBe('unknown'); // the cut word is never used
  });
});

describe('toFacts', () => {
  it('maps the spinner metrics', () => {
    const f = facts(
      mainFrame({
        above: ['✽ Considering… (running PreToolUse hooks… 1/2 · 1m 2s · ↓ 1.2k tokens · still thinking)'],
        footer: [BUSY_FOOTER],
      }),
    );
    expect(f.status).toEqual({
      kind: 'spinner',
      elapsedMs: 62_000,
      tokens: { dir: 'down', count: 1200 },
      thinkingLabel: 'still thinking',
      hookWait: { event: 'PreToolUse', done: 1, total: 2 },
    });
    expect(f.footer).toEqual({
      busy: true,
      modeLabel: 'manual mode on',
      mode: 'default',
      pasting: false,
      ctrlCExitArmed: false,
      hints: ['esc to interrupt'],
    });
  });

  it('maps retry, stall, no-response, low-priority, done and waiting-background banners', () => {
    const s = (l: string) => facts(mainFrame({ above: [l], footer: [BUSY_FOOTER] })).status;
    expect(s('✻ API error · Retrying in 10s · attempt 5/10')).toEqual({
      kind: 'retrying',
      attempt: 5,
      max: 10,
      retryInMs: 10_000,
      truncatedMsg: false,
      errorHint: 'api',
    });
    expect(s('✻ 5-hour limit reached · Retrying in 3m (resets 3pm) · attempt 1/10')).toMatchObject({
      kind: 'retrying',
      errorHint: 'rateLimit',
      resetText: 'resets 3pm',
      resetsAtWall: Date.UTC(2026, 10, 3, 15, 0),
    });
    expect(s('✻ Something new · attempt 2/7')).toEqual({ kind: 'retryingUnparsed', attempt: 2, max: 7 });
    expect(s('✻ Waiting for API response · will retry in 2m 40s · check your network')).toEqual({ kind: 'stalled', retryInMs: 160_000 });
    expect(s('✻ No response from the API after 2m · retrying, waiting up to 5m · attempt 2/10')).toEqual({
      kind: 'noResponse',
      attempt: 2,
      max: 10,
      retryInMs: 300_000,
    });
    expect(s('✻ Working at lower priority · next try in 30s · attempt 3 · esc to interrupt')).toEqual({
      kind: 'lowPriority',
      attempt: 3,
      retryInMs: 30_000,
    });
    expect(s('✻ Worked for 1m 18s · done 2:24 AM')).toEqual({ kind: 'done', doneDurationMs: 78_000 });
    expect(s('✻ Waiting for 2 background agents and 1 dynamic workflow to finish')).toEqual({
      kind: 'waitingBackground',
      waitingBackground: { agents: 2, workflows: 1 },
    });
    expect(s('⎿  Interrupted · What should Claude do instead?')).toEqual({ kind: 'interrupted' });
    expect(s('⏺ streaming')).toEqual({ kind: 'none' });
  });

  it('maps footer modes to PermissionMode (P-SCREEN-19)', () => {
    const m = (l: string) => facts(mainFrame({ footer: [l] })).footer?.mode;
    expect(m('  ⏵⏵ auto mode on (shift+tab to cycle)')).toBe('auto');
    expect(m('  ⏵⏵ accept edits on (shift+tab to cycle)')).toBe('acceptEdits');
    expect(m('  ⏸ plan mode on (shift+tab to cycle)')).toBe('plan');
    expect(m('  ⏸ manual mode on')).toBe('default');
    expect(m('  ? for shortcuts')).toBe('default');
    expect(m('  -- INSERT --')).toBeUndefined();
  });

  it('reads the right-aligned `Esc again to clear` overlay of a 250-col footer as a composer notice (live LP-32, F-5)', () => {
    // captured verbatim from 2.1.316 at 250 cols after one Escape on a three-line draft
    const rule = '─'.repeat(WIDE_COLS);
    const lines = mainFrame({
      input: ['❯ line one', '  line two', '  line three'],
      footer: [wideFooter('⏸ manual mode on', 'Esc again to clear')],
    }).map((r) => (r === RULE ? rule : r));
    const f = facts(lines, 'UTC', { cols: WIDE_COLS });
    expect(f.composer).toMatchObject({ text: 'line one\nline two\nline three', notices: ['escAgainToClear'] });
    expect(f.footer?.mode).toBe('default');
  });

  it('maps footer modes on a 250-col footer row with a right-aligned segment (ICR 0019)', () => {
    const rule = '─'.repeat(WIDE_COLS);
    const wide = (left: string, right: string): ScreenFacts['footer'] => {
      const lines = mainFrame({ footer: [wideFooter(left, right)] }).map((r) => (r === RULE ? rule : r));
      return facts(lines, 'UTC', { cols: WIDE_COLS }).footer;
    };
    expect(wide('⏵⏵ auto mode on (shift+tab to cycle)', '◐ medium · /effort')).toMatchObject({ mode: 'auto', busy: false });
    expect(wide('⏸ plan mode on (shift+tab to cycle) · esc to interrupt', '◐ medium · /effort')).toMatchObject({
      mode: 'plan',
      busy: true,
    });
    expect(wide('⏸ manual mode on', 'ctrl+g to edit in Editor.sh')?.mode).toBe('default');
    expect(wide('? for shortcuts · ← for agents', '◐ medium · /effort')?.mode).toBe('default');
  });

  it('treats a placeholder-only composer as empty, a pasted placeholder as content (P-SCREEN-07)', () => {
    expect(facts(mainFrame({ input: ['❯ Try "fix lint errors"'] })).composer).toMatchObject({ empty: true, placeholderLikely: true });
    expect(facts(mainFrame({ input: ['❯ real text'] })).composer).toMatchObject({ empty: false, text: 'real text' });
    expect(facts(mainFrame({ input: ['❯ [Pasted text #1 +20 lines]'] })).composer).toMatchObject({ empty: false, pastedPlaceholder: true });
  });

  it('derives usage-limit facts: limit name key, reset text and instant, auto-continue state (P-TUI-21, §3.9)', () => {
    const lim = facts(mainFrame({ above: ["⎿  You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)"] }), 'Europe/Berlin');
    expect(lim.usageLimit).toEqual({
      line: "You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)",
      limitName: 'five_hour',
      resetsText: '3pm (America/Los_Angeles)',
      resetsAtWall: Date.UTC(2026, 10, 3, 23, 0),
      autoContinue: 'none',
    });
    expect(facts(mainFrame({ above: ["You've hit your session limit · resets 12:30pm"] })).usageLimit?.limitName).toBe('five_hour');
    expect(facts(mainFrame({ above: ["You've hit your weekly limit · resets Nov 9, 4pm"] })).usageLimit).toMatchObject({
      limitName: 'seven_day',
      resetsAtWall: Date.UTC(2026, 10, 9, 16, 0),
    });
    expect(facts(mainFrame({ above: ["You've hit your monthly spend limit · raise it at https://x"] })).usageLimit?.limitName).toBe(
      'monthly spend limit',
    );
    const wait = facts(
      mainFrame({ above: ['Usage limit reached · limit resets 3:45pm'], footer: ['  Continuing automatically at 3:45pm · Esc to cancel'] }),
    );
    expect(wait.usageLimit).toMatchObject({ autoContinue: 'waiting', resetsText: '3:45pm', resetsAtWall: Date.UTC(2026, 10, 3, 15, 45) });
    const stale = facts(mainFrame({ footer: ['  Usage limit has reset · Press enter to continue'] }));
    expect(stale.usageLimit).toMatchObject({ autoContinue: 'stalePressEnter' });
    const stopped = facts(
      mainFrame({
        above: [
          'Automatic continue stopped after repeated usage limit hits · This task will not resume on its own (/rate-limit-options to try again)',
        ],
      }),
    );
    expect(stopped.usageLimit?.autoContinue).toBe('stopped');
    const cancelled = facts(mainFrame({ above: ['Automatic continue cancelled · /rate-limit-options to re-arm'] }));
    expect(cancelled.usageLimit?.autoContinue).toBe('cancelled');
    const cont = facts(mainFrame({ above: ['Usage limit reset · Continuing automatically'] }));
    expect(cont.usageLimit?.autoContinue).toBe('resetContinuing');
  });

  it('maps auth lines to kinds (TUI §6, LC §2)', () => {
    const a = (l: string) => facts(mainFrame({ above: [l] })).auth;
    expect(a('⏺ Login expired · Please run /login')).toEqual({ kind: 'loginExpired', line: 'Login expired · Please run /login' });
    expect(a('Not logged in · Please run /login')?.kind).toBe('notLoggedIn');
    expect(a('⏺ Failed to authenticate: OAuth token revoked · Please run /login')?.kind).toBe('tokenRevoked');
    expect(
      a('Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · Try again in a minute')
        ?.kind,
    ).toBe('refreshLock');
    expect(a('Authentication error · This may be a temporary network issue, please try again')?.kind).toBe('transient');
    expect(a('Invalid API key · Fix external API key')?.kind).toBe('other');
    expect(a('all good')).toBeUndefined();
  });

  it('copies dialogs, gates, flags and the header version; status only on main', () => {
    const d = facts(dialogFrame([' Bash command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend']));
    expect(d).toMatchObject({ surface: 'permissionDialog', headerVersion: '2.1.316', torn: false, hookErrorLines: 0, agentPanelRows: 0 });
    expect(d.status).toBeUndefined();
    expect(d.dialog).toEqual({
      kind: 'permission',
      title: 'Bash command',
      question: 'Do you want to proceed?',
      options: [
        { n: 1, label: 'Yes', selected: true },
        { n: 2, label: 'No', selected: false },
      ],
      footer: 'Esc to cancel · Tab to amend',
    });
    const old = facts(
      mainFrame({ above: ['⎿  API Error: Claude Code 2.1.316 does not support this model; version 2.3.0 or newer is required'] }),
    );
    expect(old).toMatchObject({
      versionTooOld: true,
      apiErrorLine: 'API Error: Claude Code 2.1.316 does not support this model; version 2.3.0 or newer is required',
    });
    expect(facts(mainFrame()).versionTooOld).toBeUndefined();
  });
});
