#!/usr/bin/env bash
# scripts/ci/build-tmux.sh — build a pinned tmux release from its tarball for the CI minimum/version jobs
# (DESIGN.md §7 "CI", §5.1 P-TMUX-42, rev 2 §10 G24/C9; owned by WP-CI).
#
# Usage:
#   scripts/ci/build-tmux.sh [options] <version>        build tmux <version> (e.g. 3.2a) into a prefix, or reuse a cached one
#   scripts/ci/build-tmux.sh --check <tmux-bin> [min]   print `<bin> -V` and fail when it is older than <min> (default 3.2)
#   scripts/ci/build-tmux.sh --help
#
# Build options:
#   --prefix <dir>      install prefix (default: $CCD_TMUX_PREFIX, else $HOME/.cache/ccd-tmux/<version>)
#   --jobs <n>          parallel make jobs (default: number of CPUs)
#   --sha256 <hex>      expected SHA-256 of the tarball (default: $CCD_TMUX_SHA256, else the digest pinned below for
#                       3.2a/3.5a/3.6a; for any other version the digest is only printed). `none` disables the check.
#   --no-deps           do not install build dependencies (same as CCD_TMUX_INSTALL_DEPS=0)
#   --force             rebuild even when the prefix already holds a working tmux <version>
#
# Environment:
#   CCD_TMUX_URL_BASE      release base URL (default https://github.com/tmux/tmux/releases/download); the tarball is
#                          <base>/<version>/tmux-<version>.tar.gz. file:// URLs work (used by the contract test).
#   CCD_TMUX_INSTALL_DEPS  0 disables the apt-get/brew dependency step.
#   GITHUB_OUTPUT/GITHUB_ENV/GITHUB_PATH  when set (GitHub Actions), the script appends `tmux-bin=<path>` and
#                          `tmux-version=<v>` to GITHUB_OUTPUT, `CCD_TMUX_BIN=<path>` to GITHUB_ENV and `<prefix>/bin` to
#                          GITHUB_PATH, so later steps (and contract tests that look tmux up on PATH) use the built binary.
#
# The last line on stdout is always the absolute path of the tmux binary; progress goes to stderr.
# Exit codes: 0 ok, 1 build/verification failure, 2 usage error.
#
# The smoke test after the build only ever talks to a private server (`-L ccd-ci-build-<pid>`, `-f /dev/null`) and kills it
# again, so it never touches the runner's or a developer's own tmux sessions.

set -euo pipefail

readonly DEFAULT_URL_BASE='https://github.com/tmux/tmux/releases/download'
readonly DEFAULT_MIN='3.2'

log() { printf 'build-tmux: %s\n' "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}
usage_error() {
  log "usage error: $*"
  log "run with --help for usage"
  exit 2
}

print_help() {
  sed -n '2,/^$/{s/^# \{0,1\}//;p;}' "$0"
}

# SHA-256 of the release tarballs CI builds (computed from the github.com release downloads on 2026-11-03 and checked by
# a full build of each on ubuntu:24.04). GitHub does not publish tmux checksums, so these pins are the integrity check
# for code that CI compiles and runs.
pinned_sha256() {
  case $1 in
    3.2a) printf '551553a4f82beaa8dadc9256800bcc284d7c000081e47aa6ecbb6ff36eacd05f\n' ;;
    3.5a) printf '16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951\n' ;;
    3.6a) printf 'b6d8d9c76585db8ef5fa00d4931902fa4b8cbe8166f528f44fc403961a3f3759\n' ;;
    *) return 1 ;;
  esac
}

# ---- version handling ------------------------------------------------------------------------------------------------

# A release version as published on github.com/tmux/tmux/releases: <major>.<minor> with an optional letter (3.2a, 3.4, 3.6a).
valid_release() { [[ $1 =~ ^[0-9]+\.[0-9]+[a-z]?$ ]]; }

