// platform/registry/claude-registry.ts — read-only view of Claude's own registry `<configDir>/sessions/<pid>.json`
// (DESIGN.md §2.7.8, D-23, P-PRIOR-04). Lenient: the first complete JSON object wins (torn/concatenated files, #96438);
// unknown fields are ignored; wrong-typed fields are dropped. Only `<digits>.json` names are ever opened, so `*.key`
// credential files (#100824) are never read. Symlinks are not followed. `scan()` keeps only records whose pid is alive.
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeRegistryReader, ClaudeRegistryRecord, EnvPort } from '../ports.js';
import { isPidAlive } from '../process/process-port.js';
import { isNoEnt } from '../runtime-dir/dir-checks.js';
import { firstJsonObject } from '../settings/lenient-json.js';
import { claudePaths } from '../settings/paths.js';

const RECORD_NAME = /^(\d{1,10})\.json$/;
const MAX_RECORD_BYTES = 256 * 1024;

export interface ClaudeRegistryOptions {
  env: Pick<EnvPort, 'snapshot' | 'homeDir'>;
  /** Override `<configDir>/sessions` (tests). */
  sessionsDir?: string;
  isAlive?: (pid: number) => boolean;
}

/** Map a parsed registry object to the typed record; the file-name pid is the fallback for a missing `pid`. */
export function toRegistryRecord(v: Record<string, unknown>, filePid: number): ClaudeRegistryRecord | undefined {
  const pidRaw = v['pid'];
  const pid = typeof pidRaw === 'number' && Number.isInteger(pidRaw) && pidRaw > 0 ? pidRaw : filePid;
  if (pid !== filePid) return undefined; // a record that names another pid than its file is not trustworthy
  const rec: ClaudeRegistryRecord = { pid };
  const str = (k: string): string | undefined => {
    const x = v[k];
    return typeof x === 'string' ? x : undefined;
  };
  const sessionId = str('sessionId');
  const version = str('version');
  const status = str('status');
  const waitingFor = str('waitingFor');
  const tmux = str('tmux');
  const ps = v['procStart'];
  if (sessionId !== undefined) rec.sessionId = sessionId;
  if (version !== undefined) rec.version = version;
  if (status !== undefined) rec.status = status;
  if (waitingFor !== undefined) rec.waitingFor = waitingFor;
  if (tmux !== undefined) rec.tmux = tmux;
  if (typeof ps === 'string') rec.procStart = ps;
  else if (typeof ps === 'number' && Number.isFinite(ps)) rec.procStart = String(ps);
  return rec;
}

export function createClaudeRegistryReader(o: ClaudeRegistryOptions): ClaudeRegistryReader {
  const dir = (): string => o.sessionsDir ?? join(claudePaths(o.env.snapshot(), o.env.homeDir()).configDir, 'sessions');
  const isAlive = o.isAlive ?? isPidAlive;

  const readOne = async (pid: number): Promise<ClaudeRegistryRecord | undefined> => {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    let text: string;
    try {
      const fh = await open(join(dir(), `${pid}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const buf = Buffer.alloc(MAX_RECORD_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MAX_RECORD_BYTES, 0);
        text = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      return undefined; // ENOENT (not written yet), ELOOP (symlink), EACCES: lenient
    }
    const obj = firstJsonObject(text);
    return obj === undefined ? undefined : toRegistryRecord(obj, pid);
  };

  return {
    read: readOne,
    async scan() {
      let names: string[];
      try {
        names = await readdir(dir());
      } catch (e) {
        if (isNoEnt(e)) return [];
        throw e;
      }
      const out: ClaudeRegistryRecord[] = [];
      for (const name of names.sort()) {
        const m = RECORD_NAME.exec(name);
        if (m?.[1] === undefined) continue;
        const pid = Number(m[1]);
        if (!isAlive(pid)) continue;
        const rec = await readOne(pid);
        if (rec !== undefined) out.push(rec);
      }
      return out;
    },
  };
}
