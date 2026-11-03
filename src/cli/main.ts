#!/usr/bin/env node
// cli/main.ts — the `ccd` bin (DESIGN.md §3.12, package.json `bin.ccd`).
//
//   ccd lifecheck [--state-dir D] [--json] [--signal-hung]     reap orphans, finalize dead sessions, report hung owners
//   ccd lifecheck install|uninstall [--state-dir D]           state-dir shim + LaunchAgent (darwin) / printed units (linux)
//   ccd lifecheck status [--state-dir D] [--json]             installed? loaded? last run ok? stale (> 15 min) → exit 2
//   ccd view <sessionKey> [--exec] [--state-dir D]            print / run the read-only `tmux attach -r` command
//   ccd trace replay <file> [--golden G] [--kinds k,…] [--json]
//   ccd trace explain <file> --event <seq> [--json]
//
// Exit codes: 0 ok, 1 failure, 2 stale/never ran (status), 3 not installed (status), 64 usage error.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LIB_VERSION } from '../model/version.js';
import { intFlag, parseArgs, UsageError } from './args.js';
import type { InstallHost, LifecheckHost } from './host.js';
import { installLifecheck, InstallError, lifecheckStatus, uninstallLifecheck } from './launchd.js';
import { formatLifecheckReport, formatStatus, runLifecheck } from './lifecheck.js';
import { createLifecheckHost } from './lifecheck-host.js';
import { createInstallHost, createViewHost, defaultStateDir, processEnv } from './node-host.js';
import { explainEvent, formatExplanation, parseKinds, parseTrace, replayTrace, TraceError } from './trace.js';
import { runView, ViewError, type ViewHost } from './view.js';

export const EXIT_USAGE = 64;

export interface CliDeps {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  lifecheckHost: (stateDir: string) => Promise<LifecheckHost>;
  installHost: (stateDir: string) => InstallHost;
  viewHost: (stateDir: string) => ViewHost;
  readFile: (path: string) => Promise<string>;
}

export const USAGE = `usage:
  ccd lifecheck [--state-dir D] [--json] [--signal-hung]
      --signal-hung sends SIGUSR2 to owners whose heartbeat is > 60 s old (diagnostic dump). Only use it when the host
      process installed a SIGUSR2 handler: Node's default action for SIGUSR2 terminates the process.
  ccd lifecheck install|uninstall [--state-dir D]
  ccd lifecheck status [--state-dir D] [--json]
  ccd view <sessionKey> [--exec] [--state-dir D]
  ccd trace replay <file> [--golden <events.jsonl>] [--kinds header,raw,obs,cmd,step,event,effect,diag,drop] [--json]
  ccd trace explain <file> --event <seq> [--json]
`;

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

function stateDirOf(deps: CliDeps, flag: string | undefined): string {
  if (flag !== undefined) {
    if (!flag.startsWith('/')) throw new UsageError('--state-dir must be an absolute path');
    return flag.replace(/\/+$/, '') || '/';
  }
  return defaultStateDir(deps.env, deps.homeDir);
}

