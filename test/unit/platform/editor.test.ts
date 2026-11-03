// WP-05 unit tests: EditorInjector + ccd-editor standalone (D-15; P-INPUT-16 / P-REV-31: unarmed runs exec the user's
// editor; LP-01/LP-02: consumed() is the done signal; byte-exact injection).
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { createRealClock } from '../../../src/platform/clock/real-clock.js';
import { FakeEditorInjectorFactory } from '../../../src/platform/editor/fake-editor.js';
import {
  ARM_NAME,
  createEditorInjectorFactory,
  DISARMED_NAME,
  ORIG_NAME,
  originalEditor,
  shQuote,
  STAGED_NAME,
  wrapperScript,
} from '../../../src/platform/editor/injector.js';
import {
  DISARMED_NAME as STANDALONE_DISARMED_NAME,
  DRAFT_NAME,
  main as editorMain,
  parseArm,
  parseOrig,
  recentlyDisarmed,
  tryConsume,
} from '../../../src/platform/editor/standalone/editor.js';
import { FakeIds } from '../../../src/platform/ids/fake-ids.js';

let dir: string;
let drafts: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-ed-')));
  chmodSync(dir, 0o700);
  drafts = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-drafts-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(drafts, { recursive: true, force: true });
});

function runVisual(visual: string, file: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((res) => {
    execFile(visual, [file], { env: { PATH: '/usr/bin:/bin' } }, (err, _o, stderr) => {
      res({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : null, stderr });
    });
  });
}

function draft(name = 'claude-prompt-1b2c.md', text = 'old draft'): string {
  const p = join(drafts, name);
  writeFileSync(p, text);
  return p;
}

describe('setup', () => {
  it('writes a 0700 sh wrapper that execs node editor.js arm.json "$@" and a 0600 editor-orig.json', async () => {
    const inj = createEditorInjectorFactory({ hostEnv: { VISUAL: 'code --wait', EDITOR: 'vi' } }).create({
      clock: createRealClock(),
      ids: new FakeIds(),
    });
    const { visualPath } = await inj.setup(dir, process.execPath);
    expect(visualPath).toBe(join(dir, 'ccd-editor'));
    expect(statSync(visualPath).mode & 0o777).toBe(0o700);
    const text = readFileSync(visualPath, 'utf8');
    expect(text.startsWith('#!/bin/sh\nexec ')).toBe(true);
    expect(text).toContain(`${shQuote(join(dir, ARM_NAME))} "$@"`);
    expect(statSync(join(dir, ORIG_NAME)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, ORIG_NAME), 'utf8'))).toEqual({ visual: 'code --wait', editor: 'vi' });
    await expect(inj.setup(dir, process.execPath)).rejects.toThrow(); // O_EXCL: never overwrite a planted wrapper
  });

  it('refuses a non-private session dir', async () => {
    chmodSync(dir, 0o755);
    const inj = createEditorInjectorFactory().create({ clock: createRealClock(), ids: new FakeIds() });
    await expect(inj.setup(dir, process.execPath)).rejects.toMatchObject({ name: 'UnsafeRuntimeDir' });
  });

  it('helpers: shQuote, wrapperScript, originalEditor drops nested ccd-editor wrappers', () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
    expect(wrapperScript('/n', "/s'x", '/a')).toBe(`#!/bin/sh\nexec '/n' '/s'\\''x' '/a' "$@"\n`);
    expect(originalEditor({ VISUAL: '/tmp/ccd-abc/ccd-editor', EDITOR: 'nano' })).toEqual({ editor: 'nano' });
    expect(originalEditor({ VISUAL: '  ' })).toEqual({});
    expect(originalEditor(undefined)).toEqual({});
  });
});

/** Node < 22.18 cannot run the `.ts` standalone sources directly; their dist/ builds are covered by the contract suite. */
const CAN_RUN_TS =
  (process.features as { typescript?: unknown }).typescript !== undefined &&
  (process.features as { typescript?: unknown }).typescript !== false;

