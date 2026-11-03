#!/usr/bin/env node
// scripts/fixtures-depersonalize.mjs — strip machine/account-specific content from recorded fixtures before publishing.
// Idempotent. Rewrites in place:
//  - transcript lines the normalizer never reads for facts (api-request-blob/-shape/api-request params, attachment deltas
//    other than hook_permission_decision / queued_command / task_status): string leaves → "[scrubbed]", name lists → [].
//  - home paths, usernames and the local time zone in every fixture file.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? new URL('../fixtures/', import.meta.url).pathname;
// attachment types the transcript normalizer reads (profile attachments + hookErrorAttachments): kept verbatim
const KEEP_ATTACHMENTS = new Set([
  'hook_permission_decision',
  'queued_command',
  'task_status',
  'hook_non_blocking_error',
  'hook_cancelled',
]);
// only types the transcript normalizer skip-parses (transcript profile skipParseTypes); api-request carries digests the core reads
const BLANK_TYPES = new Set(['api-request-blob', 'api-request-shape']);
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const user = userInfo().username;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TEXT = [
  [new RegExp(esc(homedir()), 'g'), '/Users/dev'],
  [new RegExp(`-Users-${esc(user)}-`, 'g'), '-Users-dev-'],
  [new RegExp(`\\b${esc(user)}\\b`, 'g'), 'dev'],
  // the account's plan tier shown in the TUI header ("Opus 5.5 · Claude Max")
  [/\bClaude (Ultra|Max|Pro|Team|Enterprise)\b/g, 'Claude Plan'],
  ...(tz && tz !== 'UTC' && tz !== 'Etc/UTC' ? [[new RegExp(esc(tz), 'g'), 'Etc/UTC']] : []),
];

const blank = (o, keep) => {
  if (typeof o === 'string') return '[scrubbed]';
  if (Array.isArray(o)) return o.every((x) => typeof x === 'string') ? [] : o.map((x) => blank(x, keep));
  if (o !== null && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = keep.has(k) ? v : blank(v, keep);
    return out;
  }
  return o;
};
const KEEP_KEYS = new Set(['type', 'id', 'uuid', 'parentUuid', 'timestamp', 'sessionId', 'promptId', 'isSidechain', 'trigger']);

function scrubEntry(j) {
  if (j === null || typeof j !== 'object') return j;
  if (BLANK_TYPES.has(j.type)) return blank(j, KEEP_KEYS);
  if (j.type === 'attachment' && j.attachment && !KEEP_ATTACHMENTS.has(j.attachment.type))
    return { ...j, attachment: { ...blank(j.attachment, KEEP_KEYS), type: j.attachment.type } };
  return j;
}
// Synthetic reminders injected as user entries list the account's tools/MCP servers: keep the wrapper, drop the body.
const reminder = (o) => {
  if (typeof o === 'string')
    return o.startsWith('<system-reminder>') && o.length > 120 ? '<system-reminder>\n[scrubbed]\n</system-reminder>' : o;
  if (Array.isArray(o)) return o.map(reminder);
  if (o !== null && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, reminder(v)]));
  return o;
};
function scrubRecord(r) {
  return reminder(scrubRecord0(r));
}
function scrubRecord0(r) {
  const line = r?.data?.line;
  if (line && typeof line === 'object' && line.json) return { ...r, data: { ...r.data, line: { ...line, json: scrubEntry(line.json) } } };
  if (r && typeof r === 'object' && typeof r.type === 'string') return scrubEntry(r); // bare transcript jsonl
  return r;
}

let changed = 0;
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    let s = readFileSync(p, 'utf8');
    const before = s;
    if (p.endsWith('.jsonl')) {
      s = s
        .split('\n')
        .map((l) => {
          if (!l.trim()) return l;
          try {
            return JSON.stringify(scrubRecord(JSON.parse(l)));
          } catch {
            return l;
          }
        })
        .join('\n');
    }
    for (const [re, to] of TEXT) s = s.replace(re, to);
    if (s !== before) {
      writeFileSync(p, s);
      changed++;
    }
  }
};
walk(ROOT);
console.log(`fixtures-depersonalize: ${changed} file(s) changed`);
