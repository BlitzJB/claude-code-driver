// scripts/fixtures-{scrub,lint,from-verify}.mjs and the committed initial traces (DESIGN.md §6.6; SEC §8.4; P-SEC-23, P-REV-23,
// P-REV-35).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEST_CORE_CONFIG } from '../../../src/testing/core-config.js';
import { parseTrace } from '../../../src/testing/replay.js';
import * as scrub from '../../../scripts/fixtures-scrub.mjs';
import * as lint from '../../../scripts/fixtures-lint.mjs';
import * as fromVerify from '../../../scripts/fixtures-from-verify.mjs';

interface Scrubber {
  learn(text: string): void;
  value(v: unknown): unknown;
  string(s: string): string;
  line(s: string): string;
}
const createScrubber = scrub.createScrubber as (o?: { users?: string[]; tokens?: string[] }) => Scrubber;
const scrubText = scrub.scrubText as (t: string, o?: { users?: string[]; tokens?: string[] }) => string;
const lintText = lint.lintText as (t: string) => { line: number; rule: string; excerpt: string }[];
const lintPaths = lint.lintPaths as (p: string[]) => { file: string; line: number; rule: string }[];
const readFrames = fromVerify.readFrames as (p: string) => { t: number; lines: string[] }[];

const ROOT = join(import.meta.dirname, '..', '..', '..');
const TRACES = join(ROOT, 'fixtures', 'traces');

