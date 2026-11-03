// platform/tmux/pane.ts — TmuxPane: FIFO input queue, paste, typeLiteral, sendKey, capture, status (DESIGN.md §2.7.3).
//
// Pitfalls handled here (§5.1/§5.2):
//   P-TMUX-07  paste-buffer always `-p -r -d` (no LF→CR rewrite, bracketed when the app enabled 2004, buffer deleted)
//   P-TMUX-09  text and keys never share an invocation; Enter is never sent by paste/typeLiteral
//   P-TMUX-11/12/13/53, P-INPUT-28, P-SEC-05, P-PRIOR-06  sendKey accepts the closed TmuxKeyName list only, one key per call
//   P-TMUX-14  one key per invocation
//   P-TMUX-15  every command addresses the pane by `%N`; existence via `list-panes -t %N` (display-message exits 0 on a miss)
//   P-TMUX-21  input checks the pane status (cached ≤ 100 ms, adapter timer A-2 = a timestamp check) → TmuxPaneDead
//   P-TMUX-27/30  capture = `display-message ; capture-pane -p -N` in one batch, never -J, never -S -, never -a
//   P-TMUX-44  one FIFO queue per pane serialises all input
//   P-TMUX-45  copy mode reported in every status/capture; input refused while in mode; exitCopyMode() = `send-keys -X cancel`
//   P-TMUX-52  lone surrogates rejected (they would become U+FFFD)
//   P-TMUX-58  unique buffer `ccd-<pane>-<n>` + `-d`; `delete-buffer` on failure
//   P-TMUX-59  text only through a short-lived execFile with stdin (`load-buffer -`)
//   P-REV-44   (LP-52) input refused unless `#{pane_key_mode}` is VT10x (where the format exists)
// The pane never waits or sleeps: every gap is a core deadline (P-TMUX-10, P-TMUX-54).

import { createHash } from 'node:crypto';
import { constants as osConstants } from 'node:os';
import type { TmuxKeyName } from '../../model/intents.js';
import type { Logger } from '../../model/logger.js';
import type { Cancel, Clock, MonoMs } from '../../model/time.js';
import type { Capture, PaneInfo, PaneStatus, TmuxPane } from '../ports.js';
import { commandList, exactTarget, type CommandSpec } from './args.js';
import {
  isServerGoneError,
  LITERAL_LIMIT_BYTES,
  TmuxArgTooLong,
  TmuxCommandFailed,
  TmuxInvalidInput,
  TmuxPaneDead,
  TmuxPaneInMode,
  TmuxTargetMissing,
  TmuxUnsupported,
} from './errors.js';
import type { TmuxExec } from './exec.js';
import type { TmuxFeatures } from './version.js';

