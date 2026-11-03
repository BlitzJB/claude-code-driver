// testing/fake-claude.ts — a scripted stand-in for Claude Code 2.1.316 running in a FakeTmux pane (DESIGN.md §6.3: "real
// session+core+channels with every port faked"). It is the "world" of the kernel scenarios: it reads the argv and the injected
// settings file the launcher wrote, and through the faked ports it produces exactly the three kinds of evidence the real
// binary produces (live verification corpus, fixtures/verify/*):
//   - hook calls through the FakeHookTransport, on the transport the settings file registered (http vs command → unix),
//     with the 2.1.316 payload fields (session_id, prompt_id, permission_mode, transcript_path, …);
//   - transcript lines appended to `<home>/.claude/projects/<slug>/<sid>.jsonl` in FakeTailFs (or pushed to the scripted tail);
//   - screen frames (testing/screens.ts) on the pane.
// It reacts to input like the TUI: bracketed paste / literal text land in the composer, C-g runs $VISUAL (the FakeEditor
// injector, LP-01: alternate screen while the editor runs), Enter submits (UPS, block → prompt restored + LP-47 entry), Escape
// interrupts / dismisses, BTab cycles the mode, digits answer dialogs. A turn's behaviour is a test-provided async script
// (`onPrompt`), written against FakeTurn helpers. All time is FakeClock time; nothing here sets a real timer.
import type { FakeHookCall, FakeHookTransport } from '../platform/hook-server/fake-hooks.js';
import { SELF_TEST_BLOCK_BODY } from '../platform/hook-server/worker.js';
import type { MonoMs } from '../model/time.js';
import type { FileKey } from '../platform/ports.js';
import type { FakePaneIO, FakeProgram, FakeTmuxPane } from '../platform/tmux/fake-tmux.js';
import type { FakePortSet } from './fake-ports.js';
import {
  assistantRow,
  banner,
  doneLine,
  gateFrame,
  INTERRUPTED_BANNER,
  mainFrame,
  modalFrame,
  permissionDialog,
  promptEcho,
  spinner,
  toolRows,
  trustDialog,
} from './screens.js';

// ---------------------------------------------------------------------------------------------------------------- options

export type FakeStartup =
  | { kind: 'ready' }
  | { kind: 'trustDialog' }
  | { kind: 'gate'; lines: readonly string[] }
  | { kind: 'exit'; status: number; lines: readonly string[] }
  | { kind: 'blank' };

export interface FakeClaudeOptions {
  /** What the pane shows after boot (default ready). */
  startup?: FakeStartup;
  /** SessionStart hook: sent at boot (default), never, or after a delay. */
  sessionStart?: 'immediate' | 'none' | { delayMs: number };
  /** ms from spawn to the first frame (default 200). */
  bootMs?: number;
  /** Header version string (default 2.1.316). */
  headerVersion?: string;
  model?: string;
  /** Behaviour of each submitted prompt (default: say "OK" after 300 ms, then Stop). */
  onPrompt?: (t: FakeTurn) => Promise<void> | void;
  /** ms the external editor keeps the alternate screen (LP-01). Default 0 (instant). */
  editorMs?: number;
  /** A user-level UserPromptSubmit hook that blocks every prompt with this reason (HT §1.2, K-06 notice path). */
  userUpsBlockReason?: string;
  /** Run when Enter is pressed on an empty composer while idle (usage-limit `stalePressEnter` wake, §3.6 wakeEnter). */
  onEmptyEnter?: (s: FakeClaudeSession) => void;
  /** Modes BTab cycles through (default default → acceptEdits → plan). */
  modeCycle?: readonly string[];
  /** Body lines of modal slash commands (`/usage`, `/help`, `/context`, `/status`). */
  modalBodies?: Readonly<Record<string, readonly string[]>>;
  /** Rewrite a (non-nonce) prompt between the composer and the UPS hook, as a human editing the draft would (K-08). */
  tamper?: (text: string) => string;
  /** Called on Enter with the composer text before it is submitted (race scripts, K-25). */
  interceptEnter?: (s: FakeClaudeSession, text: string) => void;
  /** HTTP hooks never arrive (blocked URL / unreachable): Claude logs a hook error attachment instead (K-20, K-37). */
  dropHttpHooks?: boolean;
  /** Delay of the `SessionStart{source:'clear'}` command hook after `/clear` (K-17: the HTTP UPS of g2 can come first). */
  clearSessionStartDelayMs?: number;
  /** `/exit` opens a dialog instead of exiting (K-29 SIGTERM path). */
  exitShowsDialog?: boolean;
  /** The transcript `user` entry of a submitted prompt is written this many ms late (the transcript lags hooks, P-TAIL-37). */
  promptTranscriptLagMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------- helpers

const ESC = '\u001b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Claude's project slug: every char outside [A-Za-z0-9] becomes '-' (TF §1). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0').slice(-width);
}

class LocalIds {
  private n = 0;
  constructor(private readonly tag: number) {}
  uuid(): string {
    const k = ++this.n;
    return `${hex(this.tag, 8)}-${hex(k >>> 16, 4)}-4${hex(k & 0xfff, 3)}-8${hex(this.tag & 0xfff, 3)}-${hex(k, 12)}`;
  }
  short(prefix: string): string {
    return `${prefix}${hex(this.tag, 4)}${hex(++this.n, 8)}`;
  }
}

interface HookRegistration {
  transport: 'http' | 'unix';
  timeoutS: number;
}

function parseArgv(argv: readonly string[]): { sessionId?: string; resume?: string; settings?: string; mode: string; model?: string } {
  const out: { sessionId?: string; resume?: string; settings?: string; mode: string; model?: string } = { mode: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (v === undefined) continue;
    if (a === '--session-id') out.sessionId = v;
    else if (a === '--resume') out.resume = v;
    else if (a === '--settings') out.settings = v;
    else if (a === '--permission-mode') out.mode = v;
    else if (a === '--model') out.model = v;
  }
  return out;
}

