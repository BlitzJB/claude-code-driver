// cli/args.ts — strict, dependency-free argv parsing for `ccd` (DESIGN.md §3.12). Unknown flags are errors, never ignored:
// the lifecheck job runs unattended from launchd/cron, so a typo must fail loudly instead of silently changing behaviour.

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface FlagSpec {
  /** Flags that take a value (`--state-dir D` or `--state-dir=D`). */
  readonly values: readonly string[];
  /** Boolean flags (`--json`). */
  readonly booleans: readonly string[];
}

export interface ParsedArgs {
  readonly positionals: string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (onlyPositionals || !a.startsWith('--') || a === '-') {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      onlyPositionals = true;
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (spec.values.includes(name)) {
      let v: string | undefined;
      if (eq !== -1) v = a.slice(eq + 1);
      else {
        v = argv[i + 1];
        i++;
      }
      if (v === undefined || v === '') throw new UsageError(`--${name} needs a value`);
      if (values.has(name)) throw new UsageError(`--${name} given twice`);
      values.set(name, v);
      continue;
    }
    if (spec.booleans.includes(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      booleans.add(name);
      continue;
    }
    throw new UsageError(`unknown option --${name}`);
  }
  return { positionals, values, booleans };
}

/** Parses a non-negative integer flag value; throws UsageError otherwise. */
export function intFlag(p: ParsedArgs, name: string): number | undefined {
  const v = p.values.get(name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return Number(v);
}
