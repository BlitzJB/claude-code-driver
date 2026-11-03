// WP-13 session/path-resolver.ts (DESIGN.md §3.7 step 1, rev 2 §10 G3, P-REV-30; SEC §4.1). Real filesystem in a temp dir
// (§6.1 unit project: "path-resolver with a temp dir"): inside, outside, symlink out, ENOENT ancestor, `../**`, `/abs/**`,
// `~`, unknown arg.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IntentId, PermissionKey } from '../../../src/model/ids.js';
import type { ObservationInput } from '../../../src/model/observation.js';
import { FakeClock } from '../../../src/platform/clock/fake-clock.js';
import { createEnvPort } from '../../../src/platform/env/env-port.js';
import {
  checkPattern,
  createPathResolver,
  expandBraces,
  isInside,
  MAX_PATTERN_EXPANSIONS,
  resolveFsPath,
  resolveToolPaths,
} from '../../../src/session/path-resolver.js';

const fs = createEnvPort();
let root: string; // realpath'd temp root
let ws: string; // the workspace (cwdRealpath)
let outside: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-pr-')));
  ws = join(root, 'ws');
  outside = join(root, 'outside');
  mkdirSync(join(ws, 'src', 'deep'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(ws, 'src', 'a.ts'), 'x');
  writeFileSync(join(outside, 'secret.txt'), 's');
  symlinkSync(outside, join(ws, 'link-out')); // workspace symlink → outside
  symlinkSync(join(ws, 'src'), join(ws, 'link-in')); // workspace symlink → inside
  symlinkSync(join(outside, 'secret.txt'), join(ws, 'file-link-out'));
  symlinkSync(ws, join(outside, 'into-ws')); // a symlink outside the workspace that points in
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveFsPath', () => {
  it('a file inside the workspace is inside, with its realpath', async () => {
    const r = await resolveFsPath(fs, ws, 'file_path', join(ws, 'src', 'a.ts'));
    expect(r).toEqual({ arg: 'file_path', raw: join(ws, 'src', 'a.ts'), real: join(ws, 'src', 'a.ts'), inside: true });
  });

  it('the workspace root itself is inside', async () => {
    expect((await resolveFsPath(fs, ws, 'path', ws)).inside).toBe(true);
  });

  it('a file outside is outside', async () => {
    const r = await resolveFsPath(fs, ws, 'file_path', join(outside, 'secret.txt'));
    expect(r).toMatchObject({ inside: false, reason: 'outside' });
  });

  it('a sibling directory whose name extends the workspace name is outside (no string-prefix bug)', async () => {
    mkdirSync(`${ws}-evil`, { recursive: true });
    const r = await resolveFsPath(fs, ws, 'path', `${ws}-evil`);
    expect(r).toMatchObject({ inside: false, reason: 'outside' });
  });

  it('a workspace symlink to a directory outside is symlinkOut, also for a missing file under it', async () => {
    expect(await resolveFsPath(fs, ws, 'file_path', join(ws, 'link-out', 'secret.txt'))).toMatchObject({ inside: false });
    const r = await resolveFsPath(fs, ws, 'file_path', join(ws, 'link-out', 'nope.txt'));
    expect(r.inside).toBe(false);
    expect(['symlinkOut', 'outside']).toContain(r.reason);
  });

  it('a workspace file symlink pointing outside is not inside', async () => {
    const r = await resolveFsPath(fs, ws, 'file_path', join(ws, 'file-link-out'));
    expect(r.inside).toBe(false);
  });

  it('a symlink that leads out and `..` back in is symlinkOut (every component is checked)', async () => {
    const p = join(ws, 'link-out') + '/../ws/src/a.ts';
    const r = await resolveFsPath(fs, ws, 'file_path', p);
    expect(r).toMatchObject({ inside: false, reason: 'symlinkOut' });
  });

  it('a workspace symlink to inside is inside', async () => {
    const r = await resolveFsPath(fs, ws, 'file_path', join(ws, 'link-in', 'a.ts'));
    expect(r).toMatchObject({ inside: true, real: join(ws, 'src', 'a.ts') });
  });

  it('a symlink above/outside the workspace that resolves into it is inside (only the final real path counts)', async () => {
    const r = await resolveFsPath(fs, ws, 'file_path', join(outside, 'into-ws', 'src', 'a.ts'));
    expect(r).toMatchObject({ inside: true, real: join(ws, 'src', 'a.ts') });
  });

  it('ENOENT → realpath of the deepest existing ancestor + rest', async () => {
    const r = await resolveFsPath(fs, ws, 'file_path', join(ws, 'src', 'new', 'dir', 'file.ts'));
    expect(r).toMatchObject({ inside: true, real: join(ws, 'src', 'new', 'dir', 'file.ts') });
  });

  it('ENOENT rest must not contain `..`', async () => {
    const r = await resolveFsPath(fs, ws, 'file_path', `${ws}/nope/../../outside/secret.txt`);
    expect(r).toMatchObject({ inside: false, reason: 'parentSegment' });
  });

  it('`..` through existing directories is resolved by realpath, not lexically', async () => {
    expect((await resolveFsPath(fs, ws, 'file_path', `${ws}/src/deep/../a.ts`)).inside).toBe(true);
    expect(await resolveFsPath(fs, ws, 'file_path', `${ws}/../outside/secret.txt`)).toMatchObject({ inside: false, reason: 'outside' });
  });

  it('`~` is never expanded; empty and NUL are unknownArg', async () => {
    expect(await resolveFsPath(fs, ws, 'file_path', '~/.ssh/id_rsa')).toMatchObject({ inside: false, reason: 'tilde' });
    expect(await resolveFsPath(fs, ws, 'file_path', '')).toMatchObject({ inside: false, reason: 'unknownArg' });
    expect(await resolveFsPath(fs, ws, 'file_path', `${ws}/a\u0000b`)).toMatchObject({ inside: false, reason: 'unknownArg' });
  });

  it('a relative path is resolved against the workspace', async () => {
    expect(await resolveFsPath(fs, ws, 'path', 'src')).toMatchObject({ inside: true, real: join(ws, 'src') });
    expect(await resolveFsPath(fs, ws, 'path', '../outside')).toMatchObject({ inside: false, reason: 'outside' });
  });

  it('an unreadable realpath error other than ENOENT is enoent (not inside)', async () => {
    const failing = {
      realpath: (): Promise<string> => Promise.reject(Object.assign(new Error('loop'), { code: 'ELOOP' })),
      lstat: () => Promise.resolve(undefined),
    };
    expect(await resolveFsPath(failing, ws, 'path', `${ws}/x`)).toMatchObject({ inside: false, reason: 'enoent' });
  });
});

