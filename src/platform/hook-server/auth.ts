// platform/hook-server/auth.ts — request authentication for the hook servers (DESIGN.md §3.5, SEC §2.3, HT §6).
//
// Loaded inside the hook worker by a computed `import()` (worker.ts may import node:* only, §1.4 3c), so this module, like
// every module the worker loads, imports node:* only and uses only erasable TypeScript syntax (Node's type stripping runs it
// from src in tests; tsc emits it to dist).
import { timingSafeEqual } from 'node:crypto';

/** Header carrying the per-session hook token, written literally into the 0600 settings file (D-12, P-HOOK-22). */
export const TOKEN_HEADER = 'x-ccd-token';

/** 64 lowercase hex characters (`IdPort.tokenHex(32)`); never contains `$`, so header interpolation cannot mangle it. */
export const TOKEN_RE = /^[0-9a-f]{64}$/;
/** The non-secret session short id used as the URL path segment `/h/<sid>/<Event>`. */
export const SESSION_SHORT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Hook event names are plain identifiers; anything else is never routed. */
export const EVENT_NAME_RE = /^[A-Za-z]{1,64}$/;

/** Why a request was refused with 403 (checks 1–5 of SEC §2.3, in order). */
export type HttpAuthFailure = 'method' | 'path' | 'event' | 'host' | 'origin' | 'contentType' | 'token';

export interface HttpRequestHead {
  method: string | undefined;
  url: string | undefined;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}
export interface HttpAuthConfig {
  sessionShortId: string;
  port: number;
  token: string;
  /** Events registered over HTTP; a path naming any other event is refused (SEC §2.3 step 1). */
  events: ReadonlySet<string>;
}
export type HttpAuthResult = { ok: true; event: string } | { ok: false; reason: HttpAuthFailure };

export function isValidToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

export function isValidSessionShortId(sid: unknown): sid is string {
  return typeof sid === 'string' && SESSION_SHORT_ID_RE.test(sid);
}

/** Constant-time token comparison after a length check (SEC §2.3 step 5). Arrays (a repeated header) never match. */
export function tokenEquals(given: string | readonly string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || b.length === 0) return false;
  return timingSafeEqual(a, b);
}

function single(h: string | string[] | undefined): string | undefined {
  return typeof h === 'string' ? h : undefined;
}

/**
 * The SEC §2.3 checks, in order: method POST; path `^/h/<sid>/<Event>$` with Event registered; `Host` exactly
 * `127.0.0.1:<port>` (DNS-rebinding defence); no `Origin` and no `Sec-Fetch-*`; `Content-Type` starts with
 * `application/json`; `X-CCD-Token` equal by `timingSafeEqual`. The first failing check is reported.
 */
export function checkHttpRequest(head: HttpRequestHead, cfg: HttpAuthConfig): HttpAuthResult {
  if (head.method !== 'POST') return { ok: false, reason: 'method' };
  const url = head.url ?? '';
  const prefix = `/h/${cfg.sessionShortId}/`;
  if (!url.startsWith(prefix)) return { ok: false, reason: 'path' };
  const event = url.slice(prefix.length);
  if (!EVENT_NAME_RE.test(event)) return { ok: false, reason: 'path' };
  if (!cfg.events.has(event)) return { ok: false, reason: 'event' };
  if (single(head.headers['host']) !== `127.0.0.1:${cfg.port}`) return { ok: false, reason: 'host' };
  if (head.headers['origin'] !== undefined) return { ok: false, reason: 'origin' };
  for (const name of Object.keys(head.headers)) if (name.startsWith('sec-fetch-')) return { ok: false, reason: 'origin' };
  const ct = single(head.headers['content-type']);
  if (!(ct?.toLowerCase().startsWith('application/json') ?? false)) return { ok: false, reason: 'contentType' };
  if (!tokenEquals(head.headers[TOKEN_HEADER], cfg.token)) return { ok: false, reason: 'token' };
  return { ok: true, event };
}
