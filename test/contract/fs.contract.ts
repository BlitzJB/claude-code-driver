// Shared contract for the WP-05 file-system ports (RuntimeDirPort, StateStorePort, SettingsFilePort), run against the fakes
// and the real adapters (DESIGN.md §2.7 "Fakes", §8 "the WP runs the shared contract suite against both").
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeDirPort, SettingsFilePort, StateStorePort } from '../../src/platform/ports.js';

export interface FsHarness {
  runtimeDir: RuntimeDirPort;
  state: StateStorePort;
  settingsFile: SettingsFilePort;
  /** Plant a lock file named `name` held by a pid that is not alive. */
  plantDeadLock(name: string): Promise<void>;
  cleanup(): Promise<void>;
}

export function fsContract(label: string, make: () => Promise<FsHarness>): void {
  describe(`fs ports contract: ${label}`, () => {
    let h: FsHarness;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    describe('RuntimeDirPort', () => {
      it('creates distinct absolute ccd-XXXXXX session dirs under the root and removes them idempotently', async () => {
        const root = await h.runtimeDir.ensureRoot();
        const a = await h.runtimeDir.createSessionDir();
        const b = await h.runtimeDir.createSessionDir();
        expect(a).not.toBe(b);
        for (const d of [a, b]) {
          expect(d.startsWith(`${root}/ccd-`)).toBe(true);
          expect(d).toMatch(/\/ccd-[A-Za-z0-9]{6}$/);
          expect(Buffer.byteLength(`${d}/net.sock`)).toBeLessThanOrEqual(100);
        }
        await h.runtimeDir.removeSessionDir(a);
        await h.runtimeDir.removeSessionDir(a);
        await expect(h.runtimeDir.removeSessionDir(`${root}/not-a-session-dir`)).rejects.toMatchObject({ name: 'UnsafeRuntimeDir' });
      });

      it('sweepStale removes only known dirs whose owner is dead', async () => {
        const dead = await h.runtimeDir.createSessionDir();
        const live = await h.runtimeDir.createSessionDir();
        const removed = await h.runtimeDir.sweepStale([
          { path: dead, ownerAlive: false },
          { path: live, ownerAlive: true },
        ]);
        expect(removed).toEqual([dead]);
        expect(await h.runtimeDir.sweepStale([{ path: dead, ownerAlive: false }])).toEqual([]);
      });
    });

    describe('StateStorePort', () => {
      it('round-trips JSON, overwrites atomically, lists names sorted, removes', async () => {
        expect(await h.state.readJson('sessions/s1.json')).toBeUndefined();
        await h.state.writeJsonAtomic('sessions/s2.json', { n: 2 });
        await h.state.writeJsonAtomic('sessions/s1.json', { n: 1, nested: { a: [true, null] } });
        await h.state.writeJsonAtomic('sessions/s1.json', { n: 11 });
        expect(await h.state.readJson('sessions/s1.json')).toEqual({ n: 11 });
        expect(await h.state.list('sessions')).toEqual(['s1.json', 's2.json']);
        expect(await h.state.list('archive')).toEqual([]);
        await h.state.remove('sessions/s2.json');
        await h.state.remove('sessions/s2.json');
        expect(await h.state.list('sessions')).toEqual(['s1.json']);
      });

      it('appendLine appends whole lines; embedded newlines and escaping paths are refused', async () => {
        await h.state.appendLine('exits/k.log', 'one');
        await h.state.appendLine('exits/k.log', 'two\n');
        expect(await h.state.list('exits')).toEqual(['k.log']);
        await expect(h.state.appendLine('exits/k.log', 'a\nb')).rejects.toThrow(RangeError);
        await expect(h.state.writeJsonAtomic('../escape.json', 1)).rejects.toThrow(RangeError);
        await expect(h.state.readJson('/abs.json')).rejects.toThrow(RangeError);
      });

      it('withLock is exclusive, returns the result, releases on throw, and steals a dead holder’s lock', async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const first = h.state.withLock(
          'lock',
          async () => {
            order.push('first-in');
            await gate;
            order.push('first-out');
            return 1;
          },
          { staleMs: 60_000 },
        );
        await new Promise((r) => setTimeout(r, 5));
        const second = h.state.withLock(
          'lock',
          () => {
            order.push('second');
            return Promise.resolve(2);
          },
          { staleMs: 60_000 },
        );
        await new Promise((r) => setTimeout(r, 30));
        expect(order).toEqual(['first-in']);
        release();
        expect(await first).toBe(1);
        expect(await second).toBe(2);
        expect(order).toEqual(['first-in', 'first-out', 'second']);
        await expect(h.state.withLock('lock', () => Promise.reject(new Error('boom')), { staleMs: 60_000 })).rejects.toThrow('boom');
        await h.plantDeadLock('lock');
        expect(await h.state.withLock('lock', () => Promise.resolve('stolen'), { staleMs: 60_000 })).toBe('stolen');
      });
    });

    describe('SettingsFilePort', () => {
      it('writes once (O_EXCL), hashes the exact bytes, detects tampering', async () => {
        const dir = await h.runtimeDir.createSessionDir();
        const p = `${dir}/settings.json`;
        const json = { hooks: {}, editorMode: 'normal' };
        const r = await h.settingsFile.writeExclusive(p, json);
        const canonical = Buffer.from(`${JSON.stringify(json, null, 2)}\n`);
        expect(r).toEqual({ sha256: createHash('sha256').update(canonical).digest('hex'), bytes: canonical.length });
        expect(await h.settingsFile.matches(p, r.sha256)).toBe(true);
        expect(await h.settingsFile.matches(p, '0'.repeat(64))).toBe(false);
        expect(await h.settingsFile.matches(`${dir}/missing.json`, r.sha256)).toBe(false);
        await expect(h.settingsFile.writeExclusive(p, {})).rejects.toMatchObject({ name: 'SettingsFileExists' });
      });
    });
  });
}
