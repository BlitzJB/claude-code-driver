// channels/screen/debounce.ts (WP-07; DESIGN.md §2.8, D-41, D-42, rev 2 §10 G26; ICR 0001 item 3b). Pitfalls: P-SCREEN-10,
// P-TMUX-29 (torn frames emitted with `torn`, never held: the core claim machine owns stability), P-SCREEN-23 (hash
// short-circuit), P-SCREEN-24 (unknown-line telemetry), P-SCREEN-27 (frozen UI), K-43 (A→B→A reaches the core), LP-01.
import { describe, expect, it } from 'vitest';
import { profile } from '../../../src/channels/profiles/claude-2.1.316/index.js';
import { classifyFrame } from '../../../src/channels/screen/classify.js';
import { createScreenChannel, createScreenDebouncer } from '../../../src/channels/screen/debounce.js';
import type { MonoMs, WallMs } from '../../../src/model/time.js';
import type { Capture, PaneStatus } from '../../../src/platform/ports.js';
import { BUSY_FOOTER, dialogFrame, mainFrame, st } from './screen-frames.js';

const TZ = 'UTC';
const WALL = Date.UTC(2026, 10, 3, 12, 0) as WallMs;

function cap(lines: string[], at: number, o: Partial<PaneStatus> = {}): Capture {
  return { lines, status: st(o), at: at as MonoMs, hash: `h:${lines.join('\n')}:${JSON.stringify(o)}` };
}

const spinner = (glyph: string) => mainFrame({ above: ['❯ go', `${glyph} Working… (3s)`], footer: [BUSY_FOOTER] });
const A = mainFrame({ input: ['❯ '] });
const B = mainFrame({ input: ['❯ typed text'] });
const PERM = dialogFrame([' Bash command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend']);

function debouncer() {
  const d = createScreenDebouncer({ frozenAfterMs: 3000, profile });
  const push = (lines: string[], at: number, o: Partial<PaneStatus> = {}) => {
    const c = cap(lines, at, o);
    return d.push(c, classifyFrame(c.lines, c.status, profile, { at: c.at, wallAt: WALL }), TZ);
  };
  return { d, push };
}

describe('createScreenDebouncer', () => {
  it('drops consecutive identical frames only (D-41, D-42)', () => {
    const { d, push } = debouncer();
    expect(push(A, 0)?.surface).toBe('main');
    expect(push(A, 100)).toBeUndefined();
    expect(push(A, 200)).toBeUndefined();
    expect(push(B, 300)?.composer?.text).toBe('typed text');
    expect(d.telemetry()).toMatchObject({ pushed: 4, emitted: 2, dropped: 2 });
    expect(d.last()?.composer?.text).toBe('typed text');
  });

  it('lets A→B→A through as three frames (K-43): permission dialog twice, composer empty→text→empty', () => {
    const { push } = debouncer();
    const out = [push(PERM, 0), push(A, 100), push(PERM, 200), push(A, 300), push(B, 400), push(A, 500)].map((f) => f?.surface ?? null);
    expect(out).toEqual(['permissionDialog', 'main', 'permissionDialog', 'main', 'main', 'main']);
  });

  it('emits torn frames immediately with torn:true; no stability wait in L1 (P-SCREEN-10, G26)', () => {
    const { push } = debouncer();
    const torn = push(mainFrame({ footer: [] }), 0);
    expect(torn).toMatchObject({ surface: 'main', torn: true });
    expect(push(A, 50)).toMatchObject({ torn: false });
  });

  it('reports a frozen spinner after ≥ frozenAfterMs unchanged, not before, and not for idle frames (P-SCREEN-27)', () => {
    const { d, push } = debouncer();
    push(spinner('✻'), 0);
    push(spinner('✶'), 150);
    expect(d.frozen()).toBeUndefined();
    push(spinner('✶'), 2000);
    expect(d.frozen()).toBeUndefined();
    push(spinner('✶'), 3150);
    expect(d.frozen()).toMatchObject({ since: 150, forMs: 3000 });
    push(spinner('✳'), 3300);
    expect(d.frozen()).toBeUndefined();
    const idle = debouncer();
    idle.push(A, 0);
    idle.push(A, 10_000);
    expect(idle.d.frozen()).toBeUndefined();
  });

  it('maps the external-editor alternate screen to editorOpen from history (ICR 0001 item 3b)', () => {
    const { push } = debouncer();
    push(A, 0);
    expect(push(['', ''], 100, { alternateOn: true })?.surface).toBe('editorOpen');
    expect(push(['~', '~ vim'], 200, { alternateOn: true })?.surface).toBe('editorOpen'); // still the editor
    expect(push(B, 300)?.surface).toBe('main');
    // a non-blank alternate screen right after main without the editor hint is a renderer problem
    expect(push(['fullscreen ui'], 400, { alternateOn: true })?.surface).toBe('unsupportedRenderer');
    // with the `ctrl+g to edit in …` hint the user's real editor may draw at once
    const h = debouncer();
    h.push(mainFrame({ input: ['❯ draft'], footer: ['  ⏸ manual mode on · ctrl+g to edit in Vim'] }), 0);
    expect(h.push(['~ vim ui'], 100, { alternateOn: true })?.surface).toBe('editorOpen');
    // no history at all → unsupportedRenderer
    expect(debouncer().push(['', ''], 0, { alternateOn: true })?.surface).toBe('unsupportedRenderer');
  });

  it('collects bounded unknown-line telemetry for drift detection (P-SCREEN-24)', () => {
    const { d, push } = debouncer();
    push(mainFrame({ above: ['⏺ streaming text 1'], footer: [BUSY_FOOTER] }), 0);
    push(mainFrame({ above: ['⏺ streaming text 2'], footer: [BUSY_FOOTER] }), 100);
    push(dialogFrame([' Brand new layout', ' nothing known']), 200);
    for (let i = 0; i < 100; i++) push(mainFrame({ above: [`⏺ line ${i}`], footer: [BUSY_FOOTER] }), 300 + i);
    const t = d.telemetry();
    expect(t.unknownStatus.slice(0, 2)).toEqual([
      ['⏺ streaming text 1', 1],
      ['⏺ streaming text 2', 1],
    ]);
    expect(t.unknownStatus.length).toBe(64);
    expect(t.unknownModal).toEqual([['Brand new layout … nothing known', 1]]);
  });

  it('parses reset texts with the zone it is given (P-REV-35)', () => {
    const d = createScreenDebouncer({ frozenAfterMs: 3000, profile });
    const lines = mainFrame({ above: ["⎿  You've hit your 5-hour limit · resets 3pm"] });
    const c = cap(lines, 0);
    const snap = classifyFrame(c.lines, c.status, profile, { at: c.at, wallAt: WALL });
    const utc = d.push(c, snap, 'UTC');
    expect(utc?.usageLimit?.resetsAtWall).toBe(Date.UTC(2026, 10, 3, 15, 0));
    const la = createScreenDebouncer({ frozenAfterMs: 3000, profile }).push(c, snap, 'America/Los_Angeles');
    expect(la?.usageLimit?.resetsAtWall).toBe(Date.UTC(2026, 10, 3, 23, 0));
  });
});