async function recordHostFailure(deps: CliDeps, stateDir: string, e: unknown): Promise<void> {
  const error = `host: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  try {
    const h = deps.installHost(stateDir);
    const report = {
      ranAt: h.nowWall(),
      lastRunOk: false,
      libVersion: LIB_VERSION,
      distPath: h.distPath,
      actions: [],
      unknownCctSockets: 0,
      sessions: [],
      errors: [error],
      error,
    };
    await h.writeFile(`${stateDir}/lifecheck.json`, json(report), 0o600);
  } catch {
    // the state dir itself is unusable; stderr has the cause
  }
}

async function lifecheckCmd(argv: readonly string[], deps: CliDeps): Promise<number> {
  const p = parseArgs(argv, { values: ['state-dir'], booleans: ['json', 'signal-hung'] });
  const sub = p.positionals[0];
  if (p.positionals.length > 1) throw new UsageError(`unexpected argument ${JSON.stringify(p.positionals[1])}`);
  const stateDir = stateDirOf(deps, p.values.get('state-dir'));
  const asJson = p.booleans.has('json');
  if (sub === undefined || sub === 'run') {
    let host: LifecheckHost;
    try {
      host = await deps.lifecheckHost(stateDir);
    } catch (e) {
      // No ports, no reaper: still leave `lastRunOk:false` behind so `ccd lifecheck status` reports the breakage instead of
      // a silently stale `ranAt` (P-REV-32). Best effort; the error itself goes to stderr (the launchd log).
      await recordHostFailure(deps, stateDir, e);
      throw e;
    }
    const report = await runLifecheck(host, { signalHung: p.booleans.has('signal-hung') });
    deps.out(asJson ? json(report) : formatLifecheckReport(report));
    return report.lastRunOk ? 0 : 1;
  }
  if (p.booleans.has('signal-hung')) throw new UsageError('--signal-hung only applies to a lifecheck run');
  if (sub === 'install' || sub === 'uninstall') {
    if (asJson) throw new UsageError(`--json does not apply to lifecheck ${sub}`);
    const h = deps.installHost(stateDir);
    const r = sub === 'install' ? await installLifecheck(h, LIB_VERSION) : await uninstallLifecheck(h);
    (r.exitCode === 0 ? deps.out : deps.err)(r.lines.join('\n') + '\n');
    return r.exitCode;
  }
  if (sub === 'status') {
    const s = await lifecheckStatus(deps.installHost(stateDir));
    deps.out(asJson ? json(s) : formatStatus(s));
    return s.exitCode;
  }
  throw new UsageError(`unknown lifecheck subcommand ${JSON.stringify(sub)}`);
}

async function viewCmd(argv: readonly string[], deps: CliDeps): Promise<number> {
  const p = parseArgs(argv, { values: ['state-dir'], booleans: ['exec'] });
  const key = p.positionals[0];
  if (key === undefined || p.positionals.length !== 1) throw new UsageError('ccd view needs exactly one <sessionKey>');
  const r = await runView(deps.viewHost(stateDirOf(deps, p.values.get('state-dir'))), key, { exec: p.booleans.has('exec') });
  if (r.stdout) deps.out(r.stdout);
  if (r.stderr) deps.err(r.stderr);
  return r.exitCode;
}

async function traceCmd(argv: readonly string[], deps: CliDeps): Promise<number> {
  const p = parseArgs(argv, { values: ['golden', 'kinds', 'event'], booleans: ['json'] });
  const [sub, file, extra] = p.positionals;
  if (file === undefined || extra !== undefined) throw new UsageError('ccd trace replay|explain <file>');
  const trace = parseTrace(await deps.readFile(file));
  if (sub === 'replay') {
    if (p.values.has('event')) throw new UsageError('--event applies to trace explain');
    const goldenPath = p.values.get('golden');
    const kinds = p.values.get('kinds');
    const r = replayTrace(trace, {
      ...(kinds === undefined ? {} : { kinds: parseKinds(kinds) }),
      ...(goldenPath === undefined ? {} : { golden: await deps.readFile(goldenPath) }),
    });
    if (p.booleans.has('json')) {
      const filtered = kinds === undefined ? trace.records : trace.records.filter((x) => parseKinds(kinds).has(x.r));
      deps.out(json({ summary: r.summary, golden: r.golden, malformed: trace.malformed, records: filtered }));
    } else deps.out(r.lines.join('\n') + '\n');
    return r.exitCode;
  }
  if (sub === 'explain') {
    if (p.values.has('golden') || p.values.has('kinds')) throw new UsageError('--golden/--kinds apply to trace replay');
    const seq = intFlag(p, 'event');
    if (seq === undefined) throw new UsageError('ccd trace explain needs --event <seq>');
    const x = explainEvent(trace, seq);
    deps.out(p.booleans.has('json') ? json(x) : formatExplanation(x));
    return 0;
  }
  throw new UsageError(`unknown trace subcommand ${JSON.stringify(sub)}`);
}

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'lifecheck':
        return await lifecheckCmd(rest, deps);
      case 'view':
        return await viewCmd(rest, deps);
      case 'trace':
        return await traceCmd(rest, deps);
      case '--version':
      case 'version':
        deps.out(`claude-code-driver ${LIB_VERSION}\n`);
        return 0;
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        (cmd === undefined ? deps.err : deps.out)(USAGE);
        return cmd === undefined ? EXIT_USAGE : 0;
      default:
        throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      deps.err(`ccd: ${e.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    if (e instanceof InstallError || e instanceof ViewError || e instanceof TraceError) {
      deps.err(`ccd: ${e.message}\n`);
      return 1;
    }
    deps.err(`ccd: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 1;
  }
}

export function nodeDeps(): CliDeps {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    env: processEnv(),
    homeDir: homedir(),
    lifecheckHost: createLifecheckHost,
    installHost: createInstallHost,
    viewHost: createViewHost,
    readFile: (p) => readFile(p, 'utf8'),
  };
}

function invokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), nodeDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`ccd: ${String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
