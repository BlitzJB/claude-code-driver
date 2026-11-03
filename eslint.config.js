// eslint.config.js — editor-feedback mirror of the layering + core determinism rules (DESIGN.md §1.4 item 2; AL §3.3).
// dependency-cruiser stays authoritative for layering; ESLint adds what depcruise cannot see (determinism, I1, emit('error'), TLA).
import tseslint from 'typescript-eslint';

const LAYERS = ['model', 'platform', 'channels', 'core', 'session', 'runtime', 'api', 'facades', 'cli', 'testing'];

/** Repo-wide syntax bans (P-API-08, P-API-14). Repeated in every override of `no-restricted-syntax`, which replaces, not merges. */
const BASE_SYNTAX = [
  {
    selector: "CallExpression[callee.property.name='emit'][arguments.0.value='error']",
    message: "never emit 'error' on an EventEmitter (throws without a listener)",
  },
  { selector: 'AwaitExpression:not(:function AwaitExpression)', message: 'no top-level await (breaks require(esm), P-API-14)' },
  {
    selector: 'ForOfStatement[await=true]:not(:function ForOfStatement)',
    message: 'no top-level for-await (breaks require(esm), P-API-14)',
  },
];

const layer = (dir, forbidden, extra = {}) => ({
  files: [`src/${dir}/**/*.ts`],
  rules: {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      { patterns: [{ group: forbidden.map((f) => `**/${f}/**`), message: `${dir} must not import ${forbidden.join(', ')}` }] },
    ],
    ...extra,
  },
});

const others = (...allowed) => LAYERS.filter((l) => !allowed.includes(l));

/** Invariant I1: only core/evolve.ts writes `domain` (DESIGN.md §2.9). */
const I1 = 'only core/evolve.ts writes `domain` (invariant I1)';
const I1_SYNTAX = [
  "AssignmentExpression[left.type='Identifier'][left.name='domain']",
  "AssignmentExpression[left.object.name='domain']",
  "AssignmentExpression[left.property.name='domain']",
  "AssignmentExpression[left.object.object.name='domain']",
  "AssignmentExpression[left.object.property.name='domain']",
  "UpdateExpression[argument.object.name='domain']",
  "UnaryExpression[operator='delete'][argument.object.name='domain']",
  "UnaryExpression[operator='delete'][argument.object.object.name='domain']",
].map((selector) => ({ selector, message: I1 }));

const coreDeterminism = {
  'no-restricted-globals': [
    'error',
    'Date',
    'setTimeout',
    'setInterval',
    'setImmediate',
    'queueMicrotask',
    'performance',
    'process',
    'console',
    'crypto',
    'Intl',
  ],
  'no-restricted-properties': ['error', { object: 'Math', property: 'random' }],
  'no-restricted-syntax': [
    'error',
    ...BASE_SYNTAX,
    { selector: 'AwaitExpression', message: 'core is synchronous' },
    { selector: 'ThrowStatement', message: 'core reports anomalies as diagnostics' },
    ...I1_SYNTAX,
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'fixtures/**', 'node_modules/**', 'etc/**', 'docs/**'] },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { requireDefaultForNonUnion: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', ...BASE_SYNTAX],
    },
  },
  // The §2 model and port files are copied verbatim from DESIGN.md, which spells empty payloads `{}` and open string
  // unions `'a' | string`; both are intentional documentation of the wire shape.
  {
    files: ['src/model/**/*.ts', 'src/platform/ports.ts', 'src/channels/profiles/index.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-duplicate-type-constituents': 'off',
    },
  },
  layer('model', others('model')),
  layer('platform', others('model', 'platform')),
  layer('channels', others('model', 'platform', 'channels')),
  layer('core', others('model', 'core'), coreDeterminism),
  {
    files: ['src/core/evolve.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...BASE_SYNTAX,
        { selector: 'AwaitExpression', message: 'core is synchronous' },
        { selector: 'ThrowStatement', message: 'core reports anomalies as diagnostics' },
      ],
    },
  },
  layer('session', ['runtime', 'api', 'facades', 'cli', 'testing']),
  layer('runtime', ['api', 'facades', 'cli', 'testing']),
  layer('api', ['platform', 'channels', 'session', 'facades', 'cli', 'testing']),
  layer('facades', ['platform', 'channels', 'session', 'api', 'cli', 'testing']),
  layer('cli', ['platform', 'channels', 'core', 'facades', 'testing']),
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
