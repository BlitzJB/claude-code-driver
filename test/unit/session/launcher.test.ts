// WP-12 launcher (DESIGN.md §3.1 steps 1–13) against the fake ports and the FakeClaude world.
import { describe, expect, it } from 'vitest';
import { isCcdError } from '../../../src/model/errors.js';
import type { ObservationInput } from '../../../src/model/observation.js';
import { TmuxUnsupported } from '../../../src/platform/tmux/errors.js';
import { expectedTranscriptPath, launchSession, projectSlug, type LaunchWarning } from '../../../src/session/launcher.js';
import { TEST_CLAUDE_SESSION_ID, TEST_SESSION_KEY } from '../../../src/testing/core-config.js';
import { FakeClaude } from '../../../src/testing/fake-claude.js';
import { createFakePorts } from '../../../src/testing/fake-ports.js';
import { launchWorld, pump, testConfig } from './wp12-helpers.js';

async function failure(p: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> | undefined }> {
  try {
    await p;
  } catch (e) {
    if (isCcdError(e)) return { code: e.code, details: e.details as Record<string, unknown> | undefined };
    throw e;
  }
  throw new Error('expected launch to fail');
}

describe('happy path (§3.1 steps 1–13)', () => {
  it('spawns Claude with the D-08 argv, the injected settings and a clean env', async () => {
    const observed: ObservationInput[] = [];
    const { fakes, world, result } = await launchWorld({ launch: { sinks: { observe: (o) => observed.push(o) } } });
    const pane = fakes.tmux.lastPane();
    expect(pane).toBeDefined();
    const sessionDir = result.handles.sessionDir;
    expect(pane?.argv).toEqual([
      '/usr/bin/env',
      '-u',
      'TMUX',
      '-u',
      'TMUX_PANE',
      '/fake/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      '--session-id',
      TEST_CLAUDE_SESSION_ID,
      '--settings',
      `${sessionDir}/settings.json`,
      '--permission-mode',
      'default',
      '--teammate-mode',
      'in-process',
    ]);
    expect(pane?.cwd).toBe(fakes.cwd);
    // the world read the settings file the launcher wrote through SettingsFilePort
    const settings = fakes.readWritten(`${sessionDir}/settings.json`) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toContain('SessionStart');
    expect(world.current().sessionId).toBe(TEST_CLAUDE_SESSION_ID);
    // pane env: VISUAL is our wrapper (world requirement), library vars present, no secrets
    const env = fakes.tmux.lastServer()?.clientEnv ?? {};
    expect(env['VISUAL']).toBe(`${sessionDir}/ccd-editor`);
    expect(env['DISABLE_AUTOUPDATER']).toBe('1');
    expect(env['TMUX']).toBeUndefined();
    // registry
    const rec = await result.handles.store.readSession(TEST_SESSION_KEY);
    expect(rec).toMatchObject({
      state: 'launching',
      claude: { pid: result.handles.claude.pid, exe: result.claude.exe, version: '2.1.316' },
      tmux: { paneId: pane?.info.paneId, socketName: result.handles.tmux.server.socketName },
      ownerWatch: { pid: result.handles.ownerWatch?.pid },
      hook: { transport: 'http' },
      initialSessionId: TEST_CLAUDE_SESSION_ID,
    });
    expect(rec?.sessionDir.startsWith('/')).toBe(true);
    expect(await result.handles.store.readOwner(fakes.ownerPid)).toMatchObject({ pid: fakes.ownerPid });
    expect(result.handles.tmux.server.socketName).toMatch(new RegExp(`^ccd-${fakes.ownerPid.toString(36)}-[0-9a-f]{8}$`));
    // owner-watch started right after the pane with a valid watch.json
    expect(fakes.ownerWatch.started).toHaveLength(1);
    expect(fakes.ownerWatch.started[0]?.config).toMatchObject({
      ownerPid: fakes.ownerPid,
      claudePid: result.handles.claude.pid,
      claudeExeSubstr: 'claude.exe',
      sessionIdSubstr: TEST_CLAUDE_SESSION_ID,
      exitsLog: result.handles.store.exitsLogPath(TEST_SESSION_KEY),
    });
    // process.launched
    expect(observed.map((o) => o.kind)).toEqual(['process.launched']);
    expect(observed[0]?.p).toMatchObject({ pid: result.handles.claude.pid, claudeVersion: '2.1.316' });
    // tail target + lifecheck target
    expect(result.expectedTranscriptPath).toBe(`${fakes.home}/.claude/projects/${projectSlug(fakes.cwd)}/${TEST_CLAUDE_SESSION_ID}.jsonl`);
    expect(fakes.state.files.has('lifecheck-target.json')).toBe(true);
    expect(fakes.state.files.get(`exits/${TEST_SESSION_KEY}.log`)).toMatch(/^launched owner=/);
    expect(result.network).toBe('off');
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });

  it('the world boots and sends SessionStart over the forwarder transport', async () => {
    const events: string[] = [];
    const { fakes, result } = await launchWorld({ launch: { sinks: { hook: (e) => events.push(e.event) } } });
    await fakes.clock.advanceAsync(1000);
    expect(events).toContain('SessionStart');
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });

  it('writes the registry record (launching) BEFORE the pane is spawned (§3.1 step 11)', async () => {
    const fakes = createFakePorts();
    let atSpawn: string | undefined;
    fakes.setProgram((argv) => ({
      start: (io) => {
        atSpawn = fakes.state.files.get(`sessions/${TEST_SESSION_KEY}.json`);
        const pane = fakes.tmux.lastPane();
        if (pane !== undefined) fakes.process.addProcess({ pid: pane.info.pid, command: argv.join(' ') });
        io.setScreen(['']);
      },
    }));
    const r = await pump(fakes, launchSession(fakes.ports, testConfig(fakes), { registerExit: false }));
    expect(atSpawn).toBeDefined();
    expect(JSON.parse(atSpawn ?? '{}')).toMatchObject({ state: 'launching', claude: { exe: r.claude.exe } });
    expect((JSON.parse(atSpawn ?? '{}') as { claude: { pid?: number } }).claude.pid).toBeUndefined();
    await pump(fakes, r.lifecycle.close({ mode: 'kill' }));
  });

  it('resume passes --resume again with settings/mode/model and follows the resumed transcript', async () => {
    const id = '11111111-0000-4000-8000-000000000009';
    const { fakes, result } = await launchWorld({
      config: { resume: id, claudeSessionId: id, model: 'opus', permissionMode: 'plan' },
    });
    const argv = fakes.tmux.lastPane()?.argv ?? [];
    expect(argv).toContain('--resume');
    expect(argv).not.toContain('--session-id');
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(argv).toContain('plan');
    expect(result.resumed).toBe(true);
    expect(result.expectedTranscriptPath.endsWith(`${id}.jsonl`)).toBe(true);
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });

  it('claudeDebugFile puts --debug-file inside the 0700 session dir (P-REV-27, LP-50)', async () => {
    const { fakes, result } = await launchWorld({ config: { debug: { claudeDebugFile: true } } });
    const argv = fakes.tmux.lastPane()?.argv ?? [];
    expect(argv[argv.indexOf('--debug-file') + 1]).toBe(`${result.handles.sessionDir}/claude-debug.log`);
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });
});

