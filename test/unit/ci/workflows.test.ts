// test/unit/ci/workflows.test.ts — the CI workflows implement DESIGN.md §7 "CI" (rev 2 §10 G24/C9) and the pitfall
// mitigations that point at CI: P-TMUX-42 (tmux ≥ 3.2; matrix 3.2a/3.4/3.5a/3.6a), P-API-25 (Node 22 for lint),
// P-API-29 (Node 20.19), P-TAIL-19 (Linux runs), P-SEC-23 (fixtures:lint in CI), §6.1 coverage thresholds, and §6.5/§7
// "live tests are never run in CI". Owned by WP-CI.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asList, asMap, asString, isMap, parseYaml } from './yaml-subset.js';
import type { Yaml, YamlMap } from './yaml-subset.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const load = (rel: string): YamlMap => asMap(parseYaml(read(rel)), rel);

const ci = load('.github/workflows/ci.yml');
const nightly = load('.github/workflows/nightly.yml');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; packageManager: string };

const jobs = (wf: YamlMap): YamlMap => asMap(wf['jobs'], 'jobs');
const job = (name: string): YamlMap => asMap(jobs(ci)[name], `jobs.${name}`);
const steps = (j: YamlMap): YamlMap[] => asList(j['steps'], 'steps').map((s, i) => asMap(s, `steps[${String(i)}]`));
const runs = (j: YamlMap): string[] => steps(j).flatMap((s) => (typeof s['run'] === 'string' ? [s['run']] : []));
/** `owner/repo@<tag or 40-hex sha>` → owner/repo (actions are SHA-pinned with the tag in a comment). */
const isAction = (u: unknown, action: string): boolean => typeof u === 'string' && u.split('@')[0] === action;
const uses = (j: YamlMap): string[] => steps(j).flatMap((s) => (typeof s['uses'] === 'string' ? [s['uses']] : []));

/** Every `pnpm <script>` / `pnpm run <script>` invoked by a run block, in order (pnpm built-ins excluded). */
function pnpmScripts(j: YamlMap): string[] {
  const out: string[] = [];
  for (const r of runs(j)) {
    for (const m of r.matchAll(/(?:^|[\s;&|(])pnpm\s+(?:run\s+)?([a-z][\w:-]*)/g)) {
      const name = m[1] ?? '';
      if (!['install', 'exec', 'dlx', '--version'].includes(name)) out.push(name);
    }
  }
  return out;
}

/** Index of the first run step matching `re`, or -1. */
function stepIndex(j: YamlMap, re: RegExp): number {
  return steps(j).findIndex((s) => typeof s['run'] === 'string' && re.test(s['run']));
}

/** Every string anywhere in a parsed document (values only; comments are already gone). */
function strings(v: Yaml): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (isMap(v)) return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}

