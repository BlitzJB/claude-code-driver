// WP-05 unit tests: SettingsFilePort — O_EXCL 0600 + fsync + sha256 (P-HOOK-17, P-SEC-14), tamper check (P-SEC-31).
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsFileExists } from '../../../src/platform/settings/errors.js';
import { FakeSettingsFile } from '../../../src/platform/settings/fake-config.js';
import { createSettingsFilePort } from '../../../src/platform/settings/settings-file.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-sf-')));
  chmodSync(dir, 0o700);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeExclusive', () => {
  it('writes 0600 JSON and returns the sha256/bytes of exactly what is on disk', async () => {
    const p = join(dir, 'settings.json');
    const json = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/h/s/Stop' }] }] }, editorMode: 'normal' };
    const r = await createSettingsFilePort().writeExclusive(p, json);
    const disk = readFileSync(p);
    expect(r.bytes).toBe(disk.length);
    expect(r.sha256).toBe(createHash('sha256').update(disk).digest('hex'));
    expect(JSON.parse(disk.toString('utf8'))).toEqual(json);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('a second write, or a planted file/symlink, fails with SettingsFileExists (never followed)', async () => {
    const port = createSettingsFilePort();
    const p = join(dir, 'settings.json');
    await port.writeExclusive(p, {});
    await expect(port.writeExclusive(p, { x: 1 })).rejects.toBeInstanceOf(SettingsFileExists);
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep');
    const planted = join(dir, 'planted.json');
    symlinkSync(victim, planted);
    await expect(port.writeExclusive(planted, { x: 1 })).rejects.toBeInstanceOf(SettingsFileExists);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('refuses a parent dir that is not private (never inside a shared/project dir)', async () => {
    const loose = join(dir, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    await expect(createSettingsFilePort().writeExclusive(join(loose, 's.json'), {})).rejects.toMatchObject({
      name: 'UnsafeRuntimeDir',
      reason: 'mode',
    });
    await expect(createSettingsFilePort().writeExclusive('rel/s.json', {})).rejects.toMatchObject({ reason: 'notAbsolute' });
  });
});

describe('matches', () => {
  it('is true for the untouched file and false after tampering, for symlinks and missing files', async () => {
    const port = createSettingsFilePort();
    const p = join(dir, 'settings.json');
    const { sha256 } = await port.writeExclusive(p, { a: 1 });
    expect(await port.matches(p, sha256)).toBe(true);
    expect(await port.matches(p, sha256.toUpperCase())).toBe(true);
    writeFileSync(p, '{"a":2}');
    expect(await port.matches(p, sha256)).toBe(false);
    const l = join(dir, 'l.json');
    symlinkSync(p, l);
    expect(await port.matches(l, sha256)).toBe(false);
    expect(await port.matches(join(dir, 'none'), sha256)).toBe(false);
  });

  it('FakeSettingsFile has the same contract and exposes reads/tampering', async () => {
    const f = new FakeSettingsFile();
    const real = createSettingsFilePort();
    const a = await f.writeExclusive('/s/settings.json', { k: [1, 'x'] });
    const b = await real.writeExclusive(join(dir, 'same.json'), { k: [1, 'x'] });
    expect(a).toEqual(b);
    await expect(f.writeExclusive('/s/settings.json', {})).rejects.toBeInstanceOf(SettingsFileExists);
    expect(f.read('/s/settings.json')).toEqual({ k: [1, 'x'] });
    expect(await f.matches('/s/settings.json', a.sha256)).toBe(true);
    f.tamper('/s/settings.json', '{}');
    expect(await f.matches('/s/settings.json', a.sha256)).toBe(false);
  });
});
