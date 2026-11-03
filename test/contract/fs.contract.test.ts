// Runs the fs ports contract against the fakes and the real adapters (WP-05).
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealClock } from '../../src/platform/clock/real-clock.js';
import { FakeEnv } from '../../src/platform/env/fake-env.js';
import { FakeRuntimeDir } from '../../src/platform/runtime-dir/fake-runtime-dir.js';
import { FakeStateStore } from '../../src/platform/runtime-dir/fake-state-store.js';
import { createRuntimeDirPort } from '../../src/platform/runtime-dir/runtime-dir.js';
import { createStateStore } from '../../src/platform/runtime-dir/state-store.js';
import { FakeSettingsFile } from '../../src/platform/settings/fake-config.js';
import { createSettingsFilePort } from '../../src/platform/settings/settings-file.js';
import { fsContract } from './fs.contract.js';

const DEAD_PID = 999_999; // above macOS pid_max (99998) and Linux's default (4194304 is the max, 32768 typical): not alive

fsContract('fakes', () => {
  const clock = createRealClock();
  const state = new FakeStateStore({ clock, isAlive: (p) => p !== DEAD_PID });
  return Promise.resolve({
    runtimeDir: new FakeRuntimeDir(),
    state,
    settingsFile: new FakeSettingsFile(),
    plantDeadLock: (name) => {
      state.plantLock(name, { pid: DEAD_PID, at: clock.wallNow() });
      return Promise.resolve();
    },
    cleanup: () => Promise.resolve(),
  });
});

fsContract('real adapters', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-fsc-')));
  const env = new FakeEnv({ uid: process.getuid?.() ?? 501, platform: 'darwin', tmpDir: base, home: base });
  const state = createStateStore({ env, clock: createRealClock(), root: join(base, 'state') });
  return Promise.resolve({
    runtimeDir: createRuntimeDirPort({ env, root: join(base, 'run') }),
    state,
    settingsFile: createSettingsFilePort(),
    plantDeadLock: async (name) => {
      await state.list('');
      writeFileSync(join(state.root, name), JSON.stringify({ pid: DEAD_PID, token: 'planted', at: Date.now() }));
    },
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
      return Promise.resolve();
    },
  });
});
