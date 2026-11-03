// runtime/node.ts — the composition root (DESIGN.md §1.1 L3.5, §2.10 createKernel, §3.12 lifecheck uses createNodePorts).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isCcdError } from '../../../src/model/errors.js';
import { createKernel, createNodePorts, defaultLogger, silentLogger } from '../../../src/runtime/node.js';
import * as entry from '../../../src/runtime/kernel-entry.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccd-rt-'));
  dirs.push(d);
  return d;
}

describe('createNodePorts', () => {
  it('builds every §2.7 port (net included; the channel itself is opt-in through the spec)', () => {
    const p = createNodePorts({ stateDir: tmp() });
    for (const k of [
      'clock',
      'ids',
      'process',
      'env',
      'claude',
      'runtimeDir',
      'state',
      'settingsFile',
      'claudeConfig',
      'tmux',
      'tail',
      'hooks',
      'editor',
      'net',
      'registry',
      'ownerWatch',
      'logger',
    ] as const)
      expect(p[k], k).toBeDefined();
    expect(typeof p.tmux.probe).toBe('function');
    expect(typeof p.hooks.create).toBe('function');
    expect(typeof p.tail.create).toBe('function');
    expect(typeof p.ownerWatch.start).toBe('function');
  });

  it('roots the state store exactly at the requested stateDir and touches no disk while building', () => {
    const dir = join(tmp(), 'not-created-yet');
    const p = createNodePorts({ stateDir: dir });
    expect(p.state.root).toBe(dir);
  });

  it('shares one clock: every timestamp of every port is on the same mono base (D-03)', () => {
    const p = createNodePorts({ stateDir: tmp() });
    const a = p.clock.now();
    const b = p.clock.now();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(p.clock.wallNow()).toBeGreaterThan(1_700_000_000_000);
  });

  it('honours an explicit runtime root (the port then uses it as its only candidate)', async () => {
    const root = join(tmp(), 'rt');
    const p = createNodePorts({ stateDir: tmp(), runtimeRoot: root });
    await expect(p.runtimeDir.ensureRoot()).resolves.toBe(root);
  });

  it('ids are lowercase hex tokens and v4 uuids (no `$` ever reaches a settings file, SEC §2.2)', () => {
    const p = createNodePorts({ stateDir: tmp() });
    expect(p.ids.tokenHex(32)).toMatch(/^[0-9a-f]{64}$/);
    expect(p.ids.uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('defaultLogger', () => {
  it('is silent unless CCD_LOG names a level, then writes JSON lines at or above it', () => {
    const lines: string[] = [];
    expect(defaultLogger({}, (l) => lines.push(l))).toBe(silentLogger);
    const l = defaultLogger({ CCD_LOG: 'warn' }, (x) => lines.push(x));
    l.info('ignored');
    l.warn('kept', { code: 'E_X' });
    l.error('also kept');
    expect(lines.map((x) => JSON.parse(x) as { level: string; msg: string })).toEqual([
      { level: 'warn', msg: 'kept', code: 'E_X' },
      { level: 'error', msg: 'also kept' },
    ]);
  });

  it('never throws on unserializable fields', () => {
    const lines: string[] = [];
    const l = defaultLogger({ CCD_LOG: 'debug' }, (x) => lines.push(x));
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => {
      l.debug('cyclic', cyc);
    }).not.toThrow();
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ msg: 'cyclic', fields: '[unserializable]' });
  });
});

describe('createKernel', () => {
  it('rejects at once with an AbortError when the signal is already aborted (nothing is built)', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(createKernel({ cwd: tmp(), permissions: { policy: 'deny' } }, { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('a spec error is the CcdError of resolveConfig (§3.1 step 1), before any process or tmux call', async () => {
    let err: unknown;
    try {
      await createKernel({ cwd: join(tmp(), 'missing'), permissions: { policy: 'deny' } });
    } catch (e) {
      err = e;
    }
    expect(isCcdError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('E_CONFIG_INVALID');
  });

  it('unknown spec keys are refused (E_CONFIG_INVALID{unknownKey})', async () => {
    await expect(createKernel({ cwd: tmp(), permissions: { policy: 'deny' }, bogus: true } as never)).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
    });
  });
});

describe('kernel-entry (./kernel subpath, @experimental)', () => {
  it('re-exports createKernel, the read-only selectors and the version constants', () => {
    expect(entry.createKernel).toBe(createKernel);
    for (const k of ['backgroundCount', 'currentTurn', 'displayToolState', 'isBgTaskOpen', 'isQuiescent', 'lastTurn', 'pendingPermissions'])
      expect(typeof (entry as Record<string, unknown>)[k], k).toBe('function');
    expect(entry.SUPPORTED_CLAUDE_VERSION).toBe('2.1.316');
  });
});
