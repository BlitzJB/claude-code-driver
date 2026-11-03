#!/usr/bin/env node
// scripts/fixtures-lint.mjs — fail if a committed fixture still carries personal data or secrets (DESIGN.md §6.6; SEC §8.4;
// P-SEC-23). Usage:
//
//   pnpm fixtures:lint [paths...]        (default: every committed fixture under fixtures/)
//
// Findings (exit 1): e-mails other than @example.com, `/Users/<x>` or `/home/<x>` paths, `sk-ant-`, `gh[pousr]_` tokens, `AKIA`,
// private-key blocks, `Proxy-Authorization`, `X-CCD-Token`, an unscrubbed self-test nonce `ccd-selftest-<32 hex>`, and any run
// of ≥ 32 hex or ≥ 32 base64 characters that is not one of the scrubber's fakes. `fixtures/verify/` (the raw live corpus,
// a source for fixtures-from-verify, not a fixture) and `fixtures/raw/` (unscrubbed recordings, gitignored) are never linted;
// everything else under fixtures/ (traces, goldens, the scrubbed screen corpus and its labels) is.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_HEX_RE = /^cafe0+[0-9a-f]{1,8}$/;
export const FAKE_B64_RE = /^FAKEb64x+[0-9]{4,}$/;

/** [rule id, regex, predicate on the match (true = finding)] */
const RULES = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => !/@example\.com$/i.test(m)],
  ['home-path', /\/(?:Users|home)\/[^/\s"'\\]+/g, () => true],
  ['anthropic-key', /sk-ant-/g, () => true],
  ['github-token', /gh[pousr]_[A-Za-z0-9]/g, () => true],
  ['aws-key', /AKIA[0-9A-Z]{4,}/g, () => true],
  ['private-key', /BEGIN [A-Z ]*PRIVATE KEY/g, () => true],
  ['proxy-authorization', /Proxy-Authorization/gi, () => true],
  ['hook-token-header', /X-CCD-Token/gi, () => true],
  ['selftest-nonce', /ccd-selftest-[0-9a-f]{32}/g, () => true],
  ['long-hex', /(?<![0-9a-fA-F])[0-9a-f]{32,}(?![0-9a-fA-F])/g, (m) => !FAKE_HEX_RE.test(m)],
  ['long-base64', /[A-Za-z0-9+/]{32,}={0,2}/g, (m) => /[0-9]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) && !FAKE_B64_RE.test(m)],
];

/** Every string (keys included) of a parsed JSON value, decoded. */
function* jsonStrings(v) {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* jsonStrings(x);
  else if (v !== null && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      yield k;
      yield* jsonStrings(x);
    }
}

function lintPiece(piece, lineNo, findings) {
  for (const [rule, re, bad] of RULES) {
    re.lastIndex = 0;
    for (const m of piece.matchAll(re)) {
      if (!bad(m[0])) continue;
      const at = m.index ?? 0;
      findings.push({ line: lineNo, rule, excerpt: piece.slice(Math.max(0, at - 20), at + m[0].length + 20) });
    }
  }
}

/**
 * Lint one text; returns findings `{line, rule, excerpt}`. A line that is a JSON value is checked string by string, decoded
 * (the scrubber works on decoded strings too): JSON escapes would otherwise glue a letter to a fake (`\nFAKEb64…`,
 * `\bcafe0…`) and `\u0040`-style escapes would hide an e-mail. Any other line (screen logs, a torn record) is checked as is.
 */
export function lintText(text) {
  const findings = [];
  text.split('\n').forEach((line, i) => {
    let parsed;
    let isJson = false;
    const t = line.trim();
    if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
      try {
        parsed = JSON.parse(t);
        isJson = true;
      } catch {
        isJson = false;
      }
    }
    if (isJson) for (const s of jsonStrings(parsed)) lintPiece(s, i + 1, findings);
    else lintPiece(line, i + 1, findings);
  });
  return findings;
}

function* files(p) {
  const st = statSync(p);
  if (st.isFile()) {
    yield p;
    return;
  }
  for (const name of readdirSync(p).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(p, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(jsonl|json|txt|log)$/.test(name)) yield full;
  }
}

/** Lint every fixture under `paths`; returns all findings with their file. */
export function lintPaths(paths) {
  const out = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      // a mistyped path must not read as "clean"
      out.push({ file: p, line: 0, rule: 'missing-path', excerpt: 'path does not exist' });
      continue;
    }
    const explicitFile = statSync(p).isFile();
    for (const f of files(p)) {
      // a file named on the command line is always linted; the directory walk skips the raw/verify corpora
      if (!explicitFile && /[/\\]fixtures[/\\](?:verify|raw)[/\\]/.test(resolve(f))) continue;
      for (const x of lintText(readFileSync(f, 'utf8'))) out.push({ file: f, ...x });
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const paths = args.length > 0 ? args : ['fixtures'];
  const findings = lintPaths(paths);
  for (const f of findings) process.stderr.write(`${f.file}:${f.line}: ${f.rule}: ${JSON.stringify(f.excerpt)}\n`);
  if (findings.length > 0) {
    process.stderr.write(`fixtures:lint: ${findings.length} finding(s)\n`);
    process.exit(1);
  }
  process.stdout.write(`fixtures:lint: clean (${paths.join(', ')})\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