describe.skipIf(!CAN_RUN_TS)('stage → C-g → consumed (real wrapper and standalone)', () => {
  it('replaces the draft byte-exactly, signals done once, and a second run does not consume again', async () => {
    const inj = createEditorInjectorFactory().create({ clock: createRealClock(), ids: new FakeIds() });
    const { visualPath } = await inj.setup(dir, process.execPath);
    const text = `line1\n\tTAB "quotes" $HOME \`tick\` !bang @mention\n${'x'.repeat(5000)}\nüñí 🙂\r\nend`;
    const { nonce } = await inj.stage(text);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(join(dir, STAGED_NAME)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, ARM_NAME)).mode & 0o777).toBe(0o600);
    const f = draft();
    expect((await runVisual(visualPath, f)).code).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe(text);
    expect(await inj.consumed(nonce, 2_000)).toBe(true);
    expect(existsSync(join(dir, ARM_NAME))).toBe(false);
    expect(existsSync(join(dir, STAGED_NAME))).toBe(false);
    const f2 = draft('claude-prompt-2.md', 'second');
    expect((await runVisual(visualPath, f2)).code).toBe(1); // unarmed, no original editor recorded
    expect(readFileSync(f2, 'utf8')).toBe('second');
  });

  it('an empty staged text clears the draft (clearComposer primitive)', async () => {
    const inj = createEditorInjectorFactory().create({ clock: createRealClock(), ids: new FakeIds() });
    const { visualPath } = await inj.setup(dir, process.execPath);
    const { nonce } = await inj.stage('');
    const f = draft('claude-prompt-c.md', 'leftover junk');
    expect((await runVisual(visualPath, f)).code).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe('');
    expect(await inj.consumed(nonce, 1_000)).toBe(true);
  });

  it('unarmed runs exec the user’s original editor with the same argv (git/crontab via inherited VISUAL)', async () => {
    const origEditor = join(drafts, 'orig-editor.sh');
    writeFileSync(origEditor, '#!/bin/sh\nprintf "ORIG:%s" "$#" >> "$1"\n');
    chmodSync(origEditor, 0o755);
    const inj = createEditorInjectorFactory({ hostEnv: { EDITOR: origEditor } }).create({ clock: createRealClock(), ids: new FakeIds() });
    const { visualPath } = await inj.setup(dir, process.execPath);
    const commitMsg = draft('COMMIT_EDITMSG', 'msg');
    expect((await runVisual(visualPath, commitMsg)).code).toBe(0);
    expect(readFileSync(commitMsg, 'utf8')).toBe('msgORIG:1');
    // armed, but the target is not a Claude draft: never consumed, the original editor runs instead
    const { nonce } = await inj.stage('PROMPT');
    const crontab = draft('crontab.abc', 'cron');
    await runVisual(visualPath, crontab);
    expect(readFileSync(crontab, 'utf8')).toBe('cronORIG:1');
    expect(existsSync(join(dir, ARM_NAME))).toBe(true);
    const f = draft();
    await runVisual(visualPath, f);
    expect(readFileSync(f, 'utf8')).toBe('PROMPT');
    expect(await inj.consumed(nonce, 1_000)).toBe(true);
  });

  it('consumed() times out on a fake clock and disarms, so a late C-g cannot inject a stale prompt', async () => {
    const clock = new FakeClock();
    const inj = createEditorInjectorFactory({ pollMs: 10 }).create({ clock, ids: new FakeIds() });
    const { visualPath } = await inj.setup(dir, process.execPath);
    const { nonce } = await inj.stage('stale');
    const wait = inj.consumed(nonce, 3_000);
    const state = { settled: false };
    void wait.then(() => (state.settled = true));
    // Real fs work happens between fake ticks: give each poll a real event-loop turn, then advance 10 fake ms.
    for (let i = 0; i < 2_000 && !state.settled; i++) {
      await new Promise((r) => setImmediate(r));
      clock.advance(10);
    }
    expect(await wait).toBe(false);
    expect(existsSync(join(dir, ARM_NAME))).toBe(false);
    const f = draft();
    expect((await runVisual(visualPath, f)).code).toBe(1);
    expect(readFileSync(f, 'utf8')).toBe('old draft');
    expect(await inj.consumed('not-hex!', 10)).toBe(false);
  });

  it('an expired arm is not consumed', async () => {
    const clock = new FakeClock({ wall: Date.now() - 120_000 }); // arm expires 30 s after a wall time 2 min ago
    const inj = createEditorInjectorFactory().create({ clock, ids: new FakeIds() });
    const { visualPath } = await inj.setup(dir, process.execPath);
    await inj.stage('too late');
    const f = draft();
    expect((await runVisual(visualPath, f)).code).toBe(1);
    expect(readFileSync(f, 'utf8')).toBe('old draft');
  });

  it('ICR 0018: a late library C-g after consumed() timed out never opens the user’s editor on the Claude draft', async () => {
    const origEditor = join(drafts, 'orig-editor.sh');
    writeFileSync(origEditor, '#!/bin/sh\nprintf "ORIG" >> "$1"\n');
    chmodSync(origEditor, 0o755);
    const clock = new FakeClock({ wall: Date.now() });
    const inj = createEditorInjectorFactory({ hostEnv: { VISUAL: origEditor }, pollMs: 10 }).create({ clock, ids: new FakeIds() });
    const { visualPath } = await inj.setup(dir, process.execPath);
    const { nonce } = await inj.stage('stale');
    const wait = inj.consumed(nonce, 30);
    const state = { settled: false };
    void wait.then(() => (state.settled = true));
    for (let i = 0; i < 200 && !state.settled; i++) {
      await new Promise((r) => setImmediate(r));
      clock.advance(10);
    }
    expect(await wait).toBe(false);
    expect(existsSync(join(dir, ARM_NAME))).toBe(false);
    expect(statSync(join(dir, DISARMED_NAME)).mode & 0o777).toBe(0o600);
    const f = draft();
    const r = await runVisual(visualPath, f);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('could not be applied');
    expect(readFileSync(f, 'utf8')).toBe('old draft'); // the original editor did not run
    // git / crontab through an inherited VISUAL still get the user's editor while the tombstone is live
    const commitMsg = draft('COMMIT_EDITMSG', 'msg');
    expect((await runVisual(visualPath, commitMsg)).code).toBe(0);
    expect(readFileSync(commitMsg, 'utf8')).toBe('msgORIG');
    // a later human C-g (tombstone expired) runs the user's editor again (P-INPUT-16, ICR 0001 item 3c)
    expect(recentlyDisarmed(join(dir, ARM_NAME), Date.now())).toBe(true);
    expect(recentlyDisarmed(join(dir, ARM_NAME), Date.now() + 60_000)).toBe(false);
    expect(tryConsume(join(dir, ARM_NAME), f, Date.now() + 60_000)).toBe('notArmed');
    // a disarm with no outstanding arm (e.g. close after a consumed prompt) leaves no tombstone
    rmSync(join(dir, DISARMED_NAME));
    const { nonce: n2 } = await inj.stage('ok');
    await runVisual(visualPath, draft('claude-prompt-ok.md'));
    expect(await inj.consumed(n2, 1_000)).toBe(true);
    await inj.disarm();
    expect(existsSync(join(dir, DISARMED_NAME))).toBe(false);
    expect(STANDALONE_DISARMED_NAME).toBe(DISARMED_NAME);
  });

  it('ICR 0018: an expired arm on a Claude draft fails without running the user’s editor', async () => {
    const origEditor = join(drafts, 'orig-editor.sh');
    writeFileSync(origEditor, '#!/bin/sh\nprintf "ORIG" >> "$1"\n');
    chmodSync(origEditor, 0o755);
    const clock = new FakeClock({ wall: Date.now() - 120_000 });
    const inj = createEditorInjectorFactory({ hostEnv: { VISUAL: origEditor } }).create({ clock, ids: new FakeIds() });
    const { visualPath } = await inj.setup(dir, process.execPath);
    await inj.stage('too late');
    const f = draft();
    expect((await runVisual(visualPath, f)).code).toBe(1);
    expect(readFileSync(f, 'utf8')).toBe('old draft');
    expect(existsSync(join(dir, ARM_NAME))).toBe(false); // claimed and dropped: a second run cannot reuse it
  });

  it('disarm removes arm.json and staged.txt; stage before setup fails', async () => {
    const inj = createEditorInjectorFactory().create({ clock: createRealClock(), ids: new FakeIds() });
    await expect(inj.stage('x')).rejects.toThrow('setup');
    await inj.setup(dir, process.execPath);
    await inj.stage('x');
    await inj.disarm();
    expect(existsSync(join(dir, ARM_NAME)) || existsSync(join(dir, STAGED_NAME))).toBe(false);
  });
});