describe('fixtures-scrub', () => {
  it('rewrites home paths, their slug form and the user name', () => {
    const s = createScrubber();
    const text = '/Users/alice/.claude/projects/-Users-alice-work/x.jsonl and alice said hi';
    s.learn(text);
    expect(s.string(text)).toBe('/HOME/.claude/projects/-HOME-work/x.jsonl and user said hi');
    expect(createScrubber().string('/home/bob/x')).toBe('/HOME/x');
  });

  it('rewrites temp prefixes (macOS per-user T dir, /private/tmp, /tmp) and their slug forms', () => {
    const s = createScrubber();
    expect(s.string('/private/var/folders/yj/g_x6cnk53n7dsdr1bkv34x840000gn/T/ccd-verify-c')).toBe('/TMP/ccd-verify-c');
    expect(s.string('/private/tmp/claude-501/a')).toBe('/TMP/claude-501/a');
    expect(s.string('cwd=/tmp/x')).toBe('cwd=/TMP/x');
    expect(s.string('-private-tmp-claude-501-ccd-verify-a')).toBe('-TMP-claude-501-ccd-verify-a');
    expect(s.string('/fake/tmp/keep')).toBe('/fake/tmp/keep');
  });

  it('rewrites e-mails, keeps @example.com', () => {
    const s = createScrubber();
    expect(s.string('mail me: jane.doe+x@corp.io or user@example.com')).toBe('mail me: user@example.com or user@example.com');
  });

  it('rewrites self-test nonces (P-REV-23) and exact secrets; masks token-bearing keys and drops header keys', () => {
    const nonce = `ccd-selftest-${'0123456789abcdef'.repeat(2)}`;
    const s = createScrubber({ tokens: ['supersecretvalue'] });
    expect(s.string(`prompt ${nonce}`)).toBe('prompt ccd-selftest-NONCE');
    expect(s.string('x supersecretvalue y')).toBe('x TOKEN y');
    expect(s.value({ token: 'abc', headers: { 'X-CCD-Token': 'f'.repeat(64), 'Proxy-Authorization': 'Basic x' }, keep: 1 })).toEqual({
      token: 'TOKEN',
      headers: {},
      keep: 1,
    });
  });

  it('maps org/account ids to consistent fakes', () => {
    const s = createScrubber();
    const id = '9c3f6a2e-1111-4222-8333-444455556666';
    const out = s.value({ organizationUuid: id, nested: { accountUuid: id, userID: 'deadbeef' } }) as Record<string, unknown>;
    expect(out['organizationUuid']).toBe('00000000-0000-4000-8000-000000000001');
    expect((out['nested'] as Record<string, unknown>)['accountUuid']).toBe('00000000-0000-4000-8000-000000000001');
    expect((out['nested'] as Record<string, unknown>)['userID']).toBe('fake-id-2');
  });

  it('drops api-request-blob content and api-request-shape system; truncates tool_response > 8 KiB', () => {
    const s = createScrubber();
    const blob = s.value({ type: 'api-request-blob', message: { role: 'user', content: 'secret context' } }) as {
      message: { content: unknown; role: string };
    };
    expect(blob.message).toEqual({ role: 'user', content: '[dropped]' });
    const shape = s.value({ type: 'api-request-shape', shape: { system: 'big prompt', tools: 3 } }) as { shape: unknown };
    expect(shape.shape).toEqual({ system: '[dropped]', tools: 3 });
    const big = s.value({ tool_response: { stdout: 'x'.repeat(20_000) } }) as { tool_response: string };
    expect(typeof big.tool_response).toBe('string');
    expect(big.tool_response.length).toBeLessThan(8 * 1024 + 64);
    expect(big.tool_response).toContain('[truncated');
  });

  it('applies the SEC §8.2 redactor patterns', () => {
    const s = createScrubber();
    const out = s.string(
      'k=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA gh=ghp_' +
        'a'.repeat(36) +
        ' aws=AKIAABCDEFGHIJKLMNOP Authorization: Bearer abcdefghijklmnopqrstuvwxyz https://u:p@host/x GITHUB_TOKEN=abc',
    );
    expect(out).not.toMatch(/sk-ant-api03|ghp_a|AKIAABCD|abcdefghijklmnopqrstuvwxyz|u:p@|=abc\b/);
    expect(out).toContain('***:***@host');
  });

  it('replaces long hex / base64 runs with deterministic allow-listed fakes, consistently', () => {
    const s = createScrubber();
    const h = 'a'.repeat(31) + 'b' + 'c'.repeat(32);
    const out1 = s.string(`shapeHash ${h}`);
    const out2 = s.string(`again ${h}`);
    const fake = out1.split(' ')[1] ?? '';
    expect(fake).toMatch(/^cafe0+1$/);
    expect(fake).toHaveLength(h.length);
    expect(out2).toBe(`again ${fake}`);
    const sig = s.string('sig EqoBCkYIBxgCKkB3xYzQ9mN2pL8vR4tW6uI0oP5aS7dF1gH3jK');
    expect(sig).toMatch(/^sig FAKEb64x+0001$/);
    expect(lintText(out1 + sig)).toEqual([]);
  });

  it('scrubText keeps one record per line and non-JSON lines as text', () => {
    const out = scrubText('{"a":"/Users/zed/x"}\nnot json /Users/zed/y\n', { users: ['zed'] });
    expect(out).toBe('{"a":"/HOME/x"}\nnot json /HOME/y\n');
  });
});

