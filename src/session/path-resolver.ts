// session/path-resolver.ts — executes `permission.resolvePaths` intents (realpath, lstat) → `permission.pathsResolved`
// (DESIGN.md §3.7 step 1 `allowRead`, rev 2 §10 G3, P-REV-30; SEC §4.1 "realpath and refuse symlinks out of the workspace").
//
// The core cannot touch the filesystem (D-03), so it asks L3. Rules (§3.7 step 1), evaluated per argument:
//   - Known path arguments: Read.file_path, NotebookRead.notebook_path, Glob.path, Grep.path (filesystem paths) and
//     Glob.pattern, Grep.glob (glob patterns). Any other key whose value is (or contains) a string with '/' → `unknownArg`.
//   - A filesystem path is realpath'd. ENOENT/ENOTDIR → realpath of the deepest existing ancestor + the rest, and the rest
//     must not contain `..` (`parentSegment`). The result must be `cwdRealpath` or below it (`outside`). Every existing
//     component that lives inside the workspace must not be a symlink that resolves outside it (`symlinkOut`).
//     A leading `~` is never expanded here (`tilde`); a relative path is resolved against `cwdRealpath`.
//   - A missing Glob/Grep `path` means the cwd (inside). A missing Read `file_path` is not a readable request → `unknownArg`.
//   - Patterns must be relative: no leading `/` or `~`, also not inside a brace alternative (`absolutePattern`/`tilde`), and no
//     `..` segment (`parentSegment`). Checked on every brace expansion, after backslash escapes, per list item, with a
//     leading `!` stripped, so `.{.,}/x` (→ `../x`), `{\/etc/*,x}` and `*.ts /etc/*` cannot slip past a lexical scan.
// Lexical checks alone are never used for a filesystem path. The result list is never empty, so the core's "all inside"
// can only be true for an explicit verdict.

import { posix as path } from 'node:path';
import type { Intent } from '../model/intents.js';
import type { Logger } from '../model/logger.js';
import type { ResolvedPath } from '../model/observation.js';
import type { Clock } from '../model/time.js';
import type { EnvPort } from '../platform/ports.js';
import type { ObservationSink } from './input-executor.js';

type ResolvePathsIntent = Extract<Intent, { kind: 'permission.resolvePaths' }>;

type Fs = Pick<EnvPort, 'realpath' | 'lstat'>;

/** Tool → its filesystem-path keys and its glob-pattern keys. `required` keys must be present. */
const TOOL_ARGS: Readonly<Record<string, { paths: readonly string[]; patterns: readonly string[]; required: readonly string[] }>> = {
  Read: { paths: ['file_path'], patterns: [], required: ['file_path'] },
  NotebookRead: { paths: ['notebook_path'], patterns: [], required: ['notebook_path'] },
  Glob: { paths: ['path'], patterns: ['pattern'], required: ['pattern'] },
  Grep: { paths: ['path'], patterns: ['glob'], required: [] },
};