describe('hook transport selection', () => {
  it('a layer defining allowedHttpHookUrls → unix transport, every event via the forwarder', async () => {
    const { fakes, result } = await launchWorld({ ports: { layers: { allowedHttpHookUrlsDefinedIn: ['user'] } } });
    expect(result.hookTransport).toEqual({ transport: 'unix', reason: 'allowedHttpHookUrls' });
    const s = fakes.readWritten(result.settingsPath) as { hooks: Record<string, [{ hooks: [{ type: string }] }]> };
    for (const g of Object.values(s.hooks)) expect(g[0].hooks[0].type).toBe('command');
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });

  it('the selftest-cache callback forces unix; an explicit relaunch transport wins', async () => {
    const a = await launchWorld({ launch: { httpSelfTestFailedRecently: () => true } });
    expect(a.result.hookTransport.reason).toBe('selfTestCache');
    await pump(a.fakes, a.result.lifecycle.close({ mode: 'kill' }));
    const b = await launchWorld({ launch: { hookTransport: 'unix' } });
    expect(b.result.hookTransport).toEqual({ transport: 'unix', reason: 'forced' });
    await pump(b.fakes, b.result.lifecycle.close({ mode: 'kill' }));
  });
});

describe('network channel (§3.10, P-NET-31…34, P-SEC-18)', () => {
  it('on: proxy env in the tmux starting-client env only, never in argv; hook port denied to the sidecar', async () => {
    const { fakes, result } = await launchWorld({ config: { network: { faults: false, allowPrivate: false, allowPorts: [] } } });
    expect(result.network).toBe('on');
    const env = fakes.tmux.lastServer()?.clientEnv ?? {};
    expect(env['HTTPS_PROXY']).toMatch(/^http:\/\/ccd:[0-9a-f]{64}@127\.0\.0\.1:\d+$/);
    expect(env['NO_PROXY']).toBe('127.0.0.1,localhost,::1');
    const token = new URL(env['HTTPS_PROXY'] ?? 'http://x').password;
    expect(result.argv.join(' ')).not.toContain(token);
    expect(JSON.stringify(fakes.readWritten(result.settingsPath))).not.toContain(token);
    const proxy = fakes.net.proxies[0];
    expect(proxy?.options.denyPorts).toEqual([result.handles.hooks.endpoint.http?.port]);
    expect(proxy?.boundPids).toEqual([result.handles.claude.pid]);
    expect((await result.handles.store.readSession(TEST_SESSION_KEY))?.net?.port).toBe(result.handles.net?.port);
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });

  it('a user proxy turns the channel off with a warning and passes the proxy through', async () => {
    const warnings: LaunchWarning[] = [];
    const { fakes, result } = await launchWorld({
      ports: { envVars: { HTTPS_PROXY: 'http://corp:3128' } },
      config: { network: { faults: false, allowPrivate: false, allowPorts: [] } },
      launch: { sinks: { warning: (w) => warnings.push(w) } },
    });
    expect(result.network).toBe('off');
    expect(warnings).toContainEqual({ code: 'E_NETWORK_UNAVAILABLE', reason: 'userProxy' });
    const env = fakes.tmux.lastServer()?.clientEnv ?? {};
    expect(env['HTTPS_PROXY']).toBe('http://corp:3128');
    expect(env['NO_PROXY']).toBe('127.0.0.1,localhost,::1');
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });
});

