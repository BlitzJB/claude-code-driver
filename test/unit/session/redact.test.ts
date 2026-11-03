// session/redact.ts — exact-token masking first, SEC §8.2 patterns, meta summaries, redactEvent, fixture scrubbing
// (P-SEC-22, P-SEC-41, P-API-20; ICR 0014 item 5).
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../../src/model/events.js';
import {
  CONTENT_KEYS,
  EMAIL_FAKE,
  REDACTED,
  createFixtureScrubber,
  createRedactor,
  redactEvent,
  sha256_8,
  summarize,
} from '../../../src/session/redact.js';

const HOOK_TOKEN = 'a'.repeat(16) + '0123456789abcdef'.repeat(3);

describe('redactor: exact secrets first (SEC §8.2 layer 1)', () => {
  it('masks every registered library secret wherever it appears, longest first', () => {
    const r = createRedactor({ secrets: [HOOK_TOKEN] });
    r.addSecret('proxy-secret-xyz');
    r.addSecret('short'); // < 8 chars: ignored (would mask ordinary words)
    expect(r.secretCount).toBe(2);
    expect(r.string(`X-CCD-Token ${HOOK_TOKEN} and http://ccd:proxy-secret-xyz@127.0.0.1:1`)).not.toContain(HOOK_TOKEN);
    expect(r.string('a proxy-secret-xyz b')).toBe(`a ${REDACTED} b`);
    expect(r.string('short stays')).toBe('short stays');
    const both = createRedactor({ secrets: ['abcdefgh', 'abcdefghijkl'] });
    expect(both.string('xx abcdefghijkl yy')).toBe(`xx ${REDACTED} yy`);
  });
});

