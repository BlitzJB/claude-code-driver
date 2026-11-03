// channels/hooks/task-notification.ts — parse a `<task-notification>` prompt (DESIGN.md §1.2; RC §5.5; TF §4.2 item 2).
// A background agent or task finishing starts an automatic turn whose UPS `prompt` (and transcript user content) is:
//   <task-notification>\n<task-id>a573…</task-id>\n<tool-use-id>toolu_…</tool-use-id>\n<output-file>…</output-file>\n
//   <status>completed</status>\n<summary>…</summary>\n<note>…</note>\n<result>…</result>\n<usage>…</usage>\n</task-notification>
// In subagent files the same text is prefixed by `[SYSTEM NOTIFICATION - NOT USER INPUT]…`. Pure; never throws.

import type { HookExtras } from '../profiles/claude-2.1.316/hooks.js';

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  status: string;
  outputFile?: string;
  summary?: string;
}

/** Text of the first `<tag>…</tag>` inside `body`, trimmed; `undefined` when absent or empty. */
function tagText(body: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const start = body.indexOf(open);
  if (start < 0) return undefined;
  const from = start + open.length;
  const end = body.indexOf(`</${tag}>`, from);
  if (end < 0) return undefined;
  const v = body.slice(from, end).trim();
  return v.length > 0 ? v : undefined;
}

/**
 * Locate the notification body. It must be the first thing in the text (after whitespace and the optional subagent banner),
 * so a user prompt that merely *mentions* `<task-notification>` is not classified as one.
 */
function notificationBody(text: string, t: HookExtras['taskNotification']): string | undefined {
  let s = text.trimStart();
  if (s.startsWith(t.systemPrefix)) {
    const at = s.indexOf(`<${t.root}>`);
    if (at < 0) return undefined;
    s = s.slice(at);
  }
  const open = `<${t.root}>`;
  if (!s.startsWith(open)) return undefined;
  const close = s.indexOf(`</${t.root}>`, open.length);
  // A truncated notification (no closing tag) is still parsed up to the end of the text.
  return close < 0 ? s.slice(open.length) : s.slice(open.length, close);
}

/** True when `text` has the task-notification shape (cheap check used for classification). */
export function isTaskNotification(text: string, x: HookExtras): boolean {
  return notificationBody(text, x.taskNotification) !== undefined;
}

/**
 * Parse the notification. `undefined` when the text is not a task notification or has no `<task-id>`; a missing `<status>`
 * becomes `'unknown'` (the turn is still a task-notification turn, RC §5.5).
 */
export function parseTaskNotification(text: string, x: HookExtras): TaskNotification | undefined {
  const t = x.taskNotification;
  const body = notificationBody(text, t);
  if (body === undefined) return undefined;
  const taskId = tagText(body, t.taskId);
  if (taskId === undefined) return undefined;
  const n: TaskNotification = { taskId, status: tagText(body, t.status) ?? 'unknown' };
  const toolUseId = tagText(body, t.toolUseId);
  if (toolUseId !== undefined) n.toolUseId = toolUseId;
  const outputFile = tagText(body, t.outputFile);
  if (outputFile !== undefined) n.outputFile = outputFile;
  const summary = tagText(body, t.summary);
  if (summary !== undefined) n.summary = summary;
  return n;
}
