// Shared TmuxServerFactory contract (DESIGN.md §2.7 "Fakes", §6.4 tmux row). Run against FakeTmux and the real driver by
// tmux.contract.test.ts. The program in the pane is `rawecho`: a node one-liner that, like Claude, requests modifyOtherKeys
// and the kitty keyboard protocol (LP-52), enables bracketed paste, prints ENV/CWD/READY, and logs every read it gets as one
// JSON line (TD R20). The fake simulates the same program, so both sides are checked against the same byte expectations.
// Waits are condition polls with ceilings, never fixed sleeps (§6.5 rule, rev 2 §10 D6).
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { Cancel, Clock, MonoMs, WallMs } from '../../src/model/time.js';
import type { PaneSpawnOptions, TmuxPane, TmuxServer, TmuxServerFactory } from '../../src/platform/ports.js';
import { TmuxArgTooLong, TmuxDuplicate, TmuxInvalidInput, TmuxPaneDead, TmuxPaneInMode } from '../../src/platform/tmux/errors.js';
import { FakeTmux, type FakeProgram } from '../../src/platform/tmux/fake-tmux.js';
import { createTmuxServerFactory } from '../../src/platform/tmux/server.js';
import { parseTmuxVersion, versionAtLeast } from '../../src/platform/tmux/version.js';

// ------------------------------------------------------------------ the pane programs

/** One line of CommonJS (`node -e`): argv[1] is the log file. Ends with ';' on purpose (exercises escapeArg on argv). */
const RAWECHO_JS = [
  "const fs=require('fs');const log=process.argv[1];",
  'process.stdin.setRawMode(true);',
  "process.stdout.write('\\x1b[>4;2m\\x1b[>5u\\x1b[?2004h');",
  "process.stdout.write('ENV:'+JSON.stringify({FOO:process.env.CCD_CT_FOO??null,SECRET:process.env.CCD_CT_SECRET??null,TMUX:process.env.TMUX!==undefined})+'\\r\\n');",
  "process.stdout.write('CWD:'+process.cwd()+'\\r\\n');",
  "process.stdout.write('READY\\r\\n');",
  "process.stdin.on('data',d=>{const s=d.toString('utf8');fs.appendFileSync(log,JSON.stringify(s)+'\\n');process.stdout.write('RX:'+JSON.stringify(s).slice(0,200)+'\\r\\n');});",
].join('');

const EXIT42: [string, string, ...string[]] = ['/bin/sh', '-c', 'exit 42'];
const SIGTERM_SELF: [string, string, ...string[]] = ['/bin/sh', '-c', 'kill -TERM $$'];

// ------------------------------------------------------------------ harness

export interface TmuxHarness {
  readonly label: string;
  readonly factory: TmuxServerFactory;
  readonly cwd: string;
  readonly tmuxPath: string;
  readonly version: string;
  readonly clientEnv: Readonly<Record<string, string>>;
  freshSocketName(): string;
  exitLogPath(): string;
  rawechoArgv(): { argv: [string, string, ...string[]]; log: string };
  /** Every read the program got, in order. */
  received(log: string): string[];
  readExitLog(path: string): string[];
  socketFileExists(path: string): boolean;
  enterCopyMode(server: TmuxServer, pane: TmuxPane): Promise<void>;
  crashServer(server: TmuxServer): Promise<void>;
  showOption(server: TmuxServer, pane: TmuxPane, scope: '-s' | '-g' | '-w', name: string): Promise<string>;
  listBuffers(server: TmuxServer): Promise<string[]>;
  /** Max time a condition poll may take (fake: immediate). */
  readonly ceilingMs: number;
  cleanup(): Promise<void>;
}

