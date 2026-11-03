// cli/lifecheck.ts — `ccd lifecheck [--state-dir D] [--json] [--signal-hung]` run mode and the `status` classification
// (DESIGN.md §3.12, §3.8; LC §14.A).
//
// Reap/report only (D-20, rev 2 §10 G1/C5/G19): it never wakes a session, never sends input, never kills an owner.
// - P-LIFE-30: runs outside any long-lived Node process (launchd/cron via the shim in launchd.ts).
// - P-LIFE-58: an owner that is alive but whose heartbeat is older than 60 s is `owned-hung`: logged and, only with
//   `--signal-hung`, sent SIGUSR2 (diagnostic dump). It is never killed, and neither is its Claude: the reaper only touches
//   sessions whose owner is dead (pid gone or start time differs).
// - P-REV-46: the 5-min lifecheck is the reaper backstop when an owner-watch died.
// - P-REV-33 / P-LIFE-45: the reaper sweeps only registry-named sockets; unknown `ccd-*` sockets are only counted.
// - P-LIFE-57 / P-REV-32: every run writes `lifecheck.json {ranAt, lastRunOk, …}`, which `ccd lifecheck status` checks.
//
// Order: classify every session (read-only), report hung owners, then one reaper pass (it takes the registry lock itself and
// re-checks every owner under it, so a session whose owner came back between the two steps is not reaped).

import type { Classification, LifecheckHost, ReapedLine, ReapPassResult, SessionRecord } from './host.js';

/** A usage-limited session is "past its reset" this long after `resetsAtWall` (LC §14 step 5: "more than 2 min"). */
export const RESET_GRACE_MS = 120_000;
/** `ccd lifecheck status`: `ranAt` older than this → stale, exit 2 (§3.12). */
export const STATUS_STALE_MS = 15 * 60_000;

type LifecheckActionKind =
  'finalized' | 'reaped' | 'reapFailed' | 'hung' | 'hungWhileLimited' | 'diagnosticsRequested' | 'socketSwept' | 'error';

interface LifecheckAction {
  kind: LifecheckActionKind;
  sessionKey?: string;
  /** For `ClaudeSession.start({resume})` after an owner death (§3.8 recovery). */
  claudeSessionId?: string;
  detail?: string;
}

interface LifecheckSessionLine {
  key: string;
  classification: Classification;
  claudeSessionId: string;
  ownerPid: number;
  claudePid?: number;
  state?: string;
  heartbeatAgeMs?: number;
}

/** `lifecheck.json` (§3.12) — also the `--json` stdout shape. */
export interface LifecheckReport {
  ranAt: number;
  lastRunOk: boolean;
  libVersion: string;
  distPath: string;
  actions: LifecheckAction[];
  unknownCctSockets: number;
  sessions: LifecheckSessionLine[];
  durationMs: number;
  errors: string[];
}

