// The tmux driver contract run against FakeTmux and the real driver on a private `ccd-ct-*` socket (DESIGN.md §2.7 "Fakes"),
// plus real-only checks that a fake cannot model: window size under an attached shrinking client (P-TMUX-18), the key mode
// after the app requests extended keys (LP-52, P-REV-44), and the execFile cost budget (P-TMUX-31).
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import type { TmuxPane, TmuxServer } from '../../src/platform/ports.js';
import {
  attachShrinkingControlClient,
  defineTmuxContract,
  findRealTmux,
  makeFakeHarness,
  makeRealHarness,
  waitFor,
} from './tmux.contract.js';

defineTmuxContract(() => makeFakeHarness());

const real = findRealTmux();
if (real !== undefined) defineTmuxContract(() => makeRealHarness(real));

describe.skipIf(real === undefined)(`real tmux only (${real?.version ?? 'not installed'})`, () => {
  const h = real === undefined ? undefined : makeRealHarness(real);
  const servers: TmuxServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.kill().catch(() => undefined);
    await h?.cleanup();
  });

  async function rawecho(): Promise<{ server: TmuxServer; pane: TmuxPane; log: string; sessionName: string }> {
    if (h === undefined) throw new Error('no tmux');
    const server = await h.factory.create({
      tmuxPath: h.tmuxPath,
      socketName: h.freshSocketName(),
      clientEnv: h.clientEnv,
      historyLimit: 2000,
      paneDiedLogPath: h.exitLogPath(),
    });
    servers.push(server);
    const { argv, log } = h.rawechoArgv();
    const sessionName = `ccd-r${servers.length}`;
    const pane = await server.spawnPane({ sessionName, argv, cwd: h.cwd, cols: 250, rows: 80, nonSecretEnv: {} });
    await waitFor(
      () => pane.capture(),
      (c) => c.lines.some((l) => l.trimEnd() === 'READY'),
      h.ceilingMs,
      'READY',
    );
    return { server, pane, log, sessionName };
  }

  it('an attached client that asks for 100x30 does not shrink the pane (per-window window-size manual)', async () => {
    const { server, pane, sessionName } = await rawecho();
    const stop = attachShrinkingControlClient(h!.tmuxPath, server, sessionName);
    try {
      await waitFor(
        () => {
          try {
            return execFileSync(
              h!.tmuxPath,
              ['-L', server.socketName, '-f', '/dev/null', 'display-message', '-p', '-t', pane.info.paneId, '#{session_attached}'],
              {
                encoding: 'utf8',
              },
            ).trim();
          } catch {
            return '0';
          }
        },
        (v) => v === '1',
        h!.ceilingMs,
        'control client attached',
      );
      await new Promise((r) => setTimeout(r, 300)); // give tmux a chance to apply the client size, if it were going to
      const st = await waitFor(
        () => pane.status(),
        () => true,
        h!.ceilingMs,
        'status',
      );
      expect([st.cols, st.rows]).toEqual([250, 80]);
    } finally {
      stop();
    }
  });

  it('the app requesting modifyOtherKeys/kitty keys leaves pane_key_mode VT10x, and Enter is still a plain CR (LP-52)', async () => {
    const { server, pane, log } = await rawecho(); // rawecho writes ESC[>4;2m ESC[>5u before READY, like Claude 2.1.316
    const mode = execFileSync(
      h!.tmuxPath,
      ['-L', server.socketName, '-f', '/dev/null', 'display-message', '-p', '-t', pane.info.paneId, '#{pane_key_mode}'],
      {
        encoding: 'utf8',
      },
    ).trim();
    if (mode !== '') expect(mode).toBe('VT10x');
    await pane.sendKey('Enter');
    expect(
      await waitFor(
        () => h!.received(log),
        (r) => r.length >= 1,
        h!.ceilingMs,
        'enter',
      ),
    ).toEqual(['\r']);
  });

  it('capture cost stays within the execFile budget (≈ 4 ms per call, P-TMUX-31)', async () => {
    const { pane } = await rawecho();
    const n = 20;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await pane.capture();
    const per = (performance.now() - t0) / n;
    // Generous ceiling for loaded CI machines; the design budget is ≈ 4 ms × ≤ 7 captures/s while busy.
    expect(per).toBeLessThan(50);
  });
});