describe('checkPattern (Glob.pattern, Grep.glob)', () => {
  const ok = ['**/*.ts', 'src/**', '*.{ts,tsx}', 'a..b/*.md', '.github/**'];
  for (const p of ok)
    it(`${p} is inside`, () => {
      expect(checkPattern('pattern', p).inside).toBe(true);
    });
  const bad: [string, string][] = [
    ['/etc/**', 'absolutePattern'],
    ['  /etc/*', 'absolutePattern'],
    ['{/etc/*,x}', 'absolutePattern'],
    ['~/**', 'tilde'],
    ['x{,~/y}', 'tilde'],
    ['../**', 'parentSegment'],
    ['src/../../x', 'parentSegment'],
    ['{..,x}/y', 'parentSegment'],
    ['a/{x,..}', 'parentSegment'],
    ['..', 'parentSegment'],
    ['\\/etc', 'absolutePattern'],
  ];
  for (const [p, reason] of bad)
    it(`${p} → ${reason}`, () => {
      expect(checkPattern('glob', p)).toMatchObject({ inside: false, reason });
    });
});

describe('checkPattern: brace / escape / list bypasses (a lexical scan of the raw string is not enough)', () => {
  const bad: [string, string][] = [
    ['.{.,}/secret', 'parentSegment'], // expands to ../secret
    ['{.,.}./**', 'parentSegment'], // expands to ../**
    ['x/.{.}/y', 'parentSegment'], // a comma-less group is assumed to expand too
    ['{a,{b,..}}/z', 'parentSegment'], // nested group
    ['{\\/etc/*,x}', 'absolutePattern'], // escaped slash at the start of an alternative
    ['\\~/x', 'tilde'],
    ['*.ts /etc/*', 'absolutePattern'], // whitespace-separated list item
    ['*.ts,/etc/*', 'absolutePattern'], // comma-separated list item
    ['*.ts ../x', 'parentSegment'],
    ['!../x', 'parentSegment'], // negation does not hide a parent segment
    ['!/etc/x', 'absolutePattern'],
  ];
  for (const [p, reason] of bad)
    it(`${p} → ${reason}`, () => {
      expect(checkPattern('glob', p)).toMatchObject({ inside: false, reason });
    });

  it('a pattern that expands past the limit is refused, not truncated', () => {
    const p = '{a,b}'.repeat(9); // 512 expansions
    expect(checkPattern('pattern', p)).toMatchObject({ inside: false, reason: 'unknownArg' });
    expect(expandBraces('{a,b}'.repeat(8))).toHaveLength(MAX_PATTERN_EXPANSIONS);
  });

  it('expandBraces: alternatives, nesting, escapes and unmatched braces', () => {
    expect(expandBraces('*.{ts,tsx}')).toEqual(['*.ts', '*.tsx']);
    expect(expandBraces('a{b,{c,d}}e')).toEqual(['abe', 'ace', 'ade']);
    expect(expandBraces('a\\{b,c}')).toEqual(['a\\{b,c}']);
    expect(expandBraces('a{b')).toEqual(['a{b']);
    expect(expandBraces('}{')).toEqual(['}{']);
  });

  it('ordinary patterns with braces, dots and negation stay inside', () => {
    for (const p of ['src/**/*.{ts,tsx}', '!**/node_modules/**', '...', 'a.../b', '{src,test}/**/*.ts', '*.{js,mjs} *.ts'])
      expect(checkPattern('glob', p).inside).toBe(true);
  });
});

