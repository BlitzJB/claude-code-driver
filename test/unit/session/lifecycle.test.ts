// WP-12 lifecycle (DESIGN.md §3.8 close/crash/exit handling; P-LIFE-06/07/11/13/22/29/44/46, P-REV-27/43).
import { describe, expect, it, vi } from 'vitest';
import type { WallMs } from '../../../src/model/time.js';
import {
  CLOSE_DENY_BODY,
  closeAll,
  EXIT_DIALOG_CHECK_MS,
  EXIT_REGISTRY_KEY,
  exitRegistry,
  installSignalHandlers,
  mapExitReason,
  registerForExit,
  trimScreen,
} from '../../../src/session/lifecycle.js';
import { TEST_SESSION_KEY } from '../../../src/testing/core-config.js';
import { KEY2, launchWorld, pump, record } from './wp12-helpers.js';
import { releaseTrustLocked } from '../../../src/session/reaper.js';
import { TRUST_SEEDS_FILE } from '../../../src/session/registry-store.js';

type Listener = (...a: unknown[]) => void;

/** A stand-in for `process` (once/on/off/kill/pid) that records everything. */
function fakeProc(): {
  proc: Parameters<typeof registerForExit>[1] & object;
  emit(ev: string, ...a: unknown[]): void;
  kills: [number, string][];
  listeners: Map<string, Listener[]>;
} {
  const listeners = new Map<string, Listener[]>();
  const kills: [number, string][] = [];
  const add = (ev: string, fn: Listener): void => {
    listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
  };
  const proc = {
    pid: 777,
    once(ev: string, fn: Listener) {
      const w: Listener = (...a) => {
        this.off(ev, w);
        fn(...a);
      };
      add(ev, w);
      return this;
    },
    on(ev: string, fn: Listener) {
      add(ev, fn);
      return this;
    },
    off(ev: string, fn: Listener) {
      listeners.set(
        ev,
        (listeners.get(ev) ?? []).filter((x) => x !== fn),
      );
      return this;
    },
    kill(pid: number, sig: string) {
      kills.push([pid, sig]);
      return true;
    },
  };
  return {
    proc: proc as never,
    emit: (ev, ...a) => {
      for (const l of [...(listeners.get(ev) ?? [])]) l(...a);
    },
    kills,
    listeners,
  };
}

describe('mapExitReason (P-LIFE-06)', () => {
  it.each([
    [{ exitStatus: 0, signal: null, closing: false }, 'exitedByItself'],
    [{ exitStatus: 1, signal: null, closing: false }, 'crashed'],
    [{ exitStatus: 129, signal: null, closing: false }, 'hangup'],
    [{ exitStatus: null, signal: 'SIGHUP', closing: false }, 'hangup'],
    [{ exitStatus: 143, signal: null, closing: false }, 'killed'],
    [{ exitStatus: null, signal: 'SIGKILL', closing: false }, 'killed'],
    [{ exitStatus: 0, signal: null, closing: true, mode: 'graceful' as const }, 'closed'],
    [{ exitStatus: null, signal: 'SIGTERM', closing: true, mode: 'graceful' as const }, 'closed'],
    [{ exitStatus: null, signal: 'SIGKILL', closing: true, mode: 'graceful' as const, escalated: true }, 'killed'],
    [{ exitStatus: null, signal: 'SIGKILL', closing: true, mode: 'kill' as const }, 'killed'],
    [{ exitStatus: 1, signal: null, closing: false, startup: true }, 'startupFailed'],
    [{ exitStatus: null, signal: 'SIGTERM', closing: false, ownerGone: true }, 'ownerGone'],
  ])('%j → %s', (facts, reason) => {
    expect(mapExitReason(facts)).toBe(reason);
  });

  it('trimScreen drops trailing blanks and bounds the size', () => {
    expect(trimScreen(['a  ', 'b', '', '   '])).toBe('a\nb');
    expect(trimScreen(Array.from({ length: 200 }, (_, i) => `l${i}`)).split('\n')).toHaveLength(80);
  });
});

