// platform/fs-tail/discovery.ts — file discovery for the transcript tail (DESIGN.md §1.2, §5.3; transcript-tail.md §6, §8;
// transcript-format.md §1). Only directory listings and stats: no watchers (rev 2 §10 C3), no shell-outs (P-TAIL-05).
//
// Mitigations implemented here:
// - P-TAIL-26 only `<uuid>.jsonl` names count as session files; `*.superseded-*`, `*.compact.tmp.*`, `memory/` and
//   `*.meta.json` are never followed.
// - P-TAIL-27 a project-dir scan for an unknown main file is accepted only when the file's first user prompt matches the
//   text we typed (findMainByFirstPrompt); ambiguous matches are rejected.
// - P-TAIL-31 `.meta.json` is never needed to find or follow a subagent (it only exists at the finish).
// - P-TAIL-32 workflow agents live under `subagents/workflows/<wf>/`; the readdir backstop looks there too.
// - P-TAIL-33 symlinks (e.g. `tasks/<id>.output`) are never picked up by scans; the tail dedupes by realpath.
// - P-TX-05 slugs longer than 200 chars get a hash suffix: `projects/*/<uuid>.jsonl` glob fallback (locateMainBySessionId).

import { basename, dirname, join } from 'node:path';
import { errnoOf, type TailFs } from './node-fs.js';

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const AGENT_FILE_RE = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/;
/** Claude's slug truncation length (transcript-format.md §1, binary `lke=200`). */
const SLUG_MAX = 200;

/** Names that are never transcripts we follow, even when they look close (P-TAIL-26, P-TAIL-31, transcript-tail.md §5.2/§5.3). */
export function isIgnoredName(name: string): boolean {
  return (
    name === 'memory' ||
    name.includes('.superseded-') ||
    name.includes('.compact.tmp.') ||
    name.endsWith('.meta.json') ||
    name.startsWith('.')
  );
}

export function isSessionFileName(name: string): boolean {
  return SESSION_FILE_RE.test(name) && !isIgnoredName(name);
}

/** `agent-<id>.jsonl` → id, else undefined. */
export function agentIdOfFileName(name: string): string | undefined {
  if (isIgnoredName(name)) return undefined;
  return AGENT_FILE_RE.exec(name)?.[1];
}

/** `<projects>/<slug>/<sid>/subagents` for the main file `<projects>/<slug>/<sid>.jsonl`. */
export function subagentDir(mainPath: string, sessionId: string): string {
  return join(dirname(mainPath), sessionId, 'subagents');
}

/** Default subagent path (transcript-tail.md §8.2); workflow agents are found by locateSubagent. */
export function expectedSubagentPath(mainPath: string, sessionId: string, agentId: string): string {
  return join(subagentDir(mainPath, sessionId), `agent-${agentId}.jsonl`);
}

/** When the main file moved from `oldMain` to `newMain` (`/cd`, worktrees: the `<sid>/` dir moves with it, §5.3), the new
 *  location of a path under the old `<sid>/` dir; undefined when `p` is not under it. */
export function rebaseUnderSession(p: string, oldMain: string, newMain: string, sessionId: string): string | undefined {
  const oldRoot = join(dirname(oldMain), sessionId) + '/';
  if (!p.startsWith(oldRoot)) return undefined;
  return join(dirname(newMain), sessionId, p.slice(oldRoot.length));
}

async function listDir(fs: TailFs, dir: string): Promise<{ name: string; kind: string }[]> {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    const c = errnoOf(e);
    if (c === 'ENOENT' || c === 'ENOTDIR' || c === 'EACCES') return [];
    throw e;
  }
}

async function isRegularFile(fs: TailFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile;
  } catch (e) {
    const c = errnoOf(e);
    if (c === 'ENOENT' || c === 'ENOTDIR' || c === 'EACCES') return false;
    throw e;
  }
}

/** Every regular `agent-<id>.jsonl` under `subagents/` and `subagents/workflows/<wf>/` (one level). Symlinks are skipped. */
export async function scanSubagents(fs: TailFs, mainPath: string, sessionId: string): Promise<{ agentId: string; path: string }[]> {
  const root = subagentDir(mainPath, sessionId);
  const out: { agentId: string; path: string }[] = [];
  const collect = async (dir: string): Promise<void> => {
    for (const ent of await listDir(fs, dir)) {
      if (ent.kind !== 'file') continue;
      const id = agentIdOfFileName(ent.name);
      if (id !== undefined) out.push({ agentId: id, path: join(dir, ent.name) });
    }
  };
  await collect(root);
  const wfRoot = join(root, 'workflows');
  for (const ent of await listDir(fs, wfRoot)) if (ent.kind === 'dir' && !isIgnoredName(ent.name)) await collect(join(wfRoot, ent.name));
  return out;
}

