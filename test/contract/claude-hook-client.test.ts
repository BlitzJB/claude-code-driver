// test/contract/claude-hook-client.test.ts — the real `claude.exe` 2.1.316 hook clients against our servers (DESIGN.md §3.5,
// §6.1 "the real claude.exe HTTP-hook-client test", P-REV-26 / LP-53, LP-50). Free: the only prompt is the armed self-test
// nonce, which our UserPromptSubmit endpoint blocks, so no model call is made.
//
// It still starts a real (print-mode) Claude process with the user's login, so it is gated like the live tests:
// CCD_LIVE=1 and the pinned binary must be present. It asserts that Claude's axios client passes every SEC §2.3 check
// (no 403), accepts the body-then-200 order and the empty 200 without a `hook error`, applies the constant block body,
// that the command forwarder delivers SessionStart, and that the debug log never records our token.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeHookTransportFactory } from '../../src/platform/hook-server/transport.js';
import type { NodeHookTransport } from '../../src/platform/hook-server/transport.js';
import type { RawHookEvent } from '../../src/platform/ports.js';
import { buildHookServerDist, memLogger, privateDir, realClock, realIds, ROOT } from './hooks.contract.helpers.js';

const CLAUDE = join(ROOT, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const version = (): string => {
  if (!existsSync(CLAUDE)) return '';
  const r = spawnSync(CLAUDE, ['--version'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' },
  });
  return r.stdout;
};
const ENABLED = process.env['CCD_LIVE'] === '1' && version().startsWith('2.1.316');

describe.runIf(ENABLED)('real claude.exe hook clients vs the hook worker (LP-53)', () => {
  const dist = buildHookServerDist();
  afterAll(() => {
    dist.remove();
  });

  it(
    'SessionStart via the forwarder, UPS via HTTP: no 403, no hook error, nonce blocked, token not in the debug log',
    { timeout: 120_000 },
    async () => {
      const d = privateDir();
      // A throwaway cwd under /private/tmp (trusted by inheritance, LV Q4); removed afterwards.
      const cwd = mkdtempSync(process.platform === 'darwin' ? '/private/tmp/ccd-live-hookclient-' : '/tmp/ccd-live-hookclient-');
      const t = createNodeHookTransportFactory({ workerUrl: dist.workerUrl, forwarderScriptPath: dist.forwarderPath }).create({
        runtimeDir: d.dir,
        clock: realClock(),
        ids: realIds(),
        maxBodyBytes: 32 * 1024 * 1024,
        maxHeld: 32,
        maxConnections: 64,
        logger: memLogger(),
      }) as NodeHookTransport;
      const events: RawHookEvent[] = [];
      t.on((e) => events.push(e));
      try {
        const ep = await t.start({ sessionShortId: 'sLive1', transport: 'http' });
        const http = ep.http;
        if (http === undefined) throw new Error('no http endpoint');
        const nonce = `ccd-selftest-${realIds().tokenHex(16)}`;
        await t.armSelfTestNonce(nonce);
        const cmd = (ev: string) => ({
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: ep.forwarder.nodePath,
              args: [ep.forwarder.scriptPath, ep.unix.forwarderConfigPath, ev],
              timeout: 5,
            },
          ],
        });
        const viaHttp = (ev: string) => ({
          matcher: '*',
          hooks: [{ type: 'http', url: `${http.urlBase}${ev}`, headers: { 'X-CCD-Token': http.token }, timeout: 5 }],
        });
        const settingsPath = join(d.dir, 'settings.json');
        writeFileSync(
          settingsPath,
          JSON.stringify({
            hooks: { SessionStart: [cmd('SessionStart')], UserPromptSubmit: [viaHttp('UserPromptSubmit')], Stop: [viaHttp('Stop')] },
          }),
          { mode: 0o600, flag: 'wx' },
        );
        const debugFile = join(d.dir, 'claude-debug.log');
        const env: Record<string, string> = {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: process.env['HOME'] ?? '',
          USER: process.env['USER'] ?? '',
          LANG: 'en_US.UTF-8',
          DISABLE_AUTOUPDATER: '1',
          NO_PROXY: '127.0.0.1,localhost,::1',
          no_proxy: '127.0.0.1,localhost,::1',
        };
        const res = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
          const child = spawn(CLAUDE, ['-p', '--settings', settingsPath, '--debug-file', debugFile, nonce], {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          child.stdout.on('data', (c: Buffer) => (out += c.toString()));
          child.stderr.on('data', (c: Buffer) => (out += c.toString()));
          child.on('error', reject);
          child.on('exit', (code) => {
            resolve({ code, out });
          });
        });
        expect(t.stats().authFailures).toBe(0); // Claude's client passes Host / no Origin / JSON CT / token
        expect(events.find((e) => e.event === 'SessionStart')).toMatchObject({ transport: 'unix', holdable: false });
        const ups = events.find((e) => e.event === 'UserPromptSubmit');
        expect(ups).toMatchObject({ transport: 'http', truncated: false });
        expect((ups?.payload as { prompt?: unknown } | undefined)?.prompt).toBe(nonce);
        expect(events.some((e) => e.event === 'Stop')).toBe(false); // blocked: no model call, no turn
        expect(res.out).not.toMatch(/hook error/i);
        expect(res.out).not.toMatch(/HTTP 40\d/);
        if (existsSync(debugFile)) {
          const log = readFileSync(debugFile, 'utf8');
          expect(log).not.toContain(http.token); // LP-50
          expect(log).not.toMatch(/HTTP hook error/);
        }
      } finally {
        await t.close(null);
        d.remove(); // deletes the debug file, which holds the prompt (LP-50)
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(ENABLED)('real claude.exe hook clients (gated)', () => {
  it('is skipped unless CCD_LIVE=1 and claude.exe 2.1.316 is installed', () => {
    expect(ENABLED).toBe(false);
  });
});