describe('close (§3.8)', () => {
  it('graceful: /exit through the editor, then hooks/net/tail stop after the pane is dead, then cleanup (P-LIFE-13)', async () => {
    const { fakes, world, result } = await launchWorld();
    await fakes.clock.advanceAsync(1000); // boot + SessionStart
    const h = result.handles;
    const order: string[] = [];
    const transport = fakes.hooks.instances[0];
    const origClose = transport?.close.bind(transport);
    if (transport !== undefined && origClose !== undefined)
      transport.close = (body) => {
        order.push(`hooks.close dead=${String(!fakes.process.isAlive(h.claude.pid))}`);
        expect(body).toEqual(CLOSE_DENY_BODY);
        return origClose(body);
      };
    const steps: string[] = [];
    const info = await pump(
      fakes,
      result.lifecycle.close(
        {},
        {
          beginClosing: () => void steps.push('closing'),
          denyHeldPermissions: () => void steps.push('deny'),
          canExitGracefully: () => true,
        },
      ),
    );
    expect(steps).toEqual(['closing', 'deny']);
    expect(info.reason).toBe('closed');
    expect(info.exitStatus).toBe(0);
    expect(world.current().exited).toBe(true);
    expect(order).toEqual(['hooks.close dead=true']);
    // no signal was needed
    expect(fakes.process.killCalls.filter((k) => k.pid === h.claude.pid)).toEqual([]);
    // cleanup
    expect(fakes.ownerWatch.started[0]?.stopped).toBe(true);
    expect(fakes.tmux.lastServer()?.alive).toBe(false);
    expect(fakes.runtimeDir.removed).toEqual([h.sessionDir]);
    expect(await h.store.readSession(TEST_SESSION_KEY)).toBeUndefined();
    expect((await h.store.readArchive(TEST_SESSION_KEY))?.exit).toEqual({ exitStatus: 0, signal: null, reason: 'closed' });
    expect(await h.store.readOwner(fakes.ownerPid)).toBeUndefined();
    // idempotent
    expect(await result.lifecycle.close()).toBe(info);
  });

  it('not idle → SIGTERM to the verified pid instead of /exit', async () => {
    const { fakes, result } = await launchWorld();
    await fakes.clock.advanceAsync(500);
    const info = await pump(fakes, result.lifecycle.close({}, { canExitGracefully: () => false }));
    expect(fakes.process.killCalls.filter((k) => k.pid === result.handles.claude.pid).map((k) => k.sig)).toEqual(['SIGTERM']);
    expect(info.reason).toBe('closed');
    expect(fakes.editor.last?.staged ?? []).toEqual([]);
  });

  it('P-LIFE-07 / P-LIFE-11: a Claude that ignores SIGTERM is SIGKILLed after closeGraceMs + killAfterMs', async () => {
    const { fakes, result } = await launchWorld();
    await fakes.clock.advanceAsync(500);
    fakes.process.procs.get(result.handles.claude.pid)?.ignores.add('SIGTERM');
    const t0 = fakes.clock.now();
    const info = await pump(fakes, result.lifecycle.close());
    const sigs = fakes.process.killCalls.filter((k) => k.pid === result.handles.claude.pid).map((k) => k.sig);
    expect(sigs).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL']);
    expect(fakes.clock.now() - t0).toBeGreaterThanOrEqual(12_000 + 3_000);
    expect(info.reason).toBe('killed');
  });

  it("mode:'kill' starts at step 5 with SIGKILL", async () => {
    const { fakes, result } = await launchWorld();
    const info = await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    expect(fakes.process.killCalls.filter((k) => k.pid === result.handles.claude.pid).map((k) => k.sig)).toEqual(['SIGKILL']);
    expect(info.reason).toBe('killed');
  });

  it('P-LIFE-44: a reused pid is never signalled', async () => {
    const { fakes, result } = await launchWorld();
    await fakes.clock.advanceAsync(500);
    const pid = result.handles.claude.pid;
    fakes.process.reusePid(pid, 'vim notes');
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    expect(fakes.process.killCalls.filter((k) => k.pid === pid)).toEqual([]);
  });

  it('P-LIFE-46: a dialog after /exit falls back to SIGTERM at once (not after the 12 s grace)', async () => {
    const { fakes, result } = await launchWorld({ claude: { exitShowsDialog: true } });
    await fakes.clock.advanceAsync(500);
    const pid = result.handles.claude.pid;
    const t0 = fakes.clock.now();
    const sigAt: { sig: string; at: number }[] = [];
    const kill = fakes.process.kill.bind(fakes.process);
    fakes.process.kill = (p, sig) => {
      if (p === pid) sigAt.push({ sig, at: fakes.clock.now() - t0 });
      return kill(p, sig);
    };
    const info = await pump(fakes, result.lifecycle.close({}, { canExitGracefully: () => true, dialogVisible: () => true }));
    expect(sigAt[0]?.sig).toBe('SIGTERM');
    // /exit staging + consume + settle + the dialog check, well inside the 12 000 ms grace period
    expect(sigAt[0]?.at ?? Infinity).toBeLessThan(EXIT_DIALOG_CHECK_MS + 3_000);
    expect(sigAt.map((s) => s.sig)).not.toContain('SIGKILL');
    expect(info.reason).toBe('closed');
  });

  it('D-27 / P-LIFE-13: teardown order — owner-watch stop, hooks close, tail close, kill-server, cleanup, archive', async () => {
    const { fakes, result } = await launchWorld();
    await fakes.clock.advanceAsync(1000);
    const h = result.handles;
    const order: string[] = [];
    const wrap = <T extends object>(o: T | undefined, m: keyof T, name: string): void => {
      if (o === undefined) return;
      const f = o[m] as unknown as (...a: unknown[]) => unknown;
      (o as Record<keyof T, unknown>)[m] = (...a: unknown[]) => {
        order.push(name);
        return f.apply(o, a);
      };
    };
    wrap(h.ownerWatch, 'stop', 'ownerWatch.stop');
    wrap(h.hooks.transport, 'close', 'hooks.close');
    wrap(h.tail, 'close', 'tail.close');
    wrap(h.tmux.server, 'kill', 'tmux.kill');
    wrap(fakes.runtimeDir, 'removeSessionDir', 'removeSessionDir');
    wrap(h.store, 'archive', 'archive');
    await pump(fakes, result.lifecycle.close({}, { canExitGracefully: () => true }));
    expect(order).toEqual(['ownerWatch.stop', 'hooks.close', 'tail.close', 'tmux.kill', 'removeSessionDir', 'archive']);
  });

  it('ICR 0022: close keeps a seeded trust key while another session uses the cwd; the last one out removes it', async () => {
    const { fakes, result } = await launchWorld({ ports: { trusted: false }, config: { trust: { mode: 'seed', acceptRisks: false } } });
    const h = result.handles;
    await h.store.writeSession(record(KEY2, { cwdRealpath: h.cwdRealpath, trustKeyAddedByLibrary: false }));
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    expect(fakes.claudeConfig.writes.map((w) => w.op)).toEqual(['seed']);
    expect(await fakes.claudeConfig.trustOf(h.cwdRealpath)).toMatchObject({ trusted: true });
    expect(fakes.state.files.get(TRUST_SEEDS_FILE)).toContain(h.cwdRealpath);
    // the other session (which never added the key itself) is the last one out
    const deps = { store: h.store, claudeConfig: fakes.claudeConfig };
    expect(await releaseTrustLocked(deps, { sessionKey: KEY2, cwdRealpath: h.cwdRealpath, ownedHint: false })).toBe('unseeded');
    expect(fakes.claudeConfig.writes.map((w) => w.op)).toEqual(['seed', 'unseed']);
    expect(fakes.state.files.has(TRUST_SEEDS_FILE)).toBe(false);
  });

  it('P-LIFE-22: waitForBackgroundMs waits for quiescence, bounded by the timeout', async () => {
    const { fakes, result } = await launchWorld();
    await fakes.clock.advanceAsync(500);
    const t0 = fakes.clock.now();
    await pump(
      fakes,
      result.lifecycle.close({ waitForBackgroundMs: 4000 }, { waitBackgroundQuiescent: () => new Promise(() => undefined) }),
    );
    expect(fakes.clock.now() - t0).toBeGreaterThanOrEqual(4000);
  });

  it('unseeds trust it added; keepClaudeDebugFile keeps the 0700 session dir (P-REV-27)', async () => {
    const { fakes, result } = await launchWorld({
      ports: { trusted: false },
      config: { trust: { mode: 'seed', acceptRisks: false }, debug: { claudeDebugFile: true, keepClaudeDebugFile: true } },
    });
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    expect(fakes.claudeConfig.writes.map((w) => w.op)).toEqual(['seed', 'unseed']);
    expect(fakes.runtimeDir.removed).toEqual([]);
    expect((await result.handles.store.readArchive(TEST_SESSION_KEY))?.keptSessionDir).toBe(true);
  });

  it('the debug file is deleted with the session dir by default', async () => {
    const { fakes, result } = await launchWorld({ config: { debug: { claudeDebugFile: true } } });
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    expect(fakes.runtimeDir.removed).toEqual([result.handles.sessionDir]);
  });

  it('finalizeAfterExit: Claude exited by itself → reason from the exit status, same cleanup', async () => {
    const { fakes, world, result } = await launchWorld();
    await fakes.clock.advanceAsync(500);
    world.current().terminate(1, null);
    const info = await pump(fakes, result.lifecycle.finalizeAfterExit());
    expect(info).toMatchObject({ exitStatus: 1, reason: 'crashed' });
    expect(fakes.hooks.instances[0]?.state).toBe('closed');
    expect(await result.lifecycle.close()).toBe(info);
  });
});

