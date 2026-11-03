// .dependency-cruiser.cjs — authoritative layering check (DESIGN.md §1.3, §1.4 item 1; api-layering.md §3.2).
// Run under Node 22: `depcruise src --config .dependency-cruiser.cjs` (dependency-cruiser 17.4.3 refuses Node 23, P-API-25).
// Changes against AL §3.2 (all from DESIGN.md rev 2):
//   - `facades-isolated` is one rule per reserved facade folder (the `$1` back-reference is UNVERIFIED, P-API-30);
//   - `cli-no-low` and `cli-session-reaper-registry-only` (§1.3 cli row);
//   - api/facades may not import session/** at all; they reach L3 only through runtime/node.ts (§1.3 api row, rev2);
//   - session may import platform/ports.ts only, type-only;
//   - hook-server/worker.ts is held to the standalone builtins-only rule (§1.4 3c);
//   - fake-*.ts may only be imported from testing/** (or by another fake) (§1.2);
//   - only runtime cycles are forbidden: a cycle that contains an `import type` edge is erased at compile time (such cycles are
//     unavoidable between the mutually-referencing §2 model files).
'use strict';

const LAYERS_ABOVE_PLATFORM = 'channels|core|session|runtime|api|facades|cli|testing';
const NPM = ['npm', 'npm-dev', 'npm-peer', 'npm-optional', 'npm-bundled', 'npm-no-pkg', 'npm-unknown'];
const RESERVED_FACADES = ['callbacks', 'rx', 'mcp', 'http'];

const deny = (name, from, to, extra = {}) => ({ name, severity: 'error', from: { path: from }, to: { path: to, ...extra } });

module.exports = {
  forbidden: [
    // ---- model: imports nothing ----
    deny('model-imports-nothing', '^src/model/', '^src/(?!model/)'),
    { name: 'model-no-builtins', severity: 'error', from: { path: '^src/model/' }, to: { dependencyTypes: ['core'] } },
    { name: 'model-no-npm', severity: 'error', from: { path: '^src/model/' }, to: { dependencyTypes: NPM } },

    // ---- L0 platform ----
    deny('platform-down-only', '^src/platform/', `^src/(${LAYERS_ABOVE_PLATFORM})/`),
    {
      name: 'standalone-builtins-only',
      comment: 'standalone scripts and the hook worker run as separate processes/threads and may import node:* only (R-A, §1.4 3c)',
      severity: 'error',
      from: { path: ['^src/platform/[^/]+/standalone/', '^src/platform/hook-server/worker\\.ts$'] },
      to: { dependencyTypesNot: ['core'] },
    },

    // ---- L1 channels ----
    deny('channels-down-only', '^src/channels/', '^src/(core|session|runtime|api|facades|cli|testing)/'),
    deny('channels-platform-types-only', '^src/channels/', '^src/platform/', { dependencyTypesNot: ['type-only'] }),

    // ---- L2 core: pure ----
    deny('core-model-only', '^src/core/', '^src/(?!core/|model/)'),
    { name: 'core-no-builtins', severity: 'error', from: { path: '^src/core/' }, to: { dependencyTypes: ['core'] } },
    { name: 'core-no-npm', severity: 'error', from: { path: '^src/core/' }, to: { dependencyTypes: NPM } },

    // ---- L3 session ----
    deny('session-no-up', '^src/session/', '^src/(runtime|api|facades|cli|testing)/'),
    deny('session-platform-ports-only', '^src/session/', '^src/platform/(?!ports\\.ts$)'),
    deny('session-platform-types-only', '^src/session/', '^src/platform/', { dependencyTypesNot: ['type-only'] }),

    // ---- L3.5 runtime ----
    deny('runtime-no-up', '^src/runtime/', '^src/(api|facades|cli|testing)/'),

    // ---- L4 api / facades ----
    deny('facade-no-low', '^src/(api|facades)/', '^src/(platform|channels|session)/'),
    deny('facade-core-selectors-only', '^src/(api|facades)/', '^src/core/(?!selectors\\.ts$)'),
    deny('facade-runtime-node-only', '^src/(api|facades)/', '^src/runtime/(?!node\\.ts$)'),
    deny('facade-no-cli', '^src/(api|facades)/', '^src/cli/'),
    { name: 'api-no-npm', severity: 'error', from: { path: '^src/api/' }, to: { dependencyTypes: NPM } },
    deny('facades-not-api', '^src/facades/', '^src/api/'),
    ...RESERVED_FACADES.map((f) => deny(`facades-isolated-${f}`, `^src/facades/${f}/`, `^src/facades/(?!${f}/)`)),

    // ---- L4 cli ----
    deny('cli-no-low', '^src/cli/', '^src/(platform|channels|core)/'),
    deny('cli-session-reaper-registry-only', '^src/cli/', '^src/session/(?!reaper\\.ts$|registry-store\\.ts$)'),
    deny('cli-no-facades', '^src/cli/', '^src/facades/'),

    // ---- testing kit and fakes ----
    deny('nobody-imports-testing', '^src/(?!testing/)', '^src/testing/'),
    {
      name: 'fakes-only-from-testing',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/testing/', '/fake-[^/]+\\.ts$'] },
      to: { path: '/fake-[^/]+\\.ts$' },
    },

    // ---- graph hygiene ----
    {
      name: 'no-circular',
      comment:
        'no value cycles anywhere (R-C, P-API-11); a cycle with at least one `import type` edge is erased at compile time and allowed',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '^src/(api|testing)/index\\.ts$',
          '^src/facades/[^/]+/index\\.ts$',
          '^src/cli/main\\.ts$',
          '^src/runtime/kernel-entry\\.ts$',
          '^src/platform/[^/]+/standalone/',
          '^src/platform/hook-server/worker\\.ts$',
          '^src/model/',
          '^src/platform/ports\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.ts$' },
  },
};
