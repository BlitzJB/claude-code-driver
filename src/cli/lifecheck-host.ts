// cli/lifecheck-host.ts — the real LifecheckHost: `session/reaper.ts` + `session/registry-store.ts` over the L0 ports built by
// `runtime/node.ts createNodePorts()` (DESIGN.md §3.12; §1.3 cli row; rev 2 §10 G19). No kernel, no keys, no hook port.
//
// The reaper is the single source of truth for classification (`classifySession`) and for reaping (`reap`, which takes the
// registry lock itself). This module adapts its records to the cli's `SessionRecord` and its report to `ReapPassResult`.

import { readFile } from 'node:fs/promises';
import { createNodePorts } from '../runtime/node.js';

import type { SessionKey } from '../model/ids.js';
import type { WallMs } from '../model/time.js';
import { LIB_VERSION } from '../model/version.js';
import type { LifecheckHost, ReapPassResult, SessionRecord } from './host.js';
import { parseSessionRecord } from './host.js';
import { ownDistPath } from './node-host.js';
import { classifySession, isOwnerAlive, reap, type ReaperDeps } from '../session/reaper.js';
import { RegistryStore, type SessionRecord as StoredRecord } from '../session/registry-store.js';

/** The L0 ports the lifecheck needs (a subset of `Ports`, spelled through the session modules' own parameter types). */
export type LifecheckPorts = Omit<ReaperDeps, 'store'> & { state: ConstructorParameters<typeof RegistryStore>[0] };

export interface LifecheckHostOptions {
  libVersion?: string;
  distPath?: string;
  /** The caller's own pid: never reaped (the reaper's `selfPid`). */
  selfPid?: number;
  log?: (line: string) => void;
  /** Reads a state-dir file as text (the state port has no text read). Default: node:fs under `state.root`. */
  readStateText?: (rel: string) => Promise<string | undefined>;
  /** Reaper socket-probe gap (default 5 s; tests shorten it). */
  socketProbeGapMs?: number;
}

const KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function createLifecheckHostFromPorts(ports: LifecheckPorts, o: LifecheckHostOptions = {}): LifecheckHost {
  const now = (): WallMs => ports.clock.wallNow();
  const store = new RegistryStore(ports.state, now);
  const deps: ReaperDeps = { ...ports, store };
  const stored = new Map<string, StoredRecord>();
  const readStateText =
    o.readStateText ??
    (async (rel: string): Promise<string | undefined> => {
      try {
        return await readFile(`${ports.state.root}/${rel}`, 'utf8');
      } catch {
        return undefined;
      }
    });

  return {
    stateDir: ports.state.root,
    libVersion: o.libVersion ?? LIB_VERSION,
    distPath: o.distPath ?? ownDistPath(),
    nowWall: now,
    listSessions: async () => {
      stored.clear();
      const out: SessionRecord[] = [];
      for (const r of await store.listSessions()) {
        const p = parseSessionRecord(r.sessionKey, r);
        if (!('record' in p)) continue; // listSessions already dropped malformed files; a v2 record always parses
        stored.set(r.sessionKey, r);
        out.push(p.record);
      }
      return out;
    },
    classify: async (rec) => {
      const r = stored.get(rec.key);
      if (r === undefined) throw new Error(`session ${rec.key} was not listed`);
      const classification = await classifySession(deps, r, now());
      if (classification !== 'owned-alive' && classification !== 'owned-hung') return { classification };
      const owner = await store.readOwner(r.owner.pid);
      // An owners/ file of another process instance (pid reuse) is not this owner's heartbeat.
      if (owner?.startTime !== r.owner.startTime) return { classification };
      return { classification, heartbeatAt: owner.heartbeatAt };
    },
    readExits: async (key) => {
      if (!KEY.test(key)) return [];
      const t = await readStateText(`exits/${key}.log`);
      return t === undefined
        ? []
        : t
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '');
    },
    reapPass: async (): Promise<ReapPassResult> => {
      const ro: Parameters<typeof reap>[1] = { reapedBy: 'lifecheck', selfPid: o.selfPid ?? process.pid };
      if (o.socketProbeGapMs !== undefined) ro.socketProbeGapMs = o.socketProbeGapMs;
      const r = await reap(deps, ro);
      return {
        reaped: r.reaped.map((x) => ({
          key: x.sessionKey,
          claude: x.claude,
          server: x.server,
          socketUnlinked: x.socketUnlinked,
          sessionDirRemoved: x.sessionDirRemoved,
          trustUnseeded: x.trustUnseeded,
        })),
        skippedLive: r.skippedLive.map(String),
        socketsUnlinked: r.sockets.unlinked,
        unknownCctSockets: r.sockets.unknownCctSockets,
        sweptDirs: r.sweptDirs,
        prunedArchive: r.prunedArchive.map((k: SessionKey) => String(k)),
        ownersRemoved: r.ownersRemoved,
        errors: r.errors,
      };
    },
    signalOwnerDiagnostics: async (owner) => {
      if (!(await isOwnerAlive(ports.process, owner))) return false;
      return ports.process.kill(owner.pid, 'SIGUSR2');
    },
    writeLifecheckJson: (report) => ports.state.writeJsonAtomic('lifecheck.json', report),
    log: o.log ?? ((line) => process.stderr.write(`${line}\n`)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Loading the node composition root.
//
// `runtime/node.ts` is WP-INT's composition root (§8). The ports are built only when a lifecheck runs, so `ccd view|trace|
// lifecheck status` never build L0 ports; the returned object is shape-checked and must be rooted at the requested state dir
// (a lifecheck must never reap the wrong registry). WP-INT replaced the earlier lazy import (docs/icr/0016-wp-int.md).

const isFn = (o: unknown, k: string): boolean =>
  typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>)[k] === 'function';

export function assertLifecheckPorts(v: unknown, stateDir: string): asserts v is LifecheckPorts {
  const o = v as Record<string, unknown> | null;
  const problems: string[] = [];
  if (typeof o !== 'object' || o === null) throw new Error('createNodePorts() returned no object');
  for (const k of ['isAlive', 'kill', 'identity', 'exec']) if (!isFn(o['process'], k)) problems.push(`process.${k}`);
  for (const k of ['wallNow', 'now', 'sleep']) if (!isFn(o['clock'], k)) problems.push(`clock.${k}`);
  for (const k of ['snapshot', 'homeDir', 'uid', 'lstat']) if (!isFn(o['env'], k)) problems.push(`env.${k}`);
  for (const k of ['removeSessionDir', 'sweepStale']) if (!isFn(o['runtimeDir'], k)) problems.push(`runtimeDir.${k}`);
  if (!isFn(o['claudeConfig'], 'unseedTrust')) problems.push('claudeConfig.unseedTrust');
  for (const k of ['warn', 'info']) if (!isFn(o['logger'], k)) problems.push(`logger.${k}`);
  for (const k of ['writeJsonAtomic', 'readJson', 'list', 'remove', 'appendLine', 'withLock'])
    if (!isFn(o['state'], k)) problems.push(`state.${k}`);
  if (problems.length > 0) throw new Error(`createNodePorts() is missing ${problems.join(', ')}`);
  const root = (o['state'] as { root?: unknown }).root;
  if (root !== stateDir)
    throw new Error(`createNodePorts() state root ${JSON.stringify(root)} is not the requested ${JSON.stringify(stateDir)}`);
}

function loadNodePorts(stateDir: string): Promise<LifecheckPorts> {
  const ports: unknown = createNodePorts({ stateDir });
  assertLifecheckPorts(ports, stateDir);
  return Promise.resolve(ports);
}

export async function createLifecheckHost(stateDir: string): Promise<LifecheckHost> {
  return createLifecheckHostFromPorts(await loadNodePorts(stateDir));
}
