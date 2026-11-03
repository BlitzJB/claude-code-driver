// core/claims.ts — screen claims: candidate → asserted → confirmed | retracted | expired (DESIGN.md §4.6 Claims, RC §8, D-41).
// The single owner of screen stability. L1 emits a frame only when its hash changes, so "2 frames" means the value
// survived one further change of the bottom region, or one stability check at `stableSince + stableMs` while the latest
// frame still shows it (the deadline wakes the core; an unchanged screen produces no observation).

import type { JsonValue } from '../model/json.js';
import type { ScreenFacts } from '../model/screen-facts.js';
import type { MonoMs } from '../model/time.js';
import { arm, captureNow, cfg, disarm, nowOf, publish, recon, seqOf, updRecon } from './ctx.js';
import type { Ctx } from './ctx.js';
import type { Claim } from './facts.js';

export interface ClaimSpec {
  key: string;
  value: JsonValue;
  /** dialog/gate surfaces need claimDialogStableMs (250) instead of claimMinStableMs (100) */
  dialog: boolean;
}

const DIALOG_SURFACES = new Set([
  'permissionDialog',
  'trustDialog',
  'usageLimitMenu',
  'resumeDialog',
  'startupGate',
  'modal',
  'unknownModal',
]);
const NON_CLAIM_SURFACES = new Set(['main', 'blank', 'partialFrame', 'editorOpen']);

function compact(o: Record<string, JsonValue | undefined>): JsonValue {
  const r: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
  return r;
}

/** Claim keys of one frame (scope rules of §4.6: never entity creation; metrics such as spinner glyphs are not keys). */
export function claimsOfFrame(f: ScreenFacts): ClaimSpec[] {
  const out: ClaimSpec[] = [];
  if (!NON_CLAIM_SURFACES.has(f.surface)) {
    out.push({
      key: `surface:${f.surface}`,
      value: compact({ surface: f.surface, gate: f.dialog?.gate, title: f.dialog?.title, question: f.dialog?.question }),
      dialog: DIALOG_SURFACES.has(f.surface),
    });
  }
  if (f.dialog !== undefined) {
    out.push({
      key: `dialog:${f.dialog.kind}`,
      value: compact({
        kind: f.dialog.kind,
        gate: f.dialog.gate,
        title: f.dialog.title,
        question: f.dialog.question,
        options: f.dialog.options.map((o) => compact({ n: o.n, label: o.label, selected: o.selected })),
      }),
      dialog: true,
    });
  }
  const st = f.status;
  if (st !== undefined && st.kind !== 'none') {
    const kind = st.kind === 'retryingUnparsed' ? 'retrying' : st.kind;
    out.push({
      key: `status:${kind}`,
      value: compact({
        kind,
        attempt: st.attempt,
        max: st.max,
        retryInMs: st.retryInMs,
        errorHint: st.errorHint,
        resetsAtWall: st.resetsAtWall,
        doneDurationMs: st.doneDurationMs,
      }),
      dialog: false,
    });
  }
  if (f.interruptedBanner) out.push({ key: 'interruptedBanner', value: true, dialog: false });
  if (f.usageLimit !== undefined) {
    out.push({
      key: 'usageLimit',
      value: compact({
        line: f.usageLimit.line,
        limitName: f.usageLimit.limitName,
        resetsAtWall: f.usageLimit.resetsAtWall,
        autoContinue: f.usageLimit.autoContinue,
      }),
      dialog: false,
    });
  }
  if (f.auth !== undefined)
    out.push({ key: `auth:${f.auth.kind}`, value: compact({ kind: f.auth.kind, line: f.auth.line }), dialog: false });
  if (f.versionTooOld === true) out.push({ key: 'versionTooOld', value: true, dialog: false });
  if (isIdleMain(f)) out.push({ key: 'idleMain', value: true, dialog: false });
  return out;
}

/** main surface, empty composer (placeholder counts as empty), footer not busy, no spinner (§4.3 readiness). */
export function isIdleMain(f: ScreenFacts | undefined): boolean {
  if (f === undefined || f.torn || f.surface !== 'main') return false;
  if (f.composer === undefined) return false;
  if (!(f.composer.empty || f.composer.placeholderLikely)) return false;
  if (f.footer?.busy === true) return false;
  const k = f.status?.kind;
  return k === undefined || k === 'none' || k === 'done' || k === 'interrupted' || k === 'waitingBackground';
}

const ACTIVE = (c: Claim): boolean => c.status === 'candidate' || c.status === 'asserted' || c.status === 'confirmed';
const isAsserted = (c: Claim | undefined): boolean => c !== undefined && (c.status === 'asserted' || c.status === 'confirmed');

export function claim(ctx: Ctx, key: string): Claim | undefined {
  const c = recon(ctx).claims[key];
  return c !== undefined && ACTIVE(c) ? c : undefined;
}
export function assertedClaim(ctx: Ctx, key: string): Claim | undefined {
  const c = claim(ctx, key);
  return isAsserted(c) ? c : undefined;
}

function stableMs(ctx: Ctx, dialog: boolean): number {
  const t = cfg(ctx).timeouts;
  return dialog ? t.claimDialogStableMs : t.claimMinStableMs;
}
function ttlMs(ctx: Ctx): number {
  const interval = recon(ctx).cadence ?? cfg(ctx).channels.screen.idlePollMs;
  const base = 2 * interval + 500;
  return Math.max(base, cfg(ctx).timeouts.claimTtlMs);
}