describe('failures tear down in reverse order', () => {
  it('P-REV-44 (LP-52): a non-VT10x pane key mode fails E_TMUX_UNSUPPORTED{extendedKeys}; nothing is left behind', async () => {
    const fakes = createFakePorts({ trusted: false });
    fakes.tmux.failNext('spawn', new TmuxUnsupported('extendedKeys', 'VT10x+CSIu'));
    const err = await failure(
      pump(fakes, launchSession(fakes.ports, testConfig(fakes, { trust: { mode: 'seed', acceptRisks: false } }), { registerExit: false })),
    );
    expect(err.code).toBe('E_TMUX_UNSUPPORTED');
    expect(err.details?.['reason']).toBe('extendedKeys');
    expect(fakes.runtimeDir.dirs.size).toBe(0);
    expect(fakes.hooks.instances[0]?.state).toBe('closed');
    expect(fakes.claudeConfig.writes.map((w) => w.op)).toEqual(['seed', 'unseed']);
    expect(fakes.state.files.has(`sessions/${TEST_SESSION_KEY}.json`)).toBe(false);
    const arch = JSON.parse(fakes.state.files.get(`archive/${TEST_SESSION_KEY}.json`) ?? '{}') as { exit?: { reason: string } };
    expect(arch.exit?.reason).toBe('startupFailed');
    expect(fakes.tmux.lastServer()?.alive).toBe(false);
  });

  it('ICR 0022: the failure undo archives the record last (after tmux kill and the trust release)', async () => {
    const fakes = createFakePorts({ trusted: false });
    fakes.tmux.failNext('spawn', new TmuxUnsupported('extendedKeys', 'VT10x+CSIu'));
    const order: string[] = [];
    const write = fakes.state.writeJsonAtomic.bind(fakes.state);
    fakes.state.writeJsonAtomic = (rel, v) => {
      if (rel.startsWith('archive/'))
        order.push(
          `archive kill=${String(fakes.tmux.invocations.some((i) => i.op === 'kill'))} writes=${fakes.claudeConfig.writes.length}`,
        );
      return write(rel, v);
    };
    await failure(
      pump(fakes, launchSession(fakes.ports, testConfig(fakes, { trust: { mode: 'seed', acceptRisks: false } }), { registerExit: false })),
    );
    expect(order).toEqual(['archive kill=true writes=2']);
  });

  it('ICR 0022: trust is seeded only once the registry record exists (a crash before is reapable or never seeded)', async () => {
    const fakes = createFakePorts({ trusted: false });
    const seen: unknown[] = [];
    const seed = fakes.claudeConfig.seedTrust.bind(fakes.claudeConfig);
    fakes.claudeConfig.seedTrust = (cwd) => {
      const raw = fakes.state.files.get(`sessions/${TEST_SESSION_KEY}.json`);
      seen.push(raw === undefined ? 'no record' : (JSON.parse(raw) as { trustKeyAddedByLibrary: unknown }).trustKeyAddedByLibrary);
      return seed(cwd);
    };
    const { result } = await launchWorld({ fakes, config: { trust: { mode: 'seed', acceptRisks: false } } });
    expect(seen).toEqual([true]);
    expect(result.trust.trustKeyAddedByLibrary).toBe(true);
    expect(result.handles.trustKeyAddedByLibrary).toBe(true);
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    expect(fakes.claudeConfig.writes.map((w) => w.op)).toEqual(['seed', 'unseed']);
  });

  it('ICR 0022: a failure before the registry record (hook server) never touches ~/.claude.json', async () => {
    const fakes = createFakePorts({ trusted: false });
    const create = fakes.hooks.create.bind(fakes.hooks);
    fakes.hooks.create = (o) => {
      const t = create(o);
      t.failNextStart();
      return t;
    };
    const err = await failure(
      pump(fakes, launchSession(fakes.ports, testConfig(fakes, { trust: { mode: 'seed', acceptRisks: false } }), { registerExit: false })),
    );
    expect(err.code).toBe('E_HOOKS_UNAVAILABLE');
    expect(fakes.claudeConfig.writes).toEqual([]);
  });

  it('ICR 0022: the trust key vanished between the check and the record (another session released it) → seeded again', async () => {
    const fakes = createFakePorts({ trusted: true });
    const trustOf = fakes.claudeConfig.trustOf.bind(fakes.claudeConfig);
    let calls = 0;
    fakes.claudeConfig.trustOf = (cwd) => {
      // first call (step 7): trusted; then another session's close removes the key before our record exists
      if (++calls === 2) void fakes.claudeConfig.unseedTrust(cwd);
      return trustOf(cwd);
    };
    const { result } = await launchWorld({ fakes, config: { trust: { mode: 'seed', acceptRisks: false } } });
    expect(fakes.claudeConfig.writes.map((w) => w.op)).toEqual(['unseed', 'seed']);
    expect(result.handles.trustKeyAddedByLibrary).toBe(true);
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });

  it('a pane process that is not our Claude → E_STARTUP_EXITED', async () => {
    const fakes = createFakePorts();
    fakes.setProgram(() => ({
      start: (io) => {
        io.setScreen(['bash: claude.exe: No such file']);
      },
    }));
    const err = await failure(pump(fakes, launchSession(fakes.ports, testConfig(fakes), { registerExit: false })));
    expect(err.code).toBe('E_STARTUP_EXITED');
    expect(err.details?.['reason']).toBe('noProcess');
    expect(String(err.details?.['finalScreen'])).toContain('No such file');
    expect(fakes.ownerWatch.started).toEqual([]);
  });

  it('a hook server that cannot start → E_HOOKS_UNAVAILABLE and the session dir is removed', async () => {
    const fakes = createFakePorts();
    const create = fakes.hooks.create.bind(fakes.hooks);
    fakes.hooks.create = (o) => {
      const t = create(o);
      t.failNextStart();
      return t;
    };
    const err = await failure(pump(fakes, launchSession(fakes.ports, testConfig(fakes), { registerExit: false })));
    expect(err.code).toBe('E_HOOKS_UNAVAILABLE');
    expect(fakes.runtimeDir.dirs.size).toBe(0);
    expect(fakes.tmux.invocations.filter((i) => i.op === 'create')).toEqual([]);
  });

  it('forbidden extraArgs fail before anything is created', async () => {
    const fakes = createFakePorts();
    const err = await failure(
      pump(fakes, launchSession(fakes.ports, testConfig(fakes, { extraArgs: ['--dangerously-skip-permissions'] }))),
    );
    expect(err).toEqual({ code: 'E_FORBIDDEN_ARG', details: { arg: '--dangerously-skip-permissions', reason: 'skipsPermissions' } });
    expect(fakes.runtimeDir.dirs.size).toBe(0);
  });

  it('a live holder of the resume id → E_SESSION_ID_IN_USE before any tmux call', async () => {
    const fakes = createFakePorts();
    const pid = fakes.process.addProcess({ command: 'claude --resume X' });
    const id = '22222222-0000-4000-8000-000000000001';
    fakes.registry.put({ pid, sessionId: id });
    const err = await failure(
      pump(fakes, launchSession(fakes.ports, testConfig(fakes, { resume: id, claudeSessionId: id }), { registerExit: false })),
    );
    expect(err.code).toBe('E_SESSION_ID_IN_USE');
    expect(fakes.tmux.invocations).toEqual([]);
  });
});