export async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ceilingMs: number, what: string): Promise<T> {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${ceilingMs} ms waiting for ${what}; last value: ${inspect(v, { depth: 2 }).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function realClock(): Clock {
  const t0 = Date.now();
  return {
    now: () => (performance.now() + t0) as MonoMs,
    wallNow: () => Date.now() as WallMs,
    setTimer: (at: MonoMs, fn: () => void): Cancel => {
      const h = setTimeout(fn, Math.max(0, at - (performance.now() + t0)));
      return () => {
        clearTimeout(h);
      };
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}

function shortId(): string {
  return `${process.pid.toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** The fake world: FakeTmux with a rawecho/exit program simulator. */
export function makeFakeHarness(): TmuxHarness {
  const logs = new Map<string, string[]>();
  const program = (argv: readonly string[]): FakeProgram => {
    if (argv[1] === '-e' && argv[2] === RAWECHO_JS) {
      const log = argv[3] ?? '';
      logs.set(log, []);
      return {
        start(io) {
          io.setBracketedPaste(true);
          io.print(
            `ENV:${JSON.stringify({ FOO: io.env['CCD_CT_FOO'] ?? null, SECRET: io.env['CCD_CT_SECRET'] ?? null, TMUX: io.env['TMUX'] !== undefined })}`,
          );
          io.print(`CWD:${io.cwd}`);
          io.print('READY');
        },
        input(bytes, io) {
          logs.get(log)?.push(bytes);
          io.print(`RX:${JSON.stringify(bytes).slice(0, 200)}`);
        },
      };
    }
    if (argv.join(' ') === EXIT42.join(' '))
      return {
        start: (io) => {
          io.exit(42);
        },
      };
    if (argv.join(' ') === SIGTERM_SELF.join(' '))
      return {
        start: (io) => {
          io.exit(null, 'SIGTERM');
        },
      };
    return {};
  };
  const fake = new FakeTmux({ clock: realClock(), program });
  let n = 0;
  return {
    label: 'FakeTmux',
    factory: fake,
    cwd: '/private/tmp/ccd-contract-cwd',
    tmuxPath: '/opt/homebrew/bin/tmux',
    version: '3.5a',
    clientEnv: { CCD_CT_SECRET: 'sekrit', TMUX: '/tmp/tmux-501/default,1,0', LC_ALL: 'en_US.UTF-8' },
    freshSocketName: () => `ccd-ct-${shortId()}-${n++}`,
    exitLogPath: () => `/private/tmp/ccd-ct-exits-${n++}.log`,
    rawechoArgv: () => {
      const log = `/fake/rawecho-${n++}.jsonl`;
      return { argv: ['/usr/local/bin/node', '-e', RAWECHO_JS, log], log };
    },
    received: (log) => [...(logs.get(log) ?? [])],
    readExitLog: (p) => fake.exitLogLines(p),
    socketFileExists: (p) => fake.socketExists(p),
    enterCopyMode: (server, pane) => {
      const p = fake.server(server.socketName)?.panes.find((x) => x.info.paneId === pane.info.paneId);
      p?.enterCopyMode();
      return Promise.resolve();
    },
    crashServer: (server) => {
      fake.server(server.socketName)?.vanish();
      return Promise.resolve();
    },
    showOption: (server, _pane, _scope, name) => Promise.resolve(fake.server(server.socketName)?.options.get(name) ?? ''),
    listBuffers: (server) => Promise.resolve([...(fake.server(server.socketName)?.buffers ?? [])]),
    ceilingMs: 200,
    cleanup: () => Promise.resolve(),
  };
}

/** Locate a real tmux ≥ 3.2 (CCD_TMUX_BIN wins, as in the CI min-version job). */
export function findRealTmux(): { path: string; version: string } | undefined {
  const candidates = [process.env['CCD_TMUX_BIN'], '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].filter(
    (x): x is string => x !== undefined && x !== '',
  );
  for (const c of candidates) {
    try {
      const out = execFileSync(c, ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const v = parseTmuxVersion(out);
      if (v !== undefined && versionAtLeast(v, 3, 2)) return { path: c, version: v.raw };
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** The real world: private sockets `ccd-ct-*`, a 0700 temp dir, everything killed and removed in cleanup(). */
export function makeRealHarness(tmux: { path: string; version: string }): TmuxHarness {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-ct-')));
  const sockets = new Set<string>();
  const clientEnv: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    LC_ALL: 'en_US.UTF-8',
    CCD_CT_SECRET: 'sekrit',
    TMUX: '/tmp/tmux-501/not-ours,1,0', // must never reach the tmux client
  };
  const factory = createTmuxServerFactory({ clock: realClock(), env: { PATH: '' } });
  let n = 0;
  const tmuxRun = (server: TmuxServer, args: string[]): string =>
    execFileSync(tmux.path, ['-u', '-L', server.socketName, '-f', '/dev/null', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return {
    label: `tmux ${tmux.version}`,
    factory,
    cwd: dir,
    tmuxPath: tmux.path,
    version: tmux.version,
    clientEnv,
    freshSocketName: () => {
      const s = `ccd-ct-${shortId()}-${n++}`;
      sockets.add(s);
      return s;
    },
    exitLogPath: () => join(dir, `exits-${n++}.log`),
    rawechoArgv: () => {
      const log = join(dir, `rawecho-${n++}.jsonl`);
      return { argv: [process.execPath, '-e', RAWECHO_JS, log], log };
    },
    received: (log) =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => JSON.parse(l) as string)
        : [],
    readExitLog: (p) =>
      existsSync(p)
        ? readFileSync(p, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
        : [],
    socketFileExists: (p) => existsSync(p),
    enterCopyMode: (server, pane) => {
      tmuxRun(server, ['copy-mode', '-t', pane.info.paneId]);
      return Promise.resolve();
    },
    crashServer: (server) => {
      const pid = Number(tmuxRun(server, ['display-message', '-p', '#{pid}']).trim());
      process.kill(pid, 'SIGKILL');
      return waitFor(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        (x) => x,
        3000,
        'tmux server death',
      ).then(() => undefined);
    },
    showOption: (server, pane, scope, name) =>
      Promise.resolve(
        tmuxRun(
          server,
          scope === '-w' ? ['show-options', '-w', '-v', '-t', pane.info.paneId, name] : ['show-options', scope, '-v', name],
        ).trim(),
      ),
    listBuffers: (server) => {
      try {
        return Promise.resolve(
          tmuxRun(server, ['list-buffers', '-F', '#{buffer_name}'])
            .split('\n')
            .filter((l) => l !== ''),
        );
      } catch {
        return Promise.resolve([]);
      }
    },
    ceilingMs: 8000,
    cleanup: () => {
      for (const s of sockets) {
        try {
          execFileSync(tmux.path, ['-L', s, '-f', '/dev/null', 'kill-server'], { stdio: 'ignore' });
        } catch {
          /* already gone */
        }
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        for (const base of ['/tmp', '/private/tmp']) rmSync(join(base, `tmux-${uid}`, s), { force: true });
      }
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

/** Spawn a control-mode client that shrinks its size (real only; P-TMUX-18). Returns a stop function. */
export function attachShrinkingControlClient(tmuxPath: string, server: TmuxServer, sessionName: string): () => void {
  const child = spawn(tmuxPath, ['-u', '-L', server.socketName, '-f', '/dev/null', '-C', 'attach', '-t', `=${sessionName}:`], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.write('refresh-client -C 100x30\n');
  return () => {
    child.stdin.end();
    child.kill('SIGKILL');
  };
}

// ------------------------------------------------------------------ the suite

export function defineTmuxContract(makeHarness: () => TmuxHarness): void {
  const h = makeHarness();

  describe(`TmuxServerFactory contract — ${h.label}`, () => {
    const servers: TmuxServer[] = [];
    afterAll(async () => {
      for (const s of servers) await s.kill().catch(() => undefined);
      await h.cleanup();
    });

    async function newServer(
      over: Partial<{ historyLimit: number; paneDiedLogPath: string }> = {},
    ): Promise<{ server: TmuxServer; exitLog: string }> {
      const exitLog = over.paneDiedLogPath ?? h.exitLogPath();
      const { path } = await h.factory.probe(h.tmuxPath);
      const server = await h.factory.create({
        tmuxPath: path,
        socketName: h.freshSocketName(),
        clientEnv: h.clientEnv,
        historyLimit: over.historyLimit ?? 5000,
        paneDiedLogPath: exitLog,
      });
      servers.push(server);
      return { server, exitLog };
    }

    function opts(argv: [string, string, ...string[]], over: Partial<PaneSpawnOptions> = {}): PaneSpawnOptions {
      return {
        sessionName: `ccd-c${servers.length}`,
        argv,
        cwd: h.cwd,
        cols: 250,
        rows: 80,
        nonSecretEnv: { CCD_CT_FOO: 'bar;' },
        ...over,
      };
    }

    async function rawecho(): Promise<{ server: TmuxServer; pane: TmuxPane; log: string; exitLog: string }> {
      const { server, exitLog } = await newServer();
      const { argv, log } = h.rawechoArgv();
      const pane = await server.spawnPane(opts(argv));
      await waitFor(
        () => pane.capture(),
        (c) => c.lines.some((l) => l.trimEnd() === 'READY'),
        h.ceilingMs,
        'READY',
      );
      return { server, pane, log, exitLog };
    }

    const rx = (log: string, n: number, what: string) =>
      waitFor(
        () => h.received(log),
        (r) => r.length >= n,
        h.ceilingMs,
        what,
      );

    it('probe reports the binary and a supported version', async () => {
      const p = await h.factory.probe(h.tmuxPath);
      expect(p.path).toBe(h.tmuxPath);
      const v = parseTmuxVersion(`tmux ${p.version}`);
      expect(v !== undefined && versionAtLeast(v, 3, 2)).toBe(true);
    });

    it('create validates names and paths', async () => {
      const { path } = await h.factory.probe(h.tmuxPath);
      const base = { tmuxPath: path, clientEnv: h.clientEnv, historyLimit: 100 };
      await expect(h.factory.create({ ...base, socketName: '/abs/sock', paneDiedLogPath: h.exitLogPath() })).rejects.toBeInstanceOf(
        TmuxInvalidInput,
      );
      await expect(h.factory.create({ ...base, socketName: h.freshSocketName(), paneDiedLogPath: '/tmp/x y.log' })).rejects.toBeInstanceOf(
        TmuxInvalidInput,
      );
    });

    it('spawn: %N pane of the requested size, alive, inline screen, read-only view command', async () => {
      const { server, pane } = await rawecho();
      expect(pane.info.paneId).toMatch(/^%\d+$/);
      expect(pane.info.pid).toBeGreaterThan(0);
      expect(pane.info.sessionId).toMatch(/^\$\d+$/);
      expect(pane.info.windowId).toMatch(/^@\d+$/);
      expect([pane.info.cols, pane.info.rows]).toEqual([250, 80]);
      const st = await pane.status();
      expect(st).toMatchObject({ exists: true, dead: false, inMode: false, alternateOn: false, cols: 250, rows: 80 });
      expect(pane.viewCommand()).toContain(`-L ${server.socketName} attach -r -t '=ccd-`);
      expect(server.version).toBe(h.version);
    });

    it('the prelude pins every option the input and screen safety relies on', async () => {
      const { server, pane } = await rawecho();
      expect(await h.showOption(server, pane, '-s', 'set-clipboard')).toBe('off');
      expect(await h.showOption(server, pane, '-s', 'extended-keys')).toBe('off');
      expect(await h.showOption(server, pane, '-s', 'focus-events')).toBe('off');
      expect(await h.showOption(server, pane, '-g', 'history-limit')).toBe('5000');
      expect(await h.showOption(server, pane, '-g', 'remain-on-exit')).toBe('on');
      expect(await h.showOption(server, pane, '-g', 'status')).toBe('off');
      expect(await h.showOption(server, pane, '-g', 'mouse')).toBe('off');
      expect(await h.showOption(server, pane, '-w', 'window-size')).toBe('manual');
      const v = parseTmuxVersion(`tmux ${h.version}`);
      if (v !== undefined && versionAtLeast(v, 3, 3)) expect(await h.showOption(server, pane, '-g', 'allow-passthrough')).toBe('off');
    });

    it('the pane gets the client env (secrets) and -e extras, runs in cwd; the caller TMUX never reaches tmux', async () => {
      const { pane } = await rawecho();
      const c = await pane.capture();
      const env = c.lines.find((l) => l.startsWith('ENV:'))?.trimEnd();
      expect(env).toBe(`ENV:${JSON.stringify({ FOO: 'bar;', SECRET: 'sekrit', TMUX: true })}`);
      expect(c.lines.find((l) => l.startsWith('CWD:'))?.trimEnd()).toBe(`CWD:${h.cwd}`);
    });

    it('paste: bracketed, LF kept (-r), CRLF normalised, trailing ; intact, buffer deleted, no Enter', async () => {
      const { server, pane, log } = await rawecho();
      await pane.paste('line1;\r\nline2 ✻👍 \ttab\nend;');
      const r = await rx(log, 1, 'paste chunk');
      expect(r.join('')).toBe('\u001b[200~line1;\nline2 ✻👍 \ttab\nend;\u001b[201~');
      expect(r.join('')).not.toContain('\r');
      expect(await h.listBuffers(server)).toEqual([]);
    });

    it('paste refuses control characters and lone surrogates', async () => {
      const { pane } = await rawecho();
      await expect(pane.paste('x\u001b[201~y')).rejects.toBeInstanceOf(TmuxInvalidInput);
      await expect(pane.paste('x\ud800')).rejects.toBeInstanceOf(TmuxInvalidInput);
    });

    it('paste and Enter are separate invocations and separate reads (P-TMUX-09)', async () => {
      const { pane, log } = await rawecho();
      await pane.paste('hello\nworld');
      await rx(log, 1, 'paste');
      await pane.sendKey('Enter');
      const r = await rx(log, 2, 'enter');
      expect(r).toEqual(['\u001b[200~hello\nworld\u001b[201~', '\r']);
    });

    it('a 200 KB paste arrives complete through stdin (no argv limit)', async () => {
      const { pane, log } = await rawecho();
      const text = 'abcdefghij'.repeat(20_000);
      await pane.paste(text);
      const want = `\u001b[200~${text}\u001b[201~`;
      const r = await waitFor(
        () => h.received(log).join(''),
        (s) => s.length >= want.length,
        h.ceilingMs * 2,
        '200 KB paste',
      );
      expect(r).toBe(want);
    });

    it('typeLiteral sends text literally (-l --, escapeArg) and caps it at 8 KiB', async () => {
      const { pane, log } = await rawecho();
      await pane.typeLiteral('a;');
      await rx(log, 1, 'a;');
      await pane.typeLiteral('-x');
      await rx(log, 2, '-x');
      await pane.typeLiteral('#{pane_id} $HOME enter');
      const r = await rx(log, 3, 'format text');
      expect(r).toEqual(['a;', '-x', '#{pane_id} $HOME enter']);
      await expect(pane.typeLiteral('x'.repeat(8193))).rejects.toBeInstanceOf(TmuxArgTooLong);
      await expect(pane.typeLiteral('a\rb')).rejects.toBeInstanceOf(TmuxInvalidInput);
    });

    it('every key of the closed list delivers its exact bytes, one read per key', async () => {
      const { pane, log } = await rawecho();
      const want: [Parameters<TmuxPane['sendKey']>[0], string][] = [
        ['Enter', '\r'],
        ['Escape', '\u001b'],
        ['BTab', '\u001b[Z'],
        ['Up', '\u001b[A'],
        ['Down', '\u001b[B'],
        ['C-g', '\u0007'],
        ['1', '1'],
        ['9', '9'],
      ];
      for (const [i, [k]] of want.entries()) {
        await pane.sendKey(k);
        await rx(log, i + 1, `key ${k}`);
      }
      expect(h.received(log)).toEqual(want.map(([, b]) => b));
      await expect(pane.sendKey('Tab' as never)).rejects.toBeInstanceOf(TmuxInvalidInput);
    });

    it('concurrent input keeps call order (FIFO queue)', async () => {
      const { pane, log } = await rawecho();
      await Promise.all(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => pane.sendKey(k as '1')));
      const r = await waitFor(
        () => h.received(log).join(''),
        (s) => s.length >= 9,
        h.ceilingMs,
        '9 digits',
      );
      expect(r).toBe('123456789');
    });

    it('copy mode is reported, blocks input, and exitCopyMode leaves it', async () => {
      const { server, pane, log } = await rawecho();
      await h.enterCopyMode(server, pane);
      await waitFor(
        () => pane.status(),
        (s) => s.inMode,
        h.ceilingMs,
        'inMode',
      );
      await expect(pane.sendKey('Enter')).rejects.toBeInstanceOf(TmuxPaneInMode);
      await pane.exitCopyMode();
      await waitFor(
        () => pane.status(),
        (s) => !s.inMode,
        h.ceilingMs,
        '!inMode',
      );
      await pane.exitCopyMode(); // no-op when not in mode
      await pane.sendKey('1');
      expect(await rx(log, 1, 'key after copy mode')).toEqual(['1']);
    });

    it('a fast exit (status 42) keeps the dead pane, fires died once, refuses input, writes the exit record', async () => {
      const { server, exitLog } = await newServer();
      const pane = await server.spawnPane(opts(EXIT42));
      const died: { exitStatus: number | null; exitSignal: string | null }[] = [];
      pane.on('died', (s) => died.push(s));
      const st = await waitFor(
        () => pane.status(),
        (s) => s.dead,
        h.ceilingMs,
        'dead',
      );
      expect(st).toMatchObject({ exists: true, dead: true, exitStatus: 42, exitSignal: null });
      await pane.status();
      expect(died).toEqual([{ exitStatus: 42, exitSignal: null }]);
      await expect(pane.sendKey('Enter')).rejects.toBeInstanceOf(TmuxPaneDead);
      await expect(pane.paste('x')).rejects.toBeInstanceOf(TmuxPaneDead);
      const lines = await waitFor(
        () => h.readExitLog(exitLog),
        (l) => l.length > 0,
        h.ceilingMs,
        'exit record',
      );
      expect(lines[0]).toBe(`died pane=${pane.info.paneId} pid=${pane.info.pid} status=42 signal=`);
      expect((await pane.capture()).status.dead).toBe(true);
    });

    it('death by signal reports SIGTERM', async () => {
      const { server, exitLog } = await newServer();
      const pane = await server.spawnPane(opts(SIGTERM_SELF));
      const st = await waitFor(
        () => pane.status(),
        (s) => s.dead,
        h.ceilingMs,
        'dead',
      );
      expect(st).toMatchObject({ dead: true, exitStatus: null, exitSignal: 'SIGTERM' });
      const lines = await waitFor(
        () => h.readExitLog(exitLog),
        (l) => l.length > 0,
        h.ceilingMs,
        'exit record',
      );
      expect(lines[0]).toMatch(/^died pane=%\d+ pid=\d+ status= signal=term$/);
    });

    it('kill(): server and socket file gone, pane gone, onGone not fired', async () => {
      const { server, pane } = await rawecho();
      let serverGone = 0;
      let paneGone = 0;
      server.onGone(() => serverGone++);
      pane.on('gone', () => paneGone++);
      expect(h.socketFileExists(server.socketPath)).toBe(true);
      await server.kill();
      expect(h.socketFileExists(server.socketPath)).toBe(false);
      expect(await pane.status()).toMatchObject({ exists: false });
      expect(paneGone).toBe(1);
      expect(serverGone).toBe(0);
    });

    it('a server crash is noticed by the next command: status exists:false, onGone and pane gone once', async () => {
      const { server, pane } = await rawecho();
      let serverGone = 0;
      let paneGone = 0;
      server.onGone(() => serverGone++);
      pane.on('gone', () => paneGone++);
      await h.crashServer(server);
      await waitFor(
        () => pane.status(),
        (s) => !s.exists,
        h.ceilingMs,
        'exists:false',
      );
      await expect(pane.sendKey('Enter')).rejects.toThrow();
      expect(serverGone).toBe(1);
      expect(paneGone).toBe(1);
    });

    it('a socket that already has a live server is refused (fresh names only)', async () => {
      const { server } = await rawecho();
      const { path } = await h.factory.probe(h.tmuxPath);
      await expect(
        h.factory.create({
          tmuxPath: path,
          socketName: server.socketName,
          clientEnv: h.clientEnv,
          historyLimit: 10,
          paneDiedLogPath: h.exitLogPath(),
        }),
      ).rejects.toBeInstanceOf(TmuxDuplicate);
    });

    it('a duplicate session name is refused and the existing session survives (no cleanup of a session we did not create)', async () => {
      const { server, pane } = await rawecho();
      const { argv } = h.rawechoArgv();
      const name = `ccd-c${servers.length}`; // the name rawecho() used for its pane
      const e = await server.spawnPane(opts(argv, { sessionName: name })).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(TmuxDuplicate);
      const st = await pane.status();
      expect(st).toMatchObject({ exists: true, dead: false });
      await pane.sendKey('1'); // still a live, usable pane
    });

    it('capture returns exactly the requested rows and the status of the same batch', async () => {
      const { pane } = await rawecho();
      const all = await pane.capture();
      expect(all.lines).toHaveLength(80);
      const some = await pane.capture({ startRow: 0, endRow: 4 });
      expect(some.lines).toHaveLength(5);
      expect(some.lines.some((l) => l.startsWith('ENV:'))).toBe(true);
      expect(some.status.exists).toBe(true);
      expect(typeof some.hash).toBe('string');
      expect((await pane.capture({ startRow: 0, endRow: 4 })).hash).toBe(some.hash);
      await expect(pane.capture({ startRow: 3, endRow: 2 })).rejects.toBeInstanceOf(TmuxInvalidInput);
    });
  });
}