describe('registry duties', () => {
  it('markReady, persist (registry.persist intent), A-1 heartbeat every 10 s', async () => {
    const { fakes, result } = await launchWorld();
    const lc = result.lifecycle;
    await lc.markReady();
    await lc.persist({
      claudeSessionId: 'new-id',
      transcriptPath: '/t.jsonl',
      state: 'idle',
      lastEventSeq: 42,
      usageLimit: { state: 'limited', resetsAtWall: 99 as WallMs } as never,
    });
    let rec = await result.handles.store.readSession(TEST_SESSION_KEY);
    expect(rec).toMatchObject({
      state: 'ready',
      claudeSessionId: 'new-id',
      transcriptPath: '/t.jsonl',
      status: 'idle',
      lastEventSeq: 42,
      usageLimit: { resetsAtWall: 99 },
    });
    await lc.persist({ usageLimit: null });
    rec = await result.handles.store.readSession(TEST_SESSION_KEY);
    expect(rec?.usageLimit).toBeUndefined();
    const before = (await result.handles.store.readOwner(fakes.ownerPid))?.heartbeatAt ?? 0;
    lc.startHeartbeat();
    await fakes.clock.advanceAsync(10_050);
    const after = (await result.handles.store.readOwner(fakes.ownerPid))?.heartbeatAt ?? 0;
    expect(after - before).toBeGreaterThanOrEqual(10_000);
    lc.stopHeartbeat();
    await pump(fakes, lc.close({ mode: 'kill' }));
  });

  it('signal() only reaches the verified pid', async () => {
    const { fakes, result } = await launchWorld();
    fakes.process.reusePid(result.handles.claude.pid, 'other');
    expect(await result.lifecycle.signal('SIGTERM')).toBe(false);
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
  });
});