describe('standalone pure parts', () => {
  it('parseArm keeps staged/done next to arm.json and requires a hex nonce', () => {
    const arm = join(dir, 'arm.json');
    const good = {
      v: 1,
      nonce: 'ab'.repeat(16),
      stagedPath: join(dir, 'staged.txt'),
      donePath: join(dir, `done-${'ab'.repeat(16)}`),
      expiresAtWall: 1,
    };
    expect(parseArm(good, arm)).toEqual(good);
    expect(parseArm({ ...good, stagedPath: '/etc/passwd' }, arm)).toBeUndefined();
    expect(parseArm({ ...good, donePath: join(dir, 'done-other') }, arm)).toBeUndefined();
    expect(parseArm({ ...good, nonce: '../x' }, arm)).toBeUndefined();
    expect(parseArm(null, arm)).toBeUndefined();
    expect(parseOrig({ visual: 'v', editor: 1 })).toEqual({ visual: 'v' });
    expect(DRAFT_NAME.test('claude-prompt-3f2a-11.md')).toBe(true);
    expect(DRAFT_NAME.test('COMMIT_EDITMSG')).toBe(false);
  });

  it('tryConsume: claimed-but-incomplete runs report failed and main exits 1 without opening an editor', () => {
    const arm = join(dir, 'arm.json');
    const nonce = 'cd'.repeat(16);
    writeFileSync(
      arm,
      JSON.stringify({
        v: 1,
        nonce,
        stagedPath: join(dir, 'staged.txt'),
        donePath: join(dir, `done-${nonce}`),
        expiresAtWall: Date.now() + 10_000,
      }),
    );
    // staged.txt is missing (the injector disarmed between claim and read)
    const f = draft();
    expect(tryConsume(arm, f, Date.now())).toBe('failed');
    expect(readFileSync(f, 'utf8')).toBe('old draft');
    expect(editorMain(['relative'])).toBe(2);
  });
});