# Prints "<major> <minor> <letter-rank>" for a version string; letter-rank 0 = no letter, a = 1, b = 2, ...
# Development builds (`master`, `next-3.6`) parse as the version they lead to; `master` counts as newer than anything.
version_key() {
  local v=$1
  v=${v#tmux }
  v=${v#openbsd-}
  v=${v#next-}
  if [[ $v == master ]]; then
    printf '9999 0 0\n'
    return 0
  fi
  if [[ $v =~ ^([0-9]+)\.([0-9]+)([a-z]?) ]]; then
    local letter=${BASH_REMATCH[3]} rank=0
    if [[ -n $letter ]]; then
      rank=$(($(printf '%d' "'$letter") - 96))
    fi
    printf '%d %d %d\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$rank"
    return 0
  fi
  return 1
}

# version_at_least <have> <min>: 0 when have >= min.
version_at_least() {
  local have want
  have=$(version_key "$1") || return 1
  want=$(version_key "$2") || return 1
  local h1 h2 h3 w1 w2 w3
  read -r h1 h2 h3 <<<"$have"
  read -r w1 w2 w3 <<<"$want"
  ((h1 != w1)) && { ((h1 > w1)); return; }
  ((h2 != w2)) && { ((h2 > w2)); return; }
  ((h3 >= w3))
}

# `tmux -V` of a binary, or empty when it does not run.
tmux_version_of() {
  local out
  out=$("$1" -V 2>/dev/null) || return 1
  printf '%s\n' "${out#tmux }"
}

# ---- --check mode ----------------------------------------------------------------------------------------------------

check_mode() {
  local bin=${1:-} min=${2:-$DEFAULT_MIN}
  [[ -n $bin ]] || usage_error '--check needs the path of a tmux binary'
  if [[ $bin != */* ]]; then
    bin=$(command -v "$bin" 2>/dev/null) || die "'$1' is not on PATH"
  fi
  version_key "$min" >/dev/null || usage_error "invalid minimum version '$min'"
  [[ -x $bin ]] || die "tmux binary '$bin' is missing or not executable"
  local v
  v=$(tmux_version_of "$bin") || die "'$bin -V' failed"
  printf 'tmux %s (%s)\n' "$v" "$bin"
  if ! version_key "$v" >/dev/null; then
    die "cannot parse tmux version '$v'"
  fi
  if ! version_at_least "$v" "$min"; then
    die "tmux $v is older than the supported minimum $min (P-TMUX-42)"
  fi
}

# ---- build mode ------------------------------------------------------------------------------------------------------

cpu_count() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
  elif command -v sysctl >/dev/null 2>&1; then
    sysctl -n hw.ncpu 2>/dev/null || printf '2\n'
  else
    printf '2\n'
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

install_deps() {
  if [[ ${CCD_TMUX_INSTALL_DEPS:-1} == 0 ]]; then
    log 'dependency install disabled'
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    local sudo=''
    [[ $(id -u) == 0 ]] || sudo='sudo'
    log 'installing build dependencies with apt-get (libevent-dev libncurses-dev bison pkg-config build-essential)'
    $sudo apt-get update -qq >&2
    DEBIAN_FRONTEND=noninteractive $sudo apt-get install -y -qq --no-install-recommends \
      libevent-dev libncurses-dev bison pkg-config build-essential curl ca-certificates >&2
  elif command -v brew >/dev/null 2>&1; then
    log 'installing build dependencies with brew (libevent ncurses utf8proc pkg-config bison)'
    HOMEBREW_NO_AUTO_UPDATE=1 brew install libevent ncurses utf8proc pkg-config bison >&2
  else
    log 'no apt-get or brew: assuming libevent, ncurses, a C compiler, make and pkg-config are already installed'
  fi
}

publish_outputs() {
  local bin=$1 version=$2 prefix=$3
  if [[ -n ${GITHUB_OUTPUT:-} ]]; then
    printf 'tmux-bin=%s\ntmux-version=%s\n' "$bin" "$version" >>"$GITHUB_OUTPUT"
  fi
  if [[ -n ${GITHUB_ENV:-} ]]; then
    printf 'CCD_TMUX_BIN=%s\n' "$bin" >>"$GITHUB_ENV"
  fi
  if [[ -n ${GITHUB_PATH:-} ]]; then
    printf '%s\n' "$prefix/bin" >>"$GITHUB_PATH"
  fi
  printf '%s\n' "$bin"
}

# Starts a private server, creates a detached session, reads one format back and kills the server (no shared state).
smoke_test() {
  local bin=$1
  local sock="ccd-ci-build-$$"
  local ok=0 got=''
  if "$bin" -L "$sock" -f /dev/null new-session -d -s smoke -x 80 -y 24 'sleep 30' 2>/dev/null; then
    got=$("$bin" -L "$sock" display-message -p -t smoke: '#{session_name}' 2>/dev/null || true)
    [[ $got == smoke ]] && ok=1
  fi
  "$bin" -L "$sock" kill-server >/dev/null 2>&1 || true
  local sock_dir="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"
  rm -f "$sock_dir/$sock" 2>/dev/null || true
  ((ok == 1)) || die "smoke test failed: $bin could not run a private server (got '${got}')"
}

build_mode() {
  local version=$1 prefix=$2 jobs=$3 want_sha=$4 force=$5
  valid_release "$version" || usage_error "'$version' is not a tmux release version (expected e.g. 3.2a or 3.4)"
  local bin="$prefix/bin/tmux"

  install_deps

  if [[ $force == 0 && -x $bin ]]; then
    local have
    if have=$(tmux_version_of "$bin") && [[ $have == "$version" ]]; then
      log "cached: $bin reports tmux $have"
      smoke_test "$bin"
      publish_outputs "$bin" "$have" "$prefix"
      return 0
    fi
    log "prefix holds an unusable or different tmux (${have:-none}); rebuilding"
  fi

  local base=${CCD_TMUX_URL_BASE:-$DEFAULT_URL_BASE}
  local url="${base%/}/$version/tmux-$version.tar.gz"
  local work
  work=$(mktemp -d "${TMPDIR:-/tmp}/ccd-tmux-build.XXXXXX")
  # shellcheck disable=SC2064 # expand $work now: the trap must remove this exact directory
  trap "rm -rf '$work'" EXIT

  log "downloading $url"
  curl -fsSL --retry 3 --retry-delay 2 -o "$work/tmux.tar.gz" "$url" || die "download failed: $url"

  local sha
  sha=$(sha256_of "$work/tmux.tar.gz")
  log "tarball sha256 $sha"
  if [[ -z $want_sha ]]; then
    log "no pinned or given sha256 for tmux $version: digest printed only"
  else
    local want_lower
    want_lower=$(printf '%s' "$want_sha" | tr '[:upper:]' '[:lower:]')
    [[ $sha == "$want_lower" ]] || die "sha256 mismatch for $url: expected $want_lower, got $sha"
  fi

  tar -xzf "$work/tmux.tar.gz" -C "$work"
  local src="$work/tmux-$version"
  [[ -d $src ]] || die "tarball did not contain tmux-$version/"

  # Homebrew keeps ncurses/libevent keg-only on macOS; point pkg-config at them when present.
  if command -v brew >/dev/null 2>&1; then
    local p extra=''
    for p in libevent ncurses utf8proc; do
      local kp
      kp=$(brew --prefix "$p" 2>/dev/null || true)
      [[ -n $kp && -d $kp/lib/pkgconfig ]] && extra="$extra${extra:+:}$kp/lib/pkgconfig"
    done
    [[ -n $extra ]] && export PKG_CONFIG_PATH="$extra${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  fi

  # Only a prefix this script created (marker file) or an empty/missing directory is ever wiped.
  if [[ -d $prefix && -n $(ls -A "$prefix" 2>/dev/null) && ! -f $prefix/.ccd-tmux-prefix ]]; then
    die "refusing to replace non-empty $prefix: it was not created by build-tmux.sh (no .ccd-tmux-prefix marker)"
  fi
  rm -rf "$prefix"
  mkdir -p "$prefix"
  printf 'tmux %s built by scripts/ci/build-tmux.sh\n' "$version" >"$prefix/.ccd-tmux-prefix"
  log "configuring into $prefix"
  (cd "$src" && ./configure --prefix="$prefix" >&2) || die 'configure failed'
  log "building with $jobs jobs"
  (cd "$src" && make -j "$jobs" >&2) || die 'make failed'
  (cd "$src" && make install >&2) || die 'make install failed'

  [[ -x $bin ]] || die "make install did not produce $bin"
  local built
  built=$(tmux_version_of "$bin") || die "'$bin -V' failed after the build"
  [[ $built == "$version" ]] || die "built binary reports tmux $built, expected $version"
  smoke_test "$bin"
  log "built tmux $built at $bin"
  publish_outputs "$bin" "$built" "$prefix"
}

# ---- argument parsing ------------------------------------------------------------------------------------------------

main() {
  local prefix='' jobs='' sha=${CCD_TMUX_SHA256:-} force=0 version=''
  while (($# > 0)); do
    case $1 in
      -h | --help)
        print_help
        exit 0
        ;;
      --check)
        shift
        (($# <= 2)) || usage_error '--check takes <tmux-bin> [min]'
        check_mode "$@"
        exit 0
        ;;
      --prefix)
        (($# >= 2)) || usage_error '--prefix needs a directory'
        prefix=$2
        shift 2
        ;;
      --jobs)
        (($# >= 2)) || usage_error '--jobs needs a number'
        [[ $2 =~ ^[1-9][0-9]*$ ]] || usage_error "--jobs must be a positive integer, got '$2'"
        jobs=$2
        shift 2
        ;;
      --sha256)
        (($# >= 2)) || usage_error '--sha256 needs a hex digest'
        sha=$2
        shift 2
        ;;
      --no-deps)
        export CCD_TMUX_INSTALL_DEPS=0
        shift
        ;;
      --force)
        force=1
        shift
        ;;
      -*)
        usage_error "unknown option '$1'"
        ;;
      *)
        [[ -z $version ]] || usage_error "unexpected argument '$1' (version already given as '$version')"
        version=$1
        shift
        ;;
    esac
  done
  [[ -n $version ]] || usage_error 'missing <version>'
  valid_release "$version" || usage_error "'$version' is not a tmux release version (expected e.g. 3.2a or 3.4)"
  if [[ -z $sha ]]; then
    sha=$(pinned_sha256 "$version") || sha=''
  elif [[ $sha == none ]]; then
    log 'sha256 check disabled (--sha256 none)'
    sha=''
  elif [[ ! $sha =~ ^[0-9a-fA-F]{64}$ ]]; then
    usage_error "--sha256 must be 64 hex characters or 'none'"
  fi
  [[ -n $prefix ]] || prefix=${CCD_TMUX_PREFIX:-"${HOME:?HOME is not set}/.cache/ccd-tmux/$version"}
  case $prefix in
    /*) ;;
    *) prefix="$PWD/$prefix" ;;
  esac
  [[ $prefix != / ]] || usage_error 'refusing to use / as the prefix'
  [[ -n $jobs ]] || jobs=$(cpu_count)
  build_mode "$version" "$prefix" "$jobs" "$sha" "$force"
}

main "$@"