/** Keys whose absence means "the cwd" (§3.7 step 1). */
const DEFAULTS_TO_CWD: ReadonlySet<string> = new Set(['path']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

/** `p` is `root` or below it (both absolute, normalized). */
export function isInside(p: string, root: string): boolean {
  if (p === root) return true;
  const base = root.endsWith('/') ? root : `${root}/`;
  return p.startsWith(base);
}

function containsSlashString(v: unknown, depth = 0): boolean {
  if (depth > 8) return true; // pathological nesting: treat as path-like (conservative)
  if (typeof v === 'string') return v.includes('/');
  if (Array.isArray(v)) return v.some((x) => containsSlashString(x, depth + 1));
  if (isRecord(v)) return Object.values(v).some((x) => containsSlashString(x, depth + 1));
  return false;
}

/** Brace expansions examined per pattern; a pattern that expands to more is refused (`unknownArg`), never truncated. */
export const MAX_PATTERN_EXPANSIONS = 256;
const MAX_PATTERN_CHARS = 4096;

/** Index of the `}` closing the `{` at `open` (backslash escapes and nesting respected), or -1. */
function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Split the inside of a brace group on its top-level commas. */
function braceAlternatives(inner: string): string[] {
  const alts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0) {
      alts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  alts.push(inner.slice(start));
  return alts;
}

/**
 * Every brace expansion of `s` (`a{b,c}d` → `abd`, `acd`; nested groups too). A group without a comma (`{..}`) is expanded
 * to its content as well: some matchers keep it literal, but the check must assume the dangerous reading. Returns
 * undefined when the expansion would exceed `MAX_PATTERN_EXPANSIONS`.
 */
export function expandBraces(s: string): string[] | undefined {
  const out: string[] = [];
  const work: string[] = [s];
  let steps = 0;
  while (work.length > 0) {
    if (++steps > MAX_PATTERN_EXPANSIONS * 8) return undefined;
    const cur = work.pop();
    if (cur === undefined) break;
    let open = -1;
    let close = -1;
    for (let i = 0; i < cur.length; i++) {
      const c = cur[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') {
        const j = closingBrace(cur, i);
        if (j !== -1) {
          open = i;
          close = j;
          break;
        }
      }
    }
    if (open === -1) {
      out.push(cur);
      if (out.length > MAX_PATTERN_EXPANSIONS) return undefined;
      continue;
    }
    const head = cur.slice(0, open);
    const tail = cur.slice(close + 1);
    const alts = braceAlternatives(cur.slice(open + 1, close));
    for (let k = alts.length - 1; k >= 0; k--) work.push(`${head}${alts[k] ?? ''}${tail}`);
    if (work.length > MAX_PATTERN_EXPANSIONS * 4) return undefined;
  }
  return out;
}

/**
 * Pattern rules (Glob.pattern, Grep.glob; §3.7 step 1). Pure; exported for tests. Every brace alternative is checked after
 * removing backslash escapes (`\/etc` is `/etc`), and every whitespace/comma separated item of it (a Grep `glob` may be a
 * list), with a leading `!` negation stripped: none may start with `/` (`absolutePattern`) or `~` (`tilde`) or contain a
 * `..` segment (`parentSegment`). So `{/etc/*,x}`, `.{.,}/x` (→ `../x`) and `*.ts /etc/*` are refused.
 */
export function checkPattern(arg: string, raw: string): ResolvedPath {
  const out = (inside: boolean, reason?: ResolvedPath['reason']): ResolvedPath =>
    reason === undefined ? { arg, raw, inside } : { arg, raw, inside, reason };
  if (raw.includes('\u0000') || raw.length > MAX_PATTERN_CHARS) return out(false, 'unknownArg');
  // Conservative extra: a brace alternative that itself starts with `/` or `~` (`x{,~/y}`) is refused even where its
  // expansion would be relative; a matcher that expands `~` per alternative would otherwise leave the workspace.
  if (/[{,]\s*\\?\//u.test(raw)) return out(false, 'absolutePattern');
  if (/[{,]\s*\\?~/u.test(raw)) return out(false, 'tilde');
  const expansions = expandBraces(raw);
  if (expansions === undefined) return out(false, 'unknownArg');
  for (const e of expansions) {
    const plain = e.replace(/\\(.)/gsu, '$1');
    for (const item of plain.split(/[\s,]+/u)) {
      const t = item.replace(/^!+/u, '');
      if (t === '') continue;
      if (t.startsWith('/')) return out(false, 'absolutePattern');
      if (t.startsWith('~')) return out(false, 'tilde');
      if (t.split('/').some((seg) => seg === '..')) return out(false, 'parentSegment');
    }
  }
  return out(true);
}

/** Resolve one filesystem path argument against the workspace. Never throws. */
export async function resolveFsPath(fs: Fs, cwdRealpath: string, arg: string, raw: string): Promise<ResolvedPath> {
  const out = (inside: boolean, reason?: ResolvedPath['reason'], real?: string): ResolvedPath => {
    const r: ResolvedPath = { arg, raw, inside };
    if (real !== undefined) r.real = real;
    if (reason !== undefined) r.reason = reason;
    return r;
  };
  if (raw === '' || raw.includes('\u0000')) return out(false, 'unknownArg');
  if (raw.startsWith('~')) return out(false, 'tilde');
  const abs = raw.startsWith('/') ? raw : `${cwdRealpath.replace(/\/+$/u, '')}/${raw}`;
  const parts = abs.split('/').filter((s) => s !== '' && s !== '.');

  // 1. Find the deepest existing prefix (realpath succeeds); the rest must not climb.
  let real: string | undefined;
  let existing = parts.length;
  for (; existing >= 0; existing--) {
    const prefix = `/${parts.slice(0, existing).join('/')}`;
    try {
      real = await fs.realpath(prefix);
      break;
    } catch (e) {
      const c = errCode(e);
      if (c !== 'ENOENT' && c !== 'ENOTDIR') return out(false, 'enoent');
    }
  }
  if (real === undefined) return out(false, 'enoent');
  const rest = parts.slice(existing);
  if (rest.includes('..')) return out(false, 'parentSegment');
  const full = rest.length === 0 ? real : path.join(real, ...rest);

  // 2. Every existing component inside the workspace must not be a symlink that leads out of it.
  for (let i = 1; i <= existing; i++) {
    const prefix = `/${parts.slice(0, i).join('/')}`;
    let st: Awaited<ReturnType<Fs['lstat']>>;
    try {
      st = await fs.lstat(prefix);
    } catch {
      return out(false, 'enoent', full);
    }
    if (st?.isSymlink !== true) continue;
    let parentReal: string;
    let targetReal: string;
    try {
      parentReal = await fs.realpath(`/${parts.slice(0, i - 1).join('/')}`);
      targetReal = await fs.realpath(prefix);
    } catch {
      return out(false, 'enoent', full);
    }
    // A symlink that lives in the workspace (its directory resolves inside) must resolve inside too. Symlinks above the
    // workspace (e.g. macOS /var → /private/var) are covered by the final containment check.
    if (isInside(parentReal, cwdRealpath) && !isInside(targetReal, cwdRealpath)) return out(false, 'symlinkOut', full);
  }

  // 3. Containment.
  return isInside(full, cwdRealpath) ? out(true, undefined, full) : out(false, 'outside', full);
}

/** Evaluate every argument of one read-tool request (§3.7 step 1). Never throws; never returns an empty list. */
export async function resolveToolPaths(fs: Fs, cwdRealpath: string, toolName: string, input: unknown): Promise<ResolvedPath[]> {
  const spec = TOOL_ARGS[toolName];
  if (spec === undefined) return [{ arg: 'tool', raw: toolName, inside: false, reason: 'unknownArg' }];
  if (!isRecord(input)) return [{ arg: 'input', raw: typeof input, inside: false, reason: 'unknownArg' }];
  const res: ResolvedPath[] = [];
  const known = new Set([...spec.paths, ...spec.patterns]);
  for (const key of spec.paths) {
    const v = input[key];
    if (v === undefined || v === null) {
      if (spec.required.includes(key)) res.push({ arg: key, raw: '', inside: false, reason: 'unknownArg' });
      else if (DEFAULTS_TO_CWD.has(key)) res.push({ arg: key, raw: '', real: cwdRealpath, inside: true });
      continue;
    }
    if (typeof v !== 'string') {
      res.push({ arg: key, raw: typeof v, inside: false, reason: 'unknownArg' });
      continue;
    }
    if (v === '' && DEFAULTS_TO_CWD.has(key)) {
      res.push({ arg: key, raw: '', real: cwdRealpath, inside: true });
      continue;
    }
    res.push(await resolveFsPath(fs, cwdRealpath, key, v));
  }
  for (const key of spec.patterns) {
    const v = input[key];
    if (v === undefined || v === null) {
      if (spec.required.includes(key)) res.push({ arg: key, raw: '', inside: false, reason: 'unknownArg' });
      continue;
    }
    if (typeof v !== 'string') {
      res.push({ arg: key, raw: typeof v, inside: false, reason: 'unknownArg' });
      continue;
    }
    res.push(checkPattern(key, v));
  }
  for (const [key, v] of Object.entries(input)) {
    if (known.has(key)) continue;
    if (containsSlashString(v)) res.push({ arg: key, raw: typeof v === 'string' ? v : typeof v, inside: false, reason: 'unknownArg' });
  }
  if (res.length === 0) res.push({ arg: 'path', raw: '', real: cwdRealpath, inside: true });
  return res;
}

export interface PathResolverOptions {
  clock: Clock;
  fs: Fs;
  /** ResolvedConfig.cwdRealpath (the workspace root every path must stay under). */
  cwdRealpath: string;
  emit: ObservationSink;
  logger?: Logger;
}

export interface PathResolver {
  /** Resolve and emit `permission.pathsResolved`. Resolves after the emit. Never rejects. */
  execute(intent: ResolvePathsIntent): Promise<void>;
  close(): void;
}

export function createPathResolver(o: PathResolverOptions): PathResolver {
  let closed = false;
  const isClosed = (): boolean => closed;
  return {
    async execute(intent: ResolvePathsIntent): Promise<void> {
      if (closed) return;
      let paths: ResolvedPath[];
      try {
        paths = await resolveToolPaths(o.fs, o.cwdRealpath, intent.toolName, intent.input);
      } catch {
        paths = [{ arg: 'input', raw: '', inside: false, reason: 'enoent' }];
      }
      if (isClosed()) return;
      const outside = paths.filter((p) => !p.inside).map((p) => `${p.arg}:${p.reason ?? '?'}`);
      if (outside.length > 0)
        o.logger?.debug('path-resolver: not inside', { permissionKey: intent.permissionKey, toolName: intent.toolName, outside });
      o.emit({
        kind: 'permission.pathsResolved',
        meta: { at: o.clock.now(), wallAt: o.clock.wallNow(), source: 'self', origin: { kind: 'self', intentId: intent.id } },
        p: { permissionKey: intent.permissionKey, cwdRealpath: o.cwdRealpath, paths },
      });
    },
    close(): void {
      closed = true;
    },
  };
}
