// WP-13 contract: the L3 input executor and pollers against FakeTmux and the real tmux driver on a private `ccd-ct-*` socket
// (DESIGN.md §2.7 "Fakes", §3.6, §4.11/§4.12). Same assertions for both, so the fake the kernel scenarios use behaves like
// tmux for everything the executors rely on: byte delivery of keys/paste/literals, copy-mode exit before input (P-TMUX-45),
// dead-pane refusal (P-TMUX-21), capture → screen.frame (A-4) and pane death → process.exited (A-3, P-TMUX-37).
// Condition polling with ceilings only (§6.5 D6); every server is killed and its socket removed in afterAll.
import { afterAll, describe, expect, it } from 'vitest';
import { profile } from '../../src/channels/profiles/claude-2.1.316/index.js';
import type { InputJobKey, IntentId } from '../../src/model/ids.js';
import type { InputPrimitive } from '../../src/model/intents.js';
import type { ObservationInput } from '../../src/model/observation.js';
import type { Cancel, Clock, MonoMs, WallMs } from '../../src/model/time.js';
import { FakeEditorInjector } from '../../src/platform/editor/fake-editor.js';
import { FakeIds } from '../../src/platform/ids/fake-ids.js';
import type { TmuxPane, TmuxServer } from '../../src/platform/ports.js';
import { createInputExecutor } from '../../src/session/input-executor.js';
import { createPollers } from '../../src/session/pollers.js';
import { findRealTmux, makeFakeHarness, makeRealHarness, waitFor, type TmuxHarness } from './tmux.contract.js';

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
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const h = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(h);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  };
}

