// test/live/global-setup.ts — the `live` project's global setup/teardown (DESIGN.md §6.5; WP-INT).
//
// Rules it enforces:
//   - nothing happens unless CCD_LIVE=1 (the test files skip themselves too);
//   - every live session of this run gets one private root `/private/tmp/claude-<uid>/ccd-live/<pid>` (cwds under the trusted
//     /private/tmp, LV Q4) with its own library state dir, so this run's registry names exactly this run's sessions;
//   - teardown kills only the tmux servers that THIS run's registry entries name (sessions/ and archive/), never any other
//     tmux socket, then removes the root;
//   - the prompt budget (CCD_LIVE_MAX_PROMPTS, default 10) is a counter file under the root, shared by all test files.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIVE_ROOT_ENV = 'CCD_LIVE_ROOT';

interface RegistryEntry {
  tmux?: { bin?: unknown; socketName?: unknown };
}

function socketsNamedBy(stateDir: string): { bin: string; socketName: string }[] {
  const out: { bin: string; socketName: string }[] = [];
  for (const sub of ['sessions', 'archive']) {
    const dir = join(stateDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RegistryEntry;
        const name = rec.tmux?.socketName;
        const bin = rec.tmux?.bin;
        // our own socket naming only (`ccd-<owner pid base36>-<hex8>`, §3.1 step 12): never touch anything else
        if (typeof name === 'string' && /^ccd-[0-9a-z]+-[0-9a-f]{8}$/.test(name))
          out.push({ bin: typeof bin === 'string' && bin !== '' ? bin : 'tmux', socketName: name });
      } catch {
        /* a torn record names nothing */
      }
    }
  }
  return out;
}

export function setup(): (() => void) | undefined {
  if (process.env['CCD_LIVE'] !== '1') return undefined;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const root = join('/private/tmp', `claude-${uid}`, 'ccd-live', String(process.pid));
  mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'work'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'prompts.count'), '0\n', { mode: 0o600 });
  process.env[LIVE_ROOT_ENV] = root;
  return () => {
    for (const s of socketsNamedBy(join(root, 'state'))) {
      try {
        execFileSync(s.bin, ['-L', s.socketName, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
      } catch {
        /* already gone */
      }
    }
    if (process.env['CCD_LIVE_KEEP'] !== '1') rmSync(root, { recursive: true, force: true });
  };
}