describe('fail-closed guards (P-SEC-31, P-NET-25, §3.5)', () => {
  it('P-SEC-31: a SessionStart after the settings file changed → warning E_SECURITY_SETTINGS_TAMPERED and Claude is killed', async () => {
    const warnings: LaunchWarning[] = [];
    const { fakes, result } = await launchWorld({ claude: { bootMs: 5_000 }, launch: { sinks: { warning: (w) => warnings.push(w) } } });
    const pid = result.handles.claude.pid;
    expect(fakes.process.isAlive(pid)).toBe(true);
    fakes.settingsFile.tamper(result.settingsPath, JSON.stringify({ hooks: {}, disableAllHooks: true }));
    await fakes.clock.advanceAsync(6_000);
    expect(warnings).toContainEqual({ code: 'E_SECURITY_SETTINGS_TAMPERED', reason: 'settingsTampered' });
    expect(fakes.process.killCalls.filter((k) => k.pid === pid).map((k) => k.sig)).toEqual(['SIGKILL']);
    expect(result.lifecycle.failedClosed).toBe('settingsTampered');
    await pump(fakes, result.lifecycle.finalizeAfterExit());
  });

  it('P-SEC-31: an untouched settings file passes every SessionStart (startup and a later /clear generation)', async () => {
    const warnings: LaunchWarning[] = [];
    const { fakes, result } = await launchWorld({ launch: { sinks: { warning: (w) => warnings.push(w) } } });
    await fakes.clock.advanceAsync(1_000);
    fakes.hooks.instances[0]?.deliver('SessionStart', { session_id: TEST_CLAUDE_SESSION_ID, source: 'clear' });
    await fakes.clock.advanceAsync(100);
    expect(warnings.filter((w) => w.code === 'E_SECURITY_SETTINGS_TAMPERED')).toEqual([]);
    expect(fakes.process.isAlive(result.handles.claude.pid)).toBe(true);
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });

  it('P-SEC-31: tampering detected before launch returns fails the start; Claude is SIGKILLed before the hook server closes', async () => {
    const fakes = createFakePorts();
    new FakeClaude(fakes, { bootMs: 1 });
    const write = fakes.settingsFile.writeExclusive.bind(fakes.settingsFile);
    fakes.settingsFile.writeExclusive = async (path, json) => {
      const r = await write(path, json);
      if (path.endsWith('/settings.json')) fakes.settingsFile.tamper(path, `${JSON.stringify(json)} `);
      return r;
    };
    // hold the launch at the owner-watch step long enough for the boot SessionStart to arrive
    const start = fakes.ownerWatch.start.bind(fakes.ownerWatch);
    fakes.ownerWatch.start = async (s) => {
      await fakes.ports.clock.sleep(500);
      return start(s);
    };
    const order: string[] = [];
    fakes.process.onExit((p) => {
      if (p.command.includes('claude.exe')) order.push(`claude:${p.exitSignal ?? ''}`);
    });
    const create = fakes.hooks.create.bind(fakes.hooks);
    fakes.hooks.create = (o) => {
      const t = create(o);
      const close = t.close.bind(t);
      t.close = (b) => {
        order.push('hooks.close');
        return close(b);
      };
      return t;
    };
    const err = await failure(pump(fakes, launchSession(fakes.ports, testConfig(fakes), { registerExit: false })));
    expect(err).toEqual({ code: 'E_SECURITY_SETTINGS_TAMPERED', details: { reason: 'settingsTampered' } });
    expect(order).toEqual(['claude:SIGKILL', 'hooks.close']);
    expect(fakes.runtimeDir.dirs.size).toBe(0);
    expect(fakes.tmux.lastServer()?.alive).toBe(false);
  });

  it('P-NET-25 / §3.10: the sidecar dies → warning sidecarDied and Claude is terminated (no same-port restart)', async () => {
    const warnings: LaunchWarning[] = [];
    const { fakes, result } = await launchWorld({
      config: { network: { faults: false, allowPrivate: false, allowPorts: [] } },
      launch: { sinks: { warning: (w) => warnings.push(w) } },
    });
    await fakes.clock.advanceAsync(500);
    fakes.net.last?.die();
    await pump(
      fakes,
      (async () => {
        while (fakes.process.isAlive(result.handles.claude.pid)) await fakes.ports.clock.sleep(10);
      })(),
    );
    expect(warnings).toContainEqual({ code: 'E_NETWORK_UNAVAILABLE', reason: 'sidecarDied' });
    expect(fakes.process.killCalls.filter((k) => k.pid === result.handles.claude.pid).map((k) => k.sig)[0]).toBe('SIGTERM');
    expect(fakes.net.proxies).toHaveLength(1);
    await pump(fakes, result.lifecycle.finalizeAfterExit());
  });

  it('§3.5: the hook worker dies → warning hookWorkerDied and Claude is terminated', async () => {
    const warnings: LaunchWarning[] = [];
    const { fakes, result } = await launchWorld({ launch: { sinks: { warning: (w) => warnings.push(w) } } });
    await fakes.clock.advanceAsync(500);
    fakes.hooks.instances[0]?.crash();
    await pump(
      fakes,
      (async () => {
        while (fakes.process.isAlive(result.handles.claude.pid)) await fakes.ports.clock.sleep(10);
      })(),
    );
    expect(warnings).toContainEqual({ code: 'E_HOOKS_UNAVAILABLE', reason: 'hookWorkerDied' });
    await pump(fakes, result.lifecycle.finalizeAfterExit());
  });

  it('guards are removed at teardown: a SessionStart after close does nothing', async () => {
    const warnings: LaunchWarning[] = [];
    const { fakes, result } = await launchWorld({ launch: { sinks: { warning: (w) => warnings.push(w) } } });
    await fakes.clock.advanceAsync(500);
    const t = fakes.hooks.instances[0];
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    fakes.settingsFile.tamper(result.settingsPath, '{}');
    t?.deliver('SessionStart', { source: 'startup' });
    await fakes.clock.advanceAsync(100);
    expect(warnings.filter((w) => w.code === 'E_SECURITY_SETTINGS_TAMPERED')).toEqual([]);
  });
});