describe('createScreenChannel', () => {
  it('skips the classifier for an identical raw capture but still advances the frozen detector (P-SCREEN-23)', () => {
    const ch = createScreenChannel({ frozenAfterMs: 3000, profile });
    const ctx = { wallAt: WALL, tz: TZ };
    expect(ch.push(cap(spinner('✻'), 0), ctx)?.status?.kind).toBe('spinner');
    expect(ch.push(cap(spinner('✻'), 1500), ctx)).toBeUndefined();
    expect(ch.push(cap(spinner('✻'), 3000), ctx)).toBeUndefined();
    expect(ch.frozen()).toMatchObject({ since: 0, forMs: 3000 });
    expect(ch.telemetry()).toMatchObject({ pushed: 3, emitted: 1 });
    expect(ch.last()?.status?.kind).toBe('spinner');
  });

  it('re-classifies when the pane status or the editor phase changes for the same text', () => {
    const ch = createScreenChannel({ frozenAfterMs: 3000, profile });
    const blank = ['', ''];
    expect(ch.push(cap(blank, 0), { wallAt: WALL, tz: TZ })?.surface).toBe('blank');
    expect(ch.push(cap(blank, 100, { alternateOn: true }), { wallAt: WALL, tz: TZ, editorPhase: true })?.surface).toBe('editorOpen');
    expect(ch.push(cap(A, 200, { inMode: true }), { wallAt: WALL, tz: TZ })?.inCopyMode).toBe(true);
  });
});

describe('editor fallback guards (WP-07 audit)', () => {
  it('never rescues the fullscreen renderer and never resumes the editor chain after unsupportedRenderer', () => {
    const { push } = debouncer();
    push(A, 0);
    // Claude's own box on the alternate screen right after main: the fullscreen renderer, even though main came first
    expect(push(mainFrame({ input: ['❯ x'] }), 100, { alternateOn: true })?.surface).toBe('unsupportedRenderer');
    // a blank alternate frame after that is not the editor either
    expect(push(['', ''], 200, { alternateOn: true })?.surface).toBe('unsupportedRenderer');
    // back on main, a blank alternate screen is the editor again
    push(B, 300);
    expect(push(['', ''], 400, { alternateOn: true })?.surface).toBe('editorOpen');
    // and the editor drawing does not turn into Claude UI: if it does, the renderer wins
    expect(push(mainFrame(), 500, { alternateOn: true })?.surface).toBe('unsupportedRenderer');
  });
});
