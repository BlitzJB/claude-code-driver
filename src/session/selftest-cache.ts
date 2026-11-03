// session/selftest-cache.ts — once-per-(process, Claude version, cwdRealpath trust state, hook transport) self-test cache
// (DESIGN.md D-35, §3.1 steps 7 and 15; P-REV-23, P-HOOK-06; ICR 0001 item 4).
//
// - In memory, per library process and state dir (a WeakMap keyed on the StateStorePort instance, so independent state dirs —
//   and independent test worlds — never share entries). Two installed package copies still agree, through the disk copy,
//   whose entries carry the pid of the process that wrote them.
// - On disk: `stateDir/selftest-cache.json` (atomic JSON through the StateStorePort, 0600), 24 h TTL. The disk copy records
//   which process passed (pid) — a pass counts as `cachedPass` only for the same process (D-35: "once per library process"),
//   while an HTTP self-test failure is honoured by any process for 24 h: the `hooks.transport:'auto'` rule of §3.1 step 7
//   (`httpFailedRecently`) and the automatic unix relaunch of step 15 both read it.
// - `selfTest:'once'` caching exists for startup latency and flakiness (rev 2 §10 A12); since LP-47 a blocked self-test
//   prompt leaves no history.jsonl line, so history pollution is no longer part of the rationale (ICR 0001 item 4).

import type { StateStorePort } from '../platform/ports.js';

export const SELFTEST_CACHE_FILE = 'selftest-cache.json';
export const SELFTEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 64;

export interface SelfTestKey {
  claudeVersion: string;
  cwdRealpath: string;
  trusted: boolean;
  transport: 'http' | 'unix';
}

interface SelfTestEntry extends SelfTestKey {
  result: 'pass' | 'fail';
  step?: string;
  atWall: number;
  pid: number;
}

interface CacheFile {
  v: 1;
  entries: SelfTestEntry[];
}

function keyString(k: SelfTestKey): string {
  return `${k.claudeVersion}\u0000${k.cwdRealpath}\u0000${k.trusted ? 1 : 0}\u0000${k.transport}`;
}

const MEMORY = new WeakMap<StateStorePort, Map<string, SelfTestEntry>>();

/** The in-memory map (keyString → entry) of this process for one state store. */
function processCache(state: StateStorePort): Map<string, SelfTestEntry> {
  let m = MEMORY.get(state);
  if (m === undefined) {
    m = new Map();
    MEMORY.set(state, m);
  }
  return m;
}

function isEntry(v: unknown): v is SelfTestEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['claudeVersion'] === 'string' &&
    typeof e['cwdRealpath'] === 'string' &&
    typeof e['trusted'] === 'boolean' &&
    (e['transport'] === 'http' || e['transport'] === 'unix') &&
    (e['result'] === 'pass' || e['result'] === 'fail') &&
    typeof e['atWall'] === 'number' &&
    typeof e['pid'] === 'number'
  );
}

export interface SelfTestCache {
  /** True when this process already passed the self-test for exactly this key within the TTL. */
  cachedPass(k: SelfTestKey, nowWall: number): Promise<boolean>;
  /** True when an HTTP self-test for (version, cwd) failed within the TTL, in any process (§3.1 step 7 'auto' rule). */
  httpFailedRecently(claudeVersion: string, cwdRealpath: string, nowWall: number): Promise<boolean>;
  record(k: SelfTestKey, result: 'pass' | 'fail', nowWall: number, step?: string): Promise<void>;
  /** Drop this process's memory entries (tests). The disk file is left alone. */
  forgetProcess(): void;
}

export function createSelfTestCache(o: { state: StateStorePort; pid: number; ttlMs?: number; file?: string }): SelfTestCache {
  const ttl = o.ttlMs ?? SELFTEST_TTL_MS;
  const file = o.file ?? SELFTEST_CACHE_FILE;
  const mem = processCache(o.state);
  const fresh = (e: SelfTestEntry, now: number): boolean => now - e.atWall >= -60_000 && now - e.atWall < ttl;

  const readDisk = async (): Promise<SelfTestEntry[]> => {
    try {
      const f = await o.state.readJson<CacheFile>(file);
      if (f === undefined || typeof f !== 'object' || !Array.isArray(f.entries)) return [];
      return f.entries.filter(isEntry);
    } catch {
      return []; // a corrupt cache only costs one self-test
    }
  };

  return {
    async cachedPass(k, nowWall) {
      const m = mem.get(keyString(k));
      if (m?.pid === o.pid && m.result === 'pass' && fresh(m, nowWall)) return true;
      const disk = await readDisk();
      const ks = keyString(k);
      return disk.some((e) => keyString(e) === ks && e.pid === o.pid && e.result === 'pass' && fresh(e, nowWall));
    },
    async httpFailedRecently(claudeVersion, cwdRealpath, nowWall) {
      const match = (e: SelfTestEntry): boolean =>
        e.transport === 'http' &&
        e.result === 'fail' &&
        e.claudeVersion === claudeVersion &&
        e.cwdRealpath === cwdRealpath &&
        fresh(e, nowWall);
      for (const e of mem.values()) if (match(e)) return true;
      return (await readDisk()).some(match);
    },
    async record(k, result, nowWall, step) {
      const entry: SelfTestEntry = { ...k, result, atWall: nowWall, pid: o.pid };
      if (step !== undefined) entry.step = step;
      mem.set(keyString(k), entry);
      const ks = keyString(k);
      const kept = (await readDisk()).filter((e) => keyString(e) !== ks && fresh(e, nowWall));
      kept.push(entry);
      const out: CacheFile = { v: 1, entries: kept.slice(-MAX_ENTRIES) };
      await o.state.writeJsonAtomic(file, out);
    },
    forgetProcess() {
      for (const [k, e] of mem) if (e.pid === o.pid) mem.delete(k);
    },
  };
}

/** Convenience for the launcher's 'auto' transport rule (§3.1 step 7), so it does not need to know the file format. */
export function httpSelfTestFailedRecently(
  state: StateStorePort,
  claudeVersion: string,
  cwdRealpath: string,
  nowWall: number,
  pid: number,
): Promise<boolean> {
  return createSelfTestCache({ state, pid }).httpFailedRecently(claudeVersion, cwdRealpath, nowWall);
}
