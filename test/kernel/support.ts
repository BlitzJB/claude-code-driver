// test/kernel/support.ts — shared helpers of the kernel scenarios K-01…K-52 (DESIGN.md §6.3).
//
// Acceptance gating (§8 "initially it.fails until the owning WP lands"): a scenario runs as a normal `it` once every work
// package it needs has landed — the WPs named in its brackets plus the ones the test kernel itself needs (L1 normalizers,
// core, L3 loop/launcher/executors). Until then it runs as `it.fails`, so the suite stays green while it documents the
// acceptance criteria, and flips to a real assertion the moment the code exists (a failing scenario then names the WP).
// `CCD_KERNEL_STRICT=1` forces every scenario to `it` (see what would fail today).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Command, CommandResult } from '../../src/model/commands.js';
import type { DomainEvent } from '../../src/model/events.js';
import type { TurnKey } from '../../src/model/ids.js';
import type { FakeInvocation } from '../../src/platform/tmux/fake-tmux.js';
import { createTestKernel, SessionNotLanded, type TestKernel, type TestKernelOptions } from '../../src/testing/test-kernel.js';

const ROOT = join(import.meta.dirname, '..', '..');

/** A file per work package whose presence means "landed" (the WP's entry module, §1.2). */
const WP_SENTINELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '02': ['src/platform/fs-tail/tail.ts'],
  '03': ['src/platform/hook-server/transport.ts'],
  '05': ['src/platform/process/owner-watcher.ts', 'src/platform/process/fake-owner-watch.ts'],
  '06': ['src/channels/hooks/normalize.ts', 'src/channels/transcript/normalize.ts'],
  '07': ['src/channels/screen/classify.ts', 'src/channels/screen/debounce.ts'],
  '09': ['src/core/step.ts', 'src/core/init.ts'],
  '11': ['src/session/kernel.ts', 'src/session/config.ts', 'src/session/loop.ts', 'src/session/scheduler.ts'],
  '12': ['src/session/launcher.ts', 'src/session/lifecycle.ts', 'src/session/preflight.ts'],
  '13': ['src/session/input-executor.ts', 'src/session/permission-broker.ts', 'src/session/pollers.ts', 'src/session/tail-driver.ts'],
  '14': ['src/testing/test-kernel.ts'],
});

/** What `createTestKernel` needs before any scenario can run for real. */
const KERNEL_BASE = ['06', '07', '09', '11', '12', '13'] as const;

function landed(wp: string): boolean {
  const files = WP_SENTINELS[wp];
  if (files === undefined) throw new Error(`unknown work package ${wp}`);
  return files.every((f) => existsSync(join(ROOT, f)));
}

function acceptanceReady(wps: readonly string[]): boolean {
  return [...new Set([...KERNEL_BASE, ...wps])].every(landed);
}

const STRICT = process.env['CCD_KERNEL_STRICT'] === '1';

/** Real-time budget of one scenario (the fake clock does the waiting; this only bounds a hang). */
const SCENARIO_TIMEOUT_MS = 60_000;

/** The L3 entry points `createTestKernel` loads (testing/test-kernel.ts loadSessionModules). */
function sessionEntryLanded(): boolean {
  return existsSync(join(ROOT, 'src/session/kernel.ts')) && existsSync(join(ROOT, 'src/session/config.ts'));
}

/**
 * Declare scenario `id` (e.g. 'K-13') owned by `wps` (e.g. ['09']). Three states:
 *   - every needed WP landed (or CCD_KERNEL_STRICT=1): a normal `it`;
 *   - session/kernel.ts or session/config.ts missing: a normal `it` that asserts the scenario fails with exactly
 *     `SessionNotLanded`, so a bug in the scenario's own code (a TypeError before the kernel is created, a helper that
 *     swallows the not-landed error) is caught today instead of hiding behind `it.fails`;
 *   - the session entry exists but a bracketed WP has not landed: `it.fails` (any failure is expected while it is partial).
 */
