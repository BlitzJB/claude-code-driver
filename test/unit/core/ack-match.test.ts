// core/input-policy/ack-match.ts — §3.6 step 5 ack order, IN §7.2, LP-54 (P-INPUT-11, P-INPUT-14, P-REV-22).
import { describe, expect, it } from 'vitest';
import {
  ackMatches,
  classifyAck,
  classifyExternalShape,
  editDistanceBucket,
  fnv1a32,
  normalizeForAck,
  sha256Hex,
  stripPastedContentWrappers,
} from '../../../src/core/input-policy/ack-match.js';

describe('normalizeForAck', () => {
  it('trims trailing whitespace per line and at the end, keeps leading whitespace (P-INPUT-11, LP-54)', () => {
    expect(normalizeForAck('  a  \n b \t\n\n')).toBe('  a\n b');
    expect(ackMatches(' !x', ' !x  ')).toBe(true);
    expect(ackMatches(' !x', '!x')).toBe(false);
  });
  it('NFC and CRLF are normalized', () => {
    expect(ackMatches('é\r\nx', 'é\nx')).toBe(true);
  });
  it('strips <pasted_content> wrappers (P-INPUT-14)', () => {
    const wrapped = 'intro\n\n<pasted_content id="abc">\nbody line\n</pasted_content id="abc">\n\noutro';
    expect(stripPastedContentWrappers(wrapped)).toBe('introbody lineoutro');
    expect(ackMatches('<pasted_content id="1">\nhello\n</pasted_content id="1">', 'hello')).toBe(true);
  });
});

describe('classifyAck order (§3.6 step 5)', () => {
  const nonce = 'ccd-selftest-00112233445566778899aabbccddeeff';
  it('1. the self-test nonce wins over everything', () => {
    expect(classifyAck(nonce, { nonces: [nonce], sent: nonce })).toEqual({ kind: 'selftest', nonce });
  });
  it('2. known external shapes are never compared with ours', () => {
    expect(classifyAck('<task-notification><task-id>a1</task-id></task-notification>', { nonces: [], sent: 'hi' })).toEqual({
      kind: 'external',
      origin: 'task_notification',
    });
    expect(classifyAck('anything', { nonces: [], sent: 'hi', hasTaskNotification: true })).toEqual({
      kind: 'external',
      origin: 'task_notification',
    });
    expect(classifyExternalShape('<scheduled-task>x')).toBe('scheduled');
    expect(classifyExternalShape('<peer-message from="x">hi')).toBe('peer_message');
    expect(classifyExternalShape('<bash-input>ls</bash-input>')).toBe('bash_mode');
    expect(classifyExternalShape('plain')).toBeUndefined();
  });
  it('3. match', () => {
    expect(classifyAck('fix the bug \n', { nonces: [], sent: 'fix the bug' })).toEqual({ kind: 'match' });
  });
  it('4. mismatch carries digests and an edit-distance bucket, never the texts', () => {
    const v = classifyAck('fix the bugs', { nonces: [], sent: 'fix the bug' });
    expect(v.kind).toBe('mismatch');
    if (v.kind !== 'mismatch') return;
    expect(v.detail.sentSha256_16).toBe(sha256Hex('fix the bug').slice(0, 16));
    expect(v.detail.gotSha256_16).toHaveLength(16);
    expect(v.detail.editDistanceBucket).toBe('1-2');
  });
  it('no in-flight submit → unsolicited', () => {
    expect(classifyAck('hello', { nonces: [] })).toEqual({ kind: 'unsolicited' });
  });
});

describe('digests', () => {
  it('sha256 matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('é👩‍💻')).toHaveLength(64);
  });
  it('fnv1a32 matches known vectors and is deterministic', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
  it('edit distance buckets', () => {
    expect(editDistanceBucket('a', 'a')).toBe('0');
    expect(editDistanceBucket('abc', 'xyz')).toBe('3-10');
    expect(editDistanceBucket('a'.repeat(50), 'b'.repeat(50))).toBe('11-100');
    expect(editDistanceBucket('a'.repeat(200), 'b'.repeat(200))).toBe('>100');
  });
});