describe('redactor: patterns (SEC §8.2 layer 2)', () => {
  const r = createRedactor();
  it.each([
    ['sk-ant-api03-' + 'A'.repeat(30), 'sk-ant-'],
    ['ghp_' + 'a'.repeat(36), 'ghp_'],
    ['github_pat_' + 'a'.repeat(60), 'github_pat_'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIA'],
    ['xoxb-1234567890-abcdef', 'xoxb-'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', 'MIIE'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'eyJ'],
    ['curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"', 'abcdefghijklmnop'],
    ['Proxy-Authorization: Basic Y2N0OnNlY3JldA==', 'Y2N0'],
    ['https://user:pa55word@example.org/x', 'pa55word'],
    ['export GITHUB_TOKEN=abc123 && API_KEY=zzz', 'abc123'],
  ])('%s is redacted', (input, secret) => {
    expect(r.string(input)).not.toContain(secret);
  });

  it('keeps URL structure for userinfo and e-mails become user@example.com', () => {
    expect(r.string('https://user:pw@host.example/p')).toBe('https://***:***@host.example/p');
    expect(r.string('mail me at someone@corp.io')).toBe(`mail me at ${EMAIL_FAKE}`);
    expect(r.string('x@example.com')).toBe('x@example.com');
  });

  it('leaves ordinary text alone', () => {
    expect(r.string('ls -la /tmp && echo done')).toBe('ls -la /tmp && echo done');
  });
});

describe('redactor: structured values', () => {
  const r = createRedactor({ secrets: [HOOK_TOKEN] });
  it('value(): deep copy, secret-named keys masked, cycles and exotic values handled, total', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = cyc;
    const v = r.value({
      token: 'tok-1234567890',
      nested: { authorization: 'Bearer x', ok: `t=${HOOK_TOKEN}` },
      list: [1, 'two', undefined, () => 1],
      n: Number.NaN,
      big: 10n,
      err: new Error(`failed with ${HOOK_TOKEN}`),
      map: new Map([['k', 'v']]),
      set: new Set(['s']),
      buf: new Uint8Array(Buffer.from('bytes')),
      cyc,
    });
    expect(v).toMatchObject({
      token: REDACTED,
      nested: { authorization: REDACTED, ok: `t=${REDACTED}` },
      list: [1, 'two', null, null],
      n: null,
      big: '10',
      err: { name: 'Error', message: `failed with ${REDACTED}` },
      map: [['k', 'v']],
      set: ['s'],
      buf: 'bytes',
      cyc: { a: 1, self: '[Circular]' },
    });
  });

  it('meta(): content keys become {len, sha256_8}, metadata stays (raw:meta default, P-API-20)', () => {
    const m = r.meta({ text: 'secret prompt', toolName: 'Bash', input: { command: 'cat .env' }, bytes: 12 }) as Record<string, unknown>;
    expect(m['text']).toEqual({ len: 13, sha256_8: sha256_8('secret prompt') });
    expect(m['input']).toEqual(summarize({ command: 'cat .env' }));
    expect(m['toolName']).toBe('Bash');
    expect(m['bytes']).toBe(12);
    expect(CONTENT_KEYS.has('delta')).toBe(true);
    expect(summarize(undefined)).toEqual({ len: 9, sha256_8: sha256_8('undefined') });
  });

  it('env(): values masked by name, URL userinfo always masked (SEC §8.2 layer 3)', () => {
    expect(
      r.env({
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'x',
        HTTPS_PROXY: 'http://ccd:abc@127.0.0.1:1',
        NO_PROXY: '',
        SOME_URL: 'http://u:p@h/x',
        EMPTY_TOKEN: '',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      GITHUB_TOKEN: REDACTED,
      HTTPS_PROXY: REDACTED,
      NO_PROXY: '',
      SOME_URL: 'http://***:***@h/x',
      EMPTY_TOKEN: '',
    });
  });

  it('redactEvent(): envelope kept, content summarized (P-SEC-41)', () => {
    const e = {
      v: 1,
      seq: 3,
      type: 'turn.queued',
      at: 1,
      wallAt: 2,
      sessionKey: 's1',
      provenance: { confirmed: true, sources: ['self'] },
      causedBy: [1],
      payload: { prompt: 'deploy with key sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx', origin: 'library' },
    } as unknown as DomainEvent;
    const out = redactEvent(e) as Record<string, unknown>;
    expect(out['seq']).toBe(3);
    expect(out['type']).toBe('turn.queued');
    expect(JSON.stringify(out)).not.toContain('deploy');
    expect((out['payload'] as Record<string, unknown>)['origin']).toBe('library');
  });
});

describe('fixture scrubber (fixtures:scrub forms)', () => {
  it('rewrites homes, users, tmp, e-mails, nonces, tokens, ids, hex and base64 runs into lint-allowed fakes', () => {
    const s = createFixtureScrubber({ home: '/Users/alice', user: 'alice', tmpDir: '/var/folders/ab/cdef/T', tokens: [HOOK_TOKEN] });
    const out = s.value({
      path: '/Users/alice/proj/x.ts',
      other: '/home/bob/y and bob again',
      tmp: '/var/folders/ab/cdef/T/ccd-1/sock',
      mail: 'alice@corp.io',
      nonce: `ccd-selftest-${'0123456789abcdef'.repeat(2)}`,
      hdr: `X-CCD-Token: ${HOOK_TOKEN}`,
      'X-CCD-Token': 'dropped entirely',
      token: 'tok',
      accountUuid: '12345678-1234-4123-8123-123456789abc',
      hex: 'f'.repeat(40),
      b64: 'QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890abcXYZ',
      key: 'sk-ant-api03-abcdef',
    }) as Record<string, string>;
    expect(out['path']).toBe('/HOME/proj/x.ts');
    expect(out['other']).toBe('/HOME/y and user again');
    expect(out['tmp']).toBe('/TMP/ccd-1/sock');
    expect(out['mail']).toBe('user@example.com');
    expect(out['nonce']).toBe('ccd-selftest-NONCE');
    expect(out['hdr']).not.toContain(HOOK_TOKEN);
    expect(out['hdr']).not.toMatch(/x-ccd-token/i);
    expect('X-CCD-Token' in out).toBe(false);
    expect(out['token']).toBe('TOKEN');
    expect(out['accountUuid']).toBe('00000000-0000-4000-8000-000000000001');
    expect(out['hex']).toMatch(/^cafe0+[0-9a-f]{1,8}$/);
    expect(out['b64']).toMatch(/^FAKEb64x+[0-9]{4,}$/);
    expect(out['key']).toBe('ANTHROPIC_KEY_REDACTED');
  });

  it('is consistent within one scrubber (same original → same fake)', () => {
    const s = createFixtureScrubber();
    const a = s.string('e'.repeat(32));
    expect(s.string(`x ${'e'.repeat(32)} y`)).toBe(`x ${a} y`);
    expect(s.string('d'.repeat(32))).not.toBe(a);
  });
});
