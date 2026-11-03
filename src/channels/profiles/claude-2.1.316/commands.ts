// channels/profiles/claude-2.1.316/commands.ts — OWNED BY WP-07 (DESIGN.md §1.2, §3.6 Commands; ICR 0001 item 6).
// Slash-command aliases of Claude Code 2.1.316 and the library's allow/deny/refuse tables. Every rule and every completion
// check applies to the CANONICAL name only (P-REV-02): `/quit` is `/exit` (immediate: it runs even while busy), `/new` and
// `/reset` are `/clear`, `/cost` and `/stats` are `/usage`, `/continue` is `/resume`, `/checkpoint` and `/undo` are `/rewind`,
// `/settings` is `/config`, `/bashes` is `/tasks`, `/update` is `/restart`, `/allowed-tools` is `/permissions`, …
// Alias table VERIFIED-BIN (2.1.316 command objects `{name, aliases}`), `/cost` → `<command-name>/usage</command-name>`
// VERIFIED-LIVE (phase0-probes.md LP-33/LP-45). `commandsProfile` has the fixed export name and type the WP-00 assembly imports
// (§8); `commandsExtras` carries the tables the assembly type has no slot for. WP-09 consumes both through the profile.

import type { ClaudeProfile } from '../index.js';

/** alias → canonical name (VERIFIED-BIN `aliases:[…]`). Key-name tables of the binary (`alt`, `cmd`, `ctrl`) are not commands. */
const ALIASES = {
  '/quit': '/exit',
  '/new': '/clear',
  '/reset': '/clear',
  '/cost': '/usage',
  '/stats': '/usage',
  '/continue': '/resume',
  '/checkpoint': '/rewind',
  '/undo': '/rewind',
  '/settings': '/config',
  '/bashes': '/tasks',
  '/update': '/restart',
  '/allowed-tools': '/permissions',
  '/plugins': '/plugin',
  '/marketplace': '/plugin',
  '/checkup': '/doctor',
  '/name': '/rename',
  '/bg': '/background',
  '/share': '/feedback',
  '/rc': '/remote-control',
  '/tp': '/teleport',
  '/remote': '/session',
  '/routines': '/schedule',
  '/peers': '/list-agents',
  '/app': '/desktop',
  '/ios': '/mobile',
  '/android': '/mobile',
  '/memory-pause': '/pause-memory',
  '/toggle-memory': '/pause-memory',
  '/breaks': '/wellbeing',
  '/break-reminder': '/wellbeing',
  '/downtime': '/wellbeing',
} as const;

export const commandsProfile: ClaudeProfile['commands'] = Object.freeze({
  aliases: Object.freeze({ ...ALIASES }),
});

/**
 * §3.6 allowlist (canonical names). ICR 0001 item 6: `/cost` became `/usage` (still reachable as `/cost` through the alias);
 * `/rewind` was removed in rev 2 (picker with no driving flow).
 */
const ALLOWED = ['/clear', '/compact', '/model', '/effort', '/rename', '/context', '/usage', '/status', '/help'] as const;

/**
 * §3.6 denylist (canonical names; `/bashes` of the rev 2 list is the alias of `/tasks`, `/settings` of `/config`).
 * Denied commands need `unsafe:true`; `REFUSED_ALWAYS` are refused even then.
 */
const DENIED = [
  '/permissions',
  '/hooks',
  '/config',
  '/login',
  '/logout',
  '/add-dir',
  '/mcp',
  '/sandbox',
  '/terminal-setup',
  '/install-github-app',
  '/plugin',
  '/agents',
  '/tasks',
  '/vim',
  '/keybindings',
  '/doctor',
  '/upgrade',
  '/tui',
  '/restart',
  '/resume',
  '/exit',
  '/background',
  '/rate-limit-options',
  '/usage-credits',
] as const;

/** Refused even with `unsafe` (LC §10.4): `close()` is the only exit path; `/rewind` has no driving flow. */
const REFUSED_ALWAYS = ['/tui', '/restart', '/resume', '/exit', '/rewind'] as const;

/**
 * Commands with `immediate:!0` (VERIFIED-BIN): they run at once even while Claude is busy, through the trimmed lookup of the
 * busy path (LP-45). Documented for P-REV-02; the allowed ones among them (`/model`, `/effort`, `/rename`, `/status`, `/usage`)
 * are read-only or session-local.
 */
const IMMEDIATE = [
  '/exit',
  '/usage',
  '/model',
  '/effort',
  '/status',
  '/rename',
  '/permissions',
  '/tasks',
  '/feedback',
  '/remote-control',
  '/wellbeing',
  '/stop',
  '/goal',
  '/loops',
  '/workflows',
  '/skills',
  '/skill-doctor',
  '/artifacts',
  '/btw',
  '/autocompact',
  '/brief',
  '/color',
  '/daemon',
  '/import',
  '/version',
] as const;

export interface CommandsExtras {
  /** `^/[a-z][a-z0-9:_-]*$` (§3.6). */
  readonly namePattern: RegExp;
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
  readonly refusedAlways: readonly string[];
  readonly immediate: readonly string[];
  /** Canonical name of a command name (`/QUIT` is not a command name; only exact lower-case names are canonicalised). */
  readonly canonical: (name: string) => string;
  /** Rule outcome for a canonical-or-alias name: allowed, needs `unsafe:true`, refused, or not a valid name. */
  readonly classify: (name: string) => 'allowed' | 'unsafe' | 'refused' | 'invalid';
}

const has = (list: readonly string[], v: string): boolean => list.includes(v);

function canonical(name: string): string {
  return Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name as keyof typeof ALIASES] : name;
}

const NAME = /^\/[a-z][a-z0-9:_-]*$/u;

export const commandsExtras: CommandsExtras = Object.freeze({
  namePattern: NAME,
  allowed: Object.freeze([...ALLOWED]),
  denied: Object.freeze([...DENIED]),
  refusedAlways: Object.freeze([...REFUSED_ALWAYS]),
  immediate: Object.freeze([...IMMEDIATE]),
  canonical,
  classify: (name: string): 'allowed' | 'unsafe' | 'refused' | 'invalid' => {
    if (!NAME.test(name)) return 'invalid';
    const c = canonical(name);
    if (has(REFUSED_ALWAYS, c)) return 'refused';
    if (has(ALLOWED, c) && !has(DENIED, c)) return 'allowed';
    return 'unsafe';
  },
});
