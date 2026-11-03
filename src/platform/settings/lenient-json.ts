// platform/settings/lenient-json.ts — tolerant readers for files the library does not own (user settings, keybindings,
// Claude's registry). Strict JSON first; then a second pass that drops a BOM, // and /* */ comments and trailing commas
// (outside strings). `firstJsonObject` extracts the first complete top-level object (registry files can carry a torn or
// concatenated tail, #96438).

export type LenientResult = { ok: true; value: unknown } | { ok: false; error: string };

export function parseLenientJson(text: string): LenientResult {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    try {
      return { ok: true, value: JSON.parse(stripCommentsAndTrailingCommas(t)) };
    } catch {
      return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' };
    }
  }
}

/** Remove comments and trailing commas outside string literals. */
export function stripCommentsAndTrailingCommas(s: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < s.length) {
    const c = s[i] ?? '';
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += s[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j] ?? '')) j++;
      if (s[j] === '}' || s[j] === ']') {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** The first complete `{…}` object in `text` (string-aware brace matching), parsed; `undefined` if none parses. */
export function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          const v: unknown = JSON.parse(text.slice(start, i + 1));
          return isPlainObject(v) ? v : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