describe('process-exit registry (P-LIFE-09, P-REV-43) and signal handlers (P-LIFE-29)', () => {
  it('killSync on process exit: SIGTERM Claude + sync kill-server; registry entries stay', async () => {
    const { fakes, result } = await launchWorld();
    const fp = fakeProc();
    result.lifecycle.registerExit(fp.proc);
    expect(exitRegistry().entries.has(TEST_SESSION_KEY)).toBe(true);
    fp.emit('exit');
    expect(fakes.process.killCalls.filter((k) => k.pid === result.handles.claude.pid).map((k) => k.sig)).toEqual(['SIGTERM']);
    const sync = fakes.process.syncCalls.find((c) => c.args.includes('kill-server'));
    expect(sync?.args).toEqual(['-S', result.handles.tmux.server.socketPath, 'kill-server']);
    expect(await result.handles.store.readSession(TEST_SESSION_KEY)).toBeDefined();
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    expect(exitRegistry().entries.has(TEST_SESSION_KEY)).toBe(false);
  });

  it('two module copies share one globalThis registry and install one exit hook', async () => {
    const a = await import('../../../src/session/lifecycle.js');
    vi.resetModules();
    const copy2 = '../../../src/session/lifecycle.js?copy=2';
    const b = (await import(/* @vite-ignore */ copy2)) as typeof a;
    expect(b.registerForExit).not.toBe(a.registerForExit);
    const fp = fakeProc();
    const seen: string[] = [];
    const offA = a.registerForExit({ sessionKey: 'sA', killSync: () => seen.push('A'), close: () => Promise.resolve() }, fp.proc);
    const offB = b.registerForExit({ sessionKey: 'sB', killSync: () => seen.push('B'), close: () => Promise.resolve() }, fp.proc);
    expect(a.exitRegistry()).toBe(b.exitRegistry());
    expect((globalThis as unknown as Record<symbol, unknown>)[EXIT_REGISTRY_KEY]).toBe(a.exitRegistry());
    expect(fp.listeners.get('exit')).toHaveLength(1);
    fp.emit('exit');
    expect(seen.sort()).toEqual(['A', 'B']);
    offA();
    offB();
    expect(a.exitRegistry().entries.size).toBe(0);
  });

  it('first signal closes gracefully then re-raises; a second signal forces kill', async () => {
    const fp = fakeProc();
    const modes: string[] = [];
    let release: () => void = () => undefined;
    const off = registerForExit(
      {
        sessionKey: 'sSig',
        killSync: () => undefined,
        close: (o) => {
          modes.push(o.mode ?? 'graceful');
          return o.mode === 'kill' ? Promise.resolve() : new Promise<void>((r) => (release = r));
        },
      },
      fp.proc,
    );
    const uninstall = installSignalHandlers({ signals: ['SIGINT'], proc: fp.proc });
    expect(installSignalHandlers({ signals: ['SIGINT'], proc: fp.proc })).toBe(uninstall); // idempotent
    fp.emit('SIGINT', 'SIGINT');
    fp.emit('SIGINT', 'SIGINT');
    await new Promise((r) => setImmediate(r));
    expect(modes).toEqual(['graceful', 'kill']);
    expect(fp.kills).toEqual([[777, 'SIGINT']]);
    expect(fp.listeners.get('SIGINT')).toEqual([]);
    release();
    await new Promise((r) => setImmediate(r));
    off();
  });

  it('closeAll closes every registered session', async () => {
    const closed: string[] = [];
    const offs = ['s1', 's2'].map((k) =>
      registerForExit({ sessionKey: k, killSync: () => undefined, close: () => Promise.resolve(void closed.push(k)) }, fakeProc().proc),
    );
    await closeAll({ mode: 'kill' });
    expect(closed.sort()).toEqual(['s1', 's2']);
    for (const o of offs) o();
  });
});