function defineExecutorContract(h: TmuxHarness): void {
  describe(`input executor + pollers contract — ${h.label}`, () => {
    const servers: TmuxServer[] = [];
    let n = 0;
    afterAll(async () => {
      for (const s of servers) await s.kill().catch(() => undefined);
      await h.cleanup();
    });

    async function spawn(argv?: [string, string, ...string[]]): Promise<{ server: TmuxServer; pane: TmuxPane; log: string }> {
      const server = await h.factory.create({
        tmuxPath: h.tmuxPath,
        socketName: h.freshSocketName(),
        clientEnv: h.clientEnv,
        historyLimit: 2000,
        paneDiedLogPath: h.exitLogPath(),
      });
      servers.push(server);
      const echo = h.rawechoArgv();
      const pane = await server.spawnPane({
        sessionName: `ccd-x${++n}`,
        argv: argv ?? echo.argv,
        cwd: h.cwd,
        cols: 250,
        rows: 80,
        nonSecretEnv: {},
      });
      if (argv === undefined)
        await waitFor(
          () => pane.capture(),
          (c) => c.lines.some((l) => l.trimEnd() === 'READY'),
          h.ceilingMs,
          'READY',
        );
      return { server, pane, log: echo.log };
    }

    function executor(pane: TmuxPane, clock: Clock, out: ObservationInput[]) {
      const editor = new FakeEditorInjector(clock, new FakeIds(), {});
      return createInputExecutor({ clock, pane: () => pane, editor, emit: (x) => out.push(x), profile, chunkGapMs: 30 });
    }

    let seq = 0;
    const input = (primitive: InputPrimitive) =>
      ({ kind: 'input', id: ++seq as IntentId, job: 'j1' as InputJobKey, step: seq, primitive }) as const;
    const dones = (out: ObservationInput[]) =>
      out.filter((x): x is Extract<ObservationInput, { kind: 'input.done' }> => x.kind === 'input.done').map((x) => x.p);

    it('keys, a bracketed paste and a literal reach the program byte-exact, in order', async () => {
      const { pane, log } = await spawn();
      const clock = realClock();
      const out: ObservationInput[] = [];
      const ex = executor(pane, clock, out);
      await Promise.all([
        ex.execute(input({ kind: 'pasteChunk', text: 'héllo\nworld', bracketed: true })),
        ex.execute(input({ kind: 'typeLiteral', text: '/usage' })),
        ex.execute(input({ kind: 'key', key: 'Escape', gapAfterMs: 0 })),
        ex.execute(input({ kind: 'key', key: 'BTab', gapAfterMs: 15 })),
        ex.execute(input({ kind: 'key', key: 'Enter', gapAfterMs: 15 })),
      ]);
      const expected = '\u001b[200~héllo\nworld\u001b[201~' + '/usage' + '\u001b' + '\u001b[Z' + '\r';
      await waitFor(
        () => h.received(log).join(''),
        (s) => s.length >= expected.length,
        h.ceilingMs,
        'all bytes',
      );
      expect(h.received(log).join('')).toBe(expected);
      expect(dones(out).every((d) => d.ok)).toBe(true);
      await ex.close();
    });

    it('copy mode: the executor leaves it before sending (P-TMUX-45)', async () => {
      const { server, pane, log } = await spawn();
      await h.enterCopyMode(server, pane);
      await waitFor(
        () => pane.status(),
        (s) => s.inMode,
        h.ceilingMs,
        'copy mode',
      );
      const out: ObservationInput[] = [];
      const ex = executor(pane, realClock(), out);
      await ex.execute(input({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
      await waitFor(
        () => h.received(log),
        (r) => r.join('').includes('\r'),
        h.ceilingMs,
        'Enter after copy mode',
      );
      expect(dones(out)[0]!.ok).toBe(true);
      expect((await pane.status()).inMode).toBe(false);
      await ex.close();
    });

    it('a dead pane refuses input with E_SESSION_EXITED; the pane_dead watch emits process.exited', async () => {
      const { pane } = await spawn(['/bin/sh', '-c', 'exit 42']);
      await waitFor(
        () => pane.status(),
        (s) => s.dead,
        h.ceilingMs,
        'pane dead',
      );
      const clock = realClock();
      const out: ObservationInput[] = [];
      const ex = executor(pane, clock, out);
      await ex.execute(input({ kind: 'key', key: 'Enter', gapAfterMs: 0 }));
      expect(dones(out)[0]).toMatchObject({ ok: false, error: 'E_SESSION_EXITED' });
      const pollers = createPollers({ clock, pane: () => pane, emit: (x) => out.push(x), profile, tz: 'UTC', paneDeadPollMs: 100 });
      pollers.watchPane();
      const ex2 = await waitFor(
        () => out.filter((x) => x.kind === 'process.exited'),
        (l) => l.length > 0,
        h.ceilingMs,
        'process.exited',
      );
      expect(ex2[0]!.p).toEqual({ exitStatus: 42, signal: null });
      pollers.close();
      await ex.close();
    });

    it('captureNow emits a screen.frame for the visible pane; an unchanged pane emits nothing more', async () => {
      const { pane } = await spawn();
      const out: ObservationInput[] = [];
      const pollers = createPollers({ clock: realClock(), pane: () => pane, emit: (x) => out.push(x), profile, tz: 'UTC' });
      await pollers.captureNow('test');
      const frames = out.filter((x) => x.kind === 'screen.frame');
      expect(frames).toHaveLength(1);
      expect(frames[0]!.meta.source).toBe('screen');
      await pollers.captureNow('again');
      expect(out.filter((x) => x.kind === 'screen.frame')).toHaveLength(1);
      pollers.close();
    });

    it('captureText returns the visible text of the pane', async () => {
      const { pane } = await spawn();
      const out: ObservationInput[] = [];
      const ex = executor(pane, realClock(), out);
      await ex.execute(input({ kind: 'captureText', rows: 'modal' }));
      const d = dones(out)[0]!;
      expect(d.ok).toBe(true);
      expect(d.output).toContain('READY');
      await ex.close();
    });
  });
}

defineExecutorContract(makeFakeHarness());
const real = findRealTmux();
if (real !== undefined) defineExecutorContract(makeRealHarness(real));
