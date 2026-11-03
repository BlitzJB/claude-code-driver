// platform/editor/standalone/editor.ts — the VISUAL target behind `<sessionDir>/ccd-editor` (DESIGN.md §2.7.6, D-15).
// node:* imports ONLY. Invoked as: node editor.js <sessionDir>/arm.json <editor args…> (the last arg is the file to edit).
//
// Armed (Claude's `C-g` on a `claude-prompt-*.md` draft while arm.json is present and unexpired):
//   1. claim arm.json by an atomic rename (a second editor run can never consume the same staged text);
//   2. copy staged.txt byte-for-byte over the draft file (IN §3.1: byte-exact, atomic replace, no paste handling);
//   3. fsync, then create done-<nonce> (0600) — the injector's `consumed()` waits for it; Enter is sent only after it
//      (LP-02: an Enter while the editor runs becomes a draft newline).
// Stale (a Claude draft while the library's own arm is gone or unusable: the C-g arrived after `consumed()` timed out and
// disarmed — the injector then leaves disarmed.json — or the claimed arm expired / is malformed; ICR 0018): exit 1 without
// touching the draft and NEVER open an interactive editor inside the pane (nobody could type into it, and the session would
// stay `inputBlocked.editor` until close).
// Unarmed (a human's C-g, or a tool child that inherited VISUAL: `crontab -e`, `git commit` without GIT_EDITOR, P-INPUT-16,
// P-REV-31): exec the user's original $VISUAL/$EDITOR recorded in editor-orig.json with the same argv, through
// `/bin/sh -c '<editor> "$@"'` (the same convention git uses); with none recorded, exit 1 without touching the file.
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { argv, exit, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';

export interface ArmFile {
  v: 1;
  nonce: string;
  stagedPath: string;
  donePath: string;
  expiresAtWall: number;
}

export interface EditorOrig {
  visual?: string;
  editor?: string;
}

/** Tombstone the injector leaves next to arm.json when it gives up on an arm (ICR 0018). */
export interface DisarmedFile {
  v: 1;
  expiresAtWall: number;
}

export const DISARMED_NAME = 'disarmed.json';
export const DRAFT_NAME = /^claude-prompt-[A-Za-z0-9._-]+\.md$/;
const NONCE = /^[0-9a-f]{16,128}$/;

/** Validate arm.json against its own directory: staged/done files must live next to it. */
export function parseArm(raw: unknown, armPath: string): ArmFile | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const dir = dirname(armPath);
  const nonce = r['nonce'];
  const stagedPath = r['stagedPath'];
  const donePath = r['donePath'];
  const expiresAtWall = r['expiresAtWall'];
  if (r['v'] !== 1 || typeof nonce !== 'string' || !NONCE.test(nonce)) return undefined;
  if (typeof stagedPath !== 'string' || dirname(stagedPath) !== dir) return undefined;
  if (typeof donePath !== 'string' || donePath !== join(dir, `done-${nonce}`)) return undefined;
  if (typeof expiresAtWall !== 'number' || !Number.isFinite(expiresAtWall)) return undefined;
  return { v: 1, nonce, stagedPath, donePath, expiresAtWall };
}

export function parseOrig(raw: unknown): EditorOrig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: EditorOrig = {};
  const ok = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !v.includes('\0');
  if (ok(r['visual'])) out.visual = r['visual'];
  if (ok(r['editor'])) out.editor = r['editor'];
  return out;
}

/** True while a valid, unexpired disarm tombstone sits next to arm.json. */
export function recentlyDisarmed(armPath: string, nowWall: number): boolean {
  const raw = readJson(join(dirname(armPath), DISARMED_NAME));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  const exp = r['expiresAtWall'];
  return r['v'] === 1 && typeof exp === 'number' && Number.isFinite(exp) && exp >= nowWall;
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Try to consume the armed staged text into `target`.
 *   'consumed'  the draft was replaced and done-<nonce> exists;
 *   'notArmed'  not a Claude draft, or nothing was armed and the library did not just give up on an arm (a human's C-g):
 *               the caller runs the user's editor;
 *   'failed'    the library's C-g cannot be honoured: we claimed the arm but could not finish (the injector disarmed
 *               meanwhile), the claimed arm is expired or malformed, or the arm is gone because `consumed()` timed out
 *               (disarm tombstone present): leave the draft alone and never open an interactive editor inside the pane.
 */
export function tryConsume(armPath: string, target: string, nowWall: number): 'consumed' | 'notArmed' | 'failed' {
  if (!DRAFT_NAME.test(basename(target))) return 'notArmed';
  const claimed = `${armPath}.claimed-${process.pid}`;
  try {
    renameSync(armPath, claimed);
  } catch {
    // Not armed, or another run claimed it first. A late library C-g (after consumed() timed out) must not open an editor.
    return recentlyDisarmed(armPath, nowWall) ? 'failed' : 'notArmed';
  }
  try {
    const arm = parseArm(readJson(claimed), armPath);
    if (arm === undefined || arm.expiresAtWall < nowWall) return 'failed'; // the library's (stale) arm, not a human's C-g
    const data = readFileSync(arm.stagedPath);
    const fd = openSync(target, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off, data.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const done = openSync(arm.donePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(done);
    return 'consumed';
  } catch {
    return 'failed';
  } finally {
    try {
      unlinkSync(claimed);
    } catch {
      // already gone
    }
  }
}

/** Run the user's original editor with the same argv; returns its exit status. */
export function runOriginal(armPath: string, editorArgs: readonly string[]): number {
  const orig = parseOrig(readJson(join(dirname(armPath), 'editor-orig.json')));
  const cmd = orig.visual ?? orig.editor;
  if (cmd === undefined) {
    stderr.write('ccd-editor: no prompt is armed and no original $VISUAL/$EDITOR was recorded\n');
    return 1;
  }
  const r = spawnSync('/bin/sh', ['-c', `${cmd} "$@"`, 'sh', ...editorArgs], { stdio: 'inherit' });
  if (r.error !== undefined) return 1;
  if (r.signal !== null) {
    const signum = (osConstants.signals as Partial<Record<string, number>>)[r.signal];
    return 128 + (signum ?? 1);
  }
  return r.status ?? 1;
}

export function main(args: readonly string[], nowWall: number = Date.now()): number {
  const [armPath, ...editorArgs] = args;
  if (armPath === undefined || !isAbsolute(armPath)) {
    stderr.write('ccd-editor: usage: editor <abs arm.json> <file>\n');
    return 2;
  }
  const target = editorArgs.at(-1);
  const r = target === undefined ? 'notArmed' : tryConsume(armPath, target, nowWall);
  if (r === 'consumed') return 0;
  if (r === 'failed') {
    stderr.write('ccd-editor: the armed prompt could not be applied\n');
    return 1;
  }
  return runOriginal(armPath, editorArgs);
}

function isEntry(): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) exit(main(argv.slice(2)));