describe('fail closed (P-SEC-31, P-NET-25, §3.5)', () => {
  it('P-SEC-31: verifySettingsIntegrity compares the recorded sha256; a read error counts as tampered', async () => {
    const { fakes, result } = await launchWorld();
    const l = result.lifecycle;
    expect(await l.verifySettingsIntegrity()).toBe('intact');
    fakes.settingsFile.tamper(result.settingsPath, '{"hooks":{}}');
    expect(await l.verifySettingsIntegrity()).toBe('tampered');
    const matches = fakes.settingsFile.matches.bind(fakes.settingsFile);
    fakes.settingsFile.matches = () => Promise.reject(new Error('EACCES'));
    expect(await l.verifySettingsIntegrity()).toBe('tampered');
    fakes.settingsFile.matches = matches;
    await pump(fakes, l.close({ mode: 'kill' }));
  });

  it('failClosed(immediate) SIGKILLs only the verified pid, once, and records it in the exits log', async () => {
    const { fakes, result } = await launchWorld();
    const pid = result.handles.claude.pid;
    const out = await pump(fakes, result.lifecycle.failClosed('settingsTampered', { immediate: true }));
    expect(out).toBe('killed');
    expect(fakes.process.killCalls.filter((k) => k.pid === pid).map((k) => k.sig)).toEqual(['SIGKILL']);
    expect(result.lifecycle.failedClosed).toBe('settingsTampered');
    expect(await pump(fakes, result.lifecycle.failClosed('again'))).toBe('skipped');
    expect(fakes.state.files.get(`exits/${TEST_SESSION_KEY}.log`)).toContain('failClosed reason=settingsTampered');
    const info = await pump(fakes, result.lifecycle.finalizeAfterExit());
    expect(info.reason).toBe('killed');
  });

  it('P-TMUX-61 / P-LIFE-08: a non-immediate failClosed sends SIGTERM first and SIGKILL only after killAfterMs', async () => {
    const { fakes, result } = await launchWorld();
    const pid = result.handles.claude.pid;
    fakes.process.procs.get(pid)?.ignores.add('SIGTERM');
    const t0 = fakes.clock.now();
    const out = await pump(fakes, result.lifecycle.failClosed('sidecarDied'));
    expect(out).toBe('killed');
    expect(fakes.process.killCalls.filter((k) => k.pid === pid).map((k) => k.sig)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fakes.clock.now() - t0).toBeGreaterThanOrEqual(3_000);
    await pump(fakes, result.lifecycle.finalizeAfterExit());
  });

  it('never fails closed during close; a reused pid is never signalled', async () => {
    const a = await launchWorld();
    const closing = a.result.lifecycle.close({ mode: 'kill' });
    expect(await a.result.lifecycle.failClosed('late')).toBe('skipped');
    await pump(a.fakes, closing);
    const b = await launchWorld();
    b.fakes.process.reusePid(b.result.handles.claude.pid, 'vim notes');
    expect(await pump(b.fakes, b.result.lifecycle.failClosed('x', { immediate: true }))).toBe('identity-mismatch');
    expect(b.fakes.process.killCalls.filter((k) => k.pid === b.result.handles.claude.pid)).toEqual([]);
    await pump(b.fakes, b.result.lifecycle.close({ mode: 'kill' }));
  });

  it('guards are cancelled at teardown (and at once when added after it)', async () => {
    const { fakes, result } = await launchWorld();
    const cancelled: string[] = [];
    result.lifecycle.addGuard(() => cancelled.push('a'));
    await pump(fakes, result.lifecycle.close({ mode: 'kill' }));
    expect(cancelled).toEqual(['a']);
    result.lifecycle.addGuard(() => cancelled.push('b'));
    expect(cancelled).toEqual(['a', 'b']);
  });
});

describe('P-API-17: the exit handler is synchronous', () => {
  it('killSync uses only sync calls (kill + execSyncBestEffort kill-server on the recorded socket)', async () => {
    const { fakes, result } = await launchWorld();
    const exec = vi.spyOn(fakes.process, 'exec');
    const sync = vi.spyOn(fakes.process, 'execSyncBestEffort');
    result.lifecycle.killSync();
    expect(exec).not.toHaveBeenCalled();
    const call = sync.mock.calls[0];
    expect(call?.[0]).toBe(result.handles.tmux.bin);
    expect(call?.[1].at(-1)).toBe('kill-server');
    expect(call?.[1]).toContain(result.handles.tmux.server.socketPath.startsWith('/') ? '-S' : '-L');
    expect(fakes.process.isAlive(result.handles.claude.pid)).toBe(false);
    await pump(fakes, result.lifecycle.finalizeAfterExit());
  });
});