export function kscenario(id: string, wps: readonly string[], title: string, fn: () => Promise<void>): void {
  const name = `${id} [${wps.join('/')}] ${title}`;
  if (STRICT || acceptanceReady(wps)) it(name, fn, SCENARIO_TIMEOUT_MS);
  else if (!sessionEntryLanded())
    it(
      `${name} (pending: session/** not landed)`,
      async () => {
        await expect(fn()).rejects.toBeInstanceOf(SessionNotLanded);
      },
      SCENARIO_TIMEOUT_MS,
    );
  else it.fails(name, fn, SCENARIO_TIMEOUT_MS);
}

// ------------------------------------------------------------------------------------------------------------ helpers

/** A ready test kernel (trusted cwd, handler policy unless overridden). */
export function boot(o: TestKernelOptions = {}): Promise<TestKernel> {
  return createTestKernel(o);
}

/** Error code of a CcdError (or the public facade error's `details.reason`). */
export function codeOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const c = (e as { code?: unknown }).code;
  const reason = (e as { details?: { reason?: unknown } }).details?.reason;
  // The internal CcdError carries the fine code in `code`; a public ClaudeSessionError carries it in `details.reason`.
  if (typeof reason === 'string' && reason.startsWith('E_')) return reason;
  return typeof c === 'string' ? c : undefined;
}

export function detailsOf(e: unknown): Record<string, unknown> {
  const d = (e as { details?: unknown } | null)?.details;
  return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {};
}

/** Send a prompt (whenBusy wait) and return its turn key. */
export async function send(tk: TestKernel, text: string, o: { whenBusy?: 'wait' | 'reject'; clientRef?: string } = {}): Promise<TurnKey> {
  const cmd: Command = {
    type: 'prompt.send',
    text,
    whenBusy: o.whenBusy ?? 'wait',
    ...(o.clientRef === undefined ? {} : { clientRef: o.clientRef }),
  };
  const r: CommandResult<Extract<Command, { type: 'prompt.send' }>> = await tk.dispatch<Extract<Command, { type: 'prompt.send' }>>(cmd);
  return r.turnKey;
}

/** Wait for `turn.ended` of `turnKey`. */
export function ended(tk: TestKernel, turnKey: TurnKey, maxMs = 30_000): Promise<Extract<DomainEvent, { type: 'turn.ended' }>> {
  return tk.waitForEvent('turn.ended', { pred: (e) => e.turnKey === turnKey, maxMs });
}

/** Send and wait for the end of the turn. */
export async function roundTrip(tk: TestKernel, text: string, maxMs = 30_000): Promise<Extract<DomainEvent, { type: 'turn.ended' }>> {
  const k = await send(tk, text);
  return ended(tk, k, maxMs);
}

const INPUT_OPS = new Set(['paste', 'typeLiteral', 'sendKey', 'exitCopyMode']);

/** Input operations (paste / typeLiteral / sendKey / exitCopyMode) since invocation index `from`. */
export function inputOps(tk: TestKernel, from = 0): FakeInvocation[] {
  return tk.fakes.tmux.invocations.slice(from).filter((i) => INPUT_OPS.has(i.op));
}

/** Keys sent since `from` (dropped ones included). */
export function keys(tk: TestKernel, from = 0): string[] {
  return tk.fakes.tmux.invocations.slice(from).flatMap((i) => (i.op === 'sendKey' ? [i.key] : []));
}

/** Current invocation and event indexes ("since now" marks). */
export function mark(tk: TestKernel): { inv: number; ev: number } {
  return { inv: tk.fakes.tmux.invocations.length, ev: tk.events.length };
}

/** Events of `type` published since mark `m`. */
export function since<T extends DomainEvent['type']>(tk: TestKernel, m: { ev: number }, type: T): Extract<DomainEvent, { type: T }>[] {
  return tk.events.slice(m.ev).filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);
}

/** fnv1a-32 over the UTF-16 code units (the §3.9 jitter formula's hash). */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** §3.9: jitterMs = jitterMinMs + fnv1a32(sessionKey:resetsAtWall:rearms) mod (jitterMaxMs − jitterMinMs + 1). */
export function expectedJitter(sessionKey: string, resetsAtWall: number, rearms: number, min = 30_000, max = 90_000): number {
  return min + (fnv1a32(`${sessionKey}:${resetsAtWall}:${rearms}`) % (max - min + 1));
}
