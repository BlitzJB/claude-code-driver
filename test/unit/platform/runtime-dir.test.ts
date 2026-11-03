// WP-05 unit tests: RuntimeDirPort (P-SEC-24 lstat rule, P-HOOK-17/P-SEC-14 0700 mkdtemp, socket path guard, sweep rule).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEnv } from '../../../src/platform/env/fake-env.js';
import { privateDirProblem } from '../../../src/platform/runtime-dir/dir-checks.js';
import { SocketPathTooLong, UnsafeRuntimeDir } from '../../../src/platform/runtime-dir/errors.js';
import { FakeRuntimeDir } from '../../../src/platform/runtime-dir/fake-runtime-dir.js';
import { createRuntimeDirPort } from '../../../src/platform/runtime-dir/runtime-dir.js';

let base: string;
const uid = process.getuid?.() ?? 501;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-rt-')));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const env = (o: { platform?: 'darwin' | 'linux'; tmp?: string; xdg?: string } = {}) =>
  new FakeEnv({
    uid,
    platform: o.platform ?? 'darwin',
    tmpDir: o.tmp ?? base,
    ...(o.xdg !== undefined ? { vars: { XDG_RUNTIME_DIR: o.xdg } } : {}),
  });

describe('ensureRoot', () => {
  it('uses a private darwin TMPDIR as is', async () => {
    const rt = createRuntimeDirPort({ env: env({ tmp: base }) });
    expect(await rt.ensureRoot()).toBe(base);
  });

  it('linux prefers $XDG_RUNTIME_DIR', async () => {
    const xdg = join(base, 'xdg');
    mkdirSync(xdg, { mode: 0o700 });
    const rt = createRuntimeDirPort({ env: env({ platform: 'linux', xdg }) });
    expect(await rt.ensureRoot()).toBe(xdg);
  });

  it('an explicit root is created 0700; a group-readable, symlinked or foreign one is refused (P-SEC-24)', async () => {
    const fresh = join(base, 'fresh');
    expect(await createRuntimeDirPort({ env: env(), root: fresh }).ensureRoot()).toBe(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);

    const loose = join(base, 'loose');
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    await expect(createRuntimeDirPort({ env: env(), root: loose }).ensureRoot()).rejects.toMatchObject({
      name: 'UnsafeRuntimeDir',
      reason: 'mode',
    });

    const link = join(base, 'link');
    symlinkSync(fresh, link);
    await expect(createRuntimeDirPort({ env: env(), root: link }).ensureRoot()).rejects.toMatchObject({ reason: 'symlink' });

    const foreign = createRuntimeDirPort({ env: new FakeEnv({ uid: uid + 12345, platform: 'darwin', tmpDir: base }), root: fresh });
    await expect(foreign.ensureRoot()).rejects.toMatchObject({ reason: 'owner' });
  });

  it('privateDirProblem reasons', async () => {
    const f = join(base, 'file');
    writeFileSync(f, '');
    expect(await privateDirProblem('relative')).toBe('notAbsolute');
    expect(await privateDirProblem(join(base, 'none'))).toBe('missing');
    expect(await privateDirProblem(f)).toBe('notDirectory');
    expect(await privateDirProblem(base)).toBeUndefined();
  });
});

describe('session dirs', () => {
  it('createSessionDir → absolute ccd-XXXXXX, 0700, under the root, outside any cwd', async () => {
    const rt = createRuntimeDirPort({ env: env() });
    const d = await rt.createSessionDir();
    expect(d.startsWith(`${base}/ccd-`)).toBe(true);
    expect(d).toMatch(/\/ccd-[A-Za-z0-9]{6}$/);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    await rt.removeSessionDir(d);
    expect(existsSync(d)).toBe(false);
    await rt.removeSessionDir(d); // idempotent
  });

  it('refuses a root whose net.sock path would exceed 100 bytes and leaves nothing behind', async () => {
    const deep = join(base, 'x'.repeat(40), 'y'.repeat(40));
    mkdirSync(deep, { recursive: true, mode: 0o700 });
    const rt = createRuntimeDirPort({ env: env(), root: deep });
    const e = await rt.createSessionDir().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SocketPathTooLong);
    expect((e as SocketPathTooLong).bytes).toBeGreaterThan(100);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(deep)).toEqual([]);
  });

  it('removeSessionDir refuses anything that is not a ccd-XXXXXX dir we own', async () => {
    const rt = createRuntimeDirPort({ env: env() });
    const other = join(base, 'important');
    mkdirSync(other);
    await expect(rt.removeSessionDir(other)).rejects.toBeInstanceOf(UnsafeRuntimeDir);
    await expect(rt.removeSessionDir('ccd-abcdef')).rejects.toMatchObject({ reason: 'notAbsolute' });
    const target = await rt.createSessionDir();
    const link = join(base, 'ccd-LINKED');
    symlinkSync(target, link);
    await expect(rt.removeSessionDir(link)).rejects.toMatchObject({ reason: 'symlink' });
    expect(existsSync(other) && existsSync(target)).toBe(true);
  });

  it('sweepStale removes only registry-named dirs whose owner is dead', async () => {
    const rt = createRuntimeDirPort({ env: env() });
    const dead = await rt.createSessionDir();
    const live = await rt.createSessionDir();
    const unknown = await rt.createSessionDir();
    const removed = await rt.sweepStale([
      { path: dead, ownerAlive: false },
      { path: live, ownerAlive: true },
      { path: join(base, 'not-ours'), ownerAlive: false },
      { path: join(base, 'ccd-gone00'), ownerAlive: false },
    ]);
    expect(removed).toEqual([dead]);
    expect(existsSync(live) && existsSync(unknown)).toBe(true);
  });
});

describe('FakeRuntimeDir', () => {
  it('mirrors the rules', async () => {
    const f = new FakeRuntimeDir();
    const d = await f.createSessionDir();
    expect(d).toMatch(/^\/fake\/run\/ccd-[A-Za-z0-9]{6}$/);
    await expect(f.removeSessionDir('/etc')).rejects.toBeInstanceOf(UnsafeRuntimeDir);
    f.plant('/fake/run/ccd-old000');
    expect(
      await f.sweepStale([
        { path: '/fake/run/ccd-old000', ownerAlive: false },
        { path: d, ownerAlive: true },
      ]),
    ).toEqual(['/fake/run/ccd-old000']);
    await expect(new FakeRuntimeDir({ unsafe: 'symlink' }).ensureRoot()).rejects.toMatchObject({ reason: 'symlink' });
    await expect(new FakeRuntimeDir({ root: `/${'r'.repeat(100)}` }).createSessionDir()).rejects.toBeInstanceOf(SocketPathTooLong);
  });
});
