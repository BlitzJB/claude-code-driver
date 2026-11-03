// WP-01 tmux/args.ts: P-TMUX-03, P-TMUX-04 (18 edge strings, TD §2.2), P-TMUX-05, P-TMUX-16, P-TMUX-34, P-INPUT-39.
import { describe, expect, it } from 'vitest';
import {
  argvBytes,
  commandList,
  commandNames,
  ENV_NAME_RE,
  escapeArg,
  exactTarget,
  lit,
  SAFE_PATH_RE,
  SEP,
  SESSION_NAME_RE,
  SOCKET_NAME_RE,
  toArgv,
} from '../../../src/platform/tmux/args.js';

describe('escapeArg (P-TMUX-04, TD §2.2 table, VERIFIED on tmux 3.5a)', () => {
  // [want delivered, argv element we must pass]
  const rows: [string, string][] = [
    ['a;', 'a\\;'],
    [';', '\\;'],
    [';;', ';\\;'],
    ['x;;', 'x;\\;'],
    ['a;b;', 'a;b\\;'],
    ['a\\;', 'a\\\\;'],
    ['a\\\\;', 'a\\\\\\;'],
    ['a;b', 'a;b'],
    ['a; b', 'a; b'],
    ['a;\n', 'a;\n'],
    ['\\;x', '\\;x'],
    ['\\', '\\'],
    ['a\\', 'a\\'],
    ['{', '{'],
    ['}', '}'],
    ['%if', '%if'],
    ['%hidden', '%hidden'],
    ['$X', '$X'],
    ['~', '~'],
    ["'", "'"],
    ['"', '"'],
  ];
  it.each(rows)('%j is passed as %j', (want, arg) => {
    expect(escapeArg(want)).toBe(arg);
  });

  it('is applied to every literal element of an invocation, never to separators', () => {
    expect(toArgv([lit('send-keys'), lit('-l'), lit('--'), lit('end;'), SEP, lit('x;')])).toEqual([
      'send-keys',
      '-l',
      '--',
      'end\\;',
      ';',
      'x\\;',
    ]);
  });
});

describe('commandList builder (P-TMUX-03/05, P-INPUT-39, P-TMUX-34)', () => {
  it('emits flags before positionals and -- before free text', () => {
    const argv = toArgv(commandList([{ name: 'send-keys', flags: [['-t', '%3'], ['-l']], positional: ['-x'], endOfFlags: true }]));
    expect(argv).toEqual(['send-keys', '-t', '%3', '-l', '--', '-x']);
  });

  it('joins commands with exactly one SEP and never lets text become a separator', () => {
    const args = commandList([
      { name: 'load-buffer', flags: [['-b', 'ccd-0-1']], positional: ['-'] },
      { name: 'paste-buffer', flags: [['-t', '%0'], ['-b', 'ccd-0-1'], ['-d'], ['-p'], ['-r']] },
    ]);
    expect(toArgv(args)).toEqual(['load-buffer', '-b', 'ccd-0-1', '-', ';', 'paste-buffer', '-t', '%0', '-b', 'ccd-0-1', '-d', '-p', '-r']);
    expect(commandNames(args)).toEqual(['load-buffer', 'paste-buffer']);
    // a positional ';' is a literal, escaped
    expect(toArgv(commandList([{ name: 'send-keys', flags: [['-l']], positional: [';'], endOfFlags: true }]))).toEqual([
      'send-keys',
      '-l',
      '--',
      '\\;',
    ]);
  });

  it('rejects malformed command names and flags (no injection through the builder)', () => {
    expect(() => commandList([{ name: 'send-keys; kill-server' }])).toThrow(TypeError);
    expect(() => commandList([{ name: 'send-keys', flags: [['-tt']] }])).toThrow(TypeError);
    expect(() => commandList([{ name: 'send-keys', flags: [['t']] }])).toThrow(TypeError);
  });

  it('counts argv bytes in UTF-8 plus one NUL per element', () => {
    expect(argvBytes(['ab', '日'])).toBe(2 + 1 + 3 + 1);
  });
});

describe('names and targets (P-TMUX-15, P-TMUX-16, P-TMUX-38)', () => {
  it('session names are ccd- plus [a-z0-9-] only', () => {
    expect(SESSION_NAME_RE.test('ccd-s1a2b3c4d')).toBe(true);
    for (const bad of ['ccd-a.b', 'ccd-a:b', 'CCD-x', 'ccd-', 'x-ccd', 'ccd-a b', 'ccd-=x', `ccd-${'a'.repeat(61)}`])
      expect(SESSION_NAME_RE.test(bad)).toBe(false);
  });

  it('socket names are short names, never paths', () => {
    expect(SOCKET_NAME_RE.test('ccd-1a2b-deadbeef')).toBe(true);
    expect(SOCKET_NAME_RE.test('/tmp/x')).toBe(false);
    expect(SOCKET_NAME_RE.test('ccd-../x')).toBe(false);
  });

  it('exact targets use =name: (prefix matching and the missing colon bite, TD §6)', () => {
    expect(exactTarget('ccd-abc')).toBe('=ccd-abc:');
  });

  it('env names and safe paths', () => {
    expect(ENV_NAME_RE.test('LC_ALL')).toBe(true);
    expect(ENV_NAME_RE.test('A=B')).toBe(false);
    expect(SAFE_PATH_RE.test('/Users/me/.local/state/claude-code-driver/exits/s1.log')).toBe(true);
    expect(SAFE_PATH_RE.test("/tmp/x'; rm -rf ~")).toBe(false);
    expect(SAFE_PATH_RE.test('/tmp/a b')).toBe(false);
  });
});
