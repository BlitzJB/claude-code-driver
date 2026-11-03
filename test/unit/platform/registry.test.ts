// WP-05 unit tests: Claude registry reader (P-PRIOR-04: corrupt/stale files, never `*.key`; D-23, §3.1 step 7 scan).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEnv } from '../../../src/platform/env/fake-env.js';
import { createClaudeRegistryReader, toRegistryRecord } from '../../../src/platform/registry/claude-registry.js';
import { FakeClaudeRegistry } from '../../../src/platform/registry/fake-registry.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-reg-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FULL = {
  pid: 4242,
  sessionId: '11111111-2222-4333-8444-555555555555',
  cwd: '/w',
  startedAt: 1,
  procStart: 'Tue Nov  3 06:00:00 2026',
  version: '2.1.316',
  kind: 'interactive',
  tmux: 'ccd-s1:@0.%0',
  status: 'busy',
  waitingFor: 'permission',
  messagingSocketPath: '/tmp/x.sock',
};

describe('read', () => {
  it('maps the known fields and drops the rest', async () => {
    writeFileSync(join(dir, '4242.json'), JSON.stringify(FULL));
    const r = createClaudeRegistryReader({ env: new FakeEnv(), sessionsDir: dir });
    expect(await r.read(4242)).toEqual({
      pid: 4242,
      sessionId: FULL.sessionId,
      version: '2.1.316',
      status: 'busy',
      waitingFor: 'permission',
      tmux: 'ccd-s1:@0.%0',
      procStart: FULL.procStart,
    });
  });

  it('is lenient: torn tail, concatenated objects, wrong types; missing → undefined (retry is the caller’s)', async () => {
    writeFileSync(join(dir, '7.json'), `${JSON.stringify({ pid: 7, sessionId: 's', status: 3 })}{"pid":7,"sess`);
    writeFileSync(join(dir, '8.json'), '{"pid":8,"sessionId":');
    const r = createClaudeRegistryReader({ env: new FakeEnv(), sessionsDir: dir });
    expect(await r.read(7)).toEqual({ pid: 7, sessionId: 's' });
    expect(await r.read(8)).toBeUndefined();
    expect(await r.read(9)).toBeUndefined();
    expect(await r.read(-1)).toBeUndefined();
  });

  it('a record naming another pid than its file is ignored; numeric procStart is kept as text', () => {
    expect(toRegistryRecord({ pid: 5 }, 6)).toBeUndefined();
    expect(toRegistryRecord({ procStart: 123 }, 6)).toEqual({ pid: 6, procStart: '123' });
  });

  it('does not follow symlinks', async () => {
    writeFileSync(join(dir, 'target'), JSON.stringify({ pid: 10 }));
    symlinkSync(join(dir, 'target'), join(dir, '10.json'));
    expect(await createClaudeRegistryReader({ env: new FakeEnv(), sessionsDir: dir }).read(10)).toBeUndefined();
  });
});

describe('scan', () => {
  it('returns only live pids and never opens *.key files', async () => {
    writeFileSync(join(dir, '100.json'), JSON.stringify({ pid: 100, sessionId: 'a' }));
    writeFileSync(join(dir, '200.json'), JSON.stringify({ pid: 200, sessionId: 'b' }));
    // A *.key "file" that would hang any reader (a directory with the key name cannot be read as a file either way).
    mkdirSync(join(dir, '100.0123abcd.key'));
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const r = createClaudeRegistryReader({ env: new FakeEnv(), sessionsDir: dir, isAlive: (pid) => pid === 100 });
    expect(await r.scan()).toEqual([{ pid: 100, sessionId: 'a' }]);
  });

  it('missing sessions dir → []; default dir is <configDir>/sessions', async () => {
    expect(await createClaudeRegistryReader({ env: new FakeEnv(), sessionsDir: join(dir, 'none') }).scan()).toEqual([]);
    const home = join(dir, 'home');
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'me' }));
    const r = createClaudeRegistryReader({ env: new FakeEnv({ home }) });
    expect(await r.scan()).toEqual([{ pid: process.pid, sessionId: 'me' }]);
  });
});

describe('FakeClaudeRegistry', () => {
  it('filters scan by liveness and copies records', async () => {
    const f = new FakeClaudeRegistry((pid) => pid !== 2);
    f.put({ pid: 1, sessionId: 'x' });
    f.put({ pid: 2, sessionId: 'y' });
    expect(await f.scan()).toEqual([{ pid: 1, sessionId: 'x' }]);
    const r = await f.read(1);
    if (r !== undefined) r.sessionId = 'mutated';
    expect((await f.read(1))?.sessionId).toBe('x');
    expect(f.reads).toEqual([1, 1]);
  });
});
