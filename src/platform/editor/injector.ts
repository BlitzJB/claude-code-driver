// platform/editor/injector.ts — EditorInjector (DESIGN.md §2.7.6, D-15, §3.6 submit step 2, rev 2 §10 A11).
//   setup  → <sessionDir>/ccd-editor (0700 sh wrapper: exec '<node>' '<editor.js>' '<arm.json>' "$@") and
//            <sessionDir>/editor-orig.json (0600: the user's original VISUAL/EDITOR, so an unarmed run execs it, P-INPUT-16)
//   stage  → staged.txt (0600, exact UTF-8 bytes) then arm.json {v, nonce, stagedPath, donePath, expiresAtWall} (0600),
//            both via tmp + rename so the editor never sees a half-written file
//   consumed(nonce) → waits (clock-driven polling) for done-<nonce>; on timeout it DISARMS, so a late C-g after the
//            pasteChunks fallback started can never inject a stale prompt
//   disarm → removes arm.json and staged.txt; when an arm was still outstanding it first writes disarmed.json
//            {v, expiresAtWall} (0600, ICR 0018) so a late C-g on a Claude draft exits 1 instead of opening the user's
//            editor inside the pane
// The executor must not capture the screen while a `consumed()` wait is pending (LP-01: the editor handoff runs on the
// alternate screen) and must not send Enter before it resolved true (LP-02).
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { Clock } from '../../model/time.js';
import type { EditorInjector, EditorInjectorFactory, IdPort } from '../ports.js';
import { resolveStandaloneScript } from '../process/standalone-path.js';
import { currentUid, isNoEnt, privateDirProblem } from '../runtime-dir/dir-checks.js';
import { UnsafeRuntimeDir } from '../runtime-dir/errors.js';
import type { ArmFile, DisarmedFile, EditorOrig } from './standalone/editor.js';

export const WRAPPER_NAME = 'ccd-editor';
export const ARM_NAME = 'arm.json';
export const STAGED_NAME = 'staged.txt';
export const ORIG_NAME = 'editor-orig.json';
/** Disarm tombstone; standalone/editor.ts keeps the same literal (it may import node:* only). */
export const DISARMED_NAME = 'disarmed.json';
export const DEFAULT_ARM_TTL_MS = 30_000;
export const DEFAULT_POLL_MS = 10;

export interface EditorInjectorFactoryOptions {
  /** Host env snapshot: its VISUAL / EDITOR are recorded as the user's original editor. */
  hostEnv?: Readonly<Record<string, string>>;
  /** editor.js path (default: standalone/editor.{js,ts} next to this module). */
  scriptPath?: string;
  armTtlMs?: number;
  pollMs?: number;
}

/** POSIX single-quote a string for /bin/sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function wrapperScript(nodePath: string, scriptPath: string, armPath: string): string {
  return `#!/bin/sh\nexec ${shQuote(nodePath)} ${shQuote(scriptPath)} ${shQuote(armPath)} "$@"\n`;
}

/** The user's original editor chain, minus any library wrapper (nested library sessions). */
export function originalEditor(env: Readonly<Record<string, string>> | undefined): EditorOrig {
  const out: EditorOrig = {};
  const keep = (v: string | undefined): v is string =>
    v !== undefined && v.trim() !== '' && !v.includes('\0') && basename(v.trim().split(/\s+/)[0] ?? '') !== WRAPPER_NAME;
  const visual = env?.['VISUAL'];
  const editor = env?.['EDITOR'];
  if (keep(visual)) out.visual = visual;
  if (keep(editor)) out.editor = editor;
  return out;
}

async function writeExclusive(path: string, data: string, mode: number): Promise<void> {
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await fh.chmod(mode);
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomic(dir: string, name: string, data: string, tag: string): Promise<void> {
  const tmp = join(dir, `.${name}.${tag}.tmp`);
  await unlink(tmp).catch(() => undefined);
  await writeExclusive(tmp, data, 0o600);
  await rename(tmp, join(dir, name));
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if (isNoEnt(e)) return false;
    throw e;
  }
}