describe('resolveToolPaths', () => {
  it('Read inside → one inside entry', async () => {
    const r = await resolveToolPaths(fs, ws, 'Read', { file_path: join(ws, 'src', 'a.ts'), offset: 1, limit: 20 });
    expect(r).toEqual([{ arg: 'file_path', raw: join(ws, 'src', 'a.ts'), real: join(ws, 'src', 'a.ts'), inside: true }]);
  });

  it('Read without file_path is unknownArg (never an empty, all-inside list)', async () => {
    expect(await resolveToolPaths(fs, ws, 'Read', {})).toEqual([{ arg: 'file_path', raw: '', inside: false, reason: 'unknownArg' }]);
  });

  it('Glob with no path means the cwd; the pattern is checked', async () => {
    const r = await resolveToolPaths(fs, ws, 'Glob', { pattern: '**/*.ts' });
    expect(r).toEqual([
      { arg: 'path', raw: '', real: ws, inside: true },
      { arg: 'pattern', raw: '**/*.ts', inside: true },
    ]);
    expect((await resolveToolPaths(fs, ws, 'Glob', { pattern: '../**' })).some((x) => x.reason === 'parentSegment')).toBe(true);
    expect((await resolveToolPaths(fs, ws, 'Glob', { pattern: '/abs/**' })).some((x) => x.reason === 'absolutePattern')).toBe(true);
    expect((await resolveToolPaths(fs, ws, 'Glob', { path: outside, pattern: '*' })).some((x) => x.reason === 'outside')).toBe(true);
  });

  it('Grep path + glob; any other string with "/" is unknownArg', async () => {
    const inside = await resolveToolPaths(fs, ws, 'Grep', { pattern: 'TODO', path: join(ws, 'src'), glob: '*.ts', output_mode: 'content' });
    expect(inside.every((x) => x.inside)).toBe(true);
    const r = await resolveToolPaths(fs, ws, 'Grep', { pattern: 'TODO', include: '/etc/passwd' });
    expect(r).toContainEqual({ arg: 'include', raw: '/etc/passwd', inside: false, reason: 'unknownArg' });
    const nested = await resolveToolPaths(fs, ws, 'Grep', { pattern: 'x', extra: { files: ['/etc/hosts'] } });
    expect(nested).toContainEqual({ arg: 'extra', raw: 'object', inside: false, reason: 'unknownArg' });
  });

  it('a non-string path argument is unknownArg', async () => {
    expect(await resolveToolPaths(fs, ws, 'Read', { file_path: 42 })).toEqual([
      { arg: 'file_path', raw: 'number', inside: false, reason: 'unknownArg' },
    ]);
    expect(await resolveToolPaths(fs, ws, 'Glob', { pattern: ['a'] })).toContainEqual({
      arg: 'pattern',
      raw: 'object',
      inside: false,
      reason: 'unknownArg',
    });
  });

  it('NotebookRead uses notebook_path', async () => {
    expect((await resolveToolPaths(fs, ws, 'NotebookRead', { notebook_path: join(ws, 'src', 'n.ipynb') }))[0]).toMatchObject({
      arg: 'notebook_path',
      inside: true,
    });
  });

  it('a tool that is not a read tool, or a non-object input, is never inside', async () => {
    expect(await resolveToolPaths(fs, ws, 'Bash', { command: 'ls' })).toEqual([
      { arg: 'tool', raw: 'Bash', inside: false, reason: 'unknownArg' },
    ]);
    expect(await resolveToolPaths(fs, ws, 'Read', 'x')).toEqual([{ arg: 'input', raw: 'string', inside: false, reason: 'unknownArg' }]);
  });

  it('isInside handles a root workspace', () => {
    expect(isInside('/a/b', '/')).toBe(true);
    expect(isInside('/ab', '/a')).toBe(false);
  });
});

