// Shared helpers for the WP-01 tmux unit tests: a manual clock and an argv-level tmux simulator behind ExecFileFn.
import type { Cancel, Clock, MonoMs, WallMs } from '../../../src/model/time.js';
import type { ExecFileFn, RawExecResult } from '../../../src/platform/tmux/exec.js';
import type { TmuxFs } from '../../../src/platform/tmux/server.js';

export class ManualClock implements Clock {
  mono = 1000;
  wall = Date.UTC(2026, 10, 3);
  sleeps: number[] = [];
  now(): MonoMs {
    return this.mono as MonoMs;
  }
  wallNow(): WallMs {
    return this.wall as WallMs;
  }
  advance(ms: number): void {
    this.mono += ms;
    this.wall += ms;
  }
  setTimer(_at: MonoMs, _fn: () => void): Cancel {
    return () => undefined;
  }
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.advance(ms);
    return Promise.resolve();
  }
}

export interface ExecCall {
  file: string;
  argv: string[];
  /** argv without the `-u -L <sock> -f /dev/null` prefix. */
  cmd: string[];
  stdin: string | undefined;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBuffer: number;
}

export const ok = (stdout = ''): RawExecResult => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false });
export const fail = (stderr: string, code = 1): RawExecResult => ({ code, signal: null, stdout: '', stderr, timedOut: false });

/** Split a command list at bare ';' separators. */
export function splitCommands(cmd: readonly string[]): string[][] {
  const out: string[][] = [[]];
  for (const a of cmd) {
    if (a === ';') out.push([]);
    else out[out.length - 1]!.push(a);
  }
  return out.filter((c) => c.length > 0);
}

export interface SimPane {
  id: string;
  pid: number;
  dead: boolean;
  status: string;
  signal: string;
  inMode: boolean;
  alternate: boolean;
  cols: number;
  rows: number;
  keyMode: string;
  lines: string[];
}

/**
 * A small tmux model: enough of list-sessions / new-session / list-panes / display-message / capture-pane / load-buffer /
 * paste-buffer / send-keys / kill-* to unit-test the driver's argv and its parsing, with injectable failures.
 */
export class TmuxSim {
  calls: ExecCall[] = [];
  serverUp = false;
  panes = new Map<string, SimPane>();
  buffers = new Map<string, string>();
  version = 'tmux 3.5a';
  /** Override the size new panes report (to test the resize path). */
  spawnSize: { cols: number; rows: number } | undefined;
  /** After resize-window, report this size (undefined = the requested size). */
  resizeResult: { cols: number; rows: number } | undefined;
  keyModeOnSpawn = 'VT10x';
  /** Each queued responder runs before the model; return undefined to fall through. */
  intercept: ((c: ExecCall) => RawExecResult | undefined)[] = [];
  private paneSeq = 0;

  readonly exec: ExecFileFn = (file, args, o) => {
    const argv = [...args];
    const call: ExecCall = {
      file,
      argv,
      cmd: argv[0] === '-V' ? argv : argv.slice(5),
      stdin: o.stdin,
      env: o.env,
      timeoutMs: o.timeoutMs,
      maxBuffer: o.maxBuffer,
    };
    this.calls.push(call);
    for (const i of this.intercept) {
      const r = i(call);
      if (r !== undefined) return Promise.resolve(r);
    }
    return Promise.resolve(this.model(call));
  };

  readonly fs: TmuxFs & { removed: string[]; executables: Set<string>; realpaths: Map<string, string> } = {
    removed: [],
    executables: new Set(['/opt/homebrew/bin/tmux']),
    realpaths: new Map(),
    realpathOr: (p) => Promise.resolve(this.fs.realpaths.get(p) ?? p),
    isExecutableFile: (p) => Promise.resolve(this.fs.executables.has(p)),
    rmForce: (p) => {
      this.fs.removed.push(p);
      return Promise.resolve();
    },
    rmForceSync: (p) => {
      this.fs.removed.push(p);
    },
  };

  /** Commands (split) of every call, flattened. */
  commands(): string[][] {
    return this.calls.flatMap((c) => splitCommands(c.cmd));
  }

  pane(id = '%0'): SimPane {
    const p = this.panes.get(id);
    if (p === undefined) throw new Error(`no sim pane ${id}`);
    return p;
  }

  private statusLine(p: SimPane): string {
    return [
      p.id,
      p.dead ? '1' : '0',
      p.status,
      p.signal,
      p.inMode ? '1' : '0',
      p.alternate ? '1' : '0',
      '0',
      '5',
      p.cols,
      p.rows,
      '0',
      p.keyMode,
    ].join('|');
  }

