// platform/editor/fake-editor.ts — in-memory EditorInjectorFactory with the standalone's decision rules (armed + unexpired +
// a Claude draft → consume exactly once; a Claude draft whose arm expired or was disarmed by a timed-out `consumed()` (live
// tombstone, ICR 0018) → exit 1 without opening an editor; else the user's original editor or exit 1). WP-14 wires `runEditor` to FakeTmux's
// `C-g` so the composer receives the staged text (K-01, K-07).
import type { Clock } from '../../model/time.js';
import type { EditorInjector, EditorInjectorFactory, IdPort } from '../ports.js';
import { DEFAULT_ARM_TTL_MS, DEFAULT_POLL_MS, WRAPPER_NAME } from './injector.js';

export interface FakeEditorRun {
  /** The text the draft holds after the editor exits. */
  result: string;
  consumed: boolean;
  exitCode: number;
  ranOriginal: boolean;
}

export interface FakeEditorOptions {
  /** The user's original editor; when set, an unarmed run "edits" the draft with it. */
  original?: (draft: string) => string;
  armTtlMs?: number;
  pollMs?: number;
  /** K-07: the editor never runs / never finishes, so `consumed()` times out. */
  neverConsume?: boolean;
}

export class FakeEditorInjector implements EditorInjector {
  visualPath: string | undefined;
  armed: { nonce: string; text: string; expiresAtWall: number } | undefined;
  readonly done = new Set<string>();
  readonly staged: string[] = [];
  readonly runs: FakeEditorRun[] = [];
  disarms = 0;
  /** Wall time until which a disarm tombstone is live (ICR 0018). */
  disarmedUntilWall: number | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly o: FakeEditorOptions,
  ) {}

  setup(sessionDir: string, _nodePath: string): Promise<{ visualPath: string }> {
    this.visualPath = `${sessionDir}/${WRAPPER_NAME}`;
    return Promise.resolve({ visualPath: this.visualPath });
  }

  stage(text: string): Promise<{ nonce: string }> {
    if (this.visualPath === undefined) return Promise.reject(new Error('EditorInjector: setup() was not called'));
    const nonce = this.ids.tokenHex(16);
    this.done.clear();
    this.armed = { nonce, text, expiresAtWall: this.clock.wallNow() + (this.o.armTtlMs ?? DEFAULT_ARM_TTL_MS) };
    this.staged.push(text);
    return Promise.resolve({ nonce });
  }

  /** Simulate Claude running $VISUAL on a draft file. */
  runEditor(draft: string, o: { claudeDraft?: boolean } = {}): FakeEditorRun {
    let run: FakeEditorRun;
    const a = this.armed;
    if (o.claudeDraft !== false && this.o.neverConsume !== true && a !== undefined && a.expiresAtWall >= this.clock.wallNow()) {
      this.armed = undefined;
      this.done.add(a.nonce);
      run = { result: a.text, consumed: true, exitCode: 0, ranOriginal: false };
    } else if (
      o.claudeDraft !== false &&
      this.o.neverConsume !== true &&
      (a !== undefined || (this.disarmedUntilWall !== undefined && this.disarmedUntilWall >= this.clock.wallNow()))
    ) {
      // the library's own C-g came too late (expired arm, or consumed() timed out): never open an editor in the pane
      this.armed = undefined;
      run = { result: draft, consumed: false, exitCode: 1, ranOriginal: false };
    } else if (this.o.original !== undefined) {
      run = { result: this.o.original(draft), consumed: false, exitCode: 0, ranOriginal: true };
    } else run = { result: draft, consumed: false, exitCode: 1, ranOriginal: false };
    this.runs.push(run);
    return run;
  }

  async consumed(nonce: string, timeoutMs: number): Promise<boolean> {
    const deadline = this.clock.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (this.done.delete(nonce)) return true;
      const left = deadline - this.clock.now();
      if (left <= 0) {
        await this.disarm();
        return false;
      }
      await this.clock.sleep(Math.min(this.o.pollMs ?? DEFAULT_POLL_MS, left));
    }
  }

  disarm(): Promise<void> {
    if (this.armed !== undefined) this.disarmedUntilWall = this.clock.wallNow() + (this.o.armTtlMs ?? DEFAULT_ARM_TTL_MS);
    this.armed = undefined;
    this.disarms++;
    return Promise.resolve();
  }
}

export class FakeEditorInjectorFactory implements EditorInjectorFactory {
  readonly created: FakeEditorInjector[] = [];

  constructor(private readonly o: FakeEditorOptions = {}) {}

  create({ clock, ids }: { clock: Clock; ids: IdPort }): FakeEditorInjector {
    const inj = new FakeEditorInjector(clock, ids, this.o);
    this.created.push(inj);
    return inj;
  }

  /** The most recently created injector. */
  get last(): FakeEditorInjector | undefined {
    return this.created.at(-1);
  }
}