export function createEditorInjectorFactory(fo: EditorInjectorFactoryOptions = {}): EditorInjectorFactory {
  const scriptPath = fo.scriptPath ?? resolveStandaloneScript(import.meta.url, './standalone/editor');
  const armTtlMs = fo.armTtlMs ?? DEFAULT_ARM_TTL_MS;
  const pollMs = fo.pollMs ?? DEFAULT_POLL_MS;

  return {
    create({ clock, ids }: { clock: Clock; ids: IdPort }): EditorInjector {
      let dir: string | undefined;
      let seq = 0;
      /** An arm was staged and not yet confirmed consumed (a disarm must leave a tombstone). */
      let outstanding = false;
      const need = (): string => {
        if (dir === undefined) throw new Error('EditorInjector: setup() was not called');
        return dir;
      };
      const removeQuiet = async (p: string): Promise<void> => {
        await unlink(p).catch(() => undefined);
      };
      const removeDoneFiles = async (d: string): Promise<void> => {
        const names = await readdir(d).catch(() => [] as string[]);
        await Promise.all(names.filter((n) => n.startsWith('done-')).map((n) => removeQuiet(join(d, n))));
      };
      const disarm = async (): Promise<void> => {
        if (dir === undefined) return;
        if (outstanding) {
          outstanding = false;
          const t: DisarmedFile = { v: 1, expiresAtWall: clock.wallNow() + armTtlMs };
          await writeAtomic(dir, DISARMED_NAME, `${JSON.stringify(t)}\n`, `${process.pid}-d${++seq}`).catch(() => undefined);
        }
        await removeQuiet(join(dir, ARM_NAME));
        await removeQuiet(join(dir, STAGED_NAME));
      };

      return {
        async setup(sessionDir, nodePath) {
          if (!isAbsolute(sessionDir) || !isAbsolute(nodePath)) throw new UnsafeRuntimeDir(sessionDir, 'notAbsolute');
          const problem = await privateDirProblem(sessionDir, currentUid());
          if (problem !== undefined) throw new UnsafeRuntimeDir(sessionDir, problem);
          const visualPath = join(sessionDir, WRAPPER_NAME);
          await writeExclusive(visualPath, wrapperScript(nodePath, scriptPath, join(sessionDir, ARM_NAME)), 0o700);
          await writeExclusive(join(sessionDir, ORIG_NAME), `${JSON.stringify(originalEditor(fo.hostEnv))}\n`, 0o600);
          dir = sessionDir;
          return { visualPath };
        },

        async stage(text) {
          const d = need();
          const nonce = ids.tokenHex(16);
          const tag = `${process.pid}-${++seq}`;
          await removeDoneFiles(d);
          await writeAtomic(d, STAGED_NAME, text, tag);
          const arm: ArmFile = {
            v: 1,
            nonce,
            stagedPath: join(d, STAGED_NAME),
            donePath: join(d, `done-${nonce}`),
            expiresAtWall: clock.wallNow() + armTtlMs,
          };
          await writeAtomic(d, ARM_NAME, `${JSON.stringify(arm)}\n`, tag);
          outstanding = true;
          return { nonce };
        },

        async consumed(nonce, timeoutMs) {
          const d = need();
          if (!/^[0-9a-f]+$/.test(nonce)) return false;
          const done = join(d, `done-${nonce}`);
          const deadline = clock.now() + Math.max(0, timeoutMs);
          for (;;) {
            if (await exists(done)) {
              outstanding = false;
              await removeQuiet(done);
              await removeQuiet(join(d, STAGED_NAME));
              return true;
            }
            const left = deadline - clock.now();
            if (left <= 0) {
              await disarm();
              return false;
            }
            await clock.sleep(Math.min(pollMs, left));
          }
        },

        disarm,
      };
    },
  };
}