/** Find one agent's file: the default path first, then `workflows/*` (P-TAIL-32). */
export async function locateSubagent(fs: TailFs, mainPath: string, sessionId: string, agentId: string): Promise<string | undefined> {
  const direct = expectedSubagentPath(mainPath, sessionId, agentId);
  if (await isRegularFile(fs, direct)) return direct;
  const wfRoot = join(subagentDir(mainPath, sessionId), 'workflows');
  const name = `agent-${agentId}.jsonl`;
  for (const ent of await listDir(fs, wfRoot)) {
    if (ent.kind !== 'dir' || isIgnoredName(ent.name)) continue;
    const p = join(wfRoot, ent.name, name);
    if (await isRegularFile(fs, p)) return p;
  }
  return undefined;
}

/** `<configDir>/projects/<slug>/<sessionId>.jsonl` for every slug dir (P-TX-05 glob fallback; also the relocation search
 *  after `/cd` when no hook has told us the new path yet). `slugPrefix` limits the dirs to those starting with it. */
export async function locateMainBySessionId(
  fs: TailFs,
  configDir: string,
  sessionId: string,
  o: { slugPrefix?: string } = {},
): Promise<string[]> {
  const projects = join(configDir, 'projects');
  const name = `${sessionId}.jsonl`;
  if (!isSessionFileName(name)) return [];
  const out: string[] = [];
  for (const ent of await listDir(fs, projects)) {
    if ((ent.kind !== 'dir' && ent.kind !== 'symlink') || isIgnoredName(ent.name)) continue;
    if (o.slugPrefix !== undefined && !ent.name.startsWith(o.slugPrefix)) continue;
    const p = join(projects, ent.name, name);
    if (await isRegularFile(fs, p)) out.push(p);
  }
  return out;
}

/** Slug-dir prefix that also matches Claude's hash-suffixed form of a long slug (`slice(0,200) + '-' + hash`). */
export function slugPrefixOf(mainPath: string): string {
  return basename(dirname(mainPath)).slice(0, SLUG_MAX);
}

function promptTextOf(entry: Record<string, unknown>): string | undefined {
  if (entry['type'] !== 'user' || entry['isMeta'] === true) return undefined;
  const msg = entry['message'];
  if (typeof msg !== 'object' || msg === null) return undefined;
  const content = (msg as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const b of content) {
    if (typeof b === 'object' && b !== null) {
      const r = b as Record<string, unknown>;
      if (r['type'] === 'text' && typeof r['text'] === 'string') texts.push(r['text']);
    }
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/** The first non-meta user prompt in the first `maxBytes` of a transcript, or undefined. */
export async function readFirstPrompt(fs: TailFs, path: string, maxBytes = 1 << 20): Promise<string | undefined> {
  let fh;
  try {
    fh = await fs.open(path);
  } catch (e) {
    const c = errnoOf(e);
    if (c === 'ENOENT' || c === 'EACCES' || c === 'ENOTDIR') return undefined;
    throw e;
  }
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    let got = 0;
    while (got < maxBytes) {
      const n = await fh.read(buf, got, maxBytes - got, got);
      if (n <= 0) break;
      got += n;
    }
    let start = 0;
    while (start < got) {
      const nl = buf.subarray(start, got).indexOf(0x0a);
      if (nl === -1) break; // incomplete last line: never parsed (P-TAIL-10)
      const line = buf.toString('utf8', start, start + nl);
      start += nl + 1;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
      const t = promptTextOf(v as Record<string, unknown>);
      if (t !== undefined) return t;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

/** P-TAIL-27: when no hook told us the path, accept a `<uuid>.jsonl` in `projectDir` only if its first user prompt equals
 *  (after trimming) the text we typed. Zero or several matches → undefined (other sessions may share the cwd). */
export async function findMainByFirstPrompt(
  fs: TailFs,
  projectDir: string,
  promptText: string,
  o: { exclude?: ReadonlySet<string>; maxBytes?: number } = {},
): Promise<{ path: string; sessionId: string } | undefined> {
  const want = promptText.trim();
  if (want === '') return undefined;
  const matches: { path: string; sessionId: string }[] = [];
  for (const ent of await listDir(fs, projectDir)) {
    if (ent.kind !== 'file' || !isSessionFileName(ent.name)) continue;
    const p = join(projectDir, ent.name);
    if (o.exclude?.has(p) === true) continue;
    const first = await readFirstPrompt(fs, p, o.maxBytes);
    if (first?.trim() === want) matches.push({ path: p, sessionId: ent.name.slice(0, -'.jsonl'.length) });
  }
  return matches.length === 1 ? matches[0] : undefined;
}
