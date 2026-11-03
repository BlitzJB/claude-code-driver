// vitest.config.ts — test projects (DESIGN.md §6.1). Run one with `vitest run --project <name>`.
// The `orch` project of §6.1 is not configured: WP-ORCH was dropped (docs/icr/0000-drop-wp-orch.md).
import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const liveGlobalSetup = 'test/live/global-setup.ts';
const hasAssertions = 'test/setup/has-assertions.ts';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'], setupFiles: [hasAssertions] } },
      { extends: true, test: { name: 'arch', include: ['test/arch/**/*.test.ts'], testTimeout: 60_000 } },
      { extends: true, test: { name: 'contract', include: ['test/contract/**/*.test.ts'], testTimeout: 20_000 } },
      { extends: true, test: { name: 'kernel', include: ['test/kernel/**/*.test.ts'], setupFiles: [hasAssertions] } },
      // replay: whole-corpus tests (every trace, sometimes twice) exceed vitest's 5 s default under full-suite load.
      { extends: true, test: { name: 'replay', include: ['test/replay/**/*.test.ts'], testTimeout: 60_000 } },
      {
        extends: true,
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 60_000,
          // The live global setup (WP-INT) kills only the ccd-live-<pid>-* sockets its own registry names (§6.5).
          globalSetup: existsSync(liveGlobalSetup) ? [liveGlobalSetup] : [],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/testing/**', 'src/**/standalone/**', 'src/**/fake-*.ts', 'src/model/version.ts'],
      thresholds: {
        'src/core/**': { lines: 90, branches: 80 },
        'src/channels/**': { lines: 90 },
        'src/session/**': { lines: 85 },
        'src/platform/**': { lines: 80 },
        'src/api/**': { lines: 85 },
        'src/cli/**': { lines: 70 },
      },
    },
  },
});