describe('more failure paths', () => {
  it('D-28: an owner-watch that cannot start fails the launch closed; Claude is terminated and everything torn down', async () => {
    const fakes = createFakePorts();
    new FakeClaude(fakes);
    fakes.ownerWatch.start = () => Promise.reject(new Error('spawn EAGAIN'));
    const err = await failure(pump(fakes, launchSession(fakes.ports, testConfig(fakes), { registerExit: false })));
    expect(err.code).toBe('E_INVARIANT');
    const claude = [...fakes.process.procs.values()].find((p) => p.command.includes('claude.exe'));
    expect(claude?.alive).toBe(false);
    expect(fakes.process.killCalls.filter((k) => k.pid === claude?.pid).map((k) => k.sig)[0]).toBe('SIGTERM');
    expect(fakes.tmux.lastServer()?.alive).toBe(false);
    expect(fakes.runtimeDir.dirs.size).toBe(0);
    expect(fakes.state.files.has(`sessions/${TEST_SESSION_KEY}.json`)).toBe(false);
  });

  it('K-03: a version mismatch fails before any tmux call and before the hook server', async () => {
    const fakes = createFakePorts();
    const err = await failure(
      pump(fakes, launchSession(fakes.ports, testConfig(fakes, { claude: { expectVersion: '2.1.317' } }), { registerExit: false })),
    );
    expect(err).toMatchObject({ code: 'E_CLAUDE_VERSION_MISMATCH', details: { expected: '2.1.317', found: '2.1.316' } });
    expect(fakes.tmux.invocations).toEqual([]);
    expect(fakes.hooks.instances).toEqual([]);
    expect(fakes.runtimeDir.dirs.size).toBe(0);
  });

  it('D-23: the registry cross-check warns on a version / session id mismatch', async () => {
    const warnings: LaunchWarning[] = [];
    const fakes = createFakePorts();
    fakes.registry.read = (pid: number) => Promise.resolve({ pid, version: '2.1.999', sessionId: 'someone-else' });
    const { result } = await launchWorld({ fakes, launch: { registryCrossCheck: true, sinks: { warning: (w) => warnings.push(w) } } });
    await fakes.clock.advanceAsync(100);
    expect(warnings).toContainEqual({
      code: 'E_CLAUDE_VERSION_MISMATCH',
      reason: 'registryVersionMismatch',
      details: { expected: '2.1.316', found: '2.1.999' },
    });
    expect(warnings).toContainEqual({ code: 'E_INVARIANT', reason: 'registrySessionIdMismatch' });
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });

  it('P-REV-32: lifecheck-target.json gets an absolute, decoded dist path and the node path', async () => {
    const { fakes, result } = await launchWorld();
    const t = JSON.parse(fakes.state.files.get('lifecheck-target.json') ?? '{}') as { distPath: string; nodePath: string };
    expect(t.distPath.startsWith('/')).toBe(true);
    expect(t.distPath.endsWith('/cli/main.js')).toBe(true);
    expect(t.distPath).not.toMatch(/%[0-9A-F]{2}|^file:/i);
    expect(t.nodePath).toBe(fakes.env.execPath());
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });
});

describe('helpers', () => {
  it('expectedTranscriptPath uses Claude’s slug', () => {
    expect(expectedTranscriptPath('/h/.claude', '/Users/a b/x.y', 'id')).toBe('/h/.claude/projects/-Users-a-b-x-y/id.jsonl');
  });
});
