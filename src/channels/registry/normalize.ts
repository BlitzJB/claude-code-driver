// channels/registry/normalize.ts — Claude's own registry record → `registry` observation (DESIGN.md §2.4, §2.8, D-23;
// P-PRIOR-04). The single post-launch read of `~/.claude/sessions/<pid>.json` (the statusLine/registry *channels* were cut in
// rev 2, §10 C8); the core uses it only as a weak corroboration of the session id / version / status.
//
// Pure and total: never throws, never does I/O. Lenient (P-PRIOR-04): the L0 reader already took the first complete JSON
// object and never opened `*.key` files; here every field is re-checked anyway because the record may also come from a
// replayed trace. A missing record (not written yet, unreadable) yields no observation. A record with an invalid pid yields
// one `unknown` observation (channel noise, never a fact). Wrong-typed or empty optional fields are dropped, over-long ones
// are cut, control characters are removed. Fields the observation does not carry (`tmux`, `procStart`) are not forwarded:
// pid identity (procStart) is checked by L3 (`process.identityMismatch`), never inferred here. The session id is never
// filtered (rev 2 §10 A5): it is reported as `meta.claudeSessionId` for the core's generation join.

import type { ObsMeta, Observation, ObservationInput } from '../../model/observation.js';
import type { MonoMs, WallMs } from '../../model/time.js';
import type { ClaudeRegistryReader } from '../../platform/ports.js';

type RegistryRead = Awaited<ReturnType<ClaudeRegistryReader['read']>>;
type RegistryPayload = Extract<Observation, { kind: 'registry' }>['p'];
type Meta = Omit<ObsMeta, 'seq'>;

const MAX_FIELD = 256;
const MAX_PID = 4_194_304; // Linux pid_max upper bound; macOS is far below
/** Whole terminal escape sequences (CSI incl. 8-bit `\x9b`, OSC up to BEL/ST, two-byte ESC x), removed before single controls
 *  so no `[31m` residue is left behind. */
const ESCAPES = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-~]/g;
/** C0/C1 controls plus bidi overrides/isolates, zero-width characters and the BOM (display spoofing, never data). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function cleanString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(ESCAPES, '').replace(CONTROL, '').trim();
  if (s.length === 0) return undefined;
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

function validPid(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_PID;
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

export function normalizeRegistry(rec: RegistryRead, at: MonoMs, wallAt: WallMs): ObservationInput[] {
  const meta: Meta = { at: finite(at) as MonoMs, wallAt: finite(wallAt) as WallMs, source: 'registry' };
  try {
    const v: unknown = rec; // re-checked: the record may come from a replayed trace
    if (v === undefined || v === null) return [];
    if (typeof v !== 'object') return [{ kind: 'unknown', meta, p: { channel: 'registry', raw: { reason: 'notAnObject' } } }];
    const o = v as Record<string, unknown>;
    if (!validPid(o['pid'])) {
      return [{ kind: 'unknown', meta, p: { channel: 'registry', raw: { reason: 'invalidPid', pid: typeof o['pid'] } } }];
    }
    const p: RegistryPayload = { pid: o['pid'] };
    const sessionId = cleanString(o['sessionId']);
    const status = cleanString(o['status']);
    const waitingFor = cleanString(o['waitingFor']);
    const version = cleanString(o['version']);
    if (sessionId !== undefined) p.sessionId = sessionId;
    if (status !== undefined) p.status = status;
    if (waitingFor !== undefined) p.waitingFor = waitingFor;
    if (version !== undefined) p.version = version;
    const m: Meta = sessionId === undefined ? meta : { ...meta, claudeSessionId: sessionId };
    return [{ kind: 'registry', meta: m, p }];
  } catch {
    // Unreachable for plain data; a hostile getter on a replayed object must still not throw out of L1.
    return [{ kind: 'unknown', meta, p: { channel: 'registry', raw: { reason: 'normalizeError' } } }];
  }
}
