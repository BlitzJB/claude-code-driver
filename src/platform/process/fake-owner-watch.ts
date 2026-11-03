// platform/process/fake-owner-watch.ts — OwnerWatchFactory fake wired to FakeProcess (K-22: "FakeProcess kills the owner →
// FakeOwnerWatch reports Claude + server killed"). Same decision rules as the standalone: identity-verified Claude kill,
// tmux server kill regardless, `watch=claude-gone` when Claude exits first, no action after stop().
import type { OwnerWatchFactory } from '../ports.js';
import { OwnerWatchStartFailed } from './errors.js';
import type { FakeProcess } from './fake-process.js';
import { parseWatchConfig, type WatchConfig } from './standalone/owner-watch.js';

export interface FakeOwnerWatchReport {
  kind: 'owner-gone' | 'claude-gone';
  watcherPid: number;
  claude: 'terminated' | 'killed' | 'gone' | 'identity-mismatch' | 'survived' | 'n/a';
  serverKilled: boolean;
  exitsLine: string;
}

export interface FakeOwnerWatchOptions {
  process: FakeProcess;
  /** Reads watch.json by path (e.g. from FakeSettingsFile); a parsed object or JSON text. */
  readConfig: (configPath: string) => unknown;
  /** Called when the watcher kills the private tmux server (WP-14 wires it to FakeTmux). */
  onKillServer?: (cfg: WatchConfig) => void;
  /** Called with each exits-log line. */
  appendExit?: (exitsLog: string, line: string) => void;
}

export class FakeOwnerWatchFactory implements OwnerWatchFactory {
  readonly reports: FakeOwnerWatchReport[] = [];
  readonly started: { pid: number; config: WatchConfig; logPath: string; stopped: boolean }[] = [];

  constructor(private readonly o: FakeOwnerWatchOptions) {}

  start(s: { configPath: string; logPath: string }): Promise<{ pid: number; stop(): Promise<void> }> {
    let raw = this.o.readConfig(s.configPath);
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return Promise.reject(new OwnerWatchStartFailed('watch.json unreadable'));
      }
    }
    const cfg = parseWatchConfig(raw);
    if (typeof cfg === 'string') return Promise.reject(new OwnerWatchStartFailed(`watch.json invalid: ${cfg}`));
    const fp = this.o.process;
    const pid = fp.addProcess({ command: `node owner-watch.js ${s.configPath}` });
    const entry = { pid, config: cfg, logPath: s.logPath, stopped: false };
    this.started.push(entry);

    let done = false;
    const finish = (): void => {
      off();
      fp.exit(pid);
    };
    const report = (r: Omit<FakeOwnerWatchReport, 'watcherPid' | 'exitsLine'>): void => {
      const exitsLine =
        r.kind === 'claude-gone'
          ? `watch=claude-gone claudePid=${cfg.claudePid} watcher=${pid}`
          : `watch=owner-gone ownerPid=${cfg.ownerPid} claudePid=${cfg.claudePid} claude=${r.claude} server=${r.serverKilled ? 'killed' : 'kill-failed'} watcher=${pid}`;
      const full: FakeOwnerWatchReport = { ...r, watcherPid: pid, exitsLine };
      this.reports.push(full);
      this.o.appendExit?.(cfg.exitsLog, exitsLine);
    };

    const ownerGone = (): void => {
      done = true;
      let claude: FakeOwnerWatchReport['claude'];
      const p = fp.procs.get(cfg.claudePid);
      if (p?.alive !== true) claude = 'gone';
      else if (!(p.startTime === cfg.claudeStart && p.command.includes(cfg.claudeExeSubstr) && p.command.includes(cfg.sessionIdSubstr)))
        claude = 'identity-mismatch';
      else {
        fp.kill(cfg.claudePid, 'SIGTERM');
        if (!fp.isAlive(cfg.claudePid)) claude = 'terminated';
        else {
          fp.kill(cfg.claudePid, 'SIGKILL');
          claude = fp.isAlive(cfg.claudePid) ? 'survived' : 'killed';
        }
      }
      this.o.onKillServer?.(cfg);
      report({ kind: 'owner-gone', claude, serverKilled: true });
      finish();
    };

    const off = fp.onExit((p) => {
      if (done || entry.stopped || !fp.isAlive(pid)) return;
      if (p.pid === cfg.ownerPid) ownerGone();
      else if (p.pid === cfg.claudePid) {
        done = true;
        report({ kind: 'claude-gone', claude: 'n/a', serverKilled: false });
        finish();
      }
    });

    // First check happens at once, like the standalone's first poll.
    const owner = fp.procs.get(cfg.ownerPid);
    if (!fp.isAlive(cfg.claudePid)) {
      done = true;
      report({ kind: 'claude-gone', claude: 'n/a', serverKilled: false });
      finish();
    } else if (owner?.alive !== true || owner.startTime !== cfg.ownerStart) ownerGone();

    return Promise.resolve({
      pid,
      stop: () => {
        entry.stopped = true;
        off();
        if (fp.isAlive(pid)) fp.kill(pid, 'SIGTERM');
        return Promise.resolve();
      },
    });
  }
}
