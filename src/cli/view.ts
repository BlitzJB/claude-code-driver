// cli/view.ts — `ccd view <sessionKey> [--exec] [--state-dir D]` (DESIGN.md §3.12).
//
// Prints (or, with --exec, runs) the **read-only** attach command for a live library session, built from the registry record
// only — no kernel, no tmux driver. `attach -r` is the only client the library ever attaches (P-TMUX-18: the window size is
// pinned per window, never globally, and a read-only client cannot type into Claude's composer). A human who needs to
// answer an elicitation does so knowingly in their own terminal (§4.6 PendingInput).

import type { SessionRecord } from './host.js';

export interface ViewHost {
  readSession(key: string): Promise<SessionRecord | 'missing' | { error: string }>;
  /** Runs a command with the terminal inherited; resolves with its exit code. */
  execInteractive(file: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<number>;
  env(): Readonly<Record<string, string>>;
}

export class ViewError extends Error {
  override readonly name = 'ViewError';
}

/** Session keys are minted by L3 (`s` + hex); anything else is refused before it reaches a path. */
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** tmux socket and session names the library creates (`ccd-…`); refuse anything a shell or tmux target could misread. */
const TMUX_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const BIN = /^\/[A-Za-z0-9/._+-]+$/;

export function assertSessionKey(key: string): string {
  if (!KEY.test(key)) throw new ViewError(`invalid session key ${JSON.stringify(key)}`);
  return key;
}

/** `tmux -u -L <sock> attach-session -r -t =<session>:` as argv (TmuxPane.viewCommand shape, §2.7.3). */
export function viewArgv(rec: SessionRecord): { file: string; args: string[] } {
  if (!BIN.test(rec.tmux.bin)) throw new ViewError(`registry tmux bin ${JSON.stringify(rec.tmux.bin)} is not an absolute plain path`);
  if (!TMUX_NAME.test(rec.tmux.socketName)) throw new ViewError(`registry socket name ${JSON.stringify(rec.tmux.socketName)} is unsafe`);
  if (!TMUX_NAME.test(rec.tmux.sessionName)) throw new ViewError(`registry session name ${JSON.stringify(rec.tmux.sessionName)} is unsafe`);
  return { file: rec.tmux.bin, args: ['-u', '-L', rec.tmux.socketName, 'attach-session', '-r', '-t', `=${rec.tmux.sessionName}:`] };
}

const shq = (s: string): string => (/^[A-Za-z0-9/._:=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The printable shell command. `TMUX=` is cleared so it also works from inside another tmux client. */
export function viewCommandLine(rec: SessionRecord): string {
  const { file, args } = viewArgv(rec);
  return ['env', '-u', 'TMUX', file, ...args].map(shq).join(' ');
}

export async function runView(
  host: ViewHost,
  key: string,
  o: { exec: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  assertSessionKey(key);
  const rec = await host.readSession(key);
  if (rec === 'missing') return { exitCode: 1, stdout: '', stderr: `ccd view: no live session ${key} in the registry\n` };
  if ('error' in rec) return { exitCode: 1, stdout: '', stderr: `ccd view: unreadable registry record ${key}: ${rec.error}\n` };
  const line = viewCommandLine(rec);
  if (!o.exec) return { exitCode: 0, stdout: line + '\n', stderr: '' };
  const { file, args } = viewArgv(rec);
  const env: Record<string, string> = { ...host.env() };
  delete env['TMUX'];
  delete env['TMUX_PANE'];
  const code = await host.execInteractive(file, args, env);
  return { exitCode: code, stdout: '', stderr: '' };
}
