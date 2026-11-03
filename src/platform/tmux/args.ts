// platform/tmux/args.ts — TmuxArg, escapeArg, SEP and the command-list builder (DESIGN.md §2.7.3; TD §2.2, R2/R3).
//
// tmux parses its own argv even under execFile: an element that ENDS in ';' terminates the command and the ';' is dropped
// (P-TMUX-04). `escapeArg` rewrites the final ';' to '\;' (verified against every row of TD §2.2). The ONLY way to produce a
// bare ';' separator is the SEP token, inserted by the builder; every other element is a literal that is always escaped.
// Flags are always emitted before positionals (P-INPUT-39), and '--' precedes free text / argv (P-TMUX-05).

declare const sepBrand: unique symbol;
export interface Separator {
  readonly [sepBrand]: true;
}
/** The command separator token (emitted as a bare ';'). */
export const SEP: Separator = Object.freeze({ sep: true }) as unknown as Separator;

export interface Literal {
  readonly lit: string;
}
export type TmuxArg = Literal | Separator;

export function lit(s: string): Literal {
  return { lit: s };
}

function isSep(a: TmuxArg): a is Separator {
  return a === SEP;
}

/** TD §2.2: replace a trailing ';' by '\;'. Everything else passes through unchanged. */
export function escapeArg(s: string): string {
  return s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s;
}

/** TmuxArg[] → argv strings (literals escaped, separators as ';'). */
export function toArgv(args: readonly TmuxArg[]): string[] {
  return args.map((a) => (isSep(a) ? ';' : escapeArg(a.lit)));
}

/** Total UTF-8 bytes of an argv (plus one NUL per element, as the kernel counts it). */
export function argvBytes(argv: readonly string[]): number {
  let n = 0;
  for (const a of argv) n += Buffer.byteLength(a, 'utf8') + 1;
  return n;
}

const FLAG_RE = /^-[A-Za-z]$/;
const COMMAND_RE = /^[a-z][a-z-]*$/;

/** One flag: `['-t', '%3']` (with value) or `['-d']` (switch). */
type Flag = readonly [flag: string] | readonly [flag: string, value: string];

export interface CommandSpec {
  /** tmux command name (`send-keys`, `new-session`, …). */
  readonly name: string;
  readonly flags?: readonly Flag[];
  /** Positional arguments, emitted after every flag. */
  readonly positional?: readonly string[];
  /** Emit `--` between the flags and the positionals (required for free text and command argv). */
  readonly endOfFlags?: boolean;
}

function commandArgs(c: CommandSpec): TmuxArg[] {
  if (!COMMAND_RE.test(c.name)) throw new TypeError(`invalid tmux command name: ${c.name}`);
  const out: TmuxArg[] = [lit(c.name)];
  for (const f of c.flags ?? []) {
    const [flag, value] = f;
    if (!FLAG_RE.test(flag)) throw new TypeError(`invalid tmux flag: ${flag}`);
    out.push(lit(flag));
    if (value !== undefined) out.push(lit(value));
  }
  const pos = c.positional ?? [];
  if (c.endOfFlags === true) out.push(lit('--'));
  for (const p of pos) out.push(lit(p));
  return out;
}

/** Build one invocation from several commands, separated by SEP. */
export function commandList(cmds: readonly CommandSpec[]): TmuxArg[] {
  const out: TmuxArg[] = [];
  cmds.forEach((c, i) => {
    if (i > 0) out.push(SEP);
    out.push(...commandArgs(c));
  });
  return out;
}

/** Command names of an arg list (for redacted error messages and logs). */
export function commandNames(args: readonly TmuxArg[]): string[] {
  const names: string[] = [];
  let atStart = true;
  for (const a of args) {
    if (isSep(a)) {
      atStart = true;
      continue;
    }
    if (atStart) names.push(a.lit);
    atStart = false;
  }
  return names;
}

/** P-TMUX-16: session names are `ccd-` + [a-z0-9-] (tmux maps '.' and ':' to '_', and '=' / prefix matching bite). */
export const SESSION_NAME_RE = /^ccd-[a-z0-9-]{1,60}$/;
/** Socket names: `ccd-<ownerPid36>-<8hex>` and test names like `ccd-ct-<…>`; never a path (`-S` is never used, P-TMUX-38). */
export const SOCKET_NAME_RE = /^ccd-[a-z0-9-]{1,60}$/;
/** Env names passed with `-e` (no '=' and no shell metacharacters). */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** §3.8: the pane-died log path is spliced into a run-shell string, so only library-safe characters are accepted. */
export const SAFE_PATH_RE = /^[A-Za-z0-9/._-]+$/;

/** Exact session target (P-TMUX-15): `=name:` (a pane/window target needs the trailing colon, TD §6; VERIFIED). */
export function exactTarget(sessionName: string): string {
  return `=${sessionName}:`;
}
