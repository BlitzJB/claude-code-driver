// test/unit/ci/yaml-subset.test.ts — the subset YAML reader used by the workflow tests (WP-CI). Its own behaviour is pinned
// here, and, when Ruby is installed, its result for every workflow is cross-checked against Ruby's Psych parser.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScalar, parseYaml, stripComment, YamlSubsetError } from './yaml-subset.js';
import type { Yaml } from './yaml-subset.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
/** Optional system Ruby (not a project dependency); CCD_RUBY overrides the binary. */
const RUBY = process.env['CCD_RUBY'] ?? 'ruby';

function hasRuby(): boolean {
  try {
    execFileSync(RUBY, ['-ryaml', '-rjson', '-e', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('stripComment', () => {
  it('drops a trailing comment but keeps # inside quotes and words', () => {
    expect(stripComment('a: b # c')).toBe('a: b');
    expect(stripComment("a: '# not a comment' # yes")).toBe("a: '# not a comment'");
    expect(stripComment('a: "x # y"')).toBe('a: "x # y"');
    expect(stripComment('a: b#c')).toBe('a: b#c');
    expect(stripComment('# whole line')).toBe('');
    expect(stripComment("a: 'it''s # here'")).toBe("a: 'it''s # here'");
  });
});

describe('parseScalar', () => {
  it('types plain booleans, null and integers and leaves the rest as strings', () => {
    expect(parseScalar('true')).toBe(true);
    expect(parseScalar('false')).toBe(false);
    expect(parseScalar('~')).toBeNull();
    expect(parseScalar('40')).toBe(40);
    expect(parseScalar('3.2')).toBe('3.2');
    expect(parseScalar('20.19.x')).toBe('20.19.x');
    expect(parseScalar("'22'")).toBe('22');
    expect(parseScalar('"a\\nb"')).toBe('a\nb');
    expect(parseScalar("'it''s'")).toBe("it's");
  });

  it('reads one-level flow sequences', () => {
    expect(parseScalar("['20.19.x', '22.x', 24]")).toEqual(['20.19.x', '22.x', 24]);
    expect(parseScalar('[main]')).toEqual(['main']);
    expect(parseScalar('[]')).toEqual([]);
    expect(parseScalar("['a, b', c]")).toEqual(['a, b', 'c']);
  });

  it('rejects what is outside the subset', () => {
    expect(() => parseScalar('{a: 1}')).toThrow(YamlSubsetError);
    expect(() => parseScalar('[[1]]')).toThrow(YamlSubsetError);
    expect(() => parseScalar('&anchor x')).toThrow(YamlSubsetError);
    expect(() => parseScalar("'open")).toThrow(YamlSubsetError);
    expect(() => parseScalar('[a')).toThrow(YamlSubsetError);
  });
});

describe('parseYaml', () => {
  it('reads nested mappings, sequences of mappings and block scalars', () => {
    const doc = parseYaml(
      [
        '# header',
        'name: ci',
        'on:',
        '  push:',
        '    branches: [main]',
        '  pull_request:',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-24.04 # trailing',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '',
        '      - name: Many lines',
        '        run: |',
        '          echo one',
        '          # kept: part of the script',
        '',
        '          echo two',
        '      - name: Folded',
        '        run: >-',
        '          a',
        '          b',
        '      -',
        '        nested: true',
        'list:',
        '- x',
        "- 'y'",
      ].join('\n'),
    );
    expect(doc).toEqual({
      name: 'ci',
      on: { push: { branches: ['main'] }, pull_request: null },
      jobs: {
        a: {
          'runs-on': 'ubuntu-24.04',
          steps: [
            { uses: 'actions/checkout@v4' },
            { name: 'Many lines', run: 'echo one\n# kept: part of the script\n\necho two\n' },
            { name: 'Folded', run: 'a b' },
            { nested: true },
          ],
        },
      },
      list: ['x', 'y'],
    } satisfies Yaml);
  });

  it('keeps `on` a string key (GitHub semantics, not YAML 1.1 booleans)', () => {
    expect(Object.keys(parseYaml('on:\n  push:\n') as object)).toEqual(['on']);
  });

  it('fails loudly on input it does not understand', () => {
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/duplicate key/);
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(/tab/);
    expect(() => parseYaml('  a: 1')).toThrow(/column 0/);
    expect(() => parseYaml('a: 1\n   b: 2')).toThrow(YamlSubsetError);
    expect(() => parseYaml('just words')).toThrow(/key: value/);
  });

  it('returns null for an empty document', () => {
    expect(parseYaml('# only a comment\n\n')).toBeNull();
  });
});

describe.runIf(hasRuby())('cross-check with Ruby Psych', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'));

  it.each(files)('%s parses the same with Psych', (file) => {
    const path = join(WORKFLOWS, file);
    const json = execFileSync(RUBY, ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))', path], {
      encoding: 'utf8',
    });
    const psych = JSON.parse(json) as Record<string, unknown>;
    // YAML 1.1 reads the bare key `on` as `true`; GitHub (and our reader) keep it as "on".
    if (Object.hasOwn(psych, 'true')) {
      psych['on'] = psych['true'];
      delete psych['true'];
    }
    const ours = parseYaml(readFileSync(path, 'utf8'));
    expect(ours).toEqual(psych);
  });
});