/** The closed key list (model/intents.ts). A runtime check backs the type: callers may be untyped JS. */
export const TMUX_KEYS = ['Enter', 'Escape', 'BTab', 'Up', 'Down', 'C-g', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
type MissingKeys = Exclude<TmuxKeyName, (typeof TMUX_KEYS)[number]>;
type AssertTrue<T extends true> = T;
// Compile-time: TMUX_KEYS lists every TmuxKeyName.
type _AllKeysListed = AssertTrue<[MissingKeys] extends [never] ? true : false>;
const KEY_SET: ReadonlySet<string> = new Set<string>(TMUX_KEYS);

export function isTmuxKeyName(k: unknown): k is TmuxKeyName {
  return typeof k === 'string' && KEY_SET.has(k);
}

/** A-2: the status cache TTL. */
export const STATUS_TTL_MS = 100;

/** Status format; '|' never occurs in any of these values. `pane_key_mode` expands to '' on tmux < 3.5. */
const STATUS_FIELDS = [
  'pane_id',
  'pane_dead',
  'pane_dead_status',
  'pane_dead_signal',
  'pane_in_mode',
  'alternate_on',
  'cursor_x',
  'cursor_y',
  'pane_width',
  'pane_height',
  'history_size',
  'pane_key_mode',
] as const;
const STATUS_FORMAT = STATUS_FIELDS.map((f) => `#{${f}}`).join('|');

export interface RawPaneStatus extends PaneStatus {
  /** `#{pane_key_mode}` ('' where the format does not exist). Internal: not part of the port's PaneStatus. */
  keyMode: string;
}

const SIGNAL_BY_NUMBER: ReadonlyMap<number, string> = new Map(Object.entries(osConstants.signals).map(([name, n]) => [n, name] as const));

/** tmux prints `term` (3.5a, VERIFIED), older builds may print a number; normalise to `SIGTERM`. */
export function normalizeSignal(s: string): string | null {
  const t = s.trim();
  if (t === '') return null;
  if (/^\d+$/.test(t)) return SIGNAL_BY_NUMBER.get(Number(t)) ?? `SIG${t}`;
  const up = t.toUpperCase();
  return up.startsWith('SIG') ? up : `SIG${up}`;
}

function int(s: string | undefined, dflt = 0): number {
  if (s === undefined || s.trim() === '') return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/** Parse one STATUS_FORMAT line. Returns undefined for lines of another pane or garbage. */
export function parseStatusLine(line: string, paneId: string): RawPaneStatus | undefined {
  const f = line.split('|');
  if (f.length !== STATUS_FIELDS.length || f[0] !== paneId) return undefined;
  const dead = f[1] === '1';
  const st = f[2] ?? '';
  return {
    exists: true,
    dead,
    exitStatus: dead && st.trim() !== '' ? int(st) : null,
    exitSignal: dead ? normalizeSignal(f[3] ?? '') : null,
    inMode: f[4] === '1',
    alternateOn: f[5] === '1',
    cursorX: int(f[6]),
    cursorY: int(f[7]),
    cols: int(f[8]),
    rows: int(f[9]),
    historySize: int(f[10]),
    keyMode: f[11] ?? '',
  };
}

/** P-TMUX-52: true when the string has no lone surrogate (String.prototype.isWellFormed is ES2024). */
export function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

// Paste may carry LF and TAB only; ESC would let text close the bracketed paste early (`ESC[201~`), CR would submit.

const PASTE_FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// typeLiteral is single-line slash-command text: no control characters at all.

const LITERAL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f]/;

/** TD R9: CRLF and lone CR become LF (raw CR would be a submit inside an unbracketed paste). */
export function normalizePasteText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Read-only attach command for humans (`attach -r`: a read-only client cannot send keys, TD §9). */
export function viewCommandFor(tmuxPath: string, socketName: string, sessionName: string): string {
  return `${shellQuote(tmuxPath)} -L ${socketName} attach -r -t ${shellQuote(exactTarget(sessionName))}`;
}

/** What a pane needs from its server. */
export interface PaneHost {
  readonly exec: TmuxExec;
  readonly clock: Clock;
  readonly features: TmuxFeatures;
  readonly logger?: Logger | undefined;
  /** A command failed with TmuxServerGone/TmuxCrashed. */
  serverGone(): void;
  /** True after TmuxServer.kill(): failures are expected, not news. */
  readonly killed: boolean;
}

export class TmuxPaneImpl implements TmuxPane {
  readonly info: PaneInfo;
  private readonly host: PaneHost;
  private readonly sessionName: string;
  private readonly paneNum: number;
  private bufferSeq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private cache: { at: MonoMs; status: RawPaneStatus } | undefined;
  private last: RawPaneStatus | undefined;
  private diedFired = false;
  private goneFired = false;
  private readonly diedListeners = new Set<(s: { exitStatus: number | null; exitSignal: string | null }) => void>();
  private readonly goneListeners = new Set<() => void>();

  constructor(host: PaneHost, info: PaneInfo, sessionName: string) {
    this.host = host;
    this.info = Object.freeze({ ...info });
    this.sessionName = sessionName;
    this.paneNum = Number(info.paneId.slice(1));
  }

  /** The tmux session this pane was spawned in (internal, for the server's cleanup rules). */
  get sessionNameValue(): string {
    return this.sessionName;
  }

  /** True once a gone condition (pane missing, server gone or killed) was observed. */
  get isGone(): boolean {
    return this.goneFired;
  }

  // ---------------------------------------------------------------- events

  on(e: 'died', fn: (s: { exitStatus: number | null; exitSignal: string | null }) => void): Cancel;
  on(e: 'gone', fn: () => void): Cancel;
  on(e: 'died' | 'gone', fn: ((s: { exitStatus: number | null; exitSignal: string | null }) => void) | (() => void)): Cancel {
    if (e === 'died') {
      const f = fn;
      this.diedListeners.add(f);
      return () => this.diedListeners.delete(f);
    }
    const g = fn as () => void;
    this.goneListeners.add(g);
    return () => this.goneListeners.delete(g);
  }

  private safeCall(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.host.logger?.warn('tmux pane listener threw', { what, error: String(err) });
    }
  }

  private observe(s: RawPaneStatus): void {
    this.last = s;
    this.cache = { at: this.host.clock.now(), status: s };
    if (s.dead && !this.diedFired) {
      this.diedFired = true;
      const ev = { exitStatus: s.exitStatus, exitSignal: s.exitSignal };
      for (const l of [...this.diedListeners])
        this.safeCall('died', () => {
          l(ev);
        });
    }
  }

  /** Mark the pane gone (target missing or server gone) and fire 'gone' once. */
  markGone(): RawPaneStatus {
    const prev = this.last;
    const s: RawPaneStatus = {
      exists: false,
      dead: prev?.dead ?? false,
      exitStatus: prev?.exitStatus ?? null,
      exitSignal: prev?.exitSignal ?? null,
      inMode: false,
      alternateOn: false,
      cursorX: 0,
      cursorY: 0,
      cols: prev?.cols ?? this.info.cols,
      rows: prev?.rows ?? this.info.rows,
      historySize: prev?.historySize ?? 0,
      keyMode: prev?.keyMode ?? '',
    };
    this.last = s;
    this.cache = { at: this.host.clock.now(), status: s };
    if (!this.goneFired) {
      this.goneFired = true;
      for (const l of [...this.goneListeners]) this.safeCall('gone', l);
    }
    return s;
  }

  /** Classify a failure: gone conditions update state; everything is rethrown by the caller. */
  private noteFailure(e: unknown): void {
    if (isServerGoneError(e)) {
      if (!this.host.killed) this.host.serverGone();
      this.markGone();
    } else if (e instanceof TmuxTargetMissing) {
      this.markGone();
    }
  }

  private async run(cmds: readonly CommandSpec[], stdin?: string): Promise<string> {
    try {
      return await this.host.exec.run(commandList(cmds), stdin !== undefined ? { stdin } : {});
    } catch (e) {
      this.noteFailure(e);
      throw e;
    }
  }

  // ---------------------------------------------------------------- status

  private async fetchStatus(): Promise<RawPaneStatus> {
    let out: string;
    try {
      out = await this.run([
        {
          name: 'list-panes',
          flags: [
            ['-t', this.info.paneId],
            ['-F', STATUS_FORMAT],
          ],
        },
      ]);
    } catch (e) {
      if (isServerGoneError(e) || e instanceof TmuxTargetMissing) return this.goneStatus();
      throw e;
    }
    for (const line of out.split('\n')) {
      const s = parseStatusLine(line, this.info.paneId);
      if (s !== undefined) {
        this.observe(s);
        return s;
      }
    }
    this.markGone();
    return this.goneStatus();
  }

  /** The status recorded by markGone() (always set once a gone condition was observed). */
  private goneStatus(): RawPaneStatus {
    return this.last ?? this.markGone();
  }

  /** Cached ≤ 100 ms (A-2). Never throws for a missing pane or a gone server: those report `exists:false`. */
  async status(): Promise<PaneStatus> {
    return toPublic(await this.rawStatus(false));
  }

  /** Internal status including the key mode; `fresh` bypasses the cache. */
  async rawStatus(fresh: boolean): Promise<RawPaneStatus> {
    const c = this.cache;
    if (!fresh && c !== undefined && this.host.clock.now() - c.at <= STATUS_TTL_MS) return c.status;
    if (this.goneFired) return this.goneStatus();
    return this.fetchStatus();
  }

  /** Every input op: pane must exist, be alive, not in copy mode, and in the legacy key mode. */
  private async assertInputReady(): Promise<void> {
    const s = await this.rawStatus(false);
    if (!s.exists) throw new TmuxTargetMissing(this.info.paneId);
    if (s.dead) throw new TmuxPaneDead(this.info.paneId, s.exitStatus, s.exitSignal);
    if (s.inMode) throw new TmuxPaneInMode(this.info.paneId);
    if (s.keyMode !== '' && s.keyMode !== 'VT10x') throw new TmuxUnsupported('extendedKeys', s.keyMode);
    if (s.keyMode === '' && this.host.features.paneKeyMode) throw new TmuxUnsupported('extendedKeys', '(empty)');
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  // ---------------------------------------------------------------- input

  paste(text: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isWellFormedString(text)) throw new TmuxInvalidInput('notWellFormed', 'paste text has a lone surrogate');
      const body = normalizePasteText(text);
      if (PASTE_FORBIDDEN.test(body)) throw new TmuxInvalidInput('controlChar', 'paste text may contain only LF and TAB controls');
      if (body === '') return; // load-buffer of empty stdin creates no buffer (VERIFIED 3.5a); nothing to paste
      await this.assertInputReady();
      const buffer = `ccd-${this.paneNum}-${++this.bufferSeq}`;
      try {
        await this.run(
          [
            { name: 'load-buffer', flags: [['-b', buffer]], positional: ['-'] },
            { name: 'paste-buffer', flags: [['-t', this.info.paneId], ['-b', buffer], ['-d'], ['-p'], ['-r']] },
          ],
          body,
        );
      } catch (e) {
        await this.deleteBufferQuietly(buffer, e);
        throw e;
      }
    });
  }

  private async deleteBufferQuietly(buffer: string, cause: unknown): Promise<void> {
    if (isServerGoneError(cause)) return;
    try {
      await this.host.exec.run(commandList([{ name: 'delete-buffer', flags: [['-b', buffer]] }]));
    } catch {
      /* the buffer may never have been created */
    }
  }

  typeLiteral(text: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isWellFormedString(text)) throw new TmuxInvalidInput('notWellFormed', 'literal text has a lone surrogate');
      if (LITERAL_FORBIDDEN.test(text)) throw new TmuxInvalidInput('controlChar', 'literal text must be one line without controls');
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > LITERAL_LIMIT_BYTES) throw new TmuxArgTooLong(bytes, LITERAL_LIMIT_BYTES);
      if (text === '') return;
      await this.assertInputReady();
      await this.run([{ name: 'send-keys', flags: [['-t', this.info.paneId], ['-l']], positional: [text], endOfFlags: true }]);
    });
  }

  sendKey(k: TmuxKeyName): Promise<void> {
    return this.enqueue(async () => {
      if (!isTmuxKeyName(k)) throw new TmuxInvalidInput('unknownKey', `key not in the closed list: ${String(k).slice(0, 16)}`);
      await this.assertInputReady();
      await this.run([{ name: 'send-keys', flags: [['-t', this.info.paneId]], positional: [k] }]);
    });
  }

  exitCopyMode(): Promise<void> {
    return this.enqueue(async () => {
      const s = await this.rawStatus(true);
      if (!s.exists || !s.inMode) return;
      try {
        await this.run([{ name: 'send-keys', flags: [['-t', this.info.paneId], ['-X']], positional: ['cancel'] }]);
      } catch (e) {
        // The mode can end between the status read and the cancel (a human pressed q): tmux says `not in a mode`.
        if (!(e instanceof TmuxCommandFailed && e.stderr.includes('not in a mode'))) throw e;
      }
      this.cache = undefined;
    });
  }

  async killPane(): Promise<void> {
    try {
      await this.run([{ name: 'kill-pane', flags: [['-t', this.info.paneId]] }]);
    } catch (e) {
      if (isServerGoneError(e) || e instanceof TmuxTargetMissing) return;
      throw e;
    }
    this.cache = undefined;
  }

  // ---------------------------------------------------------------- output

  async capture(o: { styles?: boolean; startRow?: number; endRow?: number } = {}): Promise<Capture> {
    const flags: (readonly [string] | readonly [string, string])[] = [['-p'], ['-N'], ['-t', this.info.paneId]];
    if (o.styles === true) flags.push(['-e']);
    if (o.startRow !== undefined) {
      if (!Number.isInteger(o.startRow)) throw new TmuxInvalidInput('badOption', 'startRow must be an integer');
      flags.push(['-S', String(o.startRow)]);
    }
    if (o.endRow !== undefined) {
      if (!Number.isInteger(o.endRow)) throw new TmuxInvalidInput('badOption', 'endRow must be an integer');
      flags.push(['-E', String(o.endRow)]);
    }
    if (o.startRow !== undefined && o.endRow !== undefined && o.startRow > o.endRow)
      throw new TmuxInvalidInput('badOption', 'startRow > endRow');
    const out = await this.run([
      { name: 'display-message', flags: [['-p'], ['-t', this.info.paneId]], positional: [STATUS_FORMAT] },
      { name: 'capture-pane', flags },
    ]);
    const nl = out.indexOf('\n');
    const head = nl < 0 ? out : out.slice(0, nl);
    const rest = nl < 0 ? '' : out.slice(nl + 1);
    const s = parseStatusLine(head, this.info.paneId);
    if (s === undefined) {
      this.markGone();
      throw new TmuxTargetMissing(this.info.paneId);
    }
    this.observe(s);
    const lines = rest === '' ? [] : rest.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const at = this.host.clock.now();
    return { lines, status: toPublic(s), at, hash: captureHash(lines, s) };
  }

  viewCommand(): string {
    return viewCommandFor(this.host.exec.tmuxPath, this.host.exec.socketName, this.sessionName);
  }
}

function toPublic(s: RawPaneStatus): PaneStatus {
  return {
    exists: s.exists,
    dead: s.dead,
    exitStatus: s.exitStatus,
    exitSignal: s.exitSignal,
    inMode: s.inMode,
    alternateOn: s.alternateOn,
    cursorX: s.cursorX,
    cursorY: s.cursorY,
    cols: s.cols,
    rows: s.rows,
    historySize: s.historySize,
  };
}

/** Change detection for the L1 consecutive-identical drop (D-41/D-42): content plus the mode bits that change meaning. */
export function captureHash(
  lines: readonly string[],
  s: Pick<PaneStatus, 'dead' | 'inMode' | 'alternateOn' | 'cursorX' | 'cursorY'>,
): string {
  const h = createHash('sha1');
  h.update(`${s.dead ? 1 : 0}${s.inMode ? 1 : 0}${s.alternateOn ? 1 : 0}:${s.cursorX},${s.cursorY}\n`);
  h.update(lines.join('\n'));
  return h.digest('hex');
}
