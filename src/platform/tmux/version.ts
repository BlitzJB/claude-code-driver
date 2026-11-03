// platform/tmux/version.ts — parse `tmux -V` and derive feature gates (DESIGN.md §2.7.3, P-TMUX-42; TD §1.3).
//
// `tmux -V` prints `tmux 3.5a`, `tmux next-3.6` / `tmux master` on development builds and `tmux openbsd-7.4` on OpenBSD
// (the number there is the OpenBSD release, not the tmux release). Minimum supported: 3.2 (`new-session -e`, `extended-keys`).

export interface TmuxVersion {
  /** The raw text after `tmux ` (e.g. `3.5a`, `next-3.6`, `master`, `openbsd-7.4`). */
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  /** Letter suffix of a patch release (`a` in 3.5a), '' when none. */
  readonly patch: string;
  /** True for `next-*`, `master` and other development builds. */
  readonly dev: boolean;
}

export const MIN_TMUX_VERSION = '3.2';
const MIN = { major: 3, minor: 2 } as const;

/** OpenBSD release → the tmux release it ships (OpenBSD 6.9 shipped tmux 3.2; later releases ship newer versions). */
function fromOpenBsd(release: number, raw: string): TmuxVersion {
  // Conservative: OpenBSD ≥ 6.9 is treated as exactly 3.2 so no newer feature gate is assumed; older is reported as 3.1.
  return release >= 6.9 ? { raw, major: 3, minor: 2, patch: '', dev: false } : { raw, major: 3, minor: 1, patch: '', dev: false };
}

/**
 * Parse the output of `tmux -V`. Returns undefined when the text is not recognisable at all.
 * Accepted: `tmux 3.5a`, `tmux 3.2`, `tmux next-3.6`, `tmux 3.6-rc`, `tmux master`, `tmux openbsd-7.4`.
 */
export function parseTmuxVersion(output: string): TmuxVersion | undefined {
  const line = output.trim().split('\n')[0]?.trim() ?? '';
  const m = /^tmux\s+(\S+)$/.exec(line);
  if (m === null) return undefined;
  const raw = m[1] ?? '';
  if (raw === 'master') return { raw, major: 999, minor: 0, patch: '', dev: true };
  const bsd = /^openbsd-(\d+(?:\.\d+)?)$/.exec(raw);
  if (bsd !== null) return fromOpenBsd(Number(bsd[1]), raw);
  const v = /^(next-)?(\d+)\.(\d+)([a-z]?)(?:-(\S+))?$/.exec(raw);
  if (v === null) return undefined;
  return {
    raw,
    major: Number(v[2]),
    minor: Number(v[3]),
    patch: v[4] ?? '',
    dev: v[1] !== undefined || v[5] !== undefined,
  };
}

/** a ≥ b on (major, minor); patch letters do not gate features. */
export function versionAtLeast(v: Pick<TmuxVersion, 'major' | 'minor'>, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

export function isSupportedVersion(v: TmuxVersion): boolean {
  return versionAtLeast(v, MIN.major, MIN.minor);
}

/** Version-dependent options and formats the driver uses. Anything ≥ 3.2 is assumed by the driver unconditionally. */
export interface TmuxFeatures {
  /** `allow-passthrough` option (3.3+). On 3.2 passthrough does not exist, so there is nothing to turn off. */
  readonly allowPassthrough: boolean;
  /** `#{pane_key_mode}` format (VERIFIED on 3.5a, LP-52). Older versions expand it to ''. */
  readonly paneKeyMode: boolean;
  /** `extended-keys` server option (3.2+). */
  readonly extendedKeys: boolean;
}

export function featuresOf(v: TmuxVersion): TmuxFeatures {
  return {
    allowPassthrough: versionAtLeast(v, 3, 3),
    paneKeyMode: versionAtLeast(v, 3, 5),
    extendedKeys: versionAtLeast(v, 3, 2),
  };
}