function putClaim(ctx: Ctx, c: Claim): void {
  updRecon(ctx, (r) => ({ ...r, claims: { ...r.claims, [c.key]: c } }));
}
function dropClaim(ctx: Ctx, key: string): void {
  updRecon(ctx, (r) => {
    const { [key]: _gone, ...rest } = r.claims;
    return { ...r, claims: rest };
  });
  disarm(ctx, 'claimTtl', `stable:${key}`);
  disarm(ctx, 'claimTtl', `ttl:${key}`);
}

export interface ClaimDelta {
  asserted: Claim[];
  ended: Claim[];
  /** asserted claims whose value changed this frame */
  updated: Claim[];
}

function isDialogKey(key: string): boolean {
  return key.startsWith('dialog:') || (key.startsWith('surface:') && DIALOG_SURFACES.has(key.slice('surface:'.length)));
}

function assert(ctx: Ctx, c: Claim, delta: ClaimDelta): Claim {
  const a: Claim = { ...c, status: 'asserted' };
  putClaim(ctx, a);
  disarm(ctx, 'claimTtl', `stable:${c.key}`);
  arm(ctx, 'claimTtl', `ttl:${c.key}`, a.lastSeenAt + ttlMs(ctx));
  publish(ctx, 'claim.asserted', { claim: c.key, value: c.value }, { confirmed: false, sources: ['screen'] });
  delta.asserted.push(a);
  return a;
}

/** Apply one non-torn frame to the claim table. */
export function updateClaims(ctx: Ctx, f: ScreenFacts, at: MonoMs): ClaimDelta {
  const delta: ClaimDelta = { asserted: [], ended: [], updated: [] };
  const present = new Map(claimsOfFrame(f).map((s) => [s.key, s]));
  for (const c of Object.values(recon(ctx).claims)) {
    if (!ACTIVE(c) || present.has(c.key)) continue;
    if (c.status === 'candidate') {
      dropClaim(ctx, c.key);
      continue;
    }
    dropClaim(ctx, c.key);
    publish(ctx, 'claim.expired', { claim: c.key, value: c.value }, { confirmed: false, sources: ['screen'] });
    delta.ended.push({ ...c, status: 'expired' });
  }
  for (const s of present.values()) {
    const cur = claim(ctx, s.key);
    if (cur === undefined) {
      const c: Claim = {
        key: s.key,
        value: s.value,
        firstSeenSeq: seqOf(ctx),
        stableSince: at,
        frames: 1,
        expiresAt: (at + ttlMs(ctx)) as MonoMs,
        status: 'candidate',
        lastSeenAt: at,
      };
      putClaim(ctx, c);
      arm(ctx, 'claimTtl', `stable:${s.key}`, at + stableMs(ctx, s.dialog));
      continue;
    }
    const valueChanged = JSON.stringify(cur.value) !== JSON.stringify(s.value);
    const next: Claim = { ...cur, value: s.value, frames: cur.frames + 1, lastSeenAt: at, expiresAt: (at + ttlMs(ctx)) as MonoMs };
    putClaim(ctx, next);
    if (next.status === 'candidate') {
      if (next.frames >= 2 && at - next.stableSince >= stableMs(ctx, s.dialog)) assert(ctx, next, delta);
    } else {
      arm(ctx, 'claimTtl', `ttl:${s.key}`, at + ttlMs(ctx));
      if (valueChanged) delta.updated.push(next);
    }
  }
  return delta;
}

/** `claimTtl` deadline: stability check (`stable:<key>`) or TTL expiry (`ttl:<key>`). */
export function onClaimDeadline(ctx: Ctx, ref: string): ClaimDelta {
  const delta: ClaimDelta = { asserted: [], ended: [], updated: [] };
  const [kind, ...rest] = ref.split(':');
  const key = rest.join(':');
  const c = claim(ctx, key);
  if (c === undefined) return delta;
  const last = recon(ctx).lastFrame;
  const stillShown = last !== undefined && !last.torn && claimsOfFrame(last).some((s) => s.key === key);
  if (kind === 'stable') {
    if (c.status === 'candidate' && stillShown && nowOf(ctx) - c.stableSince >= stableMs(ctx, isDialogKey(key))) assert(ctx, c, delta);
    else if (c.status === 'candidate' && stillShown) captureNow(ctx, 'claimStability');
    return delta;
  }
  // TTL: an unchanged screen produces no new frame, so a claim still shown by the latest frame of a healthy screen
  // channel is extended; otherwise (channel down, frames stopped) it expires.
  const screenUp = (recon(ctx).transport.screen ?? 'up') === 'up';
  if (stillShown && screenUp) {
    arm(ctx, 'claimTtl', `ttl:${key}`, nowOf(ctx) + ttlMs(ctx));
    return delta;
  }
  dropClaim(ctx, key);
  publish(ctx, 'claim.expired', { claim: key, value: c.value }, { confirmed: false, sources: ['screen'] });
  delta.ended.push({ ...c, status: 'expired' });
  return delta;
}

/** A higher-ranked observation with the same meaning (§4.6). */
export function confirmClaim(ctx: Ctx, key: string): void {
  const c = claim(ctx, key);
  if (c === undefined || c.status === 'confirmed') return;
  putClaim(ctx, { ...c, status: 'confirmed' });
  publish(ctx, 'claim.confirmed', { claim: key, value: c.value });
}

/** Expire every active claim (screen channel down, process exit). */
export function expireAllClaims(ctx: Ctx): void {
  for (const c of Object.values(recon(ctx).claims)) {
    if (!ACTIVE(c)) continue;
    dropClaim(ctx, c.key);
    if (c.status !== 'candidate')
      publish(ctx, 'claim.expired', { claim: c.key, value: c.value }, { confirmed: false, sources: ['screen'] });
  }
}