  private model(call: ExecCall): RawExecResult {
    if (call.argv[0] === '-V') return ok(`${this.version}\n`);
    let out = '';
    for (const c of splitCommands(call.cmd)) {
      const r = this.one(c, call);
      if (r.code !== 0) return { ...r, stdout: out + r.stdout };
      out += r.stdout;
    }
    return ok(out);
  }

  private flag(c: readonly string[], f: string): string | undefined {
    const i = c.indexOf(f);
    return i >= 0 ? c[i + 1] : undefined;
  }

  private one(c: readonly string[], call: ExecCall): RawExecResult {
    const name = c[0];
    const noServer = fail('no server running on /private/tmp/tmux-501/sock\n');
    if (name === 'start-server') {
      this.serverUp = true;
      return ok();
    }
    if (!this.serverUp) return noServer;
    switch (name ?? '') {
      case 'set-option':
      case 'set-hook':
        return ok();
      case 'list-sessions':
        return ok('$0\n');
      case 'new-session': {
        const id = `%${this.paneSeq}`;
        const n = this.paneSeq++;
        const size = this.spawnSize ?? { cols: Number(this.flag(c, '-x')), rows: Number(this.flag(c, '-y')) };
        this.panes.set(id, {
          id,
          pid: 4000 + n,
          dead: false,
          status: '',
          signal: '',
          inMode: false,
          alternate: false,
          cols: size.cols,
          rows: size.rows,
          keyMode: this.keyModeOnSpawn,
          lines: Array.from({ length: size.rows }, () => ''),
        });
        return ok(`$${n} @${n} ${id} ${4000 + n}\n`);
      }
      case 'list-panes': {
        const t = this.flag(c, '-t') ?? '';
        const p = this.panes.get(t);
        if (p === undefined) return fail(`can't find pane: ${t}\n`);
        const fmt = this.flag(c, '-F') ?? '';
        if (fmt.startsWith('#{pane_id}|#{pane_width}')) return ok(`${p.id}|${p.cols}|${p.rows}|${p.keyMode}|/private/tmp/tmux-501/sock\n`);
        return ok(`${this.statusLine(p)}\n`);
      }
      case 'display-message': {
        const t = this.flag(c, '-t') ?? '';
        const p = this.panes.get(t);
        if (p === undefined) return ok('|||||||||||\n'); // display-message on a missing target exits 0 (TD §6)
        return ok(`${this.statusLine(p)}\n`);
      }
      case 'capture-pane': {
        const t = this.flag(c, '-t') ?? '';
        const p = this.panes.get(t);
        if (p === undefined) return fail(`can't find pane: ${t}\n`);
        const s = Number(this.flag(c, '-S') ?? '0');
        const e = Number(this.flag(c, '-E') ?? String(p.rows - 1));
        return ok(
          p.lines
            .slice(Math.max(0, s), e + 1)
            .map((l) => `${l}\n`)
            .join(''),
        );
      }
      case 'load-buffer': {
        const b = this.flag(c, '-b') ?? '';
        if ((call.stdin ?? '') !== '') this.buffers.set(b, call.stdin ?? '');
        return ok();
      }
      case 'paste-buffer': {
        const b = this.flag(c, '-b') ?? '';
        const t = this.flag(c, '-t') ?? '';
        if (!this.buffers.has(b)) return fail(`no buffer ${b}\n`);
        if (!this.panes.has(t)) return fail(`can't find pane: ${t}\n`);
        if (c.includes('-d')) this.buffers.delete(b);
        return ok();
      }
      case 'delete-buffer': {
        const b = this.flag(c, '-b') ?? '';
        if (!this.buffers.delete(b)) return fail(`no buffer ${b}\n`);
        return ok();
      }
      case 'send-keys': {
        const t = this.flag(c, '-t') ?? '';
        const p = this.panes.get(t);
        if (p === undefined) return fail(`can't find pane: ${t}\n`);
        if (c.includes('-X') && c.at(-1) === 'cancel') p.inMode = false;
        return ok();
      }
      case 'resize-window': {
        const t = this.flag(c, '-t') ?? '';
        const p = this.panes.get(t);
        if (p === undefined) return fail(`can't find pane: ${t}\n`);
        const r = this.resizeResult ?? { cols: Number(this.flag(c, '-x')), rows: Number(this.flag(c, '-y')) };
        p.cols = r.cols;
        p.rows = r.rows;
        return ok();
      }
      case 'kill-pane': {
        const t = this.flag(c, '-t') ?? '';
        if (!this.panes.delete(t)) return fail(`can't find pane: ${t}\n`);
        return ok();
      }
      case 'kill-session':
        return ok();
      case 'kill-server':
        this.serverUp = false;
        this.panes.clear();
        return ok();
      default:
        return fail(`unknown command: ${name ?? ''}\n`);
    }
  }
}
