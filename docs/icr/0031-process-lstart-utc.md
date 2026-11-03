# ICR 0031 — Process identity start times are rendered in UTC (`TZ=UTC0`)

Area: platform/process (`src/platform/process/identity.ts`, `src/platform/process/standalone/owner-watch.ts`).
Clarifies DESIGN.md §3.8 / LC §6.3 ("same start time"); no type or record-shape change.

## Defect

Every identity check (owner-watch owner/Claude polls, `reaper.isOwnerAlive` / Claude verification, `identityMatches`,
lifecheck) compares the `ps -o lstart=` text recorded at launch with the text `ps` prints now. `PS_ENV` and the
owner-watch's own `ps` env fixed the locale but not the zone, so `ps` rendered `lstart` in whatever zone `/etc/localtime`
named when it ran. A time-zone change on a running host (macOS automatic time zone while travelling, a user edit)
therefore changed the string for every live process: the owner-watch saw "owner gone" and killed Claude and the tmux
server, and the next reap treated every other live owner as dead.

## Change

- `PS_ENV` (identity.ts) and the standalone's new exported `PS_ENV` (owner-watch.ts, kept identical; asserted by a unit
  test) add `TZ: 'UTC0'` (POSIX form, needs no tz database). All `ps` invocations in the library go through these two.
- The recorded representation stays the C-locale `lstart` string, now always UTC, in the owner record, watch.json and the
  session record (they are all produced by `ProcessPort.identity`).

## Compatibility / limits

- Records written by an older build hold host-zone strings. A session started by an older build and checked by this build
  on a host not set to UTC would look stale; records only live for the lifetime of a session, so this is limited to an
  in-place upgrade while sessions run (do not upgrade the library under live sessions).
- Not addressed: on Linux `lstart` is derived from `/proc/stat` `btime`, which moves with a wall-clock step (e.g. an NTP
  step correction). A TZ fix cannot cover that; an epoch-based start time (`/proc/<pid>/stat` starttime in clock ticks)
  would. macOS (the primary target) stores the absolute start time, so it is unaffected.

Tests: `test/unit/platform/process.test.ts` ("identity start time is rendered in UTC"),
`test/unit/platform/owner-watch.test.ts` ("both ps envs pin TZ=UTC0", "an owner whose recorded start time is its UTC
lstart is not treated as gone" — the watcher is spawned with `TZ=Asia/Tokyo` in its own env).
