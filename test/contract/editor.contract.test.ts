// Runs the editor injector contract against FakeEditorInjector and the real ccd-editor wrapper + standalone (WP-05).
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealClock } from '../../src/platform/clock/real-clock.js';
import { FakeEditorInjectorFactory } from '../../src/platform/editor/fake-editor.js';
import { createEditorInjectorFactory } from '../../src/platform/editor/injector.js';
import { createCryptoIds } from '../../src/platform/ids/crypto-ids.js';
import { editorContract } from './editor.contract.js';

const SUFFIX = '+orig';

editorContract('fake', (o) => {
  const inj = new FakeEditorInjectorFactory({
    original: (d) => `${d}${SUFFIX}`,
    ...(o?.armTtlMs !== undefined ? { armTtlMs: o.armTtlMs } : {}),
  }).create({
    clock: createRealClock(),
    ids: createCryptoIds(),
  });
  return Promise.resolve({
    injector: inj,
    sessionDir: '/fake/run/ccd-000001',
    nodePath: '/usr/local/bin/node',
    origSuffix: SUFFIX,
    runEditor: (_visual, draft, o) => {
      const r = inj.runEditor(draft, o);
      return Promise.resolve({ exitCode: r.exitCode, result: r.result });
    },
    cleanup: () => Promise.resolve(),
  });
});

editorContract('real wrapper + standalone', (o) => {
  const sessionDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-edc-')));
  chmodSync(sessionDir, 0o700);
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'ccd-wp05-edw-')));
  const orig = join(work, 'orig-editor');
  writeFileSync(orig, `#!/bin/sh\nprintf '%s' '${SUFFIX}' >> "$1"\n`);
  chmodSync(orig, 0o755);
  let n = 0;
  return Promise.resolve({
    injector: createEditorInjectorFactory({
      hostEnv: { VISUAL: orig },
      ...(o?.armTtlMs !== undefined ? { armTtlMs: o.armTtlMs } : {}),
    }).create({ clock: createRealClock(), ids: createCryptoIds() }),
    sessionDir,
    nodePath: process.execPath,
    origSuffix: SUFFIX,
    runEditor: (visual, draft, o) =>
      new Promise((res) => {
        const file = join(work, o?.claudeDraft === false ? `COMMIT_EDITMSG-${++n}` : `claude-prompt-${(++n).toString(16)}abc.md`);
        writeFileSync(file, draft);
        execFile(visual, [file], { env: { PATH: '/usr/bin:/bin' } }, (err) => {
          res({ exitCode: err === null ? 0 : typeof err.code === 'number' ? err.code : -1, result: readFileSync(file, 'utf8') });
        });
      }),
    cleanup: () => {
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      return Promise.resolve();
    },
  });
});