/** Usage-limited (a `usageLimit` entry in the record) with a reset that passed more than RESET_GRACE_MS ago (§3.12). */
export function isPastUsageReset(rec: SessionRecord, now: number): boolean {
  if (rec.usageLimit === undefined) return false;
  const r = rec.usageLimit.resetsAtWall;
  return r !== undefined && now - r > RESET_GRACE_MS;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface RunLifecheckOptions {
  signalHung: boolean;
}

/** Claude outcomes after which the session cannot still be running Claude (identity-mismatch = the pid is someone else's). */
const CLAUDE_DOWN = new Set(['terminated', 'killed', 'gone', 'identity-mismatch', 'n/a']);

function reapDetail(r: ReapedLine): string {
  const parts = [`claude=${r.claude}`, `server=${r.server}`];
  if (r.socketUnlinked) parts.push('socket unlinked');
  if (r.sessionDirRemoved) parts.push('session dir removed');
  if (r.trustUnseeded) parts.push('trust unseeded');
  return parts.join(' ');
}

export async function runLifecheck(host: LifecheckHost, o: RunLifecheckOptions): Promise<LifecheckReport> {
  const started = host.nowWall();
  const report: LifecheckReport = {
    ranAt: started,
    lastRunOk: true,
    libVersion: host.libVersion,
    distPath: host.distPath,
    actions: [],
    unknownCctSockets: 0,
    sessions: [],
    durationMs: 0,
    errors: [],
  };
  const fail = (where: string, e: unknown): void => {
    report.lastRunOk = false;
    report.errors.push(`${where}: ${msg(e)}`);
  };

  // 1. classify (read-only)
  let records: SessionRecord[] = [];
  try {
    records = await host.listSessions();
  } catch (e) {
    fail('listSessions', e);
  }
  const byKey = new Map<string, { rec: SessionRecord; classification: Classification }>();
  for (const rec of records) {
    try {
      const now = host.nowWall();
      const c = await host.classify(rec);
      byKey.set(rec.key, { rec, classification: c.classification });
      const line: LifecheckSessionLine = {
        key: rec.key,
        classification: c.classification,
        claudeSessionId: rec.claudeSessionId,
        ownerPid: rec.owner.pid,
      };
      if (rec.claude.pid !== undefined) line.claudePid = rec.claude.pid;
      if (rec.state !== undefined) line.state = rec.state;
      if (c.heartbeatAt !== undefined) line.heartbeatAgeMs = Math.max(0, now - c.heartbeatAt);
      report.sessions.push(line);
      if (c.classification === 'owned-hung') await reportHung(host, rec, c.heartbeatAt, now, report, o);
    } catch (e) {
      fail(`session ${rec.key}`, e);
      report.actions.push({ kind: 'error', sessionKey: rec.key, claudeSessionId: rec.claudeSessionId, detail: msg(e) });
    }
  }

  // 2. one reaper pass (lock inside)
  let pass: ReapPassResult | undefined;
  try {
    pass = await host.reapPass();
  } catch (e) {
    fail('reap', e);
  }
  if (pass !== undefined) {
    for (const r of pass.reaped) {
      const known = byKey.get(r.key);
      const base: LifecheckAction = { kind: 'reaped', sessionKey: r.key };
      if (known !== undefined) base.claudeSessionId = known.rec.claudeSessionId;
      if (!CLAUDE_DOWN.has(r.claude)) {
        report.lastRunOk = false;
        report.actions.push({ ...base, kind: 'reapFailed', detail: reapDetail(r) });
        continue;
      }
      if (known?.classification === 'dead') {
        // `dead` → finalize from exits/: the last exit record says how it ended (tmux pane-died or owner-watch line).
        let last: string | undefined;
        try {
          last = (await host.readExits(r.key)).filter((l) => !l.startsWith('reaped ')).at(-1);
        } catch (e) {
          fail(`readExits ${r.key}`, e);
        }
        report.actions.push({
          ...base,
          kind: 'finalized',
          detail: `${last === undefined ? 'no exit record' : `exit: ${last}`}; ${reapDetail(r)}`,
        });
      } else report.actions.push({ ...base, detail: reapDetail(r) });
    }
    for (const s of pass.socketsUnlinked) report.actions.push({ kind: 'socketSwept', detail: s });
    report.unknownCctSockets = pass.unknownCctSockets;
    for (const e of pass.errors) {
      report.lastRunOk = false;
      report.errors.push(`reap: ${e}`);
    }
  }
  report.durationMs = Math.max(0, host.nowWall() - started);
  try {
    await host.writeLifecheckJson(report);
  } catch (e) {
    // The report on stdout still says why; `status` will see a stale ranAt.
    fail('writeLifecheckJson', e);
  }
  return report;
}

async function reportHung(
  host: LifecheckHost,
  rec: SessionRecord,
  heartbeatAt: number | undefined,
  now: number,
  report: LifecheckReport,
  o: RunLifecheckOptions,
): Promise<void> {
  const base = { sessionKey: rec.key, claudeSessionId: rec.claudeSessionId };
  const age = heartbeatAt === undefined ? 'no heartbeat record' : `heartbeat ${Math.round((now - heartbeatAt) / 1000)} s old`;
  host.log(`lifecheck: owner ${rec.owner.pid} of ${rec.key} looks hung (${age}); not killed`);
  report.actions.push({
    kind: isPastUsageReset(rec, now) ? 'hungWhileLimited' : 'hung',
    ...base,
    detail: `owner ${rec.owner.pid}: ${age}`,
  });
  if (o.signalHung) {
    const sent = await host.signalOwnerDiagnostics(rec.owner);
    report.actions.push({ kind: 'diagnosticsRequested', ...base, detail: sent ? 'SIGUSR2 sent' : 'SIGUSR2 failed' });
  }
}

export function formatLifecheckReport(r: LifecheckReport): string {
  const out: string[] = [];
  out.push(`lifecheck ${r.lastRunOk ? 'ok' : 'FAILED'} at ${new Date(r.ranAt).toISOString()} (${r.durationMs} ms)`);
  if (r.sessions.length === 0) out.push('  no registered sessions');
  for (const s of r.sessions) {
    const hb = s.heartbeatAgeMs === undefined ? '' : ` heartbeat ${Math.round(s.heartbeatAgeMs / 1000)}s`;
    out.push(
      `  ${s.key} ${s.classification} owner=${s.ownerPid} claude=${s.claudePid ?? '-'} session=${s.claudeSessionId}${s.state ? ` state=${s.state}` : ''}${hb}`,
    );
  }
  for (const a of r.actions) {
    out.push(
      `  action ${a.kind}${a.sessionKey ? ` ${a.sessionKey}` : ''}${a.claudeSessionId ? ` (resume: ${a.claudeSessionId})` : ''}${a.detail ? `: ${a.detail}` : ''}`,
    );
  }
  if (r.unknownCctSockets > 0) out.push(`  ${r.unknownCctSockets} ccd-* socket(s) not named by the registry (left alone)`);
  for (const e of r.errors) out.push(`  error ${e}`);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------------
// `ccd lifecheck status` classification (§3.12). The probing (files, launchctl) lives in launchd.ts.

export interface StatusProbe {
  platform: 'darwin' | 'linux' | 'other';
  shimInstalled: boolean;
  /** darwin only: the plist exists. */
  plistInstalled?: boolean;
  /** darwin only: `launchctl print gui/$UID/<label>` succeeded, and its `state =` / `last exit code =` lines. */
  launchd?: { loaded: boolean; state?: string; lastExitCode?: string };
  target?: { distPath?: string; node?: string };
  distPathExists?: boolean;
  /** Parsed `lifecheck.json`, if readable. */
  last?: { ranAt?: number; lastRunOk?: boolean; error?: string };
  now: number;
}

type StatusHealth = 'ok' | 'notInstalled' | 'neverRan' | 'stale' | 'failing';

export interface StatusResult {
  health: StatusHealth;
  /** 0 ok, 1 failing (last run not ok / dist missing / not loaded), 2 stale or never ran (§3.12), 3 not installed. */
  exitCode: 0 | 1 | 2 | 3;
  installed: boolean;
  ranAt?: number;
  ranAgeMs?: number;
  lastRunOk?: boolean;
  distPath?: string;
  distPathExists?: boolean;
  launchd?: { loaded: boolean; state?: string; lastExitCode?: string };
  problems: string[];
}

export function classifyStatus(p: StatusProbe): StatusResult {
  const problems: string[] = [];
  const installed = p.shimInstalled && (p.platform !== 'darwin' || p.plistInstalled === true);
  const r: StatusResult = { health: 'ok', exitCode: 0, installed, problems };
  if (p.launchd !== undefined) r.launchd = p.launchd;
  if (p.target?.distPath !== undefined) r.distPath = p.target.distPath;
  if (p.distPathExists !== undefined) r.distPathExists = p.distPathExists;
  if (p.last?.ranAt !== undefined) {
    r.ranAt = p.last.ranAt;
    r.ranAgeMs = Math.max(0, p.now - p.last.ranAt);
  }
  if (p.last?.lastRunOk !== undefined) r.lastRunOk = p.last.lastRunOk;

  if (!p.shimInstalled) problems.push('shim not installed (run `ccd lifecheck install`)');
  if (p.platform === 'darwin' && p.plistInstalled !== true) problems.push('LaunchAgent plist not installed');
  if (!installed) return { ...r, health: 'notInstalled', exitCode: 3 };

  let failing = false;
  if (p.platform === 'darwin' && p.launchd?.loaded !== true) {
    problems.push('LaunchAgent not loaded in gui/$UID');
    failing = true;
  }
  if (p.target?.distPath === undefined) {
    problems.push('lifecheck-target.json has no distPath');
    failing = true;
  } else if (p.distPathExists !== true) {
    problems.push(`distPath ${p.target.distPath} does not exist (reinstalled? the next start() rewrites it)`);
    failing = true;
  }
  if (p.last?.lastRunOk === false) {
    problems.push(`last run failed${p.last.error ? `: ${p.last.error}` : ''}`);
    failing = true;
  }
  if (r.ranAt === undefined) {
    problems.push('lifecheck has never run (no lifecheck.json ranAt)');
    return { ...r, health: 'neverRan', exitCode: 2 };
  }
  if ((r.ranAgeMs ?? 0) > STATUS_STALE_MS) {
    problems.push(`last run ${Math.round((r.ranAgeMs ?? 0) / 60_000)} min ago (> 15 min)`);
    return { ...r, health: 'stale', exitCode: 2 };
  }
  if (failing) return { ...r, health: 'failing', exitCode: 1 };
  return r;
}

export function formatStatus(s: StatusResult): string {
  const out = [`lifecheck status: ${s.health}`];
  out.push(`  installed: ${s.installed ? 'yes' : 'no'}`);
  if (s.launchd !== undefined)
    out.push(
      `  launchd: ${s.launchd.loaded ? 'loaded' : 'not loaded'}${s.launchd.state ? ` state=${s.launchd.state}` : ''}${s.launchd.lastExitCode ? ` last exit=${s.launchd.lastExitCode}` : ''}`,
    );
  if (s.ranAt !== undefined)
    out.push(`  last run: ${new Date(s.ranAt).toISOString()} (${Math.round((s.ranAgeMs ?? 0) / 1000)} s ago), ok=${String(s.lastRunOk)}`);
  if (s.distPath !== undefined) out.push(`  distPath: ${s.distPath} (${s.distPathExists ? 'exists' : 'MISSING'})`);
  for (const p of s.problems) out.push(`  problem: ${p}`);
  return out.join('\n') + '\n';
}