describe('FakeEditorInjector', () => {
  it('consumes once when armed, otherwise runs the original editor or exits 1; consumed() times out', async () => {
    const clock = new FakeClock();
    const factory = new FakeEditorInjectorFactory({ original: (d) => `${d}+orig` });
    const inj = factory.create({ clock, ids: new FakeIds() });
    await inj.setup('/s', '/node');
    const { nonce } = await inj.stage('hello');
    expect(inj.runEditor('draft', { claudeDraft: false })).toMatchObject({ consumed: false, ranOriginal: true, result: 'draft+orig' });
    expect(inj.runEditor('draft')).toMatchObject({ consumed: true, result: 'hello' });
    expect(await inj.consumed(nonce, 100)).toBe(true);
    expect(inj.runEditor('again')).toMatchObject({ consumed: false, result: 'again+orig' });
    const { nonce: n2 } = await inj.stage('never');
    const p = inj.consumed(n2, 3_000);
    await clock.advanceAsync(3_100);
    expect(await p).toBe(false);
    expect(inj.armed).toBeUndefined();
    // ICR 0018: after the timeout's disarm, a late run on a Claude draft exits 1 instead of running the original editor
    expect(inj.runEditor('late')).toMatchObject({ consumed: false, ranOriginal: false, exitCode: 1, result: 'late' });
    expect(inj.runEditor('git', { claudeDraft: false })).toMatchObject({ ranOriginal: true });
    clock.jumpWall(60_000);
    expect(inj.runEditor('human')).toMatchObject({ ranOriginal: true, result: 'human+orig' }); // tombstone expired
    const k07 = new FakeEditorInjectorFactory({ neverConsume: true }).create({ clock, ids: new FakeIds() });
    await k07.setup('/s', '/n');
    await k07.stage('x');
    expect(k07.runEditor('d')).toMatchObject({ consumed: false, exitCode: 1 });
    expect(factory.last).toBe(inj);
  });
});