describe('ci.yml triggers and permissions', () => {
  it('runs on push to main, every pull request, by hand, and as a reusable workflow', () => {
    const on = asMap(ci['on'], 'on');
    expect(asList(asMap(on['push'], 'push')['branches'], 'branches')).toEqual(['main']);
    expect(Object.hasOwn(on, 'pull_request')).toBe(true);
    expect(Object.hasOwn(on, 'workflow_dispatch')).toBe(true);
    const input = asMap(asMap(asMap(on['workflow_call'], 'workflow_call')['inputs'], 'inputs')['tmux-min-versions'], 'input');
    expect(input['type']).toBe('string');
    expect(JSON.parse(asString(input['default'], 'default'))).toEqual(['3.2a']);
  });

  it('has a read-only token', () => {
    expect(ci['permissions']).toEqual({ contents: 'read' });
    expect(nightly['permissions']).toEqual({ contents: 'read' });
  });

  it('cancels superseded runs only for pull requests', () => {
    const c = asMap(ci['concurrency'], 'concurrency');
    expect(asString(c['group'], 'group')).toContain('github.ref');
    expect(c['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('gives every job a timeout and pins every action to a release tag', () => {
    for (const [name, j] of Object.entries(jobs(ci))) {
      const jm = asMap(j, name);
      expect(typeof jm['timeout-minutes'], name).toBe('number');
      for (const u of uses(jm)) expect(u, `${name}: ${u}`).toMatch(/^[\w.-]+\/[\w.-]+@(?:v\d+(?:\.\d+){0,2}|[0-9a-f]{40})$/);
    }
  });
});

describe('ci.yml hardening (untrusted PR code)', () => {
  it('never uses pull_request_target, never grants a job write permissions, and never persists checkout credentials', () => {
    for (const [file, wf] of [
      ['ci.yml', ci],
      ['nightly.yml', nightly],
    ] as const) {
      expect(Object.hasOwn(asMap(wf['on'], 'on'), 'pull_request_target'), file).toBe(false);
      for (const [name, j] of Object.entries(jobs(wf))) {
        const perms = asMap(j, name)['permissions'];
        if (perms !== undefined)
          expect(
            strings(perms).filter((s) => s === 'write' || s === 'write-all'),
            `${file} ${name}`,
          ).toEqual([]);
      }
    }
    for (const [name, j] of Object.entries(jobs(ci))) {
      const checkouts = steps(asMap(j, name)).filter((s) => isAction(s['uses'], 'actions/checkout'));
      expect(checkouts, name).toHaveLength(1);
      for (const c of checkouts) expect(asMap(c['with'], 'with')['persist-credentials'], name).toBe(false);
    }
  });
});

describe('job linux (§7)', () => {
  const linux = job('linux');

  it('runs on ubuntu-24.04 across Node 20.19.x, 22.x and 24.x without fail-fast (P-API-29, P-API-25, P-TAIL-19)', () => {
    expect(linux['runs-on']).toBe('ubuntu-24.04');
    const strategy = asMap(linux['strategy'], 'strategy');
    expect(strategy['fail-fast']).toBe(false);
    expect(asMap(strategy['matrix'], 'matrix')['node']).toEqual(['20.19.x', '22.x', '24.x']);
    const setupNode = steps(linux).find((s) => isAction(s['uses'], 'actions/setup-node'));
    expect(asMap(setupNode?.['with'], 'with')['node-version']).toBe('${{ matrix.node }}');
  });

  it('installs the distro tmux and fails when it is older than 3.2 before any test (P-TMUX-42)', () => {
    const install = stepIndex(linux, /apt-get install[^\n]*\btmux\b/);
    const check = stepIndex(linux, /scripts\/ci\/build-tmux\.sh --check "\$\(command -v tmux\)" 3\.2\b/);
    const firstTest = stepIndex(linux, /pnpm (?:run )?test\b/);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(install);
    expect(firstTest).toBeGreaterThan(check);
  });

  it('runs the §7 sequence: frozen install, lint, typecheck, test, test:contract, check:pkg, check:api, check:tables', () => {
    const r = runs(linux).join('\n');
    expect(r).toMatch(/pnpm install --frozen-lockfile/);
    const order = pnpmScripts(linux);
    const want = ['lint', 'typecheck', 'test', 'test:contract', 'check:pkg', 'check:api', 'check:tables'];
    const positions = want.map((s) => order.indexOf(s));
    expect(
      positions.every((p) => p >= 0),
      `missing one of ${want.join(', ')} in ${order.join(', ')}`,
    ).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('builds before the package and API checks, which read dist/', () => {
    const order = pnpmScripts(linux);
    expect(order.indexOf('build')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('check:pkg'));
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('check:api'));
  });

  it('lints the committed fixtures for personal data and secrets (P-SEC-23)', () => {
    expect(pnpmScripts(linux)).toContain('fixtures:lint');
  });

  it('enforces the §6.1 coverage thresholds with unit and contract merged, on the Node 22 cell', () => {
    const cov = steps(linux).find((s) => typeof s['run'] === 'string' && s['run'].includes('--coverage'));
    expect(cov).toBeDefined();
    const run = asString(cov?.['run'], 'run');
    for (const p of ['unit', 'kernel', 'replay', 'contract']) expect(run).toContain(`--project ${p}`);
    expect(cov?.['if']).toBe("startsWith(matrix.node, '22')");
    // The thresholds the gate enforces live in vitest.config.ts (WP-00); make sure they are there.
    const config = read('vitest.config.ts');
    for (const glob of ['src/core/**', 'src/channels/**', 'src/session/**', 'src/platform/**', 'src/api/**', 'src/cli/**']) {
      expect(config).toContain(`'${glob}'`);
    }
  });

  it('only calls package.json scripts that exist', () => {
    for (const [name, j] of Object.entries(jobs(ci))) {
      for (const s of pnpmScripts(asMap(j, name))) expect(Object.keys(pkg.scripts), `${name} calls pnpm ${s}`).toContain(s);
    }
  });
});

describe('job linux-tmux-min (§7, P-TMUX-42)', () => {
  const min = job('linux-tmux-min');

  it('takes its tmux versions from the reusable-workflow input, defaulting to 3.2a', () => {
    const matrix = asMap(asMap(min['strategy'], 'strategy')['matrix'], 'matrix');
    const expr = asString(matrix['tmux'], 'matrix.tmux');
    expect(expr).toMatch(/^\$\{\{ fromJSON\(inputs\.tmux-min-versions \|\| '(.+)'\) \}\}$/);
    const fallback = /'(.+)'/.exec(expr)?.[1] ?? '';
    const input = asMap(asMap(asMap(asMap(ci['on'], 'on')['workflow_call'], 'wc')['inputs'], 'inputs')['tmux-min-versions'], 'in');
    expect(JSON.parse(fallback)).toEqual(JSON.parse(asString(input['default'], 'default')));
  });

  it('caches the build by tmux version and the script, then builds with build-tmux.sh', () => {
    const cache = steps(min).find((s) => isAction(s['uses'], 'actions/cache'));
    const w = asMap(cache?.['with'], 'cache.with');
    expect(asString(w['path'], 'path')).toBe('~/.cache/ccd-tmux/${{ matrix.tmux }}');
    const key = asString(w['key'], 'key');
    expect(key).toContain('${{ matrix.tmux }}');
    expect(key).toContain("hashFiles('scripts/ci/build-tmux.sh')");
    const build = steps(min).find((s) => s['id'] === 'tmux');
    expect(asString(build?.['run'], 'run')).toBe(
      'bash scripts/ci/build-tmux.sh --prefix "$HOME/.cache/ccd-tmux/${{ matrix.tmux }}" "${{ matrix.tmux }}"',
    );
  });

  it('proves the contract tests use the built binary (CCD_TMUX_BIN and PATH) and runs them on Node 22', () => {
    const check = steps(min).find((s) => typeof s['run'] === 'string' && s['run'].includes('CCD_TMUX_BIN'));
    const run = asString(check?.['run'], 'run');
    expect(run).toContain('test "$("$BIN" -V)" = "tmux $WANT"');
    expect(run).toContain('test "$CCD_TMUX_BIN" = "$BIN"');
    expect(run).toContain('test "$(command -v tmux)" = "$BIN"');
    expect(asMap(check?.['env'], 'env')['BIN']).toBe('${{ steps.tmux.outputs.tmux-bin }}');
    const setupNode = steps(min).find((s) => isAction(s['uses'], 'actions/setup-node'));
    expect(asMap(setupNode?.['with'], 'with')['node-version']).toBe('22.x');
    const order = pnpmScripts(min);
    expect(order).toEqual(['test:contract']);
    expect(stepIndex(min, /pnpm test:contract/)).toBeGreaterThan(steps(min).indexOf(check ?? {}));
  });

  it('the contract helper reads CCD_TMUX_BIN first (the variable build-tmux.sh exports)', () => {
    expect(read('test/contract/tmux.contract.ts')).toMatch(/process\.env\['CCD_TMUX_BIN'\]/);
    expect(read('scripts/ci/build-tmux.sh')).toContain('printf \'CCD_TMUX_BIN=%s\\n\' "$bin" >>"$GITHUB_ENV"');
  });
});

describe('job macos (§7)', () => {
  const mac = job('macos');

  it('runs test and test:contract on macos-14 with brew tmux (checked ≥ 3.2) and Node 22', () => {
    expect(mac['runs-on']).toBe('macos-14');
    expect(runs(mac).join('\n')).toMatch(/brew install tmux/);
    expect(stepIndex(mac, /build-tmux\.sh --check "\$\(command -v tmux\)" 3\.2/)).toBeLessThan(stepIndex(mac, /pnpm test\b/));
    const setupNode = steps(mac).find((s) => isAction(s['uses'], 'actions/setup-node'));
    expect(asMap(setupNode?.['with'], 'with')['node-version']).toBe('22.x');
    expect(pnpmScripts(mac)).toEqual(['test', 'test:contract']);
  });
});

describe('pnpm setup', () => {
  it('every job installs pnpm (version from package.json#packageManager) before setup-node caches it', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    for (const [name, j] of Object.entries(jobs(ci))) {
      const u = uses(asMap(j, name));
      const pnpmAt = u.findIndex((x) => isAction(x, 'pnpm/action-setup'));
      expect(pnpmAt, name).toBeGreaterThanOrEqual(0);
      expect(
        u.findIndex((x) => isAction(x, 'actions/setup-node')),
        name,
      ).toBeGreaterThan(pnpmAt);
      const st = steps(asMap(j, name)).find((s) => isAction(s['uses'], 'pnpm/action-setup'));
      const w = asMap(st?.['with'], 'with');
      expect(Object.hasOwn(w, 'version'), `${name}: the version must come from packageManager`).toBe(false);
      expect(w['standalone']).toBe(true);
    }
  });
});

describe('nightly.yml (§7)', () => {
  it('runs on a schedule and by hand', () => {
    const on = asMap(nightly['on'], 'on');
    const cron = asString(asMap(asList(on['schedule'], 'schedule')[0], 'schedule[0]')['cron'], 'cron');
    expect(cron.split(' ')).toHaveLength(5);
    expect(Object.hasOwn(on, 'workflow_dispatch')).toBe(true);
  });

  it('reuses the whole ci.yml matrix and widens tmux-min to 3.2a, 3.5a and 3.6a (with distro 3.4: P-TMUX-42 set)', () => {
    const call = asMap(jobs(nightly)['ci'], 'jobs.ci');
    expect(call['uses']).toBe('./.github/workflows/ci.yml');
    const versions = JSON.parse(asString(asMap(call['with'], 'with')['tmux-min-versions'], 'tmux-min-versions')) as string[];
    expect(versions).toEqual(['3.2a', '3.5a', '3.6a']);
    const script = read('scripts/ci/build-tmux.sh');
    for (const v of versions) expect(v).toMatch(/^[0-9]+\.[0-9]+[a-z]?$/);
    expect(script).toContain("readonly DEFAULT_URL_BASE='https://github.com/tmux/tmux/releases/download'");
    expect(script).toContain('url="${base%/}/$version/tmux-$version.tar.gz"');
    // Every version CI builds from source has a pinned tarball digest in the script.
    for (const v of versions)
      expect(script, `pinned sha256 for ${v}`).toMatch(new RegExp(`^ {4}${v.replace('.', '\\.')}\\) printf '[0-9a-f]{64}`, 'm'));
  });
});

describe('live tests never run in CI (§6.5, §7)', () => {
  for (const [file, wf] of [
    ['ci.yml', ci],
    ['nightly.yml', nightly],
  ] as const) {
    it(`${file} never enables CCD_LIVE or runs test:live`, () => {
      const all = strings(wf);
      expect(all.filter((s) => /CCD_LIVE\s*[:=]\s*['"]?1/.test(s) || s === 'CCD_LIVE')).toEqual([]);
      expect(all.filter((s) => /test:live|--project live/.test(s))).toEqual([]);
      expect(all.filter((s) => /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|secrets\./.test(s))).toEqual([]);
    });
  }
});