describe('fixtures-scrub → fixtures-lint (P-SEC-23: whatever the scrubber emits, the lint accepts)', () => {
  const PLANTS = [
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'sk-ant-xy',
    'ghp_' + 'Z'.repeat(40),
    'ghs_short1',
    'github_pat_' + 'A1'.repeat(30),
    'AKIAABCDEFGHIJKLMNOP',
    'AKIAAB12',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA',
    'Proxy-Authorization: Basic dXNlcjpodW50ZXIy',
    '{"Proxy-Authorization":"Basic dXNlcjpodW50ZXIy"}',
    'X-CCD-Token: 0123456789abcdef0123456789abcdef',
    '{"headers":{"X-CCD-Token":"0123456789abcdef"}}',
    `ccd-selftest-${'9f'.repeat(16)}`,
    'jane.doe@corp.example.org',
    '/Users/jane/code',
    '/home/+odd/x',
    '/Users/a/x',
    'deadbeef'.repeat(5),
    'EqoBCkYIBxgCKkB3xYzQ9mN2pL8vR4tW6uI0oP5aS7dF1gH3jK',
  ];

  it('every planted secret / personal datum is gone after scrubbing and the result lints clean', () => {
    for (const p of PLANTS) {
      const out = scrubText(JSON.stringify({ s: `before ${p} after`, nested: { text: p } }));
      expect(lintText(out), `${p} → ${out}`).toEqual([]);
    }
    const auth = scrubText(JSON.stringify({ s: 'Proxy-Authorization: Basic dXNlcjpodW50ZXIy' }));
    expect(auth).not.toContain('dXNlcjpodW50ZXIy'); // the credential, not only the scheme word, is removed
  });

  it('a private key cut by the 8 KiB tool_response truncation is still removed', () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${'QUJD'.repeat(4000)}\n-----END RSA PRIVATE KEY-----`;
    const out = scrubText(JSON.stringify({ tool_response: { stdout: key } }));
    expect(out).not.toMatch(/PRIVATE KEY-----|QUJDQUJD/);
    expect(lintText(out)).toEqual([]);
  });

  it('property: random text mixed with planted fragments always scrubs to lint-clean output', () => {
    const fragment = fc.oneof(fc.constantFrom(...PLANTS), fc.string({ maxLength: 40 }), fc.constantFrom(' ', '\n', '"', ':', '/'));
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 12 }), (parts) => {
        const out = scrubText(JSON.stringify({ text: parts.join('') }));
        expect(lintText(out), out).toEqual([]);
      }),
      { numRuns: 300, seed: 14 },
    );
  });

  it('lint reads JSON lines decoded: escapes neither glue letters to fakes nor hide an e-mail', () => {
    const fake = `FAKEb64${'x'.repeat(21)}0001`;
    const hex = `cafe${'0'.repeat(27)}1`;
    expect(lintText(JSON.stringify({ t: `\n${fake}\b${hex}` }))).toEqual([]);
    expect(lintText('{"t":"jane\\u0040corp.io"}').map((f) => f.rule)).toEqual(['email']);
    expect(lintText('not json: jane@corp.io').map((f) => f.rule)).toEqual(['email']);
  });

  it('rules run to a fixed point: an e-mail glued to a base64 run still ends lint-clean', () => {
    const out = scrubText(JSON.stringify({ t: 'jane@corp.ioEqoBCkYIBxgCKkB3xYzQ9mN2pL8vR4tW6uI0oP5aS7dF1gH3jK' }));
    expect(lintText(out)).toEqual([]);
    expect(out).not.toContain('jane');
  });

  it('one-letter home dirs are rewritten but their name is not learned as a word to replace', () => {
    expect(scrubText('{"p":"/home/a/x","t":"a cat"}')).toBe('{"p":"/HOME/x","t":"a cat"}');
  });
});

describe('fixtures-lint', () => {
  it('fails on a planted e-mail and a planted home path (SEC §8.4 check 8)', () => {
    const f = lintText('{"x":"jane@corp.io","p":"/Users/jane/code"}');
    expect(f.map((x) => x.rule).sort()).toEqual(['email', 'home-path']);
  });

  it('fails on every listed secret shape and accepts the scrubber fakes', () => {
    const planted = [
      'sk-ant-xyz',
      'ghp_abc',
      'AKIAABCD',
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proxy-Authorization: x',
      'X-CCD-Token: y',
      `ccd-selftest-${'a'.repeat(32)}`,
      'f'.repeat(40),
      'EqoBCkYIBxgCKkB3xYzQ9mN2pL8vR4tW6uI0oP5aS7dF1gH3jK',
    ];
    for (const p of planted) expect(lintText(p).length, p).toBeGreaterThan(0);
    expect(
      lintText(
        `cafe${'0'.repeat(27)}1 FAKEb64${'x'.repeat(21)}0001 ccd-selftest-NONCE user@example.com /HOME/x 11111111-2222-4333-8444-555555555555`,
      ),
    ).toEqual([]);
  });
});

describe('fixtures-lint paths', () => {
  it('walks directories but skips fixtures/raw and fixtures/verify; a named file is always linted; a missing path is a finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccd-lint-'));
    try {
      for (const sub of ['traces', 'raw', 'verify']) mkdirSync(join(dir, 'fixtures', sub), { recursive: true });
      writeFileSync(join(dir, 'fixtures', 'traces', 'ok.ccd.jsonl'), '{"a":"/HOME/x"}\n');
      writeFileSync(join(dir, 'fixtures', 'raw', 'leak.ccd.jsonl'), '{"a":"/Users/jane/x"}\n');
      writeFileSync(join(dir, 'fixtures', 'verify', 'leak.jsonl'), '{"a":"jane@corp.io"}\n');
      expect(lintPaths([join(dir, 'fixtures')])).toEqual([]);
      const named = lintPaths([join(dir, 'fixtures', 'raw', 'leak.ccd.jsonl')]);
      expect(named.map((f) => f.rule)).toEqual(['home-path']);
      expect(lintPaths([join(dir, 'nope')]).map((f) => f.rule)).toEqual(['missing-path']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the default scope (all of fixtures/ except raw/verify) is clean in the repo', () => {
    expect(lintPaths([join(ROOT, 'fixtures')])).toEqual([]);
  });
});

describe('fixtures-from-verify and the committed traces', () => {
  const names = existsSync(TRACES)
    ? readdirSync(TRACES)
        .filter((f) => f.endsWith('.ccd.jsonl'))
        .sort()
    : [];

  it('built the initial §6.6 set (verify corpus + probe dirs)', () => {
    const want = [
      'hook-allow',
      'hook-held-35s',
      'hook-timeout-then-keys',
      'hook-deny',
      'hook-endpoint-down',
      'pre-hook-timeout',
      'clear-generation-switch',
      'message-display-3-chunks',
      'trust-dialog',
      'startup-automode',
      'bg-agents-task-notification',
      'esc-interrupt-after-tool',
      'esc-at-permission',
      'ghost-agent-after-stop',
      'retry-storm',
    ];
    expect(names.map((n) => n.replace('.ccd.jsonl', '')).sort()).toEqual([...want].sort());
  });

  it.each(names)('%s parses as a v1 trace with tz and CoreInit in the header, and lints clean', (name) => {
    const text = readFileSync(join(TRACES, name), 'utf8');
    const t = parseTrace(text);
    expect(t.header.tz).toBe('Asia/Kolkata');
    expect(t.header.coreInit.config).toEqual(DEFAULT_TEST_CORE_CONFIG);
    expect(t.records.filter((r) => r.r === 'raw').length).toBeGreaterThan(0);
    expect(lintText(text)).toEqual([]);
    expect(text).not.toMatch(/\/(?:Users|home)\/[A-Za-z]/);
  });

  it('core-config.default.json is the testing kit’s DEFAULT_TEST_CORE_CONFIG', () => {
    expect(JSON.parse(readFileSync(join(TRACES, 'core-config.default.json'), 'utf8'))).toEqual(DEFAULT_TEST_CORE_CONFIG);
  });

  it('hook records follow the transport rule: SessionStart/PermissionRequest unix (holdable), the rest http', () => {
    const t = parseTrace(readFileSync(join(TRACES, 'hook-allow.ccd.jsonl'), 'utf8'));
    const hooks = t.records.flatMap((r) =>
      r.r === 'raw' && r.ch === 'hook' ? [r.data as { event: string; transport: string; holdable: boolean }] : [],
    );
    expect(hooks.length).toBeGreaterThan(3);
    for (const h of hooks) {
      const unix = h.event === 'SessionStart' || h.event === 'PermissionRequest';
      expect(h.transport, h.event).toBe(unix ? 'unix' : 'http');
      expect(h.holdable).toBe(h.event === 'PermissionRequest');
    }
  });

  it('readFrames splits a capture log at `=== <epoch>` separators', () => {
    const frames = readFrames(join(ROOT, 'fixtures', 'verify', 'screen-B.log'));
    expect(frames.length).toBeGreaterThan(3);
    expect(frames[0]?.t).toBeGreaterThan(1_700_000_000_000);
    expect(frames[0]?.lines.some((l) => l.includes('Accessing workspace:'))).toBe(true);
  });
});