describe('createPathResolver: intent → permission.pathsResolved', () => {
  it('emits one observation with the permission key, cwdRealpath and the paths; meta origin is the intent', async () => {
    const out: ObservationInput[] = [];
    const clock = new FakeClock();
    const r = createPathResolver({ clock, fs, cwdRealpath: ws, emit: (x) => out.push(x) });
    await r.execute({
      kind: 'permission.resolvePaths',
      id: 7 as IntentId,
      permissionKey: 'p3' as PermissionKey,
      toolName: 'Read',
      input: { file_path: join(outside, 'secret.txt') },
    });
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.kind).toBe('permission.pathsResolved');
    expect(o.meta).toMatchObject({ source: 'self', origin: { kind: 'self', intentId: 7 }, at: clock.now() });
    expect(o.p).toEqual({
      permissionKey: 'p3',
      cwdRealpath: ws,
      paths: [{ arg: 'file_path', raw: join(outside, 'secret.txt'), real: join(outside, 'secret.txt'), inside: false, reason: 'outside' }],
    });
  });

  it('emits nothing after close', async () => {
    const out: ObservationInput[] = [];
    const r = createPathResolver({ clock: new FakeClock(), fs, cwdRealpath: ws, emit: (x) => out.push(x) });
    r.close();
    await r.execute({
      kind: 'permission.resolvePaths',
      id: 1 as IntentId,
      permissionKey: 'p1' as PermissionKey,
      toolName: 'Read',
      input: {},
    });
    expect(out).toEqual([]);
  });
});