function hookRegistrations(settings: unknown): Map<string, HookRegistration> | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== 'object' || hooks === null) return undefined;
  const out = new Map<string, HookRegistration>();
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const list = (g as { hooks?: unknown }).hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        const type = (h as { type?: unknown }).type;
        const timeout = (h as { timeout?: unknown }).timeout;
        if (type === 'http' || type === 'command')
          out.set(event, { transport: type === 'http' ? 'http' : 'unix', timeoutS: typeof timeout === 'number' ? timeout : 60 });
      }
    }
  }
  return out;
}

function parseHookReply(body: string): Record<string, unknown> | undefined {
  if (body.trim() === '') return undefined;
  try {
    const v = JSON.parse(body) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** PermissionRequest reply → allow/deny/undefined (no decision → the dialog appears, HT §5.1). */
function permissionDecisionOf(
  body: string,
): { behavior: 'allow' | 'deny'; message?: string; interrupt?: boolean; updatedInput?: unknown } | undefined {
  const j = parseHookReply(body);
  const hso = j?.['hookSpecificOutput'];
  if (typeof hso !== 'object' || hso === null) return undefined;
  const d = (hso as { decision?: unknown }).decision;
  if (typeof d !== 'object' || d === null) return undefined;
  const b = (d as { behavior?: unknown }).behavior;
  if (b !== 'allow' && b !== 'deny') return undefined;
  const out: { behavior: 'allow' | 'deny'; message?: string; interrupt?: boolean; updatedInput?: unknown } = { behavior: b };
  const m = (d as { message?: unknown }).message;
  if (typeof m === 'string') out.message = m;
  if ((d as { interrupt?: unknown }).interrupt === true) out.interrupt = true;
  if ('updatedInput' in d) out.updatedInput = (d as { updatedInput?: unknown }).updatedInput;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- dialogs

type DialogKey = 'Enter' | 'Escape' | 'Up' | 'Down' | `${number}`;

interface Dialog {
  kind: 'permission' | 'trust' | 'modal' | 'gate' | 'menu';
  lines: () => string[];
  onKey: (k: DialogKey) => void;
  /** Draw the dialog alone (trust, gate) instead of under the history block. */
  fullScreen?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------- turn API

export interface ToolSpec {
  name: string;
  input: Record<string, unknown>;
  /** 'ask' (default for Bash/Write/Edit): PermissionRequest + dialog fallback; 'none': auto-allowed by rules. */
  permission?: 'ask' | 'none';
  /** Tool output (default `ok`). */
  result?: string;
  runMs?: number;
  /** Agent the call runs in (subagent PreToolUse payloads carry agent_id/agent_type). */
  agent?: { id: string; type: string };
  /** Fail the tool with this error after running (PostToolUseFailure). */
  fail?: string;
  /** Skip the PreToolUse hook (as when the hook is not registered). */
  noPreHook?: boolean;
  /** The PermissionRequest hook never reaches us (forwarder ECONNREFUSED): the dialog shows at once (K-39). */
  noPermissionHook?: boolean;
  /** Delay between PreToolUse and PermissionRequest (K-44: 400 ms). */
  permissionDelayMs?: number;
  /** Exact `tool_response` / `toolUseResult` (e.g. an Agent launch `{status:'async_launched', agentId}`). */
  response?: unknown;
}

export interface ToolOutcome {
  decision: 'allow' | 'deny' | 'interrupted';
  decider: 'hook' | 'user_keys' | 'config';
  toolUseId: string;
}

export interface FakeTurn {
  readonly session: FakeClaudeSession;
  readonly text: string;
  readonly promptId: string;
  readonly startedAt: number;
  /** True once Escape interrupted this turn. */
  readonly interrupted: boolean;
  /** Wait FakeClock time; resolves false (early) when the turn was interrupted. */
  sleep(ms: number): Promise<boolean>;
  /** Assistant text: MessageDisplay deltas (unless display:false) + transcript assistant entry + history row. */
  say(text: string, o?: { chunks?: number; display?: boolean; finalFlag?: boolean; apiMessageId?: string }): Promise<void>;
  /** One tool call (PreToolUse → PermissionRequest/dialog → run → PostToolUse + tool_result). */
  tool(spec: ToolSpec): Promise<ToolOutcome>;
  /** Stop hook (+ stop_hook_summary, turn_duration), idle screen. */
  stop(o?: { lastMessage?: string; stopHookActive?: boolean; backgroundTasks?: unknown[]; noTurnDuration?: boolean }): Promise<void>;
  /** StopFailure hook (+ synthetic API error entry), idle screen. */
  fail(o: { error: string; message: string; details?: string; resetsAtEpochS?: number; rateLimitType?: string }): Promise<void>;
  /** Replace the status line (spinner/retry/stall banner); undefined = plain spinner. */
  status(line: string | undefined): void;
  /** One model call through the network sidecar when the session runs with the proxy (FakeNetProxy tunnel). */
  modelCall(o?: { downBytes?: number }): void;
}

// ---------------------------------------------------------------------------------------------------------------- session

/** One Claude process in one pane. */
export class FakeClaudeSession {
  readonly pid: number;
  readonly cwd: string;
  readonly argv: readonly string[];
  sessionId: string;
  readonly resumed: boolean;
  mode: string;
  model: string;
  composer = '';
  composerNotice: string | undefined;
  history: string[] = [];
  statusLine: string | undefined;
  busy = false;
  exited = false;
  dialog: Dialog | undefined;
  /** Prompts typed while busy (queue-operation enqueue); delivered when the turn ends. */
  readonly queued: string[] = [];
  /** Every hook call made, in order. */
  readonly hookCalls: { event: string; payload: Record<string, unknown>; call: FakeHookCall | undefined }[] = [];
  /** Every transcript entry written, in order (all files). */
  readonly entries: { file: string; json: Record<string, unknown> }[] = [];
  /** Prompts submitted (after UPS), in order. */
  readonly prompts: { text: string; promptId: string; blocked: boolean }[] = [];
  turn: TurnImpl | undefined;
  /** HTTP hooks fail (endpoint unreachable): hook error attachments are written instead (K-20). Mutable at run time. */
  httpHooksDown: boolean;
  private readonly ids: LocalIds;
  private lastUuid: string | null = null;
  private registrations: Map<string, HookRegistration> | undefined;
  private escArmedAt: number | undefined;
  private editorBusy = false;
  private readonly offExit: () => void;

  constructor(
    readonly world: FakeClaude,
    readonly io: FakePaneIO,
    readonly pane: FakeTmuxPane,
  ) {
    const p = world.ports;
    this.ids = new LocalIds(world.nextTag());
    this.httpHooksDown = world.options.dropHttpHooks === true;
    this.argv = io.argv;
    this.cwd = io.cwd;
    const a = parseArgv(io.argv);
    this.resumed = a.resume !== undefined;
    this.sessionId = a.resume ?? a.sessionId ?? this.ids.uuid();
    this.mode = a.mode;
    this.model = a.model ?? world.options.model ?? 'claude-opus-5-5';
    this.pid = p.process.addProcess({ pid: pane.info.pid, command: io.argv.join(' ') });
    if (a.settings !== undefined) this.registrations = hookRegistrations(p.readWritten(a.settings));
    this.offExit = p.process.onExit((proc) => {
      if (proc.pid === this.pid && !this.exited) this.terminate(null, proc.exitSignal ?? 'SIGTERM');
    });
    p.registry.put({ pid: this.pid, sessionId: this.sessionId, version: '2.1.316', status: 'idle' });
  }

  get ports(): FakePortSet {
    return this.world.ports;
  }

  get transcriptPath(): string {
    return `${this.ports.home}/.claude/projects/${projectSlug(this.cwd)}/${this.sessionId}.jsonl`;
  }

  get hookTransport(): FakeHookTransport | undefined {
    return this.ports.hooks.instances.at(-1);
  }

  now(): number {
    return this.ports.clock.now();
  }

  // ------------------------------------------------------------ boot

  boot(): void {
    const o = this.world.options;
    const startup = o.startup ?? { kind: 'ready' };
    this.ports.clock.setTimer((this.now() + (o.bootMs ?? 200)) as MonoMs, () => {
      if (this.exited) return;
      switch (startup.kind) {
        case 'ready':
          this.render();
          this.scheduleSessionStart();
          break;
        case 'trustDialog':
          this.dialog = this.trust();
          this.render();
          break;
        case 'gate':
          this.dialog = { kind: 'gate', fullScreen: true, lines: () => gateFrame({ lines: startup.lines }), onKey: () => undefined };
          this.render();
          break;
        case 'exit':
          this.io.setScreen(startup.lines);
          this.terminate(startup.status, null);
          break;
        case 'blank':
          this.io.setScreen([]);
          break;
      }
    });
  }

  private scheduleSessionStart(source = this.resumed ? 'resume' : 'startup'): void {
    const ss = this.world.options.sessionStart ?? 'immediate';
    if (ss === 'none') return;
    const send = (): void => {
      if (!this.exited) this.hook('SessionStart', { source, model: this.model });
    };
    if (ss === 'immediate') send();
    else this.ports.clock.setTimer((this.now() + ss.delayMs) as MonoMs, send);
  }

  private trust(): Dialog {
    let sel = 0;
    const options = ['No, exit', 'Yes, I trust this folder'];
    return {
      kind: 'trust',
      fullScreen: true,
      lines: () =>
        trustDialog({ cwd: this.cwd }).map((l) => {
          const i = options.findIndex((x) => l.endsWith(x));
          return i < 0 ? l : `${i === sel ? ' ❯ ' : '   '}${options[i] ?? ''}`;
        }),
      onKey: (k) => {
        if (k === 'Up') sel = 0;
        else if (k === 'Down') sel = 1;
        else if (k === 'Escape' || (k === 'Enter' && sel === 0)) this.terminate(1, null);
        else if (k === 'Enter') {
          this.dialog = undefined;
          this.render();
          this.scheduleSessionStart();
          return;
        }
        this.render();
      },
    };
  }

  // ------------------------------------------------------------ screen

  render(): void {
    if (this.exited || this.editorBusy) return;
    const cols = this.pane.info.cols;
    const rows = this.pane.info.rows;
    let lines: string[];
    const d = this.dialog;
    if (d?.fullScreen === true) lines = d.lines();
    else if (d !== undefined)
      lines = [...banner({ cwd: this.cwd, version: this.world.options.headerVersion ?? '2.1.316' }), ...this.history, ...d.lines()];
    else {
      const frame: Parameters<typeof mainFrame>[0] = {
        cols,
        banner: { cwd: this.cwd, version: this.world.options.headerVersion ?? '2.1.316' },
        history: this.history,
        mode: this.mode,
        busy: this.busy,
      };
      // The startup placeholder (`Try "…"`) shows only on a fresh, empty, idle screen.
      const placeholder = this.composer === '' && this.history.length === 0 && !this.busy;
      if (!placeholder) frame.composer = this.composer;
      if (this.busy) frame.status = this.statusLine ?? spinner();
      else if (this.statusLine !== undefined) frame.status = this.statusLine;
      if (this.composerNotice !== undefined) frame.notice = this.composerNotice;
      lines = mainFrame(frame);
    }
    this.io.setScreen(lines.length > rows ? lines.slice(lines.length - rows) : lines);
  }

  // ------------------------------------------------------------ hooks / transcript

  /** Deliver a hook the way 2.1.316 does (only if registered; transport from the settings file). */
  hook(event: string, extra: Record<string, unknown> = {}): FakeHookCall | undefined {
    const t = this.hookTransport;
    const reg = this.registrations?.get(event);
    if (this.registrations !== undefined && reg === undefined) return undefined;
    const transport = reg?.transport ?? (event === 'SessionStart' || event === 'PermissionRequest' ? 'unix' : 'http');
    if (transport === 'http' && this.httpHooksDown) {
      // Claude records the failed HTTP hook as an attachment (LV P6: ECONNREFUSED → hook_non_blocking_error).
      this.entry({
        type: 'attachment',
        attachment: {
          type: 'hook_non_blocking_error',
          hookName: event,
          hookEvent: event,
          toolUseID: this.newId(),
          stderr: 'connect ECONNREFUSED 127.0.0.1',
          exitCode: 1,
        },
      });
      this.hookCalls.push({ event, payload: { hook_event_name: event, dropped: true }, call: undefined });
      return undefined;
    }
    const payload: Record<string, unknown> = {
      session_id: this.sessionId,
      transcript_path: this.transcriptPath,
      cwd: this.cwd,
      ...(event === 'SessionStart' || event === 'SessionEnd' || event === 'MessageDisplay' ? {} : { permission_mode: this.mode }),
      ...(this.turn !== undefined && event !== 'SessionStart' ? { prompt_id: this.turn.promptId } : {}),
      hook_event_name: event,
      ...extra,
    };
    const call = t?.deliver(event, payload, { transport });
    this.hookCalls.push({ event, payload, call });
    return call;
  }

  /** Append a transcript entry (main file of the current session unless `file` says otherwise). */
  entry(json: Record<string, unknown>, o: { file?: string; chain?: boolean; agentId?: string } = {}): Record<string, unknown> {
    const chain = o.chain ?? true;
    const full: Record<string, unknown> = chain
      ? {
          parentUuid: this.lastUuid,
          isSidechain: o.agentId !== undefined,
          ...json,
          uuid: json['uuid'] ?? this.ids.uuid(),
          timestamp: new Date(this.ports.clock.wallNow()).toISOString(),
          userType: 'external',
          entrypoint: 'cli',
          cwd: this.cwd,
          sessionId: this.sessionId,
          version: '2.1.316',
          gitBranch: 'HEAD',
        }
      : { ...json, sessionId: this.sessionId };
    if (chain) this.lastUuid = full['uuid'] as string;
    const file =
      o.file ??
      (o.agentId !== undefined
        ? `${this.ports.home}/.claude/projects/${projectSlug(this.cwd)}/${this.sessionId}/subagents/agent-${o.agentId}.jsonl`
        : this.transcriptPath);
    this.entries.push({ file, json: full });
    const scripted = this.ports.scriptedTail?.last;
    if (scripted !== undefined) {
      const key: FileKey =
        o.agentId !== undefined
          ? { kind: 'subagent', sessionId: this.sessionId, agentId: o.agentId }
          : { kind: 'main', sessionId: this.sessionId };
      scripted.emitLine(key, full, { at: this.ports.clock.now(), wallAt: this.ports.clock.wallNow() });
    } else this.ports.tailFs.appendFile(file, `${JSON.stringify(full)}\n`);
    return full;
  }

  /**
   * One `api-request` metadata entry (2.1.316 writes one per model request attempt, before the assistant entry that answers
   * it; the assistant entry carries its `id` as `requestRef`, verify transcript 59129e0d). Returns the request ref.
   */
  apiRequest(o: { agentId?: string } = {}): string {
    const id = this.ids.uuid();
    this.entry(
      {
        type: 'api-request',
        id,
        timestamp: new Date(this.ports.clock.wallNow()).toISOString(),
        version: '2.1.316',
        querySource: o.agentId === undefined ? 'repl_main_thread' : 'agent:custom',
        keep: 0,
        tail: [id],
        requestDigest: id.replace(/-/g, ''),
      },
      { chain: false, ...(o.agentId === undefined ? {} : { agentId: o.agentId }) },
    );
    return id;
  }

  /** The hook timeout (s) the settings file registered for `event` (60 when unknown). */
  hookTimeoutS(event: string): number {
    return this.registrations?.get(event)?.timeoutS ?? 60;
  }

  newId(): string {
    return this.ids.uuid();
  }

  shortId(prefix: string): string {
    return this.ids.short(prefix);
  }

  // ------------------------------------------------------------ input

  input(bytes: string): void {
    if (this.exited) return;
    if (bytes.startsWith(PASTE_START) && bytes.endsWith(PASTE_END)) {
      this.insert(bytes.slice(PASTE_START.length, bytes.length - PASTE_END.length));
      return;
    }
    switch (bytes) {
      case '\r':
        this.key('Enter');
        return;
      case ESC:
        this.key('Escape');
        return;
      case `${ESC}[Z`:
        this.cycleMode();
        return;
      case `${ESC}[A`:
        this.key('Up');
        return;
      case `${ESC}[B`:
        this.key('Down');
        return;
      case '\u0007':
        this.openEditor();
        return;
      default:
        if (/^[1-9]$/.test(bytes) && this.dialog !== undefined) {
          this.dialog.onKey(bytes as DialogKey);
          return;
        }
        if (!bytes.includes(ESC)) this.insert(bytes);
    }
  }

  private insert(text: string): void {
    if (this.dialog !== undefined) return;
    this.composer += text;
    this.composerNotice = undefined;
    this.escArmedAt = undefined;
    this.render();
  }

  private key(k: DialogKey): void {
    const d = this.dialog;
    if (d !== undefined) {
      d.onKey(k);
      return;
    }
    if (k === 'Enter') {
      if (this.composer === '') {
        if (!this.busy) this.world.options.onEmptyEnter?.(this);
        return;
      }
      const text = this.composer;
      this.composer = '';
      this.composerNotice = undefined;
      this.world.options.interceptEnter?.(this, text);
      this.submit(text);
      return;
    }
    if (k === 'Escape') {
      if (this.busy && this.turn !== undefined) {
        this.turn.interrupt();
        return;
      }
      if (this.composer !== '') {
        const now = this.now();
        if (this.escArmedAt !== undefined && now - this.escArmedAt <= 2000) {
          this.composer = '';
          this.composerNotice = undefined;
          this.escArmedAt = undefined;
        } else {
          this.escArmedAt = now;
          this.composerNotice = 'Esc again to clear'; // input.md §6: the real right-aligned overlay text
        }
        this.render();
      }
    }
  }

  private cycleMode(): void {
    if (this.dialog !== undefined) return;
    const cycle = this.world.options.modeCycle ?? ['default', 'acceptEdits', 'plan'];
    const i = cycle.indexOf(this.mode);
    this.mode = cycle[(i + 1) % cycle.length] ?? 'default';
    this.render();
  }

  private openEditor(): void {
    if (this.dialog !== undefined || this.editorBusy) return;
    const visual = this.io.env['VISUAL'] ?? '';
    const inj = this.ports.editor.last;
    if (inj === undefined || !visual.endsWith('ccd-editor')) return;
    const finish = (): void => {
      const run = inj.runEditor(this.composer, { claudeDraft: true });
      this.editorBusy = false;
      this.io.setAlternate(false);
      if (run.exitCode === 0) this.composer = run.result.replace(/\n$/, '');
      this.render();
    };
    // LP-01: Claude switches the pane to the alternate screen for the whole editor handoff.
    this.editorBusy = true;
    this.io.setAlternate(true);
    this.io.setScreen([]);
    const ms = this.world.options.editorMs ?? 0;
    if (ms <= 0) finish();
    else this.ports.clock.setTimer((this.now() + ms) as MonoMs, finish);
  }

  // ------------------------------------------------------------ submit

  submit(text: string): void {
    if (this.busy) {
      this.queued.push(text);
      this.entry(
        { type: 'queue-operation', operation: 'enqueue', content: text, timestamp: new Date(this.ports.clock.wallNow()).toISOString() },
        { chain: false },
      );
      this.render();
      return;
    }
    if (text.startsWith('/')) {
      this.command(text);
      return;
    }
    const armed = this.hookTransport?.armedNonce ?? null;
    const tamper = this.world.options.tamper;
    if (tamper !== undefined && text !== armed) text = tamper(text);
    const promptId = this.ids.uuid();
    this.turn = new TurnImpl(this, text, promptId);
    const call = this.hook('UserPromptSubmit', { prompt: text });
    const reply = call?.settled();
    const ours = reply?.body === SELF_TEST_BLOCK_BODY;
    const userReason = this.world.options.userUpsBlockReason;
    if (ours || userReason !== undefined) {
      const reason = ours ? (parseHookReply(SELF_TEST_BLOCK_BODY)?.['reason'] as string) : (userReason ?? '');
      this.turn = undefined;
      this.prompts.push({ text, promptId, blocked: true });
      // LP-47: one system/informational entry; no user entry, no ai-title; the prompt returns to the composer.
      this.entry({
        type: 'system',
        subtype: 'informational',
        level: 'warning',
        preventContinuation: true,
        content: `UserPromptSubmit operation blocked by hook:\n${reason}\n\nOriginal prompt: ${text}`,
        promptSubmitEnding: { ending: { kind: 'blocked_by_hook', reason }, promptKept: false },
        isMeta: false,
      });
      this.history.push(`  ⎿  UserPromptSubmit operation blocked by hook: ${reason}`);
      this.composer = text;
      if (!ours) this.composerNotice = 'Prompt blocked by hook';
      this.render();
      return;
    }
    this.prompts.push({ text, promptId, blocked: false });
    this.busy = true;
    this.statusLine = undefined;
    this.history.push(promptEcho(text));
    const userEntry = {
      type: 'user',
      promptId,
      message: { role: 'user', content: text },
      permissionMode: this.mode,
      origin: { kind: 'human' },
      promptSource: 'typed',
    };
    const lag = this.world.options.promptTranscriptLagMs ?? 0;
    if (lag > 0)
      this.ports.clock.setTimer((this.now() + lag) as MonoMs, () => {
        this.entry(userEntry);
      });
    else this.entry(userEntry);
    this.render();
    const turn = this.turn;
    const script = this.world.options.onPrompt ?? defaultTurn;
    void Promise.resolve()
      .then(() => script(turn))
      .catch((e: unknown) => {
        this.world.errors.push(e);
      })
      .finally(() => {
        turn.finished = true;
        if (this.turn === turn && !turn.ended) turn.endIdle();
      });
  }

  /** Slash commands as typed into the composer (canonical names; `/cost` and `/stats` run `/usage`, LP-33). */
  command(line: string): void {
    const [rawName = '', ...rest] = line.split(' ');
    const aliases: Record<string, string> = {
      '/quit': '/exit',
      '/new': '/clear',
      '/reset': '/clear',
      '/cost': '/usage',
      '/stats': '/usage',
    };
    const name = aliases[rawName] ?? rawName;
    const args = rest.join(' ');
    const local = (stdout: string): void => {
      this.entry({
        type: 'user',
        message: {
          role: 'user',
          content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`,
        },
        isMeta: false,
      });
      this.entry({
        type: 'system',
        subtype: 'local_command',
        content: `<local-command-stdout>${stdout}</local-command-stdout>`,
        level: 'info',
      });
    };
    switch (name) {
      case '/clear': {
        this.hook('SessionEnd', { reason: 'clear' });
        this.sessionId = this.ids.uuid();
        this.lastUuid = null;
        this.history = [];
        this.ports.registry.put({ pid: this.pid, sessionId: this.sessionId, version: '2.1.316', status: 'idle' });
        this.render();
        const delay = this.world.options.clearSessionStartDelayMs ?? 0;
        const start = (): void => {
          if (!this.exited) this.hook('SessionStart', { source: 'clear', model: this.model });
        };
        if (delay <= 0) start();
        else this.ports.clock.setTimer((this.now() + delay) as MonoMs, start);
        return;
      }
      case '/exit':
        if (this.world.options.exitShowsDialog === true) {
          this.dialog = {
            kind: 'menu',
            lines: () =>
              modalFrame({ title: 'How is Claude doing this session? (optional)', body: ['1: Bad    2: Fine   3: Good   0: Dismiss'] }),
            onKey: () => undefined,
          };
          this.render();
          return;
        }
        this.hook('SessionEnd', { reason: 'prompt_input_exit' });
        this.terminate(0, null);
        return;
      case '/model': {
        const from = this.model;
        if (args !== '') this.model = args;
        this.hook('PostModelSwitch', { from_model: from, to_model: this.model, source: 'command' });
        local(`Set model to ${this.model}`);
        this.history.push(`  ⎿  Set model to ${this.model}`);
        this.render();
        return;
      }
      case '/compact':
        this.hook('PreCompact', { trigger: 'manual', custom_instructions: args });
        this.entry({
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          compactMetadata: { trigger: 'manual' },
        });
        this.hook('PostCompact', { trigger: 'manual' });
        this.render();
        return;
      default: {
        const body = this.world.options.modalBodies?.[name];
        const known = body !== undefined || ['/usage', '/help', '/context', '/status'].includes(name);
        if (!known) {
          this.composer = '';
          this.composerNotice = `Unknown command: ${rawName}`;
          this.render();
          return;
        }
        const lines = body ?? [`${name.slice(1)} output`];
        this.dialog = {
          kind: 'modal',
          lines: () => modalFrame({ title: name.slice(1), body: lines }),
          onKey: (k) => {
            if (k !== 'Escape') return;
            this.dialog = undefined;
            local(name === '/usage' ? 'Settings dialog dismissed' : `${name.slice(1)} dialog dismissed`);
            this.render();
          },
        };
        this.render();
      }
    }
  }

  // ------------------------------------------------------------ dialogs

  /** Show the permission dialog; resolves with the key answer (1 = allow, Esc/4 = deny). */
  permissionDialogFor(o: { description: string; command: string; title?: string }): Promise<'allow' | 'deny' | 'escape'> {
    return new Promise((resolve) => {
      const d: Dialog = {
        kind: 'permission',
        lines: () => {
          const x: Parameters<typeof permissionDialog>[0] = { description: o.description, command: o.command, cwd: this.cwd };
          if (o.title !== undefined) x.title = o.title;
          return permissionDialog(x);
        },
        onKey: (k) => {
          const allow = k === '1' || k === '2' || k === '3' || k === 'Enter';
          const deny = k === '4';
          const escape = k === 'Escape';
          if (!allow && !deny && !escape) return;
          if (this.dialog === d) this.dialog = undefined;
          this.render();
          resolve(allow ? 'allow' : deny ? 'deny' : 'escape');
        },
      };
      this.dialog = d;
      this.hook('Notification', { message: 'Claude needs your permission', notification_type: 'permission_prompt' });
      this.render();
    });
  }

  /** Close any dialog without an answer (e.g. the hook decided while the dialog was up). */
  closeDialog(): void {
    this.dialog = undefined;
    this.render();
  }

  // ------------------------------------------------------------ exit

  terminate(status: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.offExit();
    this.turn?.abortSilently();
    if (this.ports.process.isAlive(this.pid)) this.ports.process.exit(this.pid, signal);
    this.ports.registry.delete(this.pid);
    this.io.exit(status, signal);
  }
}

// ---------------------------------------------------------------------------------------------------------------- turn

async function defaultTurn(t: FakeTurn): Promise<void> {
  if (!(await t.sleep(300))) return;
  await t.say('OK');
  await t.stop();
}

class TurnImpl implements FakeTurn {
  readonly startedAt: number;
  interrupted = false;
  ended = false;
  finished = false;
  private lastText = '';
  private readonly waiters = new Set<() => void>();
  private runningTool: string | undefined;

  constructor(
    readonly session: FakeClaudeSession,
    readonly text: string,
    readonly promptId: string,
  ) {
    this.startedAt = session.now();
  }

  /** Interrupted or ended (a method, so a check after an `await` is not narrowed away). */
  over(): boolean {
    return this.interrupted || this.ended;
  }

  sleep(ms: number): Promise<boolean> {
    if (this.interrupted || this.ended) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake);
        cancel();
        resolve(false);
      };
      const cancel = this.session.ports.clock.setTimer((this.session.now() + Math.max(0, ms)) as MonoMs, () => {
        this.waiters.delete(wake);
        resolve(!this.interrupted && !this.ended);
      });
      this.waiters.add(wake);
    });
  }

  async say(text: string, o: { chunks?: number; display?: boolean; finalFlag?: boolean; apiMessageId?: string } = {}): Promise<void> {
    if (this.interrupted || this.ended) return;
    const s = this.session;
    const msgId = o.apiMessageId ?? s.shortId('msg_01');
    if (o.display !== false) {
      const n = Math.max(1, o.chunks ?? 1);
      const size = Math.ceil(text.length / n);
      const turnId = s.newId();
      const uiMessageId = s.newId();
      for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        s.hook('MessageDisplay', {
          turn_id: turnId,
          message_id: uiMessageId,
          index: i,
          final: last && o.finalFlag !== false,
          delta: text.slice(i * size, (i + 1) * size),
        });
        if (!last && !(await this.sleep(20))) return;
      }
    }
    const requestRef = s.apiRequest();
    s.entry({
      type: 'assistant',
      requestRef,
      message: {
        model: s.model,
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 2,
          output_tokens: Math.max(1, Math.ceil(text.length / 4)),
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      requestId: s.shortId('req_01'),
    });
    this.lastText = text;
    s.history.push(assistantRow(text));
    s.render();
  }

  async tool(spec: ToolSpec): Promise<ToolOutcome> {
    const s = this.session;
    const toolUseId = s.shortId('toolu_01');
    if (this.interrupted || this.ended) return { decision: 'interrupted', decider: 'user_keys', toolUseId };
    const agent = spec.agent === undefined ? {} : { agent_id: spec.agent.id, agent_type: spec.agent.type };
    const requestRef = s.apiRequest(spec.agent === undefined ? {} : { agentId: spec.agent.id });
    s.entry(
      {
        type: 'assistant',
        requestRef,
        message: {
          model: s.model,
          id: s.shortId('msg_01'),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: spec.name, input: spec.input }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        requestId: s.shortId('req_01'),
      },
      spec.agent === undefined ? {} : { agentId: spec.agent.id },
    );
    if (spec.noPreHook !== true) s.hook('PreToolUse', { tool_name: spec.name, tool_input: spec.input, tool_use_id: toolUseId, ...agent });
    let decision: ToolOutcome['decision'] = 'allow';
    let decider: ToolOutcome['decider'] = 'config';
    let denyMessage: string | undefined;
    if ((spec.permission ?? 'ask') === 'ask') {
      if (spec.permissionDelayMs !== undefined && !(await this.sleep(spec.permissionDelayMs)))
        return { decision: 'interrupted', decider: 'user_keys', toolUseId };
      const call =
        spec.noPermissionHook === true
          ? undefined
          : s.hook('PermissionRequest', { tool_name: spec.name, tool_input: spec.input, permission_suggestions: [], ...agent });
      let answered: ReturnType<typeof permissionDecisionOf>;
      if (call?.hookSeq !== undefined) {
        // Claude waits for the held forwarder up to the registered timeout, then falls back to the dialog (LV P3).
        this.runningTool = toolUseId;
        const timeoutMs = s.hookTimeoutS('PermissionRequest') * 1000;
        const reply = await Promise.race([call.reply, s.ports.clock.sleep(timeoutMs).then(() => undefined)]);
        this.runningTool = undefined;
        if (reply === undefined) call.abort('timeout');
        else answered = permissionDecisionOf(reply.body);
      }
      if (this.over()) return { decision: 'interrupted', decider: 'user_keys', toolUseId };
      if (answered !== undefined) {
        decision = answered.behavior;
        decider = 'hook';
        if (answered.message !== undefined) denyMessage = answered.message;
        if (answered.interrupt === true) {
          this.interruptForTool(toolUseId);
          return { decision: 'interrupted', decider: 'hook', toolUseId };
        }
      } else {
        const command = typeof spec.input['command'] === 'string' ? spec.input['command'] : JSON.stringify(spec.input);
        const desc = typeof spec.input['description'] === 'string' ? spec.input['description'] : `${spec.name} call`;
        this.runningTool = toolUseId;
        const keys = await s.permissionDialogFor({ description: desc, command, title: spec.name === 'Bash' ? 'Bash command' : spec.name });
        this.runningTool = undefined;
        if (this.over()) return { decision: 'interrupted', decider: 'user_keys', toolUseId };
        if (keys === 'escape') {
          this.escapeAtDialog(toolUseId);
          return { decision: 'interrupted', decider: 'user_keys', toolUseId };
        }
        decision = keys;
        decider = 'user_keys';
      }
    }
    // Transcript evidence of who decided (LV §Q2): the hook attachment, and permissionDecision on the tool_result.
    if (decider === 'hook')
      s.entry({
        type: 'attachment',
        attachment: { type: 'hook_permission_decision', decision, toolUseID: toolUseId, hookEvent: 'PermissionRequest' },
      });
    const permissionDecision = {
      decision: decision === 'allow' ? 'accept' : 'reject',
      source: decider === 'hook' ? 'hook' : decider === 'user_keys' ? 'user_temporary' : 'config',
      ...(decider === 'hook' ? { reasonType: 'hook' } : {}),
      reasonCode: 'unknown',
    };
    if (decision === 'deny') {
      s.entry({
        type: 'user',
        permissionDecision,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              is_error: true,
              content: denyMessage ?? `Permission to use ${spec.name} has been denied.`,
            },
          ],
        },
        toolUseResult: `Error: ${denyMessage ?? 'Permission denied'}`,
      });
      const cmdText = typeof spec.input['command'] === 'string' ? spec.input['command'] : '';
      s.history.push(...toolRows({ summary: `${spec.name}(${cmdText})`, detail: 'Denied' }));
      s.render();
      return { decision, decider, toolUseId };
    }
    this.runningTool = toolUseId;
    const ran = await this.sleep(spec.runMs ?? 50);
    this.runningTool = undefined;
    if (!ran) return { decision: 'interrupted', decider: 'user_keys', toolUseId };
    const out = spec.result ?? 'ok';
    if (spec.fail !== undefined) {
      s.hook('PostToolUseFailure', {
        tool_name: spec.name,
        tool_input: spec.input,
        tool_use_id: toolUseId,
        error: spec.fail,
        is_interrupt: false,
        ...agent,
      });
      s.entry({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: spec.fail }] },
      });
    } else {
      s.hook('PostToolUse', {
        tool_name: spec.name,
        tool_input: spec.input,
        tool_response: spec.response ?? { stdout: out, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
        tool_use_id: toolUseId,
        duration_ms: spec.runMs ?? 50,
        ...agent,
      });
      s.entry(
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: out, is_error: false }] },
          toolUseResult: spec.response ?? { stdout: out, stderr: '', interrupted: false, isImage: false },
          ...((spec.permission ?? 'ask') === 'ask' ? { permissionDecision } : {}),
        },
        spec.agent === undefined ? {} : { agentId: spec.agent.id },
      );
    }
    s.history.push(...toolRows({ summary: `Ran 1 shell command` }));
    s.render();
    return { decision: 'allow', decider, toolUseId };
  }

  async stop(
    o: { lastMessage?: string; stopHookActive?: boolean; backgroundTasks?: unknown[]; noTurnDuration?: boolean } = {},
  ): Promise<void> {
    if (this.interrupted || this.ended) return;
    const s = this.session;
    s.hook('Stop', {
      stop_hook_active: o.stopHookActive ?? false,
      last_assistant_message: o.lastMessage ?? this.lastText,
      background_tasks: o.backgroundTasks ?? [],
      session_crons: [],
    });
    if (o.stopHookActive === true) return;
    s.entry({
      type: 'system',
      subtype: 'stop_hook_summary',
      hookCount: 1,
      hookInfos: [{ command: 'http://127.0.0.1/Stop' }],
      hookErrors: [],
      preventedContinuation: false,
      stopReason: '',
      hasOutput: false,
      level: 'suggestion',
    });
    if (o.noTurnDuration !== true)
      s.entry({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: Math.max(1, Math.round(s.now() - this.startedAt)),
        messageCount: 2,
        isMeta: false,
      });
    this.endIdle(doneLine({ seconds: Math.max(1, Math.round((s.now() - this.startedAt) / 1000)) }));
    await Promise.resolve();
  }

  async fail(o: { error: string; message: string; details?: string; resetsAtEpochS?: number; rateLimitType?: string }): Promise<void> {
    if (this.interrupted || this.ended) return;
    const s = this.session;
    const apiErrorParams: Record<string, unknown> = {};
    if (o.resetsAtEpochS !== undefined)
      apiErrorParams['rate_limit_info'] = { resetsAt: o.resetsAtEpochS, rateLimitType: o.rateLimitType ?? 'five_hour' };
    s.entry({
      type: 'assistant',
      isApiErrorMessage: true,
      error: o.error,
      ...(Object.keys(apiErrorParams).length > 0 ? { apiErrorParams } : {}),
      message: {
        model: '<synthetic>',
        id: s.newId(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: o.message }],
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    s.hook('StopFailure', { error: o.error, error_details: o.details ?? o.message, last_assistant_message: o.message });
    s.history.push(`  ⎿  ${o.message}`);
    this.endIdle();
    await Promise.resolve();
  }

  status(line: string | undefined): void {
    this.session.statusLine = line;
    this.session.render();
  }

  modelCall(o: { downBytes?: number } = {}): void {
    const proxy = this.session.ports.net.last;
    if (proxy === undefined || this.session.io.env['HTTPS_PROXY'] === undefined) return;
    proxy.simulateTunnel({ host: 'api.anthropic.com', upBytes: 4096, downBytes: o.downBytes ?? 2048 });
  }

  // ------------------------------------------------------------ internal

  /** Escape while busy: `[Request interrupted by user]` (or the tool-use form), no Stop, no turn_duration (K-13). */
  interrupt(): void {
    if (this.interrupted || this.ended) return;
    const s = this.session;
    const tool = this.runningTool;
    if (tool !== undefined && s.dialog?.kind === 'permission') {
      s.dialog.onKey('Escape');
      return;
    }
    if (tool !== undefined) {
      this.interruptForTool(tool);
      return;
    } else {
      this.interrupted = true;
      s.entry({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    }
    s.history.push(INTERRUPTED_BANNER);
    this.endIdle();
  }

  /** Esc at the permission dialog (K-14): the tool is rejected, the turn ends with turn_duration only (no Stop). */
  private escapeAtDialog(toolUseId: string): void {
    const s = this.session;
    this.interrupted = true;
    s.entry({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: true,
            content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
          },
        ],
      },
      toolUseResult: 'User rejected tool use',
    });
    s.entry({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    s.entry({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: Math.max(1, Math.round(s.now() - this.startedAt)),
      messageCount: 3,
      isMeta: false,
    });
    s.history.push(INTERRUPTED_BANNER);
    this.endIdle();
  }

  private interruptForTool(toolUseId: string): void {
    const s = this.session;
    this.interrupted = true;
    s.entry({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: '[Request interrupted by user for tool use]' }],
      },
      toolUseResult: 'Error: [Request interrupted by user for tool use]',
    });
    s.entry({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    s.history.push(INTERRUPTED_BANNER);
    this.endIdle();
  }

  abortSilently(): void {
    this.ended = true;
    for (const w of [...this.waiters]) w();
  }

  /** Back to an idle composer; queued prompts are submitted next (Claude dequeues them). */
  endIdle(status?: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of [...this.waiters]) w();
    const s = this.session;
    s.busy = false;
    s.statusLine = status;
    if (s.turn === this) s.turn = undefined;
    s.render();
    const next = s.queued.shift();
    if (next !== undefined) {
      s.entry(
        { type: 'queue-operation', operation: 'dequeue', timestamp: new Date(s.ports.clock.wallNow()).toISOString() },
        { chain: false },
      );
      s.submit(next);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- world

/** Installs itself as the program of every pane FakeTmux spawns; one FakeClaudeSession per pane. */
export class FakeClaude {
  readonly sessions: FakeClaudeSession[] = [];
  private tags = 0;
  /** Errors thrown by turn scripts (a scenario asserts this stays empty). */
  readonly errors: unknown[] = [];

  constructor(
    readonly ports: FakePortSet,
    readonly options: FakeClaudeOptions = {},
  ) {
    ports.setProgram((argv) => this.program(argv));
  }

  /** Per-world id namespace for each spawned session (deterministic ids within a test). */
  nextTag(): number {
    return ++this.tags;
  }

  /** The session in the most recently spawned pane. */
  get last(): FakeClaudeSession | undefined {
    return this.sessions.at(-1);
  }

  /** The last session, or throw (scenario helper). */
  current(): FakeClaudeSession {
    const s = this.last;
    if (s === undefined) throw new Error('FakeClaude: no pane was spawned');
    return s;
  }

  private program(argv: readonly string[]): FakeProgram {
    let session: FakeClaudeSession | undefined;
    const claudeExe = argv.some((a) => a.endsWith('claude.exe') || a.endsWith('/claude'));
    if (!claudeExe) return {};
    return {
      start: (io) => {
        const pane = this.ports.tmux.lastPane();
        if (pane === undefined) return;
        session = new FakeClaudeSession(this, io, pane);
        this.sessions.push(session);
        session.boot();
      },
      input: (bytes) => {
        session?.input(bytes);
      },
    };
  }
}
